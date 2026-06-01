-- Lançar despesas (finance_entries) falhava com erro de RLS para o papel
-- `accountant` (ex.: adm.grupoavelino@gmail.com): a policy de escrita só permitia
-- owner/admin/manager (app.is_admin_or_manager), mas o frontend libera o módulo
-- "finance" também para accountant e para qualquer membro com `modules` custom
-- incluindo "finance" (ver getAllowedModules em shell.jsx).
--
-- Solução: a RLS de escrita passa a espelhar exatamente getAllowedModules — quem
-- enxerga o módulo financeiro pode preencher/adicionar lançamentos.

-- Presets padrão de módulos por papel (espelha ROLE_DEFAULT_MODULES em shell.jsx).
CREATE OR REPLACE FUNCTION app.role_default_modules(p_role app.member_role)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = 'public', 'app', 'pg_temp'
AS $$
  SELECT CASE p_role
    WHEN 'owner'      THEN ARRAY['dashboard','stock','recipes','revenue','requests','purchases','cmv','finance','dre','analise-mercado','settings']
    WHEN 'admin'      THEN ARRAY['dashboard','stock','recipes','revenue','requests','purchases','cmv','finance','dre','analise-mercado','settings']
    WHEN 'manager'    THEN ARRAY['dashboard','stock','recipes','revenue','requests','purchases','cmv','finance','dre','analise-mercado']
    WHEN 'kitchen'    THEN ARRAY['dashboard','stock','requests','recipes']
    WHEN 'stock'      THEN ARRAY['dashboard','stock','requests','purchases']
    WHEN 'accountant' THEN ARRAY['dashboard','revenue','cmv','finance','dre']
    WHEN 'viewer'     THEN ARRAY['dashboard']
    ELSE ARRAY['dashboard']
  END;
$$;

-- O membro pode acessar o módulo p_module no tenant?
-- Espelha getAllowedModules: owner/admin veem tudo; senão `modules` custom
-- (quando preenchido) tem prioridade; senão cai no preset do papel.
CREATE OR REPLACE FUNCTION app.can_access_module(p_tenant uuid, p_module text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public', 'app', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tenant_members tm
    WHERE tm.tenant_id = p_tenant
      AND tm.user_id   = auth.uid()
      AND (
        tm.role IN ('owner','admin')
        OR (
          tm.modules IS NOT NULL
          AND array_length(tm.modules, 1) > 0
          AND p_module = ANY(tm.modules)
        )
        OR (
          (tm.modules IS NULL OR array_length(tm.modules, 1) IS NULL)
          AND p_module = ANY(app.role_default_modules(tm.role))
        )
      )
  );
$$;

-- GRANTs (CLAUDE.md 5.2): resolução do nome app.* exige USAGE/EXECUTE pelo role chamador.
GRANT EXECUTE ON FUNCTION app.role_default_modules(app.member_role) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION app.can_access_module(uuid, text) TO authenticated, anon, service_role;

-- Escrita de lançamentos: quem vê o financeiro pode preencher/adicionar.
DROP POLICY IF EXISTS finance_entries_write ON public.finance_entries;
CREATE POLICY finance_entries_write ON public.finance_entries
  FOR ALL
  USING (app.can_access_module(tenant_id, 'finance'))
  WITH CHECK (app.can_access_module(tenant_id, 'finance'));
