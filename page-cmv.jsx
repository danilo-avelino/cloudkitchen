// CMV & margem — real-only.
// CMV = Σ(saídas de estoque kind=out × custo unitário, ignorando insumos com compose_cmv=false)
//     + Σ(ajustes de inventário no período × custo unitário, sinal -delta) → custo compartilhado
//     ÷ Σ(faturamento de revenue_entries no período)
// Agrupado por (data, operação) para alimentar heatmap e tabela por operação.
// Ajustes de inventário não têm operação, então entram só nos totais/byOp (rateio por
// faturamento), nunca no heatmap diário — daily detail = consumo puro.
//
// Faixas de cor (absoluto):
//   < 30%  → Azul céu (ótimo)
//   < 35%  → Verde     (saudável)
//   < 40%  → Amarelo   (alerta)
//   ≥ 40%  → Vermelho  (crítico)

const CMV_SKY      = "#38bdf8";
const CMV_SKY_SOFT = "rgba(56,189,248,0.14)";
const CMV_SKY_LINE = "rgba(56,189,248,0.34)";

function cmvTone(pct) {
  if (pct < 30) return { fg: CMV_SKY,        bg: CMV_SKY_SOFT,        line: CMV_SKY_LINE,        label: "Ótimo"    };
  if (pct < 35) return { fg: "var(--ok)",    bg: "var(--accent-soft)", line: "var(--accent-line)", label: "Saudável" };
  if (pct < 40) return { fg: "var(--warn)",  bg: "var(--warn-soft)",   line: "var(--warn-line)",   label: "Alerta"   };
  return        { fg: "var(--crit)",  bg: "var(--crit-soft)",   line: "var(--crit-line)",   label: "Crítico"  };
}

function cmvCellBg(pct) {
  if (pct < 30) return "rgba(56,189,248,0.5)";
  if (pct < 35) return "rgba(45,140,102,0.55)";
  if (pct < 40) return "rgba(194,132,58,0.55)";
  return "rgba(176,69,69,0.7)";
}

const _fmtBRLc  = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _fmtBRLci = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const _ymd = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

// Data local de SP (YYYY-MM-DD) a partir de um timestamp ISO. stock_movements.performed_at
// é timestamptz; sem converter pro fuso de SP, movimentos da noite (ex.: 31/05 22h SP =
// 01/06 01h UTC) caíam no dia seguinte e divergiam do "Resultado por operação" (que usa
// limites de busca em horário de SP). Alinha a atribuição de dia ao mesmo fuso.
const _spDay = (iso) => iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }) : "";

// Calcula intervalo [fromDate, toDate] em YYYY-MM-DD a partir do period.
function getDateRange(period) {
  const now = new Date();
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const toDate = _ymd(startOfToday);
  let fromDate = toDate;
  if (period === "yesterday") {
    const y = new Date(startOfToday); y.setDate(y.getDate() - 1);
    fromDate = _ymd(y);
  } else if (period === "7d") {
    const c = new Date(startOfToday); c.setDate(c.getDate() - 6);
    fromDate = _ymd(c);
  } else if (period === "30d") {
    const c = new Date(startOfToday); c.setDate(c.getDate() - 29);
    fromDate = _ymd(c);
  } else if (period === "mtd") {
    const c = new Date(startOfToday); c.setDate(1);
    fromDate = _ymd(c);
  }
  return { fromDate, toDate };
}

// Agrega revenue_entries (rev/day/op) + stock_movements (cogs/day/op)
// em rows { date, op, revenue, cogs } prontos para o heatmap/tabela.
// `sharedSplits` = { [requestId]: [{ slug, pct }] }: para movimentos de uma requisição
// "Uso compartilhado", o custo é rateado entre as operações pelos pcts (em vez de cair
// inteiro na operação primária do movimento). Sem tocar no estoque.
function buildDailyRows(revenueEntries, movements, sharedSplits = {}) {
  const acc = {};
  const key = (d, op) => `${d}|${op}`;
  const addCogs = (d, op, cost) => {
    if (!d || !op || op === "—" || !cost) return;
    const k = key(d, op);
    if (!acc[k]) acc[k] = { date: d, op, revenue: 0, cogs: 0 };
    acc[k].cogs += cost;
  };
  for (const re of revenueEntries) {
    const d = String(re.date || "").slice(0, 10);
    const op = re.op;
    if (!d || !op) continue;
    const k = key(d, op);
    if (!acc[k]) acc[k] = { date: d, op, revenue: 0, cogs: 0 };
    acc[k].revenue += Number(re.revenue) || 0;
  }
  for (const mv of movements) {
    // CMV inclui consumo (out) e desperdício com operação setada (loss/expiration).
    // Desperdício compartilhado (sem op) é tratado fora, rateado pelo faturamento.
    if (mv.kind !== "out" && mv.kind !== "loss" && mv.kind !== "expiration") continue;
    if (mv.composeCmv === false) continue; // respeita flag "não compõe CMV"
    const d = _spDay(mv.at);
    if (!d) continue;
    const cost = Math.abs(mv.delta || 0) * (mv.unitCost || 0);
    const splits = mv.referenceId ? sharedSplits[mv.referenceId] : null;
    if (splits && splits.length > 0) {
      const totalPct = splits.reduce((s, x) => s + (x.pct || 0), 0) || 1;
      for (const sp of splits) addCogs(d, sp.slug, cost * ((sp.pct || 0) / totalPct));
    } else {
      addCogs(d, mv.op, cost);
    }
  }
  return Object.values(acc).sort((a, b) => a.date.localeCompare(b.date));
}

