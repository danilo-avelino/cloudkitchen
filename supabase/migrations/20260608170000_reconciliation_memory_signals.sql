-- Aprendizado de conciliação mais rico: guardar os SINAIS da contraparte do banco
-- (CNPJ, nome normalizado, direção) e um rótulo legível do gasto, para que matches
-- futuros possam casar por documento E/OU nome e dar peso à conciliação.
--
-- Antes só existia `signature` (documento OU nome). Agora guardamos as partes
-- separadas, então a próxima transação da "Foody" com o mesmo CNPJ pontua mais alto
-- mesmo que o lançamento não tenha o CNPJ cadastrado.

ALTER TABLE public.reconciliation_memory
  ADD COLUMN IF NOT EXISTS document     text,
  ADD COLUMN IF NOT EXISTS name_norm    text,
  ADD COLUMN IF NOT EXISTS direction    text,           -- 'debit' | 'credit'
  ADD COLUMN IF NOT EXISTS sample_label text;           -- rótulo legível (ex.: "Foody Delivery")

CREATE INDEX IF NOT EXISTS reconciliation_memory_document_idx
  ON public.reconciliation_memory(tenant_id, document);
CREATE INDEX IF NOT EXISTS reconciliation_memory_name_idx
  ON public.reconciliation_memory(tenant_id, name_norm);
