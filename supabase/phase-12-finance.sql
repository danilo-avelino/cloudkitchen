-- Fase 12: Finance/DRE — DRE categories, subcategories, entries, closing checklist
-- Tables for multi-operation financial tracking, cost analysis, and end-of-month procedures

-- =====================================================================
-- DRE CATEGORIES (e.g., "Custo CMV", "Pessoal", "Marketing")
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.dre_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  color       text NOT NULL DEFAULT '#8a9098',
  sort_order  int NOT NULL DEFAULT 99,
  locked      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dre_categories_unique_tenant_name UNIQUE(tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_dre_categories_tenant ON public.dre_categories(tenant_id);

-- =====================================================================
-- DRE SUBCATEGORIES (e.g., "Compras hortifruti", "Ajuste de estoque")
-- =====================================================================
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

-- =====================================================================
-- FINANCE ENTRIES (lançamentos manuais)
-- =====================================================================
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

-- Trigger: auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at_finance_entries()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at_finance_entries ON public.finance_entries;
CREATE TRIGGER set_updated_at_finance_entries
BEFORE UPDATE ON public.finance_entries
FOR EACH ROW
EXECUTE FUNCTION set_updated_at_finance_entries();

-- =====================================================================
-- CLOSING CHECKLIST ITEMS (rotina de fechamento mensal)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.closing_checklist_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  period      text NOT NULL,
  label       text NOT NULL,
  done        boolean NOT NULL DEFAULT false,
  done_at     timestamptz,
  done_by     uuid REFERENCES auth.users(id),
  sort_order  int NOT NULL DEFAULT 99,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Safety: ensure all columns exist in case table was created partially before
ALTER TABLE public.closing_checklist_items ADD COLUMN IF NOT EXISTS period      text;
ALTER TABLE public.closing_checklist_items ADD COLUMN IF NOT EXISTS label       text;
ALTER TABLE public.closing_checklist_items ADD COLUMN IF NOT EXISTS done        boolean DEFAULT false;
ALTER TABLE public.closing_checklist_items ADD COLUMN IF NOT EXISTS done_at     timestamptz;
ALTER TABLE public.closing_checklist_items ADD COLUMN IF NOT EXISTS done_by     uuid;
ALTER TABLE public.closing_checklist_items ADD COLUMN IF NOT EXISTS sort_order  int DEFAULT 99;
ALTER TABLE public.closing_checklist_items ADD COLUMN IF NOT EXISTS created_at  timestamptz DEFAULT now();
ALTER TABLE public.closing_checklist_items ADD COLUMN IF NOT EXISTS updated_at  timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_closing_checklist_tenant_period ON public.closing_checklist_items(tenant_id, period);

-- Trigger: auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at_closing_checklist()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at_closing_checklist ON public.closing_checklist_items;
CREATE TRIGGER set_updated_at_closing_checklist
BEFORE UPDATE ON public.closing_checklist_items
FOR EACH ROW
EXECUTE FUNCTION set_updated_at_closing_checklist();

-- =====================================================================
-- RLS POLICIES
-- =====================================================================

-- DRE Categories
ALTER TABLE public.dre_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dre_categories_read" ON public.dre_categories;
DROP POLICY IF EXISTS "dre_categories_write" ON public.dre_categories;

CREATE POLICY "dre_categories_read" ON public.dre_categories
  FOR SELECT USING (app.is_member(tenant_id));

CREATE POLICY "dre_categories_write" ON public.dre_categories
  FOR ALL USING (app.is_admin_or_manager(tenant_id));

-- DRE Subcategories
ALTER TABLE public.dre_subcategories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dre_subcategories_read" ON public.dre_subcategories;
DROP POLICY IF EXISTS "dre_subcategories_write" ON public.dre_subcategories;

CREATE POLICY "dre_subcategories_read" ON public.dre_subcategories
  FOR SELECT USING (app.is_member(tenant_id));

CREATE POLICY "dre_subcategories_write" ON public.dre_subcategories
  FOR ALL USING (app.is_admin_or_manager(tenant_id));

-- Finance Entries
ALTER TABLE public.finance_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "finance_entries_read" ON public.finance_entries;
DROP POLICY IF EXISTS "finance_entries_write" ON public.finance_entries;

CREATE POLICY "finance_entries_read" ON public.finance_entries
  FOR SELECT USING (app.is_member(tenant_id));

CREATE POLICY "finance_entries_write" ON public.finance_entries
  FOR ALL USING (app.is_admin_or_manager(tenant_id));

-- Closing Checklist
ALTER TABLE public.closing_checklist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "closing_checklist_read" ON public.closing_checklist_items;
DROP POLICY IF EXISTS "closing_checklist_write" ON public.closing_checklist_items;

CREATE POLICY "closing_checklist_read" ON public.closing_checklist_items
  FOR SELECT USING (app.is_member(tenant_id));

CREATE POLICY "closing_checklist_write" ON public.closing_checklist_items
  FOR ALL USING (app.is_admin_or_manager(tenant_id));
