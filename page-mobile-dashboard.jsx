// page-mobile-dashboard.jsx — Dashboard no celular (≤480px). Tela dedicada dentro
// do MobileApp. Reaproveita 100% a lógica de negócio do desktop (computeKpi,
// computeDashboardMetrics, dashPeriodRange e os cards CMV/Ranking/Alertas/etc.,
// todos expostos por page-dashboard.jsx) — o fork é só de layout/interação.
//
// KPIs viram um StatStrip horizontal; os cards do desktop empilham em coluna única.

const _dBRL = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 });

// Totais de entradas/saídas de estoque no período (R$) — mesma fórmula do desktop.
function _mDashFlows(movements = []) {
  let entradas = 0, saidas = 0;
  for (const mv of movements) {
    const value = Math.abs(mv.delta || 0) * (mv.unitCost || 0);
    if (mv.kind === "in") entradas += value;
    else if (mv.kind === "out" || mv.kind === "loss" || mv.kind === "expiration") saidas += value;
    else if (mv.kind === "adjust") {
      if ((mv.delta || 0) > 0) entradas += value;
      else if ((mv.delta || 0) < 0) saidas += value;
    }
  }
  return { entradas, saidas };
}

const _M_PERIOD_LABEL = {
  "1d": "Hoje", "yesterday": "Ontem", "7d": "Últimos 7 dias",
  "30d": "Últimos 30 dias", "mtd": "Mês atual", "lastmonth": "Mês passado",
};
const _M_PERIOD_OPTS = [
  { id: "1d", label: "Hoje" },
  { id: "yesterday", label: "Ontem" },
  { id: "7d", label: "7 dias" },
  { id: "30d", label: "30 dias" },
  { id: "mtd", label: "Mês" },
  { id: "lastmonth", label: "Mês passado" },
];

