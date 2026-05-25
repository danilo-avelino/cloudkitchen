// Dashboard page — visão consolidada operacional · puxa de TODOS os módulos
function Dashboard({ scope, setPage }) {
  const op = MOCK.opById(scope);
  const isConsolidated = scope === "all";
  const [period, setPeriod] = useState("mtd");
  const periodLabel = { "1d": "Hoje", "7d": "Últimos 7 dias", "30d": "Últimos 30 dias", "mtd": "Mês atual" }[period];
  const sess = (typeof useSession === "function") ? useSession() : null;
  const [tenantNameLive, setTenantNameLive] = useState(sess?.tenantName || null);
  useEffect(() => {
    if (tenantNameLive || !sess?.tenantId) return;
    (async () => {
      const ctx = await dbGetCurrentContext?.();
      const name = ctx?.tenant?.name;
      if (!name) return;
      setTenantNameLive(name);
      try {
        const s = JSON.parse(localStorage.getItem("stockkitchen.session.v1") || "null");
        if (s) localStorage.setItem("stockkitchen.session.v1", JSON.stringify({ ...s, tenantName: name }));
      } catch {}
    })();
  }, [sess?.tenantId]);
  const headerTitle = isConsolidated
    ? (tenantNameLive || sess?.tenantName || "Visão consolidada")
    : op.name;
  const opsCount = (MOCK.OPERATIONS || []).filter((o) => o.id !== "all").length;

  // DB data
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [pageLoading, setPageLoading] = useState(true);
  const [dbData, setDbData] = useState({
    revenue: [],
    revenuePrev: [],        // mesmo length de período, deslocado para o anterior
    stock: [],
    inventories: [],
    todayConsumption: [],
    cmvDaily: [],
    requests: [],
    cmvMovements: [], // saídas (kind=out) do mês até hoje, p/ CMV real por operação
    dreCategories: [],
    dreSubcategories: [],
    financeEntries: [], // do mês corrente, p/ KPI "Compras do mês"
  });

  // Carrega dados do DB + assina realtime (faturamento/saída atualizam o ranking ao vivo)
  useEffect(() => {
    if (dbStatus.state === "checking") return; // aguarda saber o status
    if (!dbStatus.isOnline) { setPageLoading(false); return; }
    const sess = (() => { try { return JSON.parse(localStorage.getItem("stockkitchen.session.v1")); } catch { return null; } })();
    const tid = sess?.tenantId;
    if (!tid) { setPageLoading(false); return; }

    let cancelled = false;
    let reloadTimer = null;

    const load = async () => {
      const days = period === "1d" ? 1 : period === "7d" ? 7 : period === "30d" ? 30 : 31;
      const fromDate = new Date(); fromDate.setDate(fromDate.getDate() - days);
      const fromISO = fromDate.toISOString();
      const prevFromDate = new Date(); prevFromDate.setDate(prevFromDate.getDate() - days * 2);
      const prevFromISO = prevFromDate.toISOString();
      const prevToISO = fromDate.toISOString();

      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      const endOfDay   = new Date(); endOfDay.setHours(23, 59, 59, 999);

      const toYMD       = new Date().toISOString().slice(0, 10);
      const _mtdFirst   = new Date(); _mtdFirst.setDate(1); _mtdFirst.setHours(0, 0, 0, 0);
      const cmvFromYMD  = _mtdFirst.toISOString().slice(0, 10);
      const currentPeriod = `${_mtdFirst.getFullYear()}-${String(_mtdFirst.getMonth() + 1).padStart(2, "0")}`;

      const [, revRes, revPrevRes, stockRes, invRes, consRes, cmvRes, reqRes, movRes, dreCatRes, dreSubRes, finRes] = await Promise.all([
        dbGetCurrentContext?.(),
        dbListRevenueEntries(tid, fromISO, null),
        dbListRevenueEntries(tid, prevFromISO, prevToISO),
        dbListStockItems(tid),
        dbListInventories(tid),
        dbTopConsumedItems(tid, startOfDay.toISOString(), endOfDay.toISOString(), 8),
        dbListCmvDaily(tid, cmvFromYMD, toYMD),
        dbListKitchenRequests(tid, { limit: 8 }),
        dbListStockMovements(tid, _mtdFirst.toISOString(), new Date().toISOString(), { limit: 5000 }),
        dbListDreCategories?.(tid) || { data: null },
        dbListDreSubcategories?.(tid) || { data: null },
        dbListFinanceEntries?.(tid, currentPeriod) || { data: null },
      ]);
      if (cancelled) return;
      setDbData({
        revenue:          revRes.data || [],
        revenuePrev:      revPrevRes.data || [],
        stock:            stockRes.data || [],
        inventories:      invRes.data || [],
        todayConsumption: consRes.data || [],
        cmvDaily:         cmvRes.data || [],
        requests:         reqRes.data || [],
        cmvMovements:     movRes.data || [],
        dreCategories:    dreCatRes.data || [],
        dreSubcategories: dreSubRes.data || [],
        financeEntries:   finRes.data || [],
      });
      setPageLoading(false);
    };

    // Debounce — várias mudanças em sequência viram um único reload
    const scheduleReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { if (!cancelled) load(); }, 400);
    };

    load();

    const unsubs = [
      dbSubscribeTable?.("revenue_entries",  tid, scheduleReload),
      dbSubscribeTable?.("stock_movements",  tid, scheduleReload),
      dbSubscribeTable?.("goods_receipts",   tid, scheduleReload),
      dbSubscribeTable?.("finance_entries",  tid, scheduleReload),
    ].filter(Boolean);

    return () => {
      cancelled = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      unsubs.forEach((u) => { try { u(); } catch {} });
    };
  }, [dbStatus.state, dbStatus.isOnline, period]);

  // Computa KPI real a partir de dados do DB ou MOCK
  const k = useMemo(() => computeKpi(scope, dbData, period), [scope, dbData, period]);

  // Métricas dos novos módulos (Inventário)
  const moduleMetrics = useMemo(() => computeDashboardMetrics(scope, period, dbData, dbStatus.isOnline), [scope, period, dbData, dbStatus.isOnline]);

  // Compras do mês corrente · soma das subcategorias do grupo CMV (exclui autofeed
  // "Ajuste de estoque"). Mesma fórmula do `comprasTotal` da DRE em page-finance.
  const comprasMes = useMemo(() => {
    const cats = dbData.dreCategories || [];
    const subs = dbData.dreSubcategories || [];
    const entries = dbData.financeEntries || [];
    const cmvCatIds = new Set(
      cats.filter((c) => c.kind === "cogs" || c.groupSlug === "cmv" || c.id === "cmv").map((c) => c.id),
    );
    const cmvSubIds = new Set(
      subs.filter((s) => cmvCatIds.has(s.category) && !s.autofeed).map((s) => s.id),
    );
    return entries
      .filter((e) => cmvSubIds.has(e.cat))
      .reduce((acc, e) => acc + (Number(e.value) || 0), 0);
  }, [dbData.dreCategories, dbData.dreSubcategories, dbData.financeEntries]);

  // Totais de entradas e saídas de estoque no mês (R$) · |qty| × custo unitário
  const stockFlows = useMemo(() => {
    let entradas = 0, saidas = 0;
    for (const mv of (dbData.cmvMovements || [])) {
      const value = Math.abs(mv.delta || 0) * (mv.unitCost || 0);
      if (mv.kind === "in")  entradas += value;
      if (mv.kind === "out") saidas   += value;
    }
    return { entradas, saidas };
  }, [dbData.cmvMovements]);

  if (pageLoading) return <PageLoading label="Carregando dashboard…" variant="dashboard" />;

  return (
    <div style={{ padding: "24px 28px 32px", display: "flex", flexDirection: "column", gap: 20 }} className="stagger">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, position: "relative", zIndex: 10 }}>
        <div>
          <div className="h-eyebrow" style={{ marginBottom: 6 }}>
            {isConsolidated ? `Visão consolidada · ${opsCount} ${opsCount === 1 ? "operação" : "operações"}` : `Operação · ${op.short}`}
          </div>
          <h1 className="h-title">{headerTitle}</h1>
          <p className="h-sub">{periodLabel} · operação ao vivo</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <PeriodPicker value={period} onChange={setPeriod} label={periodLabel} />
          <button className="btn" data-size="sm" onClick={() => notImplemented("Exportar dashboard")}>Exportar</button>
          <button className="btn" data-variant="primary" data-size="sm" onClick={() => setPage("requests")}>
            <I.Plus size={13} />Nova requisição
          </button>
        </div>
      </div>

      {/* KPIs financeiros (linha 1) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <KpiCard label={`Faturamento · ${periodLabel}`} data={(k[scope] || k.all).revenue} accent />
        <KpiCard label="CMV consolidado" data={(k[scope] || k.all).cmv} />
        <KpiCard label="Valor em estoque" data={(k[scope] || k.all).stockValue} />
        <KpiCard label="Compras do mês" data={{
          v: `R$ ${(comprasMes / 1000).toFixed(1)}k`,
          d: new Date().toLocaleDateString("pt-BR", { month: "long" }),
          tone: "info",
          sub: "via DRE · CMV",
        }} onClick={() => setPage("finance")} />
      </div>

      {/* Fluxos de estoque + KPIs operacionais — linha única compacta */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <FlowKpi label="Entradas de estoque" value={stockFlows.entradas} tone="in" />
        <FlowKpi label="Saídas de estoque"   value={stockFlows.saidas}   tone="out" />
        <ModuleKpi label="Precisão de estoque"
          value={moduleMetrics.inv.accuracy ? `${moduleMetrics.inv.accuracy.toFixed(0)}%` : "—"}
          sub={moduleMetrics.inv.lastDate ? `último em ${moduleMetrics.inv.lastDate}` : "sem inventários"}
          tone={moduleMetrics.inv.accuracy >= 95 ? "ok" : moduleMetrics.inv.accuracy >= 90 ? "info" : "warn"}
          onClick={() => setPage("stock")} icon={<I.Box size={11} />} />
        <ModuleKpi label="Alertas de estoque"
          value={moduleMetrics.alerts.total}
          sub={`${moduleMetrics.alerts.ruptura} ruptura · ${moduleMetrics.alerts.baixo} baixo · ${moduleMetrics.alerts.acimaMax} acima do máx`}
          tone={moduleMetrics.alerts.ruptura > 0 ? "crit" : moduleMetrics.alerts.total > 0 ? "warn" : "ok"}
          onClick={() => setPage("stock")} icon={<I.AlertTriangle size={11} />} />
      </div>

      {/* CMV + Ranking */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
        <CmvByOpCard setPage={setPage} cmvDaily={dbData.cmvDaily} movements={dbData.cmvMovements} dbOnline={dbStatus.isOnline} />
        <RankingCard cmvDaily={dbData.cmvDaily} movements={dbData.cmvMovements} dbOnline={dbStatus.isOnline} />
      </div>

      {/* Estoque por categoria */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
        <StockByCategoryCard stock={dbData.stock} onClick={() => setPage("stock")} />
      </div>

      {/* Pendências consolidadas + Requisições */}
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 12 }}>
        <ConsolidatedAlertsCard setPage={setPage} stock={dbData.stock} dbOnline={dbStatus.isOnline} />
        <RecentRequestsCard setPage={setPage} requests={dbData.requests} dbOnline={dbStatus.isOnline} />
      </div>

      {/* Operação em tempo real */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
        <TodayConsumptionCard consumption={dbData.todayConsumption} dbOnline={dbStatus.isOnline} />
      </div>
    </div>
  );
}

