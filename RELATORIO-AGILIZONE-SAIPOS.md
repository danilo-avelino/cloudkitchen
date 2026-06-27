# Relatório técnico — Pedidos SAIPOS sem preço por item na API Agilizone

**Data:** 2026-06-20
**Integração:** Agilizone (API v2, `GET /orders`) → StockKitchen / Cloud Kitchen
**Conta onde foi identificado:** Quarteto e Carê (`client_id` 321213cd-…-f568, ambiente *production*)
**Escopo analisado:** ~500 pedidos recentes (mai–jun/2026), 605 itens

---

## 1. Resumo executivo

Os pedidos que entram pela origem **SAIPOS** (`originPlatform = "SAIPOS"`) chegam pela API da
Agilizone **sem o preço no nível do item** — cada item traz apenas `{ name, quantity }`. O valor
só existe **agregado no pedido** (`originOrder.totalOrderPrice` / `amount`).

Já os pedidos de **CARDAPIO_WEB** e **iFood** trazem o preço completo por item
(`unit_price`, `total_price`, `external_code` etc.).

**Consequência:** no nosso módulo de Cardápio, todos os itens vindos do SAIPOS apareciam com
**valor R$ 0,00** (valor médio e total). O **faturamento não é afetado** (ele usa o total do
pedido, que vem correto).

A correção **definitiva** depende da Agilizone preencher o preço por item também na origem SAIPOS.
Enquanto isso, aplicamos uma mitigação do nosso lado (ver §6).

---

## 2. Como a API entrega os dados (por origem)

Um mesmo pedido pode vir de origens diferentes, e a **estrutura dos itens muda conforme a origem**:

| Origem (`originPlatform`) | Caminho dos itens | Campos do item |
|---|---|---|
| `IFOOD` | `ifoodOrder.items[]` | `name`, `quantity`, `externalCode`, `unitPrice`, `totalPrice`, `options` |
| `CARDAPIO_WEB` | `originOrder.items[]` | `name`, `quantity`, `external_code`, `unit_price`, `total_price`, `options`, … |
| **`SAIPOS`** | `originOrder.items[]` | **apenas `name` e `quantity`** ← sem preço |

---

## 3. Evidências

### 3.1 Item SAIPOS (pedido com 1 item)
```jsonc
// GET /orders → pedido #0049, originPlatform: "SAIPOS"
"amount": 109.71,
"originOrder": {
  "totalOrderPrice": { "currency": "BRL", "value": 109.71 },
  "orderDeliveryFee": { "currency": "BRL", "value": 0 },
  "items": [
    { "name": "(10% off) Calabresa (G) + Frango com Catupiry (G)", "quantity": 1 }
    //  ↑ sem price / unitPrice / totalPrice
  ]
}
```

### 3.2 Item SAIPOS (pedido com 2 itens) — impossível ratear por item
```jsonc
// pedido #0001, originPlatform: "SAIPOS", amount: 18.26
"originOrder": { "items": [
  { "name": "Refrigerante Coca-Cola sem Açúcar 350 Ml", "quantity": 1 },
  { "name": "Tigela de Açai - 500 ml",                  "quantity": 1 }
]}
// O total (18,26) existe, mas não há como saber quanto é cada item.
```

### 3.3 Item CARDAPIO_WEB (mesma loja) — vem completo
```jsonc
"originOrder": { "items": [
  { "item_id": 860650, "external_code": "11882002", "name": "Cogumelo Vegano",
    "quantity": 1, "unit_price": 0, "total_price": 46.9, "options": [ … ] }
]}
```

### 3.4 Números agregados (conta Quarteto e Carê, jun/2026)

| Origem | Itens | Itens com preço | Itens zerados | Σ `total_price` |
|---|---:|---:|---:|---:|
| CARDAPIO_WEB | 357 | 357 (100%) | 0 | R$ 23.315,72 |
| **SAIPOS** | 248 | **0 (0%)** | **248 (100%)** | **R$ 0,00** |

