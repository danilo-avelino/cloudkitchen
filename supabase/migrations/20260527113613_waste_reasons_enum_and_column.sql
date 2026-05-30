do $$ begin
  create type app.waste_reason as enum (
    'vencido',
    'danificado',
    'estragado',
    'fora_de_uso'
  );
exception when duplicate_object then null; end $$;

alter table public.stock_movements
  add column if not exists loss_reason app.waste_reason;

create index if not exists stock_movements_loss_reason_idx
  on public.stock_movements (tenant_id, loss_reason, performed_at desc)
  where loss_reason is not null;;
