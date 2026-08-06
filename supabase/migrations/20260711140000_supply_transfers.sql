-- =====================================================================
-- Fase C — Transferências, Gastos e Solicitações da rede de suprimentos
-- (PRD-PRODUCAO-E-DISTRIBUICAO.md §7–§8; requer 20260711130000_supply_network)
--
--  • supply_transfers/_items: draft → sent (baixa no remetente) → received
--    (entrada no destinatário; opção "direto na cozinha" = in + out p/ CMV)
--  • supply_item_links: mapeamento item do remetente → item do destinatário
--  • supply_ledger_entries: Gastos por tenant (imutável; saldo = Σ delta)
--  • finance_entries automáticos: +valor "Compras · Rede de suprimentos" no
--    destino, −valor "Repasses à rede (−)" na origem (subs normais, NÃO
--    autofeed — a DRE ignora lançamentos de subs autofeed na agregação)
--  • supply_requests/_items: solicitações à central ou entre tenants
--  • Transições via trigger SECURITY DEFINER (efeitos cross-tenant: ledger e
--    finance do outro lado não são graváveis pelo usuário sob RLS)
-- =====================================================================

-- ---------- 1. Transferências ------------------------------------------
create table if not exists public.supply_transfers (
  id                   uuid primary key default gen_random_uuid(),
  central_tenant_id    uuid not null references public.tenants(id) on delete cascade,
  from_tenant_id       uuid not null references public.tenants(id) on delete cascade,
  to_tenant_id         uuid not null references public.tenants(id) on delete cascade,
  from_name            text,                       -- snapshot p/ exibição cross-tenant
  to_name              text,
  code                 text,
  status               text not null default 'draft'
                         check (status in ('draft','sent','received','cancelled')),
  request_id           uuid,                        -- FK adicionada após supply_requests
  direct_to_kitchen    boolean not null default false,
  receive_operation_id uuid references public.operations(id) on delete set null,
  total_value          numeric(14,4),               -- snapshot no sent
  notes                text,
  created_by  uuid references auth.users(id) on delete set null,
  sent_at     timestamptz, sent_by     uuid references auth.users(id) on delete set null,
  received_at timestamptz, received_by uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (central_tenant_id, code),
  check (from_tenant_id <> to_tenant_id)
);

create index if not exists supply_transfers_from_idx on public.supply_transfers (from_tenant_id, status);
create index if not exists supply_transfers_to_idx   on public.supply_transfers (to_tenant_id, status);
create index if not exists supply_transfers_central_idx on public.supply_transfers (central_tenant_id, created_at desc);

drop trigger if exists tg_supply_transfers_updated_at on public.supply_transfers;
create trigger tg_supply_transfers_updated_at
  before update on public.supply_transfers
  for each row execute function app.tg_set_updated_at();

create table if not exists public.supply_transfer_items (
  id             uuid primary key default gen_random_uuid(),
  transfer_id    uuid not null references public.supply_transfers(id) on delete cascade,
  from_item_id   uuid references public.stock_items(id) on delete set null,
  to_item_id     uuid references public.stock_items(id) on delete set null,  -- resolvido no receive
  display_name   text not null,
  item_kind      text not null default 'raw',
  category_name  text,                              -- snapshot p/ mapear categoria no destino
  qty            numeric(14,4) not null check (qty > 0),
  unit           text not null,
  unit_cost      numeric(12,4) not null default 0,  -- snapshot no sent (custo do remetente)
  portion_qty    numeric(14,4),
  portion_unit   text,
  sort_order     int not null default 0
);

create index if not exists supply_transfer_items_transfer_idx
  on public.supply_transfer_items (transfer_id);

-- ---------- 2. Mapeamento de itens entre tenants ------------------------
create table if not exists public.supply_item_links (
  central_tenant_id uuid not null references public.tenants(id) on delete cascade,
  from_item_id      uuid not null references public.stock_items(id) on delete cascade,
  to_tenant_id      uuid not null references public.tenants(id) on delete cascade,
  to_item_id        uuid not null references public.stock_items(id) on delete cascade,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (central_tenant_id, from_item_id, to_tenant_id)
);

drop trigger if exists tg_supply_item_links_updated_at on public.supply_item_links;
create trigger tg_supply_item_links_updated_at
  before update on public.supply_item_links
  for each row execute function app.tg_set_updated_at();

