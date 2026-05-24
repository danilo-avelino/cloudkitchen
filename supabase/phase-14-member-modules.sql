-- Fase 14: per-member module access
-- Adiciona coluna `modules text[]` em tenant_members e expõe na view
-- tenant_member_profiles. NULL = usa preset do role (compat com membros antigos).

-- Restaura privilégios do service_role no schema public (edge functions os usam)
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;

ALTER TABLE public.tenant_members
  ADD COLUMN IF NOT EXISTS modules text[] NULL;

-- View precisa ser DROPada (não CREATE OR REPLACE) porque a ordem das colunas mudou
DROP VIEW IF EXISTS public.tenant_member_profiles;
CREATE VIEW public.tenant_member_profiles AS
SELECT
  tm.tenant_id, tm.user_id, tm.role, tm.joined_at, tm.ops, tm.modules,
  p.full_name, p.avatar_url,
  au.email
FROM public.tenant_members tm
LEFT JOIN public.profiles p ON p.id = tm.user_id
LEFT JOIN auth.users au ON au.id = tm.user_id;

ALTER VIEW public.tenant_member_profiles OWNER TO postgres;
GRANT SELECT ON public.tenant_member_profiles TO authenticated;

-- Permite owner/admin/manager renomearem o profile (full_name) de membros
-- do MESMO tenant. Sem isso, o rename via UI silencia (RLS bloqueia).
DROP POLICY IF EXISTS profiles_tenant_admin_update ON public.profiles;
CREATE POLICY profiles_tenant_admin_update ON public.profiles
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.tenant_members tm_target
      JOIN public.tenant_members tm_actor
        ON tm_actor.tenant_id = tm_target.tenant_id
      WHERE tm_target.user_id = profiles.id
        AND tm_actor.user_id  = auth.uid()
        AND tm_actor.role IN ('owner','admin','manager')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.tenant_members tm_target
      JOIN public.tenant_members tm_actor
        ON tm_actor.tenant_id = tm_target.tenant_id
      WHERE tm_target.user_id = profiles.id
        AND tm_actor.user_id  = auth.uid()
        AND tm_actor.role IN ('owner','admin','manager')
    )
  );
