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
        const [reqRes, stockRes] = await Promise.all([
          dbListKitchenRequests(tid, { limit: 100 }),
          dbListStockItems(tid),
        ]);
        if (cancelled) return;
        if (reqRes.data && reqRes.source === "db") { setItems(reqRes.data); setSource("db"); }
        if (stockRes.data && stockRes.source === "db") setStockItems(stockRes.data);
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

  const counts = useMemo(() => ({
    pending: filtered.filter((r) => r.status === "pending").length,
    separated: filtered.filter((r) => r.status === "separated").length,
    delivered: filtered.filter((r) => r.status === "delivered").length,
  }), [filtered]);

  const list = filtered
    .filter((r) => r.status === tab)
    .sort((a, b) => String(b.requestedAt || b.requested_at || b.created_at || "").localeCompare(String(a.requestedAt || a.requested_at || a.created_at || "")));

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
        {list.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13 }}>
            Nenhuma requisição {tab === "pending" ? "pendente" : tab === "separated" ? "separada" : "entregue"}.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {list.map((r) => <RequestCard key={r.id} r={r} onTap={() => setDetail(r)} />)}
          </div>
        )}
      </MobileScroll>

      <MobileBottomBar>
        <MPrimaryButton onClick={() => { window.location.hash = "#/mobile"; }}>
          <I.Plus size={16} />Nova requisição
        </MPrimaryButton>
      </MobileBottomBar>

      {detail && (
        <RequestDetailSheet
          r={items.find((x) => x.id === detail.id) || detail}
          busy={advancing.has(detail.id)}
          onClose={() => setDetail(null)}
          onAdvance={() => advance(detail.id)}
          onRevert={() => revert(detail.id)}
        />
      )}
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

function RequestDetailSheet({ r, busy, onClose, onAdvance, onRevert }) {
  const m = _reqStatusMeta[r.status] || _reqStatusMeta.pending;
  const advanceLabel = r.status === "pending" ? "Marcar como separada" : r.status === "separated" ? "Confirmar entrega" : null;
  return (
    <BottomSheet
      title={`${r.code || r.id}`}
      subtitle={`${_reqOpName(r)} · ${r.by || "—"} · ${_reqTime(r)}`}
      onClose={onClose}
      footer={
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {advanceLabel && (
            <MPrimaryButton onClick={onAdvance} loading={busy}>
              {r.status === "separated" ? <I.Box size={16} /> : <I.Check size={16} />}{advanceLabel}
            </MPrimaryButton>
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
        {r.status === "delivered" && <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>Estoque já baixado</span>}
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
