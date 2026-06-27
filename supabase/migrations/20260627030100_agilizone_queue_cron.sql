-- Fase 1: troca o poll monolítico pelo pipeline de fila (scheduler + worker)
-- e adiciona retenção do histórico de cron. Idempotente: cron.schedule
-- substitui o job de mesmo nome.

-- desativa o poll antigo se existir (rollback: reativar o jobid)
do $$
declare v_id bigint;
begin
  select jobid into v_id from cron.job where jobname = 'agilizone-poll-2min';
  if v_id is not null then perform cron.alter_job(v_id, active := false); end if;
end $$;

select cron.schedule('agilizone-enqueue-2min', '*/2 * * * *', 'select public.agilizone_enqueue_sync();');
select cron.schedule('agilizone-worker-1min',  '* * * * *',   'select public.agilizone_run_worker();');
select cron.schedule('cron-history-prune',     '0 4 * * *',   $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
