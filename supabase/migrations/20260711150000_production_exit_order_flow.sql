-- =====================================================================
-- Produção: fluxo de ORDEM DE SAÍDA (pedido do usuário em 2026-07-11)
--
-- Antes: a ordem exigia insumos E transformados definidos na criação.
-- Agora: a ordem de saída leva só os INSUMOS — envia à produção (baixa o
-- estoque) e fica aguardando o retorno. Os transformados devolvidos são
-- informados na DEVOLUÇÃO (status issued), e só então o custo é convertido.
--
-- Mudanças (create or replace — pode colar no SQL Editor por cima do patch):
--  1. tg_check_production_output: saídas podem ser inseridas/removidas também
--     com a ordem em 'issued' (a devolução cria as linhas com returned_qty).
--  2. tg_production_order_transition: o envio (draft→issued) não exige mais
--     saídas nem valida porção — essas validações acontecem no completed,
--     quando as saídas existem de fato.
-- =====================================================================

-- ---------- 1. Saídas: editáveis em draft E issued ---------------------
create or replace function app.tg_check_production_output()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
declare
  v_order record;
  v_item  record;
begin
  select tenant_id, status into v_order
    from public.production_orders
   where id = coalesce(new.order_id, old.order_id);
  if v_order is null then
    raise exception 'production_order_outputs: ordem não encontrada';
  end if;

  if tg_op = 'DELETE' then
    -- issued: a devolução pode substituir linhas; cancelled: cascata do delete
    if v_order.status not in ('draft','issued','cancelled') then
      raise exception 'Saídas de ordem % não podem ser removidas', v_order.status;
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' and v_order.status not in ('draft','issued') then
    raise exception 'Saídas só podem ser lançadas com a ordem em rascunho ou aguardando retorno';
  end if;

  if tg_op = 'UPDATE' then
    if v_order.status in ('draft','issued') then
      null; -- editável até o retorno ser confirmado (o completed congela tudo)
    else
      raise exception 'Saídas de ordem % não podem ser alteradas', v_order.status;
    end if;
  end if;

  select tenant_id, item_kind into v_item from public.stock_items where id = new.stock_item_id;
  if v_item is null or v_item.tenant_id <> v_order.tenant_id then
    raise exception 'production_order_outputs: stock_item pertence a outro tenant';
  end if;
  if v_item.item_kind <> 'transformed' then
    raise exception 'A saída da produção precisa ser um item transformado (item_kind=transformed)';
  end if;
  return new;
end;
$$;

-- ---------- 2. Transição: envio não exige saídas ------------------------
create or replace function app.tg_production_order_transition()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
declare
  r               record;
  v_total_cost    numeric(14,4) := 0;
  v_input_weight  numeric(14,4);
  v_output_weight numeric(14,4);
  v_w             numeric;
  v_out_count     int;
  v_sum_weight    numeric(14,4);
  v_share         numeric(14,4);
  v_unit_cost     numeric(12,4);
