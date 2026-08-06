-- ============================================================================
-- Logística — RPCs unificados (Agilizone + Foody Delivery)
-- ----------------------------------------------------------------------------
-- A view delivery_orders_unified normaliza as duas fontes num shape único:
--   - Agilizone: tempos extraídos do payload->'history' (como os RPCs faziam);
--     exclui PENDING_PAYMENT (nunca é usado em nenhum RPC).
--   - Foody: tempos já vêm em colunas próprias (ready/collected/delivered).
-- Mapeamento de fases: t_start→t_prepared = preparo · t_prepared→t_collected =
-- coleta · t_collected→t_completed = entrega.
--
-- Os 5 RPCs de logística passam a ler a view, mantendo NOME, ASSINATURA e
-- SHAPE de retorno (o front não muda). A trava de exclusividade garante uma
-- integração ativa por vez; o histórico das duas continua visível junto.
-- worstItems (timeseries) segue vindo só de agilizone_order_items — a Foody
-- não expõe itens estruturados (orderDetails é texto livre).
--
-- SECURITY INVOKER em tudo: a RLS das tabelas-base (is_tenant_member) escopa.
-- ============================================================================

create or replace view public.delivery_orders_unified
with (security_invoker = true) as
select
  'agilizone'::text as source,
  o.id              as order_id,
  o.tenant_id,
  o.operation_id,
  o.business_date,
  o.created_at_src,
  (o.status = 'CANCELED') as is_canceled,
  o.amount,
  o.delivery_fee,
  o.deliveryman_fee,
  nullif(trim(regexp_replace(coalesce(h.deliveryman, ''), '^[#0-9\s]+', '')), '') as deliveryman,
  coalesce(h.t_scheduled, h.t_preparing) as t_start,
  h.t_prepared,
  h.t_collected,
  h.t_completed,
  o.neighborhood,
  nullif(o.payload->'deliveryDetails'->>'calculatedDistance','')::numeric as dist_m,
  nullif(o.payload->'ifoodOrder'->'delivery'->>'deliveryDateTime','')::timestamptz as promised_at
from public.agilizone_orders o
cross join lateral (
  select
    max(case when e->>'status'='SCHEDULED' then (e->>'timestamp')::timestamptz end) as t_scheduled,
    max(case when e->>'status'='PREPARING' then (e->>'timestamp')::timestamptz end) as t_preparing,
    max(case when e->>'status'='PREPARED'  then (e->>'timestamp')::timestamptz end) as t_prepared,
    max(case when e->>'status'='COLLECTED' then (e->>'timestamp')::timestamptz end) as t_collected,
    max(case when e->>'status'='COMPLETED' then (e->>'timestamp')::timestamptz end) as t_completed,
    (array_agg(e->'deliveryman'->>'name') filter (where e->'deliveryman'->>'name' is not null))[1] as deliveryman
  from jsonb_array_elements(
    case when jsonb_typeof(o.payload->'history')='array' then o.payload->'history' else '[]'::jsonb end
  ) e
) h
where o.status <> 'PENDING_PAYMENT'
union all
select
  'foody'::text,
  f.id,
  f.tenant_id,
  f.operation_id,
  f.business_date,
  f.created_at_src,
  f.is_canceled,
  f.amount,
  f.delivery_fee,
  f.courier_fee,
  nullif(trim(coalesce(f.courier_name, '')), ''),
  f.created_at_src,     -- t_start: preparo conta desde a criação do pedido
  f.ready_at,
  f.collected_at,
  f.delivered_at,
  f.neighborhood,
  f.distance_m,
  f.promised_at
from public.foody_orders f;

