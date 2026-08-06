-- =====================================================================
-- Produção: permitir ordem de saída sem saldo em estoque (2026-07-13)
--
-- Pedido do usuário: a produção precisa poder retirar insumo mesmo quando o
-- estoque está zerado/atrasado no lançamento — o saldo fica NEGATIVO e é
-- regularizado depois pela entrada da compra.
--
-- Antes: draft → issued abortava com 'Saldo insuficiente de "X"'.
-- Agora: sem guard — o movimento 'out' é gravado e current_qty pode ficar < 0.
-- Isso segue o comportamento que o Estoque já tem para saldo negativo (aba
-- "Pendências de lançamento" lista os itens com qty < 0 para regularizar).
-- O front avisa quais insumos ficarão negativos, mas não bloqueia.
--
-- NOTA: a transferência da rede (supply_transfers) MANTÉM o guard de saldo —
-- lá o item sai para outro tenant, então enviar a descoberto não faz sentido.
--
-- Só `create or replace` da função do trigger — colável por cima do patch.
-- =====================================================================

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
      -- current_qty não é mais lido: a saída pode deixar o saldo negativo
      select pi.id, pi.stock_item_id, pi.qty, pi.unit, si.name, si.unit_cost as cost_now
        from public.production_order_inputs pi
        join public.stock_items si on si.id = pi.stock_item_id
       where pi.order_id = new.id
    loop
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

-- GRANTs (CLAUDE.md §5.2 / §5.3)
grant usage on schema app to authenticated, anon, service_role;
grant execute on all functions in schema app to authenticated, anon, service_role;
alter default privileges in schema app
  grant execute on functions to authenticated, anon, service_role;
