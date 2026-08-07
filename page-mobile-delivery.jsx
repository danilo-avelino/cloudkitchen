// page-mobile-delivery.jsx — Logística no celular (≤480px). Tempos · Entregadores ·
// Bairros (Raios/Turnos ficam no desktop). Read-focused, alimentado pela integração
// Agilizone/Foody. Reaproveita os RPCs db* do desktop (page-delivery.jsx). Só online.

const _dvEffDay = (d) => new Date(d.getTime() - 8 * 3600e3).toISOString().slice(0, 10);
const _dvDur = (s) => { if (s == null) return "—"; const n = Math.round(Number(s)); const m = Math.floor(n / 60), sec = n % 60; return m === 0 ? `${sec}s` : `${m}m ${String(sec).padStart(2, "0")}s`; };
const _dvBRL = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const _dvNum = (v) => (Number(v) || 0).toLocaleString("pt-BR");
const _dvDist = (m) => { const n = Number(m) || 0; if (n <= 0) return "—"; return n >= 1000 ? (n / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " km" : Math.round(n) + " m"; };
const _dvWeekday = (day) => { try { const w = new Date(day + "T12:00:00Z").toLocaleDateString("pt-BR", { weekday: "short", timeZone: "UTC" }).replace(".", ""); return w.charAt(0).toUpperCase() + w.slice(1); } catch { return ""; } };
const _DV_PERIODS = [{ id: "7d", label: "7 dias", days: 7 }, { id: "30d", label: "30 dias", days: 30 }];

function MobileDelivery({ scope = "all" }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid] = useState(null);
  const [integ, setInteg] = useState(null);
  const [view, setView] = useState("tempos");
  const [period, setPeriod] = useState("7d");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ts, setTs] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [hoods, setHoods] = useState([]);
  const [range, setRange] = useState({ from: null, to: null });

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
      const { active } = await dbLogisticsIntegrationActive(t);
      if (!cancelled) setInteg(active);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  useEffect(() => {
    if (!tid || integ === false) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setBusy(true);
      const days = _DV_PERIODS.find((p) => p.id === period)?.days || 7;
      const to = _dvEffDay(new Date());
      const from = _dvEffDay(new Date(Date.now() - (days - 1) * 86400e3));
      setRange({ from, to });
      const op = scope === "all" ? null : scope;
      try {
        if (view === "tempos") {
          const { data } = await dbDeliveryTimeseries(tid, from, to, op, null, null);
          if (!cancelled) setTs(data || { byDay: [], summary: {} });
        } else if (view === "entregadores") {
          const [m, f] = await Promise.all([dbDeliveryMetrics(tid, from, to), dbDeliveryFees(tid, from, to)]);
          if (!cancelled) setMetrics({ ...(m.data || { byDeliveryman: [] }), fees: f.data?.total || null });
        } else if (view === "bairros") {
          const { data } = await dbNeighborhoodStats(tid, from, to, op);
          if (!cancelled) setHoods(data || []);
        }
      } catch (e) { if (!cancelled) window.showToast?.(e.message, { tone: "crit" }); }
      finally { if (!cancelled) { setBusy(false); setLoading(false); } }
    })();
    return () => { cancelled = true; };
  }, [tid, integ, view, period, scope]);

  if (loading || (dbStatus.isOnline && tid && integ === null)) return <PageLoading label="Carregando logística…" variant="cards" />;
  if (!dbStatus.isOnline || !tid) {
    return <MobilePage><div style={{ padding: 24 }}><div style={{ fontSize: 12.5, color: "var(--warn)", padding: "12px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 8 }}>Logística só fica disponível com Supabase online.</div></div></MobilePage>;
  }
  if (integ === false) {
    return <MobilePage><div style={{ padding: 24, textAlign: "center" }}>
      <I.AlertTriangle size={26} style={{ color: "var(--info)" }} />
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-0)", margin: "12px 0 8px" }}>Integração de logística não ativa</div>
      <div style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.6 }}>A Logística é alimentada pela Agilizone ou Foody Delivery. Configure no desktop (Configurações → Agilizone/Foody).</div>
    </div></MobilePage>;
  }

  const sm = ts?.summary || {};
  const byDayMap = {}; (ts?.byDay || []).forEach((d) => { byDayMap[d.day] = d; });
  const days = (range.from && range.to) ? _dvDaysRange(range.from, range.to) : [];
  const chartDays = days.map((day) => { const d = byDayMap[day] || {}; const p = Number(d.avgPrep) || 0, c = Number(d.avgCollect) || 0, e = Number(d.avgDeliver) || 0; return { day, p, c, e, total: p + c + e, orders: Number(d.orders) || 0 }; }).filter((d) => d.orders > 0).sort((a, b) => b.day.localeCompare(a.day));
  const ranking = (metrics?.byDeliveryman || []).slice().sort((a, b) => (Number(b.deliveries) || 0) - (Number(a.deliveries) || 0));
  const totalDeliveries = ranking.reduce((s, d) => s + (Number(d.deliveries) || 0), 0);
  const hoodOrders = hoods.reduce((s, r) => s + (Number(r.orders) || 0), 0);

  return (
    <MobilePage>
      <SegTabs value={view} onChange={setView} options={[{ id: "tempos", label: "Tempos" }, { id: "entregadores", label: "Entregadores" }, { id: "bairros", label: "Bairros" }]} />
      <div style={{ display: "flex", gap: 6, padding: "10px 14px 4px" }}>
        {_DV_PERIODS.map((p) => (
          <button key={p.id} onClick={() => setPeriod(p.id)} style={{ flex: 1, height: 36, borderRadius: 999, fontSize: 13, fontWeight: period === p.id ? 600 : 400, background: period === p.id ? "var(--accent-bright)" : "var(--bg-2)", color: period === p.id ? "var(--accent-fg, #07080a)" : "var(--fg-1)", border: `1px solid ${period === p.id ? "var(--accent-bright)" : "var(--line)"}` }}>{p.label}</button>
        ))}
      </div>

      {view === "tempos" && (
        <MobileScroll style={{ padding: "8px 14px 16px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
            <_DvTile label="Preparo" value={_dvDur(sm.avgPrep)} color="var(--accent-bright)" />
            <_DvTile label="Coleta" value={_dvDur(sm.avgCollect)} color="var(--info, var(--accent-bright))" />
            <_DvTile label="Entrega" value={_dvDur(sm.avgDeliver)} color="var(--warn)" />
            <_DvTile label="Total" value={_dvDur(sm.avgTotal)} sub={`${_dvNum(sm.orders)} pedidos`} />
          </div>
          <MSectionLabel>Por dia</MSectionLabel>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {chartDays.length === 0 ? <div style={{ textAlign: "center", padding: 24, color: "var(--fg-3)", fontSize: 13 }}>Sem dados no período.</div>
              : chartDays.map((d) => (
                <div key={d.day} style={{ padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={{ flex: 1, fontSize: 13.5, color: "var(--fg-0)", fontWeight: 500 }}>{d.day.slice(8, 10)}/{d.day.slice(5, 7)} <span style={{ color: "var(--fg-3)", fontWeight: 400, fontSize: 11.5 }}>{_dvWeekday(d.day)} · {d.orders} ped.</span></span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 15, fontWeight: 700, color: "var(--accent-bright)" }}>{_dvDur(d.total)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--fg-3)" }}>
                    <span>Prep {_dvDur(d.p)}</span><span>Coleta {_dvDur(d.c)}</span><span>Entrega {_dvDur(d.e)}</span>
                  </div>
                </div>
              ))}
          </div>
        </MobileScroll>
      )}

      {view === "entregadores" && (
        <MobileScroll style={{ padding: "8px 14px 16px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
            <_DvTile label="Entregas" value={_dvNum(totalDeliveries)} />
            <_DvTile label="Entregadores" value={_dvNum(ranking.length)} />
          </div>
          <MSectionLabel>Ranking</MSectionLabel>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {ranking.length === 0 ? <div style={{ textAlign: "center", padding: 24, color: "var(--fg-3)", fontSize: 13 }}>Sem entregador identificado no período.</div>
              : ranking.map((d, i) => (
                <div key={d.name + i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-4)", width: 18, textAlign: "right" }}>{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.name}</div>
                    <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2 }}>tempo {_dvDur(d.avgDeliver)} · {_dvBRL(d.paid)}</div>
                  </div>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 15, fontWeight: 700, color: "var(--fg-0)" }}>{_dvNum(d.deliveries)}</span>
                </div>
              ))}
          </div>
        </MobileScroll>
      )}

      {view === "bairros" && (
        <MobileScroll style={{ padding: "8px 14px 16px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
            <_DvTile label="Bairros" value={_dvNum(hoods.length)} />
            <_DvTile label="Pedidos" value={_dvNum(hoodOrders)} />
          </div>
          <MSectionLabel>Ranking de bairros</MSectionLabel>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {hoods.length === 0 ? <div style={{ textAlign: "center", padding: 24, color: "var(--fg-3)", fontSize: 13 }}>Sem pedidos no período.</div>
              : hoods.map((r, i) => {
                const share = hoodOrders > 0 ? (Number(r.orders) || 0) / hoodOrders * 100 : 0;
                return (
                  <div key={r.neighborhood + i} style={{ padding: "11px 12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-4)", width: 18, textAlign: "right" }}>{i + 1}</span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.neighborhood}</span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 14, fontWeight: 700, color: "var(--fg-0)" }}>{_dvNum(r.orders)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--fg-3)", marginTop: 6 }}>
                      <span>{share.toFixed(1)}% dos pedidos</span><span>{_dvBRL(r.revenue)}</span><span>{_dvDist(r.avg_distance)}</span>
                    </div>
                  </div>
                );
              })}
          </div>
        </MobileScroll>
      )}
    </MobilePage>
  );
}

function _dvDaysRange(from, to) {
  const out = []; let d = new Date(from + "T12:00:00Z"); const end = new Date(to + "T12:00:00Z");
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400e3); }
  return out;
}
function _DvTile({ label, value, sub, color }) {
  return (
    <div style={{ padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", minWidth: 0 }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4, color: color || "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

window.MobileDelivery = MobileDelivery;
