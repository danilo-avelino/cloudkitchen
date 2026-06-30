// CMV & margem — real-only.
// CMV = Σ(saídas de estoque kind=out × custo unitário, ignorando insumos com compose_cmv=false)
//     + Σ(ajustes de inventário no período × custo unitário, só perdas Δ<0) → custo compartilhado
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

import {
  CMV_TARGET, cmvBand, buildWeeklyAnalysis, projectCurrentWeek,
} from "./lib-cmv-weekly.js";

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
const _fmtPct = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
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

// Detalhe de uma única célula (operação × dia) do heatmap: faturamento do dia +
// insumos que compõem o CMV daquele dia (qty e custo). Replica o rateio de uso
// compartilhado de buildDailyRows pra o total bater com a célula clicada.
function buildDayOpDetail(movements, revenueEntries, sharedSplits, op, isoDate) {
  let revenue = 0;
  for (const re of revenueEntries) {
    if (String(re.date || "").slice(0, 10) === isoDate && re.op === op) revenue += Number(re.revenue) || 0;
  }
  const acc = {};
  const add = (mv, frac) => {
    const id = mv.itemId || mv.item;
    if (!acc[id]) acc[id] = { id, name: mv.item, unit: mv.unit, qty: 0, cost: 0 };
    const qty = Math.abs(Number(mv.delta) || 0) * frac;
    acc[id].qty  += qty;
    acc[id].cost += qty * (Number(mv.unitCost) || 0);
  };
  for (const mv of movements) {
    if (mv.kind !== "out" && mv.kind !== "loss" && mv.kind !== "expiration") continue;
    if (mv.composeCmv === false) continue;
    if (_spDay(mv.at) !== isoDate) continue;
    const splits = mv.referenceId ? sharedSplits[mv.referenceId] : null;
    if (splits && splits.length > 0) {
      const totalPct = splits.reduce((s, x) => s + (x.pct || 0), 0) || 1;
      const sp = splits.find((x) => x.slug === op);
      if (sp) add(mv, (sp.pct || 0) / totalPct);
    } else if (mv.op === op) {
      add(mv, 1);
    }
  }
  const items = Object.values(acc).sort((a, b) => b.cost - a.cost);
  const cogs = items.reduce((s, r) => s + r.cost, 0);
  return { revenue, items, cogs, cmv: revenue > 0 ? (cogs / revenue) * 100 : null };
}

// "Quarta-feira, 24/06/2026" a partir de um ISO YYYY-MM-DD.
function dayLabelFull(iso) {
  const d = new Date(iso + "T12:00:00");
  const names = ["Domingo","Segunda-feira","Terça-feira","Quarta-feira","Quinta-feira","Sexta-feira","Sábado"];
  return `${names[d.getDay()]}, ${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
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

// ===== Semanal · ciclos Seg→Dom (independem da data do mês) =====

// Segunda-feira (YYYY-MM-DD) da semana que contém `iso`.
function weekMonday(iso) {
  const d = new Date(iso + "T12:00:00");
  const dow = d.getDay();               // 0=Dom … 6=Sáb
  const back = dow === 0 ? 6 : dow - 1; // dias desde a segunda
  d.setDate(d.getDate() - back);
  return _ymd(d);
}

// Domingo (YYYY-MM-DD) a partir da segunda da semana.
function weekSunday(mondayIso) {
  const d = new Date(mondayIso + "T12:00:00");
  d.setDate(d.getDate() + 6);
  return _ymd(d);
}

// "22/06 – 28/06" a partir da segunda.
function weekRangeShort(mondayIso) {
  const mon = new Date(mondayIso + "T12:00:00");
  const sun = new Date(mon); sun.setDate(sun.getDate() + 6);
  const f = (d) => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}`;
  return `${f(mon)} – ${f(sun)}`;
}

// "22/06/2026 – 28/06/2026" (com ano) para subtítulo/exportação.
function weekRangeFull(mondayIso) {
  const mon = new Date(mondayIso + "T12:00:00");
  const sun = new Date(mon); sun.setDate(sun.getDate() + 6);
  const f = (d) => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
  return `${f(mon)} – ${f(sun)}`;
}

// "08/06" (DD/MM da segunda) — tick curto para o eixo dos gráficos semanais.
function weekTick(mondayIso) {
  const d = new Date(mondayIso + "T12:00:00");
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}`;
}

// Tendência da variação de CMV (pp): estável quando |Δ| < 0,02pp; senão sobe (ruim) / cai (bom).
function cmvTrend(delta) {
  if (delta == null || Math.abs(delta) < 0.02) return "flat";
  return delta > 0 ? "up" : "down";
}
// Cor semântica da tendência (mapa para os tokens do projeto).
const _TREND_COLOR = { up: "var(--crit)", down: "var(--ok)", flat: "var(--warn)" };
const trendColor = (t) => _TREND_COLOR[t] || "var(--fg-3)";

// Cor determinística do dot de categoria (HSL a partir do nome). Sem mapa fixo — o conjunto
// de categorias varia por tenant; o hash dá uma cor estável por categoria.
function catColor(name) {
  if (!name) return "var(--fg-4)";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 52% 58%)`;
}

// ── Períodos da Análise de insumos · semana (Seg→Dom) ou mês civil ──
// Cada granularidade expõe a mesma interface (chave, intervalo from/to em YMD e rótulos),
// para que o grid, os KPIs e o modal sejam agnósticos à granularidade.
const _MESES_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const _MESES_PT_FULL = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const monthKeyOf = (ymd) => String(ymd || "").slice(0, 7);            // "YYYY-MM"
const monthFrom  = (key) => key + "-01";
const monthTo    = (key) => { const [y, m] = key.split("-").map(Number); return _ymd(new Date(y, m, 0)); }; // último dia
const monthRangeFull = (key) => { const [y, m] = key.split("-").map(Number); return `${_MESES_PT_FULL[m - 1]} ${y}`; };
const monthTick      = (key) => { const [y, m] = key.split("-").map(Number); return `${_MESES_PT[m - 1]}/${String(y).slice(2)}`; };

// Formatadores e wording por granularidade — ponto único do switch semana/mês.
function periodFmt(gran) {
  if (gran === "month") {
    return { keyOf: monthKeyOf, short: monthRangeFull, tick: monthTick, full: monthRangeFull, from: monthFrom, to: monthTo, noun: "mês", nounCap: "Mês", adj: "mensal" };
  }
  return { keyOf: weekMonday, short: weekRangeShort, tick: weekTick, full: weekRangeFull, from: (k) => k, to: weekSunday, noun: "semana", nounCap: "Semana", adj: "semanal" };
}

// Custo que compõe o CMV de um movimento de saída (out/loss/expiration). Ajustes de
// inventário não entram — o semanal espelha as "saídas de estoque" do heatmap diário.
function cmvOutCost(mv) {
  if (mv.composeCmv === false) return 0;
  if (mv.kind !== "out" && mv.kind !== "loss" && mv.kind !== "expiration") return 0;
  return Math.abs(Number(mv.delta) || 0) * (Number(mv.unitCost) || 0);
}

// Fração do custo de um movimento atribuída à operação `op` (slug). "all" → 1. Caso
// contrário aplica o rateio de uso compartilhado (splits) ou a operação primária —
// mesma regra do heatmap diário / "Resultado por operação".
function cmvOpFrac(mv, op, sharedSplits) {
  if (op === "all") return 1;
  const splits = mv.referenceId ? sharedSplits[mv.referenceId] : null;
  if (splits && splits.length > 0) {
    const totalPct = splits.reduce((s, x) => s + (x.pct || 0), 0) || 1;
    const sp = splits.find((x) => x.slug === op);
    return sp ? (sp.pct || 0) / totalPct : 0;
  }
  return mv.op === op ? 1 : 0;
}

// Agrega faturamento + custo de saídas por semana (Seg→Dom), opcionalmente filtrado por
// operação (slug). Com filtro, o custo é rateado pelos splits de uso compartilhado.
// Retorna semanas da mais recente p/ a mais antiga: { week (segunda ISO), revenue, cogs, cmv, margin }.
function buildWeeklyRows(revenueEntries, movements, sharedSplits = {}, opFilter = "all") {
  const acc = {};
  const ensure = (mon) => acc[mon] || (acc[mon] = { week: mon, revenue: 0, cogs: 0 });
  for (const re of revenueEntries) {
    if (opFilter !== "all" && re.op !== opFilter) continue;
    const d = String(re.date || "").slice(0, 10);
    if (!d) continue;
    ensure(weekMonday(d)).revenue += Number(re.revenue) || 0;
  }
  for (const mv of movements) {
    const frac = cmvOpFrac(mv, opFilter, sharedSplits);
    if (!frac) continue;
    const cost = cmvOutCost(mv) * frac;
    if (!cost) continue;
    const d = _spDay(mv.at);
    if (!d) continue;
    ensure(weekMonday(d)).cogs += cost;
  }
  return Object.values(acc).map((w) => ({
    ...w,
    cmv:    w.revenue > 0 ? (w.cogs / w.revenue) * 100 : null,
    margin: w.revenue > 0 ? ((w.revenue - w.cogs) / w.revenue) * 100 : null,
  })).sort((a, b) => b.week.localeCompare(a.week));
}

// Detalhe de uma semana: faturamento + insumos que compõem o CMV (saídas) no intervalo
// Seg→Dom, opcionalmente filtrado por operação. Mesmo formato de buildDayOpDetail.
function buildWeekDetail(movements, revenueEntries, mondayIso, sharedSplits = {}, opFilter = "all") {
  const from = mondayIso, to = weekSunday(mondayIso);
  let revenue = 0;
  for (const re of revenueEntries) {
    if (opFilter !== "all" && re.op !== opFilter) continue;
    const d = String(re.date || "").slice(0, 10);
    if (d >= from && d <= to) revenue += Number(re.revenue) || 0;
  }
  const acc = {};
  for (const mv of movements) {
    const frac = cmvOpFrac(mv, opFilter, sharedSplits);
    if (!frac) continue;
    const baseCost = cmvOutCost(mv);
    if (!baseCost) continue;
    const d = _spDay(mv.at);
    if (d < from || d > to) continue;
    const id = mv.itemId || mv.item;
    if (!acc[id]) acc[id] = { id, name: mv.item, unit: mv.unit, qty: 0, cost: 0 };
    acc[id].qty  += Math.abs(Number(mv.delta) || 0) * frac;
    acc[id].cost += baseCost * frac;
  }
  const items = Object.values(acc).sort((a, b) => b.cost - a.cost);
  const cogs = items.reduce((s, r) => s + r.cost, 0);
  return { revenue, items, cogs, cmv: revenue > 0 ? (cogs / revenue) * 100 : null };
}

// Consumo (qty + custo) por (insumo × período) restrito às chaves `keySet`, com filtro de
// operação (rateando uso compartilhado pelos splits). `keyOf(dayYMD)` define a granularidade
// (semana Seg→Dom ou mês civil). Ordenado por custo total desc. Base da "Análise de insumos":
// { id, name, unit, category, totalCost, byKey: { [periodKey]: { qty, cost } } }.
function buildItemByPeriod(movements, sharedSplits, opFilter, keyOf, keySet) {
  const acc = {};
  for (const mv of movements) {
    const frac = cmvOpFrac(mv, opFilter, sharedSplits);
    if (!frac) continue;
    const baseCost = cmvOutCost(mv);
    if (!baseCost) continue;
    const d = _spDay(mv.at);
    if (!d) continue;
    const key = keyOf(d);
    if (!keySet.has(key)) continue;
    const id = mv.itemId || mv.item;
    if (!acc[id]) acc[id] = { id, name: mv.item, unit: mv.unit, category: mv.categoryName, totalCost: 0, byKey: {} };
    const qty  = Math.abs(Number(mv.delta) || 0) * frac;
    const cost = baseCost * frac;
    acc[id].totalCost += cost;
    if (!acc[id].byKey[key]) acc[id].byKey[key] = { qty: 0, cost: 0 };
    acc[id].byKey[key].qty  += qty;
    acc[id].byKey[key].cost += cost;
  }
  return Object.values(acc).sort((a, b) => b.totalCost - a.totalCost);
}

// ===== Camada de dados do modal de detalhe do insumo =====
// PONTO ÚNICO DE TROCA para a API real: hoje computa a partir das tabelas reais
// (saídas de estoque + faturamento + fichas técnicas + metadados do item). Amanhã,
// trocar o corpo por uma chamada ao backend que devolva o mesmo shape (InsumoDetail).
// Não espalhar dados pelos componentes — tudo o que o modal mostra sai daqui.
/**
 * @typedef {Object} InsumoDetail
 * @property {{name:string,unit:string,category:?string,sku:?string,supplier:?string,rank:number,weekLabel:string,opName:string}} header
 * @property {{cmv:?number,cmvDeltaPp:?number,cost:number,qty:number,unit:?string,unitPrice:number,unitPriceDeltaPct:?number,sharePct:?number}} kpis
 * @property {{available:boolean,price:number,volume:number,revenue:number,total:number}} decomposition  // efeitos em pp
 * @property {Array<{slug:string,name:string,color:string,cmv:?number,cost:number,isCurrent:boolean}>} byOperation
 * @property {{available:boolean,rows:Array<{dish:string,opName:?string,portionQty:number,portionUnit:string,pctOfDishCost:number}>}} usage
 * @property {Array<{tone:'accent'|'success'|'danger',text:string}>} recommendations
 * @returns {Promise<InsumoDetail>}
 */
