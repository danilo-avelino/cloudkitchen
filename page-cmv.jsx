// CMV & margem — versão real-only.
// CMV é calculado SOMENTE a partir de saídas de estoque (consumo × custo)
// e do faturamento do período. Não há mais CMV teórico (ficha técnica).
//
// Faixas de cor (por CMV % absoluto, sem comparar com meta):
//   < 30%  → Azul céu           (ótimo)
//   < 35%  → Verde              (saudável)
//   < 40%  → Amarelo · alerta   (atenção)
//   ≥ 40%  → Vermelho           (crítico)

// Paleta · Azul céu custom + reaproveitamento das vars existentes
const CMV_SKY      = "#38bdf8";
const CMV_SKY_SOFT = "rgba(56,189,248,0.14)";
const CMV_SKY_LINE = "rgba(56,189,248,0.34)";

function cmvTone(pct) {
  if (pct < 30) return {
    fg:    CMV_SKY,
    bg:    CMV_SKY_SOFT,
    line:  CMV_SKY_LINE,
    label: "Ótimo",
  };
  if (pct < 35) return {
    fg:    "var(--ok)",
    bg:    "var(--accent-soft)",
    line:  "var(--accent-line)",
    label: "Saudável",
  };
  if (pct < 40) return {
    fg:    "var(--warn)",
    bg:    "var(--warn-soft)",
    line:  "var(--warn-line)",
    label: "Alerta",
  };
  return {
    fg:    "var(--crit)",
    bg:    "var(--crit-soft)",
    line:  "var(--crit-line)",
    label: "Crítico",
  };
}

// Heatmap usa células com mais saturação que cards, mas mesma faixa.
function cmvCellBg(pct) {
  if (pct < 30) return "rgba(56,189,248,0.5)";
  if (pct < 35) return "rgba(45,140,102,0.55)";
  if (pct < 40) return "rgba(194,132,58,0.55)";
  return "rgba(176,69,69,0.7)";
}

const _fmtBRLc  = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _fmtBRLci = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// Aplica a flag composeCmv dos insumos: subtrai dos cogs diários a parcela
// estimada de itens marcados como "não compõe CMV". Distribuição:
//  - Se o item tem alocação por operação (alloc), usa a proporção do alloc.
//  - Senão, distribui igualmente entre as 4 operações.
// O impacto diário de um item é (usage30d × cost) / 30.
function applyComposeCmvFilter(daily, items) {
  const excluded = items.filter((it) => it.composeCmv === false);
  if (excluded.length === 0) return { daily, excludedCount: 0, excludedDailyTotal: 0 };
  const dailyImpactByOp = {};
  let totalDailyImpact = 0;
  excluded.forEach((it) => {
    const impactDay = (it.usage30d || 0) * (it.cost || 0) / 30;
    if (impactDay <= 0) return;
    totalDailyImpact += impactDay;
    const allocSum = Object.values(it.alloc || {}).reduce((s, v) => s + v, 0);
    if (allocSum > 0) {
      Object.entries(it.alloc).forEach(([op, qty]) => {
        if (qty <= 0) return;
        dailyImpactByOp[op] = (dailyImpactByOp[op] || 0) + impactDay * (qty / allocSum);
      });
    } else {
      const ops = ["burguer", "pizzaria", "acai", "saudavel"];
      ops.forEach((op) => {
        dailyImpactByOp[op] = (dailyImpactByOp[op] || 0) + impactDay / ops.length;
      });
    }
  });
  return {
    daily: daily.map((r) => ({
      ...r,
      cogs: Math.max(0, r.cogs - (dailyImpactByOp[r.op] || 0)),
    })),
    excludedCount: excluded.length,
    excludedDailyTotal: totalDailyImpact,
  };
}

// Filtra rows de CMV diário (do DB ou MOCK) pelo período selecionado
function filterByPeriod(rows, period) {
  const now = new Date();
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const today = ymd(startOfToday);
  if (period === "today") {
    return rows.filter((r) => r.date === today);
  }
  if (period === "yesterday") {
    const y = new Date(startOfToday); y.setDate(y.getDate() - 1);
    return rows.filter((r) => r.date === ymd(y));
  }
  if (period === "7d") {
    const c = new Date(startOfToday); c.setDate(c.getDate() - 6); // últimos 7 dias incluindo hoje
    const cs = ymd(c);
    return rows.filter((r) => r.date >= cs);
  }
  // 30d
  const c = new Date(startOfToday); c.setDate(c.getDate() - 29);
  const cs = ymd(c);
  return rows.filter((r) => r.date >= cs);
}

