-- =====================================================================
-- Fase A — Módulo Produção & Porcionamento (PRD-PRODUCAO-E-DISTRIBUICAO.md)
--
--  • stock_items.item_kind ('raw'|'transformed') + portion_qty/portion_unit
--  • production_orders / _inputs / _outputs (multi-saída, custo rateado por peso)
--  • production_recipes / _inputs / _outputs (templates de lote)
--  • Transições de status via trigger (padrão kitchen_requests):
--      draft → issued    : baixa dos insumos (out, reference_type='production_order')
--      issued → completed: entrada dos transformados com custo convertido
--      issued → cancelled: movimentos inversos (in) dos insumos
--    Movimentos com reference_type='production_order' NÃO compõem CMV
--    (exclusão feita no front — page-cmv.jsx).
--  • RLS: select por membro; escrita por app.can_access_module(tenant,'production')
--  • Presets de módulos: kitchen/stock ganham 'production' (espelha shell.jsx)
-- =====================================================================

-- ---------- 1. stock_items: tipo do item + porção -------------------
alter table public.stock_items
  add column if not exists item_kind    text not null default 'raw',
  add column if not exists portion_qty  numeric(14,4),
  add column if not exists portion_unit text;

do $$ begin
  alter table public.stock_items
    add constraint stock_items_item_kind_chk check (item_kind in ('raw','transformed'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.stock_items
    add constraint stock_items_portion_qty_chk check (portion_qty is null or portion_qty > 0);
exception when duplicate_object then null; end $$;

create index if not exists stock_items_item_kind_idx
  on public.stock_items (tenant_id, item_kind);

-- O catálogo de transformados vive em stock_items: quem vê o módulo Transformados
-- pode criar/editar itens transformados. Insumos brutos seguem exigindo 'stock'.
drop policy if exists stock_items_write on public.stock_items;
create policy stock_items_write on public.stock_items
  for all using (
    app.can_access_module(tenant_id, 'stock')
    or (item_kind = 'transformed' and app.can_access_module(tenant_id, 'transformed'))
  )
  with check (
    app.can_access_module(tenant_id, 'stock')
    or (item_kind = 'transformed' and app.can_access_module(tenant_id, 'transformed'))
  );

-- ---------- 2. Ordens de produção ------------------------------------
create table if not exists public.production_orders (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  code             text,                                   -- 'PRD-0001' (gerado no front, como REQ)
  status           text not null default 'draft'
                     check (status in ('draft','issued','completed','cancelled')),
  total_input_cost numeric(14,4),                          -- snapshot no issue (Σ line_cost)
  input_weight     numeric(14,4),                          -- Σ inputs em kg (quando conversível)
  output_weight    numeric(14,4),                          -- Σ returned_qty × portion_qty (kg)
  yield_pct        numeric(6,2),                           -- aproveitamento % agregado
  waste_qty        numeric(14,4),                          -- desperdício em kg (entrada − saída)
  notes            text,
  created_by       uuid references auth.users(id) on delete set null,
  issued_at        timestamptz,
  issued_by        uuid references auth.users(id) on delete set null,
  completed_at     timestamptz,
  completed_by     uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, code)
);

create index if not exists production_orders_tenant_idx
  on public.production_orders (tenant_id, created_at desc);
create index if not exists production_orders_status_idx
  on public.production_orders (tenant_id, status);

drop trigger if exists tg_production_orders_updated_at on public.production_orders;
create trigger tg_production_orders_updated_at
  before update on public.production_orders
  for each row execute function app.tg_set_updated_at();

-- Insumos da ordem (unit_cost = snapshot no issue; line_cost gerada — NUNCA
-- gravar custo da linha em unit_cost, ver feedback do bug REQ R$17.666)
create table if not exists public.production_order_inputs (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.production_orders(id) on delete cascade,
  stock_item_id uuid not null references public.stock_items(id),
  display_name  text not null,
  qty           numeric(14,4) not null check (qty > 0),
  unit          text not null,
  unit_cost     numeric(12,4) not null default 0 check (unit_cost >= 0),
  line_cost     numeric(14,4) generated always as (qty * unit_cost) stored,
  sort_order    int not null default 0
);

create index if not exists production_order_inputs_order_idx
  on public.production_order_inputs (order_id);

-- Saídas da ordem (multi-saída; custo rateado por peso no complete)
create table if not exists public.production_order_outputs (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.production_orders(id) on delete cascade,
  stock_item_id uuid not null references public.stock_items(id),
  display_name  text not null,
  expected_qty  numeric(14,4) check (expected_qty is null or expected_qty > 0),
  returned_qty  numeric(14,4) check (returned_qty is null or returned_qty >= 0),
  weight_qty    numeric(14,4),                             -- snapshot no complete
  cost_share    numeric(14,4),                             -- snapshot no complete
  unit_cost     numeric(12,4),                             -- cost_share / returned_qty
  sort_order    int not null default 0
);

create index if not exists production_order_outputs_order_idx
  on public.production_order_outputs (order_id);
create index if not exists production_order_outputs_item_idx
  on public.production_order_outputs (stock_item_id);

-- ---------- 3. Receitas de produção (templates, sem efeito contábil) --
create table if not exists public.production_recipes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists production_recipes_tenant_idx
  on public.production_recipes (tenant_id);

drop trigger if exists tg_production_recipes_updated_at on public.production_recipes;
create trigger tg_production_recipes_updated_at
  before update on public.production_recipes
  for each row execute function app.tg_set_updated_at();

create table if not exists public.production_recipe_inputs (
  id            uuid primary key default gen_random_uuid(),
  recipe_id     uuid not null references public.production_recipes(id) on delete cascade,
  stock_item_id uuid not null references public.stock_items(id) on delete cascade,
  qty           numeric(14,4) not null check (qty > 0),
  unit          text not null,
  sort_order    int not null default 0
);

create index if not exists production_recipe_inputs_recipe_idx
  on public.production_recipe_inputs (recipe_id);

create table if not exists public.production_recipe_outputs (
  id            uuid primary key default gen_random_uuid(),
  recipe_id     uuid not null references public.production_recipes(id) on delete cascade,
  stock_item_id uuid not null references public.stock_items(id) on delete cascade,
  expected_qty  numeric(14,4) check (expected_qty is null or expected_qty > 0),
  sort_order    int not null default 0
);

create index if not exists production_recipe_outputs_recipe_idx
  on public.production_recipe_outputs (recipe_id);

-- ---------- 4. Triggers de coerência ---------------------------------
-- Inputs: item do mesmo tenant; edição só com ordem em draft.
create or replace function app.tg_check_production_input()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
declare
  v_order  record;
  v_item_tenant uuid;
begin
  select tenant_id, status into v_order
    from public.production_orders
   where id = coalesce(new.order_id, old.order_id);
  if v_order is null then
    raise exception 'production_order_inputs: ordem não encontrada';
  end if;
  -- DELETE em cascata da ordem cancelada também passa por aqui
  if tg_op = 'DELETE' and v_order.status in ('draft','cancelled') then
    return old;
  end if;
  if v_order.status <> 'draft' then
    raise exception 'Insumos só podem ser alterados com a ordem em rascunho (status atual: %)', v_order.status;
  end if;
  if tg_op <> 'DELETE' then
    select tenant_id into v_item_tenant from public.stock_items where id = new.stock_item_id;
    if v_item_tenant is null or v_item_tenant <> v_order.tenant_id then
      raise exception 'production_order_inputs: stock_item pertence a outro tenant';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists tg_production_order_inputs_check on public.production_order_inputs;
create trigger tg_production_order_inputs_check
  before insert or update or delete on public.production_order_inputs
  for each row execute function app.tg_check_production_input();

-- Outputs: item transformado do mesmo tenant; estrutura editável só em draft,
-- mas returned_qty pode ser preenchido com a ordem em issued (lançar retorno).
create or replace function app.tg_check_production_output()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
declare
  v_order record;
  v_item  record;
begin
  select tenant_id, status into v_order
    from public.production_orders
   where id = coalesce(new.order_id, old.order_id);
  if v_order is null then
    raise exception 'production_order_outputs: ordem não encontrada';
  end if;

  if tg_op = 'DELETE' then
    -- DELETE em cascata da ordem cancelada também passa por aqui
    if v_order.status not in ('draft','cancelled') then
      raise exception 'Saídas só podem ser removidas com a ordem em rascunho';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' and v_order.status <> 'draft' then
    raise exception 'Saídas só podem ser adicionadas com a ordem em rascunho';
  end if;

  if tg_op = 'UPDATE' then
    if v_order.status = 'draft' then
      null; -- tudo editável
    elsif v_order.status = 'issued' then
      -- Em issued só o retorno (returned_qty) e os snapshots do complete mudam.
      if new.stock_item_id <> old.stock_item_id
         or new.order_id <> old.order_id
         or coalesce(new.expected_qty, -1) <> coalesce(old.expected_qty, -1) then
        raise exception 'Com a ordem enviada à produção, só o retorno pode ser lançado';
      end if;
    else
      raise exception 'Saídas de ordem % não podem ser alteradas', v_order.status;
    end if;
  end if;

  select tenant_id, item_kind into v_item from public.stock_items where id = new.stock_item_id;
  if v_item is null or v_item.tenant_id <> v_order.tenant_id then
    raise exception 'production_order_outputs: stock_item pertence a outro tenant';
  end if;
  if v_item.item_kind <> 'transformed' then
    raise exception 'A saída da produção precisa ser um item transformado (item_kind=transformed)';
  end if;
  return new;
end;
$$;

drop trigger if exists tg_production_order_outputs_check on public.production_order_outputs;
create trigger tg_production_order_outputs_check
  before insert or update or delete on public.production_order_outputs
  for each row execute function app.tg_check_production_output();

-- Receitas: itens do mesmo tenant (inputs e outputs)
create or replace function app.tg_check_production_recipe_item()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
declare
  v_recipe_tenant uuid;
  v_item_tenant   uuid;
begin
  select tenant_id into v_recipe_tenant from public.production_recipes where id = new.recipe_id;
  if v_recipe_tenant is null then
    raise exception 'receita de produção % não encontrada', new.recipe_id;
  end if;
  select tenant_id into v_item_tenant from public.stock_items where id = new.stock_item_id;
  if v_item_tenant is null or v_item_tenant <> v_recipe_tenant then
    raise exception 'item da receita pertence a outro tenant';
  end if;
  return new;
end;
$$;

drop trigger if exists tg_production_recipe_inputs_check on public.production_recipe_inputs;
create trigger tg_production_recipe_inputs_check
  before insert or update on public.production_recipe_inputs
  for each row execute function app.tg_check_production_recipe_item();

drop trigger if exists tg_production_recipe_outputs_check on public.production_recipe_outputs;
create trigger tg_production_recipe_outputs_check
  before insert or update on public.production_recipe_outputs
  for each row execute function app.tg_check_production_recipe_item();

-- ---------- 5. Trigger de transição de status ------------------------
-- Converte peso pra kg quando a unidade permite (kg, g). Retorna null se
-- a unidade não é de massa — aí o aproveitamento fica indefinido.
create or replace function app.production_weight_kg(p_qty numeric, p_unit text)
returns numeric
language sql
immutable
set search_path = 'app','public','pg_temp'
as $$
  select case lower(coalesce(p_unit,''))
    when 'kg' then p_qty
    when 'g'  then p_qty / 1000.0
    else null
  end;
$$;

create or replace function app.tg_production_order_transition()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
declare
  r               record;
  v_total_cost    numeric(14,4) := 0;
  v_input_weight  numeric(14,4);
  v_output_weight numeric(14,4);
  v_w             numeric;
  v_missing       text;
  v_out_count     int;
  v_sum_weight    numeric(14,4);
  v_share         numeric(14,4);
  v_unit_cost     numeric(12,4);
begin
  if tg_op <> 'UPDATE' or new.status = old.status then
    return new;
  end if;

  -- Transições válidas
  if not (
       (old.status = 'draft'  and new.status in ('issued','cancelled'))
    or (old.status = 'issued' and new.status in ('completed','cancelled'))
  ) then
    raise exception 'Transição de status inválida: % → %', old.status, new.status;
  end if;

  -- ===== draft → issued: snapshot de custos + baixa dos insumos =====
  if new.status = 'issued' then
    select count(*) into v_out_count from public.production_order_outputs where order_id = new.id;
    if v_out_count = 0 then
      raise exception 'A ordem precisa de pelo menos um transformado de saída';
    end if;
    if not exists (select 1 from public.production_order_inputs where order_id = new.id) then
      raise exception 'A ordem precisa de pelo menos um insumo';
    end if;

    -- Multi-saída exige portion_qty em todos os transformados (rateio por peso)
    if v_out_count > 1 then
      select string_agg(si.name, ', ') into v_missing
        from public.production_order_outputs po
        join public.stock_items si on si.id = po.stock_item_id
       where po.order_id = new.id
         and (si.portion_qty is null or si.portion_qty <= 0);
      if v_missing is not null then
        raise exception 'Ordem com várias saídas exige porção definida em todos os transformados. Sem porção: %', v_missing;
      end if;
    end if;

    v_input_weight := 0;
    for r in
      select pi.id, pi.stock_item_id, pi.qty, pi.unit, si.name, si.unit_cost as cost_now, si.current_qty
        from public.production_order_inputs pi
        join public.stock_items si on si.id = pi.stock_item_id
       where pi.order_id = new.id
    loop
      if r.current_qty < r.qty then
        raise exception 'Saldo insuficiente de "%" (disponível %, necessário %)', r.name, r.current_qty, r.qty;
      end if;
      -- Snapshot do custo atual (última compra)
      update public.production_order_inputs
         set unit_cost = round(coalesce(r.cost_now, 0), 4)
       where id = r.id;
      v_total_cost := v_total_cost + round(r.qty * coalesce(r.cost_now, 0), 4);

      v_w := app.production_weight_kg(r.qty, r.unit);
      if v_w is not null and v_input_weight is not null then
        v_input_weight := v_input_weight + v_w;
      else
        v_input_weight := null; -- alguma unidade não-mássica → peso indefinido
      end if;

      insert into public.stock_movements
        (tenant_id, stock_item_id, kind, qty, unit_cost, notes, reference_type, reference_id, performed_by)
      values
        (new.tenant_id, r.stock_item_id, 'out', -r.qty, round(coalesce(r.cost_now,0),4),
         'Produção ' || coalesce(new.code, new.id::text),
         'production_order', new.id, coalesce(new.issued_by, auth.uid()));
    end loop;

    new.total_input_cost := v_total_cost;
    new.input_weight     := v_input_weight;
    if new.issued_at is null then new.issued_at := now(); end if;
    if new.issued_by is null then new.issued_by := auth.uid(); end if;
    return new;
  end if;

  -- ===== issued → completed: rateio por peso + entrada dos transformados =====
  if new.status = 'completed' then
    select count(*) into v_out_count from public.production_order_outputs where order_id = new.id;

    -- Peso devolvido por saída (returned_qty × portion_qty, em kg)
    select sum(app.production_weight_kg(po.returned_qty * si.portion_qty, coalesce(si.portion_unit,'kg')))
      into v_sum_weight
      from public.production_order_outputs po
      join public.stock_items si on si.id = po.stock_item_id
     where po.order_id = new.id
       and coalesce(po.returned_qty, 0) > 0;

    if not exists (
      select 1 from public.production_order_outputs
       where order_id = new.id and coalesce(returned_qty, 0) > 0
    ) then
      raise exception 'Informe as porções devolvidas de pelo menos uma saída';
    end if;

    if v_out_count > 1 and coalesce(v_sum_weight, 0) <= 0 then
      raise exception 'Rateio por peso indisponível — confira a porção dos transformados';
    end if;

    v_output_weight := 0;
    for r in
      select po.id, po.stock_item_id, po.returned_qty, si.name, si.portion_qty, si.portion_unit
        from public.production_order_outputs po
        join public.stock_items si on si.id = po.stock_item_id
       where po.order_id = new.id
    loop
      if coalesce(r.returned_qty, 0) <= 0 then
        -- Saída sem retorno: zera snapshots e não gera movimento
        update public.production_order_outputs
           set weight_qty = null, cost_share = 0, unit_cost = null
         where id = r.id;
        continue;
      end if;

      v_w := case when r.portion_qty is not null
                  then app.production_weight_kg(r.returned_qty * r.portion_qty, coalesce(r.portion_unit,'kg'))
                  else null end;
      -- Multi-saída sem peso conversível numa saída devolvida → rateio impossível
      if v_out_count > 1 and v_w is null then
        raise exception 'Rateio por peso: a porção de "%" precisa estar em kg ou g', r.name;
      end if;
      if v_w is not null and v_output_weight is not null then
        v_output_weight := v_output_weight + v_w;
      elsif v_w is null then
        v_output_weight := null;
      end if;

      -- Rateio: saída única leva 100%; multi-saída rateia por peso
      if v_out_count = 1 then
        v_share := coalesce(new.total_input_cost, 0);
      else
        v_share := round(coalesce(new.total_input_cost, 0) * v_w / v_sum_weight, 4);
      end if;
      v_unit_cost := case when r.returned_qty > 0 then round(v_share / r.returned_qty, 4) else null end;

      update public.production_order_outputs
         set weight_qty = v_w, cost_share = v_share, unit_cost = v_unit_cost
       where id = r.id;

      insert into public.stock_movements
        (tenant_id, stock_item_id, kind, qty, unit_cost, notes, reference_type, reference_id, performed_by)
      values
        (new.tenant_id, r.stock_item_id, 'in', r.returned_qty, v_unit_cost,
         'Retorno produção ' || coalesce(new.code, new.id::text),
         'production_order', new.id, coalesce(new.completed_by, auth.uid()));
    end loop;

    new.output_weight := v_output_weight;
    if new.input_weight is not null and new.input_weight > 0 and v_output_weight is not null then
      new.yield_pct := round((v_output_weight / new.input_weight) * 100, 2);
      new.waste_qty := greatest(new.input_weight - v_output_weight, 0);
    end if;
    if new.completed_at is null then new.completed_at := now(); end if;
    if new.completed_by is null then new.completed_by := auth.uid(); end if;
    return new;
  end if;

  -- ===== cancelamento =====
  if new.status = 'cancelled' then
    if old.status = 'issued' then
      -- Movimentos imutáveis: cancelar = movimentos inversos (in) dos insumos
      for r in
        select stock_item_id, qty, unit_cost
          from public.production_order_inputs
         where order_id = new.id
      loop
        insert into public.stock_movements
          (tenant_id, stock_item_id, kind, qty, unit_cost, notes, reference_type, reference_id, performed_by)
        values
          (new.tenant_id, r.stock_item_id, 'in', r.qty, r.unit_cost,
           'Cancelamento produção ' || coalesce(new.code, new.id::text),
           'production_order', new.id, auth.uid());
      end loop;
    end if;
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists tg_production_orders_transition on public.production_orders;
create trigger tg_production_orders_transition
  before update on public.production_orders
  for each row execute function app.tg_production_order_transition();

-- Ordem só pode ser excluída em rascunho ou cancelada sem movimentos
create or replace function app.tg_block_production_order_delete()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
begin
  if old.status not in ('draft','cancelled') then
    raise exception 'Ordem % não pode ser excluída (status %). Cancele antes.', coalesce(old.code, old.id::text), old.status;
  end if;
  return old;
end;
$$;

drop trigger if exists tg_production_orders_block_delete on public.production_orders;
create trigger tg_production_orders_block_delete
  before delete on public.production_orders
  for each row execute function app.tg_block_production_order_delete();

-- ---------- 6. RLS ----------------------------------------------------
alter table public.production_orders         enable row level security;
alter table public.production_order_inputs   enable row level security;
alter table public.production_order_outputs  enable row level security;
alter table public.production_recipes        enable row level security;
alter table public.production_recipe_inputs  enable row level security;
alter table public.production_recipe_outputs enable row level security;

drop policy if exists production_orders_select on public.production_orders;
create policy production_orders_select on public.production_orders
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists production_orders_write on public.production_orders;
create policy production_orders_write on public.production_orders
  for all using (app.can_access_module(tenant_id, 'production'))
  with check    (app.can_access_module(tenant_id, 'production'));

drop policy if exists production_order_inputs_select on public.production_order_inputs;
create policy production_order_inputs_select on public.production_order_inputs
  for select using (exists (select 1 from public.production_orders po
      where po.id = production_order_inputs.order_id and app.is_tenant_member(po.tenant_id)));

drop policy if exists production_order_inputs_write on public.production_order_inputs;
create policy production_order_inputs_write on public.production_order_inputs
  for all using (exists (select 1 from public.production_orders po
      where po.id = production_order_inputs.order_id and app.can_access_module(po.tenant_id, 'production')))
  with check (exists (select 1 from public.production_orders po
      where po.id = production_order_inputs.order_id and app.can_access_module(po.tenant_id, 'production')));

drop policy if exists production_order_outputs_select on public.production_order_outputs;
create policy production_order_outputs_select on public.production_order_outputs
  for select using (exists (select 1 from public.production_orders po
      where po.id = production_order_outputs.order_id and app.is_tenant_member(po.tenant_id)));

drop policy if exists production_order_outputs_write on public.production_order_outputs;
create policy production_order_outputs_write on public.production_order_outputs
  for all using (exists (select 1 from public.production_orders po
      where po.id = production_order_outputs.order_id and app.can_access_module(po.tenant_id, 'production')))
  with check (exists (select 1 from public.production_orders po
      where po.id = production_order_outputs.order_id and app.can_access_module(po.tenant_id, 'production')));

drop policy if exists production_recipes_select on public.production_recipes;
create policy production_recipes_select on public.production_recipes
  for select using (app.is_tenant_member(tenant_id));

drop policy if exists production_recipes_write on public.production_recipes;
create policy production_recipes_write on public.production_recipes
  for all using (app.can_access_module(tenant_id, 'transformed'))
  with check    (app.can_access_module(tenant_id, 'transformed'));

drop policy if exists production_recipe_inputs_select on public.production_recipe_inputs;
create policy production_recipe_inputs_select on public.production_recipe_inputs
  for select using (exists (select 1 from public.production_recipes pr
      where pr.id = production_recipe_inputs.recipe_id and app.is_tenant_member(pr.tenant_id)));

drop policy if exists production_recipe_inputs_write on public.production_recipe_inputs;
create policy production_recipe_inputs_write on public.production_recipe_inputs
  for all using (exists (select 1 from public.production_recipes pr
      where pr.id = production_recipe_inputs.recipe_id and app.can_access_module(pr.tenant_id, 'transformed')))
  with check (exists (select 1 from public.production_recipes pr
      where pr.id = production_recipe_inputs.recipe_id and app.can_access_module(pr.tenant_id, 'transformed')));

drop policy if exists production_recipe_outputs_select on public.production_recipe_outputs;
create policy production_recipe_outputs_select on public.production_recipe_outputs
  for select using (exists (select 1 from public.production_recipes pr
      where pr.id = production_recipe_outputs.recipe_id and app.is_tenant_member(pr.tenant_id)));

drop policy if exists production_recipe_outputs_write on public.production_recipe_outputs;
create policy production_recipe_outputs_write on public.production_recipe_outputs
  for all using (exists (select 1 from public.production_recipes pr
      where pr.id = production_recipe_outputs.recipe_id and app.can_access_module(pr.tenant_id, 'transformed')))
  with check (exists (select 1 from public.production_recipes pr
      where pr.id = production_recipe_outputs.recipe_id and app.can_access_module(pr.tenant_id, 'transformed')));

-- ---------- 7. Presets de módulos por papel ---------------------------
-- Espelha ROLE_DEFAULT_MODULES (shell.jsx) e ROLE_MODULE_PRESETS (page-settings.jsx):
-- kitchen e stock ganham 'production'. 'transformed' segue os módulos de gestão
-- (owner/admin/manager veem tudo pela regra do can_access_module).
CREATE OR REPLACE FUNCTION app.role_default_modules(p_role app.member_role)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = 'public', 'app', 'pg_temp'
AS $$
  SELECT CASE p_role
    WHEN 'owner'      THEN ARRAY['dashboard','stock','recipes','revenue','requests','purchases','cmv','finance','dre','analise-mercado','settings','production','transformed']
    WHEN 'admin'      THEN ARRAY['dashboard','stock','recipes','revenue','requests','purchases','cmv','finance','dre','analise-mercado','settings','production','transformed']
    WHEN 'manager'    THEN ARRAY['dashboard','stock','recipes','revenue','requests','purchases','cmv','finance','dre','analise-mercado','production','transformed']
    WHEN 'kitchen'    THEN ARRAY['dashboard','stock','requests','recipes','production']
    WHEN 'stock'      THEN ARRAY['dashboard','stock','requests','purchases','production']
    WHEN 'accountant' THEN ARRAY['dashboard','revenue','cmv','finance','dre']
    WHEN 'viewer'     THEN ARRAY['dashboard']
    ELSE ARRAY['dashboard']
  END;
$$;

-- ---------- 8. GRANTs (CLAUDE.md §5.2 / §5.3) --------------------------
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

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.production_orders,
  public.production_order_inputs,
  public.production_order_outputs,
  public.production_recipes,
  public.production_recipe_inputs,
  public.production_recipe_outputs
TO authenticated;
