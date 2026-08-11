-- =====================================================================
-- Cadeia de suprimentos · catálogo de abastecimento por unidade
-- (evolução de 20260711140000_supply_transfers)
--
--  • A central cadastra QUAIS itens cada unidade recebe. O item é criado
--    automaticamente no estoque da unidade (ou vinculado ao equivalente já
--    existente por nome+unidade) e passa a ser "gerido pela central":
--    mín/máx/auto ficam sob controle da central (stock_items.managed_by_central_id
--    + trigger de guarda que bloqueia a edição pela unidade).
--  • supply_item_links ganha is_assortment — a mesma linha que mapeia
--    "item da central → item da unidade" nas transferências passa a marcar
--    o vínculo deliberado do catálogo.
--  • RPCs de leitura (SECURITY DEFINER, cross-tenant): visão de unidades,
--    catálogo/estoque de uma unidade e lista de reposição da rede — mesma
--    lógica da lista de compras (abaixo do mín → repõe até o máx), descontando
--    o que já está em trânsito.
--  • RPCs de escrita: add/set/remove do catálogo, só p/ gestor da central.
-- =====================================================================

-- ---------- 1. Colunas -------------------------------------------------
alter table public.supply_item_links
  add column if not exists is_assortment boolean not null default false,
  add column if not exists added_by      uuid references auth.users(id) on delete set null;

alter table public.stock_items
  add column if not exists managed_by_central_id uuid references public.tenants(id) on delete set null;

create index if not exists stock_items_managed_central_idx
  on public.stock_items (managed_by_central_id)
  where managed_by_central_id is not null;

comment on column public.stock_items.managed_by_central_id is
  'Central de distribuição que gerencia mín/máx/auto deste item (catálogo de abastecimento). NULL = item próprio da unidade.';

-- ---------- 2. Guarda: mín/máx de item do catálogo é da central ---------
-- Só o gestor da central (ou efeitos internos do banco, ex.: compute_auto_min_max
-- disparado por movimentação) mudam reorder_point/max_qty/auto_min_*.
create or replace function app.tg_stock_item_central_guard()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
declare
  v_central uuid := coalesce(old.managed_by_central_id, new.managed_by_central_id);
begin
  if v_central is null then
    return new;
  end if;
  -- Updates disparados de dentro de outro trigger (recálculo automático) passam.
  if pg_trigger_depth() > 1 or auth.role() = 'service_role' then
    return new;
  end if;
  -- Gestor da central pode tudo, inclusive assumir/soltar a gestão do item.
  if app.supply_is_manager(v_central) then
    return new;
  end if;
  if new.managed_by_central_id is distinct from old.managed_by_central_id then
    raise exception 'só a central da rede pode alterar a gestão de "%"', old.name;
  end if;
  if new.reorder_point   is distinct from old.reorder_point
     or new.max_qty      is distinct from old.max_qty
     or new.auto_min_mode is distinct from old.auto_min_mode
     or new.auto_min_enabled is distinct from old.auto_min_enabled then
    raise exception 'mín/máx de "%" é gerido pela central da rede de suprimentos', old.name;
  end if;
  return new;
end;
$$;

drop trigger if exists tg_stock_items_central_guard on public.stock_items;
create trigger tg_stock_items_central_guard
  before update on public.stock_items
  for each row execute function app.tg_stock_item_central_guard();

-- ---------- 3. Helper: unidade ativa na rede da central -----------------
create or replace function app.supply_unit_ok(p_central uuid, p_unit uuid)
returns boolean
language sql
stable
security definer
set search_path = 'app','public','pg_temp'
as $$
  select exists (
    select 1 from public.supply_members sm
     where sm.central_tenant_id = p_central
       and sm.member_tenant_id  = p_unit
       and sm.status = 'active'
  );
$$;

-- Valida chamador + central + unidade. Levanta exceção; usada por todas as RPCs.
create or replace function app.supply_assert_central(p_central uuid, p_unit uuid default null)
returns void
language plpgsql
stable
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
  if not exists (select 1 from public.tenants t
                  where t.id = p_central and t.kind = 'distribution_center') then
    raise exception 'tenant % não é uma central de distribuição', p_central;
  end if;
  if p_unit is not null and not app.supply_unit_ok(p_central, p_unit) then
    raise exception 'unidade não participa (ativa) da rede desta central';
  end if;
