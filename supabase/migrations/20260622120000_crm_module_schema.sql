-- ============================================================================
-- Módulo CRM/WhatsApp — schema consolidado (Fase 2)
-- ----------------------------------------------------------------------------
-- Port multi-tenant do wacrm (MIT). Modelo de propriedade trocado de
-- account/auth.uid() para tenant_id + RLS por módulo, no padrão StockKitchen:
--   • SELECT  → app.is_member(tenant_id)            (quem é do tenant lê)
--   • ESCRITA → app.can_access_module(tenant_id,'crm') (quem vê o módulo edita)
-- Credenciais da Meta (crm_whatsapp_config) ficam fora do cliente: só
-- service_role enxerga (mesmo padrão de agilizone_accounts). A integração
-- WhatsApp real (edge functions) é a Fase 1, construída depois.
-- ============================================================================

-- 1. Contatos (clientes/leads) -----------------------------------------------
create table if not exists public.crm_contacts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  phone       text,                                          -- E.164 (ex.: +5585...)
  email       text,
  company     text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists crm_contacts_tenant_idx
  on public.crm_contacts (tenant_id);
-- Dedupe por telefone dentro do tenant (só quando há telefone).
create unique index if not exists crm_contacts_tenant_phone_uq
  on public.crm_contacts (tenant_id, phone) where phone is not null;

drop trigger if exists tg_crm_contacts_updated_at on public.crm_contacts;
create trigger tg_crm_contacts_updated_at
  before update on public.crm_contacts
  for each row execute function app.tg_set_updated_at();

-- 2. Tags --------------------------------------------------------------------
create table if not exists public.crm_tags (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  color       text,
  created_at  timestamptz not null default now(),
  unique (tenant_id, name)
);

create index if not exists crm_tags_tenant_idx on public.crm_tags (tenant_id);

-- 3. Contato <-> Tag (N:N) ---------------------------------------------------
create table if not exists public.crm_contact_tags (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  contact_id  uuid not null references public.crm_contacts(id) on delete cascade,
  tag_id      uuid not null references public.crm_tags(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (contact_id, tag_id)
);

create index if not exists crm_contact_tags_tag_idx on public.crm_contact_tags (tag_id);

-- 4. Conversas ---------------------------------------------------------------
create table if not exists public.crm_conversations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  contact_id       uuid not null references public.crm_contacts(id) on delete cascade,
  channel          text not null default 'whatsapp',
  status           text not null default 'open' check (status in ('open','closed')),
  assigned_to      uuid references auth.users(id) on delete set null,
  last_message_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, contact_id, channel)
);

create index if not exists crm_conversations_tenant_idx
  on public.crm_conversations (tenant_id, last_message_at desc);

drop trigger if exists tg_crm_conversations_updated_at on public.crm_conversations;
create trigger tg_crm_conversations_updated_at
  before update on public.crm_conversations
  for each row execute function app.tg_set_updated_at();

-- 5. Mensagens ---------------------------------------------------------------
create table if not exists public.crm_messages (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  conversation_id  uuid not null references public.crm_conversations(id) on delete cascade,
  direction        text not null check (direction in ('in','out')),
  wa_message_id    text,                                     -- id da Meta (wamid)
  type             text not null default 'text',             -- text/image/audio/...
  body             text,
  media_url        text,
  status           text,                                     -- sent/delivered/read/failed
  sender_user_id   uuid references auth.users(id) on delete set null, -- agente (outbound)
  created_at       timestamptz not null default now()
);

create index if not exists crm_messages_conversation_idx
  on public.crm_messages (conversation_id, created_at);
create index if not exists crm_messages_wamid_idx
  on public.crm_messages (wa_message_id);

