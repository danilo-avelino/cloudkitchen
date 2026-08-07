// page-mobile-purchases.jsx — Compras no celular (≤480px). Foco: RECEBER
// MERCADORIA (operador confere a entrega). Viewer de listas + recebimento por
// fornecedor (inclusive parcial/divergente). Reaproveita a camada de dados (db*)
// e a mesma lógica de status/entrada do desktop (page-purchases.jsx).

const _pbrP = (raw) => {
  if (raw === "" || raw == null) return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  let s = String(raw).trim().replace(/\s+/g, "");
  if (!s) return 0;
  const dp = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  if (dp >= 0) s = s.slice(0, dp).replace(/[.,]/g, "") + "." + s.slice(dp + 1);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};
const _brlP = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _brlPs = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
const _dateBR = (iso) => { if (!iso) return "—"; const d = new Date(iso); return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`; };
const _timeBR = (iso) => { if (!iso) return ""; const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

function MobilePurchases() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [lists, setLists] = useState(() => dbStatus.isOnline ? [] : (MOCK.SHOPPING_LISTS || []));
  const [receipts, setReceipts] = useState(() => dbStatus.isOnline ? [] : (MOCK.GOODS_RECEIPTS || []));
  const [stockItems, setStockItems] = useState(() => dbStatus.isOnline ? [] : (MOCK.STOCK_ITEMS || []));
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState(dbStatus.isOnline ? "db" : "mock");
  const [pageLoading, setPageLoading] = useState(true);
  const [openListId, setOpenListId] = useState(null);
  const [receiving, setReceiving] = useState(null); // { listId, supplier }
  const [generating, setGenerating] = useState(false);
  const [tab, setTab] = useState("saved"); // saved | suggestion

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setPageLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const ctx = await dbGetCurrentContext();
        if (cancelled) return;
        const tid = ctx?.tenant?.id;
        setTenantId(tid || null);
        if (!tid) return;
        const [l, r, s] = await Promise.all([dbListPurchaseOrders(tid), dbListGoodsReceipts(tid), dbListStockItems(tid)]);
        if (cancelled) return;
        if (l.source === "db") { setLists(l.data || []); setSource("db"); }
        if (r.source === "db") setReceipts(r.data || []);
        if (s.source === "db") setStockItems(s.data || []);
      } finally { if (!cancelled) setPageLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  const refetchAll = async () => {
    if (source !== "db" || !tenantId) return;
    const [l, r, s] = await Promise.all([dbListPurchaseOrders(tenantId), dbListGoodsReceipts(tenantId), dbListStockItems(tenantId)]);
    if (l.data) setLists(l.data);
    if (r.data) setReceipts(r.data);
    if (s.data) setStockItems(s.data);
  };

  // ===== status por (lista, fornecedor) — igual ao desktop =====
  const supplierStatusFor = (list, supplier) => {
    const rs = receipts.filter((r) => r.list_id === list.id && r.supplier === supplier);
    if (rs.length === 0) return "pending";
    const recByItem = {}, divByItem = {};
    rs.forEach((r) => r.items.forEach((it) => {
      if (!it.list_item_id) return;
      recByItem[it.list_item_id] = (recByItem[it.list_item_id] || 0) + (it.qty_received || 0);
      if (it.divergent) divByItem[it.list_item_id] = true;
    }));
    const supItems = list.items.filter((li) => li.supplier === supplier);
    const allClosed = supItems.every((li) => (recByItem[li.id] || 0) >= li.qty || divByItem[li.id]);
    return allClosed ? "received" : "partial";
  };
  const recomputeListStatus = (list) => {
    const fs = [...new Set(list.items.map((it) => it.supplier))];
    const st = fs.map((s) => supplierStatusFor(list, s));
    if (st.every((s) => s === "received")) return "received";
    if (st.some((s) => s !== "pending")) return "partial";
    return "open";
  };
  const enrichedLists = useMemo(() =>
    lists.map((l) => ({ ...l, computedStatus: recomputeListStatus(l) })),
    [lists, receipts]
  );

  const totals = useMemo(() => {
    const t = { count: enrichedLists.length, value: 0, open: 0, partial: 0, received: 0 };
    enrichedLists.forEach((l) => {
      t.value += l.items.reduce((s, it) => s + (it.est_cost || 0), 0);
      t[l.computedStatus] = (t[l.computedStatus] || 0) + 1;
    });
    return t;
  }, [enrichedLists]);

  // ===== persiste uma lista (1 PO por fornecedor) — reusado pelo auto e pela aba Nova lista =====
  const persistItems = async (items) => {
    if (!items || items.length === 0) { window.showToast?.("Lista vazia · nada a salvar", { tone: "warn" }); return false; }
    if (source === "db" && tenantId) {
      const bySup = {};
      items.forEach((it) => { const sup = it.supplier || "Sem fornecedor cadastrado"; (bySup[sup] = bySup[sup] || []).push(it); });
      const code = `LCO-${Date.now().toString(36).slice(-6).toUpperCase()}`;
      for (const [sup, sItems] of Object.entries(bySup)) {
        await dbInsertPurchaseOrder(tenantId, {
          code: `${code}-${sup.slice(0, 6).toUpperCase().replace(/[^A-Z]/g, "")}`,
          supplier: sup, status: "draft",
          title: `Lista de compras · ${_dateBR(new Date().toISOString())}`, items: sItems,
        });
      }
      await refetchAll();
      return true;
    }
    const id = `LCO-${Date.now().toString(36).slice(-4).toUpperCase()}`;
    setLists((prev) => [{ id, title: `Lista de compras · ${_dateBR(new Date().toISOString())}`, created_at: new Date().toISOString(), created_by: "Mobile", status: "open", notes: "Gerada a partir do estoque", items: items.map((it, i) => ({ id: `lci-${i}`, ...it })) }, ...prev]);
    return true;
  };

  // ===== gerar lista automática (itens abaixo do mínimo), agrupada por fornecedor =====
  const generateAuto = async () => {
    if (generating) return;
    const candidates = stockItems.filter((it) => it.itemKind !== "transformed" && it.qty < it.reorder);
    if (candidates.length === 0) { window.showToast?.("Sem itens abaixo do mínimo", { tone: "warn" }); return; }
    setGenerating(true);
    try {
      const items = candidates.map((it) => {
        const target = it.max && it.max > it.reorder ? it.max : it.reorder * 2;
        const qty = Math.max(0, Number((target - it.qty).toFixed(2)));
        return { stock_item_id: it.id, name: it.name, supplier: it.supplier || "Sem fornecedor cadastrado", category: it.cat, qty, unit: it.unit, est_unit_cost: it.cost, est_cost: Number((qty * it.cost).toFixed(2)) };
      });
      const ok = await persistItems(items);
      if (ok) { setTab("saved"); window.showToast?.(`Lista gerada · ${items.length} itens`, { tone: source === "db" ? "ok" : "warn" }); }
    } finally { setGenerating(false); }
  };

  // ===== salvar sugestão editada na aba "Nova lista" (Shopping embedded) =====
  const handleSaveSuggestion = async ({ items }) => {
    const ok = await persistItems(items);
    if (ok) { setTab("saved"); window.showToast?.(`Lista salva · ${items.length} ${items.length === 1 ? "item" : "itens"}`, { tone: source === "db" ? "ok" : "warn" }); }
  };

  // ===== confirmar recebimento (mesma lógica do desktop handleConfirmReceipt) =====
  const confirmReceipt = async (draft) => {
    const list = lists.find((l) => l.id === draft.list_id);
    if (!list) return { ok: false };
    const recId = `REC-${Date.now().toString(36).slice(-6).toUpperCase()}`;
    const receipt = {
      id: recId, list_id: draft.list_id, supplier: draft.supplier,
      received_at: new Date().toISOString(), received_by: draft.received_by || "—",
      nf_number: draft.nf_number || "", notes: draft.notes || "",
      items: draft.items.map((it, i) => ({
        id: `rci-${i}`, list_item_id: it.list_item_id || null, name: it.name,
        qty_ordered: Number(it.qty_ordered) || 0, qty_received: Number(it.qty_received) || 0,
        unit: it.unit, unit_cost: Number(it.unit_cost) || 0,
        line_cost: Number(((Number(it.qty_received) || 0) * (Number(it.unit_cost) || 0)).toFixed(2)),
        divergent: !!it.divergent || (it.list_item_id && Number(it.qty_received) !== Number(it.qty_ordered)) || (!it.list_item_id),
        divergence_reason: it.divergence_reason || (it.list_item_id ? "" : "Item adicionado no recebimento"),
      })),
    };

    if (source === "db" && tenantId) {
      const { data, error } = await dbInsertGoodsReceipt(tenantId, { ...receipt, list_id: draft.list_id });
      if (error) { window.showToast?.(`Erro ao salvar: ${error.message}`, { tone: "crit", ttl: 4500 }); return { ok: false }; }
      const realRecId = data?.code || recId;
      let entered = 0, missed = 0;
      for (const it of receipt.items) {
        const inQty = Number(it.qty_received) || 0;
        if (inQty <= 0) continue;
        let stockItemId = null;
        if (it.list_item_id) stockItemId = list.items.find((x) => x.id === it.list_item_id)?.stock_item_id || null;
        if (!stockItemId && typeof findStockItemByName === "function") stockItemId = findStockItemByName(it.name, stockItems)?.id || null;
        if (!stockItemId) { missed++; continue; }
        const { error: mvErr } = await dbApplyStockMovement(tenantId, stockItemId, inQty, "in", `Recebimento ${realRecId} de ${draft.supplier || "—"}`, Number(it.unit_cost) || undefined);
        if (mvErr) { missed++; continue; } entered++;
      }
      await refetchAll();
      window.showToast?.(`Recebimento salvo · ${entered} no estoque${missed ? ` · ${missed} sem match` : ""}`, { tone: missed ? "warn" : "ok", ttl: 4500 });
      return { ok: true };
    }

    // mock
    setReceipts((prev) => [receipt, ...prev]);
    window.showToast?.(`Recebimento ${recId} confirmado (mock)`, { tone: "warn" });
    return { ok: true };
  };

  // ===== editar itens da lista (qtd/remover) — mesma lógica do desktop =====
  const handleUpdateListItems = async (listId, changes) => {
    const updates = Array.isArray(changes?.updates) ? changes.updates : [];
    const deletes = Array.isArray(changes?.deletes) ? changes.deletes : [];
    const errors = [];
    if (source === "db") {
      for (const u of updates) {
        const patch = {};
        if (u.qty !== undefined) patch.qty = Number(u.qty) || 0;
        if (u.est_unit_cost !== undefined) patch.unit_cost = Number(u.est_unit_cost) || 0;
        const { error } = await dbUpdatePurchaseOrderItem(u.id, patch);
        if (error) errors.push(error.message);
      }
      for (const id of deletes) {
        const { error } = await dbDeletePurchaseOrderItem(id);
        if (error) errors.push(error.message);
      }
      const { data: refreshed } = await dbListPurchaseOrders(tenantId);
      if (refreshed) setLists(refreshed);
    } else {
      setLists((prev) => prev.map((l) => {
        if (l.id !== listId) return l;
        const delSet = new Set(deletes);
        const updMap = new Map(updates.map((u) => [u.id, u]));
        const nextItems = l.items.filter((it) => !delSet.has(it.id)).map((it) => {
          const u = updMap.get(it.id);
          if (!u) return it;
          const qty = u.qty !== undefined ? Number(u.qty) || 0 : it.qty;
          const cost = u.est_unit_cost !== undefined ? Number(u.est_unit_cost) || 0 : it.est_unit_cost;
          return { ...it, qty, est_unit_cost: cost, est_cost: qty * cost };
        });
        return { ...l, items: nextItems };
      }));
    }
    if (errors.length) { window.showToast?.(`Salvou com erros: ${errors[0]}`, { tone: "crit", ttl: 5000 }); return { ok: false }; }
    const summary = [];
    if (updates.length) summary.push(`${updates.length} ajustado(s)`);
    if (deletes.length) summary.push(`${deletes.length} removido(s)`);
    if (summary.length) window.showToast?.(`Lista atualizada · ${summary.join(" · ")}`, { tone: "ok" });
    return { ok: true };
  };

  const handleDeleteList = async (id, onDone) => {
    const list = lists.find((l) => l.id === id);
    if (!list) return;
    if (source === "db") {
      const ids = Array.isArray(list._pos) && list._pos.length > 0 ? list._pos : [id];
      for (const poId of ids) {
        const { error } = await dbDeletePurchaseOrder(poId);
        if (error) { window.showToast?.(`Erro ao excluir: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
      }
    }
    setLists((prev) => prev.filter((l) => l.id !== id));
    setReceipts((prev) => prev.filter((r) => r.list_id !== id));
    window.showToast?.(`Lista excluída`, { tone: "warn" });
    onDone?.();
  };

  if (pageLoading) return <PageLoading label="Carregando compras…" variant="cards" />;

  const openList = enrichedLists.find((l) => l.id === openListId) || null;

  // ---- Detalhe da lista ----
  if (openList) {
    return (
      <>
        <MobilePurchaseDetail
          list={openList}
          receipts={receipts.filter((r) => r.list_id === openList.id)}
          stockItems={stockItems}
          supplierStatusFor={supplierStatusFor}
          onBack={() => setOpenListId(null)}
          onReceive={(supplier) => setReceiving({ listId: openList.id, supplier })}
          onUpdateItems={(changes) => handleUpdateListItems(openList.id, changes)}
          onDelete={() => handleDeleteList(openList.id, () => setOpenListId(null))}
        />
        {receiving && (
          <ReceiveSheet
            list={lists.find((l) => l.id === receiving.listId)}
            supplier={receiving.supplier}
            receipts={receipts.filter((r) => r.list_id === receiving.listId && r.supplier === receiving.supplier)}
            onClose={() => setReceiving(null)}
            onConfirm={async (draft) => { const r = await confirmReceipt(draft); if (r.ok) setReceiving(null); return r; }}
          />
        )}
      </>
    );
  }

  // ---- Master (listas) ----
  const byDay = (() => {
    const g = {};
    enrichedLists.forEach((l) => { const k = (window.spDay ? window.spDay(l.created_at) : (l.created_at || "").slice(0, 10)); (g[k] = g[k] || []).push(l); });
    return Object.entries(g).sort(([a], [b]) => b.localeCompare(a));
  })();

  return (
    <MobilePage>
      <SegTabs value={tab} onChange={setTab} options={[
        { id: "saved", label: "Listas salvas", count: enrichedLists.length },
        { id: "suggestion", label: "Nova lista" },
      ]} />

      {tab === "saved" ? (
        <>
          <StatStrip stats={[
            { label: "Abertas", value: totals.open, tone: totals.open > 0 ? "warn" : "neutral" },
            { label: "Parciais", value: totals.partial, tone: totals.partial > 0 ? "info" : "neutral" },
            { label: "Recebidas", value: totals.received, tone: "ok" },
            { label: "Total estimado", value: _brlPs(totals.value) },
          ]} />

          <MobileScroll style={{ padding: "0 14px 12px" }}>
            {enrichedLists.length === 0 ? (
              <div style={{ textAlign: "center", padding: "48px 12px", color: "var(--fg-3)", fontSize: 13 }}>
                Nenhuma lista salva.<br />
                <span style={{ fontSize: 11.5 }}>Use a aba <strong>Nova lista</strong> ou o botão auto abaixo.</span>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {byDay.map(([day, dayLists]) => (
                  <div key={day}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 2px 6px" }}>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-2)", fontWeight: 500, letterSpacing: "0.04em" }}>{_dateBR(day)}</span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", textTransform: "uppercase" }}>{dayLists.length} {dayLists.length === 1 ? "lista" : "listas"}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {dayLists.map((l) => <PurchaseListCard key={l.id} list={l} onOpen={() => setOpenListId(l.id)} />)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </MobileScroll>

          <MobileBottomBar>
            <MPrimaryButton onClick={generateAuto} loading={generating}><I.Plus size={16} />Nova lista (auto)</MPrimaryButton>
          </MobileBottomBar>
        </>
      ) : (
        <MobileScroll style={{ padding: "14px" }}>
          {typeof Shopping === "function"
            ? <Shopping embedded stockItems={stockItems} onSave={handleSaveSuggestion} />
            : <div style={{ padding: 24, color: "var(--fg-3)" }}>Sugestão indisponível.</div>}
        </MobileScroll>
      )}
    </MobilePage>
  );
}

function statusMeta(status) {
  return {
    open: { l: "Aberta", t: "warn" }, partial: { l: "Parcial", t: "info" },
    received: { l: "Recebida", t: "ok" }, closed: { l: "Fechada", t: "neutral" },
  }[status] || { l: "Aberta", t: "warn" };
}

function PurchaseListCard({ list, onOpen }) {
  const total = list.items.reduce((s, it) => s + (it.est_cost || 0), 0);
  const suppliers = [...new Set(list.items.map((it) => it.supplier))];
  const m = statusMeta(list.computedStatus || list.status);
  return (
    <MobileCard onClick={onOpen}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{list.title}</div>
          <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 3 }}>
            {_timeBR(list.created_at)} · {suppliers.length} {suppliers.length === 1 ? "fornecedor" : "fornecedores"} · {list.items.length} itens
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <MBadge tone={m.t}>{m.l}</MBadge>
          <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-0)", fontWeight: 600 }}>{_brlP(total)}</span>
        </div>
      </div>
    </MobileCard>
  );
}

