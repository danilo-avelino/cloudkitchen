-- "Quem vê o módulo, edita o módulo": uniformiza as policies de ESCRITA das
-- tabelas de conteúdo de cada módulo para usar app.can_access_module(tenant, '<módulo>'),
-- a mesma regra já aplicada em finance_entries. can_access_module espelha o
-- getAllowedModules do frontend (preset por papel + modules customizado), então
-- o acesso de escrita passa a seguir exatamente a visibilidade do módulo.
--
-- Decisões (autorizadas pelo usuário em 2026-06-01):
--   • Escopo: só módulos de conteúdo. Ficam de FORA (intocadas):
--       - tenant_members, tenants, profiles (gestão de membros/conta)
--       - operations, operation_shifts (geridas em Configurações)
--       - módulos já removidos: checklist_*, fb_* (NPS)
--       - inserts públicos/triggers (stock_movements, fb_responses)
--   • Regra PURA do módulo: pode remover acesso de papéis que não estão no preset
--     do módulo (ex.: accountant deixa de escrever stock_period_closures/inventário).
--
-- Leitura (SELECT) NÃO é alterada — continua como estava (is_member etc.).
-- finance_entries já está em can_access_module (migration anterior) — não repetido.

-- ============================ RECIPES ============================
DROP POLICY IF EXISTS recipe_categories_write ON public.recipe_categories;
CREATE POLICY recipe_categories_write ON public.recipe_categories
  FOR ALL USING (app.can_access_module(tenant_id, 'recipes'))
  WITH CHECK (app.can_access_module(tenant_id, 'recipes'));

DROP POLICY IF EXISTS tech_sheets_write ON public.tech_sheets;
CREATE POLICY tech_sheets_write ON public.tech_sheets
  FOR ALL USING (app.can_access_module(tenant_id, 'recipes'))
  WITH CHECK (app.can_access_module(tenant_id, 'recipes'));

DROP POLICY IF EXISTS tech_sheet_items_write ON public.tech_sheet_items;
CREATE POLICY tech_sheet_items_write ON public.tech_sheet_items
  FOR ALL USING (EXISTS (SELECT 1 FROM public.tech_sheets ts
      WHERE ts.id = tech_sheet_items.tech_sheet_id AND app.can_access_module(ts.tenant_id, 'recipes')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.tech_sheets ts
      WHERE ts.id = tech_sheet_items.tech_sheet_id AND app.can_access_module(ts.tenant_id, 'recipes')));

DROP POLICY IF EXISTS preparations_write ON public.preparations;
CREATE POLICY preparations_write ON public.preparations
  FOR ALL USING (app.can_access_module(tenant_id, 'recipes'))
  WITH CHECK (app.can_access_module(tenant_id, 'recipes'));

DROP POLICY IF EXISTS preparation_items_write ON public.preparation_items;
CREATE POLICY preparation_items_write ON public.preparation_items
  FOR ALL USING (EXISTS (SELECT 1 FROM public.preparations p
      WHERE p.id = preparation_items.preparation_id AND app.can_access_module(p.tenant_id, 'recipes')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.preparations p
      WHERE p.id = preparation_items.preparation_id AND app.can_access_module(p.tenant_id, 'recipes')));

-- ============================ STOCK ============================
DROP POLICY IF EXISTS stock_items_write ON public.stock_items;
CREATE POLICY stock_items_write ON public.stock_items
  FOR ALL USING (app.can_access_module(tenant_id, 'stock'))
  WITH CHECK (app.can_access_module(tenant_id, 'stock'));

DROP POLICY IF EXISTS stock_categories_write ON public.stock_categories;
CREATE POLICY stock_categories_write ON public.stock_categories
  FOR ALL USING (app.can_access_module(tenant_id, 'stock'))
  WITH CHECK (app.can_access_module(tenant_id, 'stock'));

DROP POLICY IF EXISTS suppliers_write ON public.suppliers;
CREATE POLICY suppliers_write ON public.suppliers
  FOR ALL USING (app.can_access_module(tenant_id, 'stock'))
  WITH CHECK (app.can_access_module(tenant_id, 'stock'));