// Calcula CMV real a partir de revenue e stock value
// CMV = (Custo do Estoque Vendido) / Revenue
// Estimativa: usa valor em estoque como proxy de COGS
function estimateCmvFromData(revenue, stock) {
  const totalRevenue = revenue.reduce((s, r) => s + (r.revenue || 0), 0);
  if (totalRevenue <= 0) return 0;

  // Estimativa de COGS: média ponderada de % do valor em estoque
  // (simplificação: assume que 40% do estoque virou venda)
  const stockValue = stock.reduce((s, it) => s + ((it.qty || 0) * (it.cost || 0)), 0);
  const estimatedCogs = stockValue * 0.40; // proxy: 40% do estoque = COGS

  return Math.min(99, (estimatedCogs / totalRevenue) * 100);
}

// Computa KPI financeiro a partir de dados reais (revenue + stock + período anterior)
function computeKpi(scope, dbData = {}, period = "7d") {
  const { revenue = [], revenuePrev = [], stock = [] } = dbData;
  const periodComparisonLabel = {
    "1d":  "vs ontem",
    "7d":  "vs semana anterior",
    "30d": "vs 30 dias anteriores",
    "mtd": "vs mês anterior",
  }[period] || "vs período anterior";

  // Filtra por operação se não for consolidado
  const matchOp = (r) => scope === "all" || r.operationId === scope || r.op === scope;
  const revFiltered     = revenue.filter(matchOp);
  const revPrevFiltered = revenuePrev.filter(matchOp);
  const stockFiltered   = stock; // stock_items não tem operação no schema atual

  const totalRevenue = revFiltered.reduce((s, r) => s + (r.revenue || 0), 0);
  const prevRevenue  = revPrevFiltered.reduce((s, r) => s + (r.revenue || 0), 0);
  let revenueDeltaTxt, revenueDeltaTone;
  if (prevRevenue > 0) {
    const pct = ((totalRevenue - prevRevenue) / prevRevenue) * 100;
    const sign = pct >= 0 ? "+" : "−";
    revenueDeltaTxt  = `${sign}${Math.abs(pct).toFixed(0)}% ${periodComparisonLabel}`;
    revenueDeltaTone = pct >= 0 ? "up" : "down";
  } else if (totalRevenue > 0) {
    revenueDeltaTxt  = `novo · sem histórico ${periodComparisonLabel}`;
    revenueDeltaTone = "info";
  } else {
    revenueDeltaTxt  = "sem dados no período";
    revenueDeltaTone = "info";
  }

  // Valor em estoque (sem snapshot histórico — sem delta %)
  const stockValue = stockFiltered.reduce((s, it) => s + ((it.qty || 0) * (it.cost || 0)), 0);
  const stockSub   = stockValue > 0 ? `${stockFiltered.length} SKUs em estoque` : "sem itens";

  // CMV real + meta da operação
  const cmvPct  = estimateCmvFromData(revFiltered, stockFiltered);
  const cmv     = `${cmvPct.toFixed(1)}%`;
  const cmvDelta = cmvPct < 30 ? "up" : cmvPct < 35 ? "info" : cmvPct < 40 ? "warn" : "down";

  let cmvGoalTxt, cmvSub;
  if (scope === "all") {
    const goals = (MOCK.OPERATIONS || []).filter((o) => o.id !== "all" && o.cmvGoal != null).map((o) => o.cmvGoal);
    const avgGoal = goals.length ? (goals.reduce((s, g) => s + g, 0) / goals.length) : null;
    cmvGoalTxt = avgGoal != null ? `meta média ${avgGoal.toFixed(0)}%` : "sem meta definida";
    cmvSub = "consolidado";
  } else {
    const scopedOp = (MOCK.OPERATIONS || []).find((o) => o.id === scope);
    cmvGoalTxt = scopedOp?.cmvGoal != null ? `meta ${scopedOp.cmvGoal.toFixed(0)}%` : "sem meta definida";
    cmvSub = "operação";
  }

  // Alertas (stock crítico)
  const alerts = stockFiltered.filter((it) => (it.qty || 0) < (it.reorder || 0)).length;
  const alertsDelta = alerts > 0 ? "down" : "up";

  const base = {
    revenue:    { v: `R$ ${(totalRevenue / 1000).toFixed(1)}k`, d: revenueDeltaTxt, tone: revenueDeltaTone, sub: "faturamento" },
    cmv:        { v: cmv, d: cmvGoalTxt, tone: cmvDelta, sub: cmvSub },
    stockValue: { v: `R$ ${(stockValue / 1000).toFixed(0)}k`, d: stockSub, tone: "info", sub: "atualizado" },
    alerts:     { v: String(alerts), d: `${alerts === 0 ? "sem" : "tem"} críticos`, tone: alertsDelta, sub: "itens abaixo de reorder" },
  };
  return { all: base, [scope]: base };
}

