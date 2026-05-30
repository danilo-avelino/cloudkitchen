-- Fix para "permission denied for table users" em Configurações > Usuários.
--
-- Causa: a view public.tenant_member_profiles faz JOIN com auth.users.email.
-- Depois que ativei security_invoker=true nela (auditoria 2026-05-27), a view
-- passou a executar com privilégios do role `authenticated`, que NÃO tem
-- SELECT em auth.users — daí o erro.
--
-- Fix: substituir o uso da view por uma RPC SECURITY DEFINER que valida
-- internamente que auth.uid() é membro do tenant solicitado. Sem isso,
-- qualquer authenticated com p_tenant aleatório poderia listar membros
-- (tenant escape). A função segue exatamente o padrão definido em CLAUDE.md
-- (Nova RPC SECURITY DEFINER): auth.uid() check + validação de membership +
-- search_path fixo + REVOKE de PUBLIC.

CREATE OR REPLACE FUNCTION public.list_tenant_members(p_tenant uuid)
RETURNS TABLE (
  tenant_id  uuid,
  user_id    uuid,
  role       text,
  joined_at  timestamptz,
  ops        text[],
  modules    jsonb,
  full_name  text,
  avatar_url text,
  email      text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'app', 'public', 'pg_temp'
AS $function$
BEGIN
  -- 1. Precisa estar autenticado
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'forbidden: not authenticated' USING ERRCODE = '42501';
  END IF;

  -- 2. Caller precisa ser membro do tenant (qualquer role — todos veem a lista)
  --    service_role bypassa (para edge functions de onboarding/admin)
  IF auth.role() <> 'service_role' AND NOT EXISTS (
    SELECT 1
      FROM public.tenant_members
     WHERE tenant_id = p_tenant
       AND user_id   = auth.uid()
  ) THEN
    RAISE EXCEPTION 'forbidden: caller is not a member of tenant %', p_tenant
      USING ERRCODE = '42501';
  END IF;

  -- 3. Retorna o mesmo shape da antiga view tenant_member_profiles
  RETURN QUERY
    SELECT tm.tenant_id,
           tm.user_id,
           tm.role::text,
           tm.joined_at,
           tm.ops,
           tm.modules,
           p.full_name,
           p.avatar_url,
           au.email::text
      FROM public.tenant_members tm
      LEFT JOIN public.profiles  p  ON p.id  = tm.user_id
      LEFT JOIN auth.users       au ON au.id = tm.user_id
     WHERE tm.tenant_id = p_tenant
  ORDER BY tm.joined_at ASC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.list_tenant_members(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.list_tenant_members(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.list_tenant_members(uuid) TO authenticated;
;
