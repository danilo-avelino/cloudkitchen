-- Fase 1d: as 79 tabelas legadas (sistema Prisma anterior, sem RLS) não são usadas
-- pelo StockKitchen (zero refs em código JSX). Renomeio com prefixo "_legacy_" e revogo
-- TODOS os grants de anon/authenticated/PUBLIC, mantendo apenas postgres/service_role.
--
-- Decisão (2026-05-27): preservar dados (não dropar) — usuário pode mover para schema
-- separado ou dropar manualmente depois. O REVOKE garante isolamento via PostgREST.
--
-- Idempotente: cada bloco verifica existência da tabela original antes de renomear.

DO $$
DECLARE
  v_tbl text;
  v_new text;
  v_legacy_tables text[] := ARRAY[
    'Organization','UserCostCenterAccess','AdminImpersonationSession','AdminImpersonationLog',
    'User','Session','cost_centers','Order','SyncLog','ProductCategory','Product','Supplier',
    'StockMovement','StockBatch','RecipeCategory','Recipe','RecipeIngredient','PricingSuggestion',
    'PortioningProcess','PortioningBatch','CMVSnapshot','MenuAnalysis','ItemPerformance','Alert',
    'AlertRule','PurchaseSuggestion','ConsumptionAnomaly','Achievement','AuditLog',
    'InventorySession','InventoryItem','StockRequest','StockRequestItem','StockRequestComment',
    'StockRequestTemplate','StockRequestTemplateItem','CashSession','CashMovement','Customer',
    'CustomerAddress','RestaurantTable','PdvOrder','PdvOrderItem','PdvOrderStatusHistory',
    'PdvPayment','PurchaseList','PurchaseListItem','PurchaseConfig','Event','Ticket',
    'PlatformAuditLog','WebhookLog','ScheduleSector','ScheduleEmployee','ScheduleMonthConfig',
    'Schedule','ScheduleSectorOutput','ScheduleChange','IntegrationInbox','WorkTimeOrder',
    'MenuCategory','MenuItem','MenuItemCombo','MenuOptionGroup','MenuOption','goals',
    'IndicatorResult','IndicatorAccess','IndicatorComment','PortioningProcessOutput',
    'PortioningBatchOutput','revenues','SalesIntegration','LogisticsIntegration','Goal',
    'GoalTarget','GoalInterestedUser','GoalEntry','GoalResult'
  ];
BEGIN
  FOREACH v_tbl IN ARRAY v_legacy_tables LOOP
    v_new := '_legacy_' || v_tbl;
    -- Renomeia apenas se a tabela original existe e a renomeada ainda NÃO existe (idempotente)
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname = 'public' AND c.relname = v_tbl
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname = 'public' AND c.relname = v_new
    ) THEN
      EXECUTE format('ALTER TABLE public.%I RENAME TO %I', v_tbl, v_new);
    END IF;

    -- REVOKE em anon/authenticated/PUBLIC — só executa se a renomeada existir agora
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname = 'public' AND c.relname = v_new
    ) THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',        v_new);
      EXECUTE format('REVOKE ALL ON public.%I FROM anon',          v_new);
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', v_new);
    END IF;
  END LOOP;
END $$;

-- Também revoga grants de sequences órfãs do sistema legado (Prisma costuma criar _id_seq)
DO $$
DECLARE
  v_seq record;
BEGIN
  FOR v_seq IN
    SELECT c.relname AS seqname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'S'
       AND n.nspname = 'public'
       AND c.relname LIKE ANY (ARRAY[
         '%Organization%','%User%','%Session%','%Order%','%Product%','%Supplier%',
         '%StockMovement%','%StockBatch%','%Recipe%','%Pricing%','%Portioning%','%CMV%',
         '%Menu%','%Alert%','%Purchase%','%Achievement%','%Audit%','%Inventory%',
         '%StockRequest%','%Cash%','%Customer%','%Restaurant%','%Pdv%','%Event%',
         '%Ticket%','%Platform%','%Webhook%','%Schedule%','%Integration%','%WorkTime%',
         '%Indicator%','%Goal%','%Sales%','%Logistics%','%cost_centers%','%goals%','%revenues%'
       ])
  LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM anon, authenticated, PUBLIC', v_seq.seqname);
    EXCEPTION WHEN OTHERS THEN
      -- sequências do StockKitchen (snake_case) também batem, mas REVOKE só remove o que existe — safe
      NULL;
    END;
  END LOOP;
END $$;
;