end;
$$;

-- ---------- 4. Escrita do catálogo --------------------------------------
-- p_items: [{ "centralItemId": uuid, "min": num, "max": num, "autoMode": text }]
-- Cria/vincula o item no estoque da unidade e aplica os parâmetros.
create or replace function public.supply_assortment_add(
  p_central uuid, p_unit uuid, p_items jsonb
) returns integer
language plpgsql
volatile
security definer
set search_path = 'app','public','pg_temp'
as $$
declare
  r         jsonb;
  v_src     record;
  v_item    uuid;
  v_cat     uuid;
  v_mode    text;
  v_min     numeric;
  v_max     numeric;
  v_count   int := 0;
begin
  perform app.supply_assert_central(p_central, p_unit);
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'lista de itens inválida';
  end if;

  for r in select t.value from jsonb_array_elements(p_items) as t(value)
  loop
    select si.id, si.name, si.unit, si.unit_cost, si.item_kind,
           si.portion_qty, si.portion_unit, sc.name as category_name
      into v_src
      from public.stock_items si
      left join public.stock_categories sc on sc.id = si.category_id
     where si.id = (r->>'centralItemId')::uuid
       and si.tenant_id = p_central
       and si.is_active;
    if v_src.id is null then
      raise exception 'item % não pertence ao estoque da central', r->>'centralItemId';
    end if;

    v_mode := coalesce(nullif(r->>'autoMode',''), 'off');
    if v_mode not in ('off','weekly','monthly') then v_mode := 'off'; end if;
    v_min := greatest(coalesce((r->>'min')::numeric, 0), 0);
    v_max := nullif((r->>'max')::numeric, 0);

    -- 1) vínculo já memorizado (catálogo ou transferência anterior)
    v_item := null;
    select l.to_item_id into v_item
      from public.supply_item_links l
      join public.stock_items si on si.id = l.to_item_id and si.is_active
     where l.central_tenant_id = p_central
       and l.from_item_id      = v_src.id
       and l.to_tenant_id      = p_unit;

    -- 2) equivalente por nome + unidade no estoque da unidade
    if v_item is null then
      select si.id into v_item
        from public.stock_items si
       where si.tenant_id = p_unit
         and si.is_active
         and lower(trim(si.name)) = lower(trim(v_src.name))
         and si.unit = v_src.unit
       order by si.created_at
       limit 1;
    end if;

    -- 3) cria na unidade (espelhando categoria por nome)
    if v_item is null then
      v_cat := null;
      if v_src.category_name is not null then
        select id into v_cat from public.stock_categories
         where tenant_id = p_unit and lower(trim(name)) = lower(trim(v_src.category_name))
         limit 1;
        if v_cat is null then
          insert into public.stock_categories (tenant_id, name)
          values (p_unit, v_src.category_name)
          on conflict (tenant_id, name) do nothing
          returning id into v_cat;
          if v_cat is null then
            select id into v_cat from public.stock_categories
             where tenant_id = p_unit and name = v_src.category_name limit 1;
          end if;
        end if;
      end if;

      insert into public.stock_items
        (tenant_id, name, unit, unit_cost, current_qty, item_kind,
         portion_qty, portion_unit, category_id)
      values
        (p_unit, v_src.name, v_src.unit, v_src.unit_cost, 0, coalesce(v_src.item_kind,'raw'),
         v_src.portion_qty, v_src.portion_unit, v_cat)
      returning id into v_item;
    end if;

    update public.stock_items
       set reorder_point         = v_min,
           max_qty               = v_max,
           auto_min_mode         = v_mode,
           auto_min_enabled      = (v_mode <> 'off'),
           managed_by_central_id = p_central
     where id = v_item;

    insert into public.supply_item_links
      (central_tenant_id, from_item_id, to_tenant_id, to_item_id, is_assortment, added_by)
    values (p_central, v_src.id, p_unit, v_item, true, auth.uid())
    on conflict (central_tenant_id, from_item_id, to_tenant_id) do update
      set to_item_id    = excluded.to_item_id,
          is_assortment = true,
          added_by      = coalesce(supply_item_links.added_by, excluded.added_by),
          updated_at    = now();

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Ajusta mín/máx/modo automático de um item do catálogo (estoque da unidade).
create or replace function public.supply_assortment_set(
  p_central uuid, p_unit uuid, p_unit_item uuid,
  p_min numeric, p_max numeric, p_auto_mode text
) returns void
language plpgsql
volatile
security definer
set search_path = 'app','public','pg_temp'
as $$
declare
  v_mode text := coalesce(nullif(p_auto_mode,''), 'off');
