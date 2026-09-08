-- Bloqueio: linha de receita em unidade contável × massa exige o peso do insumo.
--
-- Fecha a porta de entrada do bug corrigido em `20260830120000`. Lá o banco parou
-- de GRAVAR chute quando não sabe converter; aqui ele para de ACEITAR a linha que
-- só existe porque a conversão é impossível.
--
-- Escopo do bloqueio (decisão do usuário em 2026-08-30, com os dados de produção
-- na mesa): só o par **contável × massa** (`un` ↔ `kg`/`g`) sem `portion_qty`.
-- É o único par que vira conta certa cadastrando um dado que já existe na tela
-- (Estoque › insumo › Peso por unidade), e é exatamente o caso do REQUEIJÃO.
--
-- Volume fica de FORA de propósito: hoje há 35 linhas de preparo medidas em `L`
-- vindas de insumo em `kg`/`un` (óleo, molhos). Não existe densidade no modelo,
-- então essas linhas nunca converteram e funcionam como custo manual — bloqueá-las
-- proibiria um fluxo em uso, sem oferecer conserto.
--
-- Duas travas:
--   1. `tech_sheet_items` / `preparation_items`: recusa INSERT, e UPDATE que mexa
--      em `unit`/`stock_item_id`. Só essas duas colunas para que as linhas hoje
--      tortas continuem editáveis (dá para consertar mudando a unidade) e para que
--      a propagação de custo — que só escreve `unit_cost` — nunca esbarre na trava.
--   2. `stock_items`: recusa a edição do insumo que TIRA a conversão de linhas que
--      hoje estão certas (trocar a unidade, apagar o peso). Linha que já estava
--      sem conversão não trava nada: o preço do insumo continua editável.
--
-- Idempotente: CREATE OR REPLACE + DROP/CREATE TRIGGER.