-- 6. Pipelines ---------------------------------------------------------------
create table if not exists public.crm_pipelines (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists crm_pipelines_tenant_idx on public.crm_pipelines (tenant_id);

drop trigger if exists tg_crm_pipelines_updated_at on public.crm_pipelines;
create trigger tg_crm_pipelines_updated_at
  before update on public.crm_pipelines
  for each row execute function app.tg_set_updated_at();

-- 7. Estágios do pipeline ----------------------------------------------------
create table if not exists public.crm_stages (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  pipeline_id  uuid not null references public.crm_pipelines(id) on delete cascade,
  name         text not null,
  position     int not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists crm_stages_pipeline_idx on public.crm_stages (pipeline_id, position);

-- 8. Deals (negociações) -----------------------------------------------------
create table if not exists public.crm_deals (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  pipeline_id  uuid not null references public.crm_pipelines(id) on delete cascade,
  stage_id     uuid not null references public.crm_stages(id) on delete cascade,
  contact_id   uuid not null references public.crm_contacts(id) on delete cascade,
  title        text not null,
  value        numeric(14,2),
  currency     text not null default 'BRL',
  status       text not null default 'open' check (status in ('open','won','lost')),
  position     int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists crm_deals_pipeline_idx on public.crm_deals (pipeline_id);
create index if not exists crm_deals_stage_idx on public.crm_deals (stage_id, position);

drop trigger if exists tg_crm_deals_updated_at on public.crm_deals;
create trigger tg_crm_deals_updated_at
  before update on public.crm_deals
  for each row execute function app.tg_set_updated_at();

-- 9. Broadcasts --------------------------------------------------------------
create table if not exists public.crm_broadcasts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  name          text not null,
  template_name text,
  status        text not null default 'draft'
                  check (status in ('draft','scheduled','sending','sent','failed')),
  scheduled_at  timestamptz,
  total_count   int not null default 0,
  sent_count    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists crm_broadcasts_tenant_idx on public.crm_broadcasts (tenant_id);

drop trigger if exists tg_crm_broadcasts_updated_at on public.crm_broadcasts;
create trigger tg_crm_broadcasts_updated_at
  before update on public.crm_broadcasts
  for each row execute function app.tg_set_updated_at();

-- 10. Destinatários do broadcast ---------------------------------------------
create table if not exists public.crm_broadcast_recipients (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  broadcast_id  uuid not null references public.crm_broadcasts(id) on delete cascade,
  contact_id    uuid not null references public.crm_contacts(id) on delete cascade,
  status        text not null default 'pending',             -- pending/sent/delivered/failed
  wa_message_id text,
  error         text,
  created_at    timestamptz not null default now()
);

create index if not exists crm_broadcast_recipients_broadcast_idx
  on public.crm_broadcast_recipients (broadcast_id);

-- 11. Templates (espelho dos templates aprovados na Meta) --------------------
create table if not exists public.crm_templates (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  name             text not null,
  category         text,
  language         text not null default 'pt_BR',
  status           text,                                     -- approved/pending/rejected
  body             text,
  meta_template_id text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, name, language)
);

create index if not exists crm_templates_tenant_idx on public.crm_templates (tenant_id);

drop trigger if exists tg_crm_templates_updated_at on public.crm_templates;
create trigger tg_crm_templates_updated_at
  before update on public.crm_templates
  for each row execute function app.tg_set_updated_at();

-- 12. Config WhatsApp (credenciais) — service_role only -----------------------
--     Token guardado criptografado; NUNCA exposto ao cliente. Igual
--     agilizone_accounts: sem policy p/ authenticated → só service_role lê.
create table if not exists public.crm_whatsapp_config (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null unique references public.tenants(id) on delete cascade,
  phone_number_id        text,
  waba_id                text,
  display_phone          text,
  verify_token           text,
  access_token_encrypted text,
  is_active              boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

drop trigger if exists tg_crm_whatsapp_config_updated_at on public.crm_whatsapp_config;
create trigger tg_crm_whatsapp_config_updated_at
  before update on public.crm_whatsapp_config
  for each row execute function app.tg_set_updated_at();

-- ============================ RLS ===========================================
alter table public.crm_contacts             enable row level security;
alter table public.crm_tags                 enable row level security;
alter table public.crm_contact_tags         enable row level security;
alter table public.crm_conversations        enable row level security;
alter table public.crm_messages             enable row level security;
alter table public.crm_pipelines            enable row level security;
alter table public.crm_stages               enable row level security;
alter table public.crm_deals                enable row level security;
alter table public.crm_broadcasts           enable row level security;
alter table public.crm_broadcast_recipients enable row level security;
alter table public.crm_templates            enable row level security;
alter table public.crm_whatsapp_config      enable row level security;

-- Padrão por tabela editável: SELECT p/ todo membro do tenant; ESCRITA só p/
-- quem tem acesso ao módulo 'crm'. (FOR ALL cobre I/U/D; a _sel amplia o SELECT.)

-- contacts
drop policy if exists crm_contacts_sel   on public.crm_contacts;
create policy crm_contacts_sel   on public.crm_contacts
  for select using (app.is_member(tenant_id));
drop policy if exists crm_contacts_write on public.crm_contacts;
create policy crm_contacts_write on public.crm_contacts
  for all using (app.can_access_module(tenant_id,'crm'))
  with check (app.can_access_module(tenant_id,'crm'));

-- tags
drop policy if exists crm_tags_sel   on public.crm_tags;
create policy crm_tags_sel   on public.crm_tags
  for select using (app.is_member(tenant_id));
drop policy if exists crm_tags_write on public.crm_tags;
create policy crm_tags_write on public.crm_tags
  for all using (app.can_access_module(tenant_id,'crm'))
  with check (app.can_access_module(tenant_id,'crm'));

-- contact_tags
drop policy if exists crm_contact_tags_sel   on public.crm_contact_tags;
create policy crm_contact_tags_sel   on public.crm_contact_tags
  for select using (app.is_member(tenant_id));
drop policy if exists crm_contact_tags_write on public.crm_contact_tags;
create policy crm_contact_tags_write on public.crm_contact_tags
  for all using (app.can_access_module(tenant_id,'crm'))
  with check (app.can_access_module(tenant_id,'crm'));

-- conversations
drop policy if exists crm_conversations_sel   on public.crm_conversations;
create policy crm_conversations_sel   on public.crm_conversations
  for select using (app.is_member(tenant_id));
drop policy if exists crm_conversations_write on public.crm_conversations;
create policy crm_conversations_write on public.crm_conversations
  for all using (app.can_access_module(tenant_id,'crm'))
  with check (app.can_access_module(tenant_id,'crm'));

-- messages
drop policy if exists crm_messages_sel   on public.crm_messages;
create policy crm_messages_sel   on public.crm_messages
  for select using (app.is_member(tenant_id));
drop policy if exists crm_messages_write on public.crm_messages;
create policy crm_messages_write on public.crm_messages
  for all using (app.can_access_module(tenant_id,'crm'))
  with check (app.can_access_module(tenant_id,'crm'));

-- pipelines
drop policy if exists crm_pipelines_sel   on public.crm_pipelines;
create policy crm_pipelines_sel   on public.crm_pipelines
  for select using (app.is_member(tenant_id));
drop policy if exists crm_pipelines_write on public.crm_pipelines;
create policy crm_pipelines_write on public.crm_pipelines
  for all using (app.can_access_module(tenant_id,'crm'))
  with check (app.can_access_module(tenant_id,'crm'));

-- stages
drop policy if exists crm_stages_sel   on public.crm_stages;
create policy crm_stages_sel   on public.crm_stages
  for select using (app.is_member(tenant_id));
drop policy if exists crm_stages_write on public.crm_stages;
create policy crm_stages_write on public.crm_stages
  for all using (app.can_access_module(tenant_id,'crm'))
  with check (app.can_access_module(tenant_id,'crm'));

-- deals
drop policy if exists crm_deals_sel   on public.crm_deals;
create policy crm_deals_sel   on public.crm_deals
  for select using (app.is_member(tenant_id));
drop policy if exists crm_deals_write on public.crm_deals;
create policy crm_deals_write on public.crm_deals
  for all using (app.can_access_module(tenant_id,'crm'))
  with check (app.can_access_module(tenant_id,'crm'));

-- broadcasts
drop policy if exists crm_broadcasts_sel   on public.crm_broadcasts;
create policy crm_broadcasts_sel   on public.crm_broadcasts
  for select using (app.is_member(tenant_id));
drop policy if exists crm_broadcasts_write on public.crm_broadcasts;
create policy crm_broadcasts_write on public.crm_broadcasts
  for all using (app.can_access_module(tenant_id,'crm'))
  with check (app.can_access_module(tenant_id,'crm'));

-- broadcast_recipients
drop policy if exists crm_broadcast_recipients_sel   on public.crm_broadcast_recipients;
create policy crm_broadcast_recipients_sel   on public.crm_broadcast_recipients
  for select using (app.is_member(tenant_id));
drop policy if exists crm_broadcast_recipients_write on public.crm_broadcast_recipients;
create policy crm_broadcast_recipients_write on public.crm_broadcast_recipients
  for all using (app.can_access_module(tenant_id,'crm'))
  with check (app.can_access_module(tenant_id,'crm'));

-- templates
drop policy if exists crm_templates_sel   on public.crm_templates;
create policy crm_templates_sel   on public.crm_templates
  for select using (app.is_member(tenant_id));
drop policy if exists crm_templates_write on public.crm_templates;
create policy crm_templates_write on public.crm_templates
  for all using (app.can_access_module(tenant_id,'crm'))
  with check (app.can_access_module(tenant_id,'crm'));

-- crm_whatsapp_config: sem policy p/ authenticated/anon → só service_role.

-- ============================ GRANTs (CLAUDE.md §5.3) =======================
grant usage on schema public to service_role;

grant select on
  public.crm_contacts, public.crm_tags, public.crm_contact_tags,
  public.crm_conversations, public.crm_messages, public.crm_pipelines,
  public.crm_stages, public.crm_deals, public.crm_broadcasts,
  public.crm_broadcast_recipients, public.crm_templates
  to authenticated;

grant insert, update, delete on
  public.crm_contacts, public.crm_tags, public.crm_contact_tags,
  public.crm_conversations, public.crm_messages, public.crm_pipelines,
  public.crm_stages, public.crm_deals, public.crm_broadcasts,
  public.crm_broadcast_recipients, public.crm_templates
  to authenticated;

grant all on
  public.crm_contacts, public.crm_tags, public.crm_contact_tags,
  public.crm_conversations, public.crm_messages, public.crm_pipelines,
  public.crm_stages, public.crm_deals, public.crm_broadcasts,
  public.crm_broadcast_recipients, public.crm_templates,
  public.crm_whatsapp_config
  to service_role;
