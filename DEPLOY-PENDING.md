# DEPLOY-PENDING — pendências de migration, deploy e commit

> Atualizado em **2026-08-24**. **Backend 100% aplicado**: nenhuma migration
> pendente e as 4 edge functions estão em produção. O que resta são os **smoke
> tests** (seção 3) e os **commits** do front (seção 4) — este último só com
> pedido explícito.

## 0-ter. ✅ Aplicado em 2026-08-24 (via Supabase CLI) — Preparo → ficha respeita a unidade

| # | Arquivo | O que faz |
|---|---------|-----------|
| 0 | `supabase/migrations/20260824180000_preparation_cost_unit_aware.sql` | **Mesma armadilha da seção 0, no caminho do preparo.** `propagate_preparation_cost()` e `propagate_preparation_yield_change()` gravavam `total ÷ yield_qty` (custo por unidade de **rendimento**) em toda `tech_sheet_items` com aquele `source_prep_id`, ignorando a `unit` da linha — uma linha em `g` de um preparo que rende em `kg` ficaria 1000× mais cara na primeira edição do preparo. As duas passam por `app.stock_unit_cost_in(custo, yield_unit, tsi.unit, NULL, NULL)` (peso NULL → só kg ↔ g converte, o resto cai no fallback = comportamento anterior). Bloco 3 do `recompute_all_costs` idem. De quebra: as duas funções ganharam o `SET search_path` que faltava (§5.1) e o trigger de rendimento passou a disparar também em `yield_unit`. |

**Verificações pós-migration (CLAUDE.md §5) — feitas** (mesmo método da 0-bis:
workdir isolado + probe com `RAISE EXCEPTION`, que não deixa linha no histórico):
- [x] `migration list --linked`: `20260824180000` com local **e** remoto preenchidos.
- [x] Conversão na função em prod: preparo a R$ 13,5217/kg → `kg→g` = **0,0135217**;
      `kg→kg` = 13,5217 (intacto); preparo que rende em `und`: `und→und` = 4,50 e
      `und→g` = 4,50 (**fallback preservado** — preparo em und não vira massa, e o
      front nem oferece a unidade).
- [x] `prosecdef` = false e `proconfig` = `search_path=app, public, pg_temp` nas duas
      funções de propagação e em `recompute_all_costs`.
- [x] Os 4 triggers seguem ligados: `trg_propagate_prep_cost_ins/_upd/_del` e
      `trg_propagate_prep_yield`.
- [ ] `get_advisors` — **não rodado** (precisa do MCP). Só `CREATE OR REPLACE` de
      funções existentes + GRANTs já vigentes; nenhum objeto novo. Ver a ressalva da
      seção 0-bis.

## 0-bis. ✅ Aplicado em 2026-08-24 (via Supabase CLI) — Gramas (g) na ficha técnica

| # | Arquivo | O que faz |
|---|---------|-----------|
| 0 | `supabase/migrations/20260824160000_recipe_unit_cost_grams.sql` | **`app.stock_unit_cost_in` passa a aceitar `g`.** `create or replace` da função criada na seção 0: em vez de tratar só o par kg × un, normaliza para **custo por kg** e converte a partir daí — `kg ↔ g` é fator 1000 e **não** precisa de `portion_qty`; só entrar ou sair de `un` precisa do peso. Mesmo contrato de fallback (sem conversão possível, devolve o custo original). Trigger e `recompute_all_costs` não mudam — já chamam a função. |

**Como foi aplicada:** o MCP do Supabase não estava disponível; usei o **CLI**
(`supabase db push --linked --workdir <tmp>`). O projeto está linkado
(`supabase/.temp/project-ref`), mas 15 migrations locais nunca foram registradas em
`supabase_migrations.schema_migrations` (foram aplicadas à mão pelo SQL Editor), e
um `db push` normal tentaria reaplicar todas. Solução: workdir temporário com **só
esta migration** + placeholders vazios para as versões que existem no remoto (a
checagem de histórico do CLI é por versão, e placeholder já registrado nunca
executa). `--dry-run` confirmou "Would push these migrations: 20260824160000" antes.
**Se for preciso repetir esse tipo de push, refazer o workdir isolado — nunca rodar
`db push` na raiz do projeto e nunca aceitar o `migration repair` que o CLI sugere.**

