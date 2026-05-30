-- Fase 3 (revisada): move pg_trgm e citext para schema `extensions`.
-- pg_net não suporta SET SCHEMA (limitação da extensão); fica como dívida técnica
-- documentada — para mover seria preciso DROP/CREATE com perda da fila net._http_response.
--
-- Adicionamos `extensions` ao search_path dos roles do PostgREST para que queries
-- não-qualificadas que usam ::citext ou operator `%` do pg_trgm continuem funcionando.

CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'pg_trgm' AND n.nspname = 'public'
  ) THEN
    EXECUTE 'ALTER EXTENSION pg_trgm SET SCHEMA extensions';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'citext' AND n.nspname = 'public'
  ) THEN
    EXECUTE 'ALTER EXTENSION citext SET SCHEMA extensions';
  END IF;
END $$;

ALTER ROLE anon          SET search_path = "$user", public, extensions;
ALTER ROLE authenticated SET search_path = "$user", public, extensions;
ALTER ROLE service_role  SET search_path = "$user", public, extensions;
;
