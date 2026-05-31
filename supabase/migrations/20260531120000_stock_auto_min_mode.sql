-- Dois modos de auto min/max por item de estoque:
--   weekly  · min = ceil(daily*7), max = ceil(min*1.3)   (reposição frequente, estoque enxuto)
--   monthly · min = ceil(daily*7), max = ceil(daily*35)  (mesmo ponto de pedir, compra p/ 5 semanas)
-- 'off' desliga. auto_min_enabled fica em sync (true sse mode <> 'off') por retrocompat.
--
-- Decisão de produto (2026-05-31): ponto de reposição (min) é igual nos dois modos —
-- 1 semana de buffer antes de zerar. O que muda é o teto de compra (max): semanal
-- repõe pouco (vai comprar de novo logo), mensal compra para ~5 semanas.

alter table public.stock_items
  add column if not exists auto_min_mode text not null default 'off'
    check (auto_min_mode in ('off','weekly','monthly'));

update public.stock_items
   set auto_min_mode = 'weekly'
 where auto_min_enabled = true and auto_min_mode = 'off';

-- compute_auto_min_max · ramifica por modo. INVOKER + search_path lock (NÃO DEFINER:
-- é função de trigger interna, não deve ser exposta como RPC).
create or replace function public.compute_auto_min_max(p_item_id uuid)
returns void
language plpgsql
set search_path = 'app','public','pg_temp'
as $function$
declare
  v_total_30 numeric;
  v_total_7  numeric;
  v_daily    numeric;
  v_min      numeric;
  v_max      numeric;
  v_mode     text;
begin
  select auto_min_mode into v_mode from public.stock_items where id = p_item_id;
  if v_mode is null or v_mode = 'off' then return; end if;

  select coalesce(sum(abs(qty)), 0) into v_total_30
    from public.stock_movements
   where stock_item_id = p_item_id
     and kind = 'out'
     and performed_at >= now() - interval '30 days';

  if v_total_30 > 0 then
    v_daily := v_total_30 / 30.0;
  else
    select coalesce(sum(abs(qty)), 0) into v_total_7
      from public.stock_movements
     where stock_item_id = p_item_id
       and kind = 'out'
       and performed_at >= now() - interval '7 days';
    v_daily := v_total_7 / 7.0;
  end if;

  if v_daily <= 0 then return; end if;

  v_min := ceil(v_daily * 7);
  if v_mode = 'monthly' then
    v_max := ceil(v_daily * 35);
  else
    v_max := ceil(v_min * 1.3);
  end if;

  update public.stock_items
     set reorder_point = v_min,
         max_qty       = v_max
   where id = p_item_id;
end;
$function$;

-- Recalcula quando o modo muda (não só em movimentação)
create or replace function public.trg_recompute_on_toggle()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $function$
begin
  if NEW.auto_min_mode is distinct from OLD.auto_min_mode and NEW.auto_min_mode <> 'off' then
    perform public.compute_auto_min_max(NEW.id);
  end if;
  return NEW;
end;
$function$;

drop trigger if exists trg_stock_item_auto_min_toggle on public.stock_items;
create trigger trg_stock_item_auto_min_toggle
  after update of auto_min_mode on public.stock_items
  for each row execute function public.trg_recompute_on_toggle();

-- Cascade de categoria sincroniza auto_min_mode junto com auto_min_enabled
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
     set auto_min_enabled = p_enabled,
         auto_min_mode    = case when p_enabled then 'weekly' else 'off' end
   where category_id = p_category_id
     and is_active    = true;
end;
$$;

revoke execute on function public.set_category_auto_min_max(uuid, boolean) from public, anon;
grant  execute on function public.set_category_auto_min_max(uuid, boolean) to authenticated, service_role;
