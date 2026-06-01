-- Remove por completo a feature "Análise de mercado" (frontend e edge functions
-- removidos do código). Dropa a tabela de chaves OpenAI por tenant — o trigger
-- tg_market_openai_keys_updated_at vai junto (a função app.tg_set_updated_at é
-- compartilhada e permanece). Edge functions market-analysis / market-openai-key
-- precisam de undeploy à parte (supabase functions delete ...).
DROP TABLE IF EXISTS public.market_openai_keys CASCADE;

-- Tira 'analise-mercado' dos presets de módulo (espelha APP_MODULES do frontend).
CREATE OR REPLACE FUNCTION app.role_default_modules(p_role app.member_role)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = 'public', 'app', 'pg_temp'
AS $$
  SELECT CASE p_role
    WHEN 'owner'      THEN ARRAY['dashboard','stock','recipes','revenue','requests','purchases','cmv','finance','dre','settings']
    WHEN 'admin'      THEN ARRAY['dashboard','stock','recipes','revenue','requests','purchases','cmv','finance','dre','settings']
    WHEN 'manager'    THEN ARRAY['dashboard','stock','recipes','revenue','requests','purchases','cmv','finance','dre']
    WHEN 'kitchen'    THEN ARRAY['dashboard','stock','requests','recipes']
    WHEN 'stock'      THEN ARRAY['dashboard','stock','requests','purchases']
    WHEN 'accountant' THEN ARRAY['dashboard','revenue','cmv','finance','dre']
    WHEN 'viewer'     THEN ARRAY['dashboard']
    ELSE ARRAY['dashboard']
  END;
$$;
