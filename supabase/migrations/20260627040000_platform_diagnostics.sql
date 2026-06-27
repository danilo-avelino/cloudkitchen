-- ============================================================================
-- Painel de diagnóstico da plataforma (Superadmin > Sistema)
-- ----------------------------------------------------------------------------
-- Três RPCs service_role-only, chamados pela edge function `platform-diagnostics`:
--
--   1. platform_set_mgmt_token(p_token)  → grava o Personal Access Token da
--      Supabase Management API no Vault (segredo `platform_mgmt_token`). O token
--      NUNCA vai pro navegador; é gravado pela edge function e lido só por ela.
--   2. platform_get_mgmt_token()         → lê o token (pra edge function chamar a
--      Management API: advisors + logs + edge functions).
--   3. platform_diag_overview()          → diagnóstico que o próprio Postgres
--      enxerga (tabelas, tamanhos, extensões, cron, e os "lints" de segurança
--      computados em SQL). Funciona mesmo SEM o token configurado.
--
-- Segurança (CLAUDE.md §5): todas SECURITY DEFINER com search_path fixo,
-- EXECUTE revogado de public/anon/authenticated e concedido só a service_role.
-- ============================================================================

-- 1) Grava/atualiza o token da Management API no Vault -----------------------
create or replace function public.platform_set_mgmt_token(p_token text)
returns void
language plpgsql
security definer
set search_path = 'public','pg_temp'
as $$
declare
  v_id uuid;
begin
  select id into v_id from vault.decrypted_secrets where name = 'platform_mgmt_token' limit 1;
  if v_id is null then
    perform vault.create_secret(
      p_token,
      'platform_mgmt_token',
      'Supabase Management API PAT usado pelo painel de diagnostico (Superadmin > Sistema)'
    );
  else
    perform vault.update_secret(v_id, p_token);
  end if;
end $$;

revoke execute on function public.platform_set_mgmt_token(text) from public, anon, authenticated;
grant  execute on function public.platform_set_mgmt_token(text) to service_role;

-- 2) Lê o token (só a edge function service_role) ----------------------------
create or replace function public.platform_get_mgmt_token()
returns text
language sql
security definer
set search_path = 'public','pg_temp'
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'platform_mgmt_token' limit 1;
$$;

revoke execute on function public.platform_get_mgmt_token() from public, anon, authenticated;
grant  execute on function public.platform_get_mgmt_token() to service_role;

-- 3) Diagnóstico que o Postgres enxerga sozinho ------------------------------
--    Inclui os "lints" de segurança computados em SQL (reproduzem as regras do
--    linter do Supabase que dá pra checar de dentro do banco — sem depender do
--    token). Cada lint tem um `code` que o front mapeia pra explicação leiga.
create or replace function public.platform_diag_overview()
returns jsonb
language sql
security definer
set search_path = 'public','pg_temp'
as $$
  select jsonb_build_object(
    'generated_at', now(),

    'totals', jsonb_build_object(
      'public_tables',   (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
                            where n.nspname='public' and c.relkind='r'),
      'public_bytes',    (select coalesce(sum(pg_total_relation_size(c.oid)),0) from pg_class c
                            join pg_namespace n on n.oid=c.relnamespace
                            where n.nspname='public' and c.relkind='r'),
      'db_bytes',        pg_database_size(current_database()),
      'migrations',      (select count(*) from supabase_migrations.schema_migrations),
      'latest_migration',(select version from supabase_migrations.schema_migrations order by version desc limit 1),
      'extensions',      (select count(*) from pg_extension),
      'cron_jobs',       (select count(*) from cron.job),
      'cron_jobs_active',(select count(*) from cron.job where active)
    ),

    -- 15 maiores tabelas do schema public
    'tables', (
      select coalesce(jsonb_agg(t order by (t->>'bytes')::bigint desc), '[]'::jsonb) from (
        select jsonb_build_object(
                 'name', c.relname,
                 'bytes', pg_total_relation_size(c.oid),
                 'pretty', pg_size_pretty(pg_total_relation_size(c.oid)),
                 'est_rows', greatest(c.reltuples::bigint, 0)
               ) as t
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind='r'
        order by pg_total_relation_size(c.oid) desc
        limit 15
      ) x
    ),

    -- extensões instaladas (com versão)
    'extensions', (
      select coalesce(jsonb_agg(jsonb_build_object('name', extname, 'version', extversion) order by extname), '[]'::jsonb)
      from pg_extension
    ),

    -- jobs agendados (pg_cron)
    'cron_jobs', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'jobid', jobid, 'schedule', schedule, 'active', active,
               'command', left(command, 180)
             ) order by jobid), '[]'::jsonb)
      from cron.job
    ),

    -- lints de segurança computáveis em SQL -------------------------------
    'lints', (
      -- (a) RLS ligada sem nenhuma policy → ninguém lê/escreve a tabela
      select coalesce(jsonb_agg(l), '[]'::jsonb) from (
        select jsonb_build_object('code','rls_enabled_no_policy','level','INFO',
                 'object', n.nspname||'.'||c.relname) as l
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind='r' and c.relrowsecurity=true
          and not exists (select 1 from pg_policy p where p.polrelid=c.oid)

        union all
        -- (b) função SECURITY DEFINER em public executável por usuário logado
        select jsonb_build_object('code','definer_exposed','level','WARN',
                 'object','public.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')')
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prosecdef=true
          and has_function_privilege('authenticated', p.oid, 'EXECUTE')

        union all
        -- (c) extensão instalada no schema public
        select jsonb_build_object('code','extension_in_public','level','WARN',
                 'object','public.'||e.extname)
        from pg_extension e join pg_namespace n on n.oid=e.extnamespace
        where n.nspname='public'

        union all
        -- (d) função SECURITY DEFINER em public sem search_path fixado
        select jsonb_build_object('code','function_no_search_path','level','WARN',
                 'object','public.'||p.proname)
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prosecdef=true
          and not exists (
            select 1 from unnest(coalesce(p.proconfig,'{}'::text[])) cfg where cfg like 'search_path=%'
          )
      ) l
    )
  );
$$;

revoke execute on function public.platform_diag_overview() from public, anon, authenticated;
grant  execute on function public.platform_diag_overview() to service_role;

-- GRANTs de garantia para service_role no schema public (CLAUDE.md §5.3) -----
grant usage on schema public to service_role;
grant all on all functions in schema public to service_role;