// Computa métricas dos novos módulos consolidando dados de DB/MOCK
function computeDashboardMetrics(scope, period, dbData = {}, dbOnline = false) {
  const days = period === "1d" ? 1 : period === "7d" ? 7 : period === "30d" ? 30 : 31;
  const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() - days);
  const today = new Date(); today.setHours(0, 0, 0, 0);

  // ===== Inventário · última precisão (DB ou MOCK fallback) =====
  const finalizedInv = (dbData.inventories || (dbOnline ? [] : MOCK.INVENTORIES) || [])
    .filter((i) => i.status === "finalized")
    .sort((a, b) => (b.finished_at || "").localeCompare(a.finished_at || ""));
  const last = finalizedInv[0];
  let accuracy = null, lastDate = null;
  if (last) {
    const counted = (last.items || []).filter((it) => it.counted != null);
    if (counted.length > 0) {
      let weight = 0, weighted = 0;
      counted.forEach((it) => {
        const w = Math.max(it.expected || 0, 0) * (it.cost || 0) || 1;
        const err = it.expected > 0 ? Math.abs(it.counted - it.expected) / it.expected * 100 : (it.counted === 0 ? 0 : 100);
        weight += w;
        weighted += Math.max(0, 100 - err) * w;
      });
      accuracy = weight > 0 ? weighted / weight : 0;
    }
    const d = new Date(last.finished_at);
    lastDate = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  const inv = { accuracy, lastDate };

  // ===== Alertas consolidados (Stock) — sempre dados reais quando DB online =====
  const stockSource = dbOnline ? (dbData.stock || []) : (MOCK.STOCK_ITEMS || []);
  let ruptura = 0, baixo = 0, acimaMax = 0;
  for (const i of stockSource) {
    const qty = Number(i.qty) || 0;
    const reorder = Number(i.reorder) || 0;
    const max = Number(i.max) || 0;
    if (qty <= 0) ruptura += 1;
    else if (reorder > 0 && qty < reorder) baixo += 1;
    if (max > 0 && qty > max) acimaMax += 1;
  }
  const alerts = {
    total: ruptura + baixo + acimaMax,
    ruptura, baixo, acimaMax,
  };

  return { inv, alerts };
}

