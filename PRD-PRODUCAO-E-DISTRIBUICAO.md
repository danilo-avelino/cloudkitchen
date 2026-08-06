# PRD — Produção/Porcionamento, Transformados e Central de Distribuição

> Spec de implementação. Escrito em 2026-07-11; decisões da seção 12 confirmadas pelo usuário em 2026-07-11.
> Convenções seguem o CLAUDE.md (seções 5.x de segurança Supabase, guard de duplo-clique em botões, etc.).

---

## 1. Sumário executivo

Clientes maiores operam com **central de produção/distribuição**: um local que compra,
estoca e produz, e depois distribui insumos brutos ou porcionados para as cozinhas
(outros tenants do sistema). Este PRD cobre 4 módulos novos + 1 tipo novo de tenant:

| # | Módulo (id) | Slug hash | Quem vê | O que faz |
|---|-------------|-----------|---------|-----------|
| F1 | Produção (`production`) | `#/producao` | Qualquer tenant | Ordens de produção/porcionamento: sai insumo bruto, volta transformado porcionado, custo convertido (sem CMV) |
| F2 | Transformados (`transformed`) | `#/transformados` | Qualquer tenant | Catálogo + análises dos itens transformados: custo, aproveitamento %, desperdício, consumo por tenant |
| F3 | Central (`distribution`) | `#/central` | Só tenant tipo `distribution_center` | Rede de suprimentos: convidar tenants por código, transferências de saída, solicitações recebidas, painel de Gastos por tenant |
| F4 | Suprimentos (`supply`) | `#/suprimentos` | Tenants membros de uma rede | Solicitar da central (aba 1), pedir/enviar entre tenants (aba 2), confirmar recebimentos (com opção "direto na cozinha"), extrato de gastos |

Tipo novo de tenant: `tenants.kind = 'distribution_center'` (default `'standard'`).
Cada tenant ganha um **código numérico único** (`tenants.supply_code`, 8 dígitos) exibido
em Configurações — é com ele que a central convida o tenant para a rede.

---

## 2. Glossário

- **Transformado**: item produzido internamente a partir de insumos brutos (ex.: "Calabresa porcionada 100g"). Vive em `stock_items` com `item_kind='transformed'` — assim participa de requisições, inventário, snapshots e movimentações sem código novo.
- **Ordem de produção**: documento que registra a saída dos insumos brutos para a cozinha de produção e o retorno em porções transformadas.
- **Rede de suprimentos**: o conjunto {central + tenants membros}. A central **é** a rede (1 rede por tenant central; um tenant pode ser membro de mais de uma rede).
- **Transferência**: envio de itens (brutos ou transformados) central→tenant ou tenant→tenant, com confirmação de recebimento pelo destinatário.
- **Gastos**: saldo por tenant, mantido pela central, do valor de mercadorias recebidas da rede. Transferência da central aumenta o gasto do destinatário; transferência entre tenants move gasto do remetente para o destinatário.

---

## 3. Decisões arquiteturais globais

### 3.1 Transformados são `stock_items`

Nova coluna `stock_items.item_kind text not null default 'raw' check (item_kind in ('raw','transformed'))`
+ `portion_qty numeric(14,4)` / `portion_unit text` (ex.: `0.100` / `'kg'` = porção de 100g;
usados para calcular aproveitamento % e converter peso↔porções).

Por quê: requisições, inventário, snapshot EI/EF, auto min/max e CMV já funcionam sobre
`stock_items` — o transformado herda tudo de graça. O que muda é só a origem do saldo
(produção/transferência em vez de compra).

**Efeitos colaterais a tratar (lacunas do pedido original):**
- Compras: itens `item_kind='transformed'` **não aparecem** em sugestões de compra nem no fluxo de recebimento de NF (são produzidos, não comprados). Filtro no front (page-purchases / page-shopping).
- O custo do transformado é sobrescrito a cada ordem de produção concluída (mesma filosofia do "última compra" — decisão de 2026-05-26).

### 3.2 Novos `reference_type` em `stock_movements` (enum `kind` não muda)

Movimentações continuam imutáveis e com os kinds atuais. A semântica nova vai no
`reference_type`:

| reference_type | kind | Conta no CMV? | Uso |
|---|---|---|---|
| `production_order` | `out` (insumos) / `in` (transformado) | **Não** | Ordem de produção (conversão de valor, não consumo) |
| `supply_transfer` | `out` (remetente) / `in` (destinatário) | **Não** | Transferência entre tenants da rede |
| `supply_transfer_kitchen` | `out` (destinatário) | **Sim** | Saída imediata quando o recebimento é "direto na cozinha" |

