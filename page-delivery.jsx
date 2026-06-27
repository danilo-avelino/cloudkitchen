// Logística — sub-abas: Tempos (gráfico de camada dos tempos médios por
// dia + piores dias + itens que mais atrasam a produção), Entregadores (ranking),
// Bairros/Raios (análise geográfica) e Turnos (config de faixas de horário). Dados da Agilizone via RPCs
// agilizone_delivery_timeseries (série + piores itens) e agilizone_delivery_metrics
// (ranking de entregadores). Turnos em delivery_shifts.

// "Dia efetivo": corte 05:00 BRT = UTC-8h (igual ao ingest).
function _effDay(d) { return new Date(d.getTime() - 8 * 3600e3).toISOString().slice(0, 10); }
// segundos → "Xm YYs" (ou "Ys")
function _fmtDur(s) {
  if (s == null) return "—";
  const n = Math.round(Number(s));
  const m = Math.floor(n / 60), sec = n % 60;
  return m === 0 ? `${sec}s` : `${m}m ${String(sec).padStart(2, "0")}s`;
}
// segundos → "M:SS" (ex.: 1161s → "19:21")
function _fmtMS(s) {
  if (s == null) return "—";
  const n = Math.max(0, Math.round(Number(s)));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
function _hm(t) { return (t || "").slice(0, 5); }
function _brl(v) { return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function _weekday(day) {
  try {
    const w = new Date(day + "T12:00:00Z").toLocaleDateString("pt-BR", { weekday: "short", timeZone: "UTC" }).replace(".", "");
    return w.charAt(0).toUpperCase() + w.slice(1);
  } catch { return ""; }
}
function _niceCeil(v) { const step = 300; return Math.max(step, Math.ceil(v / step) * step); }
function _daysRange(from, to) {
  const out = [];
  let d = new Date(from + "T12:00:00Z");
  const end = new Date(to + "T12:00:00Z");
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400e3); }
  return out;
}

