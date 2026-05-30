-- Coluna para sinalizar auto-cálculo de mínimo/máximo
ALTER TABLE public.stock_items
  ADD COLUMN IF NOT EXISTS auto_min_enabled boolean NOT NULL DEFAULT false;

-- Função que recalcula reorder_point e max_qty baseado em consumo 7d
-- reorder = ceil(média_diária × 3 dias), max = reorder × 2
CREATE OR REPLACE FUNCTION public.compute_auto_min_max(p_item_id uuid)
RETURNS void AS $$
DECLARE
  v_total_out  numeric;
  v_daily      numeric;
  v_min        numeric;
  v_max        numeric;
  v_auto       boolean;
BEGIN
  SELECT auto_min_enabled INTO v_auto FROM public.stock_items WHERE id = p_item_id;
  IF v_auto IS NULL OR v_auto = false THEN RETURN; END IF;

  SELECT COALESCE(SUM(ABS(qty)), 0) INTO v_total_out
  FROM public.stock_movements
  WHERE stock_item_id = p_item_id
    AND kind = 'out'
    AND performed_at >= now() - interval '7 days';

  v_daily := v_total_out / 7.0;
  IF v_daily <= 0 THEN RETURN; END IF;

  v_min := CEIL(v_daily * 3);
  v_max := v_min * 2;

  UPDATE public.stock_items
  SET reorder_point = v_min,
      max_qty       = v_max
  WHERE id = p_item_id;
END;
$$ LANGUAGE plpgsql;

-- Trigger: quando inserir/atualizar/deletar movimentação, recalcula min/max
-- só dos itens com auto_min_enabled = true.
CREATE OR REPLACE FUNCTION public.trg_recompute_auto_min()
RETURNS TRIGGER AS $$
DECLARE
  v_item_id uuid;
BEGIN
  v_item_id := COALESCE(NEW.stock_item_id, OLD.stock_item_id);
  IF v_item_id IS NOT NULL THEN
    PERFORM public.compute_auto_min_max(v_item_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stock_mov_auto_min_ins ON public.stock_movements;
DROP TRIGGER IF EXISTS trg_stock_mov_auto_min_upd ON public.stock_movements;
DROP TRIGGER IF EXISTS trg_stock_mov_auto_min_del ON public.stock_movements;
CREATE TRIGGER trg_stock_mov_auto_min_ins AFTER INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_auto_min();
CREATE TRIGGER trg_stock_mov_auto_min_upd AFTER UPDATE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_auto_min();
CREATE TRIGGER trg_stock_mov_auto_min_del AFTER DELETE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_auto_min();

-- Trigger: quando auto_min_enabled vira true, recalcula imediatamente
CREATE OR REPLACE FUNCTION public.trg_recompute_on_toggle()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.auto_min_enabled = true AND (OLD.auto_min_enabled IS DISTINCT FROM NEW.auto_min_enabled) THEN
    PERFORM public.compute_auto_min_max(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stock_item_auto_min_toggle ON public.stock_items;
CREATE TRIGGER trg_stock_item_auto_min_toggle AFTER UPDATE OF auto_min_enabled ON public.stock_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_on_toggle();
;
