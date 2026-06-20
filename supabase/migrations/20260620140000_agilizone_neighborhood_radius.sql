-- ============================================================================
-- Bairros/Raios · análise geográfica dos pedidos (Agilizone)
-- ----------------------------------------------------------------------------
-- Dois recortes read-only sobre agilizone_orders:
--   1. por bairro (neighborhood)
--   2. por raio de distância — faixas de 1 km da distância em linha reta
--      restaurante→cliente (payload.deliveryDetails.calculatedDistance, metros).
--      Raio N km = de (N-1) a N km, ou seja N = ceil(distancia_km).
-- Ambos SECURITY INVOKER: a RLS de agilizone_orders garante o escopo do tenant.
-- Mesmo padrão de scope dos RPCs agilizone_menu_*.
-- ============================================================================

-- 1. Estatísticas por bairro -------------------------------------------------
create or replace function public.agilizone_neighborhood_stats(
  p_tenant uuid, p_from date, p_to date, p_operation uuid default null
)
returns table (
  neighborhood text, orders bigint, revenue numeric, avg_ticket numeric,
  avg_distance numeric, avg_delivery_fee numeric, avg_deliveryman_fee numeric
)
language sql
stable
security invoker
set search_path = 'public','pg_temp'
as $$
  with scope as (
    select
      o.neighborhood,
      o.amount,
      o.delivery_fee,
      o.deliveryman_fee,
      nullif(o.payload->'deliveryDetails'->>'calculatedDistance','')::numeric as dist_m
    from public.agilizone_orders o
    where o.tenant_id = p_tenant
      and o.business_date between p_from and p_to
      and o.status not in ('CANCELED','PENDING_PAYMENT')
      and o.operation_id is not null
      and (p_operation is null or o.operation_id = p_operation)
  )
  select
    coalesce(nullif(trim(neighborhood), ''), 'Sem bairro')        as neighborhood,
    count(*)                                                      as orders,
    round(sum(coalesce(amount, 0)), 2)                            as revenue,
    round(avg(coalesce(amount, 0)), 2)                            as avg_ticket,
    round(avg(dist_m) filter (where dist_m > 0))                  as avg_distance,
    round(avg(coalesce(delivery_fee, 0)), 2)                      as avg_delivery_fee,
    round(avg(coalesce(deliveryman_fee, 0)), 2)                   as avg_deliveryman_fee
  from scope
  group by 1
  order by count(*) desc, sum(coalesce(amount, 0)) desc;
$$;

revoke execute on function public.agilizone_neighborhood_stats(uuid, date, date, uuid) from public, anon;
grant  execute on function public.agilizone_neighborhood_stats(uuid, date, date, uuid) to authenticated, service_role;

-- 2. Estatísticas por raio de distância --------------------------------------
create or replace function public.agilizone_radius_stats(
  p_tenant uuid, p_from date, p_to date, p_operation uuid default null
)
returns table (
  radius_km int, orders bigint, revenue numeric, avg_ticket numeric,
  avg_distance numeric, avg_delivery_fee numeric, avg_deliveryman_fee numeric
)
language sql
stable
security invoker
set search_path = 'public','pg_temp'
as $$
  with scope as (
    select
      o.amount,
      o.delivery_fee,
      o.deliveryman_fee,
      nullif(o.payload->'deliveryDetails'->>'calculatedDistance','')::numeric as dist_m
    from public.agilizone_orders o
    where o.tenant_id = p_tenant
      and o.business_date between p_from and p_to
      and o.status not in ('CANCELED','PENDING_PAYMENT')
      and o.operation_id is not null
      and (p_operation is null or o.operation_id = p_operation)
  )
  select
    greatest(1, ceil(dist_m / 1000.0))::int                       as radius_km,
    count(*)                                                      as orders,
    round(sum(coalesce(amount, 0)), 2)                            as revenue,
    round(avg(coalesce(amount, 0)), 2)                            as avg_ticket,
    round(avg(dist_m))                                            as avg_distance,
    round(avg(coalesce(delivery_fee, 0)), 2)                      as avg_delivery_fee,
    round(avg(coalesce(deliveryman_fee, 0)), 2)                   as avg_deliveryman_fee
  from scope
  where dist_m is not null and dist_m > 0
  group by 1
  order by 1;
$$;

revoke execute on function public.agilizone_radius_stats(uuid, date, date, uuid) from public, anon;
grant  execute on function public.agilizone_radius_stats(uuid, date, date, uuid) to authenticated, service_role;
