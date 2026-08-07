// page-mobile-production.jsx — Produção no celular (≤480px). Foco operacional:
// ordens de saída (draft → issued → completed). Reaproveita as funções db* do
// desktop (page-production.jsx): a saída baixa insumos no envio; a devolução
// converte o custo em porções. Gestão fina (Transformados/Receitas/Análises) fica
// no desktop. Só funciona online.

const _mpFmt = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _mpNum = (raw) => { if (raw == null) return 0; const s = String(raw).trim().replace(/\./g, "").replace(",", "."); const n = parseFloat(s); return Number.isFinite(n) ? n : 0; };
const _MP_STATUS = {
  draft: { label: "Rascunho", tone: "neutral" }, issued: { label: "Aguardando devolução", tone: "warn" },
  completed: { label: "Devolvida", tone: "ok" }, cancelled: { label: "Cancelada", tone: "crit" },
};
function _mpElapsed(fromIso) {
  if (!fromIso) return { label: "—", tone: "ok", ms: 0 };
  const ms = Date.now() - new Date(fromIso).getTime();
  const min = Math.max(0, Math.floor(ms / 60000)), h = Math.floor(min / 60), d = Math.floor(h / 24);
  const label = d >= 1 ? `${d}d ${h % 24}h` : h >= 1 ? `${h}h ${min % 60}min` : `${min}min`;
  return { label, tone: h >= 12 ? "crit" : h >= 4 ? "warn" : "ok", ms };
}
function _mpNextCode(orders) {
  let max = 0;
  for (const o of orders || []) { const m = /^PRD-(\d+)$/.exec(o.code || ""); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return `PRD-${String(max + 1).padStart(4, "0")}`;
}
function _mpPortion(item) {
  if (!item || item.portionQty == null) return null;
  const q = Number(item.portionQty), unit = item.portionUnit || "kg";
  return unit === "kg" && q < 1 ? `${(q * 1000).toLocaleString("pt-BR")} g` : `${q.toLocaleString("pt-BR")} ${unit}`;
}

function MobileProduction() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid] = useState(null);
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState([]);
  const [stockItems, setStockItems] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(null);      // { edit?: order } — criar/editar
  const [returnFor, setReturnFor] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind:'cancel'|'delete', order }
  const [busy, setBusy] = useState(false);

  const reload = async (t) => {
    const tenant = t || tid;
    if (!tenant) return;
    const [oRes, sRes, rRes] = await Promise.all([
      dbListProductionOrders(tenant), dbListStockItems(tenant), dbListProductionRecipes(tenant),
    ]);
    setOrders(oRes?.data || []); setStockItems(sRes?.data || []); setRecipes(rRes?.data || []);
  };

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const t = ctx?.tenant?.id || null;
      setTid(t);
      if (t) await reload(t);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  const filtered = statusFilter === "all" ? orders : orders.filter((o) => o.status === statusFilter);
  const counts = useMemo(() => ({
    all: orders.length,
    draft: orders.filter((o) => o.status === "draft").length,
    issued: orders.filter((o) => o.status === "issued").length,
    completed: orders.filter((o) => o.status === "completed").length,
    cancelled: orders.filter((o) => o.status === "cancelled").length,
  }), [orders]);

  const kpis = useMemo(() => {
    const waiting = orders.filter((o) => o.status === "issued");
    const waitingValue = waiting.reduce((s, o) => s + (o.totalInputCost || 0), 0);
    const cutoff30 = Date.now() - 30 * 86400000;
    const done30 = orders.filter((o) => o.status === "completed" && o.completedAt && new Date(o.completedAt).getTime() >= cutoff30);
    const yields = done30.filter((o) => o.yieldPct != null);
    const avgYield = yields.length ? yields.reduce((s, o) => s + o.yieldPct, 0) / yields.length : null;
    return { waiting: waiting.length, waitingValue, done30: done30.length, avgYield };
  }, [orders]);

  const doIssue = async (order) => {
    if (busy) return; setBusy(true);
    try {
      const sess = await dbGetSession();
      const { error } = await dbIssueProductionOrder(order.id, sess?.user?.id);
      if (error) throw error;
      window.showToast?.("Ordem enviada à produção — insumos baixados do estoque", { tone: "ok" });
      setDetail(null); await reload();
    } catch (e) { window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 }); }
    setBusy(false);
  };
  const doConfirm = async () => {
    if (busy || !confirm) return; setBusy(true);
    try {
      if (confirm.kind === "cancel") { const { error } = await dbCancelProductionOrder(confirm.order.id); if (error) throw error; window.showToast?.("Ordem cancelada — insumos devolvidos ao estoque", { tone: "ok" }); }
      else { const { error } = await dbDeleteProductionOrder(confirm.order.id); if (error) throw error; window.showToast?.("Rascunho excluído", { tone: "ok" }); }
      setConfirm(null); setDetail(null); await reload();
    } catch (e) { window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 }); }
    setBusy(false);
  };

  if (loading) return <PageLoading label="Carregando produção…" variant="table" />;
  if (!dbStatus.isOnline || !tid) {
    return <MobilePage><div style={{ padding: 24 }}><div style={{ fontSize: 12.5, color: "var(--warn)", padding: "12px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 8 }}>Produção só fica disponível com Supabase online.</div></div></MobilePage>;
  }

  return (
    <MobilePage>
      <SegTabs value={statusFilter} onChange={setStatusFilter} options={[
        { id: "all", label: "Todas", count: counts.all },
        { id: "draft", label: "Rascunhos", count: counts.draft || null },
        { id: "issued", label: "Em produção", count: counts.issued || null, tone: "warn" },
        { id: "completed", label: "Concluídas", count: counts.completed || null },
        { id: "cancelled", label: "Canceladas", count: counts.cancelled || null },
      ]} />

      <StatStrip stats={[
        { label: "Aguardando", value: kpis.waiting, tone: kpis.waiting > 0 ? "warn" : "ok", sub: "devolução" },
        { label: "Em produção", value: _mpFmt(kpis.waitingValue).replace(",00", ""), sub: "insumos fora" },
        { label: "Produções 30d", value: kpis.done30 },
        { label: "Aproveit. 30d", value: kpis.avgYield != null ? `${kpis.avgYield.toFixed(0)}%` : "—", tone: kpis.avgYield != null && kpis.avgYield < 90 ? "warn" : "ok" },
      ]} />

      <MobileScroll style={{ padding: "0 14px 12px" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13 }}>
            Nenhuma ordem {statusFilter !== "all" ? "neste filtro" : "ainda"}.<br />
            <span style={{ fontSize: 11.5 }}>Lance a saída dos insumos; quando a produção devolver, registre a devolução.</span>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filtered.map((o) => <ProdOrderCard key={o.id} order={o} onTap={() => setDetail(o)} />)}
          </div>
        )}
      </MobileScroll>

      <MobileBottomBar>
        <MPrimaryButton onClick={() => setForm({})}><I.Plus size={16} />Nova ordem de saída</MPrimaryButton>
      </MobileBottomBar>

      {detail && (
        <ProdOrderSheet
          order={orders.find((o) => o.id === detail.id) || detail}
          busy={busy}
          onClose={() => setDetail(null)}
          onEdit={() => { setForm({ edit: orders.find((o) => o.id === detail.id) || detail }); setDetail(null); }}
          onIssue={() => doIssue(detail)}
          onReturn={() => { setReturnFor(orders.find((o) => o.id === detail.id) || detail); setDetail(null); }}
          onCancelOrder={() => setConfirm({ kind: "cancel", order: detail })}
          onDelete={() => setConfirm({ kind: "delete", order: detail })}
        />
      )}

      {form && (
        <ProdOrderForm
          tid={tid} stockItems={stockItems} recipes={recipes}
          initial={form.edit || null} nextCode={_mpNextCode(orders)}
          onClose={() => setForm(null)}
          onSaved={async () => { setForm(null); setDetail(null); await reload(); }}
        />
      )}

      {returnFor && (
        <ProdReturnForm
          order={returnFor} stockItems={stockItems}
          onClose={() => setReturnFor(null)}
          onSaved={async () => { setReturnFor(null); setDetail(null); await reload(); }}
        />
      )}

      {confirm && (
        <BottomSheet
          title={confirm.kind === "cancel" ? "Cancelar ordem?" : "Excluir rascunho?"}
          subtitle={confirm.order.code}
          onClose={() => !busy && setConfirm(null)}
          footer={
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setConfirm(null)} disabled={busy} style={{ flex: 1, height: 50, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14, fontWeight: 600 }}>Voltar</button>
              <button onClick={doConfirm} disabled={busy} style={{ flex: 1, height: 50, borderRadius: 10, background: "var(--crit)", border: "none", color: "#fff", fontSize: 14, fontWeight: 600 }}>{busy ? "…" : (confirm.kind === "cancel" ? "Cancelar ordem" : "Excluir")}</button>
            </div>
          }
        >
          <div style={{ fontSize: 13, color: "var(--fg-2)" }}>
            {confirm.kind === "cancel"
              ? "Os insumos baixados voltam ao estoque com movimentos inversos."
              : "Essa ação não pode ser desfeita."}
          </div>
        </BottomSheet>
      )}
    </MobilePage>
  );
}