-- ---------- 3. Ledger de Gastos -----------------------------------------
create table if not exists public.supply_ledger_entries (
  id                uuid primary key default gen_random_uuid(),
  central_tenant_id uuid not null references public.tenants(id) on delete cascade,
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  delta             numeric(14,4) not null,
  kind              text not null check (kind in ('transfer_in','transfer_out','adjustment')),
  transfer_id       uuid references public.supply_transfers(id) on delete set null,
  notes             text,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists supply_ledger_central_idx
  on public.supply_ledger_entries (central_tenant_id, tenant_id, created_at desc);

-- Imutável: corrigir = novo 'adjustment'
create or replace function app.tg_block_supply_ledger_change()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
begin
  raise exception 'supply_ledger_entries é imutável — lance um ajuste para corrigir';
end;
$$;

drop trigger if exists tg_supply_ledger_no_update on public.supply_ledger_entries;
create trigger tg_supply_ledger_no_update
  before update or delete on public.supply_ledger_entries
  for each row execute function app.tg_block_supply_ledger_change();

create or replace view public.v_supply_balances
with (security_invoker = true) as
  select central_tenant_id, tenant_id,
         sum(delta)      as balance,
         max(created_at) as last_entry_at
    from public.supply_ledger_entries
   group by central_tenant_id, tenant_id;

revoke select on public.v_supply_balances from anon;

-- ---------- 4. Solicitações ----------------------------------------------
create table if not exists public.supply_requests (
  id                  uuid primary key default gen_random_uuid(),
  central_tenant_id   uuid not null references public.tenants(id) on delete cascade,
  requester_tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier_tenant_id  uuid not null references public.tenants(id) on delete cascade,
  requester_name      text,
  supplier_name       text,
  code                text,
  status              text not null default 'pending'
                        check (status in ('pending','approved','rejected','cancelled','fulfilled')),
  notes               text,
  rejection_reason    text,
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  responded_at timestamptz, responded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (central_tenant_id, code),
  check (requester_tenant_id <> supplier_tenant_id)
);

create index if not exists supply_requests_requester_idx on public.supply_requests (requester_tenant_id, status);
create index if not exists supply_requests_supplier_idx  on public.supply_requests (supplier_tenant_id, status);

drop trigger if exists tg_supply_requests_updated_at on public.supply_requests;
create trigger tg_supply_requests_updated_at
  before update on public.supply_requests
  for each row execute function app.tg_set_updated_at();

create table if not exists public.supply_request_items (
  id               uuid primary key default gen_random_uuid(),
  request_id       uuid not null references public.supply_requests(id) on delete cascade,
  supplier_item_id uuid references public.stock_items(id) on delete set null,
  display_name     text not null,
  qty              numeric(14,4) not null check (qty > 0),
  unit             text not null,
  sort_order       int not null default 0
);

create index if not exists supply_request_items_request_idx
  on public.supply_request_items (request_id);

do $$ begin
  alter table public.supply_transfers
    add constraint supply_transfers_request_fk
    foreign key (request_id) references public.supply_requests(id) on delete set null;
exception when duplicate_object then null; end $$;

-- ---------- 5. Helpers ----------------------------------------------------
-- Quem pode operar a rede num tenant: módulo 'supply' (membro) ou 'distribution'
-- (central). SECURITY DEFINER p/ resolver membership sem depender da RLS do chamador.
create or replace function app.supply_can_write(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = 'app','public','pg_temp'
as $$
  select auth.role() = 'service_role'
      or app.can_access_module(p_tenant, 'supply')
      or app.can_access_module(p_tenant, 'distribution');
$$;

-- Tenant participa (ativo) da rede da central? A própria central conta.
create or replace function app.supply_in_network(p_central uuid, p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = 'app','public','pg_temp'
as $$
  select p_tenant = p_central
      or exists (select 1 from public.supply_members sm
                  where sm.central_tenant_id = p_central
                    and sm.member_tenant_id  = p_tenant
                    and sm.status = 'active');
$$;

-- Lançamento financeiro automático da transferência (grupo cmv do tenant).
-- Sub NORMAL (autofeed nulo) — a DRE ignora lançamentos de subs autofeed,
-- e estes precisam somar em "Compras" (CMV real = EI + Compras − EF).
create or replace function app.supply_finance_entry(
  p_tenant uuid, p_value numeric, p_desc text, p_transfer uuid
) returns void
language plpgsql
volatile
security definer
set search_path = 'app','public','pg_temp'
as $$
declare
  v_cat uuid;
  v_sub uuid;
  v_sub_name text := case when p_value >= 0
                          then 'Compras · Rede de suprimentos'
                          else 'Repasses à rede (−)' end;
begin
  select c.id into v_cat
    from public.dre_categories c
    join public.dre_groups g on g.id = c.group_id
   where c.tenant_id = p_tenant and g.slug = 'cmv' and c.is_active
   order by c.sort_order limit 1;
  if v_cat is null then
    raise notice 'supply_finance_entry: tenant % sem categoria cmv — lançamento pulado', p_tenant;
    return;
  end if;

  select id into v_sub from public.dre_subcategories
   where tenant_id = p_tenant and name = v_sub_name;
  if v_sub is null then
    insert into public.dre_subcategories (tenant_id, category_id, name, sort_order)
    values (p_tenant, v_cat, v_sub_name, case when p_value >= 0 then 15 else 16 end)
    returning id into v_sub;
  end if;

  insert into public.finance_entries
    (tenant_id, subcategory_id, description, value, competence_date, payment_date,
     status, auto_source, auto_source_id)
  values
    (p_tenant, v_sub, p_desc, round(p_value, 2), current_date, current_date,
     'paid', 'supply_transfer', p_transfer);
end;
$$;

-- ---------- 6. Triggers de transferência ----------------------------------
-- INSERT: valida rede + snapshots de nomes + código 'TRF-xxxxxx' por rede.
create or replace function app.tg_supply_transfer_insert()
returns trigger
language plpgsql
security definer
set search_path = 'app','public','pg_temp'
as $$
declare
  v_try int := 0;
begin
  if not exists (select 1 from public.tenants t
                  where t.id = new.central_tenant_id and t.kind = 'distribution_center') then
    raise exception 'central % não é uma central de distribuição', new.central_tenant_id;
  end if;
  if not app.supply_in_network(new.central_tenant_id, new.from_tenant_id) then
    raise exception 'tenant remetente não participa da rede';
  end if;
  if not app.supply_in_network(new.central_tenant_id, new.to_tenant_id) then
    raise exception 'tenant destinatário não participa da rede';
  end if;
  if new.status <> 'draft' then
    raise exception 'transferência nasce como rascunho';
  end if;
  if new.request_id is not null and not exists (
    select 1 from public.supply_requests r
     where r.id = new.request_id
       and r.central_tenant_id  = new.central_tenant_id
       and r.supplier_tenant_id = new.from_tenant_id
       and r.requester_tenant_id = new.to_tenant_id
  ) then
    raise exception 'request_id não corresponde a uma solicitação desta rota';
  end if;

  select name into new.from_name from public.tenants where id = new.from_tenant_id;
  select name into new.to_name   from public.tenants where id = new.to_tenant_id;
  if new.created_by is null then new.created_by := auth.uid(); end if;

  if new.code is null then
    loop
      v_try := v_try + 1;
      new.code := 'TRF-' || lpad(floor(random() * 1000000)::bigint::text, 6, '0');
      exit when not exists (select 1 from public.supply_transfers st
                             where st.central_tenant_id = new.central_tenant_id
                               and st.code = new.code);
      if v_try > 20 then raise exception 'não foi possível gerar código da transferência'; end if;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists tg_supply_transfers_insert on public.supply_transfers;
create trigger tg_supply_transfers_insert
  before insert on public.supply_transfers
  for each row execute function app.tg_supply_transfer_insert();

-- Itens: enriquece snapshots a partir do item do remetente; edição só em draft
-- (exceto to_item_id, gravado pelo receive). Coerência de tenant.
create or replace function app.tg_supply_transfer_item_check()
returns trigger
language plpgsql
security definer
set search_path = 'app','public','pg_temp'
as $$
declare
  v_tr record;
  v_item record;
begin
  select from_tenant_id, status into v_tr
    from public.supply_transfers where id = coalesce(new.transfer_id, old.transfer_id);
  if v_tr is null then
    raise exception 'supply_transfer_items: transferência não encontrada';
  end if;

  if tg_op = 'DELETE' then
    if v_tr.status not in ('draft','cancelled') then
      raise exception 'itens só podem ser removidos com a transferência em rascunho';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' and v_tr.status <> 'draft' then
    raise exception 'itens só podem ser adicionados com a transferência em rascunho';
  end if;
  if tg_op = 'UPDATE' and v_tr.status not in ('draft','sent') then
    raise exception 'itens de transferência % não podem ser alterados', v_tr.status;
  end if;

  if new.from_item_id is not null then
    select tenant_id, name, unit, unit_cost, item_kind, portion_qty, portion_unit, category_id
      into v_item from public.stock_items where id = new.from_item_id;
    if v_item is null or v_item.tenant_id <> v_tr.from_tenant_id then
      raise exception 'item % não pertence ao tenant remetente', new.from_item_id;
    end if;
    -- Snapshots (sempre re-derivados do item do remetente)
    if new.display_name is null or new.display_name = '' then new.display_name := v_item.name; end if;
    new.unit         := coalesce(new.unit, v_item.unit);
    new.item_kind    := coalesce(v_item.item_kind, 'raw');
    new.portion_qty  := v_item.portion_qty;
    new.portion_unit := v_item.portion_unit;
    select name into new.category_name from public.stock_categories where id = v_item.category_id;
  end if;
  return new;
end;
$$;

drop trigger if exists tg_supply_transfer_items_check on public.supply_transfer_items;
create trigger tg_supply_transfer_items_check
  before insert or update or delete on public.supply_transfer_items
  for each row execute function app.tg_supply_transfer_item_check();

-- Transições de status (SECURITY DEFINER — ledger/finance do outro tenant).
create or replace function app.tg_supply_transfer_transition()
returns trigger
language plpgsql
security definer
set search_path = 'app','public','pg_temp'
as $$
declare
  r record;
  v_total numeric(14,4) := 0;
  v_to_item uuid;
  v_cat uuid;
begin
  if tg_op <> 'UPDATE' then return new; end if;

  -- Campos estruturais são imutáveis fora do rascunho
  if old.status <> 'draft' then
    new.central_tenant_id := old.central_tenant_id;
    new.from_tenant_id    := old.from_tenant_id;
    new.to_tenant_id      := old.to_tenant_id;
    new.code              := old.code;
    new.request_id        := old.request_id;
    new.total_value       := old.total_value;
  end if;

  if new.status = old.status then
    if old.status <> 'draft' then
      -- fora do draft, só o receive (mesma transação) mexe — bloqueia edição solta
      if new.direct_to_kitchen <> old.direct_to_kitchen
         or coalesce(new.receive_operation_id::text,'') <> coalesce(old.receive_operation_id::text,'')
         or coalesce(new.notes,'') <> coalesce(old.notes,'') then
        raise exception 'transferência % não pode mais ser editada', old.status;
      end if;
    end if;
    return new;
  end if;

  -- ===== draft → sent (remetente): guard de saldo + baixa + snapshots =====
  if old.status = 'draft' and new.status = 'sent' then
    if not app.supply_can_write(old.from_tenant_id) then
      raise exception 'sem permissão para enviar (módulo Suprimentos/Central do remetente)';
    end if;
    if not exists (select 1 from public.supply_transfer_items where transfer_id = new.id) then
      raise exception 'adicione pelo menos um item antes de enviar';
    end if;
    for r in
      select ti.id, ti.from_item_id, ti.qty, ti.display_name,
             si.current_qty, si.unit_cost
        from public.supply_transfer_items ti
        left join public.stock_items si on si.id = ti.from_item_id
       where ti.transfer_id = new.id
    loop
      if r.from_item_id is null then
        raise exception 'item "%" sem vínculo com o estoque do remetente', r.display_name;
      end if;
      if r.current_qty < r.qty then
        raise exception 'Saldo insuficiente de "%" (disponível %, necessário %)',
          r.display_name, r.current_qty, r.qty;
      end if;
      update public.supply_transfer_items
         set unit_cost = round(coalesce(r.unit_cost, 0), 4)
       where id = r.id;
      v_total := v_total + round(r.qty * coalesce(r.unit_cost, 0), 4);

      insert into public.stock_movements
        (tenant_id, stock_item_id, kind, qty, unit_cost, notes, reference_type, reference_id, performed_by)
      values
        (old.from_tenant_id, r.from_item_id, 'out', -r.qty, round(coalesce(r.unit_cost,0),4),
         'Transferência ' || coalesce(new.code, new.id::text) || ' → ' || coalesce(new.to_name,'—'),
         'supply_transfer', new.id, coalesce(new.sent_by, auth.uid()));
    end loop;
    new.total_value := v_total;
    if new.sent_at is null then new.sent_at := now(); end if;
    if new.sent_by is null then new.sent_by := auth.uid(); end if;
    return new;
  end if;

  -- ===== sent → received (destinatário): mapeia itens + entrada + ledger + finance =====
  if old.status = 'sent' and new.status = 'received' then
    if not app.supply_can_write(old.to_tenant_id) then
      raise exception 'sem permissão para receber (módulo Suprimentos do destinatário)';
    end if;
    if new.direct_to_kitchen then
      if new.receive_operation_id is null then
        raise exception 'escolha a operação para a entrega direto na cozinha';
      end if;
      if not exists (select 1 from public.operations o
                      where o.id = new.receive_operation_id and o.tenant_id = old.to_tenant_id) then
        raise exception 'operação não pertence ao tenant destinatário';
      end if;
    end if;

    for r in
      select ti.id, ti.from_item_id, ti.to_item_id, ti.display_name, ti.item_kind,
             ti.category_name, ti.qty, ti.unit, ti.unit_cost, ti.portion_qty, ti.portion_unit
        from public.supply_transfer_items ti
       where ti.transfer_id = new.id
    loop
      -- 1) link memorizado (inclui override feito pelo destinatário antes de confirmar)
      v_to_item := null;
      select l.to_item_id into v_to_item
        from public.supply_item_links l
        join public.stock_items si on si.id = l.to_item_id and si.is_active
       where l.central_tenant_id = old.central_tenant_id
         and l.from_item_id = r.from_item_id
         and l.to_tenant_id = old.to_tenant_id;

      -- 2) match por nome+unidade no destino
      if v_to_item is null then
        select si.id into v_to_item
          from public.stock_items si
         where si.tenant_id = old.to_tenant_id
           and si.is_active
           and lower(trim(si.name)) = lower(trim(r.display_name))
           and si.unit = r.unit
         order by si.created_at limit 1;
      end if;

      -- 3) cria o item no destino (categoria mapeada por nome quando existir)
      if v_to_item is null then
        v_cat := null;
        if r.category_name is not null then
          select id into v_cat from public.stock_categories
           where tenant_id = old.to_tenant_id
             and lower(trim(name)) = lower(trim(r.category_name))
           limit 1;
        end if;
        insert into public.stock_items
          (tenant_id, name, unit, unit_cost, current_qty, item_kind, portion_qty, portion_unit, category_id)
        values
          (old.to_tenant_id, r.display_name, r.unit, r.unit_cost, 0,
           coalesce(r.item_kind,'raw'), r.portion_qty, r.portion_unit, v_cat)
        returning id into v_to_item;
      end if;

      -- memoriza o mapeamento p/ próximas transferências
      if r.from_item_id is not null then
        insert into public.supply_item_links (central_tenant_id, from_item_id, to_tenant_id, to_item_id)
        values (old.central_tenant_id, r.from_item_id, old.to_tenant_id, v_to_item)
        on conflict (central_tenant_id, from_item_id, to_tenant_id)
          do update set to_item_id = excluded.to_item_id, updated_at = now();
      end if;

      update public.supply_transfer_items set to_item_id = v_to_item where id = r.id;

      insert into public.stock_movements
        (tenant_id, stock_item_id, kind, qty, unit_cost, notes, reference_type, reference_id, performed_by)
      values
        (old.to_tenant_id, v_to_item, 'in', r.qty, r.unit_cost,
         'Transferência ' || coalesce(old.code, new.id::text) || ' · ' || coalesce(old.from_name,'—'),
         'supply_transfer', new.id, coalesce(new.received_by, auth.uid()));

      -- direto na cozinha: saída imediata que COMPÕE o CMV
      if new.direct_to_kitchen then
        insert into public.stock_movements
          (tenant_id, stock_item_id, operation_id, kind, qty, unit_cost, notes, reference_type, reference_id, performed_by)
        values
          (old.to_tenant_id, v_to_item, new.receive_operation_id, 'out', -r.qty, r.unit_cost,
           'Transferência ' || coalesce(old.code, new.id::text) || ' · direto na cozinha',
           'supply_transfer_kitchen', new.id, coalesce(new.received_by, auth.uid()));
      end if;
    end loop;

    -- Ledger de Gastos (saldo por tenant em relação à central)
    if old.total_value is not null and old.total_value <> 0 then
      if old.from_tenant_id = old.central_tenant_id then
        insert into public.supply_ledger_entries (central_tenant_id, tenant_id, delta, kind, transfer_id, created_by)
        values (old.central_tenant_id, old.to_tenant_id, old.total_value, 'transfer_in', new.id, auth.uid());
      elsif old.to_tenant_id = old.central_tenant_id then
        insert into public.supply_ledger_entries (central_tenant_id, tenant_id, delta, kind, transfer_id, created_by)
        values (old.central_tenant_id, old.from_tenant_id, -old.total_value, 'transfer_out', new.id, auth.uid());
      else
        insert into public.supply_ledger_entries (central_tenant_id, tenant_id, delta, kind, transfer_id, created_by)
        values (old.central_tenant_id, old.from_tenant_id, -old.total_value, 'transfer_out', new.id, auth.uid()),
               (old.central_tenant_id, old.to_tenant_id,    old.total_value, 'transfer_in',  new.id, auth.uid());
      end if;

      -- Financeiro (CMV real = EI + Compras − EF dos dois lados)
      perform app.supply_finance_entry(old.to_tenant_id,  old.total_value,
        'Transferência ' || coalesce(old.code,'') || ' · recebida de ' || coalesce(old.from_name,'—'), new.id);
      perform app.supply_finance_entry(old.from_tenant_id, -old.total_value,
        'Transferência ' || coalesce(old.code,'') || ' · enviada para ' || coalesce(old.to_name,'—'), new.id);
    end if;

    -- Solicitação vinculada vira 'fulfilled'
    if old.request_id is not null then
      perform set_config('app.supply_receive', '1', true);
      update public.supply_requests
         set status = 'fulfilled', responded_at = coalesce(responded_at, now())
       where id = old.request_id and status in ('pending','approved');
      perform set_config('app.supply_receive', '0', true);
    end if;

    if new.received_at is null then new.received_at := now(); end if;
    if new.received_by is null then new.received_by := auth.uid(); end if;
    return new;
  end if;

  -- ===== cancelamento =====
  if new.status = 'cancelled' and old.status in ('draft','sent') then
    if not app.supply_can_write(old.from_tenant_id) then
      raise exception 'só o remetente pode cancelar a transferência';
    end if;
    if old.status = 'sent' then
      for r in
        select from_item_id, qty, unit_cost, display_name
          from public.supply_transfer_items where transfer_id = new.id
      loop
        insert into public.stock_movements
          (tenant_id, stock_item_id, kind, qty, unit_cost, notes, reference_type, reference_id, performed_by)
        values
          (old.from_tenant_id, r.from_item_id, 'in', r.qty, r.unit_cost,
           'Cancelamento transferência ' || coalesce(old.code, new.id::text),
           'supply_transfer', new.id, auth.uid());
      end loop;
    end if;
    return new;
  end if;

  raise exception 'Transição de status inválida: % → %', old.status, new.status;
