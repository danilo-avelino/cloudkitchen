// page-mobile-cmv.jsx — CMV & margem no celular (≤480px). 4 views como o desktop:
// Consolidado · Por item · Semanal · Insumos. Layout de coluna única, SEM scroll
// lateral (KPIs em grid 2col, abas quebram linha). Reaproveita os builders do
// desktop (buildDailyRows/buildItemRows/buildWeeklyRows/buildItemByPeriod/cmvTone/
// getDateRange), expostos por page-cmv.jsx — o fork é só de layout.

const _cbrl = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _cbrlk = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
const _cymd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };

const _CMV_PERIODS = [
  { id: "today", label: "Hoje" }, { id: "yesterday", label: "Ontem" },
  { id: "7d", label: "7 dias" }, { id: "30d", label: "30 dias" }, { id: "mtd", label: "Mês" },
];
const _CMV_PERIOD_LABEL = { today: "hoje", yesterday: "ontem", "7d": "últimos 7 dias", "30d": "últimos 30 dias", mtd: "mês atual" };
const _CMV_VIEWS = [
  { id: "consolidado", label: "Consolidado" }, { id: "items", label: "Por item" },
  { id: "semanal", label: "Semanal" }, { id: "insumos", label: "Insumos" },
];

// Abas que dividem a largura toda (cada botão flex:1, de ponta a ponta).
function WrapTabs({ value, onChange, options, size = "md" }) {
  const h = size === "sm" ? 34 : 40;
  return (
    <div style={{ display: "flex", gap: 6, padding: "10px 14px" }}>
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button key={o.id} onClick={() => onChange(o.id)} style={{
            flex: 1, minWidth: 0, height: h, padding: "0 6px", borderRadius: 999,
            fontSize: 13, fontWeight: active ? 600 : 400,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            background: active ? "var(--accent-bright)" : "var(--bg-2)",
            color: active ? "var(--accent-fg, #07080a)" : "var(--fg-1)",
            border: `1px solid ${active ? "var(--accent-bright)" : "var(--line)"}`,
          }}>{o.label}</button>
        );
      })}
    </div>
  );
}

// KPI tile (grid 2col). Não rola lateralmente.
function CmvTile({ label, value, sub, color }) {
  return (
    <div style={{ minWidth: 0, padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 700, marginTop: 4, color: color || "var(--fg-0)", letterSpacing: "-0.01em" }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>}
    </div>
  );
}

