-- =====================================================================
-- FASE 11 — INVENTÁRIOS FÍSICOS
-- Sessões de contagem física com itens esperado/contado, score, impacto.
-- Diferente de stock_period_closures (que é fechamento contábil mensal).
--
-- IDEMPOTENTE · pode rodar várias vezes.
-- =====================================================================

do $$ begin
  create type app.inventory_status as enum ('in_progress', 'finalized', 'canceled');
exception when duplicate_object then null; end $$;

-- 11.1 Sessão de inventário (cabeçalho)
create table if not exists public.inventory_sessions (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  status             app.inventory_status not null default 'in_progress',
  -- Pontuação calculada na finalização (0-100)
  score              numeric(5,2),
  -- Impacto financeiro líquido (positivo = sobra; negativo = perda)
  financial_impact   numeric(14,2),
  -- Categorias incluídas no escopo (snapshot dos nomes)
  scope_categories   text[] default '{}',
  -- Quem conduziu a contagem (snapshot · profile pode ser desativado depois)
  responsible_id     uuid references public.profiles(id) on delete set null,
  responsible_name   text,
  responsible_role   text,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists inventory_sessions_tenant_idx
  on public.inventory_sessions (tenant_id, started_at desc);
create index if not exists inventory_sessions_status_idx
  on public.inventory_sessions (tenant_id, status);

drop trigger if exists tg_inventory_sessions_updated_at on public.inventory_sessions;
create trigger tg_inventory_sessions_updated_at
  before update on public.inventory_sessions
  for each row execute function app.tg_set_updated_at();

-- 11.2 Itens da sessão · esperado vs contado
create table if not exists public.inventory_session_items (
  id                     uuid primary key default gen_random_uuid(),
  inventory_session_id   uuid not null references public.inventory_sessions(id) on delete cascade,
  stock_item_id          uuid references public.stock_items(id) on delete set null,
  display_name           text not null,
  category_name          text,
  unit                   text not null,
  expected_qty           numeric(14,4) not null default 0,
  -- counted_qty NULL = não contado (parcial · em sessões salvas como rascunho)
  counted_qty            numeric(14,4),
  unit_cost              numeric(12,4) not null default 0 check (unit_cost >= 0),
  -- diff e impact calculados na finalização (cache pra não recalcular)
  diff_qty               numeric(14,4) generated always as (
    case when counted_qty is null then null else counted_qty - expected_qty end
  ) stored,
  impact_value           numeric(14,4) generated always as (
    case when counted_qty is null then null else (counted_qty - expected_qty) * unit_cost end
  ) stored,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists inventory_items_session_idx
  on public.inventory_session_items (inventory_session_id);
create index if not exists inventory_items_stock_idx
  on public.inventory_session_items (stock_item_id);

drop trigger if exists tg_inventory_items_updated_at on public.inventory_session_items;
create trigger tg_inventory_items_updated_at
  before update on public.inventory_session_items
  for each row execute function app.tg_set_updated_at();

-- 11.3 RLS
alter table public.inventory_sessions       enable row level security;
alter table public.inventory_session_items  enable row level security;

drop policy if exists "inv_sessions_select" on public.inventory_sessions;
drop policy if exists "inv_sessions_write"  on public.inventory_sessions;
drop policy if exists "inv_items_rw"        on public.inventory_session_items;

create policy "inv_sessions_select" on public.inventory_sessions
  for select using (app.is_member(tenant_id));
create policy "inv_sessions_write"  on public.inventory_sessions
  for all    using (app.is_member(tenant_id));
create policy "inv_items_rw"        on public.inventory_session_items
  for all    using (app.is_member(
    (select tenant_id from public.inventory_sessions where id = inventory_session_id)
  ));

-- =====================================================================
-- FIM — FASE 11
-- =====================================================================

-- Verificação
select 'inventory_sessions'      as table, count(*) from public.inventory_sessions
union all
select 'inventory_session_items' as table, count(*) from public.inventory_session_items;
