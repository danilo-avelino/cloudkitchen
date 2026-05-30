-- Adiciona source_prep_id em tech_sheet_items para vincular a preparações
ALTER TABLE public.tech_sheet_items
  ADD COLUMN IF NOT EXISTS source_prep_id uuid REFERENCES public.preparations(id) ON DELETE SET NULL;

-- Função: quando preparation_items mudam, recalcula custo unitário do preparo
-- e propaga pra tech_sheet_items que usam esse preparo.
CREATE OR REPLACE FUNCTION public.propagate_preparation_cost()
RETURNS TRIGGER AS $$
DECLARE
  prep_id uuid;
  total numeric;
  yield_qty numeric;
  new_unit_cost numeric;
BEGIN
  prep_id := COALESCE(NEW.preparation_id, OLD.preparation_id);
  SELECT COALESCE(SUM(total_cost), 0) INTO total
    FROM public.preparation_items WHERE preparation_id = prep_id;
  SELECT p.yield_qty INTO yield_qty FROM public.preparations p WHERE p.id = prep_id;
  IF yield_qty IS NULL OR yield_qty <= 0 THEN yield_qty := 1; END IF;
  new_unit_cost := total / yield_qty;

  UPDATE public.tech_sheet_items
  SET unit_cost = new_unit_cost
  WHERE source_prep_id = prep_id;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_propagate_prep_cost_ins ON public.preparation_items;
DROP TRIGGER IF EXISTS trg_propagate_prep_cost_upd ON public.preparation_items;
DROP TRIGGER IF EXISTS trg_propagate_prep_cost_del ON public.preparation_items;
CREATE TRIGGER trg_propagate_prep_cost_ins AFTER INSERT ON public.preparation_items
  FOR EACH ROW EXECUTE FUNCTION public.propagate_preparation_cost();
CREATE TRIGGER trg_propagate_prep_cost_upd AFTER UPDATE ON public.preparation_items
  FOR EACH ROW EXECUTE FUNCTION public.propagate_preparation_cost();
CREATE TRIGGER trg_propagate_prep_cost_del AFTER DELETE ON public.preparation_items
  FOR EACH ROW EXECUTE FUNCTION public.propagate_preparation_cost();
;
