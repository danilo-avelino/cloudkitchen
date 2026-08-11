-- =====================================================================
-- Produção · liga o rateio multi-saída por VALOR DE REFERÊNCIA
-- Conclui a pendência declarada em 20260809120000_production_cost_allocation_ref_value
-- =====================================================================
--
-- A 20260809120000 criou as colunas ref_value e a lógica nova em
-- app.tg_production_apply_complete_alloc(), mas não religou o trigger — o
-- comentário sugeria `return app.tg_production_apply_complete_alloc();` dentro
-- da função de transição. Isso não funciona: o PL/pgSQL recusa chamar uma
-- função `returns trigger` fora do gerenciador de triggers
-- ("trigger functions can only be called as triggers"). O nome citado lá
-- (app.tg_production_apply_status) também não existe.
--
-- Solução: a cascata de direcionadores passa a viver no ramo 'completed' de
-- app.tg_production_order_transition() — a função que o trigger realmente usa
-- (tg_production_orders_transition). A função órfã é removida para não deixar
-- duas cópias divergentes da mesma regra.
--
-- Direcionador, em ordem de precedência:
--   1. ref_value em TODAS as saídas devolvidas  → rateio por valor
--   2. senão, peso conversível em todas          → rateio por peso (regra antiga)
--   3. senão                                     → rateio por quantidade devolvida
-- O passo 3 remove as duas exceções que travavam a devolução multi-saída sem
-- portion_qty: nada mais aborta o lançamento.
--
-- Ramos 'issued' (com o fallback de peso por portion_qty de 20260810160000) e
-- 'cancelled' ficam idênticos ao que estava em produção.
--
-- Validado em prod (2026-08-11), em transações revertidas:
--   • valor: entrada R$400, saídas 4×ref 100 e 1×ref 10 → R$390,2439 e R$9,7561
--     (pela regra antiga seriam R$320/R$80, os dois a R$80/kg);
--   • quantidade: 2 saídas sem ref_value e sem portion_qty, 3:1 de R$200
--     → R$150 e R$50 (antes levantava 'exige porção (em kg/g)').
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
  v_sum_value     numeric(14,4);
  v_sum_qty       numeric(14,4);
  v_all_have_ref  boolean;
  v_all_have_wt   boolean;
  v_mode          text;
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
      select pi.id, pi.stock_item_id, pi.qty, pi.unit, si.name, si.unit_cost as cost_now,
             si.portion_qty, si.portion_unit
        from public.production_order_inputs pi
        join public.stock_items si on si.id = pi.stock_item_id
       where pi.order_id = new.id
    loop
      -- Snapshot do custo atual (última compra)
      update public.production_order_inputs
         set unit_cost = round(coalesce(r.cost_now, 0), 4)
       where id = r.id;
      v_total_cost := v_total_cost + round(r.qty * coalesce(r.cost_now, 0), 4);

      -- Unidade nao-massica (un): o peso vem do peso unitario cadastrado no
      -- Estoque (portion_qty/portion_unit). Sem ele o peso do lote fica NULL,
      -- e sem peso de entrada nao ha como calcular desperdicio.
      v_w := coalesce(
        app.production_weight_kg(r.qty, r.unit),
        app.production_weight_kg(r.qty * r.portion_qty, coalesce(r.portion_unit, 'kg'))
      );
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

  -- ===== issued → completed (devolução): rateio em cascata + entrada =====
  if new.status = 'completed' then
    select count(*) into v_out_count
      from public.production_order_outputs where order_id = new.id;

    if not exists (
      select 1 from public.production_order_outputs
       where order_id = new.id and coalesce(returned_qty, 0) > 0
    ) then
      raise exception 'Informe as porções devolvidas de pelo menos uma saída';
    end if;

    -- Direcionadores candidatos, sobre as saídas efetivamente devolvidas
    select
      sum(po.returned_qty * po.ref_value) filter (where po.ref_value is not null),
      sum(app.production_weight_kg(po.returned_qty * si.portion_qty, coalesce(si.portion_unit,'kg'))),
      sum(po.returned_qty),
      bool_and(po.ref_value is not null),
      bool_and(si.portion_qty is not null
               and app.production_weight_kg(po.returned_qty * si.portion_qty, coalesce(si.portion_unit,'kg')) is not null)
      into v_sum_value, v_sum_weight, v_sum_qty, v_all_have_ref, v_all_have_wt
      from public.production_order_outputs po
      join public.stock_items si on si.id = po.stock_item_id
     where po.order_id = new.id
       and coalesce(po.returned_qty, 0) > 0;

    v_mode := case
      when v_out_count <= 1                                 then 'single'
      when v_all_have_ref and coalesce(v_sum_value, 0)  > 0 then 'value'
      when v_all_have_wt  and coalesce(v_sum_weight, 0) > 0 then 'weight'
      else 'qty'   -- nunca aborta: pior caso divide pela quantidade devolvida
    end;

    v_output_weight := 0;
    for r in
      select po.id, po.stock_item_id, po.returned_qty, po.ref_value,
             si.name, si.portion_qty, si.portion_unit
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

      -- Peso continua sendo calculado sempre: alimenta yield_pct/waste_qty,
      -- independente de ser ou não o direcionador do rateio.
      v_w := case when r.portion_qty is not null
                  then app.production_weight_kg(r.returned_qty * r.portion_qty, coalesce(r.portion_unit,'kg'))
                  else null end;
      if v_w is not null and v_output_weight is not null then
        v_output_weight := v_output_weight + v_w;
      elsif v_w is null then
        v_output_weight := null;   -- peso agregado deixa de ser confiável
      end if;

      v_share := case v_mode
        when 'single' then coalesce(new.total_input_cost, 0)
        when 'value'  then round(coalesce(new.total_input_cost,0) * (r.returned_qty * r.ref_value) / v_sum_value, 4)
        when 'weight' then round(coalesce(new.total_input_cost,0) * v_w / v_sum_weight, 4)
        else               round(coalesce(new.total_input_cost,0) * r.returned_qty / v_sum_qty, 4)
      end;
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

-- A lógica passou para o ramo 'completed' acima; a função nunca chegou a ser
-- ligada a nenhum trigger (verificado: 0 triggers e 0 funções a referenciam).
drop function if exists app.tg_production_apply_complete_alloc();

-- GRANTs (CLAUDE.md §5.2)
grant usage on schema app to authenticated, anon, service_role;
grant execute on all functions in schema app to authenticated, anon, service_role;
alter default privileges in schema app
  grant execute on functions to authenticated, anon, service_role;
