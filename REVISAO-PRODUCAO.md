# Revisão do módulo Produção — diagnóstico e proposta de novo modelo

> Escrito em 2026-08-09. Revisa o que foi entregue conforme `PRD-PRODUCAO-E-DISTRIBUICAO.md` §4.
> Nada aqui foi implementado — é proposta para decisão.

**Base revisada:** `page-production.jsx` (855 linhas), `page-mobile-production.jsx` (481),
`ProductionRecipesPanel` + `TransformedCatalog` + `TransformedAnalytics` em `page-transformed.jsx`,
RPCs `dbIssue/Complete/CancelProductionOrder` em `lib-supabase.jsx`, e o PRD §4.

---

## 1. O diagnóstico em uma frase

O módulo modela **o documento** (a ordem de produção) e não **o trabalho** (o preparo do dia).
Ele grava bem o que já aconteceu, mas não responde a única pergunta que o cozinheiro faz de manhã
— *o que eu produzo hoje e quanto?* — e não tem padrão de comparação para dizer se o que aconteceu
foi bom ou ruim.

Tudo abaixo decorre disso.

---

## 2. O que está ruim

### 2.1 Não existe planejamento — o módulo é só um gravador

A tela abre em "Ordens de saída" com o KPI de destaque **"Aguardando devolução"**. Ou seja: a métrica
principal do módulo é a quantidade da própria burocracia dele em aberto. Não há nada que diga o que
produzir.

