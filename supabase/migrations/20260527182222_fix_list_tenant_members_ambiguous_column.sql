-- Fix: "column reference tenant_id is ambiguous" em public.list_tenant_members.
--
-- Causa: RETURNS TABLE(tenant_id uuid, user_id uuid, ...) declara variáveis OUT
-- com os mesmos nomes das colunas das tabelas internas. Dentro do corpo, PL/pgSQL
-- não sabe se `tenant_id` é a variável OUT ou a coluna de tenant_members.
--
-- Solução: diretiva `#variable_conflict use_column` faz nomes das colunas das
-- tabelas terem precedência sobre variáveis. Padrão recomendado pelo PostgreSQL
-- para funções com RETURNS TABLE que filtram pelas mesmas colunas.
-- (https://www.postgresql.org/docs/current/plpgsql-implementation.html#PLPGSQL-VAR-SUBST)

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
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'forbidden: not authenticated' USING ERRCODE = '42501';
  END IF;

  IF auth.role() <> 'service_role' AND NOT EXISTS (
    SELECT 1
      FROM public.tenant_members tm
     WHERE tm.tenant_id = p_tenant
       AND tm.user_id   = auth.uid()
  ) THEN
    RAISE EXCEPTION 'forbidden: caller is not a member of tenant %', p_tenant
      USING ERRCODE = '42501';
  END IF;

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
;
