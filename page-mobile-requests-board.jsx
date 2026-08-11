// page-mobile-requests-board.jsx — Requisições no celular (≤480px): QUADRO de
// gestão (listar por status + avançar Separar→Entregar). A CRIAÇÃO de requisição
// usa a tela standalone que já existe (#/mobile · MobileRequests), acionada pelo
// botão do rodapé. Reaproveita as funções db* e a mesma regra de baixa na entrega
// do desktop (page-requests.jsx): a baixa acontece na entrega (trigger no DB).

function MobileRequestsBoard({ scope = "all" }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [items, setItems] = useState(() => (MOCK.REQUESTS || []).map((r) => r.status === "approved" ? { ...r, status: "pending" } : r));
  const [stockItems, setStockItems] = useState(MOCK.STOCK_ITEMS || []);
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState("mock");
  const [pageLoading, setPageLoading] = useState(true);
  const [tab, setTab] = useState("pending"); // pending | separated | delivered
  const [detail, setDetail] = useState(null);
  const advancingRef = useRef(new Set());
  const [advancing, setAdvancing] = useState(new Set());
  // Solicitações da Produção · não são kitchen_requests (a baixa delas não é de
  // nenhuma marca, senão o CMV contaria o insumo e depois o transformado).
  // Dividem o quadro com o mesmo ritual pendente → separada → entregue.
  const [prodOrders, setProdOrders] = useState([]);
  const [editingProd, setEditingProd] = useState(null);  // ajuste da separação

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
        const [reqRes, stockRes, prodRes] = await Promise.all([
          dbListKitchenRequests(tid, { limit: 100 }),
          dbListStockItems(tid),
          dbListProductionOrders(tid).catch(() => ({ data: null })),
        ]);
        if (cancelled) return;
        if (reqRes.data && reqRes.source === "db") { setItems(reqRes.data); setSource("db"); }
        if (stockRes.data && stockRes.source === "db") setStockItems(stockRes.data);
        if (prodRes?.data) setProdOrders(prodRes.data);
        else if (prodRes?.error) {
          console.error("[requests-board] produção não carregou:", prodRes.error);
          window.showToast?.(
            `Solicitações da produção não carregaram: ${prodRes.error.message || prodRes.error}`,
            { tone: "crit", ttl: 8000 },
          );
        }
      } finally { if (!cancelled) setPageLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  useEffect(() => {
    if (!dbStatus.isOnline || !tenantId) return;
    return dbSubscribeTable?.("kitchen_requests", tenantId, async () => {
      const { data, source: src } = await dbListKitchenRequests(tenantId, { limit: 100 });
      if (data && src === "db") setItems(data);
    });
  }, [dbStatus.isOnline, tenantId]);

  const filtered = scope === "all"
    ? items
    : items.filter((r) => r.op === scope || (r.splits && r.splits.some((s) => s.op === scope)));

  // Produção não pertence a uma marca — aparece em qualquer escopo.
  const prodCards = useMemo(() => {
    const todayStr = new Date().toDateString();
    // Draft não tem custo no banco (o snapshot só sai na entrega) — estima pelo
    // custo atual do insumo.
    const costById = {};
    (stockItems || []).forEach((s) => { costById[s.id] = s.cost || 0; });
    return (prodOrders || []).map((o) => {
      const status = o.status === "draft"
        ? (o.separatedAt ? "separated" : "pending")
        : (o.status === "issued" || o.status === "completed") ? "delivered" : null;
      if (!status) return null;
      if (status === "delivered" && new Date(o.issuedAt || o.createdAt).toDateString() !== todayStr) return null;
      const totalNum = o.totalInputCost != null
        ? o.totalInputCost
        : (o.inputs || []).reduce((s, l) => s + l.qty * (costById[l.itemId] || 0), 0);
      return {
        id: o.id, code: o.code, isProduction: true, status,
        items: (o.inputs || []).map((l) => [l.name, `${l.qty.toLocaleString("pt-BR")} ${l.unit}`, l.itemId]),
        itemsCount: (o.inputs || []).length,
        total: "R$ " + (totalNum || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        notes: o.notes, requestedAt: o.createdAt, separatedAt: o.separatedAt, deliveredAt: o.issuedAt,
      };
    }).filter(Boolean);
  }, [prodOrders, stockItems]);

  const counts = useMemo(() => ({
    pending: filtered.filter((r) => r.status === "pending").length + prodCards.filter((c) => c.status === "pending").length,
    separated: filtered.filter((r) => r.status === "separated").length + prodCards.filter((c) => c.status === "separated").length,
    delivered: filtered.filter((r) => r.status === "delivered").length + prodCards.filter((c) => c.status === "delivered").length,
  }), [filtered, prodCards]);

  const list = filtered
    .filter((r) => r.status === tab)
    .sort((a, b) => String(b.requestedAt || b.requested_at || b.created_at || "").localeCompare(String(a.requestedAt || a.requested_at || a.created_at || "")));
  const prodList = prodCards.filter((c) => c.status === tab);

  // Separar é só carimbo; entregar chama o issue da ordem e é o trigger do
  // banco que baixa os insumos (fora do CMV das marcas).
  const advanceProd = async (card) => {
    if (advancingRef.current.has(card.id)) return;
    advancingRef.current.add(card.id);
    setAdvancing(new Set(advancingRef.current));
    try {
      const sess = await dbGetSession();
      const uid = sess?.user?.id;
      if (card.status === "pending") {
        const { error } = await dbSeparateProductionOrder(card.id, uid);
        if (error) throw error;
        window.showToast?.(`Produção ${card.code} separada`, { tone: "ok" });
      } else if (card.status === "separated") {
        const { error } = await dbIssueProductionOrder(card.id, uid);
        if (error) throw error;
        window.showToast?.(`Produção ${card.code} entregue · insumos baixados`, { tone: "ok", ttl: 5000 });
        const { data } = await dbListStockItems(tenantId);
        if (data) setStockItems(data);
      }
      const { data: fresh } = await dbListProductionOrders(tenantId);
      if (fresh) setProdOrders(fresh);
      setDetail(null);
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 5000 });
    } finally {
      advancingRef.current.delete(card.id);
      setAdvancing(new Set(advancingRef.current));
    }
  };

  const revertProd = async (card) => {
    if (advancingRef.current.has(card.id)) return;
    advancingRef.current.add(card.id);
    setAdvancing(new Set(advancingRef.current));
    try {
      const { error } = await dbUnseparateProductionOrder(card.id);
      if (error) throw error;
      const { data: fresh } = await dbListProductionOrders(tenantId);
      if (fresh) setProdOrders(fresh);
      setDetail(null);
      window.showToast?.(`Produção ${card.code} voltou para pendente`, { tone: "ok" });
    } catch (e) {
      window.showToast?.(`Erro ao voltar: ${e.message || e}`, { tone: "crit", ttl: 4500 });
    } finally {
      advancingRef.current.delete(card.id);
      setAdvancing(new Set(advancingRef.current));
    }
  };

  // Avança status (pending→separated→delivered) com guard de duplo-clique.
  const advance = async (id) => {
    if (advancingRef.current.has(id)) return;
    const order = ["pending", "separated", "delivered"];
    const cur = items.find((r) => r.id === id);
    if (!cur) return;
    const next = order[Math.min(order.indexOf(cur.status) + 1, order.length - 1)];
    if (next === cur.status) return;
    advancingRef.current.add(id);
    setAdvancing(new Set(advancingRef.current));
    try {
      const nowIso = new Date().toISOString();
      const stamp = next === "separated" ? { separatedAt: nowIso } : next === "delivered" ? { deliveredAt: nowIso } : {};
      setItems((prev) => prev.map((r) => r.id === id ? { ...r, status: next, ...stamp } : r));
      if (source === "db") {
        const { error } = await dbUpdateKitchenRequestStatus(id, next);
        if (error) {
          setItems((prev) => prev.map((r) => r.id === id ? { ...r, status: cur.status, separatedAt: cur.separatedAt, deliveredAt: cur.deliveredAt } : r));
          window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 });
          return;
        }
      }
      if (next === "delivered") {
        // Baixa: no DB o trigger gera as saídas; no MOCK aplica aqui. Depois re-busca qty.
        if (source === "db" && tenantId) {
          const { data } = await dbListStockItems(tenantId);
          if (data) setStockItems(data);
        } else {
          for (const entry of (cur.items || [])) {
            const [name, rawQty, stockId] = entry;
            const { qty } = parseQtyText(rawQty);
            if (qty <= 0) continue;
            let si = stockId ? stockItems.find((s) => s.id === stockId) : null;
            if (!si) si = findStockItemByName(name, stockItems);
            if (si) applyStockMovement(si, -qty);
          }
        }
        window.showToast?.(`Requisição ${cur.code || id} entregue · estoque baixado`, { tone: "ok", ttl: 4000 });
      } else {
        window.showToast?.(`Requisição ${cur.code || id} separada`, { tone: "ok" });
      }
      setDetail(null);
    } finally {
      advancingRef.current.delete(id);
      setAdvancing(new Set(advancingRef.current));
    }
  };

  const revert = async (id) => {
    const cur = items.find((r) => r.id === id);
    if (!cur || cur.status !== "separated") return;
    setItems((prev) => prev.map((r) => r.id === id ? { ...r, status: "pending", separatedAt: null } : r));
    if (source === "db") {
      const { error } = await dbUpdateKitchenRequestStatus(id, "pending");
      if (error) {
        setItems((prev) => prev.map((r) => r.id === id ? { ...r, status: cur.status, separatedAt: cur.separatedAt } : r));
        window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
    }
    window.showToast?.(`Requisição ${cur.code || id} voltou para pendente`, { tone: "warn" });
    setDetail(null);
  };

  if (pageLoading) return <PageLoading label="Carregando requisições…" variant="cards" />;

  return (
    <MobilePage>
      <SegTabs value={tab} onChange={setTab} options={[
        { id: "pending", label: "Pendentes", count: counts.pending, tone: "warn" },
        { id: "separated", label: "Separadas", count: counts.separated, tone: "info" },
        { id: "delivered", label: "Entregues", count: counts.delivered, tone: "ok" },
      ]} />

      <MobileScroll style={{ padding: "12px 14px" }}>
        {list.length === 0 && prodList.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13 }}>
            Nenhuma requisição {tab === "pending" ? "pendente" : tab === "separated" ? "separada" : "entregue"}.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {prodList.map((c) => (
              <MobileCard key={c.id} onClick={() => setDetail(c)}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13.5, color: "var(--fg-0)", fontWeight: 600 }}>🏭 Produção</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-3)" }}>{c.code}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-0)", fontWeight: 600 }}>{c.total}</span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 4 }}>
                  {c.itemsCount} {c.itemsCount === 1 ? "insumo" : "insumos"}
                  {c.notes ? ` · ${c.notes}` : ""}
                </div>
              </MobileCard>
            ))}
            {list.map((r) => <RequestCard key={r.id} r={r} onTap={() => setDetail(r)} />)}
          </div>
        )}
      </MobileScroll>

      <MobileBottomBar>
        <MPrimaryButton onClick={() => { window.location.hash = "#/mobile"; }}>
          <I.Plus size={16} />Nova requisição
        </MPrimaryButton>
      </MobileBottomBar>

      {editingProd && (
        <ProdRequestEditSheet
          card={prodCards.find((c) => c.id === editingProd.id) || editingProd}
          stockItems={stockItems}
          onClose={() => setEditingProd(null)}
          onSaved={async () => {
            setEditingProd(null);
            const { data } = await dbListProductionOrders(tenantId);
            if (data) setProdOrders(data);
          }}
        />
      )}

      {detail && !editingProd && (detail.isProduction ? (
        <RequestDetailSheet
          r={prodCards.find((x) => x.id === detail.id) || detail}
          busy={advancing.has(detail.id)}
          onClose={() => setDetail(null)}
          onAdvance={() => advanceProd(prodCards.find((x) => x.id === detail.id) || detail)}
          onRevert={() => revertProd(prodCards.find((x) => x.id === detail.id) || detail)}
          onEdit={() => { setEditingProd(prodCards.find((x) => x.id === detail.id) || detail); setDetail(null); }}
        />
      ) : (
        <RequestDetailSheet
          r={items.find((x) => x.id === detail.id) || detail}
          busy={advancing.has(detail.id)}
          onClose={() => setDetail(null)}
          onAdvance={() => advance(detail.id)}
          onRevert={() => revert(detail.id)}
        />
      ))}
    </MobilePage>
  );
}