async function getInsumoDetail({ tenantId, itemId, op, period, prevPeriod, rank, noun = "semana" }) {
  const fromIso = new Date(prevPeriod.from + "T00:00:00").toISOString();
  const toEnd   = new Date(period.to + "T23:59:59.999").toISOString();

  const [movRes, revRes, metaRes, usageRes] = await Promise.all([
    dbListStockMovements?.(tenantId, fromIso, toEnd, { limit: 20000 }) || { data: [] },
    dbListRevenueEntries?.(tenantId, prevPeriod.from, period.to) || { data: [] },
    dbGetInsumoMeta?.(itemId) || { data: null },
    dbListInsumoUsage?.(tenantId, itemId, op) || { data: [] },
  ]);
  const movements = movRes.data || [];
  const revenue   = revRes.data || [];

  // Splits de uso compartilhado resolvidos (op uuid → slug/name/color).
  const reqIds = movements.filter((m) => m.referenceType === "kitchen_request" && m.referenceId).map((m) => m.referenceId);
  const splitsRaw = (await (dbListSharedSplits?.(tenantId, reqIds) || { data: {} })).data || {};
  const splits = {};
  for (const [rid, arr] of Object.entries(splitsRaw)) {
    splits[rid] = arr.map((s) => { const o = MOCK.opById(s.op); return { slug: o?.slug || s.op, name: o?.name || "—", color: o?.color || "var(--fg-3)", pct: s.pct }; });
  }

  const inRange = (mv, p) => { const d = _spDay(mv.at); return d >= p.from && d <= p.to; };
  // Consumo do insumo (qty/custo) num período, no escopo de operação.
  const itemAgg = (p, scope) => {
    let qty = 0, cost = 0;
    for (const mv of movements) {
      if ((mv.itemId || mv.item) !== itemId) continue;
      if (!inRange(mv, p)) continue;
      const frac = cmvOpFrac(mv, scope, splits); if (!frac) continue;
      const base = cmvOutCost(mv); if (!base) continue;
      qty  += Math.abs(Number(mv.delta) || 0) * frac;
      cost += base * frac;
    }
    return { qty, cost };
  };
  const totalCostRange = (p, scope) => {
    let c = 0;
    for (const mv of movements) {
      if (!inRange(mv, p)) continue;
      const frac = cmvOpFrac(mv, scope, splits); if (!frac) continue;
      c += cmvOutCost(mv) * frac;
    }
    return c;
  };
  const revRange = (p, scope) => {
    let r = 0;
    for (const re of revenue) {
      if (scope !== "all" && re.op !== scope) continue;
      const d = String(re.date || "").slice(0, 10);
      if (d < p.from || d > p.to) continue;
      r += Number(re.revenue) || 0;
    }
    return r;
  };

  const cur = itemAgg(period, op), prev = itemAgg(prevPeriod, op);
  const revCur = revRange(period, op), revPrev = revRange(prevPeriod, op);
  const cmvCur  = revCur  > 0 ? (cur.cost  / revCur)  * 100 : null;
  const cmvPrev = revPrev > 0 ? (prev.cost / revPrev) * 100 : null;
  const cmvDeltaPp = (cmvCur != null && cmvPrev != null) ? cmvCur - cmvPrev : null;
  const pCur  = cur.qty  > 0 ? cur.cost  / cur.qty  : 0;
  const pPrev = prev.qty > 0 ? prev.cost / prev.qty : 0;
  const unitPriceDeltaPct = pPrev > 0 ? ((pCur - pPrev) / pPrev) * 100 : null;
  const totCur = totalCostRange(period, op);
  const sharePct = totCur > 0 ? (cur.cost / totCur) * 100 : null;

  // Decomposição aditiva da variação de CMV (em pp). Requer período anterior comparável.
  let decomposition = { available: false, price: 0, volume: 0, revenue: 0, total: cmvDeltaPp || 0 };
  if (revPrev > 0 && prev.qty > 0 && cmvCur != null && cmvPrev != null) {
    const price  = ((pCur - pPrev) * prev.qty / revPrev) * 100;
    const volume = ((cur.qty - prev.qty) * pPrev / revPrev) * 100;
    const rev    = (prev.qty * pPrev) * (1 / revCur - 1 / revPrev) * 100;
    const total  = cmvCur - cmvPrev;
    const residual = total - (price + volume + rev); // termo de interação → incorporado ao volume
    decomposition = { available: true, price, volume: volume + residual, revenue: rev, total };
  }

  // Mesmo insumo em todas as operações (período atual).
  const opCost = {};
  for (const mv of movements) {
    if ((mv.itemId || mv.item) !== itemId) continue;
    if (!inRange(mv, period)) continue;
    const base = cmvOutCost(mv); if (!base) continue;
    const sp = mv.referenceId ? splits[mv.referenceId] : null;
    if (sp && sp.length) {
      const tot = sp.reduce((s, x) => s + (x.pct || 0), 0) || 1;
      for (const s of sp) opCost[s.slug] = (opCost[s.slug] || 0) + base * ((s.pct || 0) / tot);
    } else if (mv.op && mv.op !== "—") {
      opCost[mv.op] = (opCost[mv.op] || 0) + base;
    }
  }
  const byOperation = Object.entries(opCost).map(([slug, cost]) => {
    const o = MOCK.opById(slug);
    const r = revRange(period, slug);
    return { slug, name: o?.name || slug, color: o?.color || "var(--fg-3)", cost, cmv: r > 0 ? (cost / r) * 100 : null, isCurrent: slug === op };
  }).filter((r) => r.cost > 0.005).sort((a, b) => (b.cmv ?? -1) - (a.cmv ?? -1));

  // Motor de regras simples para recomendações.
  const recommendations = [];
  const cheaper = byOperation.filter((r) => r.cmv != null && r.slug !== op).sort((a, b) => a.cmv - b.cmv)[0];
  if (op !== "all" && cmvCur != null && cheaper && cheaper.cmv < cmvCur - 0.1) {
    const deltaPp = cmvCur - cheaper.cmv;
    const monthly = (deltaPp / 100) * revCur * (noun === "mês" ? 1 : 52 / 12); // economia mensal aproximada
    recommendations.push({ tone: "accent", text: `Custo ${deltaPp.toFixed(2)}% acima da ${cheaper.name}. Alinhar fornecedor/preço pode economizar ~${_fmtBRLci(monthly)}/mês.` });
  }
  if (unitPriceDeltaPct != null && unitPriceDeltaPct < -3) {
    recommendations.push({ tone: "success", text: `Preço unitário caiu ${Math.abs(unitPriceDeltaPct).toFixed(1)}% ${noun === "mês" ? "neste mês" : "nesta semana"} — boa janela para fechar volume ou contrato.` });
  }
  if (cmvDeltaPp != null && cmvDeltaPp > 0.3) {
    recommendations.push({ tone: "danger", text: `CMV subiu ${cmvDeltaPp.toFixed(2)}% vs. ${noun === "mês" ? "o mês" : "a semana"} anterior — acompanhe preço e volume.` });
  }

  const meta = metaRes.data || {};
  return {
    header: {
      name: meta.name || null, unit: meta.unit || null, category: meta.category || null,
      sku: meta.sku || null, supplier: meta.supplier || null, rank,
      weekLabel: period.label, opName: op === "all" ? "Todas as operações" : (MOCK.opById(op)?.name || op),
    },
    kpis: { cmv: cmvCur, cmvDeltaPp, cost: cur.cost, qty: cur.qty, unit: meta.unit || null, unitPrice: pCur, unitPriceDeltaPct, sharePct },
    decomposition,
    byOperation,
    usage: { available: (usageRes.data || []).length > 0, rows: usageRes.data || [] },
    recommendations,
  };
}

