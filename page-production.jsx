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
// Formulário de ORDEM DE SAÍDA (criar / editar rascunho)
// A ordem leva só os insumos que a produção retira do estoque. Os
// transformados devolvidos são lançados depois, na devolução.
// ---------------------------------------------------------------------
function ProductionOrderForm({ tid, stockItems, recipes, initial, nextCode, onClose, onSaved }) {
  const rawItems = (stockItems || []).filter((i) => i.itemKind !== "transformed");
  const byId = {};
  (stockItems || []).forEach((i) => { byId[i.id] = i; });

  const [inputs, setInputs] = useState(
    initial?.inputs?.length
      ? initial.inputs.map((l) => ({ itemId: l.itemId, qty: String(l.qty).replace(".", ",") }))
      : [{ itemId: "", qty: "" }]
  );
  const [notes, setNotes] = useState(initial?.notes || "");
  const [recipeId, setRecipeId] = useState("");
  const [saving, setSaving] = useState(false); // guard de duplo-clique

  const applyRecipe = (rid) => {
    setRecipeId(rid);
    const r = (recipes || []).find((x) => x.id === rid);
    if (!r) return;
    setInputs(r.inputs.map((l) => ({ itemId: l.itemId, qty: String(l.qty).replace(".", ",") })));
  };

  const setInput = (i, patch) => setInputs((cur) => cur.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  const validInputs = inputs
    .map((l) => ({ ...l, item: byId[l.itemId], qtyN: _prodParseNum(l.qty) }))
    .filter((l) => l.item && l.qtyN > 0);
  const estCost = validInputs.reduce((s, l) => s + l.qtyN * (l.item.cost || 0), 0);
  const overStock = validInputs.filter((l) => l.qtyN > (l.item.qty || 0));

  const canSave = validInputs.length > 0;

  const save = async (alsoIssue) => {
    if (saving || !canSave) return;
    setSaving(true);
    try {
      const payload = {
        code: initial?.code || nextCode,
        notes,
        inputs: validInputs.map((l) => ({ itemId: l.item.id, name: l.item.name, qty: l.qtyN, unit: l.item.unit })),
        outputs: [], // saídas são lançadas na devolução
      };
      let orderId = initial?.id || null;
      if (orderId) {
        const { error } = await dbReplaceProductionOrderLines(orderId, payload.inputs, [], { notes });
        if (error) throw error;
      } else {
        const { data, error } = await dbInsertProductionOrder(tid, payload);
        if (error) throw error;
        orderId = data.id;
      }
      if (alsoIssue) {
        const sess = await dbGetSession();
        const { error } = await dbIssueProductionOrder(orderId, sess?.user?.id);
        if (error) throw error;
        window.showToast?.("Saída lançada — a ordem fica aguardando o retorno da produção", { tone: "ok" });
      } else {
        window.showToast?.(initial ? "Rascunho atualizado" : "Rascunho criado", { tone: "ok" });
      }
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro ao salvar: ${e.message || e}`, { tone: "crit", ttl: 6000 });
      setSaving(false);
    }
  };

  const lineStyle = { display: "grid", gridTemplateColumns: "1fr 110px 90px 28px", gap: 8, alignItems: "center" };

  return (
    <Modal
      title={initial ? `Editar ${initial.code}` : "Nova ordem de saída"}
      subtitle="Os insumos saem do estoque no envio e a ordem fica aguardando o retorno. Os transformados devolvidos são lançados na devolução — é lá que o custo é convertido."
      width={640}
      onClose={saving ? undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn" data-size="sm" onClick={() => save(false)} disabled={saving || !canSave}>
            {saving ? "Carregando…" : "Salvar rascunho"}
          </button>
          <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={() => save(true)} disabled={saving || !canSave}>
            {saving ? "Carregando…" : "Lançar saída para produção"}
          </button>
        </>
      )}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {(recipes || []).length > 0 && !initial && (
          <FormRow label="Partir de receita de produção" hint="Pré-preenche insumos e saídas — você pode ajustar depois.">
            <select className="select" value={recipeId} onChange={(e) => applyRecipe(e.target.value)}>
              <option value="">— começar do zero —</option>
              {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </FormRow>
        )}

        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
            Insumos enviados à produção
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {inputs.map((l, i) => {
              const item = byId[l.itemId];
              const qtyN = _prodParseNum(l.qty);
              return (
                <div key={i} style={lineStyle}>
                  <select className="select" value={l.itemId} onChange={(e) => setInput(i, { itemId: e.target.value })}>
                    <option value="">— insumo —</option>
                    {rawItems.map((it) => (
                      <option key={it.id} value={it.id}>{it.name} · {it.qty.toLocaleString("pt-BR")} {it.unit} em estoque</option>
                    ))}
                  </select>
                  <input className="input" placeholder={`Qtd${item ? ` (${item.unit})` : ""}`}
                    value={l.qty} onChange={(e) => setInput(i, { qty: e.target.value })} inputMode="decimal" />
                  <span style={{ fontSize: 11.5, color: "var(--fg-2)", fontFamily: "var(--mono)", textAlign: "right" }}>
                    {item && qtyN > 0 ? _prodFmtBRL(qtyN * (item.cost || 0)) : "—"}
                  </span>
                  <button type="button" className="btn" data-variant="ghost" data-size="sm" title="Remover linha"
                    onClick={() => setInputs((cur) => cur.length > 1 ? cur.filter((_, k) => k !== i) : cur)}>
                    <I.X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
          <button type="button" className="btn" data-size="sm" style={{ marginTop: 8 }}
            onClick={() => setInputs((cur) => [...cur, { itemId: "", qty: "" }])}>
            <I.Plus size={12} /> Adicionar insumo
          </button>
          {overStock.length > 0 && (
            <div style={{
              display: "flex", gap: 10, alignItems: "flex-start", marginTop: 10,
              padding: "9px 12px", borderRadius: 4,
              background: "var(--warn-soft)", border: "1px solid var(--warn-line)",
            }}>
              <I.AlertTriangle size={14} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.5 }}>
                Sem saldo suficiente — o estoque vai ficar <strong>negativo</strong>:{" "}
                {overStock.map((l) => `${l.item.name} (${(l.item.qty - l.qtyN).toLocaleString("pt-BR")} ${l.item.unit})`).join(", ")}.
                {" "}A saída é lançada assim mesmo; regularize com a entrada da compra — os itens negativos aparecem em <strong>Estoque → Pendências de lançamento</strong>.
              </div>
            </div>
          )}
        </div>

        <FormRow label="Observações">
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
        </FormRow>

        <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4 }}>
          <span style={{ fontSize: 12, color: "var(--fg-2)" }}>Custo estimado dos insumos</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)", fontFamily: "var(--mono)" }}>{_prodFmtBRL(estCost)}</span>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Devolução da produção (issued → completed)
// A ordem de saída não pré-define transformados: aqui o usuário informa
// O QUE voltou e QUANTAS porções — o custo total dos insumos é convertido
// (rateado por peso quando volta mais de um transformado).
// ---------------------------------------------------------------------
function ProductionReturnModal({ order, stockItems, onClose, onSaved }) {
  const transformedItems = (stockItems || []).filter((i) => i.itemKind === "transformed");
  const byId = {};
  transformedItems.forEach((i) => { byId[i.id] = i; });

  // Rascunhos antigos (fluxo anterior) podem ter saídas pré-definidas — prefill.
  const [lines, setLines] = useState(() =>
    order.outputs?.length
      ? order.outputs.map((o) => ({ itemId: o.itemId, qty: o.expectedQty != null ? String(o.expectedQty) : "" }))
      : [{ itemId: "", qty: "" }]
  );
  const [saving, setSaving] = useState(false);

  const valid = lines
    .map((l) => ({ item: byId[l.itemId], qtyN: _prodParseNum(l.qty) }))
    .filter((l) => l.item && l.qtyN > 0);
  const multiMissingPortion = valid.length > 1 && valid.some((l) => !(l.item.portionQty > 0));
  const canSave = valid.length > 0 && !multiMissingPortion;
  const elapsed = _prodElapsed(order.issuedAt);

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
      const { error } = await dbCompleteProductionOrder(
        order.id,
        valid.map((l) => ({ itemId: l.item.id, name: l.item.name, returnedQty: l.qtyN })),
        sess?.user?.id
      );
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
              O que a produção devolveu
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {lines.map((l, i) => {
                const item = byId[l.itemId];
                const qtyN = _prodParseNum(l.qty);
                const prev = item && qtyN > 0 ? previews[item.id] : null;
                return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 110px 110px 28px", gap: 8, alignItems: "center" }}>
                    <select className="select" value={l.itemId}
                      onChange={(e) => setLines((cur) => cur.map((x, k) => k === i ? { ...x, itemId: e.target.value } : x))}>
                      <option value="">— transformado —</option>
                      {transformedItems.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name}{_portionLabel(it) ? ` · porção ${_portionLabel(it)}` : ""}
                        </option>
                      ))}
                    </select>
                    <input className="input" placeholder="Porções" value={l.qty} inputMode="decimal"
                      onChange={(e) => setLines((cur) => cur.map((x, k) => k === i ? { ...x, qty: e.target.value } : x))} />
                    <span style={{ fontSize: 11, color: "var(--fg-2)", fontFamily: "var(--mono)", textAlign: "right" }}>
                      {prev != null && isFinite(prev) ? `≈ ${_prodFmtBRL(prev)}/porção` : ""}
                    </span>
                    <button type="button" className="btn" data-variant="ghost" data-size="sm" title="Remover linha"
                      onClick={() => setLines((cur) => cur.length > 1 ? cur.filter((_, k) => k !== i) : cur)}>
                      <I.X size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
            <button type="button" className="btn" data-size="sm" style={{ marginTop: 8 }}
              onClick={() => setLines((cur) => [...cur, { itemId: "", qty: "" }])}>
              <I.Plus size={12} /> Adicionar transformado
            </button>
          </div>
        )}

        {multiMissingPortion && (
          <div style={{ fontSize: 12, color: "var(--warn)", padding: "8px 12px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 4 }}>
            Devolução com vários transformados: todos precisam ter <strong>porção definida</strong> (o custo é rateado por peso). Ajuste na aba Transformados.
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
function ProductionOrderDetail({ order, onClose, onEdit, onIssue, onReturn, onCancelOrder, onDelete, busy }) {
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
                Excluir rascunho
              </button>
              <button type="button" className="btn" data-size="sm" onClick={onEdit} disabled={busy}>Editar</button>
              <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={onIssue} disabled={busy}>
                {busy ? "Carregando…" : "Enviar à produção"}
              </button>
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
// Página raiz
// ---------------------------------------------------------------------
// Abas do módulo (Transformados virou parte da Produção em 2026-07-12)
const _PROD_VIEWS = [
  { id: "orders",   label: "Ordens de saída" },
  { id: "catalog",  label: "Transformados" },
  { id: "recipes",  label: "Receitas de produção" },
  { id: "insights", label: "Análises" },
];

function Production({ scope }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid] = useState(null);
  const [kind, setKind] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("orders");
  const [orders, setOrders] = useState([]);
  const [stockItems, setStockItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [supplyTransfers, setSupplyTransfers] = useState([]); // só central (Consumo por tenant)
  const [statusFilter, setStatusFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [editOrder, setEditOrder] = useState(null);
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
    setOrders(oRes?.data || []);
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

  const doIssue = async (order) => {
    if (busy) return;
    setBusy(true);
    try {
      const sess = await dbGetSession();
      const { error } = await dbIssueProductionOrder(order.id, sess?.user?.id);
      if (error) throw error;
      window.showToast?.("Ordem enviada à produção — insumos baixados do estoque", { tone: "ok" });
      setDetail(null);
      await reload();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
    }
    setBusy(false);
  };

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
        <div className="h-eyebrow" style={{ marginBottom: 6 }}>Central de produção</div>
        <h1 className="h-title">Produção & Porcionamento</h1>
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
        {view === "catalog" && (
          <TransformedCatalog tid={tid} stockItems={stockItems} categories={categories}
            orders={orders} onChanged={() => reload()} />
        )}
        {view === "recipes" && (
          <ProductionRecipesPanel tid={tid} stockItems={stockItems} recipes={recipes}
            onChanged={() => reload()} />
        )}
        {view === "insights" && <TransformedAnalytics orders={orders} />}
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
        return (
          <div className="stagger" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
              <div className="kpi">
                <span className="label">Aguardando devolução</span>
                <span className="value" style={oldestE?.tone === "crit" ? { color: "var(--crit)" } : oldestE?.tone === "warn" ? { color: "var(--warn)" } : undefined}>{waiting.length}</span>
                <span className="delta" data-tone={waiting.length ? alertTone : undefined}>
                  {oldest ? `mais antiga (${oldest.code}) há ${oldestE.label}` : "nenhuma ordem em aberto"}
                </span>
              </div>
              <div className="kpi">
                <span className="label">Valor em produção</span>
                <span className="value">{_prodFmtBRL(waitingValue)}</span>
                <span className="delta">insumos fora do estoque agora</span>
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
                  <strong>{waiting.length} {waiting.length === 1 ? "ordem aguardando" : "ordens aguardando"} devolução da produção</strong>
                  {" · "}{_prodFmtBRL(waitingValue)} em insumos fora do estoque — confira com a equipe se passar do turno.
                </div>
                <button className="btn" data-size="sm" onClick={() => { setStatusFilter("issued"); setDetail(oldest); }}>
                  Ver mais antiga
                </button>
              </div>
            )}

            <div className="card">
              <div className="card-header">
                <div>
                  <h3 className="card-title">Ordens de saída</h3>
                  <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
                    saída → aguardando devolução → devolvida · o custo dos insumos vira o custo das porções
                  </span>
                </div>
                <button className="btn" data-variant="primary" data-size="sm"
                  onClick={() => { setEditOrder(null); setShowForm(true); }}>
                  <I.Plus size={12} /> Nova ordem de saída
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

      {showForm && (
        <ProductionOrderForm
          tid={tid} stockItems={stockItems} recipes={recipes}
          initial={editOrder} nextCode={_nextProdCode(orders)}
          onClose={() => { setShowForm(false); setEditOrder(null); }}
          onSaved={async () => { setShowForm(false); setEditOrder(null); setDetail(null); await reload(); }}
        />
      )}

      {detail && !showForm && !returnFor && (
        <ProductionOrderDetail
          order={orders.find((o) => o.id === detail.id) || detail}
          busy={busy}
          onClose={() => setDetail(null)}
          onEdit={() => { setEditOrder(orders.find((o) => o.id === detail.id) || detail); setShowForm(true); }}
          onIssue={() => doIssue(detail)}
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
