-- ============================================================================
-- Polling automático do Agilizone (near real-time)
-- ----------------------------------------------------------------------------
-- agilizone_poll: dispara o ingest de TODAS as contas ativas de uma vez (sem
-- accountId no body → a edge function processa todas). Lê o shared-secret do
-- Vault e chama via pg_net. service_role-only. Igual ao agilizone_trigger_ingest,
-- mas sem precisar de uma conta específica.
-- Agendado no pg_cron a cada 2 min. lookback=1 cobre o dia efetivo corrente +
-- a cauda de ontem (captura também atualizações de status); upsert idempotente.
-- ============================================================================

create or replace function public.agilizone_poll(p_lookback int default 1)
returns bigint
language plpgsql
security definer
set search_path = 'public','pg_temp'
as $$
declare
  v_secret text;
  v_req    bigint;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'agilizone_ingest_secret' limit 1;
  if v_secret is null then raise exception 'agilizone_ingest_secret ausente no Vault'; end if;

  select net.http_post(
    url := 'https://dnvrerivultswuirxnns.supabase.co/functions/v1/agilizone-ingest',
    body := jsonb_build_object('lookbackDays', p_lookback),
    headers := jsonb_build_object('Content-Type','application/json','x-ingest-secret', v_secret),
    timeout_milliseconds := 280000
  ) into v_req;
  return v_req;
end $$;

revoke execute on function public.agilizone_poll(int) from public, anon, authenticated;
grant execute on function public.agilizone_poll(int) to service_role;

-- Agenda a cada 2 min. cron.schedule por nome faz upsert (idempotente).
select cron.schedule('agilizone-poll-2min', '*/2 * * * *', $cron$select public.agilizone_poll(1);$cron$);
