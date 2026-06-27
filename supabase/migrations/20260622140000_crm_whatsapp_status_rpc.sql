-- ============================================================================
-- CRM/WhatsApp — leitura de STATUS da conexão (não-secreta) + colunas p/ Embedded Signup
-- ----------------------------------------------------------------------------
-- crm_whatsapp_config é service_role-only (guarda o token criptografado). A UI
-- precisa só do STATUS (conectado? qual número? ativo?), nunca do token. Expomos
-- via RPC SECURITY DEFINER que valida acesso ao módulo 'crm' e devolve apenas
-- campos não-secretos. Segue CLAUDE.md §5.1 (auth.uid() check + validação de role).
-- ============================================================================

-- Colunas usadas pelo Embedded Signup (token vem do fluxo da Meta).
alter table public.crm_whatsapp_config
  add column if not exists business_id      text,
  add column if not exists token_expires_at timestamptz;

create or replace function public.crm_whatsapp_status(p_tenant uuid)
returns table (
  connected        boolean,
  is_active        boolean,
  display_phone    text,
  phone_number_id  text,
  waba_id          text,
  business_id      text,
  token_expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = 'public','app','pg_temp'
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not app.can_access_module(p_tenant, 'crm') then
    raise exception 'forbidden';
  end if;

  return query
  select
    (c.access_token_encrypted is not null) as connected,
    coalesce(c.is_active, false)           as is_active,
    c.display_phone,
    c.phone_number_id,
    c.waba_id,
    c.business_id,
    c.token_expires_at
  from public.crm_whatsapp_config c
  where c.tenant_id = p_tenant;
end $$;

revoke execute on function public.crm_whatsapp_status(uuid) from public, anon;
grant  execute on function public.crm_whatsapp_status(uuid) to authenticated, service_role;
