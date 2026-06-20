-- ============================================================================
-- Cardápio · valoração de itens sem preço (ex.: SAIPOS não envia preço por item)
-- ----------------------------------------------------------------------------
-- Algumas origens (SAIPOS) só trazem { name, quantity } no item — sem preço. O
-- preço só existe no nível do pedido. Em vez de inventar/ratear, valoramos cada
-- item pelo **preço unitário médio das vendas DO MESMO item que vêm com preço**
-- (ex.: CARDAPIO_WEB/iFood). As unidades sem preço herdam esse unitário; itens
-- que nunca venderam com preço ficam sem valor (não há de onde estimar).
--   total = receita real (linhas com preço) + unidades_sem_preço × unitário_médio
-- Agrupado por nome do item (match exato), igual à versão anterior.
-- ============================================================================

create or replace function public.agilizone_menu_sales(
  p_tenant uuid, p_from date, p_to date, p_operation uuid default null
)
returns table (
  name text, external_code text, lines bigint, qty numeric, total numeric, avg_price numeric
)
language sql
stable
security invoker
set search_path = 'public','pg_temp'
as $$
  with agg as (
    select
      i.name,
      max(i.external_code)                                                   as external_code,
      count(*)                                                               as lines,
      sum(i.quantity)                                                        as qty,
      sum(i.quantity) filter (where coalesce(i.total_price, 0) > 0)          as priced_qty,
      sum(coalesce(i.total_price, 0)) filter (where coalesce(i.total_price, 0) > 0) as priced_total
    from public.agilizone_order_items i
    join public.agilizone_orders o on o.id = i.order_id
    where o.tenant_id = p_tenant
      and o.business_date between p_from and p_to
      and o.status not in ('CANCELED','PENDING_PAYMENT')
      and o.operation_id is not null
      and (p_operation is null or o.operation_id = p_operation)
    group by i.name
  ),
  val as (
    select
      name, external_code, lines, qty, priced_qty, priced_total,
      round(
        coalesce(priced_total, 0)
        + coalesce(priced_total / nullif(priced_qty, 0), 0) * (coalesce(qty, 0) - coalesce(priced_qty, 0))
      , 2) as total
    from agg
  )
  select
    name, external_code, lines, qty, total,
    case when coalesce(qty, 0) > 0 then round(total / qty, 2) end as avg_price
  from val
  order by total desc nulls last;
$$;

revoke execute on function public.agilizone_menu_sales(uuid, date, date, uuid) from public, anon;
grant execute on function public.agilizone_menu_sales(uuid, date, date, uuid) to authenticated, service_role;
