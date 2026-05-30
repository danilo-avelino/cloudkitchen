-- Fixa search_path explícito (advisory function_search_path_mutable)
CREATE OR REPLACE FUNCTION public.set_updated_at_finance_entries()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;;
