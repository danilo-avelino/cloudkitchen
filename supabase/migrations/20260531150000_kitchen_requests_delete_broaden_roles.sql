-- A UX "zerar itens = excluir requisição" está disponível para todos os papéis que
-- editam (owner/admin/manager/stock/kitchen), mas a policy de DELETE só permitia
-- owner/admin → o delete era filtrado pela RLS (0 linhas, sem erro) e a requisição
-- reaparecia no reload. Amplia o DELETE para os mesmos papéis do UPDATE/INSERT.
DROP POLICY IF EXISTS kitchen_requests_delete ON public.kitchen_requests;
CREATE POLICY kitchen_requests_delete ON public.kitchen_requests
  FOR DELETE
  USING (
    app.has_tenant_role(
      tenant_id,
      ARRAY['owner','admin','manager','stock','kitchen']::app.member_role[]
    )
  );