const _reqStatusMeta = { pending: { l: "Pendente", t: "warn" }, separated: { l: "Separada", t: "info" }, delivered: { l: "Entregue", t: "ok" } };
function _reqTime(r) {
  const iso = r.requestedAt || r.requested_at || r.created_at;
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function _reqOpName(r) {
  if (r.splits && r.splits.length > 1) return "Uso compartilhado";
  return (typeof MOCK !== "undefined" && MOCK.opById ? MOCK.opById(r.op)?.name : null) || r.op || "—";
}

function RequestCard({ r, onTap }) {
  const m = _reqStatusMeta[r.status] || _reqStatusMeta.pending;
  return (
    <MobileCard onClick={onTap}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-0)", fontWeight: 600 }}>{r.code || r.id}</span>
            <span style={{ fontSize: 12, color: "var(--fg-2)" }}>· {_reqOpName(r)}</span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 3 }}>
            {(r.items?.length || 0)} {(r.items?.length || 0) === 1 ? "item" : "itens"} · {r.by || "—"} · {_reqTime(r)}
          </div>
        </div>
        <MBadge tone={m.t}>{m.l}</MBadge>
      </div>
    </MobileCard>
  );
}

// Ajuste da separação no celular: corrige o que realmente saiu do estoque. O
// rendimento esperado é reajustado no banco pelo insumo mais limitante.
function ProdRequestEditSheet({ card, stockItems, onClose, onSaved }) {
  const byId = {}; (stockItems || []).forEach((i) => { byId[i.id] = i; });
  const [lines, setLines] = useState(() =>
    (card.order.inputs || []).map((l) => ({ itemId: l.itemId, qty: String(l.qty).replace(".", ","), original: l.qty }))
  );
  const [saving, setSaving] = useState(false);
  const num = (s) => {
    const n = parseFloat(String(s ?? "").trim().replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  };
  const valid = lines.map((l) => ({ ...l, item: byId[l.itemId], qtyN: num(l.qty) })).filter((l) => l.item && l.qtyN > 0);
  const ratio = (() => {
    let r = null;
    for (const prev of card.order.inputs || []) {
      if (!(prev.qty > 0)) continue;
      const now = valid.find((l) => l.item.id === prev.itemId);
      const x = (now ? now.qtyN : 0) / prev.qty;
      r = r == null ? x : Math.min(r, x);
    }
    return r;
  })();
  const willRescale = ratio != null && ratio > 0 && Math.abs(ratio - 1) > 0.0001;

  const save = async () => {
    if (saving || valid.length === 0) return;
    setSaving(true);
    try {
      const { error } = await dbReplaceProductionOrderInputs(
        card.id,
        valid.map((l) => ({ itemId: l.item.id, name: l.item.name, qty: l.qtyN, unit: l.item.unit })),
      );
      if (error) throw error;
      window.showToast?.(`Solicitação ${card.code} ajustada`, { tone: "ok" });
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro ao ajustar: ${e.message || e}`, { tone: "crit", ttl: 6000 });
      setSaving(false);
    }
  };

  return (
    <FullSheet
      title={`Ajustar ${card.code}`}
      subtitle="Corrija para o que realmente saiu do estoque"
      onBack={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={save} disabled={valid.length === 0} loading={saving}><I.Check size={15} />Salvar ajuste</MPrimaryButton>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {lines.map((l, i) => {
          const item = byId[l.itemId];
          const qtyN = num(l.qty);
          const cut = l.original != null && qtyN > 0 && qtyN < l.original;
          return (
            <div key={i} style={{ padding: "10px 12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)" }}>{item ? item.name : "—"}</span>
                <button onClick={() => setLines((cur) => cur.filter((_, k) => k !== i))} aria-label="Remover"
                  style={{ width: 36, height: 36, borderRadius: 8, flexShrink: 0, background: "transparent", border: "1px solid var(--line)", color: "var(--fg-3)", display: "grid", placeItems: "center" }}>
                  <I.X size={14} />
                </button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input value={l.qty} inputMode="decimal"
                  onChange={(e) => setLines((cur) => cur.map((x, k) => (k === i ? { ...x, qty: e.target.value } : x)))}
                  style={{ ...mInput, height: 42, textAlign: "right", borderColor: cut ? "var(--warn-line)" : "var(--line)" }} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-3)", width: 110, textAlign: "right", flexShrink: 0 }}>
                  {item ? `saldo ${(item.qty || 0).toLocaleString("pt-BR")} ${item.unit}` : "—"}
                </span>
              </div>
              {l.original != null && (
                <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", marginTop: 6 }}>
                  pedido: {l.original.toLocaleString("pt-BR")}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {willRescale && (
        <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.5 }}>
          O rendimento esperado será reajustado para <strong style={{ color: "var(--fg-0)" }}>{(ratio * 100).toFixed(0)}%</strong> do
          planejado — proporcional ao insumo mais limitante.
        </div>
      )}
    </FullSheet>
  );
}

function RequestDetailSheet({ r, busy, onClose, onAdvance, onRevert, onEdit }) {
  const m = _reqStatusMeta[r.status] || _reqStatusMeta.pending;
  const advanceLabel = r.status === "pending" ? "Marcar como separada" : r.status === "separated" ? "Confirmar entrega" : null;
  return (
    <BottomSheet
      title={`${r.code || r.id}`}
      subtitle={r.isProduction
        ? `🏭 Produção · ${r.itemsCount} insumo(s) · ${r.total}`
        : `${_reqOpName(r)} · ${r.by || "—"} · ${_reqTime(r)}`}
      onClose={onClose}
      footer={
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {advanceLabel && (
            <MPrimaryButton onClick={onAdvance} loading={busy}>
              {r.status === "separated" ? <I.Box size={16} /> : <I.Check size={16} />}{advanceLabel}
            </MPrimaryButton>
          )}
          {/* Faltou insumo? O separador corrige antes de marcar como separada. */}
          {onEdit && r.status === "pending" && (
            <button onClick={onEdit} style={{ width: "100%", height: 46, borderRadius: 10, background: "transparent", border: "1px solid var(--line)", color: "var(--fg-2)", fontSize: 14, fontWeight: 600 }}>
              Ajustar quantidades
            </button>
          )}
          {r.status === "separated" && (
            <button onClick={onRevert} style={{ width: "100%", height: 46, borderRadius: 10, background: "transparent", border: "1px solid var(--line)", color: "var(--fg-2)", fontSize: 14, fontWeight: 600 }}>
              Voltar para pendente
            </button>
          )}
        </div>
      }
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <MBadge tone={m.t}>{m.l}</MBadge>
        {r.status === "delivered" && (
          <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
            {r.isProduction ? "Baixado · aguardando devolução na Produção" : "Estoque já baixado"}
          </span>
        )}
      </div>
      {r.notes && <div style={{ fontSize: 12.5, color: "var(--fg-2)", marginBottom: 12, padding: "8px 10px", background: "var(--bg-2)", borderRadius: 8 }}>{r.notes}</div>}
      <MSectionLabel>Itens</MSectionLabel>
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column" }}>
        {(r.items || []).map((entry, i) => {
          const [name, qtyText] = Array.isArray(entry) ? entry : [entry?.name, entry?.qty];
          return (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--line-soft)", fontSize: 13.5 }}>
              <span style={{ color: "var(--fg-0)", flex: 1, minWidth: 0 }}>{name}</span>
              <span style={{ color: "var(--fg-2)", fontFamily: "var(--mono)", whiteSpace: "nowrap" }}>{qtyText}</span>
            </div>
          );
        })}
      </div>
    </BottomSheet>
  );
}

window.MobileRequestsBoard = MobileRequestsBoard;
