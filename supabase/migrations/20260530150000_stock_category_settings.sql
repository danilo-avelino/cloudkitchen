-- Flags por categoria pra controlar comportamento dos itens:
--   alerts_enabled         · se itens dessa categoria entram em alertas (ruptura/baixo/acima)
--   auto_min_max_enabled   · marca a categoria como "auto min/max"; cascateia em items via RPC
--   auto_shopping_enabled  · se a categoria entra nas listas de compras automáticas
--
-- Defaults conservadores: alerts/shopping ON (não esconde nada por engano),
-- auto_min_max OFF (precisa decisão explícita por categoria).
--
-- Acompanha um RPC `public.set_category_auto_min_max(category_id, enabled)` que
-- liga/desliga `auto_min_enabled` em todos os itens da categoria de uma vez.
-- Vive em `public` porque PostgREST só expõe esse schema.

alter table public.stock_categories
  add column if not exists alerts_enabled        boolean not null default true,
  add column if not exists auto_min_max_enabled  boolean not null default false,
  add column if not exists auto_shopping_enabled boolean not null default true;

create or replace function public.set_category_auto_min_max(p_category_id uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = 'app','public','pg_temp'
as $$
declare
  v_tenant uuid;
  v_role   text;
begin
  if auth.role() <> 'service_role' then
    if auth.uid() is null then
      raise exception 'forbidden: not authenticated' using errcode = '42501';
    end if;
    select tenant_id into v_tenant from public.stock_categories where id = p_category_id;
    if v_tenant is null then
      raise exception 'categoria % não existe', p_category_id;
    end if;
    select role::text into v_role
      from public.tenant_members
     where tenant_id = v_tenant and user_id = auth.uid();
    if v_role is null or v_role not in ('owner','admin','manager') then
      raise exception 'forbidden: caller is not owner/admin/manager of tenant %', v_tenant
        using errcode = '42501';
    end if;
  end if;

  update public.stock_categories
     set auto_min_max_enabled = p_enabled,
         updated_at = now()
   where id = p_category_id;

  update public.stock_items
     set auto_min_enabled = p_enabled
   where category_id = p_category_id
     and is_active    = true;
end;
$$;

revoke execute on function public.set_category_auto_min_max(uuid, boolean) from public, anon;
grant  execute on function public.set_category_auto_min_max(uuid, boolean) to authenticated, service_role;
