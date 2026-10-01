// Dashboard page — visão consolidada operacional · puxa de TODOS os módulos

// segundos → "Xm YYs" — formata os tempos gerais de delivery no dashboard
function _fmtDeliverDur(s) {
  if (s == null) return "—";
  const n = Math.round(Number(s));
  const m = Math.floor(n / 60), sec = n % 60;
  return m === 0 ? `${sec}s` : `${m}m ${String(sec).padStart(2, "0")}s`;
}

// Cores dos tempos de delivery — espelham o gráfico de camada da Logística (_LAYERS).
const _TIME_COLORS = {
  avgPrep:    "var(--accent-bright)",
  avgCollect: "var(--info)",
  avgDeliver: "var(--warn)",
  avgTotal:   "var(--accent-bright)",
};

// [fromYMD, toYMD] do período do header — mesmo critério das taxas de entrega
function _dashRangeYMD(period) {
  const from = new Date();
  let to = null;
  if (period === "1d") { from.setHours(0, 0, 0, 0); }
  else if (period === "yesterday") { from.setDate(from.getDate() - 1); from.setHours(0, 0, 0, 0); to = new Date(from); to.setHours(23, 59, 59, 999); }
  else if (period === "7d") { from.setDate(from.getDate() - 6); from.setHours(0, 0, 0, 0); }
  else if (period === "30d") { from.setDate(from.getDate() - 29); from.setHours(0, 0, 0, 0); }
  else if (period === "lastmonth") { from.setDate(1); from.setMonth(from.getMonth() - 1); from.setHours(0, 0, 0, 0); to = new Date(from.getFullYear(), from.getMonth() + 1, 0, 23, 59, 59, 999); }
  else { from.setDate(1); from.setHours(0, 0, 0, 0); }
  return [from.toISOString().slice(0, 10), (to || new Date()).toISOString().slice(0, 10)];
}

// Compras do mês do filtro · soma das subcategorias do grupo CMV (exclui autofeed
// "Ajuste de estoque"). Mesma fórmula do `comprasTotal` da DRE em page-finance.
function computeComprasMes({ dreCategories = [], dreSubcategories = [], financeEntries = [] }) {
  const cmvCatIds = new Set(
    dreCategories.filter((c) => c.kind === "cogs" || c.groupSlug === "cmv" || c.id === "cmv").map((c) => c.id),
  );
  const cmvSubIds = new Set(
    dreSubcategories.filter((s) => cmvCatIds.has(s.category) && !s.autofeed).map((s) => s.id),
  );
  return financeEntries
    .filter((e) => cmvSubIds.has(e.cat))
    .reduce((acc, e) => acc + (Number(e.value) || 0), 0);
}

// Range ISO do período do header (from/to) + período anterior de mesmo tamanho.
// Função pura extraída do useEffect do Dashboard para ser reaproveitada pela
// versão mobile (MobileDashboard) — mesma semântica de dia civil.
function dashPeriodRange(period) {
  // Range começa em 00:00 do dia inicial — evita vazar movimentações de "ontem 23:xx"
  // no filtro "Hoje" e dá semântica de dia civil em todas as opções.
  const fromDate = new Date();
  // toDate limita o range superior (null = sem limite = até agora).
  // "Ontem"/"Mês passado" são os únicos com limite superior explícito.
  let toDate = null;
  if (period === "1d") {
    fromDate.setHours(0, 0, 0, 0);
  } else if (period === "yesterday") {
    fromDate.setDate(fromDate.getDate() - 1);
    fromDate.setHours(0, 0, 0, 0);
    toDate = new Date(fromDate);
    toDate.setHours(23, 59, 59, 999);
  } else if (period === "7d") {
    fromDate.setDate(fromDate.getDate() - 6); // 7 dias incluindo hoje
    fromDate.setHours(0, 0, 0, 0);
  } else if (period === "30d") {
    fromDate.setDate(fromDate.getDate() - 29); // 30 dias incluindo hoje
    fromDate.setHours(0, 0, 0, 0);
  } else if (period === "lastmonth") {
    fromDate.setDate(1);
    fromDate.setMonth(fromDate.getMonth() - 1);
    fromDate.setHours(0, 0, 0, 0);
    toDate = new Date(fromDate.getFullYear(), fromDate.getMonth() + 1, 0, 23, 59, 59, 999);
  } else { // mtd: dia 1 do mês corrente até agora
    fromDate.setDate(1);
    fromDate.setHours(0, 0, 0, 0);
  }
  const fromISO = fromDate.toISOString();
  const toISO   = toDate ? toDate.toISOString() : new Date().toISOString();
  // Período anterior: mesmo tamanho, terminando no início do período atual.
  const prevToISO = fromDate.toISOString();
  const prevFromDate = new Date(fromDate);
  if (period === "1d")             prevFromDate.setDate(prevFromDate.getDate() - 1);
  else if (period === "yesterday") prevFromDate.setDate(prevFromDate.getDate() - 1);
  else if (period === "7d")        prevFromDate.setDate(prevFromDate.getDate() - 7);
  else if (period === "30d")       prevFromDate.setDate(prevFromDate.getDate() - 30);
  else                             prevFromDate.setMonth(prevFromDate.getMonth() - 1);
  const prevFromISO = prevFromDate.toISOString();
  return { fromDate, toDate, fromISO, toISO, prevFromISO, prevToISO };
}

