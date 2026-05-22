-- Fase 12: Multi-user management
-- View para acessar email de auth.users via tenant_members
-- RLS policies para controle de acesso
-- Column ops para escopo de operações por membro

-- Add ops column to tenant_members if not exists (BEFORE view creation)
ALTER TABLE public.tenant_members
  ADD COLUMN IF NOT EXISTS ops jsonb DEFAULT '[]'::jsonb;

-- Create view joining tenant_members + profiles + auth.users
CREATE OR REPLACE VIEW public.tenant_member_profiles AS
SELECT
  tm.tenant_id, tm.user_id, tm.role, tm.joined_at, tm.ops,
  p.full_name, p.avatar_url,
  au.email
FROM public.tenant_members tm
LEFT JOIN public.profiles p ON p.id = tm.user_id
LEFT JOIN auth.users au ON au.id = tm.user_id;

-- RLS on view (read-only; actual modifications go through tenant_members table policies)
ALTER VIEW public.tenant_member_profiles OWNER TO postgres;

-- Ensure authenticated users can select from the view (RLS will filter by tenant_id)
GRANT SELECT ON public.tenant_member_profiles TO authenticated;

-- Enable RLS if not already enabled
ALTER TABLE public.tenant_members ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (idempotent)
DROP POLICY IF EXISTS "members_read_own_tenant" ON public.tenant_members;
DROP POLICY IF EXISTS "members_manage" ON public.tenant_members;

-- Policy: members can read their own tenant's members
CREATE POLICY "members_read_own_tenant" ON public.tenant_members
  FOR SELECT
  USING (app.is_member(tenant_id));

-- Policy: admin/manager can INSERT/UPDATE/DELETE members of their tenant
CREATE POLICY "members_manage" ON public.tenant_members
  FOR ALL
  USING (app.is_admin_or_manager(tenant_id));

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_tenant_members_role ON public.tenant_members(tenant_id, role);
