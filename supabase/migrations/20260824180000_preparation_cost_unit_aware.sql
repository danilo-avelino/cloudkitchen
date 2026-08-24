-- Propagação de custo PREPARO → FICHA passa a respeitar a unidade da linha.
--
-- Mesma armadilha já corrigida do lado do estoque em `20260824120000` /
-- `20260824160000`, agora no outro caminho: `propagate_preparation_cost()` e
-- `propagate_preparation_yield_change()` gravavam `total ÷ yield_qty` — que é o
-- custo por unidade de RENDIMENTO do preparo — em toda `tech_sheet_items` com
-- aquele `source_prep_id`, ignorando a `unit` da linha.
--
-- Com a ficha podendo medir em `g` um preparo que rende em `kg`, isso deixaria a
-- linha 1000× mais cara na primeira edição do preparo. Reusa
-- `app.stock_unit_cost_in(...)` passando o rendimento como unidade de origem e
-- peso NULL: só o par kg ↔ g converte, o resto cai no fallback (devolve o custo
-- original), que é exatamente o comportamento anterior.
--
-- De quebra, as duas funções ganham o `SET search_path` que faltava (CLAUDE.md §5.1)
-- e o trigger de rendimento passa a disparar também quando `yield_unit` muda — sem
-- isso, trocar o rendimento de kg para und deixaria as fichas com o custo antigo.
--
-- Idempotente: CREATE OR REPLACE + recriação dos triggers.

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

  -- Custo por unidade de rendimento, convertido para a unidade de cada linha.
  UPDATE public.tech_sheet_items tsi
  SET unit_cost = app.stock_unit_cost_in(new_unit_cost, yield_unit, tsi.unit, NULL, NULL)
  WHERE tsi.source_prep_id = prep_id;

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
  -- yield_unit entra na condição: trocar kg por und muda a base do custo das
  -- fichas que medem esse preparo, mesmo com a quantidade intacta.
  IF NEW.yield_qty  IS DISTINCT FROM OLD.yield_qty
  OR NEW.yield_unit IS DISTINCT FROM OLD.yield_unit THEN

    SELECT COALESCE(SUM(total_cost), 0) INTO v_total
      FROM public.preparation_items WHERE preparation_id = NEW.id;

    v_yield := NEW.yield_qty;
    IF v_yield IS NULL OR v_yield <= 0 THEN v_yield := 1; END IF;
    v_unit_cost := v_total / v_yield;

    UPDATE public.tech_sheet_items tsi
    SET unit_cost = app.stock_unit_cost_in(v_unit_cost, NEW.yield_unit, tsi.unit, NULL, NULL)
    WHERE tsi.source_prep_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

-- ============================================================================
-- recompute_all_costs — bloco 3 (fichas alimentadas por preparação)
-- ============================================================================
-- Base: `20260824120000` (que por sua vez veio de `20260527122400`). Blocos 1 e 2
-- ficam idênticos; só o 3 ganha a conversão pela unidade da linha.
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
      AND tsi.unit_cost IS DISTINCT FROM app.stock_unit_cost_in(pc.new_unit_cost, pc.yield_unit, tsi.unit, NULL, NULL)
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
-- GRANTs (CLAUDE.md §5.2)
-- ============================================================================
-- Os dois triggers de preparação NÃO são SECURITY DEFINER: rodam como o role que
-- editou o preparo, então precisam de USAGE em `app` + EXECUTE na função.
GRANT USAGE ON SCHEMA app TO authenticated, anon, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO authenticated, anon, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO authenticated, anon, service_role;

GRANT EXECUTE ON FUNCTION public.recompute_all_costs(uuid) TO authenticated;