// --- Bairros/Raios (sub-abas) ---
function _dNum(v) { return (Number(v) || 0).toLocaleString("pt-BR"); }
function _dPct(v) { return (Number(v) || 0).toLocaleString("pt-BR", { style: "percent", maximumFractionDigits: 1 }); }
// metros → "1,2 km" ou "840 m"
function _dDist(m) {
  const n = Number(m) || 0;
  if (n <= 0) return "—";
  return n >= 1000
    ? (n / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " km"
    : Math.round(n) + " m";
}
// raio N → "0–1 km" (de N-1 a N km)
function _raioLabel(k) { return `${Math.max(0, k - 1)}–${k} km`; }
// CSV pt-BR (Excel): ';' separador, ',' decimal, sem agrupamento.
function _dCsvCell(v) { const s = String(v == null ? "" : v); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function _dCsvNum(v, dec = 2) { return (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: false }); }
// % de atraso (0–100) → cor de severidade
function _lateColor(pct) { const n = Number(pct) || 0; return n >= 40 ? "var(--crit)" : n >= 20 ? "var(--warn)" : "var(--fg-1)"; }

const _DELIV_PERIODS = [
  { id: "7d",  label: "7 dias",  days: 7 },
  { id: "30d", label: "30 dias", days: 30 },
];
const _DELIV_VIEWS = [
  { id: "tempos",       label: "Tempos" },
  { id: "entregadores", label: "Entregadores" },
  { id: "bairros",      label: "Bairros" },
  { id: "raios",        label: "Raios" },
  { id: "turnos",       label: "Turnos" },
];
const _LAYERS = [
  { key: "avgPrep",    label: "Preparo", color: "var(--accent-bright)" },
  { key: "avgCollect", label: "Coleta",  color: "var(--info)" },
  { key: "avgDeliver", label: "Entrega", color: "var(--warn)" },
];

// --------------------------- gráfico de camada ---------------------------
// Curva suave (Catmull-Rom → Bézier) passando pelos pontos.
function _smoothPath(pts) {
  if (!pts.length) return "";
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const t = 1 / 6;
    const c1x = p1[0] + (p2[0] - p0[0]) * t, c1y = p1[1] + (p2[1] - p0[1]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t, c2y = p2[1] - (p3[1] - p1[1]) * t;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function StackedAreaChart({ days }) {
  const [hover, setHover] = useState(null);
  const W = 760, H = 280, padL = 50, padR = 16, padT = 16, padB = 30;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = days.length;
  const maxTotal = Math.max(1, ...days.map((d) => d.total || 0));
  const niceMax = _niceCeil(maxTotal);
  const xAt = (i) => padL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yAt = (v) => padT + ih - (Math.max(0, v) / niceMax) * ih;

  const prep = days.map((d) => d.avgPrep || 0);
  const c2   = days.map((d) => (d.avgPrep || 0) + (d.avgCollect || 0));
  const c3   = days.map((d) => d.total || 0);
  const zero = days.map(() => 0);
  const P = (arr) => arr.map((v, i) => [xAt(i), yAt(v)]);
  // área = curva do topo (ida) + curva da base (volta)
  const area = (topArr, botArr) => {
    const topPath = _smoothPath(P(topArr));
    const botPath = _smoothPath(P(botArr).slice().reverse());
    return `${topPath}L${botPath.slice(1)}Z`;
  };
  const line = (arr) => _smoothPath(P(arr));

  const ticks = [0, niceMax / 2, niceMax];
  const labelEvery = Math.ceil(n / 8);
  const hd = hover != null ? days[hover] : null;
  const txAnchor = hover == null ? "-50%" : hover <= 1 ? "0%" : hover >= n - 2 ? "-100%" : "-50%";

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const vbX = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((vbX - padL) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, idx)));
  };

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} preserveAspectRatio="xMidYMid meet"
           onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          {_LAYERS.map((l) => (
            <linearGradient key={l.key} id={`grad-${l.key}`} x1="0" y1={padT} x2="0" y2={padT + ih} gradientUnits="userSpaceOnUse">
              <stop offset="0%"   stopColor={l.color} stopOpacity="0.55" />
              <stop offset="100%" stopColor={l.color} stopOpacity="0.92" />
            </linearGradient>
          ))}
        </defs>

        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} y1={yAt(t)} x2={W - padR} y2={yAt(t)} stroke="var(--line)" strokeWidth="1" strokeDasharray={i === 0 ? undefined : "3 4"} />
            <text x={padL - 8} y={yAt(t) + 3} textAnchor="end" fontSize="9.5" fontFamily="var(--mono)" fill="var(--fg-3)">{_fmtDur(t)}</text>
          </g>
        ))}

        <path d={area(c3, c2)} fill="url(#grad-avgDeliver)" stroke="none" />
        <path d={area(c2, prep)} fill="url(#grad-avgCollect)" stroke="none" />
        <path d={area(prep, zero)} fill="url(#grad-avgPrep)" stroke="none" />
        <path d={line(c3)} fill="none" stroke="var(--warn)" strokeWidth="1.6" strokeLinejoin="round" opacity="0.9" />
        <path d={line(c2)} fill="none" stroke="var(--info)" strokeWidth="1.4" strokeLinejoin="round" opacity="0.85" />
        <path d={line(prep)} fill="none" stroke="var(--accent-bright)" strokeWidth="1.4" strokeLinejoin="round" opacity="0.85" />

        {days.map((d, i) => (
          <text key={"x" + i} x={xAt(i)} y={H - 10} textAnchor="middle" fontSize="9.5" fontFamily="var(--mono)"
                fill={i === hover ? "var(--fg-1)" : "var(--fg-3)"} style={{ display: i % labelEvery === 0 || i === n - 1 || i === hover ? undefined : "none" }}>{d.label}</text>
        ))}

        {hd && (
          <g pointerEvents="none">
            <line x1={xAt(hover)} y1={padT} x2={xAt(hover)} y2={padT + ih} stroke="var(--fg-2)" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
            {[[prep[hover], "var(--accent-bright)"], [c2[hover], "var(--info)"], [c3[hover], "var(--warn)"]].map(([v, col], k) =>
              v > 0 ? <circle key={k} cx={xAt(hover)} cy={yAt(v)} r="3.4" fill={col} stroke="var(--bg-1)" strokeWidth="1.5" /> : null
            )}
          </g>
        )}
      </svg>

      {hd && (
        <div style={{
          position: "absolute", left: `${(xAt(hover) / W) * 100}%`, top: 4,
          transform: `translateX(${txAnchor})`, pointerEvents: "none", zIndex: 5,
          background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 6,
          boxShadow: "0 6px 18px rgba(0,0,0,0.35)", padding: "8px 10px", minWidth: 150,
        }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--fg-0)", marginBottom: 6 }}>
            {hd.label} <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>{_weekday(hd.day)} · {hd.orders} ped.</span>
          </div>
          {hd.orders === 0 ? (
            <div style={{ fontSize: 11.5, color: "var(--fg-3)" }}>Sem dados</div>
          ) : (
            <>
              {_LAYERS.map((l) => (
                <div key={l.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, fontSize: 11.5, marginBottom: 3 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--fg-2)" }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: l.color }} />{l.label}
                  </span>
                  <span style={{ fontFamily: "var(--mono)", color: "var(--fg-1)" }}>{_fmtDur(hd[l.key])}</span>
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, fontSize: 11.5, marginTop: 5, paddingTop: 5, borderTop: "1px solid var(--line)" }}>
                <span style={{ color: "var(--fg-2)", fontWeight: 500 }}>Total</span>
                <span style={{ fontFamily: "var(--mono)", color: "var(--accent-bright)", fontWeight: 600 }}>{_fmtDur(hd.total)}</span>
              </div>
            </>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 16, marginTop: 8, paddingLeft: padL, flexWrap: "wrap" }}>
        {_LAYERS.map((l) => (
          <span key={l.key} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--fg-2)" }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: l.color }} />{l.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function DayCard({ d, rank, tone }) {
  const col = tone === "ok" ? "var(--ok)" : "var(--crit)";
  return (
    <div className="card"><div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 500 }}>{d.label} <span style={{ color: "var(--fg-3)", fontWeight: 400, fontSize: 11.5 }}>{_weekday(d.day)}</span></span>
        <span style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: "var(--fg-3)" }}>#{rank} · {d.orders} ped.</span>
      </div>
      <div style={{ fontSize: 19, fontWeight: 500, fontFamily: "var(--mono)", color: col }}>{_fmtDur(d.total)}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2 }}>
        {_LAYERS.map((l) => (
          <div key={l.key} style={{ fontSize: 12, fontFamily: "var(--mono)" }}>
            <span style={{ color: "var(--fg-3)" }}>{l.label}: </span>
            <span style={{ color: l.color }}>{_fmtMS(d[l.key])}</span>
          </div>
        ))}
      </div>
    </div></div>
  );
}

