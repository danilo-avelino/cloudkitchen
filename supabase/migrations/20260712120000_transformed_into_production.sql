-- =====================================================================
-- Transformados vira parte do módulo Produção (pedido do usuário 2026-07-12)
--
-- O módulo 'transformed' deixou de existir na UI — catálogo, receitas e
-- análises viraram abas do módulo 'production'. As RLS de escrita passam a
-- aceitar o módulo 'production'; 'transformed' segue aceito por compat com
-- membros que tenham o id no `modules` customizado.
-- (create or replace / drop+create — colável no SQL Editor por cima do patch)
-- =====================================================================

-- Catálogo (stock_items transformados): production OU transformed
drop policy if exists stock_items_write on public.stock_items;
create policy stock_items_write on public.stock_items
  for all using (
    app.can_access_module(tenant_id, 'stock')
    or (item_kind = 'transformed'
        and (app.can_access_module(tenant_id, 'production')
             or app.can_access_module(tenant_id, 'transformed')))
  )
  with check (
    app.can_access_module(tenant_id, 'stock')
    or (item_kind = 'transformed'
        and (app.can_access_module(tenant_id, 'production')
             or app.can_access_module(tenant_id, 'transformed')))
  );

-- Receitas de produção: production OU transformed
drop policy if exists production_recipes_write on public.production_recipes;
create policy production_recipes_write on public.production_recipes
  for all using (
    app.can_access_module(tenant_id, 'production') or app.can_access_module(tenant_id, 'transformed'))
  with check (
    app.can_access_module(tenant_id, 'production') or app.can_access_module(tenant_id, 'transformed'));

drop policy if exists production_recipe_inputs_write on public.production_recipe_inputs;
create policy production_recipe_inputs_write on public.production_recipe_inputs
  for all using (exists (select 1 from public.production_recipes pr
      where pr.id = production_recipe_inputs.recipe_id
        and (app.can_access_module(pr.tenant_id, 'production') or app.can_access_module(pr.tenant_id, 'transformed'))))
  with check (exists (select 1 from public.production_recipes pr
      where pr.id = production_recipe_inputs.recipe_id
        and (app.can_access_module(pr.tenant_id, 'production') or app.can_access_module(pr.tenant_id, 'transformed'))));

drop policy if exists production_recipe_outputs_write on public.production_recipe_outputs;
create policy production_recipe_outputs_write on public.production_recipe_outputs
  for all using (exists (select 1 from public.production_recipes pr
      where pr.id = production_recipe_outputs.recipe_id
        and (app.can_access_module(pr.tenant_id, 'production') or app.can_access_module(pr.tenant_id, 'transformed'))))
  with check (exists (select 1 from public.production_recipes pr
      where pr.id = production_recipe_outputs.recipe_id
        and (app.can_access_module(pr.tenant_id, 'production') or app.can_access_module(pr.tenant_id, 'transformed'))));

-- Presets por papel: 'transformed' sai dos presets (o id não existe mais na UI).
-- Espelha ROLE_DEFAULT_MODULES (shell.jsx) e ROLE_MODULE_PRESETS (page-settings.jsx).
CREATE OR REPLACE FUNCTION app.role_default_modules(p_role app.member_role)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = 'public', 'app', 'pg_temp'
AS $$
  SELECT CASE p_role
    WHEN 'owner'      THEN ARRAY['dashboard','stock','recipes','revenue','requests','purchases','cmv','finance','dre','analise-mercado','settings','production','supply','distribution']
    WHEN 'admin'      THEN ARRAY['dashboard','stock','recipes','revenue','requests','purchases','cmv','finance','dre','analise-mercado','settings','production','supply','distribution']
    WHEN 'manager'    THEN ARRAY['dashboard','stock','recipes','revenue','requests','purchases','cmv','finance','dre','analise-mercado','production','supply','distribution']
    WHEN 'kitchen'    THEN ARRAY['dashboard','stock','requests','recipes','production']
    WHEN 'stock'      THEN ARRAY['dashboard','stock','requests','purchases','production','supply']
    WHEN 'accountant' THEN ARRAY['dashboard','revenue','cmv','finance','dre']
    WHEN 'viewer'     THEN ARRAY['dashboard']
    ELSE ARRAY['dashboard']
  END;
$$;

-- GRANTs (CLAUDE.md §5.2 / §5.3)
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
