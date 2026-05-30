-- Atualiza fórmula do auto-min/max de estoque.
--   Antes: min = ceil(daily * 3), max = min * 2
--   Agora: min = ceil(daily * 7), max = ceil(min * 1.3)
-- Mantém: janela 30d com fallback 7d, e early-return quando auto_min_enabled = false.
CREATE OR REPLACE FUNCTION public.compute_auto_min_max(p_item_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  v_total_30  numeric;
  v_total_7   numeric;
  v_daily     numeric;
  v_min       numeric;
  v_max       numeric;
  v_auto      boolean;
BEGIN
  SELECT auto_min_enabled INTO v_auto FROM public.stock_items WHERE id = p_item_id;
  IF v_auto IS NULL OR v_auto = false THEN RETURN; END IF;

  SELECT COALESCE(SUM(ABS(qty)), 0) INTO v_total_30
  FROM public.stock_movements
  WHERE stock_item_id = p_item_id
    AND kind = 'out'
    AND performed_at >= now() - interval '30 days';

  IF v_total_30 > 0 THEN
    v_daily := v_total_30 / 30.0;
  ELSE
    SELECT COALESCE(SUM(ABS(qty)), 0) INTO v_total_7
    FROM public.stock_movements
    WHERE stock_item_id = p_item_id
      AND kind = 'out'
      AND performed_at >= now() - interval '7 days';
    v_daily := v_total_7 / 7.0;
  END IF;

  IF v_daily <= 0 THEN RETURN; END IF;

  v_min := CEIL(v_daily * 7);
  v_max := CEIL(v_min * 1.3);

  UPDATE public.stock_items
  SET reorder_point = v_min,
      max_qty       = v_max
  WHERE id = p_item_id;
END;
$function$;;