function MetricCell({ label, value, strong }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: strong ? 19 : 17, fontWeight: 500, color: strong ? "var(--accent-bright)" : "var(--fg-0)", fontFamily: "var(--mono)" }}>{value}</div>
    </div>
  );
}

// --------------------------- mini dashboard (entregadores) ---------------------------
function StatBox({ label, value, hint }) {
  return (
    <div className="card"><div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 500, fontFamily: "var(--mono)", color: "var(--fg-0)" }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: "var(--fg-3)" }}>{hint}</div>}
    </div></div>
  );
}

// Arrecadação de taxas: cobrado do cliente (delivery_fee) vs. pago ao entregador
// (deliveryman_fee). `fees` vem do RPC agilizone_delivery_metrics; enquanto a
// migration não estiver no ar, fica indisponível (placeholder).
function FeesBox({ fees }) {
  const has = fees != null;
  const collected = Number(fees?.clientCollected) || 0;
  const paid = Number(fees?.deliverymanPaid) || 0;
  const net = collected - paid;
  const Row = ({ label, value, color }) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, fontSize: 12.5 }}>
      <span style={{ color: "var(--fg-2)" }}>{label}</span>
      <span style={{ fontFamily: "var(--mono)", color }}>{value}</span>
    </div>
  );
  return (
    <div className="card"><div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Arrecadação de taxas</div>
      {!has ? (
        <div style={{ fontSize: 12, color: "var(--fg-3)", lineHeight: 1.5 }}>Sem dados de taxas no período.</div>
      ) : (
        <>
          <Row label="Arrecadado dos clientes" value={_brl(collected)} color="var(--ok)" />
          <Row label="Pago aos entregadores"  value={_brl(paid)}      color="var(--crit)" />
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 7 }}>
            <Row label="Saldo" value={_brl(net)} color={net >= 0 ? "var(--accent-bright)" : "var(--crit)"} />
          </div>
        </>
      )}
    </div></div>
  );
}

// Investimento em descontos · loja vs iFood (mesmo payload do RPC de taxas)
function DiscountsBox({ fees }) {
  const has = fees != null;
  const store = Number(fees?.storeDiscount) || 0;
  const ifood = Number(fees?.ifoodDiscount) || 0;
  const saldo = ifood - store; // verde se o iFood patrocina mais que a loja
  const Row = ({ label, value, color }) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, fontSize: 12.5 }}>
      <span style={{ color: "var(--fg-2)" }}>{label}</span>
      <span style={{ fontFamily: "var(--mono)", color }}>{value}</span>
    </div>
  );
  return (
    <div className="card"><div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Investimento em descontos</div>
      {!has ? (
        <div style={{ fontSize: 12, color: "var(--fg-3)", lineHeight: 1.5 }}>Sem dados de desconto no período.</div>
      ) : (
        <>
          <Row label="Desconto dado pela loja"   value={_brl(store)} color="var(--crit)" />
          <Row label="Desconto pago pelo iFood"  value={_brl(ifood)} color="var(--ok)" />
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 7 }}>
            <Row label="Saldo do investimento" value={_brl(saldo)} color={saldo >= 0 ? "var(--ok)" : "var(--crit)"} />
          </div>
        </>
      )}
    </div></div>
  );
}

// --------------------------- config de turnos ---------------------------
function ShiftRow({ shift, onChanged }) {
  const [name, setName]   = useState(shift.name);
  const [start, setStart] = useState(_hm(shift.start_time));
  const [end, setEnd]     = useState(_hm(shift.end_time));
  const [saving, setSaving]     = useState(false);
  const [deleting, setDeleting] = useState(false);
  const dirty = name !== shift.name || start !== _hm(shift.start_time) || end !== _hm(shift.end_time);

  const save = async () => {
    if (saving || !dirty) return;
    if (!name.trim() || !start || !end) { window.showToast?.("Preencha nome, início e fim", { tone: "crit" }); return; }
    setSaving(true);
    const { error } = await dbUpdateDeliveryShift(shift.id, { name, startTime: start, endTime: end });
    setSaving(false);
    if (error) { window.showToast?.(error.message, { tone: "crit" }); return; }
    window.showToast?.("Turno atualizado");
    onChanged?.();
  };
  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    const { error } = await dbDeleteDeliveryShift(shift.id);
    setDeleting(false);
    if (error) { window.showToast?.(error.message, { tone: "crit" }); return; }
    window.showToast?.("Turno removido");
    onChanged?.();
  };

  return (
    <tr>
      <td><input className="input" value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} /></td>
      <td><input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} style={{ width: 110 }} /></td>
      <td><input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} style={{ width: 110 }} /></td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        <button className="btn" data-size="sm" data-variant={dirty ? "primary" : undefined} disabled={saving || !dirty} onClick={save}>
          {saving ? "Salvando…" : "Salvar"}
        </button>
        <button className="btn" data-size="sm" disabled={deleting} onClick={remove} style={{ marginLeft: 6 }}>
          {deleting ? "Excluindo…" : "Excluir"}
        </button>
      </td>
    </tr>
  );
}

