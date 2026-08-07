// page-mobile-revenue.jsx — Faturamento no celular (≤480px). Lançar fechamento de
// caixa por dia/operação e consultar totais. Reaproveita as funções db* do desktop
// (page-revenue.jsx): a receita alimenta a DRE automaticamente. COGS fica 0 no
// lançamento (backend calcula pelo consumo de estoque).

const _rvBRL = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _rvBRLs = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
const _rvParse = (raw) => {
  if (raw === "" || raw == null) return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  let s = String(raw).trim().replace(/\s+/g, "");
  if (!s) return 0;
  const dp = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  if (dp >= 0) s = s.slice(0, dp).replace(/[.,]/g, "") + "." + s.slice(dp + 1);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};
const _rvDateBR = (iso) => { if (!iso) return "—"; const [y, m, d] = String(iso).slice(0, 10).split("-"); return `${d}/${m}/${y}`; };
const _RV_MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function MobileRevenue({ scope = "all" }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [entries, setEntries] = useState(() => dbStatus.isOnline ? [] : (MOCK.REVENUE_ENTRIES || []).map((e) => ({ ...e })));
  const [methods, setMethods] = useState(dbStatus.isOnline ? [] : (MOCK.PAYMENT_METHODS || []));
  const [shifts, setShifts] = useState([]);
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState(dbStatus.isOnline ? "db" : "mock");
  const [pageLoading, setPageLoading] = useState(true);

  const _now = new Date();
  const [fYear, setFYear] = useState(String(_now.getFullYear()));
  const [fMonth, setFMonth] = useState(String(_now.getMonth() + 1).padStart(2, "0"));
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);

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
        const [entRes, methRes, shiftRes] = await Promise.all([
          dbListRevenueEntries(tid),
          dbListPaymentMethods(tid),
          typeof dbListOperationShifts === "function" ? dbListOperationShifts(tid) : Promise.resolve({ data: [] }),
        ]);
        if (cancelled) return;
        if (entRes.source === "db") { setEntries(entRes.data || []); setSource("db"); }
        if (shiftRes?.data) setShifts(shiftRes.data);
        if (methRes.data && methRes.data.length > 0) {
          setMethods(methRes.data.map((m) => ({ id: m.slug, label: m.label, short: m.short_label, color: m.color })));
        } else if (methRes.source === "db") {
          setMethods([
            { id: "dinheiro", label: "Dinheiro", short: "DIN", color: "#9ca3af" },
            { id: "debito", label: "Débito", short: "DEB", color: "#60a5fa" },
            { id: "credito", label: "Crédito", short: "CRE", color: "#a78bfa" },
            { id: "pix", label: "Pix", short: "PIX", color: "#34d399" },
          ]);
        }
      } finally { if (!cancelled) setPageLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  const ops = (MOCK.OPERATIONS || []).filter((o) => o.id !== "all");

  const yearsAvailable = useMemo(() => {
    const set = new Set(entries.map((e) => String(e.date || "").slice(0, 4)).filter(Boolean));
    set.add(String(_now.getFullYear()));
    return [...set].sort().reverse();
  }, [entries]);

  const visible = useMemo(() => {
    let list = scope === "all" ? entries : entries.filter((e) => e.op === scope);
    if (fYear) list = list.filter((e) => String(e.date || "").slice(0, 4) === fYear);
    if (fMonth !== "all") list = list.filter((e) => String(e.date || "").slice(5, 7) === fMonth);
    return list;
  }, [entries, scope, fYear, fMonth]);

  const totalRevenue = visible.reduce((s, e) => s + (e.revenue || 0), 0);
  const totalOrders = visible.reduce((s, e) => s + (e.orders || 0), 0);
  const avgTicket = totalOrders > 0 ? totalRevenue / totalOrders : 0;
  const totalByMethod = methods.reduce((acc, m) => { acc[m.id] = visible.reduce((s, e) => s + (e.methods?.[m.id] || 0), 0); return acc; }, {});

  const byDay = useMemo(() => {
    const g = {};
    visible.forEach((e) => { const k = String(e.date || "").slice(0, 10); (g[k] = g[k] || []).push(e); });
    return Object.entries(g).sort(([a], [b]) => b.localeCompare(a));
  }, [visible]);

  const upsert = async (draft) => {
    const revenue = methods.reduce((s, m) => s + (Number(draft.methods[m.id]) || 0), 0);
    const orders = Number(draft.orders) || 0;
    if (source === "db" && tenantId) {
      const isUpdate = draft.id && entries.find((e) => e.id === draft.id);
      if (isUpdate) {
        const operationId = ops.find((o) => o.id === draft.op || o.slug === draft.op)?.id || draft.op;
        const { error } = await dbUpdateRevenueEntry(draft.id, { cogs: 0, operationId, ordersCount: orders, status: draft.status, date: draft.date, source: draft.source, notes: draft.notes, breakdown: draft.methods, shiftId: draft.shiftId });
        if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; }
      } else {
        const { error } = await dbInsertRevenueEntry(tenantId, { op: draft.op, date: draft.date, source: draft.source || "balcao", ordersCount: orders, cogs: 0, status: draft.status || "confirmed", notes: draft.notes, breakdown: draft.methods, shiftId: draft.shiftId });
        if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; }
      }
      const { data: refreshed } = await dbListRevenueEntries(tenantId);
      if (refreshed) setEntries(refreshed);
      window.showToast?.(`Faturamento de ${_rvDateBR(draft.date)} salvo · ${_rvBRL(revenue)}`, { tone: "ok" });
      return true;
    }
    // mock
    if (draft.id && entries.find((e) => e.id === draft.id)) {
      setEntries(entries.map((e) => e.id === draft.id ? { ...e, ...draft, revenue, orders, cogs: 0 } : e));
    } else {
      const id = entries.length ? Math.max(...entries.map((e) => Number(e.id) || 0)) + 1 : 1;
      setEntries([{ ...draft, id, revenue, orders, cogs: 0 }, ...entries]);
    }
    window.showToast?.(`Faturamento de ${_rvDateBR(draft.date)} salvo (mock)`, { tone: "warn" });
    return true;
  };

  const remove = async (id) => {
    if (source === "db") {
      const { error } = await dbDeleteRevenueEntry(id);
      if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
    }
    setEntries(entries.filter((e) => e.id !== id));
    window.showToast?.("Lançamento removido", { tone: "warn" });
  };

  if (pageLoading) return <PageLoading label="Carregando faturamento…" variant="table" />;

  return (
    <MobilePage>
      {/* Filtro mês/ano */}
      <div style={{ display: "flex", gap: 8, padding: "12px 14px 8px" }}>
        <select value={fMonth} onChange={(e) => setFMonth(e.target.value)} style={{ ...mInput, flex: 1 }}>
          <option value="all">Todos os meses</option>
          {_RV_MONTHS.map((m, i) => <option key={i} value={String(i + 1).padStart(2, "0")}>{m}</option>)}
        </select>
        <select value={fYear} onChange={(e) => setFYear(e.target.value)} style={{ ...mInput, width: 100 }}>
          {yearsAvailable.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      <StatStrip stats={[
        { label: "Faturamento", value: _rvBRLs(totalRevenue), tone: "ok", sub: `${visible.length} fechamentos` },
        { label: "Pedidos", value: totalOrders },
        { label: "Ticket médio", value: _rvBRL(avgTicket) },
        ...methods.map((m) => ({ label: m.label, value: _rvBRLs(totalByMethod[m.id]), sub: totalRevenue > 0 ? `${((totalByMethod[m.id] / totalRevenue) * 100).toFixed(0)}%` : "—" })),
      ]} />

      <MobileScroll style={{ padding: "0 14px 12px" }}>
        {visible.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 12px", color: "var(--fg-3)", fontSize: 13 }}>
            Nenhum fechamento no período.<br /><span style={{ fontSize: 11.5 }}>Lance o caixa do dia no botão abaixo.</span>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {byDay.map(([day, dayEntries]) => {
              const dayTotal = dayEntries.reduce((s, e) => s + (e.revenue || 0), 0);
              return (
                <div key={day}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 2px 6px" }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-2)", fontWeight: 500 }}>{_rvDateBR(day)}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-2)" }}>{_rvBRL(dayTotal)}</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {dayEntries.map((e) => <RevenueEntryCard key={e.id} e={e} onTap={() => setEditing(e)} />)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </MobileScroll>

      <MobileBottomBar>
        <MPrimaryButton onClick={() => setCreating(true)}><I.Plus size={16} />Lançar venda</MPrimaryButton>
      </MobileBottomBar>

      {(creating || editing) && (
        <RevenueFormSheet
          initial={editing}
          methods={methods}
          ops={ops}
          shifts={shifts}
          defaultOp={!editing && scope !== "all" ? scope : null}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSave={async (draft) => { const ok = await upsert(draft); if (ok) { setCreating(false); setEditing(null); } return ok; }}
          onDelete={editing ? async () => { await remove(editing.id); setEditing(null); } : null}
        />
      )}
    </MobilePage>
  );
}

function RevenueEntryCard({ e, onTap }) {
  const opName = (typeof MOCK !== "undefined" && MOCK.opById ? MOCK.opById(e.op)?.name : null) || e.op || "—";
  const confirmed = e.status === "confirmed";
  return (
    <MobileCard onClick={onTap}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 500 }}>{opName}</div>
          <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 2 }}>{e.orders || 0} pedidos</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--fg-0)", fontWeight: 600 }}>{_rvBRL(e.revenue)}</span>
          <MBadge tone={confirmed ? "ok" : "warn"}>{confirmed ? "Confirmado" : "Pendente"}</MBadge>
        </div>
      </div>
    </MobileCard>
  );
}

