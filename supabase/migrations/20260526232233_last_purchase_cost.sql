-- ============================================================================
-- patch-last-purchase-cost.sql · 2026-05-26
-- Substitui a média ponderada de unit_cost por "custo da última compra".
--
-- Motivo: decisão de produto — o estoque deve refletir o que foi pago no último
-- recebimento, sem cálculo extra. Antes, recebimentos com qty já existente em
-- estoque misturavam o custo antigo no novo, e o operador via valores que não
-- batiam com a NF.
--
-- Espelhado no cliente em widgets.jsx `applyStockMovement`.
-- ============================================================================

create or replace function app.tg_apply_stock_movement()
returns trigger
language plpgsql
as $$
declare
  v_item_tenant uuid;
  v_op_tenant   uuid;
begin
  -- Coerência de tenant (item e operação dentro do mesmo tenant da movimentação)
  select tenant_id into v_item_tenant from public.stock_items where id = new.stock_item_id;
  if v_item_tenant is null or v_item_tenant <> new.tenant_id then
    raise exception 'stock_movements.tenant_id (%) <> stock_items.tenant_id (%)',
      new.tenant_id, v_item_tenant;
  end if;

  if new.operation_id is not null then
    select tenant_id into v_op_tenant from public.operations where id = new.operation_id;
    if v_op_tenant is null or v_op_tenant <> new.tenant_id then
      raise exception 'stock_movements.operation_id pertence a outro tenant';
    end if;
  end if;

  -- Aplica delta no saldo
  update public.stock_items
     set current_qty = current_qty + new.qty
   where id = new.stock_item_id;

  -- Sobrescreve unit_cost pelo custo da última compra (NÃO média ponderada).
  if new.kind = 'in' and new.unit_cost is not null and new.unit_cost > 0 and new.qty > 0 then
    update public.stock_items si
       set unit_cost = round(new.unit_cost, 4)
     where si.id = new.stock_item_id;
  end if;

  return new;
end;
$$;;
