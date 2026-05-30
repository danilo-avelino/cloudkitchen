-- Quando o unit_cost de stock_items muda, atualiza unit_cost / total_cost
-- de tech_sheet_items e preparation_items que apontam pra esse item.
CREATE OR REPLACE FUNCTION public.propagate_stock_item_cost()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.unit_cost IS DISTINCT FROM OLD.unit_cost THEN
    UPDATE public.tech_sheet_items
    SET unit_cost = NEW.unit_cost
    WHERE stock_item_id = NEW.id;

    UPDATE public.preparation_items
    SET unit_cost = NEW.unit_cost,
        total_cost = qty * NEW.unit_cost
    WHERE stock_item_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_propagate_stock_item_cost ON public.stock_items;
CREATE TRIGGER trg_propagate_stock_item_cost
AFTER UPDATE ON public.stock_items
FOR EACH ROW
EXECUTE FUNCTION public.propagate_stock_item_cost();
;