end;
$$;

drop trigger if exists tg_supply_transfers_transition on public.supply_transfers;
create trigger tg_supply_transfers_transition
  before update on public.supply_transfers
  for each row execute function app.tg_supply_transfer_transition();

-- Só rascunhos podem ser excluídos
create or replace function app.tg_block_supply_transfer_delete()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
begin
  if old.status <> 'draft' then
    raise exception 'transferência % não pode ser excluída (status %)', coalesce(old.code, old.id::text), old.status;
  end if;
  return old;
end;
$$;

drop trigger if exists tg_supply_transfers_block_delete on public.supply_transfers;
create trigger tg_supply_transfers_block_delete
  before delete on public.supply_transfers
  for each row execute function app.tg_block_supply_transfer_delete();

-- ---------- 7. Triggers de solicitação ------------------------------------
create or replace function app.tg_supply_request_insert()
returns trigger
language plpgsql
security definer
set search_path = 'app','public','pg_temp'
as $$
declare
  v_try int := 0;
begin
  if not exists (select 1 from public.tenants t
                  where t.id = new.central_tenant_id and t.kind = 'distribution_center') then
    raise exception 'central % não é uma central de distribuição', new.central_tenant_id;
  end if;
  if not app.supply_in_network(new.central_tenant_id, new.requester_tenant_id) then
    raise exception 'tenant solicitante não participa da rede';
  end if;
  if not app.supply_in_network(new.central_tenant_id, new.supplier_tenant_id) then
    raise exception 'tenant fornecedor não participa da rede';
  end if;
  if new.status <> 'pending' then
    raise exception 'solicitação nasce como pendente';
  end if;

  select name into new.requester_name from public.tenants where id = new.requester_tenant_id;
  select name into new.supplier_name  from public.tenants where id = new.supplier_tenant_id;
  if new.requested_by is null then new.requested_by := auth.uid(); end if;

  if new.code is null then
    loop
      v_try := v_try + 1;
      new.code := 'SOL-' || lpad(floor(random() * 1000000)::bigint::text, 6, '0');
      exit when not exists (select 1 from public.supply_requests sr
                             where sr.central_tenant_id = new.central_tenant_id
                               and sr.code = new.code);
      if v_try > 20 then raise exception 'não foi possível gerar código da solicitação'; end if;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists tg_supply_requests_insert on public.supply_requests;