begin
  if tg_op <> 'UPDATE' or new.status = old.status then
    return new;
  end if;

  -- Transições válidas
  if not (
       (old.status = 'draft'  and new.status in ('issued','cancelled'))
    or (old.status = 'issued' and new.status in ('completed','cancelled'))
  ) then
    raise exception 'Transição de status inválida: % → %', old.status, new.status;
  end if;

  -- ===== draft → issued (ordem de saída): snapshot de custos + baixa =====
  -- Os transformados NÃO são exigidos aqui — serão lançados na devolução.
  if new.status = 'issued' then
    if not exists (select 1 from public.production_order_inputs where order_id = new.id) then
      raise exception 'A ordem precisa de pelo menos um insumo';
    end if;

    v_input_weight := 0;
    for r in
      select pi.id, pi.stock_item_id, pi.qty, pi.unit, si.name, si.unit_cost as cost_now, si.current_qty
        from public.production_order_inputs pi
        join public.stock_items si on si.id = pi.stock_item_id
       where pi.order_id = new.id
    loop
      if r.current_qty < r.qty then
        raise exception 'Saldo insuficiente de "%" (disponível %, necessário %)', r.name, r.current_qty, r.qty;
      end if;
      -- Snapshot do custo atual (última compra)
      update public.production_order_inputs
         set unit_cost = round(coalesce(r.cost_now, 0), 4)
       where id = r.id;
      v_total_cost := v_total_cost + round(r.qty * coalesce(r.cost_now, 0), 4);

      v_w := app.production_weight_kg(r.qty, r.unit);
      if v_w is not null and v_input_weight is not null then
        v_input_weight := v_input_weight + v_w;
      else
        v_input_weight := null; -- alguma unidade não-mássica → peso indefinido
      end if;

      insert into public.stock_movements
        (tenant_id, stock_item_id, kind, qty, unit_cost, notes, reference_type, reference_id, performed_by)
      values
        (new.tenant_id, r.stock_item_id, 'out', -r.qty, round(coalesce(r.cost_now,0),4),
         'Produção ' || coalesce(new.code, new.id::text),
         'production_order', new.id, coalesce(new.issued_by, auth.uid()));
    end loop;

    new.total_input_cost := v_total_cost;
    new.input_weight     := v_input_weight;
    if new.issued_at is null then new.issued_at := now(); end if;
    if new.issued_by is null then new.issued_by := auth.uid(); end if;
    return new;
  end if;

  -- ===== issued → completed (devolução): rateio por peso + entrada =====
  if new.status = 'completed' then
    select count(*) into v_out_count
      from public.production_order_outputs
     where order_id = new.id and coalesce(returned_qty, 0) > 0;

    if v_out_count = 0 then
      raise exception 'Informe as porções devolvidas de pelo menos um transformado';
    end if;

    -- Peso devolvido por saída (returned_qty × portion_qty, em kg)
    select sum(app.production_weight_kg(po.returned_qty * si.portion_qty, coalesce(si.portion_unit,'kg')))
      into v_sum_weight
      from public.production_order_outputs po
      join public.stock_items si on si.id = po.stock_item_id
     where po.order_id = new.id
       and coalesce(po.returned_qty, 0) > 0;

    if v_out_count > 1 and coalesce(v_sum_weight, 0) <= 0 then
      raise exception 'Devolução com vários transformados exige porção (em kg/g) definida em todos — o custo é rateado por peso';
    end if;

    v_output_weight := 0;
    for r in
      select po.id, po.stock_item_id, po.returned_qty, si.name, si.portion_qty, si.portion_unit
        from public.production_order_outputs po
        join public.stock_items si on si.id = po.stock_item_id
       where po.order_id = new.id
    loop
      if coalesce(r.returned_qty, 0) <= 0 then
        -- Saída sem retorno: zera snapshots e não gera movimento
        update public.production_order_outputs
           set weight_qty = null, cost_share = 0, unit_cost = null
         where id = r.id;
        continue;
      end if;

      v_w := case when r.portion_qty is not null
                  then app.production_weight_kg(r.returned_qty * r.portion_qty, coalesce(r.portion_unit,'kg'))
                  else null end;
      -- Multi-saída sem peso conversível numa saída devolvida → rateio impossível
      if v_out_count > 1 and v_w is null then
        raise exception 'Rateio por peso: a porção de "%" precisa estar em kg ou g', r.name;
      end if;
      if v_w is not null and v_output_weight is not null then
        v_output_weight := v_output_weight + v_w;
      elsif v_w is null then
        v_output_weight := null;
      end if;

      -- Rateio: saída única leva 100%; multi-saída rateia por peso
      if v_out_count = 1 then
        v_share := coalesce(new.total_input_cost, 0);
      else
        v_share := round(coalesce(new.total_input_cost, 0) * v_w / v_sum_weight, 4);
      end if;
      v_unit_cost := case when r.returned_qty > 0 then round(v_share / r.returned_qty, 4) else null end;

      update public.production_order_outputs
         set weight_qty = v_w, cost_share = v_share, unit_cost = v_unit_cost
       where id = r.id;

      insert into public.stock_movements
        (tenant_id, stock_item_id, kind, qty, unit_cost, notes, reference_type, reference_id, performed_by)
      values
        (new.tenant_id, r.stock_item_id, 'in', r.returned_qty, v_unit_cost,
         'Retorno produção ' || coalesce(new.code, new.id::text),
         'production_order', new.id, coalesce(new.completed_by, auth.uid()));
    end loop;

    new.output_weight := v_output_weight;
    if new.input_weight is not null and new.input_weight > 0 and v_output_weight is not null then
      new.yield_pct := round((v_output_weight / new.input_weight) * 100, 2);
      new.waste_qty := greatest(new.input_weight - v_output_weight, 0);
    end if;
    if new.completed_at is null then new.completed_at := now(); end if;
    if new.completed_by is null then new.completed_by := auth.uid(); end if;
    return new;
  end if;

  -- ===== cancelamento =====
  if new.status = 'cancelled' then
    if old.status = 'issued' then
      -- Movimentos imutáveis: cancelar = movimentos inversos (in) dos insumos
      for r in
        select stock_item_id, qty, unit_cost
          from public.production_order_inputs
         where order_id = new.id
      loop
        insert into public.stock_movements
          (tenant_id, stock_item_id, kind, qty, unit_cost, notes, reference_type, reference_id, performed_by)
        values
          (new.tenant_id, r.stock_item_id, 'in', r.qty, r.unit_cost,
           'Cancelamento produção ' || coalesce(new.code, new.id::text),
           'production_order', new.id, auth.uid());
      end loop;
    end if;
    return new;
  end if;

  return new;
end;
$$;

-- ---------- 3. GRANTs (CLAUDE.md §5.2 / §5.3) --------------------------
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
