-- ============================================================================
-- Agilizone — leitura de secrets do Vault pela edge function
-- ----------------------------------------------------------------------------
-- A edge function agilizone-ingest lê client_secret e o shared-secret de
-- disparo do Supabase Vault via este RPC (service_role-only).
--
-- Os VALORES dos secrets NÃO ficam aqui (são segredos). Popular fora da
-- migration (uma vez), ex.:
--   select vault.create_secret('{"<client_id>":"<client_secret>"}', 'agilizone_client_secrets');
--   select vault.create_secret(gen_random_uuid()::text, 'agilizone_ingest_secret');
-- ============================================================================

create or replace function public.agilizone_get_secret(p_name text)
returns text
language sql
security definer
set search_path = 'public','pg_temp'
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1;
$$;

revoke execute on function public.agilizone_get_secret(text) from public, anon, authenticated;
grant execute on function public.agilizone_get_secret(text) to service_role;
