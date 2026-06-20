-- ============================================================================
-- Cardápio · análises extras: adicionais (attach rate) + cesta (market basket)
-- Ambos read-only, SECURITY INVOKER (RLS de agilizone_orders/items garante o
-- escopo do tenant), no mesmo padrão de agilizone_menu_sales.
-- ============================================================================

-- 1. Adicionais / complementos: desagrega o jsonb `options` dos itens.
--    qty/receita por adicional + attach rate (% dos pedidos do recorte que o levam).
create or replace function public.agilizone_menu_addons(
  p_tenant uuid, p_from date, p_to date, p_operation uuid default null
)
returns table (
  name text, group_name text, qty numeric, revenue numeric,
  orders bigint, attach_pct numeric
)
language sql
stable
security invoker
set search_path = 'public','pg_temp'
as $$
  with scope as (
    select o.id
    from public.agilizone_orders o
    where o.tenant_id = p_tenant
      and o.business_date between p_from and p_to
      and o.status not in ('CANCELED','PENDING_PAYMENT')
      and o.operation_id is not null
      and (p_operation is null or o.operation_id = p_operation)
  ),
  tot as (select count(*)::numeric as n from scope),
  base as (
    select i.order_id, opt
    from public.agilizone_order_items i
    join scope s on s.id = i.order_id
    cross join lateral jsonb_array_elements(i.options) as opt
    where i.options is not null
  )
  select
    opt->>'name'                                                 as name,
    nullif(opt->>'groupName','')                                 as group_name,
    sum(coalesce((opt->>'quantity')::numeric, 1))               as qty,
    round(sum(coalesce((opt->>'unitPrice')::numeric,
                       (opt->>'price')::numeric, 0)
            * coalesce((opt->>'quantity')::numeric, 1)), 2)     as revenue,
    count(distinct order_id)                                     as orders,
    round(100.0 * count(distinct order_id)
          / nullif((select n from tot), 0), 1)                  as attach_pct
  from base
  group by opt->>'name', nullif(opt->>'groupName','')
  order by count(distinct order_id) desc, 3 desc;
$$;

revoke execute on function public.agilizone_menu_addons(uuid, date, date, uuid) from public, anon;
grant execute on function public.agilizone_menu_addons(uuid, date, date, uuid) to authenticated, service_role;

-- 2. Cesta / itens vendidos juntos (market basket): pares de itens no mesmo
--    pedido, com confiança (P(B|A) e P(A|B)) e lift (afinidade > 1 = positiva).
--    Corta ruído com pares em >= 3 pedidos; top 200 por co-ocorrência.
create or replace function public.agilizone_menu_baskets(
  p_tenant uuid, p_from date, p_to date, p_operation uuid default null
)
returns table (
  item_a text, item_b text, pair_orders bigint,
  cnt_a bigint, cnt_b bigint,
  conf_a_pct numeric, conf_b_pct numeric, lift numeric
)
language sql
stable
security invoker
set search_path = 'public','pg_temp'
as $$
  with scope as (
    select o.id
    from public.agilizone_orders o
    where o.tenant_id = p_tenant
      and o.business_date between p_from and p_to
      and o.status not in ('CANCELED','PENDING_PAYMENT')
      and o.operation_id is not null
      and (p_operation is null or o.operation_id = p_operation)
  ),
  oi as (   -- (pedido, nome do item) distinto dentro do recorte
    select distinct i.order_id, i.name
    from public.agilizone_order_items i
    join scope s on s.id = i.order_id
  ),
  tot as (select count(distinct order_id)::numeric as n from oi),
  item_cnt as (select name, count(distinct order_id)::numeric as cnt from oi group by name),
  pairs as (
    select a.name as item_a, b.name as item_b, count(*)::numeric as pair_orders
    from oi a
    join oi b on b.order_id = a.order_id and a.name < b.name
    group by a.name, b.name
    having count(*) >= 3
  )
  select
    p.item_a, p.item_b, p.pair_orders::bigint,
    ca.cnt::bigint, cb.cnt::bigint,
    round(100.0 * p.pair_orders / ca.cnt, 1)                           as conf_a_pct,
    round(100.0 * p.pair_orders / cb.cnt, 1)                           as conf_b_pct,
    round(p.pair_orders * (select n from tot) / (ca.cnt * cb.cnt), 2)  as lift
  from pairs p
  join item_cnt ca on ca.name = p.item_a
  join item_cnt cb on cb.name = p.item_b
  order by p.pair_orders desc, lift desc
  limit 200;
$$;

revoke execute on function public.agilizone_menu_baskets(uuid, date, date, uuid) from public, anon;
grant execute on function public.agilizone_menu_baskets(uuid, date, date, uuid) to authenticated, service_role;
