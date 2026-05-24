// Requests page — Kanban Pendente → Separada → Entregue
function Requests({ scope }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  // Lançamentos existentes com status "approved" são tratados como "pending" no novo fluxo
  const [items, setItems] = useState(() =>
    MOCK.REQUESTS.map((r) => r.status === "approved" ? { ...r, status: "pending" } : r)
  );
  const [stockItems, setStockItems] = useState(MOCK.STOCK_ITEMS || []);
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource]     = useState("mock");
  const [pageLoading, setPageLoading] = useState(true);
  const [view, setView] = useState("kanban"); // kanban | list
  const [creating, setCreating] = useState(false);
  const [editingReq, setEditingReq] = useState(null);
  const [printingReq, setPrintingReq] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  // Carrega do DB quando online
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
        if (reqRes.data && reqRes.source === "db") {
          setItems(reqRes.data);
          setSource("db");
        }
        if (stockRes.data && stockRes.source === "db") {
          setStockItems(stockRes.data);
        } else if (stockRes.source === "db") {
          setStockItems([]); // DB online porém sem insumos cadastrados
        }
      } finally {
        if (!cancelled) setPageLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  // Realtime · atualiza itens quando kitchen_requests muda no DB
  useEffect(() => {
    if (!dbStatus.isOnline || !tenantId) return;
    return dbSubscribeTable("kitchen_requests", tenantId, async () => {
      const { data, source: src } = await dbListKitchenRequests(tenantId, { limit: 100 });
      if (data && src === "db") setItems(data);
    });
  }, [dbStatus.isOnline, tenantId]);

  // Quando setamos uma requisição p/ impressão, esperamos o React commitar o
  // template, abrimos o diálogo nativo de impressão, e limpamos depois.
  useEffect(() => {
    if (!printingReq) return;
    const t = setTimeout(() => {
      window.print();
      setPrintingReq(null);
    }, 60);
    return () => clearTimeout(t);
  }, [printingReq]);

  // Requisições com rateio aparecem em qualquer escopo cujas ops estejam no rateio
  const filtered = scope === "all"
    ? items
    : items.filter((r) =>
        r.op === scope ||
        (r.splits && r.splits.some((s) => s.op === scope))
      );

  const cols = [
    { id: "pending",   label: "Pendente",   tone: "warn", desc: "aguardando separação" },
    { id: "separated", label: "Separada",   tone: "info", desc: "aguarda retirada/entrega" },
    { id: "delivered", label: "Entregue",   tone: "ok",   desc: "consumo registrado" },
  ];

  const advance = async (id) => {
    const order = ["pending", "separated", "delivered"];
    const cur = items.find((r) => r.id === id);
    if (!cur) return;
    const next = order[Math.min(order.indexOf(cur.status) + 1, order.length - 1)];
    if (next === cur.status) return;

    setItems((prev) => prev.map((r) => r.id === id ? { ...r, status: next } : r));

    // Persiste status no DB se conectado
    if (source === "db") {
      const { error } = await dbUpdateKitchenRequestStatus(id, next);
      if (error) {
        // Rollback
        setItems((prev) => prev.map((r) => r.id === id ? { ...r, status: cur.status } : r));
        window.showToast(`Erro ao atualizar status: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
    }

    if (next === "delivered") {
      // Baixa automática do estoque · cada item da requisição vira saída.
      // Quando online, a baixa já foi feita pelo DB trigger durante o passo "separated".
      // O frontend só atualiza qty localmente para refletir na UI.
      let moved = 0, missed = 0;
      const missedNames = [];
      const dbOn = source === "db" && tenantId;
      for (const entry of cur.items) {
        const [name, rawQty, stockId] = entry;
        const { qty } = parseQtyText(rawQty);
        if (qty <= 0) continue;
        let stockItem = stockId ? stockItems.find((s) => s.id === stockId) : null;
        if (!stockItem) stockItem = findStockItemByName(name, stockItems);
        if (!stockItem) { missed++; missedNames.push(name); continue; }
        // No modo MOCK, aplica a saída direto; no modo DB o trigger já fez isso.
        if (!dbOn) {
          applyStockMovement(stockItem, -qty);
        }
        moved++;
      }
      if (dbOn) {
        // Re-fetch p/ atualizar qty exibidas nos pickers (refletindo o que o trigger fez)
        const { data } = await dbListStockItems(tenantId);
        if (data) setStockItems(data);
      }
      const baseMsg = `Requisição ${id} entregue · ${moved} insumo(s) baixado(s) do estoque`;
      window.showToast(
        missed > 0
          ? `${baseMsg} · ${missed} sem match (${missedNames.slice(0, 2).join(", ")}${missed > 2 ? "…" : ""})`
          : baseMsg,
        { tone: missed > 0 ? "warn" : "ok", ttl: 4500 },
      );
    } else {
      const label = { separated: "separada" }[next] || next;
      window.showToast(`Requisição ${id} ${label}`, { tone: "ok" });
    }
  };

  const handleEditSave = (id, draft) => {
    setItems((prev) => prev.map((r) => {
      if (r.id !== id) return r;
      // Recalcula total se houver custos por item; senão mantém o original
      const lineCosts = draft.lines.map((ln) => parseFloat(String(ln.estCost).replace(",", ".")));
      const allHaveCost = lineCosts.every((c) => Number.isFinite(c) && c > 0);
      const newTotal = allHaveCost
        ? "R$ " + lineCosts.reduce((s, c) => s + c, 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : r.total;
      return {
        ...r,
        items: draft.lines.map((ln) => [ln.name, ln.qty, ln.stock_item_id || null]),
        itemsCount: draft.lines.length,
        total: newTotal,
      };
    }));
    setEditingReq(null);
    window.showToast(`Requisição ${id} atualizada`, { tone: "ok" });
  };

  const handleCreate = async (draft) => {
    if (source === "db" && tenantId) {
      const code = `REQ-${Date.now().toString(36).slice(-6).toUpperCase()}`;
      const { data, error } = await dbInsertKitchenRequest(tenantId, {
        op:        draft.op,
        code,
        priority:  draft.priority,
        by:        draft.by || "Cozinha",
        notes:     draft.notes || null,
        items:     draft.lines.map((ln) => ({
          name:          ln.name,
          stock_item_id: ln.stock_item_id || null,
          qty:           parseFloat(String(ln.qty).replace(/[^\d.,]/g, "").replace(",", ".")) || 1,
          unit:          String(ln.qty).match(/[a-zA-Zçãáéíóú]+\s*$/)?.[0]?.trim() || "un",
          estCost:       parseFloat(String(ln.estCost).replace(",", ".")) || 0,
        })),
      });
      if (error) {
        window.showToast(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
      // Recarrega a lista pra ter a versão completa do banco
      const { data: refreshed } = await dbListKitchenRequests(tenantId, { limit: 100 });
      if (refreshed) setItems(refreshed);
      setCreating(false);
      window.showToast(`Requisição ${code} criada no Supabase`, { tone: "ok" });
      return;
    }
    // Fallback MOCK
    const nextNum = items.reduce((max, r) => {
      const n = parseInt(String(r.id).replace(/\D/g, ""), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0) + 1;
    const id = `REQ-${String(nextNum).padStart(4, "0")}`;
    const total = draft.lines.reduce((s, ln) => s + (parseFloat(ln.estCost) || 0), 0);
    const fmt = "R$ " + total.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const now = new Date();
    const at = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    // Se vier rateio, materializa valor por operação
    const splits = draft.splits ? draft.splits.map((s) => ({
      op: s.op,
      pct: s.pct,
      value: Number(((s.pct / 100) * total).toFixed(2)),
    })) : null;

    const newReq = {
      id,
      op: draft.op,           // operação primária (mesmo quando rateado)
      at,
      by: draft.by || "Cozinha",
      itemsCount: draft.lines.length,
      total: fmt,
      status: "pending",
      priority: draft.priority,
      age: "agora",
      items: draft.lines.map((ln) => [ln.name, ln.qty, ln.stock_item_id || null]),
      splits,
      notes: draft.notes || null,
    };
    setItems((prev) => [newReq, ...prev]);
    setCreating(false);

    if (splits) {
      const opNames = splits.map((s) => MOCK.opById(s.op).short).join(" / ");
      window.showToast(`Requisição ${id} criada · custo rateado entre ${opNames}`, { tone: "ok", ttl: 4000 });
    } else {
      window.showToast(`Requisição ${id} criada · aguardando aprovação`, { tone: "ok" });
    }
  };

  if (pageLoading) return <PageLoading label="Carregando requisições…" variant="cards" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "20px 28px 14px", display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div className="h-eyebrow" style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 10 }}>
            {filtered.filter((r) => r.status === "pending").length} pendentes · {filtered.length} hoje
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase",
              padding: "2px 7px", borderRadius: 99,
              color: source === "db" ? "var(--ok)" : "var(--fg-3)",
              background: source === "db" ? "var(--accent-soft)" : "var(--bg-2)",
              border: `1px solid ${source === "db" ? "var(--accent-line)" : "var(--line)"}`,
            }}>
              <span style={{ width: 5, height: 5, borderRadius: 50, background: source === "db" ? "var(--ok)" : "var(--fg-3)" }} />
              {source === "db" ? "Supabase" : "Mock"}
            </span>
          </div>
          <h1 className="h-title">Requisições</h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Tabs value={view} onChange={setView} options={[
            { id: "kanban", label: "Kanban", count: 3 },
            { id: "list",   label: "Lista",  count: filtered.length },
          ]} />
          <button className="btn" data-size="sm" onClick={() => setShowHistory(true)}>
            <I.Calendar size={13} />Histórico
          </button>
          <button className="btn" data-variant="primary" data-size="sm" onClick={() => setCreating(true)}>
            <I.Plus size={13} />Nova requisição
          </button>
        </div>
      </div>

      {view === "kanban" ? (
        <div style={{ flex: 1, padding: "0 28px 24px", overflow: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, height: "100%" }}>
            {cols.map((col) => {
              const todayStr = new Date().toDateString();
              const colItems = filtered.filter((r) => {
                if (r.status !== col.id) return false;
                // Coluna "Entregue" mostra apenas as do dia corrente
                if (col.id === "delivered") {
                  const t = r.requestedAt || r.deliveredAt;
                  if (!t) return false;
                  return new Date(t).toDateString() === todayStr;
                }
                return true;
              });
              return (
                <div key={col.id} style={{ display: "flex", flexDirection: "column", background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 4, overflow: "hidden", minHeight: 200 }}>
                  <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line-soft)", display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="badge" data-tone={col.tone}>{col.label}</span>
                      <span style={{ flex: 1 }} />
                      <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>{colItems.length}</span>
                    </div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{col.desc}</div>
                  </div>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, padding: 10, overflow: "auto" }} className="stagger">
                    {colItems.length === 0 && <div style={{ fontSize: 11, color: "var(--fg-3)", textAlign: "center", padding: 20 }}>—</div>}
                    {colItems.map((r) => (
                      <RequestCard
                        key={r.id}
                        r={r}
                        onAdvance={() => advance(r.id)}
                        canAdvance={col.id !== "delivered"}
                        onEdit={col.id === "pending" ? () => setEditingReq(r) : null}
                        onPrint={col.id === "pending" ? () => setPrintingReq(r) : null}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, overflow: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Operação</th>
                <th>Solicitante</th>
                <th className="num">Itens</th>
                <th className="num">Total</th>
                <th>Idade</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const op = MOCK.opById(r.op);
                const tone = r.status === "pending" ? "warn" : r.status === "delivered" ? "ok" : "info";
                const lbl = { pending: "Pendente", separated: "Separada", delivered: "Entregue" }[r.status];
                return (
                  <tr key={r.id} onClick={() => setEditingReq(r)} style={{ cursor: "pointer" }}
                      title="Clique para abrir os detalhes da requisição">
                    <td><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><span style={{ width: 6, height: 6, borderRadius: 50, background: op.color }} />{op.name}</span></td>
                    <td className="dim">{r.by}</td>
                    <td className="num">{r.itemsCount}</td>
                    <td className="num">{r.total}</td>
                    <td className="dim mono" style={{ fontSize: 11 }}>{r.age}</td>
                    <td><span className="badge" data-tone={tone}>{lbl}</span></td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        {r.status === "pending" && (
                          <>
                            <button className="btn" data-variant="ghost" data-size="sm" onClick={() => setPrintingReq(r)} title="Imprimir">
                              <I.Print size={11} />
                            </button>
                            <button className="btn" data-variant="ghost" data-size="sm" onClick={() => setEditingReq(r)}>
                              <I.Edit size={11} />Editar
                            </button>
                          </>
                        )}
                        {r.status !== "delivered" && (
                          <button className="btn" data-variant="ghost" data-size="sm" onClick={() => advance(r.id)}>Avançar <I.ChevronR size={11} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <NewRequestModal
          defaultOp={scope !== "all" ? scope : null}
          stockItems={stockItems}
          onCancel={() => setCreating(false)}
          onSubmit={handleCreate}
        />
      )}

      {editingReq && (
        <EditRequestModal
          request={editingReq}
          stockItems={stockItems}
          onCancel={() => setEditingReq(null)}
          onSubmit={(draft) => handleEditSave(editingReq.id, draft)}
        />
      )}

      {printingReq && <PrintTicket request={printingReq} />}

      {showHistory && (
        <RequestsHistoryModal
          requests={items}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}

// Histórico de requisições — dashboard mês × operação com filtro de período.
// requestedAt no DB vem em ISO; no MOCK usamos r.at + data fictícia (created hoje).
function RequestsHistoryModal({ requests = [], onClose }) {
  const MONTH_PT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const ops = useMemo(
    () => (MOCK.OPERATIONS || []).filter((o) => o.id !== "all"),
    []
  );

  // Normaliza data de cada request → YYYY-MM. Fallback: hoje (MOCK sem timestamp).
  const enriched = useMemo(() =>
    (requests || []).map((r) => {
      const iso = r.requestedAt || r.requested_at || r.created_at || new Date().toISOString();
      const d = new Date(iso);
      return {
        ...r,
        _date: d,
        _ym: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      };
    }), [requests]);

  // Lista única de meses presentes nos dados, ordenada (mais novo no fim)
  const monthsAvailable = useMemo(() => {
    const set = new Set(enriched.map((r) => r._ym));
    return [...set].sort();
  }, [enriched]);

  // Filtro: "all" mostra todos os meses; senão filtra por YYYY-MM
  const [monthFilter, setMonthFilter] = useState("all");
  const filtered = useMemo(() =>
    monthFilter === "all" ? enriched : enriched.filter((r) => r._ym === monthFilter),
    [enriched, monthFilter]
  );

  // Matriz mês × operação
  // Coluna virtual para requisições compartilhadas (sem operação atribuída).
  const SHARED_KEY = "__shared__";
  const opsWithShared = useMemo(
    () => [...ops, { id: SHARED_KEY, slug: SHARED_KEY, name: "Compartilhado", short: "COMP", color: "#94a3b8" }],
    [ops]
  );

  // Resolve qualquer formato de r.op (slug ou UUID) para o id canônico (UUID) da ops list.
  // Sem match → SHARED_KEY (requisição compartilhada/sem operação).
  const resolveOpKey = (r) => {
    const raw = r.op || r.operationId;
    if (!raw) return SHARED_KEY;
    const byId   = ops.find((o) => o.id === raw);
    if (byId) return byId.id;
    const bySlug = ops.find((o) => o.slug === raw);
    if (bySlug) return bySlug.id;
    return SHARED_KEY;
  };

  const matrix = useMemo(() => {
    const months = monthFilter === "all" ? monthsAvailable : [monthFilter];
    const rows = months.map((ym) => {
      const [y, m] = ym.split("-");
      const label = `${MONTH_PT[Number(m) - 1]}/${y.slice(-2)}`;
      const byOp = {};
      let total = 0;
      opsWithShared.forEach((op) => { byOp[op.id] = 0; });
      enriched
        .filter((r) => r._ym === ym)
        .forEach((r) => {
          byOp[resolveOpKey(r)] += 1;
          total += 1;
        });
      return { ym, label, byOp, total };
    });
    return rows;
  }, [enriched, monthsAvailable, monthFilter, opsWithShared]);

  const totals = useMemo(() => {
    const byOp = {};
    opsWithShared.forEach((op) => { byOp[op.id] = 0; });
    filtered.forEach((r) => { byOp[resolveOpKey(r)] += 1; });
    return { byOp, grand: filtered.length };
  }, [filtered, opsWithShared]);

  const fmtMonthOption = (ym) => {
    const [y, m] = ym.split("-");
    return `${MONTH_PT[Number(m) - 1]}/${y}`;
  };

  // Para shading da heatmap, pega o max para escalar opacidade
  const maxCell = useMemo(() => {
    let max = 0;
    matrix.forEach((row) => opsWithShared.forEach((op) => {
      if (row.byOp[op.id] > max) max = row.byOp[op.id];
    }));
    return max;
  }, [matrix, opsWithShared]);

  const cellBg = (v) => {
    if (!v || maxCell === 0) return "transparent";
    const intensity = 0.15 + (v / maxCell) * 0.45;
    return `rgba(56, 189, 248, ${intensity.toFixed(2)})`;
  };

  return (
    <Modal
      title="Histórico de requisições"
      subtitle={`${filtered.length} requisição(ões) · ${monthsAvailable.length} ${monthsAvailable.length === 1 ? "mês com dados" : "meses com dados"}`}
      onClose={onClose}
      width={820}
      footer={<button className="btn" data-size="sm" onClick={onClose}>Fechar</button>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Filtro de mês */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="h-eyebrow" style={{ margin: 0 }}>Período</span>
          <select
            className="select"
            value={monthFilter}
            onChange={(e) => setMonthFilter(e.target.value)}
            style={{ padding: "4px 8px", fontSize: 12, minWidth: 160 }}
          >
            <option value="all">Todos os meses</option>
            {[...monthsAvailable].reverse().map((ym) => (
              <option key={ym} value={ym}>{fmtMonthOption(ym)}</option>
            ))}
          </select>
        </div>

        {/* KPIs resumo */}
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${opsWithShared.length + 1}, 1fr)`, gap: 8 }}>
          <div style={{
            padding: "10px 12px", background: "var(--bg-2)",
            border: "1px solid var(--accent-line)", borderRadius: 4,
          }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Total</div>
            <div style={{ fontSize: 20, color: "var(--fg-0)", fontWeight: 500, marginTop: 2 }}>{totals.grand}</div>
          </div>
          {opsWithShared.map((op) => (
            <div key={op.id} style={{
              padding: "10px 12px", background: "var(--bg-2)",
              border: "1px solid var(--line)", borderRadius: 4,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                <span style={{ width: 6, height: 6, borderRadius: 50, background: op.color }} />
                {op.short || op.name}
              </div>
              <div style={{ fontSize: 18, color: "var(--fg-0)", fontWeight: 500, marginTop: 2 }}>{totals.byOp[op.id] || 0}</div>
            </div>
          ))}
        </div>

        {/* Heatmap mês × operação */}
        <div style={{ overflow: "auto", border: "1px solid var(--line-soft)", borderRadius: 4 }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                <th style={{ padding: "8px 12px", textAlign: "left", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 400, background: "var(--bg-2)" }}>Mês</th>
                {opsWithShared.map((op) => (
                  <th key={op.id} style={{ padding: "8px 12px", textAlign: "center", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 400, background: "var(--bg-2)" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 6, height: 6, borderRadius: 50, background: op.color }} />
                      {op.short || op.name}
                    </span>
                  </th>
                ))}
                <th style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 400, background: "var(--bg-2)" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {matrix.length === 0 ? (
                <tr><td colSpan={opsWithShared.length + 2} style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>Sem requisições no período</td></tr>
              ) : matrix.map((row) => (
                <tr key={row.ym}>
                  <td style={{ padding: "8px 12px", borderTop: "1px solid var(--line-soft)", fontSize: 12, color: "var(--fg-0)", fontWeight: 500 }}>{row.label}</td>
                  {opsWithShared.map((op) => {
                    const v = row.byOp[op.id] || 0;
                    return (
                      <td key={op.id} style={{
                        padding: "8px 12px", borderTop: "1px solid var(--line-soft)",
                        textAlign: "center", background: cellBg(v),
                        fontFamily: "var(--mono)", fontSize: 12,
                        color: v > 0 ? "var(--fg-0)" : "var(--fg-3)", fontWeight: v > 0 ? 500 : 400,
                      }}>{v}</td>
                    );
                  })}
                  <td className="mono" style={{ padding: "8px 12px", borderTop: "1px solid var(--line-soft)", textAlign: "right", fontSize: 12, color: "var(--fg-0)", fontWeight: 500 }}>{row.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}

function RequestCard({ r, onAdvance, canAdvance, onEdit, onPrint }) {
  const op = MOCK.opById(r.op);
  const tone = r.priority === "high" ? "crit" : "neutral";
  return (
    <div style={{ background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 6, height: 6, borderRadius: 50, background: op.color }} />
        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--fg-0)" }}>{op.name}</span>
        <span style={{ flex: 1 }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {r.items.slice(0, 3).map((it, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}>
            <span style={{ color: "var(--fg-1)" }}>{it[0]}</span>
            <span className="mono" style={{ color: "var(--fg-2)" }}>{it[1]}</span>
          </div>
        ))}
        {r.items.length > 3 && <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>+{r.items.length - 3} itens</div>}
      </div>
      {r.splits && r.splits.length > 1 && (
        <div style={{
          paddingTop: 8, borderTop: "1px solid var(--line-soft)",
          display: "flex", flexDirection: "column", gap: 4,
        }}>
          <div style={{
            fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)",
            letterSpacing: "0.06em", textTransform: "uppercase",
          }}>
            Rateado entre {r.splits.length} operações
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 10.5 }}>
            {r.splits.map((s) => {
              const sop = MOCK.opById(s.op);
              return (
                <span key={s.op} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 5, height: 5, borderRadius: 50, background: sop.color }} />
                  <span style={{ color: "var(--fg-2)" }}>{sop.short}</span>
                  <span className="mono" style={{ color: "var(--fg-0)" }}>{s.pct}%</span>
                </span>
              );
            })}
          </div>
        </div>
      )}
      {r.notes && (
        <div style={{
          padding: "6px 8px", borderRadius: 3,
          background: "var(--bg-1)", border: "1px solid var(--line-soft)",
          fontSize: 11, color: "var(--fg-1)", fontStyle: "italic",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          “{r.notes}”
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 8, borderTop: "1px solid var(--line-soft)" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>{r.at} · {r.age}</span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-0)", fontWeight: 500 }}>{r.total}</span>
      </div>
      {r.priority === "high" && <span className="badge" data-tone="crit" style={{ alignSelf: "flex-start" }}>Prioridade alta</span>}
      {(canAdvance || onEdit || onPrint) && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {onPrint && (
            <button className="btn" data-size="sm" onClick={onPrint} title="Imprimir (papel térmico)"
                    style={{ justifyContent: "center", padding: "5px 9px" }}>
              <I.Print size={12} />
            </button>
          )}
          {onEdit && (
            <button className="btn" data-size="sm" onClick={onEdit} style={{ flex: 1, justifyContent: "center" }}>
              <I.Edit size={11} />Editar
            </button>
          )}
          {canAdvance && (
            <button className="btn" data-variant="primary" data-size="sm" onClick={onAdvance}
                    style={{ flex: 1, justifyContent: "center" }}>
              {r.status === "pending" ? "Separar" : "Confirmar entrega"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ===== Cupom térmico para impressão (visível apenas em @media print) =====
function PrintTicket({ request }) {
  const op = MOCK.opById(request.op);

  return (
    <div className="print-area">
      <div className="rule-double" />
      <div className="center bold">COZINHA CENTRAL SP</div>
      <div className="center">Requisição interna</div>
      <div className="rule-double" />

      <div className="row">
        <span className="bold">{request.id}</span>
        <span>{request.at}</span>
      </div>
      <div className="row">
        <span>Operação:</span>
        <span className="bold">{op.short}</span>
      </div>
      <div>{op.name}</div>
      <div>Solicitante: {request.by}</div>
      {request.priority === "high" && (
        <div className="bold center" style={{ marginTop: "2mm", border: "1px solid black", padding: "1mm" }}>
          ** PRIORIDADE ALTA **
        </div>
      )}
      {request.notes && (
        <div style={{ marginTop: "2mm", whiteSpace: "pre-wrap" }}>
          <span className="bold">Obs.:</span> {request.notes}
        </div>
      )}

      <div className="rule" />
      <div className="bold">ITENS ({request.items.length})</div>
      <div className="rule" />

      {request.items.map(([name, qty], i) => (
        <div key={i} className="row" style={{ marginBottom: "1mm" }}>
          <span className="bold">{name}</span>
          <span style={{ whiteSpace: "nowrap" }}>{qty} - [ &nbsp;&nbsp;&nbsp; ]</span>
        </div>
      ))}

      <div className="rule-double" />
      <div className="row bold">
        <span>TOTAL ESTIMADO</span>
        <span>{request.total}</span>
      </div>

      {request.splits && request.splits.length > 1 && (
        <>
          <div className="rule" />
          <div className="bold">Rateado entre {request.splits.length} ops:</div>
          {request.splits.map((s) => {
            const sop = MOCK.opById(s.op);
            return (
              <div key={s.op} className="row">
                <span>{sop.short} ({s.pct}%)</span>
                <span>R$ {s.value.toFixed(2)}</span>
              </div>
            );
          })}
        </>
      )}

      <div className="rule-double" />
    </div>
  );
}

// ===== Modal de edição da requisição (somente em status pendente) =====
// Itens são travados ao catálogo de estoque · usuário pode editar qty ou
// remover linhas, mas o insumo (nome+unidade+custo) sai do MOCK.STOCK_ITEMS.
function EditRequestModal({ request, onCancel, onSubmit, stockItems = MOCK.STOCK_ITEMS }) {
  const [lines, setLines] = useState(() =>
    request.items.map((entry) => {
      const [name, qtyText, stockId] = entry;
      const item = stockId ? stockItems.find((s) => s.id === stockId)
                           : (stockItems.find((s) => s.name === name) || findStockItemByName(name));
      const { qty } = parseQtyText(qtyText);
      return {
        stock_item_id: item?.id || "",
        legacyName: name, // exibe só se o item não casar mais com o estoque
        qty: String(qty || ""),
      };
    })
  );

  const validLines = lines.filter((ln) => ln.stock_item_id && parseFloat(String(ln.qty).replace(",", ".")) > 0);
  const valid = validLines.length > 0;
  const op = MOCK.opById(request.op);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmitClick = async () => {
    if (submitting || !valid) return;
    setSubmitting(true);
    try {
      await onSubmit({ lines: validLines.map((ln) => buildSubmitLine(ln)) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={`Editar requisição ${request.id}`}
      subtitle="Ajuste quantidades ou remova itens · insumos vêm do catálogo do estoque."
      onClose={onCancel}
      width={820}
      minHeight="92vh"
      footer={<>
        <button className="btn" data-size="sm" onClick={onCancel} disabled={submitting}>Cancelar</button>
        <button className="btn" data-variant="primary" data-size="sm" disabled={!valid || submitting}
                onClick={handleSubmitClick}>
          {submitting ? "Salvando…" : "Salvar alterações"}
        </button>
      </>}
    >
      <div style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--fg-2)" }}>
        <span style={{ width: 8, height: 8, borderRadius: 50, background: op.color }} />
        <span style={{ color: "var(--fg-0)", fontWeight: 500 }}>{op.name}</span>
        <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
          {request.by} · {request.at}
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ color: "var(--fg-0)" }}>{request.total}</span>
      </div>

      <StockLinesEditor
        lines={lines} setLines={setLines}
        allowAdd /* permite adicionar novo item na edição */
        emptyHint="Nenhum item · selecione um insumo ou cancele"
        stockItems={stockItems}
      />
    </Modal>
  );
}

// Converte uma linha do formulário no formato salvo da requisição
function buildSubmitLine(ln, stockItems = MOCK.STOCK_ITEMS) {
  const item = stockItems.find((s) => s.id === ln.stock_item_id);
  const qtyN = parseFloat(String(ln.qty).replace(",", ".")) || 0;
  const cost = (item?.cost || 0) * qtyN;
  return {
    name: item?.name || ln.legacyName || "",
    qty:  item ? `${qtyN} ${item.unit}` : String(qtyN),
    estCost: cost.toFixed(2),
    stock_item_id: item?.id || null,
  };
}

// Combobox · botão que abre popover com input de busca + lista filtrada.
// O popover é renderizado via portal no document.body com position: fixed pra
// escapar do overflow:auto do modal (senão fica recortado pela borda inferior).
// Filtro por nome ou categoria, acento/case-insensitive.
function StockItemPicker({ items, value, onChange, disabledIds = [], unmatchedHint }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0, openUp: false });
  const ref = useRef(null);
  const popRef = useRef(null);
  const inputRef = useRef(null);
  const [activeIdx, setActiveIdx] = useState(0);

  const selected = items.find((it) => it.id === value) || null;

  // Posiciona o popover relativo ao trigger; abre pra cima se faltar espaço embaixo.
  useEffect(() => {
    if (!open || !ref.current) return;
    const computePos = () => {
      const r = ref.current.getBoundingClientRect();
      const POP_H = 320; // altura aproximada do popover
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < POP_H && r.top > POP_H;
      setPos({
        top:  openUp ? r.top - 4 : r.bottom + 4,
        left: r.left,
        width: r.width,
        openUp,
      });
    };
    computePos();
    window.addEventListener("scroll", computePos, true);
    window.addEventListener("resize", computePos);
    return () => {
      window.removeEventListener("scroll", computePos, true);
      window.removeEventListener("resize", computePos);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      const t = e.target;
      const inTrigger = ref.current && ref.current.contains(t);
      const inPop     = popRef.current && popRef.current.contains(t);
      if (!inTrigger && !inPop) {
        setOpen(false); setSearch("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Reset focus index quando filtra
  useEffect(() => { setActiveIdx(0); }, [search, open]);

  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const q = norm(search.trim());
  const filtered = q
    ? items.filter((it) => norm(it.name).includes(q) || norm(it.cat).includes(q))
    : items;

  const pick = (it) => {
    if (disabledIds.includes(it.id) && it.id !== value) return;
    onChange(it.id);
    setOpen(false);
    setSearch("");
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") { setOpen(false); setSearch(""); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = filtered[activeIdx];
      if (it) pick(it);
    }
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" className="select"
              onClick={() => setOpen((o) => !o)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                width: "100%", textAlign: "left", cursor: "pointer", gap: 6,
                ...(unmatchedHint && !selected ? { borderColor: "var(--warn)", color: "var(--warn)" } : null),
                ...(open ? { borderColor: "var(--accent-line)" } : null),
              }}
              title={selected?.name}>
        <span style={{
          flex: 1, minWidth: 0,
          color: selected ? "var(--fg-0)" : (unmatchedHint ? "var(--warn)" : "var(--fg-3)"),
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {selected
            ? selected.name
            : unmatchedHint
              ? `⚠ "${unmatchedHint}" · selecione novamente`
              : "Selecione um insumo…"}
        </span>
        <I.Chevron size={11} style={{
          color: "var(--fg-3)", flexShrink: 0,
          transform: open ? "rotate(180deg)" : null,
          transition: "transform 120ms ease",
        }} />
      </button>

      {open && ReactDOM.createPortal((
        <div ref={popRef} style={{
          position: "fixed",
          top: pos.openUp ? "auto" : pos.top,
          bottom: pos.openUp ? `calc(100vh - ${pos.top}px)` : "auto",
          left: pos.left, width: pos.width,
          background: "var(--bg-2)", border: "1px solid var(--line-strong)",
          borderRadius: 4, zIndex: 400,
          boxShadow: "0 12px 32px -8px rgba(0,0,0,0.55)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{ padding: 6, borderBottom: "1px solid var(--line-soft)", position: "relative" }}>
            <I.Search size={11} style={{
              position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)",
              color: "var(--fg-3)", pointerEvents: "none",
            }} />
            <input ref={inputRef} className="input" autoFocus value={search}
                   placeholder="Digite para buscar…"
                   onChange={(e) => setSearch(e.target.value)}
                   onKeyDown={onKeyDown}
                   style={{ width: "100%", paddingLeft: 26, fontSize: 12 }} />
          </div>
          <div style={{ maxHeight: 260, overflow: "auto" }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 14, fontSize: 12, color: "var(--fg-3)", textAlign: "center" }}>
                Nenhum insumo encontrado
              </div>
            ) : filtered.map((it, idx) => {
              const isDisabled = disabledIds.includes(it.id) && it.id !== value;
              const isSelected = it.id === value;
              const isActive = idx === activeIdx;
              return (
                <button key={it.id} type="button"
                        onClick={() => pick(it)}
                        onMouseEnter={() => setActiveIdx(idx)}
                        disabled={isDisabled}
                        style={{
                          display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
                          width: "100%", textAlign: "left", border: "none",
                          padding: "6px 10px",
                          cursor: isDisabled ? "not-allowed" : "pointer",
                          background: isActive
                            ? "var(--bg-3)"
                            : isSelected ? "var(--accent-soft)" : "transparent",
                          color: isSelected ? "var(--fg-0)"
                              : isDisabled ? "var(--fg-3)"
                              : "var(--fg-1)",
                          fontSize: 12,
                          opacity: isDisabled ? 0.55 : 1,
                        }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                    {isSelected && <I.Check size={10} style={{ color: "var(--accent-bright)" }} />}
                    <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {it.name}
                    </span>
                    {isDisabled && (
                      <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
                        já adicionado
                      </span>
                    )}
                  </span>
                  <span style={{
                    fontFamily: "var(--mono)", fontSize: 9.5,
                    color: "var(--fg-3)", letterSpacing: "0.04em",
                  }}>
                    {it.cat} · {it.unit}
                  </span>
                </button>
              );
            })}
          </div>
          <div style={{
            padding: "5px 10px", borderTop: "1px solid var(--line-soft)",
            fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)",
            letterSpacing: "0.04em", display: "flex", justifyContent: "space-between",
          }}>
            <span>↑↓ navegar · enter selecionar · esc fechar</span>
            <span>{filtered.length} {filtered.length === 1 ? "item" : "itens"}</span>
          </div>
        </div>
      ), document.body)}
    </div>
  );
}

// Editor de linhas que força seleção de itens do estoque.
// Estado por linha: { stock_item_id, qty } · nome/unit/custo derivam do MOCK.
function StockLinesEditor({ lines, setLines, allowAdd, emptyHint, stockItems = MOCK.STOCK_ITEMS }) {
  const setLine    = (i, k, v) => setLines(lines.map((ln, j) => j === i ? { ...ln, [k]: v } : ln));
  const removeLine = (i)        => setLines(lines.filter((_, j) => j !== i));
  const addLine    = ()         => setLines([...lines, { stock_item_id: "", qty: "" }]);

  // Itens já selecionados (excluindo a linha atual) para evitar duplicar
  const usedIds = (currentIdx) =>
    new Set(lines.filter((_, j) => j !== currentIdx).map((ln) => ln.stock_item_id).filter(Boolean));

  // Catálogo ordenado por nome
  const catalog = useMemo(() =>
    [...(stockItems || [])].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [stockItems]
  );

  const validCount = lines.filter((ln) => ln.stock_item_id && parseFloat(String(ln.qty).replace(",", ".")) > 0).length;
  const totalEst   = lines.reduce((s, ln) => {
    const item = catalog.find((it) => it.id === ln.stock_item_id);
    const qtyN = parseFloat(String(ln.qty).replace(",", ".")) || 0;
    return s + (item ? item.cost * qtyN : 0);
  }, 0);

  return (
    <>
      <div className="h-eyebrow" style={{ marginBottom: 8 }}>Itens · {validCount}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {lines.map((ln, i) => {
          const item = catalog.find((s) => s.id === ln.stock_item_id);
          const qtyN = parseFloat(String(ln.qty).replace(",", ".")) || 0;
          const estCost = item ? item.cost * qtyN : 0;
          const taken = usedIds(i);
          const unmatched = !item && ln.legacyName;
          return (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 90px 50px 110px 32px", gap: 10, alignItems: "center" }}>
              <StockItemPicker
                items={catalog}
                value={ln.stock_item_id}
                onChange={(id) => setLine(i, "stock_item_id", id)}
                disabledIds={Array.from(taken)}
                unmatchedHint={unmatched ? ln.legacyName : null}
              />
              <input className="input mono" value={ln.qty} placeholder="0"
                     inputMode="decimal"
                     onChange={(e) => setLine(i, "qty", e.target.value)}
                     style={{ textAlign: "right", padding: "4px 8px" }}
                     disabled={!item} />
              <span style={{
                fontFamily: "var(--mono)", fontSize: 11,
                color: item ? "var(--fg-2)" : "var(--fg-3)",
                textAlign: "center",
              }}>
                {item?.unit || "—"}
              </span>
              <span className="mono" style={{
                fontSize: 11.5,
                color: estCost > 0 ? "var(--fg-1)" : "var(--fg-3)",
                textAlign: "right",
              }}>
                {estCost > 0 ? "R$ " + estCost.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}
              </span>
              <button type="button" className="btn" data-variant="ghost" data-size="sm"
                      onClick={() => removeLine(i)} style={{ padding: "4px 6px" }} title="Remover item"
                      disabled={lines.length === 1 && !allowAdd}>
                <I.X size={11} />
              </button>
            </div>
          );
        })}
        {allowAdd && (
          <button type="button" className="btn" data-variant="ghost" data-size="sm"
                  onClick={addLine} style={{ alignSelf: "flex-start" }}>
            <I.Plus size={11} />Adicionar item
          </button>
        )}
        {lines.length === 0 && (
          <div style={{
            padding: "16px 12px", textAlign: "center", fontSize: 11.5,
            color: "var(--warn)", background: "var(--bg-2)", border: "1px dashed var(--line)", borderRadius: 4,
          }}>
            {emptyHint || "Nenhum item · selecione um insumo do estoque"}
          </div>
        )}
      </div>

      <div style={{
        marginTop: 16, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center",
        background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4,
      }}>
        <span className="h-eyebrow">Total estimado</span>
        <span className="mono" style={{ fontSize: 16, fontWeight: 500, color: "var(--fg-0)" }}>
          R$ {totalEst.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>
    </>
  );
}

function NewRequestModal({ defaultOp, onCancel, onSubmit, stockItems = MOCK.STOCK_ITEMS }) {
  const ops = MOCK.OPERATIONS.filter((o) => o.id !== "all");
  const SHARED = "shared";
  const [op, setOp] = useState(defaultOp || ops[0]?.id || "");
  const [by, setBy] = useState("");
  const [priority, setPriority] = useState("normal");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([{ stock_item_id: "", qty: "" }]);

  // Rateio entre operações (ativo quando op === SHARED)
  const splitMode = op === SHARED;
  const [splits, setSplits] = useState({}); // { opId: pct }

  // Faturamento por operação (somente confirmados) · usado p/ rateio proporcional.
  // Quando online, busca do Supabase; offline, cai no MOCK.
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false };
  const [dbRevenueEntries, setDbRevenueEntries] = useState(null);
  useEffect(() => {
    if (!dbStatus.isOnline) { setDbRevenueEntries(null); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext?.();
      const tid = ctx?.tenant?.id;
      if (!tid) return;
      const { data } = await dbListRevenueEntries(tid);
      if (!cancelled && data) setDbRevenueEntries(data);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.isOnline]);

  const revenueByOp = useMemo(() => {
    const r = {};
    const source = dbRevenueEntries || MOCK.REVENUE_ENTRIES || [];
    // MOCK.OPERATIONS usa id=UUID quando vem do Supabase; e.op é slug, e.operationId é UUID.
    // Indexa o resultado pelas duas chaves para casar com qualquer formato.
    source.forEach((e) => {
      if (e.status !== "confirmed") return;
      const rev = e.revenue || 0;
      if (e.op)          r[e.op]          = (r[e.op]          || 0) + rev;
      if (e.operationId) r[e.operationId] = (r[e.operationId] || 0) + rev;
    });
    return r;
  }, [dbRevenueEntries]);

  // Distribui 100% entre os ids segundo um peso (qualquer função peso → número >= 0)
  const distributeBy = (ids, weightFn) => {
    if (ids.length === 0) return {};
    const weights = ids.map(weightFn);
    const totalW  = weights.reduce((s, v) => s + v, 0);
    const next = {};
    if (totalW <= 0) {
      // Fallback: divide igualmente
      const each = Math.floor((100 / ids.length) * 100) / 100;
      ids.forEach((id, i) => {
        next[id] = i === ids.length - 1
          ? Number((100 - each * (ids.length - 1)).toFixed(2))
          : each;
      });
      return next;
    }
    let assigned = 0;
    ids.forEach((id, i) => {
      if (i === ids.length - 1) {
        next[id] = Number((100 - assigned).toFixed(2));
      } else {
        const pct = Number((((weights[i]) / totalW) * 100).toFixed(2));
        next[id] = pct;
        assigned += pct;
      }
    });
    return next;
  };

  const splitByRevenue = (idsArg) => {
    const ids = idsArg || Object.keys(splits);
    if (ids.length === 0) return;
    const totalRev = ids.reduce((s, id) => s + (revenueByOp[id] || 0), 0);
    if (totalRev <= 0) {
      window.showToast("Sem faturamento confirmado · usando divisão igual", { tone: "warn" });
      setSplits(distributeBy(ids, () => 1));
      return;
    }
    setSplits(distributeBy(ids, (id) => revenueByOp[id] || 0));
  };

  const splitEqually = (idsArg) => {
    const ids = idsArg || Object.keys(splits);
    if (ids.length === 0) return;
    setSplits(distributeBy(ids, () => 1));
  };

  // Quando muda para "Uso compartilhado", inicia o rateio proporcional ao faturamento.
  // Quando muda para uma operação específica, limpa o rateio.
  // Recompõe quando o faturamento do DB chegar (assíncrono).
  useEffect(() => {
    if (op === SHARED) {
      const allIds = ops.map((o) => o.id);
      const totalRev = allIds.reduce((s, id) => s + (revenueByOp[id] || 0), 0);
      if (totalRev > 0) {
        setSplits(distributeBy(allIds, (id) => revenueByOp[id] || 0));
      } else {
        setSplits(distributeBy(allIds, () => 1));
      }
    } else {
      setSplits({});
    }
  }, [op, revenueByOp]);

  const toggleSplitOp = (opId) => {
    setSplits((cur) => {
      if (cur[opId] != null) {
        const next = {};
        for (const k of Object.keys(cur)) if (k !== opId) next[k] = cur[k];
        return next;
      }
      return { ...cur, [opId]: 0 };
    });
  };

  const setSplitPct = (opId, raw) => {
    const v = parseFloat(String(raw).replace(",", "."));
    setSplits((cur) => ({ ...cur, [opId]: Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0 }));
  };

  const splitEntries = Object.entries(splits);
  const splitSum = splitEntries.reduce((s, [, v]) => s + (Number(v) || 0), 0);
  const splitValid = splitMode
    ? splitEntries.length >= 2 && Math.abs(splitSum - 100) < 0.5
    : true;

  const validLines = lines.filter((ln) => ln.stock_item_id && parseFloat(String(ln.qty).replace(",", ".")) > 0);
  const valid = op && validLines.length > 0 && splitValid;
  // Total estimado · custo do estoque × qty (usado pelo rateio entre operações)
  const totalEst = lines.reduce((s, ln) => {
    const item = stockItems.find((it) => it.id === ln.stock_item_id);
    const qtyN = parseFloat(String(ln.qty).replace(",", ".")) || 0;
    return s + (item ? item.cost * qtyN : 0);
  }, 0);

  const buildSubmitPayload = () => {
    const splitsArr = splitMode
      ? splitEntries.map(([opId, pct]) => ({ op: opId, pct }))
      : null;
    const primaryOp = splitMode
      ? splitsArr.slice().sort((a, b) => b.pct - a.pct)[0]?.op || ops[0].id
      : op;
    return {
      op: primaryOp,
      by: by.trim(),
      priority,
      notes: notes.trim() || null,
      lines: validLines.map((ln) => buildSubmitLine(ln, stockItems)),
      splits: splitsArr,
    };
  };

  const [submitting, setSubmitting] = useState(false);
  const handleSubmitClick = async () => {
    if (submitting || !valid) return;
    setSubmitting(true);
    try {
      await onSubmit(buildSubmitPayload());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Nova requisição" subtitle="A cozinha solicita itens; o estoquista aprova e separa." onClose={onCancel} width={820} minHeight="92vh"
      footer={<>
        <button className="btn" data-size="sm" onClick={onCancel} disabled={submitting}>Cancelar</button>
        <button className="btn" data-variant="primary" data-size="sm" disabled={!valid || submitting}
                onClick={handleSubmitClick}>
          {submitting ? "Enviando…" : "Enviar requisição"}
        </button>
      </>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 14 }}>
        <FormRow label="Operação">
          <select className="select" value={op} onChange={(e) => setOp(e.target.value)}>
            <option value={SHARED}>🔗 Uso compartilhado</option>
            <option disabled>──────────</option>
            {ops.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </FormRow>
        <FormRow label="Solicitante">
          <input className="input" placeholder="Ex.: Stefano (cozinha)" value={by} onChange={(e) => setBy(e.target.value)} />
        </FormRow>
        <FormRow label="Prioridade">
          <select className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="normal">Normal</option>
            <option value="high">Alta</option>
          </select>
        </FormRow>
      </div>

      {/* Painel de divisão */}
      {splitMode && (
        <div style={{
          marginBottom: 16, padding: "12px 14px",
          background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4,
        }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10, gap: 8 }}>
            <span className="h-eyebrow">Divisão de custo</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn" data-variant="primary" data-size="sm"
                    onClick={() => splitByRevenue()}
                    disabled={splitEntries.length === 0}
                    title="Distribui o custo proporcional ao faturamento de cada operação">
              Por faturamento
            </button>
            <button type="button" className="btn" data-size="sm"
                    onClick={() => splitEqually()}
                    disabled={splitEntries.length === 0}>
              Igualmente
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {ops.map((o) => {
              const checked = splits[o.id] != null;
              const pct = splits[o.id] || 0;
              const value = (totalEst * pct) / 100;
              const opRevenue = revenueByOp[o.id] || 0;
              return (
                <div key={o.id} style={{
                  display: "grid",
                  gridTemplateColumns: "20px 1fr 88px 110px",
                  gap: 10, alignItems: "center",
                  padding: "6px 4px",
                  opacity: checked ? 1 : 0.55,
                }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSplitOp(o.id)}
                    style={{ accentColor: "var(--accent-bright)" }}
                  />
                  <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 50, background: o.color }} />
                      <span style={{ color: "var(--fg-0)" }}>{o.name}</span>
                    </span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
                      Faturamento {opRevenue > 0
                        ? `R$ ${opRevenue.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                        : "—"}
                    </span>
                  </span>
                  <div style={{ position: "relative" }}>
                    <input
                      className="input mono"
                      type="text" inputMode="decimal"
                      value={checked ? pct : ""}
                      placeholder="0"
                      disabled={!checked}
                      onChange={(e) => setSplitPct(o.id, e.target.value)}
                      style={{ paddingRight: 22, textAlign: "right", width: "100%" }}
                    />
                    <span style={{
                      position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                      fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-3)",
                    }}>%</span>
                  </div>
                  <span className="mono" style={{
                    fontSize: 12, color: checked ? "var(--fg-0)" : "var(--fg-4)",
                    textAlign: "right", fontWeight: 500,
                  }}>
                    R$ {value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{
            marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line-soft)",
            display: "flex", justifyContent: "space-between", alignItems: "center",
            fontFamily: "var(--mono)", fontSize: 11.5,
          }}>
            <span style={{
              color: Math.abs(splitSum - 100) < 0.5 ? "var(--ok)" : "var(--crit)",
              fontWeight: 500,
            }}>
              Σ {splitSum.toFixed(2)}% {Math.abs(splitSum - 100) < 0.5 ? "✓" : `· faltam ${(100 - splitSum).toFixed(2)}%`}
            </span>
            <span style={{ color: "var(--fg-2)" }}>
              {splitEntries.length} {splitEntries.length === 1 ? "operação" : "operações"} · total R$ {totalEst.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          {splitEntries.length < 2 && (
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--warn)" }}>
              Selecione pelo menos 2 operações para dividir o custo.
            </div>
          )}
        </div>
      )}

      <StockLinesEditor lines={lines} setLines={setLines} allowAdd stockItems={stockItems} />

      <div style={{ marginTop: 14 }}>
        <FormRow label="Observação">
          <textarea
            className="input"
            placeholder="Ex.: urgente para o jantar, entregar embalado, etc."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            style={{ resize: "vertical", minHeight: 60, fontFamily: "inherit" }}
          />
        </FormRow>
      </div>
    </Modal>
  );
}

window.Requests = Requests;
