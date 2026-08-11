# DEPLOY-PENDING — pendências de migration, deploy e commit

> Atualizado em **2026-08-11**. **3 migrations pendentes** (seção 0, cadeia de
> suprimentos). Restam também as 4 edge functions, os commits, os smoke tests e
> ligar o trigger do rateio.
> O MCP do Supabase foi reautenticado em 2026-08-10 (as migrations 1c/1d foram
> aplicadas por ele), mas **nas sessões de hoje o MCP do Supabase não está
> disponível** — as migrations da seção 0 não puderam ser aplicadas nem passar
> pelos advisors.

## 0. ⏳ PENDENTE — Cadeia de suprimentos (aplicar na ordem 0 → 1 → 2)

| # | Arquivo | O que faz |
|---|---------|-----------|
| 2 | `supabase/migrations/20260811160000_supply_receipt_divergence.sql` | **Divergência de recebimento.** Quem recebe confere item a item (`supply_transfer_items.received_qty` + `divergence_reason`) e o que diferir vira divergência. Regra: **entra o que chegou, cobra o que chegou** — `supply_transfers.received_value` (= Σ `received_qty × unit_cost`) passa a alimentar `supply_ledger_entries` e o financeiro dos dois lados no lugar de `total_value` (que continua sendo o valor **enviado**, imutável); `divergence_value` = recebido − enviado (negativo = faltou). A perda por falta fica com quem enviou, cujo estoque já saiu no envio. Nova assinatura `supply_receive_transfer(uuid, jsonb, text)` (a de 2 args é dropada) e view `supply_divergence_lines` (security_invoker) alimentando a aba Divergências. **Aplicar depois da 1.** |
| 1 | `supabase/migrations/20260811120000_supply_direct_kitchen_per_item.sql` | **"Direto na cozinha" vira item a item** (era da transferência inteira): colunas `direct_to_kitchen`/`receive_operation_id` em `supply_transfer_items` e `auto_direct_kitchen`/`direct_kitchen_operation_id` em `stock_items` (memória da escolha, pré-marca o próximo recebimento). `create or replace` de `app.tg_supply_transfer_transition()` mexendo **só** no ramo `sent → received` (flag por linha, com fallback no flag da transferência p/ linhas antigas). RPC nova `supply_receive_transfer(uuid, jsonb)` — o destinatário não tem policy de escrita em `supply_transfer_items`, então a marcação e a virada de status acontecem numa DEFINER, na mesma transação. **Aplicar depois da 0.** |
| 0 | `supabase/migrations/20260810180000_supply_assortment.sql` | **A central passa a gerir o estoque das unidades.** `supply_item_links.is_assortment` marca o catálogo de abastecimento; `stock_items.managed_by_central_id` marca o item gerido; trigger `tg_stock_items_central_guard` impede a unidade de mexer em `reorder_point`/`max_qty`/`auto_min_*` (libera updates internos via `pg_trigger_depth() > 1`, que é como o `compute_auto_min_max` roda). RPCs novos: `supply_assortment_add/set/remove` (escrita, só gestor da central) e `supply_unit_assortment` / `supply_units_summary` / `supply_replenishment` (leitura cross-tenant). |

Sem a migration 0 aplicada, o resto do app segue normal: as abas **Unidades** e
**Reposição** da Central apenas ficam vazias (os wrappers tratam o erro da RPC
inexistente devolvendo lista vazia) e nenhum item aparece como "gerido pela central".
Já a 1 e a 2 **são bloqueantes para o recebimento**: o modal de confirmar recebimento
chama `supply_receive_transfer` e hoje passa 3 argumentos, então até aplicá-las o
recebimento falha com "function does not exist". A aba **Divergências** (Central e
Cadeia de suprimentos) fica vazia sem a 2 — a view `supply_divergence_lines` e as
colunas `received_value`/`divergence_value` não existem, e o select de transferências
falha (o `_SUPPLY_TRANSFER_FIELDS` pede as colunas novas).

**Pós-migration (obrigatório, CLAUDE.md §5):**
- [ ] `apply_migration` dos 3 arquivos acima, na ordem.
- [ ] `get_advisors` — confirmar que não regrediu do baseline de 3 WARNs.
- [ ] Conferir que `authenticated` tem EXECUTE nos 6 RPCs novos e que `anon`/`PUBLIC` foram revogados.
- [ ] Smoke test: cadastrar 1 item para uma unidade → conferir que ele nasce no
      estoque dela com saldo 0 e mín/máx travados no app da unidade; baixar o saldo
      abaixo do mínimo → conferir que aparece em Reposição com qtd = máx − atual.