grant select on public.delivery_orders_unified to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 1. agilizone_delivery_metrics — tempos por operação + ranking de entregadores
-- ----------------------------------------------------------------------------
create or replace function public.agilizone_delivery_metrics(p_tenant uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security invoker
set search_path = 'public','pg_temp'
as $$
with base as (
  select
    u.operation_id,
    u.business_date,
    u.is_canceled,
    coalesce(u.deliveryman_fee, 0) as deliveryman_fee,
    u.deliveryman,
    u.t_start, u.t_prepared, u.t_collected, u.t_completed
  from public.delivery_orders_unified u
  where u.tenant_id = p_tenant
    and u.operation_id is not null
    and u.business_date between p_from and p_to
),
calc as (
  select
    operation_id, business_date, deliveryman, deliveryman_fee,
    case when prep_raw  >= 10 and prep_raw  <= 3600 then prep_raw  end as prep_s,
    case when coll_raw  >= 10 and coll_raw  <= 3600 then coll_raw  end as coll_s,
    case when deliv_raw >= 10 and deliv_raw <= 7200 then deliv_raw end as deliv_s
  from (
    select
      operation_id, business_date, deliveryman, deliveryman_fee,
      extract(epoch from (t_prepared  - t_start))::numeric     as prep_raw,
      extract(epoch from (t_collected - t_prepared))::numeric  as coll_raw,
      extract(epoch from (t_completed - t_collected))::numeric as deliv_raw
    from base
    where not is_canceled
  ) r
),
canceled as (
  select deliveryman, count(*) as canceled_count
  from base
  where is_canceled and deliveryman is not null
  group by deliveryman
)
select jsonb_build_object(
  'byOperation', coalesce((
    select jsonb_agg(jsonb_build_object(
      'operationId', operation_id,
      'orders',      cnt,
      'delivered',   delivered,
      'avgPrep',     round(avg_prep),
      'avgCollect',  round(avg_coll),
      'avgDeliver',  round(avg_deliv),
      'avgTotal',    nullif(round(coalesce(avg_prep,0) + coalesce(avg_coll,0) + coalesce(avg_deliv,0)), 0)
    ) order by cnt desc)
    from (
      select operation_id,
        count(*)        as cnt,
        count(deliv_s)  as delivered,
        avg(prep_s)     as avg_prep,
        avg(coll_s)     as avg_coll,
        avg(deliv_s)    as avg_deliv
      from calc
      group by operation_id
    ) a
  ), '[]'::jsonb),
  'byDeliveryman', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name',       d.deliveryman,
      'deliveries', d.delivered,
      'avgDeliver', round(d.avg_deliv),
      'paid',       round(d.paid, 2),
      'daysWorked', d.days_worked,
      'canceled',   coalesce(x.canceled_count, 0)
    ) order by d.delivered desc, d.avg_deliv asc)
    from (
      select
        c.deliveryman,
        count(c.deliv_s)                as delivered,
        avg(c.deliv_s)                  as avg_deliv,
        sum(c.deliveryman_fee)          as paid,
        count(distinct c.business_date) as days_worked
      from calc c
      where c.deliveryman is not null
      group by c.deliveryman
      having count(c.deliv_s) > 0
    ) d
    left join canceled x on x.deliveryman = d.deliveryman
  ), '[]'::jsonb)
);
$$;

revoke execute on function public.agilizone_delivery_metrics(uuid, date, date) from public, anon;
grant execute on function public.agilizone_delivery_metrics(uuid, date, date) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. agilizone_delivery_timeseries — série por dia + piores itens (só Agilizone)
-- ----------------------------------------------------------------------------
create or replace function public.agilizone_delivery_timeseries(
  p_tenant uuid, p_from date, p_to date,
  p_operation uuid default null,
  p_shift_start time default null,
  p_shift_end   time default null
)
returns jsonb
language sql
stable
security invoker
set search_path = 'public','pg_temp'
as $$
with calc as (
  select
    u.business_date as day,
    u.order_id,
    case when r.prep_raw  >= 10 and r.prep_raw  <= 3600 then r.prep_raw  end as prep_s,
    case when r.coll_raw  >= 10 and r.coll_raw  <= 3600 then r.coll_raw  end as coll_s,
    case when r.deliv_raw >= 10 and r.deliv_raw <= 7200 then r.deliv_raw end as deliv_s
  from public.delivery_orders_unified u
  cross join lateral (
    select
      extract(epoch from (u.t_prepared  - u.t_start))::numeric     as prep_raw,
      extract(epoch from (u.t_collected - u.t_prepared))::numeric  as coll_raw,
      extract(epoch from (u.t_completed - u.t_collected))::numeric as deliv_raw
  ) r
  where u.tenant_id = p_tenant
    and u.operation_id is not null
    and u.business_date between p_from and p_to
    and not u.is_canceled
    and (p_operation is null or u.operation_id = p_operation)
    and (
      p_shift_start is null or p_shift_end is null
      or case when p_shift_start <= p_shift_end
           then (u.created_at_src at time zone 'America/Fortaleza')::time >= p_shift_start
            and (u.created_at_src at time zone 'America/Fortaleza')::time <  p_shift_end
           else (u.created_at_src at time zone 'America/Fortaleza')::time >= p_shift_start
             or (u.created_at_src at time zone 'America/Fortaleza')::time <  p_shift_end
         end
    )
),
thr as (
  select percentile_cont(0.75) within group (order by prep_s) as p75
  from calc where prep_s is not null
),
late_orders as (
  select c.order_id, c.prep_s
  from calc c, thr
  where c.prep_s is not null and thr.p75 is not null and c.prep_s > thr.p75
)
select jsonb_build_object(
  'byDay', coalesce((
    select jsonb_agg(jsonb_build_object(
      'day', day, 'orders', cnt,
      'avgPrep', round(ap), 'avgCollect', round(ac), 'avgDeliver', round(ad),
      'avgTotal', nullif(round(coalesce(ap,0)+coalesce(ac,0)+coalesce(ad,0)), 0)
    ) order by day)
    from (
      select day, count(*) as cnt, avg(prep_s) ap, avg(coll_s) ac, avg(deliv_s) ad
      from calc group by day
    ) g
  ), '[]'::jsonb),
  'worstItems', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', name, 'externalCode', external_code,
      'lateOrders', n, 'avgPrep', round(ap)
    ) order by n desc, ap desc)
    from (
      select i.name, max(i.external_code) as external_code,
        count(distinct lo.order_id) as n, avg(lo.prep_s) as ap
      from late_orders lo
      join public.agilizone_order_items i on i.order_id = lo.order_id
      group by i.name
      order by count(distinct lo.order_id) desc, avg(lo.prep_s) desc
      limit 5
    ) wi
  ), '[]'::jsonb),
  'lateThreshold', (select round(p75) from thr),
  'summary', (
    select jsonb_build_object(
      'orders',     count(*),
      'avgPrep',    round(avg(prep_s)),
      'avgCollect', round(avg(coll_s)),
      'avgDeliver', round(avg(deliv_s)),
      'avgTotal',   nullif(round(coalesce(avg(prep_s),0)+coalesce(avg(coll_s),0)+coalesce(avg(deliv_s),0)), 0)
    ) from calc
  )
);
$$;

