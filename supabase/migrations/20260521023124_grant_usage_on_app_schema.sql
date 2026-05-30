-- Concede acesso ao schema utilitário `app` para os roles do Supabase.
-- Sem isso, qualquer RLS policy ou trigger que invoque app.has_tenant_role()
-- ou app.is_tenant_member() falha com "permission denied for schema app".
GRANT USAGE ON SCHEMA app TO authenticated, anon, service_role;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app
  TO authenticated, anon, service_role;

-- Garante que funções criadas no futuro no schema app já nasçam executáveis.
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO authenticated, anon, service_role;;
