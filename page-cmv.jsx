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
function buildDailyRows(revenueEntries, movements) {
  const acc = {};
  const key = (d, op) => `${d}|${op}`;
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
    const op = mv.op;
    if (!d || !op || op === "—") continue;
    const k = key(d, op);
    if (!acc[k]) acc[k] = { date: d, op, revenue: 0, cogs: 0 };
    acc[k].cogs += Math.abs(mv.delta || 0) * (mv.unitCost || 0);
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

function CMV({ setPage }) {
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
      setSource("db");
      setRevenueEntries(revRes.data || []);
      setMovements(movRes.data || []);
      setTopConsumed(consRes.data || []);
      setHeatRevenue(heatRevRes.data ?? revRes.data ?? []);
      setHeatMovements(heatMovRes.data ?? movRes.data ?? []);
      setLoading(false);
      setPageLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline, period]);

  const daily = useMemo(
    () => buildDailyRows(revenueEntries, movements),
    [revenueEntries, movements],
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

  // Heatmap · sempre últimos 7 dias, operações derivadas dos dados
  const heat = useMemo(() => {
    const rows7 = buildDailyRows(heatRevenue, heatMovements);
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
  }, [heatRevenue, heatMovements]);

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
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase",
            padding: "2px 7px", borderRadius: 99,
            color: source === "db" ? "var(--ok)" : "var(--fg-3)",
            background: source === "db" ? "var(--accent-soft)" : "var(--bg-2)",
            border: `1px solid ${source === "db" ? "var(--accent-line)" : "var(--line)"}`,
          }} title={source === "db" ? "CMV calculado em tempo real do Supabase" : (source === "offline" ? "Sem conexão com o banco" : "Carregando…")}>
            <span style={{ width: 5, height: 5, borderRadius: 50, background: source === "db" ? "var(--ok)" : "var(--fg-3)" }} />
            {source === "db" ? "Supabase" : (source === "loading" ? "Carregando…" : "Offline")}
          </span>
        </div>
      </div>

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
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
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
    </div>
  );
}

// ===== Sub-components =====
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