revoke execute on function public.agilizone_delivery_timeseries(uuid, date, date, uuid, time, time) from public, anon;
grant execute on function public.agilizone_delivery_timeseries(uuid, date, date, uuid, time, time) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. agilizone_delivery_fees — taxas cobradas do cliente x pagas ao entregador
-- ----------------------------------------------------------------------------
create or replace function public.agilizone_delivery_fees(p_tenant uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security invoker
set search_path = 'public','pg_temp'
as $$
  with f as (
    select operation_id,
           coalesce(sum(delivery_fee), 0)    as client_collected,
           coalesce(sum(deliveryman_fee), 0) as deliveryman_paid
    from public.delivery_orders_unified
    where tenant_id = p_tenant
      and business_date between p_from and p_to
      and not is_canceled
    group by operation_id
  )
  select jsonb_build_object(
    'total', jsonb_build_object(
      'clientCollected', coalesce(sum(client_collected), 0),
      'deliverymanPaid', coalesce(sum(deliveryman_paid), 0)
    ),
    'byOperation', coalesce(
      jsonb_object_agg(operation_id::text, jsonb_build_object(
        'clientCollected', client_collected,
        'deliverymanPaid', deliveryman_paid
      )) filter (where operation_id is not null),
      '{}'::jsonb)
  )
  from f;
$$;

revoke execute on function public.agilizone_delivery_fees(uuid, date, date) from public, anon;
grant execute on function public.agilizone_delivery_fees(uuid, date, date) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. agilizone_neighborhood_stats — estatísticas por bairro
--    "Atrasada" = entregue depois do ETA prometido (promised_at) — na Foody o
--    ETA é o deliveryDueDate; na Agilizone, ifoodOrder.delivery.deliveryDateTime.
-- ----------------------------------------------------------------------------
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
      u.neighborhood,
      u.amount,
      u.delivery_fee,
      u.deliveryman_fee,
      u.dist_m,
      u.promised_at as promised_dt,
      u.t_completed as completed_dt
    from public.delivery_orders_unified u
    where u.tenant_id = p_tenant
      and u.business_date between p_from and p_to
      and not u.is_canceled
      and u.operation_id is not null
      and (p_operation is null or u.operation_id = p_operation)
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

-- ----------------------------------------------------------------------------
-- 5. agilizone_radius_stats — estatísticas por raio de distância
-- ----------------------------------------------------------------------------
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
      u.amount,
      u.delivery_fee,
      u.deliveryman_fee,
      u.dist_m,
      u.promised_at as promised_dt,
      u.t_completed as completed_dt
    from public.delivery_orders_unified u
    where u.tenant_id = p_tenant
      and u.business_date between p_from and p_to
      and not u.is_canceled
      and u.operation_id is not null
      and (p_operation is null or u.operation_id = p_operation)
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
