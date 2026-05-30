-- Fase 14: per-member module access
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
  );;
