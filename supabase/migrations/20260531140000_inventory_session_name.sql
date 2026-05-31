-- Nome/título opcional no banco (NULL para inventários já existentes); o frontend
-- exige preenchimento ao criar um novo inventário.
ALTER TABLE public.inventory_sessions
  ADD COLUMN IF NOT EXISTS name text;