- [ ] Smoke test do guard: tentar editar o mín do item pela unidade → deve falhar
      com "mín/máx de X é gerido pela central"; e uma movimentação de estoque no
      item (com auto ligado) deve continuar recalculando normalmente.
- [ ] Smoke test do direto na cozinha: receber uma transferência com 1 item marcado
      → conferir os 2 movimentos (`in` + `out` com `operation_id`) só naquele item,
      e que o outro item ficou só com o `in`; reabrir o próximo recebimento do mesmo
      insumo → deve vir pré-marcado com a mesma operação.
- [ ] Smoke test da divergência: enviar 50 un a R$ 3,47 → no recebimento clicar
      **Relatar divergência**, informar 46 un com motivo "Não veio" → confirmar.
      Conferir: movimento `in` de 46 (não 50); `received_value` = 159,62 e
      `divergence_value` = −13,88 na transferência; `supply_ledger_entries` e as
      duas `finance_entries` (destinatário +159,62 / remetente −159,62) com o valor
      recebido; a linha aparecendo na aba **Divergências** dos dois lados com o KPI
      de % batendo com |13,88| ÷ 173,50. Testar também um item com 0 recebido
      (não pode gerar movimento nem criar insumo novo no destino) e uma sobra.

## 1c. ✅ Aplicada em 2026-08-10 (via MCP) — só falta commitar

| # | Arquivo | O que faz |
|---|---------|-----------|
| 0 | `supabase/migrations/20260810120000_production_order_separation.sql` | **Solicitação de insumos passa pelo módulo Requisições (2026-08-10)**: colunas `separated_at`/`separated_by` em `production_orders` + índice parcial da fila de abertas. Não mexe em trigger nenhum — "separada" é só carimbo sobre a ordem `draft`; a baixa continua no `draft → issued` (entrega). |

Verificado em prod: as 2 colunas existem e o índice `production_orders_open_idx`
foi criado. O front (`_PROD_ORDER_FIELDS` com `separated_at`) já pode subir.
>
>
> ⚠️ **Não cadastrar conta Foody antes de deployar as edge functions.** O cron
> `foody-poll-5min` já está agendado; hoje ele não faz nada porque `foody_poll`
> tem guard de "nenhuma conta ativa", mas a primeira conta cadastrada faz o cron
> chamar `foody-ingest` (inexistente) a cada 5 minutos.

## 1d. ✅ Aplicada em 2026-08-10 (via MCP) — só falta commitar

| # | Arquivo | O que faz |
|---|---------|-----------|
| 0 | `supabase/migrations/20260810160000_production_input_weight_from_unit.sql` | **Desperdício para insumo em "un" (2026-08-10)**: `create or replace` de `app.tg_production_order_transition()` com uma mudança só, no ramo `draft → issued` — o peso do insumo cai em `stock_items.portion_qty/portion_unit` quando a unidade não é de massa. Sem isso, uma linha em "un" zera `input_weight` e o lote nunca calcula `yield_pct`/`waste_qty`. |

Base: a versão de `20260713120000` (última a definir a função). O ramo `completed`
fica **intocado** — a pendência de religar `tg_production_apply_complete_alloc()`
continua aberta e não conflita. Sem coluna nova: reusa `portion_qty`.

Antes de aplicar, o `prosrc` de produção foi comparado com o arquivo: era
byte-a-byte a versão de `20260713120000` (nenhum patch manual em cima), e as
únicas diferenças eram as 3 pretendidas. Pós-aplicação, verificado em prod: o
fallback por `portion_qty` está no corpo, `search_path = app, public, pg_temp`
preservado, o trigger `tg_production_orders_transition` segue apontando para a
função e `authenticated` mantém EXECUTE.

## 1. Migrations

### 1a. Aplicadas em 2026-08-09 (via SQL Editor) — só falta commitar

