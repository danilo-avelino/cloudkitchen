// Produção & Porcionamento · módulo 'production'
// Ordens de produção: draft → issued (baixa insumos) → completed (retorno porções).
// Movimentos usam reference_type='production_order' e NÃO compõem CMV — a ordem
// só converte valor (custo dos insumos ÷ porções devolvidas, rateado por peso).
// Spec: PRD-PRODUCAO-E-DISTRIBUICAO.md §4.

const _prodFmtBRL = (v) =>
  "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Parse pt-BR: aceita vírgula como decimal ("8,50"). Number("8,50") é NaN.
const _prodParseNum = (raw) => {
  if (raw == null) return 0;
  const s = String(raw).trim().replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

// Badges do design system (.badge com data-tone — dot + pílula padrão do app)
const _PROD_STATUS_META = {
  draft:     { label: "Rascunho",             tone: "neutral" },
  issued:    { label: "Aguardando devolução", tone: "warn" },
  completed: { label: "Devolvida",            tone: "ok" },
  cancelled: { label: "Cancelada",            tone: "crit" },
};

function ProdStatusBadge({ status }) {
  const m = _PROD_STATUS_META[status] || _PROD_STATUS_META.draft;
  return <span className="badge" data-tone={m.tone} style={{ whiteSpace: "nowrap" }}>{m.label}</span>;
}

// Tempo aguardando retorno da produção — etapa crítica de desvio, então o
// alerta escala com a idade: ok < 4h · warn 4–12h · crit ≥ 12h.
function _prodElapsed(fromIso) {
  if (!fromIso) return { label: "—", tone: "ok", ms: 0 };
  const ms = Date.now() - new Date(fromIso).getTime();
  const min = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  const label = d >= 1 ? `${d}d ${h % 24}h` : h >= 1 ? `${h}h ${min % 60}min` : `${min}min`;
  const tone = h >= 12 ? "crit" : h >= 4 ? "warn" : "ok";
  return { label, tone, ms };
}

// Pílula "há X" das ordens aguardando devolução (tom escala com a idade)
function ProdWaitingBadge({ issuedAt }) {
  const e = _prodElapsed(issuedAt);
  const tone = e.tone === "crit" ? "crit" : e.tone === "warn" ? "warn" : "neutral";
  return (
    <span className="badge" data-tone={tone} data-flat
      title={`Enviada à produção em ${issuedAt ? new Date(issuedAt).toLocaleString("pt-BR") : "—"}`}
      style={{ whiteSpace: "nowrap" }}>
      há {e.label}
    </span>
  );
}

// "PRD-0007" → próximo código a partir das ordens existentes
function _nextProdCode(orders) {
  let max = 0;
  for (const o of orders || []) {
    const m = /^PRD-(\d+)$/.exec(o.code || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `PRD-${String(max + 1).padStart(4, "0")}`;
}

// Rótulo da porção de um transformado ("100 g", "1,2 kg")
function _portionLabel(item) {
  if (!item || item.portionQty == null) return null;
  const q = Number(item.portionQty);
  const unit = item.portionUnit || "kg";
  const disp = unit === "kg" && q < 1 ? `${(q * 1000).toLocaleString("pt-BR")} g` :
    `${q.toLocaleString("pt-BR")} ${unit}`;
  return disp;
}

// ---------------------------------------------------------------------
// Devolução da produção (issued → completed)
// Quem devolve informa QUANTAS porções voltaram — não O QUE voltou: o item e a
// gramatura da porção são ditados pela receita, gravada na ordem como saída
// esperada. O custo total dos insumos é convertido nessas porções (rateado por
// peso quando volta mais de um transformado).
// ---------------------------------------------------------------------
function ProductionReturnModal({ order, stockItems, onClose, onSaved }) {
  const StockItemPicker = window.StockItemPicker;   // lazy · ver nota no batch modal
  const transformedItems = (stockItems || []).filter((i) => i.itemKind === "transformed");
  const byId = {};
  transformedItems.forEach((i) => { byId[i.id] = i; });

  // Ordem nascida de receita já carrega as saídas: as linhas ficam travadas e só
  // a quantidade é digitável. Ordem avulsa (criada sem receita) não tem o que
  // travar — só nela o transformado ainda é escolhido aqui.
  const fromRecipe = (order.outputs || []).length > 0;

  // A QUANTIDADE nasce em branco de propósito. Preencher com o esperado
  // transforma a devolução em confirmação: bastaria clicar para registrar o
  // rendimento teórico como se fosse contagem real, e a diferença viraria custo
  // nas porções sem ninguém perceber. Quem devolve conta.
  const [lines, setLines] = useState(() =>
    fromRecipe
      ? order.outputs.map((o) => ({ itemId: o.itemId, name: o.name, expectedQty: o.expectedQty, qty: "" }))
      : [{ itemId: "", qty: "" }]
  );
  const [saving, setSaving] = useState(false);

  const valid = lines
    .map((l) => ({ item: byId[l.itemId], qtyN: _prodParseNum(l.qty) }))
    .filter((l) => l.item && l.qtyN > 0);
  const multiMissingPortion = valid.length > 1 && valid.some((l) => !(l.item.portionQty > 0));
  const canSave = valid.length > 0 && !multiMissingPortion;
  const elapsed = _prodElapsed(order.issuedAt);
  // Peso de entrada indefinido = desperdício não fecha nesta ordem. Checagem
  // pelo cadastro ATUAL do insumo: é dele que o aproveitamento é derivado, então
  // cadastrar o peso agora ainda resolve esta ordem.
  const inputsNoWeight = (order.inputs || []).filter((l) => {
    const u = String(l.unit || "").toLowerCase();
    if (u === "kg" || u === "g") return false;
    const it = (stockItems || []).find((s) => s.id === l.itemId);
    return !(it && it.portionQty > 0);
  });

  // Prévia do custo por porção (espelha o rateio por peso do banco)
  const previews = (() => {
    const total = Number(order.totalInputCost) || 0;
    if (valid.length === 0) return {};
    if (valid.length === 1) {
      return { [valid[0].item.id]: total / valid[0].qtyN };
    }
    const weights = valid.map((l) => ({ id: l.item.id, qtyN: l.qtyN, w: l.qtyN * (l.item.portionQty || 0) }));
    const sumW = weights.reduce((s, x) => s + x.w, 0);
    if (sumW <= 0) return {};
    const out = {};
    for (const x of weights) out[x.id] = (total * x.w / sumW) / x.qtyN;
    return out;
  })();

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    try {
      const sess = await dbGetSession();
      // Linha travada sem retorno vai como 0, com o esperado preservado: sumir
      // com ela apagaria da ordem o que a receita mandava produzir e não voltou.
      const payload = fromRecipe
        ? lines.filter((l) => l.itemId).map((l) => ({
            itemId: l.itemId,
            name: byId[l.itemId]?.name || l.name,
            returnedQty: _prodParseNum(l.qty),
            expectedQty: l.expectedQty,
          }))
        : valid.map((l) => ({ itemId: l.item.id, name: l.item.name, returnedQty: l.qtyN }));
      const { error } = await dbCompleteProductionOrder(order.id, payload, sess?.user?.id);
      if (error) throw error;
      window.showToast?.("Devolução lançada — transformados no estoque com custo convertido", { tone: "ok" });
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro ao lançar devolução: ${e.message || e}`, { tone: "crit", ttl: 6000 });
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Devolução da produção · ${order.code}`}
      subtitle={`Custo total dos insumos: ${_prodFmtBRL(order.totalInputCost)} — vira o custo das porções devolvidas (rateado por peso quando volta mais de um transformado).`}
      width={560}
      onClose={saving ? undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={save} disabled={saving || !canSave}>
            {saving ? "Carregando…" : "Confirmar devolução"}
          </button>
        </>
      )}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ProdWaitingBadge issuedAt={order.issuedAt} />
          <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
            insumos retirados: {order.inputs.map((l) => `${l.name} (${l.qty.toLocaleString("pt-BR")} ${l.unit})`).join(", ")}
          </span>
        </div>

        {transformedItems.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--warn)", padding: "8px 12px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 4 }}>
            Nenhum transformado cadastrado — crie primeiro na aba <strong>Transformados</strong>.
          </div>
        ) : (
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
              Quantas porções voltaram
            </div>
            {fromRecipe && (
              <div style={{ fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.5, marginBottom: 8 }}>
                Os transformados e a gramatura da porção vêm da receita da ordem — informe só a contagem.
                O que não voltou fica registrado como zero.
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {lines.map((l, i) => {
                const item = byId[l.itemId];
                const qtyN = _prodParseNum(l.qty);
                const prev = item && qtyN > 0 ? previews[item.id] : null;
                const qtyInput = (
                  <input className="input" placeholder="Porções" value={l.qty} inputMode="decimal"
                    onChange={(e) => setLines((cur) => cur.map((x, k) => k === i ? { ...x, qty: e.target.value } : x))} />
                );
                const prevCell = (
                  <span style={{ fontSize: 11, color: "var(--fg-2)", fontFamily: "var(--mono)", textAlign: "right" }}>
                    {prev != null && isFinite(prev) ? `≈ ${_prodFmtBRL(prev)}/porção` : ""}
                  </span>
                );
                if (fromRecipe) {
                  const portion = _portionLabel(item);
                  return (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 110px 130px", gap: 8, alignItems: "center" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item?.name || l.name}
                        </div>
                        <div style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: portion ? "var(--fg-3)" : "var(--warn)" }}>
                          {portion ? `porção ${portion}` : "porção não cadastrada"}
                        </div>
                      </div>
                      {qtyInput}
                      {prevCell}
                    </div>
                  );
                }
                return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 110px 110px 28px", gap: 8, alignItems: "center" }}>
                    <StockItemPicker
                      items={transformedItems} value={l.itemId}
                      placeholder="Selecione um transformado…"
                      emptyLabel="Nenhum transformado encontrado"
                      disabledIds={lines.map((x) => x.itemId).filter(Boolean)}
                      onChange={(id) => setLines((cur) => cur.map((x, k) => k === i ? { ...x, itemId: id } : x))} />
                    {qtyInput}
                    {prevCell}
                    <button type="button" className="btn" data-variant="ghost" data-size="sm" title="Remover linha"
                      onClick={() => setLines((cur) => cur.length > 1 ? cur.filter((_, k) => k !== i) : cur)}>
                      <I.X size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
            {!fromRecipe && (
              <button type="button" className="btn" data-size="sm" style={{ marginTop: 8 }}
                onClick={() => setLines((cur) => [...cur, { itemId: "", qty: "" }])}>
                <I.Plus size={12} /> Adicionar transformado
              </button>
            )}
          </div>
        )}

        {multiMissingPortion && (
          <div style={{ fontSize: 12, color: "var(--warn)", padding: "8px 12px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 4 }}>
            Devolução com vários transformados: todos precisam ter <strong>porção definida</strong> (o custo é rateado por peso). Ajuste na aba Transformados.
          </div>
        )}

        {inputsNoWeight.length > 0 && (
          <div style={{ fontSize: 12, color: "var(--fg-1)", padding: "8px 12px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 4, lineHeight: 1.5 }}>
            <strong>Sem desperdício calculado nesta ordem.</strong>{" "}
            {inputsNoWeight.map((l) => l.name).join(", ")} {inputsNoWeight.length === 1 ? "está cadastrado" : "estão cadastrados"} em
            unidade, sem <strong>peso por unidade</strong> — preencha em <strong>Estoque</strong> e o aproveitamento
            desta ordem (e das anteriores) passa a ser calculado.
          </div>
        )}

        <div style={{ fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
          Voltou menos que o enviado? O desperdício fica <strong>absorvido no custo</strong> da porção (nada vira perda no CMV) e aparece na aba Análises — o aproveitamento % denuncia desvios.
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Detalhe da ordem
// ---------------------------------------------------------------------
function ProductionOrderDetail({ order, onClose, onReturn, onCancelOrder, onDelete, busy }) {
  const m = _PROD_STATUS_META[order.status] || _PROD_STATUS_META.draft;
  const th = { fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--line)" };
  const td = { fontSize: 12.5, color: "var(--fg-1)", padding: "7px 8px", borderBottom: "1px solid var(--line-soft)" };

  return (
    <Modal
      title={`Ordem ${order.code}`}
      subtitle={order.notes || null}
      width={640}
      onClose={busy ? undefined : onClose}
      footer={(
        <>
          {order.status === "draft" && (
            <>
              <button type="button" className="btn" data-variant="danger" data-size="sm" onClick={onDelete} disabled={busy} style={{ marginRight: "auto" }}>
                Excluir solicitação
              </button>
              {/* A entrega (que baixa os insumos) mora no módulo Requisições —
                  um caminho só, para a fila de separação não ser furada aqui. */}
              <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
                separação e entrega em <strong style={{ color: "var(--fg-2)" }}>Requisições</strong>
              </span>
              <button type="button" className="btn" data-size="sm" onClick={onClose}>Fechar</button>
            </>
          )}
          {order.status === "issued" && (
            <>
              <button type="button" className="btn" data-variant="danger" data-size="sm" onClick={onCancelOrder} disabled={busy} style={{ marginRight: "auto" }}>
                Cancelar ordem
              </button>
              <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={onReturn} disabled={busy}>
                {busy ? "Carregando…" : "Lançar devolução"}
              </button>
            </>
          )}
          {(order.status === "completed" || order.status === "cancelled") && (
            <button type="button" className="btn" data-size="sm" onClick={onClose}>Fechar</button>
          )}
        </>
      )}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <ProdStatusBadge status={order.status} />
          {order.status === "issued" && <ProdWaitingBadge issuedAt={order.issuedAt} />}
          <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
            criada em {order.createdAt ? new Date(order.createdAt).toLocaleDateString("pt-BR") : "—"}
            {order.issuedAt ? ` · saída ${new Date(order.issuedAt).toLocaleString("pt-BR")}` : ""}
            {order.completedAt ? ` · devolvida ${new Date(order.completedAt).toLocaleString("pt-BR")}` : ""}
          </span>
        </div>

        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Insumos</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Insumo</th><th style={{ ...th, textAlign: "right" }}>Qtd</th><th style={{ ...th, textAlign: "right" }}>Custo un.</th><th style={{ ...th, textAlign: "right" }}>Total</th></tr></thead>
            <tbody>
              {order.inputs.map((l) => (
                <tr key={l.id}>
                  <td style={td}>{l.name}</td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--mono)" }}>{l.qty.toLocaleString("pt-BR")} {l.unit}</td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--mono)" }}>{order.status === "draft" ? "—" : _prodFmtBRL(l.unitCost)}</td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--mono)" }}>{order.status === "draft" ? "—" : _prodFmtBRL(l.lineCost)}</td>
                </tr>
              ))}
              <tr>
                <td style={{ ...td, fontWeight: 600, color: "var(--fg-0)" }} colSpan={3}>Custo total dos insumos</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "var(--mono)", fontWeight: 600, color: "var(--fg-0)" }}>
                  {_prodFmtBRL(order.totalInputCost != null ? order.totalInputCost : order.estCost)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {order.status === "issued" && order.outputs.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--fg-2)", padding: "10px 14px", background: "var(--bg-2)", border: "1px dashed var(--line)", borderRadius: 4 }}>
            Aguardando a produção devolver os transformados — use <strong>Lançar devolução</strong> quando os itens voltarem.
          </div>
        ) : order.outputs.length > 0 && (
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Transformados devolvidos</div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Transformado</th><th style={{ ...th, textAlign: "right" }}>Devolvido</th><th style={{ ...th, textAlign: "right" }}>Custo/porção</th><th style={{ ...th, textAlign: "right" }}>Custo total</th></tr></thead>
              <tbody>
                {order.outputs.map((l) => (
                  <tr key={l.id}>
                    <td style={td}>{l.name}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "var(--mono)" }}>{l.returnedQty != null ? l.returnedQty.toLocaleString("pt-BR") : "—"}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "var(--mono)" }}>{l.unitCost != null ? _prodFmtBRL(l.unitCost) : "—"}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "var(--mono)" }}>{l.costShare != null ? _prodFmtBRL(l.costShare) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {order.status === "completed" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
            <SummaryStat label="Aproveitamento" value={order.yieldPct != null ? `${order.yieldPct.toLocaleString("pt-BR")}%` : "—"} tone={order.yieldPct != null && order.yieldPct < 90 ? "warn" : "ok"} />
            <SummaryStat label="Desperdício" value={order.wasteQty != null ? `${order.wasteQty.toLocaleString("pt-BR", { maximumFractionDigits: 3 })} kg` : "—"} />
            <SummaryStat label="Peso devolvido" value={order.outputWeight != null ? `${order.outputWeight.toLocaleString("pt-BR", { maximumFractionDigits: 3 })} kg` : "—"} />
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// SOLICITAÇÃO DE INSUMOS · primeira das duas fases
// ---------------------------------------------------------------------
// Este modal só CRIA a ordem em 'draft'. Nada sai do estoque aqui: a ordem cai
// na fila do módulo Requisições (pendente → separada → entregue) e é a entrega
// que dispara draft → issued, baixando os insumos e congelando o custo.
//
// O motivo de não fechar tudo num clique: no instante do pedido ninguém sabe
// quantas porções vão voltar — só o teórico da receita. Fechar aqui gravaria o
// rendimento esperado como se fosse real e o custo por porção sairia errado.
// As porções reais entram na devolução (ProductionReturnModal), que é quando o
// banco rateia o custo por peso e grava o unit_cost de verdade.
//
// A receita entra como PADRÃO: traz o insumo teórico E o rendimento esperado
// (production_recipe_outputs.expected_qty), que fica gravado na ordem só para a
// variância ser medida contra ele depois.
function ProductionRequestModal({ tid, stockItems, recipes, nextCode, initialRecipeId, initialBatches, onClose, onSaved }) {
  // Combobox com busca — mesmo componente do modal de Requisições. Lido do
  // window aqui dentro (lazy): page-requests.jsx carrega DEPOIS deste arquivo.
  const StockItemPicker = window.StockItemPicker;
  const rawItems = (stockItems || []).filter((i) => i.itemKind !== "transformed");
  const byId = {};
  (stockItems || []).forEach((i) => { byId[i.id] = i; });

  // Vindo de "Produzir hoje" a receita já chega escolhida, junto com o nº de
  // lotes que repõe o estoque até o máximo — o padrão dela é carregado já
  // escalado no primeiro render, em vez de exigir novo clique.
  const seed = (recipes || []).find((r) => r.id === initialRecipeId) || null;
  const seedN = initialBatches > 0 ? initialBatches : 1;
  const seedLines = (arr, key) => (arr || []).map((l) => ({
    itemId: l.itemId,
    qty: l[key] != null ? String(Number((l[key] * seedN).toFixed(4))).replace(".", ",") : "",
  }));
  const [recipeId, setRecipeId] = useState(seed ? seed.id : "");
  const [batches, setBatches] = useState(seed ? String(seedN) : "1");
  const [inputs, setInputs] = useState(seed ? seedLines(seed.inputs, "qty") : [{ itemId: "", qty: "" }]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState("");   // rótulo do progresso durante o save

  const recipe = (recipes || []).find((r) => r.id === recipeId) || null;
  const batchN = _prodParseNum(batches) || 0;

  // Só a receita define o rendimento esperado — não é digitável. Sem receita não
  // há expectativa nenhuma, e a ordem vai sem saída pré-declarada (os
  // transformados aparecem na devolução, que é onde o número real existe).
  const expectedOutputs = (recipe?.outputs || [])
    .map((l) => ({ item: byId[l.itemId], expected: l.expectedQty != null ? l.expectedQty * batchN : null }))
    .filter((l) => l.item && l.expected > 0);

  // Aplica a receita × nº de lotes nos insumos. O rendimento esperado sai de
  // expectedOutputs, derivado da mesma receita.
  const applyRecipe = (rid, n) => {
    const r = (recipes || []).find((x) => x.id === rid);
    if (!r) { setInputs([{ itemId: "", qty: "" }]); return; }
    const mult = _prodParseNum(n) || 1;
    const fmt = (v) => String(Number((v * mult).toFixed(4))).replace(".", ",");
    setInputs(r.inputs.map((l) => ({ itemId: l.itemId, qty: fmt(l.qty) })));
  };
  const pickRecipe = (rid) => { setRecipeId(rid); applyRecipe(rid, batches); };
  const setBatchCount = (v) => { setBatches(v); if (recipeId) applyRecipe(recipeId, v); };

  const setLine = (i, patch) =>
    setInputs((cur) => cur.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const addLine = () => setInputs((cur) => [...cur, { itemId: "", qty: "" }]);
  const dropLine = (i) => setInputs((cur) => cur.length > 1 ? cur.filter((_, k) => k !== i) : cur);

  const validIn = inputs
    .map((l) => ({ ...l, item: byId[l.itemId], qtyN: _prodParseNum(l.qty) }))
    .filter((l) => l.item && l.qtyN > 0);

  const estCost = validIn.reduce((s, l) => s + l.qtyN * (l.item.cost || 0), 0);
  const overStock = validIn.filter((l) => l.qtyN > (l.item.qty || 0));
  const expectedPortions = expectedOutputs.reduce((s, l) => s + l.expected, 0);
  // Insumo em unidade sem peso cadastrado: o lote inteiro fica sem peso de
  // entrada e o desperdício não fecha. Melhor avisar agora, com tempo de
  // cadastrar, do que descobrir no KPI vazio depois.
  const noWeight = validIn.filter((l) => {
    const u = String(l.item.unit || "").toLowerCase();
    return u !== "kg" && u !== "g" && !(l.item.portionQty > 0);
  });

  // Variância de insumo: o que foi pedido vs. o teórico da receita. O lado do
  // rendimento não tem variância aqui — a expectativa É a receita.
  const variance = (() => {
    if (!recipe || batchN <= 0) return null;
    const theoIn = recipe.inputs.reduce((s, l) => s + (byId[l.itemId]?.cost || 0) * l.qty * batchN, 0);
    return {
      inPct: theoIn > 0 ? (estCost - theoIn) / theoIn * 100 : null,
      inBRL: estCost - theoIn,
      theoIn,
    };
  })();

  // O trigger do banco impõe rateio por peso quando há 2+ saídas: exige
  // portion_qty conversível em kg/g em TODAS elas, senão levanta exceção na
  // devolução. Avisamos já na solicitação para dar tempo de cadastrar.
  const multiNoPortion = expectedOutputs.length > 1
    ? expectedOutputs.filter((l) => !(l.item.portionQty > 0)) : [];
  const blockedMulti = multiNoPortion.length > 0;

  // A solicitação só exige os insumos. O rendimento esperado vem da receita e é
  // gravado só para a variância — o que voltou de verdade é informado na
  // devolução, e é de lá que sai o custo real da porção.
  const canSave = validIn.length > 0;

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    let orderId = null;
    try {
      setStep("Criando solicitação…");
      const { data, error } = await dbInsertProductionOrder(tid, {
        code: nextCode,
        notes: notes || (recipe ? `${recipe.name}${batchN !== 1 ? ` · ${batchN} lotes` : ""}` : null),
        inputs:  validIn.map((l) => ({ itemId: l.item.id, name: l.item.name, qty: l.qtyN, unit: l.item.unit })),
        // expected_qty: o padrão da receita fica gravado na ordem — é contra ele
        // que a variância é medida depois, na aba Análises.
        outputs: expectedOutputs.map((l) => ({
          itemId: l.item.id, name: l.item.name, expectedQty: l.expected,
        })),
      });
      if (error) throw error;
      orderId = data.id;

      // Nada de baixa aqui: a ordem nasce 'draft' e vai para a fila do módulo
      // Requisições. O estoque só sai quando a cozinha entrega (draft → issued).
      window.showToast?.(
        `Solicitação ${data.code || ""} enviada para Requisições · ${_prodFmtBRL(estCost)} em insumos`,
        { tone: "ok", ttl: 5000 },
      );
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro ao solicitar: ${e.message || e}`, { tone: "crit", ttl: 7000 });
      setSaving(false);
      setStep("");
      if (orderId) onSaved();
    }
  };

  const lineStyle = { display: "grid", gridTemplateColumns: "1fr 110px 90px 28px", gap: 8, alignItems: "center" };
  const secLabel = { fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 };

  return (
    <Modal
      title="Solicitar insumos para produção"
      subtitle="A solicitação vai para o módulo Requisições. Os insumos só saem do estoque quando a cozinha entregar — e as porções reais são informadas depois, na devolução."
      width={680}
      onClose={saving ? undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={save} disabled={saving || !canSave}>
            {saving ? (step || "Carregando…") : "Enviar para Requisições"}
          </button>
        </>
      )}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {(recipes || []).length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 12 }}>
            <FormRow label="Receita de produção" hint="Traz insumo teórico e rendimento esperado.">
              <select className="select" value={recipeId} onChange={(e) => pickRecipe(e.target.value)}>
                <option value="">— sem receita (lançamento avulso) —</option>
                {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </FormRow>
            <FormRow label="Lotes">
              <input className="input mono" value={batches} inputMode="decimal"
                onChange={(e) => setBatchCount(e.target.value)} style={{ textAlign: "right" }}
                disabled={!recipeId} />
            </FormRow>
          </div>
        )}

        <div>
          <div style={secLabel}>Insumos a separar</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {inputs.map((l, i) => {
              const item = byId[l.itemId];
              const qtyN = _prodParseNum(l.qty);
              return (
                <div key={i} style={lineStyle}>
                  <StockItemPicker
                    items={rawItems} value={l.itemId}
                    placeholder="Selecione um insumo…"
                    disabledIds={inputs.map((x) => x.itemId).filter(Boolean)}
                    onChange={(id) => setLine(i, { itemId: id })} />
                  <input className="input mono" placeholder={`Qtd${item ? ` (${item.unit})` : ""}`} value={l.qty}
                    onChange={(e) => setLine(i, { qty: e.target.value })} inputMode="decimal" style={{ textAlign: "right" }} />
                  <span style={{ fontSize: 11.5, color: "var(--fg-2)", fontFamily: "var(--mono)", textAlign: "right" }}>
                    {item && qtyN > 0 ? _prodFmtBRL(qtyN * (item.cost || 0)) : "—"}
                  </span>
                  <button type="button" className="btn" data-variant="ghost" data-size="sm" title="Remover linha"
                    onClick={() => dropLine(i)}><I.X size={11} /></button>
                </div>
              );
            })}
          </div>
          <button type="button" className="btn" data-size="sm" style={{ marginTop: 8 }} onClick={addLine}>
            <I.Plus size={12} /> Adicionar insumo
          </button>
        </div>

        {/* Leitura pura: a expectativa é a receita × lotes. Sem receita não há o
            que exibir — os transformados entram na devolução. */}
        {expectedOutputs.length > 0 && (
          <div>
            <div style={secLabel}>Rendimento esperado</div>
            <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 8, lineHeight: 1.5 }}>
              Pela receita, {batchN.toLocaleString("pt-BR")} {batchN === 1 ? "lote" : "lotes"}. Serve só para
              medir variância — quantas porções voltaram de verdade você informa na devolução.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {expectedOutputs.map((l) => (
                <div key={l.item.id} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "7px 10px", borderRadius: 4,
                  background: "var(--bg-2)", border: "1px solid var(--line-soft)",
                }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "var(--fg-1)" }}>{l.item.name}</span>
                  {_portionLabel(l.item) && (
                    <span style={{ fontSize: 10.5, color: "var(--fg-3)" }}>porção {_portionLabel(l.item)}</span>
                  )}
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-0)", fontWeight: 600 }}>
                    {l.expected.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Aviso, não bloqueio: a porção só é obrigatória na devolução (é lá que
            o rateio por peso roda), e até lá dá tempo de cadastrar. */}
        {blockedMulti && (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 12px", borderRadius: 4,
                        background: "var(--warn-soft)", border: "1px solid var(--warn-line)" }}>
            <I.AlertTriangle size={14} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.5 }}>
              Voltando mais de um transformado, o custo é rateado por peso — então{" "}
              <strong>{multiNoPortion.map((l) => l.item.name).join(", ")}</strong>{" "}
              {multiNoPortion.length === 1 ? "vai precisar" : "vão precisar"} de porção definida (em kg ou g)
              na aba <strong>Transformados</strong> antes da devolução ser aceita.
            </div>
          </div>
        )}

        {noWeight.length > 0 && (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 12px", borderRadius: 4,
                        background: "var(--warn-soft)", border: "1px solid var(--warn-line)" }}>
            <I.AlertTriangle size={14} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.5 }}>
              Sem <strong>peso por unidade</strong> em {noWeight.map((l) => l.item.name).join(", ")} — cadastre
              em <strong>Estoque</strong> para esta produção calcular desperdício e aproveitamento.
              Um insumo sem peso zera a conta do lote inteiro.
            </div>
          </div>
        )}

        {overStock.length > 0 && (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 12px", borderRadius: 4,
                        background: "var(--warn-soft)", border: "1px solid var(--warn-line)" }}>
            <I.AlertTriangle size={14} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.5 }}>
              Saldo atual não cobre a solicitação — na <strong>entrega</strong> o estoque vai ficar negativo:{" "}
              {overStock.map((l) => `${l.item.name} (${(l.item.qty - l.qtyN).toLocaleString("pt-BR")} ${l.item.unit})`).join(", ")}.
              {" "}Regularize com a entrada da compra — os negativos aparecem em <strong>Estoque → Pendências de lançamento</strong>.
            </div>
          </div>
        )}

        <FormRow label="Observações">
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder={recipe ? recipe.name : "Opcional"} />
        </FormRow>

        <div style={{ display: "grid", gridTemplateColumns: variance ? "repeat(3, 1fr)" : "1fr", gap: 8 }}>
          <SummaryStat label="Custo dos insumos" value={_prodFmtBRL(estCost)} />
          {variance && (
            <div>
              <SummaryStat
                label="Variância de insumo"
                value={variance.inPct == null ? "—" : `${variance.inPct > 0 ? "+" : ""}${variance.inPct.toFixed(1)}%`}
                tone={variance.inPct == null || Math.abs(variance.inPct) < 2 ? undefined : "warn"} />
              {variance.inPct != null && (
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>
                  {variance.inBRL >= 0 ? "+" : "−"}{_prodFmtBRL(Math.abs(variance.inBRL))} vs. receita
                </span>
              )}
            </div>
          )}
          {variance && (
            <div>
              {/* Custo/porção teórico. O real sai na devolução, quando o custo
                  dos insumos é dividido pelas porções que voltaram de fato. */}
              <SummaryStat
                label="Custo/porção teórico"
                value={expectedPortions > 0 ? _prodFmtBRL(estCost / expectedPortions) : "—"} />
              {expectedPortions > 0 && (
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>
                  se voltarem {expectedPortions.toLocaleString("pt-BR")} porções
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// PRODUZIR HOJE · política mín/máx dos transformados
// ---------------------------------------------------------------------
// Os dois níveis já existiam em stock_items: reorder_point (mín, exposto pelo
// mapper como `reorder`) e max_qty (máx). O gatilho é o mínimo — saldo ≤ mín
// entra na lista — e a reposição vai até o máximo.
//
// A receita produz em LOTES inteiros (rendimento do lote = expectedQty da
// saída correspondente), então a quantidade bruta (máx − saldo) é arredondada
// para um número inteiro de lotes. Passar do máximo é permitido desde que a
// sobra não ultrapasse 50% de um lote — Math.round() faz exatamente esse
// corte (fração ≥ 0,5 sobe; sobra = lote × (1 − fração) ≤ 0,5 lote).
//
// Exposto no window porque page-mobile-production.jsx repete a lista e não
// pode importar daqui (esbuild trata cada .jsx como módulo strict).
function planProduction(item, recipe) {
  const qty = Number(item.qty) || 0;
  const min = Number(item.reorder) || 0;
  const max = item.max != null && Number(item.max) > 0 ? Number(item.max) : null;
  // Sem máximo definido a reposição vai até o próprio mínimo; sem nenhum dos
  // dois não há o que planejar.
  const target = max != null ? max : (min > 0 ? min : null);
  if (target == null) return { min, max, target: null, rawNeed: null, produce: null, batches: null, lote: null, recipe, inputs: [] };

  const below   = qty <= min;
  const rawNeed = target - qty;
  const lote    = recipe
    ? (recipe.outputs.find((o) => o.itemId === item.id)?.expectedQty || 0)
    : 0;

  if (!below || rawNeed <= 0) {
    return { min, max, target, rawNeed, produce: 0, batches: null, lote, recipe, inputs: [] };
  }

  // Sem receita (ou receita sem rendimento) não há lote: produz o déficit cru.
  const batches = lote > 0 ? Math.max(1, Math.round(rawNeed / lote)) : null;
  const produce = batches != null ? batches * lote : rawNeed;

  // Insumos do plano = linha da receita × nº de lotes.
  const inputs = batches != null && recipe
    ? recipe.inputs.map((l) => ({ itemId: l.itemId, unit: l.unit, qty: l.qty * batches }))
    : [];

  return { min, max, target, rawNeed, produce, batches, lote, recipe, inputs };
}
window.planProduction = planProduction;

function ProduceTodayPanel({ stockItems, recipes, orders, onProduce, onReturn, onOpenOrder }) {
  const byId = {};
  (stockItems || []).forEach((i) => { byId[i.id] = i; });

  // Ordens abertas: 'draft' ainda está na fila de Requisições (a separar ou
  // separada, aguardando entrega); 'issued' já retirou os insumos e deve a
  // devolução. As duas ocupam a tela inicial porque são trabalho em aberto.
  const open = (orders || []).filter((o) => o.status === "draft" || o.status === "issued");
  const waiting  = open.filter((o) => o.status === "issued");
  const queued   = open.filter((o) => o.status === "draft");
  // Transformado que já tem lote a caminho não deve ser pedido de novo sem o
  // operador saber — a linha ganha um aviso em vez de sumir da lista.
  const inFlight = new Set();
  open.forEach((o) => (o.outputs || []).forEach((l) => l.itemId && inFlight.add(l.itemId)));

  const rows = (stockItems || [])
    .filter((i) => i.itemKind === "transformed")
    .map((i) => {
      const recipe = (recipes || []).find((r) => r.outputs.some((o) => o.itemId === i.id)) || null;
      return { item: i, recipe, plan: planProduction(i, recipe) };
    })
    .sort((a, b) => {
      // Sem parâmetro vai pro fim; entre os demais, maior déficit relativo primeiro.
      if (a.plan.target == null && b.plan.target == null) return a.item.name.localeCompare(b.item.name);
      if (a.plan.target == null) return 1;
      if (b.plan.target == null) return -1;
      const ra = a.plan.target > 0 ? (a.plan.rawNeed || 0) / a.plan.target : 0;
      const rb = b.plan.target > 0 ? (b.plan.rawNeed || 0) / b.plan.target : 0;
      return rb - ra;
    });

  const toProduce = rows.filter((r) => r.plan.produce > 0);
  const ok        = rows.filter((r) => r.plan.target != null && !(r.plan.produce > 0));
  const noPar     = rows.filter((r) => r.plan.target == null);

  const th = { fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--line)" };
  const td = { fontSize: 12.5, color: "var(--fg-1)", padding: "8px 8px", borderBottom: "1px solid var(--line-soft)" };

  if (rows.length === 0 && open.length === 0) {
    return (
      <div className="card">
        <div className="card-body" style={{ padding: "40px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 6 }}>Nenhum transformado cadastrado.</div>
          <div style={{ fontSize: 12, color: "var(--fg-3)", maxWidth: 520, margin: "0 auto", lineHeight: 1.6 }}>
            Cadastre os itens que você produz na aba <strong>Transformados</strong>. Depois, defina o
            estoque mínimo e o máximo de cada um em <strong>Estoque</strong> — são eles que alimentam esta lista.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stagger" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {open.length > 0 && (
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">Em andamento</h3>
              <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
                {waiting.length} {waiting.length === 1 ? "lote aguardando devolução" : "lotes aguardando devolução"}
                {queued.length > 0 && ` · ${queued.length} na fila de Requisições`}
              </span>
            </div>
          </div>
          <table className="table" data-density="compact">
            <tbody>
              {[...waiting, ...queued].map((o) => {
                const isWaiting = o.status === "issued";
                const separated = !isWaiting && !!o.separatedAt;
                return (
                  <tr key={o.id}>
                    <td style={td}>
                      <div className="row-strong" style={{ fontFamily: "var(--mono)" }}>{o.code}</div>
                      <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2 }}>
                        {o.inputs.length} {o.inputs.length === 1 ? "insumo" : "insumos"}
                        {o.notes ? ` · ${o.notes}` : ""}
                      </div>
                    </td>
                    <td style={{ ...td, width: 200 }}>
                      {isWaiting
                        ? <ProdWaitingBadge issuedAt={o.issuedAt} />
                        : <span className="badge" data-tone={separated ? "info" : "warn"}>
                            {separated ? "separada · aguarda entrega" : "aguardando separação"}
                          </span>}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "var(--mono)", width: 120, color: "var(--fg-2)" }}>
                      {isWaiting ? _prodFmtBRL(o.totalInputCost) : ""}
                    </td>
                    <td style={{ ...td, textAlign: "right", width: 200 }}>
                      {isWaiting ? (
                        <button className="btn" data-variant="primary" data-size="sm" onClick={() => onReturn(o)}>
                          Registrar devolução
                        </button>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--fg-3)" }}>
                          entrega em <strong style={{ color: "var(--fg-2)" }}>Requisições</strong>
                        </span>
                      )}
                      <button className="btn" data-variant="ghost" data-size="sm" style={{ marginLeft: 6 }}
                              onClick={() => onOpenOrder(o)} title="Ver detalhes da ordem">
                        <I.ChevronR size={11} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Produzir hoje</h3>
            <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
              saldo ≤ mínimo · repõe até o máximo · {toProduce.length}{" "}
              {toProduce.length === 1 ? "item abaixo do mínimo" : "itens abaixo do mínimo"}
            </span>
          </div>
        </div>

        {toProduce.length === 0 ? (
          <div className="card-body" style={{ padding: "28px 20px", textAlign: "center", fontSize: 12.5, color: "var(--fg-2)" }}>
            Nenhum transformado no estoque mínimo. Nada a produzir.
          </div>
        ) : (
          <table className="table" data-density="compact">
            <thead>
              <tr>
                <th style={th}>Transformado</th>
                <th style={{ ...th, textAlign: "right" }}>Saldo</th>
                <th style={{ ...th, textAlign: "right" }}>Mínimo</th>
                <th style={{ ...th, textAlign: "right" }}>Máximo</th>
                <th style={{ ...th, textAlign: "right" }}>Produzir</th>
                <th style={th}>Receita</th>
                <th style={{ ...th, width: 120 }} />
              </tr>
            </thead>
            <tbody>
              {toProduce.map(({ item, recipe, plan }) => (
                <ProduceTodayRow key={item.id} item={item} recipe={recipe} plan={plan}
                                 byId={byId} td={td} onProduce={onProduce}
                                 inFlight={inFlight.has(item.id)} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(ok.length > 0 || noPar.length > 0) && (
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">Demais transformados</h3>
              <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
                {ok.length} acima do mínimo · {noPar.length} sem mínimo/máximo definido
              </span>
            </div>
          </div>
          <table className="table" data-density="compact">
            <tbody>
              {[...ok, ...noPar].map(({ item, plan }) => (
                <tr key={item.id}>
                  <td style={{ ...td, width: "22%" }}>{item.name}</td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "var(--mono)", color: "var(--fg-2)", width: 110 }}>
                    {(item.qty || 0).toLocaleString("pt-BR")} {item.unit}
                  </td>
                  <td style={{ ...td, minWidth: 160 }}>
                    {/* Sem mínimo nem máximo não há régua — a barra não teria escala. */}
                    {plan.target == null ? null : (
                      <TransformedLevelBar qty={item.qty} min={plan.min} max={plan.max} />
                    )}
                  </td>
                  <td style={{ ...td, textAlign: "right", width: 240 }}>
                    {plan.target == null
                      ? <span style={{ fontSize: 11, color: "var(--fg-3)" }}>defina mínimo e máximo em Estoque</span>
                      : <span className="badge" data-tone="ok">
                          acima do mínimo · mín {plan.min.toLocaleString("pt-BR")}
                          {plan.max != null ? ` · máx ${plan.max.toLocaleString("pt-BR")}` : ""}
                        </span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Barra de nível do transformado, com marcação de mínimo e máximo.
// A cor segue a MESMA regra do módulo Estoque (recomputeStatus em
// page-stock.jsx): zerado ou abaixo de 25% do mínimo = crítico, abaixo do
// mínimo = alerta, senão ok. Duplicar a regra aqui é proposital — o Estoque a
// aplica sobre o item cru; aqui ela vale sobre o transformado.
function TransformedLevelBar({ qty, min, max }) {
  const q = Number(qty) || 0;
  const tone = q <= 0 ? "crit"
             : (min > 0 && q < min * 0.25) ? "crit"
             : (min > 0 && q < min) ? "warn"
             : "ok";
  const color = tone === "crit" ? "var(--crit)" : tone === "warn" ? "var(--warn)" : "var(--ok)";

  // Escala com 15% de folga acima do máximo para o marcador não colar na borda;
  // estica quando o saldo passa disso, senão a sobra ficaria invisível.
  const top   = max > 0 ? max * 1.15 : (min > 0 ? min * 2 : 0);
  const scale = Math.max(top, q) || 1;
  const at    = (v) => Math.max(0, Math.min(100, (v / scale) * 100));

  // Marcas em cor de alta luminância: os tokens *-line são rgba ~25% e sumiriam
  // sobre a barra preenchida. Mínimo e máximo se distinguem pela posição (o
  // mínimo é sempre o da esquerda) e pelo tooltip.
  const tick = (v, label) => (
    <span title={label} style={{
      position: "absolute", left: `${at(v)}%`, top: -3, bottom: -3,
      width: 2, marginLeft: -1, background: "var(--fg-0)", borderRadius: 1,
    }} />
  );

  return (
    <div title={`saldo ${q.toLocaleString("pt-BR")}`}
         style={{ position: "relative", height: 6, borderRadius: 3, background: "var(--bg-3)" }}>
      <div style={{ width: `${at(q)}%`, height: "100%", borderRadius: 3, background: color, transition: "width 200ms" }} />
      {min > 0 && tick(min, `mínimo ${min.toLocaleString("pt-BR")}`)}
      {max > 0 && tick(max, `máximo ${max.toLocaleString("pt-BR")}`)}
    </div>
  );
}

// Linha do "Produzir hoje". Abre os insumos que o plano consome (receita × nº
// de lotes) para dar de ver, antes de abrir o modal, se o estoque cobre o lote.
function ProduceTodayRow({ item, recipe, plan, byId, td, onProduce, inFlight }) {
  const [open, setOpen] = useState(false);
  const pct = plan.target > 0 ? (item.qty || 0) / plan.target : 0;
  const over = plan.produce - plan.rawNeed;   // sobra acima do máximo (≤ 50% do lote)
  const fmt  = (v) => v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });

  const inputs = plan.inputs.map((l) => {
    const ing = byId[l.itemId];
    return { ...l, ing, short: ing ? l.qty > (ing.qty || 0) : false };
  });
  const missing = inputs.filter((l) => l.short);

  return (
    <>
      <tr>
        <td style={td}>
          <div className="row-strong">{item.name}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", marginTop: 2 }}>{item.cat}</div>
        </td>
        <td style={{ ...td, textAlign: "right", fontFamily: "var(--mono)", color: pct <= 0.25 ? "var(--crit)" : pct <= 0.6 ? "var(--warn)" : "var(--fg-1)" }}>
          {(item.qty || 0).toLocaleString("pt-BR")} {item.unit}
        </td>
        <td style={{ ...td, textAlign: "right", fontFamily: "var(--mono)", color: "var(--warn)" }}>
          {plan.min.toLocaleString("pt-BR")}
        </td>
        <td style={{ ...td, textAlign: "right", fontFamily: "var(--mono)", color: "var(--fg-3)" }}>
          {plan.max != null ? plan.max.toLocaleString("pt-BR") : "—"}
        </td>
        <td style={{ ...td, textAlign: "right", fontFamily: "var(--mono)" }}>
          <div style={{ fontWeight: 600, color: "var(--fg-0)" }}>{fmt(plan.produce)} {item.unit}</div>
          {plan.batches != null && (
            <div style={{ fontSize: 9.5, color: "var(--fg-3)", marginTop: 2 }}>
              {plan.batches} {plan.batches === 1 ? "lote" : "lotes"} de {fmt(plan.lote)}
              {over > 0 && (
                // Sobra acima do máximo. O arredondamento a mantém em ≤ 50% do
                // lote, exceto quando um único lote já estoura o máximo sozinho
                // — não dá pra produzir menos que um lote, então avisa.
                <span style={{ color: over > plan.lote / 2 ? "var(--warn)" : "var(--fg-3)" }}>
                  {" "}· +{fmt(over)} do máx
                </span>
              )}
            </div>
          )}
        </td>
        <td style={{ ...td, fontSize: 11.5 }}>
          {recipe ? (
            <button type="button" onClick={() => setOpen((v) => !v)}
                    style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--fg-2)", fontSize: 11.5, display: "flex", alignItems: "center", gap: 4, textAlign: "left" }}>
              <I.Chevron size={11} style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 120ms", flexShrink: 0 }} />
              {recipe.name}
            </button>
          ) : (
            <span style={{ fontStyle: "italic", color: "var(--fg-3)" }}>sem receita</span>
          )}
          {missing.length > 0 && (
            <div style={{ fontSize: 10, color: "var(--crit)", marginTop: 2 }}>
              {missing.length} {missing.length === 1 ? "insumo insuficiente" : "insumos insuficientes"}
            </div>
          )}
        </td>
        <td style={{ ...td, textAlign: "right" }}>
          <button className="btn" data-variant={inFlight ? "ghost" : "primary"} data-size="sm"
                  onClick={() => onProduce(recipe?.id || "", plan.batches)}
                  title={inFlight ? "Já existe um lote em andamento para este transformado" : undefined}>
            Solicitar insumos
          </button>
          {inFlight && (
            <div style={{ fontSize: 10, color: "var(--info)", marginTop: 3 }}>lote já em andamento</div>
          )}
        </td>
      </tr>
      {open && inputs.length > 0 && (
        <tr>
          <td style={{ ...td, padding: "0 8px 10px", background: "var(--bg-2)" }} colSpan={7}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", padding: "8px 0 6px" }}>
              Insumos para {plan.batches} {plan.batches === 1 ? "lote" : "lotes"}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {inputs.map((l) => (
                <div key={l.itemId} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11.5 }}>
                  <span style={{ color: "var(--fg-2)" }}>{l.ing ? l.ing.name : l.itemId}</span>
                  <span style={{ fontFamily: "var(--mono)", color: l.short ? "var(--crit)" : "var(--fg-1)", flexShrink: 0 }}>
                    {fmt(l.qty)} {l.unit || l.ing?.unit || ""}
                    <span style={{ color: "var(--fg-3)" }}>
                      {" "}· saldo {l.ing ? fmt(l.ing.qty || 0) : "—"}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------
// Página raiz
// ---------------------------------------------------------------------
// Abas do módulo (Transformados virou parte da Produção em 2026-07-12).
// Em 2026-08-09 a landing deixou de ser a lista de ordens e passou a ser
// "Produzir hoje": o módulo abre com uma decisão, não com um arquivo.
const _PROD_VIEWS = [
  { id: "today",    label: "Produzir hoje" },
  { id: "orders",   label: "Histórico" },
  { id: "catalog",  label: "Transformados" },
  { id: "recipes",  label: "Receitas de produção" },
  { id: "insights", label: "Análises" },
];

function Production({ scope }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid] = useState(null);
  const [kind, setKind] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("today");
  const [orders, setOrders] = useState([]);
  const [stockItems, setStockItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [supplyTransfers, setSupplyTransfers] = useState([]); // só central (Consumo por tenant)
  const [statusFilter, setStatusFilter] = useState("all");
  const [batchModal, setBatchModal] = useState(null); // { recipeId, batches } | null
  const [detail, setDetail] = useState(null);        // ordem aberta no modal
  const [returnFor, setReturnFor] = useState(null);  // ordem no modal de retorno
  const [confirm, setConfirm] = useState(null);      // { kind: 'cancel'|'delete', order }
  const [busy, setBusy] = useState(false);           // guard de duplo-clique das ações

  const reload = async (tenantId, tenantKind) => {
    const t = tenantId || tid;
    if (!t) return;
    const isCentral = (tenantKind || kind) === "distribution_center";
    const [oRes, sRes, cRes, rRes, tRes] = await Promise.all([
      dbListProductionOrders(t),
      dbListStockItems(t),
      dbListStockCategories(t),
      dbListProductionRecipes(t),
      isCentral && typeof dbSupplyListTransfers === "function"
        ? dbSupplyListTransfers(t)
        : Promise.resolve({ data: [] }),
    ]);
    // Peso/aproveitamento recalculados com o peso atual do estoque (o snapshot do
    // banco fica só como fallback) — cadastrar o peso depois conserta o histórico.
    const items = sRes?.data || [];
    setOrders((oRes?.data || []).map((o) => prodOrderWithLiveWeights(o, items)));
    // Sem isso a falha some: a lista de ordens fica vazia e parece "não tem nada
    // em andamento", quando na verdade a query quebrou.
    if (!oRes?.data && oRes?.error) {
      console.error("[produção] ordens não carregaram:", oRes.error);
      window.showToast?.(
        `Ordens de produção não carregaram: ${oRes.error.message || oRes.error}`,
        { tone: "crit", ttl: 8000 },
      );
    }
    setStockItems(sRes?.data || []);
    setCategories(cRes?.data || []);
    setRecipes(rRes?.data || []);
    setSupplyTransfers(tRes?.data || []);
  };

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const t = ctx?.tenant?.id || null;
      const k = ctx?.tenant?.kind || "standard";
      setTid(t);
      setKind(k);
      if (t) await reload(t, k);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  if (loading) return <PageLoading label="Carregando produção…" variant="table" />;

  if (!dbStatus.isOnline || !tid) {
    return (
      <div style={{ padding: "24px 28px" }}>
        <div style={{ fontSize: 12.5, color: "var(--warn)", padding: "10px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 4 }}>
          O módulo Produção só fica disponível com Supabase online.
        </div>
      </div>
    );
  }

  const doConfirm = async () => {
    if (busy || !confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "cancel") {
        const { error } = await dbCancelProductionOrder(confirm.order.id);
        if (error) throw error;
        window.showToast?.("Ordem cancelada — insumos devolvidos ao estoque", { tone: "ok" });
      } else {
        const { error } = await dbDeleteProductionOrder(confirm.order.id);
        if (error) throw error;
        window.showToast?.("Rascunho excluído", { tone: "ok" });
      }
      setConfirm(null);
      setDetail(null);
      await reload();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
    }
    setBusy(false);
  };

  const filtered = statusFilter === "all" ? orders : orders.filter((o) => o.status === statusFilter);
  const chips = [
    { id: "all",       label: "Todas" },
    { id: "draft",     label: "Rascunhos" },
    { id: "issued",    label: "Em produção" },
    { id: "completed", label: "Concluídas" },
    { id: "cancelled", label: "Canceladas" },
  ];

  const waitingCount = orders.filter((o) => o.status === "issued").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "20px 28px 0" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="h-eyebrow" style={{ marginBottom: 6 }}>Central de produção</div>
            <h1 className="h-title">Produção & Porcionamento</h1>
          </div>
          {/* Solicitação avulsa: produção que não veio da lista de mín/máx
              (pedido extra, evento, reposição fora de hora). */}
          <button className="btn" data-variant="primary" data-size="sm"
                  onClick={() => setBatchModal({ recipeId: "", batches: null })}>
            <I.Plus size={13} />Solicitar insumo para produção
          </button>
        </div>
        <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--line)", marginTop: 14 }}>
          {(kind === "distribution_center" ? [..._PROD_VIEWS, { id: "bytenant", label: "Consumo por tenant" }] : _PROD_VIEWS).map((v) => (
            <button key={v.id} onClick={() => setView(v.id)}
              style={{
                background: "none", border: "none", cursor: "pointer",
                padding: "8px 14px", fontSize: 13, marginBottom: -1,
                color: view === v.id ? "var(--fg-0)" : "var(--fg-3)",
                fontWeight: view === v.id ? 600 : 400,
                borderBottom: view === v.id ? "2px solid var(--accent-bright)" : "2px solid transparent",
                display: "inline-flex", alignItems: "center", gap: 6,
              }}>
              {v.label}
              {v.id === "orders" && waitingCount > 0 && (
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "1px 6px", background: "var(--accent-bright)", color: "var(--accent-fg)", borderRadius: 8, fontWeight: 500 }}>{waitingCount}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 32px" }}>
        {view === "today" && (
          <ProduceTodayPanel
            stockItems={stockItems} recipes={recipes} orders={orders}
            onProduce={(rid, batches) => setBatchModal({ recipeId: rid || "", batches })}
            onReturn={(order) => setReturnFor(order)}
            onOpenOrder={(order) => setDetail(order)} />
        )}
        {view === "catalog" && (
          <TransformedCatalog tid={tid} stockItems={stockItems} categories={categories}
            orders={orders} onChanged={() => reload()} />
        )}
        {view === "recipes" && (
          <ProductionRecipesPanel tid={tid} stockItems={stockItems} recipes={recipes}
            onChanged={() => reload()} />
        )}
        {view === "insights" && <TransformedAnalytics orders={orders} stockItems={stockItems} />}
        {view === "bytenant" && <TransformedByTenant tid={tid} transfers={supplyTransfers} />}

        {view === "orders" && (<>
      {(() => {
        // KPIs da produção · aguardando devolução é a etapa crítica de desvio
        const waiting = orders.filter((o) => o.status === "issued");
        const oldest = waiting.length
          ? waiting.reduce((a, b) => _prodElapsed(a.issuedAt).ms >= _prodElapsed(b.issuedAt).ms ? a : b)
          : null;
        const oldestE = oldest ? _prodElapsed(oldest.issuedAt) : null;
        const waitingValue = waiting.reduce((s, o) => s + (o.totalInputCost || 0), 0);
        const cutoff30 = Date.now() - 30 * 86400000;
        const done30 = orders.filter((o) => o.status === "completed" && o.completedAt && new Date(o.completedAt).getTime() >= cutoff30);
        const done30Value = done30.reduce((s, o) => s + (o.totalInputCost || 0), 0);
        const yields = done30.filter((o) => o.yieldPct != null);
        const avgYield = yields.length ? yields.reduce((s, o) => s + o.yieldPct, 0) / yields.length : null;
        const waste30 = done30.reduce((s, o) => s + (o.wasteQty || 0), 0);
        const wasteCost30 = done30.reduce((s, o) =>
          s + ((o.wasteQty || 0) > 0 && o.inputWeight > 0 ? o.wasteQty * ((o.totalInputCost || 0) / o.inputWeight) : 0), 0);
        const alertTone = oldestE?.tone === "crit" ? "down" : oldestE?.tone === "warn" ? "warn" : "up";
        // `waiting` deixou de ser fluxo normal (o registro de lote fecha as duas
        // transições de uma vez) e virou anomalia: só sobra aqui se o complete
        // falhar no meio, ou se for ordem legada do fluxo de duas fases.
        return (
          <div className="stagger" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
              <div className="kpi">
                <span className="label">Produções não concluídas</span>
                <span className="value" style={waiting.length ? { color: "var(--crit)" } : undefined}>{waiting.length}</span>
                <span className="delta" data-tone={waiting.length ? alertTone : undefined}>
                  {oldest ? `${oldest.code} parou há ${oldestE.label} — conclua` : "nenhuma pendência"}
                </span>
              </div>
              <div className="kpi">
                <span className="label">Valor travado</span>
                <span className="value">{_prodFmtBRL(waitingValue)}</span>
                <span className="delta">insumo baixado sem o produzido dar entrada</span>
              </div>
              <div className="kpi">
                <span className="label">Produções · 30 dias</span>
                <span className="value">{done30.length}</span>
                <span className="delta">{_prodFmtBRL(done30Value)} convertidos em porções</span>
              </div>
              <div className="kpi">
                <span className="label">Aproveitamento · 30 dias</span>
                <span className="value" style={avgYield != null && avgYield < 90 ? { color: "var(--warn)" } : undefined}>
                  {avgYield != null ? `${avgYield.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : "—"}
                </span>
                <span className="delta" data-tone={waste30 > 0 ? "warn" : undefined}>
                  {waste30 > 0
                    ? `desperdício ${waste30.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} kg · ${_prodFmtBRL(wasteCost30)}`
                    : "sem desperdício registrado"}
                </span>
              </div>
            </div>

            {waiting.length > 0 && (
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", borderRadius: 4,
                background: oldestE.tone === "crit" ? "var(--crit-soft)" : oldestE.tone === "warn" ? "var(--warn-soft)" : "var(--bg-2)",
                border: `1px solid ${oldestE.tone === "crit" ? "var(--crit-line)" : oldestE.tone === "warn" ? "var(--warn-line)" : "var(--line)"}`,
              }}>
                <I.AlertTriangle size={15} style={{ color: oldestE.tone === "crit" ? "var(--crit)" : oldestE.tone === "warn" ? "var(--warn)" : "var(--fg-2)", flexShrink: 0 }} />
                <div style={{ fontSize: 12.5, color: "var(--fg-0)", flex: 1 }}>
                  <strong>{waiting.length} {waiting.length === 1 ? "produção não concluída" : "produções não concluídas"}</strong>
                  {" · "}{_prodFmtBRL(waitingValue)} em insumo já baixado sem o produzido ter dado entrada.
                  {" "}Lance o que saiu da produção para fechar — enquanto isso o estoque está subavaliado.
                </div>
                <button className="btn" data-variant="primary" data-size="sm"
                  onClick={() => setReturnFor(oldest)}>
                  Concluir {oldest.code}
                </button>
              </div>
            )}

            <div className="card">
              <div className="card-header">
                <div>
                  <h3 className="card-title">Histórico de produções</h3>
                  <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
                    o custo dos insumos vira o custo do produzido · sem passar por CMV
                  </span>
                </div>
                <button className="btn" data-variant="primary" data-size="sm"
                  onClick={() => setBatchModal({ recipeId: "" })}>
                  <I.Plus size={12} /> Registrar produção
                </button>
              </div>

              <div style={{ display: "flex", gap: 6, padding: "10px 16px", borderBottom: "1px solid var(--line-soft)" }}>
                {chips.map((c) => {
                  const n = c.id === "all" ? orders.length : orders.filter((o) => o.status === c.id).length;
                  const active = statusFilter === c.id;
                  return (
                    <button key={c.id} onClick={() => setStatusFilter(c.id)} className="btn" data-size="sm"
                      style={active ? { background: "var(--bg-3)", color: "var(--fg-0)", borderColor: "var(--line-strong)" } : undefined}>
                      {c.label} {n > 0 && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: active ? "var(--fg-1)" : "var(--fg-3)" }}>{n}</span>}
                    </button>
                  );
                })}
              </div>

              {filtered.length === 0 ? (
                <div className="card-body" style={{ padding: "40px 20px", textAlign: "center" }}>
                  <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 6 }}>Nenhuma ordem de produção {statusFilter !== "all" ? "neste filtro" : "ainda"}.</div>
                  <div style={{ fontSize: 12, color: "var(--fg-3)", maxWidth: 560, margin: "0 auto", lineHeight: 1.6 }}>
                    Fluxo: lance a <strong>ordem de saída</strong> (ex.: 10 kg de calabresa) — os insumos saem do estoque e a ordem fica aguardando.
                    Quando a produção devolver (ex.: 100 porções de 100 g), lance a <strong>devolução</strong> — o custo é convertido automaticamente, sem tocar no CMV.
                  </div>
                </div>
              ) : (
                <table className="table" data-density="compact">
                  <thead>
                    <tr>
                      <th style={{ width: 110 }}>Ordem</th>
                      <th>Insumos</th>
                      <th>Saídas</th>
                      <th className="num">Custo</th>
                      <th className="num">Aproveit.</th>
                      <th style={{ width: 200 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((o) => (
                      <tr key={o.id} onClick={() => setDetail(o)} style={{ cursor: "pointer" }}>
                        <td>
                          <div className="row-strong" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{o.code}</div>
                          <div style={{ fontSize: 10.5, color: "var(--fg-3)", fontFamily: "var(--mono)" }}>{o.createdAt ? new Date(o.createdAt).toLocaleDateString("pt-BR") : ""}</div>
                        </td>
                        <td className="dim">{o.inputs.map((l) => `${l.name} (${l.qty.toLocaleString("pt-BR")} ${l.unit})`).join(", ") || "—"}</td>
                        <td className="dim">
                          {o.status === "issued" && o.outputs.length === 0
                            ? <span style={{ color: "var(--fg-3)", fontStyle: "italic" }}>aguardando devolução</span>
                            : (o.outputs.map((l) => l.returnedQty != null ? `${l.name} · ${l.returnedQty.toLocaleString("pt-BR")} porções` : l.name).join(", ") || "—")}
                        </td>
                        <td className="num">{_prodFmtBRL(o.totalInputCost != null ? o.totalInputCost : o.estCost)}</td>
                        <td className="num" style={o.yieldPct != null && o.yieldPct < 90 ? { color: "var(--warn)" } : undefined}>
                          {o.yieldPct != null ? `${o.yieldPct.toLocaleString("pt-BR")}%` : "—"}
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                            <ProdStatusBadge status={o.status} />
                            {o.status === "issued" && <ProdWaitingBadge issuedAt={o.issuedAt} />}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        );
      })()}
        </>)}
      </div>

      {batchModal && (
        <ProductionRequestModal
          tid={tid} stockItems={stockItems} recipes={recipes}
          nextCode={_nextProdCode(orders)}
          initialRecipeId={batchModal.recipeId}
          initialBatches={batchModal.batches}
          onClose={() => setBatchModal(null)}
          onSaved={async () => { setBatchModal(null); setDetail(null); await reload(); }}
        />
      )}

      {detail && !batchModal && !returnFor && (
        <ProductionOrderDetail
          order={orders.find((o) => o.id === detail.id) || detail}
          busy={busy}
          onClose={() => setDetail(null)}
          onReturn={() => setReturnFor(orders.find((o) => o.id === detail.id) || detail)}
          onCancelOrder={() => setConfirm({ kind: "cancel", order: detail })}
          onDelete={() => setConfirm({ kind: "delete", order: detail })}
        />
      )}

      {returnFor && (
        <ProductionReturnModal
          order={returnFor}
          stockItems={stockItems}
          onClose={() => setReturnFor(null)}
          onSaved={async () => { setReturnFor(null); setDetail(null); await reload(); }}
        />
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === "cancel" ? "Cancelar ordem" : "Excluir rascunho"}
        message={confirm?.kind === "cancel"
          ? `Cancelar a ordem ${confirm?.order?.code}? Os insumos baixados voltam ao estoque com movimentos inversos.`
          : `Excluir o rascunho ${confirm?.order?.code}? Essa ação não pode ser desfeita.`}
        confirmLabel={confirm?.kind === "cancel" ? "Cancelar ordem" : "Excluir"}
        busy={busy}
        onConfirm={doConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

window.Production = Production;