> 84% dos pedidos SAIPOS têm 1 item só (média 1,19 itens/pedido) — ou seja, na maioria o
> `totalOrderPrice` do pedido é o próprio preço do item, mas a API não o coloca na linha.

---

## 4. Causa raiz (hipótese)

A integração **SAIPOS → Agilizone** parece **não mapear o preço da linha** ao montar o
`originOrder.items[]`. O preço é mantido apenas no agregado do pedido
(`totalOrderPrice`). Não encontramos nenhum campo de preço por item no payload SAIPOS
(verificado em pedidos de 1 e de vários itens).

Não parece limitação do nosso lado: o **mesmo endpoint**, para CARDAPIO_WEB e iFood, devolve o
preço por item normalmente.

---

## 5. Impacto

- **Cardápio (valor médio / total por item):** itens SAIPOS apareciam zerados.
- **Curva ABC e Tendência:** distorcidas para esses itens (valor 0).
- **Faturamento (DRE/receita):** **não afetado** — usa `amount`/`totalOrderPrice` do pedido.
- **Itens vendidos (quantidade):** **não afetado** — `quantity` vem correto.

---

## 6. Mitigação aplicada (nosso lado, sem depender da Agilizone)

Como o preço por item não existe no SAIPOS, **não inventamos** valor: para cada item, usamos o
**preço unitário médio das vendas do MESMO item que vêm com preço** (CARDAPIO_WEB/iFood) e
aplicamos às unidades sem preço.

- Normalização de nome (caixa/acentos/espaços) para casar variações triviais.
- Tabela de **apelidos** (de-para) para quando SAIPOS e web nomeiam o mesmo produto de forma
  diferente (ex.: *"Pizzas Grandes - 2 Sabores"* ↔ *"Pizza Grande - Dois Sabores"*).
- Resultado: total do Cardápio de junho passou de **R$ 12.159 → R$ 19.482**, alinhado ao
  faturamento do período (R$ 19.267).

**Limites da mitigação:** itens **exclusivos do SAIPOS** que nunca venderam com preço continuam
sem valor (ex.: combos *sopa + refrigerante*, sabores não vendidos no web). São baixo volume.

---

## 7. O que pedimos à Agilizone (correção definitiva)

Para a origem **SAIPOS**, preencher no payload de `GET /orders`, dentro de
`originOrder.items[]`, os campos de preço já presentes nas outras origens:

- `unit_price` (preço unitário) **e/ou** `total_price` (preço da linha);
- idealmente também `external_code` (SKU), para casar com o cardápio.

Exemplo do formato desejado (igual ao que CARDAPIO_WEB já entrega):
```jsonc
{ "name": "Pizza Grande - Dois Sabores", "quantity": 1,
  "unit_price": 75.43, "total_price": 75.43, "external_code": "..." }
```

### Perguntas para o suporte
1. Por que os itens de pedidos **SAIPOS** vêm sem preço (`unit_price`/`total_price`), enquanto
   CARDAPIO_WEB e iFood vêm completos?
2. É limitação da integração SAIPOS→Agilizone ou da API de saída?
3. Existe algum parâmetro/endpoint para obter o detalhe do item com preço nessa origem?
4. Há previsão para padronizar o `originOrder.items[]` entre origens?

---

## Apêndice — achado relacionado (CARDAPIO_WEB sem nome de marca)

Na mesma investigação notamos outro ponto: pedidos **CARDAPIO_WEB** não trazem o **nome da marca**
(`merchant.name`), apenas um id numérico (`originOrder.merchant_id`, ex.: 8747/8749) com
`external_merchant_name: null`. No SAIPOS o nome vem (`originOrder.merchant.name` = "Quartheto"/"Care").
Contornamos rotulando como `"Cardápio Web #<id>"` para mapeamento manual, mas seria ideal a API
enviar o `merchant.name` também no CARDAPIO_WEB.