begin
  perform app.supply_assert_central(p_central, p_unit);
  if v_mode not in ('off','weekly','monthly') then
    raise exception 'modo de cálculo automático inválido: %', p_auto_mode;
  end if;
  if not exists (
    select 1 from public.supply_item_links l
     where l.central_tenant_id = p_central
       and l.to_tenant_id      = p_unit
       and l.to_item_id        = p_unit_item
       and l.is_assortment
  ) then
    raise exception 'item não faz parte do catálogo desta unidade';
  end if;

  update public.stock_items
     set reorder_point    = greatest(coalesce(p_min, 0), 0),
         max_qty          = nullif(p_max, 0),
         auto_min_mode    = v_mode,
         auto_min_enabled = (v_mode <> 'off'),
         managed_by_central_id = p_central
   where id = p_unit_item and tenant_id = p_unit;
  if not found then
    raise exception 'item não encontrado no estoque da unidade';
  end if;
end;
$$;

-- Tira do catálogo: o item continua no estoque da unidade (com o saldo dele),
-- mas volta a ser gerido localmente. O vínculo de mapeamento é preservado.
create or replace function public.supply_assortment_remove(
  p_central uuid, p_unit uuid, p_unit_item uuid
) returns void
language plpgsql
volatile
security definer
set search_path = 'app','public','pg_temp'
as $$
begin
  perform app.supply_assert_central(p_central, p_unit);
  update public.supply_item_links
     set is_assortment = false, updated_at = now()
   where central_tenant_id = p_central
     and to_tenant_id      = p_unit
     and to_item_id        = p_unit_item;
  update public.stock_items
     set managed_by_central_id = null
   where id = p_unit_item and tenant_id = p_unit;
end;
$$;

-- ---------- 5. Leitura: catálogo + estoque de uma unidade ---------------
create or replace function public.supply_unit_assortment(p_central uuid, p_unit uuid)
returns table (
  unit_item_id    uuid,
  central_item_id uuid,
  name            text,
  unit            text,
  item_kind       text,
  category_name   text,
  is_active       boolean,
  current_qty     numeric,
  reorder_point   numeric,
  max_qty         numeric,
  auto_min_mode   text,
  unit_cost       numeric,
  usage30d        numeric,
  in_transit_qty  numeric,
  central_qty     numeric,
  central_cost    numeric,
  last_received_at timestamptz
)
language plpgsql
stable
security definer
set search_path = 'app','public','pg_temp'
as $$
begin
  perform app.supply_assert_central(p_central, p_unit);
  return query
    select
      ui.id, ci.id, ui.name::text, ui.unit::text, ui.item_kind::text, sc.name::text,
      ui.is_active,
      ui.current_qty, ui.reorder_point, ui.max_qty, ui.auto_min_mode::text, ui.unit_cost,
      coalesce((select sum(abs(m.qty)) from public.stock_movements m
                 where m.stock_item_id = ui.id and m.kind = 'out'
                   and m.performed_at >= now() - interval '30 days'), 0),
      coalesce((select sum(ti.qty)
                  from public.supply_transfer_items ti
                  join public.supply_transfers st on st.id = ti.transfer_id
                 where st.status = 'sent'
                   and st.central_tenant_id = p_central
                   and st.to_tenant_id = p_unit
                   and ti.from_item_id = ci.id), 0),
      ci.current_qty, ci.unit_cost,
      (select max(m.performed_at) from public.stock_movements m
        where m.stock_item_id = ui.id and m.kind = 'in'
          and m.reference_type = 'supply_transfer')
    from public.supply_item_links l
    join public.stock_items ui on ui.id = l.to_item_id
    join public.stock_items ci on ci.id = l.from_item_id
    left join public.stock_categories sc on sc.id = ui.category_id
   where l.central_tenant_id = p_central
     and l.to_tenant_id      = p_unit
     and l.is_assortment
   order by ui.name;
