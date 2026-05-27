-- ============================================================================
-- patch-waste-reasons.sql · 2026-05-26
-- Adiciona enum `app.waste_reason` e coluna `stock_movements.loss_reason` para
-- registrar o motivo de desperdício (Vencido / Danificado / Estragado / Fora de uso).
--
-- Motivo: a aba "Desperdícios" do Estoque exige um motivo estruturado (não apenas
-- texto livre em notes) pra rankear no mini-dashboard. Aproveita os kinds já
-- existentes 'loss' e 'expiration' — o sinal do qty continua o mesmo.
--
-- Mapeamento sugerido (decidido em conversa, não é enforced pelo banco):
--   loss_reason='vencido'      → kind='expiration'
--   loss_reason='danificado'   → kind='loss'
--   loss_reason='estragado'    → kind='loss'
--   loss_reason='fora_de_uso'  → kind='loss'
-- Movimentações antigas (sem motivo) permanecem com loss_reason NULL.
-- ============================================================================

do $$ begin
  create type app.waste_reason as enum (
    'vencido',
    'danificado',
    'estragado',
    'fora_de_uso'
  );
exception when duplicate_object then null; end $$;

alter table public.stock_movements
  add column if not exists loss_reason app.waste_reason;

create index if not exists stock_movements_loss_reason_idx
  on public.stock_movements (tenant_id, loss_reason, performed_at desc)
  where loss_reason is not null;
