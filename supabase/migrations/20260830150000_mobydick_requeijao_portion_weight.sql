-- Patch de dado (one-off): peso por unidade do REQUEIJÃO CATUPIRY (1,5KG) do
-- tenant `mobydick`.
--
-- É o insumo do bug de `20260830120000`: cadastrado em `un` a R$ 70,17 sem
-- `portion_qty`, com uma linha de ficha medida em 105 g. Com o peso preenchido, o
-- trigger `trg_propagate_stock_item_cost` (que dispara em `portion_qty`) recalcula
-- a linha sozinho: 70,17 ÷ 1,5 kg ÷ 1000 = R$ 0,04678/g → 105 g = **R$ 4,91**.
--
-- Escopo estreito de propósito: o usuário pediu só este (as 5 linhas do tenant
-- `terra-querida-dom-severino` ficam para ele resolver pela tela). O `portion_qty
-- IS NULL` no WHERE deixa a migration idempotente e faz dela um no-op em qualquer
-- ambiente onde o insumo já tenha peso — ou não exista.
UPDATE public.stock_items si
SET portion_qty  = 1.5,
    portion_unit = 'kg'
FROM public.tenants t
WHERE t.id = si.tenant_id
  AND t.slug = 'mobydick'
  AND si.name ILIKE '%REQUEIJ%CATUPIRY%'
  AND si.name ILIKE '%1,5%'
  AND lower(si.unit) = 'un'
  AND si.portion_qty IS NULL;
