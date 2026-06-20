-- ============================================================================
-- Bairros/Raios · % de entregas atrasadas
-- ----------------------------------------------------------------------------
-- "Atrasada" = entregue depois do horário previsto pela plataforma:
--   COMPLETED (history) > ifoodOrder.delivery.deliveryDateTime (ETA prometido).
-- Definição baseada em SLA (≠ "atrasado" da aba Tempos, que é preparo > P75).
-- Só conta no denominador (`measured`) pedidos com ETA e COMPLETED — cobertura
-- ~99,5% / ~100%. Acrescenta colunas measured/late_orders/late_pct aos 2 RPCs.
-- Mudança de assinatura (novas colunas) → DROP + CREATE.
-- ============================================================================

drop function if exists public.agilizone_neighborhood_stats(uuid, date, date, uuid);
drop function if exists public.agilizone_radius_stats(uuid, date, date, uuid);

-- 1. Estatísticas por bairro -------------------------------------------------
create or replace function public.agilizone_neighborhood_stats(
  p_tenant uuid, p_from date, p_to date, p_operation uuid default null
)
returns table (
  neighborhood text, orders bigint, revenue numeric, avg_ticket numeric,
  avg_distance numeric, avg_delivery_fee numeric, avg_deliveryman_fee numeric,
  measured bigint, late_orders bigint, late_pct numeric
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
      nullif(o.payload->'deliveryDetails'->>'calculatedDistance','')::numeric as dist_m,
      nullif(o.payload->'ifoodOrder'->'delivery'->>'deliveryDateTime','')::timestamptz as promised_dt,
      (select max((e->>'timestamp')::timestamptz)
         from jsonb_array_elements(
           case when jsonb_typeof(o.payload->'history')='array' then o.payload->'history' else '[]'::jsonb end) e
         where e->>'status' = 'COMPLETED') as completed_dt
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
    round(avg(coalesce(deliveryman_fee, 0)), 2)                   as avg_deliveryman_fee,
    count(*) filter (where promised_dt is not null and completed_dt is not null)                          as measured,
    count(*) filter (where promised_dt is not null and completed_dt is not null and completed_dt > promised_dt) as late_orders,
    round(100.0 * count(*) filter (where promised_dt is not null and completed_dt is not null and completed_dt > promised_dt)
          / nullif(count(*) filter (where promised_dt is not null and completed_dt is not null), 0), 1)   as late_pct
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
  avg_distance numeric, avg_delivery_fee numeric, avg_deliveryman_fee numeric,
  measured bigint, late_orders bigint, late_pct numeric
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
      nullif(o.payload->'deliveryDetails'->>'calculatedDistance','')::numeric as dist_m,
      nullif(o.payload->'ifoodOrder'->'delivery'->>'deliveryDateTime','')::timestamptz as promised_dt,
      (select max((e->>'timestamp')::timestamptz)
         from jsonb_array_elements(
           case when jsonb_typeof(o.payload->'history')='array' then o.payload->'history' else '[]'::jsonb end) e
         where e->>'status' = 'COMPLETED') as completed_dt
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
    round(avg(coalesce(deliveryman_fee, 0)), 2)                   as avg_deliveryman_fee,
    count(*) filter (where promised_dt is not null and completed_dt is not null)                          as measured,
    count(*) filter (where promised_dt is not null and completed_dt is not null and completed_dt > promised_dt) as late_orders,
    round(100.0 * count(*) filter (where promised_dt is not null and completed_dt is not null and completed_dt > promised_dt)
          / nullif(count(*) filter (where promised_dt is not null and completed_dt is not null), 0), 1)   as late_pct
  from scope
  where dist_m is not null and dist_m > 0
  group by 1
  order by 1;
$$;

revoke execute on function public.agilizone_radius_stats(uuid, date, date, uuid) from public, anon;
grant  execute on function public.agilizone_radius_stats(uuid, date, date, uuid) to authenticated, service_role;
