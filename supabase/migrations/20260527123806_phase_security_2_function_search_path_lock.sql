-- Fase 2: trava SET search_path nas 31 funções flagadas pelo advisor
-- (function_search_path_mutable).
--
-- Risco mitigado: sem search_path fixo, um atacante com CREATE em qualquer schema
-- do search_path do role corrente pode interpor objetos maliciosos (functions, tables,
-- types) que seriam resolvidos antes dos legítimos. Em funções SECURITY DEFINER isso
-- é privilege escalation; em triggers que escrevem em estoque/CMV é tenant data poisoning.
--
-- Padrão aplicado: SET search_path = 'app', 'public', 'pg_temp'
--   - 'app' primeiro: domínio principal do StockKitchen
--   - 'public' depois: tabelas legadas/operacionais
--   - 'pg_temp' por último: defesa contra temp-schema hijack (recomendação Supabase)
--
-- Usa ALTER FUNCTION ... SET — NÃO toca no corpo das funções (zero risco de regressão).
-- Idempotente: ALTER FUNCTION SET é sempre seguro de reaplicar.

-- =============================================================================
-- Funções em schema `app` (triggers de integridade tenant + apply_*)
-- =============================================================================
ALTER FUNCTION app.tg_check_stock_item_category_tenant()      SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_block_stock_movement_change()           SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_set_updated_at()                        SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_check_purchase_order_supplier_tenant()  SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_check_stock_allocation_tenant()         SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_check_tech_sheet_operation_tenant()     SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_check_tech_sheet_item_tenant()          SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_check_kitchen_request_operation_tenant() SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_check_kitchen_request_item_tenant()     SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_kitchen_request_apply_separation()      SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_check_purchase_order_item_tenant()      SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_purchase_order_apply_receipt()          SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_check_goods_receipt_tenant()            SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_goods_receipt_apply()                   SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_check_revenue_entry_operation_tenant()  SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_check_revenue_breakdown_tenant()        SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_check_dre_category_group_tenant()       SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.tg_apply_stock_movement()                  SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.fb_calc_nps(uuid, uuid, uuid, timestamptz, timestamptz)
                                                              SET search_path = 'app','public','pg_temp';
ALTER FUNCTION app.fb_classify_response()                     SET search_path = 'app','public','pg_temp';

-- =============================================================================
-- Funções em schema `public` (seeders, snapshots, recomputes, propagações)
-- =============================================================================
ALTER FUNCTION public.tg_seed_dre_on_tenant_insert()          SET search_path = 'app','public','pg_temp';
ALTER FUNCTION public.propagate_preparation_cost()            SET search_path = 'app','public','pg_temp';
ALTER FUNCTION public.trg_recompute_auto_min()                SET search_path = 'app','public','pg_temp';
ALTER FUNCTION public.trg_recompute_on_toggle()               SET search_path = 'app','public','pg_temp';
ALTER FUNCTION public.propagate_stock_item_cost()             SET search_path = 'app','public','pg_temp';
ALTER FUNCTION public.tg_snapshot_initial_on_tenant_insert()  SET search_path = 'app','public','pg_temp';
ALTER FUNCTION public.seed_default_dre(uuid)                  SET search_path = 'app','public','pg_temp';
ALTER FUNCTION public.snapshot_stock_value(uuid, text, text)  SET search_path = 'app','public','pg_temp';
ALTER FUNCTION public.run_stock_value_snapshots()             SET search_path = 'app','public','pg_temp';
ALTER FUNCTION public.propagate_preparation_yield_change()    SET search_path = 'app','public','pg_temp';
ALTER FUNCTION public.compute_auto_min_max(uuid)              SET search_path = 'app','public','pg_temp';
;
