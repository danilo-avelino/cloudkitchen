// page-mobile-cardapio.jsx — Análise de Cardápio no celular (≤480px). Itens
// (ranking de vendas) + Adicionais (por grupo). Alimentado pela integração
// Agilizone. Reaproveita dbMenuSales/dbMenuAddons do desktop (page-cardapio.jsx).
// Só online. Curva ABC / tendência / combos ficam no desktop.

const _cdEffDay = (d) => new Date(d.getTime() - 8 * 3600e3).toISOString().slice(0, 10);
const _cdBRL = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const _cdBRLk = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
const _cdNum = (v) => (Number(v) || 0).toLocaleString("pt-BR");
const _CD_PERIODS = [{ id: "7d", label: "7 dias", days: 7 }, { id: "30d", label: "30 dias", days: 30 }];

function MobileCardapio({ scope = "all" }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid] = useState(null);
  const [integ, setInteg] = useState(null);
  const [view, setView] = useState("itens");
  const [period, setPeriod] = useState("7d");
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [addons, setAddons] = useState([]);
  const [openGroups, setOpenGroups] = useState(() => new Set());

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
      const { active } = await dbAgilizoneIntegrationActive(t);
      if (!cancelled) setInteg(active);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  useEffect(() => {
    if (!tid || integ === false) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const days = _CD_PERIODS.find((p) => p.id === period)?.days || 7;
      const to = _cdEffDay(new Date());
      const from = _cdEffDay(new Date(Date.now() - (days - 1) * 86400e3));
      const op = scope === "all" ? null : scope;
      try {
        if (view === "itens") { const { data } = await dbMenuSales(tid, from, to, op); if (!cancelled) setItems(data || []); }
        else { const { data } = await dbMenuAddons(tid, from, to, op); if (!cancelled) setAddons(data || []); }
      } catch (e) { if (!cancelled) window.showToast?.(e.message, { tone: "crit" }); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [tid, integ, view, period, scope]);

  const addonGroups = useMemo(() => {
    const map = new Map();
    for (const a of addons) {
      const key = a.group_name || "—";
      let g = map.get(key); if (!g) { g = { name: key, items: [], qty: 0, revenue: 0 }; map.set(key, g); }
      g.items.push(a); g.qty += Number(a.qty) || 0; g.revenue += Number(a.revenue) || 0;
    }
    const groups = Array.from(map.values());
    groups.forEach((g) => g.items.sort((x, y) => (Number(y.qty) || 0) - (Number(x.qty) || 0)));
    groups.sort((a, b) => b.qty - a.qty);
    return groups;
  }, [addons]);

  if (loading || (dbStatus.isOnline && tid && integ === null)) return <PageLoading label="Carregando cardápio…" variant="cards" />;
  if (!dbStatus.isOnline || !tid) {
    return <MobilePage><div style={{ padding: 24 }}><div style={{ fontSize: 12.5, color: "var(--warn)", padding: "12px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 8 }}>Análise de Cardápio só fica disponível com Supabase online.</div></div></MobilePage>;
  }
  if (integ === false) {
    return <MobilePage><div style={{ padding: 24, textAlign: "center" }}>
      <I.AlertTriangle size={26} style={{ color: "var(--info)" }} />
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-0)", margin: "12px 0 8px" }}>Integração Agilizone não ativa</div>
      <div style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.6 }}>A Análise de Cardápio é alimentada pela Agilizone. Configure no desktop (Configurações → Agilizone).</div>
    </div></MobilePage>;
  }

  const sorted = items.slice().sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0));
  const totalRev = sorted.reduce((s, r) => s + (Number(r.total) || 0), 0);
  const totalQty = sorted.reduce((s, r) => s + (Number(r.qty) || 0), 0);

  return (
    <MobilePage>
      <SegTabs value={view} onChange={setView} options={[{ id: "itens", label: "Itens" }, { id: "adicionais", label: "Adicionais" }]} />
      <div style={{ display: "flex", gap: 6, padding: "10px 14px 4px" }}>
        {_CD_PERIODS.map((p) => (
          <button key={p.id} onClick={() => setPeriod(p.id)} style={{ flex: 1, height: 36, borderRadius: 999, fontSize: 13, fontWeight: period === p.id ? 600 : 400, background: period === p.id ? "var(--accent-bright)" : "var(--bg-2)", color: period === p.id ? "var(--accent-fg, #07080a)" : "var(--fg-1)", border: `1px solid ${period === p.id ? "var(--accent-bright)" : "var(--line)"}` }}>{p.label}</button>
        ))}
      </div>

      {view === "itens" ? (
        <MobileScroll style={{ padding: "8px 14px 16px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
            <_CdTile label="Faturamento" value={_cdBRLk(totalRev)} />
            <_CdTile label="Vendas" value={_cdNum(totalQty)} />
            <_CdTile label="Itens" value={_cdNum(sorted.length)} />
          </div>
          <MSectionLabel>Mais vendidos</MSectionLabel>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {sorted.length === 0 ? <div style={{ textAlign: "center", padding: 24, color: "var(--fg-3)", fontSize: 13 }}>Sem vendas no período.</div>
              : sorted.map((r, i) => (
                <div key={(r.external_code || r.name) + i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-4)", width: 18, textAlign: "right" }}>{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
                    <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2 }}>{_cdNum(r.qty)} vendas · {_cdBRL(r.avg_price)}/un</div>
                  </div>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 13.5, fontWeight: 700, color: "var(--fg-0)" }}>{_cdBRL(r.total)}</span>
                </div>
              ))}
          </div>
        </MobileScroll>
      ) : (
        <MobileScroll style={{ padding: "12px 14px 16px" }}>
          <MSectionLabel>Adicionais por grupo</MSectionLabel>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {addonGroups.length === 0 ? <div style={{ textAlign: "center", padding: 24, color: "var(--fg-3)", fontSize: 13 }}>Sem adicionais no período.</div>
              : addonGroups.map((g) => {
                const open = openGroups.has(g.name);
                return (
                  <div key={g.name} style={{ borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", overflow: "hidden" }}>
                    <button onClick={() => setOpenGroups((cur) => { const n = new Set(cur); n.has(g.name) ? n.delete(g.name) : n.add(g.name); return n; })} style={{ width: "100%", padding: "11px 12px", background: "transparent", border: "none", display: "flex", alignItems: "center", gap: 10, textAlign: "left" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</div>
                        <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2 }}>{g.items.length} opções · {_cdBRL(g.revenue)}</div>
                      </div>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 14, fontWeight: 700, color: "var(--fg-0)" }}>{_cdNum(g.qty)}</span>
                      <I.Chevron size={14} style={{ color: "var(--fg-3)", transform: open ? "rotate(180deg)" : "none", flexShrink: 0 }} />
                    </button>
                    {open && (
                      <div style={{ padding: "0 12px 8px" }}>
                        {g.items.map((a, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: "1px solid var(--line-soft)" }}>
                            <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "var(--fg-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</span>
                            <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-1)" }}>{_cdNum(a.qty)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </MobileScroll>
      )}
    </MobilePage>
  );
}

function _CdTile({ label, value }) {
  return (
    <div style={{ padding: "10px 8px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", textAlign: "center", minWidth: 0 }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-3)", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, marginTop: 3, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
    </div>
  );
}

window.MobileCardapio = MobileCardapio;
