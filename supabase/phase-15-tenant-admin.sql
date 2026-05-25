-- Fase 15 · Acesso superadmin total a public.tenants
-- =====================================================================
-- O painel /admin (page-superadmin) precisa listar/criar/editar/excluir
-- TODOS os tenants — não só aqueles aos quais o usuário pertence.
--
-- Já temos:
--   - public.profiles.is_superadmin (Fase 13)
--   - app.is_superadmin(uuid) → boolean
--
-- O que falta: políticas RLS em public.tenants permitindo CRUD pleno
-- quando app.is_superadmin(auth.uid()) = true.
--
-- INSERT é via RLS aqui (sem precisar de edge function) — mas o
-- provisionamento de owner + seeds continua via edge function
-- `provision-tenant` (cria auth.users + tenant_members).
-- =====================================================================

-- SELECT: superadmin enxerga todos os tenants
drop policy if exists tenants_superadmin_select on public.tenants;
create policy tenants_superadmin_select on public.tenants
  for select using (app.is_superadmin(auth.uid()));

-- UPDATE: superadmin pode atualizar qualquer tenant
drop policy if exists tenants_superadmin_update on public.tenants;
create policy tenants_superadmin_update on public.tenants
  for update using (app.is_superadmin(auth.uid()))
  with check     (app.is_superadmin(auth.uid()));

-- INSERT: superadmin pode inserir tenants direto (opcional · normalmente
-- usamos a edge function provision-tenant). Mantém porque o painel pode
-- precisar de criar um placeholder antes de provisionar o owner.
drop policy if exists tenants_superadmin_insert on public.tenants;
create policy tenants_superadmin_insert on public.tenants
  for insert with check (app.is_superadmin(auth.uid()));

-- DELETE: superadmin pode excluir tenants (CASCADE remove members/dados)
drop policy if exists tenants_superadmin_delete on public.tenants;
create policy tenants_superadmin_delete on public.tenants
  for delete using (app.is_superadmin(auth.uid()));

-- tenant_members: superadmin enxerga todos os vínculos · útil pra mostrar
-- quem é owner/admin de cada tenant na visão /admin.
drop policy if exists tenant_members_superadmin_select on public.tenant_members;
create policy tenant_members_superadmin_select on public.tenant_members
  for select using (app.is_superadmin(auth.uid()));

drop policy if exists tenant_members_superadmin_all on public.tenant_members;
create policy tenant_members_superadmin_all on public.tenant_members
  for all using (app.is_superadmin(auth.uid()))
  with check    (app.is_superadmin(auth.uid()));

-- profiles: superadmin pode ler perfis de todos os usuários (pra resolver
-- nome do owner por tenant).
drop policy if exists profiles_superadmin_select on public.profiles;
create policy profiles_superadmin_select on public.profiles
  for select using (app.is_superadmin(auth.uid()));

-- =====================================================================
-- Smoke test (rode no editor SQL após o deploy):
--   set role authenticated;
--   set request.jwt.claim.sub to '<seu-user-id-superadmin>';
--   select id, slug, name, plan, status from public.tenants order by created_at desc;
--   reset role; reset request.jwt.claim.sub;
-- =====================================================================