function CMV({ setPage }) {
  const [view, setView] = useState("consolidado"); // consolidado | items | semanal
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
  // Célula do heatmap aberta no modal de detalhe · { op (slug), date (ISO) }
  const [dayDetail, setDayDetail] = useState(null);

  // Heatmap fixo · últimos 7 dias (independe do filtro de período de KPI).
  const [heatRevenue, setHeatRevenue] = useState([]);
  const [heatMovements, setHeatMovements] = useState([]);

  // Splits de rateio das requisições "Uso compartilhado" → { [requestId]: [{op, pct}] }
  const [sharedSplits, setSharedSplits] = useState({});

  // Aba "Semanal" · janela própria (semana atual + 7 completas), independe do período.
  const [weeklyRevenue, setWeeklyRevenue] = useState([]);
  const [weeklyMovements, setWeeklyMovements] = useState([]);
  const [weeklySharedSplits, setWeeklySharedSplits] = useState({});
  const [weeklyLoading, setWeeklyLoading] = useState(true);
  const [weeklyOpFilter, setWeeklyOpFilter] = useState("all"); // all | <operation slug>
  // Semana aberta no modal de detalhe · segunda-feira ISO (YYYY-MM-DD).
  const [weekDetail, setWeekDetail] = useState(null);
  // Insumo aberto no modal avançado · { itemId, name, ..., period, prevPeriod, granularity }
  const [insumoCtx, setInsumoCtx] = useState(null);

  // Análise de insumos · granularidade da comparação (semana atual vs mês civil). O modo
  // "mês" precisa de uma janela própria alinhada a meses completos (a janela semanal não
  // cobre meses civis inteiros) — carregada sob demanda.
  const [insumoGran, setInsumoGran] = useState("week"); // week | month
  const [monthRevenue, setMonthRevenue] = useState([]);
  const [monthMovements, setMonthMovements] = useState([]);
  const [monthSharedSplits, setMonthSharedSplits] = useState({});
  const [monthLoading, setMonthLoading] = useState(false);
  const [monthLoaded, setMonthLoaded] = useState(false);

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

  // Carrega a janela da aba "Semanal" uma vez (não depende do filtro de período):
  // semana atual + 7 semanas completas (Seg→Dom).
  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setWeeklyLoading(false); return; }
    let cancelled = false;
    setWeeklyLoading(true);
    (async () => {
      const ctx = await dbGetCurrentContext?.();
      const tid = ctx?.tenant?.id;
      if (cancelled || !tid) { setWeeklyLoading(false); return; }
      const curMon = weekMonday(_ymd(new Date()));
      const start = new Date(curMon + "T00:00:00"); start.setDate(start.getDate() - 7 * 7);
      const fromDate = _ymd(start);
      const toDate   = _ymd(new Date());
      const fromIso = new Date(fromDate + "T00:00:00").toISOString();
      const toEnd   = new Date(toDate   + "T23:59:59.999").toISOString();
      const [revRes, movRes] = await Promise.all([
        dbListRevenueEntries?.(tid, fromDate, toDate) || { data: [] },
        dbListStockMovements?.(tid, fromIso, toEnd, { limit: 20000 }) || { data: [] },
      ]);
      if (cancelled) return;
      const movsData = movRes.data || [];
      // Splits das requisições compartilhadas — necessários para ratear o custo ao
      // filtrar por operação (sem filtro, a soma independe do rateio).
      const reqIds = movsData
        .filter((m) => m.referenceType === "kitchen_request" && m.referenceId)
        .map((m) => m.referenceId);
      const splitsRes = await dbListSharedSplits?.(tid, reqIds) || { data: {} };
      if (cancelled) return;
      setWeeklyRevenue(revRes.data || []);
      setWeeklyMovements(movsData);
      setWeeklySharedSplits(splitsRes.data || {});
      setWeeklyLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

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

  // Mesma resolução, para a janela própria da aba "Semanal".
  const weeklySplitsResolved = useMemo(() => {
    const out = {};
    for (const [reqId, splits] of Object.entries(weeklySharedSplits)) {
      out[reqId] = splits.map((s) => {
        const op = MOCK.opById(s.op);
        return { slug: op?.slug || s.op, name: op?.name || "—", color: op?.color || "var(--fg-3)", pct: s.pct };
      });
    }
    return out;
  }, [weeklySharedSplits]);

  // Janela mensal da "Análise de insumos" (modo mês) · 6 meses + mês corrente, carregada
  // só quando o switch entra em "mês" (uma vez).
  useEffect(() => {
    if (insumoGran !== "month" || monthLoaded) return;
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setMonthLoading(false); return; }
    let cancelled = false;
    setMonthLoading(true);
    (async () => {
      const ctx = await dbGetCurrentContext?.();
      const tid = ctx?.tenant?.id;
      if (cancelled || !tid) { setMonthLoading(false); return; }
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() - 6, 1); // 6 meses anteriores + corrente
      const fromDate = _ymd(start);
      const toDate   = _ymd(now);
      const fromIso = new Date(fromDate + "T00:00:00").toISOString();
      const toEnd   = new Date(toDate   + "T23:59:59.999").toISOString();
      const [revRes, movRes] = await Promise.all([
        dbListRevenueEntries?.(tid, fromDate, toDate) || { data: [] },
        dbListStockMovements?.(tid, fromIso, toEnd, { limit: 50000 }) || { data: [] },
      ]);
      if (cancelled) return;
      const movsData = movRes.data || [];
      const reqIds = movsData
        .filter((m) => m.referenceType === "kitchen_request" && m.referenceId)
        .map((m) => m.referenceId);
      const splitsRes = await dbListSharedSplits?.(tid, reqIds) || { data: {} };
      if (cancelled) return;
      setMonthRevenue(revRes.data || []);
      setMonthMovements(movsData);
      setMonthSharedSplits(splitsRes.data || {});
      setMonthLoaded(true);
      setMonthLoading(false);
    })();
    return () => { cancelled = true; };
  }, [insumoGran, monthLoaded, dbStatus.state, dbStatus.isOnline]);

  const monthSplitsResolved = useMemo(() => {
    const out = {};
    for (const [reqId, splits] of Object.entries(monthSharedSplits)) {
      out[reqId] = splits.map((s) => {
        const op = MOCK.opById(s.op);
        return { slug: op?.slug || s.op, name: op?.name || "—", color: op?.color || "var(--fg-3)", pct: s.pct };
      });
    }
    return out;
  }, [monthSharedSplits]);

  const daily = useMemo(
    () => buildDailyRows(revenueEntries, movements, sharedSplitsResolved),
    [revenueEntries, movements, sharedSplitsResolved],
  );

  // Custo dos ajustes de inventário que compõem CMV — só perdas (delta<0).
  // Sobras (delta>0) NÃO abatem o CMV: contagem pra cima é correção de saldo /
  // estoque inicial, não ganho operacional. Alinhado ao Dashboard. Respeita compose_cmv.
  const adjustLossCost = useMemo(() => {
    let total = 0;
    for (const mv of movements) {
      if (mv.kind !== "adjust") continue;
      if (mv.composeCmv === false) continue;
      if (Number(mv.delta || 0) >= 0) continue; // sobras não compõem CMV
      total += Math.abs(Number(mv.delta || 0)) * Number(mv.unitCost || 0);
    }
    return total;
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
  //  2) Ajustes de inventário (só perdas Δ<0) + desperdício sem operação — rateados
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
    const sharedRevCost = adjustLossCost + wasteSharedCost;
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
  }, [movements, sharedSplitsResolved, daily, adjustLossCost, wasteSharedCost]);

  // Totais consolidados do período (consumo + ajustes + desperdício como custo compartilhado)
  const totals = useMemo(() => {
    const rev         = daily.reduce((s, r) => s + r.revenue, 0);
    const cogsConsumo = daily.reduce((s, r) => s + r.cogs, 0);
    const cogs        = cogsConsumo + adjustLossCost + wasteSharedCost;
    return {
      revenue: rev,
      cogs,
      cogsConsumo,
      cogsAdjust: adjustLossCost,
      cogsWasteShared: wasteSharedCost,
      cmv:    rev > 0 ? (cogs / rev) * 100 : 0,
      margin: rev > 0 ? ((rev - cogs) / rev) * 100 : 0,
      days:   new Set(daily.map((r) => r.date)).size,
      opsCount: new Set(daily.map((r) => r.op)).size,
    };
  }, [daily, adjustLossCost, wasteSharedCost]);

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
    const sharedCost = adjustLossCost + wasteSharedCost;
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
  }, [daily, adjustLossCost, wasteSharedCost]);

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
    return { days: dates.map(dayLabel), dates, rows };
  }, [heatRevenue, heatMovements, sharedSplitsResolved]);

  // Operações presentes na janela semanal — alimentam o filtro da aba.
  const weeklyAvailableOps = useMemo(() => {
    const seen = new Map();
    for (const mv of weeklyMovements) {
      if (!mv.operationId || mv.op === "—") continue;
      if (!seen.has(mv.op)) seen.set(mv.op, { slug: mv.op, name: mv.operationName, color: mv.operationColor });
    }
    return [...seen.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [weeklyMovements]);

  // Reseta o filtro semanal se a operação some da janela.
  useEffect(() => {
    if (weeklyOpFilter !== "all" && !weeklyAvailableOps.some((o) => o.slug === weeklyOpFilter)) setWeeklyOpFilter("all");
  }, [weeklyAvailableOps, weeklyOpFilter]);

  // Semanas (Seg→Dom) da janela própria · mais recente primeiro · filtradas por operação.
  const weekly = useMemo(
    () => buildWeeklyRows(weeklyRevenue, weeklyMovements, weeklySplitsResolved, weeklyOpFilter),
    [weeklyRevenue, weeklyMovements, weeklySplitsResolved, weeklyOpFilter],
  );
  const currentWeekMon = weekMonday(_ymd(new Date()));

  // Análise da aba Semanal (predicado de semana válida + média corrigida + campos das boxes).
  const weeklyAnalysis = useMemo(
    () => buildWeeklyAnalysis(weekly, currentWeekMon),
    [weekly, currentWeekMon],
  );
  const weeklyProjection = useMemo(
    () => projectCurrentWeek(weeklyAnalysis.current, currentWeekMon),
    [weeklyAnalysis, currentWeekMon],
  );

  // Bloco "itens fora do CMV" da aba Semanal: total na janela + % do custo da última
  // semana válida (insumos com compose_cmv=false não computados).
  const weeklyExcluded = useMemo(() => {
    const all = excludedImpact(weeklyMovements, "0000-01-01", "9999-12-31");
    const lastValid = weeklyAnalysis.weeks.find((w) => w.valid);
    let lastWeekPct = null, lastWeekLabel = null;
    if (lastValid) {
      const inWeek = excludedImpact(weeklyMovements, lastValid.week, weekSunday(lastValid.week));
      lastWeekPct = lastValid.cogs > 0 ? (inWeek.total / lastValid.cogs) * 100 : null;
      lastWeekLabel = weekRangeShort(lastValid.week);
    }
    return { ...all, lastWeekPct, lastWeekLabel };
  }, [weeklyMovements, weeklyAnalysis]);

  // Análise de insumos · top 12 por custo nos períodos completos + série por período.
  // Shape genérico { periods (asc), revByPeriod, items(.byKey) } consumido pela view.
  const itemsAnalysis = useMemo(() => {
    const complete = weekly.filter((w) => w.week < currentWeekMon)
      .slice().sort((a, b) => a.week.localeCompare(b.week)); // ascendente p/ série temporal
    const periods = complete.map((w) => w.week);
    const revByPeriod = Object.fromEntries(complete.map((w) => [w.week, w.revenue]));
    const items = buildItemByPeriod(weeklyMovements, weeklySplitsResolved, weeklyOpFilter, weekMonday, new Set(periods)).slice(0, 12);
    return { periods, revByPeriod, items };
  }, [weekly, currentWeekMon, weeklyMovements, weeklySplitsResolved, weeklyOpFilter]);

  // Mesmo cálculo por mês civil completo (exclui o mês corrente em andamento), até 6 meses.
  const monthsAnalysis = useMemo(() => {
    const curMonthKey = monthKeyOf(_ymd(new Date()));
    const revByPeriod = {};
    for (const re of monthRevenue) {
      if (weeklyOpFilter !== "all" && re.op !== weeklyOpFilter) continue;
      const k = monthKeyOf(String(re.date || "").slice(0, 10));
      if (!k) continue;
      revByPeriod[k] = (revByPeriod[k] || 0) + (Number(re.revenue) || 0);
    }
    const periods = Object.keys(revByPeriod).filter((k) => k < curMonthKey).sort().slice(-6);
    const rev = Object.fromEntries(periods.map((k) => [k, revByPeriod[k] || 0]));
    const items = buildItemByPeriod(monthMovements, monthSplitsResolved, weeklyOpFilter, monthKeyOf, new Set(periods)).slice(0, 12);
    return { periods, revByPeriod: rev, items };
  }, [monthRevenue, monthMovements, monthSplitsResolved, weeklyOpFilter]);

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
          {view !== "semanal" && view !== "insumos" && <CmvPeriodTabs value={period} onChange={setPeriod} />}
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
      ) : view === "semanal" ? (
        <CmvWeeklyView
          analysis={weeklyAnalysis}
          projection={weeklyProjection}
          excluded={weeklyExcluded}
          currentWeekMon={currentWeekMon}
          loading={weeklyLoading}
          source={source}
          availableOps={weeklyAvailableOps}
          opFilter={weeklyOpFilter}
          onOpFilter={setWeeklyOpFilter}
          onOpenWeek={(mon) => setWeekDetail(mon)}
          onOpenStock={() => setPage?.("stock")}
        />
      ) : view === "insumos" ? (
        <CmvItemsAnalysisView
          data={insumoGran === "month" ? monthsAnalysis : itemsAnalysis}
          granularity={insumoGran}
          onGranularity={setInsumoGran}
          loading={insumoGran === "month" ? (monthLoading || (!monthLoaded && dbStatus.isOnline)) : weeklyLoading}
          source={source}
          availableOps={weeklyAvailableOps}
          opFilter={weeklyOpFilter}
          onOpFilter={setWeeklyOpFilter}
          onOpenInsumo={setInsumoCtx}
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
                          <div
                            onClick={() => setDayDetail({ op: row.op, date: heat.dates[i] })}
                            style={{
                              background: cmvCellBg(v),
                              border: "1px solid var(--line)",
                              padding: "10px 6px", textAlign: "center",
                              fontFamily: "var(--mono)", fontSize: 11.5,
                              color: "var(--fg-0)", fontWeight: 500,
                              borderRadius: 2, position: "relative", cursor: "pointer",
                            }}
                            title={`${v.toFixed(1)}% · clique para detalhar o dia`}
                          >
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

      {dayDetail && (
        <CmvDayDetailModal
          op={dayDetail.op}
          date={dayDetail.date}
          movements={heatMovements}
          revenueEntries={heatRevenue}
          sharedSplits={sharedSplitsResolved}
          onClose={() => setDayDetail(null)}
        />
      )}

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
                        {op ? `${op.short} · ` : ""}{(Number(itemQty) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} {c.unit}
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

      {weekDetail && (
        <CmvWeekDetailModal
          week={weekDetail}
          movements={weeklyMovements}
          revenueEntries={weeklyRevenue}
          sharedSplits={weeklySplitsResolved}
          opFilter={weeklyOpFilter}
          onClose={() => setWeekDetail(null)}
        />
      )}

      {insumoCtx && (
        <CmvInsumoDetailModal
          ctx={insumoCtx}
          op={weeklyOpFilter}
          tenantId={tenantId}
          onClose={() => setInsumoCtx(null)}
        />
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
    { id: "semanal",     label: "Semanal" },
    { id: "insumos",     label: "Análise de insumos" },
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

// Barra de filtro por operação · chips "Todas" + uma por operação (com cor).
function CmvOpFilterBar({ availableOps, opFilter, onOpFilter }) {
  return (
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
  );
}

// Seta de tendência (sobe/cai) ou traço (estável) — usada no badge Δpp do card.
function TrendArrow({ trend, size = 11 }) {
  if (trend === "flat") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true"><path d="M5 12h14" /></svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true"
         style={{ transform: `rotate(${trend === "up" ? 0 : 180}deg)` }}><path d="M12 19V5M6 11l6-6 6 6" /></svg>
  );
}

// Gráfico de barras do CMV do insumo, semana a semana. Normaliza pela PRÓPRIA escala
// (CMV de um único insumo é baixo, ~1–2%) p/ a tendência ficar legível. A última semana é
// destacada na cor da tendência; tooltip por barra com intervalo, qtd, CMV% e custo.
function ItemCmvBars({ series, unit, trend }) {
  const H = 92;
  const tColor = trendColor(trend);
  const max = Math.max(...series.map((s) => s.cmv ?? 0), 0.1);
  const [tip, setTip] = useState(null); // { x, y, i } | null
  const qfmt = (q) => (Number(q) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 });

  const place = (e) => {
    const pad = 14, w = 168, h = 96;
    let x = e.clientX + pad, y = e.clientY - h - pad;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
    if (y < 8) y = e.clientY + pad;
    return { x, y };
  };

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "stretch", gap: 9, height: H + 26 }}>
      {series.map((s, i) => {
        const cur = i === series.length - 1;
        const h = Math.max((s.cmv ?? 0) / max * 100, 4);
        const op = cur ? 1 : 0.34 + 0.16 * i;
        const onEnter = (e) => setTip({ ...place(e), i });
        const onMove  = (e) => setTip((t) => (t ? { ...place(e), i } : t));
        const leave   = () => setTip(null);
        return (
          <div key={s.key} style={{ flex: 1, minWidth: 0, display: "grid", gridTemplateRows: "1fr auto" }}>
            <div style={{ position: "relative", display: "flex", alignItems: "flex-end", justifyContent: "center", paddingTop: 18 }}>
              <div
                tabIndex={0}
                role="img"
                aria-label={`${s.rangeLabel}: CMV ${s.cmv != null ? s.cmv.toFixed(2) + "%" : "—"}, ${qfmt(s.qty)} ${unit || "un"}, ${_fmtBRLc(s.cost)}`}
                onMouseEnter={onEnter} onMouseMove={onMove} onMouseLeave={leave}
                onFocus={(e) => { const r = e.target.getBoundingClientRect(); setTip({ x: Math.min(r.left, window.innerWidth - 176), y: Math.max(8, r.top - 100), i }); }}
                onBlur={leave}
                style={{
                  position: "relative", width: "100%", height: `${h}%`, minHeight: 4,
                  borderRadius: "6px 6px 2px 2px", background: tColor, opacity: op,
                  cursor: "pointer", outline: "none",
                  boxShadow: cur ? `0 0 18px -6px ${tColor}, 0 0 0 1px color-mix(in srgb, ${tColor} 40%, transparent)` : "none",
                }}
              >
                <span style={{
                  position: "absolute", left: "50%", top: -16, transform: "translateX(-50%)",
                  fontFamily: "var(--mono)", fontSize: 10.5, whiteSpace: "nowrap",
                  color: cur ? "var(--fg-0)" : "var(--fg-3)", fontWeight: cur ? 600 : 400,
                }}>
                  {s.cmv != null ? s.cmv.toFixed(1) : "—"}
                </span>
              </div>
            </div>
            <span className="mono" style={{ textAlign: "center", fontSize: 9.5, color: cur ? tColor : "var(--fg-4)", paddingTop: 7, whiteSpace: "nowrap" }}>
              {s.tickLabel}
            </span>
          </div>
        );
      })}
      {tip && (() => {
        const s = series[tip.i];
        const row = (lbl, val, c) => (
          <div style={{ display: "flex", justifyContent: "space-between", gap: 18, marginTop: 4, fontSize: 12 }}>
            <span style={{ color: "var(--fg-3)" }}>{lbl}</span>
            <span className="mono" style={{ color: c || "var(--fg-0)", fontWeight: 600 }}>{val}</span>
          </div>
        );
        return (
          <div role="tooltip" style={{
            position: "fixed", left: tip.x, top: tip.y, zIndex: 90, pointerEvents: "none",
            minWidth: 160, padding: "10px 12px", background: "var(--bg-3)",
            border: "1px solid var(--line-strong)", borderRadius: 8,
            boxShadow: "0 20px 46px -14px rgba(0,0,0,.9)",
          }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-3)", marginBottom: 5 }}>{s.rangeLabel}</div>
            {row("CMV", s.cmv != null ? s.cmv.toFixed(2).replace(".", ",") + "%" : "—", tip.i === series.length - 1 ? tColor : "var(--fg-0)")}
            {row("Custo", _fmtBRLc(s.cost))}
            {row("Qtd usada", `${qfmt(s.qty)} ${unit || "un"}`)}
          </div>
        );
      })()}
    </div>
  );
}

