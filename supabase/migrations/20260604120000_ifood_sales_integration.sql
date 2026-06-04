-- Integrações por operação (PoC) — começando pelo iFood (Sales API).
--
-- Fluxo de produto: selecionar operação → "Adicionar integração" → iFood.
-- As credenciais do APP iFood (clientId/clientSecret) são únicas e ficam em
-- SECRETS do projeto (IFOOD_CLIENT_ID / IFOOD_CLIENT_SECRET) — NUNCA no banco.
-- Por operação guardamos apenas o provedor + o merchantId (e flags).
--
-- A escrita das vendas é feita pela edge function `ifood-sales-sync` com
-- SERVICE_ROLE_KEY (bypassa RLS). Usuários do tenant apenas leem.

-- =====================================================================
-- 1. Integrações por operação (provider-agnóstico; iFood é o primeiro)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.operation_integrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id)    ON DELETE CASCADE,
  operation_id   uuid NOT NULL REFERENCES public.operations(id) ON DELETE CASCADE,
  provider       text NOT NULL,                       -- 'ifood' | (futuro: 'rappi', ...)
  external_id    text,                                -- merchantId no provedor
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- ajustes extras por provedor
  is_active      boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, operation_id, provider)
);

CREATE INDEX IF NOT EXISTS operation_integrations_tenant_idx
  ON public.operation_integrations(tenant_id);
CREATE INDEX IF NOT EXISTS operation_integrations_provider_idx
  ON public.operation_integrations(tenant_id, provider);

DROP TRIGGER IF EXISTS tg_operation_integrations_updated_at ON public.operation_integrations;
CREATE TRIGGER tg_operation_integrations_updated_at
  BEFORE UPDATE ON public.operation_integrations
  FOR EACH ROW EXECUTE FUNCTION app.tg_set_updated_at();

-- =====================================================================
-- 2. Vendas brutas puxadas da Sales API do iFood
--    `raw` guarda o payload completo da venda — assim, mesmo que o
--    mapeamento de colunas abaixo não cubra todos os campos, nada se perde.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.ifood_sales (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES public.tenants(id)    ON DELETE CASCADE,
  operation_id      uuid REFERENCES public.operations(id)          ON DELETE SET NULL,
  ifood_merchant_id text NOT NULL,
  ifood_sale_id     text NOT NULL,          -- identificador único da venda no iFood
  order_id          text,                   -- nº/short id do pedido, quando presente
  competence_date   date,                   -- data local da venda
  payment_method    text,
  status            text,
  gross_value       numeric(12,2),          -- valor pago pelo consumidor
  net_value         numeric(12,2),          -- valor líquido/repasse, quando disponível
  raw               jsonb NOT NULL,         -- payload completo da venda
  synced_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ifood_sale_id)
);

CREATE INDEX IF NOT EXISTS ifood_sales_tenant_date_idx
  ON public.ifood_sales(tenant_id, competence_date);
CREATE INDEX IF NOT EXISTS ifood_sales_operation_idx
  ON public.ifood_sales(operation_id);

-- =====================================================================
-- 3. RLS
-- =====================================================================
ALTER TABLE public.operation_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ifood_sales            ENABLE ROW LEVEL SECURITY;

-- Integrações: leitura por membro; escrita por admin/manager (é configuração).
DROP POLICY IF EXISTS operation_integrations_read ON public.operation_integrations;
CREATE POLICY operation_integrations_read ON public.operation_integrations
  FOR SELECT USING (app.is_member(tenant_id));

DROP POLICY IF EXISTS operation_integrations_write ON public.operation_integrations;
CREATE POLICY operation_integrations_write ON public.operation_integrations
  FOR ALL USING (app.is_admin_or_manager(tenant_id))
          WITH CHECK (app.is_admin_or_manager(tenant_id));

-- Vendas: leitura por quem acessa o módulo de faturamento. A escrita é só da
-- edge function (service_role bypassa RLS) — sem policy de escrita p/ usuários.
DROP POLICY IF EXISTS ifood_sales_read ON public.ifood_sales;
CREATE POLICY ifood_sales_read ON public.ifood_sales
  FOR SELECT USING (app.can_access_module(tenant_id, 'revenue'));

-- =====================================================================
-- 4. GRANTs service_role (CLAUDE.md 5.3) — edge function usa SERVICE_ROLE_KEY.
-- =====================================================================
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON public.operation_integrations TO service_role;
GRANT ALL ON public.ifood_sales            TO service_role;