function DeliveryShiftsConfig({ tid, shifts, onChanged }) {
  const [name, setName]   = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd]     = useState("");
  const [adding, setAdding] = useState(false);

  const add = async () => {
    if (adding) return;
    if (!name.trim() || !start || !end) { window.showToast?.("Preencha nome, início e fim", { tone: "crit" }); return; }
    setAdding(true);
    const { error } = await dbInsertDeliveryShift(tid, { name, startTime: start, endTime: end, sortOrder: shifts.length });
    setAdding(false);
    if (error) { window.showToast?.(error.message, { tone: "crit" }); return; }
    setName(""); setStart(""); setEnd("");
    window.showToast?.("Turno criado");
    onChanged?.();
  };

  return (
    <>
      <div style={{ fontSize: 12, color: "var(--fg-3)", maxWidth: 720 }}>
        Divida o dia em faixas de horário nomeadas (ex.: Almoço 11:00–15:00, Jantar 18:00–23:00).
        Os turnos aparecem como filtro na aba <b>Tempos</b>. Faixa que cruza a meia-noite é permitida (início maior que fim).
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr><th>Nome</th><th style={{ width: 130 }}>Início</th><th style={{ width: 130 }}>Fim</th><th style={{ width: 180 }}></th></tr>
          </thead>
          <tbody>
            {shifts.map((s) => <ShiftRow key={s.id} shift={s} onChanged={onChanged} />)}
            <tr>
              <td><input className="input" placeholder="Novo turno" value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} /></td>
              <td><input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} style={{ width: 110 }} /></td>
              <td><input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} style={{ width: 110 }} /></td>
              <td style={{ textAlign: "right" }}>
                <button className="btn" data-size="sm" data-variant="primary" disabled={adding} onClick={add}>
                  {adding ? "Adicionando…" : "Adicionar"}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {shifts.length === 0 && (
        <div style={{ fontSize: 12.5, color: "var(--fg-3)" }}>Nenhum turno cadastrado ainda.</div>
      )}
    </>
  );
}

// --------------------------- bairros/raios ---------------------------
// barra horizontal de participação dentro da célula
function BrShareBar({ pct, color }) {
  return (
    <div style={{ height: 6, borderRadius: 3, background: "var(--line)", overflow: "hidden" }}>
      <div style={{ width: `${Math.max(2, Math.min(100, (Number(pct) || 0) * 100))}%`, height: "100%", background: color || "var(--accent-bright)", borderRadius: 3 }} />
    </div>
  );
}
function BrKpi({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 500, fontFamily: "var(--mono)", color: color || "var(--fg-0)" }}>{value}</div>
    </div>
  );
}