create trigger tg_supply_requests_insert
  before insert on public.supply_requests
  for each row execute function app.tg_supply_request_insert();

create or replace function app.tg_supply_request_transition()
returns trigger
language plpgsql
security definer
set search_path = 'app','public','pg_temp'
as $$
begin
  if tg_op <> 'UPDATE' then return new; end if;

  -- Campos estruturais imutáveis
  new.central_tenant_id   := old.central_tenant_id;
  new.requester_tenant_id := old.requester_tenant_id;
  new.supplier_tenant_id  := old.supplier_tenant_id;
  new.code                := old.code;

  if new.status = old.status then
    if old.status <> 'pending' then
      raise exception 'solicitação % não pode mais ser editada', old.status;
    end if;
    return new; -- notas editáveis enquanto pendente
  end if;

  -- fulfilled: só pelo receive da transferência vinculada (GUC de sessão)
  if new.status = 'fulfilled' then
    if coalesce(current_setting('app.supply_receive', true), '0') <> '1' then
      raise exception 'solicitação é concluída automaticamente no recebimento da transferência';
    end if;
    return new;
  end if;

  if old.status = 'pending' and new.status in ('approved','rejected') then
    if not app.supply_can_write(old.supplier_tenant_id) then
      raise exception 'só o fornecedor pode aprovar/recusar';
    end if;
    if new.responded_at is null then new.responded_at := now(); end if;
    if new.responded_by is null then new.responded_by := auth.uid(); end if;
    return new;
  end if;

  if old.status in ('pending','approved') and new.status = 'cancelled' then
    if not app.supply_can_write(old.requester_tenant_id) then
      raise exception 'só o solicitante pode cancelar';
    end if;
    return new;
  end if;

  raise exception 'Transição de status inválida: % → %', old.status, new.status;
