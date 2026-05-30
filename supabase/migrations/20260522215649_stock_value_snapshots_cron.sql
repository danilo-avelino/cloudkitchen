-- Tabela de snapshots do valor de estoque (início e fim de mês por tenant)
CREATE TABLE IF NOT EXISTS public.stock_value_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  period      text NOT NULL,                -- 'YYYY-MM'
  kind        text NOT NULL CHECK (kind IN ('initial', 'final')),
  total_value numeric(14,2) NOT NULL DEFAULT 0,
  items_count int NOT NULL DEFAULT 0,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  detail      jsonb,                        -- breakdown opcional por categoria
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_value_snapshots_unique UNIQUE (tenant_id, period, kind)
);

CREATE INDEX IF NOT EXISTS idx_stock_value_snapshots_tenant_period
  ON public.stock_value_snapshots(tenant_id, period);

ALTER TABLE public.stock_value_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_value_snapshots_read" ON public.stock_value_snapshots;
CREATE POLICY "stock_value_snapshots_read" ON public.stock_value_snapshots
  FOR SELECT USING (app.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS "stock_value_snapshots_write" ON public.stock_value_snapshots;
CREATE POLICY "stock_value_snapshots_write" ON public.stock_value_snapshots
  FOR ALL USING (app.has_tenant_role(tenant_id, ARRAY['owner'::app.member_role, 'admin'::app.member_role, 'manager'::app.member_role]))
         WITH CHECK (app.has_tenant_role(tenant_id, ARRAY['owner'::app.member_role, 'admin'::app.member_role, 'manager'::app.member_role]));

-- Função que tira snapshot do valor de estoque atual para um tenant + kind ('initial' | 'final')
-- Usa current_qty × unit_cost de todos os itens ativos.
CREATE OR REPLACE FUNCTION public.snapshot_stock_value(p_tenant uuid, p_period text, p_kind text)
RETURNS uuid AS $$
DECLARE
  v_total numeric;
  v_count int;
  v_detail jsonb;
  v_id uuid;
BEGIN
  SELECT
    COALESCE(SUM(current_qty * unit_cost), 0),
    COUNT(*)
  INTO v_total, v_count
  FROM public.stock_items
  WHERE tenant_id = p_tenant
    AND is_active = true;

  -- Breakdown por categoria
  SELECT jsonb_object_agg(cat_name, sub_total)
  INTO v_detail
  FROM (
    SELECT COALESCE(c.name, 'Sem categoria') AS cat_name,
           SUM(si.current_qty * si.unit_cost) AS sub_total
    FROM public.stock_items si
    LEFT JOIN public.stock_categories c ON c.id = si.category_id
    WHERE si.tenant_id = p_tenant AND si.is_active = true
    GROUP BY c.name
  ) g;

  INSERT INTO public.stock_value_snapshots (tenant_id, period, kind, total_value, items_count, detail)
  VALUES (p_tenant, p_period, p_kind, v_total, v_count, v_detail)
  ON CONFLICT (tenant_id, period, kind) DO UPDATE
    SET total_value = EXCLUDED.total_value,
        items_count = EXCLUDED.items_count,
        detail      = EXCLUDED.detail,
        snapshot_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- Roda diariamente · 00:05 de cada dia
-- - No dia 1 → tira snapshot 'initial' do mês atual e 'final' do mês anterior
-- - Demais dias → atualiza só o 'final' do mês corrente (saldo running)
CREATE OR REPLACE FUNCTION public.run_stock_value_snapshots()
RETURNS void AS $$
DECLARE
  v_today      date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_period_now text := to_char(v_today, 'YYYY-MM');
  v_period_prev text := to_char(v_today - interval '1 month', 'YYYY-MM');
  v_is_first   boolean := EXTRACT(DAY FROM v_today) = 1;
  v_tenant     uuid;
BEGIN
  FOR v_tenant IN SELECT id FROM public.tenants LOOP
    IF v_is_first THEN
      -- Fecha o mês anterior
      PERFORM public.snapshot_stock_value(v_tenant, v_period_prev, 'final');
      -- Abre o novo
      PERFORM public.snapshot_stock_value(v_tenant, v_period_now, 'initial');
    END IF;
    -- Sempre atualiza o "final" corrente como running balance (sobrescreve via ON CONFLICT)
    PERFORM public.snapshot_stock_value(v_tenant, v_period_now, 'final');
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Agenda cron: 00:05 todo dia (horário do servidor; ajuste para timezone se necessário)
-- Remove job anterior se existir
DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'stock_value_daily_snapshot';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'stock_value_daily_snapshot',
  '5 0 * * *',
  $$SELECT public.run_stock_value_snapshots();$$
);
;
