-- ============================================================================
-- Cardápio · normalização de nome + apelidos (de-para) entre origens
-- ----------------------------------------------------------------------------
-- SAIPOS e CARDAPIO_WEB às vezes nomeiam o MESMO item diferente
-- ("Pizzas Grandes - 2 Sabores" vs "Pizza Grande - Dois Sabores"; espaço/acento).
-- (1) agz_norm(): normaliza p/ casar variações triviais (caixa, espaço, acento).
-- (2) agilizone_item_aliases: de-para manual from_name→to_name p/ os que diferem
--     de verdade (combos/sinônimos). A RPC resolve o apelido, depois normaliza e
--     agrupa; assim as unidades sem preço (SAIPOS) herdam o preço do item canônico.
-- ============================================================================

-- (1) normalização: trim + collapse espaços + lower + remove acentos PT-BR
create or replace function public.agz_norm(p text)
returns text
language sql
immutable
set search_path = 'public','pg_temp'
as $$
  select translate(
    lower(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g')),
    'áàâãäéèêëíìîïóòôõöúùûüç',
    'aaaaaeeeeiiiiooooouuuuc'
  );
$$;

-- (2) tabela de apelidos (de-para por tenant)
create table if not exists public.agilizone_item_aliases (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  from_name  text not null,        -- nome como vem da origem (ex.: SAIPOS)
  to_name    text not null,        -- nome canônico (geralmente o do CARDAPIO_WEB)
  created_at timestamptz not null default now(),
  unique (tenant_id, from_name)
);
create index if not exists agilizone_item_aliases_tenant_idx
  on public.agilizone_item_aliases (tenant_id);

alter table public.agilizone_item_aliases enable row level security;

drop policy if exists agilizone_item_aliases_read on public.agilizone_item_aliases;
create policy agilizone_item_aliases_read on public.agilizone_item_aliases
  for select using (app.is_member(tenant_id));

drop policy if exists agilizone_item_aliases_write on public.agilizone_item_aliases;
create policy agilizone_item_aliases_write on public.agilizone_item_aliases
  for all using (app.is_admin_or_manager(tenant_id))
  with check (app.is_admin_or_manager(tenant_id));

grant select, insert, update, delete on public.agilizone_item_aliases to authenticated;
grant all on public.agilizone_item_aliases to service_role;

-- (3) RPC: resolve apelido → normaliza → agrupa → valora pelas vendas com preço
create or replace function public.agilizone_menu_sales(
  p_tenant uuid, p_from date, p_to date, p_operation uuid default null
)
returns table (
  name text, external_code text, lines bigint, qty numeric, total numeric, avg_price numeric
)
language sql
stable
security invoker
set search_path = 'public','pg_temp'
as $$
  with src as (
    select i.name, i.external_code, i.quantity, i.total_price, o.tenant_id
    from public.agilizone_order_items i
    join public.agilizone_orders o on o.id = i.order_id
    where o.tenant_id = p_tenant
      and o.business_date between p_from and p_to
      and o.status not in ('CANCELED','PENDING_PAYMENT')
      and o.operation_id is not null
      and (p_operation is null or o.operation_id = p_operation)
  ),
  resolved as (
    select s.external_code, s.quantity, s.total_price,
           coalesce(al.to_name, s.name) as canon
    from src s
    left join public.agilizone_item_aliases al
      on al.tenant_id = s.tenant_id
     and public.agz_norm(al.from_name) = public.agz_norm(s.name)
  ),
  agg as (
    select
      public.agz_norm(canon) as key,
      (array_agg(canon order by (case when coalesce(total_price,0) > 0 then 0 else 1 end), canon))[1] as name,
      max(external_code)                                            as external_code,
      count(*)                                                      as lines,
      sum(quantity)                                                 as qty,
      sum(quantity) filter (where coalesce(total_price,0) > 0)      as priced_qty,
      sum(coalesce(total_price,0)) filter (where coalesce(total_price,0) > 0) as priced_total
    from resolved
    group by 1
  ),
  val as (
    select name, external_code, lines, qty,
      round(
        coalesce(priced_total,0)
        + coalesce(priced_total / nullif(priced_qty,0), 0) * (coalesce(qty,0) - coalesce(priced_qty,0))
      , 2) as total
    from agg
  )
  select name, external_code, lines, qty, total,
    case when coalesce(qty,0) > 0 then round(total / qty, 2) end as avg_price
  from val
  order by total desc nulls last;
$$;

revoke execute on function public.agilizone_menu_sales(uuid, date, date, uuid) from public, anon;
grant execute on function public.agilizone_menu_sales(uuid, date, date, uuid) to authenticated, service_role;
