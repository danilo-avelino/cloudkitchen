-- =====================================================================
-- Divergência de recebimento na rede de suprimentos
-- (evolução de 20260811120000_supply_direct_kitchen_per_item)
--
-- Quem recebe confere item a item e informa a quantidade que REALMENTE
-- chegou. Regra escolhida: "entra o que chegou, cobra o que chegou".
--
--  • supply_transfer_items.received_qty / divergence_reason: a conferência.
--    received_qty null = não conferido (recebimentos antigos) → assume qty.
--  • supply_transfers.received_value: soma de received_qty × unit_cost —
--    é o valor que vai pro ledger e pro financeiro dos dois lados.
--    total_value continua sendo o valor ENVIADO (documento, imutável).
--  • supply_transfers.divergence_value = received_value − total_value
--    (negativo = faltou, positivo = sobrou). A perda por falta fica com
--    quem enviou: a central já baixou do estoque e não é paga por ela.
--  • view supply_divergence_lines: alimenta a aba Divergências dos dois
--    módulos (Central e Cadeia de suprimentos).
-- =====================================================================

-- ---------- 1. Colunas ---------------------------------------------------
alter table public.supply_transfer_items
  add column if not exists received_qty       numeric(14,4) check (received_qty >= 0),
  add column if not exists divergence_reason  text
    check (divergence_reason in ('faltou','avaria','sobra','contagem','outro'));

alter table public.supply_transfers
  add column if not exists received_value   numeric(14,4),
  add column if not exists divergence_value numeric(14,4) not null default 0,
  add column if not exists divergence_notes text;

comment on column public.supply_transfer_items.received_qty is
  'Quantidade conferida no recebimento. NULL = não conferido (assume qty).';
comment on column public.supply_transfers.received_value is
  'Valor efetivamente recebido (received_qty × unit_cost) — é o que vai pro ledger/financeiro.';
comment on column public.supply_transfers.divergence_value is
  'received_value − total_value. Negativo = faltou; positivo = sobrou.';

-- Aba Divergências filtra por período sobre os recebimentos da rede
create index if not exists supply_transfers_received_idx
  on public.supply_transfers (central_tenant_id, received_at desc)
  where status = 'received';

-- ---------- 2. Transição da transferência --------------------------------
-- Igual a 20260811120000, exceto o ramo sent → received: as entradas usam a
-- quantidade conferida e o ledger/financeiro passam a cobrar o valor recebido.
create or replace function app.tg_supply_transfer_transition()
returns trigger
language plpgsql
security definer
set search_path = 'app','public','pg_temp'
as $$
declare
  r record;
  v_total numeric(14,4) := 0;
  v_to_item uuid;
  v_cat uuid;
  v_direct boolean;
  v_op uuid;
  v_recv numeric(14,4);
  v_recv_total numeric(14,4) := 0;