end;
$$;

drop trigger if exists tg_supply_requests_transition on public.supply_requests;
create trigger tg_supply_requests_transition
  before update on public.supply_requests
  for each row execute function app.tg_supply_request_transition();

-- Itens: fornecedor é o dono dos itens referenciados; edição só pendente.
create or replace function app.tg_supply_request_item_check()
returns trigger
language plpgsql
security definer
set search_path = 'app','public','pg_temp'
as $$
declare
  v_req record;
  v_item_tenant uuid;
begin
  select supplier_tenant_id, status into v_req
    from public.supply_requests where id = coalesce(new.request_id, old.request_id);
  if v_req is null then
    raise exception 'supply_request_items: solicitação não encontrada';
  end if;
  if tg_op = 'DELETE' then
    if v_req.status not in ('pending','cancelled','rejected') then
      raise exception 'itens não podem ser removidos (status %)', v_req.status;
    end if;
    return old;
  end if;
  if v_req.status <> 'pending' then
    raise exception 'itens só podem ser alterados com a solicitação pendente';
  end if;
  if new.supplier_item_id is not null then
    select tenant_id into v_item_tenant from public.stock_items where id = new.supplier_item_id;
    if v_item_tenant is null or v_item_tenant <> v_req.supplier_tenant_id then
      raise exception 'item não pertence ao fornecedor da solicitação';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tg_supply_request_items_check on public.supply_request_items;
