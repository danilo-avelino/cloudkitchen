-- =====================================================================
-- Fase B — Rede de suprimentos (PRD-PRODUCAO-E-DISTRIBUICAO.md §6)
--
--  • tenants.kind ('standard'|'distribution_center') + supply_code (8 dígitos,
--    único, gerado p/ todos os tenants — é o código de convite da rede)
--  • supply_members: vínculo central ↔ tenant com consentimento mútuo
--    (invited → active/rejected; removed pela central; left pelo membro)
--  • RPCs SECURITY DEFINER (CLAUDE.md §5.1: auth.uid() + papel validados):
--    supply_lookup_tenant_by_code, supply_invite_tenant,
--    supply_respond_invite, supply_remove_member
--  • Escrita em supply_members SÓ via RPC (sem policies de write)
-- =====================================================================

-- ---------- 1. tenants: tipo + código de convite ----------------------
alter table public.tenants
  add column if not exists kind text not null default 'standard',
  add column if not exists supply_code text;

do $$ begin
  alter table public.tenants
    add constraint tenants_kind_chk check (kind in ('standard','distribution_center'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.tenants
    add constraint tenants_supply_code_key unique (supply_code);
exception when duplicate_object then null; end $$;

-- Gera código numérico de 8 dígitos, com retry em colisão
create or replace function app.gen_supply_code()
returns text
language plpgsql
volatile
set search_path = 'app','public','pg_temp'
as $$
declare
  v_code text;
begin
  loop
    v_code := lpad(floor(random() * 100000000)::bigint::text, 8, '0');
    exit when not exists (select 1 from public.tenants t where t.supply_code = v_code);
  end loop;
  return v_code;
end;
$$;

-- Backfill: todos os tenants existentes ganham código
do $$
declare
  r record;
begin
  for r in select id from public.tenants where supply_code is null loop
    update public.tenants set supply_code = app.gen_supply_code() where id = r.id;
  end loop;
end $$;

-- Novos tenants ganham código na criação
create or replace function app.tg_tenants_gen_supply_code()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
begin
  if new.supply_code is null then
    new.supply_code := app.gen_supply_code();
  end if;
  return new;
end;
$$;

drop trigger if exists tg_tenants_supply_code on public.tenants;
create trigger tg_tenants_supply_code
  before insert on public.tenants
  for each row execute function app.tg_tenants_gen_supply_code();

-- ---------- 2. Membros da rede ----------------------------------------
create table if not exists public.supply_members (
  central_tenant_id uuid not null references public.tenants(id) on delete cascade,
  member_tenant_id  uuid not null references public.tenants(id) on delete cascade,
  status            text not null default 'invited'
                      check (status in ('invited','active','rejected','removed','left')),
  invited_by        uuid references auth.users(id) on delete set null,
  invited_at        timestamptz not null default now(),
  responded_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (central_tenant_id, member_tenant_id),
  check (central_tenant_id <> member_tenant_id)
);

create index if not exists supply_members_member_idx
  on public.supply_members (member_tenant_id, status);

drop trigger if exists tg_supply_members_updated_at on public.supply_members;
create trigger tg_supply_members_updated_at
  before update on public.supply_members
  for each row execute function app.tg_set_updated_at();

alter table public.supply_members enable row level security;

-- Leitura: qualquer membro de qualquer lado do vínculo. Escrita: só via RPC
-- (nenhuma policy de INSERT/UPDATE/DELETE — as RPCs são SECURITY DEFINER).
drop policy if exists supply_members_select on public.supply_members;
create policy supply_members_select on public.supply_members
  for select using (
    app.is_tenant_member(central_tenant_id) or app.is_tenant_member(member_tenant_id)
  );

-- ---------- 3. Helpers de autorização ---------------------------------
-- Papel de gestão (owner/admin/manager) num tenant — usado pelas RPCs da rede.
create or replace function app.supply_is_manager(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = 'app','public','pg_temp'
as $$
  select auth.role() = 'service_role' or app.has_tenant_role(p_tenant,
    array['owner','admin','manager']::app.member_role[]);
$$;

-- ---------- 4. RPCs ----------------------------------------------------
-- Busca tenant pelo código de convite. Só para gestores de uma central —
-- devolve apenas id + nome (não vaza dados do tenant).
create or replace function public.supply_lookup_tenant_by_code(p_central uuid, p_code text)
returns table (tenant_id uuid, tenant_name text, member_status text)
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
  if not exists (select 1 from public.tenants t where t.id = p_central and t.kind = 'distribution_center') then
    raise exception 'tenant % não é uma central de distribuição', p_central;
  end if;
  return query
    select t.id, t.name::text, sm.status::text
      from public.tenants t
      left join public.supply_members sm
        on sm.central_tenant_id = p_central and sm.member_tenant_id = t.id
     where t.supply_code = regexp_replace(coalesce(p_code,''), '\D', '', 'g');
end;
$$;

-- Convida um tenant (pelo código) para a rede da central.
create or replace function public.supply_invite_tenant(p_central uuid, p_code text)
returns void
language plpgsql
volatile
security definer
set search_path = 'app','public','pg_temp'
as $$
declare
  v_target uuid;
  v_status text;
begin
  if auth.uid() is null and auth.role() <> 'service_role' then
    raise exception 'não autenticado';
  end if;
  if not app.supply_is_manager(p_central) then
    raise exception 'sem permissão na central';
  end if;
  if not exists (select 1 from public.tenants t where t.id = p_central and t.kind = 'distribution_center') then
    raise exception 'tenant % não é uma central de distribuição', p_central;
  end if;

  select id into v_target from public.tenants
   where supply_code = regexp_replace(coalesce(p_code,''), '\D', '', 'g');
  if v_target is null then
    raise exception 'Nenhum tenant encontrado com esse código';
  end if;
  if v_target = p_central then
    raise exception 'A central não pode convidar a si mesma';
  end if;

  select status into v_status from public.supply_members
   where central_tenant_id = p_central and member_tenant_id = v_target;

  if v_status is null then
    insert into public.supply_members (central_tenant_id, member_tenant_id, status, invited_by)
    values (p_central, v_target, 'invited', auth.uid());
  elsif v_status in ('rejected','removed','left') then
    update public.supply_members
       set status = 'invited', invited_by = auth.uid(), invited_at = now(), responded_at = null
     where central_tenant_id = p_central and member_tenant_id = v_target;
  elsif v_status = 'invited' then
    raise exception 'Convite já enviado — aguardando resposta do tenant';
  else
    raise exception 'Tenant já é membro ativo da rede';
  end if;
end;
$$;

-- Tenant convidado aceita ou recusa o convite.
create or replace function public.supply_respond_invite(p_central uuid, p_member uuid, p_accept boolean)
returns void
language plpgsql
volatile
security definer
set search_path = 'app','public','pg_temp'
as $$
begin
  if auth.uid() is null and auth.role() <> 'service_role' then
    raise exception 'não autenticado';
  end if;
  if not app.supply_is_manager(p_member) then
    raise exception 'sem permissão no tenant convidado';
  end if;
  update public.supply_members
     set status = case when p_accept then 'active' else 'rejected' end,
         responded_at = now()
   where central_tenant_id = p_central
     and member_tenant_id  = p_member
     and status = 'invited';
  if not found then
    raise exception 'Convite não encontrado (ou já respondido)';
  end if;
end;
$$;

-- Central remove um membro ('removed') ou o membro sai da rede ('left').
create or replace function public.supply_remove_member(p_central uuid, p_member uuid)
returns void
language plpgsql
volatile
security definer
set search_path = 'app','public','pg_temp'
as $$
declare
  v_is_central boolean := app.supply_is_manager(p_central);
  v_is_member  boolean := app.supply_is_manager(p_member);
begin
  if auth.uid() is null and auth.role() <> 'service_role' then
    raise exception 'não autenticado';
  end if;
  if not v_is_central and not v_is_member then
    raise exception 'sem permissão';
  end if;
  update public.supply_members
     set status = case when v_is_central then 'removed' else 'left' end,
         responded_at = now()
   where central_tenant_id = p_central
     and member_tenant_id  = p_member
     and status in ('invited','active');
  if not found then
    raise exception 'Vínculo não encontrado (ou já encerrado)';
  end if;
end;
$$;

-- ---------- 5. GRANTs (CLAUDE.md §5.2 / §5.3) --------------------------
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

GRANT SELECT ON public.supply_members TO authenticated;
GRANT EXECUTE ON FUNCTION public.supply_lookup_tenant_by_code(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_invite_tenant(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_respond_invite(uuid, uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_remove_member(uuid, uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.supply_lookup_tenant_by_code(uuid, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.supply_invite_tenant(uuid, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.supply_respond_invite(uuid, uuid, boolean) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.supply_remove_member(uuid, uuid) FROM anon, PUBLIC;
