-- Ajusta o guard idempotente da baixa na entrega: em vez de "existe qualquer
-- saída", passa a checar o SALDO LÍQUIDO dos movimentos da requisição.
--
-- Motivo: requisições separadas sob o modelo antigo (baixa na separação) têm
-- saída registrada. Ao voltar para pendente e estornar (movimento 'in'), o
-- líquido zera. Se essas requisições forem separadas e entregues de verdade
-- depois, a baixa DEVE ocorrer — o guard por "existe saída" pularia
-- indevidamente. Com saldo líquido: < 0 = já tem baixa pendente (pula);
-- = 0 (nunca baixado ou já estornado) = baixa normalmente.
--
-- Acompanha a correção de dados (estorno das requisições REQ-B502FG e
-- REQ-B63E4K do tenant MobyDick, separadas sob o modelo antigo e revertidas
-- para pendente em 2026-06-12). O estorno foi aplicado via movimentos 'in' de
-- compensação (não é migration de schema, foi data fix pontual).

create or replace function app.tg_kitchen_request_apply_delivery()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
declare
  r record;
  v_qty numeric(14,4);
  v_net numeric(14,4);
begin
  if new.status <> 'delivered'
     or (tg_op = 'UPDATE' and old.status = 'delivered') then
    return new;
  end if;

  -- Saldo líquido das movimentações desta requisição (saída negativa, estorno
  -- positivo). Se já há baixa líquida pendente (< 0), não baixa de novo.
  select coalesce(sum(qty), 0) into v_net
    from public.stock_movements
   where reference_type = 'kitchen_request'
     and reference_id   = new.id;

  if v_net < 0 then
    return new;
  end if;

  if new.delivered_at is null then new.delivered_at := now(); end if;
  if new.delivered_by is null then new.delivered_by := auth.uid(); end if;

  for r in
    select id, stock_item_id, qty, separated_qty, unit_cost
      from public.kitchen_request_items
     where kitchen_request_id = new.id
       and stock_item_id is not null
  loop
    v_qty := coalesce(r.separated_qty, r.qty);
    if v_qty is null or v_qty <= 0 then
      continue;
    end if;

    insert into public.stock_movements (
      tenant_id, stock_item_id, operation_id, kind, qty, unit_cost,
      reference_type, reference_id, performed_by, performed_at, notes
    ) values (
      new.tenant_id, r.stock_item_id, new.operation_id, 'out',
      -v_qty, nullif(r.unit_cost, 0),
      'kitchen_request', new.id, coalesce(new.delivered_by, auth.uid()), now(),
      'Entrega do pedido ' || coalesce(new.code, new.id::text)
    );
  end loop;

  return new;
end;
$$;