begin
  if tg_op <> 'UPDATE' then return new; end if;

  -- Campos estruturais são imutáveis fora do rascunho
  if old.status <> 'draft' then
    new.central_tenant_id := old.central_tenant_id;
    new.from_tenant_id    := old.from_tenant_id;
    new.to_tenant_id      := old.to_tenant_id;
    new.code              := old.code;
    new.request_id        := old.request_id;
    new.total_value       := old.total_value;
  end if;

  if new.status = old.status then
    if old.status <> 'draft' then
      -- fora do draft, só o receive (mesma transação) mexe — bloqueia edição solta
      if new.direct_to_kitchen <> old.direct_to_kitchen
         or coalesce(new.receive_operation_id::text,'') <> coalesce(old.receive_operation_id::text,'')
         or coalesce(new.notes,'') <> coalesce(old.notes,'')
         or coalesce(new.divergence_notes,'') <> coalesce(old.divergence_notes,'')
         or new.received_value   is distinct from old.received_value
         or new.divergence_value is distinct from old.divergence_value then
        raise exception 'transferência % não pode mais ser editada', old.status;
      end if;
    end if;
    return new;
  end if;

  -- ===== draft → sent (remetente): guard de saldo + baixa + snapshots =====
  if old.status = 'draft' and new.status = 'sent' then
    if not app.supply_can_write(old.from_tenant_id) then
      raise exception 'sem permissão para enviar (módulo Suprimentos/Central do remetente)';
    end if;
    if not exists (select 1 from public.supply_transfer_items where transfer_id = new.id) then
      raise exception 'adicione pelo menos um item antes de enviar';
    end if;
    for r in
      select ti.id, ti.from_item_id, ti.qty, ti.display_name,
             si.current_qty, si.unit_cost
        from public.supply_transfer_items ti
        left join public.stock_items si on si.id = ti.from_item_id
       where ti.transfer_id = new.id
    loop
      if r.from_item_id is null then
        raise exception 'item "%" sem vínculo com o estoque do remetente', r.display_name;
      end if;
      if r.current_qty < r.qty then
        raise exception 'Saldo insuficiente de "%" (disponível %, necessário %)',
          r.display_name, r.current_qty, r.qty;
      end if;
      update public.supply_transfer_items
         set unit_cost = round(coalesce(r.unit_cost, 0), 4)
       where id = r.id;
      v_total := v_total + round(r.qty * coalesce(r.unit_cost, 0), 4);

      insert into public.stock_movements
        (tenant_id, stock_item_id, kind, qty, unit_cost, notes, reference_type, reference_id, performed_by)
      values
        (old.from_tenant_id, r.from_item_id, 'out', -r.qty, round(coalesce(r.unit_cost,0),4),
         'Transferência ' || coalesce(new.code, new.id::text) || ' → ' || coalesce(new.to_name,'—'),
         'supply_transfer', new.id, coalesce(new.sent_by, auth.uid()));
    end loop;
    new.total_value := v_total;
    if new.sent_at is null then new.sent_at := now(); end if;
    if new.sent_by is null then new.sent_by := auth.uid(); end if;
    return new;
  end if;

  -- ===== sent → received (destinatário): confere, dá entrada, ledger, finance =====
  if old.status = 'sent' and new.status = 'received' then
    if not app.supply_can_write(old.to_tenant_id) then
      raise exception 'sem permissão para receber (módulo Cadeia de suprimentos do destinatário)';
    end if;

    for r in
      select ti.id, ti.from_item_id, ti.to_item_id, ti.display_name, ti.item_kind,
             ti.category_name, ti.qty, ti.unit, ti.unit_cost, ti.portion_qty, ti.portion_unit,
             ti.direct_to_kitchen, ti.receive_operation_id, ti.received_qty
        from public.supply_transfer_items ti
       where ti.transfer_id = new.id
    loop
      -- Quantidade conferida pelo destinatário (null = não conferiu → assume o enviado)
      v_recv := coalesce(r.received_qty, r.qty);
      v_recv_total := v_recv_total + round(v_recv * r.unit_cost, 4);

      -- Item que não chegou não gera movimento nem cria insumo no destino —
      -- só entra na divergência.
      if v_recv <= 0 then
        continue;
      end if;

      -- Direto na cozinha é por item; o flag da transferência é o fallback
      -- (linhas gravadas antes de 20260811120000).
      v_direct := coalesce(r.direct_to_kitchen, false) or coalesce(new.direct_to_kitchen, false);
      v_op     := coalesce(r.receive_operation_id, new.receive_operation_id);
      if v_direct then
        if v_op is null then
          raise exception 'escolha a operação de "%" para entregar direto na cozinha', r.display_name;
        end if;
        if not exists (select 1 from public.operations o
                        where o.id = v_op and o.tenant_id = old.to_tenant_id) then
          raise exception 'operação de "%" não pertence ao tenant destinatário', r.display_name;
        end if;
      end if;

      -- 1) link memorizado (catálogo de abastecimento ou recebimento anterior)
      v_to_item := null;
      select l.to_item_id into v_to_item
        from public.supply_item_links l
        join public.stock_items si on si.id = l.to_item_id and si.is_active
       where l.central_tenant_id = old.central_tenant_id
         and l.from_item_id = r.from_item_id
         and l.to_tenant_id = old.to_tenant_id;

      -- 2) match por nome+unidade no destino
      if v_to_item is null then
        select si.id into v_to_item
          from public.stock_items si
         where si.tenant_id = old.to_tenant_id
           and si.is_active
           and lower(trim(si.name)) = lower(trim(r.display_name))
           and si.unit = r.unit
         order by si.created_at limit 1;
      end if;

      -- 3) cria o item no destino (categoria mapeada por nome quando existir)
      if v_to_item is null then
        v_cat := null;
        if r.category_name is not null then
          select id into v_cat from public.stock_categories
           where tenant_id = old.to_tenant_id
             and lower(trim(name)) = lower(trim(r.category_name))
           limit 1;
        end if;
        insert into public.stock_items
          (tenant_id, name, unit, unit_cost, current_qty, item_kind, portion_qty, portion_unit, category_id)
        values
          (old.to_tenant_id, r.display_name, r.unit, r.unit_cost, 0,
           coalesce(r.item_kind,'raw'), r.portion_qty, r.portion_unit, v_cat)
        returning id into v_to_item;
      end if;

      -- memoriza o mapeamento p/ próximas transferências
      if r.from_item_id is not null then
        insert into public.supply_item_links (central_tenant_id, from_item_id, to_tenant_id, to_item_id)
        values (old.central_tenant_id, r.from_item_id, old.to_tenant_id, v_to_item)
        on conflict (central_tenant_id, from_item_id, to_tenant_id)
          do update set to_item_id = excluded.to_item_id, updated_at = now();
      end if;

      update public.supply_transfer_items set to_item_id = v_to_item where id = r.id;

      insert into public.stock_movements
        (tenant_id, stock_item_id, kind, qty, unit_cost, notes, reference_type, reference_id, performed_by)
      values
        (old.to_tenant_id, v_to_item, 'in', v_recv, r.unit_cost,
         'Transferência ' || coalesce(old.code, new.id::text) || ' · ' || coalesce(old.from_name,'—'),
         'supply_transfer', new.id, coalesce(new.received_by, auth.uid()));

      -- direto na cozinha: saída imediata que COMPÕE o CMV da operação do item
      if v_direct then
        insert into public.stock_movements
          (tenant_id, stock_item_id, operation_id, kind, qty, unit_cost, notes, reference_type, reference_id, performed_by)
        values
          (old.to_tenant_id, v_to_item, v_op, 'out', -v_recv, r.unit_cost,
           'Transferência ' || coalesce(old.code, new.id::text) || ' · direto na cozinha',
           'supply_transfer_kitchen', new.id, coalesce(new.received_by, auth.uid()));
      end if;

      -- memoriza a escolha p/ o próximo recebimento deste item
      update public.stock_items
         set auto_direct_kitchen         = v_direct,
             direct_kitchen_operation_id = coalesce(v_op, direct_kitchen_operation_id)
       where id = v_to_item;
    end loop;

    new.received_value   := v_recv_total;
    new.divergence_value := round(v_recv_total - coalesce(old.total_value, 0), 4);

    -- Ledger de Gastos e financeiro cobram o que CHEGOU, não o que foi enviado.
    -- A diferença é perda de quem enviou (o estoque dele já saiu no envio) e
    -- fica visível na aba Divergências dos dois lados.
    if v_recv_total <> 0 then
      if old.from_tenant_id = old.central_tenant_id then
        insert into public.supply_ledger_entries (central_tenant_id, tenant_id, delta, kind, transfer_id, created_by)
        values (old.central_tenant_id, old.to_tenant_id, v_recv_total, 'transfer_in', new.id, auth.uid());
      elsif old.to_tenant_id = old.central_tenant_id then
        insert into public.supply_ledger_entries (central_tenant_id, tenant_id, delta, kind, transfer_id, created_by)
        values (old.central_tenant_id, old.from_tenant_id, -v_recv_total, 'transfer_out', new.id, auth.uid());
      else
        insert into public.supply_ledger_entries (central_tenant_id, tenant_id, delta, kind, transfer_id, created_by)
        values (old.central_tenant_id, old.from_tenant_id, -v_recv_total, 'transfer_out', new.id, auth.uid()),
               (old.central_tenant_id, old.to_tenant_id,    v_recv_total, 'transfer_in',  new.id, auth.uid());
      end if;

      -- Financeiro (CMV real = EI + Compras − EF dos dois lados)
      perform app.supply_finance_entry(old.to_tenant_id,  v_recv_total,
        'Transferência ' || coalesce(old.code,'') || ' · recebida de ' || coalesce(old.from_name,'—'), new.id);
      perform app.supply_finance_entry(old.from_tenant_id, -v_recv_total,
        'Transferência ' || coalesce(old.code,'') || ' · enviada para ' || coalesce(old.to_name,'—'), new.id);
    end if;

    -- Solicitação vinculada vira 'fulfilled'
    if old.request_id is not null then
      perform set_config('app.supply_receive', '1', true);
      update public.supply_requests
         set status = 'fulfilled', responded_at = coalesce(responded_at, now())
       where id = old.request_id and status in ('pending','approved');
      perform set_config('app.supply_receive', '0', true);
    end if;

    if new.received_at is null then new.received_at := now(); end if;
    if new.received_by is null then new.received_by := auth.uid(); end if;
    return new;
  end if;

  -- ===== cancelamento =====
  if new.status = 'cancelled' and old.status in ('draft','sent') then
    if not app.supply_can_write(old.from_tenant_id) then
      raise exception 'só o remetente pode cancelar a transferência';
    end if;
    if old.status = 'sent' then
      for r in
        select from_item_id, qty, unit_cost, display_name
          from public.supply_transfer_items where transfer_id = new.id
      loop
        insert into public.stock_movements
          (tenant_id, stock_item_id, kind, qty, unit_cost, notes, reference_type, reference_id, performed_by)
        values
          (old.from_tenant_id, r.from_item_id, 'in', r.qty, r.unit_cost,
           'Cancelamento transferência ' || coalesce(old.code, new.id::text),
           'supply_transfer', new.id, auth.uid());
      end loop;
    end if;
    return new;
  end if;

  raise exception 'Transição de status inválida: % → %', old.status, new.status;
