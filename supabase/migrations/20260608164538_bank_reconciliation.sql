-- Conciliação bancária — camada sobre o módulo financeiro.
--
-- Objetivo: ingerir o extrato da conta PJ (open banking, prioridade Stone; v1 via
-- import OFX/CSV) e conciliar os DÉBITOS contra `finance_entries`, fechando a DRE
-- com base no que realmente saiu da conta. Não cria livro paralelo: o resultado
-- de toda conciliação/criação acaba em `finance_entries` (a DRE não muda de fonte).
--
-- Mapeamento spec → schema:
--   transacao_bancaria  → public.bank_transactions
--   vinculo_conciliacao → public.reconciliation_links
--   memoria_recorrencia → public.reconciliation_memory
--   contraparte_alias   → public.counterparty_aliases
--   config_match        → public.reconciliation_config
--   conta conectada     → public.bank_accounts
--   contraparte         → public.suppliers (já existe; cnpj/legal_name)
--   lancamento          → public.finance_entries (+ counterparty_id adicionado aqui)
--
-- RLS (CLAUDE.md §5): leitura por membro; escrita por quem acessa o módulo
-- 'finance' (espelha finance_entries — "quem vê edita"). bank_transactions também
-- aceita escrita por service_role (edge function de sync).

-- =====================================================================
-- 1. bank_accounts — conta PJ conectada (provider-agnóstico; Stone primeiro)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider       text NOT NULL DEFAULT 'manual',        -- 'stone' | 'ofx' | 'manual'
  external_id    text,                                  -- id da conta no agregador
  label          text NOT NULL,                         -- "Stone PJ • 0001"
  is_active      boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_id)
);
CREATE INDEX IF NOT EXISTS bank_accounts_tenant_idx ON public.bank_accounts(tenant_id);

DROP TRIGGER IF EXISTS tg_bank_accounts_updated_at ON public.bank_accounts;
CREATE TRIGGER tg_bank_accounts_updated_at
  BEFORE UPDATE ON public.bank_accounts
  FOR EACH ROW EXECUTE FUNCTION app.tg_set_updated_at();

-- =====================================================================
-- 2. bank_transactions — linhas do extrato (spec §3.1)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  account_id             uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  external_id            text,                            -- FITID / id do agregador
  idempotency_hash       text NOT NULL,                   -- conta+external+valor+data
  transaction_date       date NOT NULL,
  settled_date           date,
  amount                 numeric(14,2) NOT NULL,          -- sempre positivo
  direction              text NOT NULL,                   -- 'debit' | 'credit'
  raw_description         text,
  counterparty_name_norm text,
  counterparty_document  text,                            -- CNPJ/CPF extraído
  identifiers            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { e2e_id, nosso_numero, ... }
  bank_status            text NOT NULL DEFAULT 'settled', -- 'pending' | 'settled' | 'reversed'
  state                  text NOT NULL DEFAULT 'unidentified', -- máquina de estados §4
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_hash)
);
CREATE INDEX IF NOT EXISTS bank_transactions_tenant_date_idx ON public.bank_transactions(tenant_id, transaction_date);
CREATE INDEX IF NOT EXISTS bank_transactions_state_idx       ON public.bank_transactions(tenant_id, state);
CREATE INDEX IF NOT EXISTS bank_transactions_account_idx     ON public.bank_transactions(account_id);

DROP TRIGGER IF EXISTS tg_bank_transactions_updated_at ON public.bank_transactions;
CREATE TRIGGER tg_bank_transactions_updated_at
  BEFORE UPDATE ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION app.tg_set_updated_at();

-- =====================================================================
-- 3. finance_entries.counterparty_id — sinal de match mais forte (spec §2/§6)
--    Documento (CNPJ) vem de suppliers.cnpj via este FK.
-- =====================================================================
ALTER TABLE public.finance_entries
  ADD COLUMN IF NOT EXISTS counterparty_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS finance_entries_counterparty_idx ON public.finance_entries(counterparty_id);