function _resolveSplits(raw) {
  const out = {};
  for (const [id, sp] of Object.entries(raw || {})) {
    out[id] = (sp || []).map((s) => { const op = MOCK.opById(s.op); return { slug: op?.slug || s.op, name: op?.name || "—", color: op?.color || "var(--fg-3)", pct: s.pct }; });
  }
  return out;
}
function _opsFrom(movs) {
  const seen = new Map();
  for (const mv of movs) { if (!mv.operationId || mv.op === "—") continue; if (!seen.has(mv.op)) seen.set(mv.op, { slug: mv.op, name: mv.operationName, color: mv.operationColor }); }
  return [...seen.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

function MobileCMV() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [view, setView] = useState("consolidado");
  const [period, setPeriod] = useState("mtd");
  const [opFilter, setOpFilter] = useState("all");        // Por item (janela do período)
  const [weeklyOpFilter, setWeeklyOpFilter] = useState("all"); // Semanal/Insumos (janela própria)
  const [insumoGran, setInsumoGran] = useState("week");
  const [pageLoading, setPageLoading] = useState(true);
  const [source, setSource] = useState("loading");
  const [tenantId, setTenantId] = useState(null);
  const [insumoCtx, setInsumoCtx] = useState(null); // detalhe do insumo (sheet)
  const [weekDetail, setWeekDetail] = useState(null); // semana (monday iso) do sheet

  // Janela do período (Consolidado / Por item)
  const [revenueEntries, setRevenueEntries] = useState([]);
  const [movements, setMovements] = useState([]);
  const [topConsumed, setTopConsumed] = useState([]);
  const [sharedSplits, setSharedSplits] = useState({});

  // Janela semanal (Semanal / Insumos-semana)
  const [weeklyRevenue, setWeeklyRevenue] = useState([]);
  const [weeklyMovements, setWeeklyMovements] = useState([]);
  const [weeklySharedSplits, setWeeklySharedSplits] = useState({});
  const [weeklyLoading, setWeeklyLoading] = useState(true);

  // Janela mensal (Insumos-mês, lazy)
  const [monthRevenue, setMonthRevenue] = useState([]);
  const [monthMovements, setMonthMovements] = useState([]);
  const [monthSharedSplits, setMonthSharedSplits] = useState({});
  const [monthLoaded, setMonthLoaded] = useState(false);
  const [monthLoading, setMonthLoading] = useState(false);

  const getTid = async () => { const ctx = await dbGetCurrentContext?.(); return ctx?.tenant?.id || null; };

  // Carrega a janela do período
  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setSource("offline"); setPageLoading(false); return; }
    let cancelled = false;
    (async () => {
      const tid = await getTid();
      if (cancelled || !tid) { setSource("offline"); setPageLoading(false); return; }
      const { fromDate, toDate } = window.getDateRange(period);
      const fromIso = new Date(fromDate + "T00:00:00").toISOString();
      const toEnd = new Date(toDate + "T23:59:59.999").toISOString();
      const [revRes, movRes, consRes] = await Promise.all([
        dbListRevenueEntries?.(tid, fromDate, toDate) || { data: [] },
        dbListStockMovements?.(tid, fromIso, toEnd, { limit: 10000 }) || { data: [] },
        dbTopConsumedItems?.(tid, fromIso, toEnd, 10) || { data: [] },
      ]);
      if (cancelled) return;
      const movs = movRes.data || [];
      const reqIds = movs.filter((m) => m.referenceType === "kitchen_request" && m.referenceId).map((m) => m.referenceId);
      const splitsRes = await dbListSharedSplits?.(tid, reqIds) || { data: {} };
      if (cancelled) return;
      setTenantId(tid);
      setSource("db");
      setRevenueEntries(revRes.data || []);
      setMovements(movs);
      setTopConsumed(consRes.data || []);
      setSharedSplits(splitsRes.data || {});
      setPageLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline, period]);

  // Carrega a janela semanal (uma vez): semana atual + 7 semanas
  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setWeeklyLoading(false); return; }
    let cancelled = false;
    (async () => {
      const tid = await getTid();
      if (cancelled || !tid) { setWeeklyLoading(false); return; }
      const curMon = window.cmvWeekMonday(_cymd(new Date()));
      const start = new Date(curMon + "T00:00:00"); start.setDate(start.getDate() - 7 * 7);
      const fromDate = _cymd(start), toDate = _cymd(new Date());
      const fromIso = new Date(fromDate + "T00:00:00").toISOString();
      const toEnd = new Date(toDate + "T23:59:59.999").toISOString();
      const [revRes, movRes] = await Promise.all([
        dbListRevenueEntries?.(tid, fromDate, toDate) || { data: [] },
        dbListStockMovements?.(tid, fromIso, toEnd, { limit: 20000 }) || { data: [] },
      ]);
      if (cancelled) return;
      const movs = movRes.data || [];
      const reqIds = movs.filter((m) => m.referenceType === "kitchen_request" && m.referenceId).map((m) => m.referenceId);
      const splitsRes = await dbListSharedSplits?.(tid, reqIds) || { data: {} };
      if (cancelled) return;
      setWeeklyRevenue(revRes.data || []);
      setWeeklyMovements(movs);
      setWeeklySharedSplits(splitsRes.data || {});
      setWeeklyLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  // Carrega a janela mensal (lazy quando abrir Insumos no modo mês)
  useEffect(() => {
    if (view !== "insumos" || insumoGran !== "month" || monthLoaded || !dbStatus.isOnline) return;
    let cancelled = false;
    setMonthLoading(true);
    (async () => {
      const tid = await getTid();
      if (cancelled || !tid) { setMonthLoading(false); return; }
      const start = new Date(); start.setMonth(start.getMonth() - 6, 1); start.setHours(0, 0, 0, 0);
      const fromDate = _cymd(start), toDate = _cymd(new Date());
      const fromIso = new Date(fromDate + "T00:00:00").toISOString();
      const toEnd = new Date(toDate + "T23:59:59.999").toISOString();
      const [revRes, movRes] = await Promise.all([
        dbListRevenueEntries?.(tid, fromDate, toDate) || { data: [] },
        dbListStockMovements?.(tid, fromIso, toEnd, { limit: 50000 }) || { data: [] },
      ]);
      if (cancelled) return;
      const movs = movRes.data || [];
      const reqIds = movs.filter((m) => m.referenceType === "kitchen_request" && m.referenceId).map((m) => m.referenceId);
      const splitsRes = await dbListSharedSplits?.(tid, reqIds) || { data: {} };
      if (cancelled) return;
      setMonthRevenue(revRes.data || []);
      setMonthMovements(movs);
      setMonthSharedSplits(splitsRes.data || {});
      setMonthLoaded(true);
      setMonthLoading(false);
    })();
    return () => { cancelled = true; };
  }, [view, insumoGran, monthLoaded, dbStatus.isOnline]);

  const splitsResolved = useMemo(() => _resolveSplits(sharedSplits), [sharedSplits]);
  const weeklySplitsResolved = useMemo(() => _resolveSplits(weeklySharedSplits), [weeklySharedSplits]);
  const monthSplitsResolved = useMemo(() => _resolveSplits(monthSharedSplits), [monthSharedSplits]);

  // ===== Consolidado =====
  const daily = useMemo(() => window.buildDailyRows(revenueEntries, movements, splitsResolved), [revenueEntries, movements, splitsResolved]);
  const adjustLossCost = useMemo(() => movements.reduce((t, mv) => (mv.kind === "adjust" && mv.composeCmv !== false && Number(mv.delta || 0) < 0) ? t + Math.abs(Number(mv.delta || 0)) * Number(mv.unitCost || 0) : t, 0), [movements]);
  const wasteSharedCost = useMemo(() => movements.reduce((t, mv) => ((mv.kind === "loss" || mv.kind === "expiration") && mv.composeCmv !== false && (!mv.op || mv.op === "—")) ? t + Math.abs(Number(mv.delta) || 0) * Number(mv.unitCost || 0) : t, 0), [movements]);
  const totals = useMemo(() => {
    const rev = daily.reduce((s, r) => s + r.revenue, 0);
    const cogs = daily.reduce((s, r) => s + r.cogs, 0) + adjustLossCost + wasteSharedCost;
    return { revenue: rev, cogs, cmv: rev > 0 ? (cogs / rev) * 100 : 0, margin: rev > 0 ? ((rev - cogs) / rev) * 100 : 0 };
  }, [daily, adjustLossCost, wasteSharedCost]);
  const byOp = useMemo(() => {
    const m = {};
    daily.forEach((r) => { if (!m[r.op]) m[r.op] = { op: r.op, revenue: 0, cogs: 0 }; m[r.op].revenue += r.revenue; m[r.op].cogs += r.cogs; });
    const totalRev = Object.values(m).reduce((s, r) => s + r.revenue, 0);
    const shared = adjustLossCost + wasteSharedCost;
    if (totalRev > 0 && shared !== 0) for (const r of Object.values(m)) r.cogs += shared * (r.revenue / totalRev);
    return Object.values(m).map((o) => ({ ...o, cmv: o.revenue > 0 ? (o.cogs / o.revenue) * 100 : 0, margin: o.revenue > 0 ? ((o.revenue - o.cogs) / o.revenue) * 100 : 0 })).sort((a, b) => b.cmv - a.cmv);
  }, [daily, adjustLossCost, wasteSharedCost]);

  // ===== Por item =====
  const periodOps = useMemo(() => _opsFrom(movements), [movements]);
  useEffect(() => { if (opFilter !== "all" && !periodOps.some((o) => o.slug === opFilter)) setOpFilter("all"); }, [periodOps, opFilter]);
  const itemRows = useMemo(() => window.buildItemRows(movements, opFilter), [movements, opFilter]);
  const itemTotal = useMemo(() => itemRows.reduce((s, r) => s + r.cost, 0), [itemRows]);

  // ===== Semanal / Insumos =====
  const weeklyOps = useMemo(() => _opsFrom(weeklyMovements), [weeklyMovements]);
  useEffect(() => { if (weeklyOpFilter !== "all" && !weeklyOps.some((o) => o.slug === weeklyOpFilter)) setWeeklyOpFilter("all"); }, [weeklyOps, weeklyOpFilter]);
  const curMon = window.cmvWeekMonday(_cymd(new Date()));
  const weekly = useMemo(() => window.buildWeeklyRows(weeklyRevenue, weeklyMovements, weeklySplitsResolved, weeklyOpFilter), [weeklyRevenue, weeklyMovements, weeklySplitsResolved, weeklyOpFilter]);

  const insumosData = useMemo(() => {
    if (insumoGran === "month") {
      const curKey = window.cmvMonthKeyOf(_cymd(new Date()));
      const revBy = {};
      for (const re of monthRevenue) { if (weeklyOpFilter !== "all" && re.op !== weeklyOpFilter) continue; const k = window.cmvMonthKeyOf(String(re.date || "").slice(0, 10)); if (!k) continue; revBy[k] = (revBy[k] || 0) + (Number(re.revenue) || 0); }
      const periods = Object.keys(revBy).filter((k) => k < curKey).sort().slice(-6);
      const items = window.buildItemByPeriod(monthMovements, monthSplitsResolved, weeklyOpFilter, window.cmvMonthKeyOf, new Set(periods)).slice(0, 12);
      return { periods, items, labelOf: (k) => { const [y, m] = k.split("-"); return `${["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"][Number(m) - 1]}/${String(y).slice(2)}`; } };
    }
    const complete = weekly.filter((w) => w.week < curMon).slice().sort((a, b) => a.week.localeCompare(b.week));
    const periods = complete.map((w) => w.week);
    const items = window.buildItemByPeriod(weeklyMovements, weeklySplitsResolved, weeklyOpFilter, window.cmvWeekMonday, new Set(periods)).slice(0, 12);
    return { periods, items, labelOf: (k) => window.cmvWeekRangeShort(k).split(" – ")[0] };
  }, [insumoGran, weekly, curMon, weeklyMovements, weeklySplitsResolved, weeklyOpFilter, monthRevenue, monthMovements, monthSplitsResolved]);

  if (pageLoading) return <PageLoading label="Carregando CMV…" variant="dashboard" />;

  const tone = window.cmvTone(totals.cmv);
  const periodLabel = _CMV_PERIOD_LABEL[period] || period;
  const hasData = totals.revenue > 0 || totals.cogs > 0;

  return (
    <MobilePage>
      <WrapTabs value={view} onChange={setView} options={_CMV_VIEWS} />

      <MobileScroll style={{ overflowX: "hidden", padding: "0 0 18px" }}>
        {source !== "db" ? (
          <div style={{ textAlign: "center", padding: "40px 14px", color: "var(--fg-3)", fontSize: 13 }}>
            {source === "offline" ? "Conecte ao Supabase para ver o CMV." : "Carregando…"}
          </div>
        ) : view === "consolidado" ? (
          <>
            <WrapTabs value={period} onChange={setPeriod} options={_CMV_PERIODS} size="sm" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: "0 14px 12px" }}>
              <CmvTile label="CMV" value={hasData ? `${totals.cmv.toFixed(1)}%` : "—"} sub={hasData ? tone.label : "sem dados"} color={hasData ? tone.fg : null} />
              <CmvTile label="Margem" value={hasData ? `${totals.margin.toFixed(1)}%` : "—"} sub="sobre faturamento" />
              <CmvTile label="Faturamento" value={_cbrlk(totals.revenue)} sub={periodLabel} />
              <CmvTile label="Custo (saídas)" value={_cbrlk(totals.cogs)} sub="consumo × custo" />
            </div>
            <div style={{ padding: "0 14px" }}>
              <MSectionLabel>Resultado por operação · {periodLabel}</MSectionLabel>
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                {byOp.length === 0 ? <_CmvEmpty>Sem dados no período.</_CmvEmpty> : byOp.map((r) => {
                  const op = MOCK.opById(r.op); const t = window.cmvTone(r.cmv);
                  return (
                    <div key={r.op} style={{ padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 50, background: op?.color || "var(--fg-3)", flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{op?.name || r.op}</span>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 15, fontWeight: 600, color: t.fg }}>{r.cmv.toFixed(1)}%</span>
                      </div>
                      <_CmvBar pct={r.cmv} color={t.fg} />
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--fg-3)", marginTop: 8 }}>
                        <span>Fat. {_cbrl(r.revenue)}</span><span>Custo {_cbrl(r.cogs)}</span><span>Mrg {r.margin.toFixed(0)}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 16 }}>
                <MSectionLabel>Top consumos · {periodLabel}</MSectionLabel>
                <div style={{ marginTop: 8 }}>
                  {topConsumed.length === 0 ? <_CmvEmpty>Sem consumo no período.</_CmvEmpty> : topConsumed.map((c, i) => (
                    <_CmvItemRow key={i} name={c.item || c.name} sub={`${c.op ? (MOCK.opById(c.op)?.short || "") + " · " : ""}${(Number(c.qty || c.totalQty) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${c.unit || ""}`} value={_cbrl(c.value || c.totalCost)} last={i === topConsumed.length - 1} />
                  ))}
                </div>
              </div>
            </div>
          </>
        ) : view === "items" ? (
          <>
            <WrapTabs value={period} onChange={setPeriod} options={_CMV_PERIODS} size="sm" />
            <_CmvOpSelect value={opFilter} onChange={setOpFilter} ops={periodOps} />
            <div style={{ padding: "8px 14px 0" }}>
              <MSectionLabel>Consumo por item · {periodLabel} · total {_cbrl(itemTotal)}</MSectionLabel>
              <div style={{ marginTop: 8 }}>
                {itemRows.length === 0 ? <_CmvEmpty>Sem consumo no período.</_CmvEmpty> : itemRows.map((r, i) => (
                  <_CmvItemRow key={r.id} name={r.name} sub={`${(Number(r.qty) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${r.unit || ""} · ${itemTotal > 0 ? ((r.cost / itemTotal) * 100).toFixed(1) : 0}%`} value={_cbrl(r.cost)} last={i === itemRows.length - 1} />
                ))}
              </div>
            </div>
          </>
        ) : view === "semanal" ? (
          <>
            <_CmvOpSelect value={weeklyOpFilter} onChange={setWeeklyOpFilter} ops={weeklyOps} />
            <div style={{ padding: "8px 14px 0" }}>
              <MSectionLabel>CMV por semana (Seg→Dom)</MSectionLabel>
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                {weeklyLoading ? <_CmvEmpty>Carregando…</_CmvEmpty> : weekly.length === 0 ? <_CmvEmpty>Sem dados nas últimas semanas.</_CmvEmpty> : weekly.map((w) => {
                  const isCur = w.week === curMon;
                  const t = w.cmv != null ? window.cmvTone(w.cmv) : { fg: "var(--fg-3)", label: "—" };
                  return (
                    <button key={w.week} onClick={() => setWeekDetail(w.week)} style={{ display: "block", width: "100%", textAlign: "left", padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: `1px solid ${isCur ? "var(--accent-line)" : "var(--line)"}`, color: "inherit", cursor: "pointer" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)", fontWeight: 500 }}>
                          {window.cmvWeekRangeShort(w.week)}{isCur ? <span style={{ color: "var(--accent-bright)", fontSize: 11 }}> · atual</span> : ""}
                        </span>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 15, fontWeight: 600, color: t.fg }}>{w.cmv != null ? `${w.cmv.toFixed(1)}%` : "—"}</span>
                        <I.Chevron size={14} style={{ color: "var(--fg-3)", transform: "rotate(-90deg)", flexShrink: 0 }} />
                      </div>
                      {w.cmv != null && <_CmvBar pct={w.cmv} color={t.fg} />}
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--fg-3)", marginTop: 8 }}>
                        <span>Fat. {_cbrl(w.revenue)}</span><span>Custo {_cbrl(w.cogs)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
          <>
            <WrapTabs value={insumoGran} onChange={setInsumoGran} options={[{ id: "week", label: "Por semana" }, { id: "month", label: "Por mês" }]} size="sm" />
            <_CmvOpSelect value={weeklyOpFilter} onChange={setWeeklyOpFilter} ops={weeklyOps} />
            {(() => {
              const fmt = window.cmvPeriodFmt(insumoGran === "month" ? "month" : "week");
              const ps = insumosData.periods;
              const k0 = ps[ps.length - 1];
              const k1 = ps[ps.length - 2] || k0;
              const openInsumo = (it, idx) => {
                if (!k0) return;
                setInsumoCtx({
                  itemId: it.id, name: it.name, unit: it.unit, category: it.category, rank: idx + 1, granularity: insumoGran === "month" ? "month" : "week",
                  period: { key: k0, from: fmt.from(k0), to: fmt.to(k0), label: fmt.full(k0) },
                  prevPeriod: { key: k1, from: fmt.from(k1), to: fmt.to(k1), label: fmt.full(k1) },
                });
              };
              return (
            <div style={{ padding: "8px 14px 0" }}>
              <MSectionLabel>Insumos por custo · {insumosData.periods.length} {insumoGran === "month" ? "meses" : "semanas"}</MSectionLabel>
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                {(insumoGran === "month" && monthLoading) || (insumoGran === "week" && weeklyLoading) ? <_CmvEmpty>Carregando…</_CmvEmpty>
                  : insumosData.items.length === 0 ? <_CmvEmpty>Sem dados suficientes.</_CmvEmpty>
                  : insumosData.items.map((it, idx) => {
                    const maxCost = Math.max(...insumosData.periods.map((p) => it.byKey[p]?.cost || 0), 0.0001);
                    return (
                      <button key={it.id} onClick={() => openInsumo(it, idx)} style={{ display: "block", width: "100%", textAlign: "left", padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "inherit", cursor: "pointer" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                          <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</span>
                          <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>{_cbrl(it.totalCost)}</span>
                          <I.Chevron size={14} style={{ color: "var(--fg-3)", transform: "rotate(-90deg)", flexShrink: 0 }} />
                        </div>
                        <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 34 }}>
                          {insumosData.periods.map((p) => {
                            const c = it.byKey[p]?.cost || 0;
                            return <div key={p} title={`${insumosData.labelOf(p)}: ${_cbrl(c)}`} style={{ flex: 1, minWidth: 0, height: `${Math.max(3, (c / maxCost) * 100)}%`, background: c > 0 ? "var(--accent-bright)" : "var(--bg-3)", borderRadius: 2 }} />;
                          })}
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "var(--fg-4)", fontFamily: "var(--mono)", marginTop: 4 }}>
                          <span>{insumosData.periods[0] ? insumosData.labelOf(insumosData.periods[0]) : ""}</span>
                          <span>{insumosData.periods.length > 1 ? insumosData.labelOf(insumosData.periods[insumosData.periods.length - 1]) : ""}</span>
                        </div>
                      </button>
                    );
                  })}
              </div>
            </div>
              );
            })()}
          </>
        )}
      </MobileScroll>

      {insumoCtx && (
        <MobileInsumoSheet ctx={insumoCtx} op={weeklyOpFilter} tenantId={tenantId} onClose={() => setInsumoCtx(null)} />
      )}
      {weekDetail && (
        <MobileWeekSheet week={weekDetail} movements={weeklyMovements} revenueEntries={weeklyRevenue} sharedSplits={weeklySplitsResolved} opFilter={weeklyOpFilter} onClose={() => setWeekDetail(null)} />
      )}
    </MobilePage>
  );
}

// ===== Sheet: detalhe do insumo (reusa getInsumoDetail + InsumoModalBody do desktop) =====
function MobileInsumoSheet({ ctx, op, tenantId, onClose }) {
  const fmt = window.cmvPeriodFmt(ctx.granularity);
  const [state, setState] = useState({ loading: true, error: false, data: null });
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: false, data: null });
    (async () => {
      try {
        if (!tenantId) throw new Error("sem tenant");
        const data = await window.getInsumoDetail({ tenantId, itemId: ctx.itemId, op, period: ctx.period, prevPeriod: ctx.prevPeriod, rank: ctx.rank, noun: fmt.noun });
        if (!cancelled) setState({ loading: false, error: false, data });
      } catch { if (!cancelled) setState({ loading: false, error: true, data: null }); }
    })();
    return () => { cancelled = true; };
  }, [tenantId, ctx.itemId, ctx.period?.key, ctx.prevPeriod?.key, op]);

  const opName = op === "all" ? "Todas as operações" : (MOCK.opById(op)?.name || op);
  const Body = window.InsumoModalBody;
  return (
    <FullSheet
      title={ctx.name}
      subtitle={`${ctx.category ? ctx.category + " · " : ""}#${ctx.rank} maior custo · ${fmt.nounCap} ${ctx.period.label} · ${opName}`}
      onBack={onClose}
    >
      {state.loading ? (
        <div style={{ padding: "40px 0", textAlign: "center", color: "var(--fg-3)", fontSize: 13 }}>Carregando detalhe…</div>
      ) : state.error ? (
        <div style={{ padding: "40px 0", textAlign: "center", color: "var(--fg-3)", fontSize: 13 }}>Não foi possível carregar o detalhe do insumo.</div>
      ) : (Body ? <Body data={state.data} op={op} noun={fmt.noun} /> : null)}
    </FullSheet>
  );
}

