CREATE TABLE IF NOT EXISTS public.recipe_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  color       text NOT NULL DEFAULT '#8a9098',
  sort_order  int NOT NULL DEFAULT 99,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recipe_categories_unique_tenant_name UNIQUE(tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_recipe_categories_tenant ON public.recipe_categories(tenant_id);

ALTER TABLE public.recipe_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "recipe_categories_read" ON public.recipe_categories;
DROP POLICY IF EXISTS "recipe_categories_write" ON public.recipe_categories;

CREATE POLICY "recipe_categories_read" ON public.recipe_categories
  FOR SELECT USING (app.is_tenant_member(tenant_id));

CREATE POLICY "recipe_categories_write" ON public.recipe_categories
  FOR ALL USING (app.has_tenant_role(tenant_id, ARRAY['owner'::app.member_role, 'admin'::app.member_role, 'manager'::app.member_role]));
;
