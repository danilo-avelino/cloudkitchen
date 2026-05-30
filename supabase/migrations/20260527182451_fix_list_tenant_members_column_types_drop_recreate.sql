-- Postgres não permite mudar tipos do RETURNS TABLE via CREATE OR REPLACE.
-- DROP + CREATE pra trocar ops (jsonb) e modules (text[]) na assinatura.

DROP FUNCTION IF EXISTS public.list_tenant_members(uuid);

CREATE FUNCTION public.list_tenant_members(p_tenant uuid)
RETURNS TABLE (
  tenant_id  uuid,
  user_id    uuid,
  role       text,
  joined_at  timestamptz,
  ops        jsonb,
  modules    text[],
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

-- Re-aplica grants (DROP perde os grants)
REVOKE EXECUTE ON FUNCTION public.list_tenant_members(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.list_tenant_members(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.list_tenant_members(uuid) TO authenticated;
;
