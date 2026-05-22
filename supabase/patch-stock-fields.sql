-- =====================================================================
-- PATCH · adiciona campos que o frontend usa mas faltam no schema:
--   stock_items.max_qty       (estoque máximo desejado · alvo após compra)
--   stock_items.compose_cmv   (toggle "compor CMV" por insumo)
--   stock_items.supplier_id   (FK pro fornecedor preferido)
-- IDEMPOTENTE: pode rodar quantas vezes quiser.
-- =====================================================================

alter table public.stock_items
  add column if not exists max_qty      numeric(14,4),
  add column if not exists compose_cmv  boolean not null default true,
  add column if not exists supplier_id  uuid references public.suppliers(id) on delete set null;

create index if not exists stock_items_supplier_idx
  on public.stock_items (supplier_id) where supplier_id is not null;

-- Verificação
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'stock_items'
  and column_name in ('max_qty', 'compose_cmv', 'supplier_id');
