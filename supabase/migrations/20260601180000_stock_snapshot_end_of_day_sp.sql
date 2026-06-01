-- Snapshot de valor de estoque: corrige o horário e a virada de mês.
--
-- Antes: cron '5 0 * * *' (00:05 UTC = 21:05 SP do dia anterior) → o "fim do dia"
-- saía às 21:05 SP, não no fim do dia. E no dia 1 a função re-snapshotava o
-- 'final' do mês anterior com o estoque do dia 1, corrompendo o fechamento.
--
-- Agora:
--   • Cron passa a rodar 23:59 SP (= 02:59 UTC) → o último run do mês captura o
--     estoque no fim do último dia (fechamento correto).
--   • No dia 1, o 'initial' do novo mês = saldo de virada = 'final' do mês
--     anterior (carrega o valor; se não houver, snapshot do estoque atual).
--     O 'final' fechado nunca é sobrescrito.

CREATE OR REPLACE FUNCTION public.run_stock_value_snapshots()
RETURNS void
LANGUAGE plpgsql
SET search_path = 'public', 'app', 'pg_temp'
AS $$
DECLARE
  v_today       date    := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_period_now  text    := to_char(v_today, 'YYYY-MM');
  v_period_prev text    := to_char(v_today - interval '1 month', 'YYYY-MM');
  v_is_first    boolean := EXTRACT(DAY FROM v_today) = 1;
  v_tenant      uuid;
BEGIN
  FOR v_tenant IN SELECT id FROM public.tenants LOOP
    IF v_is_first THEN
      -- Abertura do novo mês = saldo de virada = 'final' do mês anterior
      -- (capturado no fim do último dia). Carrega esse valor.
      INSERT INTO public.stock_value_snapshots (tenant_id, period, kind, total_value, items_count, detail)
      SELECT v_tenant, v_period_now, 'initial', s.total_value, s.items_count, s.detail
        FROM public.stock_value_snapshots s
       WHERE s.tenant_id = v_tenant AND s.period = v_period_prev AND s.kind = 'final'
      ON CONFLICT (tenant_id, period, kind) DO UPDATE
        SET total_value = EXCLUDED.total_value,
            items_count = EXCLUDED.items_count,
            detail      = EXCLUDED.detail,
            snapshot_at = now();
      -- Sem 'final' anterior (1º mês do tenant) → usa o estoque atual como inicial.
      IF NOT FOUND THEN
        PERFORM public.snapshot_stock_value(v_tenant, v_period_now, 'initial');
      END IF;
    END IF;
    -- Saldo corrente do mês: atualizado todo fim de dia (SP). No último dia do
    -- mês, esta é a foto de fechamento.
    PERFORM public.snapshot_stock_value(v_tenant, v_period_now, 'final');
  END LOOP;
END;
$$;

-- Reagenda o cron para 23:59 SP (02:59 UTC).
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'stock_value_daily_snapshot';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'stock_value_daily_snapshot',
  '59 2 * * *',
  $$SELECT public.run_stock_value_snapshots();$$
);
