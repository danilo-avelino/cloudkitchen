// page-mobile-dre.jsx — DRE & Fechamento no celular (≤480px). P&L empilhada +
// detalhamento por categoria (colapsável) + fechamento do mês. Read-focused.
// Reaproveita computeDreSummary (exportado por page-dre.jsx) e os helpers
// window.monthOf/findCategory/findSubcategory. Só online.

const _drBRL = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _drPct = (v, base) => base > 0 ? `${((v / base) * 100).toFixed(1)}%` : "—";
const _DR_MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const _drPeriodLabel = (p) => { const [y, m] = p.split("-"); return `${_DR_MONTHS[Number(m) - 1]}/${y}`; };
const _drCurPeriod = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const _drPeriodOptions = () => { const out = []; const d = new Date(); d.setDate(1); for (let i = 0; i < 12; i++) { out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); d.setMonth(d.getMonth() - 1); } return out; };

function MobileDre() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tab, setTab] = useState("dre");
  const [period, setPeriod] = useState(_drCurPeriod());
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState("mock");
  const [pageLoading, setPageLoading] = useState(true);
  const [entries, setEntries] = useState([]);
  const [categories, setCategories] = useState([]);
  const [subcategories, setSubcategories] = useState([]);
  const [revenueEntries, setRevenueEntries] = useState([]);
  const [stockSnapshot, setStockSnapshot] = useState({ initial: 0, final: 0 });
  const [closedPeriods, setClosedPeriods] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setPageLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const ctx = await dbGetCurrentContext?.();
        const tid = ctx?.tenant?.id;
        if (cancelled || !tid) return;
        setTenantId(tid);
        const [yy, mm] = period.split("-").map(Number);
        const rangeStart = `${period}-01`;
        const rangeEnd = `${period}-${String(new Date(yy, mm, 0).getDate()).padStart(2, "0")}`;
        const [catsRes, subsRes, entRes, snapRes, revRes, closedRes] = await Promise.all([
          dbListDreCategories?.(tid) || { data: null },
          dbListDreSubcategories?.(tid) || { data: null },
          dbListFinanceEntries?.(tid, period) || { data: null },
          dbGetStockValueSnapshots?.(tid, period) || { data: null },
          dbListRevenueEntries?.(tid, rangeStart, rangeEnd) || { data: null },
          dbListClosedPeriods?.(tid) || { data: null },
        ]);
        if (cancelled) return;
        if (catsRes.data) { setCategories(catsRes.data); setSource("db"); }
        if (subsRes.data) setSubcategories(subsRes.data);
        if (entRes.data) setEntries(entRes.data);
        if (snapRes.data) setStockSnapshot(snapRes.data);
        if (revRes.data) setRevenueEntries(revRes.data);
        if (closedRes.data) setClosedPeriods(closedRes.data);
      } finally { if (!cancelled) setPageLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline, period]);

  const inPeriod = useMemo(() => entries.filter((e) => window.monthOf(e.comp) === period), [entries, period]);
  const summary = useMemo(() => {
    if (typeof window.computeDreSummary !== "function") return null;
    return window.computeDreSummary({ entries: inPeriod, categories, subcategories, period, stockSnapshot, revenueEntries, source });
  }, [inPeriod, categories, subcategories, period, stockSnapshot, revenueEntries, source]);

  const isClosed = closedPeriods.some((c) => c.period === period);

  const doClose = async () => {
    if (busy) return; setBusy(true);
    try {
      const { error } = await dbClosePeriod(tenantId, period);
      if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
      const r = await dbListClosedPeriods?.(tenantId); if (r?.data) setClosedPeriods(r.data);
      window.showToast?.(`Mês ${_drPeriodLabel(period)} fechado`, { tone: "ok" });
    } finally { setBusy(false); }
  };
  const doReopen = async () => {
    if (busy) return; setBusy(true);
    try {
      const { error } = await dbReopenPeriod(tenantId, period);
      if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
      const r = await dbListClosedPeriods?.(tenantId); if (r?.data) setClosedPeriods(r.data);
      window.showToast?.(`Mês ${_drPeriodLabel(period)} reaberto`, { tone: "warn" });
    } finally { setBusy(false); }
  };

  if (pageLoading) return <PageLoading label="Carregando DRE…" variant="table" />;
  if (source !== "db") {
    return <MobilePage><div style={{ padding: 24 }}><div style={{ fontSize: 12.5, color: "var(--warn)", padding: "12px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 8 }}>DRE só fica disponível com Supabase online.</div></div></MobilePage>;
  }

  const rev = summary?.receita || 0;

  return (
    <MobilePage>
      <SegTabs value={tab} onChange={setTab} options={[{ id: "dre", label: "DRE" }, { id: "fechamento", label: "Fechamento" }]} />
      <div style={{ padding: "10px 14px 6px" }}>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ ...mInput, height: 40 }}>
          {_drPeriodOptions().map((p) => <option key={p} value={p}>{_drPeriodLabel(p)}{closedPeriods.some((c) => c.period === p) ? " · fechado" : ""}</option>)}
        </select>
      </div>

      {tab === "dre" ? (
        <MobileScroll style={{ padding: "0 14px 16px" }}>
          {/* P&L */}
          <div style={{ borderRadius: 12, background: "var(--bg-1)", border: "1px solid var(--line)", overflow: "hidden", marginBottom: 14 }}>
            <_PLine label="Receita bruta" value={summary?.receita} base={rev} strong />
            <_PLine label="(−) Deduções" value={-(summary?.deducoes || 0)} base={rev} dim />
            <_PLine label="= Receita líquida" value={summary?.receitaLiq} base={rev} accent />
            <_PLine label="(−) CMV / CPV" value={-(summary?.cogs || 0)} base={rev} dim />
            <_PLine label="= Lucro bruto" value={summary?.lucroBruto} base={rev} accent />
            <_PLine label="(−) Despesas operacionais" value={-(summary?.opex || 0)} base={rev} dim />
            <_PLine label="= Lucro líquido" value={summary?.lucroLiq} base={rev} result />
          </div>

          {/* CMV contábil */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
            <_DrTile label="Est. inicial" value={_drBRL(summary?.ei || 0)} />
            <_DrTile label="Compras" value={_drBRL(summary?.comprasTotal || 0)} />
            <_DrTile label="Est. final" value={_drBRL(summary?.ef || 0)} />
          </div>

          {/* Detalhamento por categoria */}
          <MSectionLabel>Detalhamento</MSectionLabel>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            {categories
              .filter((c) => c.kind !== "revenue" && Math.abs(summary?.byCat?.[c.id]?.total || 0) > 0.005)
              .sort((a, b) => (a.order || 0) - (b.order || 0))
              .map((c) => (
                <DreCatCard key={c.id} cat={c} bucket={summary.byCat[c.id]} subcategories={subcategories} base={rev} />
              ))}
          </div>
        </MobileScroll>
      ) : (
        <MobileScroll style={{ padding: "12px 14px" }}>
          <div style={{ padding: "14px", borderRadius: 12, background: isClosed ? "var(--ok-soft)" : "var(--bg-2)", border: `1px solid ${isClosed ? "var(--ok-line)" : "var(--line)"}`, marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <I.Lock size={15} style={{ color: isClosed ? "var(--ok)" : "var(--fg-3)" }} />
              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-0)" }}>{_drPeriodLabel(period)}</span>
              <MBadge tone={isClosed ? "ok" : "warn"}>{isClosed ? "Fechado" : "Aberto"}</MBadge>
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-3)", marginBottom: 12 }}>
              {isClosed ? "Lançamentos deste mês estão travados." : "Feche o mês quando a DRE estiver conferida."}
            </div>
            {isClosed
              ? <button onClick={doReopen} disabled={busy} style={{ width: "100%", height: 50, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--warn-line)", color: "var(--warn)", fontSize: 14, fontWeight: 600 }}>{busy ? "…" : "Reabrir mês"}</button>
              : <MPrimaryButton onClick={doClose} loading={busy}><I.Lock size={15} />Fechar mês</MPrimaryButton>}
          </div>

          <MSectionLabel>Meses fechados</MSectionLabel>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {closedPeriods.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--fg-3)", padding: "8px 0" }}>Nenhum mês fechado ainda.</div>
            ) : closedPeriods.slice().sort((a, b) => b.period.localeCompare(a.period)).map((c) => (
              <div key={c.period} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
                <I.Lock size={13} style={{ color: "var(--ok)" }} />
                <span style={{ flex: 1, fontSize: 13.5, color: "var(--fg-0)" }}>{_drPeriodLabel(c.period)}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)" }}>{c.closed_at ? new Date(c.closed_at).toLocaleDateString("pt-BR") : ""}</span>
              </div>
            ))}
          </div>
        </MobileScroll>
      )}
    </MobilePage>
  );
}