function ProdOrderCard({ order, onTap }) {
  const m = _MP_STATUS[order.status] || _MP_STATUS.draft;
  const el = order.status === "issued" ? _mpElapsed(order.issuedAt) : null;
  return (
    <MobileCard onClick={onTap}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-0)", fontWeight: 600 }}>{order.code}</span>
            {el && <MBadge tone={el.tone === "crit" ? "crit" : el.tone === "warn" ? "warn" : "neutral"}>há {el.label}</MBadge>}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {order.inputs.map((l) => l.name).join(", ") || "—"}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
          <MBadge tone={m.tone}>{m.label}</MBadge>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-0)", fontWeight: 600 }}>{_mpFmt(order.totalInputCost != null ? order.totalInputCost : order.estCost)}</span>
        </div>
      </div>
    </MobileCard>
  );
}

function ProdOrderSheet({ order, busy, onClose, onEdit, onIssue, onReturn, onCancelOrder, onDelete }) {
  const m = _MP_STATUS[order.status] || _MP_STATUS.draft;
  const Row = ({ l, draft }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.name}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-2)" }}>{l.qty.toLocaleString("pt-BR")} {l.unit}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-0)", fontWeight: 600, width: 84, textAlign: "right" }}>{draft ? "—" : _mpFmt(l.lineCost)}</span>
    </div>
  );
  const footer = (
    order.status === "draft" ? (
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onDelete} disabled={busy} style={{ height: 50, padding: "0 14px", borderRadius: 10, background: "transparent", border: "1px solid var(--crit-line)", color: "var(--crit)", fontSize: 14, fontWeight: 600 }}>Excluir</button>
        <button onClick={onEdit} disabled={busy} style={{ height: 50, padding: "0 14px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14, fontWeight: 600 }}>Editar</button>
        <div style={{ flex: 1 }}><MPrimaryButton onClick={onIssue} loading={busy}><I.Play size={15} />Enviar</MPrimaryButton></div>
      </div>
    ) : order.status === "issued" ? (
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onCancelOrder} disabled={busy} style={{ height: 50, padding: "0 14px", borderRadius: 10, background: "transparent", border: "1px solid var(--crit-line)", color: "var(--crit)", fontSize: 14, fontWeight: 600 }}>Cancelar</button>
        <div style={{ flex: 1 }}><MPrimaryButton onClick={onReturn} loading={busy}><I.Box size={15} />Lançar devolução</MPrimaryButton></div>
      </div>
    ) : null
  );
  return (
    <BottomSheet title={`Ordem ${order.code}`} subtitle={order.notes || null} onClose={onClose} footer={footer}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <MBadge tone={m.tone}>{m.label}</MBadge>
        {order.status === "issued" && (() => { const e = _mpElapsed(order.issuedAt); return <MBadge tone={e.tone === "crit" ? "crit" : e.tone === "warn" ? "warn" : "neutral"}>há {e.label}</MBadge>; })()}
      </div>
      <MSectionLabel>Insumos</MSectionLabel>
      <div style={{ marginTop: 6 }}>
        {order.inputs.map((l) => <Row key={l.id} l={l} draft={order.status === "draft"} />)}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0 2px", fontSize: 13 }}>
          <span style={{ color: "var(--fg-2)", fontWeight: 600 }}>Custo total dos insumos</span>
          <span style={{ fontFamily: "var(--mono)", color: "var(--fg-0)", fontWeight: 700 }}>{_mpFmt(order.totalInputCost != null ? order.totalInputCost : order.estCost)}</span>
        </div>
      </div>

      {order.status === "issued" && order.outputs.length === 0 && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--fg-2)", padding: "10px 12px", background: "var(--bg-2)", border: "1px dashed var(--line)", borderRadius: 8 }}>
          Aguardando a produção devolver — use <strong>Lançar devolução</strong> quando os itens voltarem.
        </div>
      )}
      {order.outputs.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <MSectionLabel>Transformados devolvidos</MSectionLabel>
          <div style={{ marginTop: 6 }}>
            {order.outputs.map((l) => (
              <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.name}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-2)" }}>{l.returnedQty != null ? l.returnedQty.toLocaleString("pt-BR") : "—"} porç.</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-0)", fontWeight: 600, width: 84, textAlign: "right" }}>{l.costShare != null ? _mpFmt(l.costShare) : "—"}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {order.status === "completed" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 14 }}>
          <CmvMiniStat label="Aproveit." value={order.yieldPct != null ? `${order.yieldPct.toLocaleString("pt-BR")}%` : "—"} />
          <CmvMiniStat label="Desperdício" value={order.wasteQty != null ? `${order.wasteQty.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}kg` : "—"} />
          <CmvMiniStat label="Devolvido" value={order.outputWeight != null ? `${order.outputWeight.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}kg` : "—"} />
        </div>
      )}
    </BottomSheet>
  );
}

