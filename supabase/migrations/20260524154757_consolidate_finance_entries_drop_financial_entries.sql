-- =====================================================================
-- Consolidação: unifica em finance_entries (shape phase-12) e dropa
-- financial_entries (shape canonical, zero linhas, ninguém escrevia).
-- Refaz as 3 views (v_closing_checklist, v_dre_monthly, v_cmv_real_monthly)
-- pra ler de finance_entries.
-- =====================================================================

-- 1. Adicionar checklist_item_id em finance_entries
ALTER TABLE public.finance_entries
  ADD COLUMN IF NOT EXISTS checklist_item_id uuid
  REFERENCES public.closing_checklist_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS finance_entries_checklist_idx
  ON public.finance_entries(checklist_item_id);

-- 2. Refazer v_closing_checklist apontando pra finance_entries
DROP VIEW IF EXISTS public.v_closing_checklist;
CREATE VIEW public.v_closing_checklist AS
SELECT
  cli.id,
  cli.tenant_id,
  cli.category_id,
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
GROUP BY cli.id;

-- 3. Refazer v_dre_monthly: o join agora é
--    finance_entries → dre_subcategories → dre_categories → dre_groups
DROP VIEW IF EXISTS public.v_dre_monthly;
CREATE VIEW public.v_dre_monthly AS
SELECT
  dg.tenant_id,
  date_trunc('month', fe.competence_date::timestamp with time zone)::date AS competence_month,
  dg.id AS group_id,
  dg.slug AS group_slug,
  dg.label AS group_label,
  dg.sign AS group_sign,
  dg.sort_order,
  SUM(fe.value) AS amount
FROM public.finance_entries fe
JOIN public.dre_subcategories ds ON ds.id = fe.subcategory_id
JOIN public.dre_categories dc ON dc.id = ds.category_id
JOIN public.dre_groups dg ON dg.id = dc.group_id
WHERE fe.status <> 'cancelled'
GROUP BY dg.tenant_id,
         date_trunc('month', fe.competence_date::timestamp with time zone),
         dg.id, dg.slug, dg.label, dg.sign, dg.sort_order
ORDER BY date_trunc('month', fe.competence_date::timestamp with time zone)::date DESC,
         dg.sort_order;

-- 4. Refazer v_cmv_real_monthly
DROP VIEW IF EXISTS public.v_cmv_real_monthly;
CREATE VIEW public.v_cmv_real_monthly AS
WITH month_purchases AS (
  SELECT
    fe.tenant_id,
    date_trunc('month', fe.competence_date::timestamp with time zone)::date AS competence_month,
    SUM(fe.value) AS purchases
  FROM public.finance_entries fe
  JOIN public.dre_subcategories ds ON ds.id = fe.subcategory_id
  JOIN public.dre_categories dc ON dc.id = ds.category_id
  JOIN public.dre_groups dg ON dg.id = dc.group_id
  WHERE dg.slug = 'cmv'::citext AND fe.status <> 'cancelled'
  GROUP BY fe.tenant_id, date_trunc('month', fe.competence_date::timestamp with time zone)
),
month_revenue AS (
  SELECT
    re.tenant_id,
    date_trunc('month', re.business_date::timestamp with time zone)::date AS competence_month,
    SUM(COALESCE(rpb_sum.gross, 0::numeric)) AS gross
  FROM public.revenue_entries re
  LEFT JOIN LATERAL (
    SELECT SUM(amount) AS gross
    FROM public.revenue_payment_breakdown
    WHERE revenue_entry_id = re.id
  ) rpb_sum ON true
  WHERE re.status = 'confirmed'::app.revenue_status
  GROUP BY re.tenant_id, date_trunc('month', re.business_date::timestamp with time zone)
)
SELECT
  spc.tenant_id,
  spc.period_start,
  spc.period_end,
  spc.period_label,
  spc.initial_value,
  spc.final_value,
  COALESCE(mp.purchases, 0::numeric) AS purchases,
  COALESCE(mr.gross, 0::numeric) AS gross_revenue,
  spc.initial_value + COALESCE(mp.purchases, 0::numeric)
    - COALESCE(spc.final_value, spc.initial_value) AS cmv_real_value,
  CASE
    WHEN COALESCE(mr.gross, 0::numeric) > 0::numeric
    THEN ROUND(
      (spc.initial_value + COALESCE(mp.purchases, 0::numeric)
       - COALESCE(spc.final_value, spc.initial_value)) / mr.gross * 100::numeric,
      2
    )
    ELSE NULL::numeric
  END AS cmv_real_pct
FROM public.stock_period_closures spc
LEFT JOIN month_purchases mp ON mp.tenant_id = spc.tenant_id
  AND mp.competence_month = date_trunc('month', spc.period_start::timestamp with time zone)::date
LEFT JOIN month_revenue mr ON mr.tenant_id = spc.tenant_id
  AND mr.competence_month = date_trunc('month', spc.period_start::timestamp with time zone)::date;

-- 5. Dropar financial_entries + função/trigger associados
--    (a tabela tinha 0 linhas; o trigger tg_financial_entries_check_fks
--    cai junto com a tabela; a função app.tg_check_financial_entry_fks
--    é específica dessa tabela e some também.)
DROP TABLE IF EXISTS public.financial_entries CASCADE;
DROP FUNCTION IF EXISTS app.tg_check_financial_entry_fks() CASCADE;;
