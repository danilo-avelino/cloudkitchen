-- Fase 1a + 1b: força SECURITY INVOKER em todas as views de public (advisor: security_definer_view)
-- e bloqueia leitura anônima da view que expõe auth.users (advisor: auth_users_exposed).
--
-- Por padrão, no Supabase, uma view criada por um superuser executa com os privilégios do owner
-- (postgres) — efeito equivalente a SECURITY DEFINER, bypassando a RLS das tabelas-base. Setar
-- security_invoker=true força a view a executar com os privilégios de quem consulta, garantindo
-- que a RLS de tenant_members/stock_items/etc. seja aplicada.
--
-- Idempotente: ALTER VIEW SET é idempotente; REVOKE em grant inexistente é no-op.

ALTER VIEW public.tenant_member_profiles            SET (security_invoker = true);
ALTER VIEW public.v_cmv_theoretical_by_operation    SET (security_invoker = true);
ALTER VIEW public.v_stock_value                     SET (security_invoker = true);
ALTER VIEW public.v_kitchen_requests                SET (security_invoker = true);
ALTER VIEW public.v_stock_alerts                    SET (security_invoker = true);
ALTER VIEW public.v_tech_sheets                     SET (security_invoker = true);
ALTER VIEW public.v_cmv_daily                       SET (security_invoker = true);
ALTER VIEW public.v_purchase_orders_receipts        SET (security_invoker = true);
ALTER VIEW public.v_cmv_compare_by_operation        SET (security_invoker = true);
ALTER VIEW public.v_purchase_orders                 SET (security_invoker = true);
ALTER VIEW public.v_revenue_by_operation_day        SET (security_invoker = true);

-- tenant_member_profiles agrega auth.users.email; jamais expor a anon
REVOKE SELECT ON public.tenant_member_profiles FROM anon;

-- Garante que as outras views v_* também não estejam abertas a anon (defense in depth).
-- authenticated mantém SELECT — a RLS subjacente cuida do filtro por tenant.
REVOKE SELECT ON public.v_cmv_theoretical_by_operation FROM anon;
REVOKE SELECT ON public.v_stock_value                  FROM anon;
REVOKE SELECT ON public.v_kitchen_requests             FROM anon;
REVOKE SELECT ON public.v_stock_alerts                 FROM anon;
REVOKE SELECT ON public.v_tech_sheets                  FROM anon;
REVOKE SELECT ON public.v_cmv_daily                    FROM anon;
REVOKE SELECT ON public.v_purchase_orders_receipts     FROM anon;
REVOKE SELECT ON public.v_cmv_compare_by_operation     FROM anon;
REVOKE SELECT ON public.v_purchase_orders              FROM anon;
REVOKE SELECT ON public.v_revenue_by_operation_day     FROM anon;
;