function KpiCard({ label, data, accent }) {
  const d = data || { v: "—", d: "", tone: "info", sub: "" };
  return (
    <div className="kpi" style={accent ? { borderColor: "var(--accent-line)", background: "linear-gradient(180deg, rgba(45,140,102,0.04), transparent 60%)" } : null}>
      <div className="label">{label}</div>
      <div className="value">{d.v}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="delta" data-tone={d.tone === "up" ? "up" : d.tone === "down" ? "down" : "warn"}>
          {d.tone === "up" && <I.ArrowUp size={11} />}
          {d.tone === "down" && <I.ArrowDown size={11} />}
          {d.d}
        </span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>{d.sub}</span>
      </div>
      <Spark accent={accent} />
    </div>
  );
}

function Spark({ accent }) {
  // Static sparkline path
  const pts = [12, 18, 14, 22, 19, 26, 24, 30, 27, 34, 32, 38].map((v, i) => `${i * 8},${44 - v}`).join(" ");
  return (
    <svg width="104" height="44" viewBox="0 0 104 44" className="sparkline" style={{ pointerEvents: "none" }}>
      <polyline points={pts} fill="none" stroke={accent ? "var(--accent-bright)" : "var(--fg-3)"} strokeWidth="1.2" />
    </svg>
  );
}