create trigger tg_supply_request_items_check
  before insert or update or delete on public.supply_request_items
  for each row execute function app.tg_supply_request_item_check();

-- ---------- 8. RLS ----------------------------------------------------------
alter table public.supply_transfers      enable row level security;
alter table public.supply_transfer_items enable row level security;
alter table public.supply_item_links     enable row level security;
alter table public.supply_ledger_entries enable row level security;
alter table public.supply_requests       enable row level security;
alter table public.supply_request_items  enable row level security;

-- Transferências: lados + central enxergam; cria o remetente; atualiza qualquer
-- lado (o trigger de transição decide o que cada lado pode); exclui o remetente.
drop policy if exists supply_transfers_select on public.supply_transfers;
create policy supply_transfers_select on public.supply_transfers
  for select using (
    app.is_tenant_member(from_tenant_id) or app.is_tenant_member(to_tenant_id)
    or app.is_tenant_member(central_tenant_id)
  );

drop policy if exists supply_transfers_insert on public.supply_transfers;
create policy supply_transfers_insert on public.supply_transfers
  for insert with check (app.supply_can_write(from_tenant_id));

drop policy if exists supply_transfers_update on public.supply_transfers;
create policy supply_transfers_update on public.supply_transfers
  for update using (app.supply_can_write(from_tenant_id) or app.supply_can_write(to_tenant_id));

drop policy if exists supply_transfers_delete on public.supply_transfers;
create policy supply_transfers_delete on public.supply_transfers
  for delete using (app.supply_can_write(from_tenant_id));

