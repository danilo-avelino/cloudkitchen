// Inventário — contagens físicas, precisão, divergências e impacto financeiro.
//
// Estrutura:
//   Inventory             → header + KPIs + gráfico + lista
//   AccuracyChart         → gráfico de linha mês a mês (SVG)
//   InventoriesList       → tabela do histórico
//   InventoryDetailModal  → painel de leitura de um inventário finalizado
//   NewInventoryModal     → wizard 3 passos: categorias → contagem → revisar
//
// Cálculos (computeInvMetrics): precisão por item = 100 − |diff|/expected · 100,
// agregado por valor financeiro do esperado (item de maior R$ pesa mais).

const _fmtBRLi   = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _fmtBRLsi  = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const _isoDateBRi = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};
const _isoTimeBRi = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// ===================== Cálculos =====================
// Precisão de um item: 0..100 baseado em erro % absoluto.
// Item ainda não contado (counted == null) → não conta no agregado (skipped).
function itemAccuracy(it) {
  if (it.counted == null) return null;
  if (it.expected <= 0) return it.counted === 0 ? 100 : 0;
  const errPct = Math.abs(it.counted - it.expected) / it.expected * 100;
  return Math.max(0, 100 - errPct);
}

// Agrega métricas de um inventário (ou de um subconjunto de itens, p/ por categoria).
function computeInvMetrics(items) {
  const counted = items.filter((it) => it.counted != null);
  const total   = counted.length;
  if (total === 0) {
    return { items: 0, matches: 0, divergences: 0, accuracy: 0, financialImpact: 0, shortage: 0, surplus: 0 };
  }
  let matches = 0, shortage = 0, surplus = 0, financialImpact = 0;
  let weightSum = 0, weightedAcc = 0;
  counted.forEach((it) => {
    const diff = (it.counted || 0) - (it.expected || 0);
    if (Math.abs(diff) < 0.001) matches += 1;
    if (diff < 0) shortage += 1;
    if (diff > 0) surplus  += 1;
    financialImpact += diff * (it.cost || 0);
    const valueWeight = Math.max(it.expected || 0, 0) * (it.cost || 0) || 1;
    weightSum   += valueWeight;
    weightedAcc += (itemAccuracy(it) || 0) * valueWeight;
  });
  const accuracy = weightSum > 0 ? weightedAcc / weightSum : 0;
  return {
    items: total,
    matches,
    divergences: total - matches,
    shortage,
    surplus,
    accuracy: Number(accuracy.toFixed(1)),
    financialImpact: Number(financialImpact.toFixed(2)),
  };
}

// Agrupa items por categoria e calcula métricas em cada grupo
function metricsByCategory(items) {
  const groups = {};
  items.forEach((it) => {
    if (!groups[it.cat]) groups[it.cat] = [];
    groups[it.cat].push(it);
  });
  return Object.entries(groups)
    .map(([cat, arr]) => ({ cat, ...computeInvMetrics(arr) }))
    .sort((a, b) => a.accuracy - b.accuracy); // pior primeiro (ranking)
}

// Pega os últimos N inventários finalizados na ordem cronológica — usado pelo
// gráfico de evolução. Cada ponto é UM inventário (não mais agregação mensal).
function buildInventoryHistory(inventories, limit = 8) {
  return (inventories || [])
    .filter((inv) => inv.status === "finalized" && inv.finished_at)
    .sort((a, b) => new Date(a.finished_at) - new Date(b.finished_at))
    .slice(-limit)
    .map((inv) => {
      const d = new Date(inv.finished_at);
      const label = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
      return { month: label, value: Number((Number(inv.score) || 0).toFixed(1)) };
    });
}

