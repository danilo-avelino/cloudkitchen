-- Fase 1c: hardening dos dois RPCs SECURITY DEFINER expostos via PostgREST.
--
-- Problema 1 (advisor: anon_security_definer_function_executable):
--   public.create_tenant_with_owner(text, text) é SECURITY DEFINER e executável por anon.
--   Decisão do owner: só service_role pode chamar. Signup vai via edge function
--   (TODO já documentado em page-superadmin.jsx → função `provision-tenant`).
--
-- Problema 2 (advisor: authenticated_security_definer_function_executable):
--   public.recompute_all_costs(uuid) é SECURITY DEFINER, executável por qualquer authenticated,
--   e NÃO valida se auth.uid() é membro do p_tenant. Tenant escape: qualquer usuário logado
--   conseguia recomputar custos de QUALQUER tenant.
--   Fix: validação interna exigindo membership owner/admin OU service_role.
--
-- Idempotente: REVOKE em grant ausente é no-op; CREATE OR REPLACE substitui a função.

-- ============================================================================
-- create_tenant_with_owner: revoga EXECUTE de PUBLIC/anon/authenticated
-- ============================================================================
REVOKE EXECUTE ON FUNCTION public.create_tenant_with_owner(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_tenant_with_owner(text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_tenant_with_owner(text, text) FROM authenticated;
-- service_role e postgres mantêm EXECUTE implicitamente (são owners/superusers)

-- ============================================================================
-- recompute_all_costs: adiciona validação de membership (owner/admin) ou service_role
-- ============================================================================
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

  -- 1. preparation_items vinculados a stock_items → puxa unit_cost atual do estoque
  WITH upd AS (
    UPDATE public.preparation_items pi
    SET unit_cost  = si.unit_cost,
        total_cost = pi.qty * si.unit_cost
    FROM public.stock_items si
    WHERE pi.stock_item_id = si.id
      AND si.tenant_id     = p_tenant
      AND (pi.unit_cost  IS DISTINCT FROM si.unit_cost
        OR pi.total_cost IS DISTINCT FROM (pi.qty * si.unit_cost))
    RETURNING pi.id
  )
  SELECT COUNT(*) INTO v_prep_items_updated FROM upd;

  -- 2. tech_sheet_items vinculados a stock_items
  WITH upd AS (
    UPDATE public.tech_sheet_items tsi
    SET unit_cost = si.unit_cost
    FROM public.stock_items si, public.tech_sheets ts
    WHERE tsi.stock_item_id = si.id
      AND tsi.tech_sheet_id = ts.id
      AND ts.tenant_id      = p_tenant
      AND tsi.unit_cost IS DISTINCT FROM si.unit_cost
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

-- Mantém EXECUTE pra authenticated (admins/owners legítimos chamam pelo UI),
-- mas a validação interna agora bloqueia tenant escape.
GRANT EXECUTE ON FUNCTION public.recompute_all_costs(uuid) TO authenticated;
;
