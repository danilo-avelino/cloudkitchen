-- ============================================================================
-- Arrecadação de taxas de entrega (Agilizone)
-- ----------------------------------------------------------------------------
-- RPC read-only que soma, no recorte (tenant + período, exceto CANCELED/
-- PENDING_PAYMENT), a taxa cobrada do cliente (delivery_fee) e a taxa paga ao
-- entregador (deliveryman_fee). Devolve o total do tenant + quebra por operação
-- (byOperation), pois o dashboard calcula os KPIs por escopo no cliente.
-- SECURITY INVOKER: a RLS de agilizone_orders (is_tenant_member) garante o escopo.
-- Consumidores: aba Entregadores (Tempos de Delivery) e Dashboard.
-- ============================================================================

create or replace function public.agilizone_delivery_fees(p_tenant uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security invoker
set search_path = 'public','pg_temp'
as $$
  with f as (
    select operation_id,
           coalesce(sum(delivery_fee), 0)    as client_collected,
           coalesce(sum(deliveryman_fee), 0) as deliveryman_paid
    from public.agilizone_orders
    where tenant_id = p_tenant
      and business_date between p_from and p_to
      and status not in ('CANCELED','PENDING_PAYMENT')
    group by operation_id
  )
  select jsonb_build_object(
    'total', jsonb_build_object(
      'clientCollected', coalesce(sum(client_collected), 0),
      'deliverymanPaid', coalesce(sum(deliveryman_paid), 0)
    ),
    'byOperation', coalesce(
      jsonb_object_agg(operation_id::text, jsonb_build_object(
        'clientCollected', client_collected,
        'deliverymanPaid', deliveryman_paid
      )) filter (where operation_id is not null),
      '{}'::jsonb)
  )
  from f;
$$;

revoke execute on function public.agilizone_delivery_fees(uuid, date, date) from public, anon;
grant execute on function public.agilizone_delivery_fees(uuid, date, date) to authenticated, service_role;