**Mudança obrigatória no cálculo de CMV do front** (`page-cmv.jsx`, `buildItemRows`,
`excludedImpact`, heatmap diário e semanal): além do filtro atual
(`kind ∈ {out,loss,expiration}` + `composeCmv !== false`), **excluir**
`referenceType ∈ {'production_order','supply_transfer'}`. `supply_transfer_kitchen`
continua entrando (é exatamente o propósito dele). O `referenceType` já é exposto por
`dbListStockMovements` (lib-supabase.jsx:676), então é só filtrar.

Auditar também: page-dashboard (cards de CMV), page-stock (extrato de movimentações — exibir
rótulos amigáveis "Produção", "Transferência", "Transferência · cozinha").

### 3.3 Coerência contábil (DRE `CMV real = EI + Compras − EF`)

Este é o ponto mais fácil de quebrar sem perceber. Regra por fluxo:

- **Produção**: neutra em valor. Sai R$300 de bruto, entra R$300 de porções → EF não muda, nenhum lançamento no financeiro, nenhum CMV. ✔ nada a fazer.
- **Transferência (qualquer direção)**: muda o EF dos dois lados sem compra/venda. Para o `CMV real` não distorcer, cada confirmação de recebimento gera **lançamentos automáticos em `finance_entries`** (grupo `cmv`), em subcategorias autofeed novas:
  - Destinatário: `+valor` em **"Compras · Rede de suprimentos"**.
  - Remetente: `−valor` em **"Repasses à rede (−)"**.
  - Assim: central compra R$300 (Compras +300), repassa R$150 → Compras líquidas da central = 150 e EF caiu 150 → CMV real dela mede só o que ELA consumiu. O destinatário fica com Compras +150 e EF +150 → CMV real zero até consumir. ✔
  - Essas subcategorias seguem o padrão autofeed existente (lançamento manual nelas é ignorado pela DRE, como já acontece com as subs de faturamento).
- **Direto na cozinha**: o `in`+`out` se anulam no EF; o lançamento de Compras entra normal e o `out` conta no CMV do dia. ✔

### 3.4 Exemplo numérico canônico (usar nos testes)

1. Central compra 10 kg de calabresa a R$30/kg → Compras R$300, estoque +R$300.
2. Ordem de produção: saem 10 kg (−R$300), cozinha devolve 100 porções de 100 g → entra "Calabresa porcionada 100g" 100 un a **R$3,00/un** (300 ÷ 100). CMV do dia: R$0. Aproveitamento: 100 × 0,100 kg ÷ 10 kg = **100%**.
   - Variante: devolve só 95 porções → custo unitário = 300 ÷ 95 = **R$3,1579**; aproveitamento 95%; desperdício 0,5 kg (R$15) fica **absorvido no custo da porção** (não gera movimento `loss` — o valor já saiu na conversão; um `loss` duplicaria custo).
3. Central transfere 50 porções ao Tenant A → central: `out` 50×3,00 (sem CMV) + finance −R$150; A confirma: `in` 50 un a R$3,00 + finance +R$150; **gasto de A: +R$150**.
4. A transfere 10 porções ao B; B confirma → A: `out` R$30 sem CMV, finance −30, **gasto −30**; B: `in` R$30, finance +30, **gasto +30**. Saldos: A=120, B=30 (soma = 150 = o que saiu da central). ✔
5. B confirma outro recebimento com "direto na cozinha" → `in` + `out` imediato com `reference_type='supply_transfer_kitchen'` → entra no CMV do dia de B.

---

## 4. F1 — Módulo Produção & Porcionamento (`production`)

Módulo próprio (fora do Estoque), navegação own na sidebar.

### 4.1 Fluxo / máquina de estados

```
draft ──(Enviar à produção)──► issued ──(Lançar retorno)──► completed
  │                              │
  └─► cancelled (livre)          └─► cancelled (gera movimentos inversos `in` dos insumos)
```

> **Revisão 2026-07-11 (pedido do usuário):** a ordem virou **ordem de saída** —
> na criação ela leva SÓ os insumos que a produção retira do estoque. Os
> transformados devolvidos são informados apenas na **devolução** (não são
> pré-definidos). Entre a saída e a devolução a ordem fica em `issued`
> ("aguardando devolução") — etapa crítica de desvio, com alerta de tempo de
> espera (badge por ordem: ok <4h, warn ≥4h, crit ≥12h; banner na página com a
> mais antiga; badge no menu lateral com a contagem).