// Copia texto p/ o clipboard (com fallback execCommand) — mesma UX do desktop.
async function _copyClip(text, okMsg) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      window.showToast?.(okMsg, { tone: "ok", ttl: 4000 });
      return;
    }
    throw new Error();
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); window.showToast?.(okMsg, { tone: "ok", ttl: 4000 }); }
    catch { window.showToast?.("Não foi possível copiar", { tone: "crit" }); }
    document.body.removeChild(ta);
  }
}

// ===== Detalhe da lista (fornecedores colapsáveis + copiar/editar/excluir) =====
function MobilePurchaseDetail({ list, receipts, stockItems = [], supplierStatusFor, onBack, onReceive, onUpdateItems, onDelete }) {
  const total = list.items.reduce((s, it) => s + (it.est_cost || 0), 0);
  const suppliers = [...new Set(list.items.map((it) => it.supplier))];
  const m = statusMeta(list.computedStatus || list.status);
  const [editSup, setEditSup] = useState(null);  // { supplier, items }
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Cruza com o estoque atual p/ marcar itens críticos no texto do WhatsApp.
  const stockBy = useMemo(() => { const mp = {}; (stockItems || []).forEach((it) => { mp[it.id] = it; }); return mp; }, [stockItems]);
  const isCriticalOf = (it) => { const s = stockBy[it.stock_item_id]; return s ? (s.qty <= 0 || (s.reorder > 0 && s.qty < s.reorder * 0.25)) : false; };
  const enrichedFor = (it) => { const s = stockBy[it.stock_item_id]; return { ...it, currentQty: s?.qty, reorder: s?.reorder, max: s?.max, stockUnit: s?.unit, isCritical: isCriticalOf(it) }; };

  const buildSupplierText = (sup, items) => {
    const today = new Date(list.created_at).toLocaleDateString("pt-BR");
    const lines = [`*🛒 Lista de compras · ${sup}*`, `_${today} · ${list.id || ""}_`, ""];
    items.forEach((it) => lines.push(`• ${it.name} — ${it.qty} ${it.unit}${isCriticalOf(it) ? " ⚠️" : ""}`));
    lines.push("", "_Por favor enviar cotação._");
    return lines.join("\n");
  };
  const buildFullText = () => {
    const today = new Date(list.created_at).toLocaleDateString("pt-BR");
    const lines = [`*🛒 Lista de compras · ${today}*`, `_${list.id || ""}_`, ""];
    suppliers.forEach((sup) => {
      lines.push(`*${sup}*`);
      list.items.filter((it) => it.supplier === sup).forEach((it) => lines.push(`• ${it.name} — ${it.qty} ${it.unit}${isCriticalOf(it) ? " ⚠️" : ""}`));
      lines.push("");
    });
    lines.push("_Por favor enviar cotação._");
    return lines.join("\n");
  };

  const doDelete = async () => { if (deleting) return; setDeleting(true); try { await onDelete?.(); } finally { setDeleting(false); } };

  return (
    <MobilePage>
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <button onClick={onBack} aria-label="Voltar" style={{ width: 40, height: 40, borderRadius: 8, flexShrink: 0, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", display: "grid", placeItems: "center" }}>
          <I.Chevron size={18} style={{ transform: "rotate(90deg)" }} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{list.title}</div>
          <div style={{ fontSize: 11, color: "var(--fg-3)" }}>{_dateBR(list.created_at)} · {_brlP(total)}</div>
        </div>
        <MBadge tone={m.t}>{m.l}</MBadge>
      </div>

      {/* Ações da lista: copiar (WhatsApp) + excluir */}
      <div style={{ display: "flex", gap: 8, padding: "10px 14px 4px", flexShrink: 0 }}>
        <button onClick={() => _copyClip(buildFullText(), `Lista copiada · ${list.items.length} itens`)}
          style={{ flex: 1, height: 40, borderRadius: 8, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <I.WhatsApp size={15} />Copiar lista
        </button>
        {onDelete && (
          <button onClick={() => setConfirmDel(true)} aria-label="Excluir lista"
            style={{ width: 44, height: 40, borderRadius: 8, flexShrink: 0, background: "transparent", border: "1px solid var(--crit-line)", color: "var(--crit)", display: "grid", placeItems: "center" }}>
            <I.Trash size={15} />
          </button>
        )}
      </div>

      {/* O wrapper interno evita o colapso dos cards: se o MobileScroll fosse o
          próprio container flex-column, os SupplierCards (overflow:hidden → min-height 0)
          encolheriam até só a borda em listas grandes que estouram a altura da tela. */}
      <MobileScroll style={{ padding: "8px 14px 12px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {suppliers.map((sup) => {
            const supItems = list.items.filter((it) => it.supplier === sup);
            const supReceipts = receipts.filter((r) => r.supplier === sup);
            const status = supplierStatusFor(list, sup);
            return (
              <SupplierCard key={sup} supplier={sup} items={supItems} receipts={supReceipts} status={status}
                            onCopy={() => _copyClip(buildSupplierText(sup, supItems), `${sup} copiado · ${supItems.length} itens`)}
                            onEdit={onUpdateItems ? () => setEditSup({ supplier: sup, items: supItems.map(enrichedFor) }) : null} />
            );
          })}
          {receipts.length > 0 && <ReceiptsHistoryMobile receipts={receipts} />}
        </div>
      </MobileScroll>

      {editSup && (
        <PurchaseEditSheet
          supplier={editSup.supplier}
          items={editSup.items}
          onClose={() => setEditSup(null)}
          onSave={async (changes) => { const r = await onUpdateItems(changes); if (r?.ok !== false) setEditSup(null); }}
        />
      )}

      {confirmDel && (
        <BottomSheet title="Excluir lista?" subtitle={list.title} onClose={() => !deleting && setConfirmDel(false)}
          footer={
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setConfirmDel(false)} disabled={deleting} style={{ flex: 1, height: 50, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14, fontWeight: 600 }}>Cancelar</button>
              <button onClick={doDelete} disabled={deleting} style={{ flex: 1, height: 50, borderRadius: 10, background: "var(--crit)", border: "none", color: "#fff", fontSize: 14, fontWeight: 600 }}>{deleting ? "Excluindo…" : "Excluir"}</button>
            </div>
          }>
          <div style={{ fontSize: 13, color: "var(--fg-2)" }}>Remove a lista e os recebimentos associados. Essa ação não pode ser desfeita.</div>
        </BottomSheet>
      )}
    </MobilePage>
  );
}

function SupplierCard({ supplier, items, receipts, status, onCopy, onEdit }) {
  const [open, setOpen] = useState(true);
  const total = items.reduce((s, it) => s + (it.est_cost || 0), 0);
  const m = { pending: { l: "A receber", t: "warn" }, partial: { l: "Parcial", t: "info" }, received: { l: "Recebido", t: "ok" } }[status] || { l: "A receber", t: "warn" };

  const recByItem = useMemo(() => {
    const acc = {};
    receipts.forEach((r) => r.items.forEach((it) => { if (it.list_item_id) acc[it.list_item_id] = (acc[it.list_item_id] || 0) + (it.qty_received || 0); }));
    return acc;
  }, [receipts]);
  const divByItem = useMemo(() => {
    const acc = {};
    receipts.forEach((r) => r.items.forEach((it) => { if (it.list_item_id && it.divergent) acc[it.list_item_id] = true; }));
    return acc;
  }, [receipts]);

  return (
    <div style={{ borderRadius: 12, background: "var(--bg-1)", border: "1px solid var(--line)", overflow: "hidden" }}>
      <button onClick={() => setOpen((v) => !v)} style={{ width: "100%", padding: "12px 14px", background: "transparent", border: "none", display: "flex", alignItems: "center", gap: 10, textAlign: "left" }}>
        <I.Truck size={16} style={{ color: status === "received" ? "var(--ok)" : "var(--fg-2)", flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{supplier}</div>
          <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2 }}>{items.length} {items.length === 1 ? "item" : "itens"} · {_brlP(total)}</div>
        </div>
        <MBadge tone={m.t}>{m.l}</MBadge>
        <I.Chevron size={15} style={{ color: "var(--fg-3)", transform: open ? "rotate(180deg)" : "none", flexShrink: 0 }} />
      </button>

      {open && (
        <div style={{ padding: "0 14px 12px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
            {items.map((it) => {
              const rec = recByItem[it.id] || 0;
              const closed = !!divByItem[it.id];
              const st = (rec >= it.qty || closed) ? "received" : rec > 0 ? "partial" : "pending";
              const im = { pending: { l: "A receber", t: "warn" }, partial: { l: "Parcial", t: "info" }, received: { l: "OK", t: "ok" } }[st];
              return (
                <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</div>
                    <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 1 }}>
                      Pedido {it.qty} {it.unit}{rec > 0 ? ` · Recebido ${Number(rec.toFixed(2))} ${it.unit}` : ""}
                    </div>
                  </div>
                  <MBadge tone={im.t}>{im.l}</MBadge>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {onCopy && (
              <button onClick={onCopy} title="Copiar para WhatsApp"
                style={{ flex: 1, height: 52, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <I.WhatsApp size={18} />Copiar
              </button>
            )}
            {onEdit && (
              <button onClick={onEdit} title="Editar itens"
                style={{ flex: 1, height: 52, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <I.Edit size={17} />Editar
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ===== Editar itens da lista (qtd / remover) — espelha o EditListModal do desktop =====
function PurchaseEditSheet({ supplier, items, onClose, onSave }) {
  const [drafts, setDrafts] = useState(() => items.map((it) => ({
    id: it.id, name: it.name, unit: it.unit, qty: String(it.qty ?? ""),
    est_unit_cost: it.est_unit_cost, currentQty: it.currentQty, reorder: it.reorder, max: it.max,
    stockUnit: it.stockUnit, isCritical: it.isCritical,
  })));
  const [removed, setRemoved] = useState(() => new Set());
  const [saving, setSaving] = useState(false);

  const originalById = useMemo(() => { const mp = new Map(); items.forEach((it) => mp.set(it.id, it)); return mp; }, [items]);
  const visible = drafts.filter((d) => !removed.has(d.id));
  const total = visible.reduce((s, d) => s + ((_pbrP(d.qty)) * (Number(d.est_unit_cost) || 0)), 0);
  const updates = drafts.filter((d) => !removed.has(d.id)).filter((d) => {
    const orig = originalById.get(d.id); if (!orig) return false;
    return (_pbrP(d.qty)) !== (Number(orig.qty) || 0);
  }).map((d) => ({ id: d.id, qty: _pbrP(d.qty) }));
  const deletes = Array.from(removed);
  const dirty = updates.length > 0 || deletes.length > 0;

  const setQty = (id, v) => setDrafts((prev) => prev.map((d) => d.id === id ? { ...d, qty: v } : d));
  const toggleRemoved = (id) => setRemoved((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const submit = async () => { if (!dirty || saving) return; setSaving(true); try { await onSave({ updates, deletes }); } finally { setSaving(false); } };

  return (
    <FullSheet
      title={`Editar · ${supplier}`}
      subtitle={`${visible.length} ${visible.length === 1 ? "item" : "itens"} · ${_brlP(total)}`}
      onBack={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={submit} disabled={!dirty} loading={saving}>{dirty ? `Salvar (${updates.length + deletes.length})` : "Sem alterações"}</MPrimaryButton>}
    >
      <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginBottom: 12 }}>
        Ajuste a quantidade a comprar (compare com <strong style={{ color: "var(--fg-2)" }}>Atual / Mín / Máx</strong>). Remoções só valem ao salvar.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {drafts.map((d) => {
          const isRemoved = removed.has(d.id);
          const step = (d.unit === "un" || d.unit === "und") ? 1 : 0.5;
          const q = _pbrP(d.qty);
          return (
            <div key={d.id} style={{ padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", opacity: isRemoved ? 0.5 : 1 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 500, textDecoration: isRemoved ? "line-through" : "none" }}>{d.name}</div>
                  <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2 }}>
                    Atual {d.currentQty == null ? "—" : `${d.currentQty} ${d.stockUnit || d.unit}`} · mín {d.reorder ?? "—"} / máx {d.max ?? "—"}
                    {d.isCritical ? <span style={{ color: "var(--crit)" }}> · ruptura</span> : null}
                  </div>
                </div>
                <button onClick={() => toggleRemoved(d.id)} aria-label={isRemoved ? "Restaurar" : "Remover"}
                  style={{ width: 34, height: 34, borderRadius: 8, flexShrink: 0, background: "transparent", border: "1px solid var(--line)", color: isRemoved ? "var(--fg-2)" : "var(--crit)", display: "grid", placeItems: "center" }}>
                  {isRemoved ? <I.Plus size={15} /> : <I.Trash size={14} />}
                </button>
              </div>
              {!isRemoved && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button onClick={() => setQty(d.id, Math.max(0, Number((q - step).toFixed(2))))} style={mStep}>−</button>
                  <input value={d.qty} inputMode="decimal"
                    onChange={(e) => setQty(d.id, e.target.value.replace(",", "."))}
                    style={{ width: 70, height: 40, textAlign: "center", borderRadius: 8, background: "var(--bg-0)", border: "1px solid var(--line)", color: "var(--fg-0)", fontSize: 16 }} />
                  <button onClick={() => setQty(d.id, Number((q + step).toFixed(2)))} style={mStep}>+</button>
                  <span style={{ fontSize: 12, color: "var(--fg-3)" }}>{d.unit}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-2)" }}>{_brlP(q * (Number(d.est_unit_cost) || 0))}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </FullSheet>
  );
}

function ReceiptsHistoryMobile({ receipts }) {
  return (
    <div style={{ marginTop: 4 }}>
      <MSectionLabel>Histórico de recebimentos</MSectionLabel>
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
        {receipts.slice().sort((a, b) => (b.received_at || "").localeCompare(a.received_at || "")).map((r) => {
          const total = r.items.reduce((s, it) => s + (it.line_cost || 0), 0);
          const div = r.items.filter((it) => it.divergent).length;
          return (
            <div key={r.id} style={{ padding: "10px 12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500 }}>{r.supplier}{r.nf_number ? ` · ${r.nf_number}` : ""}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-0)", fontWeight: 600 }}>{_brlP(total)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 4 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>{_dateBR(r.received_at)} {_timeBR(r.received_at)} · {r.items.length} itens</span>
                {div > 0 ? <MBadge tone="warn">{div} diverg.</MBadge> : <MBadge tone="ok">sem diverg.</MBadge>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===== Recebimento (full sheet) =====
// Fonte da verdade: (qty_received, line_total). unit_cost = line_total / qty_received
// (operador digita total da NF). Espelha o GoodsReceiptModal do desktop.
function ReceiveSheet({ list, supplier, receipts, onClose, onConfirm }) {
  const recByItem = useMemo(() => {
    const acc = {};
    receipts.forEach((r) => r.items.forEach((it) => { if (it.list_item_id) acc[it.list_item_id] = (acc[it.list_item_id] || 0) + (it.qty_received || 0); }));
    return acc;
  }, [receipts]);

  const supItems = (list?.items || []).filter((it) => it.supplier === supplier);
  const [lines, setLines] = useState(() => supItems.map((it) => {
    const remaining = Math.max(0, Number((it.qty - (recByItem[it.id] || 0)).toFixed(2)));
    const qty = remaining > 0 ? remaining : it.qty;
    const estUnit = Number(it.est_unit_cost) || 0;
    return { list_item_id: it.id, name: it.name, unit: it.unit, qty_ordered: it.qty, qty_received: qty, line_total: Number((qty * estUnit).toFixed(2)) };
  }));
  const [nf, setNf] = useState("");
  const [by, setBy] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const setLine = (idx, patch) => setLines((cur) => cur.map((l, i) => i === idx ? { ...l, ...patch } : l));
  const total = lines.reduce((s, l) => s + (Number(l.line_total) || 0), 0);
  const anyReceived = lines.some((l) => (Number(l.qty_received) || 0) > 0);

  const confirm = async () => {
    if (submitting || !anyReceived) return;
    setSubmitting(true);
    try {
      const items = lines.map((l) => {
        const q = Number(l.qty_received) || 0;
        const lt = Number(l.line_total) || 0;
        const unit_cost = q > 0 ? Number((lt / q).toFixed(4)) : 0;
        return {
          list_item_id: l.list_item_id, name: l.name, unit: l.unit,
          qty_ordered: l.qty_ordered, qty_received: q, unit_cost,
          divergent: q !== Number(l.qty_ordered), divergence_reason: "",
        };
      });
      await onConfirm({ list_id: list.id, supplier, nf_number: nf.trim(), received_by: by.trim() || "—", items });
    } finally { setSubmitting(false); }
  };

  return (
    <FullSheet
      title="Receber mercadoria"
      subtitle={supplier}
      onBack={submitting ? undefined : onClose}
      footer={
        <>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--fg-2)", marginBottom: 8 }}>
            <span>Total do recebimento</span>
            <span style={{ fontFamily: "var(--mono)", color: "var(--fg-0)", fontWeight: 600 }}>{_brlP(total)}</span>
          </div>
          <MPrimaryButton onClick={confirm} disabled={!anyReceived} loading={submitting}>
            <I.Box size={16} />Confirmar recebimento
          </MPrimaryButton>
        </>
      }
    >
      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <MField label="Nota fiscal (opcional)"><input value={nf} onChange={(e) => setNf(e.target.value)} placeholder="Nº NF" style={mInput} /></MField>
        </div>
        <div style={{ flex: 1 }}>
          <MField label="Recebido por"><input value={by} onChange={(e) => setBy(e.target.value)} placeholder="Nome" style={mInput} /></MField>
        </div>
      </div>

      <MSectionLabel>Itens · confira qtd e valor da NF</MSectionLabel>
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        {lines.map((l, i) => {
          const q = Number(l.qty_received) || 0;
          const diverg = q !== Number(l.qty_ordered);
          const step = (l.unit === "un" || l.unit === "und") ? 1 : 0.5;
          const unitCost = q > 0 ? (Number(l.line_total) || 0) / q : 0;
          return (
            <div key={l.list_item_id} style={{ padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: `1px solid ${diverg ? "var(--warn-line)" : "var(--line)"}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 500 }}>{l.name}</span>
                {diverg && <MBadge tone="warn">Divergente</MBadge>}
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 8 }}>Pedido: {l.qty_ordered} {l.unit}</div>

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginBottom: 4 }}>Recebido ({l.unit})</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button onClick={() => setLine(i, { qty_received: Math.max(0, Number((q - step).toFixed(2))) })} style={mStep}>−</button>
                    <input value={l.qty_received} inputMode="decimal"
                           onChange={(e) => { const v = e.target.value.replace(",", "."); setLine(i, { qty_received: v === "" ? "" : (Number.isFinite(parseFloat(v)) ? parseFloat(v) : "") }); }}
                           style={{ width: 60, height: 40, textAlign: "center", borderRadius: 8, background: "var(--bg-0)", border: "1px solid var(--line)", color: "var(--fg-0)", fontSize: 16 }} />
                    <button onClick={() => setLine(i, { qty_received: Number((q + step).toFixed(2)) })} style={mStep}>+</button>
                  </div>
                </div>
                <div style={{ width: 120 }}>
                  <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginBottom: 4 }}>Total NF (R$)</div>
                  <input value={l.line_total} inputMode="decimal"
                         onChange={(e) => setLine(i, { line_total: e.target.value })}
                         onBlur={(e) => setLine(i, { line_total: _pbrP(e.target.value) })}
                         style={{ ...mInput, height: 40 }} />
                </div>
              </div>
              {q > 0 && (
                <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 8, textAlign: "right" }}>
                  Unitário ≈ {_brlP(unitCost)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </FullSheet>
  );
}

window.MobilePurchases = MobilePurchases;
