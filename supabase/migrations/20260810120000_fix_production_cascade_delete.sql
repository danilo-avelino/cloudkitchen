-- Fix: excluir uma production_order com insumos/saídas falhava com
-- "production_order_inputs: ordem não encontrada".
--
-- Causa: os triggers BEFORE DELETE em production_order_inputs/outputs buscam a
-- ordem-pai e levantavam exceção quando não a encontravam. Durante o ON DELETE
-- CASCADE da própria ordem, o pai já foi removido nesse ponto do cascade, então
-- a busca retorna null — e o `raise ... 'ordem não encontrada'` acontecia ANTES
-- do tratamento de DELETE (que ficava inalcançável). Resultado: nenhuma ordem
-- com filhos podia ser excluída.
--
-- Correção: no DELETE, quando a ordem-pai não é encontrada (cascade), deixar o
-- delete concluir (return old) em vez de levantar exceção. INSERT/UPDATE seguem
-- exigindo a ordem existente.
--
-- Base: o estado de produção em 2026-08-11, que inclui a
-- 20260711150000_production_exit_order_flow — saídas podem ser inseridas,
-- editadas e removidas com a ordem em 'issued' (a devolução cria as linhas com
-- returned_qty). Só o guard do cascade muda; nenhum ramo de status é apertado.

create or replace function app.tg_check_production_input()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
declare
  v_order  record;
  v_item_tenant uuid;
begin
  select tenant_id, status into v_order
    from public.production_orders
   where id = coalesce(new.order_id, old.order_id);
  -- DELETE em cascata da própria ordem: o pai já foi removido nesse ponto do
  -- cascade, então v_order vem null. Não é erro — deixa o cascade concluir.
  if tg_op = 'DELETE' and v_order is null then
    return old;
  end if;
  if v_order is null then
    raise exception 'production_order_inputs: ordem não encontrada';
  end if;
  -- DELETE em cascata da ordem cancelada também passa por aqui
  if tg_op = 'DELETE' and v_order.status in ('draft','cancelled') then
    return old;
  end if;
  if v_order.status <> 'draft' then
    raise exception 'Insumos só podem ser alterados com a ordem em rascunho (status atual: %)', v_order.status;
  end if;
  if tg_op <> 'DELETE' then
    select tenant_id into v_item_tenant from public.stock_items where id = new.stock_item_id;
    if v_item_tenant is null or v_item_tenant <> v_order.tenant_id then
      raise exception 'production_order_inputs: stock_item pertence a outro tenant';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function app.tg_check_production_output()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
declare
  v_order record;
  v_item  record;
begin
  select tenant_id, status into v_order
    from public.production_orders
   where id = coalesce(new.order_id, old.order_id);
  -- DELETE em cascata da própria ordem: pai já removido → v_order null. Não é erro.
  if tg_op = 'DELETE' and v_order is null then
    return old;
  end if;
  if v_order is null then
    raise exception 'production_order_outputs: ordem não encontrada';
  end if;

  if tg_op = 'DELETE' then
    -- issued: a devolução pode substituir linhas; cancelled: cascata do delete
    if v_order.status not in ('draft','issued','cancelled') then
      raise exception 'Saídas de ordem % não podem ser removidas', v_order.status;
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' and v_order.status not in ('draft','issued') then
    raise exception 'Saídas só podem ser lançadas com a ordem em rascunho ou aguardando retorno';
  end if;

  if tg_op = 'UPDATE' then
    if v_order.status in ('draft','issued') then
      null; -- editável até o retorno ser confirmado (o completed congela tudo)
    else
      raise exception 'Saídas de ordem % não podem ser alteradas', v_order.status;
    end if;
  end if;

  select tenant_id, item_kind into v_item from public.stock_items where id = new.stock_item_id;
  if v_item is null or v_item.tenant_id <> v_order.tenant_id then
    raise exception 'production_order_outputs: stock_item pertence a outro tenant';
  end if;
  if v_item.item_kind <> 'transformed' then
    raise exception 'A saída da produção precisa ser um item transformado (item_kind=transformed)';
  end if;
  return new;
end;
$$;
