-- ============================================================================
-- Cardápio · insights por item (para os cards de Tendência)
-- Para um conjunto de itens (p_names), calcula no período: pico de horário,
-- canal (origin) principal, dia da semana mais forte, operação líder e o
-- sparkline de vendas/dia. Hora/dow em horário local America/Fortaleza.
-- SECURITY INVOKER: RLS de agilizone_orders/items + operations garante escopo.
-- ============================================================================

create or replace function public.agilizone_menu_item_insights(
  p_tenant uuid, p_from date, p_to date, p_operation uuid, p_names text[]
)
returns table (
  name text,
  peak_hour int, peak_share numeric,
  top_source text, top_source_share numeric,
  busiest_dow int, busiest_dow_share numeric,
  top_operation text, top_operation_share numeric,
  spark jsonb
)
language sql
stable
security invoker
set search_path = 'public','pg_temp'
as $$
  with base as (
    select
      i.name,
      coalesce(i.quantity, 1)::numeric as q,
      o.business_date as day,
      extract(hour from (o.created_at_src at time zone 'America/Fortaleza'))::int as hr,
      extract(dow  from (o.created_at_src at time zone 'America/Fortaleza'))::int as dow,
      o.origin_platform as src,
      o.operation_id as op
    from public.agilizone_order_items i
    join public.agilizone_orders o on o.id = i.order_id
    where o.tenant_id = p_tenant
      and o.business_date between p_from and p_to
      and o.status not in ('CANCELED','PENDING_PAYMENT')
      and o.operation_id is not null
      and (p_operation is null or o.operation_id = p_operation)
      and i.name = any(p_names)
  ),
  tot as (select name, sum(q) as tq from base group by name),
  byhour as (select name, hr,  sum(q) q, row_number() over (partition by name order by sum(q) desc, hr) rn from base group by name, hr),
  bysrc  as (select name, src, sum(q) q, row_number() over (partition by name order by sum(q) desc) rn from base group by name, src),
  bydow  as (select name, dow, sum(q) q, row_number() over (partition by name order by sum(q) desc, dow) rn from base group by name, dow),
  byop   as (select name, op,  sum(q) q, row_number() over (partition by name order by sum(q) desc) rn from base group by name, op),
  spk    as (
    select name, jsonb_agg(jsonb_build_object('d', day, 'q', q) order by day) as spark
    from (select name, day, sum(q) q from base group by name, day) s
    group by name
  )
  select
    t.name,
    h.hr  as peak_hour,    round(h.q / nullif(t.tq,0), 3) as peak_share,
    s.src as top_source,   round(s.q / nullif(t.tq,0), 3) as top_source_share,
    d.dow as busiest_dow,  round(d.q / nullif(t.tq,0), 3) as busiest_dow_share,
    opn.name as top_operation, round(bo.q / nullif(t.tq,0), 3) as top_operation_share,
    sp.spark
  from tot t
  left join byhour h  on h.name  = t.name and h.rn  = 1
  left join bysrc  s  on s.name  = t.name and s.rn  = 1
  left join bydow  d  on d.name  = t.name and d.rn  = 1
  left join byop   bo on bo.name = t.name and bo.rn = 1
  left join public.operations opn on opn.id = bo.op
  left join spk    sp on sp.name = t.name;
$$;

revoke execute on function public.agilizone_menu_item_insights(uuid, date, date, uuid, text[]) from public, anon;
grant execute on function public.agilizone_menu_item_insights(uuid, date, date, uuid, text[]) to authenticated, service_role;
