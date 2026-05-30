-- Quando um tenant novo é criado, tira o snapshot inicial do mês corrente.
-- O cron diário cuida do resto (atualiza o final ao longo do mês e fecha no dia 1).
CREATE OR REPLACE FUNCTION public.tg_snapshot_initial_on_tenant_insert()
RETURNS TRIGGER AS $$
DECLARE
  v_period text := to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM');
BEGIN
  PERFORM public.snapshot_stock_value(NEW.id, v_period, 'initial');
  PERFORM public.snapshot_stock_value(NEW.id, v_period, 'final');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_snapshot_initial_on_tenant ON public.tenants;
CREATE TRIGGER trg_snapshot_initial_on_tenant
AFTER INSERT ON public.tenants
FOR EACH ROW
EXECUTE FUNCTION public.tg_snapshot_initial_on_tenant_insert();
;