- **draft**: monta a **ordem de saída** — lista de insumos brutos com quantidades (multi-saída continua suportada, mas os transformados só aparecem na devolução). Pode salvar rascunho.
- **issued** ("Aguardando devolução"): gera `stock_movements` `out` para cada insumo (`reference_type='production_order'`, `unit_cost` = snapshot do custo atual do item). **Sem guard de saldo** (decisão 2026-07-13): a produção retira mesmo com estoque zerado e o `current_qty` fica negativo — o front avisa quais insumos ficarão negativos e a regularização é a entrada da compra (os negativos aparecem em Estoque → Pendências de lançamento). A ordem fica visível com o tempo de espera até a devolução.
- **completed** ("Devolução lançada"): ao clicar na ordem, o usuário informa **quais transformados** voltaram e `returned_qty` de cada um (as linhas de saída são criadas neste momento). Sistema:
  1. `total_input_cost = Σ (qty × unit_cost dos inputs)` (snapshot do issue).
  2. Rateio por peso: `peso_i = returned_qty_i × portion_qty_i`; `cost_share_i = total_input_cost × peso_i / Σ peso`. Com 1 saída só, o rateio é trivial (100%) e `portion_qty` é dispensável. Com 2+ saídas, **todos** os transformados da ordem precisam ter `portion_qty` definido (validado no issue).
  3. `unit_cost_i = cost_share_i / returned_qty_i` (arredonda 4 casas).
  4. Gera `in` de cada transformado (`reference_type='production_order'`) — o trigger existente `tg_apply_stock_movement` já sobrescreve `stock_items.unit_cost` pelo custo do `in`. ✔
  5. Calcula e grava `yield_pct` e `waste_qty` agregados (ver 4.3).
- **cancelled** a partir de `issued`: movimentos são imutáveis → gerar movimentos **inversos** (`in` espelho de cada `out`), padrão já usado no "Voltar" da separação. Ordem `completed` não cancela (corrigir = nova ordem/ajuste).

Transições via **update de status + trigger** (`tg_production_apply_issue/complete/cancel`), espelhando o padrão existente de `kitchen_requests` (status `separated`/`delivered` disparam a baixa). O front grava `returned_qty` nas saídas antes de flipar o status para `completed`.

### 4.2 Schema

```sql
create table public.production_orders (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  code            text,                                   -- 'PRD-0001' (sequência por tenant, como REQ)
  status          text not null default 'draft'
                    check (status in ('draft','issued','completed','cancelled')),
  total_input_cost numeric(14,4),                         -- snapshot no issue (Σ line_cost)
  input_weight    numeric(14,4),                          -- Σ qty dos inputs em kg (quando conversível)
  output_weight   numeric(14,4),                          -- Σ returned_qty × portion_qty
  yield_pct       numeric(6,2),                           -- aproveitamento % agregado
  waste_qty       numeric(14,4),                          -- desperdício em kg (entrada − saída)
  notes           text,
  created_by      uuid references auth.users(id) on delete set null,
  issued_at       timestamptz, issued_by uuid references auth.users(id) on delete set null,
  completed_at    timestamptz, completed_by uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, code)
);

create table public.production_order_inputs (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.production_orders(id) on delete cascade,
  stock_item_id uuid not null references public.stock_items(id),
  qty           numeric(14,4) not null check (qty > 0),
  unit          text not null,
  unit_cost     numeric(12,4) not null default 0,          -- snapshot no issue
  line_cost     numeric(14,4) generated always as (qty * unit_cost) stored,
  sort_order    int not null default 0
);

-- Saídas (multi-saída no v1 — decisão do usuário 2026-07-11)
create table public.production_order_outputs (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.production_orders(id) on delete cascade,
  stock_item_id uuid not null references public.stock_items(id),  -- item_kind='transformed' (trigger valida)
  expected_qty  numeric(14,4),                            -- porções esperadas (informativo)
  returned_qty  numeric(14,4),                            -- porções devolvidas (antes do complete)
  weight_qty    numeric(14,4),                            -- returned_qty × portion_qty (snapshot no complete)
  cost_share    numeric(14,4),                            -- custo rateado por peso (snapshot no complete)
  unit_cost     numeric(12,4),                            -- cost_share / returned_qty
  sort_order    int not null default 0
);
```

Triggers de coerência de tenant (mesmo padrão de `kitchen_request_items`).
RLS: select `app.is_tenant_member(tenant_id)`; write `app.can_access_module(tenant_id,'production')`.
Depois de `issued`, linhas de input ficam read-only (trigger bloqueia update/delete).

### 4.3 Aproveitamento e desperdício