| # | Arquivo | O que faz |
|---|---------|-----------|
| 1 | `supabase/migrations/20260706120000_foody_ingest.sql` | Integração Foody Delivery: tabelas `foody_accounts` / `foody_point_map` / pedidos; token da API no Vault (RPC service-role-only, só `token_hint` no banco); **trava de exclusividade** Agilizone×Foody (trigger nas duas tabelas de contas); RPC `foody_poll` + `cron.schedule('foody-poll-5min')` disparando o ingest via pg_net com header `x-ingest-secret`. |
| 2 | `supabase/migrations/20260706121000_logistics_rpcs_unified.sql` | View `delivery_orders_unified` (security_invoker) normalizando Agilizone + Foody; os 5 RPCs de logística passam a ler a view mantendo nome/assinatura/shape (front não muda). |

| 2b | `supabase/migrations/20260809120000_production_cost_allocation_ref_value.sql` | **Rateio multi-saída por valor de referência** (REVISAO-PRODUCAO.md §3.5): coluna `ref_value` em `production_recipe_outputs` e `production_order_outputs`; função `app.tg_production_apply_complete_alloc()` com direcionador em cascata valor → peso → quantidade (o 3º nível remove as exceções que travavam a devolução multi-saída sem `portion_qty`). **Trigger ainda NÃO religado** — ver pendência abaixo. |

**Pós-migrations (obrigatório, CLAUDE.md §5) — TODAS ABERTAS:**
- [ ] `get_advisors` — **9 migrations já aplicadas sem checagem** (as 6 de julho + as 3 de 2026-08-09). Baseline: 3 WARNs da auditoria 2026-05-27.
- [ ] Conferir GRANTs: USAGE/EXECUTE no schema `app` e USAGE+ALL em `public` para `service_role`.
- [ ] Confirmar que o secret `x-ingest-secret` criado pela migration bate com o que a edge function `foody-ingest` valida.
- [ ] **Ligar o rateio por `ref_value`**: o ramo `completed` de `app.tg_production_apply_status()` precisa passar a chamar `app.tg_production_apply_complete_alloc()`. Até lá o rateio multi-saída segue por peso (distorcendo custo entre produto nobre e subproduto). Requer o `prosrc` atual da função para reescrita segura.
- [ ] Smoke test da Logística após a troca dos 5 RPCs para `delivery_orders_unified` (mesma assinatura, mas é troca em produção).

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

Fluxo em 2 fases da produção (2026-08-10) — **depende da migration da seção 1c**:
- `supabase/migrations/20260810120000_production_order_separation.sql` (**novo**).
- `lib-supabase.jsx` — `separated_at/separated_by` em `_PROD_ORDER_FIELDS` + mapper; `dbSeparateProductionOrder`/`dbUnseparateProductionOrder`.
- `page-production.jsx` — "Produzir hoje" vira política mín/máx com lotes inteiros da receita (`planProduction`, exposto no window); bloco "Em andamento"; o modal de lote virou **solicitação de insumos** (só cria `draft`, não baixa nada); a entrega saiu da tela (mora em Requisições).
- `page-requests.jsx` — solicitações da Produção no quadro/lista (pendente → separada → entregue), cupom térmico com cabeçalho "Separação para produção".
- `page-mobile-production.jsx` / `page-mobile-requests-board.jsx` — espelhos das duas telas.
- `page-stock.jsx` / `page-mobile-stock.jsx` — modal de insumo alargado (680) e grids com `minmax(0,…)`; campo **Peso por unidade (g)** para itens em "un" (grava em `portion_qty`/`portion_unit`, em kg). **Fix 2026-08-11**: o handler de *edição* de insumo não repassava `portionQty`/`portionUnit` ao `dbUpdateStockItem` — o peso só era gravado na criação, e editar um item existente descartava o valor em silêncio (por isso as ordens ficavam sem desperdício/aproveitamento).
- `lib-supabase.jsx` / `page-production.jsx` / `page-mobile-production.jsx` — **peso vivo (2026-08-11)**: `prodOrderWithLiveWeights(order, stockItems)` recalcula `inputWeight`/`outputWeight`/`yieldPct`/`wasteQty` a partir do peso ATUAL de `stock_items.portion_qty` na leitura das ordens; as colunas do banco viram fallback. Cadastrar o peso depois passa a corrigir o histórico sozinho — nenhum backfill de dados é necessário. Custo continua congelado (`unit_cost`/`total_input_cost` são preço do dia, não atributo físico).
- `page-transformed.jsx` — aba Análises avisa quais insumos estão sem peso e por isso zeram desperdício/aproveitamento.

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

