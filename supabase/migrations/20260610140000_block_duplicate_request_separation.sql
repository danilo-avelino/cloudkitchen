-- Bloqueia baixa de estoque duplicada da mesma requisição de cozinha.
--
-- Caso real (qui 04/06): a req b349c271 (terra) gerou a baixa 2× (R$ 357,10
-- às 17:10 e 18:37) — o status foi revertido de 'separated' e marcado de novo,
-- e o trigger reaplicou todas as saídas. Este guard impede nova baixa quando
-- já existem movimentos 'out' referenciando a requisição.

create or replace function app.tg_kitchen_request_apply_separation()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
declare
  r record;
  v_qty numeric(14,4);
begin
  -- Só age na transição PARA 'separated'
  if new.status <> 'separated'
     or (tg_op = 'UPDATE' and old.status = 'separated') then
    return new;
  end if;

  -- Guard anti-duplicidade: se a requisição já tem baixa registrada
  -- (ex.: status revertido e re-separado), bloqueia a transição.
  if exists (
    select 1
      from public.stock_movements
     where reference_type = 'kitchen_request'
       and reference_id   = new.id
       and kind           = 'out'
  ) then
    raise exception 'Requisição % já teve baixa de estoque — nova baixa bloqueada para evitar duplicidade',
      coalesce(new.code, new.id::text);
  end if;

  -- Stamp de separação se não veio
  if new.separated_at is null then new.separated_at := now(); end if;
  if new.separated_by is null then new.separated_by := auth.uid(); end if;

  -- Gera saída de estoque para cada item vinculado a stock_item
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
      'kitchen_request', new.id, coalesce(new.separated_by, auth.uid()), now(),
      'Separação do pedido ' || coalesce(new.code, new.id::text)
    );
  end loop;

  return new;
end;
$$;