**Verificações pós-migration (CLAUDE.md §5) — feitas:**
- [x] `migration list --linked`: `20260824160000` com local **e** remoto preenchidos.
- [x] Conversão conferida direto na função em prod, com os números do Fermento 200 g
      (`un`, R$ 14,98, `portion_qty` = 0,2): `un→kg` = **74,90**, `un→g` = **0,0749**.
      Insumo em kg sem peso: `kg→g` = **0,0054** (não cai no fallback — kg ↔ g
      dispensa `portion_qty`); `kg→un` com peso 0,5 kg = **2,70**; `g→kg` = **5,40**.
      `un→g` **sem** peso devolve 14,98/1,20 (fallback intacto; o front bloqueia antes,
      pedindo o peso no modal).
- [x] `has_schema_privilege('authenticated','app','USAGE')` = true e EXECUTE em
      `app.stock_unit_cost_in` = true para `authenticated` e `anon` (o trigger **não**
      é DEFINER — sem isso todo UPDATE de insumo no Estoque falharia com
      "permission denied for schema app").
- [x] `prosecdef` = false e `proconfig` = `search_path=app, public, pg_temp` na função
      nova; `propagate_stock_item_cost` manteve o mesmo `search_path` e o trigger
      `trg_propagate_stock_item_cost` continua apontando para ela.
- [ ] `get_advisors` — **não rodado**: precisa do MCP/Management API, indisponível na
      sessão. A migration só fez `CREATE OR REPLACE` de uma função já existente (mesma
      assinatura, mesmo `search_path`, sem virar DEFINER) e repetiu GRANTs que já
      estavam de pé — nenhuma tabela, view ou RPC novo. A superfície de advisor é a
      mesma validada na seção 0. Rodar na próxima sessão com MCP por garantia.

As verificações acima foram feitas por um bloco `DO` que termina em
`RAISE EXCEPTION` de propósito: os valores voltam na mensagem de erro e a transação
aborta, então o probe **não** deixou linha no histórico de migrations.

## 0. ✅ Aplicado em 2026-08-24 (via MCP)

| # | Arquivo | O que faz |
|---|---------|-----------|
| 1 | `supabase/migrations/20260811160000_supply_receipt_divergence.sql` | **Divergência de recebimento.** Quem recebe confere item a item (`supply_transfer_items.received_qty` + `divergence_reason`) e o que diferir vira divergência. Regra: **entra o que chegou, cobra o que chegou** — `supply_transfers.received_value` (= Σ `received_qty × unit_cost`) alimenta `supply_ledger_entries` e o financeiro dos dois lados no lugar de `total_value` (que continua sendo o valor **enviado**, imutável); `divergence_value` = recebido − enviado (negativo = faltou). A perda por falta fica com quem enviou, cujo estoque já saiu no envio. Nova assinatura `supply_receive_transfer(uuid, jsonb, text)` (a de 2 args foi dropada) e view `supply_divergence_lines` (security_invoker) alimentando a aba Divergências. |
| 2 | `supabase/migrations/20260824120000_recipe_unit_conversion.sql` | **A ficha técnica pode medir em kg um insumo cadastrado em "un"** (e vice-versa). Nova `app.stock_unit_cost_in(custo, unidade_estoque, unidade_receita, portion_qty, portion_unit)` — espelho de `stockItemCostIn()` no front. `create or replace` de `public.propagate_stock_item_cost()` (converte em vez de copiar `unit_cost`, dispara também em `portion_qty`/`portion_unit` e ganha o `SET search_path` que faltava) e de `public.recompute_all_costs(uuid)` (blocos 1 e 2; bloco 3 intocado). |

**Verificações pós-migration (CLAUDE.md §5) — feitas:**
- [x] Antes de aplicar, o `prosrc` em produção das 3 funções recriadas foi
      comparado com a versão-base de cada migration: `app.tg_supply_transfer_transition`
      era byte-a-byte a de `20260811120000` (md5 `1853ddf8…`, 10.709 bytes),
      `propagate_stock_item_cost` a de `20260510032658` e `recompute_all_costs` a de
      `20260527122400`. Nenhum patch manual foi sobrescrito.