end;
$$;

-- ---------- 6. Leitura: painel de unidades ------------------------------
create or replace function public.supply_units_summary(p_central uuid)
returns table (
  unit_tenant_id   uuid,
  name             text,
  items_count      int,
  out_count        int,
  below_count      int,
  ok_count         int,
  stock_value      numeric,
  coverage_days    numeric,   -- mediana dos dias de cobertura
  soonest_days     numeric,   -- item que rompe primeiro
  in_transit       int,       -- transferências enviadas e não recebidas
  pending_requests int,
  last_transfer_at timestamptz,
  spend30d         numeric,
  balance          numeric
)
language plpgsql
stable
security definer
set search_path = 'app','public','pg_temp'
as $$
begin
  perform app.supply_assert_central(p_central);
  return query
  with units as (
    select sm.member_tenant_id as tid, t.name::text as tname
      from public.supply_members sm
      join public.tenants t on t.id = sm.member_tenant_id
     where sm.central_tenant_id = p_central and sm.status = 'active'
  ),
  items as (
    select u.tid,
           ui.current_qty as qty,
           ui.reorder_point as reorder,
           ui.current_qty * ui.unit_cost as value,
           case when coalesce((select sum(abs(m.qty)) from public.stock_movements m
                                where m.stock_item_id = ui.id and m.kind = 'out'
                                  and m.performed_at >= now() - interval '30 days'), 0) > 0
                then ui.current_qty / (
                     (select sum(abs(m.qty)) from public.stock_movements m
                       where m.stock_item_id = ui.id and m.kind = 'out'
                         and m.performed_at >= now() - interval '30 days') / 30.0)
                else null end as days
      from units u
      join public.supply_item_links l
        on l.central_tenant_id = p_central and l.to_tenant_id = u.tid and l.is_assortment
      join public.stock_items ui on ui.id = l.to_item_id and ui.is_active
  )
  select
    u.tid, u.tname,
    coalesce((select count(*)::int from items i where i.tid = u.tid), 0),
    coalesce((select count(*)::int from items i where i.tid = u.tid and i.qty <= 0), 0),
    coalesce((select count(*)::int from items i where i.tid = u.tid and i.qty > 0 and i.qty < i.reorder), 0),
    coalesce((select count(*)::int from items i where i.tid = u.tid and i.qty >= i.reorder and i.qty > 0), 0),
    coalesce((select sum(i.value) from items i where i.tid = u.tid), 0),
    (select percentile_cont(0.5) within group (order by i.days::double precision)
       from items i where i.tid = u.tid and i.days is not null)::numeric,
    (select min(i.days) from items i where i.tid = u.tid and i.days is not null)::numeric,
    coalesce((select count(*)::int from public.supply_transfers st
               where st.central_tenant_id = p_central and st.to_tenant_id = u.tid
                 and st.status = 'sent'), 0),
    coalesce((select count(*)::int from public.supply_requests sr
               where sr.central_tenant_id = p_central and sr.requester_tenant_id = u.tid
                 and sr.status = 'pending'), 0),
    (select max(st.sent_at) from public.supply_transfers st
      where st.central_tenant_id = p_central and st.to_tenant_id = u.tid and st.sent_at is not null),
    coalesce((select sum(le.delta) from public.supply_ledger_entries le
               where le.central_tenant_id = p_central and le.tenant_id = u.tid
                 and le.delta > 0 and le.created_at >= now() - interval '30 days'), 0),
    coalesce((select sum(le.delta) from public.supply_ledger_entries le
               where le.central_tenant_id = p_central and le.tenant_id = u.tid), 0)
  from units u
  order by u.tname;