DROP POLICY IF EXISTS stock_allocations_write ON public.stock_allocations;
CREATE POLICY stock_allocations_write ON public.stock_allocations
  FOR ALL USING (EXISTS (SELECT 1 FROM public.stock_items si
      WHERE si.id = stock_allocations.stock_item_id AND app.can_access_module(si.tenant_id, 'stock')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.stock_items si
      WHERE si.id = stock_allocations.stock_item_id AND app.can_access_module(si.tenant_id, 'stock')));

DROP POLICY IF EXISTS stock_value_snapshots_write ON public.stock_value_snapshots;
CREATE POLICY stock_value_snapshots_write ON public.stock_value_snapshots
  FOR ALL USING (app.can_access_module(tenant_id, 'stock'))
  WITH CHECK (app.can_access_module(tenant_id, 'stock'));

DROP POLICY IF EXISTS stock_period_closures_write ON public.stock_period_closures;
CREATE POLICY stock_period_closures_write ON public.stock_period_closures
  FOR ALL USING (app.can_access_module(tenant_id, 'stock'))
  WITH CHECK (app.can_access_module(tenant_id, 'stock'));

DROP POLICY IF EXISTS inv_sessions_write ON public.inventory_sessions;
CREATE POLICY inv_sessions_write ON public.inventory_sessions
  FOR ALL USING (app.can_access_module(tenant_id, 'stock'))
  WITH CHECK (app.can_access_module(tenant_id, 'stock'));

DROP POLICY IF EXISTS inv_items_rw ON public.inventory_session_items;
CREATE POLICY inv_items_rw ON public.inventory_session_items
  FOR ALL USING (EXISTS (SELECT 1 FROM public.inventory_sessions s
      WHERE s.id = inventory_session_items.inventory_session_id AND app.can_access_module(s.tenant_id, 'stock')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.inventory_sessions s
      WHERE s.id = inventory_session_items.inventory_session_id AND app.can_access_module(s.tenant_id, 'stock')));

-- ============================ REQUESTS ============================
DROP POLICY IF EXISTS kitchen_requests_insert ON public.kitchen_requests;
CREATE POLICY kitchen_requests_insert ON public.kitchen_requests
  FOR INSERT WITH CHECK (app.can_access_module(tenant_id, 'requests'));

DROP POLICY IF EXISTS kitchen_requests_update ON public.kitchen_requests;
CREATE POLICY kitchen_requests_update ON public.kitchen_requests
  FOR UPDATE USING (app.can_access_module(tenant_id, 'requests'))
  WITH CHECK (app.can_access_module(tenant_id, 'requests'));

DROP POLICY IF EXISTS kitchen_requests_delete ON public.kitchen_requests;
CREATE POLICY kitchen_requests_delete ON public.kitchen_requests
  FOR DELETE USING (app.can_access_module(tenant_id, 'requests'));

DROP POLICY IF EXISTS kitchen_request_items_write ON public.kitchen_request_items;
CREATE POLICY kitchen_request_items_write ON public.kitchen_request_items
  FOR ALL USING (EXISTS (SELECT 1 FROM public.kitchen_requests kr
      WHERE kr.id = kitchen_request_items.kitchen_request_id AND app.can_access_module(kr.tenant_id, 'requests')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.kitchen_requests kr
      WHERE kr.id = kitchen_request_items.kitchen_request_id AND app.can_access_module(kr.tenant_id, 'requests')));

-- ============================ PURCHASES ============================
DROP POLICY IF EXISTS purchase_orders_write ON public.purchase_orders;
CREATE POLICY purchase_orders_write ON public.purchase_orders
  FOR ALL USING (app.can_access_module(tenant_id, 'purchases'))
  WITH CHECK (app.can_access_module(tenant_id, 'purchases'));

