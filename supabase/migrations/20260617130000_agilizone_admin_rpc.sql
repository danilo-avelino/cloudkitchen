-- ============================================================================
-- Agilizone — RPC para a edge function de administração gravar o client_secret
-- no Vault (upsert no mapa 'agilizone_client_secrets'). service_role-only.
-- ============================================================================

create or replace function public.agilizone_set_client_secret(p_client_id text, p_secret text)
returns void
language plpgsql
security definer
set search_path = 'public','pg_temp'
as $$
declare
  v_id   uuid;
  v_json jsonb;
begin
  select id, decrypted_secret::jsonb into v_id, v_json
  from vault.decrypted_secrets where name = 'agilizone_client_secrets' limit 1;

  if v_id is null then
    perform vault.create_secret(
      jsonb_build_object(p_client_id, p_secret)::text,
      'agilizone_client_secrets',
      'Mapa client_id->client_secret da Agilizone'
    );
  else
    perform vault.update_secret(
      v_id,
      (coalesce(v_json, '{}'::jsonb) || jsonb_build_object(p_client_id, p_secret))::text
    );
  end if;
end $$;

revoke execute on function public.agilizone_set_client_secret(text, text) from public, anon, authenticated;
grant execute on function public.agilizone_set_client_secret(text, text) to service_role;
