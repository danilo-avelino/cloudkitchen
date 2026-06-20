-- ============================================================================
-- Entregadores · acrescenta ao ranking: valor pago, dias trabalhados e
-- entregas canceladas no período.
-- ----------------------------------------------------------------------------
-- Retorno segue jsonb → dá pra acrescentar chaves a byDeliveryman sem trocar a
-- assinatura (CREATE OR REPLACE). Mudanças no corpo:
--   - `base` passa a incluir CANCELED (filtra só PENDING_PAYMENT) p/ contar
--     cancelamentos por entregador (atribuídos pelo nome no history).
--   - `calc` (métricas de tempo) continua só com não-cancelados.
--   - byDeliveryman ganha: paid (Σ deliveryman_fee dos não-cancelados dele),
--     daysWorked (business_date distintos) e canceled (nº de cancelados dele).
-- ============================================================================

create or replace function public.agilizone_delivery_metrics(p_tenant uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security invoker
set search_path = 'public','pg_temp'
as $$
with base as (
  select
    o.operation_id,
    o.business_date,
    o.status,
    coalesce(o.deliveryman_fee, 0) as deliveryman_fee,
    nullif(trim(regexp_replace(coalesce(h.deliveryman, ''), '^[#0-9\s]+', '')), '') as deliveryman,
    h.t_scheduled, h.t_preparing, h.t_prepared, h.t_collected, h.t_completed
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
    and o.status <> 'PENDING_PAYMENT'
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
      extract(epoch from (t_prepared  - coalesce(t_scheduled, t_preparing)))::numeric as prep_raw,
      extract(epoch from (t_collected - t_prepared))::numeric  as coll_raw,
      extract(epoch from (t_completed - t_collected))::numeric as deliv_raw
    from base
    where status <> 'CANCELED'
  ) r
),
canceled as (
  select deliveryman, count(*) as canceled_count
  from base
  where status = 'CANCELED' and deliveryman is not null
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
