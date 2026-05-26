-- =====================================================================
-- StockKitchen — Schema Supabase (Postgres)
-- Projeto: Estoque MobyDick · multi-tenant · RLS habilitado
-- =====================================================================
-- Construção por fases (executar tudo de uma vez no SQL Editor do Supabase
-- ou aplicar via `supabase db push` quando o projeto estiver vinculado).
-- =====================================================================


-- =====================================================================
-- FASE 1 — FUNDAÇÃO: tenants, auth/profiles, operações, métodos de pagamento
-- =====================================================================

-- ---------- 1.1 Extensions --------------------------------------------
create extension if not exists "pgcrypto"; -- gen_random_uuid()
create extension if not exists "citext";   -- e-mails / slugs case-insensitive
create extension if not exists "pg_trgm";  -- busca por similaridade


-- ---------- 1.2 Schema utilitário e função updated_at -----------------
create schema if not exists app;

create or replace function app.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;


-- ---------- 1.3 Enums -------------------------------------------------
do $$ begin
  create type app.tenant_plan as enum ('trial', 'starter', 'pro', 'enterprise');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.tenant_status as enum ('active', 'suspended', 'canceled');
exception when duplicate_object then null; end $$;

-- Papéis dentro de um tenant. Combinam dono/admin com papéis operacionais
-- vistos no frontend (Rafa/owner, Estoquista, Contador, Cozinha).
do $$ begin
  create type app.member_role as enum (
    'owner',       -- dono(a), pode tudo, inclusive faturamento da plataforma
    'admin',       -- administra usuários e configurações
    'manager',     -- gerência operacional (Rafa, gerentes)
    'kitchen',     -- cozinha (Stefano, Marina, Lucas, Camila)
    'stock',       -- estoquista
    'accountant',  -- contador (acesso ao financeiro)
    'viewer'       -- somente leitura
  );
exception when duplicate_object then null; end $$;


-- ---------- 1.4 Tenants (cada cliente / dark kitchen) -----------------
create table if not exists public.tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        citext not null unique,
  name        text   not null,
  legal_name  text,
  cnpj        text,
  plan        app.tenant_plan   not null default 'trial',
  status      app.tenant_status not null default 'active',
  trial_ends_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint tenants_slug_format_chk
    check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$')
);

drop trigger if exists tg_tenants_updated_at on public.tenants;
create trigger tg_tenants_updated_at
  before update on public.tenants
  for each row execute function app.tg_set_updated_at();


-- ---------- 1.5 Profiles (1↔1 com auth.users) -------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  avatar_url  text,
  phone       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists tg_profiles_updated_at on public.profiles;
create trigger tg_profiles_updated_at
  before update on public.profiles
  for each row execute function app.tg_set_updated_at();

-- Cria perfil automaticamente ao registrar um novo usuário no auth
create or replace function app.tg_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists tg_on_auth_user_created on auth.users;
create trigger tg_on_auth_user_created
  after insert on auth.users
  for each row execute function app.tg_handle_new_user();


-- ---------- 1.6 Tenant members (vínculo user ↔ tenant ↔ papel) --------
create table if not exists public.tenant_members (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        app.member_role not null default 'viewer',
  invited_by  uuid references auth.users(id) on delete set null,
  joined_at   timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index if not exists tenant_members_user_idx
  on public.tenant_members (user_id);

drop trigger if exists tg_tenant_members_updated_at on public.tenant_members;
create trigger tg_tenant_members_updated_at
  before update on public.tenant_members
  for each row execute function app.tg_set_updated_at();


-- ---------- 1.7 Helpers de RLS ---------------------------------------
-- Retorna o conjunto de tenant_ids dos quais o usuário atual é membro.
create or replace function app.current_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, app
as $$
  select tm.tenant_id
  from public.tenant_members tm
  where tm.user_id = auth.uid();
$$;

-- Verifica se o usuário atual é membro do tenant com pelo menos um dos papéis.
create or replace function app.has_tenant_role(p_tenant uuid, p_roles app.member_role[])
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = p_tenant
      and tm.user_id   = auth.uid()
      and tm.role      = any(p_roles)
  );
$$;

-- Atalho: é membro (qualquer papel) deste tenant?
create or replace function app.is_tenant_member(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$
  select exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id = p_tenant
      and tm.user_id   = auth.uid()
  );
$$;


-- ---------- 1.7.b Grants do schema `app` para roles do Supabase -------
-- Sem USAGE em `app`, qualquer RLS policy ou trigger que invoque
-- app.has_tenant_role()/app.is_tenant_member() falha com
-- "permission denied for schema app" — mesmo que as funções sejam
-- SECURITY DEFINER, a resolução do nome exige USAGE no schema.
grant usage on schema app to authenticated, anon, service_role;
grant execute on all functions in schema app
  to authenticated, anon, service_role;
alter default privileges in schema app
  grant execute on functions to authenticated, anon, service_role;


-- ---------- 1.8 Operações (marcas dentro de um tenant) ---------------
create table if not exists public.operations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  slug        citext not null,                 -- ex.: 'burguer', 'pizzaria'
  name        text   not null,                 -- ex.: 'Forno & Brasa'
  short_label text   not null,                 -- ex.: 'BURG'
  color       text,                            -- ex.: '#c2843a'
  ifood_handle text,                           -- ex.: '@fornoebrasa'
  cmv_goal_pct numeric(5,2),                   -- meta de CMV (%)
  is_active    boolean not null default true,
  sort_order   int     not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, slug)
);

create index if not exists operations_tenant_idx
  on public.operations (tenant_id);

drop trigger if exists tg_operations_updated_at on public.operations;
create trigger tg_operations_updated_at
  before update on public.operations
  for each row execute function app.tg_set_updated_at();


-- ---------- 1.9 Métodos de pagamento (por tenant) --------------------
create table if not exists public.payment_methods (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  slug        citext not null,            -- 'debito','credito','voucher','dinheiro','pix','online'
  label       text   not null,
  short_label text,
  color       text,
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, slug)
);

create index if not exists payment_methods_tenant_idx
  on public.payment_methods (tenant_id);

drop trigger if exists tg_payment_methods_updated_at on public.payment_methods;
create trigger tg_payment_methods_updated_at
  before update on public.payment_methods
  for each row execute function app.tg_set_updated_at();


-- ---------- 1.10 Onboarding helper -----------------------------------
-- Cria um tenant + vincula o usuário atual como owner + popula métodos
-- de pagamento padrão. Devolve o tenant_id criado.
create or replace function public.create_tenant_with_owner(
  p_slug text,
  p_name text
) returns uuid
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_uid     uuid := auth.uid();
  v_tenant  uuid;
begin
  if v_uid is null then
    raise exception 'auth.uid() is null — usuário não autenticado';
  end if;

  insert into public.tenants (slug, name)
  values (lower(p_slug), p_name)
  returning id into v_tenant;

  insert into public.tenant_members (tenant_id, user_id, role)
  values (v_tenant, v_uid, 'owner');

  insert into public.payment_methods (tenant_id, slug, label, short_label, color, sort_order) values
    (v_tenant, 'debito',   'Débito',   'Déb',  '#3d6cb0', 1),
    (v_tenant, 'credito',  'Crédito',  'Créd', '#6b5fb0', 2),
    (v_tenant, 'voucher',  'Voucher',  'Vchr', '#c2843a', 3),
    (v_tenant, 'dinheiro', 'Dinheiro', 'Din',  '#2d8c66', 4),
    (v_tenant, 'pix',      'Pix',      'Pix',  '#1aa39e', 5),
    (v_tenant, 'online',   'Online',   'Onl',  '#b04545', 6);

  return v_tenant;
end;
$$;


-- =====================================================================
-- FASE 1 — RLS (Row-Level Security)
-- =====================================================================

alter table public.tenants         enable row level security;
alter table public.profiles        enable row level security;
alter table public.tenant_members  enable row level security;
alter table public.operations      enable row level security;
alter table public.payment_methods enable row level security;

-- ---------- profiles --------------------------------------------------
-- Cada usuário enxerga e edita apenas o próprio perfil.
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles
  for select using (id = auth.uid());

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ---------- tenants ---------------------------------------------------
-- Membros enxergam o próprio tenant. Apenas owner/admin podem alterar.
drop policy if exists tenants_member_select on public.tenants;
create policy tenants_member_select on public.tenants
  for select using (app.is_tenant_member(id));

drop policy if exists tenants_admin_update on public.tenants;
create policy tenants_admin_update on public.tenants
  for update using (app.has_tenant_role(id, array['owner','admin']::app.member_role[]))
  with check     (app.has_tenant_role(id, array['owner','admin']::app.member_role[]));

-- INSERT/DELETE de tenants: bloqueado via RLS; criação só via
-- public.create_tenant_with_owner() (security definer).

-- ---------- tenant_members -------------------------------------------
-- Cada usuário enxerga seus próprios vínculos; owner/admin enxerga e
-- gerencia os vínculos do tenant.
drop policy if exists tenant_members_self_select on public.tenant_members;
create policy tenant_members_self_select on public.tenant_members
  for select using (
        user_id = auth.uid()
     or app.has_tenant_role(tenant_id, array['owner','admin']::app.member_role[])
  );

drop policy if exists tenant_members_admin_write on public.tenant_members;
create policy tenant_members_admin_write on public.tenant_members
  for all using (app.has_tenant_role(tenant_id, array['owner','admin']::app.member_role[]))
  with check    (app.has_tenant_role(tenant_id, array['owner','admin']::app.member_role[]));

-- ---------- operations ------------------------------------------------
drop policy if exists operations_member_select on public.operations;
create policy operations_member_select on public.operations
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists operations_manager_write on public.operations;
create policy operations_manager_write on public.operations
  for all using (app.has_tenant_role(tenant_id, array['owner','admin','manager']::app.member_role[]))
  with check    (app.has_tenant_role(tenant_id, array['owner','admin','manager']::app.member_role[]));

-- ---------- payment_methods ------------------------------------------
drop policy if exists payment_methods_member_select on public.payment_methods;
create policy payment_methods_member_select on public.payment_methods
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists payment_methods_admin_write on public.payment_methods;
create policy payment_methods_admin_write on public.payment_methods
  for all using (app.has_tenant_role(tenant_id, array['owner','admin','manager','accountant']::app.member_role[]))
  with check    (app.has_tenant_role(tenant_id, array['owner','admin','manager','accountant']::app.member_role[]));


-- =====================================================================
-- FIM — FASE 1
-- =====================================================================


-- =====================================================================
-- FASE 2 — ESTOQUE: categorias, insumos, alocação por operação, movimentações
-- =====================================================================

-- ---------- 2.1 Enums -------------------------------------------------
do $$ begin
  create type app.stock_movement_kind as enum (
    'in',          -- entrada (compra, recebimento)
    'out',         -- saída (consumo, atendimento de pedido interno)
    'adjust',      -- ajuste manual (balanço, correção)
    'loss',        -- perda (quebra, descarte)
    'expiration'   -- baixa por validade
  );
exception when duplicate_object then null; end $$;


-- ---------- 2.2 Categorias de estoque --------------------------------
create table if not exists public.stock_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  color       text,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, name)
);

create index if not exists stock_categories_tenant_idx
  on public.stock_categories (tenant_id);

drop trigger if exists tg_stock_categories_updated_at on public.stock_categories;
create trigger tg_stock_categories_updated_at
  before update on public.stock_categories
  for each row execute function app.tg_set_updated_at();


-- ---------- 2.3 Insumos (stock_items) --------------------------------
-- current_qty é mantido pelo trigger de stock_movements (Fase 2.6).
-- status é coluna gerada a partir de current_qty / reorder_point.
create table if not exists public.stock_items (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  category_id     uuid references public.stock_categories(id) on delete set null,
  code            text,                         -- ex.: 'INS-0001' (opcional, livre)
  name            text not null,
  unit            text not null,                -- 'kg','un','pé','L','g','ml'
  unit_cost       numeric(12,4) not null default 0 check (unit_cost >= 0),
  current_qty     numeric(14,4) not null default 0,
  reorder_point   numeric(14,4) not null default 0 check (reorder_point >= 0),
  expiration_date date,
  notes           text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  status          text generated always as (
    case
      when current_qty <= 0                                            then 'crit'
      when reorder_point > 0 and current_qty < (reorder_point * 0.25)  then 'crit'
      when current_qty < reorder_point                                 then 'warn'
      else 'ok'
    end
  ) stored,
  unique (tenant_id, code)
);