end;
$$;

-- ---------- 3. RPC de recebimento ----------------------------------------
-- p_items: [{ "itemId": uuid, "direct": bool, "operationId": uuid|null,
--             "receivedQty": numeric|null, "reason": text|null }]
-- Grava a conferência linha a linha e vira o status na mesma transação.
create or replace function public.supply_receive_transfer(
  p_transfer uuid, p_items jsonb, p_notes text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = 'app','public','pg_temp'
as $$
declare
  v_tr   record;
  r      jsonb;
  v_qty  numeric;
begin
  if auth.uid() is null and auth.role() <> 'service_role' then
    raise exception 'não autenticado';
  end if;

  select id, to_tenant_id, status into v_tr
    from public.supply_transfers where id = p_transfer;
  if v_tr.id is null then
    raise exception 'transferência não encontrada';
  end if;
  if not app.supply_can_write(v_tr.to_tenant_id) then
    raise exception 'sem permissão para receber esta transferência';
  end if;
  if v_tr.status <> 'sent' then
    raise exception 'transferência não está em trânsito (status %)', v_tr.status;
  end if;

  -- Zera a conferência anterior: o payload é a verdade deste recebimento.
  update public.supply_transfer_items
     set direct_to_kitchen = false, receive_operation_id = null,
         received_qty = null, divergence_reason = null
   where transfer_id = p_transfer;

  for r in select t.value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as t(value)
  loop
    v_qty := nullif(r->>'receivedQty','')::numeric;
    if v_qty is not null and v_qty < 0 then
      raise exception 'quantidade recebida não pode ser negativa';
    end if;
    update public.supply_transfer_items
       set direct_to_kitchen    = coalesce((r->>'direct')::boolean, false),
           receive_operation_id = case when coalesce((r->>'direct')::boolean, false)
                                       then nullif(r->>'operationId','')::uuid end,
           received_qty         = v_qty,
           divergence_reason    = case when v_qty is not null and v_qty <> qty
                                       then nullif(r->>'reason','') end
     where id = (r->>'itemId')::uuid
       and transfer_id = p_transfer;
  end loop;

  update public.supply_transfers
     set status           = 'received',
         received_at      = now(),
         received_by      = auth.uid(),
         divergence_notes = nullif(p_notes,'')
   where id = p_transfer and status = 'sent';
  if not found then
    raise exception 'transferência não está mais em trânsito (recarregue)';
  end if;
end;
$$;

-- Assinatura antiga (2 args) some — o front sempre passa p_notes.
drop function if exists public.supply_receive_transfer(uuid, jsonb);

-- ---------- 4. View das divergências -------------------------------------
-- Uma linha por item conferido com diferença. security_invoker: a RLS de
-- supply_transfers/_items é quem decide o que cada tenant enxerga.
drop view if exists public.supply_divergence_lines;
create view public.supply_divergence_lines
with (security_invoker = true) as
select
  ti.id                                              as item_id,
  t.id                                               as transfer_id,
  t.code,
  t.central_tenant_id,
  t.from_tenant_id,
  t.to_tenant_id,
  t.from_name,
  t.to_name,
  t.received_at,
  t.divergence_notes,
  ti.display_name,
  ti.unit,
  ti.qty                                             as sent_qty,
  ti.received_qty,
  round(ti.received_qty - ti.qty, 4)                 as delta_qty,
  ti.unit_cost,
  round((ti.received_qty - ti.qty) * ti.unit_cost, 4) as delta_value,
  ti.divergence_reason
from public.supply_transfers t
join public.supply_transfer_items ti on ti.transfer_id = t.id
where t.status = 'received'
  and ti.received_qty is not null
  and ti.received_qty <> ti.qty;

comment on view public.supply_divergence_lines is
  'Itens cuja quantidade conferida no recebimento diferiu da enviada. delta < 0 = faltou.';

-- ---------- 5. GRANTs (CLAUDE.md §5.2 / §5.3) ----------------------------
grant usage on schema app to authenticated, anon, service_role;
grant execute on all functions in schema app to authenticated, anon, service_role;
alter default privileges in schema app
  grant execute on functions to authenticated, anon, service_role;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;

GRANT SELECT ON public.supply_divergence_lines TO authenticated, service_role;
REVOKE ALL ON public.supply_divergence_lines FROM anon;

GRANT EXECUTE ON FUNCTION public.supply_receive_transfer(uuid, jsonb, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.supply_receive_transfer(uuid, jsonb, text) FROM anon, PUBLIC;
