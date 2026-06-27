-- Reduz o fluxo de sync: enqueue a cada 5 min (era 2). Worker alinhado ~1 min
-- após cada enqueue (1,6,11,...,56) p/ drenar logo, sem disparos ociosos/min.
-- (worker mais frequente só se o nº de contas crescer a ponto de 1 run não
--  drenar a fila dentro do time-budget de 60s.)
do $$
begin
  if exists (select 1 from cron.job where jobname = 'agilizone-enqueue-2min') then
    perform cron.unschedule('agilizone-enqueue-2min');
  end if;
  if exists (select 1 from cron.job where jobname = 'agilizone-worker-1min') then
    perform cron.unschedule('agilizone-worker-1min');
  end if;
end $$;

select cron.schedule('agilizone-enqueue-5min', '*/5 * * * *',    'select public.agilizone_enqueue_sync();');
select cron.schedule('agilizone-worker-5min',  '1-59/5 * * * *', 'select public.agilizone_run_worker();');