function RevenueFormSheet({ initial, methods, ops, shifts, defaultOp, onClose, onSave, onDelete }) {
  const isEdit = !!initial;
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(initial?.date ? String(initial.date).slice(0, 10) : today);
  const [op, setOp] = useState(initial?.op ?? defaultOp ?? (ops[0]?.id || ""));
  const [shiftId, setShiftId] = useState(initial?.shiftId ?? "");
  const [status, setStatus] = useState(initial?.status ?? "confirmed");
  const [orders, setOrders] = useState(initial?.orders != null ? String(initial.orders) : "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [amounts, setAmounts] = useState(() => {
    const init = {};
    methods.forEach((m) => { init[m.id] = initial?.methods?.[m.id] != null ? String(initial.methods[m.id]) : ""; });
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Turnos da operação selecionada (se houver campo de vínculo).
  const opShifts = shifts.filter((s) => {
    const sop = s.operationId || s.operation_id || s.op;
    return !sop || sop === op || ops.find((o) => o.id === op)?.slug === sop;
  });

  const revenue = methods.reduce((s, m) => s + _rvParse(amounts[m.id]), 0);
  const valid = !!op && !!date && revenue > 0;

  const submit = async () => {
    if (saving || !valid) return;
    setSaving(true);
    try {
      const breakdown = {};
      methods.forEach((m) => { breakdown[m.id] = _rvParse(amounts[m.id]); });
      await onSave({ id: initial?.id, op, date, shiftId: shiftId || null, status, source: initial?.source || "balcao", notes: notes.trim(), methods: breakdown, orders: _rvParse(orders) });
    } finally { setSaving(false); }
  };
  const doDelete = async () => { if (deleting) return; setDeleting(true); try { await onDelete(); } finally { setDeleting(false); } };

  return (
    <FullSheet
      title={isEdit ? "Editar lançamento" : "Lançar venda"}
      subtitle={revenue > 0 ? `Total ${_rvBRL(revenue)}` : "Fechamento de caixa"}
      onBack={saving || deleting ? undefined : onClose}
      footer={<MPrimaryButton onClick={submit} disabled={!valid} loading={saving}>{isEdit ? "Salvar" : "Lançar faturamento"}</MPrimaryButton>}
    >
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <MField label="Data"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={mInput} /></MField>
        </div>
        <div style={{ flex: 1 }}>
          <MField label="Operação">
            <select value={op} onChange={(e) => setOp(e.target.value)} style={mInput}>
              {ops.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </MField>
        </div>
      </div>

      {opShifts.length > 0 && (
        <MField label="Turno (opcional)">
          <select value={shiftId} onChange={(e) => setShiftId(e.target.value)} style={mInput}>
            <option value="">— Sem turno —</option>
            {opShifts.map((s) => <option key={s.id} value={s.id}>{s.name || `${(s.start_time || "").slice(0, 5)}–${(s.end_time || "").slice(0, 5)}`}</option>)}
          </select>
        </MField>
      )}

      <MSectionLabel>Valores por método</MSectionLabel>
      <div style={{ marginTop: 10, marginBottom: 4 }}>
        {methods.map((m) => (
          <MField key={m.id} label={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: 50, background: m.color || "var(--fg-3)" }} />{m.label}
            </span>
          }>
            <input value={amounts[m.id]} inputMode="decimal" onChange={(e) => setAmounts((cur) => ({ ...cur, [m.id]: e.target.value }))} placeholder="0,00" style={mInput} />
          </MField>
        ))}
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <MField label="Nº de pedidos"><input value={orders} inputMode="numeric" onChange={(e) => setOrders(e.target.value)} placeholder="0" style={mInput} /></MField>
        </div>
        <div style={{ flex: 1 }}>
          <MField label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={mInput}>
              <option value="confirmed">Confirmado</option>
              <option value="pending">Pendente</option>
            </select>
          </MField>
        </div>
      </div>

      <MField label="Observação (opcional)"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="—" style={mInput} /></MField>

      {isEdit && onDelete && (
        <div style={{ marginTop: 16 }}>
          {!confirmDel ? (
            <button onClick={() => setConfirmDel(true)} style={{ width: "100%", height: 48, borderRadius: 10, background: "transparent", border: "1px solid var(--crit-line)", color: "var(--crit)", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <I.Trash size={15} />Excluir lançamento
            </button>
          ) : (
            <div style={{ padding: 12, borderRadius: 10, background: "var(--crit-soft)", border: "1px solid var(--crit-line)" }}>
              <div style={{ fontSize: 12.5, color: "var(--fg-1)", marginBottom: 10 }}>Excluir este lançamento? Não pode ser desfeito.</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setConfirmDel(false)} disabled={deleting} style={{ flex: 1, height: 46, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14 }}>Cancelar</button>
                <button onClick={doDelete} disabled={deleting} style={{ flex: 1, height: 46, borderRadius: 10, background: "var(--crit)", border: "none", color: "#fff", fontSize: 14, fontWeight: 600 }}>{deleting ? "Excluindo…" : "Excluir"}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </FullSheet>
  );
}

window.MobileRevenue = MobileRevenue;