- Peso de saída = `Σ returned_qty_i × portion_qty_i` das saídas (se `portion_qty` nulo em ordem de saída única, aproveitamento fica "—").
- Peso de entrada = Σ qty dos inputs cuja `unit` é compatível com `portion_unit` (v1: comparação direta de unidade; kg+kg, g convertido pra kg).
- `yield_pct = peso_saida / peso_entrada × 100`; `waste_qty = peso_entrada − peso_saida` (nunca negativo — se devolver mais que entrou, yield >100% e waste 0, com aviso no UI).
- Desperdício é **absorvido no custo** (decisão do produto, ver 3.4) e vira métrica no módulo Transformados.

### 4.4 UI

- Lista de ordens (filtros: status, período, transformado) com badges de status.
- Nova ordem: seletor de transformado → pré-preenche insumos a partir da **receita de produção** (ver F2) se existir; senão adiciona manualmente (busca em stock_items brutos).
- Tela da ordem: inputs, custo total corrente, porções esperadas vs devolvidas, botão por estado ("Enviar à produção", "Lançar retorno", "Cancelar") — todos com guard de duplo-clique + "Carregando…" (CLAUDE.md §7).
- Inputs numéricos aceitam vírgula (`_parseBR` — bug conhecido do `Number("8,50")`).

---

## 5. F2 — Módulo Transformados (`transformed`)

Catálogo + inteligência dos itens transformados. Não confundir com `preparations`
(fichas técnicas de preparo, custo teórico de receita) — transformados são estoque real.

### 5.1 Abas

1. **Catálogo**: CRUD do transformado. Criar aqui = criar `stock_items` com `item_kind='transformed'` + `portion_qty`/`portion_unit` + categoria. Mostra: custo atual da porção, estoque atual, última produção, aproveitamento médio (30d).
2. **Receitas de produção**: templates de lote (ex.: "Desossa de frango": 10 kg frango inteiro → 40 porções peito + 30 coxa + 20 asa). Tabelas `production_recipes(tenant_id, name)` + `production_recipe_inputs(recipe_id, stock_item_id, qty, unit)` + `production_recipe_outputs(recipe_id, stock_item_id, expected_qty)`. Servem só de template para pré-preencher ordens (F1) — sem efeito contábil.
3. **Análises**: por transformado e por período —
   - evolução do custo da porção (por ordem concluída);
   - aproveitamento % por ordem + média;
   - desperdício acumulado (kg e R$ = waste × custo médio do insumo);
   - produção total (porções) vs consumo (movimentos `out` de CMV do item).
4. **Consumo por tenant** (visível só quando o tenant é central `distribution_center`): quanto de cada transformado foi transferido para cada tenant da rede no período (fonte: `supply_transfer_items` recebidos). Tabela + ranking.

Fonte de dados das análises: `production_orders` concluídas (paginar com `.range()` — lembrar do cap de 1000 linhas do PostgREST).

---

## 6. F3 — Central de Distribuição (`distribution`) e a rede

### 6.1 Tipo de tenant + código único

```sql
alter table public.tenants
  add column kind text not null default 'standard'
    check (kind in ('standard','distribution_center')),
  add column supply_code text unique;   -- 8 dígitos numéricos, ex.: '48291035'
```

- **Backfill**: migration gera `supply_code` para todos os tenants existentes (loop com retry em colisão); trigger `before insert` gera para novos. Formato de exibição: `4829 1035`.
- Código exibido em **Configurações → Conta** de todo tenant (com botão copiar) e no empty-state do módulo Suprimentos.
- Central é criada/promovida pelo **superadmin** (page-superadmin + `provision-tenant`): campo "Tipo de tenant". Promover tenant existente a central é permitido; rebaixar só se a rede estiver vazia.
- Sem lookup público de código → RPC `supply_lookup_tenant_by_code(p_code)` SECURITY DEFINER que retorna **apenas** `{id, name}` (não vaza dados do tenant), chamável só por owner/admin/manager de um tenant `distribution_center`.

### 6.2 Rede: membros e convites (consentimento mútuo)

```sql
create table public.supply_members (
  central_tenant_id uuid not null references public.tenants(id) on delete cascade,
  member_tenant_id  uuid not null references public.tenants(id) on delete cascade,
  status            text not null default 'invited'
                      check (status in ('invited','active','rejected','removed','left')),
  invited_by        uuid references auth.users(id) on delete set null,
  invited_at        timestamptz not null default now(),
  responded_at      timestamptz,
  primary key (central_tenant_id, member_tenant_id),
  check (central_tenant_id <> member_tenant_id)
);
```

Fluxo: central digita o código → `supply_invite_tenant(p_code)` cria `invited` →
o tenant convidado vê banner em Suprimentos/Configurações ("A central X convidou você")
→ `supply_respond_invite(p_central, p_accept)` (owner/admin do convidado) → `active`
ou `rejected`. Central pode `removed`; membro pode `left`. Reconvite após
rejected/removed/left = update para `invited` de novo.