function _PLine({ label, value, base, strong, dim, accent, result }) {
  const v = Number(value) || 0;
  const color = result ? (v >= 0 ? "var(--ok)" : "var(--crit)") : accent ? "var(--fg-0)" : dim ? "var(--fg-2)" : "var(--fg-0)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderBottom: "1px solid var(--line-soft)", background: result ? "var(--bg-2)" : "transparent" }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: result || accent ? 13.5 : 13, color: dim ? "var(--fg-3)" : "var(--fg-1)", fontWeight: result || accent || strong ? 600 : 400 }}>{label}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-4)", width: 46, textAlign: "right" }}>{base > 0 ? _drPct(v, base) : ""}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: result ? 15 : 13.5, fontWeight: result || accent || strong ? 700 : 500, color, width: 108, textAlign: "right" }}>{_drBRL(v)}</span>
    </div>
  );
}

function _DrTile({ label, value }) {
  return (
    <div style={{ padding: "10px 8px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", textAlign: "center", minWidth: 0 }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-3)", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, marginTop: 3, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
    </div>
  );
}

function DreCatCard({ cat, bucket, subcategories, base }) {
  const [open, setOpen] = useState(false);
  const total = bucket?.total || 0;
  const subs = subcategories.filter((s) => s.category === cat.id && ((bucket?.bySub?.[s.id]) != null));
  return (
    <div style={{ borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", overflow: "hidden" }}>
      <button onClick={() => setOpen((v) => !v)} style={{ width: "100%", padding: "11px 14px", background: "transparent", border: "none", display: "flex", alignItems: "center", gap: 10, textAlign: "left" }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cat.name}</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-4)" }}>{base > 0 ? _drPct(total, base) : ""}</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-0)", fontWeight: 600 }}>{_drBRL(total)}</span>
        <I.Chevron size={14} style={{ color: "var(--fg-3)", transform: open ? "rotate(180deg)" : "none", flexShrink: 0 }} />
      </button>
      {open && subs.length > 0 && (
        <div style={{ padding: "0 14px 8px" }}>
          {subs.map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: "1px solid var(--line-soft)" }}>
              <span style={{ width: 4, height: 4, borderRadius: 50, background: s.color || "var(--fg-4)", flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "var(--fg-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-1)" }}>{_drBRL(bucket.bySub[s.id] || 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

window.MobileDre = MobileDre;
