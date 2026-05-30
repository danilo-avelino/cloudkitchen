-- closing_periods: registro de meses formalmente fechados pelo financeiro.
-- Um mês só pode ser fechado quando todos os impeditivos do checklist
-- (closing_checklist_items.is_required = true) estão preenchidos. A trava
-- de negócio fica no front; aqui apenas persistimos o evento.

CREATE TABLE IF NOT EXISTS public.closing_periods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  period      text NOT NULL,                                  -- YYYY-MM
  closed_at   timestamptz NOT NULL DEFAULT now(),
  closed_by   uuid REFERENCES auth.users(id),
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT closing_periods_unique_tenant_period UNIQUE (tenant_id, period),
  CONSTRAINT closing_periods_period_format CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

CREATE INDEX IF NOT EXISTS idx_closing_periods_tenant_period
  ON public.closing_periods (tenant_id, period DESC);

ALTER TABLE public.closing_periods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "closing_periods_read"  ON public.closing_periods;
DROP POLICY IF EXISTS "closing_periods_write" ON public.closing_periods;

CREATE POLICY "closing_periods_read" ON public.closing_periods
  FOR SELECT USING (app.is_member(tenant_id));

CREATE POLICY "closing_periods_write" ON public.closing_periods
  FOR ALL USING (app.is_admin_or_manager(tenant_id));

COMMENT ON TABLE public.closing_periods IS
  'Mêses formalmente fechados. Cada linha = um mês YYYY-MM fechado por um usuário.';
;