// Calcula impacto total dos insumos excluídos do CMV no período (apenas para
// exibir no badge "X itens excluídos · R$ Y/período não computado").
function excludedImpact(movements, fromDate, toDate) {
  const set = new Set();
  let total = 0;
  for (const mv of movements) {
    const isCogsKind = mv.kind === "out" || mv.kind === "loss" || mv.kind === "expiration";
    if (!isCogsKind || mv.composeCmv !== false) continue;
    const d = _spDay(mv.at);
    if (d < fromDate || d > toDate) continue;
    if (mv.itemId) set.add(mv.itemId);
    total += Math.abs(mv.delta || 0) * (mv.unitCost || 0);
  }
  return { count: set.size, total };
}

// Consolida consumo por item (out/loss/expiration que compõem CMV) no período,
// opcionalmente filtrado por operação (slug). Retorna itens ordenados por custo desc,
// com qty e custo total acumulados. Base da aba "Por item".
function buildItemRows(movements, opFilter) {
  const acc = {};
  for (const mv of movements) {
    if (mv.kind !== "out" && mv.kind !== "loss" && mv.kind !== "expiration") continue;
    if (mv.composeCmv === false) continue;
    if (opFilter && opFilter !== "all" && mv.op !== opFilter) continue;
    const id = mv.itemId || mv.item;
    if (!acc[id]) acc[id] = { id, name: mv.item, unit: mv.unit, category: mv.categoryName, qty: 0, cost: 0 };
    acc[id].qty  += Math.abs(Number(mv.delta) || 0);
    acc[id].cost += Math.abs(Number(mv.delta) || 0) * (Number(mv.unitCost) || 0);
  }
  return Object.values(acc).sort((a, b) => b.cost - a.cost);
}