DROP POLICY IF EXISTS purchase_order_items_write ON public.purchase_order_items;
CREATE POLICY purchase_order_items_write ON public.purchase_order_items
  FOR ALL USING (EXISTS (SELECT 1 FROM public.purchase_orders po
      WHERE po.id = purchase_order_items.purchase_order_id AND app.can_access_module(po.tenant_id, 'purchases')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.purchase_orders po
      WHERE po.id = purchase_order_items.purchase_order_id AND app.can_access_module(po.tenant_id, 'purchases')));

DROP POLICY IF EXISTS goods_receipts_write ON public.goods_receipts;
CREATE POLICY goods_receipts_write ON public.goods_receipts
  FOR ALL USING (app.can_access_module(tenant_id, 'purchases'))
  WITH CHECK (app.can_access_module(tenant_id, 'purchases'));

DROP POLICY IF EXISTS goods_receipt_items_write ON public.goods_receipt_items;
CREATE POLICY goods_receipt_items_write ON public.goods_receipt_items
  FOR ALL USING (EXISTS (SELECT 1 FROM public.goods_receipts gr
      WHERE gr.id = goods_receipt_items.goods_receipt_id AND app.can_access_module(gr.tenant_id, 'purchases')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.goods_receipts gr
      WHERE gr.id = goods_receipt_items.goods_receipt_id AND app.can_access_module(gr.tenant_id, 'purchases')));

-- ============================ REVENUE ============================
DROP POLICY IF EXISTS revenue_entries_write ON public.revenue_entries;
CREATE POLICY revenue_entries_write ON public.revenue_entries
  FOR ALL USING (app.can_access_module(tenant_id, 'revenue'))
  WITH CHECK (app.can_access_module(tenant_id, 'revenue'));

DROP POLICY IF EXISTS revenue_payment_breakdown_write ON public.revenue_payment_breakdown;
CREATE POLICY revenue_payment_breakdown_write ON public.revenue_payment_breakdown
  FOR ALL USING (EXISTS (SELECT 1 FROM public.revenue_entries re
      WHERE re.id = revenue_payment_breakdown.revenue_entry_id AND app.can_access_module(re.tenant_id, 'revenue')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.revenue_entries re
      WHERE re.id = revenue_payment_breakdown.revenue_entry_id AND app.can_access_module(re.tenant_id, 'revenue')));

DROP POLICY IF EXISTS payment_methods_admin_write ON public.payment_methods;
CREATE POLICY payment_methods_admin_write ON public.payment_methods
  FOR ALL USING (app.can_access_module(tenant_id, 'revenue'))
  WITH CHECK (app.can_access_module(tenant_id, 'revenue'));

-- ============================ FINANCE (resto) ============================
DROP POLICY IF EXISTS closing_checklist_write ON public.closing_checklist_items;
CREATE POLICY closing_checklist_write ON public.closing_checklist_items
  FOR ALL USING (app.can_access_module(tenant_id, 'finance'))
  WITH CHECK (app.can_access_module(tenant_id, 'finance'));

DROP POLICY IF EXISTS closing_periods_write ON public.closing_periods;
CREATE POLICY closing_periods_write ON public.closing_periods
  FOR ALL USING (app.can_access_module(tenant_id, 'finance'))
  WITH CHECK (app.can_access_module(tenant_id, 'finance'));

-- ============================ DRE ============================
DROP POLICY IF EXISTS dre_categories_write ON public.dre_categories;
CREATE POLICY dre_categories_write ON public.dre_categories
  FOR ALL USING (app.can_access_module(tenant_id, 'dre'))
  WITH CHECK (app.can_access_module(tenant_id, 'dre'));

DROP POLICY IF EXISTS dre_subcategories_write ON public.dre_subcategories;
CREATE POLICY dre_subcategories_write ON public.dre_subcategories
  FOR ALL USING (app.can_access_module(tenant_id, 'dre'))
  WITH CHECK (app.can_access_module(tenant_id, 'dre'));

DROP POLICY IF EXISTS dre_groups_write ON public.dre_groups;
CREATE POLICY dre_groups_write ON public.dre_groups
  FOR ALL USING (app.can_access_module(tenant_id, 'dre'))
  WITH CHECK (app.can_access_module(tenant_id, 'dre'));
