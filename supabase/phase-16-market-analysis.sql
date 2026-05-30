-- FASE 16 - Analise de mercado / OpenAI por tenant
-- Guarda a chave OpenAI criptografada. Acesso direto pelo cliente fica bloqueado por RLS.

create table if not exists public.market_openai_keys (
  tenant_id     uuid primary key references public.tenants(id) on delete cascade,
  encrypted_key text not null,
  key_iv        text not null,
  key_hint      text,
  model         text not null default 'gpt-4.1-mini',
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists tg_market_openai_keys_updated_at on public.market_openai_keys;
create trigger tg_market_openai_keys_updated_at
  before update on public.market_openai_keys
  for each row execute function app.tg_set_updated_at();

alter table public.market_openai_keys enable row level security;

-- Sem policies: clients authenticated/anon nao leem nem escrevem chaves.
-- Edge Functions usam service_role e validam o membro/role antes de operar.