Um tenant pode ser membro de várias redes (PK composta permite). UI v1: se >1 rede
ativa, seletor de central no topo do módulo Suprimentos.

### 6.3 Gastos (ledger)

```sql
create table public.supply_ledger_entries (
  id                uuid primary key default gen_random_uuid(),
  central_tenant_id uuid not null references public.tenants(id) on delete cascade,
  tenant_id         uuid not null references public.tenants(id) on delete cascade, -- de quem é o saldo
  delta             numeric(14,4) not null,        -- + aumenta gasto, − reduz
  kind              text not null check (kind in ('transfer_in','transfer_out','adjustment')),
  transfer_id       uuid references public.supply_transfers(id) on delete set null,
  notes             text,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now()
);
```

- Saldo do tenant = `Σ delta` (view `v_supply_balances` com `security_invoker=true`).
- Lançado **exclusivamente** pelos RPCs de confirmação de transferência (+ `adjustment` manual da central, para acertos/pagamentos — ex.: tenant pagou a central → central lança ajuste negativo).
- Imutável (trigger bloqueia update/delete, corrigir = novo `adjustment`).

### 6.4 Abas do módulo Central

1. **Rede**: membros ativos (nome, código, gasto acumulado no período, última transferência), convites pendentes, campo "Convidar por código".
2. **Transferências**: criar/enviar (ver F4) + histórico de enviadas com status.
3. **Solicitações**: pedidos recebidos dos tenants (ver F5) — aprovar/rejeitar/atender (atender = gera transferência pré-preenchida).
4. **Gastos**: painel por tenant (saldo atual, extrato com filtro de período, botão "Ajuste manual" com modal e confirmação).

---

## 7. F4 — Transferências

### 7.1 Máquina de estados

```
draft ──(Enviar)──► sent ──(destinatário: Confirmar recebimento)──► received
  │                   │
  └─► cancelled       └─► cancelled (só pelo remetente, antes do received;
                           gera movimentos inversos `in` no remetente)
```

- Remetente = central **ou** tenant membro (transferência entre tenants usa a mesma tabela; o que muda são os lançamentos no ledger).
- Destinatário precisa ser membro `active` da mesma rede (ou a própria central — devolução à central é permitida e lança gasto negativo pro remetente).

### 7.2 Schema

```sql
create table public.supply_transfers (
  id                uuid primary key default gen_random_uuid(),
  central_tenant_id uuid not null references public.tenants(id),   -- a rede
  from_tenant_id    uuid not null references public.tenants(id),
  to_tenant_id      uuid not null references public.tenants(id),
  code              text,                                          -- 'TRF-0001' por rede
  status            text not null default 'draft'
                      check (status in ('draft','sent','received','cancelled')),
  request_id        uuid references public.supply_requests(id) on delete set null,
  direct_to_kitchen boolean not null default false,                -- default sugerido; confirmável no recebimento
  total_value       numeric(14,4),                                 -- snapshot no sent
  notes             text,
  sent_at timestamptz,     sent_by uuid references auth.users(id) on delete set null,
  received_at timestamptz, received_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_tenant_id <> to_tenant_id)
);

create table public.supply_transfer_items (
  id              uuid primary key default gen_random_uuid(),
  transfer_id     uuid not null references public.supply_transfers(id) on delete cascade,
  from_item_id    uuid references public.stock_items(id) on delete set null, -- item do remetente
  to_item_id      uuid references public.stock_items(id) on delete set null, -- resolvido no recebimento
  display_name    text not null,               -- snapshot
  item_kind       text not null default 'raw', -- snapshot (raw|transformed)
  qty             numeric(14,4) not null check (qty > 0),
  unit            text not null,
  unit_cost       numeric(12,4) not null default 0,  -- snapshot do custo do remetente no sent
  portion_qty     numeric(14,4),                -- snapshot p/ criar o item no destino
  portion_unit    text,
  sort_order      int not null default 0
);
```

### 7.3 Efeitos de cada transição (RPCs atômicos)

**`supply_transfer_send(p_transfer_id)`** (papel do módulo no tenant remetente):
- Valida rede/status/saldo (guard: `current_qty >= qty` por item; bloqueia envio a descoberto).
- Snapshot de `unit_cost` (custo atual do remetente = última compra/produção) e `total_value`.
- Gera `out` no remetente por item: `reference_type='supply_transfer'`, `reference_id=transfer_id` → **não** conta no CMV do remetente (3.2).
- Status → `sent`. Itens ficam imutáveis.

