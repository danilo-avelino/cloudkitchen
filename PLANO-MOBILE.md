# Plano de Adaptação Mobile — StockKitchen

**Abordagem escolhida:** telas mobile **dedicadas** (não responsivo in-place), no
mesmo padrão que já funciona em `page-mobile-requests.jsx` (`#/mobile`).
**Alvo prioritário:** celular **≤480px** (estoquista/operador em pé, uma coluna,
toque). Tablet e desktop continuam usando as telas atuais, sem mudança.

**Ordem:** Fundação (Fase 0) → **Estoque** → **Compras** → demais páginas.

---

## Diagnóstico (estado atual)

- **Zero responsividade.** Tudo é inline-style com pixels fixos; `styles.css`
  praticamente sem `@media` ([styles.css:382](styles.css#L382)).
- **Shell desktop-only:** sidebar fixa de 244px + topbar 48px + área de conteúdo
  + status bar ([src/App.jsx:205-250](src/App.jsx#L205-L250),
  [shell.jsx:508](shell.jsx#L508)). O colapso da sidebar é manual, não reage à largura.
- **Tabelas densas:** Estoque tem 10 colunas ([page-stock.jsx:738-787](page-stock.jsx#L738-L787));
  Compras tem tabela de 7 colunas por fornecedor ([page-purchases.jsx:992-1061](page-purchases.jsx#L992-L1061)).
- **Grids de largura fixa:** KPIs `repeat(4,1fr)` ([page-stock.jsx:591](page-stock.jsx#L591)),
  painel lateral `1fr 380px` ([page-stock.jsx:736](page-stock.jsx#L736)),
  linhas de lista `70px 1fr 160px 110px 100px auto` ([page-purchases.jsx:744](page-purchases.jsx#L744)).
- **Já existe um bom padrão mobile** para copiar: `MobileRequests` — full-screen,
  bottom sheets, touch targets 40–56px, inputs 16px (anti-zoom iOS),
  `env(safe-area-inset-bottom)`, mesma camada de dados (`dbListStockItems`, etc.),
  renderizado **fora** do `AppShell` ([page-mobile-requests.jsx](page-mobile-requests.jsx)).

**Princípio-guia:** reaproveitar 100% da camada de dados (funções `db*` do
`lib-supabase.jsx`) e das CSS vars. O fork é **só de layout/interação**, nunca de
lógica de negócio. Cada handler de escrita (entrada, recebimento, edição) chama as
mesmas funções que a versão desktop.

---

## Convenções mobile (valem para todas as telas)

Extraídas do que já funciona em `MobileRequests`:

- **Container full-screen:** `position:fixed; inset:0` + `inner` centralizado
  `maxWidth:520; margin:0 auto`.
- **Estrutura de 3 zonas:** header fixo · área rolável (`flex:1; overflow:auto;
  WebkitOverflowScrolling:"touch"`) · rodapé fixo com CTA.
- **Safe area:** rodapés usam `calc(10px + env(safe-area-inset-bottom))`.
- **Touch targets ≥ 40px**; botões de ação primária 52px.
- **Inputs `fontSize:16`** (evita zoom automático no iOS).
- **Modais = bottom sheets** (`justifyContent:flex-end`, cantos arredondados no
  topo, "grabber" de 38×4px) ou tela cheia para fluxos longos.
- **Guard de duplo-clique + "Carregando…"** em todo botão de ação (regra 7 do
  `CLAUDE.md`): estado `submitting`/`disabled` durante a operação.
- **PT-BR safe:** parsing numérico com `_parseBR` (vírgula decimal) — nunca
  `Number("8,50")`.

---

## Fase 0 — Fundação compartilhada (pré-requisito de tudo)

Nada de tela de página até isso existir. Objetivo: um "shell mobile" e um kit de
primitivos que Estoque/Compras/etc. só preenchem.

### 0.1 Detecção de viewport
Novo hook global `useIsMobile()` (matchMedia `(max-width: 480px)`, com listener):

```
// em widgets.jsx ou novo mobile-ui.jsx
function useIsMobile() {
  const [m, setM] = useState(() => window.matchMedia("(max-width:480px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width:480px)");
    const on = (e) => setM(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}
```
→ **verificar:** redimensionar a janela cruza o breakpoint e re-renderiza.

### 0.2 Kit de primitivos — novo arquivo `mobile-ui.jsx`
Extrair de `page-mobile-requests.jsx` os pedaços reutilizáveis e expor no `window`
(convenção cross-file: `window.X` + leitura lazy — ver `feedback_cross_file_jsx_components`):

- `MobileScreen` (container fixed + inner 520)
- `MobileHeader` (título + ação à direita, com voltar opcional)
- `MobileScrollArea`
- `MobileBottomBar` (rodapé com safe-area)
- `BottomSheet` (overlay + sheet arrastável)
- `FullSheet` (tela cheia p/ fluxos longos — base do carrinho/recebimento)
- `MobileListRow` (linha tocável: título, subtítulo, badge, ação)
- `StatStrip` (KPIs em faixa horizontal com scroll, substitui `repeat(4,1fr)`)
- `SegmentedTabs` (sub-abas viram um segmented control rolável)
- `FilterSheet` (busca + filtros num bottom sheet, botão "Filtros" no header)
- `stepBtn` / `bigStep` (steppers já existentes)

→ **verificar:** `MobileRequests` refatorado para consumir esses primitivos e
continuar idêntico (sem regressão na tela `#/mobile`).

### 0.3 Shell mobile + roteamento — `mobile-shell.jsx` + edição em `src/App.jsx`
- Novo `MobileApp`: top app bar (marca + menu) · conteúdo da página · **bottom
  tab bar** com os 4–5 módulos mais usados (Dashboard, Estoque, Requisições,
  Compras, "Mais") + drawer com a lista completa (reusa `getAllowedModules`).
- Em [src/App.jsx:176](src/App.jsx#L176): quando `useIsMobile()` e logado (e não
  no caso `mobileOnly`/`#/mobile`), renderizar `<MobileApp>` no lugar de `<AppShell>`.
- **Fallback progressivo:** `MobileApp` mapeia `page → componente mobile`; página
  sem versão mobile ainda cai na página desktop dentro de um wrapper rolável, com
  um aviso discreto "Tela ainda não otimizada para celular". Isso permite lançar
  **página por página** sem quebrar o resto.

### 0.4 Registrar no runtime
Adicionar os novos arquivos ao bootstrap em
[src/main.jsx:53-83](src/main.jsx#L53-L83) (após `widgets.jsx`, antes das páginas):
`mobile-ui.jsx`, `mobile-shell.jsx`, e depois cada `page-mobile-*.jsx`.

→ **verificar Fase 0:** logar num celular (ou DevTools ≤480px) mostra o shell
mobile com bottom nav; todas as páginas abrem (desktop embutido no fallback);
`#/mobile` segue funcionando.

---

## Página 1 — Estoque (`page-mobile-stock.jsx`)

Referência desktop: [page-stock.jsx:585-852](page-stock.jsx#L585-L852).
A tela desktop tem 6 sub-abas (Insumos, Inventário, Fornecedores, Categorias,
Desperdícios, Pendências). No celular, o foco é o dia a dia do estoquista:
**consultar saldo, dar entrada, ver alertas/pendências**. As abas de gestão
(Fornecedores, Categorias) entram como itens de menu secundário, não como carrossel.

### Mapa desktop → mobile

| Elemento desktop | Tratamento mobile |
|---|---|
| KPIs `repeat(4,1fr)` ([:591](page-stock.jsx#L591)) | `StatStrip` horizontal com scroll: Entradas · Saídas · Valor · Alertas. Toque abre o mesmo detalhe (sheet). |
| Sub-abas ([:606-618](page-stock.jsx#L606)) | `SegmentedTabs` rolável com **Insumos / Inventário / Pendências / Desperdícios**; Fornecedores e Categorias vão pro menu "⋯". |
| Header + filtros numa linha ([:661-705](page-stock.jsx#L661)) | Header com busca sempre visível + botão **"Filtros"** → `FilterSheet` (status Todos/Baixo/Ruptura/Ocultos + categorias). |
| Botões (Assistente, Histórico, Entrada, Novo) | FAB/rodapé: CTA primário **"+ Entrada"**; "Novo insumo", "Assistente", "Histórico" no menu "⋯". |
| Tabela 10 colunas ([:738-787](page-stock.jsx#L738)) | **Lista de cards** (`MobileListRow`): linha 1 nome + badge status; linha 2 `qtd un · R$ custo · mín/máx`. Toque abre a ficha do item (sheet). |
| Painel lateral `1fr 380px` (`AllocationPanel`, [:790](page-stock.jsx#L790)) | Vira **bottom sheet** de detalhe do item (saldo, alocação por operação, editar). |
| Modais (`StockEntryModal`, `NewStockItemModal`, `StockAssistantModal`, `StockHistoryModal`) | `StockEntryModal` e criação/edição viram **FullSheet** (formulário em coluna única, inputs 16px). Assistente e Histórico → FullSheet com lista. |
| `PendingEntryAlert` / aba Pendências ([:588](page-stock.jsx#L588),[:655-658](page-stock.jsx#L655)) | Banner tocável no topo → aba Pendências (lista de cards com CTA "Registrar entrada"). |

### Passos
1. `StockList` mobile (cards + busca + filtro sheet) reusando `filtered`/`totals`
   já calculados na lógica atual (extrair o cálculo para reuso, ou replicar o
   `useMemo`). → **verificar:** ordenação ruptura→baixo→ok igual à desktop.
2. Ficha do item em sheet (consulta) + reuso de `handleEditItem`. → **verificar:**
   editar mín/máx persiste no Supabase (mesmo caminho `dbUpdateStockItem`).
3. Entrada manual em FullSheet multi-linha reusando `handleEntry`
   ([:371-424](page-stock.jsx#L371)). → **verificar:** entrada gera `stock_movements`
   e refetch atualiza saldo; guard de duplo-clique ativo.
4. `StatStrip` + drill-downs (reusa `StockFlowDetailModal`, `StockTopValueModal`
   como sheets). → **verificar:** valores batem com a tela desktop no mesmo período.
5. Aba Pendências + banner (reusa `pendingEntryItems`). → **verificar:** contador
   do badge = contador do sidebar/desktop.
6. Inventário e Desperdícios: começar embutindo os componentes atuais
   (`Inventory`, `WastesView`) num wrapper rolável; otimização fina depois.

**Critério de pronto (Estoque):** um estoquista consegue, só no celular:
consultar saldo de qualquer insumo, dar entrada manual, ver alertas de ruptura e
resolver pendências — sem scroll horizontal e com todos os writes persistindo.

---

## Página 2 — Compras (`page-mobile-purchases.jsx`)

Referência desktop: [page-purchases.jsx:511-591](page-purchases.jsx#L511) (master),
`PurchaseDetailView` ([:792](page-purchases.jsx#L792)), `SupplierGroupCard`
([:917](page-purchases.jsx#L917)), `GoodsReceiptModal` ([:1119](page-purchases.jsx#L1119)).
Fluxo central no celular: **receber mercadoria** (operador confere a entrega física).

### Mapa desktop → mobile

| Elemento desktop | Tratamento mobile |
|---|---|
| Header + tabs "Listas salvas / Nova lista" ([:594-625](page-purchases.jsx#L594)) | `SegmentedTabs`. "Nova lista (auto)" vira botão no rodapé/menu. |
| Faixa de stats ([:672-679](page-purchases.jsx#L672)) | `StatStrip`: Abertas · Parciais · Recebidas · Total estimado. |
| Linhas de lista grid 6-col ([:735-777](page-purchases.jsx#L735)) | **Cards**: título + notas; linha meta `N fornecedores · N itens · R$ total` + badge status; ações "Ver" / **"Receber"** (CTA) / excluir (no swipe ou menu). |
| `PurchaseDetailView` 2-zonas com busca 280px ([:805-851](page-purchases.jsx#L805)) | Header com voltar + total; busca full-width; cards de fornecedor empilhados. |
| `SupplierGroupCard` + tabela 7-col ([:962-1062](page-purchases.jsx#L962)) | Card **colapsável** por fornecedor: cabeçalho (nome, badge, total, "Receber Mercadoria"); itens como mini-linhas (`Pedido X · Recebido Y · badge`), sem tabela. |
| `GoodsReceiptModal` (largura fixa, [:1119](page-purchases.jsx#L1119)) | **FullSheet em etapas**: por item → qtd recebida (stepper) + custo total NF + flag divergência; rodapé "Confirmar recebimento". Reusa `handleConfirmReceipt` ([:266](page-purchases.jsx#L266)). |
| `ReceiptsHistory` grid 4-col ([:1066-1113](page-purchases.jsx#L1066)) | Lista de cards (fornecedor · data · divergências · total). |
| `SupplierPickerModal`, `OriginalListModal`, `DeleteListConfirm` | Bottom sheets. |
| Aba "Nova lista" (`Shopping embedded`, [:549](page-purchases.jsx#L549)) | Reaproveitar embutido num wrapper rolável; refino depois. |

### Passos
1. Master mobile: lista de cards agrupada por dia (reusa `enrichedLists`/`byDay`
   [:651-668](page-purchases.jsx#L651)). → **verificar:** status agregado idêntico.
2. Detalhe da lista: cards de fornecedor colapsáveis (reusa `supplierStatusFor`,
   `receivedByItem`, `actualByItem`). → **verificar:** custo efetivo x estimado
   exibido igual à desktop.
3. **Recebimento em FullSheet** reusando `handleConfirmReceipt` — o passo mais
   crítico (dispara `dbApplyStockMovement`). → **verificar:** confirmar recebimento
   cria `goods_receipt` + movimentos de entrada; `line_cost`/custo por NF batem
   (atenção ao `_parseBR` e à regra de `line_cost` gerado — ver memórias
   `feedback_brl_number_parse` e `feedback_generated_line_cost_double`).
   Guard de duplo-clique obrigatório aqui.
4. Histórico + sheets auxiliares.

**Critério de pronto (Compras):** operador consegue, só no celular, abrir uma
lista, receber mercadoria por fornecedor (inclusive parcial e com divergência) e
ver o estoque atualizado — com os mesmos números da versão desktop.

---

## Faseamento e verificação global

| Fase | Entrega | Verificação |
|---|---|---|
| 0 | `useIsMobile`, `mobile-ui.jsx`, `MobileApp` + bottom nav, fallback desktop | Shell mobile navega; `#/mobile` intacto; desktop inalterado |
| 1 | Estoque mobile | Consulta + entrada + alertas + pendências persistindo |
| 2 | Compras mobile | Recebimento (parcial/divergente) atualiza estoque |
| 3+ | Demais páginas (Requisições já pronta; Dashboard, Produção, Financeiro…) | Uma a uma, sempre com fallback |

**Riscos / atenção:**
- Não duplicar lógica de negócio — só layout. Se um cálculo estiver preso dentro
  do componente desktop, **extrair** para função/util reutilizável antes de copiar.
- Desktop **não pode** regredir: o gate `useIsMobile()` isola totalmente as telas.
- Regras Supabase (seção 5 do `CLAUDE.md`) não mudam — mobile usa as mesmas RPCs.
- Nada de commit/deploy sem pedido explícito (seção 6).

---

### Arquivos novos previstos
- `mobile-ui.jsx` — hook `useIsMobile` + kit de primitivos
- `mobile-shell.jsx` — `MobileApp` (top bar + bottom nav + drawer)
- `page-mobile-stock.jsx` — Estoque mobile
- `page-mobile-purchases.jsx` — Compras mobile
- (edições: `src/App.jsx`, `src/main.jsx`)