function CmvByOpCard({ setPage, cmvDaily = [], movements = [], dbOnline = false }) {
  // CMV real por operação no MTD = COGS (saídas de estoque × custo) ÷ faturamento.
  // Faturamento vem de cmv_daily; COGS é recalculado aqui a partir de stock_movements
  // (kind=out) porque revenue_entries.cogs é hoje apenas um placeholder.
  const data = useMemo(() => {
    const m = {};
    for (const row of cmvDaily) {
      if (!row.op) continue;
      if (!m[row.op]) m[row.op] = { op: row.op, revenue: 0, cogs: 0 };
      m[row.op].revenue += row.revenue || 0;
    }
    for (const mv of movements) {
      if (mv.kind !== "out") continue;
      const key = mv.op;
      if (!key || key === "—") continue;
      if (!m[key]) m[key] = { op: key, revenue: 0, cogs: 0 };
      // delta vem positivo no mapping; custo da saída = |qty| × unit_cost
      m[key].cogs += Math.abs(mv.delta || 0) * (mv.unitCost || 0);
    }
    return Object.values(m)
      .filter((r) => r.revenue > 0)
      .map((r) => {
        const opMeta = MOCK.opById(r.op);
        const real = r.revenue > 0 ? (r.cogs / r.revenue) * 100 : 0;
        return { op: r.op, real, goal: opMeta?.cmvGoal ?? 30, shared: 0 };
      })
      .sort((a, b) => a.real - b.real);
  }, [cmvDaily, movements]);
  const max = 45;

  // Faixas absolutas de cor (espelha cmvTone do page-cmv)
  const toneOf = (pct) => {
    if (pct < 30) return { fg: "#38bdf8", label: "ótimo" };
    if (pct < 35) return { fg: "var(--ok)", label: "saudável" };
    if (pct < 40) return { fg: "var(--warn)", label: "alerta" };
    return            { fg: "var(--crit)", label: "crítico" };
  };

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">CMV por operação · {new Date().toLocaleDateString("pt-BR", { month: "long" })} até hoje</h3>
          <span className="card-sub" style={{ display: "block", marginTop: 4 }}>Saídas de estoque ÷ faturamento</span>
        </div>
        <button className="btn" data-variant="ghost" data-size="sm" onClick={() => setPage && setPage("cmv")}>Ver detalhes <I.ChevronR size={12} /></button>
      </div>
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {data.length === 0 && (
          <div style={{ padding: "20px 0", textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>
            {dbOnline ? "Sem faturamento registrado no período" : "DB offline"}
          </div>
        )}
        {data.map((row) => {
          const op = MOCK.opById(row.op);
          const realPct = (row.real / max) * 100;
          const goalPct = (row.goal / max) * 100;
          const tone = toneOf(row.real);
          return (
            <div key={row.op} style={{ display: "grid", gridTemplateColumns: "120px 1fr 80px 80px", gap: 16, alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 6, height: 6, borderRadius: 50, background: op.color }} />
                <span style={{ fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500 }}>{op.name}</span>
              </div>
              <div style={{ position: "relative", height: 8, background: "var(--bg-3)", borderRadius: 4, overflow: "hidden" }}
                   title={`CMV ${row.real.toFixed(1)}% · ${row.shared.toFixed(1)}pp de itens compartilhados`}>
                {/* Itens compartilhados · slate suave com listras diagonais */}
                <div style={{
                  position: "absolute", left: 0, top: 0, height: "100%",
                  width: `${(row.shared / max) * 100}%`,
                  background:
                    "repeating-linear-gradient(135deg, rgba(255,255,255,0.05) 0 3px, transparent 3px 6px)," +
                    "linear-gradient(180deg, rgba(148,163,184,0.38), rgba(100,116,139,0.26))",
                }} />
                {/* Separador sutil entre compartilhado e exclusivo */}
                {row.shared > 0 && row.real - row.shared > 0 && (
                  <div style={{
                    position: "absolute", top: 0, bottom: 0,
                    left: `${(row.shared / max) * 100}%`,
                    width: 1, background: "rgba(0,0,0,0.25)",
                  }} />
                )}
                {/* Exclusivos da operação · cor da faixa */}
                <div style={{
                  position: "absolute", top: 0, height: "100%",
                  left: `${(row.shared / max) * 100}%`,
                  width: `${((row.real - row.shared) / max) * 100}%`,
                  background: tone.fg,
                }} />
                <div style={{ position: "absolute", left: `${goalPct}%`, top: -2, bottom: -2, width: 1, background: "var(--fg-2)" }} title={`meta ${row.goal.toFixed(1)}%`} />
              </div>
              <span className="mono" style={{ fontSize: 13, fontWeight: 500, color: tone.fg }}>{row.real.toFixed(1)}%</span>
              <span className="mono" style={{ fontSize: 10.5, color: tone.fg, textAlign: "right", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {tone.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RankingCard({ cmvDaily = [], movements = [], dbOnline = false }) {
  const ranking = useMemo(() => {
    // Margem de contribuição (R$) = faturamento − custo real das saídas de estoque.
    // revenue_entries.cogs é placeholder (zero); o COGS real vem de stock_movements
    // (kind=out) ponderado pelo unit_cost — mesmo cálculo do CmvByOpCard.
    const byOp = {};
    for (const row of cmvDaily) {
      if (!row.op) continue;
      if (!byOp[row.op]) byOp[row.op] = { op: row.op, revenue: 0, cogs: 0 };
      byOp[row.op].revenue += row.revenue || 0;
    }
    for (const mv of movements) {
      if (mv.kind !== "out") continue;
      const key = mv.op;
      if (!key || key === "—") continue;
      if (!byOp[key]) byOp[key] = { op: key, revenue: 0, cogs: 0 };
      byOp[key].cogs += Math.abs(mv.delta || 0) * (mv.unitCost || 0);
    }
    return Object.values(byOp)
      .filter((r) => r.revenue > 0 || r.cogs > 0)
      .map((r) => ({ op: r.op, contribution: r.revenue - r.cogs }))
      .sort((a, b) => b.contribution - a.contribution);
  }, [cmvDaily, movements]);

  const fmtBRL = (v) => `R$ ${Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">Ranking · margem de contribuição</h3>
          <span className="card-sub" style={{ display: "block", marginTop: 4 }}>Por operação · receita − CMV real (R$)</span>
        </div>
      </div>
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {ranking.length === 0 ? (
          <div style={{ padding: "20px 0", textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>
            {dbOnline ? "Sem faturamento no período" : "DB offline"}
          </div>
        ) : ranking.map((r, i) => {
          const op = MOCK.opById(r.op);
          return (
            <div key={r.op} style={{ display: "grid", gridTemplateColumns: "20px 1fr 140px", gap: 12, alignItems: "center", padding: "10px 0", borderBottom: i < ranking.length - 1 ? "1px solid var(--line-soft)" : "none" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-3)", letterSpacing: "0.04em" }}>0{i + 1}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 6, height: 6, borderRadius: 50, background: op.color }} />
                <span style={{ fontSize: 12.5, color: "var(--fg-0)" }}>{op.name}</span>
              </div>
              <span className="mono" style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 500, textAlign: "right" }}>{fmtBRL(r.contribution)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TodayConsumptionCard({ consumption = [], dbOnline = false }) {
  const totalCost = consumption.reduce((s, it) => s + (it.totalCost || 0), 0);
  const fmtBRL = (v) => `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtQty = (qty, unit) => {
    const n = Number(qty) || 0;
    const intLike = unit === "un" || unit === "pc" || Number.isInteger(n);
    return `${n.toLocaleString("pt-BR", { minimumFractionDigits: intLike ? 0 : 1, maximumFractionDigits: intLike ? 0 : 2 })} ${unit || ""}`.trim();
  };
  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Consumo hoje</h3>
        <span className="card-sub">{fmtBRL(totalCost)} · {consumption.length} SKUs</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {consumption.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>
            {dbOnline ? "Sem consumo registrado hoje" : "DB offline"}
          </div>
        ) : consumption.map((it, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 90px 100px", gap: 8, alignItems: "center", padding: "9px 16px", borderBottom: i < consumption.length - 1 ? "1px solid var(--line-soft)" : "none" }}>
            <div style={{ minWidth: 0, fontSize: 12, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {it.name || "—"}
            </div>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)", textAlign: "right" }}>{fmtQty(it.totalQty, it.unit)}</span>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-0)", textAlign: "right" }}>{fmtBRL(it.totalCost || 0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StockByCategoryCard({ stock = [], onClick }) {
  const data = useMemo(() => {
    const byCat = {};
    let totalValue = 0;
    for (const it of stock) {
      const v = (Number(it.qty) || 0) * (Number(it.cost) || 0);
      const k = it.cat || "Sem categoria";
      byCat[k] = (byCat[k] || 0) + v;
      totalValue += v;
    }
    const arr = Object.entries(byCat).map(([cat, val]) => ({ cat, val })).sort((a, b) => b.val - a.val);
    return { arr, totalValue, totalItems: stock.length };
  }, [stock]);

  const top5 = data.arr.slice(0, 5);
  const max = top5[0]?.val || 1;
  const palette = ["var(--ok)", "var(--crit)", "var(--fg-3)", "var(--accent-bright)", "var(--warn)"];

  const fmtBRL = (v) => `R$ ${(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const valStr = data.totalValue.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const [intPart, decPart] = valStr.split(",");

  return (
    <div className="card" style={{ cursor: onClick ? "pointer" : "default" }} onClick={onClick}>
      <div className="card-header" style={{ alignItems: "flex-start" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.Stock size={14} style={{ color: "var(--fg-2)" }} />
          <div>
            <h3 className="card-title" style={{ marginBottom: 2 }}>Produtos em estoque</h3>
            <div style={{ fontSize: 11, color: "var(--fg-3)" }}>Visão geral e principais categorias</div>
          </div>
        </div>
      </div>

      <div style={{ padding: "12px 16px 4px", display: "grid", gridTemplateColumns: "2fr 1fr", gap: 18, alignItems: "flex-end" }}>
        <div>
          <div className="h-eyebrow" style={{ marginBottom: 4 }}>Valor em estoque total</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
            <span style={{ fontSize: 16, color: "var(--fg-2)", fontFamily: "var(--mono)" }}>R$</span>
            <span className="mono" style={{ fontSize: 38, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.025em", lineHeight: 1 }}>
              {intPart}
            </span>
            <span className="mono" style={{ fontSize: 18, color: "var(--fg-2)" }}>,{decPart}</span>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="h-eyebrow" style={{ marginBottom: 4 }}>Produtos cadastrados</div>
          <div className="mono" style={{ fontSize: 28, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.02em" }}>
            {data.totalItems}
          </div>
        </div>
      </div>

      <div style={{ padding: "14px 16px 6px", display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--fg-2)" }}>
        <I.ArrowUp size={11} style={{ color: "var(--ok)" }} />
        Valor em estoque por categoria (Top 5)
      </div>

      <div style={{ padding: "8px 16px 18px", display: "grid", gridTemplateColumns: `repeat(${Math.max(top5.length, 1)}, 1fr)`, gap: 14, alignItems: "end", minHeight: 200 }}>
        {top5.length === 0 ? (
          <div style={{ textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>Sem itens cadastrados.</div>
        ) : top5.map((g, i) => {
          const h = max > 0 ? Math.max(8, (g.val / max) * 160) : 8;
          return (
            <div key={g.cat} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-1)", whiteSpace: "nowrap" }}>{fmtBRL(g.val)}</span>
              <div style={{
                width: "100%", maxWidth: 96, height: h,
                background: palette[i % palette.length],
                borderRadius: "3px 3px 0 0",
                transition: "height 200ms",
              }} />
              <span style={{ fontSize: 11, color: "var(--fg-2)", textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }} title={g.cat}>
                {g.cat}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RecentRequestsCard({ setPage, requests = [], dbOnline = false }) {
  const recent = (dbOnline ? requests : MOCK.REQUESTS).slice(0, 5);
  const statusMap = {
    pending:   ["Pendente",  "warn"],
    approved:  ["Aprovada",  "info"],
    separated: ["Separada",  "info"],
    delivered: ["Entregue",  "ok"],
    rejected:  ["Recusada",  "crit"],
    cancelled: ["Cancelada", "crit"],
  };
  const fmtBRL = (v) => `R$ ${Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Requisições recentes</h3>
        <button className="btn" data-variant="ghost" data-size="sm" onClick={() => setPage("requests")}>Ver todas <I.ChevronR size={11} /></button>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {recent.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>
            {dbOnline ? "Sem requisições recentes" : "DB offline"}
          </div>
        ) : recent.map((r, i) => {
          const opSlug = r.op || r.operationId || r.operation?.slug;
          const op = MOCK.opById(opSlug);
          const status = r.status || "pending";
          const [lbl, tone] = statusMap[status] || [status, "info"];
          const code = r.code || r.id;
          const itemsCount = r.itemsCount ?? (r.items?.length || 0);
          // `r.total` vem do mapping como string já formatada ("R$ 12,34") — não use em fmtBRL (vira NaN).
          // Tenta totalNum (numérico) ou somaria line_cost dos itens; fallback pro próprio r.total.
          const rawTotal = typeof r.totalNum === "number"
            ? r.totalNum
            : (r.items || []).reduce((s, it) => {
                if (typeof it === "object" && it !== null) return s + (Number(it.line_cost) || 0);
                return s;
              }, 0);
          const total = rawTotal > 0 ? fmtBRL(rawTotal) : (typeof r.total === "string" ? r.total : fmtBRL(0));
          // Horário: data + hora · sempre visível
          let timeLabel = "";
          if (r.requestedAt) {
            try {
              const d = new Date(r.requestedAt);
              const dd = String(d.getDate()).padStart(2, "0");
              const mm = String(d.getMonth() + 1).padStart(2, "0");
              const hhmm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
              timeLabel = `${dd}/${mm} · ${hhmm}`;
            } catch {}
          }
          if (!timeLabel && r.at) timeLabel = r.at;
          return (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: i < recent.length - 1 ? "1px solid var(--line-soft)" : "none" }}>
              <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", width: 72, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(code).slice(0, 8)}</span>
              <span style={{ width: 6, height: 6, borderRadius: 50, background: op?.color || "var(--fg-3)", flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 12, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{op?.name || "Operação"}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
                  {itemsCount} {itemsCount === 1 ? "item" : "itens"}{timeLabel ? ` · ${timeLabel}` : ""}
                </span>
              </div>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-0)" }}>{total}</span>
              <span className="badge" data-tone={tone}>{lbl}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PeriodPicker({ value, onChange, label }) {
  const [open, setOpen] = useState(false);
  const opts = [
    { id: "1d",  label: "Hoje" },
    { id: "7d",  label: "Últimos 7 dias" },
    { id: "30d", label: "Últimos 30 dias" },
    { id: "mtd", label: "Mês atual" },
  ];
  useEffect(() => {
    if (!open) return;
    const onDoc = () => setOpen(false);
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);
  return (
    <div style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
      <button className="btn" data-size="sm" onClick={() => setOpen((o) => !o)}>
        <I.Calendar size={13} />{label}
        <I.Chevron size={11} />
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", right: 0,
          background: "var(--bg-2)", border: "1px solid var(--line-strong)",
          borderRadius: 4, padding: 4, zIndex: 50, minWidth: 180,
          boxShadow: "0 8px 24px -8px rgba(0,0,0,0.5)",
        }}>
          {opts.map((o) => (
            <button key={o.id} onClick={() => { onChange(o.id); setOpen(false); }} style={{
              display: "block", width: "100%", textAlign: "left",
              padding: "7px 10px", fontSize: 12,
              background: o.id === value ? "var(--bg-3)" : "transparent",
              border: "none", borderRadius: 2,
              color: o.id === value ? "var(--fg-0)" : "var(--fg-1)",
            }}>{o.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============= ModuleKpi · KPI clicável com badge tonal e ícone =============
function ModuleKpi({ label, value, sub, tone, icon, onClick }) {
  const valueColor =
    tone === "ok"   ? "var(--ok)" :
    tone === "info" ? "var(--info)" :
    tone === "warn" ? "var(--warn)" :
    tone === "crit" ? "var(--crit)" :
    "var(--fg-0)";
  return (
    <div onClick={onClick} className="kpi" style={{
      cursor: onClick ? "pointer" : "default",
      transition: "border-color 120ms",
    }}>
      <div className="label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {icon && <span style={{ color: valueColor, opacity: 0.7 }}>{icon}</span>}
        {label}
      </div>
      <div className="value" style={{ color: valueColor }}>{value}</div>
      {sub && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ============= ConsolidatedAlertsCard · alertas de estoque =============
function ConsolidatedAlertsCard({ setPage, stock = [], dbOnline = false }) {
  const alerts = useMemo(() => {
    const source = dbOnline ? stock : (MOCK.STOCK_ITEMS || []);
    return source
      .filter((i) => (i.qty || 0) < (i.reorder || 0))
      .sort((a, b) => {
        // rupturas (qty=0) primeiro, depois mais críticos por % do reorder
        const aRatio = (a.reorder || 1) > 0 ? (a.qty || 0) / (a.reorder || 1) : 1;
        const bRatio = (b.reorder || 1) > 0 ? (b.qty || 0) / (b.reorder || 1) : 1;
        return aRatio - bRatio;
      })
      .slice(0, 8)
      .map((i) => ({
        id: `stk-${i.id}`,
        severity: (i.qty || 0) <= 0 ? "critical" : "high",
        source: "Estoque",
        title: (i.qty || 0) <= 0 ? `${i.name} · ruptura` : `${i.name} · ${i.qty} ${i.unit || ""} restantes`,
        op: null,
        page: "stock",
      }));
  }, [stock, dbOnline]);

  const sevColor = (s) => s === "critical" ? "var(--crit)" : s === "high" ? "var(--warn)" : "var(--info)";

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">Alertas consolidados</h3>
          <span className="card-sub" style={{ display: "block", marginTop: 4 }}>Estoque · clique pra ir ao módulo</span>
        </div>
        {alerts.length > 0 && <span className="badge" data-tone="warn">{alerts.length}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {alerts.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>
            Nenhum alerta crítico aberto. ✨
          </div>
        ) : alerts.map((a, i) => (
          <button key={a.id} onClick={() => setPage(a.page)} style={{
            display: "grid", gridTemplateColumns: "8px 1fr auto", gap: 10, alignItems: "center",
            padding: "10px 16px", textAlign: "left",
            background: "transparent", border: "none", cursor: "pointer",
            borderBottom: i < alerts.length - 1 ? "1px solid var(--line-soft)" : "none",
          }}>
            <span style={{ width: 6, height: 6, borderRadius: 50, background: sevColor(a.severity) }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {a.title}
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase", marginTop: 2 }}>
                {a.source}{a.op ? ` · ${a.op.short}` : ""}
              </div>
            </div>
            <I.ChevronR size={11} style={{ color: "var(--fg-3)" }} />
          </button>
        ))}
      </div>
    </div>
  );
}


// FlowKpi · card minimalista com rótulo e valor total em R$ (sem delta nem sparkline)
function FlowKpi({ label, value, tone }) {
  const color = tone === "in" ? "var(--ok)" : tone === "out" ? "var(--crit)" : "var(--fg-0)";
  const fmt = Number(value || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value" style={{ color }}>R$ {fmt}</div>
    </div>
  );
}

window.Dashboard               = Dashboard;
window.KpiCard                 = KpiCard;
window.FlowKpi                 = FlowKpi;
window.ModuleKpi               = ModuleKpi;
window.computeDashboardMetrics = computeDashboardMetrics;