**`supply_transfer_receive(p_transfer_id, p_direct_to_kitchen, p_operation_id)`** (papel do módulo no tenant destinatário):
- Valida que o chamador é membro do `to_tenant_id` com acesso ao módulo `supply`, status `sent`, idempotência (status-check dentro do RPC + guard de duplo-clique no botão).
- **Mapeamento de itens** (lacuna preenchida — ver 7.4): resolve/cria o `stock_item` correspondente no destinatário e grava `to_item_id`.
- Gera `in` no destinatário por item (`reference_type='supply_transfer'`, `unit_cost` = o do snapshot → o trigger existente sobrescreve o custo do item no destino ✔).
- Se `p_direct_to_kitchen`: gera também `out` imediato de cada item (`reference_type='supply_transfer_kitchen'`, `operation_id = p_operation_id` — obrigatório nesse caso; se o tenant tem 1 operação só, pré-seleciona) → conta no CMV.
- **Ledger** (3 casos):
  - central → tenant: `+valor` para o tenant (`transfer_in`).
  - tenant → tenant: `−valor` para o remetente (`transfer_out`) e `+valor` para o destinatário (`transfer_in`).
  - tenant → central (devolução): `−valor` para o remetente.
- **Financeiro** (3.3): `finance_entries` autofeed — `+valor` "Compras · Rede de suprimentos" no destinatário; `−valor` "Repasses à rede (−)" no remetente. Competência = data do recebimento.
- Status → `received`. Recebimento é **integral** no v1 (all-or-nothing; divergência vai em `notes` e se resolve com transferência inversa ou ajuste de inventário — parcial fica pro v2).

**`supply_transfer_cancel(p_transfer_id)`**: de `draft` → só status; de `sent` → gera `in` inversos no remetente. `received` não cancela (fazer transferência inversa).

### 7.4 Mapeamento de itens entre tenants (lacuna preenchida)

`stock_items` são por tenant — o "Calabresa porcionada 100g" da central não existe no
tenant A até a primeira transferência. Resolução no recebimento, nesta ordem:

1. Link já memorizado: `supply_item_links (central_tenant_id, from_item_id, to_tenant_id, to_item_id, pk(...))`.
2. Match por nome normalizado + unidade no estoque do destinatário (case/acentos-insensitive) → cria o link.
3. Não achou → **cria** o item no destinatário (nome, unidade, categoria por nome — cria categoria se preciso —, `item_kind`, `portion_qty/unit` do snapshot, `unit_cost` do snapshot) e grava o link.

UI de recebimento mostra o "de → para" por linha e permite trocar o item de destino
antes de confirmar (atualiza o link).

---

## 8. F5 — Solicitações (dentro de Suprimentos e Central)

### 8.1 Schema

```sql
create table public.supply_requests (
  id                 uuid primary key default gen_random_uuid(),
  central_tenant_id  uuid not null references public.tenants(id),
  requester_tenant_id uuid not null references public.tenants(id),
  supplier_tenant_id uuid not null references public.tenants(id),  -- central OU outro tenant
  code               text,                                         -- 'SOL-0001' por rede
  status             text not null default 'pending'
                       check (status in ('pending','approved','rejected','cancelled','fulfilled')),
  notes              text, rejection_reason text,
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  responded_at timestamptz, responded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.supply_request_items (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references public.supply_requests(id) on delete cascade,
  supplier_item_id uuid references public.stock_items(id) on delete set null, -- item do FORNECEDOR
  display_name  text not null,
  qty           numeric(14,4) not null check (qty > 0),
  unit          text not null,
  sort_order    int not null default 0
);
```

O solicitante escolhe itens do **catálogo do fornecedor** — precisa enxergar nome/unidade/
código dos itens de outro tenant. RPC read-only `supply_list_catalog(p_supplier_tenant)`
SECURITY DEFINER: valida que solicitante e fornecedor estão na mesma rede `active` e
retorna só `{id, name, unit, item_kind, category_name}` (**sem** custo nem saldo — preço
é da alçada do fornecedor).

### 8.2 Fluxo

```
pending ──(fornecedor aprova)──► approved ──(fornecedor atende: cria transferência)──► fulfilled
   │                                │                 (transfer.request_id = esta solicitação;
   ├─► rejected (motivo)            └─► cancelled       fulfilled quando a transfer é received)
   └─► cancelled (solicitante, antes de approved)
```

"Atender" abre a transferência pré-preenchida com os itens/qtys (fornecedor pode ajustar).

### 8.3 UI — módulo Suprimentos (tenant membro)