function CMV({ setPage }) {
  const [view, setView] = useState("consolidado"); // consolidado | items
  const [opFilter, setOpFilter] = useState("all");  // all | <operation slug>
  const [period, setPeriod] = useState("mtd"); // mtd | today | yesterday | 7d | 30d
  const dbStatus = useDbStatus?.() || { isOnline: false, state: "offline" };
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState("loading");
  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [revenueEntries, setRevenueEntries] = useState([]);
  const [movements, setMovements] = useState([]);
  const [topConsumed, setTopConsumed] = useState([]);

  // Heatmap fixo · últimos 7 dias (independe do filtro de período de KPI).
  const [heatRevenue, setHeatRevenue] = useState([]);
  const [heatMovements, setHeatMovements] = useState([]);

  // Splits de rateio das requisições "Uso compartilhado" → { [requestId]: [{op, pct}] }
  const [sharedSplits, setSharedSplits] = useState({});

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setSource("offline"); setPageLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const ctx = await dbGetCurrentContext?.();
      const tid = ctx?.tenant?.id;
      if (cancelled || !tid) { setSource("offline"); setLoading(false); setPageLoading(false); return; }
      setTenantId(tid);

      const { fromDate, toDate } = getDateRange(period);
      // stock_movements.performed_at é timestamp; revenue_entries.business_date é DATE.
      const fromIso = new Date(fromDate + "T00:00:00").toISOString();
      const toEnd   = new Date(toDate   + "T23:59:59.999").toISOString();

      // Janela fixa do heatmap (sempre 7 dias)
      const heat7 = getDateRange("7d");
      const heatFromIso = new Date(heat7.fromDate + "T00:00:00").toISOString();
      const heatToIso   = new Date(heat7.toDate   + "T23:59:59.999").toISOString();

      const [revRes, movRes, consRes, heatRevRes, heatMovRes] = await Promise.all([
        dbListRevenueEntries?.(tid, fromDate, toDate) || { data: [] },
        dbListStockMovements?.(tid, fromIso, toEnd, { limit: 10000 }) || { data: [] },
        dbTopConsumedItems?.(tid, fromIso, toEnd, 10) || { data: [] },
        (period === "7d"
          ? Promise.resolve({ data: null })
          : dbListRevenueEntries?.(tid, heat7.fromDate, heat7.toDate) || { data: [] }),
        (period === "7d"
          ? Promise.resolve({ data: null })
          : dbListStockMovements?.(tid, heatFromIso, heatToIso, { limit: 10000 }) || { data: [] }),
      ]);
      if (cancelled) return;
      const movsData = movRes.data || [];
      const heatMovsData = heatMovRes.data ?? movsData;

      // Splits das requisições compartilhadas que aparecem nos movimentos (KPI + heatmap).
      const reqIds = [...movsData, ...heatMovsData]
        .filter((m) => m.referenceType === "kitchen_request" && m.referenceId)
        .map((m) => m.referenceId);
      const splitsRes = await dbListSharedSplits?.(tid, reqIds) || { data: {} };
      if (cancelled) return;

      setSource("db");
      setRevenueEntries(revRes.data || []);
      setMovements(movsData);
      setTopConsumed(consRes.data || []);
      setHeatRevenue(heatRevRes.data ?? revRes.data ?? []);
      setHeatMovements(heatMovsData);
      setSharedSplits(splitsRes.data || {});
      setLoading(false);
      setPageLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline, period]);

  // Resolve splits (op uuid → slug/name/color) usando as operações carregadas no MOCK.
  const sharedSplitsResolved = useMemo(() => {
    const out = {};
    for (const [reqId, splits] of Object.entries(sharedSplits)) {
      out[reqId] = splits.map((s) => {
        const op = MOCK.opById(s.op);
        return { slug: op?.slug || s.op, name: op?.name || "—", color: op?.color || "var(--fg-3)", pct: s.pct };
      });
    }
    return out;
  }, [sharedSplits]);

  const daily = useMemo(
    () => buildDailyRows(revenueEntries, movements, sharedSplitsResolved),
    [revenueEntries, movements, sharedSplitsResolved],
  );

  // Custo líquido dos ajustes de inventário no período (perdas − sobras).
  // delta<0 (falta) aumenta CMV; delta>0 (sobra) reduz CMV. Respeita compose_cmv.
  const adjustNetCost = useMemo(() => {
    let net = 0;
    for (const mv of movements) {
      if (mv.kind !== "adjust") continue;
      if (mv.composeCmv === false) continue;
      net += -Number(mv.delta || 0) * Number(mv.unitCost || 0);
    }
    return net;
  }, [movements]);

  // Desperdício compartilhado (loss/expiration sem operação) — rateado por faturamento.
  // Desperdícios atribuídos a uma operação já entram em daily.cogs via buildDailyRows.
  const wasteSharedCost = useMemo(() => {
    let total = 0;
    for (const mv of movements) {
      if (mv.kind !== "loss" && mv.kind !== "expiration") continue;
      if (mv.composeCmv === false) continue;
      if (mv.op && mv.op !== "—") continue; // só os sem operação
      total += Math.abs(Number(mv.delta) || 0) * Number(mv.unitCost || 0);
    }
    return total;
  }, [movements]);

  // CMV compartilhado por operação · no período de KPI. Combina, por operação:
  //  1) Uso compartilhado (kitchen_requests) — rateado pelos splits (pct).
  //  2) Ajustes de inventário (perdas − sobras) + desperdício sem operação — rateados
  //     por faturamento, igual ao "Resultado por operação" (byOp.cogsAdjust).
  const sharedCmv = useMemo(() => {
    const byOpMap = {};
    const ensure = (slug, name, color) => {
      if (!byOpMap[slug]) {
        const op = MOCK.opById(slug);
        byOpMap[slug] = { slug, name: name || op?.name || "—", color: color || op?.color || "var(--fg-3)", cost: 0 };
      }
      return byOpMap[slug];
    };

    // 1) Uso compartilhado — rateado pelos splits
    let splitsTotal = 0;
    for (const mv of movements) {
      if (mv.kind !== "out" && mv.kind !== "loss" && mv.kind !== "expiration") continue;
      if (mv.composeCmv === false) continue;
      const splits = mv.referenceId ? sharedSplitsResolved[mv.referenceId] : null;
      if (!splits || splits.length === 0) continue;
      const cost = Math.abs(Number(mv.delta) || 0) * (Number(mv.unitCost) || 0);
      if (!cost) continue;
      splitsTotal += cost;
      const totalPct = splits.reduce((s, x) => s + (x.pct || 0), 0) || 1;
      for (const sp of splits) ensure(sp.slug, sp.name, sp.color).cost += cost * ((sp.pct || 0) / totalPct);
    }

    // 2) Ajustes de inventário + desperdício compartilhado — rateados por faturamento
    const sharedRevCost = adjustNetCost + wasteSharedCost;
    const revByOp = {};
    let totalRev = 0;
    for (const r of daily) { revByOp[r.op] = (revByOp[r.op] || 0) + r.revenue; totalRev += r.revenue; }
    if (totalRev > 0 && sharedRevCost !== 0) {
      for (const [slug, rev] of Object.entries(revByOp)) {
        if (rev <= 0) continue;
        ensure(slug).cost += sharedRevCost * (rev / totalRev);
      }
    }

    const total = splitsTotal + sharedRevCost;
    const rows = Object.values(byOpMap)
      .filter((r) => Math.abs(r.cost) > 0.005)
      .map((r) => ({ ...r, pct: total !== 0 ? (r.cost / total) * 100 : 0 }))
      .sort((a, b) => b.cost - a.cost);
    return { total, rows };
  }, [movements, sharedSplitsResolved, daily, adjustNetCost, wasteSharedCost]);

  // Totais consolidados do período (consumo + ajustes + desperdício como custo compartilhado)
  const totals = useMemo(() => {
    const rev         = daily.reduce((s, r) => s + r.revenue, 0);
    const cogsConsumo = daily.reduce((s, r) => s + r.cogs, 0);
    const cogs        = cogsConsumo + adjustNetCost + wasteSharedCost;
    return {
      revenue: rev,
      cogs,
      cogsConsumo,
      cogsAdjust: adjustNetCost,
      cogsWasteShared: wasteSharedCost,
      cmv:    rev > 0 ? (cogs / rev) * 100 : 0,
      margin: rev > 0 ? ((rev - cogs) / rev) * 100 : 0,
      days:   new Set(daily.map((r) => r.date)).size,
      opsCount: new Set(daily.map((r) => r.op)).size,
    };
  }, [daily, adjustNetCost, wasteSharedCost]);

  const excluded = useMemo(() => {
    const { fromDate, toDate } = getDateRange(period);
    return excludedImpact(movements, fromDate, toDate);
  }, [movements, period]);

  // Por operação — ajustes rateados proporcionalmente ao faturamento (custo compartilhado)
  const byOp = useMemo(() => {
    const m = {};
    daily.forEach((r) => {
      if (!m[r.op]) m[r.op] = { op: r.op, revenue: 0, cogs: 0, cogsAdjust: 0 };
      m[r.op].revenue += r.revenue;
      m[r.op].cogs    += r.cogs;
    });
    const totalRev = Object.values(m).reduce((s, r) => s + r.revenue, 0);
    const sharedCost = adjustNetCost + wasteSharedCost;
    if (totalRev > 0 && sharedCost !== 0) {
      for (const r of Object.values(m)) {
        const share = sharedCost * (r.revenue / totalRev);
        r.cogs       += share;
        r.cogsAdjust += share;
      }
    }
    return Object.values(m).map((o) => ({
      ...o,
      cmv:    o.revenue > 0 ? (o.cogs / o.revenue) * 100 : 0,
      margin: o.revenue > 0 ? ((o.revenue - o.cogs) / o.revenue) * 100 : 0,
    })).sort((a, b) => b.cmv - a.cmv);
  }, [daily, adjustNetCost, wasteSharedCost]);

  // Operações disponíveis no período (derivadas dos movimentos) — alimentam o filtro da aba "Por item".
  const availableOps = useMemo(() => {
    const seen = new Map();
    for (const mv of movements) {
      if (!mv.operationId || mv.op === "—") continue;
      if (!seen.has(mv.op)) seen.set(mv.op, { slug: mv.op, name: mv.operationName, color: mv.operationColor });
    }
    return [...seen.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [movements]);

  // Consolidado de consumo por item, filtrado pela operação selecionada.
  const itemRows = useMemo(() => buildItemRows(movements, opFilter), [movements, opFilter]);
  const itemTotalCost = useMemo(() => itemRows.reduce((s, r) => s + r.cost, 0), [itemRows]);

  // CMV % do escopo filtrado (operação) — reusa totais/por operação já computados.
  const itemScope = useMemo(() => {
    if (opFilter === "all") {
      return { cmv: totals.cmv, revenue: totals.revenue, cogs: totals.cogsConsumo, hasData: totals.revenue > 0 || totals.cogsConsumo > 0 };
    }
    const o = byOp.find((x) => x.op === opFilter);
    const cogsConsumo = itemRows.reduce((s, r) => s + r.cost, 0);
    if (!o) return { cmv: 0, revenue: 0, cogs: cogsConsumo, hasData: cogsConsumo > 0 };
    return { cmv: o.revenue > 0 ? (cogsConsumo / o.revenue) * 100 : 0, revenue: o.revenue, cogs: cogsConsumo, hasData: o.revenue > 0 || cogsConsumo > 0 };
  }, [opFilter, totals, byOp, itemRows]);

  // Reseta o filtro de operação se ela some do período (ex.: troca de período).
  useEffect(() => {
    if (opFilter !== "all" && !availableOps.some((o) => o.slug === opFilter)) setOpFilter("all");
  }, [availableOps, opFilter]);

  // Heatmap · sempre últimos 7 dias, operações derivadas dos dados
  const heat = useMemo(() => {
    const rows7 = buildDailyRows(heatRevenue, heatMovements, sharedSplitsResolved);
    const dates = [...new Set(rows7.map((r) => r.date))].sort();
    const ops   = [...new Set(rows7.map((r) => r.op))];
    const dayLabel = (iso) => {
      const d = new Date(iso + "T12:00:00");
      const names = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
      return `${names[d.getDay()]} ${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}`;
    };
    const rows = ops.map((op) => {
      const values = dates.map((d) => {
        const r = rows7.find((x) => x.date === d && x.op === op);
        if (!r || r.revenue === 0) return null;
        return (r.cogs / r.revenue) * 100;
      });
      return { op, values };
    });
    return { days: dates.map(dayLabel), rows };
  }, [heatRevenue, heatMovements, sharedSplitsResolved]);

  const periodLabel = {
    mtd: "mês atual até hoje",
    today: "hoje",
    yesterday: "ontem",
    "7d": "últimos 7 dias",
    "30d": "últimos 30 dias",
  }[period];

  const headerTone = cmvTone(totals.cmv);
  const hasData = totals.revenue > 0 || totals.cogs > 0;

  if (pageLoading) return <PageLoading label="Carregando CMV & margem…" variant="dashboard" />;

  return (
    <div style={{ padding: "20px 28px 32px", display: "flex", flexDirection: "column", gap: 20, overflow: "auto", height: "100%" }} className="stagger">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="h-eyebrow" style={{ marginBottom: 6, color: hasData ? headerTone.fg : "var(--fg-3)" }}>
            {hasData
              ? <>CMV consolidado · <span style={{ fontWeight: 500 }}>{totals.cmv.toFixed(1)}%</span> · {headerTone.label.toLowerCase()}</>
              : "Sem dados no período"}
          </div>
          <h1 className="h-title">CMV &amp; margem</h1>
          <p className="h-sub">
            Calculado a partir das <strong style={{ color: "var(--fg-1)" }}>saídas de estoque</strong> (consumo × custo)
            e do <strong style={{ color: "var(--fg-1)" }}>faturamento</strong> de cada operação · {periodLabel}.
          </p>
          {excluded.count > 0 && (
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              marginTop: 8, padding: "4px 10px",
              background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 99,
              fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-2)",
              letterSpacing: "0.04em",
            }} title="Configurado em Estoque · botão CMV de cada insumo">
              <span style={{ width: 6, height: 6, borderRadius: 50, background: "var(--fg-3)" }} />
              {excluded.count} {excluded.count === 1 ? "item excluído" : "itens excluídos"} do CMV
              <span style={{ color: "var(--fg-3)" }}>·</span>
              <span>{_fmtBRLci(excluded.total)} não computado no período</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <CmvPeriodTabs value={period} onChange={setPeriod} />
          {loading && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase",
              padding: "3px 9px", borderRadius: 99,
              color: "var(--accent-bright)", background: "var(--accent-soft)",
              border: "1px solid var(--accent-line)", whiteSpace: "nowrap",
            }} title="Buscando dados do período selecionado">
              <span aria-hidden="true" style={{
                width: 10, height: 10, borderRadius: "50%",
                border: "1.5px solid var(--line-strong)", borderTopColor: "var(--accent-bright)",
                animation: "pl-spin 0.9s linear infinite",
              }} />
              Atualizando…
            </span>
          )}
        </div>
      </div>

      {/* Conteúdo dependente do período · vira skeleton enquanto recarrega ao trocar o filtro */}
      {loading ? (
        <CmvLoadingSkeleton />
      ) : (
      <>

      {/* Alterna entre a visão consolidada e o consolidado por item */}
      <CmvViewTabs value={view} onChange={setView} />

      {view === "items" ? (
        <CmvItemsView
          rows={itemRows}
          totalCost={itemTotalCost}
          scope={itemScope}
          availableOps={availableOps}
          opFilter={opFilter}
          onOpFilter={setOpFilter}
          periodLabel={periodLabel}
          source={source}
        />
      ) : (
      <>
      {/* KPI consolidado */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        <CmvKpiCard
          label="CMV %"
          value={hasData ? `${totals.cmv.toFixed(1)}%` : "—"}
          sub={hasData ? headerTone.label : "sem dados"}
          tone={hasData ? headerTone : null}
          hero
        />
        <CmvKpiCard
          label="Faturamento"
          value={_fmtBRLci(totals.revenue)}
          sub={totals.days === 0 ? "sem dados" : `${totals.days} dia(s) · ${totals.opsCount} op.`}
        />
        <CmvKpiCard
          label="Custo (saídas estoque)"
          value={_fmtBRLci(totals.cogs)}
          sub="consumo × custo unitário"
        />
        <CmvKpiCard
          label="Margem de contribuição"
          value={hasData ? _fmtBRLci(totals.revenue - totals.cogs) : "—"}
          sub={hasData ? `${totals.margin.toFixed(1)}% sobre faturamento` : "sem dados"}
          tone={hasData ? headerTone : null}
          mode="margin"
        />
      </div>

      {/* Régua de faixas */}
      {hasData && <CmvScaleLegend pct={totals.cmv} />}

      {/* Heatmap */}
      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">CMV diário · operação × dia</h3>
            <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
              Cor por faixa absoluta de CMV (não pela meta) · últimos 7 dias
            </span>
          </div>
          <CmvLegendInline />
        </div>
        <div className="card-body" style={{ overflow: "auto" }}>
          {heat.rows.length === 0 ? (
            <div style={{ padding: "24px 0", textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>
              Sem movimentação ou faturamento nos últimos 7 dias.
            </div>
          ) : (
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                <th style={{ width: 160, padding: "8px 12px", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "left", fontWeight: 400 }}>Operação</th>
                {heat.days.map((d) => (
                  <th key={d} style={{ padding: "8px 4px", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", textAlign: "center", fontWeight: 400 }}>{d}</th>
                ))}
                <th style={{ padding: "8px 12px", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "right", fontWeight: 400 }}>Média</th>
              </tr>
            </thead>
            <tbody>
              {heat.rows.map((row) => {
                const op = MOCK.opById(row.op);
                const valid = row.values.filter((v) => v != null);
                const avg = valid.length > 0 ? valid.reduce((s, v) => s + v, 0) / valid.length : null;
                return (
                  <tr key={row.op}>
                    <td style={{ padding: "8px 12px", borderTop: "1px solid var(--line-soft)" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--fg-0)" }}>
                        <span style={{ width: 6, height: 6, borderRadius: 50, background: op?.color || "var(--fg-3)" }} />
                        {op?.name || row.op}
                      </span>
                    </td>
                    {row.values.map((v, i) => (
                      <td key={i} style={{ padding: 4, borderTop: "1px solid var(--line-soft)" }}>
                        {v == null ? (
                          <div style={{
                            background: "var(--bg-2)", border: "1px solid var(--line)",
                            padding: "10px 6px", textAlign: "center",
                            fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-3)",
                            borderRadius: 2,
                          }}>—</div>
                        ) : (
                          <div style={{
                            background: cmvCellBg(v),
                            border: "1px solid var(--line)",
                            padding: "10px 6px", textAlign: "center",
                            fontFamily: "var(--mono)", fontSize: 11.5,
                            color: "var(--fg-0)", fontWeight: 500,
                            borderRadius: 2, position: "relative",
                          }} title={`${v.toFixed(1)}%`}>
                            {v.toFixed(1)}
                          </div>
                        )}
                      </td>
                    ))}
                    <td className="mono" style={{
                      padding: "8px 12px", textAlign: "right",
                      color: avg == null ? "var(--fg-3)" : cmvTone(avg).fg,
                      fontSize: 12, fontWeight: 500,
                      borderTop: "1px solid var(--line-soft)",
                    }}>
                      {avg == null ? "—" : `${avg.toFixed(1)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          )}
        </div>
      </div>

      {/* Por operação · faturamento × custo × CMV × margem */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Resultado por operação</h3>
            <span className="card-sub">Faturamento, custo de saídas e margem · {periodLabel}</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Operação</th>
                <th className="num">Faturamento</th>
                <th className="num">Custo</th>
                <th className="num">CMV</th>
                <th>Faixa</th>
                <th className="num">Margem</th>
              </tr>
            </thead>
            <tbody>
              {byOp.length === 0 ? (
                <tr><td colSpan={6} className="dim" style={{ textAlign: "center", padding: 24 }}>Sem dados no período.</td></tr>
              ) : byOp.map((r) => {
                const op = MOCK.opById(r.op);
                const tone = cmvTone(r.cmv);
                return (
                  <tr key={r.op}>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 6, height: 6, borderRadius: 50, background: op?.color || "var(--fg-3)" }} />
                        <span style={{ color: "var(--fg-0)", fontWeight: 500 }}>{op?.name || r.op}</span>
                      </span>
                    </td>
                    <td className="num">{_fmtBRLci(r.revenue)}</td>
                    <td className="num">{_fmtBRLci(r.cogs)}</td>
                    <td className="num">
                      <span className="mono" style={{ color: tone.fg, fontWeight: 500 }}>{r.cmv.toFixed(1)}%</span>
                    </td>
                    <td>
                      <CmvBar pct={r.cmv} max={45} tone={tone} />
                    </td>
                    <td className="num" style={{ color: "var(--fg-1)" }}>{r.margin.toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <CmvSharedBox data={sharedCmv} periodLabel={periodLabel} source={source} />
        </div>

        {/* Top consumos · maior R$ saído do estoque */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Top consumos · {periodLabel}</h3>
            <span className="card-sub">Insumos com maior R$ saído do estoque</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {topConsumed.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>
                {source === "db" ? "Sem consumo no período" : (source === "loading" ? "Carregando…" : "DB offline")}
              </div>
            ) : topConsumed.map((c, i) => {
              const itemName = c.item || c.name;
              const itemQty = c.qty || c.totalQty;
              const itemCost = c.value || c.totalCost;
              const op = c.op ? MOCK.opById(c.op) : null;
              return (
                <div key={i} style={{
                  display: "grid", gridTemplateColumns: "1fr 100px",
                  gap: 10, alignItems: "center",
                  padding: "12px 16px",
                  borderBottom: i < topConsumed.length - 1 ? "1px solid var(--line-soft)" : "none",
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {itemName}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                      {op && <span style={{ width: 4, height: 4, borderRadius: 50, background: op.color }} />}
                      <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                        {op ? `${op.short} · ` : ""}{itemQty} {c.unit}
                      </span>
                    </div>
                  </div>
                  <span className="mono" style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500, textAlign: "right" }}>
                    {_fmtBRLc(itemCost)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      </>
      )}
      </>
      )}
    </div>
  );
}

// ===== Sub-components =====
// Skeleton do conteúdo enquanto recarrega ao trocar o período (mesmo padrão do dashboard:
// os dados somem e dão lugar a placeholders). O cabeçalho/filtros permanecem visíveis.
function CmvLoadingSkeleton() {
  const skel = (w, h, extra) => <div className="skel" style={{ width: w, height: h, ...(extra || {}) }} />;
  const card = (children) => (
    <div style={{ padding: 16, background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 6, display: "flex", flexDirection: "column", gap: 12 }}>
      {children}
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, animation: "fadeUp 200ms ease both" }}>
      {skel(180, 32, { borderRadius: 6 })}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="kpi" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            {skel(60, 9)}
            {skel(110, 24)}
            {skel(80, 9)}
          </div>
        ))}
      </div>
      {card(<>{skel(140, 12)}{skel("100%", 200, { borderRadius: 4 })}</>)}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {card(<>{skel(160, 12)}{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skel" style={{ width: "100%", height: 26, borderRadius: 4 }} />)}</>)}
          {card(<>{skel(140, 12)}{Array.from({ length: 3 }).map((_, i) => <div key={i} className="skel" style={{ width: "100%", height: 30, borderRadius: 4 }} />)}</>)}
        </div>
        {card(<>{skel(140, 12)}{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skel" style={{ width: "100%", height: 30, borderRadius: 4 }} />)}</>)}
      </div>
    </div>
  );
}

function CmvPeriodTabs({ value, onChange }) {
  const opts = [
    { id: "today",     label: "Hoje" },
    { id: "yesterday", label: "Ontem" },
    { id: "7d",        label: "7 dias" },
    { id: "30d",       label: "30 dias" },
    { id: "mtd",       label: "Mês atual" },
  ];
  return (
    <div style={{ display: "flex", padding: 2, background: "var(--bg-2)", borderRadius: 4, border: "1px solid var(--line)" }}>
      {opts.map((o) => {
        const active = o.id === value;
        return (
          <button key={o.id} onClick={() => onChange(o.id)} style={{
            padding: "5px 12px", fontSize: 12,
            background: active ? "var(--bg-3)" : "transparent",
            border: "none", borderRadius: 2, cursor: "pointer",
            color: active ? "var(--fg-0)" : "var(--fg-2)",
            fontWeight: active ? 500 : 400,
            letterSpacing: "-0.005em",
          }}>{o.label}</button>
        );
      })}
    </div>
  );
}

// Alterna entre a visão consolidada (heatmap + por operação) e o consolidado por item.
function CmvViewTabs({ value, onChange }) {
  const opts = [
    { id: "consolidado", label: "Consolidado" },
    { id: "items",       label: "Por item" },
  ];
  return (
    <div style={{ display: "inline-flex", padding: 2, background: "var(--bg-2)", borderRadius: 6, border: "1px solid var(--line)", alignSelf: "flex-start" }}>
      {opts.map((o) => {
        const active = o.id === value;
        return (
          <button key={o.id} onClick={() => onChange(o.id)} style={{
            padding: "6px 16px", fontSize: 12.5,
            background: active ? "var(--bg-3)" : "transparent",
            border: "none", borderRadius: 4, cursor: "pointer",
            color: active ? "var(--fg-0)" : "var(--fg-2)",
            fontWeight: active ? 500 : 400,
            letterSpacing: "-0.005em",
          }}>{o.label}</button>
        );
      })}
    </div>
  );
}

// Box "CMV compartilhado" · quanto cada operação paga do custo de uso compartilhado
// (rateado pelos splits) e sua participação %. Reflete o período de KPI selecionado.
function CmvSharedBox({ data, periodLabel, source }) {
  const rows = data.rows;
  const max = rows.length > 0 ? rows[0].cost : 0;
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">CMV compartilhado</h3>
          <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
            Uso compartilhado e ajustes de inventário rateados entre operações · {periodLabel}
          </span>
        </div>
        {data.total > 0 && (
          <span className="mono" style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }}>{_fmtBRLc(data.total)}</span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {rows.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>
            {source === "db" ? "Sem consumo compartilhado no período" : (source === "loading" ? "Carregando…" : "DB offline")}
          </div>
        ) : rows.map((r, i) => {
          const w = max > 0 ? (r.cost / max) * 100 : 0;
          return (
            <div key={r.slug} style={{ padding: "10px 16px", borderBottom: i < rows.length - 1 ? "1px solid var(--line-soft)" : "none" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 50, background: r.color, flexShrink: 0 }} />
                  <span style={{ color: "var(--fg-0)", fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                </span>
                <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, flexShrink: 0 }}>
                  <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500 }}>{_fmtBRLc(r.cost)}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", minWidth: 42, textAlign: "right" }}>{r.pct.toFixed(1)}%</span>
                </span>
              </div>
              <div style={{ position: "relative", height: 6, background: "var(--bg-3)", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${w}%`, background: r.color }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Aba "Por item" · consolidado de consumo por insumo no período, filtrável por operação.
// Mostra CMV do escopo, custo consumido e a tabela TOP 10 (% do total + valor R$).
function CmvItemsView({ rows, totalCost, scope, availableOps, opFilter, onOpFilter, periodLabel, source }) {
  const top  = rows.slice(0, 10);
  const rest = rows.slice(10);
  const restCost  = rest.reduce((s, r) => s + r.cost, 0);
  const tone = cmvTone(scope.cmv);
  const maxCost = top.length > 0 ? top[0].cost : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Filtro por operação */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginRight: 2 }}>
          Operação
        </span>
        <div style={{ display: "flex", padding: 2, background: "var(--bg-2)", borderRadius: 4, border: "1px solid var(--line)", flexWrap: "wrap" }}>
          {[{ slug: "all", name: "Todas", color: null }, ...availableOps].map((o) => {
            const active = o.slug === opFilter;
            return (
              <button key={o.slug} onClick={() => onOpFilter(o.slug)} style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "5px 12px", fontSize: 12,
                background: active ? "var(--bg-3)" : "transparent",
                border: "none", borderRadius: 2, cursor: "pointer",
                color: active ? "var(--fg-0)" : "var(--fg-2)",
                fontWeight: active ? 500 : 400,
              }}>
                {o.color && <span style={{ width: 6, height: 6, borderRadius: 50, background: o.color }} />}
                {o.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* KPIs do escopo filtrado */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        <CmvKpiCard
          label="CMV %"
          value={scope.hasData && scope.revenue > 0 ? `${scope.cmv.toFixed(1)}%` : "—"}
          sub={scope.revenue > 0 ? tone.label : "sem faturamento"}
          tone={scope.revenue > 0 ? tone : null}
          hero
        />
        <CmvKpiCard
          label="Custo consumido"
          value={_fmtBRLci(totalCost)}
          sub="saídas × custo unitário"
        />
        <CmvKpiCard
          label="Faturamento"
          value={scope.revenue > 0 ? _fmtBRLci(scope.revenue) : "—"}
          sub={opFilter === "all" ? "todas as operações" : "operação selecionada"}
        />
        <CmvKpiCard
          label="Itens consumidos"
          value={rows.length || "—"}
          sub={`distintos · ${periodLabel}`}
        />
      </div>

      {/* Tabela consolidada por item */}
      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Consolidado por item · TOP 10 mais consumidos</h3>
            <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
              Participação no custo total de consumo · {periodLabel}
            </span>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th>Item</th>
              <th className="num">Qtd.</th>
              <th className="num">Valor</th>
              <th className="num">% do total</th>
              <th style={{ width: 160 }}>Participação</th>
            </tr>
          </thead>
          <tbody>
            {top.length === 0 ? (
              <tr><td colSpan={6} className="dim" style={{ textAlign: "center", padding: 24 }}>
                {source === "db" ? "Sem consumo no período" : (source === "loading" ? "Carregando…" : "DB offline")}
              </td></tr>
            ) : top.map((r, i) => {
              const pct = totalCost > 0 ? (r.cost / totalCost) * 100 : 0;
              const w   = maxCost > 0 ? (r.cost / maxCost) * 100 : 0;
              return (
                <tr key={r.id}>
                  <td className="mono" style={{ color: "var(--fg-3)", fontSize: 11.5 }}>{i + 1}</td>
                  <td>
                    <div style={{ color: "var(--fg-0)", fontWeight: 500, fontSize: 12.5 }}>{r.name}</div>
                    {r.category && (
                      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase", marginTop: 2 }}>
                        {r.category}
                      </div>
                    )}
                  </td>
                  <td className="num mono" style={{ color: "var(--fg-1)", fontSize: 12 }}>
                    {(Number(r.qty) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} {r.unit}
                  </td>
                  <td className="num mono" style={{ color: "var(--fg-0)", fontWeight: 500 }}>{_fmtBRLc(r.cost)}</td>
                  <td className="num mono" style={{ color: "var(--fg-0)" }}>{pct.toFixed(1)}%</td>
                  <td>
                    <div style={{ position: "relative", height: 7, background: "var(--bg-3)", borderRadius: 4, overflow: "hidden", minWidth: 120 }}>
                      <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${w}%`, background: CMV_SKY }} />
                    </div>
                  </td>
                </tr>
              );
            })}
            {rest.length > 0 && (
              <tr>
                <td className="mono" style={{ color: "var(--fg-3)", fontSize: 11.5 }}>—</td>
                <td className="dim" style={{ fontSize: 12 }}>+ {rest.length} {rest.length === 1 ? "outro item" : "outros itens"}</td>
                <td />
                <td className="num mono dim">{_fmtBRLc(restCost)}</td>
                <td className="num mono dim">{totalCost > 0 ? ((restCost / totalCost) * 100).toFixed(1) : "0.0"}%</td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CmvKpiCard({ label, value, sub, tone, hero, mode }) {
  const valueColor = tone
    ? (mode === "margin" ? "var(--fg-0)" : tone.fg)
    : "var(--fg-0)";
  return (
    <div className="kpi" style={{
      padding: "14px 16px",
      ...(hero && tone ? {
        borderColor: tone.line,
        background: `linear-gradient(180deg, ${tone.bg}, transparent 60%)`,
      } : null),
    }}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 26, color: valueColor }}>{value}</div>
      {sub && (
        <div style={{
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)",
          letterSpacing: "0.04em", marginTop: 4,
        }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function CmvScaleLegend({ pct }) {
  const min = 22, max = 45;
  const clamp = Math.max(min, Math.min(max, pct));
  const left = ((clamp - min) / (max - min)) * 100;
  const seg = (a, b) => ((Math.min(b, max) - Math.max(a, min)) / (max - min)) * 100;
  const segments = [
    { from: min,  to: 30, color: CMV_SKY,       label: "<30%" },
    { from: 30,   to: 35, color: "var(--ok)",     label: "<35%" },
    { from: 35,   to: 40, color: "var(--warn)",   label: "<40%" },
    { from: 40,   to: max,color: "var(--crit)",   label: "≥40%" },
  ];

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Faixas de CMV
        </span>
        <span style={{ flex: 1 }} />
        {segments.map((s, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-2)", marginLeft: i === 0 ? 0 : 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 50, background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div style={{ position: "relative", height: 8, borderRadius: 4, overflow: "hidden", display: "flex" }}>
        {segments.map((s, i) => {
          const w = seg(s.from, s.to);
          return (
            <div key={i} style={{ width: `${w}%`, background: s.color, opacity: 0.8 }} />
          );
        })}
      </div>
      <div style={{ position: "relative", height: 18 }}>
        <div style={{
          position: "absolute", top: -2, left: `${left}%`, transform: "translateX(-50%)",
          width: 2, height: 14, background: "var(--fg-0)", borderRadius: 1,
        }} />
        <div style={{
          position: "absolute", top: 12, left: `${left}%`, transform: "translateX(-50%)",
          fontFamily: "var(--mono)", fontSize: 10, fontWeight: 500,
          color: cmvTone(pct).fg, whiteSpace: "nowrap",
        }}>
          {pct.toFixed(1)}%
        </div>
      </div>
    </div>
  );
}

function CmvLegendInline() {
  const items = [
    { color: CMV_SKY,     label: "<30" },
    { color: "var(--ok)",   label: "<35" },
    { color: "var(--warn)", label: "<40" },
    { color: "var(--crit)", label: "≥40" },
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {items.map((it, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em" }}>
          <span style={{ width: 8, height: 8, borderRadius: 50, background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

// Barra simples · proporção do CMV até `max` (default 45%).
function CmvBar({ pct, max, tone }) {
  const w = Math.min(100, (pct / max) * 100);
  return (
    <div title={`${pct.toFixed(1)}%`} style={{ minWidth: 140 }}>
      <div style={{ position: "relative", height: 7, background: "var(--bg-3)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{
          position: "absolute", left: 0, top: 0, height: "100%",
          width: `${w}%`, background: tone.fg,
        }} />
      </div>
    </div>
  );
}

window.CMV = CMV;
window.cmvTone = cmvTone;
