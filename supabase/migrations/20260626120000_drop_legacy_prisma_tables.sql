-- Remove as tabelas Prisma legadas (renomeadas _legacy_* na auditoria 2026-05-27).
-- Sem escrita desde então; nenhuma FK de tabela viva, view ou função as referencia.
-- _legacy_SyncLog sozinha = ~3 GB (92% do banco). CASCADE só afeta deps entre legacy.
-- Resultado: banco caiu de ~3.276 MB para ~161 MB.
do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like '\_legacy\_%'
  loop
    execute format('drop table if exists public.%I cascade', r.relname);
  end loop;
end $$;
