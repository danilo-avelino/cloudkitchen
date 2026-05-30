-- Trigger adicional: quando preparations.yield_qty muda, recalcula unit_cost
-- de tech_sheet_items que usam essa preparação (custo unitário do preparo = total/yield)
CREATE OR REPLACE FUNCTION public.propagate_preparation_yield_change()
RETURNS TRIGGER AS $$
DECLARE
  v_total numeric;
  v_yield numeric;
  v_unit_cost numeric;
BEGIN
  IF NEW.yield_qty IS DISTINCT FROM OLD.yield_qty THEN
    SELECT COALESCE(SUM(total_cost), 0) INTO v_total
      FROM public.preparation_items WHERE preparation_id = NEW.id;
    v_yield := NEW.yield_qty;
    IF v_yield IS NULL OR v_yield <= 0 THEN v_yield := 1; END IF;
    v_unit_cost := v_total / v_yield;

    UPDATE public.tech_sheet_items
    SET unit_cost = v_unit_cost
    WHERE source_prep_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_propagate_prep_yield ON public.preparations;
CREATE TRIGGER trg_propagate_prep_yield
AFTER UPDATE ON public.preparations
FOR EACH ROW
EXECUTE FUNCTION public.propagate_preparation_yield_change();
;
