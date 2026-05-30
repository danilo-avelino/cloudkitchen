-- Fix da entrada errada: COXÃO DURO BOVINO (KG) gravado como 6831 kg / 0,3767 R$/kg.
-- O valor correto é 68,31 kg × 37,6722 R$/kg = 2573,24 (line_total já está certo).
-- Causa: bug no _parseBR do frontend que removia pontos achando que eram milhar,
-- então "68.31" virava 6831. Frontend já corrigido neste mesmo commit.
--
-- Strategy: desabilitar o trigger de bloqueio (tg_stock_movements_no_update) só
-- durante o UPDATE, corrigir tanto o stock_movements quanto o saldo em
-- stock_items, e reabilitar. Tudo numa transação atômica.

BEGIN;

ALTER TABLE public.stock_movements DISABLE TRIGGER tg_stock_movements_no_update;

-- 1. Corrige a movimentação errada
UPDATE public.stock_movements
   SET qty       = 68.31,
       unit_cost = 37.6722
 WHERE id = 'bf379400-0838-47d2-877c-6b0cc10d85d7'
   AND qty = 6831;  -- guarda: só atualiza se ainda estiver no estado errado

-- 2. Corrige o saldo e o custo do insumo (custo da última compra — política do projeto)
--    Saldo: 6839.95 - 6831 + 68.31 = 77.26
--    unit_cost: 37.6722 (line_total / qty correta)
UPDATE public.stock_items
   SET current_qty = current_qty - 6831 + 68.31,
       unit_cost   = 37.6722
 WHERE id = 'c9bf2bab-264a-4757-a8f2-74b0c8619188'
   AND current_qty = 6839.95;  -- guarda: só atualiza se o saldo ainda reflete o erro

ALTER TABLE public.stock_movements ENABLE TRIGGER tg_stock_movements_no_update;

COMMIT;
;