drop policy if exists supply_transfer_items_select on public.supply_transfer_items;
create policy supply_transfer_items_select on public.supply_transfer_items
  for select using (exists (select 1 from public.supply_transfers st
    where st.id = supply_transfer_items.transfer_id
      and (app.is_tenant_member(st.from_tenant_id) or app.is_tenant_member(st.to_tenant_id)
           or app.is_tenant_member(st.central_tenant_id))));

drop policy if exists supply_transfer_items_write on public.supply_transfer_items;
create policy supply_transfer_items_write on public.supply_transfer_items
  for all using (exists (select 1 from public.supply_transfers st
      where st.id = supply_transfer_items.transfer_id and app.supply_can_write(st.from_tenant_id)))
  with check (exists (select 1 from public.supply_transfers st
      where st.id = supply_transfer_items.transfer_id and app.supply_can_write(st.from_tenant_id)));

-- Links de item: destinatário gerencia os seus (override no recebimento).
drop policy if exists supply_item_links_select on public.supply_item_links;
create policy supply_item_links_select on public.supply_item_links
  for select using (
    app.is_tenant_member(to_tenant_id) or app.is_tenant_member(central_tenant_id)
  );

drop policy if exists supply_item_links_write on public.supply_item_links;
create policy supply_item_links_write on public.supply_item_links
  for all using (app.supply_can_write(to_tenant_id))
  with check (app.supply_can_write(to_tenant_id));

-- Ledger: tenant vê o próprio; central vê toda a rede. Escrita só via trigger/RPC.
drop policy if exists supply_ledger_select on public.supply_ledger_entries;
create policy supply_ledger_select on public.supply_ledger_entries
  for select using (
    app.is_tenant_member(tenant_id) or app.is_tenant_member(central_tenant_id)
  );

-- Solicitações
drop policy if exists supply_requests_select on public.supply_requests;
create policy supply_requests_select on public.supply_requests
  for select using (
    app.is_tenant_member(requester_tenant_id) or app.is_tenant_member(supplier_tenant_id)
    or app.is_tenant_member(central_tenant_id)
  );

drop policy if exists supply_requests_insert on public.supply_requests;
create policy supply_requests_insert on public.supply_requests
  for insert with check (app.supply_can_write(requester_tenant_id));

drop policy if exists supply_requests_update on public.supply_requests;
create policy supply_requests_update on public.supply_requests
  for update using (
    app.supply_can_write(requester_tenant_id) or app.supply_can_write(supplier_tenant_id)
  );

drop policy if exists supply_request_items_select on public.supply_request_items;
create policy supply_request_items_select on public.supply_request_items
  for select using (exists (select 1 from public.supply_requests sr
    where sr.id = supply_request_items.request_id
      and (app.is_tenant_member(sr.requester_tenant_id) or app.is_tenant_member(sr.supplier_tenant_id)
           or app.is_tenant_member(sr.central_tenant_id))));

drop policy if exists supply_request_items_write on public.supply_request_items;
create policy supply_request_items_write on public.supply_request_items
  for all using (exists (select 1 from public.supply_requests sr
      where sr.id = supply_request_items.request_id and app.supply_can_write(sr.requester_tenant_id)))
  with check (exists (select 1 from public.supply_requests sr
      where sr.id = supply_request_items.request_id and app.supply_can_write(sr.requester_tenant_id)));