// ===================== Componente principal =====================
function Inventory() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false };
  const [inventories, setInventories] = useState(MOCK.INVENTORIES);
  const [stockItems, setStockItems] = useState(MOCK.STOCK_ITEMS);
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState("mock");
  const [creating, setCreating] = useState(false);
  const [resuming, setResuming] = useState(null); // inventário in_progress a continuar
  const [viewing,  setViewing]  = useState(null);

  // Carrega inventários + insumos do DB (se schema aplicado)
  useEffect(() => {
    if (!dbStatus.isOnline) return;
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const tid = ctx?.tenant?.id;
      setTenantId(tid || null);
      if (!tid) return;

      const [invRes, itemsRes] = await Promise.all([
        dbListInventories(tid),
        dbListStockItems(tid),
      ]);
      if (cancelled) return;

      if (invRes.data && invRes.source === "db") {
        setInventories(invRes.data);
        setSource("db");
      } else if (invRes.error) {
        // Provavelmente tabela ainda não existe (Fase 11 não aplicada)
        if (/does not exist|relation .* does not exist|42P01/i.test(invRes.error.message)) {
          console.info("[inventory] Fase 11 do schema não aplicada · usando MOCK");
        } else {
          console.warn("dbListInventories erro:", invRes.error);
        }
      }
      if (itemsRes.source === "db") {
        setStockItems(itemsRes.data || []);
      } else if (itemsRes.error) {
        console.warn("dbListStockItems erro:", itemsRes.error);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.isOnline]);

  // Métricas pro dashboard
  const finalized = useMemo(() =>
    inventories
      .filter((i) => i.status === "finalized")
      .sort((a, b) => (b.finished_at || "").localeCompare(a.finished_at || "")),
    [inventories]
  );

  const dashboardMetrics = useMemo(() => {
    const last4 = finalized.slice(0, 4);
    const avgAccuracy = last4.length > 0
      ? last4.reduce((s, i) => s + (computeInvMetrics(i.items).accuracy || 0), 0) / last4.length
      : 0;
    const lastInv     = finalized[0];
    const lastMetrics = lastInv ? computeInvMetrics(lastInv.items) : null;
    const now = new Date();
    const monthCount = inventories.filter((i) => {
      const ref = new Date(i.started_at);
      return ref.getMonth() === now.getMonth() && ref.getFullYear() === now.getFullYear();
    }).length;
    let topDivergentCat = null;
    if (lastInv) {
      const cats = metricsByCategory(lastInv.items);
      // pior precisão (já sorted asc)
      topDivergentCat = cats[0] || null;
    }
    return {
      avgAccuracy: Number(avgAccuracy.toFixed(1)),
      lastAccuracy: lastMetrics?.accuracy ?? 0,
      monthCount,
      lastDivergences: lastMetrics?.divergences ?? 0,
      topDivergentCat,
    };
  }, [inventories, finalized]);

  const handleCreateInventory = async (draft, existing = null) => {
    const today = new Date().toISOString();
    const id = existing?.id || `INV-${today.slice(0, 10)}`;
    const newInv = {
      id,
      started_at:  existing?.started_at || today,
      finished_at: draft.status === "finalized" ? today : null,
      responsible: draft.responsible || "—",
      role:        draft.role || "Estoquista",
      status:      draft.status,
      categories:  draft.categories,
      items:       draft.items,
    };
    // Se DB online + Fase 11 aplicada, persiste no banco
    if (source === "db" && tenantId) {
      const m = computeInvMetrics(draft.items);
      const payload = { ...newInv, score: m.accuracy, financialImpact: m.financialImpact };
      const { error } = existing
        ? await dbUpdateInventory(tenantId, existing.id, payload)
        : await dbInsertInventory(tenantId, payload);
      if (error) {
        window.showToast(`Erro ao salvar inventário: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
      const [{ data: refreshed }, { data: refreshedItems }] = await Promise.all([
        dbListInventories(tenantId),
        dbListStockItems(tenantId),
      ]);
      if (refreshed) setInventories(refreshed);
      if (refreshedItems) setStockItems(refreshedItems);
      setCreating(false);
      setResuming(null);
      const finalized = draft.status === "finalized";
      const label = finalized ? "finalizado" : "salvo parcialmente";
      const extra = finalized && m.divergences > 0
        ? ` · ${m.divergences} ajuste(s) aplicado(s) ao estoque`
        : "";
      window.showToast(`Inventário ${label} no Supabase · score ${m.accuracy}%${extra}`, { tone: m.divergences > 0 ? "warn" : "ok", ttl: 4500 });
      return;
    }
    // MOCK
    setInventories((prev) => existing
      ? prev.map((x) => x.id === existing.id ? newInv : x)
      : [newInv, ...prev]);
    setCreating(false);
    setResuming(null);
    if (draft.status === "finalized") {
      const m = computeInvMetrics(newInv.items);
      window.showToast(
        `Inventário ${id} finalizado · precisão ${m.accuracy}% · ${m.divergences} divergência(s)`,
        { tone: m.divergences === 0 ? "ok" : "warn", ttl: 5000 },
      );
    } else {
      window.showToast(`Inventário ${id} salvo parcialmente · finalize quando terminar`, { tone: "info", ttl: 4500 });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "auto" }}>
      {/* Header */}
      <div style={{ padding: "20px 28px 16px", display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div className="h-eyebrow" style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 10 }}>
            Contagens físicas · precisão e divergências
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase",
              padding: "2px 7px", borderRadius: 99,
              color: source === "db" ? "var(--ok)" : "var(--fg-3)",
              background: source === "db" ? "var(--accent-soft)" : "var(--bg-2)",
              border: `1px solid ${source === "db" ? "var(--accent-line)" : "var(--line)"}`,
            }} title={source === "db" ? "Inventários no Supabase (Fase 11)" : "Modo MOCK · aplique a Fase 11 do schema pra persistir"}>
              <span style={{ width: 5, height: 5, borderRadius: 50, background: source === "db" ? "var(--ok)" : "var(--fg-3)" }} />
              {source === "db" ? "Supabase" : "Mock"}
            </span>
          </div>
          <h1 className="h-title">Inventário</h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" data-variant="primary" data-size="sm" onClick={() => setCreating(true)}>
            <I.Plus size={13} />Novo Inventário
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div style={{ padding: "0 28px 18px", display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
        <InvKpi
          label="Precisão média (últ. 4)"
          value={`${dashboardMetrics.avgAccuracy}%`}
          tone={accuracyTone(dashboardMetrics.avgAccuracy)}
          accent
        />
        <InvKpi
          label="Última precisão"
          value={`${dashboardMetrics.lastAccuracy}%`}
          tone={accuracyTone(dashboardMetrics.lastAccuracy)}
        />
        <InvKpi
          label="Inventários no mês"
          value={dashboardMetrics.monthCount}
          sub="competência atual"
        />
        <InvKpi
          label="Divergências (último)"
          value={dashboardMetrics.lastDivergences}
          tone={dashboardMetrics.lastDivergences === 0 ? "ok"
              : dashboardMetrics.lastDivergences <= 2 ? "warn"
              : "crit"}
        />
        <InvKpi
          label="Pior categoria (último)"
          value={dashboardMetrics.topDivergentCat
            ? `${dashboardMetrics.topDivergentCat.cat}`
            : "—"}
          sub={dashboardMetrics.topDivergentCat
            ? `${dashboardMetrics.topDivergentCat.accuracy}% · ${dashboardMetrics.topDivergentCat.divergences} divergência(s)`
            : "sem inventários"}
          tone={dashboardMetrics.topDivergentCat ? accuracyTone(dashboardMetrics.topDivergentCat.accuracy) : "neutral"}
          smallValue
        />
      </div>

      {/* Gráfico de evolução · derivado dos inventários finalizados */}
      {(() => {
        const history = buildInventoryHistory(inventories);
        if (history.length === 0) return null;
        return (
          <div style={{ padding: "0 28px 18px" }}>
            <div className="card">
              <div className="card-header">
                <div>
                  <h3 className="card-title">Precisão por inventário</h3>
                  <span className="card-sub">últimos {history.length} {history.length === 1 ? "inventário" : "inventários"} finalizados</span>
                </div>
                <TrendBadge series={history} />
              </div>
              <div style={{ padding: "12px 16px 14px" }}>
                <AccuracyChart data={history} />
              </div>
            </div>
          </div>
        );
      })()}

      {/* Histórico */}
      <div style={{ padding: "0 28px 28px" }}>
        <InventoriesList
          inventories={inventories}
          onView={(inv) => setViewing(inv)}
          onResume={(inv) => setResuming(inv)}
        />
      </div>

      {creating && (
        <NewInventoryModal
          stockItems={stockItems}
          onCancel={() => setCreating(false)}
          onSave={handleCreateInventory}
        />
      )}
      {resuming && (
        <NewInventoryModal
          stockItems={stockItems}
          initial={resuming}
          onCancel={() => setResuming(null)}
          onSave={(draft) => handleCreateInventory(draft, resuming)}
        />
      )}
      {viewing && (
        <InventoryDetailModal
          inventory={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

// Gera HTML imprimível com lista de itens do inventário + colunas em branco
// para anotação manual no estoque físico.
function printInventorySheet(inv) {
  const items = inv.items || [];
  const dt = new Date(inv.started_at || inv.created_at || Date.now());
  const dateStr = dt.toLocaleDateString("pt-BR") + " " + dt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const esc = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));

  // Agrupa por categoria
  const byCat = {};
  items.forEach((it) => {
    const k = it.cat || "Sem categoria";
    if (!byCat[k]) byCat[k] = [];
    byCat[k].push(it);
  });
  const cats = Object.entries(byCat).sort(([a],[b]) => a.localeCompare(b));

  const sections = cats.map(([catName, catItems]) => {
    const rows = catItems.map((it, i) => {
      const expected = it.expected != null ? Number(it.expected).toLocaleString("pt-BR", { maximumFractionDigits: 3 }) : "—";
      return `<tr>
        <td class="num">${i + 1}</td>
        <td>${esc(it.name)}</td>
        <td class="num">${expected}</td>
        <td class="unit">${esc(it.unit || "un")}</td>
        <td class="count"></td>
        <td class="notes"></td>
      </tr>`;
    }).join("");
    return `<section class="cat-section">
      <h2>${esc(catName)} <span class="sub">· ${catItems.length} ${catItems.length === 1 ? "item" : "itens"}</span></h2>
      <table>
        <thead>
          <tr>
            <th class="num">#</th>
            <th>Insumo</th>
            <th class="num">Esperado</th>
            <th class="unit">Un.</th>
            <th>Contagem manual</th>
            <th>Observações</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="cat-sig">
        <div><span>Contado por:</span> ____________________________</div>
        <div><span>Data/hora:</span> _______________</div>
      </div>
    </section>`;
  }).join("");

  const html = `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8">
<title>Ficha de Conferência · ${esc(inv.id || "")}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 11px/1.4 -apple-system, "Segoe UI", sans-serif; color: #111; margin: 0; padding: 14mm 12mm; }
  h1 { font-size: 17px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 18px 0 8px; padding: 6px 10px; background: #eef; border-left: 4px solid #339; }
  h2 .sub { font-weight: 400; color: #555; font-size: 11px; margin-left: 6px; }
  .meta { font-size: 11px; color: #555; margin-bottom: 8px; display: flex; gap: 20px; flex-wrap: wrap; }
  .meta b { color: #111; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #888; padding: 5px 7px; text-align: left; vertical-align: top; font-size: 10.5px; }
  th { background: #eee; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; width: 60px; }
  td.unit, th.unit { width: 48px; text-align: center; color: #555; }
  td.count { width: 110px; background: repeating-linear-gradient(0deg, transparent, transparent 14px, #ddd 14px, #ddd 15px); }
  td.notes { width: 200px; background: repeating-linear-gradient(0deg, transparent, transparent 14px, #ddd 14px, #ddd 15px); }
  .cat-section { page-break-before: always; }
  .cat-section:first-of-type { page-break-before: auto; }
  .cat-section { page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  .cat-sig { margin-top: 12px; display: flex; gap: 30px; font-size: 10.5px; color: #555; }
  .cat-sig div { flex: 1; }
  .cat-sig span { font-weight: 600; color: #111; }
  .sig { margin-top: 24px; display: flex; gap: 30px; font-size: 10.5px; page-break-before: always; }
  .sig div { flex: 1; }
  .sig .line { border-bottom: 1px solid #000; height: 30px; }
  @media print { .noprint { display: none; } body { padding: 12mm 10mm; } }
  .noprint { margin-bottom: 10px; }
  button { padding: 8px 14px; font-size: 12px; cursor: pointer; }
</style>
</head><body>
<div class="noprint">
  <button onclick="window.print()">Imprimir</button>
  <span style="font-size:11px;color:#666;margin-left:12px">Cada categoria começa em uma página nova.</span>
</div>
<h1>Ficha de Conferência de Estoque</h1>
<div class="meta">
  <span><b>Inventário:</b> ${esc(inv.id || "—")}</span>
  <span><b>Início:</b> ${dateStr}</span>
  <span><b>Itens:</b> ${items.length}</span>
  <span><b>Categorias:</b> ${cats.length}</span>
  ${inv.notes ? `<span><b>Obs:</b> ${esc(inv.notes)}</span>` : ""}
</div>
${sections || `<p style="color:#888;text-align:center;padding:24px">Sem itens neste inventário.</p>`}
<div class="sig">
  <div><div class="line"></div>Conferente geral</div>
  <div><div class="line"></div>Revisor</div>
  <div><div class="line"></div>Data / hora final</div>
</div>
</body></html>`;

  const w = window.open("", "_blank", "width=900,height=800");
  if (!w) {
    window.showToast?.("Bloqueado pelo navegador · permita pop-ups", { tone: "crit", ttl: 4500 });
    return;
  }
  w.document.write(html);
  w.document.close();
}

function accuracyTone(pct) {
  if (pct >= 95) return "ok";
  if (pct >= 90) return "info";
  if (pct >= 80) return "warn";
  return "crit";
}

// ===================== KPI cards =====================
function InvKpi({ label, value, sub, tone, accent, smallValue }) {
  return (
    <div className="kpi" style={{
      padding: "14px 16px",
      ...(accent ? { borderColor: "var(--accent-line)", background: "linear-gradient(180deg, rgba(45,140,102,0.04), transparent 60%)" } : null),
    }}>
      <div className="label">{label}</div>
      <div className="value" style={{
        fontSize: smallValue ? 18 : 26,
        color: tone === "ok"   ? "var(--ok)"
             : tone === "info" ? "var(--info)"
             : tone === "warn" ? "var(--warn)"
             : tone === "crit" ? "var(--crit)"
             : "var(--fg-0)",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>{value}</div>
      {sub && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function TrendBadge({ series }) {
  if (!series || series.length < 2) return null;
  const last = series[series.length - 1].value;
  const prev = series[series.length - 2].value;
  const delta = last - prev;
  const tone = delta >= 0 ? "ok" : "crit";
  return (
    <span className="badge" data-tone={tone}>
      {delta >= 0 ? <I.ArrowUp size={10} /> : <I.ArrowDown size={10} />}
      {delta >= 0 ? "+" : ""}{delta.toFixed(1)} pp vs. mês anterior
    </span>
  );
}

// ===================== Gráfico de linha (SVG) =====================
// Curva suavizada por bezier cúbico (Catmull-Rom convertido), com hover e tooltip.
function AccuracyChart({ data }) {
  const W = 720, H = 140;
  const padL = 38, padR = 16, padT = 14, padB = 22;

  const [hover, setHover] = useState(null);   // { i, x, y }
  const svgRef = React.useRef(null);

  // Domínio Y: força margem em torno dos valores observados
  const minRaw = Math.min(...data.map((d) => d.value));
  const maxRaw = Math.max(...data.map((d) => d.value));
  const yMin = Math.max(0,   Math.floor((minRaw - 4) / 5) * 5);
  const yMax = Math.min(100, Math.ceil((maxRaw + 4)  / 5) * 5);

  const xOf = (i) => padL + (i / Math.max(1, data.length - 1)) * (W - padL - padR);
  const yOf = (v) => padT + (1 - (v - yMin) / Math.max(1, yMax - yMin)) * (H - padT - padB);

  const points = data.map((d, i) => ({ x: xOf(i), y: yOf(d.value), v: d.value, m: d.month, i }));

  // Path suavizado · Catmull-Rom → Bezier cúbico
  const smoothPath = (pts) => {
    if (pts.length === 0) return "";
    if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
    }
    return d;
  };
  const linePath = smoothPath(points);
  const areaPath = points.length > 0
    ? `${linePath} L ${points[points.length - 1].x},${H - padB} L ${points[0].x},${H - padB} Z`
    : "";

  // Linhas guia horizontais (grid)
  const ticks = 4;
  const yTicks = [];
  for (let i = 0; i <= ticks; i++) {
    const v = yMin + (i / ticks) * (yMax - yMin);
    yTicks.push({ v: Math.round(v), y: yOf(v) });
  }

  const handleMove = (e) => {
    if (!svgRef.current || points.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const xPx = ((e.clientX - rect.left) / rect.width) * W;
    let nearest = 0, minDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(p.x - xPx);
      if (d < minDist) { minDist = d; nearest = i; }
    });
    setHover({ i: nearest, x: points[nearest].x, y: points[nearest].y });
  };

  const tt = hover ? points[hover.i] : null;
  // Posição do tooltip ajustada nas bordas
  const ttX = tt ? Math.max(60, Math.min(W - 60, tt.x)) : 0;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      style={{ display: "block", maxWidth: "100%", overflow: "visible", cursor: "crosshair" }}
      onMouseMove={handleMove}
      onMouseLeave={() => setHover(null)}
    >
      {/* Gradiente da área */}
      <defs>
        <linearGradient id="accAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="var(--accent-bright)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--accent-bright)" stopOpacity="0.00" />
        </linearGradient>
      </defs>

      {/* Grid horizontal + labels Y */}
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={t.y} y2={t.y}
                stroke="var(--line-soft)" strokeWidth="1" strokeDasharray={i === 0 ? "" : "2 4"} />
          <text x={padL - 8} y={t.y + 3.5} textAnchor="end"
                fontFamily="var(--mono)" fontSize="9.5" fill="var(--fg-3)">{t.v}%</text>
        </g>
      ))}

      {/* Labels X */}
      {points.map((p, i) => (
        <text key={i} x={p.x} y={H - padB + 14} textAnchor="middle"
              fontFamily="var(--mono)" fontSize="9.5" fill="var(--fg-3)">{p.m}</text>
      ))}

      {/* Área */}
      <path d={areaPath} fill="url(#accAreaGrad)" />
      {/* Linha */}
      <path d={linePath} fill="none" stroke="var(--accent-bright)" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" />

      {/* Pontos */}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={hover?.i === i ? 4 : 2.4}
                fill="var(--bg-1)" stroke="var(--accent-bright)" strokeWidth="1.6" />
      ))}

      {/* Hover */}
      {tt && (
        <g pointerEvents="none">
          <line x1={tt.x} x2={tt.x} y1={padT} y2={H - padB}
                stroke="var(--fg-3)" strokeDasharray="2 4" strokeWidth="1" />
          <g transform={`translate(${ttX},${Math.max(padT + 8, tt.y - 14)})`}>
            <rect x={-50} y={-26} width={100} height={28} rx={4}
                  fill="var(--bg-2)" stroke="var(--line-strong)" />
            <text x={0} y={-13} textAnchor="middle"
                  fontFamily="var(--mono)" fontSize="10" fill="var(--fg-3)" letterSpacing="0.04em">
              {tt.m.toUpperCase()}
            </text>
            <text x={0} y={-1} textAnchor="middle"
                  fontFamily="var(--mono)" fontSize="13" fontWeight="500" fill="var(--accent-bright)">
              {tt.v.toFixed(1)}%
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}

// ===================== Lista de inventários =====================
function InventoriesList({ inventories, onView, onResume }) {
  const sorted = [...inventories].sort((a, b) =>
    (b.started_at || "").localeCompare(a.started_at || "")
  );

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">Histórico de inventários</h3>
          <span className="card-sub">{sorted.length} {sorted.length === 1 ? "registro" : "registros"} · ordenado por data</span>
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Data</th>
            <th>Responsável</th>
            <th className="num">Itens</th>
            <th className="num">Divergências</th>
            <th className="num">Precisão</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={7} className="dim" style={{ textAlign: "center", padding: 32 }}>
                Nenhum inventário registrado ainda. Comece em <strong>Novo Inventário</strong>.
              </td>
            </tr>
          ) : sorted.map((inv) => {
            const m = computeInvMetrics(inv.items);
            const isOpen = inv.status === "in_progress";
            const isCanceled = inv.status === "canceled";
            const isFinalized = inv.status === "finalized";
            return (
              <tr key={inv.id} onClick={() => onView(inv)} style={{ cursor: "pointer" }}>
                <td>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ color: "var(--fg-0)", fontSize: 12.5, fontWeight: 500 }}>
                      {_isoDateBRi(inv.started_at)}
                    </span>
                    <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
                      {inv.id} · {_isoTimeBRi(inv.started_at)}
                      {inv.finished_at ? ` → ${_isoTimeBRi(inv.finished_at)}` : ""}
                    </span>
                  </div>
                </td>
                <td>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ color: "var(--fg-1)", fontSize: 12.5 }}>{inv.responsible}</span>
                    {inv.role && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>{inv.role}</span>}
                  </div>
                </td>
                <td className="num">{m.items} <span style={{ color: "var(--fg-3)" }}>/ {inv.items.length}</span></td>
                <td className="num">
                  <span style={{ color: m.divergences > 0 ? "var(--warn)" : "var(--fg-2)", fontWeight: 500 }}>
                    {isOpen ? "—" : m.divergences}
                  </span>
                </td>
                <td className="num">
                  {isOpen ? (
                    <span className="dim">em andamento</span>
                  ) : isCanceled ? (
                    <span className="dim">—</span>
                  ) : (
                    <span className="mono" style={{ fontSize: 12, fontWeight: 500, color:
                      m.accuracy >= 95 ? "var(--ok)"
                    : m.accuracy >= 90 ? "var(--info)"
                    : m.accuracy >= 80 ? "var(--warn)"
                    : "var(--crit)" }}>
                      {m.accuracy}%
                    </span>
                  )}
                </td>
                <td>
                  <span className="badge" data-tone={
                    isOpen ? "info" : isCanceled ? "neutral" : "ok"
                  }>
                    {isOpen ? "Em andamento" : isCanceled ? "Cancelado" : "Finalizado"}
                  </span>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {isOpen ? (
                      <button className="btn" data-variant="primary" data-size="sm" onClick={() => onResume(inv)}>
                        Continuar
                      </button>
                    ) : isFinalized ? (
                      <button className="btn" data-size="sm" onClick={() => onView(inv)}>
                        Ver detalhes
                      </button>
                    ) : (
                      <span className="dim" style={{ fontSize: 11 }}>—</span>
                    )}
                    <button className="btn" data-size="sm" data-variant="ghost"
                            title="Imprimir ficha de conferência"
                            onClick={() => printInventorySheet(inv)}>
                      Imprimir ficha
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ===================== Detalhe de inventário =====================
function InventoryDetailModal({ inventory, onClose }) {
  const m   = computeInvMetrics(inventory.items);
  const cats = metricsByCategory(inventory.items);
  const isOpen     = inventory.status === "in_progress";
  const isCanceled = inventory.status === "canceled";

  return (
    <Modal
      title={isOpen ? "Inventário em andamento" : isCanceled ? "Inventário cancelado" : "Detalhes do inventário"}
      subtitle={`${inventory.id} · ${_isoDateBRi(inventory.started_at)} ${_isoTimeBRi(inventory.started_at)} · ${inventory.responsible}`}
      onClose={onClose}
      width={860}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", gap: 12 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
            {inventory.categories.length} categoria(s) · {inventory.items.length} itens no escopo
          </span>
          <button className="btn" data-variant="primary" data-size="sm" onClick={onClose}>Fechar</button>
        </div>
      }
    >
      {/* Indicadores principais */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 18 }}>
        <DetailKpi label="Precisão" value={isOpen ? "—" : `${m.accuracy}%`} tone={accuracyTone(m.accuracy)} />
        <DetailKpi label="Itens corretos" value={m.matches} sub={`${m.items} contados`} />
        <DetailKpi label="Divergências" value={m.divergences}
          sub={`${m.shortage} faltas · ${m.surplus} sobras`}
          tone={m.divergences > 0 ? "warn" : "ok"} />
        <DetailKpi
          label="Impacto financeiro"
          value={`${m.financialImpact >= 0 ? "+" : "−"}${_fmtBRLi(Math.abs(m.financialImpact)).replace("R$ ", "R$ ")}`}
          tone={m.financialImpact < 0 ? "crit" : m.financialImpact > 0 ? "info" : "ok"}
          sub={m.financialImpact < 0 ? "perda líquida" : m.financialImpact > 0 ? "sobra líquida" : "sem impacto"}
        />
      </div>

      {/* Precisão por categoria */}
      {!isOpen && cats.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <div className="h-eyebrow" style={{ marginBottom: 10 }}>Precisão por categoria</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {cats.map((c, idx) => (
              <CategoryAccuracyRow key={c.cat} rank={idx + 1} {...c} totalCats={cats.length} />
            ))}
          </div>
        </div>
      )}

      {/* Comparação de estoque */}
      <div className="h-eyebrow" style={{ marginBottom: 10 }}>Comparação · esperado × contado</div>
      <div style={{ background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4 }}>
        <table className="table" data-density="compact">
          <thead>
            <tr>
              <th>Item</th>
              <th>Categoria</th>
              <th className="num">Esperado</th>
              <th className="num">Contado</th>
              <th className="num">Diferença</th>
              <th className="num">Impacto</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {inventory.items.map((it) => {
              const counted = it.counted == null ? null : Number(it.counted);
              const diff    = counted == null ? null : counted - (it.expected || 0);
              const impact  = diff == null ? null : diff * (it.cost || 0);
              const isCrit  = counted != null && it.expected > 0 &&
                              Math.abs(diff) / it.expected >= 0.10; // ≥10% de erro
              const tone    = counted == null ? "neutral"
                            : Math.abs(diff) < 0.001 ? "ok"
                            : isCrit ? "crit"
                            : "warn";
              const lbl     = counted == null ? "Não contado"
                            : Math.abs(diff) < 0.001 ? "OK"
                            : diff < 0 ? (isCrit ? "Falta crítica" : "Falta")
                            : (isCrit ? "Sobra crítica" : "Sobra");
              return (
                <tr key={it.stock_item_id} style={{ background: isCrit ? "var(--crit-soft)" : null }}>
                  <td className="row-strong">{it.name}</td>
                  <td className="dim">{it.cat}</td>
                  <td className="num">{it.expected} {it.unit}</td>
                  <td className="num">{counted == null ? "—" : `${counted} ${it.unit}`}</td>
                  <td className="num" style={{
                    color: diff == null ? "var(--fg-3)"
                         : Math.abs(diff) < 0.001 ? "var(--fg-2)"
                         : diff < 0 ? "var(--crit)"
                         : "var(--info)",
                    fontWeight: 500,
                  }}>
                    {diff == null ? "—" : `${diff > 0 ? "+" : ""}${Number(diff.toFixed(2))} ${it.unit}`}
                  </td>
                  <td className="num" style={{
                    color: impact == null ? "var(--fg-3)"
                         : Math.abs(impact) < 0.01 ? "var(--fg-2)"
                         : impact < 0 ? "var(--crit)"
                         : "var(--info)",
                    fontWeight: 500,
                  }}>
                    {impact == null ? "—" : `${impact >= 0 ? "+" : "−"}${_fmtBRLi(Math.abs(impact)).replace("R$ ", "R$ ")}`}
                  </td>
                  <td><span className="badge" data-tone={tone}>{lbl}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function DetailKpi({ label, value, sub, tone }) {
  return (
    <div style={{
      padding: "12px 14px", background: "var(--bg-2)",
      border: "1px solid var(--line)", borderRadius: 4,
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</span>
      <span className="mono" style={{
        fontSize: 18, fontWeight: 500,
        color: tone === "ok"   ? "var(--ok)"
             : tone === "info" ? "var(--info)"
             : tone === "warn" ? "var(--warn)"
             : tone === "crit" ? "var(--crit)"
             : "var(--fg-0)",
      }}>{value}</span>
      {sub && (
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>{sub}</span>
      )}
    </div>
  );
}

function CategoryAccuracyRow({ cat, accuracy, divergences, items, financialImpact, rank, totalCats }) {
  const tone = accuracyTone(accuracy);
  const color = tone === "ok"   ? "var(--ok)"
              : tone === "info" ? "var(--info)"
              : tone === "warn" ? "var(--warn)"
              : "var(--crit)";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "32px 1fr 60px 120px 100px", gap: 12, alignItems: "center" }}>
      <span className="mono" style={{
        fontSize: 10.5, color: "var(--fg-3)", letterSpacing: "0.04em",
        fontWeight: 500, textAlign: "center",
        padding: "2px 0", background: "var(--bg-2)", borderRadius: 3,
        border: "1px solid var(--line)",
      }}>
        #{rank}
      </span>
      <div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500 }}>{cat}</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
            {items} {items === 1 ? "item" : "itens"} · {divergences} divergência(s)
          </span>
        </div>
        <div style={{ position: "relative", height: 6, background: "var(--bg-3)", borderRadius: 3, overflow: "hidden" }}>
          <div style={{
            position: "absolute", left: 0, top: 0, bottom: 0,
            width: `${accuracy}%`, background: color,
            transition: "width 220ms ease",
          }} />
        </div>
      </div>
      <span className="mono" style={{ fontSize: 13, fontWeight: 500, color, textAlign: "right" }}>
        {accuracy}%
      </span>
      <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)", textAlign: "right" }}>
        {financialImpact >= 0 ? "+" : "−"}{_fmtBRLi(Math.abs(financialImpact)).replace("R$ ", "R$ ")}
      </span>
      <div style={{
        display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4,
        fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em",
      }}>
        {rank === 1 && totalCats > 1 && <span style={{ color: "var(--crit)" }}>pior</span>}
        {rank === totalCats && totalCats > 1 && <span style={{ color: "var(--ok)" }}>melhor</span>}
      </div>
    </div>
  );
}

// ===================== Wizard de novo inventário =====================
function NewInventoryModal({ stockItems, initial, onCancel, onSave }) {
  const isResume = !!initial;
  const allCats = useMemo(() => [...new Set(stockItems.map((i) => i.cat))].sort(), [stockItems]);
  // Em modo "continuar", pula direto pra etapa de contagem e pré-carrega cats/responsável/contagens.
  const [step, setStep] = useState(isResume ? 2 : 1);
  const [selectedCats, setSelectedCats] = useState(() => initial?.categories || []);
  const [responsible,  setResponsible]  = useState(() => initial?.responsible || "");
  const [counts, setCounts] = useState(() => {
    if (!initial) return {};
    const out = {};
    (initial.items || []).forEach((it) => {
      if (it.counted != null && it.stock_item_id) out[it.stock_item_id] = it.counted;
    });
    return out;
  }); // { stock_item_id: number | null }

  // Itens do escopo (categoria selecionada)
  const scopedItems = useMemo(() =>
    stockItems
      .filter((it) => selectedCats.includes(it.cat))
      .map((it) => ({
        stock_item_id: it.id,
        name: it.name,
        cat: it.cat,
        unit: it.unit,
        expected: it.qty,
        cost: it.cost,
      })),
    [stockItems, selectedCats]
  );

  // Quando categorias mudam, podemos manter contagens já feitas para itens persistentes
  useEffect(() => {
    setCounts((prev) => {
      const keep = {};
      scopedItems.forEach((it) => {
        if (it.stock_item_id in prev) keep[it.stock_item_id] = prev[it.stock_item_id];
      });
      return keep;
    });
  }, [selectedCats]);

  const toggleCat = (c) => {
    setSelectedCats((cur) => cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]);
  };
  const selectAllCats = () => setSelectedCats(allCats);

  const setCount = (id, v) => {
    setCounts((cur) => {
      const next = { ...cur };
      if (v === "" || v == null) {
        delete next[id];
      } else {
        const n = parseFloat(String(v).replace(",", "."));
        next[id] = Number.isFinite(n) ? n : v;
      }
      return next;
    });
  };

  // Itens p/ submit, com counted preenchido a partir do state counts
  const buildItemsForSubmit = () => scopedItems.map((it) => {
    const v = counts[it.stock_item_id];
    const n = typeof v === "number" ? v
            : v == null || v === ""  ? null
            : parseFloat(String(v).replace(",", "."));
    return { ...it, counted: Number.isFinite(n) ? n : null };
  });

  const submitItems = buildItemsForSubmit();
  const filledCount = submitItems.filter((it) => it.counted != null).length;
  const allFilled   = filledCount > 0 && filledCount === submitItems.length;

  const next = () => {
    if (step === 1 && selectedCats.length === 0) {
      window.showToast("Selecione ao menos 1 categoria", { tone: "warn" });
      return;
    }
    if (step === 1 && !responsible.trim()) {
      window.showToast("Informe o responsável pela contagem", { tone: "warn" });
      return;
    }
    setStep((s) => Math.min(3, s + 1));
  };
  const back = () => setStep((s) => Math.max(1, s - 1));

  const [saving, setSaving] = useState(false);

  const savePartial = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave({
        categories: selectedCats,
        responsible: responsible.trim() || "—",
        role: "Estoquista",
        status: "in_progress",
        items: submitItems,
      });
    } finally {
      setSaving(false);
    }
  };

  const finalize = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave({
        categories: selectedCats,
        responsible: responsible.trim() || "—",
        role: "Estoquista",
        status: "finalized",
        items: submitItems,
      });
    } finally {
      setSaving(false);
    }
  };

  // Métricas da prévia (passo 3)
  const preview = computeInvMetrics(submitItems);

  return (
    <Modal
      title={isResume ? "Continuar inventário" : "Novo Inventário"}
      subtitle={`Etapa ${step} de 3 · ${step === 1 ? "Selecionar categorias" : step === 2 ? "Contagem" : "Revisar e finalizar"}`}
      onClose={onCancel}
      width={760}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", gap: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            {step > 1 && (
              <button className="btn" data-size="sm" onClick={back}>
                <I.Chevron size={11} style={{ transform: "rotate(90deg)" }} />Voltar
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" data-size="sm" onClick={onCancel} disabled={saving}>Cancelar</button>
            {step === 2 && (
              <button className="btn" data-size="sm" onClick={savePartial}
                      disabled={saving}
                      title="Salva o progresso atual (mesmo vazio) e finaliza depois">
                {saving ? "Salvando…" : "Salvar parcial"}
              </button>
            )}
            {step < 3 ? (
              <button className="btn" data-variant="primary" data-size="sm" onClick={next}
                      disabled={saving || (step === 1 && (selectedCats.length === 0 || !responsible.trim()))}>
                Avançar<I.ChevronR size={11} />
              </button>
            ) : (
              <button className="btn" data-variant="primary" data-size="sm" onClick={finalize}
                      disabled={saving || filledCount === 0}>
                <I.Check size={12} />{saving ? "Salvando…" : "Finalizar inventário"}
              </button>
            )}
          </div>
        </div>
      }
    >
      {/* Stepper */}
      <div style={{ display: "flex", gap: 4, marginBottom: 18, padding: "0 4px" }}>
        {[1, 2, 3].map((n) => (
          <div key={n} style={{
            flex: 1, height: 3, borderRadius: 2,
            background: step >= n ? "var(--accent-bright)" : "var(--bg-3)",
            transition: "background 200ms ease",
          }} />
        ))}
      </div>

      {step === 1 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <FormRow label="Responsável pela contagem">
              <input className="input" autoFocus value={responsible}
                     onChange={(e) => setResponsible(e.target.value)}
                     placeholder="Quem vai conduzir o inventário" />
            </FormRow>
            <FormRow label="Itens no escopo" hint="Calculado a partir das categorias">
              <div style={{
                padding: "6px 10px", background: "var(--bg-2)", border: "1px solid var(--line)",
                borderRadius: 4, fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-0)",
              }}>
                {scopedItems.length} {scopedItems.length === 1 ? "item" : "itens"}
              </div>
            </FormRow>
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                Categorias
              </span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>
                {selectedCats.length}/{allCats.length}
              </span>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn" data-variant="ghost" data-size="sm" onClick={selectAllCats}>
                Todas
              </button>
              <button type="button" className="btn" data-variant="ghost" data-size="sm" onClick={() => setSelectedCats([])}>
                Limpar
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
              {allCats.map((c) => {
                const on = selectedCats.includes(c);
                const itemsInCat = stockItems.filter((it) => it.cat === c).length;
                return (
                  <button
                    key={c} type="button" onClick={() => toggleCat(c)}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "8px 10px", borderRadius: 4, cursor: "pointer",
                      background:   on ? "var(--accent-soft)" : "var(--bg-2)",
                      border: `1px solid ${on ? "var(--accent-line)" : "var(--line)"}`,
                      color: on ? "var(--fg-0)" : "var(--fg-2)",
                      fontSize: 12, textAlign: "left",
                      transition: "all 120ms ease",
                    }}>
                    <span style={{
                      width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                      background: on ? "var(--accent-bright)" : "transparent",
                      border: `1px solid ${on ? "var(--accent-bright)" : "var(--line-strong)"}`,
                      display: "grid", placeItems: "center",
                    }}>
                      {on && <I.Check size={10} style={{ color: "var(--accent-fg)" }} />}
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div>{c}</div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
                        {itemsInCat} {itemsInCat === 1 ? "item" : "itens"}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <CountingStep
          scopedItems={scopedItems}
          counts={counts}
          setCount={setCount}
          filledCount={filledCount}
        />
      )}

      {step === 3 && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 18 }}>
            <DetailKpi label="Precisão prévia" value={`${preview.accuracy}%`} tone={accuracyTone(preview.accuracy)} />
            <DetailKpi label="Itens contados" value={preview.items} sub={`${scopedItems.length} no escopo`} />
            <DetailKpi label="Divergências" value={preview.divergences}
              sub={`${preview.shortage} faltas · ${preview.surplus} sobras`}
              tone={preview.divergences > 0 ? "warn" : "ok"} />
            <DetailKpi
              label="Impacto financeiro"
              value={`${preview.financialImpact >= 0 ? "+" : "−"}${_fmtBRLi(Math.abs(preview.financialImpact)).replace("R$ ", "R$ ")}`}
              tone={preview.financialImpact < 0 ? "crit" : preview.financialImpact > 0 ? "info" : "ok"}
            />
          </div>

          {!allFilled && (
            <div style={{
              padding: "10px 12px", background: "var(--warn-soft)",
              border: "1px solid var(--warn-line)", borderRadius: 4,
              display: "flex", alignItems: "center", gap: 10, marginBottom: 14,
              fontSize: 12, color: "var(--fg-1)",
            }}>
              <I.AlertTriangle size={13} style={{ color: "var(--warn)" }} />
              <span>
                <strong style={{ color: "var(--warn)" }}>{scopedItems.length - filledCount}</strong>{" "}
                {scopedItems.length - filledCount === 1 ? "item" : "itens"} sem contagem.
                Você pode <strong>finalizar mesmo assim</strong> (eles ficam como "não contados") ou voltar e contar.
              </span>
            </div>
          )}

          <div className="h-eyebrow" style={{ marginBottom: 8 }}>Resumo da contagem</div>
          <CountingTable
            items={scopedItems}
            counts={counts}
            onSetCount={setCount}
            readOnly
          />
        </div>
      )}
    </Modal>
  );
}

// Etapa 2 · Contagem com chips de categoria para focar uma categoria por vez
function CountingStep({ scopedItems, counts, setCount, filledCount }) {
  // Categorias disponíveis no escopo + contagem (preenchido / total) por categoria
  const cats = useMemo(() => {
    const map = {};
    scopedItems.forEach((it) => {
      const k = it.cat || "Sem categoria";
      if (!map[k]) map[k] = { name: k, total: 0, filled: 0 };
      map[k].total += 1;
      if (counts[it.id] != null && counts[it.id] !== "") map[k].filled += 1;
    });
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  }, [scopedItems, counts]);

  const [filterCat, setFilterCat] = useState("all");
  const visibleItems = filterCat === "all"
    ? scopedItems
    : scopedItems.filter((it) => (it.cat || "Sem categoria") === filterCat);

  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 12px", background: "var(--bg-2)",
        border: "1px solid var(--line)", borderRadius: 4,
        marginBottom: 10,
      }}>
        <I.Box size={14} style={{ color: "var(--fg-2)" }} />
        <div style={{ fontSize: 12, color: "var(--fg-1)", flex: 1 }}>
          Contagem <strong style={{ color: "var(--fg-0)" }}>às cegas</strong> · digite a quantidade sem ver o esperado.
          Filtre por categoria para conferir em blocos menores.
        </div>
        <span className="mono" style={{ fontSize: 11, color: filledCount === scopedItems.length ? "var(--ok)" : "var(--fg-2)", fontWeight: 500 }}>
          {filledCount} / {scopedItems.length}
        </span>
      </div>

      {/* Chips de categoria */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        <CatChip active={filterCat === "all"} onClick={() => setFilterCat("all")}
                 label="Todas" filled={filledCount} total={scopedItems.length} />
        {cats.map((c) => (
          <CatChip key={c.name} active={filterCat === c.name}
                   onClick={() => setFilterCat(c.name)}
                   label={c.name} filled={c.filled} total={c.total} />
        ))}
      </div>

      <CountingTable
        items={visibleItems}
        counts={counts}
        onSetCount={setCount}
        mode="blind"
      />
    </div>
  );
}

function CatChip({ active, onClick, label, filled, total }) {
  const done = filled === total && total > 0;
  return (
    <button onClick={onClick} style={{
      padding: "5px 11px",
      background: active ? "var(--accent-bright)" : (done ? "var(--ok-soft)" : "var(--bg-2)"),
      color: active ? "var(--fg-on-accent)" : (done ? "var(--ok)" : "var(--fg-1)"),
      border: `1px solid ${active ? "var(--accent-bright)" : (done ? "var(--ok-line)" : "var(--line)")}`,
      borderRadius: 99, fontSize: 11.5, cursor: "pointer",
      display: "inline-flex", alignItems: "center", gap: 6,
    }}>
      <span>{label}</span>
      <span style={{
        fontFamily: "var(--mono)", fontSize: 10,
        opacity: 0.8,
      }}>{filled}/{total}</span>
      {done && !active && <span style={{ fontSize: 10 }}>✓</span>}
    </button>
  );
}

// Tabela de contagem.
// mode "blind"  → contagem às cegas (passo 2): só Item + Contado, sem revelar esperado/divergência.
// mode "review" → leitura/revisão (passo 3, detalhe): Item + Esperado + Contado + Diferença + Estado.
function CountingTable({ items, counts, onSetCount, readOnly, mode = "review" }) {
  const blind = mode === "blind";
  // Agrupa por categoria
  const byCat = useMemo(() => {
    const g = {};
    items.forEach((it) => {
      if (!g[it.cat]) g[it.cat] = [];
      g[it.cat].push(it);
    });
    return Object.entries(g);
  }, [items]);

  const colCount = blind ? 3 : 5;

  return (
    <div style={{
      maxHeight: 360, overflow: "auto",
      background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4,
    }}>
      <table className="table" data-density="compact">
        <thead style={{ position: "sticky", top: 0, background: "var(--bg-2)", zIndex: 1 }}>
          <tr>
            <th>Item</th>
            {!blind && <th className="num">Esperado</th>}
            <th className="num">Contado</th>
            {!blind && <th className="num">Diferença</th>}
            <th>{blind ? "" : "Estado"}</th>
          </tr>
        </thead>
        <tbody>
          {byCat.map(([cat, arr]) => (
            <React.Fragment key={cat}>
              <tr>
                <td colSpan={colCount} style={{
                  background: "var(--bg-3)", padding: "5px 10px",
                  fontFamily: "var(--mono)", fontSize: 9.5,
                  color: "var(--fg-2)", letterSpacing: "0.06em",
                  textTransform: "uppercase",
                }}>
                  {cat} <span style={{ color: "var(--fg-3)" }}>· {arr.length} {arr.length === 1 ? "item" : "itens"}</span>
                </td>
              </tr>
              {arr.map((it) => {
                const raw = counts[it.stock_item_id];
                const counted = typeof raw === "number" ? raw
                              : raw == null || raw === ""  ? null
                              : parseFloat(String(raw).replace(",", "."));
                const diff    = counted == null || !Number.isFinite(counted) ? null
                              : counted - (it.expected || 0);
                const isCrit  = diff != null && it.expected > 0 &&
                                Math.abs(diff) / it.expected >= 0.10;
                const tone    = counted == null ? "neutral"
                              : Math.abs(diff || 0) < 0.001 ? "ok"
                              : isCrit ? "crit"
                              : "warn";
                const lbl     = counted == null ? "Não contado"
                              : Math.abs(diff || 0) < 0.001 ? "OK"
                              : diff < 0 ? "Falta"
                              : "Sobra";
                return (
                  <tr key={it.stock_item_id}>
                    <td className="row-strong">
                      {it.name}
                      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.04em", marginTop: 2 }}>
                        {it.stock_item_id}
                      </div>
                    </td>
                    {!blind && (
                      <td className="num" style={{ color: "var(--fg-2)" }}>{it.expected} {it.unit}</td>
                    )}
                    <td className="num">
                      {readOnly ? (
                        <span className="mono" style={{ fontWeight: 500, color: counted == null ? "var(--fg-3)" : "var(--fg-0)" }}>
                          {counted == null ? "—" : `${counted} ${it.unit}`}
                        </span>
                      ) : (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                          <input
                            className="input mono" inputMode="decimal"
                            value={raw == null ? "" : String(raw)}
                            placeholder="0"
                            onChange={(e) => onSetCount(it.stock_item_id, e.target.value)}
                            style={{ width: 88, textAlign: "right", padding: "4px 6px" }}
                          />
                          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-3)", minWidth: 22 }}>
                            {it.unit}
                          </span>
                        </div>
                      )}
                    </td>
                    {!blind && (
                      <td className="num" style={{
                        color: diff == null ? "var(--fg-3)"
                             : Math.abs(diff) < 0.001 ? "var(--fg-2)"
                             : diff < 0 ? "var(--crit)"
                             : "var(--info)",
                        fontWeight: 500,
                      }}>
                        {diff == null ? "—" : `${diff > 0 ? "+" : ""}${Number(diff.toFixed(2))} ${it.unit}`}
                      </td>
                    )}
                    <td>
                      {blind ? (
                        // Indicador minimalista — só "preenchido" ou vazio,
                        // sem revelar se está OK/falta/sobra.
                        counted == null
                          ? <span style={{
                              display: "inline-block", width: 8, height: 8, borderRadius: 50,
                              background: "var(--bg-3)", border: "1px solid var(--line-strong)",
                            }} title="Não preenchido" />
                          : <span style={{
                              display: "inline-block", width: 8, height: 8, borderRadius: 50,
                              background: "var(--accent-bright)",
                            }} title="Preenchido" />
                      ) : (
                        <span className="badge" data-tone={tone}>{lbl}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

window.Inventory = Inventory;