function CmvMiniStat({ label, value }) {
  return (
    <div style={{ padding: "10px 8px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", textAlign: "center" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-3)", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, marginTop: 3, color: "var(--fg-0)" }}>{value}</div>
    </div>
  );
}

// ===== Form: criar/editar ordem de saída =====
function ProdOrderForm({ tid, stockItems, recipes, initial, nextCode, onClose, onSaved }) {
  const rawItems = (stockItems || []).filter((i) => i.itemKind !== "transformed");
  const byId = {}; (stockItems || []).forEach((i) => { byId[i.id] = i; });
  const [inputs, setInputs] = useState(initial?.inputs?.length ? initial.inputs.map((l) => ({ itemId: l.itemId, qty: String(l.qty).replace(".", ",") })) : [{ itemId: "", qty: "" }]);
  const [notes, setNotes] = useState(initial?.notes || "");
  const [recipeId, setRecipeId] = useState("");
  const [saving, setSaving] = useState(false);

  const applyRecipe = (rid) => { setRecipeId(rid); const r = (recipes || []).find((x) => x.id === rid); if (r) setInputs(r.inputs.map((l) => ({ itemId: l.itemId, qty: String(l.qty).replace(".", ",") }))); };
  const setInput = (i, patch) => setInputs((cur) => cur.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const valid = inputs.map((l) => ({ ...l, item: byId[l.itemId], qtyN: _mpNum(l.qty) })).filter((l) => l.item && l.qtyN > 0);
  const estCost = valid.reduce((s, l) => s + l.qtyN * (l.item.cost || 0), 0);
  const overStock = valid.filter((l) => l.qtyN > (l.item.qty || 0));
  const canSave = valid.length > 0;

  const save = async (alsoIssue) => {
    if (saving || !canSave) return; setSaving(true);
    try {
      const payload = { code: initial?.code || nextCode, notes, inputs: valid.map((l) => ({ itemId: l.item.id, name: l.item.name, qty: l.qtyN, unit: l.item.unit })), outputs: [] };
      let orderId = initial?.id || null;
      if (orderId) { const { error } = await dbReplaceProductionOrderLines(orderId, payload.inputs, [], { notes }); if (error) throw error; }
      else { const { data, error } = await dbInsertProductionOrder(tid, payload); if (error) throw error; orderId = data.id; }
      if (alsoIssue) { const sess = await dbGetSession(); const { error } = await dbIssueProductionOrder(orderId, sess?.user?.id); if (error) throw error; window.showToast?.("Saída lançada — ordem aguardando o retorno", { tone: "ok" }); }
      else window.showToast?.(initial ? "Rascunho atualizado" : "Rascunho criado", { tone: "ok" });
      onSaved();
    } catch (e) { window.showToast?.(`Erro ao salvar: ${e.message || e}`, { tone: "crit", ttl: 6000 }); setSaving(false); }
  };

  return (
    <FullSheet
      title={initial ? `Editar ${initial.code}` : "Nova ordem de saída"}
      subtitle={valid.length > 0 ? `${valid.length} insumo(s) · ${_mpFmt(estCost)}` : "Insumos enviados à produção"}
      onBack={saving ? undefined : onClose}
      footer={
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => save(false)} disabled={saving || !canSave} style={{ flex: 1, height: 52, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: canSave ? "var(--fg-1)" : "var(--fg-3)", fontSize: 14, fontWeight: 600 }}>{saving ? "…" : "Salvar rascunho"}</button>
          <div style={{ flex: 1 }}><MPrimaryButton onClick={() => save(true)} disabled={!canSave} loading={saving}><I.Play size={15} />Enviar</MPrimaryButton></div>
        </div>
      }
    >
      {(recipes || []).length > 0 && !initial && (
        <MField label="Partir de receita (opcional)" hint="Pré-preenche os insumos.">
          <select value={recipeId} onChange={(e) => applyRecipe(e.target.value)} style={mInput}>
            <option value="">— começar do zero —</option>
            {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </MField>
      )}

      <MSectionLabel>Insumos enviados à produção</MSectionLabel>
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        {inputs.map((l, i) => {
          const item = byId[l.itemId]; const qtyN = _mpNum(l.qty);
          return (
            <div key={i} style={{ padding: "10px 12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <select value={l.itemId} onChange={(e) => setInput(i, { itemId: e.target.value })} style={{ ...mInput, flex: 1, height: 40 }}>
                  <option value="">— insumo —</option>
                  {rawItems.map((it) => <option key={it.id} value={it.id}>{it.name} · {it.qty.toLocaleString("pt-BR")} {it.unit}</option>)}
                </select>
                {inputs.length > 1 && (
                  <button onClick={() => setInputs((cur) => cur.filter((_, k) => k !== i))} aria-label="Remover" style={{ width: 40, height: 40, borderRadius: 8, flexShrink: 0, background: "transparent", border: "1px solid var(--line)", color: "var(--fg-3)", display: "grid", placeItems: "center" }}><I.X size={14} /></button>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input value={l.qty} inputMode="decimal" placeholder={`Qtd${item ? ` (${item.unit})` : ""}`} onChange={(e) => setInput(i, { qty: e.target.value })} style={{ ...mInput, height: 40 }} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-2)", width: 96, textAlign: "right", flexShrink: 0 }}>{item && qtyN > 0 ? _mpFmt(qtyN * (item.cost || 0)) : "—"}</span>
              </div>
            </div>
          );
        })}
      </div>
      <button onClick={() => setInputs((cur) => [...cur, { itemId: "", qty: "" }])} style={{ marginTop: 10, height: 44, width: "100%", borderRadius: 10, background: "transparent", border: "1px dashed var(--line)", color: "var(--fg-2)", fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
        <I.Plus size={14} />Adicionar insumo
      </button>

      {overStock.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", gap: 8, padding: "10px 12px", borderRadius: 10, background: "var(--warn-soft)", border: "1px solid var(--warn-line)" }}>
          <I.AlertTriangle size={14} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.5 }}>Sem saldo — o estoque fica negativo em: {overStock.map((l) => l.item.name).join(", ")}. A saída é lançada assim mesmo; regularize com a compra.</div>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <MField label="Observações (opcional)"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="—" style={mInput} /></MField>
      </div>
    </FullSheet>
  );
}

// ===== Form: devolução da produção =====
function ProdReturnForm({ order, stockItems, onClose, onSaved }) {
  const transformed = (stockItems || []).filter((i) => i.itemKind === "transformed");
  const byId = {}; transformed.forEach((i) => { byId[i.id] = i; });
  const [lines, setLines] = useState(() => order.outputs?.length ? order.outputs.map((o) => ({ itemId: o.itemId, qty: o.expectedQty != null ? String(o.expectedQty) : "" })) : [{ itemId: "", qty: "" }]);
  const [saving, setSaving] = useState(false);

  const valid = lines.map((l) => ({ item: byId[l.itemId], qtyN: _mpNum(l.qty) })).filter((l) => l.item && l.qtyN > 0);
  const multiMissingPortion = valid.length > 1 && valid.some((l) => !(l.item.portionQty > 0));
  const canSave = valid.length > 0 && !multiMissingPortion;
  const previews = (() => {
    const total = Number(order.totalInputCost) || 0;
    if (valid.length === 0) return {};
    if (valid.length === 1) return { [valid[0].item.id]: total / valid[0].qtyN };
    const weights = valid.map((l) => ({ id: l.item.id, qtyN: l.qtyN, w: l.qtyN * (l.item.portionQty || 0) }));
    const sumW = weights.reduce((s, x) => s + x.w, 0); if (sumW <= 0) return {};
    const out = {}; for (const x of weights) out[x.id] = (total * x.w / sumW) / x.qtyN; return out;
  })();
  const setLine = (i, patch) => setLines((cur) => cur.map((x, k) => k === i ? { ...x, ...patch } : x));

  const save = async () => {
    if (saving || !canSave) return; setSaving(true);
    try {
      const sess = await dbGetSession();
      const { error } = await dbCompleteProductionOrder(order.id, valid.map((l) => ({ itemId: l.item.id, name: l.item.name, returnedQty: l.qtyN })), sess?.user?.id);
      if (error) throw error;
      window.showToast?.("Devolução lançada — transformados no estoque com custo convertido", { tone: "ok" });
      onSaved();
    } catch (e) { window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 }); setSaving(false); }
  };

  return (
    <FullSheet
      title={`Devolução · ${order.code}`}
      subtitle={`Custo dos insumos: ${_mpFmt(order.totalInputCost)} → vira o custo das porções`}
      onBack={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={save} disabled={!canSave} loading={saving}><I.Box size={16} />Confirmar devolução</MPrimaryButton>}
    >
      <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginBottom: 12 }}>
        Insumos retirados: {order.inputs.map((l) => `${l.name} (${l.qty.toLocaleString("pt-BR")} ${l.unit})`).join(", ")}
      </div>

      {transformed.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--warn)", padding: "10px 12px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 8 }}>
          Nenhum transformado cadastrado — crie primeiro no desktop (aba Transformados).
        </div>
      ) : (
        <>
          <MSectionLabel>O que a produção devolveu</MSectionLabel>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
            {lines.map((l, i) => {
              const item = byId[l.itemId]; const qtyN = _mpNum(l.qty); const prev = item && qtyN > 0 ? previews[item.id] : null;
              return (
                <div key={i} style={{ padding: "10px 12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <select value={l.itemId} onChange={(e) => setLine(i, { itemId: e.target.value })} style={{ ...mInput, flex: 1, height: 40 }}>
                      <option value="">— transformado —</option>
                      {transformed.map((it) => <option key={it.id} value={it.id}>{it.name}{_mpPortion(it) ? ` · ${_mpPortion(it)}` : ""}</option>)}
                    </select>
                    {lines.length > 1 && (
                      <button onClick={() => setLines((cur) => cur.filter((_, k) => k !== i))} aria-label="Remover" style={{ width: 40, height: 40, borderRadius: 8, flexShrink: 0, background: "transparent", border: "1px solid var(--line)", color: "var(--fg-3)", display: "grid", placeItems: "center" }}><I.X size={14} /></button>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input value={l.qty} inputMode="decimal" placeholder="Porções" onChange={(e) => setLine(i, { qty: e.target.value })} style={{ ...mInput, height: 40 }} />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-2)", width: 110, textAlign: "right", flexShrink: 0 }}>{prev != null && isFinite(prev) ? `≈ ${_mpFmt(prev)}/porç.` : ""}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <button onClick={() => setLines((cur) => [...cur, { itemId: "", qty: "" }])} style={{ marginTop: 10, height: 44, width: "100%", borderRadius: 10, background: "transparent", border: "1px dashed var(--line)", color: "var(--fg-2)", fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <I.Plus size={14} />Adicionar transformado
          </button>
          {multiMissingPortion && (
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--warn)", padding: "8px 12px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 8 }}>
              Vários transformados: todos precisam ter <strong>porção definida</strong> (custo rateado por peso).
            </div>
          )}
          <div style={{ marginTop: 12, fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
            Voltou menos que o enviado? O desperdício fica absorvido no custo da porção (nada vira perda no CMV).
          </div>
        </>
      )}
    </FullSheet>
  );
}

window.MobileProduction = MobileProduction;
