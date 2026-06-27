-- Fase 1 de escala: substitui o poll monolítico (1 invocação processa TODAS as
-- contas) por fan-out via fila durável pgmq + worker com concorrência limitada.
-- scheduler enfileira 1 msg/conta; worker (edge fn) drena em paralelo, com
-- retry/visibility-timeout/DLQ nativos do pgmq. lookback incremental por conta.

create extension if not exists pgmq;

-- fila (idempotente)
do $$
begin
  if not exists (select 1 from pgmq.meta where queue_name = 'agilizone_sync') then
    perform pgmq.create('agilizone_sync');
  end if;
end $$;

-- ============ scheduler: fan-out 1 mensagem por conta ativa ============
create or replace function public.agilizone_enqueue_sync()
returns integer
language plpgsql
security definer
set search_path = 'public','pgmq','pg_temp'
as $$
declare
  r record;
  v_days  int;
  v_count int := 0;
begin
  for r in select id, last_synced_at from public.agilizone_accounts where is_active loop
    -- dedup: não empilha se já existe mensagem pendente p/ esta conta na fila
    if exists (select 1 from pgmq.q_agilizone_sync q
               where (q.message->>'accountId')::uuid = r.id) then
      continue;
    end if;
    -- lookback incremental: dias desde o último sync (1 se recém-sincronizado,
    -- 7 se nunca sincronizou), limitado a 30 p/ não explodir o backfill.
    v_days := least(30, greatest(1,
      ceil(extract(epoch from (now() - coalesce(r.last_synced_at, now() - interval '7 days'))) / 86400.0)::int));
    perform pgmq.send('agilizone_sync', jsonb_build_object('accountId', r.id, 'lookbackDays', v_days));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ============ RPCs do worker (service_role-only) ============
create or replace function public.agilizone_queue_read(p_qty int default 10, p_vt int default 180)
returns table(msg_id bigint, read_ct int, message jsonb)
language sql
security definer
set search_path = 'public','pgmq','pg_temp'
as $$ select msg_id, read_ct, message from pgmq.read('agilizone_sync', p_vt, p_qty); $$;

create or replace function public.agilizone_queue_archive(p_msg_id bigint)
returns boolean
language sql
security definer
set search_path = 'public','pgmq','pg_temp'
as $$ select pgmq.archive('agilizone_sync', p_msg_id); $$;

-- ============ trigger do worker via pg_net (chamado pelo cron) ============
create or replace function public.agilizone_run_worker()
returns bigint
language plpgsql
security definer
set search_path = 'public','pg_temp'
as $$
declare v_secret text; v_req bigint;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'agilizone_ingest_secret' limit 1;
  if v_secret is null then raise exception 'agilizone_ingest_secret ausente no Vault'; end if;
  select net.http_post(
    url := 'https://dnvrerivultswuirxnns.supabase.co/functions/v1/agilizone-sync-worker',
    headers := jsonb_build_object('Content-Type','application/json','x-ingest-secret', v_secret),
    timeout_milliseconds := 280000
  ) into v_req;
  return v_req;
end $$;

-- ============ GRANTs (CLAUDE.md 5.x) ============
revoke all on function public.agilizone_enqueue_sync()            from public, anon, authenticated;
revoke all on function public.agilizone_run_worker()              from public, anon, authenticated;
revoke all on function public.agilizone_queue_read(int,int)       from public, anon, authenticated;
revoke all on function public.agilizone_queue_archive(bigint)     from public, anon, authenticated;
grant execute on function public.agilizone_enqueue_sync()         to service_role;
grant execute on function public.agilizone_run_worker()           to service_role;
grant execute on function public.agilizone_queue_read(int,int)    to service_role;
grant execute on function public.agilizone_queue_archive(bigint)  to service_role;