function Dashboard({ scope, setPage }) {
  const op = MOCK.opById(scope);
  const isConsolidated = scope === "all";
  const [period, setPeriod] = useState("mtd");
  const periodLabel = { "1d": "Hoje", "yesterday": "Ontem", "7d": "Últimos 7 dias", "30d": "Últimos 30 dias", "mtd": "Mês atual", "lastmonth": "Mês passado" }[period];
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
  // periodLoading: re-fetch disparado por troca de filtro de período. Mantém os KPIs
  // afetados em skeleton em vez de exibir o valor do filtro anterior.
  const [periodLoading, setPeriodLoading] = useState(false);
  const [dbData, setDbData] = useState({
    revenue: [],
    revenuePrev: [],        // mesmo length de período, deslocado para o anterior
    stock: [],
    inventories: [],
    cmvDaily: [],
    sharedSplits: {}, // { [requestId]: [{op, pct}] } · rateio das requisições de uso compartilhado
    periodMovements: [], // movimentações dentro do range do filtro de período (entradas/saídas KPIs)
    dreCategories: [],
    dreSubcategories: [],
    financeEntries: [], // do mês do filtro, p/ KPI "Compras do mês"
    fees: null,         // taxas de entrega (Agilizone) no período · { total, byOperation }
  });

  // Tempos gerais de delivery (Agilizone) · summary do período + operação do header
  const [deliveryTimes, setDeliveryTimes] = useState(null);
  const [deliveryTimesLoading, setDeliveryTimesLoading] = useState(false);
  const [timesModal, setTimesModal] = useState(null); // null | "avgPrep" | "avgCollect" | "avgDeliver" | "avgTotal"

  // Carrega dados do DB + assina realtime (faturamento/saída atualizam o ranking ao vivo)
  useEffect(() => {
    if (dbStatus.state === "checking") return; // aguarda saber o status
    if (!dbStatus.isOnline) { setPageLoading(false); return; }
    const sess = (() => { try { return JSON.parse(localStorage.getItem("stockkitchen.session.v1")); } catch { return null; } })();
    const tid = sess?.tenantId;
    if (!tid) { setPageLoading(false); return; }

    let cancelled = false;
    let reloadTimer = null;
    // Skeleton nos KPIs dependentes do período (sem afetar carga inicial coberta por PageLoading)
    setPeriodLoading(true);

    const load = async () => {
      // Range do período (from/to + período anterior) — função pura compartilhada
      // com a versão mobile (MobileDashboard).
      const { fromDate, toDate, fromISO, toISO, prevFromISO, prevToISO } = dashPeriodRange(period);

      // Compras do mês (DRE) segue o filtro: usa a competência do mês inicial do período.
      const financePeriod = `${fromDate.getFullYear()}-${String(fromDate.getMonth() + 1).padStart(2, "0")}`;
      // Taxas de entrega: o RPC filtra por business_date (data civil) no período do header.
      const feesFromYMD = fromDate.toISOString().slice(0, 10);
      const feesToYMD   = (toDate || new Date()).toISOString().slice(0, 10);

      const [, revRes, revPrevRes, stockRes, invRes, cmvRes, periodMovRes, dreCatRes, dreSubRes, finRes, feesRes] = await Promise.all([
        dbGetCurrentContext?.(),
        dbListRevenueEntries(tid, fromISO, toDate ? toISO : null),
        dbListRevenueEntries(tid, prevFromISO, prevToISO),
        dbListStockItems(tid),
        dbListInventories(tid),
        // cmvDaily (faturamento por operação dos cards CMV/Ranking): respeita o filtro do header.
        dbListCmvDaily(tid, feesFromYMD, feesToYMD),
        // periodMovements: respeita o filtro de período do header (KPIs de fluxo + cards CMV/Ranking).
        dbListStockMovements(tid, fromISO, toISO, { limit: 5000 }),
        dbListDreCategories?.(tid) || { data: null },
        dbListDreSubcategories?.(tid) || { data: null },
        dbListFinanceEntries?.(tid, financePeriod) || { data: null },
        dbDeliveryFees?.(tid, feesFromYMD, feesToYMD) || { data: null },
      ]);
      if (cancelled) return;
      // Splits das requisições de uso compartilhado que aparecem nas saídas do período —
      // p/ ratear o CMV por operação pelos pct (em vez de 100% na operação primária).
      const cmvMovs = periodMovRes.data || [];
      const reqIds = cmvMovs
        .filter((mv) => mv.referenceType === "kitchen_request" && mv.referenceId)
        .map((mv) => mv.referenceId);
      const splitsRes = await dbListSharedSplits?.(tid, reqIds) || { data: {} };
      if (cancelled) return;
      setDbData({
        revenue:          revRes.data || [],
        revenuePrev:      revPrevRes.data || [],
        stock:            stockRes.data || [],
        inventories:      invRes.data || [],
        cmvDaily:         cmvRes.data || [],
        sharedSplits:     splitsRes.data || {},
        periodMovements:  periodMovRes.data || [],
        dreCategories:    dreCatRes.data || [],
        dreSubcategories: dreSubRes.data || [],
        financeEntries:   finRes.data || [],
        fees:             feesRes.data || null,
      });
      setPageLoading(false);
      setPeriodLoading(false);
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

  // Tempos gerais de delivery · refetch independente p/ responder à troca de operação
  // (scope) sem re-carregar os KPIs financeiros. Respeita o período do header.
  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setDeliveryTimes(null); return; }
    const sess = (() => { try { return JSON.parse(localStorage.getItem("stockkitchen.session.v1")); } catch { return null; } })();
    const tid = sess?.tenantId;
    if (!tid) { setDeliveryTimes(null); return; }
    let cancelled = false;
    setDeliveryTimesLoading(true);
    (async () => {
      const [fromYMD, toYMD] = _dashRangeYMD(period);
      const res = (await dbDeliveryTimeseries?.(tid, fromYMD, toYMD, scope === "all" ? null : scope, null, null)) || { data: null };
      if (cancelled) return;
      setDeliveryTimes(res.data?.summary || null);
      setDeliveryTimesLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline, period, scope]);

  // Drill-down dos KPIs de entrada/saída — abre modal com o histórico filtrado.
  const [flowDetail, setFlowDetail] = useState(null); // null | "in" | "out"
  const [showStockValueModal, setShowStockValueModal] = useState(false);

  // Computa KPI real a partir de dados do DB ou MOCK
  const k = useMemo(() => computeKpi(scope, dbData, period), [scope, dbData, period]);

  // Métricas dos novos módulos (Inventário)
  const moduleMetrics = useMemo(() => computeDashboardMetrics(scope, period, dbData, dbStatus.isOnline), [scope, period, dbData, dbStatus.isOnline]);

  // Mês (competência) do filtro, p/ o KPI "Compras do mês" — deriva do início do período.
  const financeMonthLabel = useMemo(
    () => new Date(`${_dashRangeYMD(period)[0].slice(0, 7)}-01T00:00:00`).toLocaleDateString("pt-BR", { month: "long" }),
    [period],
  );

  const comprasMes = useMemo(() => computeComprasMes(dbData), [dbData.dreCategories, dbData.dreSubcategories, dbData.financeEntries]);

  // Totais de entradas e saídas de estoque no período selecionado (R$) · |qty| × custo unit.
  const stockFlows = useMemo(() => {
    let entradas = 0, saidas = 0;
    for (const mv of (dbData.periodMovements || [])) {
      const value = Math.abs(mv.delta || 0) * (mv.unitCost || 0);
      if (mv.kind === "in")  entradas += value;
      else if (mv.kind === "out" || mv.kind === "loss" || mv.kind === "expiration") saidas += value;
      else if (mv.kind === "adjust") {
        // adjust preserva sinal: sobra (delta>0) entra como entrada, falta (delta<0) como saída
        if ((mv.delta || 0) > 0) entradas += value;
        else if ((mv.delta || 0) < 0) saidas += value;
      }
    }
    return { entradas, saidas };
  }, [dbData.periodMovements]);

  // Taxas de entrega no período · consolidado usa o total; operação usa a quebra por op.
  const feesData = dbData.fees;
  const feesForScope = !feesData ? null
    : (isConsolidated ? feesData.total : (feesData.byOperation?.[scope] || { clientCollected: 0, deliverymanPaid: 0, storeDiscount: 0, ifoodDiscount: 0 }));
  const hasFees = !!feesData && ((Number(feesData.total?.clientCollected) || 0) + (Number(feesData.total?.deliverymanPaid) || 0)) > 0;
  const hasDiscounts = !!feesData && ((Number(feesData.total?.storeDiscount) || 0) + (Number(feesData.total?.ifoodDiscount) || 0)) > 0;

  // Tempos gerais de delivery no período/operação do header.
  const dt = deliveryTimes;
  const hasDeliveryTimes = !!dt && (Number(dt.orders) || 0) > 0;

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
        <KpiCard label={`Faturamento · ${periodLabel}`} data={(k[scope] || k.all).revenue} accent loading={periodLoading} />
        <KpiCard label="CMV do estoque" data={(k[scope] || k.all).cmv} loading={periodLoading} />
        <KpiCard label="Valor em estoque" data={(k[scope] || k.all).stockValue}
          onClick={() => setShowStockValueModal(true)}
          title="Ver os 25 insumos mais caros" />
        <KpiCard label="Compras do mês" data={{
          v: `R$ ${(comprasMes / 1000).toFixed(1)}k`,
          d: financeMonthLabel,
          tone: "info",
          sub: "via DRE · CMV",
        }} onClick={() => setPage("finance")} />
      </div>

      {/* Faturamento mês a mês do ano corrente · filtro próprio de operações */}
      <RevenueMonthlyCard />

      {/* Fluxos de estoque + KPIs operacionais — linha única compacta */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <FlowKpi label="Entradas de estoque" value={stockFlows.entradas} tone="in"  sub={periodLabel.toLowerCase()} onClick={() => setFlowDetail("in")} loading={periodLoading} />
        <FlowKpi label="Saídas de estoque"   value={stockFlows.saidas}   tone="out" sub={periodLabel.toLowerCase()} onClick={() => setFlowDetail("out")} loading={periodLoading} />
        <ModuleKpi label="Precisão de estoque"
          value={moduleMetrics.inv.accuracy ? `${moduleMetrics.inv.accuracy.toFixed(0)}%` : "—"}
          sub={moduleMetrics.inv.lastDate ? `último em ${moduleMetrics.inv.lastDate}` : "sem inventários"}
          tone={moduleMetrics.inv.accuracy >= 95 ? "ok" : moduleMetrics.inv.accuracy >= 90 ? "info" : "warn"}
          onClick={() => setPage("stock")} icon={<I.Box size={11} />} />
      </div>

      {/* Tempos gerais de delivery (Agilizone) — só quando há pedidos no período/operação */}
      {hasDeliveryTimes && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <TimeKpi label="Tempo de preparo" seconds={dt.avgPrep}    color={_TIME_COLORS.avgPrep}    sub={periodLabel.toLowerCase()} loading={deliveryTimesLoading} onClick={() => setTimesModal("avgPrep")} />
          <TimeKpi label="Tempo de coleta"  seconds={dt.avgCollect} color={_TIME_COLORS.avgCollect} sub={periodLabel.toLowerCase()} loading={deliveryTimesLoading} onClick={() => setTimesModal("avgCollect")} />
          <TimeKpi label="Tempo de entrega" seconds={dt.avgDeliver} color={_TIME_COLORS.avgDeliver} sub={periodLabel.toLowerCase()} loading={deliveryTimesLoading} onClick={() => setTimesModal("avgDeliver")} />
          <TimeKpi label="Tempo total" seconds={dt.avgTotal} color={_TIME_COLORS.avgTotal} sub={`${(Number(dt.orders) || 0).toLocaleString("pt-BR")} pedidos`} loading={deliveryTimesLoading} onClick={() => setTimesModal("avgTotal")} />
        </div>
      )}

      {/* Taxas de entrega + investimento em descontos (Agilizone) — só quando há dados no período */}
      {(hasFees || hasDiscounts) && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {hasFees && window.DeliveryFeesBox && <window.DeliveryFeesBox fees={feesForScope} />}
          {hasDiscounts && window.DeliveryDiscountsBox && <window.DeliveryDiscountsBox fees={feesForScope} />}
        </div>
      )}

      {/* CMV + Ranking */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
        <CmvByOpCard setPage={setPage} cmvDaily={dbData.cmvDaily} movements={dbData.periodMovements} sharedSplits={dbData.sharedSplits} dbOnline={dbStatus.isOnline} periodLabel={periodLabel} />
        <RankingCard cmvDaily={dbData.cmvDaily} movements={dbData.periodMovements} sharedSplits={dbData.sharedSplits} dbOnline={dbStatus.isOnline} />
      </div>

      {/* Estoque por categoria */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
        <StockByCategoryCard stock={dbData.stock} onClick={() => setPage("stock")} />
      </div>

      {/* Consumo do mês vs mesmo período do mês anterior */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
        <MonthlyConsumptionCard />
      </div>

      {flowDetail && (
        <StockFlowDetailModal
          direction={flowDetail}
          periodLabel={periodLabel}
          movements={dbData.periodMovements || []}
          onClose={() => setFlowDetail(null)}
        />
      )}

      {showStockValueModal && window.StockTopValueModal && (
        <window.StockTopValueModal
          items={dbData.stock || []}
          onClose={() => setShowStockValueModal(false)}
        />
      )}

      {timesModal && (
        <DeliveryTimesModal
          metricKey={timesModal}
          scope={scope}
          period={period}
          periodLabel={periodLabel}
          onClose={() => setTimesModal(null)}
        />
      )}
    </div>
  );
}

// Modal · histórico de entradas ou saídas do período (drill-down dos FlowKpi).
// `direction`: "in" (entradas) | "out" (saídas e perdas)
function StockFlowDetailModal({ direction, periodLabel, movements, onClose }) {
  const isIn = direction === "in";

  const filtered = useMemo(() => {
    const rows = [];
    for (const mv of movements) {
      const delta = Number(mv.delta || 0);
      const isInbound  = mv.kind === "in" || (mv.kind === "adjust" && delta > 0);
      const isOutbound = mv.kind === "out" || mv.kind === "loss" || mv.kind === "expiration"
                       || (mv.kind === "adjust" && delta < 0);
      if (isIn && !isInbound)   continue;
      if (!isIn && !isOutbound) continue;
      const qtyAbs = Math.abs(delta);
      const value  = qtyAbs * Number(mv.unitCost || 0);
      rows.push({
        id: mv.id,
        at: mv.at,
        kind: mv.kind,
        item: mv.item || "—",
        unit: mv.unit || "",
        qtyAbs,
        unitCost: Number(mv.unitCost || 0),
        value,
        ref: mv.ref || "—",
      });
    }
    return rows.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  }, [movements, isIn]);

  const total = filtered.reduce((s, r) => s + r.value, 0);
  const kindLabel = {
    in: "Entrada", out: "Saída", loss: "Perda", expiration: "Vencimento", adjust: "Ajuste",
  };

  return (
    <Modal
      title={`${isIn ? "Entradas" : "Saídas"} de estoque · ${periodLabel}`}
      subtitle={`${filtered.length} ${filtered.length === 1 ? "movimentação" : "movimentações"} · total R$ ${total.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
      onClose={onClose}
      width={880}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", width: "100%" }}>
          <button className="btn" data-variant="primary" data-size="sm" onClick={onClose}>Fechar</button>
        </div>
      }
    >
      {filtered.length === 0 ? (
        <div style={{ padding: 36, textAlign: "center", fontSize: 12.5, color: "var(--fg-3)" }}>
          Sem {isIn ? "entradas" : "saídas"} no período.
        </div>
      ) : (
        <table className="table" data-density="compact">
          <thead>
            <tr>
              <th style={{ width: 130 }}>Data</th>
              <th>Insumo</th>
              <th style={{ width: 90 }}>Tipo</th>
              <th className="num" style={{ width: 90 }}>Qtd</th>
              <th className="num" style={{ width: 100 }}>Custo unit.</th>
              <th className="num" style={{ width: 110 }}>Total</th>
              <th>Referência</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
                  {r.at
                    ? `${new Date(r.at).toLocaleDateString("pt-BR")} ${new Date(r.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
                    : "—"}
                </td>
                <td className="row-strong">{r.item}</td>
                <td className="dim" style={{ fontSize: 11 }}>{kindLabel[r.kind] || r.kind}</td>
                <td className="num">{Number(r.qtyAbs.toFixed(3))} {r.unit}</td>
                <td className="num">R$ {r.unitCost.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td className="num" style={{ color: isIn ? "var(--ok)" : "var(--crit)", fontWeight: 500 }}>
                  R$ {r.value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td className="dim" style={{ fontSize: 11, maxWidth: 200, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                    title={r.ref}>
                  {r.ref}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

// Modal · tempos de delivery por operação (e por turno, se houver) — drill-down dos TimeKpi.
// Busca o `summary` do agilizone_delivery_timeseries por operação e por turno no período do
// header. Uma chamada por operação (todos os turnos) + uma por (operação × turno).
function DeliveryTimesModal({ metricKey, scope, period, periodLabel, onClose }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);          // [{ op, total, shifts: [{ shift, summary }] }]
  const [hasShifts, setHasShifts] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const sess = (() => { try { return JSON.parse(localStorage.getItem("stockkitchen.session.v1")); } catch { return null; } })();
      const tid = sess?.tenantId;
      if (!tid) { setLoading(false); return; }
      const [fromYMD, toYMD] = _dashRangeYMD(period);
      const allOps = (MOCK.OPERATIONS || []).filter((o) => o.id && o.id !== "all");
      const ops = scope === "all" ? allOps : allOps.filter((o) => o.id === scope);
      const { data: shifts } = (await dbListDeliveryShifts?.(tid)) || { data: [] };
      const shiftList = shifts || [];

      const tasks = [];
      ops.forEach((op) => {
        tasks.push(
          dbDeliveryTimeseries?.(tid, fromYMD, toYMD, op.id, null, null)
            .then((r) => ({ opId: op.id, shiftId: null, summary: r?.data?.summary || null })),
        );
        shiftList.forEach((sh) => {
          tasks.push(
            dbDeliveryTimeseries?.(tid, fromYMD, toYMD, op.id, sh.start_time, sh.end_time)
              .then((r) => ({ opId: op.id, shiftId: sh.id, summary: r?.data?.summary || null })),
          );
        });
      });
      const results = await Promise.all(tasks);
      if (cancelled) return;

      const byOp = {};
      results.forEach((res) => {
        if (!res) return;
        byOp[res.opId] = byOp[res.opId] || { total: null, byShift: {} };
        if (res.shiftId == null) byOp[res.opId].total = res.summary;
        else byOp[res.opId].byShift[res.shiftId] = res.summary;
      });
      const built = ops
        .map((op) => {
          const entry = byOp[op.id] || { total: null, byShift: {} };
          const shiftRows = shiftList
            .map((sh) => ({ shift: sh, summary: entry.byShift[sh.id] }))
            .filter((sr) => sr.summary && (Number(sr.summary.orders) || 0) > 0);
          return { op, total: entry.total, shifts: shiftRows };
        })
        .filter((r) => r.total && (Number(r.total.orders) || 0) > 0);

      setHasShifts(shiftList.length > 0);
      setRows(built);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [metricKey, scope, period]);

  const cols = [
    { key: "avgPrep",    label: "Preparo" },
    { key: "avgCollect", label: "Coleta" },
    { key: "avgDeliver", label: "Entrega" },
    { key: "avgTotal",   label: "Total" },
  ];
  const metricLabel = (cols.find((c) => c.key === metricKey) || {}).label || "Tempos";

  return (
    <Modal
      title={`Tempo por operação · ${metricLabel}`}
      subtitle={`${periodLabel}${hasShifts ? " · detalhado por turno" : ""}`}
      onClose={onClose}
      width={760}
      footer={<button className="btn" data-variant="primary" data-size="sm" onClick={onClose}>Fechar</button>}
    >
      {loading ? (
        <div style={{ padding: 36, textAlign: "center", fontSize: 12.5, color: "var(--fg-3)" }}>Carregando…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 36, textAlign: "center", fontSize: 12.5, color: "var(--fg-3)" }}>
          Sem dados de delivery no período.
        </div>
      ) : (
        <table className="table" data-density="compact">
          <thead>
            <tr>
              <th>Operação</th>
              {cols.map((c) => (
                <th key={c.key} className="num" style={{ width: 84, color: _TIME_COLORS[c.key] }}>{c.label}</th>
              ))}
              <th className="num" style={{ width: 80 }}>Pedidos</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <React.Fragment key={r.op.id}>
                <tr>
                  <td className="row-strong">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 50, background: r.op.color || "var(--fg-3)" }} />
                      {r.op.name}
                    </span>
                  </td>
                  {cols.map((c) => (
                    <td key={c.key} className="num" style={{ fontWeight: c.key === metricKey ? 700 : 500, color: _TIME_COLORS[c.key] }}>
                      {_fmtDeliverDur(r.total?.[c.key])}
                    </td>
                  ))}
                  <td className="num">{(Number(r.total?.orders) || 0).toLocaleString("pt-BR")}</td>
                </tr>
                {r.shifts.map((sr) => (
                  <tr key={r.op.id + "-" + sr.shift.id}>
                    <td style={{ paddingLeft: 22, color: "var(--fg-2)", fontSize: 12 }}>
                      ↳ {sr.shift.name}{" "}
                      <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                        {(sr.shift.start_time || "").slice(0, 5)}–{(sr.shift.end_time || "").slice(0, 5)}
                      </span>
                    </td>
                    {cols.map((c) => (
                      <td key={c.key} className="num" style={{ fontSize: 12, fontWeight: c.key === metricKey ? 600 : 400, color: _TIME_COLORS[c.key], opacity: 0.85 }}>
                        {_fmtDeliverDur(sr.summary?.[c.key])}
                      </td>
                    ))}
                    <td className="num" style={{ fontSize: 12, color: "var(--fg-2)" }}>{(Number(sr.summary?.orders) || 0).toLocaleString("pt-BR")}</td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

// Computa KPI financeiro a partir de dados reais (revenue + stock + período anterior)
function computeKpi(scope, dbData = {}, period = "7d") {
  const { revenue = [], revenuePrev = [], stock = [] } = dbData;
  const periodComparisonLabel = {
    "1d":        "vs ontem",
    "yesterday": "vs anteontem",
    "7d":        "vs semana anterior",
    "30d":       "vs 30 dias anteriores",
    "mtd":       "vs mês anterior",
    "lastmonth": "vs mês anterior",
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

  // Valor em estoque (sem snapshot histórico — sem delta %).
  // Saldos negativos contam como 0 — não devem abater o patrimônio.
  const stockValue = stockFiltered.reduce((s, it) => s + (Math.max(0, it.qty || 0) * (it.cost || 0)), 0);
  const stockSub   = stockValue > 0 ? `${stockFiltered.length} SKUs em estoque` : "sem itens";

  // CMV do estoque = consumo (out/loss/expiration) + ajuste negativo (perda) ÷ faturamento.
  // Só perdas: sobras de contagem não abatem o CMV. Respeita compose_cmv (insumos marcados
  // "não compõe CMV", ex.: embalagens, ficam de fora). Alinhado ao CMV & margem.
  let saidasValue = 0;
  for (const mv of (dbData.periodMovements || [])) {
    if (mv.composeCmv === false) continue;
    if (isNonCmvMovement(mv)) continue; // produção/transferência: conversão de valor, não consumo
    const value = Math.abs(mv.delta || 0) * (mv.unitCost || 0);
    if (mv.kind === "out" || mv.kind === "loss" || mv.kind === "expiration") saidasValue += value;
    else if (mv.kind === "adjust" && (mv.delta || 0) < 0) saidasValue += value;
  }
  const cmvPct  = totalRevenue > 0 ? (saidasValue / totalRevenue) * 100 : 0;
  const cmv     = totalRevenue > 0 ? `${cmvPct.toFixed(1)}%` : "—";
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
  const days = period === "1d" ? 1 : period === "yesterday" ? 1 : period === "7d" ? 7 : period === "30d" ? 30 : 31;
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

function KpiCard({ label, data, accent, onClick, title, loading }) {
  const d = data || { v: "—", d: "", tone: "info", sub: "" };
  const baseStyle = accent
    ? { borderColor: "var(--accent-line)", background: "linear-gradient(180deg, rgba(45,140,102,0.04), transparent 60%)" }
    : null;
  const clickStyle = onClick ? { cursor: "pointer", ...(baseStyle || {}) } : baseStyle;
  return (
    <div
      className="kpi"
      style={clickStyle}
      onClick={loading ? undefined : onClick}
      role={onClick && !loading ? "button" : undefined}
      tabIndex={onClick && !loading ? 0 : undefined}
      onKeyDown={onClick && !loading ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      title={onClick && !loading ? (title || "Ver detalhes") : undefined}
    >
      <div className="label">{label}</div>
      {loading ? (
        <>
          <div className="skel" style={{ height: 30, width: "55%", marginTop: 4, marginBottom: 8 }} />
          <div className="skel" style={{ height: 12, width: "40%" }} />
        </>
      ) : (
        <>
          <div className="value">{d.v}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="delta" data-tone={d.tone === "up" ? "up" : d.tone === "down" ? "down" : "warn"}>
              {d.tone === "up" && <I.ArrowUp size={11} />}
              {d.tone === "down" && <I.ArrowDown size={11} />}
              {d.d}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>{d.sub}</span>
          </div>
        </>
      )}
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

function CmvByOpCard({ setPage, cmvDaily = [], movements = [], sharedSplits = {}, dbOnline = false, periodLabel = "" }) {
  // CMV real por operação no período = COGS ÷ faturamento. Faturamento vem de cmv_daily;
  // COGS é recalculado aqui a partir de stock_movements porque revenue_entries.cogs é
  // hoje apenas um placeholder. Mesma fórmula do módulo CMV: consumo = out + loss/
  // expiration COM operação, excluindo compose_cmv=false; custo compartilhado (ajustes
  // + desperdício sem operação) rateado proporcionalmente ao faturamento.
  const data = useMemo(() => {
    const m = {};
    const ensure = (key) => {
      if (!m[key]) m[key] = { op: key, revenue: 0, cogs: 0, sharedAdjCogs: 0, sharedUseCogs: 0 };
      return m[key];
    };
    for (const row of cmvDaily) {
      if (!row.op) continue;
      ensure(row.op).revenue += row.revenue || 0;
    }
    // Consumo por operação: saídas (out) + desperdício COM operação (loss/expiration),
    // excluindo compose_cmv=false. Uso compartilhado (requisição com splits) é rateado
    // pelos pct entre as operações; o resto cai 100% na operação do movimento. Mesmo
    // critério do módulo CMV (buildDailyRows).
    for (const mv of movements) {
      if (mv.kind !== "out" && mv.kind !== "loss" && mv.kind !== "expiration") continue;
      if (mv.composeCmv === false) continue;
      if (isNonCmvMovement(mv)) continue;
      const cost = Math.abs(mv.delta || 0) * (mv.unitCost || 0);
      if (!cost) continue;
      const splits = mv.referenceId ? sharedSplits[mv.referenceId] : null;
      if (splits && splits.length > 0) {
        const totalPct = splits.reduce((s, x) => s + (x.pct || 0), 0) || 1;
        for (const sp of splits) {
          const slug = MOCK.opById(sp.op)?.slug || sp.op;
          if (!slug || slug === "—") continue;
          const part = cost * ((sp.pct || 0) / totalPct);
          const r = ensure(slug);
          r.cogs          += part;
          r.sharedUseCogs += part; // compõe o segmento cinza "compartilhado"
        }
      } else {
        const key = mv.op;
        if (!key || key === "—") continue;
        ensure(key).cogs += cost;
      }
    }
    // Custo compartilhado (sem operação) rateado por faturamento: ajustes de inventário
    // (só perdas Δ<0; sobras não compõem CMV) + desperdício sem operação. Mesmo critério do módulo CMV.
    let sharedCost = 0;
    for (const mv of movements) {
      if (mv.composeCmv === false) continue;
      if (mv.kind === "adjust") {
        if (Number(mv.delta || 0) >= 0) continue; // sobras não compõem CMV
        sharedCost += Math.abs(Number(mv.delta || 0)) * Number(mv.unitCost || 0);
      } else if ((mv.kind === "loss" || mv.kind === "expiration") && (!mv.op || mv.op === "—")) {
        sharedCost += Math.abs(Number(mv.delta) || 0) * Number(mv.unitCost || 0);
      }
    }
    const totalRev = Object.values(m).reduce((s, r) => s + r.revenue, 0);
    if (totalRev > 0 && sharedCost !== 0) {
      for (const r of Object.values(m)) {
        const share = sharedCost * (r.revenue / totalRev);
        r.cogs          += share;
        r.sharedAdjCogs += share;
      }
    }
    return Object.values(m)
      .filter((r) => r.revenue > 0)
      .map((r) => {
        const opMeta = MOCK.opById(r.op);
        const real = r.revenue > 0 ? (r.cogs / r.revenue) * 100 : 0;
        // Segmento cinza = uso compartilhado (splits) + ajustes/desperdício sem op.
        // Em pp, clampado em [0, real] p/ não estourar a barra.
        const usePP = r.revenue > 0 ? (Math.max(0, r.sharedUseCogs) / r.revenue) * 100 : 0;
        const adjPP = r.revenue > 0 ? (Math.max(0, r.sharedAdjCogs) / r.revenue) * 100 : 0;
        const sharedPP = Math.max(0, Math.min(real, usePP + adjPP));
        return { op: r.op, real, goal: opMeta?.cmvGoal ?? 30, shared: sharedPP, usePP, adjPP };
      })
      .sort((a, b) => a.real - b.real);
  }, [cmvDaily, movements, sharedSplits]);
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
          <h3 className="card-title">CMV por operação · {periodLabel || "período"}</h3>
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
                   title={`CMV ${row.real.toFixed(1)}% · ${row.shared.toFixed(1)}pp compartilhado (${row.usePP.toFixed(1)}pp uso compartilhado + ${row.adjPP.toFixed(1)}pp ajustes de inventário)`}>
                {/* Custo compartilhado (uso compartilhado rateado + ajustes) · slate suave com listras diagonais */}
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

// ============= RevenueMonthlyCard · faturamento mês a mês do ano corrente =============
// Filtro próprio de operações (multi-seleção; vazio = todas). Hover/toque num mês mostra
// o crescimento vs mês anterior e vs mesmo mês do ano anterior. Carrega os dados sozinho
// (ano corrente + ano anterior) p/ ser reaproveitado no desktop e no mobile.
const _RM_MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const _RM_MONTHS_LONG = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const _rmBRL = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _rmShort = (v) => v >= 1e6 ? `${(v / 1e6).toFixed(1).replace(".", ",")}M` : v >= 1000 ? `${Math.round(v / 1000)}k` : `${Math.round(v)}`;
const _rmAxis = (v) => v >= 1e6 ? `R$ ${(v / 1e6).toFixed(1).replace(".", ",")}M` : v >= 1000 ? `R$ ${Math.round(v / 1000)}k` : `R$ ${Math.round(v)}`;

function _rmGrowth(cur, prev) {
  if (!(prev > 0)) return null;
  return ((cur - prev) / prev) * 100;
}

// Data local → "YYYY-MM-DD" (meio-dia evita escorregar de dia em fuso/horário de verão).
const _rmIso = (y, m, d) => {
  const dt = new Date(y, m, d, 12);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
};
const _RM_PROJ_WEEKS = 8;

// Projeção por dia da semana: média de cada dia da semana nas últimas 8 semanas fechadas
// (até ontem; janela não recua antes do 1º dia com faturamento). Mês corrente = realizado
// até ontem + média dos dias restantes; próximo mês = soma das médias dos seus dias.
function _rmProjection(byDay, year, curMonth, today) {
  const dates = Object.keys(byDay).filter((k) => byDay[k] > 0).sort();
  if (!dates.length) return null;
  const first = dates[0];
  const sums = Array(7).fill(0), counts = Array(7).fill(0);
  for (let k = 1; k <= _RM_PROJ_WEEKS * 7; k++) {
    const iso = _rmIso(year, curMonth, today - k);
    if (iso < first) break;
    const wd = new Date(year, curMonth, today - k, 12).getDay();
    sums[wd] += byDay[iso] || 0;
    counts[wd] += 1;
  }
  const n = counts.reduce((s, c) => s + c, 0);
  if (n < 7) return null; // menos de uma semana de histórico
  const avgAll = sums.reduce((s, v) => s + v, 0) / n;
  const perWd = sums.map((s, i) => counts[i] ? s / counts[i] : avgAll);
  const sumFrom = (y, m, fromDay) => {
    const dim = new Date(y, m + 1, 0).getDate();
    let s = 0;
    for (let d = fromDay; d <= dim; d++) s += perWd[new Date(y, m, d, 12).getDay()];
    return s;
  };
  let doneCur = 0;
  for (let d = 1; d < today; d++) doneCur += byDay[_rmIso(year, curMonth, d)] || 0;
  const nextY = curMonth === 11 ? year + 1 : year;
  const nextM = (curMonth + 1) % 12;
  return { cur: doneCur + sumFrom(year, curMonth, today), next: sumFrom(nextY, nextM, 1), nextY, nextM, days: n };
}

function RevenueMonthlyCard({ compact = false }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const now = new Date();
  const year = now.getFullYear();
  const curMonth = now.getMonth(); // 0-11
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState([]); // [] = todas
  const [hover, setHover] = useState(null);     // índice do mês (0-11)
  const [width, setWidth] = useState(640);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setLoading(false); return; }
    const sess = (() => { try { return JSON.parse(localStorage.getItem("stockkitchen.session.v1")); } catch { return null; } })();
    const tid = sess?.tenantId;
    if (!tid) { setLoading(false); return; }
    let cancelled = false, reloadTimer = null;
    const load = async () => {
      const res = await dbRevenueMonthly(tid, `${year - 1}-01-01`, `${year}-12-31`);
      if (cancelled) return;
      setRows(res.data || []);
      setLoading(false);
    };
    load();
    const unsub = dbSubscribeTable?.("revenue_entries", tid, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { if (!cancelled) load(); }, 400);
    });
    return () => {
      cancelled = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      try { unsub?.(); } catch {}
    };
  }, [dbStatus.state, dbStatus.isOnline, year]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(260, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  const ops = (MOCK.OPERATIONS || []).filter((o) => o.id !== "all");

  // { "YYYY-MM-DD": total } e { "YYYY-MM": total } das operações selecionadas.
  const { byDay, byMonth } = useMemo(() => {
    const sel = new Set(selected);
    const d = {}, m = {};
    for (const r of rows) {
      if (sel.size > 0 && !sel.has(r.operationId)) continue;
      d[r.date] = (d[r.date] || 0) + (r.revenue || 0);
      m[r.month] = (m[r.month] || 0) + (r.revenue || 0);
    }
    return { byDay: d, byMonth: m };
  }, [rows, selected]);

  const today = now.getDate();
  const proj = useMemo(() => _rmProjection(byDay, year, curMonth, today), [byDay, year, curMonth, today]);
  // Mesmo período (dia 1 até ontem) no mês corrente e no anterior — comparativo justo do mês parcial.
  const mtd = useMemo(() => {
    const pY = curMonth === 0 ? year - 1 : year, pM = (curMonth + 11) % 12;
    const pDim = new Date(pY, pM + 1, 0).getDate();
    let cur = 0, prev = 0;
    for (let d = 1; d < today; d++) {
      cur += byDay[_rmIso(year, curMonth, d)] || 0;
      if (d <= pDim) prev += byDay[_rmIso(pY, pM, d)] || 0;
    }
    return { cur, prev: prev > 0 ? prev : null };
  }, [byDay, year, curMonth, today]);

  const key = (y, mi) => `${y}-${String(mi + 1).padStart(2, "0")}`;
  const months = _RM_MONTHS.map((label, i) => {
    const prevY = i === 0 ? year - 1 : year;
    const prevM = i === 0 ? 11 : i - 1;
    const has = (k) => Object.prototype.hasOwnProperty.call(byMonth, k);
    const value = byMonth[key(year, i)] || 0;
    const projected = !proj ? null
      : i === curMonth ? Math.max(proj.cur, value)
      : (proj.nextY === year && i === proj.nextM) ? proj.next
      : null;
    return {
      i, label, projected,
      future: i > curMonth,
      partial: i === curMonth,
      value,
      prev: has(key(prevY, prevM)) ? byMonth[key(prevY, prevM)] : null,
      prevLabel: `${_RM_MONTHS_LONG[prevM]}${i === 0 ? `/${prevY}` : ""}`,
      yoy: has(key(year - 1, i)) ? byMonth[key(year - 1, i)] : null,
    };
  });
  const ytd = months.filter((m) => !m.future).reduce((s, m) => s + m.value, 0);

  const toggleOp = (id) => setSelected((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);

  // Geometria
  const H = compact ? 200 : 240;
  const pad = { top: 22, right: 8, bottom: 24, left: compact ? 44 : 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const maxV = Math.max(1, ...months.map((m) => Math.max(m.value, m.projected || 0)));
  const step = (() => {
    const raw = maxV / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  })();
  const yMax = step * Math.ceil(maxV / step);
  const ticks = [];
  for (let v = 0; v <= yMax + 1e-6; v += step) ticks.push(v);
  const colW = plotW / 12;
  const barW = Math.max(6, Math.min(36, colW * 0.6));
  const y = (v) => pad.top + plotH - (v / yMax) * plotH;

  const hm = hover != null ? months[hover] : null;
  const tipLeft = hm ? Math.min(Math.max(pad.left + colW * hm.i + colW / 2, 110), width - 110) : 0;
  const barPath = (cx, h) => {
    const x0 = cx - barW / 2, x1 = cx + barW / 2, yb = y(0), yt = yb - h, r = Math.min(4, h, barW / 2);
    return `M${x0},${yb} L${x0},${yt + r} Q${x0},${yt} ${x0 + r},${yt} L${x1 - r},${yt} Q${x1},${yt} ${x1},${yt + r} L${x1},${yb} Z`;
  };
  const barH = (v) => v > 0 ? Math.max(2, plotH - (y(v) - pad.top)) : 0;
  const curProj = months[curMonth].projected;
  const nextProj = proj ? (proj.nextY === year ? months[proj.nextM].projected : proj.next) : null;

  const chipStyle = (active) => ({
    display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0,
    padding: "4px 10px", borderRadius: 999, fontSize: 11.5, cursor: "pointer",
    border: `1px solid ${active ? "var(--accent-line)" : "var(--line)"}`,
    background: active ? "var(--accent-soft, rgba(45,140,102,0.12))" : "transparent",
    color: active ? "var(--fg-0)" : "var(--fg-2)",
  });

  const GrowthLine = ({ label, cur, base }) => {
    const g = _rmGrowth(cur, base);
    return (
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11.5 }}>
        <span style={{ color: "var(--fg-3)" }}>{label}</span>
        {g == null ? (
          <span style={{ color: "var(--fg-3)" }}>sem dados</span>
        ) : (
          <span className="mono" style={{ color: g >= 0 ? "var(--ok)" : "var(--crit)", fontWeight: 600 }}>
            {g >= 0 ? "▲ +" : "▼ −"}{Math.abs(g).toFixed(1).replace(".", ",")}%
            <span style={{ color: "var(--fg-3)", fontWeight: 400 }}> · {_rmBRL(base)}</span>
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="card">
      <div className="card-header" style={{ flexWrap: "wrap", gap: 10 }}>
        <div>
          <h3 className="card-title">Faturamento mês a mês · {year}</h3>
          <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
            Acumulado no ano: <b style={{ color: "var(--fg-0)" }}>{_rmBRL(ytd)}</b> · passe o mouse num mês para ver o crescimento
          </span>
          {proj && (
            <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
              Projeção {_RM_MONTHS[curMonth].toLowerCase()}: <b style={{ color: "var(--fg-0)" }}>≈ {_rmBRL(curProj)}</b>
              {" · "}{_RM_MONTHS[proj.nextM].toLowerCase()}{proj.nextY !== year ? `/${proj.nextY}` : ""}: <b style={{ color: "var(--fg-0)" }}>≈ {_rmBRL(nextProj)}</b>
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: compact ? "nowrap" : "wrap", overflowX: compact ? "auto" : "visible", maxWidth: "100%" }}>
          <button type="button" style={chipStyle(selected.length === 0)} onClick={() => setSelected([])}>Todas</button>
          {ops.map((o) => (
            <button type="button" key={o.id} style={chipStyle(selected.includes(o.id))} onClick={() => toggleOp(o.id)}>
              <span style={{ width: 6, height: 6, borderRadius: 50, background: o.color }} />{o.name}
            </button>
          ))}
        </div>
      </div>
      <div className="card-body">
        {loading ? (
          <div className="skel" style={{ height: H, width: "100%" }} />
        ) : !dbStatus.isOnline ? (
          <div style={{ padding: "20px 0", textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>DB offline</div>
        ) : (
          <div ref={wrapRef} style={{ position: "relative", width: "100%" }} onMouseLeave={() => setHover(null)}>
            <svg width={width} height={H} style={{ display: "block" }} role="img" aria-label={`Faturamento mensal de ${year}`}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" strokeDasharray={t === 0 ? undefined : "2 4"} />
                  <text x={pad.left - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--fg-3)" fontFamily="var(--mono)">{_rmAxis(t)}</text>
                </g>
              ))}
              {months.map((m) => {
                const cx = pad.left + colW * m.i + colW / 2;
                const h = barH(m.value);
                const ph = m.projected != null ? barH(m.projected) : 0;
                const dim = hover != null && hover !== m.i;
                // Rótulo do realizado some quando colado no rótulo da projeção.
                const showValueLabel = m.value > 0 && !(ph > 0 && ph - h < 14);
                return (
                  <g key={m.i}>
                    {ph > 0 && (
                      <path d={barPath(cx, ph)} fill="var(--accent-bright)" fillOpacity="0.1"
                        stroke="var(--accent-bright)" strokeWidth="1" strokeDasharray="3 3" opacity={dim ? 0.35 : 0.9} />
                    )}
                    {h > 0 && (
                      <path
                        d={barPath(cx, h)}
                        fill="var(--accent-bright)"
                        opacity={dim ? 0.35 : m.partial ? 0.7 : 1}
                      />
                    )}
                    {ph > 0 && (
                      <text x={cx} y={y(m.projected) - 5} textAnchor="middle" fontSize={compact ? 9 : 10.5} fontWeight="600"
                        fill="var(--fg-3)" fontFamily="var(--mono)" opacity={dim ? 0.4 : 1}>≈{_rmShort(m.projected)}</text>
                    )}
                    {showValueLabel && (
                      <text x={cx} y={y(m.value) - 5} textAnchor="middle" fontSize={compact ? 9 : 10.5} fontWeight="600"
                        fill="var(--fg-1)" fontFamily="var(--mono)" opacity={dim ? 0.4 : 1}>{_rmShort(m.value)}</text>
                    )}
                    <text x={cx} y={H - 8} textAnchor="middle" fontSize="10.5" fill={m.future ? "var(--fg-3)" : "var(--fg-2)"} opacity={m.future && m.projected == null ? 0.5 : 1}>{m.label}</text>
                    {(!m.future || m.projected != null) && (
                      <rect x={pad.left + colW * m.i} y={pad.top} width={colW} height={plotH + pad.bottom} fill="transparent"
                        style={{ cursor: "pointer" }}
                        onMouseEnter={() => setHover(m.i)}
                        onClick={() => setHover((h0) => h0 === m.i ? null : m.i)} />
                    )}
                  </g>
                );
              })}
            </svg>
            {hm && (
              <div style={{
                position: "absolute", left: tipLeft, top: Math.max(0, y(Math.max(hm.value, hm.projected || 0)) - 22), transform: "translate(-50%, -100%)",
                width: 240, padding: "10px 12px", borderRadius: 8, pointerEvents: "none", zIndex: 5,
                background: "var(--bg-1)", border: "1px solid var(--line)", boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
                display: "flex", flexDirection: "column", gap: 6,
              }}>
                <div style={{ fontSize: 11, color: "var(--fg-3)", textTransform: "capitalize" }}>
                  {_RM_MONTHS_LONG[hm.i]} {year}{hm.partial ? " · em andamento" : hm.future ? " · projeção" : ""}
                </div>
                {hm.future ? (
                  <>
                    <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: "var(--fg-0)" }}>≈ {_rmBRL(hm.projected)}</div>
                    <GrowthLine label={`vs projeção ${hm.prevLabel}`} cur={hm.projected} base={curProj} />
                    <GrowthLine label={`vs ${_RM_MONTHS[hm.i].toLowerCase()}/${year - 1}`} cur={hm.projected} base={hm.yoy} />
                  </>
                ) : hm.partial ? (
                  <>
                    <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: "var(--fg-0)" }}>{_rmBRL(hm.value)}</div>
                    <GrowthLine label={`até ontem vs mesmo período de ${hm.prevLabel}`} cur={mtd.cur} base={mtd.prev} />
                    {hm.projected != null && (
                      <>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11.5 }}>
                          <span style={{ color: "var(--fg-3)" }}>Projeção do mês</span>
                          <span className="mono" style={{ color: "var(--fg-0)", fontWeight: 600 }}>≈ {_rmBRL(hm.projected)}</span>
                        </div>
                        <GrowthLine label={`projeção vs ${hm.prevLabel}`} cur={hm.projected} base={hm.prev} />
                        <GrowthLine label={`projeção vs ${_RM_MONTHS[hm.i].toLowerCase()}/${year - 1}`} cur={hm.projected} base={hm.yoy} />
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: "var(--fg-0)" }}>{_rmBRL(hm.value)}</div>
                    <GrowthLine label={`vs ${hm.prevLabel}`} cur={hm.value} base={hm.prev} />
                    <GrowthLine label={`vs ${_RM_MONTHS[hm.i].toLowerCase()}/${year - 1}`} cur={hm.value} base={hm.yoy} />
                  </>
                )}
                {hm.projected != null && (
                  <div style={{ fontSize: 10.5, color: "var(--fg-3)", borderTop: "1px solid var(--line)", paddingTop: 6 }}>
                    Projeção: média de cada dia da semana nos últimos {proj.days} dias
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RankingCard({ cmvDaily = [], movements = [], sharedSplits = {}, dbOnline = false }) {
  const ranking = useMemo(() => {
    // Margem de contribuição (R$) = faturamento − COGS real das saídas de estoque.
    // revenue_entries.cogs é placeholder (zero); o COGS real vem de stock_movements
    // ponderado pelo unit_cost — mesma fórmula do CmvByOpCard e do módulo CMV
    // (out + loss/expiration com operação, excluindo compose_cmv=false; ajustes +
    // desperdício sem operação rateados pelo faturamento).
    const byOp = {};
    const ensure = (key) => {
      if (!byOp[key]) byOp[key] = { op: key, revenue: 0, cogs: 0 };
      return byOp[key];
    };
    for (const row of cmvDaily) {
      if (!row.op) continue;
      ensure(row.op).revenue += row.revenue || 0;
    }
    // Uso compartilhado (requisição com splits) rateado pelos pct; o resto cai 100% na op.
    for (const mv of movements) {
      if (mv.kind !== "out" && mv.kind !== "loss" && mv.kind !== "expiration") continue;
      if (mv.composeCmv === false) continue;
      if (isNonCmvMovement(mv)) continue;
      const cost = Math.abs(mv.delta || 0) * (mv.unitCost || 0);
      if (!cost) continue;
      const splits = mv.referenceId ? sharedSplits[mv.referenceId] : null;
      if (splits && splits.length > 0) {
        const totalPct = splits.reduce((s, x) => s + (x.pct || 0), 0) || 1;
        for (const sp of splits) {
          const slug = MOCK.opById(sp.op)?.slug || sp.op;
          if (!slug || slug === "—") continue;
          ensure(slug).cogs += cost * ((sp.pct || 0) / totalPct);
        }
      } else {
        const key = mv.op;
        if (!key || key === "—") continue;
        ensure(key).cogs += cost;
      }
    }
    // Custo compartilhado (sem operação) rateado por faturamento: ajustes (só perdas Δ<0;
    // sobras não compõem CMV) + desperdício sem op.
    let sharedCost = 0;
    for (const mv of movements) {
      if (mv.composeCmv === false) continue;
      if (mv.kind === "adjust") {
        if (Number(mv.delta || 0) >= 0) continue; // sobras não compõem CMV
        sharedCost += Math.abs(Number(mv.delta || 0)) * Number(mv.unitCost || 0);
      } else if ((mv.kind === "loss" || mv.kind === "expiration") && (!mv.op || mv.op === "—")) {
        sharedCost += Math.abs(Number(mv.delta) || 0) * Number(mv.unitCost || 0);
      }
    }
    const totalRev = Object.values(byOp).reduce((s, r) => s + r.revenue, 0);
    if (totalRev > 0 && sharedCost !== 0) {
      for (const r of Object.values(byOp)) {
        r.cogs += sharedCost * (r.revenue / totalRev);
      }
    }
    return Object.values(byOp)
      .filter((r) => r.revenue > 0 || r.cogs > 0)
      .map((r) => ({ op: r.op, contribution: r.revenue - r.cogs }))
      .sort((a, b) => b.contribution - a.contribution);
  }, [cmvDaily, movements, sharedSplits]);

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

// ============= MonthlyConsumptionCard · consumo do mês até hoje vs mesmo período do mês anterior =============
// Ex.: dia 10 → 01–10 deste mês vs 01–10 do mês anterior (até o mesmo horário). Também traz
// a média mensal dos 3 meses fechados anteriores e a projeção do mês no ritmo atual.
// Carrega os próprios dados (baixas 'out' dos últimos ~4 meses) p/ servir desktop e mobile.
const _MC_MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const _mcBRL = (v) => `R$ ${(Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const _mcQty = (qty, unit) => {
  const n = Number(qty) || 0;
  const intLike = unit === "un" || unit === "pc" || Number.isInteger(n);
  return `${n.toLocaleString("pt-BR", { minimumFractionDigits: intLike ? 0 : 1, maximumFractionDigits: intLike ? 0 : 1 })} ${unit || ""}`.trim();
};
const _mcPct = (cur, base) => (base > 0 ? ((cur - base) / base) * 100 : null);

// Δ% com seta · consumo/custo subindo = vermelho, caindo = verde.
function _McDelta({ pct, isNew, size = 11.5 }) {
  if (isNew) return <span className="mono" style={{ fontSize: size, color: "var(--info)" }}>novo</span>;
  if (pct == null) return <span className="mono" style={{ fontSize: size, color: "var(--fg-3)" }}>—</span>;
  const flat = Math.abs(pct) < 0.5;
  const color = flat ? "var(--fg-2)" : pct > 0 ? "var(--crit)" : "var(--ok)";
  return (
    <span className="mono" style={{ fontSize: size, color, fontWeight: 600, whiteSpace: "nowrap" }}>
      {flat ? "= " : pct > 0 ? "▲ +" : "▼ −"}{Math.abs(pct).toFixed(flat ? 0 : 1).replace(".", ",")}%
    </span>
  );
}

function _mcWindows() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const curStart = new Date(y, m, 1);
  const prevStart = new Date(y, m - 1, 1);
  const prevDays = new Date(y, m, 0).getDate();
  // Mesmo dia (limitado ao tamanho do mês anterior) e mesmo horário de agora.
  const prevEnd = new Date(y, m - 1, Math.min(d, prevDays), now.getHours(), now.getMinutes(), now.getSeconds(), 999);
  const histStart = new Date(y, m - 3, 1); // 3 meses fechados: m-3, m-2, m-1
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const elapsedDays = (now - curStart) / 86400000;
  return { now, d, m, curStart, prevStart, prevEnd, histStart, daysInMonth, elapsedDays };
}

function MonthlyConsumptionCard({ compact = false }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [rows, setRows] = useState([]);
  const [win, setWin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState("cost"); // cost | up | down
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setLoading(false); return; }
    const sess = (() => { try { return JSON.parse(localStorage.getItem("stockkitchen.session.v1")); } catch { return null; } })();
    const tid = sess?.tenantId;
    if (!tid) { setLoading(false); return; }
    let cancelled = false, reloadTimer = null;
    const load = async () => {
      const w = _mcWindows(); // recalculado a cada carga — o "agora" anda
      const res = await dbListConsumptionMovements(tid, w.histStart.toISOString(), w.now.toISOString());
      if (cancelled) return;
      setWin(w);
      setRows(res.data || []);
      setLoading(false);
    };
    load();
    const unsub = dbSubscribeTable?.("stock_movements", tid, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { if (!cancelled) load(); }, 400);
    });
    return () => {
      cancelled = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      try { unsub?.(); } catch {}
    };
  }, [dbStatus.state, dbStatus.isOnline]);

  const data = useMemo(() => {
    if (!win) return null;
    const curStartMs = win.curStart.getTime(), prevStartMs = win.prevStart.getTime(), prevEndMs = win.prevEnd.getTime();
    const items = {};
    const tot = { cur: 0, prev: 0, hist: 0 };
    for (const mv of rows) {
      const t = new Date(mv.at).getTime();
      const it = items[mv.itemId] || (items[mv.itemId] = {
        id: mv.itemId, name: mv.name, unit: mv.unit,
        curQty: 0, curCost: 0, prevQty: 0, prevCost: 0, histQty: 0, histCost: 0,
      });
      if (t >= curStartMs) {
        it.curQty += mv.qty; it.curCost += mv.cost; tot.cur += mv.cost;
      } else {
        // Antes do mês corrente = histórico dos 3 meses fechados
        it.histQty += mv.qty; it.histCost += mv.cost; tot.hist += mv.cost;
        if (t >= prevStartMs && t <= prevEndMs) { it.prevQty += mv.qty; it.prevCost += mv.cost; tot.prev += mv.cost; }
      }
    }
    const pace = win.elapsedDays > 0 ? win.daysInMonth / win.elapsedDays : 1;
    const list = Object.values(items)
      .filter((it) => it.curQty > 0 || it.prevQty > 0)
      .map((it) => {
        const curUnit = it.curQty > 0 ? it.curCost / it.curQty : null;
        const prevUnit = it.prevQty > 0 ? it.prevCost / it.prevQty : null;
        return {
          ...it,
          qtyPct: _mcPct(it.curQty, it.prevQty),
          isNew: it.prevQty === 0 && it.curQty > 0,
          pricePct: curUnit != null && prevUnit != null ? _mcPct(curUnit, prevUnit) : null,
          share: tot.cur > 0 ? (it.curCost / tot.cur) * 100 : 0,
          projQty: it.curQty * pace,
          avgQty: it.histQty / 3,
        };
      });
    return {
      list,
      total: {
        cur: tot.cur, prev: tot.prev, pct: _mcPct(tot.cur, tot.prev),
        proj: tot.cur * pace, avg: tot.hist / 3,
        projPct: _mcPct(tot.cur * pace, tot.hist / 3),
      },
      ups: list.filter((x) => x.isNew || (x.qtyPct != null && x.qtyPct >= 0.5)).length,
      downs: list.filter((x) => x.qtyPct != null && x.qtyPct <= -0.5).length,
    };
  }, [rows, win]);

  const sorted = useMemo(() => {
    if (!data) return [];
    const l = [...data.list];
    // Altas/quedas ordenadas pelo impacto em R$ (variação de custo), não só pelo %.
    const diff = (x) => x.curCost - x.prevCost;
    if (sort === "up") return l.filter((x) => diff(x) > 0).sort((a, b) => diff(b) - diff(a));
    if (sort === "down") return l.filter((x) => diff(x) < 0).sort((a, b) => diff(a) - diff(b));
    return l.filter((x) => x.curCost > 0).sort((a, b) => b.curCost - a.curCost);
  }, [data, sort]);
  const LIMIT = 10;
  const visible = showAll ? sorted : sorted.slice(0, LIMIT);

  const curLabel = win ? `01–${String(win.d).padStart(2, "0")} de ${_MC_MONTHS[win.m]}` : "";
  const prevLabel = win ? `01–${String(win.prevEnd.getDate()).padStart(2, "0")} de ${_MC_MONTHS[win.prevStart.getMonth()]}` : "";

  const segBtn = (id, label) => (
    <button type="button" key={id} onClick={() => { setSort(id); setShowAll(false); }} style={{
      padding: "4px 10px", borderRadius: 999, fontSize: 11.5, cursor: "pointer", flexShrink: 0,
      border: `1px solid ${sort === id ? "var(--accent-line)" : "var(--line)"}`,
      background: sort === id ? "var(--accent-soft)" : "transparent",
      color: sort === id ? "var(--fg-0)" : "var(--fg-2)",
    }}>{label}</button>
  );

  const stat = (label, value, extra) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</div>
      <div className="mono" style={{ fontSize: compact ? 14 : 16, fontWeight: 700, color: "var(--fg-0)", marginTop: 3, whiteSpace: "nowrap" }}>{value}</div>
      {extra && <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>{extra}</div>}
    </div>
  );

  const priceTxt = (it) => it.pricePct == null || Math.abs(it.pricePct) < 0.5 ? null
    : `preço ${it.pricePct > 0 ? "+" : "−"}${Math.abs(it.pricePct).toFixed(0)}%`;

  const COLS = "minmax(0,1fr) 120px 120px 90px 170px";

  return (
    <div className="card">
      <div className="card-header" style={{ flexWrap: "wrap", gap: 10 }}>
        <div>
          <h3 className="card-title">Consumo do mês</h3>
          <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
            {curLabel} vs {prevLabel} · até o mesmo horário
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, overflowX: "auto", maxWidth: "100%" }}>
          {segBtn("cost", "Maior custo")}
          {segBtn("up", "Maiores altas")}
          {segBtn("down", "Maiores quedas")}
        </div>
      </div>

      {loading ? (
        <div className="card-body"><div className="skel" style={{ height: 220, width: "100%" }} /></div>
      ) : !dbStatus.isOnline || !data ? (
        <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>DB offline</div>
      ) : (
        <>
          {/* Resumo */}
          <div style={{
            display: "grid", gridTemplateColumns: compact ? "1fr 1fr" : "repeat(4, 1fr)", gap: compact ? 12 : 16,
            padding: compact ? "12px 14px" : "14px 16px", borderBottom: "1px solid var(--line-soft)",
          }}>
            {stat("Consumido no mês", _mcBRL(data.total.cur),
              <><_McDelta pct={data.total.pct} size={11} /><span>vs {_mcBRL(data.total.prev)}</span></>)}
            {stat("Projeção do mês", _mcBRL(data.total.proj),
              <span>ritmo de {win.elapsedDays.toFixed(1).replace(".", ",")} de {win.daysInMonth} dias</span>)}
            {stat("Média 3 meses", _mcBRL(data.total.avg),
              <><span>projeção</span><_McDelta pct={data.total.projPct} size={11} /></>)}
            {stat("Itens", `${data.ups} ▲ · ${data.downs} ▼`,
              <span>subiram · caíram em consumo</span>)}
          </div>

          {/* Cabeçalho da tabela (desktop) */}
          {!compact && (
            <div style={{
              display: "grid", gridTemplateColumns: COLS, gap: 12,
              padding: "8px 16px", fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)",
              letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: "1px solid var(--line-soft)",
            }}>
              <span>Item</span>
              <span style={{ textAlign: "right" }}>Este mês</span>
              <span style={{ textAlign: "right" }}>Mês anterior</span>
              <span style={{ textAlign: "right" }}>Consumo</span>
              <span style={{ textAlign: "right" }}>Projeção · média 3m</span>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column" }}>
            {visible.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>
                {sort === "up" ? "Nenhum item com consumo maior que no mês anterior"
                  : sort === "down" ? "Nenhum item com consumo menor que no mês anterior"
                  : "Sem consumo registrado no mês"}
              </div>
            ) : visible.map((it, i) => {
              const border = i < visible.length - 1 ? "1px solid var(--line-soft)" : "none";
              const price = priceTxt(it);
              const projVsAvg = _mcPct(it.projQty, it.avgQty);
              if (compact) {
                return (
                  <div key={it.id} style={{ padding: "10px 14px", borderBottom: border, display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                      <span style={{ minWidth: 0, fontSize: 12, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name || "—"}</span>
                      <_McDelta pct={it.qtyPct} isNew={it.isNew} />
                    </div>
                    <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)", display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span>{_mcQty(it.curQty, it.unit)} · {_mcBRL(it.curCost)}</span>
                      <span style={{ color: "var(--fg-3)" }}>ant. {_mcQty(it.prevQty, it.unit)}</span>
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                      proj. {_mcQty(it.projQty, it.unit)} · média {_mcQty(it.avgQty, it.unit)}{price ? ` · ${price}` : ""}
                    </div>
                  </div>
                );
              }
              return (
                <div key={it.id} style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, alignItems: "center", padding: "9px 16px", borderBottom: border }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name || "—"}</div>
                    <div style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 2 }}>
                      {it.share.toFixed(1).replace(".", ",")}% do consumo do mês{price ? ` · ${price}` : ""}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-0)" }}>{_mcBRL(it.curCost)}</div>
                    <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>{_mcQty(it.curQty, it.unit)}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{_mcBRL(it.prevCost)}</div>
                    <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{_mcQty(it.prevQty, it.unit)}</div>
                  </div>
                  <div style={{ textAlign: "right" }}><_McDelta pct={it.qtyPct} isNew={it.isNew} /></div>
                  <div style={{ textAlign: "right" }}>
                    <div className="mono" style={{ fontSize: 11, color: "var(--fg-1)" }}>{_mcQty(it.projQty, it.unit)}</div>
                    <div style={{ fontSize: 10.5, color: "var(--fg-3)", display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <span className="mono">média {_mcQty(it.avgQty, it.unit)}</span>
                      {projVsAvg != null && <_McDelta pct={projVsAvg} size={10} />}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {sorted.length > LIMIT && (
            <button type="button" className="btn" data-variant="ghost" data-size="sm"
              style={{ margin: "6px auto 10px", display: "flex" }}
              onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Mostrar menos" : `Ver todos (${sorted.length})`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function StockByCategoryCard({ stock = [], onClick, compact = false }) {
  const data = useMemo(() => {
    const byCat = {};
    let totalValue = 0;
    for (const it of stock) {
      // Saldo negativo conta como 0 — não deve abater o valor da categoria.
      const v = Math.max(0, Number(it.qty) || 0) * (Number(it.cost) || 0);
      const k = it.cat || "Sem categoria";
      byCat[k] = (byCat[k] || 0) + v;
      totalValue += v;
    }
    const arr = Object.entries(byCat).map(([cat, val]) => ({ cat, val })).sort((a, b) => b.val - a.val);
    return { arr, totalValue, totalItems: stock.length };
  }, [stock]);

  const top10 = data.arr.slice(0, 10);
  const max = top10[0]?.val || 1;
  const palette = ["var(--ok)", "var(--crit)", "var(--fg-3)", "var(--accent-bright)", "var(--warn)", "var(--info)", "#a78bfa", "#f472b6", "#34d399", "#fbbf24"];

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
            <span className="mono" style={{ fontSize: compact ? 26 : 38, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.025em", lineHeight: 1 }}>
              {intPart}
            </span>
            <span className="mono" style={{ fontSize: 18, color: "var(--fg-2)" }}>,{decPart}</span>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="h-eyebrow" style={{ marginBottom: 4 }}>Produtos cadastrados</div>
          <div className="mono" style={{ fontSize: compact ? 20 : 28, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.02em" }}>
            {data.totalItems}
          </div>
        </div>
      </div>

      <div style={{ padding: "14px 16px 6px", display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--fg-2)" }}>
        <I.ArrowUp size={11} style={{ color: "var(--ok)" }} />
        Valor em estoque por categoria (Top 10)
      </div>

      {compact ? (
        // Celular: barras horizontais — 10 colunas com R$ por extenso não cabem em 360px.
        <div style={{ padding: "6px 16px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          {top10.length === 0 ? (
            <div style={{ textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>Sem itens cadastrados.</div>
          ) : top10.map((g, i) => (
            <div key={g.cat} style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11.5 }}>
                <span style={{ color: "var(--fg-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.cat}</span>
                <span className="mono" style={{ color: "var(--fg-1)", whiteSpace: "nowrap" }}>{fmtBRL(g.val)}</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: "var(--bg-3, var(--line))" }}>
                <div style={{ width: `${max > 0 ? Math.max(2, (g.val / max) * 100) : 2}%`, height: "100%", borderRadius: 3, background: palette[i % palette.length] }} />
              </div>
            </div>
          ))}
        </div>
      ) : (
      <div style={{ padding: "8px 16px 18px", display: "grid", gridTemplateColumns: `repeat(${Math.max(top10.length, 1)}, 1fr)`, gap: 10, alignItems: "end", minHeight: 200 }}>
        {top10.length === 0 ? (
          <div style={{ textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>Sem itens cadastrados.</div>
        ) : top10.map((g, i) => {
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
      )}
    </div>
  );
}

function PeriodPicker({ value, onChange, label }) {
  const [open, setOpen] = useState(false);
  const opts = [
    { id: "1d",        label: "Hoje" },
    { id: "yesterday", label: "Ontem" },
    { id: "7d",        label: "Últimos 7 dias" },
    { id: "30d",       label: "Últimos 30 dias" },
    { id: "mtd",       label: "Mês atual" },
    { id: "lastmonth", label: "Mês passado" },
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


// FlowKpi · card minimalista com rótulo e valor total em R$ (sem delta nem sparkline)
function FlowKpi({ label, value, tone, sub, onClick, loading }) {
  const color = tone === "in" ? "var(--ok)" : tone === "out" ? "var(--crit)" : "var(--fg-0)";
  const fmt = Number(value || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <div className="kpi"
         onClick={loading ? undefined : onClick}
         role={onClick && !loading ? "button" : undefined}
         tabIndex={onClick && !loading ? 0 : undefined}
         onKeyDown={onClick && !loading ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
         style={onClick && !loading ? { cursor: "pointer" } : undefined}
         title={onClick && !loading ? "Ver histórico do período" : undefined}>
      <div className="label">{label}</div>
      {loading ? (
        <div className="skel" style={{ height: 30, width: "60%", marginTop: 4 }} />
      ) : (
        <div className="value" style={{ color }}>R$ {fmt}</div>
      )}
      {sub && <div className="sub" style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

// TimeKpi · card de tempo (mm ss) para os tempos gerais de delivery.
// `color` espelha a cor da camada no gráfico de tempos da Logística.
function TimeKpi({ label, seconds, sub, color, loading, onClick }) {
  return (
    <div className="kpi"
         onClick={loading ? undefined : onClick}
         role={onClick && !loading ? "button" : undefined}
         tabIndex={onClick && !loading ? 0 : undefined}
         onKeyDown={onClick && !loading ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
         style={onClick && !loading ? { cursor: "pointer" } : undefined}
         title={onClick && !loading ? "Ver tempo por operação e turno" : undefined}>
      <div className="label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {color && <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />}
        {label}
      </div>
      {loading ? (
        <div className="skel" style={{ height: 30, width: "55%", marginTop: 4 }} />
      ) : (
        <div className="value" style={color ? { color } : undefined}>{_fmtDeliverDur(seconds)}</div>
      )}
      {sub && <div className="sub" style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

window.Dashboard               = Dashboard;
window.KpiCard                 = KpiCard;
window.FlowKpi                 = FlowKpi;
window.ModuleKpi               = ModuleKpi;
window.StockFlowDetailModal    = StockFlowDetailModal;
window.computeDashboardMetrics = computeDashboardMetrics;
// Expostos p/ a versão mobile (MobileDashboard) — mesma lógica de negócio, layout próprio.
window.computeKpi              = computeKpi;
window.dashPeriodRange         = dashPeriodRange;
window.dashRangeYMD            = _dashRangeYMD;
window.computeComprasMes       = computeComprasMes;
window.fmtDeliverDur           = _fmtDeliverDur;
window.CmvByOpCard             = CmvByOpCard;
window.RankingCard             = RankingCard;
window.RevenueMonthlyCard      = RevenueMonthlyCard;
window.MonthlyConsumptionCard  = MonthlyConsumptionCard;
window.StockByCategoryCard     = StockByCategoryCard;