// cabeçalho clicável p/ ordenar o ranking de entregadores (desc → asc → desc…)
function _dmSortVal(d, key) { return key === "name" ? (d.name || "") : (Number(d[key]) || 0); }
function DmTh({ label, sortKey, sort, onSort, width, align }) {
  const active = sort.key === sortKey;
  return (
    <th onClick={() => onSort(sortKey)} title="Ordenar"
        style={{ width, textAlign: align || "left", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
      {label}
      <span style={{ marginLeft: 4, fontSize: 9, color: active ? "var(--accent-bright)" : "var(--fg-3)", opacity: active ? 1 : 0.4 }}>
        {active ? (sort.dir === "desc" ? "▼" : "▲") : "▼"}
      </span>
    </th>
  );
}

// ------------------------------- principal -------------------------------
function DeliveryTimes({ scope }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid]         = useState(null);
  const [opMap, setOpMap]     = useState({});
  const [ops, setOps]         = useState([]);
  const [shifts, setShifts]   = useState([]);
  const [view, setView]       = useState("tempos");
  const [period, setPeriod]   = useState("7d");
  const [opFilter, setOpFilter]       = useState("all");
  const [shiftFilter, setShiftFilter] = useState("all");

  const [ts, setTs]           = useState(null);   // timeseries (aba Tempos)
  const [metrics, setMetrics] = useState(null);   // ranking (aba Entregadores)
  const [hoods, setHoods]     = useState([]);     // bairros (aba Bairros)
  const [radii, setRadii]     = useState([]);     // raios (aba Raios)
  const [exporting, setExporting] = useState(false);
  const [dmSort, setDmSort]   = useState({ key: "deliveries", dir: "desc" }); // ordenação do ranking
  const [range, setRange]     = useState({ from: null, to: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState(false);
  const [integ, setInteg]     = useState(null);   // integração Agilizone ativa? (null = carregando)

  const refreshShifts = async (t) => {
    const tenant = t || tid;
    if (!tenant) return;
    const { data } = await dbListDeliveryShifts(tenant);
    setShifts(data || []);
  };

  // contexto + operações + turnos (uma vez)
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
      const map = {};
      (o || []).filter((x) => x.id !== "all").forEach((x) => { map[x.id] = { name: x.name, color: x.color, short: x.short_label }; });
      setOpMap(map);
      setOps((o || []).filter((x) => x.id !== "all").map((x) => ({ id: x.id, name: x.name })));
      await refreshShifts(t);
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
    if (view === "turnos") { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setBusy(true);
      const days = _DELIV_PERIODS.find((p) => p.id === period)?.days || 7;
      const to = _effDay(new Date());
      const from = _effDay(new Date(Date.now() - (days - 1) * 86400e3));
      setRange({ from, to });
      try {
        if (view === "tempos") {
          const sh = shiftFilter === "all" ? null : shifts.find((s) => s.id === shiftFilter);
          const { data, error } = await dbDeliveryTimeseries(
            tid, from, to,
            opFilter === "all" ? null : opFilter,
            sh ? sh.start_time : null, sh ? sh.end_time : null,
          );
          if (cancelled) return;
          if (error) throw error;
          setTs(data || { byDay: [], worstItems: [], summary: {} });
        } else if (view === "entregadores") {
          const [mRes, fRes] = await Promise.all([
            dbDeliveryMetrics(tid, from, to),
            dbDeliveryFees(tid, from, to),
          ]);
          if (cancelled) return;
          if (mRes.error) throw mRes.error;
          setMetrics({ ...(mRes.data || { byDeliveryman: [] }), fees: fRes.data?.total || null });
        } else if (view === "bairros") {
          const { data, error } = await dbNeighborhoodStats(tid, from, to, opFilter === "all" ? null : opFilter);
          if (cancelled) return;
          if (error) throw error;
          setHoods(data || []);
        } else if (view === "raios") {
          const { data, error } = await dbRadiusStats(tid, from, to, opFilter === "all" ? null : opFilter);
          if (cancelled) return;
          if (error) throw error;
          setRadii(data || []);
        }
      } catch (e) {
        if (!cancelled) window.showToast?.(e.message, { tone: "crit" });
      } finally {
        if (!cancelled) { setBusy(false); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [tid, view, period, opFilter, shiftFilter, shifts]);

  if (loading || (dbStatus.isOnline && tid && integ === null))
    return <PageLoading label="Carregando logística…" variant="cards" hint="" />;

  if (!dbStatus.isOnline || !tid) {
    return (
      <div style={{ padding: "24px 28px" }}>
        <div style={{ fontSize: 12.5, color: "var(--warn)", padding: "10px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 4 }}>
          A Logística só fica disponível com Supabase online.
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
            A Logística é alimentada pela integração com a <b>Agilizone</b>, o sistema de gestão de delivery.
          </p>
          <p style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.6, margin: 0 }}>
            Entre em contato com a <b>Agilizone</b> para realizar a integração. Depois, ative-a e atrele as
            marcas às operações em <b>Configurações → Agilizone</b>.
          </p>
        </div>
      </div>
    );
  }

  // monta a série diária contínua (preenche dias sem pedido com 0)
  const byDayMap = {};
  (ts?.byDay || []).forEach((d) => { byDayMap[d.day] = d; });
  const chartDays = (range.from && range.to ? _daysRange(range.from, range.to) : []).map((day) => {
    const d = byDayMap[day] || {};
    const p = Number(d.avgPrep) || 0, c = Number(d.avgCollect) || 0, e = Number(d.avgDeliver) || 0;
    return { day, label: day.slice(8, 10) + "/" + day.slice(5, 7), avgPrep: p, avgCollect: c, avgDeliver: e, total: p + c + e, orders: Number(d.orders) || 0 };
  });
  const hasTimeData = chartDays.some((d) => d.total > 0);
  const rankedDays = chartDays.filter((d) => d.orders > 0 && d.total > 0).slice().sort((a, b) => b.total - a.total);
  const worstDays = rankedDays.slice(0, 3);
  const bestDays = rankedDays.slice().reverse().slice(0, 3);
  const sm = ts?.summary || {};
  const worstItems = ts?.worstItems || [];
  const ranking = metrics?.byDeliveryman || [];
  const fees = metrics?.fees ?? null;
  const totalDeliveries = ranking.reduce((s, d) => s + (Number(d.deliveries) || 0), 0);
  const sortDm = (key) => setDmSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
  const sortedRanking = ranking.slice().sort((a, b) => {
    const va = _dmSortVal(a, dmSort.key), vb = _dmSortVal(b, dmSort.key);
    const cmp = typeof va === "string" ? va.localeCompare(vb, "pt-BR") : va - vb;
    return dmSort.dir === "desc" ? -cmp : cmp;
  });

  // derivados Bairros
  const hoodOrders  = hoods.reduce((s, r) => s + (Number(r.orders) || 0), 0);
  const hoodRevenue = hoods.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const hoodTicket  = hoodOrders > 0 ? hoodRevenue / hoodOrders : 0;
  const hoodMeasured = hoods.reduce((s, r) => s + (Number(r.measured) || 0), 0);
  const hoodLate     = hoods.reduce((s, r) => s + (Number(r.late_orders) || 0), 0);
  const hoodLatePct  = hoodMeasured > 0 ? hoodLate / hoodMeasured : null;
  // derivados Raios
  const radOrders  = radii.reduce((s, r) => s + (Number(r.orders) || 0), 0);
  const radRevenue = radii.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  const radDistSum = radii.reduce((s, r) => s + (Number(r.avg_distance) || 0) * (Number(r.orders) || 0), 0);
  const radAvgDist = radOrders > 0 ? radDistSum / radOrders : 0;
  const radTop     = radii.slice().sort((a, b) => (Number(b.orders) || 0) - (Number(a.orders) || 0))[0] || null;
  const radWithin3 = radii.filter((r) => Number(r.radius_km) <= 3).reduce((s, r) => s + (Number(r.orders) || 0), 0);
  const radMeasured = radii.reduce((s, r) => s + (Number(r.measured) || 0), 0);
  const radLate     = radii.reduce((s, r) => s + (Number(r.late_orders) || 0), 0);
  const radLatePct  = radMeasured > 0 ? radLate / radMeasured : null;

  // Exporta o ranking de bairros (CSV pt-BR).
  const exportHoods = () => {
    if (exporting) return;
    setExporting(true);
    try {
      if (!hoods.length) { window.showToast?.("Nada para exportar no período/filtro.", { tone: "warn" }); return; }
      const head = ["Bairro", "Pedidos", "% pedidos", "Faturamento", "Ticket médio", "Distância média (m)", "% atrasadas"];
      const rows = hoods.map((r) => [
        _dCsvCell(r.neighborhood),
        _dCsvNum(r.orders, 0),
        _dCsvNum(hoodOrders > 0 ? (Number(r.orders) || 0) / hoodOrders * 100 : 0, 1),
        _dCsvNum(r.revenue, 2),
        _dCsvNum(r.avg_ticket, 2),
        _dCsvNum(r.avg_distance, 0),
        Number(r.measured) > 0 ? _dCsvNum(r.late_pct, 1) : "",
      ].join(";"));
      const csv = [head.join(";"), ...rows].join("\r\n");
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bairros-${period}-${_effDay(new Date())}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      window.showToast?.("Bairros exportados.", { tone: "ok" });
    } finally {
      setTimeout(() => setExporting(false), 600);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "20px 28px 0" }}>
        <div className="h-eyebrow" style={{ marginBottom: 6 }}>Operação · Agilizone</div>
        <h1 className="h-title">Logística</h1>

        {/* sub-abas */}
        <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--line)", marginTop: 14 }}>
          {_DELIV_VIEWS.map((v) => (
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

        {/* controles (não em Turnos) */}
        {view !== "turnos" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            {_DELIV_PERIODS.map((p) => (
              <button key={p.id} className="btn" data-size="sm" data-variant={period === p.id ? "primary" : undefined}
                      onClick={() => setPeriod(p.id)}>{p.label}</button>
            ))}
            {(view === "tempos" || view === "bairros" || view === "raios") && (
              <>
                <span style={{ width: 1, height: 18, background: "var(--line)", margin: "0 4px" }} />
                <select className="input" style={{ width: 200 }} value={opFilter} onChange={(e) => setOpFilter(e.target.value)}>
                  <option value="all">Todas as operações</option>
                  {ops.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                {view === "tempos" && (
                  <select className="input" style={{ width: 220 }} value={shiftFilter} onChange={(e) => setShiftFilter(e.target.value)}>
                    <option value="all">Todos os turnos</option>
                    {shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({_hm(s.start_time)}–{_hm(s.end_time)})</option>)}
                  </select>
                )}
                {view === "bairros" && (
                  <button className="btn" data-size="sm" onClick={exportHoods} disabled={exporting || hoods.length === 0}>
                    {exporting ? "Exportando…" : "Exportar"}
                  </button>
                )}
              </>
            )}
            {busy && <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>atualizando…</span>}
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 32px", display: "flex", flexDirection: "column", gap: 18 }}>

        {/* ----------------------------- TEMPOS ---------------------------- */}
        {view === "tempos" && (
          !hasTimeData ? (
            <div style={{ fontSize: 13, color: "var(--fg-3)", maxWidth: 620 }}>
              Sem dados de delivery no período/filtro. Verifique se há operações com marcas
              atreladas em <b>Configurações → Agilizone</b> e se o ingest já rodou.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
                <MetricCell label="Preparo" value={_fmtDur(sm.avgPrep)} />
                <MetricCell label="Coleta"  value={_fmtDur(sm.avgCollect)} />
                <MetricCell label="Entrega" value={_fmtDur(sm.avgDeliver)} />
                <MetricCell label="Total"   value={_fmtDur(sm.avgTotal)} strong />
                <div style={{ marginLeft: "auto" }}><MetricCell label="Pedidos" value={(sm.orders || 0).toLocaleString("pt-BR")} /></div>
              </div>

              <div className="card">
                <div className="card-body">
                  <div style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500, marginBottom: 10 }}>Tempo médio por dia (camadas)</div>
                  <StackedAreaChart days={chartDays} />
                </div>
              </div>

              <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 460px", minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500, marginBottom: 8 }}>3 melhores dias <span style={{ color: "var(--fg-3)", fontWeight: 400, fontSize: 11.5 }}>· menor tempo total</span></div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                    {bestDays.map((d, i) => <DayCard key={d.day} d={d} rank={i + 1} tone="ok" />)}
                  </div>
                </div>
                <div style={{ flex: "1 1 460px", minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500, marginBottom: 8 }}>3 piores dias <span style={{ color: "var(--fg-3)", fontWeight: 400, fontSize: 11.5 }}>· maior tempo total</span></div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                    {worstDays.map((d, i) => <DayCard key={d.day} d={d} rank={i + 1} tone="crit" />)}
                  </div>
                </div>
              </div>

              <div>
                <div style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500, marginBottom: 4 }}>Itens que mais atrasam a produção</div>
                <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginBottom: 8 }}>
                  Presença em pedidos atrasados — preparo acima de {_fmtDur(ts?.lateThreshold)} (P75 do recorte).
                </div>
                {worstItems.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: "var(--fg-3)" }}>Sem pedidos atrasados suficientes no recorte.</div>
                ) : (
                  <div className="card">
                    <table className="table">
                      <thead>
                        <tr><th style={{ width: 44 }}>#</th><th>Item</th><th style={{ width: 130, textAlign: "right" }}>Pedidos atrasados</th><th style={{ width: 150, textAlign: "right" }}>Preparo médio</th></tr>
                      </thead>
                      <tbody>
                        {worstItems.map((w, i) => (
                          <tr key={(w.externalCode || w.name) + i}>
                            <td style={{ fontFamily: "var(--mono)", color: "var(--fg-3)" }}>{i + 1}</td>
                            <td>
                              {w.name}
                              {w.externalCode && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", marginLeft: 6 }}>{w.externalCode}</span>}
                            </td>
                            <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>{w.lateOrders}</td>
                            <td style={{ textAlign: "right", fontFamily: "var(--mono)", color: "var(--crit)" }}>{_fmtDur(w.avgPrep)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )
        )}

        {/* -------------------------- ENTREGADORES ------------------------- */}
        {view === "entregadores" && (
          ranking.length === 0 && !fees ? (
            <div style={{ fontSize: 13, color: "var(--fg-3)", maxWidth: 620 }}>Sem entregas com entregador identificado no período.</div>
          ) : (
            <>
              {/* mini dashboard */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, alignItems: "stretch" }}>
                <FeesBox fees={fees} />
                <StatBox label="Entregas" value={totalDeliveries.toLocaleString("pt-BR")} hint="no período" />
                <StatBox label="Entregadores" value={ranking.length.toLocaleString("pt-BR")} hint="ativos no período" />
              </div>

              {ranking.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--fg-3)", maxWidth: 620 }}>Sem entregas com entregador identificado no período.</div>
              ) : (
                <div>
                  <div style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500, marginBottom: 8 }}>
                    Ranking de entregadores <span style={{ color: "var(--fg-3)", fontWeight: 400, fontSize: 11.5 }}>· todas as operações</span>
                  </div>
                  <div className="card">
                    <table className="table">
                      <thead>
                        <tr>
                          <th style={{ width: 44 }}>#</th>
                          <DmTh label="Entregador"  sortKey="name"       sort={dmSort} onSort={sortDm} />
                          <DmTh label="Entregas"    sortKey="deliveries" sort={dmSort} onSort={sortDm} width={100} align="right" />
                          <DmTh label="Canceladas"  sortKey="canceled"   sort={dmSort} onSort={sortDm} width={110} align="right" />
                          <DmTh label="Dias trab."  sortKey="daysWorked" sort={dmSort} onSort={sortDm} width={100} align="right" />
                          <DmTh label="Valor pago"  sortKey="paid"       sort={dmSort} onSort={sortDm} width={130} align="right" />
                          <DmTh label="Tempo médio" sortKey="avgDeliver" sort={dmSort} onSort={sortDm} width={130} align="right" />
                        </tr>
                      </thead>
                      <tbody>
                        {sortedRanking.map((d, i) => (
                          <tr key={d.name + i}>
                            <td style={{ fontFamily: "var(--mono)", color: "var(--fg-3)" }}>{i + 1}</td>
                            <td>{d.name}</td>
                            <td className="num" style={{ fontWeight: 600 }}>{_dNum(d.deliveries)}</td>
                            <td className="num" style={{ color: Number(d.canceled) > 0 ? "var(--warn)" : "var(--fg-3)" }}>{_dNum(d.canceled)}</td>
                            <td className="num">{_dNum(d.daysWorked)}</td>
                            <td className="num" style={{ fontWeight: 600 }}>{_brl(d.paid)}</td>
                            <td className="num">{_fmtDur(d.avgDeliver)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )
        )}

        {/* ----------------------------- BAIRROS --------------------------- */}
        {view === "bairros" && (
          hoods.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--fg-3)", maxWidth: 620 }}>
              Sem pedidos no período/filtro. Verifique se há operações com marcas atreladas
              em <b>Configurações → Agilizone</b> e se o ingest já rodou.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
                <BrKpi label="Bairros distintos" value={_dNum(hoods.length)} />
                <BrKpi label="Pedidos" value={_dNum(hoodOrders)} />
                <BrKpi label="Faturamento" value={_brl(hoodRevenue)} color="var(--accent-bright)" />
                <BrKpi label="Ticket médio" value={_brl(hoodTicket)} />
                <BrKpi label="% atrasadas" value={hoodLatePct == null ? "—" : _dPct(hoodLatePct)} color={hoodLatePct == null ? undefined : _lateColor(hoodLatePct * 100)} />
              </div>
              <div style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
                <b>% atrasadas</b> = entregas concluídas após o horário previsto pela plataforma (iFood).
              </div>
              <div className="card">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 44 }}>#</th>
                      <th>Bairro</th>
                      <th style={{ width: 90, textAlign: "right" }}>Pedidos</th>
                      <th style={{ width: 150 }}>% pedidos</th>
                      <th style={{ width: 140, textAlign: "right" }}>Faturamento</th>
                      <th style={{ width: 120, textAlign: "right" }}>Ticket médio</th>
                      <th style={{ width: 110, textAlign: "right" }}>Dist. média</th>
                      <th style={{ width: 100, textAlign: "right" }}>% atrasadas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hoods.map((r, i) => {
                      const share = hoodOrders > 0 ? (Number(r.orders) || 0) / hoodOrders : 0;
                      return (
                        <tr key={r.neighborhood + i}>
                          <td style={{ fontFamily: "var(--mono)", color: "var(--fg-3)" }}>{i + 1}</td>
                          <td className="row-strong">{r.neighborhood}</td>
                          <td className="num" style={{ fontWeight: 600 }}>{_dNum(r.orders)}</td>
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div style={{ flex: 1, minWidth: 50 }}><BrShareBar pct={share} /></div>
                              <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-2)", width: 44, textAlign: "right" }}>{_dPct(share)}</span>
                            </div>
                          </td>
                          <td className="num" style={{ fontWeight: 700 }}>{_brl(r.revenue)}</td>
                          <td className="num" style={{ fontWeight: 500 }}>{_brl(r.avg_ticket)}</td>
                          <td className="num" style={{ fontWeight: 500 }}>{_dDist(r.avg_distance)}</td>
                          <td className="num" style={{ fontWeight: 700, color: Number(r.measured) > 0 ? _lateColor(r.late_pct) : "var(--fg-3)" }}>
                            {Number(r.measured) > 0 ? _dPct((Number(r.late_pct) || 0) / 100) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )
        )}

        {/* ------------------------------ RAIOS ---------------------------- */}
        {view === "raios" && (
          <>
            <div style={{ fontSize: 12, color: "var(--fg-3)", maxWidth: 820 }}>
              Distância em linha reta do restaurante até o cliente. <b>Raio N km</b> agrupa pedidos
              de N-1 a N km. <b>Saldo</b> = taxa cobrada do cliente − taxa paga ao entregador.
              <b> % atrasadas</b> = entregas concluídas após o horário previsto pela plataforma (iFood).
            </div>
            {radii.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--fg-3)", maxWidth: 620 }}>
                Sem pedidos com distância no período/filtro.
              </div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
                  <BrKpi label="Pedidos" value={_dNum(radOrders)} />
                  <BrKpi label="Faturamento" value={_brl(radRevenue)} color="var(--accent-bright)" />
                  <BrKpi label="Alcance médio" value={_dDist(radAvgDist)} />
                  <BrKpi label="Raio com mais pedidos" value={radTop ? _raioLabel(Number(radTop.radius_km)) : "—"} />
                  <BrKpi label="Até 3 km" value={radOrders > 0 ? _dPct(radWithin3 / radOrders) : "—"} />
                  <BrKpi label="% atrasadas" value={radLatePct == null ? "—" : _dPct(radLatePct)} color={radLatePct == null ? undefined : _lateColor(radLatePct * 100)} />
                </div>
                <div className="card">
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 110 }}>Raio</th>
                        <th style={{ width: 90, textAlign: "right" }}>Pedidos</th>
                        <th style={{ width: 160 }}>% pedidos</th>
                        <th style={{ width: 140, textAlign: "right" }}>Faturamento</th>
                        <th style={{ width: 110, textAlign: "right" }}>Ticket médio</th>
                        <th style={{ width: 120, textAlign: "right" }}>Taxa cliente</th>
                        <th style={{ width: 130, textAlign: "right" }}>Taxa entregador</th>
                        <th style={{ width: 110, textAlign: "right" }}>Saldo</th>
                        <th style={{ width: 100, textAlign: "right" }}>% atrasadas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {radii.map((r) => {
                        const share = radOrders > 0 ? (Number(r.orders) || 0) / radOrders : 0;
                        const saldo = (Number(r.avg_delivery_fee) || 0) - (Number(r.avg_deliveryman_fee) || 0);
                        return (
                          <tr key={r.radius_km}>
                            <td className="row-strong" style={{ fontFamily: "var(--mono)" }}>{_raioLabel(Number(r.radius_km))}</td>
                            <td className="num" style={{ fontWeight: 600 }}>{_dNum(r.orders)}</td>
                            <td>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <div style={{ flex: 1, minWidth: 50 }}><BrShareBar pct={share} /></div>
                                <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-2)", width: 44, textAlign: "right" }}>{_dPct(share)}</span>
                              </div>
                            </td>
                            <td className="num" style={{ fontWeight: 700 }}>{_brl(r.revenue)}</td>
                            <td className="num" style={{ fontWeight: 500 }}>{_brl(r.avg_ticket)}</td>
                            <td className="num" style={{ fontWeight: 500 }}>{_brl(r.avg_delivery_fee)}</td>
                            <td className="num" style={{ fontWeight: 500 }}>{_brl(r.avg_deliveryman_fee)}</td>
                            <td className="num" style={{ fontWeight: 700, color: saldo >= 0 ? "var(--ok)" : "var(--crit)" }}>{_brl(saldo)}</td>
                            <td className="num" style={{ fontWeight: 700, color: Number(r.measured) > 0 ? _lateColor(r.late_pct) : "var(--fg-3)" }}>
                              {Number(r.measured) > 0 ? _dPct((Number(r.late_pct) || 0) / 100) : "—"}
                            </td>
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

        {/* ----------------------------- TURNOS ---------------------------- */}
        {view === "turnos" && (
          <DeliveryShiftsConfig tid={tid} shifts={shifts} onChanged={() => refreshShifts()} />
        )}

      </div>
    </div>
  );
}

window.DeliveryTimes = DeliveryTimes;
window.DeliveryFeesBox = FeesBox;
window.DeliveryDiscountsBox = DiscountsBox;
