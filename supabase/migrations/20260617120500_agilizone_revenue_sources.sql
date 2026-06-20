-- ============================================================================
-- Agilizone — origens de faturamento como revenue_source
-- ----------------------------------------------------------------------------
-- O faturamento é atribuído pela origem real que a Agilizone indica
-- (originPlatform). 'ifood' já existe; adicionamos as demais observadas.
-- Origem não mapeada cai em 'outro' (logada pelo edge function p/ inclusão).
-- ADD VALUE roda fora de uso no mesmo txn — ok numa migration isolada.
-- ============================================================================

alter type app.revenue_source add value if not exists 'anota_ai';
alter type app.revenue_source add value if not exists 'beefood';
