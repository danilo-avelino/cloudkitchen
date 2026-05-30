CREATE TABLE IF NOT EXISTS public.preparations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  operation_id  uuid REFERENCES public.operations(id) ON DELETE SET NULL,
  code          text,
  name          text NOT NULL,
  category_id   uuid REFERENCES public.recipe_categories(id) ON DELETE SET NULL,
  yield_qty     numeric(14,3) NOT NULL DEFAULT 1,
  yield_unit    text NOT NULL DEFAULT 'kg',
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.preparation_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preparation_id  uuid NOT NULL REFERENCES public.preparations(id) ON DELETE CASCADE,
  stock_item_id   uuid REFERENCES public.stock_items(id) ON DELETE SET NULL,
  source_prep_id  uuid REFERENCES public.preparations(id) ON DELETE SET NULL,
  name            text NOT NULL,
  qty             numeric(14,3) NOT NULL,
  unit            text NOT NULL DEFAULT 'kg',
  unit_cost       numeric(14,4) NOT NULL DEFAULT 0,
  total_cost      numeric(14,2) NOT NULL DEFAULT 0,
  sort_order      int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_preparations_tenant ON public.preparations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_preparations_op ON public.preparations(operation_id);
CREATE INDEX IF NOT EXISTS idx_preparation_items_prep ON public.preparation_items(preparation_id);

ALTER TABLE public.preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.preparation_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "preparations_read" ON public.preparations;
DROP POLICY IF EXISTS "preparations_write" ON public.preparations;
DROP POLICY IF EXISTS "preparation_items_read" ON public.preparation_items;
DROP POLICY IF EXISTS "preparation_items_write" ON public.preparation_items;

CREATE POLICY "preparations_read" ON public.preparations
  FOR SELECT USING (app.is_tenant_member(tenant_id));
CREATE POLICY "preparations_write" ON public.preparations
  FOR ALL USING (app.has_tenant_role(tenant_id, ARRAY['owner'::app.member_role, 'admin'::app.member_role, 'manager'::app.member_role]));

CREATE POLICY "preparation_items_read" ON public.preparation_items
  FOR SELECT USING (EXISTS (SELECT 1 FROM public.preparations p WHERE p.id = preparation_id AND app.is_tenant_member(p.tenant_id)));
CREATE POLICY "preparation_items_write" ON public.preparation_items
  FOR ALL USING (EXISTS (SELECT 1 FROM public.preparations p WHERE p.id = preparation_id AND app.has_tenant_role(p.tenant_id, ARRAY['owner'::app.member_role, 'admin'::app.member_role, 'manager'::app.member_role])));
;
