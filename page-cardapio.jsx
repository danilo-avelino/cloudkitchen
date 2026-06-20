// Cardápio — análises de vendas a partir dos dados da Agilizone.
// Sub-abas: Itens (consolidado + curva ABC, base Faturamento↔Quantidade),
// Tendência (alta/queda vs período anterior), Adicionais (attach rate) e
// Combos (itens vendidos juntos / market basket). RPCs agilizone_menu_*.

function _cEffDay(d) { return new Date(d.getTime() - 8 * 3600e3).toISOString().slice(0, 10); }
function _brl(v) {
  return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function _pct(v) {
  return (Number(v) || 0).toLocaleString("pt-BR", { style: "percent", maximumFractionDigits: 1 });
}
function _num(v) { return (Number(v) || 0).toLocaleString("pt-BR"); }
function _deltaPct(v) {
  if (v == null) return "novo";
  return (v > 0 ? "+" : "") + (v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + "%";
}

// CSV no padrão pt-BR (Excel): separador ';', decimal ',' e sem agrupamento.
function _csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function _csvNum(v, dec = 2) {
  return (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: false });
}

const _CARD_PERIODS = [
  { id: "today", label: "Hoje",    days: 1 },
  { id: "7d",    label: "7 dias",  days: 7 },
  { id: "30d",   label: "30 dias", days: 30 },
];
const _CARD_VIEWS = [
  { id: "itens",      label: "Itens" },
  { id: "tendencia",  label: "Tendência" },
  { id: "adicionais", label: "Adicionais" },
  { id: "combos",     label: "Combos" },
];

// Janelas do período atual e do anterior (mesma duração), em dia efetivo (-8h).
function _cardRanges(period) {
  const days = _CARD_PERIODS.find((p) => p.id === period)?.days || 7;
  const to       = _cEffDay(new Date());
  const from     = _cEffDay(new Date(Date.now() - (days - 1) * 86400e3));
  const toPrev   = _cEffDay(new Date(Date.now() - days * 86400e3));
  const fromPrev = _cEffDay(new Date(Date.now() - (2 * days - 1) * 86400e3));
  return { days, from, to, fromPrev, toPrev };
}
// "2026-07-01" → "1/07" (dia sem zero à esquerda, mês com dois dígitos).
function _cardDM(iso) {
  const p = String(iso || "").split("-");
  return p.length === 3 ? `${Number(p[2])}/${p[1]}` : "—";
}

// Curva ABC (Pareto): A = primeiros 80% da base, B = 80–95%, C = 95–100%.
// `basis` = "total" (faturamento) ou "qty" (quantidade). Classe pelo acumulado
// ANTES do item, p/ o item que cruza o limite ainda cair na classe superior.
const _ABC_CLASSES = {
  A: { color: "var(--ok)",   soft: "var(--ok-soft)",   line: "var(--ok-line)" },
  B: { color: "var(--warn)", soft: "var(--warn-soft)", line: "var(--warn-line)" },
  C: { color: "var(--crit)", soft: "var(--crit-soft)", line: "var(--crit-line)" },
};
function _classifyABC(rows, basis) {
  const val = (r) => Number(r[basis]) || 0;
  const sorted = rows.slice().sort((a, b) => val(b) - val(a));
  const grand = sorted.reduce((s, r) => s + val(r), 0);
  let cum = 0;
  return sorted.map((r) => {
    const prevPct = grand > 0 ? cum / grand : 0;
    cum += val(r);
    const cumPct = grand > 0 ? cum / grand : 0;
    const cls = prevPct < 0.80 ? "A" : prevPct < 0.95 ? "B" : "C";
    return {
      name: r.name, external_code: r.external_code, lines: r.lines,
      qty: r.qty, total: r.total, avg_price: r.avg_price,
      _cls: cls, _cumPct: cumPct,
    };
  });
}

// Junta período atual x anterior por nome do item → variação (alta/queda).
function _buildTrend(cur, prev) {
  const m = new Map();
  for (const r of cur) {
    m.set(r.name, {
      name: r.name, external_code: r.external_code,
      curQty: Number(r.qty) || 0, curTotal: Number(r.total) || 0,
      prevQty: 0, prevTotal: 0,
    });
  }
  for (const r of prev) {
    const e = m.get(r.name) || {
      name: r.name, external_code: r.external_code,
      curQty: 0, curTotal: 0, prevQty: 0, prevTotal: 0,
    };
    e.prevQty = Number(r.qty) || 0;
    e.prevTotal = Number(r.total) || 0;
    m.set(r.name, e);
  }
  const out = [];
  m.forEach((e) => {
    const dTotal = e.curTotal - e.prevTotal;
    const dQty = e.curQty - e.prevQty;
    const dPct = e.prevTotal > 0 ? dTotal / e.prevTotal : null;
    const status = e.prevTotal === 0 && e.curTotal > 0 ? "novo"
                 : e.curTotal === 0 && e.prevTotal > 0 ? "sumiu" : "normal";
    out.push({
      name: e.name, external_code: e.external_code,
      curQty: e.curQty, prevQty: e.prevQty, curTotal: e.curTotal, prevTotal: e.prevTotal,
      dTotal, dQty, dPct, status,
    });
  });
  out.sort((a, b) => b.dTotal - a.dTotal);
  return out;
}

// top 10 em alta + top 10 em queda (trend já vem ordenado por dTotal desc)
function _topMovers(trend) {
  const gainers = trend.filter((t) => t.dTotal > 0).slice(0, 10);
  const losers = trend.filter((t) => t.dTotal < 0).sort((a, b) => a.dTotal - b.dTotal).slice(0, 10);
  return { gainers, losers };
}

const _dowPT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const _srcLabel = { IFOOD: "iFood", ANOTA_AI: "Anota Aí", BEEFOOD: "Beefood", AGILIZONE: "Balcão" };
function _hourLabel(h) { return h == null ? "—" : `${h}h–${(h + 1) % 24}h`; }
// "2026-07-01" → "Ter" (construído como data local p/ não deslocar o dia da semana).
function _dowFromISO(iso) {
  const p = String(iso || "").split("-");
  if (p.length !== 3) return "";
  return _dowPT[new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getDay()] || "";
}

// mini gráfico de barras de vendas/dia (com dia da semana sob cada barra)
function MenuDaySpark({ data, color }) {
  if (!data || !data.length) return null;
  const W = 400, H = 48, n = data.length;
  const max = Math.max(1, ...data.map((p) => Number(p.q) || 0));
  const bw = W / n;
  const showDow = n <= 16; // acima disso (ex.: 30 dias) os rótulos ficam ilegíveis
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: "block" }}>
        {data.map((p, i) => {
          const h = ((Number(p.q) || 0) / max) * (H - 2);
          return <rect key={i} x={i * bw + 1} y={H - h} width={Math.max(1, bw - 2)} height={h} fill={color} opacity="0.7" />;
        })}
      </svg>
      {showDow && (
        <div style={{ display: "flex", marginTop: 3 }}>
          {data.map((p, i) => (
            <div key={i} title={p.d}
                 style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 9, color: "var(--fg-3)", fontFamily: "var(--mono)", whiteSpace: "nowrap", overflow: "hidden" }}>
              {_dowFromISO(p.d)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TrendKV({ label, value, color, wide }) {
  return (
    <div style={{ minWidth: 0, gridColumn: wide ? "span 2" : undefined }}>
      <div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 14, fontFamily: "var(--mono)", fontWeight: 500, color: color || "var(--fg-0)",
                    whiteSpace: wide ? "normal" : "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
    </div>
  );
}

function ItemTrendCard({ t, ins, tone, showOp }) {
  const col = tone === "ok" ? "var(--ok)" : "var(--crit)";
  const ticket = t.curQty > 0 ? _brl(t.curTotal / t.curQty) : "—";
  const peak = ins && ins.peak_hour != null ? `${_hourLabel(ins.peak_hour)} · ${_pct(ins.peak_share)}` : "—";
  const src  = ins && ins.top_source ? `${_srcLabel[ins.top_source] || ins.top_source} · ${_pct(ins.top_source_share)}` : "—";
  const dow  = ins && ins.busiest_dow != null ? `${_dowPT[ins.busiest_dow]} · ${_pct(ins.busiest_dow_share)}` : "—";
  const opv  = ins && ins.top_operation ? `${ins.top_operation} · ${_pct(ins.top_operation_share)}` : "—";
  return (
    <div className="card"><div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 16, padding: "16px 18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14 }}>
        <div style={{ fontWeight: 500, fontSize: 15, lineHeight: 1.3, minWidth: 0 }}>
          {t.name}
          {t.external_code && <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-3)", marginLeft: 6 }}>{t.external_code}</span>}
          {t.status === "novo"  && <span style={{ marginLeft: 8, fontSize: 10, padding: "1px 6px", borderRadius: 3, background: "var(--ok-soft)", border: "1px solid var(--ok-line)", color: "var(--ok)" }}>novo</span>}
          {t.status === "sumiu" && <span style={{ marginLeft: 8, fontSize: 10, padding: "1px 6px", borderRadius: 3, background: "var(--crit-soft)", border: "1px solid var(--crit-line)", color: "var(--crit)" }}>sumiu</span>}
        </div>
        <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
          <div style={{ fontFamily: "var(--mono)", fontWeight: 600, color: col, fontSize: 18 }}>{(t.dTotal > 0 ? "+" : "") + _brl(t.dTotal)}</div>
          <div style={{ fontFamily: "var(--mono)", color: col, fontSize: 13 }}>{_deltaPct(t.dPct)}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(185px, 1fr))", gap: "16px 28px" }}>
        <TrendKV label="Receita ant→atual" value={`${_brl(t.prevTotal)} → ${_brl(t.curTotal)}`} wide />
        <TrendKV label="Qtd ant→atual" value={`${_num(t.prevQty)} → ${_num(t.curQty)}`} />
        <TrendKV label="Ticket médio" value={ticket} />
        <TrendKV label="Pico de horário" value={peak} />
        <TrendKV label="Canal principal" value={src} />
        <TrendKV label="Dia mais forte" value={dow} />
        {showOp && <TrendKV label="Operação líder" value={opv} />}
      </div>

      {ins && ins.spark && (
        <div>
          <div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Vendas/dia</div>
          <MenuDaySpark data={ins.spark} color={col} />
        </div>
      )}
    </div></div>
  );
}

function Cardapio({ scope }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid]           = useState(null);
  const [ops, setOps]           = useState([]);
  const [opFilter, setOpFilter] = useState("all");
  const [period, setPeriod]     = useState("7d");
  const [view, setView]         = useState("itens");
  const [abcBasis, setAbcBasis] = useState("total");
  const [abcFilter, setAbcFilter] = useState([]); // classes A/B/C selecionadas; vazio = todas
  const toggleAbc = (cls) =>
    setAbcFilter((prev) => (prev.includes(cls) ? prev.filter((c) => c !== cls) : [...prev, cls]));

  const [itemsRows, setItemsRows] = useState([]);
  const [trend, setTrend]         = useState([]);
  const [insights, setInsights]   = useState({});
  const [addons, setAddons]       = useState([]);
  const [baskets, setBaskets]     = useState([]);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState(false);
  const [exporting, setExporting] = useState(false);
  const [integ, setInteg]     = useState(null);   // integração Agilizone ativa? (null = carregando)

  // contexto + operações
  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      const t = ctx?.tenant?.id || null;
      if (cancelled) return;
      setTid(t);
      if (!t) { setLoading(false); return; }
      const { data: o } = await dbListOperations(t);
      if (cancelled) return;
      setOps((o || []).filter((x) => x.id !== "all").map((x) => ({ id: x.id, name: x.name })));
      const { active } = await dbAgilizoneIntegrationActive(t);
      if (cancelled) return;
      setInteg(active);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  // sincroniza com o seletor de escopo do topo
  useEffect(() => { if (scope && scope !== "all") setOpFilter(scope); }, [scope]);

  // dados da aba ativa
  useEffect(() => {
    if (!tid) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      const { from, to, fromPrev, toPrev } = _cardRanges(period);
      const op = opFilter === "all" ? null : opFilter;
      try {
        if (view === "itens") {
          const { data, error } = await dbMenuSales(tid, from, to, op);
          if (cancelled) return;
          if (error) throw error;
          setItemsRows(data || []);
        } else if (view === "tendencia") {
          const [cur, prv] = await Promise.all([
            dbMenuSales(tid, from, to, op),
            dbMenuSales(tid, fromPrev, toPrev, op),
          ]);
          if (cancelled) return;
          if (cur.error) throw cur.error;
          if (prv.error) throw prv.error;
          const tr = _buildTrend(cur.data || [], prv.data || []);
          setTrend(tr);
          const { gainers, losers } = _topMovers(tr);
          const names = Array.from(new Set([...gainers, ...losers].map((x) => x.name)));
          let insMap = {};
          if (names.length) {
            const { data: ins } = await dbMenuItemInsights(tid, from, to, op, names);
            (ins || []).forEach((r) => { insMap[r.name] = r; });
          }
          if (cancelled) return;
          setInsights(insMap);
        } else if (view === "adicionais") {
          const { data, error } = await dbMenuAddons(tid, from, to, op);
          if (cancelled) return;
          if (error) throw error;
          setAddons(data || []);
        } else if (view === "combos") {
          const { data, error } = await dbMenuBaskets(tid, from, to, op);
          if (cancelled) return;
          if (error) throw error;
          setBaskets(data || []);
        }
      } catch (e) {
        if (!cancelled) window.showToast?.(e.message, { tone: "crit" });
      } finally {
        if (!cancelled) { setBusy(false); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [tid, period, opFilter, view]);

  // Adicionais agrupados pelo grupo de complementos. Grupos ordenados por
  // quantidade total desc; itens dentro de cada grupo também por qtd desc.
  // Hook fica acima dos early returns para não violar as Rules of Hooks.
  const addonGroups = useMemo(() => {
    const map = new Map();
    for (const a of addons) {
      const key = a.group_name || "—";
      let g = map.get(key);
      if (!g) { g = { name: key, items: [], qty: 0, revenue: 0, orders: 0 }; map.set(key, g); }
      g.items.push(a);
      g.qty     += Number(a.qty) || 0;
      g.revenue += Number(a.revenue) || 0;
      g.orders  += Number(a.orders) || 0;
    }
    const groups = Array.from(map.values());
    for (const g of groups) g.items.sort((x, y) => (Number(y.qty) || 0) - (Number(x.qty) || 0));
    groups.sort((a, b) => b.qty - a.qty);
    return groups;
  }, [addons]);

  // Grupos de adicionais começam recolhidos; Set guarda os expandidos.
  const [addonOpen, setAddonOpen] = useState(() => new Set());
  const toggleAddonGroup = (name) => setAddonOpen((prev) => {
    const next = new Set(prev);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });

  if (loading || (dbStatus.isOnline && tid && integ === null))
    return <PageLoading label="Carregando cardápio…" variant="table" hint="" />;

  if (!dbStatus.isOnline || !tid) {
    return (
      <div style={{ padding: "24px 28px" }}>
        <div style={{ fontSize: 12.5, color: "var(--warn)", padding: "10px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 4 }}>
          O cardápio só fica disponível com Supabase online.
        </div>
      </div>
    );
  }

  if (integ === false) {
    return (
      <div style={{ padding: "32px 28px" }}>
        <div style={{ maxWidth: 560, margin: "8px auto 0", textAlign: "center", padding: "32px 28px", background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 10 }}>
          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 46, height: 46, borderRadius: 12, marginBottom: 14, background: "var(--info-soft)", border: "1px solid var(--info-line)", color: "var(--info)" }}>
            <I.AlertTriangle size={22} />
          </span>
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: "0 0 10px", color: "var(--fg-0)" }}>Integração Agilizone não ativa</h2>
          <p style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.6, margin: "0 0 8px" }}>
            O Cardápio é alimentado pela integração com a <b>Agilizone</b>, o sistema de gestão de delivery.
          </p>
          <p style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.6, margin: 0 }}>
            Entre em contato com a <b>Agilizone</b> para realizar a integração. Depois, ative-a e atrele as
            marcas às operações em <b>Configurações → Agilizone</b>.
          </p>
        </div>
      </div>
    );
  }

  const basisKey = abcBasis === "qty" ? "qty" : "total";
  const abcRows = _classifyABC(itemsRows, basisKey);
  const grandTotal = itemsRows.reduce((s, r) => s + (Number(r.total) || 0), 0);
  const grandQty   = itemsRows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const grandBasis = basisKey === "qty" ? grandQty : grandTotal;
  const abcSummary = ["A", "B", "C"].map((cls) => {
    const items = abcRows.filter((r) => r._cls === cls);
    const baseSum = items.reduce((s, r) => s + (Number(r[basisKey]) || 0), 0);
    return {
      cls, count: items.length,
      share: grandBasis > 0 ? baseSum / grandBasis : 0,
      mixShare: abcRows.length > 0 ? items.length / abcRows.length : 0,
      label: basisKey === "qty" ? _num(baseSum) + " un" : _brl(baseSum),
    };
  });
  const abcVisible = abcFilter.length ? abcRows.filter((r) => abcFilter.includes(r._cls)) : abcRows;

  // Exporta a curva ABC (o que está visível, respeitando o filtro de classe) como CSV.
  const exportAbc = () => {
    if (exporting) return;
    setExporting(true);
    try {
      if (!abcVisible.length) { window.showToast?.("Nada para exportar no período/filtro.", { tone: "warn" }); return; }
      const head = ["Classe", "Item", "Código", "Qtd", "Valor médio", "Total", "% acumulado", "Vendas"];
      const rows = abcVisible.map((r) => [
        r._cls,
        _csvCell(r.name),
        _csvCell(r.external_code || ""),
        _csvNum(r.qty, 0),
        _csvNum(r.avg_price, 2),
        _csvNum(r.total, 2),
        _csvNum((Number(r._cumPct) || 0) * 100, 1),
        _csvNum(r.lines, 0),
      ].join(";"));
      const csv = [head.join(";"), ...rows].join("\r\n");
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `curva-abc-${basisKey === "qty" ? "quantidade" : "faturamento"}-${period}-${_cEffDay(new Date())}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      window.showToast?.("Curva ABC exportada.", { tone: "ok" });
    } finally {
      setTimeout(() => setExporting(false), 600);
    }
  };

  const emAlta  = trend.filter((t) => t.dTotal > 0).length;
  const emQueda = trend.filter((t) => t.dTotal < 0).length;
  const movers  = _topMovers(trend);
  const tendRanges = _cardRanges(period);
  const addonsRevenue = addons.reduce((s, a) => s + (Number(a.revenue) || 0), 0);

  const emptyHint = (
    <div style={{ fontSize: 13, color: "var(--fg-3)", maxWidth: 620 }}>
      Sem dados no período. Confirme em <b>Configurações → Agilizone</b> se as marcas estão
      atreladas a operações e se a sincronização já rodou.
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "20px 28px 0" }}>
        <div className="h-eyebrow" style={{ marginBottom: 6 }}>Vendas · Agilizone</div>
        <h1 className="h-title">Cardápio</h1>

        {/* sub-abas */}
        <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--line)", marginTop: 14 }}>
          {_CARD_VIEWS.map((v) => (
            <button key={v.id} onClick={() => setView(v.id)}
              style={{
                background: "none", border: "none", cursor: "pointer",
                padding: "8px 14px", fontSize: 13, marginBottom: -1,
                color: view === v.id ? "var(--fg-0)" : "var(--fg-3)",
                fontWeight: view === v.id ? 600 : 400,
                borderBottom: view === v.id ? "2px solid var(--accent-bright)" : "2px solid transparent",
              }}>{v.label}</button>
          ))}
        </div>

        {/* controles compartilhados */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          {_CARD_PERIODS.map((p) => (
            <button key={p.id} className="btn" data-size="sm" data-variant={period === p.id ? "primary" : undefined}
                    onClick={() => setPeriod(p.id)}>{p.label}</button>
          ))}
          <span style={{ width: 1, height: 18, background: "var(--line)", margin: "0 4px" }} />
          <select className="input" style={{ width: 220 }} value={opFilter} onChange={(e) => setOpFilter(e.target.value)}>
            <option value="all">Todas as operações</option>
            {ops.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          {view === "itens" && (
            <>
              <span style={{ width: 1, height: 18, background: "var(--line)", margin: "0 4px" }} />
              <span style={{ fontSize: 11, color: "var(--fg-3)" }}>Classe</span>
              {["A", "B", "C"].map((cls) => {
                const active = abcFilter.includes(cls);
                const c = _ABC_CLASSES[cls];
                return (
                  <button key={cls} className="btn" data-size="sm" onClick={() => toggleAbc(cls)}
                          style={active ? { background: c.soft, borderColor: c.line, color: c.color } : undefined}>{cls}</button>
                );
              })}
              {abcFilter.length > 0 && (
                <button className="btn" data-size="sm" onClick={() => setAbcFilter([])}>Limpar</button>
              )}
            </>
          )}
          {busy && <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>atualizando…</span>}
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 32px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* ----------------------------- ITENS ----------------------------- */}
        {view === "itens" && (
          <>
            <div style={{ display: "flex", gap: 24, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div><div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Itens vendidos</div>
                <div style={{ fontSize: 18, fontWeight: 500, fontFamily: "var(--mono)" }}>{_num(grandQty)}</div></div>
              <div><div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Total</div>
                <div style={{ fontSize: 18, fontWeight: 500, fontFamily: "var(--mono)", color: "var(--accent-bright)" }}>{_brl(grandTotal)}</div></div>
              <div><div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Itens distintos</div>
                <div style={{ fontSize: 18, fontWeight: 500, fontFamily: "var(--mono)" }}>{itemsRows.length}</div></div>
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color: "var(--fg-3)" }}>ABC por</span>
                <button className="btn" data-size="sm" data-variant={abcBasis === "total" ? "primary" : undefined}
                        onClick={() => setAbcBasis("total")}>Faturamento</button>
                <button className="btn" data-size="sm" data-variant={abcBasis === "qty" ? "primary" : undefined}
                        onClick={() => setAbcBasis("qty")}>Quantidade</button>
                <span style={{ width: 1, height: 18, background: "var(--line)", margin: "0 4px" }} />
                <button className="btn" data-size="sm" onClick={exportAbc} disabled={exporting || itemsRows.length === 0}>
                  {exporting ? "Exportando…" : "Exportar"}
                </button>
              </div>
            </div>

            {itemsRows.length === 0 ? emptyHint : (
              <>
                <div>
                  <div className="h-eyebrow" style={{ marginBottom: 8 }}>Curva ABC · por {abcBasis === "qty" ? "quantidade" : "faturamento"}</div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    {abcSummary.map((s) => {
                      const c = _ABC_CLASSES[s.cls];
                      const active = abcFilter.includes(s.cls);
                      return (
                        <div key={s.cls} onClick={() => toggleAbc(s.cls)} title="Filtrar por esta classe"
                             style={{ flex: "1 1 200px", minWidth: 200, padding: "12px 14px", background: c.soft, border: `1px solid ${c.line}`, borderRadius: 6, cursor: "pointer", outline: active ? `2px solid ${c.color}` : "none", outlineOffset: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                            <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 4, background: c.color, color: "#fff", fontSize: 12.5, fontWeight: 700, fontFamily: "var(--mono)" }}>{s.cls}</span>
                            <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>{s.count} {s.count === 1 ? "item" : "itens"} · {_pct(s.mixShare)} do mix</span>
                          </div>
                          <div style={{ fontSize: 17, fontWeight: 500, fontFamily: "var(--mono)", color: c.color }}>{_pct(s.share)}</div>
                          <div style={{ fontSize: 11.5, color: "var(--fg-3)", fontFamily: "var(--mono)" }}>{s.label}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="card">
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 56 }}>Classe</th>
                        <th>Item</th>
                        <th style={{ width: 90, textAlign: "right" }}>Qtd</th>
                        <th style={{ width: 130, textAlign: "right" }}>Valor médio</th>
                        <th style={{ width: 140, textAlign: "right" }}>Total</th>
                        <th style={{ width: 90, textAlign: "right" }}>% acum.</th>
                        <th style={{ width: 80, textAlign: "right" }}>Vendas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {abcVisible.length === 0 && (
                        <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--fg-3)", padding: "18px 0" }}>
                          Nenhum item na(s) classe(s) selecionada(s).
                        </td></tr>
                      )}
                      {abcVisible.map((r, i) => {
                        const c = _ABC_CLASSES[r._cls];
                        return (
                          <tr key={(r.external_code || r.name) + i}>
                            <td>
                              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, borderRadius: 4, background: c.soft, border: `1px solid ${c.line}`, color: c.color, fontSize: 11, fontWeight: 700, fontFamily: "var(--mono)" }}>{r._cls}</span>
                            </td>
                            <td className="row-strong">
                              {r.name}
                              {r.external_code && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", marginLeft: 6, fontWeight: 400 }}>{r.external_code}</span>}
                            </td>
                            <td className="num" style={{ fontWeight: 600 }}>{_num(r.qty)}</td>
                            <td className="num" style={{ fontWeight: 500 }}>{_brl(r.avg_price)}</td>
                            <td className="num" style={{ fontWeight: 700 }}>{_brl(r.total)}</td>
                            <td className="num" style={{ fontWeight: 500 }}>{_pct(r._cumPct)}</td>
                            <td className="num" style={{ fontWeight: 500 }}>{r.lines}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}

        {/* --------------------------- TENDÊNCIA --------------------------- */}
        {view === "tendencia" && (
          <>
            <div style={{ fontSize: 12, color: "var(--fg-3)", maxWidth: 720 }}>
              Variação de receita por item vs. o período imediatamente anterior de mesma duração.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: 13 }}>
              <span style={{ fontSize: 10.5, fontFamily: "var(--sans)", color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Comparação</span>
              <span style={{ color: "var(--fg-2)" }}>De {_cardDM(tendRanges.fromPrev)} a {_cardDM(tendRanges.toPrev)}</span>
              <span style={{ color: "var(--fg-3)" }}>→</span>
              <span style={{ color: "var(--fg-0)", fontWeight: 600 }}>{_cardDM(tendRanges.from)} a {_cardDM(tendRanges.to)}</span>
            </div>
            <div style={{ display: "flex", gap: 24 }}>
              <div><div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Em alta</div>
                <div style={{ fontSize: 18, fontWeight: 500, fontFamily: "var(--mono)", color: "var(--ok)" }}>{emAlta}</div></div>
              <div><div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Em queda</div>
                <div style={{ fontSize: 18, fontWeight: 500, fontFamily: "var(--mono)", color: "var(--crit)" }}>{emQueda}</div></div>
            </div>

            {trend.length === 0 ? emptyHint : (
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
                <div style={{ flex: "1 1 460px", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontSize: 13, color: "var(--ok)", fontWeight: 600 }}>↑ Top 10 em crescimento</div>
                  {movers.gainers.length === 0
                    ? <div style={{ fontSize: 12.5, color: "var(--fg-3)" }}>Nenhum item em alta no período.</div>
                    : movers.gainers.map((t) => <ItemTrendCard key={t.name} t={t} ins={insights[t.name]} tone="ok" showOp={opFilter === "all"} />)}
                </div>
                <div style={{ flex: "1 1 460px", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontSize: 13, color: "var(--crit)", fontWeight: 600 }}>↓ Top 10 em queda</div>
                  {movers.losers.length === 0
                    ? <div style={{ fontSize: 12.5, color: "var(--fg-3)" }}>Nenhum item em queda no período.</div>
                    : movers.losers.map((t) => <ItemTrendCard key={t.name} t={t} ins={insights[t.name]} tone="crit" showOp={opFilter === "all"} />)}
                </div>
              </div>
            )}
          </>
        )}

        {/* --------------------------- ADICIONAIS -------------------------- */}
        {view === "adicionais" && (
          <>
            <div style={{ fontSize: 12, color: "var(--fg-3)", maxWidth: 720 }}>
              Complementos escolhidos nos pedidos. <b>Attach</b> = % dos pedidos do recorte que levam o adicional.
            </div>
            <div style={{ display: "flex", gap: 24 }}>
              <div><div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Adicionais distintos</div>
                <div style={{ fontSize: 18, fontWeight: 500, fontFamily: "var(--mono)" }}>{addons.length}</div></div>
              <div><div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Receita de adicionais</div>
                <div style={{ fontSize: 18, fontWeight: 500, fontFamily: "var(--mono)", color: "var(--accent-bright)" }}>{_brl(addonsRevenue)}</div></div>
            </div>

            {addons.length === 0 ? emptyHint : (
              <div className="card">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Adicional</th>
                      <th style={{ width: 90, textAlign: "right" }}>Qtd</th>
                      <th style={{ width: 120, textAlign: "right" }}>Receita</th>
                      <th style={{ width: 90, textAlign: "right" }}>Pedidos</th>
                      <th style={{ width: 90, textAlign: "right" }}>Attach</th>
                    </tr>
                  </thead>
                  <tbody>
                    {addonGroups.map((g) => {
                      const open = addonOpen.has(g.name);
                      return (
                      <React.Fragment key={g.name}>
                        <tr onClick={() => toggleAddonGroup(g.name)} style={{ cursor: "pointer", userSelect: "none" }}>
                          <td colSpan={5} style={{ background: "var(--bg-1)", borderBottom: "1px solid var(--line)", borderLeft: "3px solid var(--accent-bright)" }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <span style={{ color: "var(--accent-bright)", fontSize: 11, width: 12, transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }}>▶</span>
                                <span style={{ color: "#fff", fontWeight: 700, fontSize: 15, letterSpacing: "0.01em" }}>{g.name}</span>
                              </span>
                              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-3)" }}>
                                {g.items.length} {g.items.length === 1 ? "item" : "itens"} · {_num(g.qty)} un · {_brl(g.revenue)}
                              </span>
                            </div>
                          </td>
                        </tr>
                        {open && g.items.map((a, i) => (
                          <tr key={(a.name || "") + i}>
                            <td className="row-strong" style={{ paddingLeft: 32 }}>{a.name}</td>
                            <td className="num" style={{ fontWeight: 600 }}>{_num(a.qty)}</td>
                            <td className={Number(a.revenue) > 0 ? "num" : "num dim"} style={{ fontWeight: Number(a.revenue) > 0 ? 600 : 400 }}>{_brl(a.revenue)}</td>
                            <td className="num" style={{ fontWeight: 500 }}>{_num(a.orders)}</td>
                            <td className="num" style={{ color: "var(--accent-bright)", fontWeight: 700 }}>{_pct((Number(a.attach_pct) || 0) / 100)}</td>
                          </tr>
                        ))}
                      </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ----------------------------- COMBOS ---------------------------- */}
        {view === "combos" && (
          <>
            <div style={{ fontSize: 12, color: "var(--fg-3)", maxWidth: 760 }}>
              Itens que aparecem no mesmo pedido (pares com ≥ 3 pedidos). <b>A→B</b> = dos pedidos com A, % que levam B.
              <b> Afinidade</b> (lift) &gt; 1 indica que vendem juntos mais do que o acaso — candidatos a combo.
            </div>

            {baskets.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--fg-3)", maxWidth: 620 }}>
                Sem pares relevantes no período (precisa de ≥ 3 pedidos com os dois itens). Tente um período maior.
              </div>
            ) : (
              <div className="card">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Combinação</th>
                      <th style={{ width: 110, textAlign: "right" }}>Pedidos juntos</th>
                      <th style={{ width: 90, textAlign: "right" }}>A→B</th>
                      <th style={{ width: 90, textAlign: "right" }}>B→A</th>
                      <th style={{ width: 110, textAlign: "right" }}>Afinidade</th>
                    </tr>
                  </thead>
                  <tbody>
                    {baskets.map((b, i) => {
                      const lift = Number(b.lift) || 0;
                      const col = lift >= 1.2 ? "var(--ok)" : lift < 1 ? "var(--crit)" : "var(--fg-2)";
                      return (
                        <tr key={b.item_a + "|" + b.item_b + i}>
                          <td className="row-strong">
                            <span>{b.item_a}</span>
                            <span style={{ color: "var(--fg-3)", margin: "0 6px", fontWeight: 400 }}>+</span>
                            <span>{b.item_b}</span>
                          </td>
                          <td className="num" style={{ fontWeight: 600 }}>{_num(b.pair_orders)}</td>
                          <td className="num" style={{ fontWeight: 500 }}>{_pct((Number(b.conf_a_pct) || 0) / 100)}</td>
                          <td className="num" style={{ fontWeight: 500 }}>{_pct((Number(b.conf_b_pct) || 0) / 100)}</td>
                          <td className="num" style={{ fontWeight: 700, color: col }}>{lift.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

      </div>
    </div>
  );
}

window.Cardapio = Cardapio;
