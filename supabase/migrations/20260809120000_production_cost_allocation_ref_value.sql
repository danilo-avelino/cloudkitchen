-- =====================================================================
-- Produção · rateio multi-saída por VALOR DE REFERÊNCIA
-- Ref: REVISAO-PRODUCAO.md §3.5 · decisões 4/5 de 2026-08-09
-- =====================================================================
--
-- PROBLEMA
-- Quando uma produção devolve 2+ transformados (desossa: filé + aparas), o
-- rateio atual é por PESO — o physical measure method. Ele dá o mesmo custo por
-- quilo a produtos de valor completamente diferente:
--
--   Entra 5 kg de picanha ...................... R$ 400,00
--   Sai   4 kg "Picanha porcionada"  →  4/5 →   R$ 320,00  =  R$ 80,00/kg
--   Sai   1 kg "Aparas"             →  1/5 →   R$  80,00  =  R$ 80,00/kg   ← errado
--
-- As aparas passam a valer o mesmo que picanha nobre. O custo migra do produto
-- caro para o barato, e as duas margens ficam erradas em toda ficha que os usa.
--
-- SOLUÇÃO
-- `ref_value` = quanto vale, aproximadamente, UMA unidade daquela saída.
-- Só a proporção entre os ref_value importa; o valor absoluto pode ser grosseiro.
--
--   cost_share_i = total_input_cost × (returned_qty_i × ref_value_i)
--                                   ÷ Σ (returned_qty × ref_value)
--
-- POR QUE UM CAMPO NOVO E NÃO stock_items.unit_cost
-- O unit_cost do transformado é gravado pelo rateio da produção ANTERIOR. Usá-lo
-- como direcionador tornaria o cálculo auto-referente: um valor inicial torto se
-- perpetua e deriva a cada lote. O ref_value é âncora externa, estável.
--
-- COMPATIBILIDADE
-- Ordem de precedência do direcionador, por ordem:
--   1. ref_value em TODAS as saídas devolvidas  → rateio por valor
--   2. senão, peso conversível em todas          → rateio por peso (atual)
--   3. senão                                     → rateio por quantidade devolvida
-- O passo 3 é novo e remove as duas exceções que hoje travam a devolução
-- multi-saída quando falta portion_qty. Nada mais aborta o lançamento.
-- =====================================================================

-- ---------- 1. Coluna de valor de referência -------------------------
alter table public.production_recipe_outputs
  add column if not exists ref_value numeric(14,4)
    check (ref_value is null or ref_value > 0);

comment on column public.production_recipe_outputs.ref_value is
  'Valor aproximado de UMA unidade desta saída. Usado só como proporção no rateio multi-saída (REVISAO-PRODUCAO.md §3.5). Não é preço de venda nem precisa ser exato.';

alter table public.production_order_outputs
  add column if not exists ref_value numeric(14,4)
    check (ref_value is null or ref_value > 0);

comment on column public.production_order_outputs.ref_value is
  'Snapshot do ref_value da receita no momento do lançamento — o rateio de uma ordem passada não muda se a receita for editada depois.';

-- ---------- 2. Trigger de conclusão: novo direcionador ----------------
create or replace function app.tg_production_apply_complete_alloc()
returns trigger
language plpgsql
set search_path = 'app','public','pg_temp'
as $$
declare
  r               record;
  v_out_count     int;
  v_sum_weight    numeric(14,4);
  v_sum_value     numeric(14,4);
  v_sum_qty       numeric(14,4);
  v_all_have_ref  boolean;
  v_all_have_wt   boolean;
  v_mode          text;
  v_w             numeric(14,4);
  v_share         numeric(14,4);
  v_unit_cost     numeric(12,4);
  v_output_weight numeric(14,4);
begin
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
    when v_out_count <= 1                                     then 'single'
    when v_all_have_ref and coalesce(v_sum_value, 0)  > 0     then 'value'
    when v_all_have_wt  and coalesce(v_sum_weight, 0) > 0     then 'weight'
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
    new.yield_pct  := round((v_output_weight / new.input_weight) * 100, 2);
    new.waste_qty  := greatest(new.input_weight - v_output_weight, 0);
  end if;
  if new.completed_at is null then new.completed_at := now(); end if;
  if new.completed_by is null then new.completed_by := auth.uid(); end if;
  return new;
end;
$$;

grant execute on function app.tg_production_apply_complete_alloc() to authenticated, anon, service_role;

-- ---------- 3. GRANTs do schema app (CLAUDE.md §5.2, idempotente) -----
grant usage on schema app to authenticated, anon, service_role;
grant execute on all functions in schema app to authenticated, anon, service_role;
alter default privileges in schema app
  grant execute on functions to authenticated, anon, service_role;

-- =====================================================================
-- RESOLVIDO em 20260811140000_production_enable_ref_value_allocation
-- =====================================================================
-- Esta migration criou a lógica isolada mas NÃO religou o trigger, e o plano
-- descrito aqui tinha dois erros, corrigidos na migration acima:
--
--   1. app.tg_production_apply_status() não existe. A função que o trigger
--      tg_production_orders_transition usa é app.tg_production_order_transition().
--   2. `return app.tg_production_apply_complete_alloc();` não funciona — o
--      PL/pgSQL recusa chamar uma função `returns trigger` fora do gerenciador
--      de triggers ("trigger functions can only be called as triggers").
--
-- A cascata valor → peso → quantidade foi então inlinada no ramo 'completed' de
-- app.tg_production_order_transition(), e a função criada aqui
-- (tg_production_apply_complete_alloc) foi removida por nunca ter sido ligada a
-- trigger nenhum — ela não existe mais depois da 20260811140000.
-- =====================================================================
