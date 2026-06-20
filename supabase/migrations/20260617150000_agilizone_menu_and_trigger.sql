-- ============================================================================
-- Cardápio (vendas por item) + trigger de ingest em background
-- ============================================================================

-- 1. Vendas consolidadas por item (para a aba Cardápio).
--    SECURITY INVOKER: RLS de agilizone_orders/items garante o escopo do tenant.
create or replace function public.agilizone_menu_sales(
  p_tenant uuid, p_from date, p_to date, p_operation uuid default null
)
returns table (
  name text, external_code text, lines bigint, qty numeric, total numeric, avg_price numeric
)
language sql
stable
security invoker
set search_path = 'public','pg_temp'
as $$
  select
    i.name,
    max(i.external_code)                              as external_code,
    count(*)                                          as lines,
    sum(i.quantity)                                   as qty,
    round(sum(coalesce(i.total_price, 0)), 2)         as total,
    case when sum(i.quantity) > 0
      then round(sum(coalesce(i.total_price, 0)) / sum(i.quantity), 2) end as avg_price
  from public.agilizone_order_items i
  join public.agilizone_orders o on o.id = i.order_id
  where o.tenant_id = p_tenant
    and o.business_date between p_from and p_to
    and o.status not in ('CANCELED','PENDING_PAYMENT')
    and o.operation_id is not null
    and (p_operation is null or o.operation_id = p_operation)
  group by i.name
  order by sum(coalesce(i.total_price, 0)) desc;
$$;

revoke execute on function public.agilizone_menu_sales(uuid, date, date, uuid) from public, anon;
grant execute on function public.agilizone_menu_sales(uuid, date, date, uuid) to authenticated, service_role;

-- 2. Dispara o ingest em background (pg_net) — usado após mapear marcas e no
--    botão "Sincronizar". service_role-only; lê o shared-secret do Vault.
create or replace function public.agilizone_trigger_ingest(p_account uuid, p_lookback int default 7)
returns bigint
language plpgsql
security definer
set search_path = 'public','pg_temp'
as $$
declare
  v_secret text;
  v_req    bigint;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'agilizone_ingest_secret' limit 1;
  if v_secret is null then raise exception 'agilizone_ingest_secret ausente no Vault'; end if;

  select net.http_post(
    url := 'https://dnvrerivultswuirxnns.supabase.co/functions/v1/agilizone-ingest',
    body := jsonb_build_object('accountId', p_account::text, 'lookbackDays', p_lookback),
    headers := jsonb_build_object('Content-Type','application/json','x-ingest-secret', v_secret),
    timeout_milliseconds := 280000
  ) into v_req;
  return v_req;
end $$;

revoke execute on function public.agilizone_trigger_ingest(uuid, int) from public, anon, authenticated;
grant execute on function public.agilizone_trigger_ingest(uuid, int) to service_role;
