// DRE & Fechamento — visão contábil + validação de fechamento mensal +
// comparativo anual da DRE mês a mês.
//
// Este módulo foi destacado do antigo "Financeiro & DRE" para separar a parte
// de gestão de caixa (Lançamentos + Checklist em page-finance.jsx) da parte
// contábil (DRE estruturada + auditoria de fechamento).
//
// Helpers compartilhados (fmt, monthOf, findCategory, etc.) ficam no
// page-finance.jsx e são consumidos via globais (window.*) — page-finance.jsx
// é importado antes deste arquivo em src/main.jsx.

// ---------- Helpers locais ao DRE ----------

const MONTH_LABELS_PT_DRE = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function dre_periodRange(period) {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return null;
  const start = `${period}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${period}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

function isPeriodClosed(closedPeriods, period) {
  return (closedPeriods || []).some((c) => c.period === period);
}

// Auto-feed do Ajuste de estoque · entries sintéticos vindos de inventários.
// Só é gerado em modo MOCK; em DB online, vem dos inventários reais.
function buildStockAdjustEntries(period) {
  if (typeof isDbOnline === "function" && isDbOnline()) return [];
  const list = MOCK.INVENTORIES || [];
  const out = [];
  list.forEach((inv) => {
    if (inv.status !== "finalized") return;
    if ((inv.finished_at || "").slice(0, 7) !== period) return;
    const counted = (inv.items || []).filter((it) => it.counted != null);
    if (counted.length === 0) return;
    const impact = counted.reduce((s, it) => s + ((it.counted - it.expected) * (it.cost || 0)), 0);
    if (Math.abs(impact) < 0.01) return;
    out.push({
      id:    `AUTO-INV-${inv.id}`,
      cat:   "cat-29",
      desc:  `Inventário ${inv.id} · ${inv.responsible || "—"}`,
      value: -impact,
      comp:  inv.finished_at ? inv.finished_at.slice(0, 10) : null,
      paid:  inv.finished_at ? inv.finished_at.slice(0, 10) : null,
      status: "auto",
      auto:  "stock-adjust",
    });
  });
  return out;
}

// Mapeia o enum revenue_entries.source → nome da subcategoria DRE esperada.
const REVENUE_SOURCE_TO_SUB = {
  ifood:  ["Delivery", "iFood"],
  rappi:  ["Delivery", "Rappi"],
  pdv:    ["Salão", "PDV", "Balcão"],
  balcao: ["Salão", "Balcão"],
  manual: ["Delivery", "Manual"],
  outro:  [],
};

function resolveRevenueSubId(source, subcategories, revenueCats) {
  const candidates = REVENUE_SOURCE_TO_SUB[source] || [];
  const revSubs = subcategories.filter((s) => revenueCats.includes(s.category));
  for (const want of candidates) {
    const match = revSubs.find((s) => (s.name || s.label || "").toLowerCase() === want.toLowerCase());
    if (match) return match.id;
  }
  return revSubs[0]?.id || null;
}

// Pure helper · agrega entries+revenue+snapshot num único summary da DRE.
function computeDreSummary({ entries, categories, subcategories, period, stockSnapshot = { initial: 0, final: 0 }, revenueEntries = [], source = "mock" }) {
  const monthOf = window.monthOf;
  const findCategory = window.findCategory;
  const findSubcategory = window.findSubcategory;

  const byCat = {};
  categories.forEach((c) => { byCat[c.id] = { total: 0, bySub: {} }; });
  entries.forEach((e) => {
    const sub = findSubcategory(subcategories, e.cat);
    if (!sub) return;
    // Lançamentos em subs autofeed são ignorados: a linha "Ajuste de estoque"
    // é calculada abaixo como EI − EF (método contábil). Cobre o mock e os
    // lançamentos legados do trigger de inventário (lançava sobra como custo).
    if (sub.autofeed) return;
    if (!byCat[sub.category]) return;
    const cat = findCategory(categories, sub.category);
    if (cat?.kind === "revenue") return;
    byCat[sub.category].total += e.value;
    byCat[sub.category].bySub[sub.id] = (byCat[sub.category].bySub[sub.id] || 0) + e.value;
  });

  // Garante que subcategorias autofeed sempre apareçam, mesmo sem dados no período.
  subcategories.forEach((sub) => {
    if (!sub.autofeed) return;
    if (!byCat[sub.category]) return;
    if (!(sub.id in byCat[sub.category].bySub)) {
      byCat[sub.category].bySub[sub.id] = 0;
    }
  });

  // Receita
  const revBySub = {};
  const revenueCatIds = categories.filter((c) => c.kind === "revenue").map((c) => c.id);
  const revSource = source === "db" ? revenueEntries : MOCK.REVENUE_ENTRIES;
  revSource.forEach((e) => {
    if (monthOf(e.date) !== period) return;
    const subId = source === "db"
      ? resolveRevenueSubId(e.source, subcategories, revenueCatIds)
      : (e.source === "ifood" ? "cat-01" : e.source === "rappi" ? "cat-02" : "cat-03");
    if (!subId) return;
    revBySub[subId] = (revBySub[subId] || 0) + (Number(e.revenue) || 0);
  });
  const revenueTotal = Object.values(revBySub).reduce((s, v) => s + v, 0);
  const revenueCatKey = revenueCatIds[0] || "receita";
  byCat[revenueCatKey] = { total: revenueTotal, bySub: revBySub };

  // CMV real (contábil) = EI + Compras − EF.
  const dbOn = typeof isDbOnline === "function" && isDbOnline();
  const ei = dbOn ? (stockSnapshot.initial || 0) : (MOCK.STOCK_BALANCE?.initial?.value || 0);
  const ef = ei > 0
    ? (dbOn ? (stockSnapshot.final || 0) : (MOCK.STOCK_BALANCE?.final?.value || 0))
    : 0;
  const cmvCatIds = categories
    .filter((c) => c.kind === "cogs" || c.groupSlug === "cmv" || c.id === "cmv")
    .map((c) => c.id);
  const comprasTotal = subcategories
    .filter((s) => cmvCatIds.includes(s.category) && !s.autofeed)
    .reduce((acc, sub) => {
      const catBucket = cmvCatIds.map((cid) => byCat[cid]).find(Boolean);
      return acc + ((catBucket?.bySub?.[sub.id]) || 0);
    }, 0);
  const cmvReal = ei + comprasTotal - ef;

  // Linha autofeed "Ajuste de estoque" = variação do estoque (EI − EF).
  // Com ela, o Custo de Mercadoria da tabela fecha exato com o CMV real do
  // quadro contábil: compras + (EI − EF) = EI + compras − EF.
  const stockDelta = ei > 0 ? ei - ef : 0;
  const adjustSub = subcategories.find((s) => s.autofeed && cmvCatIds.includes(s.category));
  if (adjustSub && byCat[adjustSub.category]) {
    byCat[adjustSub.category].bySub[adjustSub.id] = stockDelta;
    byCat[adjustSub.category].total += stockDelta;
  }

  const sumByKind = (kinds) => categories
    .filter((c) => kinds.includes(c.kind))
    .reduce((s, c) => s + (byCat[c.id]?.total || 0), 0);

  const receita    = byCat[revenueCatKey]?.total || 0;
  const deducoes   = sumByKind(["deduction"]);
  const receitaLiq = receita - deducoes;
  const cogs       = sumByKind(["cogs"]);
  const lucroBruto = receitaLiq - cogs;
  const opexExpense   = sumByKind(["expense"]);
  const opexFinancial = sumByKind(["financial"]);
  const opex       = opexExpense + opexFinancial;
  const lucroLiq   = lucroBruto - opex;

  return {
    byCat, revenueCatKey,
    receita, deducoes, receitaLiq, cogs, lucroBruto,
    opex, opexExpense, opexFinancial, lucroLiq,
    ei, ef, comprasTotal, cmvReal,
  };
}

// ---------- Exportar DRE (PDF via diálogo de impressão) ----------
// Monta um documento A4 standalone e abre em nova janela com window.print() —
// o usuário salva como PDF. Documento separado de propósito: o CSS de
// impressão do app (styles.css) é para cupom térmico 80mm e quebraria a DRE.
function buildDreExportHtml({ summary, categories, subcategories, periodLabel, entryCount, tenantName, stockSnapshot }) {
  const fmt = window.fmt;
  const fmtDate = window.fmtDate;
  const { byCat, receita, receitaLiq, lucroBruto, lucroLiq, ei, ef, comprasTotal, cmvReal } = summary;
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pct = (v) => receita > 0 ? ((v / receita) * 100).toFixed(1) + "%" : "—";

  const sorted = [...categories].sort((a, b) => a.order - b.order);
  const above  = sorted.filter((c) => ["revenue", "deduction", "cogs"].includes(c.kind));
  const below  = sorted.filter((c) => ["expense", "financial"].includes(c.kind));

  // Mesma lógica de exibição do DreRow: sinal na frente, valor sempre absoluto.
  const catRows = (cats) => cats.map((c) => {
    const sign = c.kind === "revenue" ? "+" : "−";
    const value = byCat[c.id]?.total || 0;
    const display = sign === "−" && value > 0 ? `−${fmt(value)}` : value < 0 ? `+${fmt(-value)}` : fmt(value);
    const subRows = Object.entries(byCat[c.id]?.bySub || {})
      .filter(([, v]) => Math.abs(v) > 0.005)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .map(([subId, val]) => {
        const sub = subcategories.find((s) => s.id === subId);
        if (!sub) return "";
        return `<tr class="sub"><td>${esc(sub.name)}</td><td class="num">${val < 0 ? "+" : ""}${fmt(Math.abs(val))}</td><td class="num">${pct(Math.abs(val))}</td></tr>`;
      }).join("");
    return `<tr class="cat"><td>${sign === "−" ? "(−) " : ""}${esc(c.name)}</td><td class="num">${display}</td><td class="num">${pct(value)}</td></tr>${subRows}`;
  }).join("");

  const totalRow = (label, value, grand) =>
    `<tr class="total${grand ? " grand" : ""}${value < 0 ? " neg" : ""}"><td>= ${label}</td><td class="num">${fmt(value)}</td><td class="num">${pct(value)}</td></tr>`;

  const now = new Date();
  const genAt = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const cmvCells = ei > 0
    ? `<div><span>EI${stockSnapshot?.initialAt ? ` · ${fmtDate(stockSnapshot.initialAt)}` : ""}</span><b>${fmt(ei)}</b></div>
       <div><span>(+) Compras</span><b>${fmt(comprasTotal)}</b></div>
       <div><span>EF${stockSnapshot?.finalAt ? ` · ${fmtDate(stockSnapshot.finalAt)}` : ""}</span><b>${fmt(ef)}</b></div>`
    : `<div><span>(+) Compras · sem inventário inicial</span><b>${fmt(comprasTotal)}</b></div>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>DRE ${esc(periodLabel)}${tenantName ? ` · ${esc(tenantName)}` : ""}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 11px/1.45 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #16181c; background: #fff; }
  .toolbar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #f3f4f6; border-bottom: 1px solid #dfe2e6; }
  .toolbar button { font: 600 12px/1 inherit; padding: 8px 16px; border: 0; border-radius: 5px; background: #1a6d4a; color: #fff; cursor: pointer; }
  .toolbar span { font-size: 11px; color: #6a7077; }
  /* largura fixa = área útil do A4 (210 − 2×10mm) p/ a medição de altura no
     load valer também na impressão · o zoom de auto-ajuste escala a partir dela */
  main { width: 190mm; margin: 0 auto; padding: 16px 0 0; }
  h1 { font-size: 19px; margin: 0; letter-spacing: -0.01em; }
  .meta { font-size: 10.5px; color: #6a7077; margin-top: 4px; }
  .cmv { display: flex; gap: 24px; align-items: flex-end; border: 1px solid #dfe2e6; border-radius: 5px; padding: 10px 14px; margin: 16px 0 18px; }
  .cmv .formula { flex: 1; }
  .cmv .formula em { font-style: normal; font-size: 9px; color: #6a7077; text-transform: uppercase; letter-spacing: 0.06em; display: block; }
  .cmv .formula b { font-size: 11px; font-weight: 500; }
  .cmv > div:not(.formula) span { display: block; font-size: 8.5px; color: #6a7077; text-transform: uppercase; letter-spacing: 0.05em; }
  .cmv > div:not(.formula) b { font-size: 12.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .cmv .res b { color: #1a6d4a; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 8.5px; color: #6a7077; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; padding: 6px 8px; border-bottom: 1.5px solid #16181c; }
  td { padding: 4px 8px; border-bottom: 1px solid #eceef0; vertical-align: baseline; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr.cat td:first-child { font-weight: 600; }
  tr.sub td:first-child { padding-left: 26px; color: #555b62; font-size: 10.5px; }
  tr.sub td { border-bottom: 1px dotted #eceef0; color: #555b62; }
  tr.total td { font-weight: 600; background: #f5f6f7; border-bottom: 1px solid #dfe2e6; }
  tr.total.grand td { font-size: 12px; border-top: 1.5px solid #16181c; border-bottom: 0; background: #eef5f1; }
  tr.total.neg td { color: #963535; }
  tr { break-inside: avoid; }
  footer { margin-top: 12px; font-size: 9.5px; color: #9aa0a6; display: flex; justify-content: space-between; }
  @media print { .toolbar { display: none; } main { padding: 0; } }
</style>
</head>
<body>
<div class="toolbar">
  <button onclick="window.print()">Imprimir / Salvar PDF</button>
  <span>No diálogo de impressão, escolha o destino "Salvar como PDF".</span>
</div>
<main>
  <h1>DRE — Demonstração do Resultado</h1>
  <div class="meta">${tenantName ? `${esc(tenantName)} · ` : ""}Competência ${esc(periodLabel)} · ${entryCount} lançamentos · por data de competência</div>
  <div class="cmv">
    <div class="formula">
      <em>CMV real · método contábil</em>
      <b>${ei > 0 ? "Estoque inicial + Compras − Estoque final" : "Compras (sem inventário inicial)"}</b>
    </div>
    ${cmvCells}
    <div class="res"><span>= CMV real</span><b>${fmt(cmvReal)}</b></div>
  </div>
  <table>
    <thead><tr><th>Conta</th><th class="num">Valor</th><th class="num">% receita</th></tr></thead>
    <tbody>
      ${catRows(above)}
      ${totalRow("Receita líquida", receitaLiq)}
      ${totalRow("Lucro bruto", lucroBruto)}
      ${catRows(below)}
      ${totalRow("Lucro líquido", lucroLiq, true)}
    </tbody>
  </table>
  <footer><span>Gerado pelo Cloud Kitchen</span><span>${genAt}</span></footer>
</main>
<script>
// Auto-ajuste: se o conteúdo passar da altura útil do A4, encolhe via zoom
// proporcional para caber em UMA página (piso de 0.5 p/ manter legível).
window.addEventListener("load", function () {
  var main = document.querySelector("main");
  var availPx = (297 - 20) * 96 / 25.4; // altura útil do A4 (margens de 10mm) em px CSS
  var needPx = main.scrollHeight;
  if (needPx > availPx) main.style.zoom = Math.max(0.5, (availPx / needPx).toFixed(3));
  setTimeout(function () { window.print(); }, 300);
});
</script>
</body>
</html>`;
}

// Carrega DRE de todos os 12 meses de um ano (paralelo).
async function loadYearSummaries({ year, tenantId, categories, subcategories, source }) {
  const monthOf = window.monthOf;
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const dbOn = source === "db" && tenantId && typeof dbListFinanceEntries === "function";

  if (dbOn) {
    const fetches = months.map(async (period) => {
      const range = dre_periodRange(period);
      const [entriesRes, revRes, snapRes] = await Promise.all([
        dbListFinanceEntries(tenantId, period),
        dbListRevenueEntries(tenantId, range.start, range.end),
        dbGetStockValueSnapshots(tenantId, period),
      ]);
      const summary = computeDreSummary({
        entries: entriesRes?.data || [],
        revenueEntries: revRes?.data || [],
        stockSnapshot: snapRes?.data || { initial: 0, final: 0 },
        categories, subcategories, period, source: "db",
      });
      return [period, summary];
    });
    const results = await Promise.all(fetches);
    return Object.fromEntries(results);
  }

  const allEntries = MOCK.ENTRIES || [];
  const allRevenue = MOCK.REVENUE_ENTRIES || [];
  const result = {};
  months.forEach((period) => {
    const entries = allEntries.filter((e) => monthOf(e.comp) === period);
    const summary = computeDreSummary({
      entries, revenueEntries: allRevenue,
      stockSnapshot: { initial: 0, final: 0 },
      categories, subcategories, period, source: "mock",
    });
    result[period] = summary;
  });
  return result;
}

// ---------- Componente principal ----------

function Dre() {
  const fmt        = window.fmt;
  const fmtDate    = window.fmtDate;
  const findSubcategory = window.findSubcategory;
  const findCategory    = window.findCategory;
  const monthOf    = window.monthOf;
  const subsByCategory  = window.subsByCategory;
  const DRE_SUB_COLORS  = window.DRE_SUB_COLORS;

  const [tab, setTab] = useState("dre");
  const [period, setPeriod] = useState(() => window.currentPeriod());
  const periodOptions = useMemo(() => window.buildPeriodOptions(12), []);
  const [entries, setEntries] = useState(MOCK.ENTRIES);
  const [categories,    setCategories]    = useState(MOCK.DRE_CATEGORIES);
  const [subcategories, setSubcategories] = useState(MOCK.DRE_SUBCATEGORIES);
  const [checklist, setChecklist] = useState(MOCK.CLOSING_CHECKLIST);
  const [revenueEntries, setRevenueEntries] = useState([]);
  const [stockSnapshot, setStockSnapshot] = useState({ initial: 0, final: 0, initialAt: null, finalAt: null });
  const [closedPeriods, setClosedPeriods] = useState([]);
  const [viewingSub, setViewingSub] = useState(null);
  const [editingEntry, setEditingEntry] = useState(null);
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState(null);
  const [confirmClosePeriod, setConfirmClosePeriod] = useState(null);
  const [confirmReopenPeriod, setConfirmReopenPeriod] = useState(null);
  const [showStructure, setShowStructure] = useState(false);
  const [exporting, setExporting] = useState(false);

  const dbStatus = useDbStatus?.() || { isOnline: false, state: "offline" };
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState("mock");
  const [pageLoading, setPageLoading] = useState(true);

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

        const [catsRes, subsRes, entriesRes, checkRes, snapRes, revRes, closedRes] = await Promise.all([
          dbListDreCategories?.(tid) || { data: null },
          dbListDreSubcategories?.(tid) || { data: null },
          dbListFinanceEntries?.(tid, period) || { data: null },
          dbListClosingChecklist?.(tid, period) || { data: null },
          dbGetStockValueSnapshots?.(tid, period) || { data: null },
          dbListRevenueEntries?.(tid, rangeStart, rangeEnd) || { data: null },
          dbListClosedPeriods?.(tid) || { data: null },
        ]);
        if (cancelled) return;
        if (catsRes.data) { setCategories(catsRes.data); setSource("db"); }
        if (subsRes.data) setSubcategories(subsRes.data);
        if (entriesRes.data) setEntries(entriesRes.data);
        if (checkRes.data) setChecklist(checkRes.data);
        if (snapRes.data) setStockSnapshot(snapRes.data);
        if (revRes.data)  setRevenueEntries(revRes.data);
        if (closedRes.data) setClosedPeriods(closedRes.data);
      } finally {
        if (!cancelled) setPageLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline, period]);

  // Auto-feed do ajuste de estoque (só em mock)
  const autoEntries = useMemo(() => buildStockAdjustEntries(period), [period]);
  const allEntries  = useMemo(() => [...entries, ...autoEntries], [entries, autoEntries]);
  const inPeriod    = useMemo(() =>
    allEntries.filter((e) => monthOf(e.comp) === period),
  [allEntries, period, monthOf]);

  // Status do checklist derivado por competência (mesma regra do Financeiro).
  const checklistForPeriod = useMemo(() => {
    const visible = checklist.filter((c) => !c.startPeriod || c.startPeriod <= period);
    return visible.map((c) => {
      const linked = inPeriod.filter((e) => e.checklistItemId === c.id);
      if (linked.length > 0) {
        const total = linked.reduce((s, e) => s + (Number(e.value) || 0), 0);
        return { ...c, status: "filled", actual: total, entryIds: linked.map((e) => e.id) };
      }
      if (c.status === "filled" && (!c.entryIds || c.entryIds.length === 0)) {
        const fallback = c.expected > 0 ? "estimated" : "pending";
        return { ...c, status: fallback, actual: null, entryIds: [] };
      }
      return c;
    });
  }, [checklist, inPeriod, period]);

  // CRUD de lançamentos (necessário pra editar a partir do SubEntriesModal)
  const updateEntry = async (id, patch) => {
    if (dbStatus.isOnline && tenantId && typeof dbUpdateFinanceEntry === "function") {
      const { error } = await dbUpdateFinanceEntry(id, patch);
      if (error) {
        window.showToast?.(`Erro ao atualizar: ${error.message}`, { tone: "crit", ttl: 4500 });
        return false;
      }
      const refreshed = await dbListFinanceEntries?.(tenantId, period);
      if (refreshed?.data) setEntries(refreshed.data);
      setEditingEntry(null);
      window.showToast?.("Lançamento atualizado", { tone: "ok" });
      return true;
    }
    setEntries(entries.map((x) => x.id === id ? { ...x, ...patch } : x));
    setEditingEntry(null);
    window.showToast?.("Lançamento atualizado (offline)", { tone: "warn" });
    return true;
  };

  const deleteEntry = async (id) => {
    if (dbStatus.isOnline && tenantId && typeof dbDeleteFinanceEntry === "function") {
      const { error } = await dbDeleteFinanceEntry(id);
      if (error) {
        window.showToast?.(`Erro ao excluir: ${error.message}`, { tone: "crit", ttl: 4500 });
        return false;
      }
      const refreshed = await dbListFinanceEntries?.(tenantId, period);
      if (refreshed?.data) setEntries(refreshed.data);
      setConfirmDeleteEntry(null);
      setEditingEntry(null);
      window.showToast?.("Lançamento excluído", { tone: "warn" });
      return true;
    }
    setEntries(entries.filter((x) => x.id !== id));
    setConfirmDeleteEntry(null);
    setEditingEntry(null);
    window.showToast?.("Lançamento excluído (offline)", { tone: "warn" });
    return true;
  };

  // Fechamento mensal
  const closePeriod = async (p) => {
    if (dbStatus.isOnline && tenantId && typeof dbClosePeriod === "function") {
      const { data, error } = await dbClosePeriod(tenantId, p);
      if (error) {
        window.showToast?.(`Erro ao fechar mês: ${error.message}`, { tone: "crit", ttl: 4500 });
        return false;
      }
      const refreshed = await dbListClosedPeriods?.(tenantId);
      if (refreshed?.data) setClosedPeriods(refreshed.data);
      else if (data)       setClosedPeriods([data, ...closedPeriods]);
      setConfirmClosePeriod(null);
      window.showToast?.(`Mês ${p.replace("-", "/")} fechado`, { tone: "ok" });
      return true;
    }
    setClosedPeriods([{ period: p, closed_at: new Date().toISOString(), closed_by: null, notes: null }, ...closedPeriods]);
    setConfirmClosePeriod(null);
    window.showToast?.(`Mês ${p.replace("-", "/")} fechado (offline)`, { tone: "warn" });
    return true;
  };

  const reopenPeriod = async (p) => {
    if (dbStatus.isOnline && tenantId && typeof dbReopenPeriod === "function") {
      const { error } = await dbReopenPeriod(tenantId, p);
      if (error) {
        window.showToast?.(`Erro ao reabrir mês: ${error.message}`, { tone: "crit", ttl: 4500 });
        return false;
      }
      const refreshed = await dbListClosedPeriods?.(tenantId);
      if (refreshed?.data) setClosedPeriods(refreshed.data);
      setConfirmReopenPeriod(null);
      window.showToast?.(`Mês ${p.replace("-", "/")} reaberto`, { tone: "warn" });
      return true;
    }
    setClosedPeriods(closedPeriods.filter((c) => c.period !== p));
    setConfirmReopenPeriod(null);
    window.showToast?.(`Mês ${p.replace("-", "/")} reaberto (offline)`, { tone: "warn" });
    return true;
  };

  // CRUD da estrutura DRE
  // Caminho DB (online) persiste em dre_categories/dre_subcategories e refaz
  // a lista a partir do Supabase pra manter o front em sync com o mapping
  // (group→kind/groupSlug/order) feito em dbListDre*. Caminho mock mantém o
  // comportamento antigo só em memória.
  const dbOn = dbStatus.isOnline && !!tenantId;
  const refreshCategories = async () => {
    if (!tenantId) return;
    const { data } = await dbListDreCategories(tenantId);
    if (data) setCategories(data);
  };
  const refreshSubcategories = async () => {
    if (!tenantId) return;
    const { data } = await dbListDreSubcategories(tenantId);
    if (data) setSubcategories(data);
  };

  const createCategory = async (data) => {
    if (dbOn && typeof dbInsertDreCategory === "function") {
      const order = categories.length > 0 ? Math.max(...categories.map((c) => c.order || 0)) + 1 : 1;
      const { error } = await dbInsertDreCategory(tenantId, { name: data.name, kind: data.kind, sort_order: order });
      if (error) { window.showToast(`Erro ao criar categoria: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
      await refreshCategories();
      window.showToast(`Categoria "${data.name}" criada`, { tone: "ok" });
      return;
    }
    const slug = String(data.name || "")
      .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const id = `usr-${slug}-${Date.now().toString(36).slice(-4)}`;
    const order = categories.length > 0 ? Math.max(...categories.map((c) => c.order)) + 1 : 1;
    setCategories([...categories, { id, name: data.name.trim(), kind: data.kind, order, locked: false }]);
    window.showToast(`Categoria "${data.name}" criada (offline)`, { tone: "warn" });
  };
  const renameCategory = async (id, newName) => {
    if (dbOn && typeof dbUpdateDreCategory === "function") {
      const { error } = await dbUpdateDreCategory(id, { name: newName });
      if (error) { window.showToast(`Erro ao renomear: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
      await refreshCategories();
      return;
    }
    setCategories(categories.map((c) => c.id === id ? { ...c, name: newName.trim() } : c));
  };
  const deleteCategory = async (id) => {
    const cat = categories.find((c) => c.id === id);
    if (!cat || cat.locked) return;
    const subsCount = subcategories.filter((s) => s.category === id).length;
    if (subsCount > 0) {
      window.showToast(`Mova as ${subsCount} subcategoria(s) antes de excluir`, { tone: "warn", ttl: 4500 });
      return;
    }
    if (dbOn && typeof dbDeleteDreCategory === "function") {
      const { error } = await dbDeleteDreCategory(id);
      if (error) { window.showToast(`Erro ao excluir: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
      await refreshCategories();
      window.showToast(`Categoria "${cat.name}" excluída`, { tone: "warn" });
      return;
    }
    setCategories(categories.filter((c) => c.id !== id));
    window.showToast(`Categoria "${cat.name}" excluída (offline)`, { tone: "warn" });
  };
  const moveCategory = async (id, dir) => {
    const sorted = [...categories].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    const idx = sorted.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const target = dir === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= sorted.length) return;
    const a = sorted[idx], b = sorted[target];
    if (dbOn && typeof dbUpdateDreCategory === "function") {
      const [resA, resB] = await Promise.all([
        dbUpdateDreCategory(a.id, { sort_order: b.order ?? 99 }),
        dbUpdateDreCategory(b.id, { sort_order: a.order ?? 99 }),
      ]);
      if (resA.error || resB.error) {
        window.showToast(`Erro ao reordenar: ${(resA.error || resB.error).message}`, { tone: "crit", ttl: 4500 });
        return;
      }
      await refreshCategories();
      return;
    }
    const next = [...categories];
    const ai = next.findIndex((c) => c.id === a.id);
    const bi = next.findIndex((c) => c.id === b.id);
    [next[ai].order, next[bi].order] = [next[bi].order, next[ai].order];
    setCategories(next);
  };
  const createSubcategory = async (data) => {
    const color = data.color || DRE_SUB_COLORS[(subcategories.length) % DRE_SUB_COLORS.length];
    if (dbOn && typeof dbInsertDreSubcategory === "function") {
      const siblings = subcategories.filter((s) => s.category === data.category);
      const order = siblings.length > 0 ? Math.max(...siblings.map((s) => s.order || 0)) + 1 : 1;
      const { error } = await dbInsertDreSubcategory(tenantId, {
        categoryId: data.category, name: data.name, color, sort_order: order,
      });
      if (error) { window.showToast(`Erro ao criar subcategoria: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
      await refreshSubcategories();
      window.showToast(`Subcategoria "${data.name}" criada`, { tone: "ok" });
      return;
    }
    const slug = String(data.name || "")
      .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const id = `usr-sub-${slug}-${Date.now().toString(36).slice(-4)}`;
    setSubcategories([...subcategories, { id, name: data.name.trim(), category: data.category, color, locked: false }]);
    window.showToast(`Subcategoria "${data.name}" criada (offline)`, { tone: "warn" });
  };
  const renameSubcategory = async (id, newName) => {
    if (dbOn && typeof dbUpdateDreSubcategory === "function") {
      const { error } = await dbUpdateDreSubcategory(id, { name: newName });
      if (error) { window.showToast(`Erro ao renomear: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
      await refreshSubcategories();
      return;
    }
    setSubcategories(subcategories.map((s) => s.id === id ? { ...s, name: newName.trim() } : s));
  };
  const recolorSubcategory = async (id, color) => {
    if (dbOn && typeof dbUpdateDreSubcategory === "function") {
      const { error } = await dbUpdateDreSubcategory(id, { color });
      if (error) { window.showToast(`Erro ao trocar cor: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
      await refreshSubcategories();
      return;
    }
    setSubcategories(subcategories.map((s) => s.id === id ? { ...s, color } : s));
  };
  const deleteSubcategory = async (id) => {
    const sub = subcategories.find((s) => s.id === id);
    if (!sub || sub.locked) return;
    const usage = entries.filter((e) => e.cat === id).length;
    if (usage > 0) {
      window.showToast(`Há ${usage} lançamento(s) nessa subcategoria · migre antes`, { tone: "warn", ttl: 4500 });
      return;
    }
    if (dbOn && typeof dbDeleteDreSubcategory === "function") {
      const { error } = await dbDeleteDreSubcategory(id);
      if (error) { window.showToast(`Erro ao excluir: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
      await refreshSubcategories();
      window.showToast(`Subcategoria "${sub.name}" excluída`, { tone: "warn" });
      return;
    }
    setSubcategories(subcategories.filter((s) => s.id !== id));
    window.showToast(`Subcategoria "${sub.name}" excluída (offline)`, { tone: "warn" });
  };

  const exportDre = () => {
    if (exporting) return;
    setExporting(true);
    try {
      const summary = computeDreSummary({ entries: inPeriod, categories, subcategories, period, stockSnapshot, revenueEntries, source });
      const periodLabel = periodOptions.find((o) => o.value === period)?.label || period.replace("-", "/");
      const tenantName = (typeof getSession === "function" && getSession()?.tenantName) || null;
      const html = buildDreExportHtml({
        summary, categories, subcategories, periodLabel,
        entryCount: inPeriod.length, tenantName, stockSnapshot,
      });
      const w = window.open("", "_blank");
      if (!w) {
        window.showToast("Pop-up bloqueado pelo navegador · permita pop-ups para exportar", { tone: "warn", ttl: 4500 });
        return;
      }
      w.document.open();
      w.document.write(html);
      w.document.close();
    } finally {
      // janela de impressão já aberta · solta o guard depois de um respiro
      setTimeout(() => setExporting(false), 800);
    }
  };

  if (pageLoading) return <PageLoading label="Carregando DRE…" variant="table" />;

  const ConfirmDialog = window.ConfirmDialog;
  const EntryDraft    = window.EntryDraft;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "20px 28px 0" }}>
        <div className="h-eyebrow" style={{ marginBottom: 6 }}>Competência · {MOCK.STOCK_BALANCE.monthLabel}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
          <h1 className="h-title">DRE &amp; Fechamento</h1>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select className="select" value={period} onChange={(e) => setPeriod(e.target.value)}>
              {periodOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {tab === "dre" && (
              <>
                <button className="btn" data-size="sm" onClick={() => setShowStructure(true)}>
                  <I.Edit size={13} />Editar estrutura
                </button>
                <button className="btn" data-size="sm" onClick={exportDre} disabled={exporting}>
                  {exporting ? "Exportando…" : "Exportar DRE"}
                </button>
              </>
            )}
          </div>
        </div>
        <DreTabs tab={tab} setTab={setTab} closedPeriods={closedPeriods} period={period} />
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
        {tab === "dre" && (
          <DREView entries={inPeriod} categories={categories} subcategories={subcategories}
                   period={period} stockSnapshot={stockSnapshot} revenueEntries={revenueEntries}
                   source={source} onViewSub={setViewingSub} />
        )}
        {tab === "fechamento" && (
          <ClosingView
            period={period}
            categories={categories}
            subcategories={subcategories}
            checklistForPeriod={checklistForPeriod}
            closedPeriods={closedPeriods}
            tenantId={tenantId}
            source={source}
            entries={entries}
            revenueEntries={revenueEntries}
            stockSnapshot={stockSnapshot}
            onGoToChecklist={() => window.showToast?.("Checklist está no módulo Financeiro", { tone: "info", ttl: 3500 })}
            onRequestClose={(p) => setConfirmClosePeriod({ period: p })}
            onRequestReopen={(p) => setConfirmReopenPeriod({ period: p })}
            onSelectPeriod={setPeriod}
          />
        )}
      </div>

      {viewingSub && (
        <SubEntriesModal
          sub={viewingSub}
          categories={categories}
          subcategories={subcategories}
          entries={inPeriod}
          period={period}
          onClose={() => setViewingSub(null)}
          onEdit={(entry) => { setViewingSub(null); setEditingEntry(entry); }}
          onDelete={(entry) => setConfirmDeleteEntry(entry)}
        />
      )}
      {editingEntry && EntryDraft && (
        <EntryDraft
          categories={categories}
          subcategories={subcategories}
          initial={editingEntry}
          period={period}
          onClose={() => setEditingEntry(null)}
          onSave={(draft) => updateEntry(editingEntry.id, draft)}
          onDelete={() => setConfirmDeleteEntry(editingEntry)}
        />
      )}
      {confirmDeleteEntry && ConfirmDialog && (
        <ConfirmDialog
          open={!!confirmDeleteEntry}
          tone="danger"
          title="Excluir lançamento?"
          message={
            <>
              Esta ação remove <strong style={{ color: "var(--fg-0)" }}>{confirmDeleteEntry.desc || "este lançamento"}</strong>
              {Number(confirmDeleteEntry.value) > 0 && <> no valor de <strong style={{ color: "var(--fg-0)" }}>{fmt(confirmDeleteEntry.value)}</strong></>}
              . A exclusão não pode ser desfeita.
            </>
          }
          confirmLabel="Excluir"
          cancelLabel="Cancelar"
          onCancel={() => setConfirmDeleteEntry(null)}
          onConfirm={() => deleteEntry(confirmDeleteEntry.id)}
        />
      )}
      {confirmClosePeriod && ConfirmDialog && (
        <ConfirmDialog
          open={!!confirmClosePeriod}
          tone="ok"
          title={`Fechar mês ${confirmClosePeriod.period.replace("-", "/")}?`}
          message={
            <>
              Esta ação registra o mês como <strong style={{ color: "var(--fg-0)" }}>formalmente fechado</strong>. Lançamentos posteriores ainda podem ser feitos, mas o mês fica marcado como conferido na auditoria.
              {" "}Você pode reabrir o mês depois.
            </>
          }
          confirmLabel="Fechar mês"
          cancelLabel="Cancelar"
          onCancel={() => setConfirmClosePeriod(null)}
          onConfirm={() => closePeriod(confirmClosePeriod.period)}
        />
      )}
      {confirmReopenPeriod && ConfirmDialog && (
        <ConfirmDialog
          open={!!confirmReopenPeriod}
          tone="warn"
          title={`Reabrir mês ${confirmReopenPeriod.period.replace("-", "/")}?`}
          message={
            <>
              O mês deixa de constar como fechado. Use quando precisar corrigir lançamentos retroativos. A ação fica registrada na auditoria.
            </>
          }
          confirmLabel="Reabrir mês"
          cancelLabel="Cancelar"
          onCancel={() => setConfirmReopenPeriod(null)}
          onConfirm={() => reopenPeriod(confirmReopenPeriod.period)}
        />
      )}
      {showStructure && (
        <CategoryStructureModal
          categories={categories}
          subcategories={subcategories}
          entries={entries}
          onClose={() => setShowStructure(false)}
          handlers={{
            createCategory, renameCategory, deleteCategory, moveCategory,
            createSubcategory, renameSubcategory, recolorSubcategory, deleteSubcategory,
          }}
        />
      )}
    </div>
  );
}

function DreTabs({ tab, setTab, closedPeriods, period }) {
  const closed = isPeriodClosed(closedPeriods, period);
  const tabs = [
    { id: "dre",        label: "DRE" },
    { id: "fechamento", label: "Fechamento", badge: closed ? "fechado" : null },
  ];
  return (
    <div style={{ display: "flex", gap: 0, marginTop: 16, borderBottom: "1px solid var(--line)" }}>
      {tabs.map(({ id, label, badge }) => {
        const active = tab === id;
        return (
          <button key={id} onClick={() => setTab(id)} style={{
            background: "transparent", border: "none",
            padding: "10px 14px", fontSize: 12.5,
            color: active ? "var(--fg-0)" : "var(--fg-2)",
            fontWeight: active ? 500 : 400, letterSpacing: "-0.005em",
            borderBottom: `2px solid ${active ? "var(--accent-bright)" : "transparent"}`,
            marginBottom: -1, display: "inline-flex", alignItems: "center", gap: 8,
          }}>
            {label}
            {badge && (
              <span style={{
                fontFamily: "var(--mono)", fontSize: 10, padding: "1px 6px",
                borderRadius: 99, letterSpacing: "0.04em",
                background: "var(--accent-soft)", color: "var(--ok)",
                border: "1px solid var(--accent-line)",
                display: "inline-flex", alignItems: "center", gap: 4,
              }}><I.Lock size={9} />{badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------- DRE ----------
function DREView({ entries, categories, subcategories, period, stockSnapshot = { initial: 0, final: 0 }, revenueEntries = [], source = "mock", onViewSub }) {
  const fmt = window.fmt;
  const fmtDate = window.fmtDate;
  const summary = computeDreSummary({ entries, categories, subcategories, period, stockSnapshot, revenueEntries, source });
  const { byCat, receita, receitaLiq, lucroBruto, lucroLiq, ei, ef, comprasTotal, cmvReal } = summary;

  const pct = (v) => receita > 0 ? ((v / receita) * 100).toFixed(1) + "%" : "—";

  const sorted = [...categories].sort((a, b) => a.order - b.order);
  const aboveLucroBruto  = sorted.filter((c) => ["revenue", "deduction", "cogs"].includes(c.kind));
  const belowLucroBruto  = sorted.filter((c) => ["expense", "financial"].includes(c.kind));

  return (
    <div style={{ padding: "20px 28px 32px", display: "flex", flexDirection: "column", gap: 16 }} className="stagger">
      <div className="card" style={{ borderColor: "var(--accent-line)", background: "linear-gradient(180deg, rgba(45,140,102,0.05), transparent 70%)" }}>
        <div className="card-body" style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr 1fr 1fr", gap: 20, alignItems: "center" }}>
          <div>
            <div className="h-eyebrow" style={{ marginBottom: 6 }}>CMV Real · método contábil</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-1)", letterSpacing: "-0.005em" }}>
              {ei > 0
                ? <>Estoque inicial <span style={{ color: "var(--fg-3)" }}>+</span> Compras <span style={{ color: "var(--fg-3)" }}>−</span> Estoque final</>
                : <>Compras <span style={{ color: "var(--fg-3)" }}>(sem inventário inicial)</span></>}
            </div>
          </div>
          <DreStat label={`EI${stockSnapshot.initialAt ? ` · ${fmtDate(stockSnapshot.initialAt)}` : ""}`} value={fmt(ei)} />
          <DreStat label="(+) Compras" value={fmt(comprasTotal)} />
          {ei > 0 && (
            <DreStat label={`EF${stockSnapshot.finalAt ? ` · ${fmtDate(stockSnapshot.finalAt)}` : ""}`} value={fmt(ef)} />
          )}
          <DreStat label="= CMV real" value={fmt(cmvReal)} accent sub={receita ? `${((cmvReal / receita) * 100).toFixed(1)}% da receita` : ""} />
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">DRE · {period.replace("-", "/")}</h3>
            <span className="card-sub" style={{ display: "block", marginTop: 4 }}>Por data de competência · {entries.length} lançamentos · estrutura editável</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <span className="badge" data-tone="ok">Receita {fmt(receita)}</span>
            <span className="badge" data-tone={lucroLiq > 0 ? "ok" : "crit"}>Lucro líq. {fmt(lucroLiq)}</span>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: "44%" }}>Conta</th>
              <th className="num">Valor</th>
              <th className="num">% receita</th>
              <th>Composição</th>
            </tr>
          </thead>
          <tbody>
            {aboveLucroBruto.map((c) => {
              const sign = c.kind === "revenue" ? "+" : "−";
              const note = c.kind === "revenue"
                ? "vem de Faturamento"
                : c.id === "cmv"
                  ? "compras + ajuste de estoque automático"
                  : null;
              return (
                <DreRow key={c.id}
                  label={`${sign === "−" ? "(−) " : ""}${c.name}`}
                  value={byCat[c.id]?.total || 0}
                  pct={pct(byCat[c.id]?.total || 0)}
                  sign={sign}
                  strong={c.kind === "revenue"}
                  byCat={byCat[c.id]?.bySub || {}}
                  subcategories={subcategories}
                  note={note}
                  onViewSub={c.kind === "revenue" ? null : onViewSub}
                />
              );
            })}
            <DreSub label="= Receita líquida" value={receitaLiq} pct={pct(receitaLiq)} />
            <DreSub label="= Lucro bruto" value={lucroBruto} pct={pct(lucroBruto)} tone={lucroBruto > 0 ? "ok" : "crit"} />

            {belowLucroBruto.map((c) => (
              <DreRow key={c.id}
                label={`(−) ${c.name}`}
                value={byCat[c.id]?.total || 0}
                pct={pct(byCat[c.id]?.total || 0)}
                sign="−"
                byCat={byCat[c.id]?.bySub || {}}
                subcategories={subcategories}
                onViewSub={onViewSub}
              />
            ))}

            <DreSub label="= Lucro líquido" value={lucroLiq} pct={pct(lucroLiq)} tone={lucroLiq > 0 ? "ok" : "crit"} bold />
          </tbody>
        </table>
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--line-soft)", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
          * EF projetado · finalize o inventário do mês em <a href="#" style={{ color: "var(--accent-bright)", textDecoration: "none" }}>Estoque → Inventário</a>.
        </div>
      </div>
    </div>
  );
}

function DreStat({ label, value, accent, sub }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</span>
      <span className="mono" style={{ fontSize: 18, fontWeight: 500, color: accent ? "var(--accent-bright)" : "var(--fg-0)", letterSpacing: "-0.018em" }}>{value}</span>
      {sub && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>{sub}</span>}
    </div>
  );
}

function DreRow({ label, value, pct, sign, byCat, subcategories, strong, faded, note, onViewSub }) {
  const fmt = window.fmt;
  const [open, setOpen] = useState(false);
  const subs = byCat ? Object.entries(byCat).filter(([id, v]) => {
    if (Math.abs(v) > 0.001) return true;
    const sub = subcategories?.find((s) => s.id === id);
    return !!sub?.autofeed;
  }) : [];
  const hasDetail = subs.length > 0;
  const display = sign === "−" && value > 0 ? `−${fmt(value)}` : value < 0 ? `+${fmt(-value)}` : fmt(value);
  return (
    <>
      <tr style={{ cursor: hasDetail ? "pointer" : "default", opacity: faded ? 0.65 : 1 }} onClick={() => hasDetail && setOpen(!open)}>
        <td>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: strong ? "var(--fg-0)" : "var(--fg-1)", fontWeight: strong ? 500 : 400 }}>
            {hasDetail && <I.Chevron size={11} style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform 120ms", color: "var(--fg-3)" }} />}
            {!hasDetail && <span style={{ width: 11 }} />}
            {label}
            {note && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", marginLeft: 6 }}>{note}</span>}
          </span>
        </td>
        <td className="num">{display}</td>
        <td className="num" style={{ color: "var(--fg-3)" }}>{pct}</td>
        <td className="dim" style={{ fontSize: 11.5 }}>{subs.length} {subs.length === 1 ? "subcategoria" : "subcategorias"}</td>
      </tr>
      {open && subs.map(([subId, val]) => {
        const sub = subcategories.find((s) => s.id === subId);
        if (!sub) return null;
        const total = value || 1;
        const sharePct = total !== 0 ? (val / total) * 100 : 0;
        const canView = !!onViewSub && !sub.autofeed;
        return (
          <tr key={subId} style={{ background: "var(--bg-2)", cursor: canView ? "pointer" : "default" }}
              onClick={() => canView && onViewSub(sub)}
              title={canView ? "Ver e editar lançamentos desta subcategoria" : undefined}>
            <td style={{ paddingLeft: 36 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--fg-1)" }}>
                <span style={{ width: 4, height: 4, borderRadius: 50, background: sub.color }} />
                {sub.name}
                {sub.autofeed && (
                  <span style={{
                    fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent-bright)",
                    letterSpacing: "0.06em", textTransform: "uppercase", padding: "1px 6px",
                    background: "var(--accent-soft)", border: "1px solid var(--accent-line)", borderRadius: 99,
                    display: "inline-flex", alignItems: "center", gap: 3,
                  }} title="Calculado automaticamente">
                    <I.Bell size={9} />auto
                  </span>
                )}
              </span>
            </td>
            <td className="num" style={{ color: "var(--fg-1)" }}>
              {val < 0 ? "+" : ""}{fmt(Math.abs(val))}
            </td>
            <td className="num" style={{ color: "var(--fg-3)" }}>{Math.abs(sharePct).toFixed(1)}%</td>
            <td className="dim" style={{ fontSize: 11 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span style={{ display: "inline-block", width: 100, height: 3, background: "var(--bg-3)", borderRadius: 1, overflow: "hidden" }}>
                  <span style={{ display: "block", width: `${Math.min(100, Math.abs(sharePct))}%`, height: "100%", background: sub.color }} />
                </span>
                {canView && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--accent-bright)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                    editar →
                  </span>
                )}
              </span>
            </td>
          </tr>
        );
      })}
    </>
  );
}

function DreSub({ label, value, pct, tone, bold }) {
  const fmt = window.fmt;
  const color = tone === "ok" ? "var(--ok)" : tone === "crit" ? "var(--crit)" : "var(--fg-0)";
  return (
    <tr style={{ background: "var(--bg-2)" }}>
      <td style={{ borderTop: "1px solid var(--line-strong)", borderBottom: "1px solid var(--line-strong)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: bold ? 14 : 13, color: "var(--fg-0)", fontWeight: 500, letterSpacing: "-0.005em" }}>
          <span style={{ width: 11 }} />
          {label}
        </span>
      </td>
      <td className="num" style={{ borderTop: "1px solid var(--line-strong)", borderBottom: "1px solid var(--line-strong)", fontSize: bold ? 15 : 13, color, fontWeight: 500 }}>{fmt(value)}</td>
      <td className="num" style={{ borderTop: "1px solid var(--line-strong)", borderBottom: "1px solid var(--line-strong)", color: "var(--fg-2)" }}>{pct}</td>
      <td style={{ borderTop: "1px solid var(--line-strong)", borderBottom: "1px solid var(--line-strong)" }} />
    </tr>
  );
}

// ---------- Fechamento ----------
function ClosingView({
  period, categories, subcategories, checklistForPeriod, closedPeriods,
  tenantId, source, entries, revenueEntries, stockSnapshot,
  onGoToChecklist, onRequestClose, onRequestReopen, onSelectPeriod,
}) {
  const [year, setYear] = useState(period.slice(0, 4));
  const [yearData, setYearData] = useState({});
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadYearSummaries({ year, tenantId, categories, subcategories, source })
      .then((data) => { if (!cancelled) { setYearData(data); setLoading(false); } })
      .catch(() => { if (!cancelled) { setYearData({}); setLoading(false); } });
    return () => { cancelled = true; };
  }, [year, tenantId, categories, subcategories, source]);

  const required   = checklistForPeriod.filter((c) => c.required);
  const pendentes  = required.filter((c) => c.status !== "filled");
  const opcionaisPend = checklistForPeriod.filter((c) => !c.required && c.status !== "filled");
  const podeFechar = pendentes.length === 0;
  const jaFechado  = isPeriodClosed(closedPeriods, period);
  const closedItem = (closedPeriods || []).find((c) => c.period === period);

  const yearsAvailable = useMemo(() => {
    const now = new Date().getFullYear();
    const set = new Set([now - 1, now, now + 1, Number(period.slice(0, 4))]);
    (closedPeriods || []).forEach((c) => { if (c.period) set.add(Number(c.period.slice(0, 4))); });
    return Array.from(set).filter((y) => Number.isFinite(y)).sort((a, b) => b - a);
  }, [closedPeriods, period]);

  return (
    <div style={{ padding: "20px 28px 32px", display: "flex", flexDirection: "column", gap: 20 }} className="stagger">
      <ClosingValidationCard
        period={period}
        required={required}
        pendentes={pendentes}
        opcionaisPend={opcionaisPend}
        podeFechar={podeFechar}
        jaFechado={jaFechado}
        closedItem={closedItem}
        subcategories={subcategories}
        onGoToChecklist={onGoToChecklist}
        onRequestClose={() => onRequestClose(period)}
        onRequestReopen={() => onRequestReopen(period)}
      />

      {closedPeriods && closedPeriods.length > 0 && (
        <ClosedPeriodsList
          closedPeriods={closedPeriods}
          currentPeriod={period}
          onSelectPeriod={onSelectPeriod}
          onRequestReopen={onRequestReopen}
        />
      )}

      <YearComparisonCard
        year={year}
        yearsAvailable={yearsAvailable}
        onYearChange={setYear}
        yearData={yearData}
        loading={loading}
        categories={categories}
        subcategories={subcategories}
        closedPeriods={closedPeriods}
        currentPeriod={period}
        collapsed={collapsed}
        onToggleCollapse={(catId) => setCollapsed((c) => ({ ...c, [catId]: !c[catId] }))}
      />
    </div>
  );
}

function ClosingValidationCard({ period, required, pendentes, opcionaisPend, podeFechar, jaFechado, closedItem, subcategories, onGoToChecklist, onRequestClose, onRequestReopen }) {
  const fmt = window.fmt;
  const fmtDate = window.fmtDate;
  const findSubcategory = window.findSubcategory;
  const getChecklistUrgency = window.getChecklistUrgency;

  const totalRequired = required.length;
  const filledRequired = totalRequired - pendentes.length;
  const progress = totalRequired > 0 ? (filledRequired / totalRequired) * 100 : 100;

  const tone = jaFechado ? "closed" : podeFechar ? "ready" : "blocked";
  const themes = {
    closed:  { bg: "linear-gradient(180deg, rgba(45,140,102,0.10), transparent 80%)", border: "var(--accent-line)", label: "Mês fechado", labelColor: "var(--ok)", iconBg: "var(--accent-soft)" },
    ready:   { bg: "linear-gradient(180deg, rgba(45,140,102,0.06), transparent 80%)", border: "var(--accent-line)", label: "Pronto para fechar", labelColor: "var(--ok)", iconBg: "var(--accent-soft)" },
    blocked: { bg: "linear-gradient(180deg, rgba(176,69,69,0.06), transparent 80%)", border: "var(--crit-line)", label: `${pendentes.length} impeditivo(s) pendente(s)`, labelColor: "var(--crit)", iconBg: "var(--crit-soft)" },
  };
  const theme = themes[tone];

  return (
    <div className="card" style={{ borderColor: theme.border, background: theme.bg }}>
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flex: 1, minWidth: 0 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 6, background: theme.iconBg,
              border: `1px solid ${theme.border}`,
              display: "grid", placeItems: "center", flexShrink: 0,
            }}>
              {jaFechado ? <I.Lock size={16} style={{ color: theme.labelColor }} />
                : podeFechar ? <I.Check size={16} style={{ color: theme.labelColor }} />
                : <I.AlertTriangle size={16} style={{ color: theme.labelColor }} />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="h-eyebrow" style={{ marginBottom: 4 }}>
                Fechamento · {period.replace("-", "/")}
              </div>
              <div style={{ fontSize: 16, fontWeight: 500, color: theme.labelColor, letterSpacing: "-0.01em", marginBottom: 4 }}>
                {theme.label}
              </div>
              <div style={{ fontSize: 12, color: "var(--fg-2)" }}>
                {jaFechado
                  ? <>Mês formalmente fechado{closedItem?.closed_at ? <> em {fmtDate(window.spDay(closedItem.closed_at))}</> : null}. Reabra para corrigir lançamentos retroativos.</>
                  : podeFechar
                    ? <>Todos os {totalRequired} impeditivos do checklist estão preenchidos. Você pode marcar o mês como fechado.</>
                    : <>O fechamento está bloqueado até que todos os impeditivos do checklist sejam preenchidos. O checklist está no módulo <strong style={{ color: "var(--fg-0)" }}>Financeiro</strong>.</>}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            {jaFechado ? (
              <button className="btn" data-variant="ghost" data-size="sm" onClick={onRequestReopen} style={{ color: "var(--warn)" }}>
                <I.Edit size={11} />Reabrir mês
              </button>
            ) : podeFechar ? (
              <button className="btn" data-variant="primary" data-size="sm" onClick={onRequestClose}>
                <I.Lock size={11} />Fechar mês
              </button>
            ) : (
              <button className="btn" data-size="sm" onClick={onGoToChecklist}>
                Ir ao checklist <I.Chevron size={10} style={{ transform: "rotate(-90deg)" }} />
              </button>
            )}
          </div>
        </div>

        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
              Impeditivos · {filledRequired}/{totalRequired} preenchidos
            </span>
            {opcionaisPend.length > 0 && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
                + {opcionaisPend.length} opcional(is) pendente(s) — não bloqueiam
              </span>
            )}
          </div>
          <div style={{ height: 4, background: "var(--bg-3)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              height: "100%", width: `${progress}%`,
              background: podeFechar ? "var(--ok)" : "var(--crit)",
              transition: "width 240ms ease-out",
            }} />
          </div>
        </div>

        {pendentes.length > 0 && (
          <div style={{ background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
              <I.AlertTriangle size={12} style={{ color: "var(--crit)" }} />
              <span style={{ fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500 }}>
                {pendentes.length} {pendentes.length === 1 ? "impeditivo pendente" : "impeditivos pendentes"}
              </span>
              <span style={{ fontSize: 11, color: "var(--fg-3)" }}>· precisam ser preenchidos para liberar o fechamento</span>
            </div>
            <table className="table" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <th style={{ width: 32 }}></th>
                  <th>Item</th>
                  <th>Subcategoria</th>
                  <th>Vencimento</th>
                  <th>Responsável</th>
                  <th className="num">Esperado</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pendentes.map((c) => {
                  const sub = findSubcategory(subcategories, c.cat);
                  const urg = getChecklistUrgency(c, period);
                  const t = urg.level === "overdue" ? "crit" : urg.level === "soon" ? "warn" : "info";
                  const lbl = urg.level === "overdue" ? "Vencido"
                    : c.status === "estimated" ? "Estimado" : "Pendente";
                  return (
                    <tr key={c.id} style={{ cursor: "pointer" }} onClick={onGoToChecklist}>
                      <td>
                        <span style={{
                          display: "inline-block", width: 14, height: 14, borderRadius: 3,
                          border: "1.5px solid var(--crit)", background: "transparent",
                        }} />
                      </td>
                      <td className="row-strong">{c.label}</td>
                      <td className="dim">
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 4, height: 4, borderRadius: 50, background: sub?.color || "#888" }} />
                          {sub?.name || "—"}
                        </span>
                      </td>
                      <td className="mono" style={{ fontSize: 11.5, color: urg.level === "overdue" ? "var(--crit)" : "var(--fg-2)" }}>
                        {c.due ? `dia ${String(c.due).padStart(2, "0")}` : "—"}
                        {urg.level !== "none" && urg.daysLeft != null && (
                          <div style={{ fontFamily: "var(--mono)", fontSize: 10, marginTop: 2, letterSpacing: "0.04em", color: urg.level === "overdue" ? "var(--crit)" : "var(--warn)" }}>
                            {urg.level === "overdue" ? `vencido há ${Math.abs(urg.daysLeft)}d` : urg.daysLeft === 0 ? "vence hoje" : `em ${urg.daysLeft}d`}
                          </div>
                        )}
                      </td>
                      <td className="dim" style={{ fontSize: 11.5 }}>{c.owner || "—"}</td>
                      <td className="num" style={{ color: "var(--fg-2)" }}>{fmt(c.expected || 0)}</td>
                      <td><span className="badge" data-tone={t}>{lbl}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ClosedPeriodsList({ closedPeriods, currentPeriod, onSelectPeriod, onRequestReopen }) {
  const fmtDate = window.fmtDate;
  const sorted = [...closedPeriods].sort((a, b) => (b.period || "").localeCompare(a.period || ""));
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">Meses fechados</h3>
          <span className="card-sub" style={{ display: "block", marginTop: 4 }}>{sorted.length} {sorted.length === 1 ? "mês" : "meses"} formalmente fechados</span>
        </div>
      </div>
      <div style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
        {sorted.map((c) => {
          const isCurrent = c.period === currentPeriod;
          return (
            <div key={c.period} style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              padding: "6px 10px", borderRadius: 4,
              background: isCurrent ? "var(--accent-soft)" : "var(--bg-2)",
              border: `1px solid ${isCurrent ? "var(--accent-line)" : "var(--line)"}`,
            }}>
              <I.Lock size={10} style={{ color: "var(--ok)" }} />
              <button type="button" onClick={() => onSelectPeriod?.(c.period)}
                      title="Selecionar este período no header"
                      style={{ background: "transparent", border: "none", color: "var(--fg-0)", fontSize: 12, fontWeight: 500, padding: 0, cursor: "pointer", letterSpacing: "-0.005em" }}>
                {c.period.replace("-", "/")}
              </button>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
                {c.closed_at ? fmtDate(window.spDay(c.closed_at)) : ""}
              </span>
              <button type="button" onClick={() => onRequestReopen?.(c.period)}
                      title="Reabrir mês"
                      className="btn" data-variant="ghost" data-size="sm"
                      style={{ padding: "2px 6px", color: "var(--warn)" }}>
                <I.Edit size={10} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function YearComparisonCard({ year, yearsAvailable, onYearChange, yearData, loading, categories, subcategories, closedPeriods, currentPeriod, collapsed, onToggleCollapse }) {
  const fmtShort = window.fmtShort;
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const sortedCats = [...categories].sort((a, b) => (a.order || 99) - (b.order || 99));
  const aboveLB = sortedCats.filter((c) => ["revenue", "deduction", "cogs"].includes(c.kind));
  const belowLB = sortedCats.filter((c) => ["expense", "financial"].includes(c.kind));

  // Só meses oficialmente fechados exibem valores no comparativo —
  // dados parciais (checklist incompleto) ficam ocultos.
  const dataByPeriod = useMemo(() => {
    const out = {};
    months.forEach((period) => {
      if (isPeriodClosed(closedPeriods, period) && yearData[period]) {
        out[period] = yearData[period];
      }
    });
    return out;
  }, [months, yearData, closedPeriods]);

  const sumMonth = (period, fn) => {
    const s = dataByPeriod[period];
    if (!s) return 0;
    return fn(s);
  };
  const totalRow = (fn) => months.reduce((acc, p) => acc + sumMonth(p, fn), 0);

  const renderCategoryRow = (cat) => {
    const subs = subcategories.filter((s) => s.category === cat.id);
    const isCollapsed = !!collapsed[cat.id];
    const isRevenue = cat.kind === "revenue";
    const sign = isRevenue ? "+" : "−";
    const getCatTotal = (period) => dataByPeriod[period]?.byCat?.[cat.id]?.total || 0;
    const catYearTotal = months.reduce((acc, p) => acc + getCatTotal(p), 0);

    return (
      <React.Fragment key={cat.id}>
        <tr style={{ cursor: subs.length > 0 ? "pointer" : "default" }}
            onClick={() => subs.length > 0 && onToggleCollapse(cat.id)}>
          <td style={{ position: "sticky", left: 0, background: "var(--bg-1)", zIndex: 2, borderRight: "1px solid var(--line)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 500, color: "var(--fg-0)" }}>
              {subs.length > 0
                ? <I.Chevron size={10} style={{ transform: isCollapsed ? "rotate(-90deg)" : "none", transition: "transform 120ms", color: "var(--fg-3)" }} />
                : <span style={{ width: 10 }} />}
              {isRevenue ? "" : "(−) "}{cat.name}
            </span>
          </td>
          {months.map((period) => {
            const v = getCatTotal(period);
            const closed = isPeriodClosed(closedPeriods, period);
            return (
              <td key={period} className="num" style={{
                color: "var(--fg-0)", fontWeight: 500,
                background: period === currentPeriod ? "var(--accent-soft)" : closed ? "rgba(45,140,102,0.04)" : "transparent",
              }}>
                {v ? (sign === "−" ? "−" : "") + fmtShort(Math.abs(v)) : "—"}
              </td>
            );
          })}
          <td className="num" style={{ color: "var(--fg-0)", fontWeight: 500, background: "var(--bg-2)", borderLeft: "1px solid var(--line-strong)" }}>
            {catYearTotal ? (sign === "−" ? "−" : "") + fmtShort(Math.abs(catYearTotal)) : "—"}
          </td>
        </tr>

        {!isCollapsed && subs.map((sub) => {
          const getSubTotal = (period) => dataByPeriod[period]?.byCat?.[cat.id]?.bySub?.[sub.id] || 0;
          const subYearTotal = months.reduce((acc, p) => acc + getSubTotal(p), 0);
          const hasAnyValue = months.some((p) => Math.abs(getSubTotal(p)) > 0.001) || Math.abs(subYearTotal) > 0.001 || sub.autofeed;
          if (!hasAnyValue) return null;
          return (
            <tr key={sub.id} style={{ background: "var(--bg-2)" }}>
              <td style={{ position: "sticky", left: 0, background: "var(--bg-2)", zIndex: 2, borderRight: "1px solid var(--line)", paddingLeft: 26 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--fg-1)" }}>
                  <span style={{ width: 4, height: 4, borderRadius: 50, background: sub.color || "#888" }} />
                  {sub.name}
                </span>
              </td>
              {months.map((period) => {
                const v = getSubTotal(period);
                return (
                  <td key={period} className="num" style={{
                    color: "var(--fg-1)", fontSize: 11.5,
                    background: period === currentPeriod ? "var(--accent-soft)" : "transparent",
                  }}>
                    {Math.abs(v) > 0.001 ? (sign === "−" ? "−" : "") + fmtShort(Math.abs(v)) : "—"}
                  </td>
                );
              })}
              <td className="num" style={{ color: "var(--fg-1)", fontSize: 11.5, background: "var(--bg-3)", borderLeft: "1px solid var(--line-strong)" }}>
                {Math.abs(subYearTotal) > 0.001 ? (sign === "−" ? "−" : "") + fmtShort(Math.abs(subYearTotal)) : "—"}
              </td>
            </tr>
          );
        })}
      </React.Fragment>
    );
  };

  const renderSubtotalRow = (label, fn, opts = {}) => {
    const yearTotal = totalRow(fn);
    return (
      <tr style={{ background: "var(--bg-2)", borderTop: "1px solid var(--line-strong)", borderBottom: "1px solid var(--line-strong)" }}>
        <td style={{ position: "sticky", left: 0, background: "var(--bg-2)", zIndex: 2, borderRight: "1px solid var(--line)", borderTop: "1px solid var(--line-strong)", borderBottom: "1px solid var(--line-strong)" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: opts.bold ? 13 : 12.5, fontWeight: 500, color: "var(--fg-0)" }}>
            <span style={{ width: 10 }} />
            {label}
          </span>
        </td>
        {months.map((period) => {
          const v = sumMonth(period, fn);
          const tone = opts.colored ? (v > 0 ? "var(--ok)" : v < 0 ? "var(--crit)" : "var(--fg-1)") : "var(--fg-0)";
          return (
            <td key={period} className="num" style={{
              color: tone, fontWeight: 500, fontSize: opts.bold ? 13 : 12.5,
              background: period === currentPeriod ? "var(--accent-soft)" : "transparent",
            }}>
              {v ? (v < 0 ? "−" : "") + fmtShort(Math.abs(v)) : "—"}
            </td>
          );
        })}
        <td className="num" style={{
          color: opts.colored ? (yearTotal > 0 ? "var(--ok)" : yearTotal < 0 ? "var(--crit)" : "var(--fg-0)") : "var(--fg-0)",
          fontWeight: 500, fontSize: opts.bold ? 13 : 12.5,
          background: "var(--bg-3)", borderLeft: "1px solid var(--line-strong)",
        }}>
          {yearTotal ? (yearTotal < 0 ? "−" : "") + fmtShort(Math.abs(yearTotal)) : "—"}
        </td>
      </tr>
    );
  };

  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: "center" }}>
        <div>
          <h3 className="card-title">Comparativo anual da DRE · {year}</h3>
          <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
            Apenas meses formalmente fechados exibem valores · meses em aberto aparecem como "—" para evitar comparação com dados parciais · clique numa categoria para recolher/expandir
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Ano</span>
          <select className="select" value={year} onChange={(e) => onYearChange(e.target.value)} style={{ width: 100 }}>
            {yearsAvailable.map((y) => <option key={y} value={String(y)}>{y}</option>)}
          </select>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 48, textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>
          Carregando dados do ano…
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ minWidth: 1100 }}>
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, background: "var(--bg-1)", zIndex: 3, borderRight: "1px solid var(--line)", minWidth: 220 }}>
                  Conta
                </th>
                {months.map((period, i) => {
                  const closed = isPeriodClosed(closedPeriods, period);
                  const isCurrent = period === currentPeriod;
                  return (
                    <th key={period} className="num" style={{
                      background: isCurrent ? "var(--accent-soft)" : closed ? "rgba(45,140,102,0.06)" : "transparent",
                      minWidth: 76,
                    }} title={closed ? "Mês fechado" : ""}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {MONTH_LABELS_PT_DRE[i]}
                        {closed && <I.Lock size={9} style={{ color: "var(--ok)" }} />}
                      </span>
                    </th>
                  );
                })}
                <th className="num" style={{ background: "var(--bg-2)", borderLeft: "1px solid var(--line-strong)", minWidth: 90 }}>
                  Acum. ano
                </th>
              </tr>
            </thead>
            <tbody>
              {aboveLB.map(renderCategoryRow)}
              {renderSubtotalRow("= Receita líquida", (s) => s.receitaLiq)}
              {renderSubtotalRow("= Lucro bruto", (s) => s.lucroBruto, { colored: true })}
              {belowLB.map(renderCategoryRow)}
              {renderSubtotalRow("= Lucro líquido", (s) => s.lucroLiq, { colored: true, bold: true })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Modal · Drill-down de subcategoria ----------
function SubEntriesModal({ sub, categories, subcategories, entries, period, onClose, onEdit, onDelete }) {
  const fmt = window.fmt;
  const fmtDate = window.fmtDate;
  const findCategory = window.findCategory;
  const ModalShell   = window.ModalShell;

  const cat = sub ? findCategory(categories, sub.category) : null;
  const subEntries = entries
    .filter((e) => e.cat === sub.id && !e.auto)
    .sort((a, b) => (b.comp || "").localeCompare(a.comp || ""));
  const total = subEntries.reduce((s, e) => s + (Number(e.value) || 0), 0);

  return (
    <ModalShell
      title={`${sub.name}`}
      subtitle={`${cat?.name || "—"} · ${period.replace("-", "/")} · ${subEntries.length} lançamento(s)`}
      onClose={onClose}
      width={780}
      footer={<button className="btn" data-variant="primary" data-size="sm" onClick={onClose}>Fechar</button>}
    >
      <div style={{
        padding: "10px 14px", marginBottom: 14,
        background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Σ Total da subcategoria
        </span>
        <span className="mono" style={{ fontSize: 16, fontWeight: 500, color: "var(--fg-0)" }}>
          {fmt(total)}
        </span>
      </div>

      {subEntries.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>
          Sem lançamentos nesta subcategoria neste período.
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Descrição</th>
              <th>Competência</th>
              <th>Pagamento</th>
              <th>Status</th>
              <th className="num">Valor</th>
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {subEntries.map((e) => {
              const tone = e.status === "paid" ? "ok" : e.status === "scheduled" ? "info" : "warn";
              const lbl  = e.status === "paid" ? "Pago" : e.status === "scheduled" ? "Agendado" : "Pendente";
              return (
                <tr key={e.id} style={{ cursor: "pointer" }} onClick={() => onEdit?.(e)}>
                  <td className="row-strong">{e.desc}</td>
                  <td className="mono" style={{ fontSize: 11.5, color: "var(--fg-1)" }}>{fmtDate(e.comp)}</td>
                  <td className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{fmtDate(e.paid)}</td>
                  <td><span className="badge" data-tone={tone}>{lbl}</span></td>
                  <td className="num" style={{ color: "var(--fg-0)" }}>−{fmt(e.value)}</td>
                  <td onClick={(ev) => ev.stopPropagation()}>
                    <div style={{ display: "inline-flex", gap: 4 }}>
                      <button className="btn" data-variant="ghost" data-size="sm" title="Editar"
                              onClick={() => onEdit?.(e)} style={{ padding: "3px 6px" }}>
                        <I.Edit size={11} />
                      </button>
                      <button className="btn" data-variant="ghost" data-size="sm" title="Excluir"
                              onClick={() => onDelete?.(e)} style={{ padding: "3px 6px", color: "var(--crit)" }}>
                        <I.Trash size={11} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </ModalShell>
  );
}

// ---------- Modal · Estrutura da DRE (CRUD) ----------
function CategoryStructureModal({ categories, subcategories, entries, onClose, handlers }) {
  const subsByCategory = window.subsByCategory;
  const ModalShell     = window.ModalShell;

  const [creatingCat, setCreatingCat] = useState(false);
  const [creatingSubFor, setCreatingSubFor] = useState(null);
  const [editing, setEditing] = useState(null);

  const entryCount = (subId) => entries.filter((e) => e.cat === subId).length;
  const sortedCats = [...categories].sort((a, b) => a.order - b.order);

  const startEdit = (type, id, value) => setEditing({ type, id, value });
  const cancelEdit = () => setEditing(null);
  const saveEdit = () => {
    if (!editing) return;
    const v = String(editing.value || "").trim();
    if (!v) { cancelEdit(); return; }
    if (editing.type === "cat") handlers.renameCategory(editing.id, v);
    else                        handlers.renameSubcategory(editing.id, v);
    cancelEdit();
  };

  return (
    <ModalShell
      title="Estrutura da DRE"
      subtitle="Categorias, subcategorias e auto-feeds. Itens travados são essenciais para o fechamento."
      onClose={onClose}
      width={760}
      footer={
        <button className="btn" data-variant="primary" data-size="sm" onClick={onClose}>Concluir</button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {creatingCat ? (
          <NewCategoryRow
            onCancel={() => setCreatingCat(false)}
            onSave={(data) => { handlers.createCategory(data); setCreatingCat(false); }}
          />
        ) : (
          <button className="btn" data-variant="ghost" data-size="sm"
                  onClick={() => setCreatingCat(true)}
                  style={{ alignSelf: "flex-start" }}>
            <I.Plus size={11} />Nova categoria
          </button>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sortedCats.map((cat, idx) => {
            const subs = subsByCategory(subcategories, cat.id);
            const isEditing = editing?.type === "cat" && editing.id === cat.id;
            const kindLabel = {
              revenue: "Receita", deduction: "Dedução", cogs: "CMV (custos)",
              expense: "Despesa", financial: "Financeiro",
            }[cat.kind] || cat.kind;
            return (
              <div key={cat.id} className="card" style={{ overflow: "hidden" }}>
                <div className="card-header" style={{ alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                      <button type="button" className="btn" data-variant="ghost" data-size="sm"
                              onClick={() => handlers.moveCategory(cat.id, "up")}
                              disabled={idx === 0}
                              style={{ padding: "1px 4px" }} title="Mover para cima">
                        <I.ArrowUp size={9} />
                      </button>
                      <button type="button" className="btn" data-variant="ghost" data-size="sm"
                              onClick={() => handlers.moveCategory(cat.id, "down")}
                              disabled={idx === sortedCats.length - 1}
                              style={{ padding: "1px 4px" }} title="Mover para baixo">
                        <I.ArrowDown size={9} />
                      </button>
                    </div>
                    <span style={{
                      fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)",
                      letterSpacing: "0.04em", padding: "2px 6px",
                      background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 3,
                    }}>{idx + 1}</span>
                    {isEditing ? (
                      <input className="input" autoFocus value={editing.value}
                             onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                             onKeyDown={(e) => {
                               if (e.key === "Enter") saveEdit();
                               if (e.key === "Escape") cancelEdit();
                             }}
                             style={{ flex: 1, minWidth: 0 }} />
                    ) : (
                      <h3 className="card-title" style={{ display: "inline-flex", alignItems: "center", gap: 8, flex: 1 }}>
                        {cat.name}
                        {cat.locked && <I.Lock size={10} style={{ color: "var(--fg-3)" }} />}
                      </h3>
                    )}
                    <span style={{
                      fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)",
                      letterSpacing: "0.04em", textTransform: "uppercase",
                      padding: "2px 6px", border: "1px solid var(--line)", borderRadius: 3,
                    }}>
                      {kindLabel}
                    </span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)" }}>
                      {subs.length} {subs.length === 1 ? "subcategoria" : "subcategorias"}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {isEditing ? (
                      <>
                        <button className="btn" data-size="sm" onClick={cancelEdit}>Cancelar</button>
                        <button className="btn" data-variant="primary" data-size="sm" onClick={saveEdit}>Salvar</button>
                      </>
                    ) : (
                      <>
                        <button className="btn" data-variant="ghost" data-size="sm"
                                onClick={() => startEdit("cat", cat.id, cat.name)}
                                disabled={cat.locked}>
                          <I.Edit size={11} />Renomear
                        </button>
                        <button className="btn" data-variant="ghost" data-size="sm"
                                onClick={() => handlers.deleteCategory(cat.id)}
                                disabled={cat.locked || subs.length > 0}
                                title={cat.locked ? "Categoria essencial · não pode ser excluída"
                                                  : subs.length > 0 ? "Mova as subcategorias antes" : "Excluir categoria"}
                                style={{ color: cat.locked || subs.length > 0 ? "var(--fg-3)" : "var(--crit)" }}>
                          <I.Trash size={11} />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div style={{ padding: "8px 16px 12px" }}>
                  {subs.length === 0 ? (
                    <div style={{
                      padding: "10px 12px", fontSize: 11.5, color: "var(--fg-3)",
                      background: "var(--bg-2)", border: "1px dashed var(--line)", borderRadius: 4, textAlign: "center",
                    }}>
                      Sem subcategorias
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {subs.map((sub) => {
                        const isSubEditing = editing?.type === "sub" && editing.id === sub.id;
                        const usage = entryCount(sub.id);
                        return (
                          <div key={sub.id} style={{
                            display: "grid",
                            gridTemplateColumns: "20px 1fr 70px 100px",
                            gap: 8, alignItems: "center",
                            padding: "6px 10px",
                            background: "var(--bg-2)", borderRadius: 3,
                            border: "1px solid var(--line)",
                          }}>
                            <input type="color" value={sub.color}
                                   onChange={(e) => handlers.recolorSubcategory(sub.id, e.target.value)}
                                   disabled={sub.locked}
                                   style={{ width: 16, height: 16, padding: 0, border: "none", background: "transparent", cursor: sub.locked ? "not-allowed" : "pointer" }} />
                            {isSubEditing ? (
                              <input className="input" autoFocus value={editing.value}
                                     onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                                     onKeyDown={(e) => {
                                       if (e.key === "Enter") saveEdit();
                                       if (e.key === "Escape") cancelEdit();
                                     }} />
                            ) : (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--fg-0)", minWidth: 0 }}>
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {sub.name}
                                </span>
                                {sub.locked && <I.Lock size={9} style={{ color: "var(--fg-3)", flexShrink: 0 }} />}
                                {sub.autofeed && (
                                  <span style={{
                                    fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent-bright)",
                                    letterSpacing: "0.06em", textTransform: "uppercase", padding: "1px 5px",
                                    background: "var(--accent-soft)", border: "1px solid var(--accent-line)", borderRadius: 99,
                                    display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0,
                                  }} title={
                                    sub.autofeed === "stock-adjust"
                                      ? "Auto-feed: vem do impacto financeiro dos inventários"
                                      : "Auto-feed: alimentado automaticamente"
                                  }>
                                    <I.Bell size={9} />auto
                                  </span>
                                )}
                              </span>
                            )}
                            <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", letterSpacing: "0.04em", textAlign: "right" }}>
                              {usage} {usage === 1 ? "lanç." : "lançs."}
                            </span>
                            <div style={{ display: "flex", gap: 3, justifyContent: "flex-end" }}>
                              {isSubEditing ? (
                                <>
                                  <button className="btn" data-size="sm" onClick={cancelEdit}>×</button>
                                  <button className="btn" data-variant="primary" data-size="sm" onClick={saveEdit}>Salvar</button>
                                </>
                              ) : (
                                <>
                                  <button className="btn" data-variant="ghost" data-size="sm"
                                          onClick={() => startEdit("sub", sub.id, sub.name)}
                                          disabled={sub.locked}
                                          style={{ padding: "3px 6px" }}>
                                    <I.Edit size={10} />
                                  </button>
                                  <button className="btn" data-variant="ghost" data-size="sm"
                                          onClick={() => handlers.deleteSubcategory(sub.id)}
                                          disabled={sub.locked || usage > 0}
                                          title={sub.locked ? "Subcategoria essencial · não pode ser excluída"
                                                            : usage > 0 ? `Há ${usage} lançamento(s) · migre antes` : "Excluir"}
                                          style={{ padding: "3px 6px", color: sub.locked || usage > 0 ? "var(--fg-3)" : "var(--crit)" }}>
                                    <I.Trash size={10} />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {creatingSubFor === cat.id ? (
                    <NewSubcategoryRow
                      categoryId={cat.id}
                      onCancel={() => setCreatingSubFor(null)}
                      onSave={(data) => { handlers.createSubcategory(data); setCreatingSubFor(null); }}
                    />
                  ) : (
                    <button className="btn" data-variant="ghost" data-size="sm"
                            onClick={() => setCreatingSubFor(cat.id)}
                            style={{ alignSelf: "flex-start", marginTop: 8 }}>
                      <I.Plus size={10} />Nova subcategoria
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{
          padding: "10px 12px",
          background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4,
          display: "flex", alignItems: "flex-start", gap: 10,
          fontSize: 11.5, color: "var(--fg-2)",
        }}>
          <I.AlertTriangle size={12} style={{ color: "var(--fg-3)", marginTop: 2, flexShrink: 0 }} />
          <span>
            <strong style={{ color: "var(--fg-0)" }}>Receita</strong>, <strong style={{ color: "var(--fg-0)" }}>Deduções</strong> e <strong style={{ color: "var(--fg-0)" }}>CMV</strong> são travadas porque alimentam fórmulas do fechamento contábil.{" "}
            <strong style={{ color: "var(--fg-0)" }}>Ajuste de estoque</strong> é calculado automaticamente como a variação do estoque no mês (estoque inicial − estoque final, dos snapshots) — é o que faz o Custo de Mercadoria bater com o CMV real contábil.
          </span>
        </div>
      </div>
    </ModalShell>
  );
}

function NewCategoryRow({ onCancel, onSave }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("expense");
  // Guard síncrono contra duplo clique — onSave dispara insert no banco e a linha
  // fecha logo após; sem isso, 2 cliques no mesmo tick criam categorias duplicadas.
  const submittedRef = useRef(false);
  const submit = () => {
    if (!name.trim() || submittedRef.current) return;
    submittedRef.current = true;
    onSave({ name, kind });
  };
  return (
    <div className="card" style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, background: "var(--bg-2)" }}>
      <input className="input" autoFocus value={name}
             placeholder="Nome da categoria"
             onChange={(e) => setName(e.target.value)}
             onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }}
             style={{ flex: 1 }} />
      <select className="select" value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 160 }}>
        <option value="expense">Despesa</option>
        <option value="financial">Financeira</option>
        <option value="deduction">Dedução</option>
      </select>
      <button className="btn" data-size="sm" onClick={onCancel}>Cancelar</button>
      <button className="btn" data-variant="primary" data-size="sm"
              disabled={!name.trim()}
              onClick={submit}>
        <I.Check size={11} />Criar
      </button>
    </div>
  );
}

function NewSubcategoryRow({ categoryId, onCancel, onSave }) {
  const DRE_SUB_COLORS = window.DRE_SUB_COLORS;
  const [name, setName] = useState("");
  const [color, setColor] = useState(DRE_SUB_COLORS?.[0] || "#2d8c66");
  // Guard síncrono contra duplo clique — onSave dispara insert no banco e a linha
  // fecha logo após; sem isso, 2 cliques no mesmo tick criam subcategorias duplicadas.
  const submittedRef = useRef(false);
  const submit = () => {
    if (!name.trim() || submittedRef.current) return;
    submittedRef.current = true;
    onSave({ name, category: categoryId, color });
  };
  return (
    <div style={{
      marginTop: 8, padding: "8px 10px",
      background: "var(--bg-3)", border: "1px solid var(--line-strong)", borderRadius: 4,
      display: "flex", alignItems: "center", gap: 8,
    }}>
      <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
             style={{ width: 20, height: 20, padding: 0, border: "none", background: "transparent", cursor: "pointer" }} />
      <input className="input" autoFocus value={name}
             placeholder="Nome da subcategoria"
             onChange={(e) => setName(e.target.value)}
             onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }}
             style={{ flex: 1 }} />
      <button className="btn" data-size="sm" onClick={onCancel}>Cancelar</button>
      <button className="btn" data-variant="primary" data-size="sm"
              disabled={!name.trim()}
              onClick={submit}>
        <I.Check size={11} />Criar
      </button>
    </div>
  );
}

window.Dre = Dre;
// DreStat é usado também pelo Checklist de fechamento do Financeiro (page-finance.jsx).
window.DreStat = DreStat;