- [x] `get_advisors` sem regressão: fora da regra nova `0029`, seguem só os 2 WARNs
      conhecidos (`pg_net` no schema public — limitação da extensão — e leaked
      password protection). A `0029_authenticated_security_definer_function_executable`
      é uma regra **nova** do linter que sinaliza todo RPC `SECURITY DEFINER` chamável
      por `authenticated`; ela lista RPCs pré-existentes e é exatamente o padrão do
      §5.1 (validação de `tenant_members.role` no corpo, que o linter não lê).
      `recompute_all_costs` e `supply_receive_transfer` já eram DEFINER antes.
- [x] `supply_divergence_lines` com `security_invoker=true`, `SELECT` para
      `authenticated`/`service_role` e `anon` revogado.
- [x] `supply_receive_transfer` existe **só** na assinatura de 3 args; ACL =
      `postgres`/`service_role`/`authenticated`, sem `PUBLIC` nem `anon`.
- [x] `has_schema_privilege('authenticated','app','USAGE')` = true e EXECUTE em
      `app.stock_unit_cost_in` = true (o trigger **não** é DEFINER — sem isso todo
      UPDATE de insumo no Estoque falharia com "permission denied for schema app").
- [x] O trigger `trg_propagate_stock_item_cost` é `AFTER UPDATE` **sem lista de
      colunas**, então o novo ramo de `portion_qty`/`portion_unit` realmente dispara
      (se fosse `UPDATE OF unit_cost` a mudança 2 da migration seria código morto).
- [x] Conversão conferida direto na função, com os números do smoke test:
      `stock_unit_cost_in(45,'un','kg',3,'kg')` = 15 → 0,2 kg = **R$ 3,00**; com o
      custo em R$ 60 → **R$ 4,00** (não R$ 12,00). Peso em gramas (3000 g) dá o mesmo.
      Sem peso, peso 0 ou par não conversível devolve o custo original (fallback seguro).

## 1. ✅ Migrations anteriores — todas em produção

Reconciliado em 2026-08-24, arquivo local × estrutura no banco. Nada pendente.

| Quando | Como | Arquivos |
|--------|------|----------|
| 2026-07-11/15 | SQL Editor | `20260711120000_production_module`, `20260711130000_supply_network`, `20260711140000_supply_transfers`, `20260711150000_production_exit_order_flow`, `20260712120000_transformed_into_production`, `20260713120000_production_allow_negative_stock` |
| 2026-08-09 | SQL Editor | `20260706120000_foody_ingest`, `20260706121000_logistics_rpcs_unified`, `20260809120000_production_cost_allocation_ref_value` |
| 2026-08-10/11 | MCP | `20260810120000_production_order_separation`, `20260810160000_production_input_weight_from_unit`, `20260810180000_supply_assortment`, `20260810120000_fix_production_cascade_delete`, `20260811120000_supply_direct_kitchen_per_item`, `20260811140000_production_enable_ref_value_allocation` |

Conferido no banco: as 6 tabelas de produção, `stock_items.item_kind/portion_qty/portion_unit`,
`tenants.kind/supply_code`, as 7 tabelas de suprimentos, `v_supply_balances`, os 7 RPCs
de rede, as colunas `ref_value` e a ausência do guard "Saldo insuficiente" na produção.

**Rateio por `ref_value`: LIGADO.** Essa pendência (arrastada desde 2026-08-09) foi
fechada pela `20260811140000_production_enable_ref_value_allocation`, que **embutiu** a
cascata valor → peso → quantidade dentro de `app.tg_production_order_transition()` e
dropou a `app.tg_production_apply_complete_alloc()`. Por isso a função separada não
existe mais no banco — não é sinal de pendência.

## 2. ✅ Edge functions — deployadas em 2026-08-10

| Função | Versão em prod | Mudança |
|--------|----------------|---------|
| `foody-admin` | v1 | CRUD de contas Foody, mapeamento de pontos de coleta → operações, discover, sync manual. |
| `foody-ingest` | v1 (`verify_jwt: false`) | Ingest de pedidos da Foody (espelho da `agilizone-ingest`); chamada pelo cron `foody-poll-5min` via pg_net. |
| `agilizone-admin` | v4 | Trava de exclusividade: `list-accounts` retorna `otherActive`; conta nova nasce **pausada** se Foody ativa (`lockedPaused`); `toggle-account` retorna 409 se Foody ativa. |
| `invite-member` | v11 | **Fix de segurança**: nunca resetar senha de usuário já existente (e-mail é global — reset permitiria tomar conta de outro tenant); apenas vincula membership e retorna `linkedExisting`/`passwordApplied`. |

