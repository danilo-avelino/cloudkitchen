-- Fix: criação de tenant falha com "type citext does not exist".
--
-- Causa (regressão entre migrations da auditoria 2026-05-27):
--   1. Fase 2 (20260527123806) fixou search_path = 'app','public','pg_temp'
--      em public.seed_default_dre(uuid). Na época citext ainda morava em
--      `public`, então `::citext` resolvia.
--   2. Fase 3 (20260527124011) moveu a extensão citext para o schema
--      `extensions` e adicionou esse schema ao search_path dos ROLES — mas
--      não ao das funções com search_path fixado.
--
-- O trigger trg_seed_dre_on_tenant (AFTER INSERT ON public.tenants) chama
-- seed_default_dre, que usa `g.slug::citext`. Como `extensions` não está no
-- search_path fixado da função, o cast falha e a inserção do tenant aborta
-- com 500 — em TODA criação nova de tenant (independe do email reusado).
--
-- Correção: incluir `extensions` no search_path fixado, preservando o padrão
-- de hardening (app, public, pg_temp) das regras do projeto.
ALTER FUNCTION public.seed_default_dre(uuid)
  SET search_path = 'app', 'public', 'extensions', 'pg_temp';