Isso é o inverso da prática consolidada de cozinha. O artefato central de um prep kitchen é a
**prep list**, e a conta é trivial — [par level − saldo em mãos = quantidade a preparar](https://www.webstaurantstore.com/article/583/kitchen-prep-lists.html),
recalculada todo dia e organizada por praça.

E o pior: **o par level já existe no banco.** `stock_items` tem `min_qty`, `max_qty`, e até
`auto_min_enabled` / `auto_min_mode` (recálculo semanal). O transformado é um `stock_item` como
qualquer outro — herdou os campos e o módulo Produção simplesmente não os lê.

### 2.2 Duas visitas ao sistema para uma tarefa de 20 minutos

Fluxo atual: criar rascunho → "Enviar à produção" → *(mais tarde)* abrir a ordem → "Lançar devolução".
Quatro interações e dois momentos distintos, por item produzido. Numa cozinha que porciona 8–10 itens
por manhã, são ~40 interações e uma pilha de documentos meio-abertos.

O modelo de duas fases (`issued` → `completed`) é o de **ordem de serviço de manufatura**. Ele existe
para o caso em que o material sai fisicamente do seu controle e volta depois — que é exatamente o caso
da **central mandando insumo para a cozinha de outro tenant**. Não é o caso de "o Jorge porcionou
10 kg de calabresa às 8h e guardou na geladeira".

O módulo aplicou o caso raro como padrão e o caso comum como exceção.

### 2.3 A ordem em aberto é anônima

A revisão de 2026-07-11 tirou os transformados da criação da ordem — eles só são informados na
devolução. Consequência direta, visível na própria tabela ([page-production.jsx:783](page-production.jsx#L783)):

```
Insumos                          Saídas
Calabresa (10 kg)                aguardando devolução
```

Uma ordem `issued` não diz o que está sendo produzido. Você tem R$ 420 de insumo fora do estoque e o
sistema não sabe informar o que deveria voltar. Não dá para cobrar o retorno, não dá para conferir se
voltou o esperado, e o "aproveitamento" só pode ser calculado depois do fato consumado.

### 2.4 Aproveitamento sem linha de base não significa nada

`yield_pct = peso devolvido ÷ peso enviado`. A ordem devolve 87%.

**87% é bom?** O módulo não sabe. O rendimento esperado existe cadastrado (ver 2.6), mas a ordem não o
carrega — então não há denominador na hora de julgar. O KPI recorre a um corte fixo: pinta de amarelo
abaixo de 90% ([page-production.jsx:698](page-production.jsx#L698)), número arbitrário, igual para
calabresa em cubos e para limpeza de peixe, que têm rendimentos reais completamente diferentes.

A prática do setor é o **yield test / butcher test**: mede-se o rendimento padrão de cada item uma vez,
e daí em diante [compara-se o uso teórico com o uso real, e a diferença é o número acionável](https://www.marketman.com/blog/food-yield-percentage).
Sem padrão não há variância; sem variância a métrica não aciona nada. Hoje o número existe só para ser
olhado.

### 2.5 O desperdício desaparece dentro do custo

Decisão atual, explícita na UI: *"Voltou menos que o enviado? O desperdício fica absorvido no custo da
porção (nada vira perda no CMV)"*.

Enviou 10 kg (R$ 400), voltaram 8 kg em porções. O custo/kg da porção sobe de R$ 40 para R$ 50 e a
perda de 2 kg **some**. Não vira linha em Desperdícios, não tem motivo, não dispara alerta, não aparece
no CMV. O módulo Desperdícios tem 5 motivos catalogados (`WASTE_REASONS` em
[page-stock.jsx:3462](page-stock.jsx#L3462)) e nenhum deles é quebra de produção.

Contabilmente absorver é defensável. Operacionalmente, esconder a perda é o oposto do que você quer —
foi você mesmo que pediu, semana passada, o gate de conferência do inventário justamente porque erro
de contagem estava virando prejuízo invisível. É o mesmo problema, no módulo ao lado.

### 2.6 A receita de produção já define o rendimento esperado — e a ordem joga fora

Este é o achado mais sério, e é uma regressão, não uma lacuna.

`production_recipes` tem as duas metades do padrão:

```sql
production_recipe_inputs  (stock_item_id, qty, unit)          -- 10 kg de calabresa crua
production_recipe_outputs (stock_item_id, expected_qty)       -- 100 porções de 100 g
```

O mapper expõe as duas (`inputs[].qty`, `outputs[].expectedQty`, [lib-supabase.jsx:3478](lib-supabase.jsx#L3478))
e o editor de receita **exige** ao menos uma saída para salvar (`validOutputs.length > 0`).
Ou seja: o rendimento esperado está cadastrado, íntegro, no banco.

O fluxo da ordem descarta:

```js
// page-production.jsx:96 — aplica a receita
setInputs(r.inputs.map(...));          // lê os insumos
                                       // r.outputs nunca é lido

// page-production.jsx:121 — salva a ordem
outputs: [],                           // "saídas são lançadas na devolução"
```

A revisão de 2026-07-11 (§4.1 do PRD), que transformou a ordem em "ordem de saída" para tirar os
transformados da criação, **cortou junto a única linha de base que o módulo tinha**. É por isso que a
ordem em aberto é anônima (2.3) e que o aproveitamento não tem com o que comparar (2.4) — os dois
sintomas saem daqui.

O dado está lá. Só não é usado.

### 2.7 Rateio multi-saída por peso distorce o custo

Quando volta mais de um transformado, o custo é rateado por peso
(`cost_share_i = total × peso_i / Σ peso`) — o *physical measure method*. A literatura de custos é
direta sobre ele: [ignora o valor de mercado, e atribuir o mesmo custo por quilo a um produto caro e a
um barato produz números de rentabilidade enganosos](https://www.financestrategists.com/accounting/cost-accounting/joint-cost-allocation-methods/).

É literalmente o caso da desossa: um kg de filé e um kg de aparas saem da mesma peça e recebem o mesmo
custo/kg. O filé fica barato demais, a apara cara demais, e as duas margens ficam erradas.

Efeito colateral no código: exige `portion_qty` em **todos** os transformados da ordem, e a devolução
trava quando falta (`multiMissingPortion`, [page-production.jsx:261](page-production.jsx#L261)). O
método ruim ainda cria um bloqueio de usabilidade.

### 2.8 Sem lote, sem validade

Transformado tem prazo de validade — é o dado mais importante de um item produzido, e requisito de
HACCP. Hoje não há data de produção, validade nem lote na ordem. `stock_items.expiration_date` existe,
mas é uma data única por *item de catálogo*, não por *lote produzido* — misturar produção de segunda e
de quinta no mesmo saldo apaga a informação.

A prática do setor é gerar [etiqueta com lote e validade calculada automaticamente no momento da
produção](https://foodready.ai/app/batch-management-software/), com alerta de vencimento. A infra de
impressão já existe no app (ficha de conferência do inventário, cupom térmico das requisições).

### 2.9 Custo de produção ignora mão de obra *(fora de escopo — decisão 6)*

Custo do transformado = só insumo. Mas a decisão real que o módulo deveria informar é
*"vale a pena porcionar aqui ou comprar porcionado?"* — e essa conta é ganha ou perdida no tempo de
gente, não no insumo. Sem isso, o porcionamento interno sempre parece barato.

### 2.10 O transformado é invisível para o resto do app

`page-recipes.jsx` e `page-cmv.jsx` não têm nenhuma referência a `item_kind` / transformado (verificado
por grep: zero ocorrências). O transformado entra na ficha técnica como um insumo qualquer.

Com a decisão de 3.0 (módulos separados) isso deixa de ser um defeito de modelagem e passa a ser
comportamento correto: a ficha consome o transformado pelo `unit_cost` real que a produção gravou, e
não precisa saber de onde ele veio. Fica só um ajuste cosmético desejável — marcar visualmente o item
como transformado no seletor de ingrediente, para o usuário não confundir com insumo comprado.

---

## 3. A forma nova

### 3.0 Decisão de escopo (2026-08-09)

> **Fichas Técnicas e Produção ficam totalmente separadas.** A receita de produção é
> `production_recipes` — não se toca em `preparations` nem em `recipes`.
>
> Motivo: Fichas Técnicas resolve custeio e margem de prato vendido; Produção resolve estoque físico.
> São ciclos de vida diferentes, e acoplar faz mudança de um quebrar o outro. O custo aceito é
> manutenção em dois lugares quando um transformado também aparece numa ficha — aceitável, e nada
> quebra: a ficha consome o transformado como `stock_item`, pelo `unit_cost` real que a produção gravou.

### 3.1 A inversão

> Pare de modelar **"ordem de produção"**. Passe a modelar **"a receita rendeu"**.

A receita de produção deixa de ser um atalho de digitação e passa a ser o **padrão** contra o qual cada
lote é medido. Ela já diz o que entra e quanto rende — falta só parar de descartar a segunda metade.

### 3.2 Os três pilares

**A · A receita de produção passa a valer como padrão.**

Nada de novo precisa ser modelado para a linha de base: `production_recipe_inputs.qty` e
`production_recipe_outputs.expected_qty` já são o insumo teórico e o rendimento teórico. As mudanças são
de fluxo, não de schema:

1. `applyRecipe` passa a carregar **também** as saídas esperadas.
2. A ordem grava as saídas esperadas na criação (hoje `outputs: []`) — volta a existir `expected_qty`
   em `production_order_outputs`, coluna que **já existe** e está sempre nula.
3. A devolução pré-preenche com o esperado e destaca a diferença, em vez de pedir tudo em branco.

Com isso a ordem deixa de ser anônima e o aproveitamento ganha denominador. Três campos novos, todos
Dois campos novos, opcionais, cobrem o resto da proposta: `shelf_life_days` na receita (lote/validade)
e `ref_value` na linha de saída (rateio multi-saída) — ambos em 3.5.

Nenhuma linha de `preparations` é lida ou escrita.

**B · Registro de lote em uma tela só.**
Substitui `draft → issued → completed` no caso normal (produção no mesmo local e turno):

```
1. Escolhe a receita      "Calabresa porcionada 100g"
2. Quantos lotes?         [ 1 ]     → a receita rende 100 porções
3. O sistema mostra:      Calabresa crua .... 10,0 kg   (teórico)
4. Confirma ou ajusta:    Calabresa crua .... 11,2 kg   ← usou mais
5. Rendeu quantas?        [ 92 ] porções     ← rendeu menos
6. [ Registrar produção ]
```

Um toque no caso feliz (aceita o teórico e o rendimento nominal). Ajustar é a exceção, não a regra.
Um movimento só, sem documento em aberto.

**C · A ordem de duas fases não tem caso de uso — some.**

> Revisado em 2026-08-09. Eu tinha proposto preservá-la como "envio para produção externa", supondo que
> insumo bruto saísse para ser preparado em outro local. A resposta do usuário desfaz a suposição:
> **a central produz no próprio local e distribui o transformado pronto** aos demais tenants.

Ou seja, a sequência real é:

```
[ Central ]  insumo bruto → PRODUÇÃO (mesmo local) → transformado no estoque da central
                                                          │
                                                          ▼
                                              TRANSFERÊNCIA (módulo Suprimentos)
                                                          │
                                                          ▼
                                           [ Cozinha A ]  [ Cozinha B ]
```

A etapa entre tenants **já é uma transferência**, com sua própria máquina de estados e confirmação de
recebimento (PRD §7). Não é uma ordem de produção. Não sobra nenhum cenário em que insumo sai do
controle de quem o baixou e volta depois — que era a única coisa que `issued → completed` modelava.

Consequência: o fluxo de duas fases deixa de ser modo alternativo e é **removido da interface**. As RPCs
`dbIssue/Complete/CancelProductionOrder` continuam existindo no banco (o registro de lote da fase 2 as
usa, disparando as duas transições no mesmo instante), mas ninguém mais vê um documento em aberto.

Isso apaga por completo os problemas 2.2 (duas visitas) e 2.3 (ordem anônima), e torna o KPI
"Aguardando devolução" sem objeto.

### 3.3 O que a linha de base habilita: variância no lugar de "aproveitamento"

Com a receita como padrão, cada produção gera dois números que hoje são impossíveis:

| | Teórico (receita) | Real (lote) | Variância |
|---|---|---|---|
| **Insumo** | 10,0 kg · R$ 400,00 | 11,2 kg · R$ 448,00 | **+12% · R$ 48,00** |
| **Rendimento** | 100 porções | 92 porções | **−8%** |

*"Usou 12% a mais de calabresa do que a receita manda"* é acionável — fala de porcionamento
displicente, receita desatualizada ou desvio. *"Aproveitamento 87%"* não fala nada. Este é o padrão de
[theoretical vs. actual](https://www.getmeez.com/blog/menu-engineering-food-costing-software) que os
sistemas do setor usam, e é o mesmo raciocínio do CMV teórico × real que o app **já faz** no módulo CMV.

**O desperdício continua absorvido no custo da porção** (decisão de 2026-08-09) — nada de linha em
Desperdícios, nada de `quebra_producao`, o comportamento contábil atual fica intacto.

Isso não conflita com a variância, e é justamente o ponto: **absorver é decisão de custeio, variância é
relatório de gestão.** O custo da porção sobe quando rende menos (como hoje); o que muda é que o desvio
passa a aparecer como número em cima do padrão da receita, em vez de ficar diluído e invisível. O
problema de 2.5 se resolve pela visibilidade, não por mudar o lançamento.

### 3.4 A tela inicial passa a ser "Produzir hoje"

Substitui a lista de ordens como landing do módulo. Alimentada pelo par level que já está no banco:

```
PRODUZIR HOJE                                    quinta, 09/08

  Calabresa porcionada 100g      saldo 18   par 120    ▸ produzir 102
  Molho de tomate 1L             saldo  4   par  30    ▸ produzir  26
  Frango desfiado 500g           saldo 22   par  40    ▸ produzir  18
  ─────────────────────────────────────────────────────────────
  Cebola em cubos 1kg            saldo 31   par  30    ✓ ok

  VENCENDO
  Molho pesto 200g   lote 05/08   vence amanhã   6 porções
```

A lista de lotes produzidos vira histórico, uma aba atrás. O módulo passa a abrir com uma decisão em
vez de um arquivo.

**Cronograma automatizado** (escopo novo, decisão de 2026-08-09). A lista acima é reativa — só mostra o
que já furou o par. Em cima dela entra a camada de plano, com dois níveis:

| Nível | Regra | Exemplo |
|---|---|---|
| **Recorrente** | receita + dias da semana + quantidade fixa | Molho de tomate · seg/qua/sex · 30 L |
| **Por reposição** | dispara sozinho quando `saldo < min_qty` | Calabresa · repor até o par sempre que cair abaixo de 40 |

O cronograma gera a lista do dia automaticamente, e a tela "Produzir hoje" passa a ser a **união** do
que o cronograma mandou com o que o par acusou. Cabe também a regra de horizonte que a literatura de
prep list recomenda: [preparar para ~1,5 turno em perecível](https://www.webstaurantstore.com/article/583/kitchen-prep-lists.html),
para não produzir estoque que estraga.

Precisa de tabela nova (`production_schedules`: receita, tipo, dias, quantidade, ativo). É o único item
da proposta que cria tabela.

### 3.5 Correções pontuais que vêm junto

- **Lote com validade** (prioridade elevada — decisão 2026-08-09): cada produção gera lote com data e
  `shelf_life_days` da receita → validade calculada, alerta de vencimento, etiqueta imprimível
  reusando a infra de impressão existente.
- **Rateio multi-saída por valor de referência** (confirmado necessário em 2026-08-09: uma peça bruta
  devolve mais de um transformado). Campo novo `ref_value` em `production_recipe_outputs` — quanto vale,
  aproximadamente, **uma unidade daquela saída**. Preenchido uma vez por receita.

  ```
  cost_share_i = total_input_cost × (returned_qty_i × ref_value_i)
                                  ÷ Σ (returned_qty × ref_value)
  ```

  Só a **proporção** entre os `ref_value` importa — o valor absoluto pode ser grosseiro sem prejuízo.
  Fallbacks: sem `ref_value` em nenhuma saída → peso (comportamento atual); sem `portion_qty` também →
  divisão igual. Nunca trava, o que elimina o bloqueio `multiMissingPortion` de 2.7.

  > **Por que não derivar do `unit_cost` atual do transformado**, que já existe e não exigiria campo
  > novo: esse `unit_cost` é gravado pelo rateio da produção anterior. Usá-lo como direcionador torna o
  > cálculo auto-referente — um valor inicial torto se perpetua e deriva a cada lote. O `ref_value`
  > precisa ser uma âncora externa, estável, ou o rateio realimenta o próprio erro.

  Isto é o *market value method* da literatura de custos, alimentado por um número interno em vez do
  preço de venda — que não existe aqui, já que a operação é custo puro ponta a ponta (decisão 5).
- ~~Mão de obra~~ — **cortado por decisão de 2026-08-09.** Custo de produção = só mercadoria.
  `prep_minutes` sai do escopo.

---

## 4. O que morre, o que fica

| | |
|---|---|
| **Morre** | `outputs: []` na criação da ordem; a interface de `draft → issued → completed` **inteira** (não só como padrão — ver 3.2 C); KPI "Aguardando devolução"; rateio por peso; `yield_pct` sem denominador |
| **Fica** | `production_recipes` / `_inputs` / `_outputs` — **promovida a padrão**, schema intacto; `production_orders` e as RPCs de issue/complete/cancel (viram o modo "produção externa"); transformado como `stock_item`; `reference_type='production_order'` fora do CMV; toda a coerência contábil do §3.3 do PRD |
| **Não é tocado** | `preparations`, `recipes`, `preparation_items` e todo o módulo Fichas Técnicas |
| **Nasce** | Registro de lote em uma tela; lote + validade + etiqueta; prep list por par level; cronograma automatizado; variância teórico × real; rateio por custo esperado relativo |

Uma tabela nova, `production_schedules` (o cronograma de 3.4). Fora ela, tudo é aditivo e opcional:
`shelf_life_days` em `production_recipes`, `ref_value` em `production_recipe_outputs`, e o lote com
validade. `production_order_outputs.expected_qty`
já existe — passa a ser preenchida em vez de ficar sempre nula. `prep_minutes` e `sale_value_ref` saíram
do escopo (decisões 3 e 5).

O `production_orders` continua sendo a tabela de fato: o registro de lote grava `issued` e `completed`
no mesmo instante, então o histórico e a contabilidade não mudam de forma — só some o documento em
aberto entre as duas transições.

---

## 5. Plano sugerido

| Fase | Entrega | Por que nessa ordem |
|---|---|---|
| **0** | Parar de descartar `r.outputs`: a ordem passa a carregar e gravar o rendimento esperado | Duas mudanças pequenas em `page-production.jsx`, zero schema. Já resolve a ordem anônima (2.3) e dá denominador ao aproveitamento (2.4) |
| **1** | Registro de lote em uma tela + remoção do fluxo de duas fases | Virou a fase mais urgente: a decisão 4 tirou o caso de uso das duas fases, então manter a interface antiga só custa confusão |
| **2** | Lote, validade, alerta de vencimento, etiqueta | **Subiu** — validade é dor real (decisão 3). Depende da fase 1 (o lote nasce no registro) |
| **3** | Tela "Produzir hoje" (par − saldo) | Só lê `min/max`, que serão preenchidos (decisão 7) |
| **4** | Cronograma automatizado (`production_schedules`) | Escopo novo (decisão 7). Depende da 3, que é a superfície onde ele aparece |
| **5** | Rateio multi-saída por `ref_value` | **Subiu** — confirmado que multi-saída é caso real, então o rateio por peso está distorcendo custo hoje, em produção. Destrava também a devolução |
| **6** | Variância teórico × real na aba Análises | Depende da 0 (padrão) e da 1 (real). Sem urgência: é relatório, não fluxo |

**Sem migração de dados.** As receitas de produção existentes já têm inputs e `expected_qty` — passam a
valer como padrão no dia em que a fase 0 subir, sem recadastro.

---

## 6. Decisões registradas (2026-08-09)

| # | Pergunta | Decisão | Efeito |
|---|---|---|---|
| 1 | Ficha técnica vira a receita de produção? | **Não.** Módulos totalmente separados; a receita é `production_recipes` | §3.0 · `preparations` intocado |
| 2 | Desperdício: absorver ou reconhecer? | **Absorver** — fica dentro do preço da porção, como hoje | §3.3 · sem `quebra_producao`; o desvio aparece como variância, não como lançamento |
| 3 | Validade/lote é dor real? | **Sim, importante** | §3.5 · subiu para a fase 2 |
| 4 | Produz em outro local físico? | **Produz num local e distribui pela central** | §3.2 C · o fluxo de duas fases perde o caso de uso e sai da interface |
| 5 | Existe valor de referência de venda? | **Não** — transferência entre tenants é custo de produção puro | §3.5 · sem preço de venda; o rateio usa `ref_value` interno, preenchido na receita |
| 6 | Mão de obra entra no custo? | **Não.** Só custo de mercadoria | §3.5 · `prep_minutes` fora do escopo |
| 7 | Par level de transformado preenchido? | **Sim**, e mais: cronograma de produção automatizado | §3.4 · escopo novo, tabela `production_schedules` |

### Ainda em aberto

- **Implementamos, e por onde começo?** Nada foi codado. A fase 0 é barata (duas mudanças em
  `page-production.jsx`, zero schema) e independe de tudo o mais.
> ~~O rateio multi-saída importa no seu caso?~~ **Respondido em 2026-08-09: sim**, uma peça bruta
> devolve mais de um transformado. A fase subiu para 5 e ganhou o campo `ref_value` (§3.5).

---

**Fontes:** [WebstaurantStore — prep lists e par levels](https://www.webstaurantstore.com/article/583/kitchen-prep-lists.html) ·
[MarketMan — food yield percentage](https://www.marketman.com/blog/food-yield-percentage) ·
[meez — theoretical vs. actual](https://www.getmeez.com/blog/menu-engineering-food-costing-software) ·
[Finance Strategists — joint cost allocation](https://www.financestrategists.com/accounting/cost-accounting/joint-cost-allocation-methods/) ·
[FoodReady — batch management e shelf life](https://foodready.ai/app/batch-management-software/) ·
[reciProfity — depleção por prep recipe vs ingrediente](https://costguard.zendesk.com/hc/en-us/articles/115003821314-Requisitions-for-Catering-Prep-Recipes-and-Inventory-Control)