-- ============================================================================
-- app.recipe_unit_needs_weight — "esse par só fecha com o peso por unidade?"
-- ============================================================================
CREATE OR REPLACE FUNCTION app.recipe_unit_needs_weight(
  p_stock_unit   text,
  p_target_unit  text,
  p_portion_qty  numeric,
  p_portion_unit text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = 'app', 'public', 'pg_temp'
AS $function$
DECLARE
  v_from text := lower(coalesce(p_stock_unit, ''));
  v_to   text := lower(coalesce(p_target_unit, ''));
BEGIN
  IF v_from IN ('und', 'unid', 'unidade') THEN v_from := 'un'; END IF;
  IF v_to   IN ('und', 'unid', 'unidade') THEN v_to   := 'un'; END IF;

  IF v_to = '' OR v_from = v_to THEN
    RETURN false;
  END IF;

  -- Só contável × massa. kg ↔ g fecha sozinho (fator 1000) e volume não tem
  -- densidade no modelo — nenhum dos dois é bloqueável.
  IF NOT ((v_from = 'un'          AND v_to   IN ('kg','g'))
       OR (v_from IN ('kg','g')   AND v_to   = 'un')) THEN
    RETURN false;
  END IF;

  -- p_portion_unit entra na assinatura por simetria com stock_unit_cost_in: o que
  -- decide é existir peso, não em qual unidade ele está.
  RETURN p_portion_qty IS NULL OR p_portion_qty <= 0;
END;
$function$;

-- ============================================================================
-- Trava 1 — linha de ficha/preparo
-- ============================================================================
CREATE OR REPLACE FUNCTION app.assert_recipe_line_weight()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = 'app', 'public', 'pg_temp'
AS $function$
DECLARE
  v_name text;
  v_unit text;
  v_pq   numeric;
  v_pu   text;
BEGIN
  IF NEW.stock_item_id IS NULL THEN
    RETURN NEW;  -- linha manual ou vinda de preparo: não há insumo para converter
  END IF;

  SELECT si.name, si.unit, si.portion_qty, si.portion_unit
    INTO v_name, v_unit, v_pq, v_pu
    FROM public.stock_items si
   WHERE si.id = NEW.stock_item_id;

  IF v_name IS NULL THEN
    RETURN NEW;  -- insumo invisível para quem escreve: quem barra é o guard de tenant
  END IF;

  IF app.recipe_unit_needs_weight(v_unit, NEW.unit, v_pq, v_pu) THEN
    RAISE EXCEPTION
      'O insumo "%" está cadastrado em % e a linha está em %: sem o peso por unidade o custo sairia % vezes errado.',
      v_name, v_unit, NEW.unit, CASE WHEN lower(NEW.unit) = 'g' THEN '1000' ELSE 'muitas' END
      USING ERRCODE = '23514',
            HINT = 'Cadastre o "Peso por unidade" do insumo em Estoque, ou meça a linha na mesma unidade do insumo.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tech_sheet_items_weight_guard ON public.tech_sheet_items;
CREATE TRIGGER trg_tech_sheet_items_weight_guard
  BEFORE INSERT OR UPDATE OF unit, stock_item_id ON public.tech_sheet_items
  FOR EACH ROW EXECUTE FUNCTION app.assert_recipe_line_weight();

DROP TRIGGER IF EXISTS trg_preparation_items_weight_guard ON public.preparation_items;
CREATE TRIGGER trg_preparation_items_weight_guard
  BEFORE INSERT OR UPDATE OF unit, stock_item_id ON public.preparation_items
  FOR EACH ROW EXECUTE FUNCTION app.assert_recipe_line_weight();

-- ============================================================================
-- Trava 2 — edição do insumo não pode estragar receita que está certa
-- ============================================================================
-- Roda BEFORE, então aborta antes do AFTER `trg_propagate_stock_item_cost`.
CREATE OR REPLACE FUNCTION app.assert_stock_unit_keeps_recipes()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = 'app', 'public', 'pg_temp'
AS $function$
DECLARE
  v_broken text;
BEGIN
  IF NEW.unit         IS NOT DISTINCT FROM OLD.unit
 AND NEW.portion_qty  IS NOT DISTINCT FROM OLD.portion_qty
 AND NEW.portion_unit IS NOT DISTINCT FROM OLD.portion_unit THEN
    RETURN NEW;
  END IF;

  SELECT string_agg(x, '; ') INTO v_broken FROM (
    SELECT format('ficha "%s" (linha em %s)', ts.name, tsi.unit) AS x
      FROM public.tech_sheet_items tsi
      JOIN public.tech_sheets ts ON ts.id = tsi.tech_sheet_id
     WHERE tsi.stock_item_id = NEW.id
       AND app.stock_unit_cost_in(OLD.unit_cost, OLD.unit, tsi.unit, OLD.portion_qty, OLD.portion_unit) IS NOT NULL
       AND app.stock_unit_cost_in(NEW.unit_cost, NEW.unit, tsi.unit, NEW.portion_qty, NEW.portion_unit) IS NULL
     UNION ALL
    SELECT format('preparo "%s" (linha em %s)', p.name, pi.unit)
      FROM public.preparation_items pi
      JOIN public.preparations p ON p.id = pi.preparation_id
     WHERE pi.stock_item_id = NEW.id
       AND app.stock_unit_cost_in(OLD.unit_cost, OLD.unit, pi.unit, OLD.portion_qty, OLD.portion_unit) IS NOT NULL
       AND app.stock_unit_cost_in(NEW.unit_cost, NEW.unit, pi.unit, NEW.portion_qty, NEW.portion_unit) IS NULL
     LIMIT 3
  ) q;

  IF v_broken IS NOT NULL THEN
    RAISE EXCEPTION
      'Essa mudança em "%" deixaria receitas sem como calcular o custo: %.',
      NEW.name, v_broken
      USING ERRCODE = '23514',
            HINT = 'Ajuste a unidade dessas linhas na ficha/preparo antes de mudar a unidade ou apagar o peso por unidade do insumo.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_stock_items_unit_guard ON public.stock_items;
CREATE TRIGGER trg_stock_items_unit_guard
  BEFORE UPDATE OF unit, portion_qty, portion_unit ON public.stock_items
  FOR EACH ROW EXECUTE FUNCTION app.assert_stock_unit_keeps_recipes();

-- ============================================================================
-- GRANTs (CLAUDE.md §5.2)
-- ============================================================================
-- Nenhuma das três funções é SECURITY DEFINER: rodam como o role que escreveu na
-- tabela, então esse role precisa de USAGE em `app` + EXECUTE.
GRANT USAGE ON SCHEMA app TO authenticated, anon, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO authenticated, anon, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO authenticated, anon, service_role;