// Box individual de um insumo · CMV (custo do insumo ÷ faturamento) semana a semana, com o
// valor da última semana em destaque e a variação (pp) vs a semana anterior. Clique abre o
// modal avançado. Cada box normaliza o gráfico pela própria escala.
function ItemCmvCard({ rank, card, onOpen }) {
  const { item, series, cmvNow, delta } = card;
  const trend = cmvTrend(delta);
  const tColor = trendColor(trend);
  const [hover, setHover] = useState(false);
  const deltaTxt = delta == null
    ? "—"
    : `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta).toFixed(2).replace(".", ",")}%`;

  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={`${item.name}, CMV ${cmvNow != null ? cmvNow.toFixed(2) + "%" : "indefinido"}, variação ${deltaTxt}. Abrir detalhe.`}
      style={{
        textAlign: "left", width: "100%", font: "inherit", color: "inherit", cursor: "pointer",
        appearance: "none", display: "flex", flexDirection: "column", gap: 16,
        background: "linear-gradient(180deg, var(--bg-2), var(--bg-1))",
        border: "1px solid var(--line)", borderColor: hover ? "var(--line-strong)" : "var(--line)",
        borderRadius: 12, padding: "18px 20px 16px",
        transform: hover ? "translateY(-3px)" : "none",
        boxShadow: hover ? "0 22px 48px -26px rgba(0,0,0,.85)" : "none",
        transition: "transform .18s, border-color .18s, box-shadow .18s",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-3)", minWidth: 0 }}>
          <span style={{ width: 6, height: 6, borderRadius: 50, background: catColor(item.category), flexShrink: 0 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.category || "Sem categoria"}</span>
        </div>
        <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: "var(--fg-4)", flexShrink: 0 }}>#{rank}</span>
      </div>

      <div title={item.name} style={{ fontFamily: "var(--sans)", fontSize: 16, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-0)", lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: -4 }}>
        {item.name}
      </div>

      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontFamily: "var(--sans)", fontSize: 30, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 0.9, color: cmvNow != null ? "var(--fg-0)" : "var(--fg-3)" }}>
          {cmvNow != null ? cmvNow.toFixed(1).replace(".", ",") : "—"}
          <span style={{ fontSize: 16, color: "var(--fg-3)", fontWeight: 500, marginLeft: 1 }}>%</span>
        </div>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, fontWeight: 600,
          padding: "5px 10px 5px 8px", borderRadius: 8,
          background: `color-mix(in srgb, ${tColor} 15%, transparent)`, color: tColor,
        }}>
          <TrendArrow trend={trend} /> {deltaTxt}
        </span>
      </div>

      <ItemCmvBars series={series} unit={item.unit} trend={trend} />
    </button>
  );
}

// Aba "Análise de insumos" · top 12 insumos por custo, cada um num box com o CMV individual
// (custo do insumo ÷ faturamento) por período. O switch escolhe a granularidade da comparação:
// semana (Seg→Dom) ou mês civil. Só períodos completos com faturamento entram no gráfico.
function CmvItemsAnalysisView({ data, granularity, onGranularity, loading, source, availableOps, opFilter, onOpFilter, onOpenInsumo }) {
  const { periods, revByPeriod, items } = data;
  const fmt = periodFmt(granularity);
  const [sort, setSort] = useState("cmv");   // cmv | delta | cat
  const [onlyUp, setOnlyUp] = useState(false);
  const [q, setQ] = useState("");

  // Só períodos completos com faturamento entram no gráfico (sem faturamento → CMV
  // indefinido). Eixo X igual para todos os boxes.
  const chartKeys = periods.filter((k) => (revByPeriod[k] || 0) > 0);
  const n = chartKeys.length;
  const hasPair = n >= 2;
  const k0 = chartKeys[n - 1];
  const k1 = chartKeys[n - 2];
  const rev0 = k0 ? revByPeriod[k0] : 0;
  const rev1 = k1 ? revByPeriod[k1] : 0;
  const revGrowth = rev1 > 0 ? ((rev0 - rev1) / rev1) * 100 : null;

  const cmvOf = (it, k) => {
    const rev = revByPeriod[k] || 0;
    const cost = it.byKey[k]?.cost || 0;
    return rev > 0 ? (cost / rev) * 100 : null;
  };
  // rank vem da ordem de custo (items já vem ordenado por totalCost desc) — preservado
  // mesmo quando a lista é reordenada para exibição.
  const cards = items.map((it, idx) => {
    const series = chartKeys.map((k) => ({ key: k, rangeLabel: fmt.short(k), tickLabel: fmt.tick(k), cost: it.byKey[k]?.cost || 0, qty: it.byKey[k]?.qty || 0, cmv: cmvOf(it, k) }));
    const cmvNow  = n ? series[n - 1].cmv : null;
    const cmvPrev = n > 1 ? series[n - 2].cmv : null;
    const delta = (cmvNow != null && cmvPrev != null) ? cmvNow - cmvPrev : null;
    return { item: it, series, cmvNow, delta, rank: idx + 1, isUp: cmvTrend(delta) === "up" };
  });
  const alertCount = cards.filter((c) => c.isUp).length;

  // Filtro (busca + só em alta) e ordenação para exibição.
  let list = cards;
  if (onlyUp) list = list.filter((c) => c.isUp);
  if (q) {
    const needle = q.toLowerCase();
    list = list.filter((c) => c.item.name.toLowerCase().includes(needle) || (c.item.category || "").toLowerCase().includes(needle));
  }
  list = [...list].sort((a, b) => {
    if (sort === "delta") return (b.delta ?? -Infinity) - (a.delta ?? -Infinity);
    if (sort === "cat") return (a.item.category || "").localeCompare(b.item.category || "") || (b.cmvNow ?? 0) - (a.cmvNow ?? 0);
    return (b.cmvNow ?? 0) - (a.cmvNow ?? 0);
  });

  const controls = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
      <CmvOpFilterBar availableOps={availableOps} opFilter={opFilter} onOpFilter={onOpFilter} />
      <InsumoGranSwitch value={granularity} onChange={onGranularity} />
    </div>
  );

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {controls}
        <div style={{ padding: 40, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>Carregando análise de insumos…</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {controls}

      {!hasPair ? (
        <div className="card" style={{ padding: "56px 24px", textAlign: "center" }}>
          <div style={{ fontFamily: "var(--sans)", fontSize: 15, fontWeight: 600, color: "var(--fg-0)", marginBottom: 6 }}>
            {granularity === "month" ? "Faltam meses completos para comparar" : "Faltam semanas completas para comparar"}
          </div>
          <div style={{ fontSize: 13, color: "var(--fg-3)" }}>
            {granularity === "month"
              ? "A análise precisa de pelo menos 2 meses civis completos com faturamento sincronizado."
              : "A análise precisa de pelo menos 2 ciclos Seg → Dom com faturamento sincronizado."}
            {source !== "db" && <> · {source === "loading" ? "Carregando dados…" : "DB offline"}</>}
          </div>
        </div>
      ) : (
        <>
          {/* KPIs · comparativo do último período completo vs anterior (empilham no mobile) */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
            <InsumoWowKpi growth={revGrowth} prevLabel={fmt.short(k1)} curLabel={fmt.short(k0)} noun={fmt.noun} />
            <InsumoFatKpi value={rev0} keys={chartKeys} revByPeriod={revByPeriod} curLabel={fmt.short(k0)} noun={fmt.noun} />
            <InsumoAltaKpi count={alertCount} active={onlyUp} onToggle={() => setOnlyUp((v) => !v)} />
          </div>

          {/* Cabeçalho + toolbar */}
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
            <div>
              <h3 style={{ fontFamily: "var(--sans)", fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-0)", margin: 0 }}>
                Top <span style={{ color: "var(--accent-bright)" }}>{cards.length}</span> insumos · CMV individual {fmt.adj}
              </h3>
              <p style={{ fontSize: 12.5, color: "var(--fg-3)", marginTop: 7 }}>
                Custo do insumo ÷ faturamento {fmt.noun === "mês" ? "do mês" : "da semana"} · clique no card para detalhar
              </p>
            </div>
            <InsumoToolbar q={q} onQ={setQ} sort={sort} onSort={setSort} onlyUp={onlyUp} onToggleUp={() => setOnlyUp((v) => !v)} />
          </div>

          {list.length === 0 ? (
            <div className="card" style={{ padding: "48px 24px", textAlign: "center" }}>
              <div style={{ fontFamily: "var(--sans)", fontSize: 15, fontWeight: 600, color: "var(--fg-0)", marginBottom: 6 }}>Nenhum insumo no filtro</div>
              <div style={{ fontSize: 13, color: "var(--fg-3)" }}>Ajuste a busca ou desative “só em alta”.</div>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
              {list.map((c) => (
                <ItemCmvCard
                  key={c.item.id}
                  rank={c.rank}
                  card={c}
                  onOpen={() => onOpenInsumo({
                    itemId: c.item.id, name: c.item.name, unit: c.item.unit, category: c.item.category, rank: c.rank,
                    granularity,
                    period:     { key: k0, from: fmt.from(k0), to: fmt.to(k0), label: fmt.full(k0) },
                    prevPeriod: { key: k1, from: fmt.from(k1), to: fmt.to(k1), label: fmt.full(k1) },
                  })}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Switch da granularidade da comparação · Semana (atual) ou Mês.
function InsumoGranSwitch({ value, onChange }) {
  const opts = [{ id: "week", label: "Semana" }, { id: "month", label: "Mês" }];
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Comparar por</span>
      <div role="group" aria-label="Granularidade da comparação" style={{ display: "flex", padding: 3, background: "var(--bg-2)", borderRadius: 8, border: "1px solid var(--line)", gap: 3 }}>
        {opts.map((o) => {
          const on = o.id === value;
          return (
            <button key={o.id} type="button" onClick={() => onChange(o.id)} aria-pressed={on} style={{
              appearance: "none", cursor: "pointer", background: on ? "var(--bg-3)" : "transparent", border: 0, borderRadius: 6,
              fontFamily: "var(--sans)", fontSize: 12, fontWeight: on ? 500 : 400, color: on ? "var(--fg-0)" : "var(--fg-3)", padding: "6px 14px",
            }}>{o.label}</button>
          );
        })}
      </div>
    </div>
  );
}

// KPI · variação do faturamento período-a-período (verde ≥0 / vermelho <0) com seta e intervalos.
function InsumoWowKpi({ growth, prevLabel, curLabel, noun }) {
  const neg = growth != null && growth < 0;
  const color = growth == null ? "var(--fg-2)" : neg ? "var(--crit)" : "var(--ok)";
  const bg = neg ? "var(--crit-soft)" : "var(--accent-soft)";
  return (
    <div className="kpi" style={{ padding: "18px 20px" }}>
      <div className="label">{noun === "mês" ? "Faturamento · mês a mês" : "Faturamento · semana s/ semana"}</div>
      <div className="value" style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 32, color }}>
        <span style={{ width: 28, height: 28, borderRadius: 8, display: "inline-flex", alignItems: "center", justifyContent: "center", background: bg, color }}>
          <TrendArrow trend={growth == null ? "flat" : neg ? "up" : "down"} size={15} />
        </span>
        {growth == null ? "—" : `${neg ? "−" : "+"}${Math.abs(growth).toFixed(1).replace(".", ",")}%`}
      </div>
      <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", letterSpacing: "0.04em", marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
        <span>{prevLabel}</span><span style={{ color: "var(--fg-4)" }}>→</span><span>{curLabel}</span>
      </div>
    </div>
  );
}

// KPI · faturamento do último período + mini-spark dos períodos completos.
function InsumoFatKpi({ value, keys, revByPeriod, curLabel, noun }) {
  const vals = keys.map((k) => revByPeriod[k] || 0);
  const mx = Math.max(...vals, 1);
  return (
    <div className="kpi" style={{ padding: "18px 20px" }}>
      <div className="label">{noun === "mês" ? "Faturamento do mês" : "Faturamento da semana"}</div>
      <div className="value" style={{ fontSize: 30 }}>{_fmtBRLci(value)}</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 30, marginTop: 10 }} aria-hidden="true">
        {vals.map((v, i) => (
          <span key={i} style={{
            flex: 1, minHeight: 4, borderRadius: "3px 3px 1px 1px",
            height: `${30 + (v / mx) * 70}%`,
            background: i === vals.length - 1 ? "var(--accent-bright)" : "var(--bg-3)",
          }} />
        ))}
      </div>
      <div className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", marginTop: 6 }}>{curLabel}</div>
    </div>
  );
}

// KPI · insumos com CMV em alta · clicável (toggle "só em alta", sincronizado com a toolbar).
function InsumoAltaKpi({ count, active, onToggle }) {
  return (
    <div
      role="button" tabIndex={0} aria-pressed={active}
      aria-label="Filtrar apenas insumos com CMV em alta"
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
      className="kpi"
      style={{
        padding: "18px 20px", cursor: "pointer",
        borderColor: active ? "var(--crit-line)" : "var(--line)",
        boxShadow: active ? "0 0 0 1px var(--crit-line)" : "none",
        transition: "border-color .16s, box-shadow .16s",
      }}
    >
      <div className="label">Insumos com CMV em alta</div>
      <div className="value" style={{ fontSize: 32, color: "var(--crit)", display: "inline-flex", alignItems: "baseline", gap: 12 }}>
        {count}
        <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, fontWeight: 600, color: "var(--crit)", opacity: 0.85, letterSpacing: "0.02em" }}>
          {active ? "ativo ✓" : "clique p/ filtrar"}
        </span>
      </div>
      <div className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", marginTop: 6 }}>custo subindo mais que o faturamento</div>
    </div>
  );
}

// Toolbar do grid · busca, ordenação segmentada e toggle "só em alta".
function InsumoToolbar({ q, onQ, sort, onSort, onlyUp, onToggleUp }) {
  const sorts = [{ id: "cmv", label: "Maior CMV" }, { id: "delta", label: "Maiores altas" }, { id: "cat", label: "Categoria" }];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 8, padding: "0 12px", height: 38 }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ color: "var(--fg-3)" }} aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></svg>
        <input
          type="search" value={q} onChange={(e) => onQ(e.target.value.trim())}
          placeholder="buscar insumo" aria-label="Buscar insumo"
          style={{ background: "none", border: 0, outline: "none", color: "var(--fg-0)", fontFamily: "var(--sans)", fontSize: 13, width: 120 }}
        />
      </label>
      <div role="group" aria-label="Ordenar por" style={{ display: "flex", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 8, padding: 3, gap: 3 }}>
        {sorts.map((s) => {
          const on = sort === s.id;
          return (
            <button key={s.id} type="button" onClick={() => onSort(s.id)} aria-pressed={on} style={{
              appearance: "none", cursor: "pointer", background: on ? "var(--bg-3)" : "transparent", border: 0, borderRadius: 6,
              fontFamily: "var(--sans)", fontSize: 12, fontWeight: on ? 500 : 400, color: on ? "var(--fg-0)" : "var(--fg-3)", padding: "6px 12px",
            }}>{s.label}</button>
          );
        })}
      </div>
      <button
        type="button" onClick={onToggleUp} aria-pressed={onlyUp}
        style={{
          display: "inline-flex", alignItems: "center", gap: 9, height: 38, padding: "0 14px", borderRadius: 8, cursor: "pointer",
          fontFamily: "var(--sans)", fontSize: 12, fontWeight: 500,
          background: onlyUp ? "var(--crit-soft)" : "var(--bg-2)",
          border: `1px solid ${onlyUp ? "var(--crit-line)" : "var(--line)"}`,
          color: onlyUp ? "var(--crit)" : "var(--fg-2)",
        }}
      >
        <span style={{ position: "relative", width: 30, height: 17, borderRadius: 99, background: onlyUp ? "var(--crit)" : "var(--bg-3)", transition: ".16s" }}>
          <span style={{ position: "absolute", top: 2, left: onlyUp ? 15 : 2, width: 13, height: 13, borderRadius: "50%", background: onlyUp ? "#2a0f0f" : "var(--fg-3)", transition: ".16s" }} />
        </span>
        só em alta
      </button>
    </div>
  );
}