function CMV({ setPage }) {
  const [period, setPeriod] = useState("7d"); // today | yesterday | 7d | 30d
  const dbStatus = useDbStatus?.() || { isOnline: false };
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState("mock");
  const [dailyData, setDailyData] = useState(null);
  const [stockItems, setStockItems] = useState(null);
  const [topConsumed, setTopConsumed] = useState(null);

  // Calcula fromDate/toDate baseado no period
  const getDateRange = (p) => {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const toDate = ymd(startOfToday);
    let fromDate = toDate;
    if (p === "yesterday") {
      const y = new Date(startOfToday);
      y.setDate(y.getDate() - 1);
      fromDate = ymd(y);
    } else if (p === "7d") {
      const c = new Date(startOfToday);
      c.setDate(c.getDate() - 6);
      fromDate = ymd(c);
    } else if (p === "30d") {
      const c = new Date(startOfToday);
      c.setDate(c.getDate() - 29);
      fromDate = ymd(c);
    }
    return { fromDate, toDate };
  };

  // Carrega dados do DB quando period muda
  useEffect(() => {
    if (!dbStatus.isOnline) return;
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext?.();
      const tid = ctx?.tenant?.id;
      if (cancelled || !tid) return;
      setTenantId(tid);
      setSource("db"); // Conectado ao Supabase, mesmo que ainda não haja dados.
      const { fromDate, toDate } = getDateRange(period);
      const [dailyRes, itemsRes, consumedRes] = await Promise.all([
        dbListCmvDaily?.(tid, fromDate, toDate) || { data: null },
        dbListStockItems?.(tid) || { data: null },
        dbTopConsumedItems?.(tid, fromDate, toDate, 10) || { data: null },
      ]);
      if (cancelled) return;
      setDailyData(dailyRes.data || []);
      setStockItems(itemsRes.data || []);
      setTopConsumed(consumedRes.data || []);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.isOnline, period]);

  // Usa dados do DB; quando online sem dados, mostra vazio (não MOCK)
  const effectiveDaily = dailyData || (dbStatus.isOnline ? [] : MOCK.CMV_DAILY);
  const effectiveStockItems = stockItems || (dbStatus.isOnline ? [] : MOCK.STOCK_ITEMS);

  // Aplica flag de "compor CMV" antes de qualquer agregação. Recomputa em cada
  // render — se o usuário toggle no Estoque e voltar pro CMV, vê o reflexo.
  const { daily, excludedCount, excludedDailyTotal } = applyComposeCmvFilter(effectiveDaily, effectiveStockItems);

  const filtered = useMemo(() => filterByPeriod(daily, period), [daily, period]);

  // Totais consolidados do período
  const totals = useMemo(() => {
    const rev  = filtered.reduce((s, r) => s + r.revenue, 0);
    const cogs = filtered.reduce((s, r) => s + r.cogs, 0);
    return {
      revenue: rev,
      cogs,
      cmv:    rev > 0 ? (cogs / rev) * 100 : 0,
      margin: rev > 0 ? ((rev - cogs) / rev) * 100 : 0,
    };
  }, [filtered]);

  // Por operação (agrega no período) + parcela vinda de itens compartilhados
  const byOp = useMemo(() => {
    const m = {};
    filtered.forEach((r) => {
      if (!m[r.op]) m[r.op] = { op: r.op, revenue: 0, cogs: 0 };
      m[r.op].revenue += r.revenue;
      m[r.op].cogs    += r.cogs;
    });
    return Object.values(m).map((o) => {
      const cmv = o.revenue > 0 ? (o.cogs / o.revenue) * 100 : 0;
      return {
        ...o,
        cmv,
        shared: 0,        // sharedRatio dependia de MOCK.CMV_TABLE — desabilitado até modelar no DB
        exclusive: cmv,
        margin: o.revenue > 0 ? ((o.revenue - o.cogs) / o.revenue) * 100 : 0,
      };
    }).sort((a, b) => b.cmv - a.cmv);
  }, [filtered]);

  // Heatmap fixo · últimos 7 dias (independe do filtro de KPI)
  const heat = useMemo(() => {
    const last7 = filterByPeriod(daily, "7d");
    const dates = [...new Set(last7.map((r) => r.date))].sort();
    const opsList = ["burguer", "pizzaria", "acai", "saudavel"];
    const dayLabel = (iso) => {
      const d = new Date(iso + "T12:00:00");
      const days = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
      return `${days[d.getDay()]} ${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}`;
    };
    const rows = opsList.map((op) => {
      const values = dates.map((d) => {
        const r = last7.find((x) => x.date === d && x.op === op);
        if (!r || r.revenue === 0) return null;
        return (r.cogs / r.revenue) * 100;
      });
      return { op, values };
    });
    return { days: dates.map(dayLabel), rows };
  }, [daily]);

  const periodLabel = {
    today: "hoje", yesterday: "ontem", "7d": "últimos 7 dias", "30d": "últimos 30 dias",
  }[period];

  const headerTone = cmvTone(totals.cmv);

  return (
    <div style={{ padding: "20px 28px 32px", display: "flex", flexDirection: "column", gap: 20, overflow: "auto", height: "100%" }} className="stagger">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="h-eyebrow" style={{ marginBottom: 6, color: headerTone.fg }}>
            CMV consolidado · <span style={{ fontWeight: 500 }}>{totals.cmv.toFixed(1)}%</span> · {headerTone.label.toLowerCase()}
          </div>
          <h1 className="h-title">CMV &amp; margem</h1>
          <p className="h-sub">
            Calculado a partir das <strong style={{ color: "var(--fg-1)" }}>saídas de estoque</strong> (consumo × custo)
            e do <strong style={{ color: "var(--fg-1)" }}>faturamento</strong> de cada operação · {periodLabel}.
          </p>
          {excludedCount > 0 && (
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              marginTop: 8, padding: "4px 10px",
              background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 99,
              fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-2)",
              letterSpacing: "0.04em",
            }} title="Configurado em Estoque · botão CMV de cada insumo">
              <span style={{ width: 6, height: 6, borderRadius: 50, background: "var(--fg-3)" }} />
              {excludedCount} {excludedCount === 1 ? "item excluído" : "itens excluídos"} do CMV
              <span style={{ color: "var(--fg-3)" }}>·</span>
              <span>{_fmtBRLci(excludedDailyTotal * 30)}/mês não computado</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <CmvPeriodTabs value={period} onChange={setPeriod} />
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase",
            padding: "2px 7px", borderRadius: 99,
            color: source === "db" ? "var(--ok)" : "var(--fg-3)",
            background: source === "db" ? "var(--accent-soft)" : "var(--bg-2)",
            border: `1px solid ${source === "db" ? "var(--accent-line)" : "var(--line)"}`,
          }} title={source === "db" ? "CMV em tempo real do Supabase" : "Dados de exemplo · aguardando conexão ao DB"}>
            <span style={{ width: 5, height: 5, borderRadius: 50, background: source === "db" ? "var(--ok)" : "var(--fg-3)" }} />
            {source === "db" ? "Supabase" : "Mock"}
          </span>
          <button className="btn" data-size="sm" onClick={() => notImplemented("Exportar CSV")}>Exportar CSV</button>
        </div>
      </div>

      {/* KPI consolidado */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        <CmvKpiCard
          label="CMV %"
          value={`${totals.cmv.toFixed(1)}%`}
          sub={headerTone.label}
          tone={headerTone}
          hero
        />
        <CmvKpiCard
          label="Faturamento"
          value={_fmtBRLci(totals.revenue)}
          sub={`${filtered.length === 0 ? "sem dados" : `${[...new Set(filtered.map(r => r.date))].length} dia(s) · ${[...new Set(filtered.map(r => r.op))].length} op.`}`}
        />
        <CmvKpiCard
          label="Custo (saídas estoque)"
          value={_fmtBRLci(totals.cogs)}
          sub="consumo × custo unitário"
        />
        <CmvKpiCard
          label="Margem bruta"
          value={`${totals.margin.toFixed(1)}%`}
          sub={_fmtBRLci(totals.revenue - totals.cogs)}
          tone={cmvTone(totals.cmv)}
          mode="margin"
        />
      </div>

      {/* Régua de faixas (legenda) */}
      <CmvScaleLegend pct={totals.cmv} />

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
                        <span style={{ width: 6, height: 6, borderRadius: 50, background: op.color }} />
                        {op.name}
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
                <th>Composição</th>
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
                        <span style={{ width: 6, height: 6, borderRadius: 50, background: op.color }} />
                        <span style={{ color: "var(--fg-0)", fontWeight: 500 }}>{op.name}</span>
                      </span>
                    </td>
                    <td className="num">{_fmtBRLci(r.revenue)}</td>
                    <td className="num">{_fmtBRLci(r.cogs)}</td>
                    <td className="num">
                      <span className="mono" style={{ color: tone.fg, fontWeight: 500 }}>{r.cmv.toFixed(1)}%</span>
                    </td>
                    <td>
                      <CmvSharedBar shared={r.shared} exclusive={r.exclusive} max={45} tone={tone} />
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
            <h3 className="card-title">Top consumos · 7 dias</h3>
            <span className="card-sub">Insumos com maior R$ saído do estoque</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {(() => {
              const list = topConsumed || (dbStatus.isOnline ? [] : MOCK.TOP_CONSUMED);
              if (list.length === 0) {
                return (
                  <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>
                    {dbStatus.isOnline ? "Sem consumo no período" : "DB offline"}
                  </div>
                );
              }
              return list.map((c, i) => {
              const itemName = c.item || c.name;
              const itemQty = c.qty || c.totalQty;
              const itemCost = c.value || c.totalCost;
              const op = c.op ? MOCK.opById(c.op) : null;
              return (
                <div key={i} style={{
                  display: "grid", gridTemplateColumns: "1fr 100px",
                  gap: 10, alignItems: "center",
                  padding: "12px 16px",
                  borderBottom: i < list.length - 1 ? "1px solid var(--line-soft)" : "none",
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
            });
            })()}
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

// Régua horizontal mostrando as 4 faixas, com o ponteiro do CMV atual
function CmvScaleLegend({ pct }) {
  // Escala visual de 22 a 45 (range realista)
  const min = 22, max = 45;
  const clamp = Math.max(min, Math.min(max, pct));
  const left = ((clamp - min) / (max - min)) * 100;

  // Largura proporcional ao range de cada faixa
  const seg = (a, b) => ((Math.min(b, max) - Math.max(a, min)) / (max - min)) * 100;
  const segments = [
    { from: min,  to: 30, color: CMV_SKY,       label: "<30%" },
    { from: 30,   to: 35, color: "var(--ok)",     label: "<35%" },
    { from: 35,   to: 40, color: "var(--warn)",   label: "<40%" },
    { from: 40,   to: max,color: "var(--crit)",   label: "≥40%" },
  ];

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8,
      }}>
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
      {/* Track segmentada */}
      <div style={{ position: "relative", height: 8, borderRadius: 4, overflow: "hidden", display: "flex" }}>
        {segments.map((s, i) => {
          const w = seg(s.from, s.to);
          return (
            <div key={i} style={{
              width: `${w}%`, background: s.color, opacity: 0.8,
            }} />
          );
        })}
      </div>
      {/* Ponteiro */}
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

// Legenda compacta usada no header de cards
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

// Mini-bar de composição do CMV: slate (compartilhados) no início + cor (exclusivos).
// Listras diagonais sutis no slate sinalizam "baseline comum entre operações".
function CmvSharedBar({ shared, exclusive, max, tone }) {
  const total = shared + exclusive;
  const sharedW    = (shared    / max) * 100;
  const exclusiveW = (exclusive / max) * 100;
  return (
    <div title={`${total.toFixed(1)}% total · ${shared.toFixed(1)}pp compartilhados · ${exclusive.toFixed(1)}pp exclusivos`}
         style={{ minWidth: 140 }}>
      <div style={{ position: "relative", height: 7, background: "var(--bg-3)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{
          position: "absolute", left: 0, top: 0, height: "100%",
          width: `${sharedW}%`,
          background:
            "repeating-linear-gradient(135deg, rgba(255,255,255,0.05) 0 3px, transparent 3px 6px)," +
            "linear-gradient(180deg, rgba(148,163,184,0.38), rgba(100,116,139,0.26))",
        }} />
        {shared > 0 && exclusive > 0 && (
          <div style={{
            position: "absolute", top: 0, bottom: 0,
            left: `${sharedW}%`, width: 1,
            background: "rgba(0,0,0,0.25)",
          }} />
        )}
        <div style={{
          position: "absolute", top: 0, height: "100%",
          left: `${sharedW}%`, width: `${exclusiveW}%`,
          background: tone.fg,
        }} />
      </div>
      <div style={{
        display: "flex", justifyContent: "space-between",
        fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)",
        letterSpacing: "0.04em", marginTop: 3,
      }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{
            width: 7, height: 7, borderRadius: 1,
            background: "linear-gradient(180deg, rgba(148,163,184,0.55), rgba(100,116,139,0.4))",
          }} />
          compart. {shared.toFixed(1)}pp
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: tone.fg }}>
          <span style={{ width: 7, height: 7, borderRadius: 1, background: tone.fg }} />
          excl. {exclusive.toFixed(1)}pp
        </span>
      </div>
    </div>
  );
}

window.CMV = CMV;
window.cmvTone = cmvTone; // exposto para uso pelo dashboard