end;
$$;

-- ---------- 7. Leitura: reposição automática ----------------------------
-- Mesma regra da lista de compras: entra quem está abaixo do mínimo, sugerindo
-- o suficiente p/ chegar ao máximo. Desconta o que já está em trânsito p/ não
-- mandar duas vezes, e mostra o saldo da central p/ sinalizar o que não dá.
create or replace function public.supply_replenishment(p_central uuid, p_unit uuid default null)
returns table (
  unit_tenant_id  uuid,
  unit_name       text,
  unit_item_id    uuid,
  central_item_id uuid,
  name            text,
  unit            text,
  current_qty     numeric,
  reorder_point   numeric,
  max_qty         numeric,
  in_transit_qty  numeric,
  suggested_qty   numeric,
  central_qty     numeric,
  central_cost    numeric,
  usage30d        numeric,
  coverage_days   numeric
)
language plpgsql
stable
security definer
set search_path = 'app','public','pg_temp'
as $$
begin
  perform app.supply_assert_central(p_central, p_unit);
  return query
  with rows_ as (
    select
      u.id as tid, u.name::text as tname,
      ui.id as uiid, ci.id as ciid, ui.name::text as iname, ui.unit::text as iunit,
      ui.current_qty as qty, ui.reorder_point as reorder, ui.max_qty as maxq,
      ci.current_qty as cqty, ci.unit_cost as ccost,
      coalesce((select sum(abs(m.qty)) from public.stock_movements m
                 where m.stock_item_id = ui.id and m.kind = 'out'
                   and m.performed_at >= now() - interval '30 days'), 0) as use30,
      coalesce((select sum(ti.qty)
                  from public.supply_transfer_items ti
                  join public.supply_transfers st on st.id = ti.transfer_id
                 where st.status = 'sent'
                   and st.central_tenant_id = p_central
                   and st.to_tenant_id = u.id
                   and ti.from_item_id = ci.id), 0) as transit
      from public.supply_members sm
      join public.tenants u on u.id = sm.member_tenant_id
      join public.supply_item_links l
        on l.central_tenant_id = p_central and l.to_tenant_id = u.id and l.is_assortment
      join public.stock_items ui on ui.id = l.to_item_id and ui.is_active
      join public.stock_items ci on ci.id = l.from_item_id
     where sm.central_tenant_id = p_central
       and sm.status = 'active'
       and (p_unit is null or u.id = p_unit)
  )
  select
    r.tid, r.tname, r.uiid, r.ciid, r.iname, r.iunit,
    r.qty, r.reorder, r.maxq, r.transit,
    round(greatest(coalesce(nullif(r.maxq, 0), r.reorder * 2) - r.qty - r.transit, 0), 3),
    r.cqty, r.ccost, r.use30,
    case when r.use30 > 0 then round(r.qty / (r.use30 / 30.0), 1) else null end
  from rows_ r
  where r.reorder > 0
    and (r.qty + r.transit) < r.reorder
    and greatest(coalesce(nullif(r.maxq, 0), r.reorder * 2) - r.qty - r.transit, 0) > 0
  order by r.tname, (r.qty / nullif(r.reorder, 0)) nulls last, r.iname;
end;
$$;

-- ---------- 8. GRANTs (CLAUDE.md §5.2 / §5.3) ---------------------------
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

GRANT EXECUTE ON FUNCTION public.supply_assortment_add(uuid, uuid, jsonb)                       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_assortment_set(uuid, uuid, uuid, numeric, numeric, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_assortment_remove(uuid, uuid, uuid)                      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_unit_assortment(uuid, uuid)                              TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_units_summary(uuid)                                      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_replenishment(uuid, uuid)                                TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.supply_assortment_add(uuid, uuid, jsonb)                       FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.supply_assortment_set(uuid, uuid, uuid, numeric, numeric, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.supply_assortment_remove(uuid, uuid, uuid)                      FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.supply_unit_assortment(uuid, uuid)                              FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.supply_units_summary(uuid)                                      FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.supply_replenishment(uuid, uuid)                                FROM anon, PUBLIC;
