-- Item criado numa categoria com auto min/max ligado já nasce com o cálculo
-- automático ligado ('weekly', o mesmo modo que set_category_auto_min_max aplica
-- nos itens existentes). Sem isso só os itens que já existiam ao ligar a
-- categoria ficavam automáticos.
create or replace function app.tg_stock_item_inherit_category_auto()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
begin
  if new.auto_min_mode = 'off'
     and new.category_id is not null
     and exists (select 1 from public.stock_categories c
                  where c.id = new.category_id and c.auto_min_max_enabled) then
    new.auto_min_mode    := 'weekly';
    new.auto_min_enabled := true;
  end if;
  return new;
end;
$$;

drop trigger if exists tg_stock_items_inherit_category_auto on public.stock_items;
create trigger tg_stock_items_inherit_category_auto
  before insert on public.stock_items
  for each row execute function app.tg_stock_item_inherit_category_auto();

-- GRANTs (CLAUDE.md §5.2)
grant usage on schema app to authenticated, anon, service_role;
grant execute on all functions in schema app to authenticated, anon, service_role;
alter default privileges in schema app
  grant execute on functions to authenticated, anon, service_role;
