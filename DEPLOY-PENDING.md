# DEPLOY-PENDING — pendências de migration, deploy e commit

> Atualizado em **2026-07-15**. As migrations do PRD Produção/Distribuição já foram
> **aplicadas manualmente** pelo usuário via SQL Editor. Continua pendente: as 2
> migrations da Foody, as 4 edge functions e os commits.
> Bloqueio do MCP do Supabase (OAuth) segue de pé — por isso o fluxo manual.

## 1. Migrations

### 1a. Pendentes (aplicar nesta ordem)

| # | Arquivo | O que faz |
|---|---------|-----------|
| 1 | `supabase/migrations/20260706120000_foody_ingest.sql` | Integração Foody Delivery: tabelas `foody_accounts` / `foody_point_map` / pedidos; token da API no Vault (RPC service-role-only, só `token_hint` no banco); **trava de exclusividade** Agilizone×Foody (trigger nas duas tabelas de contas); RPC `foody_poll` + `cron.schedule('foody-poll-5min')` disparando o ingest via pg_net com header `x-ingest-secret`. |
| 2 | `supabase/migrations/20260706121000_logistics_rpcs_unified.sql` | View `delivery_orders_unified` (security_invoker) normalizando Agilizone + Foody; os 5 RPCs de logística passam a ler a view mantendo nome/assinatura/shape (front não muda). |

**Pós-migrations (obrigatório, CLAUDE.md §5):**
- [ ] `get_advisors` — confirmar que não regrediu (baseline: 3 WARNs da auditoria 2026-05-27).
- [ ] Conferir GRANTs: USAGE/EXECUTE no schema `app` e USAGE+ALL em `public` para `service_role`.
- [ ] Confirmar que o secret `x-ingest-secret` criado pela migration bate com o que a edge function `foody-ingest` valida.

### 1b. Já aplicadas em prod (2026-07-11/15, via SQL Editor) — só falta commitar

Aplicadas manualmente nesta ordem. O patch consolidado que servia de "cola" foi
removido depois de aplicado; estes arquivos são a fonte de verdade (e o que roda
num ambiente novo).

| # | Arquivo | O que faz |
|---|---------|-----------|
| 3 | `supabase/migrations/20260711120000_production_module.sql` | **Módulo Produção & Porcionamento (Fase A do PRD-PRODUCAO-E-DISTRIBUICAO.md)**: `stock_items.item_kind/portion_qty/portion_unit`; tabelas `production_orders/_inputs/_outputs` (multi-saída, custo rateado por peso) + `production_recipes/_inputs/_outputs`; trigger de transição de status (issue baixa insumos com `reference_type='production_order'`, complete dá entrada dos transformados com custo convertido, cancel gera inversos); RLS por `can_access_module`; `app.role_default_modules` ganha `production` p/ kitchen/stock. |
| 4 | `supabase/migrations/20260711130000_supply_network.sql` | **Rede de suprimentos (Fase B)**: `tenants.kind` ('standard'\|'distribution_center') + `tenants.supply_code` (8 dígitos, único, backfill p/ todos + trigger em novos); `supply_members` (invited→active/rejected; removed/left); RPCs DEFINER `supply_lookup_tenant_by_code`, `supply_invite_tenant`, `supply_respond_invite`, `supply_remove_member` (escrita em supply_members SÓ via RPC). |
| 5 | `supabase/migrations/20260711140000_supply_transfers.sql` | **Transferências/Gastos/Solicitações (Fase C)**: `supply_transfers/_items` (draft→sent→received; triggers DEFINER fazem baixa no remetente, mapeamento/criação de item no destino via `supply_item_links`, entrada + saída "direto na cozinha" com `reference_type='supply_transfer_kitchen'`); `supply_ledger_entries` imutável + view `v_supply_balances`; lançamentos automáticos em `finance_entries` (subs "Compras · Rede de suprimentos" / "Repasses à rede (−)" no grupo cmv — subs normais, NÃO autofeed); `supply_requests/_items`; RPCs `supply_network_overview`, `supply_list_catalog`, `supply_ledger_adjust`; `role_default_modules`: owner/admin/manager += supply+distribution, stock += supply. |
| 6 | `supabase/migrations/20260711150000_production_exit_order_flow.sql` | **Fluxo de ordem de saída (2026-07-11)**: envio não exige mais transformados pré-definidos; saídas podem ser inseridas com a ordem em `issued` (a devolução cria as linhas com `returned_qty`); validação de porção/rateio movida pro completed. |
| 7 | `supabase/migrations/20260712120000_transformed_into_production.sql` | **Transformados vira abas do módulo Produção (2026-07-12)**: RLS de escrita do catálogo (stock_items transformados) e das receitas passa a aceitar o módulo `production` (mantém `transformed` por compat); `role_default_modules` sem 'transformed'. |
| 8 | `supabase/migrations/20260713120000_production_allow_negative_stock.sql` | **Ordem de saída sem saldo (2026-07-13)**: remove o guard 'Saldo insuficiente' do `draft → issued` — a produção pode retirar insumo com estoque zerado e o saldo fica negativo (regulariza depois pela entrada da compra; os negativos já aparecem em Estoque → Pendências de lançamento). O guard das transferências da rede (supply_transfers) **continua**. |

