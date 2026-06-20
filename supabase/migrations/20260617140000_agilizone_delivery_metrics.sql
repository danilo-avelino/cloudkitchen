-- ============================================================================
-- Tempos de Delivery — métricas agregadas a partir de agilizone_orders.history
-- ----------------------------------------------------------------------------
-- Extrai por pedido: preparo = PREPARED − (SCHEDULED|PREPARING); coleta =
-- COLLECTED − PREPARED; entrega = COMPLETED − COLLECTED. Descarta < 10s; teto
-- 3600s (preparo/coleta) e 7200s (entrega). Agrega por operação e por entregador.
-- SECURITY INVOKER: a RLS de agilizone_orders (is_tenant_member) garante o escopo.
-- ============================================================================

create or replace function public.agilizone_delivery_metrics(p_tenant uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security invoker
set search_path = 'public','pg_temp'
as $$
with calc as (
  select
    operation_id,
    deliveryman,
    case when prep_raw  >= 10 and prep_raw  <= 3600 then prep_raw  end as prep_s,
    case when coll_raw  >= 10 and coll_raw  <= 3600 then coll_raw  end as coll_s,
    case when deliv_raw >= 10 and deliv_raw <= 7200 then deliv_raw end as deliv_s
  from (
    select
      o.operation_id,
      nullif(trim(regexp_replace(coalesce(h.deliveryman, ''), '^[#0-9\s]+', '')), '') as deliveryman,
      extract(epoch from (h.t_prepared  - coalesce(h.t_scheduled, h.t_preparing)))::numeric as prep_raw,
      extract(epoch from (h.t_collected - h.t_prepared))::numeric  as coll_raw,
      extract(epoch from (h.t_completed - h.t_collected))::numeric as deliv_raw
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
    where o.tenant_id = p_tenant
      and o.operation_id is not null
      and o.business_date between p_from and p_to
      and o.status not in ('CANCELED','PENDING_PAYMENT')
  ) r
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
      'name',       deliveryman,
      'deliveries', delivered,
      'avgDeliver', round(avg_deliv)
    ) order by delivered desc, avg_deliv asc)
    from (
      select deliveryman, count(deliv_s) as delivered, avg(deliv_s) as avg_deliv
      from calc
      where deliveryman is not null
      group by deliveryman
      having count(deliv_s) > 0
    ) d
  ), '[]'::jsonb)
);
$$;

revoke execute on function public.agilizone_delivery_metrics(uuid, date, date) from public, anon;
grant execute on function public.agilizone_delivery_metrics(uuid, date, date) to authenticated, service_role;