create index if not exists stock_items_tenant_idx     on public.stock_items (tenant_id);
create index if not exists stock_items_category_idx   on public.stock_items (category_id);
create index if not exists stock_items_status_idx     on public.stock_items (tenant_id, status);
create index if not exists stock_items_active_idx     on public.stock_items (tenant_id, is_active);
create index if not exists stock_items_expiration_idx on public.stock_items (tenant_id, expiration_date);

drop trigger if exists tg_stock_items_updated_at on public.stock_items;
create trigger tg_stock_items_updated_at
  before update on public.stock_items
  for each row execute function app.tg_set_updated_at();

-- Garante que category_id pertence ao mesmo tenant do insumo
create or replace function app.tg_check_stock_item_category_tenant()
returns trigger
language plpgsql
as $$
declare
  v_cat_tenant uuid;
begin
  if new.category_id is null then
    return new;
  end if;
  select tenant_id into v_cat_tenant
    from public.stock_categories
    where id = new.category_id;
  if v_cat_tenant is null or v_cat_tenant <> new.tenant_id then
    raise exception 'stock_items.category_id pertence a outro tenant (%, esperado %)',
      v_cat_tenant, new.tenant_id;
  end if;
  return new;
end;
$$;

drop trigger if exists tg_stock_items_check_category on public.stock_items;
create trigger tg_stock_items_check_category
  before insert or update of category_id, tenant_id on public.stock_items
  for each row execute function app.tg_check_stock_item_category_tenant();


-- ---------- 2.4 Alocação por operação --------------------------------
-- Particiona a quantidade total do insumo entre as operações (marcas).
-- A soma das alocações NÃO é forçada a bater com current_qty no banco
-- (deixa folga operacional p/ planejamento), mas o frontend pode validar.
create table if not exists public.stock_allocations (
  stock_item_id uuid not null references public.stock_items(id) on delete cascade,
  operation_id  uuid not null references public.operations(id) on delete cascade,
  qty           numeric(14,4) not null default 0 check (qty >= 0),
  updated_at    timestamptz not null default now(),
  primary key (stock_item_id, operation_id)
);

create index if not exists stock_allocations_operation_idx
  on public.stock_allocations (operation_id);

drop trigger if exists tg_stock_allocations_updated_at on public.stock_allocations;
create trigger tg_stock_allocations_updated_at
  before update on public.stock_allocations
  for each row execute function app.tg_set_updated_at();

-- Garante que operation e stock_item pertencem ao mesmo tenant
create or replace function app.tg_check_stock_allocation_tenant()
returns trigger
language plpgsql
as $$
declare
  v_item_tenant uuid;
  v_op_tenant   uuid;
begin
  select tenant_id into v_item_tenant from public.stock_items where id = new.stock_item_id;
  select tenant_id into v_op_tenant   from public.operations  where id = new.operation_id;
  if v_item_tenant is null or v_op_tenant is null or v_item_tenant <> v_op_tenant then
    raise exception 'stock_allocations: tenant divergente (item=%, operation=%)',
      v_item_tenant, v_op_tenant;
  end if;
  return new;
end;
$$;

drop trigger if exists tg_stock_allocations_check_tenant on public.stock_allocations;
create trigger tg_stock_allocations_check_tenant
  before insert or update on public.stock_allocations
  for each row execute function app.tg_check_stock_allocation_tenant();


-- ---------- 2.5 Movimentações (livro-razão de estoque) --------------
-- qty é SINAL: positivo entra, negativo sai.
-- Constraints de coerência por kind:
--   in        → qty > 0
--   out, loss, expiration → qty < 0
--   adjust    → qty <> 0 (qualquer sinal)
create table if not exists public.stock_movements (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  stock_item_id   uuid not null references public.stock_items(id) on delete cascade,
  operation_id    uuid references public.operations(id) on delete set null,
  kind            app.stock_movement_kind not null,
  qty             numeric(14,4) not null check (qty <> 0),
  unit_cost       numeric(12,4),                 -- snapshot do custo no momento
  notes           text,
  reference_type  text,                          -- 'kitchen_request','purchase_order','manual','closing_count','recipe_consumption'
  reference_id    uuid,
  performed_by    uuid references auth.users(id) on delete set null,
  performed_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),

  constraint stock_movements_kind_sign_chk check (
       (kind = 'in'         and qty > 0)
    or (kind = 'out'        and qty < 0)
    or (kind = 'loss'       and qty < 0)
    or (kind = 'expiration' and qty < 0)
    or (kind = 'adjust')
  )
);

create index if not exists stock_movements_tenant_time_idx
  on public.stock_movements (tenant_id, performed_at desc);
create index if not exists stock_movements_item_time_idx
  on public.stock_movements (stock_item_id, performed_at desc);
create index if not exists stock_movements_operation_idx
  on public.stock_movements (operation_id);
create index if not exists stock_movements_reference_idx
  on public.stock_movements (reference_type, reference_id);


-- ---------- 2.6 Trigger: movimentação atualiza current_qty ----------
create or replace function app.tg_apply_stock_movement()
returns trigger
language plpgsql
as $$
declare
  v_item_tenant uuid;
  v_op_tenant   uuid;
begin
  -- Coerência de tenant (item e operação dentro do mesmo tenant da movimentação)
  select tenant_id into v_item_tenant from public.stock_items where id = new.stock_item_id;
  if v_item_tenant is null or v_item_tenant <> new.tenant_id then
    raise exception 'stock_movements.tenant_id (%) <> stock_items.tenant_id (%)',
      new.tenant_id, v_item_tenant;
  end if;

  if new.operation_id is not null then
    select tenant_id into v_op_tenant from public.operations where id = new.operation_id;
    if v_op_tenant is null or v_op_tenant <> new.tenant_id then
      raise exception 'stock_movements.operation_id pertence a outro tenant';
    end if;
  end if;

  -- Aplica delta no saldo
  update public.stock_items
     set current_qty = current_qty + new.qty
   where id = new.stock_item_id;

  -- Sobrescreve unit_cost pelo custo da última compra (NÃO média ponderada).
  -- Decisão de produto (2026-05-26): o estoque reflete o que foi pago no último
  -- recebimento, sem cálculo extra. Espelhado em widgets.jsx `applyStockMovement`.
  if new.kind = 'in' and new.unit_cost is not null and new.unit_cost > 0 and new.qty > 0 then
    update public.stock_items si
       set unit_cost = round(new.unit_cost, 4)
     where si.id = new.stock_item_id;
  end if;

  return new;
end;
$$;

drop trigger if exists tg_stock_movements_apply on public.stock_movements;
create trigger tg_stock_movements_apply
  after insert on public.stock_movements
  for each row execute function app.tg_apply_stock_movement();

-- Movimentações são imutáveis: corrigir = inserir nova movimentação inversa
create or replace function app.tg_block_stock_movement_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'stock_movements são imutáveis — registre uma nova movimentação para corrigir';
end;
$$;

drop trigger if exists tg_stock_movements_no_update on public.stock_movements;
create trigger tg_stock_movements_no_update
  before update or delete on public.stock_movements
  for each row execute function app.tg_block_stock_movement_change();


-- =====================================================================
-- FASE 2 — RLS
-- =====================================================================

alter table public.stock_categories  enable row level security;
alter table public.stock_items       enable row level security;
alter table public.stock_allocations enable row level security;
alter table public.stock_movements   enable row level security;

-- ---------- stock_categories -----------------------------------------
drop policy if exists stock_categories_select on public.stock_categories;
create policy stock_categories_select on public.stock_categories
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists stock_categories_write on public.stock_categories;
create policy stock_categories_write on public.stock_categories
  for all using (app.has_tenant_role(tenant_id,
                  array['owner','admin','manager','stock']::app.member_role[]))
  with check    (app.has_tenant_role(tenant_id,
                  array['owner','admin','manager','stock']::app.member_role[]));

-- ---------- stock_items ----------------------------------------------
drop policy if exists stock_items_select on public.stock_items;
create policy stock_items_select on public.stock_items
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists stock_items_write on public.stock_items;
create policy stock_items_write on public.stock_items
  for all using (app.has_tenant_role(tenant_id,
                  array['owner','admin','manager','stock']::app.member_role[]))
  with check    (app.has_tenant_role(tenant_id,
                  array['owner','admin','manager','stock']::app.member_role[]));

-- ---------- stock_allocations ----------------------------------------
-- Lê via tenant do stock_item; escreve com papel operacional.
drop policy if exists stock_allocations_select on public.stock_allocations;
create policy stock_allocations_select on public.stock_allocations
  for select using (
    exists (select 1 from public.stock_items si
             where si.id = stock_allocations.stock_item_id
               and app.is_tenant_member(si.tenant_id))
  );

drop policy if exists stock_allocations_write on public.stock_allocations;
create policy stock_allocations_write on public.stock_allocations
  for all using (
    exists (select 1 from public.stock_items si
             where si.id = stock_allocations.stock_item_id
               and app.has_tenant_role(si.tenant_id,
                     array['owner','admin','manager','stock']::app.member_role[]))
  )
  with check (
    exists (select 1 from public.stock_items si
             where si.id = stock_allocations.stock_item_id
               and app.has_tenant_role(si.tenant_id,
                     array['owner','admin','manager','stock']::app.member_role[]))
  );

-- ---------- stock_movements ------------------------------------------
-- Leitura ampla; INSERT por papéis operacionais; UPDATE/DELETE bloqueado por trigger.
drop policy if exists stock_movements_select on public.stock_movements;
create policy stock_movements_select on public.stock_movements
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists stock_movements_insert on public.stock_movements;
create policy stock_movements_insert on public.stock_movements
  for insert with check (
    app.has_tenant_role(tenant_id,
      array['owner','admin','manager','stock','kitchen']::app.member_role[])
  );


-- =====================================================================
-- FIM — FASE 2
-- =====================================================================


-- =====================================================================
-- FASE 3 — FICHAS TÉCNICAS: receitas e ingredientes
-- =====================================================================

-- ---------- 3.1 Tech sheets (receita / produto vendável) -------------
create table if not exists public.tech_sheets (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  operation_id    uuid not null references public.operations(id) on delete restrict,
  code            text,                          -- ex.: 'FIC-001'
  name            text not null,                 -- ex.: 'Brasa Cheddar Bacon'
  sale_price      numeric(12,2) not null default 0 check (sale_price >= 0),
  yield_qty       numeric(14,4) not null default 1 check (yield_qty > 0),
  yield_unit      text not null default 'un',
  notes           text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, code)
);

create index if not exists tech_sheets_tenant_idx     on public.tech_sheets (tenant_id);
create index if not exists tech_sheets_operation_idx  on public.tech_sheets (operation_id);
create index if not exists tech_sheets_active_idx     on public.tech_sheets (tenant_id, is_active);

drop trigger if exists tg_tech_sheets_updated_at on public.tech_sheets;
create trigger tg_tech_sheets_updated_at
  before update on public.tech_sheets
  for each row execute function app.tg_set_updated_at();

-- Garante que operation_id pertence ao mesmo tenant
create or replace function app.tg_check_tech_sheet_operation_tenant()
returns trigger
language plpgsql
as $$
declare
  v_op_tenant uuid;
begin
  select tenant_id into v_op_tenant from public.operations where id = new.operation_id;
  if v_op_tenant is null or v_op_tenant <> new.tenant_id then
    raise exception 'tech_sheets.operation_id pertence a outro tenant';
  end if;
  return new;
end;
$$;

drop trigger if exists tg_tech_sheets_check_operation on public.tech_sheets;
create trigger tg_tech_sheets_check_operation
  before insert or update of operation_id, tenant_id on public.tech_sheets
  for each row execute function app.tg_check_tech_sheet_operation_tenant();


