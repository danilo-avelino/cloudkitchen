-- Garante que as views consolidadas respeitem RLS do invocador
-- (sem isso o Postgres usa security definer por default e ignora RLS).
ALTER VIEW public.v_closing_checklist  SET (security_invoker = true);
ALTER VIEW public.v_dre_monthly        SET (security_invoker = true);
ALTER VIEW public.v_cmv_real_monthly   SET (security_invoker = true);;
