-- L2 (limpeza/segurança): módulo NPS/Feedbacks removido em 2026-05-20. As tabelas
-- fb_* ficaram órfãs (fb_responses tinha INSERT público anon). Sem FK de tabela viva
-- nem view dependendo delas. Dropa tabelas + funções + enums do módulo.
do $$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind='r' and c.relname like 'fb\_%'
  loop execute format('drop table if exists public.%I cascade', r.relname); end loop;

  for r in select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname in ('public','app') and p.proname like 'fb\_%'
  loop execute format('drop function if exists %I.%I(%s) cascade', r.nspname, r.proname, r.args); end loop;

  for r in select t.typname from pg_type t join pg_namespace n on n.oid=t.typnamespace
           where n.nspname='public' and t.typname like 'fb\_%' and t.typtype='e'
  loop execute format('drop type if exists public.%I cascade', r.typname); end loop;
end $$;
