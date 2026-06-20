-- ============================================================================
-- Agilizone — ingest isolado + normalização por operação
-- ----------------------------------------------------------------------------
-- Modelo: 1 conta Agilizone = 1 dark kitchen física (storeId). Dentro dela
-- rodam N marcas (ifoodOrder.merchant.name) que mapeamos para `operations`.
-- O segredo (client_secret) NÃO fica no banco: vem da env AGILIZONE_SECRETS
-- (mapa client_id -> secret) na edge function. Aqui guardamos só client_id.
-- ============================================================================

-- 1. Contas (uma por dark kitchen) -------------------------------------------
create table if not exists public.agilizone_accounts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  label         text not null,                                   -- ex.: 'Dark Aldeota'
  environment   text not null default 'production'
                  check (environment in ('production','sandbox')),
  client_id     text not null unique,                            -- secret vem da env
  store_id      text,                                            -- descoberto no 1º sync
  is_active     boolean not null default true,
  last_synced_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists agilizone_accounts_tenant_idx
  on public.agilizone_accounts (tenant_id);

drop trigger if exists tg_agilizone_accounts_updated_at on public.agilizone_accounts;
create trigger tg_agilizone_accounts_updated_at
  before update on public.agilizone_accounts
  for each row execute function app.tg_set_updated_at();

-- 2. Mapa marca -> operação (por conta) --------------------------------------
create table if not exists public.agilizone_brand_map (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  account_id    uuid not null references public.agilizone_accounts(id) on delete cascade,
  merchant_name text not null,                                   -- ifoodOrder.merchant.name (match exato)
  operation_id  uuid not null references public.operations(id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (account_id, merchant_name)
);

create index if not exists agilizone_brand_map_tenant_idx
  on public.agilizone_brand_map (tenant_id);

drop trigger if exists tg_agilizone_brand_map_updated_at on public.agilizone_brand_map;
create trigger tg_agilizone_brand_map_updated_at
  before update on public.agilizone_brand_map
  for each row execute function app.tg_set_updated_at();

-- 3. Pedidos (staging cru + campos normalizados) -----------------------------
--    Upsert idempotente por (account_id, agz_id). Status muda entre polls.
create table if not exists public.agilizone_orders (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  account_id      uuid not null references public.agilizone_accounts(id) on delete cascade,
  agz_id          text not null,                                 -- _id da Agilizone
  operation_id    uuid references public.operations(id) on delete set null, -- null = marca não mapeada
  merchant_name   text,
  order_number    text,
  status          text not null,
  is_canceled     boolean not null default false,
  origin_platform text,
  order_type      text,
  business_date   date not null,                                 -- dia efetivo (corte 05:00 BRT)
  created_at_src  timestamptz not null,                          -- createdAt do pedido
  amount          numeric(14,2),                                 -- orderAmount (líquido p/ cliente)
  subtotal        numeric(14,2),                                 -- total.subTotal (bruto de menu)
  delivery_fee    numeric(14,2),
  deliveryman_fee numeric(14,2),
  benefits_total  numeric(14,2),                                 -- total.benefits (cupons/incentivos)
  payment_type    text,
  is_prepaid      boolean,
  neighborhood    text,
  deliveryman_id  text,
  payload         jsonb not null,                                -- pedido cru completo (fonte da verdade)
  fetched_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (account_id, agz_id)
);

create index if not exists agilizone_orders_tenant_date_idx
  on public.agilizone_orders (tenant_id, business_date desc);
create index if not exists agilizone_orders_operation_date_idx
  on public.agilizone_orders (operation_id, business_date desc);
create index if not exists agilizone_orders_account_status_idx
  on public.agilizone_orders (account_id, status);

drop trigger if exists tg_agilizone_orders_updated_at on public.agilizone_orders;
create trigger tg_agilizone_orders_updated_at
  before update on public.agilizone_orders
  for each row execute function app.tg_set_updated_at();

-- 4. Itens vendidos (1 linha por item) ---------------------------------------
create table if not exists public.agilizone_order_items (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  order_id      uuid not null references public.agilizone_orders(id) on delete cascade,
  idx           int,
  external_code text,                                            -- SKU (item.externalCode)
  name          text not null,
  quantity      numeric(12,3) not null default 1,
  unit_price    numeric(14,2),
  total_price   numeric(14,2),
  options       jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists agilizone_order_items_order_idx
  on public.agilizone_order_items (order_id);
create index if not exists agilizone_order_items_sku_idx
  on public.agilizone_order_items (tenant_id, external_code);

-- 5. Dia efetivo (corte 05:00 BRT = UTC-8h) ----------------------------------
create or replace function app.agilizone_effective_day(p_ts timestamptz)
returns date
language sql
immutable
set search_path = 'app','public','pg_temp'
as $$
  select ((p_ts - interval '8 hours') at time zone 'UTC')::date;
$$;

-- 6. RLS ---------------------------------------------------------------------
alter table public.agilizone_accounts    enable row level security;
alter table public.agilizone_brand_map   enable row level security;
alter table public.agilizone_orders      enable row level security;
alter table public.agilizone_order_items enable row level security;

-- Contas: sem policy para authenticated/anon → só service_role (bypassa RLS)
-- enxerga. Mantém credenciais e config de integração fora do cliente.

-- Brand map: membros do tenant leem; escrita só backend (service_role).
drop policy if exists agilizone_brand_map_sel on public.agilizone_brand_map;
create policy agilizone_brand_map_sel on public.agilizone_brand_map
  for select using (app.is_tenant_member(tenant_id));

-- Pedidos: membros do tenant leem; escrita só backend (service_role).
drop policy if exists agilizone_orders_sel on public.agilizone_orders;
create policy agilizone_orders_sel on public.agilizone_orders
  for select using (app.is_tenant_member(tenant_id));

-- Itens: membros do tenant leem; escrita só backend (service_role).
drop policy if exists agilizone_order_items_sel on public.agilizone_order_items;
create policy agilizone_order_items_sel on public.agilizone_order_items
  for select using (app.is_tenant_member(tenant_id));

-- 7. GRANTs para service_role (edge function) — CLAUDE.md §5.3 ----------------
grant usage on schema public to service_role;
grant all on public.agilizone_accounts    to service_role;
grant all on public.agilizone_brand_map   to service_role;
grant all on public.agilizone_orders      to service_role;
grant all on public.agilizone_order_items to service_role;
grant select on public.agilizone_brand_map, public.agilizone_orders,
               public.agilizone_order_items to authenticated;