// ===== Modal avançado de detalhe do insumo =====
function InsumoBadge({ children, tone }) {
  const map = {
    accent: { c: "var(--accent-bright)", b: "var(--accent-soft)" },
    danger: { c: "var(--crit)",          b: "var(--crit-soft)" },
    muted:  { c: "var(--fg-2)",          b: "var(--bg-2)" },
  };
  const t = map[tone] || map.muted;
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: t.b, color: t.c, whiteSpace: "nowrap" }}>{children}</span>;
}

function InsumoKpi({ label, value, sub, subColor }) {
  return (
    <div style={{ background: "var(--bg-2)", borderRadius: 6, padding: 12 }}>
      <div style={{ fontSize: 12, color: "var(--fg-2)" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 500, color: "var(--fg-0)", marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: subColor || "var(--fg-3)", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function InsumoSection({ title, sub, first, children }) {
  return (
    <div style={{ padding: first ? "0 0 16px" : "16px 0", borderTop: first ? "none" : "1px solid var(--line-soft)" }}>
      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)" }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 2, marginBottom: 12 }}>{sub}</div>}
      {children}
    </div>
  );
}

const _qfmt = (q) => (Number(q) || 0).toLocaleString("pt-BR", { maximumFractionDigits: Math.abs(Number(q) || 0) < 10 ? 2 : 0 });
const _ppSigned = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;

function CmvInsumoDetailModal({ ctx, op, tenantId, onClose }) {
  const ModalShell = window.ModalShell;
  const fmt = periodFmt(ctx.granularity);
  const [state, setState] = useState({ loading: true, error: false, data: null });
  const dialogRef = useRef(null);

  const load = useCallback(() => {
    let cancelled = false;
    setState({ loading: true, error: false, data: null });
    (async () => {
      try {
        if (!tenantId) throw new Error("sem tenant");
        const data = await getInsumoDetail({ tenantId, itemId: ctx.itemId, op, period: ctx.period, prevPeriod: ctx.prevPeriod, rank: ctx.rank, noun: fmt.noun });
        if (!cancelled) setState({ loading: false, error: false, data });
      } catch {
        if (!cancelled) setState({ loading: false, error: true, data: null });
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, ctx.itemId, ctx.period?.key, ctx.prevPeriod?.key, ctx.rank, op, fmt.noun]);

  useEffect(() => load(), [load]);

  // Acessibilidade: Esc fecha, foco preso no conteúdo enquanto aberto.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "Tab" && dialogRef.current) {
        const f = dialogRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    const opener = document.activeElement; // box que abriu o modal — foco retorna a ele
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  }, [onClose]);

  const h = state.data?.header;
  const name     = h?.name ?? ctx.name;
  const category = h?.category ?? ctx.category;
  const periodLabel = h?.weekLabel ?? ctx.period.label;
  const opName    = h?.opName ?? (op === "all" ? "Todas as operações" : (MOCK.opById(op)?.name || op));
  const metaBits = [h?.sku ? `SKU ${h.sku}` : null, h?.supplier ? `Fornec.: ${h.supplier}` : null, `${fmt.nounCap} ${periodLabel}`, opName].filter(Boolean);

  const header = (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
        <span style={{ fontSize: 17, fontWeight: 500, color: "var(--fg-0)" }}>{name}</span>
        {category && <InsumoBadge tone="accent">{category}</InsumoBadge>}
        <InsumoBadge tone="danger">#{ctx.rank} maior custo</InsumoBadge>
      </div>
      <div style={{ fontSize: 12, color: "var(--fg-3)", fontWeight: 400 }}>{metaBits.join(" · ")}</div>
    </div>
  );

  return (
    <ModalShell title={header} onClose={onClose} width={640}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Detalhe do insumo ${name || ""}`} style={{ outline: "none" }}>
        {state.loading ? (
          <InsumoModalSkeleton />
        ) : state.error ? (
          <div style={{ padding: "40px 0", textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 14 }}>Não foi possível carregar o detalhe do insumo.</div>
            <button className="btn" data-size="sm" onClick={load}>Tentar de novo</button>
          </div>
        ) : (
          <InsumoModalBody data={state.data} op={op} noun={fmt.noun} />
        )}
      </div>
    </ModalShell>
  );
}

function InsumoModalSkeleton() {
  const skel = (w, h, r = 6) => <div className="skel" style={{ width: w, height: h, borderRadius: r }} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, animation: "fadeUp 200ms ease both" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} style={{ background: "var(--bg-2)", borderRadius: 6, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {skel(60, 9)}{skel(70, 20)}{skel(50, 9)}
          </div>
        ))}
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {skel(180, 12)}{skel("100%", 16, 4)}{skel("100%", 16, 4)}
        </div>
      ))}
    </div>
  );
}

function InsumoModalBody({ data, op, noun = "semana" }) {
  const { kpis, decomposition, byOperation, usage, recommendations } = data;
  const cmvDown = kpis.cmvDeltaPp != null && kpis.cmvDeltaPp <= 0;
  const priceDown = kpis.unitPriceDeltaPct != null && kpis.unitPriceDeltaPct <= 0;
  const prevTxt = noun === "mês" ? "mês anterior" : "semana anterior";

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* 2 · Indicadores */}
      <InsumoSection first title={null}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
          <InsumoKpi
            label={`CMV ${noun === "mês" ? "do mês" : "da semana"}`}
            value={kpis.cmv != null ? `${kpis.cmv.toFixed(2)}%` : "—"}
            sub={kpis.cmvDeltaPp != null ? `${cmvDown ? "↓" : "↑"} ${Math.abs(kpis.cmvDeltaPp).toFixed(2)}%` : `sem ${prevTxt}`}
            subColor={kpis.cmvDeltaPp != null ? (cmvDown ? "var(--ok)" : "var(--crit)") : "var(--fg-3)"}
          />
          <InsumoKpi
            label={`Custo ${noun === "mês" ? "no mês" : "na semana"}`}
            value={_fmtBRLci(kpis.cost)}
            sub={`~${_qfmt(kpis.qty)} ${kpis.unit || ""} consumidos`}
          />
          <InsumoKpi
            label="Preço unitário"
            value={_fmtBRLc(kpis.unitPrice)}
            sub={kpis.unitPriceDeltaPct != null ? `${priceDown ? "↓" : "↑"} ${Math.abs(kpis.unitPriceDeltaPct).toFixed(1)}% /${kpis.unit || "un"}` : `por ${kpis.unit || "un"}`}
            subColor={kpis.unitPriceDeltaPct != null ? (priceDown ? "var(--ok)" : "var(--crit)") : "var(--fg-3)"}
          />
          <InsumoKpi
            label="% do CMV total"
            value={kpis.sharePct != null ? `${kpis.sharePct.toFixed(1)}%` : "—"}
            sub="do gasto em insumos"
          />
        </div>
      </InsumoSection>

      {/* 3 · Decomposição */}
      <InsumoSection
        title={decomposition.available
          ? `Por que o CMV ${decomposition.total <= 0 ? "caiu" : "subiu"} ${Math.abs(decomposition.total).toFixed(2)}%?`
          : "Decomposição da variação"}
        sub={`Variação vs. ${prevTxt} — o lever exato por trás do número`}
      >
        {!decomposition.available ? (
          <div style={{ fontSize: 12.5, color: "var(--fg-3)" }}>Sem {prevTxt} comparável para decompor.</div>
        ) : (
          <DecompRows decomposition={decomposition} />
        )}
      </InsumoSection>

      {/* 4 · Mesmo insumo em outras operações */}
      <InsumoSection
        title="Mesmo insumo em outras operações"
        sub="Onde dá pra alinhar custo dentro da rede"
      >
        {byOperation.length <= 1 ? (
          <div style={{ fontSize: 12.5, color: "var(--fg-3)" }}>Consumido só nesta operação {noun === "mês" ? "no mês" : "na semana"}.</div>
        ) : (
          <ByOpRows rows={byOperation} />
        )}
      </InsumoSection>

      {/* 5 · Onde é usado */}
      <InsumoSection
        title="Onde esse insumo é usado"
        sub={op === "all" ? "Pratos que consomem o insumo e o peso dele no custo de cada um" : "Pratos da operação que consomem o insumo"}
      >
        {!usage.available ? (
          <div style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
            Nenhuma ficha técnica cadastrada com este insumo{op === "all" ? "" : " nesta operação"}.
          </div>
        ) : (
          <UsageTable rows={usage.rows} showOp={op === "all"} />
        )}
      </InsumoSection>

      {/* 6 · Recomendações */}
      <InsumoSection title="Recomendações">
        {recommendations.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--fg-3)" }}>Sem recomendações automáticas {noun === "mês" ? "neste mês" : "nesta semana"}.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {recommendations.map((r, i) => <RecCard key={i} rec={r} />)}
          </div>
        )}
      </InsumoSection>
    </div>
  );
}

// Mini-waterfall horizontal a partir do zero (centro): efeito positivo → vermelho à direita,
// negativo → verde à esquerda. Os três efeitos somam o Δpp total (linha de total embaixo).
function DecompRows({ decomposition }) {
  const rows = [
    { label: "Preço", v: decomposition.price },
    { label: "Volume", v: decomposition.volume },
    { label: "Faturamento", v: decomposition.revenue },
  ];
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.v)), Math.abs(decomposition.total), 0.05);
  const Row = ({ label, v, total }) => {
    const pos = v >= 0;
    const w = Math.min(Math.abs(v) / maxAbs * 48, 48); // metade da barra = escala completa
    const color = pos ? "var(--crit)" : "var(--ok)";
    return (
      <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 76px", alignItems: "center", gap: 14, ...(total ? { paddingTop: 10, marginTop: 4, borderTop: "1px solid var(--line-soft)" } : null) }}>
        <span style={{ fontSize: 12.5, color: total ? "var(--fg-0)" : "var(--fg-2)", fontWeight: total ? 600 : 500 }}>{label}</span>
        <div style={{ position: "relative", height: 26, borderRadius: 8, background: "var(--bg-2)", border: "1px solid var(--line)", overflow: "hidden" }}>
          <span style={{ position: "absolute", top: 0, bottom: 0, left: "50%", width: 1, background: "var(--line-strong)" }} />
          <span style={{ position: "absolute", top: 4, bottom: 4, [pos ? "left" : "right"]: "50%", width: `${w}%`, borderRadius: 5, background: color }} />
        </div>
        <span style={{ fontSize: total ? 14 : 13, fontWeight: 600, textAlign: "right", fontVariantNumeric: "tabular-nums", color: v > 0 ? "var(--crit)" : v < 0 ? "var(--ok)" : "var(--fg-2)" }}>{_ppSigned(v)}</span>
      </div>
    );
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {rows.map((r, i) => <Row key={i} label={r.label} v={r.v} />)}
      <Row label="Variação total" v={decomposition.total} total />
    </div>
  );
}

// Mesmo insumo em cada operação · CMV% e R$ por operação, com a operação atual ("aqui")
// destacada na linha.
function ByOpRows({ rows }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {rows.map((r) => (
        <div key={r.slug} style={{
          display: "grid", gridTemplateColumns: "1fr auto auto", alignItems: "center", gap: 16,
          padding: "11px 13px", borderRadius: 10,
          ...(r.isCurrent ? { background: "var(--accent-soft)", border: "1px solid var(--accent-line)" } : null),
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <span style={{ width: 8, height: 8, borderRadius: 50, background: r.color, flexShrink: 0 }} />
            <span style={{ fontSize: 13.5, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
            {r.isCurrent && <InsumoBadge tone="accent">aqui</InsumoBadge>}
          </div>
          <div className="mono" style={{ width: 66, textAlign: "right", fontSize: 15, fontWeight: 600, color: "var(--fg-0)" }}>{r.cmv != null ? `${r.cmv.toFixed(2)}%` : "—"}</div>
          <div className="mono" style={{ width: 90, textAlign: "right", fontSize: 12, color: "var(--fg-3)" }}>{_fmtBRLci(r.cost)}</div>
        </div>
      ))}
    </div>
  );
}

// Pratos (fichas técnicas) que consomem o insumo · porção + barra de participação no custo.
function UsageTable({ rows, showOp }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 14px", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 10 }}>
          <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--sans)", fontSize: 13.5, fontWeight: 500, color: "var(--fg-0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.dish}>
            {r.dish}{showOp && r.opName ? <span style={{ color: "var(--fg-3)", fontWeight: 400 }}> · {r.opName}</span> : null}
          </span>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)", flexShrink: 0 }}>{_qfmt(r.portionQty)} {r.portionUnit}</span>
          <span style={{ flex: "0 0 96px", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ flex: 1, height: 6, borderRadius: 4, background: "var(--bg-3)", overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", borderRadius: 4, width: `${Math.min(100, r.pctOfDishCost)}%`, background: r.pctOfDishCost > 30 ? "var(--crit)" : "var(--accent-bright)" }} />
            </span>
            <b className="mono" style={{ fontSize: 12, color: "var(--fg-2)", width: 36, textAlign: "right", fontWeight: 600 }}>{r.pctOfDishCost.toFixed(0)}%</b>
          </span>
        </div>
      ))}
    </div>
  );
}

function RecCard({ rec }) {
  const map = {
    accent:  { fg: "var(--accent-bright)", bg: "var(--accent-soft)", Icon: I.Star },
    success: { fg: "var(--ok)",            bg: "var(--accent-soft)", Icon: I.ArrowDown },
    danger:  { fg: "var(--crit)",          bg: "var(--crit-soft)",   Icon: I.AlertTriangle },
  };
  const t = map[rec.tone] || map.accent;
  const Icon = t.Icon;
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", background: t.bg, borderRadius: 6, padding: "10px 12px" }}>
      <span style={{ color: t.fg, marginTop: 1, flexShrink: 0 }} aria-hidden="true">{Icon ? <Icon size={16} /> : null}</span>
      <div style={{ fontSize: 13, color: t.fg, lineHeight: 1.4 }}>{rec.text}</div>
    </div>
  );
}

// Aba "Semanal" · CMV por ciclo Seg→Dom. Boxes por semana com comparação entre si,
// média corrigida (só semanas válidas), tendência e projeção da semana atual.
const _WEEK_BAND = { good: "var(--ok)", warn: "var(--warn)", bad: "var(--crit)", mut: "var(--fg-3)" };
const bandColor = (b) => _WEEK_BAND[b] || "var(--fg-3)";
const _fmtBRLk = (v) => {
  const n = Number(v) || 0;
  return Math.abs(n) >= 1000
    ? "R$ " + (n / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "k"
    : _fmtBRLci(n);
};
const _ppText = (v) => `${v <= 0 ? "▼" : "▲"} ${Math.abs(v).toFixed(1)}%`;
const _ppColor = (v) => (v <= 0 ? "var(--ok)" : "var(--warn)");

function CmvWeeklyView({ analysis, projection, excluded, currentWeekMon, loading, source, availableOps, opFilter, onOpFilter, onOpenWeek, onOpenStock }) {
  if (loading) {
    return <div style={{ padding: 40, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>Carregando análise semanal…</div>;
  }

  const { avgCmv, avgRevenue, avgCost, avgMargin, validCount, scale, target, targetPosition, weeks, trend } = analysis;
  const avgBand = avgCmv != null ? cmvBand(avgCmv, { target }) : "mut";

  // Valor antigo (bug): Σcogs/Σrevenue sobre TODAS as semanas, incluindo sem faturamento.
  const allCogs = weeks.reduce((s, w) => s + (Number(w.cogs) || 0), 0);
  const allRev  = weeks.reduce((s, w) => s + (Number(w.revenue) || 0), 0);
  const oldAvg  = allRev > 0 ? (allCogs / allRev) * 100 : null;
  const inflated = oldAvg != null && avgCmv != null && oldAvg > avgCmv + 1;
  const latestValid = weeks.find((w) => w.valid)?.week || null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <CmvOpFilterBar availableOps={availableOps} opFilter={opFilter} onOpFilter={onOpFilter} />

      {/* Itens fora do CMV — destacado e clicável */}
      {excluded.count > 0 && (
        <div
          role="button" tabIndex={0} onClick={onOpenStock}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenStock?.(); } }}
          style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 15px", cursor: "pointer", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 11 }}
          title="Configurar em Estoque · botão CMV de cada insumo"
        >
          <I.AlertTriangle size={15} style={{ color: "var(--warn)", flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: "var(--warn)" }}>
            <strong style={{ fontWeight: 500 }}>{excluded.count} {excluded.count === 1 ? "item" : "itens"}</strong> fora do cálculo de CMV ·{" "}
            <strong style={{ fontWeight: 500 }}>{_fmtBRLci(excluded.total)}</strong> não computados na janela
            {excluded.lastWeekPct != null && <> · ≈{excluded.lastWeekPct.toFixed(0)}% do custo de {excluded.lastWeekLabel}</>}
          </span>
          <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--warn)", whiteSpace: "nowrap" }}>Ver itens →</span>
        </div>
      )}

      {/* Médias do período (corrigidas) */}
      <div className="card" style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
          <h3 className="card-title">Médias do período</h3>
          <span className="card-sub">{validCount} {validCount === 1 ? "semana válida" : "semanas válidas"} (com faturamento)</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>CMV médio</div>
            <div style={{ fontSize: 28, fontWeight: 500, color: bandColor(avgBand), marginTop: 6, display: "flex", alignItems: "baseline", gap: 8 }}>
              {avgCmv != null ? `${avgCmv.toFixed(1)}%` : "—"}
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "2px 7px", borderRadius: 6, background: "var(--bg-2)", color: "var(--fg-2)" }}>meta {target}%</span>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 4 }} title="Σ custo ÷ Σ faturamento das semanas válidas">
              {inflated
                ? <>Cálculo anterior: <span style={{ color: "var(--crit)" }}>{oldAvg.toFixed(1)}%</span> — somava semanas sem faturamento.</>
                : "Σ custo ÷ Σ faturamento das semanas válidas"}
            </div>
          </div>
          {[
            { lbl: "Faturamento / semana", val: avgRevenue != null ? _fmtBRLci(avgRevenue) : "—", note: "média das semanas válidas" },
            { lbl: "Custo / semana", val: avgCost != null ? _fmtBRLci(avgCost) : "—", note: "por saídas de estoque" },
            { lbl: "Margem média", val: avgMargin != null ? `${avgMargin.toFixed(1)}%` : "—", note: "sobre faturamento", color: "var(--ok)" },
          ].map((k, i) => (
            <div key={i} style={{ borderLeft: "1px solid var(--line-soft)", paddingLeft: 16 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{k.lbl}</div>
              <div style={{ fontSize: 28, fontWeight: 500, color: k.color || "var(--fg-0)", marginTop: 6 }}>{k.val}</div>
              <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 4 }}>{k.note}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tendência do CMV */}
      <div className="card" style={{ padding: "16px 20px 10px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
          <h3 className="card-title">Tendência do CMV</h3>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-3)" }}>
            linha tracejada = meta {target}% · abaixo = dentro da meta
          </span>
        </div>
        <CmvTrendChart trend={trend} scale={scale} target={target} />
      </div>

      {/* Semanas como boxes */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
        <h3 className="card-title">Semanas</h3>
        <span className="card-sub">Seg → Dom · clique numa semana p/ ver os insumos</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 11.5, color: "var(--fg-3)" }}>
        <span>posição do CMV entre {scale.min}% e {scale.max}%</span>
        <span>·</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 1.5, height: 11, background: "var(--fg-2)", display: "inline-block" }} /> meta {target}%</span>
        <span>·</span>
        <span>mais à esquerda = melhor</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 13 }}>
        <CmvCurrentWeekBox weekMon={currentWeekMon} projection={projection} onOpen={() => onOpenWeek(currentWeekMon)} />
        {weeks.length === 0 ? (
          <div className="card" style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--fg-3)", gridColumn: "1 / -1" }}>
            {source === "db" ? "Sem semanas completas na janela carregada" : (source === "loading" ? "Carregando…" : "DB offline")}
          </div>
        ) : weeks.map((w) => (
          w.valid
            ? <CmvWeekBox key={w.week} w={w} targetPosition={targetPosition} isLatest={w.week === latestValid} onOpen={() => onOpenWeek(w.week)} />
            : <CmvIncompleteBox key={w.week} w={w} onOpen={() => onOpenWeek(w.week)} />
        ))}
      </div>
    </div>
  );
}

// Box de uma semana válida.
function CmvWeekBox({ w, targetPosition, isLatest, onOpen }) {
  const color = bandColor(w.band);
  const pos = (w.position ?? 0) * 100;
  const flag = w.isBest
    ? { t: "★ melhor", c: "var(--ok)", b: "var(--accent-soft)" }
    : w.isWorst
      ? { t: "pior", c: "var(--crit)", b: "var(--crit-soft)" }
      : { t: isLatest ? "mais recente" : "válida", c: "var(--fg-2)", b: "var(--bg-2)" };
  return (
    <div
      className="card" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      style={{ padding: "15px 16px 14px", cursor: "pointer" }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 13 }}>
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-0)" }}>{weekRangeShort(w.week)}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>{new Date(w.week + "T12:00:00").getFullYear()}</div>
        </div>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 999, color: flag.c, background: flag.b }}>{flag.t}</span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginBottom: 14 }}>
        <span style={{ fontSize: 32, fontWeight: 500, lineHeight: 0.95, color }}>{w.cmv.toFixed(1)}%</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-3)" }}>CMV<br />da semana</span>
      </div>
      <div style={{ position: "relative", height: 6, borderRadius: 999, background: "rgba(255,255,255,0.06)", margin: "0 0 12px" }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 999, width: `${pos}%`, background: color, opacity: 0.45 }} />
        <div style={{ position: "absolute", top: -4, bottom: -4, width: 1.5, left: `${targetPosition * 100}%`, background: "var(--fg-2)", opacity: 0.7 }} />
        <div style={{ position: "absolute", top: "50%", width: 11, height: 11, borderRadius: "50%", transform: "translate(-50%,-50%)", left: `${pos}%`, background: color, border: "2px solid var(--bg-1)" }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 13 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--fg-3)" }}>vs anterior</span>
          {w.vsPrev != null
            ? <span style={{ fontWeight: 500, color: _ppColor(w.vsPrev) }}>{_ppText(w.vsPrev)}</span>
            : <span style={{ color: "var(--fg-3)" }}>— primeira</span>}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--fg-3)" }}>vs média</span>
          {w.vsAvg != null
            ? <span style={{ fontWeight: 500, color: _ppColor(w.vsAvg) }}>{_ppText(w.vsAvg)}</span>
            : <span style={{ color: "var(--fg-3)" }}>—</span>}
        </div>
      </div>
      <CmvMiniStats revenue={w.revenue} cogs={w.cogs} margin={w.margin} />
    </div>
  );
}

function CmvMiniStats({ revenue, cogs, margin, dim }) {
  const cell = (k, v, isDim) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--fg-3)" }}>{k}</span>
      <span style={{ fontSize: 13, fontWeight: isDim ? 400 : 500, color: isDim ? "var(--fg-3)" : "var(--fg-0)" }}>{v}</span>
    </div>
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 2, borderTop: "1px solid var(--line-soft)", paddingTop: 11 }}>
      {cell("Fat.", dim ? "não sincr." : _fmtBRLk(revenue), dim)}
      {cell("Custo", _fmtBRLk(cogs))}
      {cell("Margem", margin != null ? `${margin.toFixed(1)}%` : "—", margin == null)}
    </div>
  );
}

// Box da semana atual · projeção ao vivo (sem CMV/margem enquanto não há faturamento).
function CmvCurrentWeekBox({ weekMon, projection, onOpen }) {
  const hasRev = projection.cmv != null;
  return (
    <div
      className="card" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      style={{ padding: "15px 16px 14px", cursor: "pointer", borderColor: "var(--accent-line)", background: "linear-gradient(180deg, var(--accent-soft), transparent 60%)" }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 13 }}>
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-0)" }}>{weekRangeShort(weekMon)}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>{new Date(weekMon + "T12:00:00").getFullYear()}</div>
        </div>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 999, color: "var(--accent-bright)", background: "var(--accent-soft)", display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: 50, background: "var(--accent-bright)" }} />em andamento
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginBottom: 3 }}>
        <span style={{ fontSize: 32, fontWeight: 500, lineHeight: 0.95, color: hasRev ? bandColor(cmvBand(projection.cmv, { target: CMV_TARGET })) : "var(--fg-3)" }}>
          {hasRev ? `${projection.cmv.toFixed(1)}%` : "—"}
        </span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-3)" }}>{hasRev ? <>CMV<br />parcial</> : <>CMV<br />aguardando<br />faturamento</>}</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 12 }}>
        {hasRev ? "Parcial — fecha ao final da semana." : "Semana em curso — CMV e margem entram ao registrar o faturamento."}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5, background: "rgba(255,255,255,0.03)", border: "1px solid var(--line-soft)", borderRadius: 9, padding: "8px 11px", marginBottom: 8 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--fg-3)" }}>Custo acumulado</span>
        <span style={{ color: "var(--fg-0)", fontWeight: 500 }}>{_fmtBRLci(projection.cost)} <small style={{ color: "var(--fg-3)", fontWeight: 400, fontSize: 10, marginLeft: 5 }}>dia {projection.daysElapsed} de 7</small></span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5, background: "rgba(255,255,255,0.03)", border: "1px solid var(--line-soft)", borderRadius: 9, padding: "8px 11px" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--fg-3)" }}>Projeção de custo</span>
        <span style={{ color: "var(--fg-0)", fontWeight: 500 }}>~{_fmtBRLk(projection.projectedCost)} <small style={{ color: "var(--fg-3)", fontWeight: 400, fontSize: 10, marginLeft: 5 }}>estimativa</small></span>
      </div>
    </div>
  );
}

// Box de semana incompleta (custo sem faturamento sincronizado).
function CmvIncompleteBox({ w, onOpen }) {
  return (
    <div
      className="card" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      style={{ padding: "15px 16px 14px", cursor: "pointer", borderStyle: "dashed", opacity: 0.66 }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 13 }}>
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-0)" }}>{weekRangeShort(w.week)}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>{new Date(w.week + "T12:00:00").getFullYear()}</div>
        </div>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 999, color: "var(--crit)", background: "var(--crit-soft)", display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: 50, background: "var(--crit)" }} />dados incompletos
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginBottom: 3 }}>
        <span style={{ fontSize: 32, fontWeight: 500, lineHeight: 0.95, color: "var(--fg-3)" }}>—</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-3)" }}>sem<br />faturamento</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 12 }}>Faturamento não sincronizado. Custo existe, mas não há receita para dividir.</div>
      <CmvMiniStats revenue={0} cogs={w.cogs} margin={null} dim />
      <div style={{ fontSize: 11, color: "var(--fg-3)", borderTop: "1px solid var(--line-soft)", paddingTop: 10, marginTop: 11 }}>Fora da média e da tendência.</div>
    </div>
  );
}

function CmvTrendChart({ trend, scale, target }) {
  if (!trend || trend.length === 0) {
    return <div style={{ padding: "16px 0", fontSize: 12, color: "var(--fg-3)" }}>Sem semanas válidas para a tendência.</div>;
  }
  const W = 700, H = 132, padX = 34, padTop = 22, plotH = 80;
  const n = trend.length;
  const x = (i) => (n <= 1 ? W / 2 : padX + (i * (W - 2 * padX)) / (n - 1));
  const span = (scale.max - scale.min) || 1;
  const y = (cmv) => padTop + (1 - (cmv - scale.min) / span) * plotH;
  const yTarget = y(target);
  const pts = trend.map((t, i) => `${x(i).toFixed(1)},${y(t.cmv).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Tendência do CMV em ${n} ${n === 1 ? "semana" : "semanas"} válidas: ${trend.map((t) => t.cmv.toFixed(1) + "%").join(", ")}. Meta ${target}%.`}
      style={{ width: "100%", height: "auto", display: "block" }}>
      <line x1={padX} y1={yTarget} x2={W - padX} y2={yTarget} stroke="var(--fg-2)" strokeWidth="1" strokeDasharray="3 4" opacity="0.5" />
      <polyline points={pts} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.5" />
      {trend.map((t, i) => (
        <g key={t.week}>
          <circle cx={x(i)} cy={y(t.cmv)} r="4.5" fill={bandColor(t.band)} />
          <text x={x(i)} y={y(t.cmv) - 9} fill="var(--fg-2)" fontSize="11" textAnchor="middle">{t.cmv.toFixed(1).replace(".", ",")}%</text>
          <text x={x(i)} y={H - 6} fill="var(--fg-3)" fontSize="9" fontFamily="var(--mono)" textAnchor="middle">{weekRangeShort(t.week)}</text>
        </g>
      ))}
    </svg>
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

// Modal de detalhe de uma célula do heatmap (operação × dia): faturamento, insumos
// que compõem o CMV daquele dia e ações de copiar p/ WhatsApp / exportar PDF.
function CmvDayDetailModal({ op, date, movements, revenueEntries, sharedSplits, onClose }) {
  const ModalShell = window.ModalShell;
  const opMeta = MOCK.opById(op);
  const opName = opMeta?.name || op;
  const dayFull = dayLabelFull(date);
  const detail = useMemo(
    () => buildDayOpDetail(movements, revenueEntries, sharedSplits, op, date),
    [movements, revenueEntries, sharedSplits, op, date],
  );
  const tone = detail.cmv != null ? cmvTone(detail.cmv) : null;
  const cmvLabel = detail.cmv != null ? `${detail.cmv.toFixed(1)}%` : "—";
  const [copying, setCopying] = useState(false);
  const [exporting, setExporting] = useState(false);

  const buildWaText = () => {
    const lines = [
      `*CMV diário — ${opName}*`,
      dayFull,
      "",
      `Faturamento: ${_fmtBRLc(detail.revenue)}`,
      `Custo (CMV): ${_fmtBRLc(detail.cogs)}`,
      `CMV: ${cmvLabel}`,
      "",
      `*Insumos consumidos (${detail.items.length})*`,
    ];
    if (detail.items.length === 0) {
      lines.push("— sem consumo registrado —");
    } else {
      for (const it of detail.items) {
        const q = (Number(it.qty) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
        lines.push(`• ${it.name} — ${q} ${it.unit} · ${_fmtBRLc(it.cost)}`);
      }
    }
    return lines.join("\n");
  };

  const onCopy = async () => {
    if (copying) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(buildWaText());
      window.showToast?.("Resumo copiado · cole no WhatsApp", { tone: "ok" });
    } catch {
      window.showToast?.("Não foi possível copiar para a área de transferência", { tone: "crit", ttl: 4500 });
    } finally {
      setCopying(false);
    }
  };

  const onExport = () => {
    if (exporting) return;
    setExporting(true);
    try {
      const tenantName = (typeof getSession === "function" && getSession()?.tenantName) || null;
      const html = buildCmvDayExportHtml({ opName, dayFull, detail, cmvLabel, tenantName });
      const w = window.open("", "_blank");
      if (!w) {
        window.showToast?.("Pop-up bloqueado · permita pop-ups para exportar", { tone: "warn", ttl: 4500 });
        return;
      }
      w.document.open();
      w.document.write(html);
      w.document.close();
    } finally {
      setExporting(false);
    }
  };

  return (
    <ModalShell
      title={opName}
      subtitle={`${dayFull} · faturamento, consumo e CMV do dia`}
      width={640}
      onClose={onClose}
      footer={<>
        <button className="btn" data-variant="ghost" data-size="sm" onClick={onCopy} disabled={copying}>
          <I.WhatsApp size={13} />{copying ? "Copiando…" : "Copiar p/ WhatsApp"}
        </button>
        <button className="btn" data-size="sm" onClick={onExport} disabled={exporting}>
          <I.Print size={13} />{exporting ? "Exportando…" : "Exportar PDF"}
        </button>
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
        <CmvKpiCard label="Faturamento" value={detail.revenue > 0 ? _fmtBRLci(detail.revenue) : "—"} sub="vendas do dia" />
        <CmvKpiCard label="Custo (CMV)" value={_fmtBRLci(detail.cogs)} sub="saídas × custo unit." />
        <CmvKpiCard label="CMV" value={cmvLabel} sub={tone ? tone.label : "sem faturamento"} tone={tone} hero />
      </div>

      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
        Insumos que compõem o CMV · {detail.items.length} {detail.items.length === 1 ? "item" : "itens"}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Qtd.</th>
            <th className="num">Valor</th>
            <th className="num">% do consumo</th>
          </tr>
        </thead>
        <tbody>
          {detail.items.length === 0 ? (
            <tr><td colSpan={4} className="dim" style={{ textAlign: "center", padding: 24 }}>Sem consumo de estoque neste dia.</td></tr>
          ) : detail.items.map((it) => {
            const pct = detail.cogs > 0 ? (it.cost / detail.cogs) * 100 : 0;
            return (
              <tr key={it.id}>
                <td style={{ color: "var(--fg-0)", fontWeight: 500 }}>{it.name}</td>
                <td className="num mono" style={{ color: "var(--fg-1)" }}>
                  {(Number(it.qty) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} {it.unit}
                </td>
                <td className="num mono" style={{ color: "var(--fg-0)" }}>{_fmtBRLc(it.cost)}</td>
                <td className="num mono" style={{ color: "var(--fg-2)" }}>{pct.toFixed(1)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ModalShell>
  );
}

// Modal de detalhe de uma semana (Seg→Dom): faturamento, insumos que compõem o CMV
// da semana (respeitando o filtro de operação) e ações de copiar p/ WhatsApp / exportar PDF.
function CmvWeekDetailModal({ week, movements, revenueEntries, sharedSplits, opFilter = "all", onClose }) {
  const ModalShell = window.ModalShell;
  const rangeShort = weekRangeShort(week);
  const rangeFull  = weekRangeFull(week);
  const isCurrent  = week === weekMonday(_ymd(new Date()));
  const opName = opFilter === "all" ? null : (MOCK.opById(opFilter)?.name || opFilter);

  // Comparação de 3 semanas: a posterior entra se já estiver completa (totalmente
  // decorrida); senão, mostra as duas anteriores. Itens ranqueados pela semana selecionada.
  const cmp = useMemo(() => {
    const addDays = (mon, d) => { const x = new Date(mon + "T12:00:00"); x.setDate(x.getDate() + d); return _ymd(x); };
    const curMon = weekMonday(_ymd(new Date()));
    const nextMon = addDays(week, 7);
    const nextComplete = nextMon < curMon; // semana posterior já fechou
    const mons = nextComplete ? [addDays(week, -7), week, nextMon] : [addDays(week, -14), addDays(week, -7), week];
    const data = mons.map((mon) => ({ mon, selected: mon === week, detail: buildWeekDetail(movements, revenueEntries, mon, sharedSplits, opFilter) }));
    const byId = {};
    data.forEach((wd) => wd.detail.items.forEach((it) => {
      if (!byId[it.id]) byId[it.id] = { id: it.id, name: it.name, unit: it.unit, perWeek: {} };
      byId[it.id].perWeek[wd.mon] = { qty: it.qty, cost: it.cost };
    }));
    const selCost = (r) => r.perWeek[week]?.cost || 0;
    const maxCost = (r) => Math.max(0, ...mons.map((m) => r.perWeek[m]?.cost || 0));
    const rows = Object.values(byId).sort((a, b) => (selCost(b) - selCost(a)) || (maxCost(b) - maxCost(a)));
    const cogsByMon = Object.fromEntries(data.map((wd) => [wd.mon, wd.detail.cogs]));
    return { mons, data, rows, cogsByMon };
  }, [movements, revenueEntries, sharedSplits, opFilter, week]);

  const detail = (cmp.data.find((d) => d.selected) || {}).detail || { revenue: 0, items: [], cogs: 0, cmv: null };
  const tone = detail.cmv != null ? cmvTone(detail.cmv) : null;
  const cmvLabel = detail.cmv != null ? `${detail.cmv.toFixed(1)}%` : "—";
  const _qfmt2 = (q) => (Number(q) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  const [copying, setCopying] = useState(false);
  const [exporting, setExporting] = useState(false);

  const buildWaText = () => {
    const lines = [
      `*CMV semanal — ${rangeShort}*`,
      `${rangeFull} (Seg→Dom)${isCurrent ? " · em andamento" : ""}`,
      ...(opName ? [`Operação: ${opName}`] : []),
      "",
      `Faturamento: ${_fmtBRLc(detail.revenue)}`,
      `Custo (CMV): ${_fmtBRLc(detail.cogs)}`,
      `CMV: ${cmvLabel}`,
      "",
      `*Insumos consumidos (${detail.items.length})*`,
    ];
    if (detail.items.length === 0) {
      lines.push("— sem consumo registrado —");
    } else {
      for (const it of detail.items) {
        const q = (Number(it.qty) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
        lines.push(`• ${it.name} — ${q} ${it.unit} · ${_fmtBRLc(it.cost)}`);
      }
    }
    return lines.join("\n");
  };

  const onCopy = async () => {
    if (copying) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(buildWaText());
      window.showToast?.("Resumo copiado · cole no WhatsApp", { tone: "ok" });
    } catch {
      window.showToast?.("Não foi possível copiar para a área de transferência", { tone: "crit", ttl: 4500 });
    } finally {
      setCopying(false);
    }
  };

  const onExport = () => {
    if (exporting) return;
    setExporting(true);
    try {
      const tenantName = (typeof getSession === "function" && getSession()?.tenantName) || null;
      const html = buildCmvExportHtml({
        docTitle: `CMV semanal · ${rangeFull}${opName ? ` · ${opName}` : ""}`,
        heading:  `CMV semanal — ${rangeShort}${opName ? ` · ${opName}` : ""}`,
        metaText: `${rangeFull} · Seg→Dom${isCurrent ? " · em andamento" : ""}`,
        emptyMsg: "Sem consumo de estoque nesta semana.",
        detail, cmvLabel, tenantName,
      });
      const w = window.open("", "_blank");
      if (!w) {
        window.showToast?.("Pop-up bloqueado · permita pop-ups para exportar", { tone: "warn", ttl: 4500 });
        return;
      }
      w.document.open();
      w.document.write(html);
      w.document.close();
    } finally {
      setExporting(false);
    }
  };

  return (
    <ModalShell
      title={`Semana ${rangeShort}${opName ? ` · ${opName}` : ""}`}
      subtitle={`${rangeFull} · Seg → Dom${isCurrent ? " · em andamento" : ""} · comparação de 3 semanas`}
      width={1120}
      onClose={onClose}
      footer={<>
        <button className="btn" data-variant="ghost" data-size="sm" onClick={onCopy} disabled={copying}>
          <I.WhatsApp size={13} />{copying ? "Copiando…" : "Copiar p/ WhatsApp"}
        </button>
        <button className="btn" data-size="sm" onClick={onExport} disabled={exporting}>
          <I.Print size={13} />{exporting ? "Exportando…" : "Exportar PDF"}
        </button>
      </>}
    >
      {/* Resumo das 3 semanas */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
        {cmp.data.map((wd) => {
          const d = wd.detail;
          const t = d.cmv != null ? cmvTone(d.cmv) : null;
          return (
            <div key={wd.mon} style={{
              padding: "12px 14px", borderRadius: 6,
              border: `1px solid ${wd.selected ? (t ? t.line : "var(--accent-line)") : "var(--line)"}`,
              background: wd.selected ? `linear-gradient(180deg, ${t ? t.bg : "var(--accent-soft)"}, transparent 70%)` : "var(--bg-2)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-0)" }}>{weekRangeShort(wd.mon)}</span>
                {wd.selected && <span style={{ fontFamily: "var(--mono)", fontSize: 8.5, letterSpacing: "0.06em", textTransform: "uppercase", color: t ? t.fg : "var(--accent-bright)", background: "var(--bg-3)", borderRadius: 999, padding: "1px 6px" }}>selecionada</span>}
              </div>
              <div style={{ fontSize: 22, fontWeight: 500, color: t ? t.fg : "var(--fg-3)" }}>{d.cmv != null ? `${d.cmv.toFixed(1)}%` : "—"}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", marginTop: 4 }}>
                Custo {_fmtBRLk(d.cogs)} · Fat {d.revenue > 0 ? _fmtBRLk(d.revenue) : "—"}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Insumos · ranqueados pela semana {rangeShort} · {cmp.rows.length} {cmp.rows.length === 1 ? "item" : "itens"}
        </span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
          <span style={{ color: "var(--ok)" }}>▼ melhora</span> · <span style={{ color: "var(--crit)" }}>▲ piora</span> vs. semana anterior
        </span>
      </div>
      <table className="table" style={{ tableLayout: "fixed", width: "100%" }}>
        <colgroup>
          <col style={{ width: "28%" }} />
          {cmp.mons.map((m) => <col key={m} style={{ width: `${72 / cmp.mons.length}%` }} />)}
        </colgroup>
        <thead>
          <tr>
            <th>Item</th>
            {cmp.mons.map((m) => (
              <th key={m} className="num" style={m === week ? { color: "var(--fg-1)" } : undefined}>{weekRangeShort(m)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cmp.rows.length === 0 ? (
            <tr><td colSpan={4} className="dim" style={{ textAlign: "center", padding: 24 }}>Sem consumo de estoque nestas semanas.</td></tr>
          ) : cmp.rows.map((r) => (
            <tr key={r.id}>
              <td style={{ color: "var(--fg-0)", fontWeight: 500 }}>{r.name}</td>
              {cmp.mons.map((m, ci) => {
                const cell = r.perWeek[m];
                const sel = m === week;
                const prev = ci > 0 ? r.perWeek[cmp.mons[ci - 1]] : null;
                const delta = (cell && prev && prev.cost > 0) ? ((cell.cost - prev.cost) / prev.cost) * 100 : null;
                const showDelta = delta != null && Math.abs(delta) >= 0.5;
                const isNew = cell && ci > 0 && !prev;
                const weekCogs = cmp.cogsByMon[m] || 0;
                const share = cell && weekCogs > 0 ? (cell.cost / weekCogs) * 100 : null;
                return (
                  <td key={m} className="num mono" style={{ background: sel ? "var(--bg-2)" : undefined, verticalAlign: "top", whiteSpace: "nowrap" }}>
                    {cell ? (
                      <>
                        <div style={{ color: sel ? "var(--fg-0)" : "var(--fg-1)", fontWeight: sel ? 500 : 400 }}>
                          {_fmtBRLc(cell.cost)}
                          {showDelta && <span style={{ marginLeft: 6, fontSize: 9.5, color: delta > 0 ? "var(--crit)" : "var(--ok)" }}>{delta > 0 ? "▲" : "▼"}{Math.abs(delta).toFixed(0)}%</span>}
                          {isNew && <span style={{ marginLeft: 6, fontSize: 9, color: "var(--fg-3)" }}>novo</span>}
                        </div>
                        <div style={{ fontSize: 9.5, color: "var(--fg-3)", marginTop: 2 }}>
                          {_qfmt2(cell.qty)} {r.unit}{share != null && ` · ${share.toFixed(1).replace(".", ",")}% do total`}
                        </div>
                      </>
                    ) : <span className="dim">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ModalShell>
  );
}

// Documento A4 standalone do detalhe do dia (mesma técnica da DRE: window.print →
// "Salvar como PDF"). Sem dependências novas.
function buildCmvDayExportHtml({ opName, dayFull, detail, cmvLabel, tenantName }) {
  return buildCmvExportHtml({
    docTitle: `CMV diário · ${opName} · ${dayFull}`,
    heading:  `CMV diário — ${opName}`,
    metaText: dayFull,
    emptyMsg: "Sem consumo de estoque neste dia.",
    detail, cmvLabel, tenantName,
  });
}

// Builder genérico do documento A4 (dia ou semana). `metaText` já sem o nome do tenant
// (prefixado aqui). `emptyMsg` é a linha exibida quando não houve consumo.
function buildCmvExportHtml({ docTitle, heading, metaText, emptyMsg, detail, cmvLabel, tenantName }) {
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const fmt = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qfmt = (v) => (Number(v) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  const rows = detail.items.map((it) => {
    const pct = detail.cogs > 0 ? (it.cost / detail.cogs) * 100 : 0;
    return `<tr><td>${esc(it.name)}</td><td class="num">${qfmt(it.qty)} ${esc(it.unit)}</td><td class="num">${fmt(it.cost)}</td><td class="num">${pct.toFixed(1)}%</td></tr>`;
  }).join("") || `<tr><td colspan="4" class="empty">${esc(emptyMsg)}</td></tr>`;

  const now = new Date();
  const genAt = `${String(now.getDate()).padStart(2,"0")}/${String(now.getMonth()+1).padStart(2,"0")}/${now.getFullYear()} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>${esc(docTitle)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 11px/1.45 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #16181c; background: #fff; }
  .toolbar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #f3f4f6; border-bottom: 1px solid #dfe2e6; }
  .toolbar button { font: 600 12px/1 inherit; padding: 8px 16px; border: 0; border-radius: 5px; background: #1a6d4a; color: #fff; cursor: pointer; }
  .toolbar span { font-size: 11px; color: #6a7077; }
  main { width: 186mm; margin: 0 auto; padding: 18px 0 0; }
  h1 { font-size: 19px; margin: 0; letter-spacing: -0.01em; }
  .meta { font-size: 10.5px; color: #6a7077; margin-top: 4px; }
  .kpis { display: flex; gap: 12px; margin: 16px 0 18px; }
  .kpis > div { flex: 1; border: 1px solid #dfe2e6; border-radius: 6px; padding: 10px 14px; }
  .kpis span { display: block; font-size: 8.5px; color: #6a7077; text-transform: uppercase; letter-spacing: 0.06em; }
  .kpis b { font-size: 16px; font-variant-numeric: tabular-nums; }
  .kpis .cmv b { color: #1a6d4a; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 8.5px; color: #6a7077; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; padding: 6px 8px; border-bottom: 1.5px solid #16181c; }
  td { padding: 5px 8px; border-bottom: 1px solid #eceef0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.empty { text-align: center; color: #9aa0a6; padding: 20px; }
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
  <h1>${esc(heading)}</h1>
  <div class="meta">${tenantName ? `${esc(tenantName)} · ` : ""}${esc(metaText)}</div>
  <div class="kpis">
    <div><span>Faturamento</span><b>${fmt(detail.revenue)}</b></div>
    <div><span>Custo (CMV)</span><b>${fmt(detail.cogs)}</b></div>
    <div class="cmv"><span>CMV</span><b>${esc(cmvLabel)}</b></div>
  </div>
  <table>
    <thead><tr><th>Item</th><th class="num">Qtd.</th><th class="num">Valor</th><th class="num">% do consumo</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <footer><span>Gerado pelo Cloud Kitchen</span><span>${genAt}</span></footer>
</main>
<script>
window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 300); });
</script>
</body>
</html>`;
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