- [x] `x-ingest-secret`: `foody_poll` lê `vault.decrypted_secrets` na linha
      `foody_ingest_secret` e a `foody-ingest` valida contra **a mesma** linha do
      Vault — não têm como divergir. Secret existe desde 2026-07-07.
- [x] O aviso "não cadastrar conta Foody antes do deploy" **caiu**: a `foody-ingest`
      está no ar. Hoje há 0 contas Foody, então o cron `foody-poll-5min` segue
      no-op pelo guard de "nenhuma conta ativa".

## 3. ⏳ Smoke tests pendentes

Precisam da UI e de tenants reais — não dá pra fechar por SQL.

**Ficha técnica em kg / g / un** (a matemática das três unidades já foi validada
direto na função — seções 0 e 0-bis; falta a UI):
- [ ] Insumo em "un" a R$ 45 com peso 3.000 g → na ficha escolher **kg** → 0,2 kg deve
      custar R$ 3,00. Mudar o custo para R$ 60 no Estoque → a linha vai para R$ 4,00.
      Rodar "Recalcular custos" em Fichas e conferir que não mexe.
- [ ] Insumo em "un" **sem** peso → escolher kg na ficha abre o modal com o SKU →
      informar 3000 g → conferir `stock_items.portion_qty` = 3 (grava em kg) e que a
      Produção passa a calcular aproveitamento desse insumo (mesmo campo).
- [ ] **Gramas:** mesma linha em `g` tem que dar o mesmo custo composto que em kg
      (200 g do Fermento a R$ 14,98/un com peso 200 g = R$ 14,98; 0,2 kg = idem).
      Insumo cadastrado em **kg** deve aceitar `g` **sem** pedir o peso da unidade
      (kg ↔ g não depende dele) — só `un` abre o modal.

**Divergência de recebimento:**
- [ ] Enviar 50 un a R$ 3,47 → no recebimento clicar **Relatar divergência**, informar
      46 un com motivo "Não veio" → confirmar. Conferir: movimento `in` de 46 (não 50);
      `received_value` = 159,62 e `divergence_value` = −13,88; `supply_ledger_entries`
      e as duas `finance_entries` (destinatário +159,62 / remetente −159,62) com o valor
      recebido; a linha na aba **Divergências** dos dois lados com o KPI de % batendo
      com |13,88| ÷ 173,50. Testar também um item com 0 recebido (não pode gerar
      movimento nem criar insumo novo no destino) e uma sobra.

**Cadeia de suprimentos / catálogo por unidade:**
- [ ] Cadastrar 1 item para uma unidade → nasce no estoque dela com saldo 0 e mín/máx
      travados no app da unidade; baixar o saldo abaixo do mínimo → aparece em
      Reposição com qtd = máx − atual.
- [ ] Guard: editar o mín pela unidade deve falhar com "mín/máx de X é gerido pela
      central"; movimentação de estoque (com auto ligado) segue recalculando normal.
- [ ] Direto na cozinha: receber transferência com 1 item marcado → 2 movimentos
      (`in` + `out` com `operation_id`) só naquele item, o outro só com `in`; o próximo
      recebimento do mesmo insumo vem pré-marcado com a mesma operação.

**Foody / Logística:**
- [ ] Configurações → Foody Delivery: cadastrar conta com token, mapear pontos,
      sincronizar; Logística carrega com dados unificados; trava de exclusividade nos
      dois sentidos; convite de e-mail já existente vincula sem trocar senha.
- [ ] Logística após a troca dos 5 RPCs para `delivery_orders_unified` (mesma
      assinatura, mas foi troca em produção).

**Produção — fluxo em 2 fases** (PRD §3.4 itens 1–2):
- [ ] Criar transformado "Calabresa porcionada 100g" (porção 100 g, mín/máx) → em
      Produzir hoje conferir a sugestão em lotes inteiros → **Solicitar insumos**
      (10 kg de calabresa) → a ordem aparece em Requisições como "🏭 Produção ·
      Pendente" → Separar → Confirmar entrega (só aqui o estoque baixa) → volta em
      Produção como "aguardando devolução" → devolução de 95 porções → conferir
      custo/porção (custo total ÷ 95), aproveitamento 95%, CMV do dia inalterado,
      transformado requisitável em Requisições e fora da lista de Compras.

