-- =====================================================================
-- PROVISIONAMENTO INICIAL · MobyDick Dark Kitchen
-- Cria o tenant, vincula o owner e cadastra as 4 operações.
-- IDEMPOTENTE: pode rodar quantas vezes quiser sem duplicar dados.
--
-- Pré-requisito: usuário danilocaioavelino@gmail.com já criado no
-- Supabase Auth (Authentication → Users → Add user · auto-confirm).
-- =====================================================================

do $$
declare
  v_email     text  := 'danilocaioavelino@gmail.com';
  v_user_id   uuid;
  v_tenant_id uuid;
begin
  -- Resolve o user_id pelo email
  select id into v_user_id from auth.users where email = v_email;
  if v_user_id is null then
    raise exception 'Usuário % não existe em auth.users — crie pelo Authentication > Users primeiro', v_email;
  end if;

  -- Garante que o profile existe (deveria ter sido criado pelo trigger tg_handle_new_user)
  insert into public.profiles (id, full_name)
  values (v_user_id, 'Danilo Avelino')
  on conflict (id) do update set full_name = excluded.full_name;

  -- Tenant · cria se ainda não existe (lookup pelo slug 'mobydick')
  select id into v_tenant_id from public.tenants where slug = 'mobydick';
  if v_tenant_id is null then
    insert into public.tenants (slug, name, legal_name, status, plan)
    values ('mobydick', 'MobyDick Dark Kitchen', 'Cozinha Central SP Ltda', 'active', 'pro')
    returning id into v_tenant_id;
    raise notice 'Tenant criado · id=%', v_tenant_id;
  else
    raise notice 'Tenant já existia · id=%', v_tenant_id;
  end if;

  -- Vincula o owner
  insert into public.tenant_members (tenant_id, user_id, role)
  values (v_tenant_id, v_user_id, 'owner')
  on conflict (tenant_id, user_id) do update set role = 'owner';

  -- Métodos de pagamento padrão
  insert into public.payment_methods (tenant_id, slug, label, short_label, color, sort_order) values
    (v_tenant_id, 'debito',   'Débito',   'Déb',  '#3d6cb0', 1),
    (v_tenant_id, 'credito',  'Crédito',  'Créd', '#6b5fb0', 2),
    (v_tenant_id, 'voucher',  'Voucher',  'Vchr', '#c2843a', 3),
    (v_tenant_id, 'dinheiro', 'Dinheiro', 'Din',  '#2d8c66', 4),
    (v_tenant_id, 'pix',      'Pix',      'Pix',  '#1aa39e', 5),
    (v_tenant_id, 'online',   'Online',   'Onl',  '#b04545', 6)
  on conflict (tenant_id, slug) do nothing;

  -- 4 operações da MobyDick
  insert into public.operations (tenant_id, slug, name, short_label, color, ifood_handle, cmv_goal_pct, sort_order, is_active) values
    (v_tenant_id, 'burguer',  'Forno & Brasa',  'BURG',  '#c2843a', '@fornoebrasa',   30.0, 1, true),
    (v_tenant_id, 'pizzaria', 'Mestre Stefano', 'PIZZ',  '#b04545', '@mestrestefano', 31.0, 2, true),
    (v_tenant_id, 'acai',     'Tigela do Vale', 'AÇAÍ',  '#6b5fb0', '@tigeladovale',  35.0, 3, true),
    (v_tenant_id, 'saudavel', 'Verde Marmita',  'VERDE', '#2d8c66', '@verdemarmita',  28.0, 4, true)
  on conflict (tenant_id, slug) do update set
    name         = excluded.name,
    short_label  = excluded.short_label,
    color        = excluded.color,
    ifood_handle = excluded.ifood_handle,
    cmv_goal_pct = excluded.cmv_goal_pct,
    sort_order   = excluded.sort_order,
    is_active    = excluded.is_active;

  raise notice '✓ Provisionamento concluído · tenant_id=%, owner=% (%), operações=4',
               v_tenant_id, v_email, v_user_id;
end $$;

-- Verificação · rode esses SELECTs depois pra confirmar
select 'tenants'        as table, count(*) as rows from public.tenants where slug = 'mobydick'
union all
select 'tenant_members' as table, count(*) as rows from public.tenant_members
  where tenant_id = (select id from public.tenants where slug = 'mobydick')
union all
select 'payment_methods'as table, count(*) as rows from public.payment_methods
  where tenant_id = (select id from public.tenants where slug = 'mobydick')
union all
select 'operations'     as table, count(*) as rows from public.operations
  where tenant_id = (select id from public.tenants where slug = 'mobydick');