// ===== Sheet: detalhe da semana (reusa buildWeekDetail; comparação de 3 semanas + itens) =====
function MobileWeekSheet({ week, movements, revenueEntries, sharedSplits, opFilter, onClose }) {
  const _q = (q) => (Number(q) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  const addDays = (mon, d) => { const x = new Date(mon + "T12:00:00"); x.setDate(x.getDate() + d); return _cymd(x); };
  const curMon = window.cmvWeekMonday(_cymd(new Date()));
  const nextMon = addDays(week, 7);
  const nextComplete = nextMon < curMon;
  const mons = nextComplete ? [addDays(week, -7), week, nextMon] : [addDays(week, -14), addDays(week, -7), week];
  const details = mons.map((mon) => ({ mon, selected: mon === week, detail: window.buildWeekDetail(movements, revenueEntries, mon, sharedSplits, opFilter) }));
  const sel = details.find((d) => d.selected).detail;
  const tone = sel.cmv != null ? window.cmvTone(sel.cmv) : { fg: "var(--fg-3)" };
  const isCurrent = week === curMon;
  const opName = opFilter === "all" ? null : (MOCK.opById(opFilter)?.name || opFilter);

  const copyWa = () => {
    const lines = [
      `*CMV semanal — ${window.cmvWeekRangeShort(week)}*`,
      `${window.cmvWeekRangeFull(week)} (Seg→Dom)${isCurrent ? " · em andamento" : ""}`,
      ...(opName ? [`Operação: ${opName}`] : []),
      "", `Faturamento: ${_cbrl(sel.revenue)}`, `Custo (CMV): ${_cbrl(sel.cogs)}`, `CMV: ${sel.cmv != null ? sel.cmv.toFixed(1) + "%" : "—"}`,
      "", `*Insumos consumidos (${sel.items.length})*`,
      ...(sel.items.length ? sel.items.map((it) => `• ${it.name} — ${_q(it.qty)} ${it.unit} · ${_cbrl(it.cost)}`) : ["— sem consumo —"]),
    ];
    _copyClipCmv(lines.join("\n"), "Resumo copiado · cole no WhatsApp");
  };

  return (
    <FullSheet
      title={`Semana ${window.cmvWeekRangeShort(week)}`}
      subtitle={`${window.cmvWeekRangeFull(week)}${opName ? " · " + opName : ""}`}
      onBack={onClose}
      footer={<button onClick={copyWa} style={{ width: "100%", height: 50, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><I.WhatsApp size={17} />Copiar p/ WhatsApp</button>}
    >
      {/* Comparação de 3 semanas */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
        {details.map((d) => {
          const t = d.detail.cmv != null ? window.cmvTone(d.detail.cmv) : { fg: "var(--fg-3)" };
          return (
            <div key={d.mon} style={{ padding: "10px 8px", borderRadius: 10, background: d.selected ? "var(--accent-soft)" : "var(--bg-2)", border: `1px solid ${d.selected ? "var(--accent-line)" : "var(--line)"}`, textAlign: "center" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-3)" }}>{window.cmvWeekRangeShort(d.mon)}</div>
              <div style={{ fontSize: 17, fontWeight: 700, marginTop: 4, color: t.fg }}>{d.detail.cmv != null ? `${d.detail.cmv.toFixed(1)}%` : "—"}</div>
            </div>
          );
        })}
      </div>

      {/* KPIs da semana selecionada */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
        <CmvTile label="Faturamento" value={_cbrl(sel.revenue)} />
        <CmvTile label="Custo (CMV)" value={_cbrl(sel.cogs)} />
        <CmvTile label="CMV" value={sel.cmv != null ? `${sel.cmv.toFixed(1)}%` : "—"} color={tone.fg} />
        <CmvTile label="Insumos" value={String(sel.items.length)} sub="consumidos" />
      </div>

      <MSectionLabel>Insumos consumidos na semana</MSectionLabel>
      <div style={{ marginTop: 8 }}>
        {sel.items.length === 0 ? <_CmvEmpty>Sem consumo registrado.</_CmvEmpty> : sel.items.map((it, i) => (
          <_CmvItemRow key={it.id} name={it.name} sub={`${_q(it.qty)} ${it.unit} · ${sel.cogs > 0 ? ((it.cost / sel.cogs) * 100).toFixed(1) : 0}%`} value={_cbrl(it.cost)} last={i === sel.items.length - 1} />
        ))}
      </div>
    </FullSheet>
  );
}

async function _copyClipCmv(text, okMsg) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); window.showToast?.(okMsg, { tone: "ok", ttl: 4000 }); return; }
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

function _CmvOpSelect({ value, onChange, ops }) {
  if (!ops || ops.length === 0) return null;
  return (
    <div style={{ padding: "0 14px 4px" }}>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...mInput, height: 40 }}>
        <option value="all">Todas as operações</option>
        {ops.map((o) => <option key={o.slug} value={o.slug}>{o.name}</option>)}
      </select>
    </div>
  );
}

function _CmvBar({ pct, color }) {
  return (
    <div style={{ position: "relative", height: 6, background: "var(--bg-3)", borderRadius: 3, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${Math.min(100, (pct / 45) * 100)}%`, background: color }} />
    </div>
  );
}
function _CmvEmpty({ children }) {
  return <div style={{ textAlign: "center", padding: "24px 12px", color: "var(--fg-3)", fontSize: 13 }}>{children}</div>;
}
function _CmvItemRow({ name, sub, value, last }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: last ? "none" : "1px solid var(--line-soft)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
        <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2 }}>{sub}</div>
      </div>
      <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-0)", fontWeight: 600, whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}

window.MobileCMV = MobileCMV;