- [ ] Rodar `get_advisors` quando o MCP voltar (as 6 acima foram aplicadas sem checagem de advisor).

## 2. Edge functions a deployar

| Função | Status | Mudança |
|--------|--------|---------|
| `foody-admin` | **nova** | CRUD de contas Foody, mapeamento de pontos de coleta → operações, discover, sync manual. |
| `foody-ingest` | **nova** | Ingest de pedidos da Foody (espelho da `agilizone-ingest`); chamada pelo cron `foody-poll-5min` via pg_net. |
| `agilizone-admin` | modificada | Trava de exclusividade: `list-accounts` retorna `otherActive`; conta nova nasce **pausada** se Foody ativa (`lockedPaused`); `toggle-account` retorna 409 se Foody ativa. |
| `invite-member` | modificada | **Fix de segurança**: nunca resetar senha de usuário já existente (e-mail é global — reset permitiria tomar conta de outro tenant); apenas vincula membership e retorna `linkedExisting`/`passwordApplied`. |

## 3. Commits pendentes (git — só com pedido explícito)

Front (funciona junto com o backend acima — commitar no mesmo lote do deploy):
- `lib-supabase.jsx` — helpers `dbFoody*` (via edge fn `foody-admin`) + `dbLogisticsIntegrationActive` (Agilizone OU Foody).
- `page-settings.jsx` — aba **Configurações → Foody Delivery** (FoodyTab, cards, modal, avisos da trava de exclusividade dos dois lados).
- `page-delivery.jsx` — Logística usa `dbLogisticsIntegrationActive`; textos deixam de ser Agilizone-only.
- `supabase/functions/*` e `supabase/migrations/*` listados nas seções 1–2.

