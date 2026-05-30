-- O front-end armazena `cat` como subcategoria DRE (cor + nome no rótulo da
-- linha do checklist). closing_checklist_items só tinha category_id (DRE
-- category — granularidade insuficiente). Adicionamos subcategory_id opcional
-- e refazemos a view pra expor.
ALTER TABLE public.closing_checklist_items
  ADD COLUMN IF NOT EXISTS subcategory_id uuid
  REFERENCES public.dre_subcategories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS closing_checklist_subcategory_idx
  ON public.closing_checklist_items(subcategory_id);

-- Trigger: garante coerência tenant (subcategoria precisa ser do mesmo tenant)
CREATE OR REPLACE FUNCTION app.tg_check_checklist_subcategory_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  IF NEW.subcategory_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT tenant_id INTO v_tenant FROM public.dre_subcategories WHERE id = NEW.subcategory_id;
  IF v_tenant IS NULL OR v_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'closing_checklist_items.subcategory_id pertence a outro tenant';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_closing_checklist_check_subcategory
  ON public.closing_checklist_items;
CREATE TRIGGER tg_closing_checklist_check_subcategory
  BEFORE INSERT OR UPDATE ON public.closing_checklist_items
  FOR EACH ROW EXECUTE FUNCTION app.tg_check_checklist_subcategory_tenant();

-- Refaz a view incluindo subcategory_id no SELECT
DROP VIEW IF EXISTS public.v_closing_checklist;
CREATE VIEW public.v_closing_checklist
WITH (security_invoker = true) AS
SELECT
  cli.id,
  cli.tenant_id,
  cli.category_id,
  cli.subcategory_id,
  cli.code,
  cli.label,
  cli.recurrence,
  cli.due_day,
  cli.owner_role,
  cli.expected_amount,
  cli.is_required,
  cli.source,
  cli.formula,
  cli.is_active,
  cli.sort_order,
  COALESCE(SUM(fe.value), 0::numeric) AS actual_amount,
  COUNT(fe.id) AS entries_count,
  CASE
    WHEN COUNT(fe.id) > 0 THEN 'filled'::app.checklist_status
    WHEN cli.expected_amount IS NOT NULL AND cli.expected_amount > 0::numeric
         THEN 'estimated'::app.checklist_status
    ELSE 'pending'::app.checklist_status
  END AS derived_status,
  cli.created_at,
  cli.updated_at
FROM public.closing_checklist_items cli
LEFT JOIN public.finance_entries fe ON fe.checklist_item_id = cli.id
GROUP BY cli.id;;
