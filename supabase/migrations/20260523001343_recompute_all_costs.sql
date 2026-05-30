-- Recalcula todos os custos: primeiro propaga preço do estoque para preparation_items
-- e tech_sheet_items vinculados, depois recalcula tech_sheet_items que usam preparações.
CREATE OR REPLACE FUNCTION public.recompute_all_costs(p_tenant uuid)
RETURNS jsonb AS $$
DECLARE
  v_prep_items_updated int := 0;
  v_ts_items_stock int := 0;
  v_ts_items_prep int := 0;
BEGIN
  -- 1. preparation_items vinculados a stock_items → puxa unit_cost atual do estoque
  WITH upd AS (
    UPDATE public.preparation_items pi
    SET unit_cost = si.unit_cost,
        total_cost = pi.qty * si.unit_cost
    FROM public.stock_items si
    WHERE pi.stock_item_id = si.id
      AND si.tenant_id = p_tenant
      AND (pi.unit_cost IS DISTINCT FROM si.unit_cost
           OR pi.total_cost IS DISTINCT FROM (pi.qty * si.unit_cost))
    RETURNING pi.id
  )
  SELECT COUNT(*) INTO v_prep_items_updated FROM upd;

  -- 2. tech_sheet_items vinculados a stock_items → puxa unit_cost direto
  WITH upd AS (
    UPDATE public.tech_sheet_items tsi
    SET unit_cost = si.unit_cost
    FROM public.stock_items si, public.tech_sheets ts
    WHERE tsi.stock_item_id = si.id
      AND tsi.tech_sheet_id = ts.id
      AND ts.tenant_id = p_tenant
      AND tsi.unit_cost IS DISTINCT FROM si.unit_cost
    RETURNING tsi.id
  )
  SELECT COUNT(*) INTO v_ts_items_stock FROM upd;

  -- 3. tech_sheet_items vinculados a preparations → recalcula unit_cost = total_items/yield
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
      AND tsi.tech_sheet_id = ts.id
      AND ts.tenant_id = p_tenant
      AND tsi.unit_cost IS DISTINCT FROM pc.new_unit_cost
    RETURNING tsi.id
  )
  SELECT COUNT(*) INTO v_ts_items_prep FROM upd;

  RETURN jsonb_build_object(
    'prep_items_updated', v_prep_items_updated,
    'ts_items_from_stock', v_ts_items_stock,
    'ts_items_from_prep', v_ts_items_prep
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'app';

-- Permite chamar via RPC pelos membros do tenant
REVOKE ALL ON FUNCTION public.recompute_all_costs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recompute_all_costs(uuid) TO authenticated;
;
