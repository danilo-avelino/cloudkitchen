-- ============================================================================
-- Tempos de Delivery · turnos por horário + série temporal
-- ----------------------------------------------------------------------------
-- 1. delivery_shifts: divide o dia em faixas nomeadas (nível tenant). Usado só
--    para filtrar/segmentar os tempos — não tem relação com operation_shifts
--    (aquele é por operação, p/ faturamento). Suporta faixa que cruza a meia
--    noite (start > end).
-- 2. agilizone_delivery_timeseries: tempos médios por dia (p/ gráfico de camada)
--    + 5 itens mais presentes em pedidos atrasados (preparo > P75 do recorte).
--    Filtros: operação e turno (faixa de horário, hora local America/Fortaleza).
-- ============================================================================

create table if not exists public.delivery_shifts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  start_time  time not null,
  end_time    time not null,
  sort_order  int  not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, name)
);
create index if not exists delivery_shifts_tenant_idx on public.delivery_shifts(tenant_id);

drop trigger if exists tg_delivery_shifts_updated_at on public.delivery_shifts;
create trigger tg_delivery_shifts_updated_at
  before update on public.delivery_shifts
  for each row execute function app.tg_set_updated_at();

alter table public.delivery_shifts enable row level security;

drop policy if exists "delivery_shifts_read" on public.delivery_shifts;
create policy "delivery_shifts_read" on public.delivery_shifts
  for select using (app.is_member(tenant_id));

drop policy if exists "delivery_shifts_write" on public.delivery_shifts;
create policy "delivery_shifts_write" on public.delivery_shifts
  for all using (app.is_admin_or_manager(tenant_id))
  with check (app.is_admin_or_manager(tenant_id));

grant select, insert, update, delete on public.delivery_shifts to authenticated;
grant all on public.delivery_shifts to service_role;

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
    o.business_date as day,
    o.id as order_id,
    case when r.prep_raw  >= 10 and r.prep_raw  <= 3600 then r.prep_raw  end as prep_s,
    case when r.coll_raw  >= 10 and r.coll_raw  <= 3600 then r.coll_raw  end as coll_s,
    case when r.deliv_raw >= 10 and r.deliv_raw <= 7200 then r.deliv_raw end as deliv_s
  from public.agilizone_orders o
  cross join lateral (
    select
      max(case when e->>'status'='SCHEDULED' then (e->>'timestamp')::timestamptz end) as t_scheduled,
      max(case when e->>'status'='PREPARING' then (e->>'timestamp')::timestamptz end) as t_preparing,
      max(case when e->>'status'='PREPARED'  then (e->>'timestamp')::timestamptz end) as t_prepared,
      max(case when e->>'status'='COLLECTED' then (e->>'timestamp')::timestamptz end) as t_collected,
      max(case when e->>'status'='COMPLETED' then (e->>'timestamp')::timestamptz end) as t_completed
    from jsonb_array_elements(
      case when jsonb_typeof(o.payload->'history')='array' then o.payload->'history' else '[]'::jsonb end
    ) e
  ) h
  cross join lateral (
    select
      extract(epoch from (h.t_prepared  - coalesce(h.t_scheduled, h.t_preparing)))::numeric as prep_raw,
      extract(epoch from (h.t_collected - h.t_prepared))::numeric  as coll_raw,
      extract(epoch from (h.t_completed - h.t_collected))::numeric as deliv_raw
  ) r
  where o.tenant_id = p_tenant
    and o.operation_id is not null
    and o.business_date between p_from and p_to
    and o.status not in ('CANCELED','PENDING_PAYMENT')
    and (p_operation is null or o.operation_id = p_operation)
    and (
      p_shift_start is null or p_shift_end is null
      or case when p_shift_start <= p_shift_end
           then (o.created_at_src at time zone 'America/Fortaleza')::time >= p_shift_start
            and (o.created_at_src at time zone 'America/Fortaleza')::time <  p_shift_end
           else (o.created_at_src at time zone 'America/Fortaleza')::time >= p_shift_start
             or (o.created_at_src at time zone 'America/Fortaleza')::time <  p_shift_end
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
