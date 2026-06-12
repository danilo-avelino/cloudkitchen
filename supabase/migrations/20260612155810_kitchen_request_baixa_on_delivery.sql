-- Move a baixa de estoque das requisições de cozinha: SEPARAÇÃO → ENTREGA.
--
-- Contexto: a baixa acontecia na transição → 'separated' (trigger
-- tg_kitchen_requests_separation). Isso impedia "voltar para pendente" sem
-- furar o estoque e travava a re-separação (guard que levantava exceção quando
-- a requisição já tinha saída — migration 20260610140000).
--
-- Decisão do usuário (2026-06-12): a baixa deve ocorrer na ENTREGA. Assim,
-- separar não mexe no estoque e voltar "separada" → "pendente" é seguro (nada a
-- estornar). A baixa passa a ser feita na transição → 'delivered'.
--
-- Boundary: requisições que JÁ estão 'separated' sob o modelo antigo já têm a
-- baixa registrada. O guard idempotente da entrega (pula se já existe saída
-- 'out' desta requisição) garante que essas não sejam debitadas de novo —
-- e também protege contra re-entrega.

-- 1) Separação: passa a só carimbar separated_at/separated_by (sem baixa,
--    sem a exceção anti-duplicidade, que deixa de fazer sentido aqui).
create or replace function app.tg_kitchen_request_apply_separation()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
begin
  if new.status <> 'separated'
     or (tg_op = 'UPDATE' and old.status = 'separated') then
    return new;
  end if;

  if new.separated_at is null then new.separated_at := now(); end if;
  if new.separated_by is null then new.separated_by := auth.uid(); end if;

  return new;
end;
$$;

-- 2) Entrega: gera a saída de estoque para cada item vinculado a stock_item.
--    Idempotente: se a requisição já tem 'out' registrada (separada sob o
--    modelo antigo, ou re-entrega), não baixa de novo.
create or replace function app.tg_kitchen_request_apply_delivery()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
declare
  r record;
  v_qty numeric(14,4);
begin
  if new.status <> 'delivered'
     or (tg_op = 'UPDATE' and old.status = 'delivered') then
    return new;
  end if;

  if exists (
    select 1
      from public.stock_movements
     where reference_type = 'kitchen_request'
       and reference_id   = new.id
       and kind           = 'out'
  ) then
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

-- 3) Trigger de entrega (a de separação já existe e aponta para a função acima,
--    agora stamp-only). Ambas disparam BEFORE UPDATE OF status e cada uma age
--    só na sua transição — não conflitam.
drop trigger if exists tg_kitchen_requests_delivery on public.kitchen_requests;
create trigger tg_kitchen_requests_delivery
  before update of status on public.kitchen_requests
  for each row execute function app.tg_kitchen_request_apply_delivery();

-- 4) GRANTs (CLAUDE.md 5.2) — função nova no schema app.
grant execute on function app.tg_kitchen_request_apply_delivery() to authenticated, anon, service_role;