1. **Solicitar da central**: catálogo da central, carrinho, enviar. Histórico com status.
2. **Entre tenants**: mesma tela, mas escolhe outro tenant membro como fornecedor. Também lista solicitações **recebidas** de outros tenants (aprovar/atender — aqui o tenant age como fornecedor).
3. **Recebimentos**: transferências `sent` aguardando confirmação → tela de confirmação (mapeamento de itens, toggle "Entregar direto na cozinha" + seletor de operação, botão Confirmar com guard).
4. **Gastos**: saldo atual do tenant na rede + extrato (somente leitura).

Badges na sidebar (padrão `pendingReq` existente): nº de recebimentos aguardando
confirmação (Suprimentos) e nº de solicitações pendentes (Central).

---

## 9. Segurança (obrigatório — CLAUDE.md §5)

- **Todas as tabelas novas**: RLS habilitado.
  - `production_*`: select `is_tenant_member`; write `can_access_module(tenant_id,'production')` (recipes do F2 idem com `'transformed'`).
  - `supply_members`, `supply_transfers`, `supply_transfer_items`, `supply_requests`, `supply_request_items`, `supply_ledger_entries`, `supply_item_links`: **SELECT** para membros de qualquer tenant envolvido na linha (`is_tenant_member(from) OR is_tenant_member(to)`; ledger: membro do `tenant_id` OU do `central_tenant_id`); **INSERT/UPDATE/DELETE revogados** — toda escrita via RPC (transições de estado precisam ser atômicas com movimentos+ledger+finance).
- **RPCs SECURITY DEFINER** (`supply_*`, `production_*`): na ordem — (1) `auth.uid() is null` → raise; (2) validar papel via `tenant_members`/`can_access_module` para o tenant que o chamador representa na operação; (3) validar estado da rede (`supply_members.status='active'`) e da entidade; (4) `SET search_path = 'app','public','pg_temp'`.
- Views novas (`v_supply_balances`, análises): `WITH (security_invoker = true)` + revoke anon.
- GRANTs: boilerplate das seções 5.2 (schema `app`) e 5.3 (`service_role` em `public`) em toda migration.
- Rodar `mcp__supabase__get_advisors` após cada migration e confirmar sem regressão.
- Nenhuma edge function nova é necessária no v1 (tudo é RPC autenticado). `provision-tenant` ganha o parâmetro `kind`.

---

## 10. Front-end — integração com o shell

Checklist do que muda fora dos módulos novos (lacunas fáceis de esquecer):

1. `shell.jsx` — `APP_MODULES`: adicionar `"production","transformed","supply","distribution"`; presets `ROLE_DEFAULT_MODULES`: kitchen += production; stock += production, supply; (distribution só via owner/admin ou modules custom).
2. `page-settings.jsx` — `USER_MODULES` (labels: Produção, Transformados, Suprimentos, Central) e `ROLE_MODULE_PRESETS` espelhados.
3. **SQL** `app.role_default_modules(...)` — espelhar os mesmos presets (3 lugares para sincronizar; anotar nos três).
4. `src/App.jsx` — `PAGE_SLUGS`: `production:"producao"`, `transformed:"transformados"`, `supply:"suprimentos"`, `distribution:"central"` + render das páginas.
5. **Visibilidade condicional além do módulo** (no Sidebar): `distribution` só aparece se `tenant.kind==='distribution_center'`; `supply` só se o tenant tem membership `active` **ou** convite `invited` (o aceite mora lá). O contexto (`dbGetCurrentContext`) passa a carregar `kind`, `supply_code` e memberships.
6. Novos arquivos `page-production.jsx`, `page-transformed.jsx`, `page-supply.jsx`, `page-distribution.jsx` — registrar via `window.X` + import dinâmico em `src/main.jsx` (leitura lazy; nada de identificador solto cross-arquivo), **sem `...rest`** (colisão `_excluded` do Babel standalone).
7. `lib-supabase.jsx` — funções `db*` novas (listas paginadas com `.range()` por causa do cap de 1000 do PostgREST) + mapeamentos row→front.
8. `page-cmv.jsx` (+ dashboard) — exclusões por `referenceType` (3.2). **Fazer junto com a primeira migration** para não sujar o CMV no meio do caminho.
9. `page-purchases.jsx` / `page-shopping.jsx` — esconder `item_kind='transformed'` de sugestões/recebimento.
10. Todos os botões novos: guard de duplo-clique + estado "Carregando…" (CLAUDE.md §7); inputs numéricos com `_parseBR`.

---

## 11. Lacunas do pedido original preenchidas nesta spec

O pedido não cobria (e sem isso não funciona) — defaults escolhidos:

| Lacuna | Decisão nesta spec |
|---|---|
| Identidade de itens entre tenants | Auto-criação + `supply_item_links` com override manual no recebimento (7.4) |
| Valoração da transferência | Snapshot do custo do remetente no envio (coerente com "última compra") |
| Consentimento do convite | Convidado precisa aceitar (`supply_respond_invite`) — central não anexa tenant sozinha |
| Impacto na DRE/CMV real | Lançamentos autofeed em `finance_entries` (+Compras no destino, −Repasse na origem) (3.3) |
| Desperdício da produção no custo | Absorvido no custo da porção; sem movimento `loss` (evita custo em dobro) (3.4) |
| Recebimento parcial/divergente | v1 é integral (all-or-nothing) com notas; parcial fica pro v2 |
| Cancelamentos com movimentos imutáveis | Sempre via movimentos inversos (padrão existente do "Voltar") |
| Operação do CMV no "direto na cozinha" | Destinatário escolhe a operação na confirmação (obrigatório; pré-seleciona se só há 1) |
| Devolução à central / pagamento de gastos | Devolução = transferência tenant→central (gasto −); pagamento = `adjustment` manual da central |
| Múltiplas redes por tenant | Modelo suporta; UI v1 com seletor de central quando >1 |
| Transformados no fluxo de Compras | Filtrados (não se compra o que se produz) |
| Código do tenant | Gerado p/ todos (backfill + trigger), exibido em Configurações, lookup só via RPC restrito |
| Quem confirma recebimento | Quem tem o módulo `supply` no tenant destinatário (política "quem vê, edita") |
| Solicitante ver catálogo do fornecedor | RPC read-only sem custo/saldo (8.1) |

## 12. Decisões confirmadas pelo usuário (2026-07-11)

1. **Preço de repasse**: transferências saem **a custo** (sem markup). O gasto do tenant = custo do item na central.
2. **Produção multi-saída**: **SIM no v1** — 1 ordem pode devolver 2+ transformados; custo rateado por peso (`returned_qty × portion_qty`); com 2+ saídas, `portion_qty` é obrigatório em todos os transformados da ordem.
3. **Transferência entre tenants**: **qualquer membro ativo** da rede pode transferir para qualquer outro membro.
4. **DRE da central**: **SIM** — criar visão de "faturamento interno" na DRE quando `tenant.kind='distribution_center'`: card/linha gerencial "Repasses à rede no mês" (fonte: lançamentos autofeed "Repasses à rede (−)" em valor absoluto — não é receita contábil, só visão). Implementar na Fase D.

---

## 13. Plano de implementação (fases com verificação)

Cada fase termina com advisors limpos e o critério verificado. Migrations com os GRANTs §5.2/5.3.

**Fase A — Fundações de estoque/produção**
1. Migration: `stock_items.item_kind/portion_qty/portion_unit`; tabelas `production_orders/_inputs`, `production_recipes/_items`; RPCs `production_issue/complete/cancel`; RLS.
   → verificar: exemplo canônico 3.4 itens 1–2 via SQL (custos, yield, saldo, CMV do dia = 0).
2. Front: exclusões de CMV por `referenceType` (**junto com a 1ª migration**); módulos `production` + `transformed` (páginas, slugs, presets, filtro em compras).
   → verificar: criar ordem no app, enviar, lançar retorno de 95/100; custo R$3,1579, aproveitamento 95%, CMV inalterado, transformado requisitável em Requisições.

**Fase B — Rede**
3. Migration: `tenants.kind/supply_code` (+backfill/trigger), `supply_members`, RPCs de código/convite/resposta; `provision-tenant` com `kind`.
   → verificar: código visível em Configurações; convite por código; aceite; visibilidade condicional dos módulos `distribution`/`supply`.

**Fase C — Transferências + Gastos + Solicitações**
4. Migration: `supply_transfers/_items`, `supply_item_links`, `supply_ledger_entries` (+view saldos), `supply_requests/_items`, subcategorias autofeed no financeiro, RPCs `send/receive/cancel`, `supply_list_catalog`, ajustes de ledger.
   → verificar: exemplo canônico 3.4 itens 3–5 ponta a ponta (saldos A=120/B=30, finance entries espelhados, CMV só no direto-na-cozinha).
5. Front: páginas `supply` e `distribution` completas (abas 6.4/8.3), badges na sidebar, fluxo de recebimento com mapeamento de itens.
   → verificar: fluxo completo com 3 tenants de teste (central + A + B), incluindo solicitação → atendimento → recebimento direto na cozinha.

**Fase D — Analytics**
6. Aba Análises + Consumo por tenant do módulo Transformados; painel de Gastos com extrato; card "Repasses à rede no mês" na DRE da central (decisão 12.4).
   → verificar: números batem com o exemplo canônico e com consultas SQL manuais.
