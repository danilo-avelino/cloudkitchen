// Faturamento — registro de receita por operação × dia × método de pagamento
// Métodos: Dinheiro · Débito · Crédito · Pix · Online · Voucher
// Cada lançamento contém o número de pedidos e a receita por método.

const _fmtBRL      = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _fmtBRLShort = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const _isoToBR     = (iso) => { if (!iso) return "—"; const [y, m, d] = iso.split("-"); return `${d}/${m}`; };
const _todayISO    = () => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
};
const _dayName = (iso) => {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"][d.getDay()];
};
const _parseNum = (raw) => {
  if (raw === "" || raw === null || raw === undefined) return 0;
  const s = String(raw).replace(/\s+/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

function Revenue({ scope }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false };
  // Quando online, começa vazio pra evitar flash de MOCK; offline usa MOCK
  const [entries,   setEntries]   = useState(() =>
    dbStatus.isOnline ? [] : MOCK.REVENUE_ENTRIES.map((e) => ({ ...e }))
  );
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource]     = useState(dbStatus.isOnline ? "db" : "mock");
  const [methodsState, setMethodsState] = useState(
    dbStatus.isOnline ? [] : MOCK.PAYMENT_METHODS
  );
  const [view,      setView]      = useState("daily"); // daily | byop | list
  const _now = new Date();
  const [filterYear,  setFilterYear]  = useState(String(_now.getFullYear()));
  const [filterMonth, setFilterMonth] = useState(String(_now.getMonth() + 1).padStart(2, "0")); // "01".."12" | "all"
  const [editing,   setEditing]   = useState(null);    // entry sendo editada
  const [creating,  setCreating]  = useState(false);

  // Carrega faturamento + métodos de pagamento do DB
  useEffect(() => {
    if (!dbStatus.isOnline) return;
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const tid = ctx?.tenant?.id;
      setTenantId(tid || null);
      if (!tid) return;
      const [entriesRes, methodsRes] = await Promise.all([
        dbListRevenueEntries(tid),
        dbListPaymentMethods(tid),
      ]);
      if (cancelled) return;
      if (entriesRes.source === "db") {
        setEntries(entriesRes.data || []);
        setSource("db");
      }
      if (methodsRes.data && methodsRes.data.length > 0) {
        setMethodsState(methodsRes.data.map((m) => ({ id: m.slug, label: m.label, short: m.short_label, color: m.color })));
      } else if (methodsRes.source === "db") {
        // Sem métodos cadastrados no tenant — usa default mínimo
        setMethodsState([
          { id: "dinheiro", label: "Dinheiro", short: "DIN", color: "#9ca3af" },
          { id: "debito",   label: "Débito",   short: "DEB", color: "#60a5fa" },
          { id: "credito",  label: "Crédito",  short: "CRE", color: "#a78bfa" },
          { id: "pix",      label: "Pix",      short: "PIX", color: "#34d399" },
        ]);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.isOnline]);

  const ops = MOCK.OPERATIONS.filter((o) => o.id !== "all");
  const methods = methodsState;

  // Anos presentes nos dados — usado nas opções do filtro. Inclui o ano atual mesmo sem dados.
  const yearsAvailable = useMemo(() => {
    const set = new Set(entries.map((e) => String(e.date || "").slice(0, 4)).filter(Boolean));
    set.add(String(_now.getFullYear()));
    return [...set].sort().reverse();
  }, [entries]);

  // Aplica filtro de escopo (operação) + período (ano + mês opcional)
  const visible = useMemo(() => {
    let list = scope === "all" ? entries : entries.filter((e) => e.op === scope);
    if (filterYear)  list = list.filter((e) => String(e.date || "").slice(0, 4) === filterYear);
    if (filterMonth !== "all") list = list.filter((e) => String(e.date || "").slice(5, 7) === filterMonth);
    return list;
  }, [entries, scope, filterYear, filterMonth]);

  const MONTH_PT = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  const periodLabel = filterMonth === "all"
    ? `Ano ${filterYear}`
    : `${MONTH_PT[Number(filterMonth) - 1]}/${filterYear}`;

  // Totais consolidados
  const totalRevenue = visible.reduce((s, e) => s + (e.revenue || 0), 0);
  const totalOrders  = visible.reduce((s, e) => s + (e.orders  || 0), 0);
  const avgTicket    = totalOrders > 0 ? totalRevenue / totalOrders : 0;
  const totalByMethod = methods.reduce((acc, m) => {
    acc[m.id] = visible.reduce((s, e) => s + (e.methods?.[m.id] || 0), 0);
    return acc;
  }, {});

  const upsert = async (draft) => {
    const revenue = methods.reduce((s, m) => s + (Number(draft.methods[m.id]) || 0), 0);
    const orders  = Number(draft.orders) || 0;
    const cogs    = revenue * 0.31; // estimativa via fichas técnicas (até integrar com backend)

    // DB path
    if (source === "db" && tenantId) {
      const isUpdate = draft.id && entries.find((e) => e.id === draft.id);
      if (isUpdate) {
        const { error } = await dbUpdateRevenueEntry(draft.id, {
          cogs, ordersCount: orders, status: draft.status,
        });
        if (error) { window.showToast(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
        // Para alterar breakdown, hoje deletamos+recriamos o entry — simplificação
        setEntries(entries.map((e) => e.id === draft.id ? { ...e, ordersCount: orders, cogs, revenue, breakdown: draft.methods } : e));
        window.showToast(`Lançamento ${_isoToBR(draft.date)} atualizado no Supabase`, { tone: "ok" });
      } else {
        const { data, error } = await dbInsertRevenueEntry(tenantId, {
          op:           draft.op,
          date:         draft.date,
          source:       draft.source || "balcao",
          ordersCount:  orders,
          cogs,
          status:       draft.status || "pending",
          notes:        draft.notes,
          breakdown:    draft.methods,
        });
        if (error) { window.showToast(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
        // Recarrega a lista
        const { data: refreshed } = await dbListRevenueEntries(tenantId);
        if (refreshed) setEntries(refreshed);
        window.showToast(`Faturamento de ${_isoToBR(draft.date)} lançado · ${_fmtBRL(revenue)}`, { tone: "ok" });
      }
      setEditing(null); setCreating(false);
      return;
    }

    // Fallback MOCK
    if (draft.id && entries.find((e) => e.id === draft.id)) {
      setEntries(entries.map((e) => e.id === draft.id ? { ...e, ...draft, revenue, orders, cogs } : e));
      window.showToast(`Lançamento ${draft.date} · ${MOCK.opById(draft.op).name} atualizado (mock)`, { tone: "warn" });
    } else {
      const id = entries.length ? Math.max(...entries.map((e) => e.id)) + 1 : 1;
      setEntries([{ ...draft, id, revenue, orders, cogs }, ...entries]);
      window.showToast(`Faturamento de ${_isoToBR(draft.date)} lançado (mock) · ${_fmtBRL(revenue)}`, { tone: "warn" });
    }
    setEditing(null);
    setCreating(false);
  };

  const remove = async (id) => {
    if (source === "db") {
      const { error } = await dbDeleteRevenueEntry(id);
      if (error) { window.showToast(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
    }
    setEntries(entries.filter((e) => e.id !== id));
    setEditing(null);
    window.showToast("Lançamento removido", { tone: "warn" });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "20px 28px 14px", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
        <div>
          <div className="h-eyebrow" style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 10 }}>
            {scope === "all" ? "Consolidado · todas as operações" : `Operação · ${MOCK.opById(scope).name}`}
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
          <h1 className="h-title">Faturamento · {periodLabel}</h1>
          <p className="h-sub">Registre o fechamento de caixa por dia e operação. A receita alimenta a DRE automaticamente.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select className="select" data-size="sm"
                  value={filterMonth}
                  onChange={(e) => setFilterMonth(e.target.value)}
                  style={{ padding: "4px 8px", fontSize: 12 }}
                  title="Mês">
            <option value="all">Todos os meses</option>
            {MONTH_PT.map((m, i) => (
              <option key={i} value={String(i + 1).padStart(2, "0")}>{m}</option>
            ))}
          </select>
          <select className="select" data-size="sm"
                  value={filterYear}
                  onChange={(e) => setFilterYear(e.target.value)}
                  style={{ padding: "4px 8px", fontSize: 12 }}
                  title="Ano">
            {yearsAvailable.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <RevenueViewTabs value={view} onChange={setView} />
          <button className="btn" data-size="sm" onClick={() => notImplemented("Importação iFood")}>Importar iFood</button>
          <button className="btn" data-variant="primary" data-size="sm" onClick={() => setCreating(true)}>
            <I.Plus size={13} />Lançar venda
          </button>
        </div>
      </div>

      {/* KPI strip — total + ticket + breakdown por método */}
      <div style={{ padding: "0 28px 14px" }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: `1.6fr repeat(${methods.length}, 1fr)`,
          gap: 1, background: "var(--line)",
          border: "1px solid var(--line-strong)", borderRadius: 4, overflow: "hidden",
        }}>
          <KpiCell
            label="Faturamento total"
            value={_fmtBRL(totalRevenue)}
            sub={`${totalOrders} pedidos · ticket médio ${_fmtBRL(avgTicket)} · ${visible.length} fechamentos`}
            accent
          />
          {methods.map((m) => (
            <KpiCell
              key={m.id}
              dotColor={m.color}
              label={m.label}
              value={_fmtBRLShort(totalByMethod[m.id])}
              sub={totalRevenue > 0 ? `${((totalByMethod[m.id] / totalRevenue) * 100).toFixed(1)}%` : "—"}
            />
          ))}
        </div>
      </div>

      {/* Conteúdo */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {visible.length === 0 ? (
          <RevenueEmpty onCreate={() => setCreating(true)} />
        ) : view === "daily" ? (
          <ByDayView entries={visible} methods={methods} onEdit={setEditing} />
        ) : view === "byop" ? (
          <ByOpView entries={visible} methods={methods} ops={ops} onEdit={setEditing} />
        ) : (
          <FlatView entries={visible} methods={methods} onEdit={setEditing} />
        )}
      </div>

      {(creating || editing) && (
        <RevenueModal
          initial={editing}
          methods={methods}
          ops={ops}
          defaultOp={!editing && scope !== "all" ? scope : null}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSave={upsert}
          onDelete={editing ? () => remove(editing.id) : null}
        />
      )}
    </div>
  );
}

// ===== KPI cell =====
function KpiCell({ label, value, sub, accent, dotColor }) {
  return (
    <div style={{ background: "var(--bg-1)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)",
        letterSpacing: "0.08em", textTransform: "uppercase",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>
        {dotColor && <span style={{ width: 5, height: 5, borderRadius: 50, background: dotColor, flexShrink: 0 }} />}
        {label}
      </div>
      <div className="mono" style={{
        fontSize: accent ? 18 : 14, fontWeight: 500,
        color: accent ? "var(--accent-bright)" : "var(--fg-0)",
        letterSpacing: "-0.018em",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>{value}</div>
      <div style={{
        fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>{sub}</div>
    </div>
  );
}

// ===== View tabs =====
function RevenueViewTabs({ value, onChange }) {
  const opts = [
    { id: "daily", label: "Por dia" },
    { id: "byop",  label: "Por operação" },
    { id: "list",  label: "Lista" },
  ];
  return (
    <div style={{ display: "flex", padding: 2, background: "var(--bg-2)", borderRadius: 4, border: "1px solid var(--line)" }}>
      {opts.map((o) => {
        const active = o.id === value;
        return (
          <button key={o.id} onClick={() => onChange(o.id)} style={{
            padding: "5px 12px", background: active ? "var(--bg-3)" : "transparent",
            border: "none", borderRadius: 2,
            fontSize: 12, color: active ? "var(--fg-0)" : "var(--fg-2)",
            fontWeight: active ? 500 : 400,
          }}>{o.label}</button>
        );
      })}
    </div>
  );
}

// ===== Empty state =====
function RevenueEmpty({ onCreate }) {
  return (
    <div style={{ display: "grid", placeItems: "center", padding: 48 }}>
      <div style={{ textAlign: "center", maxWidth: 360 }}>
        <div className="h-eyebrow" style={{ marginBottom: 8 }}>Sem lançamentos no período</div>
        <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 16 }}>
          Lance o fechamento de caixa do dia para acompanhar receita por método de pagamento.
        </div>
        <button className="btn" data-variant="primary" data-size="sm" onClick={onCreate}>
          <I.Plus size={13} />Lançar venda
        </button>
      </div>
    </div>
  );
}

// ===== Por dia =====
function ByDayView({ entries, methods, onEdit }) {
  const byDate = {};
  entries.forEach((e) => {
    if (!byDate[e.date]) byDate[e.date] = [];
    byDate[e.date].push(e);
  });
  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

  return (
    <div style={{ padding: "8px 28px 32px", display: "flex", flexDirection: "column", gap: 14 }}>
      {dates.map((d) => {
        const dayEntries = byDate[d];
        const dayTotal   = dayEntries.reduce((s, e) => s + (e.revenue || 0), 0);
        const dayOrders  = dayEntries.reduce((s, e) => s + (e.orders  || 0), 0);
        const byMethod   = methods.reduce((acc, m) => {
          acc[m.id] = dayEntries.reduce((s, e) => s + (e.methods?.[m.id] || 0), 0);
          return acc;
        }, {});
        return (
          <div key={d} className="card">
            <div className="card-header" style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div>
                <span className="h-eyebrow">{_isoToBR(d)} · {_dayName(d)}</span>
                <div className="card-sub" style={{ display: "block", marginTop: 4 }}>
                  {dayEntries.length} {dayEntries.length === 1 ? "operação lançada" : "operações lançadas"} · {dayOrders} pedidos
                </div>
              </div>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 16, fontWeight: 500, color: "var(--accent-bright)", letterSpacing: "-0.018em" }}>
                {_fmtBRL(dayTotal)}
              </span>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: "18%" }}>Operação</th>
                  {methods.map((m) => <th key={m.id} className="num" style={{ minWidth: 78 }}>{m.short}</th>)}
                  <th className="num">Pedidos</th>
                  <th className="num">Total dia</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {dayEntries.map((e) => <EntryRow key={e.id} e={e} methods={methods} onEdit={onEdit} />)}
                <tr style={{ background: "var(--bg-2)", borderTop: "1px solid var(--line-strong)" }}>
                  <td style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-2)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Σ Soma do dia</td>
                  {methods.map((m) => (
                    <td key={m.id} className="num" style={{ color: "var(--fg-0)", fontWeight: 500 }}>{_fmtBRLShort(byMethod[m.id])}</td>
                  ))}
                  <td className="num" style={{ color: "var(--fg-0)", fontWeight: 500 }}>{dayOrders}</td>
                  <td className="num" style={{ color: "var(--accent-bright)", fontWeight: 500, fontSize: 13 }}>{_fmtBRL(dayTotal)}</td>
                  <td colSpan="2" />
                </tr>
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// Linha reutilizável de lançamento (op + métodos + pedidos + total)
function EntryRow({ e, methods, onEdit }) {
  const op = MOCK.opById(e.op);
  return (
    <tr style={{ cursor: "pointer" }} onClick={() => onEdit(e)}>
      <td>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: 50, background: op.color }} />
          <span style={{ color: "var(--fg-0)", fontWeight: 500 }}>{op.name}</span>
        </span>
      </td>
      {methods.map((m) => (
        <td key={m.id} className="num" style={{ color: e.methods?.[m.id] ? "var(--fg-0)" : "var(--fg-4)" }}>
          {e.methods?.[m.id] ? _fmtBRLShort(e.methods[m.id]) : "—"}
        </td>
      ))}
      <td className="num">{e.orders}</td>
      <td className="num" style={{ color: "var(--fg-0)", fontWeight: 500 }}>{_fmtBRL(e.revenue)}</td>
      <td><span className="badge" data-tone={e.status === "confirmed" ? "ok" : "warn"}>{e.status === "confirmed" ? "Conf." : "Pend."}</span></td>
      <td>
        <button className="btn" data-variant="ghost" data-size="sm" style={{ padding: "3px 7px" }}
                onClick={(ev) => { ev.stopPropagation(); onEdit(e); }} title="Editar">
          <I.More size={12} />
        </button>
      </td>
    </tr>
  );
}

// ===== Por operação =====
function ByOpView({ entries, methods, ops, onEdit }) {
  const grouped = {};
  entries.forEach((e) => {
    if (!grouped[e.op]) grouped[e.op] = [];
    grouped[e.op].push(e);
  });

  return (
    <div style={{ padding: "8px 28px 32px", display: "flex", flexDirection: "column", gap: 14 }}>
      {Object.entries(grouped).map(([opId, arr]) => {
        const op = MOCK.opById(opId);
        const total  = arr.reduce((s, e) => s + (e.revenue || 0), 0);
        const orders = arr.reduce((s, e) => s + (e.orders  || 0), 0);
        const byMethod = methods.reduce((acc, m) => {
          acc[m.id] = arr.reduce((s, e) => s + (e.methods?.[m.id] || 0), 0);
          return acc;
        }, {});
        return (
          <div key={opId} className="card">
            <div className="card-header" style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: 50, background: op.color }} />
                <h3 className="card-title">{op.name}</h3>
                <span className="card-sub">{arr.length} dias · {orders} pedidos</span>
              </span>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 16, fontWeight: 500, color: "var(--accent-bright)", letterSpacing: "-0.018em" }}>{_fmtBRL(total)}</span>
            </div>

            {/* Barra empilhada por método */}
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line-soft)" }}>
              <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "var(--bg-3)" }}>
                {methods.map((m) => {
                  const pct = total > 0 ? (byMethod[m.id] / total) * 100 : 0;
                  if (pct < 0.1) return null;
                  return <div key={m.id} title={`${m.label} ${pct.toFixed(1)}%`} style={{ width: `${pct}%`, background: m.color }} />;
                })}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 10 }}>
                {methods.map((m) => {
                  const v = byMethod[m.id] || 0;
                  const pct = total > 0 ? (v / total) * 100 : 0;
                  return (
                    <span key={m.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                      <span style={{ width: 6, height: 6, borderRadius: 50, background: m.color }} />
                      <span style={{ color: "var(--fg-2)" }}>{m.label}</span>
                      <span className="mono" style={{ color: "var(--fg-0)" }}>{_fmtBRLShort(v)}</span>
                      <span className="mono" style={{ color: "var(--fg-3)" }}>· {pct.toFixed(1)}%</span>
                    </span>
                  );
                })}
              </div>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Data</th>
                  {methods.map((m) => <th key={m.id} className="num" style={{ minWidth: 70 }}>{m.short}</th>)}
                  <th className="num">Pedidos</th>
                  <th className="num">Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...arr].sort((a, b) => b.date.localeCompare(a.date)).map((e) => (
                  <tr key={e.id} style={{ cursor: "pointer" }} onClick={() => onEdit(e)}>
                    <td className="mono" style={{ fontSize: 11.5, color: "var(--fg-1)" }}>{_isoToBR(e.date)}</td>
                    {methods.map((m) => (
                      <td key={m.id} className="num" style={{ color: e.methods?.[m.id] ? "var(--fg-1)" : "var(--fg-4)" }}>
                        {e.methods?.[m.id] ? _fmtBRLShort(e.methods[m.id]) : "—"}
                      </td>
                    ))}
                    <td className="num">{e.orders}</td>
                    <td className="num" style={{ color: "var(--fg-0)", fontWeight: 500 }}>{_fmtBRL(e.revenue)}</td>
                    <td>
                      <button className="btn" data-variant="ghost" data-size="sm" style={{ padding: "3px 7px" }}
                              onClick={(ev) => { ev.stopPropagation(); onEdit(e); }}>
                        <I.More size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// ===== Lista plana =====
function FlatView({ entries, methods, onEdit }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th style={{ width: 90 }}>Data</th>
          <th>Operação</th>
          {methods.map((m) => <th key={m.id} className="num" style={{ minWidth: 70 }}>{m.short}</th>)}
          <th className="num">Pedidos</th>
          <th className="num">Total</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {[...entries].sort((a, b) => b.date.localeCompare(a.date)).map((e) => {
          const op = MOCK.opById(e.op);
          return (
            <tr key={e.id} style={{ cursor: "pointer" }} onClick={() => onEdit(e)}>
              <td className="mono" style={{ fontSize: 11.5, color: "var(--fg-1)" }}>{_isoToBR(e.date)}</td>
              <td>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 50, background: op.color }} />
                  <span style={{ color: "var(--fg-0)", fontWeight: 500 }}>{op.name}</span>
                </span>
              </td>
              {methods.map((m) => (
                <td key={m.id} className="num" style={{ color: e.methods?.[m.id] ? "var(--fg-1)" : "var(--fg-4)" }}>
                  {e.methods?.[m.id] ? _fmtBRLShort(e.methods[m.id]) : "—"}
                </td>
              ))}
              <td className="num">{e.orders}</td>
              <td className="num" style={{ color: "var(--fg-0)", fontWeight: 500 }}>{_fmtBRL(e.revenue)}</td>
              <td><span className="badge" data-tone={e.status === "confirmed" ? "ok" : "warn"}>{e.status === "confirmed" ? "Conf." : "Pend."}</span></td>
              <td>
                <button className="btn" data-variant="ghost" data-size="sm" style={{ padding: "3px 7px" }}
                        onClick={(ev) => { ev.stopPropagation(); onEdit(e); }}>
                  <I.More size={12} />
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ===== Modal de criação/edição =====
function RevenueModal({ initial, methods, ops, defaultOp, onClose, onSave, onDelete }) {
  const [op,      setOp]      = useState(initial?.op     || defaultOp || ops[0]?.id || "");
  const [date,    setDate]    = useState(initial?.date   || _todayISO());
  const [orders,  setOrders]  = useState(initial?.orders ?? "");
  const [status,  setStatus]  = useState(initial?.status || "confirmed");
  const [methodVals, setMethodVals] = useState(() => {
    const init = {};
    methods.forEach((m) => { init[m.id] = initial?.methods?.[m.id] ?? ""; });
    return init;
  });

  const setMethodValue = (id, raw) => setMethodVals((cur) => ({ ...cur, [id]: raw }));

  const total = methods.reduce((s, m) => s + _parseNum(methodVals[m.id]), 0);
  // Total de pedidos é opcional: vazio vira 0 (usado só p/ ticket médio).
  const ordersNum = orders === "" ? 0 : Number(orders);
  const validOrders = Number.isFinite(ordersNum) && ordersNum >= 0;
  const valid = op && date && validOrders && total > 0;

  const submit = async () => {
    console.log("[revenue] submit clicked · valid =", valid, { op, date, ordersNum, total, methodVals });
    if (!valid) {
      const reasons = [];
      if (!op) reasons.push("operação");
      if (!date) reasons.push("data");
      if (!validOrders) reasons.push("total de pedidos");
      if (!(total > 0)) reasons.push("ao menos 1 método > 0");
      window.showToast?.(`Faltam campos: ${reasons.join(", ")}`, { tone: "warn", ttl: 4000 });
      return;
    }
    const cleanMethods = {};
    methods.forEach((m) => { cleanMethods[m.id] = _parseNum(methodVals[m.id]); });
    try {
      await onSave({
        id: initial?.id,
        op, date,
        orders: ordersNum,
        status,
        methods: cleanMethods,
        source: initial?.source || "manual",
      });
    } catch (e) {
      console.error("[revenue] onSave threw:", e);
      window.showToast?.(`Erro ao salvar: ${e?.message || e}`, { tone: "crit", ttl: 5000 });
    }
  };

  // Ctrl/Cmd+Enter para salvar
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && valid) {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const opObj = MOCK.opById(op);

  return (
    <Modal
      title={initial ? "Editar lançamento" : "Lançar venda"}
      subtitle="Fechamento de caixa por dia × operação. A soma dos métodos é o faturamento bruto."
      onClose={onClose}
      width={620}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", gap: 12 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>⌘ + ↵ para salvar</span>
          <div style={{ display: "flex", gap: 8 }}>
            {onDelete && (
              <button className="btn" data-variant="danger" data-size="sm" onClick={() => { if (confirm("Excluir este lançamento?")) onDelete(); }}>
                Excluir
              </button>
            )}
            <button className="btn" data-size="sm" onClick={onClose}>Cancelar</button>
            <button className="btn" data-variant="primary" data-size="sm" onClick={submit} disabled={!valid}>
              {initial ? "Salvar alterações" : "Salvar lançamento"}
            </button>
          </div>
        </div>
      }
    >
      {/* Cabeçalho do formulário: operação · data · pedidos */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 0.9fr 0.7fr", gap: 12, marginBottom: 16 }}>
        <FormRow label="Operação">
          <select className="select" value={op} onChange={(e) => setOp(e.target.value)}>
            {ops.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          {opObj && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: 50, background: opObj.color }} />
              <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                {opObj.short}{opObj.iFood ? ` · ${opObj.iFood}` : ""}
              </span>
            </div>
          )}
        </FormRow>
        <FormRow label="Data">
          <input className="input mono" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </FormRow>
        <FormRow label="Total de pedidos">
          <input
            className="input mono"
            type="number"
            min="0"
            inputMode="numeric"
            value={orders}
            onChange={(e) => setOrders(e.target.value)}
            placeholder="0"
          />
        </FormRow>
      </div>

      {/* Breakdown por método de pagamento */}
      <div className="h-eyebrow" style={{ marginBottom: 10 }}>Receita por método de pagamento</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {methods.map((m) => {
          const v = _parseNum(methodVals[m.id]);
          const pct = total > 0 ? (v / total) * 100 : 0;
          return (
            <div key={m.id} style={{ background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4, padding: "10px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ width: 6, height: 6, borderRadius: 50, background: m.color }} />
                <span style={{ fontSize: 12, color: "var(--fg-1)", fontWeight: 500 }}>{m.label}</span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>{pct.toFixed(1)}%</span>
              </div>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-3)" }}>R$</span>
                <input
                  className="input mono"
                  style={{ paddingLeft: 32, fontSize: 13, fontWeight: 500, color: "var(--fg-0)", textAlign: "right", width: "100%" }}
                  type="text"
                  inputMode="decimal"
                  value={methodVals[m.id]}
                  placeholder="0,00"
                  onChange={(e) => setMethodValue(m.id, e.target.value)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Total ao vivo */}
      <div style={{
        marginTop: 16, padding: "14px 16px",
        background: "linear-gradient(180deg, rgba(45,140,102,0.08), transparent)",
        border: "1px solid var(--accent-line)", borderRadius: 4,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Σ Total faturado</div>
          <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 2 }}>
            {Number(orders) > 0
              ? `${orders} pedidos · ticket médio ${_fmtBRL(total / Number(orders))}`
              : "soma automática · entra na DRE como receita bruta"}
          </div>
        </div>
        <span className="mono" style={{ fontSize: 22, fontWeight: 500, color: "var(--accent-bright)", letterSpacing: "-0.022em" }}>{_fmtBRL(total)}</span>
      </div>

      {/* Status do lançamento */}
      <div style={{ marginTop: 14 }}>
        <FormRow label="Status">
          <div style={{ display: "flex", gap: 6 }}>
            {[["confirmed", "Confirmado"], ["pending", "Pendente"]].map(([id, lbl]) => (
              <button
                key={id} type="button" className="btn" data-size="sm"
                onClick={() => setStatus(id)}
                style={{
                  background:   status === id ? "var(--accent-soft)" : "var(--bg-2)",
                  borderColor:  status === id ? "var(--accent-line)" : "var(--line)",
                  color:        status === id ? "var(--accent-bright)" : "var(--fg-1)",
                }}
              >{lbl}</button>
            ))}
          </div>
        </FormRow>
      </div>
    </Modal>
  );
}

window.Revenue = Revenue;