**Rede** (PRD §3.4 itens 3–5, precisa de 3 tenants: central + A + B):
- [ ] Superadmin promove um tenant a "Central de distribuição"; central convida A e B
      pelo código; A e B aceitam no módulo Suprimentos.
- [ ] Central transfere 50 porções a A → A confirma → estoque de A +50 a R$3,00; gasto
      de A +R$150; finance: +150 "Compras · Rede de suprimentos" (A) e −150 "Repasses
      à rede (−)" (central); CMV dos dois inalterado.
- [ ] A envia 10 porções a B → B confirma → gastos A=120/B=30; soma = 150.
- [ ] B recebe transferência com "direto na cozinha" → CMV do dia de B sobe pelo valor;
      estoque de B não muda no líquido.
- [ ] Solicitação: A pede itens do catálogo da central → central aprova → "Atender"
      cria a transferência → recebida → solicitação vira "Atendida".
- [ ] DRE da central mostra o card "Repasses à rede no mês".

## 4. ⏳ Commits pendentes (git — só com pedido explícito)

O grosso do backlog já foi commitado (`36aeb5e`, `f068af2`, `dc2f344`). As edge
functions e todas as migrations até `20260811160000` **já estão versionadas**.

Falta commitar a árvore de trabalho atual:

- `supabase/migrations/20260824120000_recipe_unit_conversion.sql` (**novo, não rastreado**).
- `supabase/migrations/20260824160000_recipe_unit_cost_grams.sql` (**novo, não rastreado**) — `g` em `app.stock_unit_cost_in`.
- `lib-supabase.jsx` — `stockItemUnitWeightKg()` / `stockItemCostIn()` (expostos no
  window); `mapTechSheetFromDb` carrega `stockItemId` na linha (o modal de edição
  precisa dele quando a unidade da ficha difere da do estoque);
  `dbInsertTechSheetItem`/`dbInsertPreparationItem` aceitam `unitCost` explícito em vez
  de derivar de custo÷qtd (a conversão perderia casas decimais).
- `supabase/migrations/20260824180000_preparation_cost_unit_aware.sql` (**novo, não rastreado**) — propagação preparo → ficha por unidade.
- `page-recipes.jsx` — campo **Unidade** do modal de insumo vira seletor: kg/g/un para
  insumo do estoque, kg/g para preparo que rende em kg (preparo em "und" segue campo
  travado, porque não há peso de uma "unidade" de preparo); `StockWeightModal` pede o
  peso por unidade (mostrando SKU, categoria, custo, saldo e fornecedor) quando ele
  ainda não existe e grava em `stock_items.portion_qty`. Correções de layout: modal de
  nova ficha 480→560 e modal de insumo 520→560, grids com `minmax(0,…)` (input de texto
  tem min-width intrínseco e vazava o card — era o toggle kg/und cortado) e custo
  unitário formatado com `_ucText` (vinha `13,521739130434783` cru do preparo).
- `page-mobile-recipes.jsx` — espelho: campo "Unidade na ficha" + `StockWeightSheet`.
- `page-stock.jsx` / `page-mobile-stock.jsx`, `page-production.jsx` /
  `page-mobile-production.jsx`, `page-supply.jsx` / `page-mobile-distribution.jsx`,
  `page-distribution.jsx`, `page-dre.jsx`, `page-settings.jsx`, `page-transformed.jsx`,
  `mobile-ui.jsx` — ajustes do mesmo lote.
- `DEPLOY-PENDING.md`, `PLANO-MOBILE.md`.

Mensagem sugerida: `Ficha técnica: insumo em "un" pode ser medido em kg (e vice-versa)`.

Não versionados — decidir antes do commit:
- `.claude/skills/` (skills oficiais Supabase instaladas em 2026-07-11) — pode commitar
  se quisermos compartilhar.
- `.claude/settings.local.json` — **não commitar** (config local); considerar adicionar
  ao `.gitignore`.
