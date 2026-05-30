-- FASE 13 — PROD (corrigida)

-- 13.1 SUPERADMIN
alter table public.profiles
  add column if not exists is_superadmin boolean not null default false;

create index if not exists profiles_superadmin_idx
  on public.profiles (is_superadmin) where is_superadmin = true;

create or replace function app.is_superadmin(p_user uuid)
returns boolean
language sql stable security definer
set search_path = public, app
as $$
  select coalesce((select is_superadmin from public.profiles where id = p_user), false);
$$;

-- 13.2 INVENTORY → DRE trigger
create or replace function app.tg_inventory_to_dre()
returns trigger
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_subcat_id uuid;
  v_category_id uuid;
  v_existing_entry uuid;
begin
  if new.status <> 'finalized' or old.status = 'finalized' then
    return new;
  end if;

  if coalesce(new.financial_impact, 0) = 0 then
    return new;
  end if;

  select id into v_subcat_id
  from public.dre_subcategories
  where tenant_id = new.tenant_id
    and lower(name) = 'ajuste de estoque'
  limit 1;

  if v_subcat_id is null then
    select id into v_category_id
    from public.dre_categories
    where tenant_id = new.tenant_id
      and lower(name) like '%custo%'
    order by sort_order nulls last
    limit 1;

    if v_category_id is null then
      insert into public.dre_categories (tenant_id, name, sort_order)
      values (new.tenant_id, 'Custos operacionais', 99)
      returning id into v_category_id;
    end if;

    insert into public.dre_subcategories (tenant_id, category_id, name, autofeed)
    values (new.tenant_id, v_category_id, 'Ajuste de estoque', 'inventory')
    returning id into v_subcat_id;
  end if;

  select id into v_existing_entry
  from public.finance_entries
  where tenant_id = new.tenant_id
    and auto_source = 'inventory_session'
    and auto_source_id = new.id
  limit 1;

  if v_existing_entry is not null then
    return new;
  end if;

  insert into public.finance_entries (
    tenant_id, subcategory_id, description, value,
    competence_date, status, auto_source, auto_source_id, notes
  ) values (
    new.tenant_id,
    v_subcat_id,
    case
      when new.financial_impact < 0
        then format('Inventário %s · perda', to_char(coalesce(new.finished_at, now()), 'DD/MM/YYYY'))
      else format('Inventário %s · sobra', to_char(coalesce(new.finished_at, now()), 'DD/MM/YYYY'))
    end,
    abs(new.financial_impact),
    coalesce(new.finished_at::date, current_date),
    'confirmed',
    'inventory_session',
    new.id,
    format('Auto-gerado pela finalização da sessão %s', new.id)
  );

  return new;
end;
$$;

drop trigger if exists tg_inventory_sessions_to_dre on public.inventory_sessions;
create trigger tg_inventory_sessions_to_dre
  after update on public.inventory_sessions
  for each row execute function app.tg_inventory_to_dre();

-- 13.3 CMV DIÁRIO
create table if not exists public.cmv_daily (
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  business_date  date not null,
  operation_id   uuid references public.operations(id) on delete cascade,
  revenue        numeric(14,2) not null default 0,
  cogs           numeric(14,2) not null default 0,
  cmv_pct        numeric(6,2) generated always as (
    case when revenue > 0 then (cogs / revenue) * 100 else 0 end
  ) stored,
  computed_at    timestamptz not null default now(),
  primary key (tenant_id, business_date, operation_id)
);

create index if not exists cmv_daily_tenant_date_idx
  on public.cmv_daily (tenant_id, business_date desc);

alter table public.cmv_daily enable row level security;

drop policy if exists cmv_daily_select on public.cmv_daily;
create policy cmv_daily_select on public.cmv_daily
  for select using (app.is_member(tenant_id));

create or replace function app.compute_cmv_daily(
  p_tenant_id uuid,
  p_from date default current_date - 30,
  p_to date default current_date
)
returns integer
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_count integer := 0;
begin
  delete from public.cmv_daily
  where tenant_id = p_tenant_id
    and business_date between p_from and p_to;

  insert into public.cmv_daily (tenant_id, business_date, operation_id, revenue, cogs)
  select
    re.tenant_id,
    re.business_date,
    re.operation_id,
    coalesce((
      select sum(rpb.amount)
      from public.revenue_payment_breakdown rpb
      where rpb.revenue_entry_id = re.id
    ), 0) as revenue,
    coalesce(re.cogs, 0) as cogs
  from public.revenue_entries re
  where re.tenant_id = p_tenant_id
    and re.business_date between p_from and p_to;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 13.4 ÍNDICES
create index if not exists revenue_entries_tenant_date_idx
  on public.revenue_entries (tenant_id, business_date desc);

create index if not exists stock_items_tenant_active_idx
  on public.stock_items (tenant_id)
  where is_active = true;

create index if not exists stock_movements_out_idx
  on public.stock_movements (tenant_id, performed_at desc)
  where kind = 'out';

create index if not exists kitchen_requests_tenant_status_idx
  on public.kitchen_requests (tenant_id, status, requested_at desc);

create index if not exists purchase_orders_tenant_status_idx
  on public.purchase_orders (tenant_id, status, created_at desc);

create index if not exists finance_entries_status_idx
  on public.finance_entries (tenant_id, status, competence_date desc);

-- 13.5 REALTIME
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'kitchen_requests'
  ) then
    alter publication supabase_realtime add table public.kitchen_requests;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stock_movements'
  ) then
    alter publication supabase_realtime add table public.stock_movements;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'revenue_entries'
  ) then
    alter publication supabase_realtime add table public.revenue_entries;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'goods_receipts'
  ) then
    alter publication supabase_realtime add table public.goods_receipts;
  end if;
end $$;;
