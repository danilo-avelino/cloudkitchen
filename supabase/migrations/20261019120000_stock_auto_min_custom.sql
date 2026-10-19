-- Modo 'custom' no auto min/max: o usuário define N dias de cobertura.
--   custom · min = ceil(daily*N), max = ceil(min*1.3)   (Semanal com N no lugar de 7)
-- N fica em stock_items.auto_min_days (obrigatório quando mode = 'custom').

alter table public.stock_items
  add column if not exists auto_min_days integer
    check (auto_min_days between 1 and 365);

-- Troca o check inline de auto_min_mode (nome gerado pelo Postgres) por um que aceita 'custom'.
do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.stock_items'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) like '%auto_min_mode%'
  loop
    execute format('alter table public.stock_items drop constraint %I', v_name);
  end loop;
end $$;

alter table public.stock_items
  add constraint stock_items_auto_min_mode_check
    check (auto_min_mode in ('off','weekly','monthly','custom')),
  add constraint stock_items_auto_min_custom_days_check
    check (auto_min_mode <> 'custom' or auto_min_days is not null);

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
  v_days     integer;
begin
  select auto_min_mode, auto_min_days into v_mode, v_days from public.stock_items where id = p_item_id;
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

  if v_mode = 'custom' then
    v_min := ceil(v_daily * coalesce(v_days, 7));
    v_max := ceil(v_min * 1.3);
  else
    v_min := ceil(v_daily * 7);
    if v_mode = 'monthly' then
      v_max := ceil(v_daily * 35);
    else
      v_max := ceil(v_min * 1.3);
    end if;
  end if;

  update public.stock_items
     set reorder_point = v_min,
         max_qty       = v_max
   where id = p_item_id;
end;
$function$;

-- Recalcula também quando muda a quantidade de dias do modo personalizado
create or replace function public.trg_recompute_on_toggle()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $function$
begin
  if NEW.auto_min_mode <> 'off'
     and (NEW.auto_min_mode is distinct from OLD.auto_min_mode
          or NEW.auto_min_days is distinct from OLD.auto_min_days) then
    perform public.compute_auto_min_max(NEW.id);
  end if;
  return NEW;
end;
$function$;

drop trigger if exists trg_stock_item_auto_min_toggle on public.stock_items;
create trigger trg_stock_item_auto_min_toggle
  after update of auto_min_mode, auto_min_days on public.stock_items
  for each row execute function public.trg_recompute_on_toggle();

-- Guarda da central: auto_min_days também é parâmetro gerido pela central.
create or replace function app.tg_stock_item_central_guard()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
declare
  v_central uuid := coalesce(old.managed_by_central_id, new.managed_by_central_id);
begin
  if v_central is null then
    return new;
  end if;
  -- Updates disparados de dentro de outro trigger (recálculo automático) passam.
  if pg_trigger_depth() > 1 or auth.role() = 'service_role' then
    return new;
  end if;
  -- Gestor da central pode tudo, inclusive assumir/soltar a gestão do item.
  if app.supply_is_manager(v_central) then
    return new;
  end if;
  if new.managed_by_central_id is distinct from old.managed_by_central_id then
    raise exception 'só a central da rede pode alterar a gestão de "%"', old.name;
  end if;
  if new.reorder_point   is distinct from old.reorder_point
     or new.max_qty      is distinct from old.max_qty
     or new.auto_min_mode is distinct from old.auto_min_mode
     or new.auto_min_days is distinct from old.auto_min_days
     or new.auto_min_enabled is distinct from old.auto_min_enabled then
    raise exception 'mín/máx de "%" é gerido pela central da rede de suprimentos', old.name;
  end if;
  return new;
end;
$$;

-- GRANTs (CLAUDE.md §5.2)
grant usage on schema app to authenticated, anon, service_role;
grant execute on all functions in schema app to authenticated, anon, service_role;
alter default privileges in schema app
  grant execute on functions to authenticated, anon, service_role;
