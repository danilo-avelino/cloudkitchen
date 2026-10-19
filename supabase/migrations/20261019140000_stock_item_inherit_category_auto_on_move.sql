-- Estende 20261019130000: item movido para uma categoria com auto min/max ligado
-- também passa a ser automático ('weekly'). Sair da categoria não desliga.
-- Itens geridos pela central ficam de fora: o guard da central roda antes deste
-- trigger (ordem alfabética) e não veria a troca de modo.
create or replace function app.tg_stock_item_inherit_category_auto()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
begin
  if tg_op = 'UPDATE' and new.category_id is not distinct from old.category_id then
    return new;
  end if;
  if new.auto_min_mode = 'off'
     and new.managed_by_central_id is null
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
  before insert or update of category_id on public.stock_items
  for each row execute function app.tg_stock_item_inherit_category_auto();

-- "UPDATE OF col" olha as colunas do comando, não as alteradas por trigger BEFORE:
-- incluir category_id para o recálculo rodar quando a troca de categoria liga o modo.
drop trigger if exists trg_stock_item_auto_min_toggle on public.stock_items;
create trigger trg_stock_item_auto_min_toggle
  after update of auto_min_mode, auto_min_days, category_id on public.stock_items
  for each row execute function public.trg_recompute_on_toggle();

-- GRANTs (CLAUDE.md §5.2)
grant usage on schema app to authenticated, anon, service_role;
grant execute on all functions in schema app to authenticated, anon, service_role;
alter default privileges in schema app
  grant execute on functions to authenticated, anon, service_role;