-- ---------- 3.2 Itens da ficha técnica (ingredientes) ----------------
-- stock_item_id é PREFERIDO (vincula ao estoque); display_name fica
-- como fallback p/ casos legados ou ingredientes não rastreáveis.
create table if not exists public.tech_sheet_items (
  id             uuid primary key default gen_random_uuid(),
  tech_sheet_id  uuid not null references public.tech_sheets(id) on delete cascade,
  stock_item_id  uuid references public.stock_items(id) on delete set null,
  display_name   text not null,                 -- 'Pão brioche'
  qty            numeric(14,4) not null check (qty > 0),
  unit           text not null,                 -- 'un', 'kg', 'g', 'ml'
  unit_cost      numeric(12,4) not null default 0 check (unit_cost >= 0),
  line_cost      numeric(14,4) generated always as (qty * unit_cost) stored,
  sort_order     int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists tech_sheet_items_sheet_idx on public.tech_sheet_items (tech_sheet_id);
create index if not exists tech_sheet_items_item_idx  on public.tech_sheet_items (stock_item_id);

drop trigger if exists tg_tech_sheet_items_updated_at on public.tech_sheet_items;
create trigger tg_tech_sheet_items_updated_at
  before update on public.tech_sheet_items
  for each row execute function app.tg_set_updated_at();

-- Garante que stock_item (se vinculado) pertence ao mesmo tenant da ficha
create or replace function app.tg_check_tech_sheet_item_tenant()
returns trigger
language plpgsql
as $$
declare
  v_sheet_tenant uuid;
  v_item_tenant  uuid;
begin
  select tenant_id into v_sheet_tenant from public.tech_sheets where id = new.tech_sheet_id;
  if v_sheet_tenant is null then
    raise exception 'tech_sheet_items: ficha técnica % não encontrada', new.tech_sheet_id;
  end if;

  if new.stock_item_id is not null then
    select tenant_id into v_item_tenant from public.stock_items where id = new.stock_item_id;
    if v_item_tenant is null or v_item_tenant <> v_sheet_tenant then
      raise exception 'tech_sheet_items: stock_item pertence a outro tenant';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tg_tech_sheet_items_check_tenant on public.tech_sheet_items;
create trigger tg_tech_sheet_items_check_tenant
  before insert or update of stock_item_id, tech_sheet_id on public.tech_sheet_items
  for each row execute function app.tg_check_tech_sheet_item_tenant();


-- ---------- 3.3 View: ficha técnica com custo e CMV ------------------
create or replace view public.v_tech_sheets as
  select
    ts.id,
    ts.tenant_id,
    ts.operation_id,
    ts.code,
    ts.name,
    ts.sale_price,
    ts.yield_qty,
    ts.yield_unit,
    ts.is_active,
    coalesce(sum(tsi.line_cost), 0)                      as theoretical_cost,
    coalesce(sum(tsi.line_cost), 0) / nullif(ts.yield_qty, 0)
                                                          as cost_per_yield_unit,
    case when ts.sale_price > 0
         then round((coalesce(sum(tsi.line_cost), 0) / ts.sale_price) * 100, 2)
         else null
    end                                                   as cmv_pct,
    ts.created_at,
    ts.updated_at
  from public.tech_sheets ts
  left join public.tech_sheet_items tsi on tsi.tech_sheet_id = ts.id
  group by ts.id;


-- =====================================================================
-- FASE 3 — RLS
-- =====================================================================

alter table public.tech_sheets      enable row level security;
alter table public.tech_sheet_items enable row level security;

drop policy if exists tech_sheets_select on public.tech_sheets;
create policy tech_sheets_select on public.tech_sheets
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists tech_sheets_write on public.tech_sheets;
create policy tech_sheets_write on public.tech_sheets
  for all using (app.has_tenant_role(tenant_id,
                  array['owner','admin','manager','kitchen']::app.member_role[]))
  with check    (app.has_tenant_role(tenant_id,
                  array['owner','admin','manager','kitchen']::app.member_role[]));

drop policy if exists tech_sheet_items_select on public.tech_sheet_items;
create policy tech_sheet_items_select on public.tech_sheet_items
  for select using (
    exists (select 1 from public.tech_sheets ts
             where ts.id = tech_sheet_items.tech_sheet_id
               and app.is_tenant_member(ts.tenant_id))
  );

drop policy if exists tech_sheet_items_write on public.tech_sheet_items;
create policy tech_sheet_items_write on public.tech_sheet_items
  for all using (
    exists (select 1 from public.tech_sheets ts
             where ts.id = tech_sheet_items.tech_sheet_id
               and app.has_tenant_role(ts.tenant_id,
                     array['owner','admin','manager','kitchen']::app.member_role[]))
  )
  with check (
    exists (select 1 from public.tech_sheets ts
             where ts.id = tech_sheet_items.tech_sheet_id
               and app.has_tenant_role(ts.tenant_id,
                     array['owner','admin','manager','kitchen']::app.member_role[]))
  );


-- =====================================================================
-- FIM — FASE 3
-- =====================================================================


-- =====================================================================
-- FASE 4 — PEDIDOS INTERNOS DA COZINHA (kitchen requests)
--   Fluxo: pending → approved → separated → delivered
--   Alternativos: rejected, cancelled
--   Ao entrar em 'separated', baixa automática no estoque (out).
-- =====================================================================

-- ---------- 4.1 Enums -------------------------------------------------
do $$ begin
  create type app.kitchen_request_status as enum (
    'pending', 'approved', 'separated', 'delivered', 'rejected', 'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.kitchen_request_priority as enum ('normal', 'high', 'urgent');
exception when duplicate_object then null; end $$;


-- ---------- 4.2 Tabela principal -------------------------------------
create table if not exists public.kitchen_requests (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  operation_id      uuid not null references public.operations(id) on delete restrict,
  code              text,                                     -- 'REQ-0418'
  status            app.kitchen_request_status   not null default 'pending',
  priority          app.kitchen_request_priority not null default 'normal',

  requested_by      uuid references auth.users(id) on delete set null,
  requested_by_name text,                                     -- snapshot p/ exibição
  requested_at      timestamptz not null default now(),

  approved_by       uuid references auth.users(id) on delete set null,
  approved_at       timestamptz,
  separated_by      uuid references auth.users(id) on delete set null,
  separated_at      timestamptz,
  delivered_by      uuid references auth.users(id) on delete set null,
  delivered_at      timestamptz,

  rejection_reason  text,
  notes             text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, code)
);

create index if not exists kitchen_requests_tenant_idx
  on public.kitchen_requests (tenant_id);
create index if not exists kitchen_requests_status_idx
  on public.kitchen_requests (tenant_id, status);
create index if not exists kitchen_requests_operation_idx
  on public.kitchen_requests (operation_id);
create index if not exists kitchen_requests_requested_at_idx
  on public.kitchen_requests (tenant_id, requested_at desc);

drop trigger if exists tg_kitchen_requests_updated_at on public.kitchen_requests;
create trigger tg_kitchen_requests_updated_at
  before update on public.kitchen_requests
  for each row execute function app.tg_set_updated_at();

-- Garante operation pertence ao mesmo tenant
create or replace function app.tg_check_kitchen_request_operation_tenant()
returns trigger
language plpgsql
as $$
declare
  v_op_tenant uuid;
begin
  select tenant_id into v_op_tenant from public.operations where id = new.operation_id;
  if v_op_tenant is null or v_op_tenant <> new.tenant_id then
    raise exception 'kitchen_requests.operation_id pertence a outro tenant';
  end if;
  return new;
end;
$$;

drop trigger if exists tg_kitchen_requests_check_operation on public.kitchen_requests;
create trigger tg_kitchen_requests_check_operation
  before insert or update of operation_id, tenant_id on public.kitchen_requests
  for each row execute function app.tg_check_kitchen_request_operation_tenant();


-- ---------- 4.3 Itens do pedido --------------------------------------
create table if not exists public.kitchen_request_items (
  id                  uuid primary key default gen_random_uuid(),
  kitchen_request_id  uuid not null references public.kitchen_requests(id) on delete cascade,
  stock_item_id       uuid references public.stock_items(id) on delete set null,
  display_name        text not null,                  -- 'Muçarela'
  qty                 numeric(14,4) not null check (qty > 0),
  unit                text not null,                   -- 'kg','un','pé', etc.
  unit_cost           numeric(12,4) not null default 0 check (unit_cost >= 0),
  line_cost           numeric(14,4) generated always as (qty * unit_cost) stored,
  separated_qty       numeric(14,4),                   -- qty efetivamente separada (pode ser parcial)
  notes               text,
  sort_order          int not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists kitchen_request_items_request_idx
  on public.kitchen_request_items (kitchen_request_id);
create index if not exists kitchen_request_items_stock_idx
  on public.kitchen_request_items (stock_item_id);

drop trigger if exists tg_kitchen_request_items_updated_at on public.kitchen_request_items;
create trigger tg_kitchen_request_items_updated_at
  before update on public.kitchen_request_items
  for each row execute function app.tg_set_updated_at();

-- Coerência tenant para item linkado a stock_item
create or replace function app.tg_check_kitchen_request_item_tenant()
returns trigger
language plpgsql
as $$
declare
  v_req_tenant  uuid;
  v_item_tenant uuid;
begin
  select tenant_id into v_req_tenant from public.kitchen_requests where id = new.kitchen_request_id;
  if v_req_tenant is null then
    raise exception 'kitchen_request_items: pedido % não encontrado', new.kitchen_request_id;
  end if;
  if new.stock_item_id is not null then
    select tenant_id into v_item_tenant from public.stock_items where id = new.stock_item_id;
    if v_item_tenant is null or v_item_tenant <> v_req_tenant then
      raise exception 'kitchen_request_items: stock_item pertence a outro tenant';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tg_kitchen_request_items_check_tenant on public.kitchen_request_items;
create trigger tg_kitchen_request_items_check_tenant
  before insert or update of stock_item_id, kitchen_request_id on public.kitchen_request_items
  for each row execute function app.tg_check_kitchen_request_item_tenant();


-- ---------- 4.4 Trigger: ao 'separated' baixa estoque ---------------
-- Para cada item com stock_item_id, gera stock_movement (kind='out').
-- Usa separated_qty se preenchido, senão qty.
-- Stamp dos campos separated_at/by se ainda não estiverem preenchidos.
create or replace function app.tg_kitchen_request_apply_separation()
returns trigger
language plpgsql
as $$
declare
  r record;
  v_qty numeric(14,4);
begin
  -- Só age na transição PARA 'separated'
  if new.status <> 'separated'
     or (tg_op = 'UPDATE' and old.status = 'separated') then
    return new;
  end if;

  -- Stamp de separação se não veio
  if new.separated_at is null then new.separated_at := now(); end if;
  if new.separated_by is null then new.separated_by := auth.uid(); end if;

  -- Gera saída de estoque para cada item vinculado a stock_item
  for r in
    select id, stock_item_id, qty, separated_qty, unit_cost
      from public.kitchen_request_items
     where kitchen_request_id = new.id
       and stock_item_id is not null
  loop
    v_qty := coalesce(r.separated_qty, r.qty);
    if v_qty is null or v_qty <= 0 then
      continue;
    end if;

    insert into public.stock_movements (
      tenant_id, stock_item_id, operation_id, kind, qty, unit_cost,
      reference_type, reference_id, performed_by, performed_at, notes
    ) values (
      new.tenant_id, r.stock_item_id, new.operation_id, 'out',
      -v_qty, nullif(r.unit_cost, 0),
      'kitchen_request', new.id, coalesce(new.separated_by, auth.uid()), now(),
      'Separação do pedido ' || coalesce(new.code, new.id::text)
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists tg_kitchen_requests_separation on public.kitchen_requests;
create trigger tg_kitchen_requests_separation
  before update of status on public.kitchen_requests
  for each row execute function app.tg_kitchen_request_apply_separation();


-- ---------- 4.5 View: pedido com total -------------------------------
create or replace view public.v_kitchen_requests as
  select
    kr.*,
    coalesce(sum(kri.line_cost), 0) as total_cost,
    count(kri.id)                   as items_count
  from public.kitchen_requests kr
  left join public.kitchen_request_items kri on kri.kitchen_request_id = kr.id
  group by kr.id;


-- =====================================================================
-- FASE 4 — RLS
-- =====================================================================

alter table public.kitchen_requests       enable row level security;
alter table public.kitchen_request_items  enable row level security;

-- Leitura: qualquer membro do tenant.
drop policy if exists kitchen_requests_select on public.kitchen_requests;
create policy kitchen_requests_select on public.kitchen_requests
  for select using (app.is_tenant_member(tenant_id));

-- INSERT: cozinha, estoque, manager, admin, owner.
drop policy if exists kitchen_requests_insert on public.kitchen_requests;
create policy kitchen_requests_insert on public.kitchen_requests
  for insert with check (
    app.has_tenant_role(tenant_id,
      array['owner','admin','manager','kitchen','stock']::app.member_role[])
  );

-- UPDATE (mudanças de status, aprovação, separação): manager+, stock, admin, owner.
drop policy if exists kitchen_requests_update on public.kitchen_requests;
create policy kitchen_requests_update on public.kitchen_requests
  for update using (
    app.has_tenant_role(tenant_id,
      array['owner','admin','manager','stock','kitchen']::app.member_role[])
  )
  with check (
    app.has_tenant_role(tenant_id,
      array['owner','admin','manager','stock','kitchen']::app.member_role[])
  );

-- DELETE: somente admin/owner (idealmente cancelar ao invés de deletar).
drop policy if exists kitchen_requests_delete on public.kitchen_requests;
create policy kitchen_requests_delete on public.kitchen_requests
  for delete using (
    app.has_tenant_role(tenant_id, array['owner','admin']::app.member_role[])
  );

-- Itens: tenant via parent.
drop policy if exists kitchen_request_items_select on public.kitchen_request_items;
create policy kitchen_request_items_select on public.kitchen_request_items
  for select using (
    exists (select 1 from public.kitchen_requests kr
             where kr.id = kitchen_request_items.kitchen_request_id
               and app.is_tenant_member(kr.tenant_id))
  );

drop policy if exists kitchen_request_items_write on public.kitchen_request_items;
create policy kitchen_request_items_write on public.kitchen_request_items
  for all using (
    exists (select 1 from public.kitchen_requests kr
             where kr.id = kitchen_request_items.kitchen_request_id
               and app.has_tenant_role(kr.tenant_id,
                     array['owner','admin','manager','stock','kitchen']::app.member_role[]))
  )
  with check (
    exists (select 1 from public.kitchen_requests kr
             where kr.id = kitchen_request_items.kitchen_request_id
               and app.has_tenant_role(kr.tenant_id,
                     array['owner','admin','manager','stock','kitchen']::app.member_role[]))
  );


-- =====================================================================
-- FIM — FASE 4
-- =====================================================================


-- =====================================================================
-- FASE 5 — COMPRAS: fornecedores e pedidos de compra
--   Fluxo: draft → sent → confirmed → received
--   Ao entrar em 'received', entrada automática no estoque (in).
-- =====================================================================

-- ---------- 5.1 Enums -------------------------------------------------
do $$ begin
  create type app.purchase_order_status as enum (
    'draft', 'sent', 'confirmed', 'received', 'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.supplier_contact_channel as enum (
    'whatsapp', 'phone', 'email', 'website', 'other'
  );
exception when duplicate_object then null; end $$;


-- ---------- 5.2 Fornecedores -----------------------------------------
create table if not exists public.suppliers (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  name               text not null,
  legal_name         text,
  cnpj               text,
  contact_channel    app.supplier_contact_channel,
  contact_value      text,                              -- '11 9 8412-3304', 'vendas@...'
  lead_time_hours    int,                               -- 12, 24, 48
  notes              text,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, name)
);

create index if not exists suppliers_tenant_idx on public.suppliers (tenant_id);

drop trigger if exists tg_suppliers_updated_at on public.suppliers;
create trigger tg_suppliers_updated_at
  before update on public.suppliers
  for each row execute function app.tg_set_updated_at();


-- ---------- 5.3 Pedidos de compra ------------------------------------
create table if not exists public.purchase_orders (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete cascade,
  supplier_id              uuid not null references public.suppliers(id) on delete restrict,
  code                     text,                            -- 'PO-2026-0001'
  status                   app.purchase_order_status not null default 'draft',
  expected_delivery_date   date,

  ordered_at               timestamptz,
  ordered_by               uuid references auth.users(id) on delete set null,
  received_at              timestamptz,
  received_by              uuid references auth.users(id) on delete set null,

  invoice_number           text,                            -- 'NF 2284'
  total_override           numeric(14,2),                   -- se preferir total manual ao invés do calculado
  notes                    text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (tenant_id, code)
);

create index if not exists purchase_orders_tenant_idx
  on public.purchase_orders (tenant_id);
create index if not exists purchase_orders_supplier_idx
  on public.purchase_orders (supplier_id);
create index if not exists purchase_orders_status_idx
  on public.purchase_orders (tenant_id, status);
create index if not exists purchase_orders_received_idx
  on public.purchase_orders (tenant_id, received_at desc);

drop trigger if exists tg_purchase_orders_updated_at on public.purchase_orders;
create trigger tg_purchase_orders_updated_at
  before update on public.purchase_orders
  for each row execute function app.tg_set_updated_at();

-- Coerência tenant para supplier
create or replace function app.tg_check_purchase_order_supplier_tenant()
returns trigger
language plpgsql
as $$
declare
  v_sup_tenant uuid;
begin
  select tenant_id into v_sup_tenant from public.suppliers where id = new.supplier_id;
  if v_sup_tenant is null or v_sup_tenant <> new.tenant_id then
    raise exception 'purchase_orders.supplier_id pertence a outro tenant';
  end if;
  return new;
end;
$$;

drop trigger if exists tg_purchase_orders_check_supplier on public.purchase_orders;
create trigger tg_purchase_orders_check_supplier
  before insert or update of supplier_id, tenant_id on public.purchase_orders
  for each row execute function app.tg_check_purchase_order_supplier_tenant();


-- ---------- 5.4 Itens do pedido --------------------------------------
create table if not exists public.purchase_order_items (
  id                  uuid primary key default gen_random_uuid(),
  purchase_order_id   uuid not null references public.purchase_orders(id) on delete cascade,
  stock_item_id       uuid references public.stock_items(id) on delete set null,
  display_name        text not null,                   -- 'Tomate italiano'
  qty                 numeric(14,4) not null check (qty > 0),
  unit                text not null,                    -- 'kg','un','pé', etc.
  unit_cost           numeric(12,4) not null default 0 check (unit_cost >= 0),
  line_cost           numeric(14,4) generated always as (qty * unit_cost) stored,
  received_qty        numeric(14,4),                    -- quanto foi efetivamente recebido
  reason              text,                             -- 'Cobertura 7 dias · consumo médio 2,8 kg/dia'
  notes               text,
  sort_order          int not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists purchase_order_items_order_idx
  on public.purchase_order_items (purchase_order_id);
create index if not exists purchase_order_items_stock_idx
  on public.purchase_order_items (stock_item_id);

drop trigger if exists tg_purchase_order_items_updated_at on public.purchase_order_items;
create trigger tg_purchase_order_items_updated_at
  before update on public.purchase_order_items
  for each row execute function app.tg_set_updated_at();

-- Coerência tenant
create or replace function app.tg_check_purchase_order_item_tenant()
returns trigger
language plpgsql
as $$
declare
  v_po_tenant   uuid;
  v_item_tenant uuid;
begin
  select tenant_id into v_po_tenant from public.purchase_orders where id = new.purchase_order_id;
  if v_po_tenant is null then
    raise exception 'purchase_order_items: pedido % não encontrado', new.purchase_order_id;
  end if;
  if new.stock_item_id is not null then
    select tenant_id into v_item_tenant from public.stock_items where id = new.stock_item_id;
    if v_item_tenant is null or v_item_tenant <> v_po_tenant then
      raise exception 'purchase_order_items: stock_item pertence a outro tenant';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tg_purchase_order_items_check_tenant on public.purchase_order_items;
create trigger tg_purchase_order_items_check_tenant
  before insert or update of stock_item_id, purchase_order_id on public.purchase_order_items
  for each row execute function app.tg_check_purchase_order_item_tenant();


-- ---------- 5.5 Trigger: ao 'received' gera entrada de estoque ------
create or replace function app.tg_purchase_order_apply_receipt()
returns trigger
language plpgsql
as $$
declare
  r record;
  v_qty numeric(14,4);
begin
  if new.status <> 'received'
     or (tg_op = 'UPDATE' and old.status = 'received') then
    return new;
  end if;

  if new.received_at is null then new.received_at := now(); end if;
  if new.received_by is null then new.received_by := auth.uid(); end if;

  for r in
    select id, stock_item_id, qty, received_qty, unit_cost
      from public.purchase_order_items
     where purchase_order_id = new.id
       and stock_item_id is not null
  loop
    v_qty := coalesce(r.received_qty, r.qty);
    if v_qty is null or v_qty <= 0 then
      continue;
    end if;

    insert into public.stock_movements (
      tenant_id, stock_item_id, operation_id, kind, qty, unit_cost,
      reference_type, reference_id, performed_by, performed_at, notes
    ) values (
      new.tenant_id, r.stock_item_id, null, 'in',
      v_qty, nullif(r.unit_cost, 0),
      'purchase_order', new.id, coalesce(new.received_by, auth.uid()), now(),
      'Recebimento do pedido ' || coalesce(new.code, new.id::text)
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists tg_purchase_orders_receipt on public.purchase_orders;
create trigger tg_purchase_orders_receipt
  before update of status on public.purchase_orders
  for each row execute function app.tg_purchase_order_apply_receipt();


-- ---------- 5.6 View: pedido com total -------------------------------
create or replace view public.v_purchase_orders as
  select
    po.*,
    coalesce(po.total_override, sum(poi.line_cost), 0) as total,
    count(poi.id)                                       as items_count
  from public.purchase_orders po
  left join public.purchase_order_items poi on poi.purchase_order_id = po.id
  group by po.id;


-- =====================================================================
-- FASE 5 — RLS
-- =====================================================================

alter table public.suppliers             enable row level security;
alter table public.purchase_orders       enable row level security;
alter table public.purchase_order_items  enable row level security;

-- ---------- suppliers ------------------------------------------------
drop policy if exists suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists suppliers_write on public.suppliers;
create policy suppliers_write on public.suppliers
  for all using (app.has_tenant_role(tenant_id,
                  array['owner','admin','manager','stock']::app.member_role[]))
  with check    (app.has_tenant_role(tenant_id,
                  array['owner','admin','manager','stock']::app.member_role[]));

-- ---------- purchase_orders -----------------------------------------
drop policy if exists purchase_orders_select on public.purchase_orders;
create policy purchase_orders_select on public.purchase_orders
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists purchase_orders_write on public.purchase_orders;
create policy purchase_orders_write on public.purchase_orders
  for all using (app.has_tenant_role(tenant_id,
                  array['owner','admin','manager','stock']::app.member_role[]))
  with check    (app.has_tenant_role(tenant_id,
                  array['owner','admin','manager','stock']::app.member_role[]));

-- ---------- purchase_order_items -------------------------------------
drop policy if exists purchase_order_items_select on public.purchase_order_items;
create policy purchase_order_items_select on public.purchase_order_items
  for select using (
    exists (select 1 from public.purchase_orders po
             where po.id = purchase_order_items.purchase_order_id
               and app.is_tenant_member(po.tenant_id))
  );

drop policy if exists purchase_order_items_write on public.purchase_order_items;
create policy purchase_order_items_write on public.purchase_order_items
  for all using (
    exists (select 1 from public.purchase_orders po
             where po.id = purchase_order_items.purchase_order_id
               and app.has_tenant_role(po.tenant_id,
                     array['owner','admin','manager','stock']::app.member_role[]))
  )
  with check (
    exists (select 1 from public.purchase_orders po
             where po.id = purchase_order_items.purchase_order_id
               and app.has_tenant_role(po.tenant_id,
                     array['owner','admin','manager','stock']::app.member_role[]))
  );


-- =====================================================================
-- FIM — FASE 5
-- =====================================================================


-- =====================================================================
-- FASE 5.5 — RECEBIMENTOS DE MERCADORIA (entrada física × pedido)
--   Separação clara:
--     purchase_orders   → o pedido (imutável após enviado)
--     goods_receipts    → entrada física no estoque (vários por PO)
--     receipt_items     → itens recebidos com qty_ordered + qty_received,
--                         flag de divergência e motivo (auditoria)
--   Ao confirmar um receipt, gera stock_movements (kind='in') automaticamente.
-- =====================================================================

-- ---------- 5.5.1 Enums ----------------------------------------------
do $$ begin
  create type app.goods_receipt_status as enum (
    'draft', 'confirmed', 'cancelled'
  );
exception when duplicate_object then null; end $$;


-- ---------- 5.5.2 Recebimentos ---------------------------------------
create table if not exists public.goods_receipts (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  purchase_order_id   uuid not null references public.purchase_orders(id) on delete restrict,
  supplier_id         uuid not null references public.suppliers(id) on delete restrict,
  code                text,                                  -- 'REC-0001'
  status              app.goods_receipt_status not null default 'draft',
  nf_number           text,
  notes               text,
  received_at         timestamptz not null default now(),
  received_by         uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, code)
);

create index if not exists goods_receipts_tenant_idx
  on public.goods_receipts (tenant_id, received_at desc);
create index if not exists goods_receipts_po_idx
  on public.goods_receipts (purchase_order_id);
create index if not exists goods_receipts_supplier_idx
  on public.goods_receipts (supplier_id);

drop trigger if exists tg_goods_receipts_updated_at on public.goods_receipts;
create trigger tg_goods_receipts_updated_at
  before update on public.goods_receipts
  for each row execute function app.tg_set_updated_at();

-- Coerência tenant: PO e supplier do mesmo tenant
create or replace function app.tg_check_goods_receipt_tenant()
returns trigger
language plpgsql
as $$
declare
  v_po_tenant  uuid;
  v_sup_tenant uuid;
begin
  select tenant_id into v_po_tenant from public.purchase_orders where id = new.purchase_order_id;
  select tenant_id into v_sup_tenant from public.suppliers where id = new.supplier_id;
  if v_po_tenant is null or v_po_tenant <> new.tenant_id then
    raise exception 'goods_receipts.purchase_order_id pertence a outro tenant';
  end if;
  if v_sup_tenant is null or v_sup_tenant <> new.tenant_id then
    raise exception 'goods_receipts.supplier_id pertence a outro tenant';
  end if;
  return new;
end;
$$;

drop trigger if exists tg_goods_receipts_check_tenant on public.goods_receipts;
create trigger tg_goods_receipts_check_tenant
  before insert or update on public.goods_receipts
  for each row execute function app.tg_check_goods_receipt_tenant();


-- ---------- 5.5.3 Itens do recebimento -------------------------------
-- qty_ordered = snapshot da qty pedida (do purchase_order_item)
-- qty_received = qty efetivamente recebida (pode ser menor/maior/zero)
-- Itens com purchase_order_item_id = null são manuais (recebidos sem pedido).
create table if not exists public.goods_receipt_items (
  id                       uuid primary key default gen_random_uuid(),
  goods_receipt_id         uuid not null references public.goods_receipts(id) on delete cascade,
  purchase_order_item_id   uuid references public.purchase_order_items(id) on delete set null,
  stock_item_id            uuid references public.stock_items(id) on delete set null,
  display_name             text not null,
  unit                     text not null,
  qty_ordered              numeric(14,4) not null default 0,
  qty_received             numeric(14,4) not null default 0 check (qty_received >= 0),
  unit_cost                numeric(12,4) not null default 0 check (unit_cost >= 0),
  line_cost                numeric(14,4) generated always as (qty_received * unit_cost) stored,
  divergent                boolean not null default false,
  divergence_reason        text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists goods_receipt_items_receipt_idx
  on public.goods_receipt_items (goods_receipt_id);
create index if not exists goods_receipt_items_po_item_idx
  on public.goods_receipt_items (purchase_order_item_id);
create index if not exists goods_receipt_items_stock_idx
  on public.goods_receipt_items (stock_item_id);

drop trigger if exists tg_goods_receipt_items_updated_at on public.goods_receipt_items;
create trigger tg_goods_receipt_items_updated_at
  before update on public.goods_receipt_items
  for each row execute function app.tg_set_updated_at();


-- ---------- 5.5.4 Trigger: ao 'confirmed' gera entrada de estoque ----
-- Substitui o fluxo legado de gerar entrada na hora do PO.received.
-- Aqui o "received" do PO continua válido para casos sem GR; mas a
-- cadeia preferida agora é PO → GR(s) → stock_movements (in).
create or replace function app.tg_goods_receipt_apply()
returns trigger
language plpgsql
as $$
declare
  r record;
begin
  if new.status <> 'confirmed'
     or (tg_op = 'UPDATE' and old.status = 'confirmed') then
    return new;
  end if;

  for r in
    select id, stock_item_id, qty_received, unit_cost, display_name
      from public.goods_receipt_items
     where goods_receipt_id = new.id
       and stock_item_id is not null
       and qty_received > 0
  loop
    insert into public.stock_movements (
      tenant_id, stock_item_id, operation_id, kind, qty, unit_cost,
      reference_type, reference_id, performed_by, performed_at, notes
    ) values (
      new.tenant_id, r.stock_item_id, null, 'in',
      r.qty_received, nullif(r.unit_cost, 0),
      'goods_receipt', new.id, coalesce(new.received_by, auth.uid()), new.received_at,
      'Recebimento ' || coalesce(new.code, new.id::text)
       || coalesce(' · NF ' || nullif(new.nf_number, ''), '')
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists tg_goods_receipts_apply on public.goods_receipts;
create trigger tg_goods_receipts_apply
  before update of status on public.goods_receipts
  for each row execute function app.tg_goods_receipt_apply();


-- ---------- 5.5.5 View: pedido com status agregado de recebimento ----
-- Calcula, por PO, quanto já foi recebido (somando qty_received de
-- todos os GRs confirmados). Útil pra UI mostrar "parcial / completo".
create or replace view public.v_purchase_orders_receipts as
  with received as (
    select
      gr.tenant_id,
      gr.purchase_order_id,
      gri.purchase_order_item_id,
      sum(gri.qty_received) filter (where gr.status = 'confirmed') as qty_received
    from public.goods_receipts gr
    join public.goods_receipt_items gri on gri.goods_receipt_id = gr.id
    where gri.purchase_order_item_id is not null
    group by gr.tenant_id, gr.purchase_order_id, gri.purchase_order_item_id
  ),
  per_po as (
    select
      po.id as purchase_order_id,
      po.tenant_id,
      bool_and(coalesce(rec.qty_received, 0) >= poi.qty) as fully_received,
      bool_or(coalesce(rec.qty_received, 0) > 0) as has_received
    from public.purchase_orders po
    join public.purchase_order_items poi on poi.purchase_order_id = po.id
    left join received rec on rec.purchase_order_item_id = poi.id
    group by po.id, po.tenant_id
  )
  select
    po.*,
    case
      when ppo.fully_received then 'received'
      when ppo.has_received   then 'partial'
      else po.status::text
    end as receipt_status
  from public.purchase_orders po
  left join per_po ppo on ppo.purchase_order_id = po.id;


-- =====================================================================
-- FASE 5.5 — RLS
-- =====================================================================

alter table public.goods_receipts       enable row level security;
alter table public.goods_receipt_items  enable row level security;

drop policy if exists goods_receipts_select on public.goods_receipts;
create policy goods_receipts_select on public.goods_receipts
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists goods_receipts_write on public.goods_receipts;
create policy goods_receipts_write on public.goods_receipts
  for all using (app.has_tenant_role(tenant_id,
                  array['owner','admin','manager','stock']::app.member_role[]))
  with check    (app.has_tenant_role(tenant_id,
                  array['owner','admin','manager','stock']::app.member_role[]));

drop policy if exists goods_receipt_items_select on public.goods_receipt_items;
create policy goods_receipt_items_select on public.goods_receipt_items
  for select using (
    exists (select 1 from public.goods_receipts gr
             where gr.id = goods_receipt_items.goods_receipt_id
               and app.is_tenant_member(gr.tenant_id))
  );

drop policy if exists goods_receipt_items_write on public.goods_receipt_items;
create policy goods_receipt_items_write on public.goods_receipt_items
  for all using (
    exists (select 1 from public.goods_receipts gr
             where gr.id = goods_receipt_items.goods_receipt_id
               and app.has_tenant_role(gr.tenant_id,
                     array['owner','admin','manager','stock']::app.member_role[]))
  )
  with check (
    exists (select 1 from public.goods_receipts gr
             where gr.id = goods_receipt_items.goods_receipt_id
               and app.has_tenant_role(gr.tenant_id,
                     array['owner','admin','manager','stock']::app.member_role[]))
  );


-- =====================================================================
-- FIM — FASE 5.5
-- =====================================================================


-- =====================================================================
-- FASE 6 — FATURAMENTO: receitas dia × operação com breakdown por método
-- =====================================================================

-- ---------- 6.1 Enums -------------------------------------------------
do $$ begin
  create type app.revenue_source as enum (
    'ifood', 'rappi', 'pdv', 'balcao', 'manual', 'outro'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.revenue_status as enum ('pending', 'confirmed');
exception when duplicate_object then null; end $$;


-- ---------- 6.2 Lançamentos de receita (1 por dia × operação × fonte)
create table if not exists public.revenue_entries (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  operation_id    uuid not null references public.operations(id) on delete restrict,
  business_date   date not null,
  source          app.revenue_source not null default 'balcao',
  orders_count    int  not null default 0 check (orders_count >= 0),
  cogs            numeric(14,2) not null default 0 check (cogs >= 0),
  status          app.revenue_status not null default 'pending',
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, operation_id, business_date, source)
);

create index if not exists revenue_entries_tenant_date_idx
  on public.revenue_entries (tenant_id, business_date desc);
create index if not exists revenue_entries_operation_date_idx
  on public.revenue_entries (operation_id, business_date desc);
create index if not exists revenue_entries_status_idx
  on public.revenue_entries (tenant_id, status);

drop trigger if exists tg_revenue_entries_updated_at on public.revenue_entries;
create trigger tg_revenue_entries_updated_at
  before update on public.revenue_entries
  for each row execute function app.tg_set_updated_at();

create or replace function app.tg_check_revenue_entry_operation_tenant()
returns trigger
language plpgsql
as $$
declare
  v_op_tenant uuid;
begin
  select tenant_id into v_op_tenant from public.operations where id = new.operation_id;
  if v_op_tenant is null or v_op_tenant <> new.tenant_id then
    raise exception 'revenue_entries.operation_id pertence a outro tenant';
  end if;
  return new;
end;
$$;

drop trigger if exists tg_revenue_entries_check_operation on public.revenue_entries;
create trigger tg_revenue_entries_check_operation
  before insert or update of operation_id, tenant_id on public.revenue_entries
  for each row execute function app.tg_check_revenue_entry_operation_tenant();


-- ---------- 6.3 Breakdown por método de pagamento --------------------
create table if not exists public.revenue_payment_breakdown (
  revenue_entry_id   uuid not null references public.revenue_entries(id) on delete cascade,
  payment_method_id  uuid not null references public.payment_methods(id) on delete restrict,
  amount             numeric(14,2) not null default 0 check (amount >= 0),
  updated_at         timestamptz not null default now(),
  primary key (revenue_entry_id, payment_method_id)
);

create index if not exists revenue_payment_breakdown_method_idx
  on public.revenue_payment_breakdown (payment_method_id);

drop trigger if exists tg_revenue_payment_breakdown_updated_at on public.revenue_payment_breakdown;
create trigger tg_revenue_payment_breakdown_updated_at
  before update on public.revenue_payment_breakdown
  for each row execute function app.tg_set_updated_at();

-- Coerência tenant
create or replace function app.tg_check_revenue_breakdown_tenant()
returns trigger
language plpgsql
as $$
declare
  v_re_tenant uuid;
  v_pm_tenant uuid;
begin
  select tenant_id into v_re_tenant from public.revenue_entries where id = new.revenue_entry_id;
  select tenant_id into v_pm_tenant from public.payment_methods where id = new.payment_method_id;
  if v_re_tenant is null or v_pm_tenant is null or v_re_tenant <> v_pm_tenant then
    raise exception 'revenue_payment_breakdown: tenant divergente';
  end if;
  return new;
end;
$$;

drop trigger if exists tg_revenue_breakdown_check_tenant on public.revenue_payment_breakdown;
create trigger tg_revenue_breakdown_check_tenant
  before insert or update on public.revenue_payment_breakdown
  for each row execute function app.tg_check_revenue_breakdown_tenant();


-- ---------- 6.4 View: receita consolidada com totais ----------------
create or replace view public.v_revenue_entries as
  select
    re.id,
    re.tenant_id,
    re.operation_id,
    re.business_date,
    re.source,
    re.status,
    re.orders_count,
    re.cogs,
    coalesce(sum(rpb.amount), 0)                            as gross_revenue,
    case when re.orders_count > 0
         then round(coalesce(sum(rpb.amount), 0) / re.orders_count, 2)
         else null
    end                                                      as avg_ticket,
    case when coalesce(sum(rpb.amount), 0) > 0
         then round((re.cogs / sum(rpb.amount)) * 100, 2)
         else null
    end                                                      as cmv_pct,
    re.notes,
    re.created_at,
    re.updated_at
  from public.revenue_entries re
  left join public.revenue_payment_breakdown rpb on rpb.revenue_entry_id = re.id
  group by re.id;


-- =====================================================================
-- FASE 6 — RLS
-- =====================================================================

alter table public.revenue_entries            enable row level security;
alter table public.revenue_payment_breakdown  enable row level security;

drop policy if exists revenue_entries_select on public.revenue_entries;
create policy revenue_entries_select on public.revenue_entries
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists revenue_entries_write on public.revenue_entries;
create policy revenue_entries_write on public.revenue_entries
  for all using (app.has_tenant_role(tenant_id,
                  array['owner','admin','manager','accountant']::app.member_role[]))
  with check    (app.has_tenant_role(tenant_id,
                  array['owner','admin','manager','accountant']::app.member_role[]));

drop policy if exists revenue_payment_breakdown_select on public.revenue_payment_breakdown;
create policy revenue_payment_breakdown_select on public.revenue_payment_breakdown
  for select using (
    exists (select 1 from public.revenue_entries re
             where re.id = revenue_payment_breakdown.revenue_entry_id
               and app.is_tenant_member(re.tenant_id))
  );

drop policy if exists revenue_payment_breakdown_write on public.revenue_payment_breakdown;
create policy revenue_payment_breakdown_write on public.revenue_payment_breakdown
  for all using (
    exists (select 1 from public.revenue_entries re
             where re.id = revenue_payment_breakdown.revenue_entry_id
               and app.has_tenant_role(re.tenant_id,
                     array['owner','admin','manager','accountant']::app.member_role[]))
  )
  with check (
    exists (select 1 from public.revenue_entries re
             where re.id = revenue_payment_breakdown.revenue_entry_id
               and app.has_tenant_role(re.tenant_id,
                     array['owner','admin','manager','accountant']::app.member_role[]))
  );


-- =====================================================================
-- FIM — FASE 6
-- =====================================================================


-- =====================================================================
-- FASE 7 — FINANCEIRO / DRE: grupos, categorias, lançamentos, checklist
-- =====================================================================

-- ---------- 7.1 Enums -------------------------------------------------
do $$ begin
  create type app.dre_sign as enum ('+', '-');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.financial_entry_status as enum (
    'paid', 'pending', 'scheduled', 'overdue', 'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.checklist_recurrence as enum (
    'monthly', 'biweekly', 'weekly', 'variable'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.checklist_status as enum ('pending', 'estimated', 'filled');
exception when duplicate_object then null; end $$;


-- ---------- 7.2 Grupos da DRE (por tenant; seed no onboarding) -------
create table if not exists public.dre_groups (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  slug         citext not null,           -- 'receita','deducoes','cmv', ...
  label        text   not null,
  sign         app.dre_sign not null,
  sort_order   int    not null default 0,
  is_subtotal  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, slug)
);

create index if not exists dre_groups_tenant_idx on public.dre_groups (tenant_id);

drop trigger if exists tg_dre_groups_updated_at on public.dre_groups;
create trigger tg_dre_groups_updated_at
  before update on public.dre_groups
  for each row execute function app.tg_set_updated_at();


-- ---------- 7.3 Categorias da DRE -----------------------------------
create table if not exists public.dre_categories (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  group_id     uuid not null references public.dre_groups(id) on delete restrict,
  code         text,                       -- 'cat-01' (legacy/external)
  name         text not null,              -- 'Comissão iFood (23%)'
  color        text,
  is_default   boolean not null default false,
  is_active    boolean not null default true,
  sort_order   int     not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, code)
);

create index if not exists dre_categories_tenant_idx on public.dre_categories (tenant_id);
create index if not exists dre_categories_group_idx  on public.dre_categories (group_id);

drop trigger if exists tg_dre_categories_updated_at on public.dre_categories;
create trigger tg_dre_categories_updated_at
  before update on public.dre_categories
  for each row execute function app.tg_set_updated_at();

-- Coerência tenant
create or replace function app.tg_check_dre_category_group_tenant()
returns trigger
language plpgsql
as $$
declare
  v_g_tenant uuid;
begin
  select tenant_id into v_g_tenant from public.dre_groups where id = new.group_id;
  if v_g_tenant is null or v_g_tenant <> new.tenant_id then
    raise exception 'dre_categories.group_id pertence a outro tenant';
  end if;
  return new;
end;
$$;

drop trigger if exists tg_dre_categories_check_group on public.dre_categories;
create trigger tg_dre_categories_check_group
  before insert or update of group_id, tenant_id on public.dre_categories
  for each row execute function app.tg_check_dre_category_group_tenant();


-- ---------- 7.4 Checklist de fechamento ------------------------------
create table if not exists public.closing_checklist_items (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  category_id     uuid not null references public.dre_categories(id) on delete restrict,
  code            text,                                -- 'chk-r01'
  label           text not null,
  recurrence      app.checklist_recurrence not null default 'monthly',
  due_day         int,                                 -- dia do mês (1..31), null se variável
  owner_role      text,                                -- 'Rafa','Contador','Estoquista'
  expected_amount numeric(14,2),
  is_required     boolean not null default true,
  source          text,                                -- 'Integração iFood','Guia DAS', ...
  formula         text,                                -- '≈ 23% das vendas iFood'
  is_active       boolean not null default true,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, code)
);

create index if not exists closing_checklist_tenant_idx
  on public.closing_checklist_items (tenant_id);
create index if not exists closing_checklist_category_idx
  on public.closing_checklist_items (category_id);

drop trigger if exists tg_closing_checklist_updated_at on public.closing_checklist_items;
create trigger tg_closing_checklist_updated_at
  before update on public.closing_checklist_items
  for each row execute function app.tg_set_updated_at();


-- ---------- 7.5 Lançamentos financeiros ------------------------------
-- operation_id NULL = lançamento consolidado (não atribuído a uma marca).
-- direction é derivado do sign do grupo (calcule no app ou via view).
create table if not exists public.financial_entries (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  category_id       uuid not null references public.dre_categories(id) on delete restrict,
  operation_id      uuid references public.operations(id) on delete set null,
  checklist_item_id uuid references public.closing_checklist_items(id) on delete set null,
  code              text,                                  -- 'LAN-1010'
  description       text not null,
  amount            numeric(14,2) not null check (amount >= 0),
  competence_date   date not null,                         -- data da competência
  due_date          date,                                  -- vencimento
  paid_date         date,                                  -- data efetiva de pagamento
  status            app.financial_entry_status not null default 'pending',
  payment_method_id uuid references public.payment_methods(id) on delete set null,
  reference_type    text,                                  -- 'purchase_order','revenue_entry','manual'
  reference_id      uuid,
  notes             text,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, code)
);

create index if not exists financial_entries_tenant_comp_idx
  on public.financial_entries (tenant_id, competence_date desc);
create index if not exists financial_entries_category_idx
  on public.financial_entries (category_id);
create index if not exists financial_entries_status_idx
  on public.financial_entries (tenant_id, status);
create index if not exists financial_entries_operation_idx
  on public.financial_entries (operation_id);
create index if not exists financial_entries_checklist_idx
  on public.financial_entries (checklist_item_id);
create index if not exists financial_entries_reference_idx
  on public.financial_entries (reference_type, reference_id);

drop trigger if exists tg_financial_entries_updated_at on public.financial_entries;
create trigger tg_financial_entries_updated_at
  before update on public.financial_entries
  for each row execute function app.tg_set_updated_at();

-- Coerência tenant para FKs
create or replace function app.tg_check_financial_entry_fks()
returns trigger
language plpgsql
as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from public.dre_categories where id = new.category_id;
  if v_tenant is null or v_tenant <> new.tenant_id then
    raise exception 'financial_entries.category_id pertence a outro tenant';
  end if;

  if new.operation_id is not null then
    select tenant_id into v_tenant from public.operations where id = new.operation_id;
    if v_tenant is null or v_tenant <> new.tenant_id then
      raise exception 'financial_entries.operation_id pertence a outro tenant';
    end if;
  end if;

  if new.checklist_item_id is not null then
    select tenant_id into v_tenant from public.closing_checklist_items where id = new.checklist_item_id;
    if v_tenant is null or v_tenant <> new.tenant_id then
      raise exception 'financial_entries.checklist_item_id pertence a outro tenant';
    end if;
  end if;

  if new.payment_method_id is not null then
    select tenant_id into v_tenant from public.payment_methods where id = new.payment_method_id;
    if v_tenant is null or v_tenant <> new.tenant_id then
      raise exception 'financial_entries.payment_method_id pertence a outro tenant';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists tg_financial_entries_check_fks on public.financial_entries;
create trigger tg_financial_entries_check_fks
  before insert or update on public.financial_entries
  for each row execute function app.tg_check_financial_entry_fks();


-- ---------- 7.6 Seed da DRE no onboarding ----------------------------
-- Recria create_tenant_with_owner para também popular DRE padrão.
create or replace function public.create_tenant_with_owner(
  p_slug text,
  p_name text
) returns uuid
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_uid     uuid := auth.uid();
  v_tenant  uuid;
  v_g_receita     uuid;
  v_g_deducoes    uuid;
  v_g_cmv         uuid;
  v_g_pessoal     uuid;
  v_g_ocupacao    uuid;
  v_g_marketing   uuid;
  v_g_operacional uuid;
  v_g_financeiro  uuid;
  v_g_outras      uuid;
begin
  if v_uid is null then
    raise exception 'auth.uid() is null — usuário não autenticado';
  end if;

  insert into public.tenants (slug, name)
  values (lower(p_slug), p_name)
  returning id into v_tenant;

  insert into public.tenant_members (tenant_id, user_id, role)
  values (v_tenant, v_uid, 'owner');

  -- Métodos de pagamento padrão
  insert into public.payment_methods (tenant_id, slug, label, short_label, color, sort_order) values
    (v_tenant, 'debito',   'Débito',   'Déb',  '#3d6cb0', 1),
    (v_tenant, 'credito',  'Crédito',  'Créd', '#6b5fb0', 2),
    (v_tenant, 'voucher',  'Voucher',  'Vchr', '#c2843a', 3),
    (v_tenant, 'dinheiro', 'Dinheiro', 'Din',  '#2d8c66', 4),
    (v_tenant, 'pix',      'Pix',      'Pix',  '#1aa39e', 5),
    (v_tenant, 'online',   'Online',   'Onl',  '#b04545', 6);

  -- Grupos DRE
  insert into public.dre_groups (tenant_id, slug, label, sign, sort_order) values
    (v_tenant, 'receita',     'Receita bruta',                 '+', 1),
    (v_tenant, 'deducoes',    '(−) Deduções e taxas',          '-', 2),
    (v_tenant, 'cmv',         '(−) CMV (compras de insumos)',  '-', 3),
    (v_tenant, 'pessoal',     '(−) Pessoal',                   '-', 4),
    (v_tenant, 'ocupacao',    '(−) Ocupação',                  '-', 5),
    (v_tenant, 'marketing',   '(−) Marketing',                 '-', 6),
    (v_tenant, 'operacional', '(−) Operacional',               '-', 7),
    (v_tenant, 'financeiro',  '(−) Financeiro',                '-', 8),
    (v_tenant, 'outras',      '(−) Outras despesas',           '-', 9);

  select id into v_g_receita     from public.dre_groups where tenant_id = v_tenant and slug = 'receita';
  select id into v_g_deducoes    from public.dre_groups where tenant_id = v_tenant and slug = 'deducoes';
  select id into v_g_cmv         from public.dre_groups where tenant_id = v_tenant and slug = 'cmv';
  select id into v_g_pessoal     from public.dre_groups where tenant_id = v_tenant and slug = 'pessoal';
  select id into v_g_ocupacao    from public.dre_groups where tenant_id = v_tenant and slug = 'ocupacao';
  select id into v_g_marketing   from public.dre_groups where tenant_id = v_tenant and slug = 'marketing';
  select id into v_g_operacional from public.dre_groups where tenant_id = v_tenant and slug = 'operacional';
  select id into v_g_financeiro  from public.dre_groups where tenant_id = v_tenant and slug = 'financeiro';
  select id into v_g_outras      from public.dre_groups where tenant_id = v_tenant and slug = 'outras';

  -- Categorias DRE padrão
  insert into public.dre_categories (tenant_id, group_id, code, name, color, is_default, sort_order) values
    (v_tenant, v_g_receita,     'cat-01', 'Vendas iFood',            '#b04545', true, 1),
    (v_tenant, v_g_receita,     'cat-02', 'Vendas Rappi',            '#c2843a', true, 2),
    (v_tenant, v_g_receita,     'cat-03', 'Vendas balcão',           '#2d8c66', true, 3),

    (v_tenant, v_g_deducoes,    'cat-10', 'Comissão iFood',          '#b04545', true, 1),
    (v_tenant, v_g_deducoes,    'cat-11', 'Comissão Rappi',          '#c2843a', true, 2),
    (v_tenant, v_g_deducoes,    'cat-12', 'Impostos (Simples)',      '#8a9098', true, 3),
    (v_tenant, v_g_deducoes,    'cat-13', 'Taxa cartão balcão',      '#8a9098', true, 4),

    (v_tenant, v_g_cmv,         'cat-20', 'Compras hortifruti',      '#2d8c66', true, 1),
    (v_tenant, v_g_cmv,         'cat-21', 'Compras carnes',          '#b04545', true, 2),
    (v_tenant, v_g_cmv,         'cat-22', 'Compras laticínios',      '#c2843a', true, 3),
    (v_tenant, v_g_cmv,         'cat-23', 'Compras embalagens',      '#8a9098', true, 4),
    (v_tenant, v_g_cmv,         'cat-24', 'Compras secos/mercearia', '#6b5fb0', true, 5),

    (v_tenant, v_g_pessoal,     'cat-30', 'Salários cozinha',        '#3d6cb0', true, 1),
    (v_tenant, v_g_pessoal,     'cat-31', 'Encargos (INSS/FGTS)',    '#3d6cb0', true, 2),
    (v_tenant, v_g_pessoal,     'cat-32', 'Vale transporte/refeição','#3d6cb0', true, 3),
    (v_tenant, v_g_pessoal,     'cat-33', 'Pró-labore',              '#3d6cb0', true, 4),

    (v_tenant, v_g_ocupacao,    'cat-40', 'Aluguel cozinha',         '#6b5fb0', true, 1),
    (v_tenant, v_g_ocupacao,    'cat-41', 'Energia elétrica',        '#c2843a', true, 2),
    (v_tenant, v_g_ocupacao,    'cat-42', 'Água e gás',              '#3d6cb0', true, 3),
    (v_tenant, v_g_ocupacao,    'cat-43', 'Internet',                '#8a9098', true, 4),

    (v_tenant, v_g_marketing,   'cat-50', 'Mídia paga iFood',        '#b04545', true, 1),
    (v_tenant, v_g_marketing,   'cat-51', 'Mídia paga Instagram',    '#c2843a', true, 2),

    (v_tenant, v_g_operacional, 'cat-60', 'Limpeza e descartáveis',  '#8a9098', true, 1),
    (v_tenant, v_g_operacional, 'cat-61', 'Manutenção equipamentos', '#8a9098', true, 2),
    (v_tenant, v_g_operacional, 'cat-62', 'Software e SaaS',         '#8a9098', true, 3),

    (v_tenant, v_g_financeiro,  'cat-70', 'Tarifas bancárias',       '#8a9098', true, 1),
    (v_tenant, v_g_financeiro,  'cat-71', 'Juros empréstimos',       '#b04545', true, 2);

  return v_tenant;
end;
$$;


-- ---------- 7.7 View: checklist com status real --------------------
create or replace view public.v_closing_checklist as
  select
    cli.id,
    cli.tenant_id,
    cli.category_id,
    cli.code,
    cli.label,
    cli.recurrence,
    cli.due_day,
    cli.owner_role,
    cli.expected_amount,
    cli.is_required,
    cli.source,
    cli.formula,
    cli.is_active,
    cli.sort_order,
    coalesce(sum(fe.amount), 0)         as actual_amount,
    count(fe.id)                         as entries_count,
    case
      when count(fe.id) > 0 then 'filled'::app.checklist_status
      when cli.expected_amount is not null
           and cli.expected_amount > 0  then 'estimated'::app.checklist_status
      else 'pending'::app.checklist_status
    end                                  as derived_status,
    cli.created_at,
    cli.updated_at
  from public.closing_checklist_items cli
  left join public.financial_entries fe on fe.checklist_item_id = cli.id
  group by cli.id;


-- ---------- 7.8 View: DRE consolidada do mês ------------------------
create or replace view public.v_dre_monthly as
  select
    dg.tenant_id,
    date_trunc('month', fe.competence_date)::date as competence_month,
    dg.id        as group_id,
    dg.slug      as group_slug,
    dg.label     as group_label,
    dg.sign      as group_sign,
    dg.sort_order,
    sum(fe.amount) as amount
  from public.financial_entries fe
  join public.dre_categories dc on dc.id = fe.category_id
  join public.dre_groups     dg on dg.id = dc.group_id
  where fe.status <> 'cancelled'
  group by dg.tenant_id, date_trunc('month', fe.competence_date), dg.id, dg.slug, dg.label, dg.sign, dg.sort_order
  order by competence_month desc, dg.sort_order;


-- =====================================================================
-- FASE 7 — RLS
-- =====================================================================

alter table public.dre_groups               enable row level security;
alter table public.dre_categories           enable row level security;
alter table public.closing_checklist_items  enable row level security;
alter table public.financial_entries        enable row level security;

drop policy if exists dre_groups_select on public.dre_groups;
create policy dre_groups_select on public.dre_groups
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists dre_groups_write on public.dre_groups;
create policy dre_groups_write on public.dre_groups
  for all using (app.has_tenant_role(tenant_id,
                  array['owner','admin','accountant']::app.member_role[]))
  with check    (app.has_tenant_role(tenant_id,
                  array['owner','admin','accountant']::app.member_role[]));

drop policy if exists dre_categories_select on public.dre_categories;
create policy dre_categories_select on public.dre_categories
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists dre_categories_write on public.dre_categories;
create policy dre_categories_write on public.dre_categories
  for all using (app.has_tenant_role(tenant_id,
                  array['owner','admin','accountant','manager']::app.member_role[]))
  with check    (app.has_tenant_role(tenant_id,
                  array['owner','admin','accountant','manager']::app.member_role[]));

drop policy if exists closing_checklist_select on public.closing_checklist_items;
create policy closing_checklist_select on public.closing_checklist_items
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists closing_checklist_write on public.closing_checklist_items;
create policy closing_checklist_write on public.closing_checklist_items
  for all using (app.has_tenant_role(tenant_id,
                  array['owner','admin','accountant','manager']::app.member_role[]))
  with check    (app.has_tenant_role(tenant_id,
                  array['owner','admin','accountant','manager']::app.member_role[]));

drop policy if exists financial_entries_select on public.financial_entries;
create policy financial_entries_select on public.financial_entries
  for select using (
    app.has_tenant_role(tenant_id,
      array['owner','admin','manager','accountant']::app.member_role[])
  );

drop policy if exists financial_entries_write on public.financial_entries;
create policy financial_entries_write on public.financial_entries
  for all using (app.has_tenant_role(tenant_id,
                  array['owner','admin','accountant','manager']::app.member_role[]))
  with check    (app.has_tenant_role(tenant_id,
                  array['owner','admin','accountant','manager']::app.member_role[]));


-- =====================================================================
-- FIM — FASE 7
-- =====================================================================


-- =====================================================================
-- FASE 8 — VIEWS E FUNÇÕES ANALÍTICAS
--   • Saldos de estoque (EI / EF do período)
--   • Valor de estoque atual + alertas
--   • CMV diário por operação (alimenta heatmap)
--   • CMV real mensal por operação (EI + Compras − EF)
--   • KPIs do dashboard
-- =====================================================================

-- ---------- 8.1 Snapshots de estoque (EI / EF) ----------------------
-- Registro manual ou via fechamento mensal. Usado p/ CMV real.
create table if not exists public.stock_period_closures (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  period_label    text not null,                     -- 'Maio / 2026'
  period_start    date not null,
  period_end      date not null,
  initial_value   numeric(14,2) not null default 0 check (initial_value >= 0),
  final_value     numeric(14,2),                     -- pode ser projetado
  is_projected    boolean not null default false,
  closed_at       timestamptz,
  closed_by       uuid references auth.users(id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, period_start, period_end),
  constraint stock_period_closures_dates_chk check (period_start <= period_end)
);

create index if not exists stock_period_closures_tenant_idx
  on public.stock_period_closures (tenant_id, period_end desc);

drop trigger if exists tg_stock_period_closures_updated_at on public.stock_period_closures;
create trigger tg_stock_period_closures_updated_at
  before update on public.stock_period_closures
  for each row execute function app.tg_set_updated_at();

alter table public.stock_period_closures enable row level security;

drop policy if exists stock_period_closures_select on public.stock_period_closures;
create policy stock_period_closures_select on public.stock_period_closures
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists stock_period_closures_write on public.stock_period_closures;
create policy stock_period_closures_write on public.stock_period_closures
  for all using (app.has_tenant_role(tenant_id,
                  array['owner','admin','accountant','manager','stock']::app.member_role[]))
  with check    (app.has_tenant_role(tenant_id,
                  array['owner','admin','accountant','manager','stock']::app.member_role[]));


-- ---------- 8.2 View: valor de estoque atual ------------------------
create or replace view public.v_stock_value as
  select
    tenant_id,
    sum(current_qty * unit_cost)                          as total_value,
    count(*)                                               as sku_count,
    count(*) filter (where status = 'ok')                  as ok_count,
    count(*) filter (where status = 'warn')                as warn_count,
    count(*) filter (where status = 'crit')                as crit_count
  from public.stock_items
  where is_active = true
  group by tenant_id;


-- ---------- 8.3 View: alertas atuais (estoque baixo + vencimento) ---
-- Combina ruptura/baixo estoque com vencimento próximo (≤ 7 dias).
create or replace view public.v_stock_alerts as
  select
    si.tenant_id,
    si.id              as stock_item_id,
    si.code,
    si.name,
    si.unit,
    si.current_qty,
    si.reorder_point,
    si.expiration_date,
    si.status,
    case
      when si.status = 'crit' then 'rupture'
      when si.status = 'warn' then 'low_stock'
      when si.expiration_date is not null
           and si.expiration_date <= (current_date + interval '7 days') then 'expiring'
      else null
    end as alert_kind
  from public.stock_items si
  where si.is_active = true
    and (
      si.status in ('crit','warn')
      or (si.expiration_date is not null
          and si.expiration_date <= (current_date + interval '7 days'))
    );


-- ---------- 8.4 View: CMV diário por operação (alimenta heatmap) ----
-- CMV % do dia = COGS / receita bruta do dia (consolidando fontes).
create or replace view public.v_cmv_daily as
  select
    re.tenant_id,
    re.operation_id,
    re.business_date,
    sum(re.cogs)                                          as cogs,
    sum(coalesce(rpb_sum.gross, 0))                       as gross_revenue,
    case when sum(coalesce(rpb_sum.gross, 0)) > 0
         then round((sum(re.cogs) / sum(rpb_sum.gross)) * 100, 2)
         else null
    end                                                    as cmv_pct
  from public.revenue_entries re
  left join lateral (
    select sum(amount) as gross
      from public.revenue_payment_breakdown
     where revenue_entry_id = re.id
  ) rpb_sum on true
  where re.status = 'confirmed'
  group by re.tenant_id, re.operation_id, re.business_date;


-- ---------- 8.5 View: CMV real mensal (EI + Compras − EF) -----------
-- Compras = lançamentos do grupo 'cmv' no mês de competência.
-- Precisa de stock_period_closures preenchido p/ retornar valor.
create or replace view public.v_cmv_real_monthly as
  with month_purchases as (
    select
      fe.tenant_id,
      date_trunc('month', fe.competence_date)::date as competence_month,
      sum(fe.amount)                                  as purchases
    from public.financial_entries fe
    join public.dre_categories dc on dc.id = fe.category_id
    join public.dre_groups     dg on dg.id = dc.group_id
    where dg.slug = 'cmv'
      and fe.status <> 'cancelled'
    group by fe.tenant_id, date_trunc('month', fe.competence_date)
  ),
  month_revenue as (
    select
      re.tenant_id,
      date_trunc('month', re.business_date)::date as competence_month,
      sum(coalesce(rpb_sum.gross, 0))             as gross
    from public.revenue_entries re
    left join lateral (
      select sum(amount) as gross
        from public.revenue_payment_breakdown
       where revenue_entry_id = re.id
    ) rpb_sum on true
    where re.status = 'confirmed'
    group by re.tenant_id, date_trunc('month', re.business_date)
  )
  select
    spc.tenant_id,
    spc.period_start,
    spc.period_end,
    spc.period_label,
    spc.initial_value,
    spc.final_value,
    coalesce(mp.purchases, 0)                                            as purchases,
    coalesce(mr.gross, 0)                                                as gross_revenue,
    (spc.initial_value + coalesce(mp.purchases, 0) - coalesce(spc.final_value, spc.initial_value))
                                                                          as cmv_real_value,
    case when coalesce(mr.gross, 0) > 0
         then round(
           ((spc.initial_value + coalesce(mp.purchases, 0) - coalesce(spc.final_value, spc.initial_value))
             / mr.gross) * 100, 2)
         else null
    end                                                                   as cmv_real_pct
  from public.stock_period_closures spc
  left join month_purchases mp on mp.tenant_id = spc.tenant_id
                              and mp.competence_month = date_trunc('month', spc.period_start)::date
  left join month_revenue   mr on mr.tenant_id = spc.tenant_id
                              and mr.competence_month = date_trunc('month', spc.period_start)::date;


-- ---------- 8.6 View: receita por operação (período arbitrário) -----
create or replace view public.v_revenue_by_operation_day as
  select
    re.tenant_id,
    re.operation_id,
    re.business_date,
    re.source,
    re.orders_count,
    re.cogs,
    coalesce(sum(rpb.amount), 0) as gross_revenue
  from public.revenue_entries re
  left join public.revenue_payment_breakdown rpb on rpb.revenue_entry_id = re.id
  where re.status = 'confirmed'
  group by re.id;


-- ---------- 8.7 Função: KPIs do dashboard ---------------------------
-- Retorna receita, CMV %, valor de estoque e nº de alertas para
-- (tenant, intervalo, operação opcional).
create or replace function public.get_dashboard_kpis(
  p_tenant       uuid,
  p_start        date,
  p_end          date,
  p_operation    uuid default null
)
returns table (
  gross_revenue   numeric,
  cogs            numeric,
  cmv_pct         numeric,
  orders_count    bigint,
  avg_ticket      numeric,
  stock_value     numeric,
  alerts_total    bigint,
  alerts_critical bigint
)
language sql
stable
security invoker
set search_path = public, app
as $$
  with rev as (
    select
      sum(coalesce(rpb_sum.gross, 0)) as gross_revenue,
      sum(re.cogs)                    as cogs,
      sum(re.orders_count)            as orders_count
    from public.revenue_entries re
    left join lateral (
      select sum(amount) as gross
        from public.revenue_payment_breakdown
       where revenue_entry_id = re.id
    ) rpb_sum on true
    where re.tenant_id = p_tenant
      and re.business_date between p_start and p_end
      and re.status = 'confirmed'
      and (p_operation is null or re.operation_id = p_operation)
  ),
  stk as (
    select
      sum(current_qty * unit_cost) as stock_value
    from public.stock_items
    where tenant_id = p_tenant and is_active = true
  ),
  alr as (
    select
      count(*)                                          as alerts_total,
      count(*) filter (where alert_kind = 'rupture')    as alerts_critical
    from public.v_stock_alerts
    where tenant_id = p_tenant
  )
  select
    coalesce(rev.gross_revenue, 0),
    coalesce(rev.cogs, 0),
    case when coalesce(rev.gross_revenue, 0) > 0
         then round((rev.cogs / rev.gross_revenue) * 100, 2)
         else null end,
    coalesce(rev.orders_count, 0),
    case when coalesce(rev.orders_count, 0) > 0
         then round(rev.gross_revenue / rev.orders_count, 2)
         else null end,
    coalesce(stk.stock_value, 0),
    coalesce(alr.alerts_total, 0),
    coalesce(alr.alerts_critical, 0)
  from rev, stk, alr;
$$;


-- ---------- 8.8 View: CMV teórico médio por operação ----------------
-- Média ponderada do CMV teórico das fichas técnicas ativas da operação.
create or replace view public.v_cmv_theoretical_by_operation as
  select
    ts.tenant_id,
    ts.operation_id,
    avg(case when ts.sale_price > 0
              then (coalesce(items.theoretical_cost, 0) / ts.sale_price) * 100
              else null
         end)                                  as theoretical_cmv_pct,
    count(*)                                   as active_sheets
  from public.tech_sheets ts
  left join lateral (
    select sum(line_cost) as theoretical_cost
      from public.tech_sheet_items
     where tech_sheet_id = ts.id
  ) items on true
  where ts.is_active = true
  group by ts.tenant_id, ts.operation_id;


-- ---------- 8.9 View: comparativo CMV teórico vs real ---------------
-- Real = CMV % consolidado das vendas confirmadas dos últimos 30 dias.
create or replace view public.v_cmv_compare_by_operation as
  with theoretical as (
    select * from public.v_cmv_theoretical_by_operation
  ),
  real_30d as (
    select
      tenant_id,
      operation_id,
      case when sum(gross_revenue) > 0
           then round((sum(cogs) / sum(gross_revenue)) * 100, 2)
           else null end as real_cmv_pct
    from public.v_cmv_daily
    where business_date >= current_date - interval '30 days'
    group by tenant_id, operation_id
  )
  select
    o.tenant_id,
    o.id           as operation_id,
    o.slug         as operation_slug,
    o.name         as operation_name,
    o.cmv_goal_pct,
    th.theoretical_cmv_pct,
    rl.real_cmv_pct,
    case when th.theoretical_cmv_pct is not null and rl.real_cmv_pct is not null
         then round(rl.real_cmv_pct - th.theoretical_cmv_pct, 2)
         else null
    end             as delta_pp
  from public.operations o
  left join theoretical th on th.operation_id = o.id
  left join real_30d    rl on rl.operation_id = o.id
  where o.is_active = true;


-- =====================================================================
-- FIM — FASE 8
-- =====================================================================


-- =====================================================================
-- RLS HELPERS — aliases curtos das funções de autorização
-- Mantém compat com a nomenclatura original (`is_tenant_member`/`has_tenant_role`)
-- e expõe nomes mais ergonômicos pras policies das fases posteriores.
-- =====================================================================
create or replace function app.is_member(p_tenant uuid)
returns boolean
language sql stable security definer set search_path = public, app
as $$ select app.is_tenant_member(p_tenant); $$;

create or replace function app.is_admin_or_manager(p_tenant uuid)
returns boolean
language sql stable security definer set search_path = public, app
as $$ select app.has_tenant_role(p_tenant, array['owner','admin','manager']::app.member_role[]); $$;



-- =====================================================================
-- COMO USAR / SMOKE TEST
-- =====================================================================
-- 1. Cole o conteúdo deste arquivo no SQL Editor do Supabase e rode.
--    (ou: supabase db push, se o projeto estiver vinculado via CLI)
--    AVISO: a primeira execução cria os triggers; a segunda execução do
--    arquivo inteiro pode dar erro em CREATE TRIGGER já existentes — use
--    `drop trigger if exists ...` antes de re-rodar, ou aplique migrations
--    incrementais pelo CLI do Supabase.
--
-- 2. Crie um usuário pelo Supabase Auth (Dashboard → Authentication).
--
-- 3. Logado como esse usuário, no SQL Editor:
--      select public.create_tenant_with_owner('mobydick', 'MobyDick Dark Kitchen');
--    O retorno é o tenant_id; copie-o p/ os passos abaixo.
--
-- 4. Cadastre as operações:
--      insert into public.operations (tenant_id, slug, name, short_label, color, ifood_handle, cmv_goal_pct, sort_order)
--      values
--        ('<tenant_id>', 'burguer',  'Forno & Brasa',  'BURG',  '#c2843a', '@fornoebrasa',   30.0, 1),
--        ('<tenant_id>', 'pizzaria', 'Mestre Stefano', 'PIZZ',  '#b04545', '@mestrestefano', 31.0, 2),
--        ('<tenant_id>', 'acai',     'Tigela do Vale', 'AÇAÍ',  '#6b5fb0', '@tigeladovale',  35.0, 3),
--        ('<tenant_id>', 'saudavel', 'Verde Marmita',  'VERDE', '#2d8c66', '@verdemarmita',  28.0, 4);
--
-- 5. KPI de teste (retorna zeros até existirem dados):
--      select * from public.get_dashboard_kpis(
--        '<tenant_id>'::uuid,
--        date_trunc('month', current_date)::date,
--        current_date
--      );
-- =====================================================================


-- =====================================================================
-- CHECKLIST PARA LIGAR O BACKEND
-- (Itens que NÃO ficam no schema SQL, mas são necessários pra app funcionar)
-- =====================================================================
--
-- A. STORAGE BUCKETS (criar via Dashboard → Storage ou CLI)
-- ---------------------------------------------------------------------
-- Criar 2 buckets (todos privados; URLs assinadas a partir do app):
--   stock-evidences      → fotos de recebimento (Compras), inventário
--   recipe-photos        → fotos das fichas técnicas (opcional)
--
-- Política de Storage (cada bucket): permitir upload/leitura para usuários
-- autenticados membros do tenant — espelha o padrão das tabelas. Use Storage
-- policies vinculando a path `<tenant_id>/...` e checando `app.is_member()`.
--
-- B. EDGE FUNCTIONS (deploy via supabase functions deploy)
-- ---------------------------------------------------------------------
-- 1. ingest-revenue · importação iFood/Rappi (cron diário) — chamada externa
-- 2. compute-cmv-daily · job que recalcula CMV_DAILY a partir de
--    stock_movements + revenue_entries
-- 3. inventory-impact · ao finalizar um inventário, gera registro automático
--    em DRE (subcategoria 'cat-29 Ajuste de estoque')
-- 4. notifications-dispatcher · canal único pra in_app/email/push/whatsapp
--
-- C. VARIÁVEIS DE AMBIENTE (Supabase Dashboard → Settings → Edge Functions)
-- ---------------------------------------------------------------------
--   IFOOD_TOKEN              — integração iFood (opcional)
--   RAPPI_TOKEN              — integração Rappi (opcional)
--   RESEND_API_KEY           — disparos de email
--   WHATSAPP_BUSINESS_TOKEN  — Meta WhatsApp Business API
--   WHATSAPP_PHONE_ID        — ID do número WhatsApp Business
--   FCM_SERVER_KEY           — push notifications (Firebase)
--   APP_PUBLIC_URL           — base URL do app (ex.: https://app.stockkitchen.com.br)
--
-- D. REALTIME (Supabase Dashboard → Database → Replication)
-- ---------------------------------------------------------------------
-- Habilitar Realtime nas tabelas:
--   public.kitchen_requests          (cozinha · status em tempo real)
--
-- E. SEEDS DE PRODUÇÃO MÍNIMA (após criar o tenant)
-- ---------------------------------------------------------------------
-- 1. Categorias DRE (DRE_CATEGORIES + DRE_SUBCATEGORIES) — copiar de data.jsx
-- 2. Métodos de pagamento padrão (já tratados em create_tenant_with_owner)
--
-- F. INTEGRAÇÃO FRONTEND (substituir window.MOCK por queries reais)
-- ---------------------------------------------------------------------
-- 1. Criar `db.js` com cliente Supabase + helper de tenant_id resolvido na sessão
-- 2. Cada `MOCK.X` vira um hook com:
--      - select inicial via supabase-js
--      - subscribe via Realtime quando aplicável
--      - mutations via insert/update/delete + revalidação local
-- 3. Auth: trocar `Rafa Medeiros` hardcoded por usuário da sessão (auth.user)
-- 4. Upload de imagens: substituir base64 in-memory por upload pro Storage
-- 5. RBAC enforcement: ler `tenant_members.role` na sessão e esconder/desabilitar
--    UI conforme role do usuário
--
-- G. PRÓXIMOS PASSOS RECOMENDADOS
-- ---------------------------------------------------------------------
-- 1. Migrar projeto pra Vite + TypeScript (build real, HMR, tipagem)
-- 2. Criar pasta `db/migrations/` com cada fase numerada como arquivo separado
-- 3. CI: rodar `supabase db diff` antes de cada PR pra detectar drift
-- 4. Backups: configurar PITR no Supabase (planos Pro+)
-- 5. Observabilidade: ligar Logflare ou Datadog pros logs de Edge Functions
-- =====================================================================
