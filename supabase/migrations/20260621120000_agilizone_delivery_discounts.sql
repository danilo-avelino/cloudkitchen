-- ============================================================================
-- Investimento em descontos (Agilizone) — loja vs iFood
-- ----------------------------------------------------------------------------
-- Estende o RPC agilizone_delivery_fees: além das taxas de entrega, soma o
-- desconto patrocinado pelo iFood (cupom sponsor='IFOOD') e pela loja (todo o
-- resto), a partir de payload->'discountCoupons' de cada pedido. Alguns tenants
-- gravam o nome do cupom (PRIMEIRA COMPRA, CACTUS10, etc.) no campo `sponsor` em
-- vez do enum canônico — esses são promoções da loja, então "loja = não-IFOOD".
-- Mesmo recorte das taxas (tenant + período, exceto CANCELED/PENDING_PAYMENT).
-- Devolve total + quebra por operação.
-- SECURITY INVOKER: a RLS de agilizone_orders (is_tenant_member) garante o escopo.
-- Consumidores: Dashboard (box "Investimento em descontos").
-- ============================================================================

create or replace function public.agilizone_delivery_fees(p_tenant uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security invoker
set search_path = 'public','pg_temp'
as $$
  with o as (
    select
      ao.operation_id,
      coalesce(ao.delivery_fee, 0)    as delivery_fee,
      coalesce(ao.deliveryman_fee, 0) as deliveryman_fee,
      coalesce((
        select sum((c->>'value')::numeric)
        from jsonb_array_elements(
          case when jsonb_typeof(ao.payload->'discountCoupons') = 'array'
               then ao.payload->'discountCoupons' else '[]'::jsonb end) c
        where coalesce(c->>'sponsor', '') <> 'IFOOD'
      ), 0) as store_discount,
      coalesce((
        select sum((c->>'value')::numeric)
        from jsonb_array_elements(
          case when jsonb_typeof(ao.payload->'discountCoupons') = 'array'
               then ao.payload->'discountCoupons' else '[]'::jsonb end) c
        where c->>'sponsor' = 'IFOOD'
      ), 0) as ifood_discount
    from public.agilizone_orders ao
    where ao.tenant_id = p_tenant
      and ao.business_date between p_from and p_to
      and ao.status not in ('CANCELED','PENDING_PAYMENT')
  ),
  f as (
    select operation_id,
           coalesce(sum(delivery_fee), 0)    as client_collected,
           coalesce(sum(deliveryman_fee), 0) as deliveryman_paid,
           coalesce(sum(store_discount), 0)  as store_discount,
           coalesce(sum(ifood_discount), 0)  as ifood_discount
    from o
    group by operation_id
  )
  select jsonb_build_object(
    'total', jsonb_build_object(
      'clientCollected', coalesce(sum(client_collected), 0),
      'deliverymanPaid', coalesce(sum(deliveryman_paid), 0),
      'storeDiscount',   coalesce(sum(store_discount), 0),
      'ifoodDiscount',   coalesce(sum(ifood_discount), 0)
    ),
    'byOperation', coalesce(
      jsonb_object_agg(operation_id::text, jsonb_build_object(
        'clientCollected', client_collected,
        'deliverymanPaid', deliveryman_paid,
        'storeDiscount',   store_discount,
        'ifoodDiscount',   ifood_discount
      )) filter (where operation_id is not null),
      '{}'::jsonb)
  )
  from f;
$$;

revoke execute on function public.agilizone_delivery_fees(uuid, date, date) from public, anon;
grant execute on function public.agilizone_delivery_fees(uuid, date, date) to authenticated, service_role;