Divergência de recebimento (2026-08-11) — **depende da migration 2 da seção 0**:
- `supabase/migrations/20260811160000_supply_receipt_divergence.sql` (**novo**).
- `lib-supabase.jsx` — `received_qty`/`divergence_reason`/`received_value`/`divergence_value`/`divergence_notes` no `_SUPPLY_TRANSFER_FIELDS` e nos mappers; `dbSupplyReceiveTransfer` passa a mandar a conferência + observação; `dbSupplyDivergences` (view + recebimentos do período, paginados por `.range()`).
- `page-supply.jsx` — botão **Relatar divergência** no modal de recebimento (input de qtd conferida por linha, motivo obrigatório, resumo do impacto); componente compartilhado `SupplyDivergenceView` (KPIs, filtros de mês/contraparte/motivo, rankings e tabela de ocorrências); aba **Divergências**; recebido vs. enviado na lista e no detalhe da transferência.
- `page-distribution.jsx` — aba **Divergências** na Central (mesmo componente, `isCentral`).
- `page-mobile-supply.jsx` / `page-mobile-distribution.jsx` — aba Divergências read-only (`MobileSupplyDivergences`, StatStrip + cards).
- Nesse mesmo lote: **Recebimentos** virou a primeira aba da Cadeia de suprimentos.

Não versionados — decidir antes do commit:
- `.claude/skills/` (skills oficiais Supabase instaladas em 2026-07-11) — pode commitar se quisermos compartilhar.
- `.claude/settings.local.json` — **não commitar** (config local); considerar adicionar `.claude/settings.local.json` ao `.gitignore`.

## 4. Roteiro do dia do deploy

1. Reautenticar MCP: terminal comum → `claude /mcp` → supabase → Authenticate (URL do `.mcp.json` está correta; erro anterior era `resource` sem o path `/mcp`).
2. Aplicar a migration da **seção 1c** (separação das ordens de produção) — obrigatória antes do front novo. As 1a/1b já estão em prod; não reaplicar (embora sejam idempotentes).
3. Deploy das 4 edge functions.
4. Smoke test Foody: Configurações → Foody Delivery (cadastrar conta com token, mapear pontos, sincronizar); Logística carrega com dados unificados; trava de exclusividade nos dois sentidos; convite de e-mail já existente vincula sem trocar senha.
5. Smoke test Produção — fluxo em 2 fases (exemplo canônico do PRD §3.4 itens 1–2): criar transformado "Calabresa porcionada 100g" (porção 100 g, mín/máx definidos) → em Produzir hoje conferir a quantidade sugerida em lotes inteiros → **Solicitar insumos** (10 kg de calabresa) → a ordem aparece em Requisições como "🏭 Produção · Pendente" → Separar → Confirmar entrega (só aqui o estoque baixa) → volta em Produção como "aguardando devolução" → devolução de 95 porções → conferir custo/porção (custo total ÷ 95), aproveitamento 95%, CMV do dia inalterado, transformado requisitável em Requisições e fora da lista de Compras.
6. Smoke test Rede (PRD §3.4 itens 3–5, precisa de 3 tenants: central + A + B):
   - Superadmin promove um tenant a "Central de distribuição"; central convida A e B pelo código (Configurações → chip "Código da rede"); A e B aceitam no módulo Suprimentos.
   - Central transfere 50 porções a A → A confirma → estoque de A +50 a R$3,00; gasto de A +R$150; finance: +150 "Compras · Rede de suprimentos" (A) e −150 "Repasses à rede (−)" (central); CMV dos dois inalterado.
   - A envia 10 porções a B → B confirma → gastos A=120/B=30 (aba Gastos da central); soma = 150.
   - B recebe outra transferência com "direto na cozinha" → CMV do dia de B sobe pelo valor; estoque de B não muda no líquido.
   - Solicitação: A pede itens do catálogo da central → central aprova → "Atender" cria a transferência → recebida → solicitação vira "Atendida".
   - DRE da central mostra o card "Repasses à rede no mês".
7. Commit + push (mensagens sugeridas: `Foody Delivery: integração de logística (contas, point map, ingest, trava de exclusividade)`, `invite-member: não resetar senha de usuário existente` e `Produção & Rede de Suprimentos: módulos production/transformed/supply/distribution (PRD Fases A-D)`).
