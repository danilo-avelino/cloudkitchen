// Testes do predicado de semana válida e da média corrigida (o bug do faturamento R$ 0).
// Rodar: `node --test lib-cmv-weekly.test.js`
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidWeek, isIncompleteWeek, correctedAverage, buildWeeklyAnalysis, projectCurrentWeek,
} from "./lib-cmv-weekly.js";

// Dataset com 4 semanas válidas + 2 semanas com custo e faturamento R$ 0 (não sincronizado).
const rows = [
  { week: "2026-06-01", revenue: 152496, cogs: 60289 }, // 39.5%
  { week: "2026-06-08", revenue: 156354, cogs: 57043 }, // 36.5%
  { week: "2026-06-15", revenue: 150662, cogs: 49400 }, // 32.8%
  { week: "2026-06-22", revenue: 144500, cogs: 52300 }, // 36.2%
  { week: "2026-05-25", revenue: 0,      cogs: 58000 }, // incompleta
  { week: "2026-05-18", revenue: null,   cogs: 1137  }, // incompleta
];

test("isValidWeek: faturamento > 0 é válido; 0/null não", () => {
  assert.equal(isValidWeek({ revenue: 100, cogs: 10 }), true);
  assert.equal(isValidWeek({ revenue: 0, cogs: 10 }), false);
  assert.equal(isValidWeek({ revenue: null, cogs: 10 }), false);
  assert.equal(isValidWeek(undefined), false);
});

test("isIncompleteWeek: custo > 0 sem faturamento", () => {
  assert.equal(isIncompleteWeek({ revenue: 0, cogs: 58000 }), true);
  assert.equal(isIncompleteWeek({ revenue: null, cogs: 1137 }), true);
  assert.equal(isIncompleteWeek({ revenue: 0, cogs: 0 }), false); // sem custo → não é "incompleta"
  assert.equal(isIncompleteWeek({ revenue: 100, cogs: 10 }), false);
});

test("correctedAverage usa só semanas válidas (~36,3%), não o valor inflado (~46%)", () => {
  const corrected = correctedAverage(rows);
  assert.ok(Math.abs(corrected - 36.26) < 0.1, `esperado ~36.3, veio ${corrected}`);

  // O cálculo antigo (Σcogs/Σrev sobre TODAS as semanas) inflava para ~46%.
  const allRev  = rows.reduce((s, w) => s + (Number(w.revenue) || 0), 0);
  const allCogs = rows.reduce((s, w) => s + (Number(w.cogs) || 0), 0);
  const buggy = (allCogs / allRev) * 100;
  assert.ok(buggy > 45 && buggy < 47, `bug esperado ~46, veio ${buggy}`);
  assert.ok(corrected < buggy - 8, "a média corrigida deve ser bem menor que a inflada");
});

test("correctedAverage devolve null quando não há semana válida", () => {
  assert.equal(correctedAverage([{ week: "2026-05-25", revenue: 0, cogs: 58000 }]), null);
});

test("buildWeeklyAnalysis: separa válidas/incompletas, ordena e deriva campos", () => {
  const a = buildWeeklyAnalysis(rows, "2026-06-29");
  assert.equal(a.validCount, 4);
  assert.equal(a.incompleteCount, 2);
  assert.ok(Math.abs(a.avgCmv - 36.26) < 0.1);

  // melhor = menor CMV (15/06 = 32.8), pior = maior (01/06 = 39.5)
  assert.ok(Math.abs(a.best - 32.79) < 0.1);
  assert.ok(Math.abs(a.worst - 39.54) < 0.1);

  // ordem: válidas mais recente→antiga, incompletas por último
  const order = a.weeks.map((w) => w.week);
  assert.deepEqual(order, ["2026-06-22", "2026-06-15", "2026-06-08", "2026-06-01", "2026-05-25", "2026-05-18"]);
  assert.equal(a.weeks.at(-1).valid, false);

  // a primeira semana válida (cronologicamente 01/06) não tem "vs anterior"
  const w0106 = a.weeks.find((w) => w.week === "2026-06-01");
  assert.equal(w0106.vsPrev, null);
  // 08/06 vs 01/06 = 36.5 - 39.5 ≈ -3.0pp
  const w0806 = a.weeks.find((w) => w.week === "2026-06-08");
  assert.ok(Math.abs(w0806.vsPrev - (-3.0)) < 0.2);
});

test("projectCurrentWeek: custo acumulado / dias × 7", () => {
  const cur = { week: "2026-06-29", revenue: 0, cogs: 6607 };
  const p = projectCurrentWeek(cur, "2026-06-29", new Date("2026-06-29T12:00:00"));
  assert.equal(p.daysElapsed, 1);
  assert.ok(Math.abs(p.projectedCost - 46249) < 1, `proj esperado ~46249, veio ${p.projectedCost}`);
  assert.equal(p.cmv, null); // sem faturamento, não projeta CMV
});