function MobileDashboard({ scope = "all", setPage }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [period, setPeriod] = useState("mtd");
  const [tenantId, setTenantId] = useState(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [dbData, setDbData] = useState({
    revenue: [], revenuePrev: [], stock: [], inventories: [],
    periodMovements: [], cmvDaily: [], sharedSplits: {}, requests: [], todayConsumption: [],
  });

  // Resolve o tenant uma vez.
  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setPageLoading(false); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext?.();
      if (cancelled) return;
      const tid = ctx?.tenant?.id;
      setTenantId(tid || null);
      if (!tid) setPageLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  // Carrega os dados do período + realtime (faturamento/saídas atualizam ao vivo).
  useEffect(() => {
    if (!dbStatus.isOnline || !tenantId) return;
    const tid = tenantId;
    let cancelled = false, reloadTimer = null;
    setPageLoading(true);

    const load = async () => {
      const { fromISO, toISO, prevFromISO, prevToISO, toDate } = dashPeriodRange(period);
      const cmvFrom = fromISO.slice(0, 10), cmvTo = toISO.slice(0, 10);
      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);

      const [revRes, revPrevRes, stockRes, invRes, movRes, cmvRes, reqRes, consRes] = await Promise.all([
        dbListRevenueEntries(tid, fromISO, toDate ? toISO : null),
        dbListRevenueEntries(tid, prevFromISO, prevToISO),
        dbListStockItems(tid),
        dbListInventories(tid),
        dbListStockMovements(tid, fromISO, toISO, { limit: 5000 }),
        dbListCmvDaily(tid, cmvFrom, cmvTo),
        dbListKitchenRequests(tid, { limit: 8 }),
        dbTopConsumedItems(tid, startOfDay.toISOString(), endOfDay.toISOString(), 8),
      ]);
      if (cancelled) return;

      // Splits das requisições de uso compartilhado — p/ ratear o CMV por operação.
      const movs = movRes.data || [];
      const reqIds = movs
        .filter((mv) => mv.referenceType === "kitchen_request" && mv.referenceId)
        .map((mv) => mv.referenceId);
      const splitsRes = await dbListSharedSplits?.(tid, reqIds) || { data: {} };
      if (cancelled) return;

      setDbData({
        revenue: revRes.data || [],
        revenuePrev: revPrevRes.data || [],
        stock: stockRes.data || [],
        inventories: invRes.data || [],
        periodMovements: movs,
        cmvDaily: cmvRes.data || [],
        sharedSplits: splitsRes.data || {},
        requests: reqRes.data || [],
        todayConsumption: consRes.data || [],
      });
      setPageLoading(false);
    };

    const scheduleReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { if (!cancelled) load(); }, 400);
    };

    load();

    const unsubs = [
      dbSubscribeTable?.("revenue_entries", tid, scheduleReload),
      dbSubscribeTable?.("stock_movements", tid, scheduleReload),
      dbSubscribeTable?.("goods_receipts", tid, scheduleReload),
    ].filter(Boolean);

    return () => {
      cancelled = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      unsubs.forEach((u) => { try { u(); } catch {} });
    };
  }, [dbStatus.isOnline, tenantId, period]);

  const dbOnline = !!dbStatus.isOnline;
  const periodLabel = _M_PERIOD_LABEL[period] || period;

  const k = useMemo(() => window.computeKpi(scope, dbData, period), [scope, dbData, period]);
  const kk = k[scope] || k.all;
  const metrics = useMemo(() => window.computeDashboardMetrics(scope, period, dbData, dbOnline), [scope, period, dbData, dbOnline]);
  const flows = useMemo(() => _mDashFlows(dbData.periodMovements), [dbData.periodMovements]);

  const alertTone = metrics.alerts.ruptura > 0 ? "crit" : metrics.alerts.total > 0 ? "warn" : "ok";
  const stats = [
    { label: `Faturamento`, value: kk.revenue.v, sub: periodLabel.toLowerCase(), onClick: () => setPage?.("revenue") },
    { label: "CMV do estoque", value: kk.cmv.v, sub: kk.cmv.sub, onClick: () => setPage?.("cmv") },
    { label: "Valor em estoque", value: kk.stockValue.v, sub: kk.stockValue.d, onClick: () => setPage?.("stock") },
    { label: "Entradas", value: _dBRL(flows.entradas), tone: "in", sub: periodLabel.toLowerCase() },
    { label: "Saídas", value: _dBRL(flows.saidas), tone: "out", sub: periodLabel.toLowerCase() },
    { label: "Alertas de estoque", value: String(metrics.alerts.total), tone: alertTone, sub: `${metrics.alerts.ruptura} ruptura · ${metrics.alerts.baixo} baixo`, onClick: () => setPage?.("stock") },
    { label: "Precisão de estoque", value: metrics.inv.accuracy != null ? `${metrics.inv.accuracy.toFixed(0)}%` : "—", sub: metrics.inv.lastDate ? `últ. ${metrics.inv.lastDate}` : "sem inventários", onClick: () => setPage?.("stock") },
  ];

  return (
    <MobilePage>
      <SegTabs value={period} onChange={setPeriod} options={_M_PERIOD_OPTS} />
      <MobileScroll style={{ padding: "4px 0 20px" }}>
        {pageLoading ? (
          <div style={{ padding: 48, textAlign: "center", color: "var(--fg-3)", fontSize: 13 }}>Carregando dashboard…</div>
        ) : (
          <>
            <StatStrip stats={stats} />
            <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "8px 14px 0" }}>
              <window.CmvByOpCard setPage={setPage} cmvDaily={dbData.cmvDaily} movements={dbData.periodMovements} sharedSplits={dbData.sharedSplits} dbOnline={dbOnline} periodLabel={periodLabel} />
              <window.RankingCard cmvDaily={dbData.cmvDaily} movements={dbData.periodMovements} sharedSplits={dbData.sharedSplits} dbOnline={dbOnline} />
              <window.ConsolidatedAlertsCard setPage={setPage} stock={dbData.stock} dbOnline={dbOnline} />
              <window.RecentRequestsCard setPage={setPage} requests={dbData.requests} dbOnline={dbOnline} />
              <window.TodayConsumptionCard consumption={dbData.todayConsumption} dbOnline={dbOnline} />
            </div>
          </>
        )}
      </MobileScroll>
    </MobilePage>
  );
}

Object.assign(window, { MobileDashboard });
