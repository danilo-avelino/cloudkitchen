-- Phase 12 (parcial) · adiciona dre_subcategories e finance_entries.
-- Mantém dre_categories e closing_checklist_items que já existem (schema Fase 7).

CREATE TABLE IF NOT EXISTS public.dre_subcategories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  category_id  uuid NOT NULL REFERENCES public.dre_categories(id) ON DELETE CASCADE,
  name         text NOT NULL,
  color        text NOT NULL DEFAULT '#8a9098',
  autofeed     text,
  locked       boolean NOT NULL DEFAULT false,
  sort_order   int NOT NULL DEFAULT 99,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dre_subcategories_unique_tenant_name UNIQUE(tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_dre_subcategories_category ON public.dre_subcategories(category_id);
CREATE INDEX IF NOT EXISTS idx_dre_subcategories_tenant ON public.dre_subcategories(tenant_id);

CREATE TABLE IF NOT EXISTS public.finance_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  subcategory_id  uuid NOT NULL REFERENCES public.dre_subcategories(id),
  description     text NOT NULL,
  value           numeric(14,2) NOT NULL,
  competence_date date NOT NULL,
  payment_date    date,
  status          text NOT NULL DEFAULT 'pending',
  auto_source     text,
  auto_source_id  uuid,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finance_entries_tenant_date ON public.finance_entries(tenant_id, competence_date);
CREATE INDEX IF NOT EXISTS idx_finance_entries_subcategory ON public.finance_entries(subcategory_id);

CREATE OR REPLACE FUNCTION set_updated_at_finance_entries()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at_finance_entries ON public.finance_entries;
CREATE TRIGGER set_updated_at_finance_entries
BEFORE UPDATE ON public.finance_entries
FOR EACH ROW EXECUTE FUNCTION set_updated_at_finance_entries();

ALTER TABLE public.dre_subcategories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dre_subcategories_read" ON public.dre_subcategories;
DROP POLICY IF EXISTS "dre_subcategories_write" ON public.dre_subcategories;
CREATE POLICY "dre_subcategories_read" ON public.dre_subcategories FOR SELECT USING (app.is_member(tenant_id));
CREATE POLICY "dre_subcategories_write" ON public.dre_subcategories FOR ALL USING (app.is_admin_or_manager(tenant_id));

ALTER TABLE public.finance_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "finance_entries_read" ON public.finance_entries;
DROP POLICY IF EXISTS "finance_entries_write" ON public.finance_entries;
CREATE POLICY "finance_entries_read" ON public.finance_entries FOR SELECT USING (app.is_member(tenant_id));
CREATE POLICY "finance_entries_write" ON public.finance_entries FOR ALL USING (app.is_admin_or_manager(tenant_id));;
