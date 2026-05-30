-- =====================================================================
-- Turnos por operação + suporte a múltiplos faturamentos por dia/op/source
--
-- Antes: revenue_entries tinha UNIQUE (tenant_id, operation_id, business_date, source)
--        — impedia 2+ lançamentos no mesmo dia/op (ex.: 2 turnos almoço/jantar).
--
-- Depois: cada lançamento pode ter um shift_id opcional. UNIQUE passa a incluir
--         shift_id, então (almoço, ifood, 24/05) e (jantar, ifood, 24/05) coexistem.
-- =====================================================================

-- 1. Tabela de turnos por operação
CREATE TABLE IF NOT EXISTS public.operation_shifts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
  name         text NOT NULL,
  sort_order   int  NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, operation_id, name)
);

CREATE INDEX IF NOT EXISTS operation_shifts_tenant_op_idx
  ON public.operation_shifts(tenant_id, operation_id);

-- Trigger pra updated_at (reusa app.tg_set_updated_at se existir)
DROP TRIGGER IF EXISTS tg_operation_shifts_updated_at ON public.operation_shifts;
CREATE TRIGGER tg_operation_shifts_updated_at
  BEFORE UPDATE ON public.operation_shifts
  FOR EACH ROW EXECUTE FUNCTION app.tg_set_updated_at();

-- Trigger pra validar coerência tenant (operation precisa ser do mesmo tenant)
CREATE OR REPLACE FUNCTION app.tg_check_shift_operation_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM public.operations WHERE id = NEW.operation_id;
  IF v_tenant IS NULL OR v_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'operation_shifts.operation_id pertence a outro tenant';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_operation_shifts_check_tenant ON public.operation_shifts;
CREATE TRIGGER tg_operation_shifts_check_tenant
  BEFORE INSERT OR UPDATE ON public.operation_shifts
  FOR EACH ROW EXECUTE FUNCTION app.tg_check_shift_operation_tenant();

-- 2. RLS
ALTER TABLE public.operation_shifts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "operation_shifts_read" ON public.operation_shifts;
CREATE POLICY "operation_shifts_read" ON public.operation_shifts
  FOR SELECT USING (app.is_member(tenant_id));

DROP POLICY IF EXISTS "operation_shifts_write" ON public.operation_shifts;
CREATE POLICY "operation_shifts_write" ON public.operation_shifts
  FOR ALL USING (app.is_admin_or_manager(tenant_id));

-- 3. shift_id em revenue_entries
ALTER TABLE public.revenue_entries
  ADD COLUMN IF NOT EXISTS shift_id uuid
  REFERENCES public.operation_shifts(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS revenue_entries_shift_idx
  ON public.revenue_entries(shift_id);

-- 4. UNIQUE constraint nova que inclui shift_id.
--    Em Postgres, NULLs em UNIQUE são considerados distintos por padrão (antes do 15)
--    OU iguais se usar NULLS NOT DISTINCT (15+). Pra garantir comportamento estável,
--    usamos UNIQUE INDEX com COALESCE: trata NULL como '00000000-0000-0000-0000-000000000000'.
ALTER TABLE public.revenue_entries
  DROP CONSTRAINT IF EXISTS revenue_entries_tenant_id_operation_id_business_date_source_key;

DROP INDEX IF EXISTS revenue_entries_unique_per_shift;
CREATE UNIQUE INDEX revenue_entries_unique_per_shift
  ON public.revenue_entries (
    tenant_id,
    operation_id,
    business_date,
    source,
    COALESCE(shift_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- 5. Trigger pra validar coerência tenant do shift (shift precisa ser do mesmo tenant + operação)
CREATE OR REPLACE FUNCTION app.tg_check_revenue_entry_shift()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
  v_shift_tenant uuid;
  v_shift_op uuid;
BEGIN
  IF NEW.shift_id IS NULL THEN RETURN NEW; END IF;
  SELECT tenant_id, operation_id INTO v_shift_tenant, v_shift_op
    FROM public.operation_shifts WHERE id = NEW.shift_id;
  IF v_shift_tenant IS NULL OR v_shift_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'revenue_entries.shift_id pertence a outro tenant';
  END IF;
  IF v_shift_op IS NOT NULL AND NEW.operation_id IS NOT NULL AND v_shift_op <> NEW.operation_id THEN
    RAISE EXCEPTION 'revenue_entries.shift_id pertence a outra operação (% vs %)', v_shift_op, NEW.operation_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_revenue_entries_check_shift ON public.revenue_entries;
CREATE TRIGGER tg_revenue_entries_check_shift
  BEFORE INSERT OR UPDATE ON public.revenue_entries
  FOR EACH ROW EXECUTE FUNCTION app.tg_check_revenue_entry_shift();;