-- =====================================================================
-- 4. reconciliation_links — vínculo transação↔lançamento (spec §3.2)
--    Uma linha por par; suporta 1:1, N:1 e 1:N.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.reconciliation_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  finance_entry_id    uuid NOT NULL REFERENCES public.finance_entries(id)   ON DELETE CASCADE,
  relation_type       text NOT NULL DEFAULT 'one_to_one', -- one_to_one | n_to_one | one_to_n
  state               text NOT NULL DEFAULT 'suggested',  -- suggested | confirmed | rejected
  score               numeric,                            -- 0–1; null se manual/criado
  match_method        text NOT NULL DEFAULT 'manual',     -- identifier|deterministic|fuzzy|recurrence|manual
  author_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  confirmed_at        timestamptz,
  UNIQUE (bank_transaction_id, finance_entry_id)
);
CREATE INDEX IF NOT EXISTS reconciliation_links_tx_idx    ON public.reconciliation_links(bank_transaction_id);
CREATE INDEX IF NOT EXISTS reconciliation_links_entry_idx ON public.reconciliation_links(finance_entry_id);
CREATE INDEX IF NOT EXISTS reconciliation_links_tenant_idx ON public.reconciliation_links(tenant_id);

-- =====================================================================
-- 5. reconciliation_memory — aprendizado por tenant (spec §3.3)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.reconciliation_memory (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  signature       text NOT NULL,                          -- documento OU nome_norm + direction
  action          text NOT NULL DEFAULT 'classify',       -- classify | reconcile_default | ignore
  subcategory_id  uuid REFERENCES public.dre_subcategories(id) ON DELETE SET NULL,
  counterparty_id uuid REFERENCES public.suppliers(id)        ON DELETE SET NULL,
  confidence      numeric NOT NULL DEFAULT 0.5,
  occurrences     int NOT NULL DEFAULT 1,
  last_applied_at date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Sao_Paulo')::date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, signature)
);
CREATE INDEX IF NOT EXISTS reconciliation_memory_tenant_idx ON public.reconciliation_memory(tenant_id);

DROP TRIGGER IF EXISTS tg_reconciliation_memory_updated_at ON public.reconciliation_memory;
CREATE TRIGGER tg_reconciliation_memory_updated_at
  BEFORE UPDATE ON public.reconciliation_memory
  FOR EACH ROW EXECUTE FUNCTION app.tg_set_updated_at();

-- =====================================================================
-- 6. counterparty_aliases — mesma contraparte com strings diferentes (spec §3.4)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.counterparty_aliases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  alias_text      text NOT NULL,                          -- string bruta do extrato (normalizada)
  document        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, alias_text)
);
CREATE INDEX IF NOT EXISTS counterparty_aliases_tenant_idx ON public.counterparty_aliases(tenant_id);