Front do PRD Produção/Distribuição (Fases A–D — migrations 3–8 **já aplicadas em prod**, então este front pode ir a qualquer momento):
- `page-production.jsx` (**novo**) — módulo Produção com abas: Ordens de saída (criar/enviar/devolução/cancelar, alertas de tempo de espera), Transformados (catálogo), Receitas de produção, Análises e Consumo por tenant (só central). O módulo Transformados foi fundido aqui em 2026-07-12.
- `page-transformed.jsx` (**novo**) — componentes embutíveis consumidos pelo page-production (TransformedCatalog, ProductionRecipesPanel, TransformedAnalytics, TransformedByTenant); não é mais página/módulo próprio.
- `page-supply.jsx` (**novo**) — Suprimentos: aceitar/recusar convite, solicitar da central, pedir/enviar entre tenants, confirmar recebimentos (mapeamento de itens + "direto na cozinha"), extrato de gastos. Componentes compartilhados com a Central.
- `page-distribution.jsx` (**novo**) — Central: convidar por código, membros, transferências, solicitações recebidas (aprovar/atender), gastos por tenant + ajuste manual.
- `lib-supabase.jsx` — funções `dbProduction*`/`dbSupply*` (~25 novas); `mapStockItemFromDb` com `itemKind/portionQty/portionUnit`; `dbListTenantsAdmin`/`dbUpdateTenantAdmin` com `kind` (⚠️ o select explícito de `kind` quebra se a migration 4 não estiver aplicada — deploy do front SÓ depois das migrations).
- `widgets.jsx` — helper `isNonCmvMovement` (`production_order`/`supply_transfer` fora do CMV).
- `page-cmv.jsx` + `page-dashboard.jsx` — exclusões de CMV por `referenceType` (6 + 3 pontos).
- `page-dre.jsx` — card "Repasses à rede no mês" (aparece quando há repasses; decisão PRD §12.4).
- `page-purchases.jsx` + `page-shopping.jsx` — transformados fora das sugestões de compra.
- `shell.jsx`, `src/App.jsx`, `src/main.jsx`, `page-settings.jsx` — módulos `production`/`supply`/`distribution` (#/producao, #/suprimentos, #/central; slug legado #/transformados redireciona p/ produção); visibilidade condicional (Central só p/ kind='distribution_center'; Suprimentos p/ membro/convidado **ou** central); chip "Código da rede" em Configurações; presets kitchen/stock.
- `page-superadmin.jsx` — seletor "Tipo de tenant" no modal de edição (promove a central de distribuição).
- `PRD-PRODUCAO-E-DISTRIBUICAO.md` — spec + decisões confirmadas em 2026-07-11.

Não versionados — decidir antes do commit:
- `.claude/skills/` (skills oficiais Supabase instaladas em 2026-07-11) — pode commitar se quisermos compartilhar.
- `.claude/settings.local.json` — **não commitar** (config local); considerar adicionar `.claude/settings.local.json` ao `.gitignore`.

## 4. Roteiro do dia do deploy

1. Reautenticar MCP: terminal comum → `claude /mcp` → supabase → Authenticate (URL do `.mcp.json` está correta; erro anterior era `resource` sem o path `/mcp`).
2. Aplicar as migrations **pendentes** (seção 1a: Foody 1→2) na ordem, rodando advisors após cada uma. As 3–8 (seção 1b) já estão em prod — não reaplicar (embora sejam idempotentes).
3. Deploy das 4 edge functions.
4. Smoke test Foody: Configurações → Foody Delivery (cadastrar conta com token, mapear pontos, sincronizar); Logística carrega com dados unificados; trava de exclusividade nos dois sentidos; convite de e-mail já existente vincula sem trocar senha.
5. Smoke test Produção (exemplo canônico do PRD §3.4 itens 1–2): criar transformado "Calabresa porcionada 100g" (porção 100 g) → ordem de saída com 10 kg de calabresa → lançar saída → lançar devolução de 95 porções → conferir custo/porção (custo total ÷ 95), aproveitamento 95%, CMV do dia inalterado, transformado requisitável em Requisições e fora da lista de Compras.
6. Smoke test Rede (PRD §3.4 itens 3–5, precisa de 3 tenants: central + A + B):
   - Superadmin promove um tenant a "Central de distribuição"; central convida A e B pelo código (Configurações → chip "Código da rede"); A e B aceitam no módulo Suprimentos.
   - Central transfere 50 porções a A → A confirma → estoque de A +50 a R$3,00; gasto de A +R$150; finance: +150 "Compras · Rede de suprimentos" (A) e −150 "Repasses à rede (−)" (central); CMV dos dois inalterado.
   - A envia 10 porções a B → B confirma → gastos A=120/B=30 (aba Gastos da central); soma = 150.
   - B recebe outra transferência com "direto na cozinha" → CMV do dia de B sobe pelo valor; estoque de B não muda no líquido.
   - Solicitação: A pede itens do catálogo da central → central aprova → "Atender" cria a transferência → recebida → solicitação vira "Atendida".
   - DRE da central mostra o card "Repasses à rede no mês".
7. Commit + push (mensagens sugeridas: `Foody Delivery: integração de logística (contas, point map, ingest, trava de exclusividade)`, `invite-member: não resetar senha de usuário existente` e `Produção & Rede de Suprimentos: módulos production/transformed/supply/distribution (PRD Fases A-D)`).
