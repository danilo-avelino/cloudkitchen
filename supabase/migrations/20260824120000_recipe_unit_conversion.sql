-- Ficha técnica medida em unidade diferente da do estoque (kg × un).
--
-- Até aqui, `tech_sheet_items.unit` / `preparation_items.unit` sempre repetiam a
-- unidade do `stock_items` de origem, então propagar custo era cópia direta:
--   tech_sheet_items.unit_cost := stock_items.unit_cost
--
-- Com a ficha podendo medir em kg um insumo cadastrado em "un" (e vice-versa),
-- essa cópia passa a estar errada: gravaria R$/un numa linha medida em kg,
-- inflando `line_cost` (coluna GERADA = qty * unit_cost) pelo peso da unidade.
--
-- A conversão usa `stock_items.portion_qty` (peso de 1 unidade) — o MESMO campo
-- que a Produção usa para aproveitamento/desperdício, alimentado pelo cadastro do
-- insumo em Estoque e agora também pelo modal da ficha técnica.
--
-- Idempotente: só CREATE OR REPLACE de funções existentes + GRANTs.

-- ============================================================================
-- app.stock_unit_cost_in — custo do insumo na unidade usada pela receita
-- ============================================================================
-- Espelha stockItemCostIn() em lib-supabase.jsx. Sem par conversível conhecido
-- (ou sem peso cadastrado), devolve o custo original: nunca fica pior do que o
-- comportamento anterior, que era cópia direta.
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
  v_from text := lower(coalesce(p_stock_unit, ''));
  v_to   text := lower(coalesce(p_target_unit, ''));
  v_kg   numeric;  -- peso de 1 unidade, em kg
BEGIN
  IF v_to = '' OR v_from = v_to THEN
    RETURN p_cost;
  END IF;

  v_kg := CASE
    WHEN p_portion_qty IS NULL OR p_portion_qty <= 0 THEN NULL
    WHEN lower(coalesce(p_portion_unit, 'kg')) = 'g'  THEN p_portion_qty / 1000
    ELSE p_portion_qty
  END;

  IF v_kg IS NULL THEN
    RETURN p_cost;
  END IF;

  IF v_from = 'un' AND v_to = 'kg' THEN
    RETURN p_cost / v_kg;   -- insumo em un -> custo por kg
  ELSIF v_from = 'kg' AND v_to = 'un' THEN
    RETURN p_cost * v_kg;   -- insumo em kg -> custo por unidade
  END IF;

  RETURN p_cost;
END;
$function$;

-- ============================================================================
-- propagate_stock_item_cost — trigger de preço do insumo, agora com conversão
-- ============================================================================
-- Mudanças em relação a 20260510032658:
--   1. usa app.stock_unit_cost_in() no lugar da cópia direta de unit_cost;
--   2. dispara também quando portion_qty/portion_unit mudam — cadastrar o peso
--      depois passa a corrigir as fichas que já medem em kg;
--   3. ganha SET search_path (CLAUDE.md §5.1), que a versão original não tinha.
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
    WHERE tsi.stock_item_id = NEW.id;

    UPDATE public.preparation_items pi
    SET unit_cost  = app.stock_unit_cost_in(
          NEW.unit_cost, NEW.unit, pi.unit, NEW.portion_qty, NEW.portion_unit),
        total_cost = pi.qty * app.stock_unit_cost_in(
          NEW.unit_cost, NEW.unit, pi.unit, NEW.portion_qty, NEW.portion_unit)
    WHERE pi.stock_item_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- recompute_all_costs — mesma conversão no recálculo manual
-- ============================================================================
-- Base: 20260527122400 (hardening do DEFINER). Só os blocos 1 e 2 mudam — o
-- bloco 3 (custo vindo de preparação) não envolve unidade de estoque.
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
      AND tsi.unit_cost IS DISTINCT FROM app.stock_unit_cost_in(si.unit_cost, si.unit, tsi.unit, si.portion_qty, si.portion_unit)
    RETURNING tsi.id
  )
  SELECT COUNT(*) INTO v_ts_items_stock FROM upd;

  -- 3. tech_sheet_items vinculados a preparations → recalcula via yield
  WITH prep_costs AS (
    SELECT p.id AS prep_id,
           COALESCE(SUM(pi.total_cost), 0) / NULLIF(p.yield_qty, 0) AS new_unit_cost
      FROM public.preparations p
 LEFT JOIN public.preparation_items pi ON pi.preparation_id = p.id
     WHERE p.tenant_id = p_tenant
  GROUP BY p.id, p.yield_qty
  ),
  upd AS (
    UPDATE public.tech_sheet_items tsi
    SET unit_cost = pc.new_unit_cost
    FROM prep_costs pc, public.tech_sheets ts
    WHERE tsi.source_prep_id = pc.prep_id
      AND tsi.tech_sheet_id  = ts.id
      AND ts.tenant_id       = p_tenant
      AND tsi.unit_cost IS DISTINCT FROM pc.new_unit_cost
    RETURNING tsi.id
  )
  SELECT COUNT(*) INTO v_ts_items_prep FROM upd;

  RETURN jsonb_build_object(
    'prep_items_updated', v_prep_items_updated,
    'ts_items_from_stock', v_ts_items_stock,
    'ts_items_from_prep',  v_ts_items_prep
  );
END;
$function$;

-- ============================================================================
-- GRANTs (CLAUDE.md §5.2 / §5.3)
-- ============================================================================
-- propagate_stock_item_cost NÃO é SECURITY DEFINER: roda como o role que fez o
-- UPDATE em stock_items, então esse role precisa de USAGE em `app` + EXECUTE na
-- função nova. Sem isso todo UPDATE de insumo falharia com
-- "permission denied for schema app".
GRANT USAGE ON SCHEMA app TO authenticated, anon, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO authenticated, anon, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO authenticated, anon, service_role;

GRANT EXECUTE ON FUNCTION public.recompute_all_costs(uuid) TO authenticated;
