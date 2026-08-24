-- Ficha técnica passa a aceitar gramas (g) como unidade da linha.
--
-- Segue `20260824120000_recipe_unit_conversion.sql` (já aplicada), que só sabia
-- converter o par kg × un. Agora `app.stock_unit_cost_in` normaliza para custo
-- por kg e converte a partir daí:
--
--   kg ↔ g   → fator 1000, NÃO precisa do peso da unidade
--   un → kg/g → precisa de stock_items.portion_qty
--   kg/g → un → precisa de stock_items.portion_qty
--
-- Só a função de conversão muda. O trigger `propagate_stock_item_cost()` e o RPC
-- `recompute_all_costs()` já a chamam e continuam como estão.
--
-- Idempotente: CREATE OR REPLACE + GRANTs.

CREATE OR REPLACE FUNCTION app.stock_unit_cost_in(
  p_cost         numeric,
  p_stock_unit   text,
  p_target_unit  text,
  p_portion_qty  numeric,
  p_portion_unit text
)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = 'app', 'public', 'pg_temp'
AS $function$
DECLARE
  v_from  text := lower(coalesce(p_stock_unit, ''));
  v_to    text := lower(coalesce(p_target_unit, ''));
  v_kg    numeric;  -- peso de 1 unidade, em kg
  v_perkg numeric;  -- custo do insumo por kg
BEGIN
  IF v_to = '' OR v_from = v_to THEN
    RETURN p_cost;
  END IF;

  v_kg := CASE
    WHEN p_portion_qty IS NULL OR p_portion_qty <= 0 THEN NULL
    WHEN lower(coalesce(p_portion_unit, 'kg')) = 'g'  THEN p_portion_qty / 1000
    ELSE p_portion_qty
  END;

  -- Custo por kg. Unidade contável ('un' e afins) só resolve com o peso cadastrado.
  v_perkg := CASE
    WHEN v_from = 'kg'    THEN p_cost
    WHEN v_from = 'g'     THEN p_cost * 1000
    WHEN v_kg IS NOT NULL THEN p_cost / v_kg
    ELSE NULL
  END;

  -- Sem conversão possível, devolve o custo original — mesmo contrato de antes:
  -- nunca fica pior do que a cópia direta que existia até 20260824120000.
  IF v_perkg IS NULL THEN
    RETURN p_cost;
  END IF;

  IF    v_to = 'kg' THEN RETURN v_perkg;
  ELSIF v_to = 'g'  THEN RETURN v_perkg / 1000;
  ELSIF v_to = 'un' AND v_kg IS NOT NULL THEN RETURN v_perkg * v_kg;
  END IF;

  RETURN p_cost;
END;
$function$;

-- ============================================================================
-- GRANTs (CLAUDE.md §5.2)
-- ============================================================================
-- CREATE OR REPLACE preserva a ACL, mas o trigger que chama essa função NÃO é
-- SECURITY DEFINER: roda como o role que fez o UPDATE em stock_items. Repetir os
-- GRANTs é barato e evita que um UPDATE de insumo quebre com
-- "permission denied for schema app".
GRANT USAGE ON SCHEMA app TO authenticated, anon, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO authenticated, anon, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO authenticated, anon, service_role;