-- ---------- 9. RPCs ----------------------------------------------------------
-- Visão geral da rede para um tenant (central e/ou membro). Nomes e saldos
-- cruzam tenants — por isso DEFINER com validação de membership do chamador.
create or replace function public.supply_network_overview(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'app','public','pg_temp'
as $$
declare
  v_out jsonb;
begin
  if auth.uid() is null and auth.role() <> 'service_role' then
    raise exception 'não autenticado';
  end if;
  if auth.role() <> 'service_role' and not app.is_tenant_member(p_tenant) then
    raise exception 'sem permissão no tenant';
  end if;

  select jsonb_build_object(
    'tenant', (select jsonb_build_object('id', t.id, 'name', t.name, 'kind', t.kind, 'supplyCode', t.supply_code)
                 from public.tenants t where t.id = p_tenant),
    'asCentral', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tenantId', sm.member_tenant_id,
        'name', mt.name,
        'code', mt.supply_code,
        'status', sm.status,
        'invitedAt', sm.invited_at,
        'respondedAt', sm.responded_at,
        'balance', coalesce((select sum(le.delta) from public.supply_ledger_entries le
                              where le.central_tenant_id = p_tenant
                                and le.tenant_id = sm.member_tenant_id), 0)
      ) order by mt.name)
      from public.supply_members sm
      join public.tenants mt on mt.id = sm.member_tenant_id
      where sm.central_tenant_id = p_tenant
        and sm.status in ('invited','active')
    ), '[]'::jsonb),
    'asMember', coalesce((
      select jsonb_agg(jsonb_build_object(
        'centralId', sm.central_tenant_id,
        'centralName', ct.name,
        'status', sm.status,
        'invitedAt', sm.invited_at,
        'myBalance', coalesce((select sum(le.delta) from public.supply_ledger_entries le
                                where le.central_tenant_id = sm.central_tenant_id
                                  and le.tenant_id = p_tenant), 0),
        'peers', coalesce((
          select jsonb_agg(jsonb_build_object('tenantId', sm2.member_tenant_id, 'name', mt2.name) order by mt2.name)
          from public.supply_members sm2
          join public.tenants mt2 on mt2.id = sm2.member_tenant_id
          where sm2.central_tenant_id = sm.central_tenant_id
            and sm2.status = 'active'
            and sm2.member_tenant_id <> p_tenant
        ), '[]'::jsonb)
      ) order by ct.name)
      from public.supply_members sm
      join public.tenants ct on ct.id = sm.central_tenant_id
      where sm.member_tenant_id = p_tenant
        and sm.status in ('invited','active')
    ), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;

-- Catálogo do fornecedor visível pra quem divide rede com ele. Sem custo/saldo.
create or replace function public.supply_list_catalog(p_viewer uuid, p_supplier uuid)
returns table (item_id uuid, name text, unit text, item_kind text, category_name text,
               portion_qty numeric, portion_unit text)
language plpgsql
stable
security definer
set search_path = 'app','public','pg_temp'
as $$
begin
  if auth.uid() is null and auth.role() <> 'service_role' then
    raise exception 'não autenticado';
  end if;
  if auth.role() <> 'service_role' and not app.is_tenant_member(p_viewer) then
    raise exception 'sem permissão no tenant';
  end if;
  -- viewer e supplier precisam dividir alguma rede ativa
  if not exists (
    select 1 from public.tenants c
     where c.kind = 'distribution_center'
       and app.supply_in_network(c.id, p_viewer)
       and app.supply_in_network(c.id, p_supplier)
       and (c.id = p_viewer or c.id = p_supplier
            or exists (select 1 from public.supply_members x
                        where x.central_tenant_id = c.id
                          and x.member_tenant_id in (p_viewer, p_supplier)))
  ) then
    raise exception 'tenants não participam da mesma rede';
  end if;

  return query
    select si.id, si.name::text, si.unit::text, si.item_kind::text,
           sc.name::text, si.portion_qty, si.portion_unit::text
      from public.stock_items si
      left join public.stock_categories sc on sc.id = si.category_id
     where si.tenant_id = p_supplier
       and si.is_active
     order by si.name;
end;
$$;

-- Ajuste manual de gastos (acertos/pagamentos) — só gestores da central.
create or replace function public.supply_ledger_adjust(
  p_central uuid, p_tenant uuid, p_delta numeric, p_notes text
) returns void
language plpgsql
volatile
security definer
set search_path = 'app','public','pg_temp'
as $$
begin
  if auth.uid() is null and auth.role() <> 'service_role' then
    raise exception 'não autenticado';
  end if;
  if not app.supply_is_manager(p_central) then
    raise exception 'sem permissão na central';
  end if;
  if not exists (select 1 from public.supply_members sm
                  where sm.central_tenant_id = p_central
                    and sm.member_tenant_id = p_tenant) then
    raise exception 'tenant não pertence à rede desta central';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'valor do ajuste não pode ser zero';
  end if;
  insert into public.supply_ledger_entries (central_tenant_id, tenant_id, delta, kind, notes, created_by)
  values (p_central, p_tenant, round(p_delta, 4), 'adjustment', p_notes, auth.uid());
end;
$$;

-- ---------- 10. Presets de módulos -----------------------------------------
-- owner/admin/manager ganham supply+distribution; stock ganha supply.
-- (espelhado em shell.jsx ROLE_DEFAULT_MODULES e page-settings ROLE_MODULE_PRESETS)
CREATE OR REPLACE FUNCTION app.role_default_modules(p_role app.member_role)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = 'public', 'app', 'pg_temp'
AS $$
  SELECT CASE p_role
    WHEN 'owner'      THEN ARRAY['dashboard','stock','recipes','revenue','requests','purchases','cmv','finance','dre','analise-mercado','settings','production','transformed','supply','distribution']
    WHEN 'admin'      THEN ARRAY['dashboard','stock','recipes','revenue','requests','purchases','cmv','finance','dre','analise-mercado','settings','production','transformed','supply','distribution']
    WHEN 'manager'    THEN ARRAY['dashboard','stock','recipes','revenue','requests','purchases','cmv','finance','dre','analise-mercado','production','transformed','supply','distribution']
    WHEN 'kitchen'    THEN ARRAY['dashboard','stock','requests','recipes','production']
    WHEN 'stock'      THEN ARRAY['dashboard','stock','requests','purchases','production','supply']
    WHEN 'accountant' THEN ARRAY['dashboard','revenue','cmv','finance','dre']
    WHEN 'viewer'     THEN ARRAY['dashboard']
    ELSE ARRAY['dashboard']
  END;
$$;

-- ---------- 11. GRANTs (CLAUDE.md §5.2 / §5.3) -------------------------------
grant usage on schema app to authenticated, anon, service_role;
grant execute on all functions in schema app to authenticated, anon, service_role;
alter default privileges in schema app
  grant execute on functions to authenticated, anon, service_role;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supply_transfers, public.supply_transfer_items,
  public.supply_item_links, public.supply_requests, public.supply_request_items TO authenticated;
GRANT SELECT ON public.supply_ledger_entries, public.v_supply_balances TO authenticated;
REVOKE SELECT ON public.v_supply_balances FROM anon;

GRANT EXECUTE ON FUNCTION public.supply_network_overview(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_list_catalog(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_ledger_adjust(uuid, uuid, numeric, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.supply_network_overview(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.supply_list_catalog(uuid, uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.supply_ledger_adjust(uuid, uuid, numeric, text) FROM anon, PUBLIC;
