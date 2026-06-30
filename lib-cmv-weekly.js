// Cálculos puros da aba "Semanal" do CMV & margem. Sem React/DOM — testável via
// `node --test`. Centraliza o predicado de "semana válida" e a média corrigida (o bug:
// semanas com custo e faturamento R$ 0 — dado não sincronizado, não venda zero — inflavam
// a média). `rows`: [{ week (segunda ISO 'YYYY-MM-DD'), revenue, cogs }].

// Meta de CMV (%). PONTO ÚNICO de configuração da meta.
export const CMV_TARGET = 33;

// Semana válida = faturamento presente e > 0. 0/null = dado incompleto (não sincronizado),
// nunca "zero vendas". Toda média/tendência usa só semanas válidas.
export function isValidWeek(w) {
  return w != null && w.revenue != null && Number(w.revenue) > 0;
}

// Semana com custo mas sem faturamento → incompleta (a sinalizar).
export function isIncompleteWeek(w) {
  return w != null && !isValidWeek(w) && Number(w.cogs || 0) > 0;
}

export function weekCmv(w) {
  return isValidWeek(w) ? (Number(w.cogs) / Number(w.revenue)) * 100 : null;
}

// Média agregada corrigida sobre semanas válidas: Σcusto_válidas / Σfaturamento_válidas.
export function correctedAverage(rows) {
  const valid = (rows || []).filter(isValidWeek);
  const rev  = valid.reduce((s, w) => s + Number(w.revenue), 0);
  const cogs = valid.reduce((s, w) => s + Number(w.cogs), 0);
  return rev > 0 ? (cogs / rev) * 100 : null;
}

// Escala fixa da barra de posição (32%–40% por padrão, ampliada com folga se algum CMV
// válido ou a meta saírem da faixa). A meta usa a mesma escala.
export function cmvScale(validCmvs, target = CMV_TARGET) {
  const vals = (validCmvs || []).filter((v) => v != null);
  const min = Math.min(32, target, ...vals);
  const max = Math.max(40, target, ...vals);
  return { min: Math.floor(min), max: Math.ceil(max) };
}

// Posição [0..1] de um CMV na escala (clamped).
export function scalePosition(cmv, scale) {
  if (cmv == null || !scale || scale.max === scale.min) return 0;
  return Math.max(0, Math.min(1, (cmv - scale.min) / (scale.max - scale.min)));
}

// Faixa de cor relativa à meta: <=meta verde; >meta âmbar; pior semana válida vermelho.
export function cmvBand(cmv, { target = CMV_TARGET, worst = null } = {}) {
  if (cmv == null) return "mut";
  if (worst != null && cmv >= worst && cmv > target) return "bad";
  return cmv <= target ? "good" : "warn";
}

// Análise completa da aba: KPIs médios corrigidos, cada semana com campos derivados
// (validade, vs anterior, vs média, posição, melhor/pior) e a série da tendência.
// `currentWeekMon` = segunda-feira ISO da semana atual (excluída das médias/tendência).
export function buildWeeklyAnalysis(rows, currentWeekMon, opts = {}) {
  const target = opts.target ?? CMV_TARGET;
  const all = rows || [];
  const complete = all.filter((w) => w.week < currentWeekMon);
  const current  = all.find((w) => w.week === currentWeekMon) || null;

  const valid = complete.filter(isValidWeek).map((w) => ({
    ...w, cmv: weekCmv(w), margin: 100 - (Number(w.cogs) / Number(w.revenue)) * 100,
  }));
  const incomplete = complete.filter((w) => !isValidWeek(w));

  const avgCmv     = correctedAverage(complete);
  const avgRevenue = valid.length ? valid.reduce((s, w) => s + Number(w.revenue), 0) / valid.length : null;
  const avgCost    = valid.length ? valid.reduce((s, w) => s + Number(w.cogs), 0) / valid.length : null;
  const avgMargin  = avgCmv != null ? 100 - avgCmv : null;

  const cmvs  = valid.map((w) => w.cmv);
  const best  = cmvs.length ? Math.min(...cmvs) : null;
  const worst = cmvs.length ? Math.max(...cmvs) : null;
  const scale = cmvScale(cmvs, target);

  // ordem cronológica p/ "vs anterior" (semana válida imediatamente anterior)
  const chrono = [...valid].sort((a, b) => a.week.localeCompare(b.week));
  const prevCmv = {};
  chrono.forEach((w, i) => { prevCmv[w.week] = i > 0 ? chrono[i - 1].cmv : null; });

  const decorate = (w) => ({
    ...w,
    valid: true,
    band: cmvBand(w.cmv, { target, worst }),
    vsPrev: prevCmv[w.week] != null ? w.cmv - prevCmv[w.week] : null,
    vsAvg: avgCmv != null ? w.cmv - avgCmv : null,
    position: scalePosition(w.cmv, scale),
    isBest: best != null && w.cmv === best,
    isWorst: worst != null && w.cmv === worst,
  });

  // Exibição: válidas (mais recente → antiga), depois incompletas.
  const validDesc = [...valid].sort((a, b) => b.week.localeCompare(a.week)).map(decorate);
  const incDesc = [...incomplete].sort((a, b) => b.week.localeCompare(a.week))
    .map((w) => ({ ...w, valid: false, cmv: null, margin: null, incomplete: true }));

  return {
    target,
    avgCmv, avgRevenue, avgCost, avgMargin,
    validCount: valid.length,
    incompleteCount: incomplete.length,
    best, worst, scale,
    targetPosition: scalePosition(target, scale),
    weeks: [...validDesc, ...incDesc],
    trend: chrono.map((w) => ({ week: w.week, cmv: w.cmv, band: cmvBand(w.cmv, { target, worst }) })),
    current,
  };
}

// Projeção da semana atual: custo acumulado / dias decorridos × 7 (estimativa).
// Não projeta CMV/margem sem faturamento.
export function projectCurrentWeek(current, currentWeekMon, today = new Date()) {
  if (!current) return { cost: 0, revenue: 0, daysElapsed: 0, projectedCost: null, cmv: null };
  const mon = new Date(currentWeekMon + "T00:00:00");
  const daysElapsed = Math.min(7, Math.max(1, Math.floor((today - mon) / 86400000) + 1));
  const cost = Number(current.cogs) || 0;
  const revenue = Number(current.revenue) || 0;
  return {
    cost, revenue, daysElapsed,
    projectedCost: daysElapsed > 0 ? (cost / daysElapsed) * 7 : null,
    cmv: revenue > 0 ? (cost / revenue) * 100 : null,
  };
}
