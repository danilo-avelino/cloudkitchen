-- Modo de preparo em fichas técnicas e preparos.
--
-- Coluna nova em vez de reusar `notes`: em `tech_sheets` o campo `notes` está
-- ocupado — guarda a categoria no formato `cat:<uuid>` (ver mapTechSheetFromDb
-- em lib-supabase.jsx), então escrever texto livre ali apagaria a categoria da
-- ficha. Em `preparations` o `notes` está livre, mas usar o mesmo nome nas duas
-- tabelas mantém os mappers simétricos.
--
-- Sem GRANT novo: privilégio de tabela vale para colunas adicionadas depois, e
-- as policies de RLS de `tech_sheets`/`preparations` são por linha, não por
-- coluna — quem já edita a ficha passa a editar o modo de preparo junto.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS.

ALTER TABLE public.tech_sheets
  ADD COLUMN IF NOT EXISTS instructions text;

ALTER TABLE public.preparations
  ADD COLUMN IF NOT EXISTS instructions text;

COMMENT ON COLUMN public.tech_sheets.instructions  IS 'Modo de preparo / descrição livre, exibido na ficha e na impressão A4.';
COMMENT ON COLUMN public.preparations.instructions IS 'Modo de preparo / descrição livre, exibido no preparo e na impressão A4.';
