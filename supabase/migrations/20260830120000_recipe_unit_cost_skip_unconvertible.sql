-- Conversão impossível deixa de gravar o custo cru na linha da ficha.
--
-- Bug em produção (2026-08-30): "Recalcular custos" jogava o custo de 105 g de
-- REQUEIJÃO para R$ 7.367,85.
--
--   estoque: REQUEIJÃO CATUPIRY (1,5KG) · unit = 'un' · R$ 70,17 · portion_qty NULL
--   ficha:   105 g  ->  app.stock_unit_cost_in(70.17,'un','g',NULL,NULL)
--
-- Sem `portion_qty` não há como saber quanto pesa 1 unidade, então a função caía
-- no fallback documentado em `20260824120000` ("devolve o custo original · nunca
-- fica pior do que a cópia direta") e devolvia 70,17 — que o RPC gravava como
-- R$/g. `line_cost` (coluna GERADA = qty × unit_cost) virava 105 × 70,17.
--
-- O fallback era inofensivo quando a cópia direta era o normal, mas com um botão
-- que reescreve TODAS as linhas ele deixou de ser "não piora": ele sobrescreve o
-- custo correto (gravado pelo front, que converte certo) por um número ~1000x
-- maior. `stockItemCostIn()` no front já devolve null nesse caso — é o que
-- destrava o modal "qual o peso de 1 unidade?". A função do banco passa a fazer
-- o mesmo, e quem chama pula a linha em vez de gravar chute.
--
-- De quebra, 'und'/'unid'/'unidade' passam a ser normalizadas para 'un' (espelha
-- `_normUnit` no front): sem isso uma linha em 'und' de um insumo em 'un' deixaria
-- de ser "mesma unidade" e pararia de receber atualização de preço.
--
-- Idempotente: CREATE OR REPLACE das 4 funções + GRANTs.

-- ============================================================================
-- app.stock_unit_cost_in — NULL = "não sei converter"
-- ============================================================================
CREATE OR REPLACE FUNCTION app.stock_unit_cost_in(
  p_cost         numeric,
  p_stock_unit   text,
  p_target_unit  text,
  p_portion_qty  numeric,
  p_portion_unit text
)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = 'app', 'public', 'pg_temp'
AS $function$
DECLARE
  v_from  text := lower(coalesce(p_stock_unit, ''));
  v_to    text := lower(coalesce(p_target_unit, ''));
  v_kg    numeric;  -- peso de 1 unidade, em kg
  v_perkg numeric;  -- custo do insumo por kg
BEGIN
  -- 'und' e 'un' são a mesma unidade; sem isso o par vira "conversão" e some.
  IF v_from IN ('und', 'unid', 'unidade') THEN v_from := 'un'; END IF;
  IF v_to   IN ('und', 'unid', 'unidade') THEN v_to   := 'un'; END IF;

  IF v_to = '' OR v_from = v_to THEN
    RETURN p_cost;
  END IF;

  v_kg := CASE
    WHEN p_portion_qty IS NULL OR p_portion_qty <= 0 THEN NULL
    WHEN lower(coalesce(p_portion_unit, 'kg')) = 'g'  THEN p_portion_qty / 1000
    ELSE p_portion_qty
  END;

  -- Custo por kg. Unidade contável ('un' e afins) só resolve com o peso cadastrado.
  v_perkg := CASE
    WHEN v_from = 'kg'    THEN p_cost
    WHEN v_from = 'g'     THEN p_cost * 1000
    WHEN v_kg IS NOT NULL THEN p_cost / v_kg
    ELSE NULL
  END;

  IF v_perkg IS NULL THEN
    RETURN NULL;  -- falta o peso por unidade: quem chama mantém o custo atual
  END IF;

  IF    v_to = 'kg' THEN RETURN v_perkg;
  ELSIF v_to = 'g'  THEN RETURN v_perkg / 1000;
  ELSIF v_to = 'un' THEN RETURN CASE WHEN v_kg IS NOT NULL THEN v_perkg * v_kg END;
  END IF;

  RETURN NULL;  -- unidade fora de kg/g/un (L, cx, ...): sem regra de conversão
END;
$function$;

-- ============================================================================
-- propagate_stock_item_cost — preço do insumo mudou
-- ============================================================================
-- Base: 20260824120000. Única mudança: linha sem conversão possível fica de fora
-- do UPDATE (antes recebia o custo cru do estoque).
CREATE OR REPLACE FUNCTION public.propagate_stock_item_cost()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = 'app', 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.unit_cost    IS DISTINCT FROM OLD.unit_cost
  OR NEW.portion_qty  IS DISTINCT FROM OLD.portion_qty
  OR NEW.portion_unit IS DISTINCT FROM OLD.portion_unit THEN

    UPDATE public.tech_sheet_items tsi
    SET unit_cost = app.stock_unit_cost_in(
          NEW.unit_cost, NEW.unit, tsi.unit, NEW.portion_qty, NEW.portion_unit)
    WHERE tsi.stock_item_id = NEW.id
      AND app.stock_unit_cost_in(
            NEW.unit_cost, NEW.unit, tsi.unit, NEW.portion_qty, NEW.portion_unit) IS NOT NULL;

    UPDATE public.preparation_items pi
    SET unit_cost  = app.stock_unit_cost_in(
          NEW.unit_cost, NEW.unit, pi.unit, NEW.portion_qty, NEW.portion_unit),
        total_cost = pi.qty * app.stock_unit_cost_in(
          NEW.unit_cost, NEW.unit, pi.unit, NEW.portion_qty, NEW.portion_unit)
    WHERE pi.stock_item_id = NEW.id
      AND app.stock_unit_cost_in(
            NEW.unit_cost, NEW.unit, pi.unit, NEW.portion_qty, NEW.portion_unit) IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- propagate_preparation_cost — itens do preparo mudaram
-- ============================================================================
CREATE OR REPLACE FUNCTION public.propagate_preparation_cost()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = 'app', 'public', 'pg_temp'
AS $function$
DECLARE
  prep_id       uuid;
  total         numeric;
  yield_qty     numeric;
  yield_unit    text;
  new_unit_cost numeric;
BEGIN
  prep_id := COALESCE(NEW.preparation_id, OLD.preparation_id);

  SELECT COALESCE(SUM(total_cost), 0) INTO total
    FROM public.preparation_items WHERE preparation_id = prep_id;

  SELECT p.yield_qty, p.yield_unit INTO yield_qty, yield_unit
    FROM public.preparations p WHERE p.id = prep_id;

  IF yield_qty IS NULL OR yield_qty <= 0 THEN yield_qty := 1; END IF;
  new_unit_cost := total / yield_qty;

  UPDATE public.tech_sheet_items tsi
  SET unit_cost = app.stock_unit_cost_in(new_unit_cost, yield_unit, tsi.unit, NULL, NULL)
  WHERE tsi.source_prep_id = prep_id
    AND app.stock_unit_cost_in(new_unit_cost, yield_unit, tsi.unit, NULL, NULL) IS NOT NULL;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- ============================================================================
-- propagate_preparation_yield_change — rendimento do preparo mudou
-- ============================================================================
CREATE OR REPLACE FUNCTION public.propagate_preparation_yield_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = 'app', 'public', 'pg_temp'
AS $function$
DECLARE
  v_total     numeric;
  v_yield     numeric;
  v_unit_cost numeric;
BEGIN
  IF NEW.yield_qty  IS DISTINCT FROM OLD.yield_qty
  OR NEW.yield_unit IS DISTINCT FROM OLD.yield_unit THEN

    SELECT COALESCE(SUM(total_cost), 0) INTO v_total
      FROM public.preparation_items WHERE preparation_id = NEW.id;

    v_yield := NEW.yield_qty;
    IF v_yield IS NULL OR v_yield <= 0 THEN v_yield := 1; END IF;
    v_unit_cost := v_total / v_yield;

    UPDATE public.tech_sheet_items tsi
    SET unit_cost = app.stock_unit_cost_in(v_unit_cost, NEW.yield_unit, tsi.unit, NULL, NULL)
    WHERE tsi.source_prep_id = NEW.id
      AND app.stock_unit_cost_in(v_unit_cost, NEW.yield_unit, tsi.unit, NULL, NULL) IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- recompute_all_costs — pula o que não converte e devolve quantas linhas pulou
-- ============================================================================
-- Base: 20260824180000. Os três blocos ganham `IS NOT NULL` (sem ele o UPDATE
-- tentaria gravar NULL numa coluna NOT NULL) e o retorno ganha `unconvertible`,
-- para o front avisar que existe linha esperando o peso por unidade.
CREATE OR REPLACE FUNCTION public.recompute_all_costs(p_tenant uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'app', 'public', 'pg_temp'
AS $function$
DECLARE
  v_prep_items_updated int := 0;
  v_ts_items_stock     int := 0;
  v_ts_items_prep      int := 0;
  v_unconvertible      int := 0;
  v_caller_role        text;
BEGIN
  -- Defesa em profundidade: service_role bypassa; demais precisam ser owner/admin do tenant
  IF auth.role() <> 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'forbidden: not authenticated' USING ERRCODE = '42501';
    END IF;
    SELECT role::text INTO v_caller_role
      FROM public.tenant_members
     WHERE tenant_id = p_tenant
       AND user_id   = auth.uid();
    IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner','admin') THEN
      RAISE EXCEPTION 'forbidden: caller is not owner/admin of tenant %', p_tenant
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 1. preparation_items vinculados a stock_items → custo atual do estoque, na unidade da receita
  WITH upd AS (
    UPDATE public.preparation_items pi
    SET unit_cost  = app.stock_unit_cost_in(si.unit_cost, si.unit, pi.unit, si.portion_qty, si.portion_unit),
        total_cost = pi.qty * app.stock_unit_cost_in(si.unit_cost, si.unit, pi.unit, si.portion_qty, si.portion_unit)
    FROM public.stock_items si
    WHERE pi.stock_item_id = si.id
      AND si.tenant_id     = p_tenant
      AND app.stock_unit_cost_in(si.unit_cost, si.unit, pi.unit, si.portion_qty, si.portion_unit) IS NOT NULL
      AND (pi.unit_cost  IS DISTINCT FROM app.stock_unit_cost_in(si.unit_cost, si.unit, pi.unit, si.portion_qty, si.portion_unit)
        OR pi.total_cost IS DISTINCT FROM (pi.qty * app.stock_unit_cost_in(si.unit_cost, si.unit, pi.unit, si.portion_qty, si.portion_unit)))
    RETURNING pi.id
  )
  SELECT COUNT(*) INTO v_prep_items_updated FROM upd;

  -- 2. tech_sheet_items vinculados a stock_items
  WITH upd AS (
    UPDATE public.tech_sheet_items tsi
    SET unit_cost = app.stock_unit_cost_in(si.unit_cost, si.unit, tsi.unit, si.portion_qty, si.portion_unit)
    FROM public.stock_items si, public.tech_sheets ts
    WHERE tsi.stock_item_id = si.id
      AND tsi.tech_sheet_id = ts.id
      AND ts.tenant_id      = p_tenant
      AND app.stock_unit_cost_in(si.unit_cost, si.unit, tsi.unit, si.portion_qty, si.portion_unit) IS NOT NULL
      AND tsi.unit_cost IS DISTINCT FROM app.stock_unit_cost_in(si.unit_cost, si.unit, tsi.unit, si.portion_qty, si.portion_unit)
    RETURNING tsi.id
  )
  SELECT COUNT(*) INTO v_ts_items_stock FROM upd;

  -- 3. tech_sheet_items vinculados a preparations → custo por rendimento,
  --    convertido para a unidade da linha (kg ↔ g).
  WITH prep_costs AS (
    SELECT p.id AS prep_id,
           p.yield_unit,
           COALESCE(SUM(pi.total_cost), 0) / NULLIF(p.yield_qty, 0) AS new_unit_cost
      FROM public.preparations p
 LEFT JOIN public.preparation_items pi ON pi.preparation_id = p.id
     WHERE p.tenant_id = p_tenant
  GROUP BY p.id, p.yield_qty, p.yield_unit
  ),
  upd AS (
    UPDATE public.tech_sheet_items tsi
    SET unit_cost = app.stock_unit_cost_in(pc.new_unit_cost, pc.yield_unit, tsi.unit, NULL, NULL)
    FROM prep_costs pc, public.tech_sheets ts
    WHERE tsi.source_prep_id = pc.prep_id
      AND tsi.tech_sheet_id  = ts.id
      AND ts.tenant_id       = p_tenant
      AND app.stock_unit_cost_in(pc.new_unit_cost, pc.yield_unit, tsi.unit, NULL, NULL) IS NOT NULL
      AND tsi.unit_cost IS DISTINCT FROM app.stock_unit_cost_in(pc.new_unit_cost, pc.yield_unit, tsi.unit, NULL, NULL)
    RETURNING tsi.id
  )
  SELECT COUNT(*) INTO v_ts_items_prep FROM upd;

  -- 4. Linhas que ficaram de fora por falta de peso por unidade no insumo.
  SELECT COUNT(*) INTO v_unconvertible
    FROM public.tech_sheet_items tsi
    JOIN public.stock_items si ON si.id = tsi.stock_item_id
    JOIN public.tech_sheets ts ON ts.id = tsi.tech_sheet_id
   WHERE ts.tenant_id = p_tenant
     AND app.stock_unit_cost_in(si.unit_cost, si.unit, tsi.unit, si.portion_qty, si.portion_unit) IS NULL;

  RETURN jsonb_build_object(
    'prep_items_updated', v_prep_items_updated,
    'ts_items_from_stock', v_ts_items_stock,
    'ts_items_from_prep',  v_ts_items_prep,
    'unconvertible',       v_unconvertible
  );
END;
$function$;

-- ============================================================================
-- GRANTs (CLAUDE.md §5.2 / §5.3)
-- ============================================================================
-- Os três triggers NÃO são SECURITY DEFINER: rodam como o role que editou o
-- insumo/preparo e precisam de USAGE em `app` + EXECUTE na função.
GRANT USAGE ON SCHEMA app TO authenticated, anon, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO authenticated, anon, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO authenticated, anon, service_role;

GRANT EXECUTE ON FUNCTION public.recompute_all_costs(uuid) TO authenticated;