-- =====================================================================
-- 7. reconciliation_config — parametrização do motor (spec §3.5)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.reconciliation_config (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  auto_min        numeric NOT NULL DEFAULT 0.85,
  ambiguous_min   numeric NOT NULL DEFAULT 0.55,
  date_window_days int    NOT NULL DEFAULT 3,
  value_tolerance numeric NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

DROP TRIGGER IF EXISTS tg_reconciliation_config_updated_at ON public.reconciliation_config;
CREATE TRIGGER tg_reconciliation_config_updated_at
  BEFORE UPDATE ON public.reconciliation_config
  FOR EACH ROW EXECUTE FUNCTION app.tg_set_updated_at();

-- =====================================================================
-- 8. RLS — leitura por membro; escrita por quem acessa 'finance'
-- =====================================================================
ALTER TABLE public.bank_accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_transactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_links   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_memory  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.counterparty_aliases   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_config  ENABLE ROW LEVEL SECURITY;

-- bank_accounts
DROP POLICY IF EXISTS bank_accounts_read  ON public.bank_accounts;
DROP POLICY IF EXISTS bank_accounts_write ON public.bank_accounts;
CREATE POLICY bank_accounts_read  ON public.bank_accounts FOR SELECT USING (app.is_member(tenant_id));
CREATE POLICY bank_accounts_write ON public.bank_accounts FOR ALL
  USING (app.can_access_module(tenant_id, 'finance')) WITH CHECK (app.can_access_module(tenant_id, 'finance'));

-- bank_transactions (escrita também por service_role via edge function de sync)
DROP POLICY IF EXISTS bank_transactions_read  ON public.bank_transactions;
DROP POLICY IF EXISTS bank_transactions_write ON public.bank_transactions;
CREATE POLICY bank_transactions_read  ON public.bank_transactions FOR SELECT USING (app.is_member(tenant_id));
CREATE POLICY bank_transactions_write ON public.bank_transactions FOR ALL
  USING (app.can_access_module(tenant_id, 'finance') OR auth.role() = 'service_role')
  WITH CHECK (app.can_access_module(tenant_id, 'finance') OR auth.role() = 'service_role');

-- reconciliation_links
DROP POLICY IF EXISTS reconciliation_links_read  ON public.reconciliation_links;
DROP POLICY IF EXISTS reconciliation_links_write ON public.reconciliation_links;
CREATE POLICY reconciliation_links_read  ON public.reconciliation_links FOR SELECT USING (app.is_member(tenant_id));
CREATE POLICY reconciliation_links_write ON public.reconciliation_links FOR ALL
  USING (app.can_access_module(tenant_id, 'finance')) WITH CHECK (app.can_access_module(tenant_id, 'finance'));

-- reconciliation_memory
DROP POLICY IF EXISTS reconciliation_memory_read  ON public.reconciliation_memory;
DROP POLICY IF EXISTS reconciliation_memory_write ON public.reconciliation_memory;
CREATE POLICY reconciliation_memory_read  ON public.reconciliation_memory FOR SELECT USING (app.is_member(tenant_id));
CREATE POLICY reconciliation_memory_write ON public.reconciliation_memory FOR ALL
  USING (app.can_access_module(tenant_id, 'finance')) WITH CHECK (app.can_access_module(tenant_id, 'finance'));

-- counterparty_aliases
DROP POLICY IF EXISTS counterparty_aliases_read  ON public.counterparty_aliases;
DROP POLICY IF EXISTS counterparty_aliases_write ON public.counterparty_aliases;
CREATE POLICY counterparty_aliases_read  ON public.counterparty_aliases FOR SELECT USING (app.is_member(tenant_id));
CREATE POLICY counterparty_aliases_write ON public.counterparty_aliases FOR ALL
  USING (app.can_access_module(tenant_id, 'finance')) WITH CHECK (app.can_access_module(tenant_id, 'finance'));

-- reconciliation_config
DROP POLICY IF EXISTS reconciliation_config_read  ON public.reconciliation_config;
DROP POLICY IF EXISTS reconciliation_config_write ON public.reconciliation_config;
CREATE POLICY reconciliation_config_read  ON public.reconciliation_config FOR SELECT USING (app.is_member(tenant_id));
CREATE POLICY reconciliation_config_write ON public.reconciliation_config FOR ALL
  USING (app.can_access_module(tenant_id, 'finance')) WITH CHECK (app.can_access_module(tenant_id, 'finance'));

-- =====================================================================
-- 9. GRANTs service_role (CLAUDE.md §5.3) — edge function usa SERVICE_ROLE_KEY
-- =====================================================================
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON public.bank_accounts         TO service_role;
GRANT ALL ON public.bank_transactions     TO service_role;
GRANT ALL ON public.reconciliation_links  TO service_role;
GRANT ALL ON public.reconciliation_memory TO service_role;
GRANT ALL ON public.counterparty_aliases  TO service_role;
GRANT ALL ON public.reconciliation_config TO service_role;
