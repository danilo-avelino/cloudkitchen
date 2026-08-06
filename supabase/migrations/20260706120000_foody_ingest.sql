-- ============================================================================
-- Foody Delivery — integração de logística (espelho da Agilizone)
-- ----------------------------------------------------------------------------
-- Modelo: 1 conta Foody = 1 conta na plataforma (token de API fixo). Dentro
-- dela os pedidos saem de N pontos de coleta (collectionPoint.name) que
-- mapeamos para `operations` — equivalente ao brand_map da Agilizone.
-- O token NÃO fica no banco: vai pro Vault (mapa 'foody_api_tokens' keyed por
-- account_id) via RPC service-role-only. Aqui guardamos só um hint (últimos 4).
--
-- TRAVA DE EXCLUSIVIDADE: um tenant não pode ter Agilizone e Foody ativas ao
-- mesmo tempo (as duas alimentam Logística e Faturamento — dupla contagem).
-- Trigger em ambas as tabelas de contas exige desativar uma antes de ativar
-- a outra. Edge functions e UI reforçam com mensagem amigável.
-- ============================================================================

-- 1. Contas ------------------------------------------------------------------
create table if not exists public.foody_accounts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  label          text not null,                                  -- ex.: 'Dark Aldeota'
  token_hint     text,                                           -- últimos 4 chars do token (só UI)
  is_active      boolean not null default true,
  last_synced_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists foody_accounts_tenant_idx
  on public.foody_accounts (tenant_id);

drop trigger if exists tg_foody_accounts_updated_at on public.foody_accounts;
create trigger tg_foody_accounts_updated_at
  before update on public.foody_accounts
  for each row execute function app.tg_set_updated_at();

