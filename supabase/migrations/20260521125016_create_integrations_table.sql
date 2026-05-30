
CREATE TABLE IF NOT EXISTS public.integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  color text DEFAULT '#8a9098',
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('connected','available','error')),
  brands_connected integer,
  config jsonb DEFAULT '{}'::jsonb,
  sort_order integer DEFAULT 0,
  connected_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS integrations_tenant_idx ON public.integrations(tenant_id);

ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS integrations_select ON public.integrations;
CREATE POLICY integrations_select ON public.integrations
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS integrations_write ON public.integrations;
CREATE POLICY integrations_write ON public.integrations
  FOR ALL TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = auth.uid() AND role IN ('owner','manager')))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_members WHERE user_id = auth.uid() AND role IN ('owner','manager')));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.integrations TO authenticated;

-- Seed para tenants existentes (catálogo padrão de apps StockKitchen)
INSERT INTO public.integrations (tenant_id, slug, name, description, color, status, brands_connected, sort_order)
SELECT t.id, v.slug, v.name, v.description, v.color, v.status, v.brands, v.sort_order
FROM public.tenants t
CROSS JOIN (VALUES
  ('ifood',      'iFood',      'Importa pedidos automaticamente · baixa estoque via ficha técnica', '#b04545', 'available', NULL::integer, 10),
  ('rappi',      'Rappi',      'Importa pedidos · sincroniza cardápio',                              '#c2843a', 'available', NULL::integer, 20),
  ('anota_ai',   'Anota AI',   'Pedidos via WhatsApp',                                               '#3d6cb0', 'available', NULL::integer, 30),
  ('ifood_shop', 'iFood Shop', 'Importa NFs de compras automaticamente',                             '#b04545', 'available', NULL::integer, 40),
  ('omie',       'Omie',       'ERP · sincroniza fornecedores e contas a pagar',                     '#2d8c66', 'available', NULL::integer, 50),
  ('webhook',    'Webhook',    'POST customizado em eventos de estoque',                             '#8a9098', 'available', NULL::integer, 60)
) AS v(slug, name, description, color, status, brands, sort_order)
ON CONFLICT (tenant_id, slug) DO NOTHING;
;