-- 2. Mapa ponto de coleta -> operação (por conta) -----------------------------
create table if not exists public.foody_point_map (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  account_id   uuid not null references public.foody_accounts(id) on delete cascade,
  point_name   text not null,                                    -- collectionPoint.name (match exato)
  operation_id uuid not null references public.operations(id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (account_id, point_name)
);

create index if not exists foody_point_map_tenant_idx
  on public.foody_point_map (tenant_id);

drop trigger if exists tg_foody_point_map_updated_at on public.foody_point_map;
create trigger tg_foody_point_map_updated_at
  before update on public.foody_point_map
  for each row execute function app.tg_set_updated_at();

-- 3. Pedidos (staging cru + campos normalizados) -----------------------------
--    Upsert idempotente por (account_id, uid). Status muda entre polls.
--    Timestamps do ciclo já vêm como campos próprios na API (readyDate,
--    despatchDate, collectedDate, deliveryDate) — sem history array.
create table if not exists public.foody_orders (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  account_id     uuid not null references public.foody_accounts(id) on delete cascade,
  uid            text not null,                                  -- uid da Foody
  operation_id   uuid references public.operations(id) on delete set null, -- null = ponto não mapeado
  point_name     text,                                           -- collectionPoint.name
  external_id    text,                                           -- id externo (PDV/marketplace)
  status         text not null,
  is_canceled    boolean not null default false,                 -- cancelled/rejected
  business_date  date not null,                                  -- dia efetivo (corte 05:00 BRT)
  created_at_src timestamptz not null,                           -- date (criação do pedido)
  ready_at       timestamptz,                                    -- readyDate
  despatched_at  timestamptz,                                    -- despatchDate
  collected_at   timestamptz,                                    -- collectedDate
  delivered_at   timestamptz,                                    -- deliveryDate
  promised_at    timestamptz,                                    -- deliveryDueDate (SLA prometido)
  amount         numeric(14,2),                                  -- orderTotal
  delivery_fee   numeric(14,2),                                  -- deliveryFee (cobrada do cliente)
  courier_fee    numeric(14,2),                                  -- courierFee (paga ao entregador)
  payment_method text,
  courier_name   text,
  courier_type   text,
  neighborhood   text,
  distance_m     numeric,                                        -- linha reta coleta->entrega (haversine)
  payload        jsonb not null,                                 -- pedido cru completo (fonte da verdade)
  fetched_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (account_id, uid)
);

create index if not exists foody_orders_tenant_date_idx
  on public.foody_orders (tenant_id, business_date desc);
create index if not exists foody_orders_operation_date_idx
  on public.foody_orders (operation_id, business_date desc);
create index if not exists foody_orders_account_status_idx
  on public.foody_orders (account_id, status);

drop trigger if exists tg_foody_orders_updated_at on public.foody_orders;
create trigger tg_foody_orders_updated_at
  before update on public.foody_orders
  for each row execute function app.tg_set_updated_at();

-- 4. TRAVA: só uma integração de logística ativa por tenant --------------------
--    `update of is_active` → não dispara nos updates rotineiros do ingest
--    (last_synced_at), só quando o flag entra no SET.
create or replace function app.tg_logistics_exclusivity()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
begin
  if new.is_active then
    if tg_table_name = 'foody_accounts' then
      if exists (select 1 from public.agilizone_accounts a
                 where a.tenant_id = new.tenant_id and a.is_active) then
        raise exception 'Desative a integração Agilizone antes de ativar a Foody Delivery.';
      end if;
    elsif tg_table_name = 'agilizone_accounts' then
      if exists (select 1 from public.foody_accounts f
                 where f.tenant_id = new.tenant_id and f.is_active) then
        raise exception 'Desative a integração Foody Delivery antes de ativar a Agilizone.';
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists tg_foody_accounts_exclusivity on public.foody_accounts;
create trigger tg_foody_accounts_exclusivity
  before insert or update of is_active on public.foody_accounts
  for each row execute function app.tg_logistics_exclusivity();

drop trigger if exists tg_agilizone_accounts_exclusivity on public.agilizone_accounts;
create trigger tg_agilizone_accounts_exclusivity
  before insert or update of is_active on public.agilizone_accounts
  for each row execute function app.tg_logistics_exclusivity();

-- 5. RLS ---------------------------------------------------------------------
alter table public.foody_accounts  enable row level security;
alter table public.foody_point_map enable row level security;
alter table public.foody_orders    enable row level security;

-- Contas: sem policy para authenticated/anon → só service_role (bypassa RLS)
-- enxerga. Mantém config de integração fora do cliente (igual agilizone_accounts).

-- Point map: membros do tenant leem; escrita só backend (service_role).
drop policy if exists foody_point_map_sel on public.foody_point_map;
create policy foody_point_map_sel on public.foody_point_map
  for select using (app.is_tenant_member(tenant_id));

-- Pedidos: membros do tenant leem; escrita só backend (service_role).
drop policy if exists foody_orders_sel on public.foody_orders;
create policy foody_orders_sel on public.foody_orders
  for select using (app.is_tenant_member(tenant_id));

-- 6. GRANTs para service_role (edge functions) — CLAUDE.md §5.3 ----------------
grant usage on schema public to service_role;
grant all on public.foody_accounts  to service_role;
grant all on public.foody_point_map to service_role;
grant all on public.foody_orders    to service_role;
grant select on public.foody_point_map, public.foody_orders to authenticated;

-- 7. Vault: leitura/gravação de secrets (service-role-only) -------------------
--    foody_get_secret: espelho do agilizone_get_secret (nome próprio p/ não
--    acoplar a Foody ao ciclo de vida da Agilizone).
create or replace function public.foody_get_secret(p_name text)
returns text
language sql
security definer
set search_path = 'public','pg_temp'
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1;
$$;

revoke execute on function public.foody_get_secret(text) from public, anon, authenticated;
grant execute on function public.foody_get_secret(text) to service_role;

--    foody_set_api_token: upsert no mapa 'foody_api_tokens' ({account_id: token}).
create or replace function public.foody_set_api_token(p_account_id uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = 'public','pg_temp'
as $$
declare
  v_id   uuid;
  v_json jsonb;
begin
  select id, decrypted_secret::jsonb into v_id, v_json
  from vault.decrypted_secrets where name = 'foody_api_tokens' limit 1;

  if v_id is null then
    perform vault.create_secret(
      jsonb_build_object(p_account_id::text, p_token)::text,
      'foody_api_tokens',
      'Mapa account_id->api_token da Foody Delivery'
    );
  else
    perform vault.update_secret(
      v_id,
      (coalesce(v_json, '{}'::jsonb) || jsonb_build_object(p_account_id::text, p_token))::text
    );
  end if;
end $$;

revoke execute on function public.foody_set_api_token(uuid, text) from public, anon, authenticated;
grant execute on function public.foody_set_api_token(uuid, text) to service_role;

--    shared-secret de disparo (máquina→edge fn): cria se ainda não existe.
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'foody_ingest_secret') then
    perform vault.create_secret(gen_random_uuid()::text, 'foody_ingest_secret',
      'Shared-secret de disparo do ingest Foody (header x-ingest-secret)');
  end if;
end $$;

-- 8. Disparo do ingest em background (pg_net) ---------------------------------
--    Usado após mapear pontos e no botão "Sincronizar". service-role-only.
create or replace function public.foody_trigger_ingest(p_account uuid, p_lookback int default 7)
returns bigint
language plpgsql
security definer
set search_path = 'public','pg_temp'
as $$
declare
  v_secret text;
  v_req    bigint;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'foody_ingest_secret' limit 1;
  if v_secret is null then raise exception 'foody_ingest_secret ausente no Vault'; end if;

  select net.http_post(
    url := 'https://dnvrerivultswuirxnns.supabase.co/functions/v1/foody-ingest',
    body := jsonb_build_object('accountId', p_account, 'lookbackDays', p_lookback),
    headers := jsonb_build_object('Content-Type','application/json','x-ingest-secret', v_secret),
    timeout_milliseconds := 280000
  ) into v_req;
  return v_req;
end $$;

revoke execute on function public.foody_trigger_ingest(uuid, int) from public, anon, authenticated;
grant execute on function public.foody_trigger_ingest(uuid, int) to service_role;

-- 9. Polling automático -------------------------------------------------------
--    Dispara o ingest de TODAS as contas Foody ativas (sem accountId no body).
--    Guard: se nenhuma conta ativa, não gasta invocação da edge function.
create or replace function public.foody_poll(p_lookback int default 1)
returns bigint
language plpgsql
security definer
set search_path = 'public','pg_temp'
as $$
declare
  v_secret text;
  v_req    bigint;
begin
  if not exists (select 1 from public.foody_accounts where is_active) then
    return null;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'foody_ingest_secret' limit 1;
  if v_secret is null then raise exception 'foody_ingest_secret ausente no Vault'; end if;

  select net.http_post(
    url := 'https://dnvrerivultswuirxnns.supabase.co/functions/v1/foody-ingest',
    body := jsonb_build_object('lookbackDays', p_lookback),
    headers := jsonb_build_object('Content-Type','application/json','x-ingest-secret', v_secret),
    timeout_milliseconds := 280000
  ) into v_req;
  return v_req;
end $$;

revoke execute on function public.foody_poll(int) from public, anon, authenticated;
grant execute on function public.foody_poll(int) to service_role;

-- Agenda a cada 5 min (upsert por nome, idempotente).
select cron.schedule('foody-poll-5min', '*/5 * * * *', $cron$select public.foody_poll(1);$cron$);
