// page-mobile-distribution.jsx — Central de Distribuição no celular (≤480px), lado
// CENTRAL. Read-focused: unidades da rede (com saúde do estoque), reposição
// sugerida, transferências e pedidos com status. Cadastrar item no catálogo e
// ajustar mín/máx ficam no desktop — aqui dá pra gerar os rascunhos de reposição
// (não mexem no estoque). Exclusivo de tenants kind='distribution_center'.

const _ctBRL = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _ctDate = (iso) => { if (!iso) return "—"; const d = new Date(iso); return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`; };
const _CT_STATUS = { draft: { l: "Rascunho", t: "neutral" }, sent: { l: "Enviada", t: "warn" }, received: { l: "Recebida", t: "ok" }, cancelled: { l: "Cancelada", t: "crit" }, pending: { l: "Pendente", t: "warn" }, fulfilled: { l: "Atendido", t: "ok" }, rejected: { l: "Recusado", t: "crit" } };
const _ctStatus = (s) => _CT_STATUS[s] || { l: s || "—", t: "neutral" };

function MobileDistribution() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid] = useState(null);
  const [kind, setKind] = useState(null);
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState(null);
  const [transfers, setTransfers] = useState([]);
  const [requests, setRequests] = useState([]);
  const [units, setUnits] = useState([]);
  const [replenish, setReplenish] = useState([]);
  const [openUnit, setOpenUnit] = useState(null);
  const [view, setView] = useState("units");

  const load = async (t) => {
    const [o, tr, rq, un, rp] = await Promise.all([
      dbSupplyOverview(t), dbSupplyListTransfers(t), dbSupplyListRequests(t),
      dbSupplyUnitsSummary(t), dbSupplyReplenishment(t),
    ]);
    setOverview(o?.data || null); setTransfers(tr?.data || []); setRequests(rq?.data || []);
    setUnits(un?.data || []); setReplenish(rp?.data || []);
  };

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const t = ctx?.tenant?.id || null;
      setTid(t); setKind(ctx?.tenant?.kind || "standard");
      if (t && !cancelled) await load(t);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  if (loading) return <PageLoading label="Carregando central…" variant="table" />;
  if (!dbStatus.isOnline || !tid) {
    return <MobilePage><div style={{ padding: 24 }}><div style={{ fontSize: 12.5, color: "var(--warn)", padding: "12px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 8 }}>Central só fica disponível com Supabase online.</div></div></MobilePage>;
  }
  if (kind !== "distribution_center") {
    return <MobilePage><div style={{ padding: 24 }}><div style={{ fontSize: 12.5, color: "var(--fg-2)", padding: "14px 16px", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 8, lineHeight: 1.6 }}>Este módulo é exclusivo de tenants do tipo <strong>Central de Distribuição</strong>.</div></div></MobilePage>;
  }

  const members = overview?.asCentral || [];
  const activeMembers = members.filter((m) => m.status === "active");
  const invitedMembers = members.filter((m) => m.status === "invited");
  const nameByTenant = {}; members.forEach((m) => { nameByTenant[m.tenantId] = m.name; });
  const pendingRequests = requests.filter((r) => r.supplierTenantId === tid && r.status === "pending").length;
  const unitById = {}; units.forEach((u) => { unitById[u.tenantId] = u; });

  if (openUnit) {
    return <_CtUnitSheet centralId={tid} unit={openUnit} onBack={() => setOpenUnit(null)} />;
  }

  return (
    <MobilePage>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, padding: "12px 14px" }}>
        <_CtTile label="Unidades" value={String(activeMembers.length)} />
        <_CtTile label="A repor" value={String(replenish.length)} color={replenish.length > 0 ? "var(--warn)" : "var(--ok)"} />
        <_CtTile label="Pedidos pend." value={String(pendingRequests)} color={pendingRequests > 0 ? "var(--warn)" : "var(--fg-0)"} />
      </div>

      <SegTabs value={view} onChange={setView} options={[
        { id: "units", label: "Unidades", count: members.length },
        { id: "replenish", label: "Repor", count: replenish.length || null, tone: "warn" },
        { id: "transfers", label: "Transferências" },
        { id: "requests", label: "Pedidos", count: pendingRequests || null, tone: "warn" },
        { id: "divergences", label: "Divergências" },
      ]} />

      <MobileScroll style={{ padding: "12px 14px" }}>
        {view === "units" && (
          members.length === 0 ? <_CtEmpty>Nenhuma unidade na rede. Convide pelo desktop.</_CtEmpty> :
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {members.map((m) => {
                const u = unitById[m.tenantId];
                const mm = m.status === "active" ? { l: "Ativo", t: "ok" } : m.status === "invited" ? { l: "Convidado", t: "warn" } : { l: m.status, t: "neutral" };
                const tone = !u ? mm.t : u.out > 0 ? "crit" : u.below > 0 ? "warn" : "ok";
                const label = !u ? mm.l : u.items === 0 ? "Sem catálogo" : u.out > 0 ? "Ruptura" : u.below > 0 ? "Repor" : "Saudável";
                return (
                  <button key={m.tenantId} type="button"
                    onClick={() => u && setOpenUnit(u)}
                    style={{ textAlign: "left", padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 9 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <I.Truck size={16} style={{ color: "var(--fg-2)", flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.name}</span>
                      <MBadge tone={tone}>{label}</MBadge>
                    </div>
                    {u && u.items > 0 && (
                      <>
                        <UnitHealthBar ok={u.ok} below={u.below} out={u.out} />
                        <div style={{ display: "flex", gap: 10, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>
                          <span><b style={{ color: "var(--crit)" }}>{u.out}</b> ruptura</span>
                          <span><b style={{ color: "var(--warn)" }}>{u.below}</b> repor</span>
                          <span><b style={{ color: "var(--ok)" }}>{u.ok}</b> ok</span>
                          <span style={{ marginLeft: "auto" }}>
                            {u.coverageDays != null ? `${Math.round(u.coverageDays)} d de cobertura` : "sem consumo"}
                          </span>
                        </div>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
        )}

        {view === "replenish" && (
          <_CtReplenish centralId={tid} rows={replenish} onGenerated={async () => { await load(tid); setView("transfers"); }} />
        )}

        {view === "transfers" && (
          transfers.length === 0 ? <_CtEmpty>Nenhuma transferência.</_CtEmpty> :
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {transfers.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((t) => {
                const m = _ctStatus(t.status); const total = t.totalValue != null ? t.totalValue : t.estValue;
                return (
                  <div key={t.id} style={{ padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-0)", fontWeight: 600 }}>{t.code}</span>
                      <span style={{ flex: 1 }} /><MBadge tone={m.t}>{m.l}</MBadge>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--fg-3)" }}>{t.toName || nameByTenant[t.toTenantId] || "—"} · {(t.items || []).length} itens</div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11.5 }}>
                      <span style={{ color: "var(--fg-3)" }}>{_ctDate(t.createdAt)}</span>
                      <span style={{ fontFamily: "var(--mono)", color: "var(--fg-0)", fontWeight: 600 }}>{t.status === "draft" ? "—" : _ctBRL(total)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
        )}

        {view === "requests" && (
          requests.length === 0 ? <_CtEmpty>Nenhum pedido dos membros.</_CtEmpty> :
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {requests.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((r) => {
                const m = _ctStatus(r.status);
                return (
                  <div key={r.id} style={{ padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: `1px solid ${r.status === "pending" ? "var(--warn-line)" : "var(--line)"}` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{nameByTenant[r.requesterTenantId] || r.code || "Pedido"}</span>
                      <MBadge tone={m.t}>{m.l}</MBadge>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 4 }}>{(r.items || []).length} itens · {_ctDate(r.createdAt)}{r.status === "pending" ? " · atenda no desktop" : ""}</div>
                  </div>
                );
              })}
            </div>
        )}

        {view === "divergences" && (
          <MobileSupplyDivergences tid={tid} scopeCentralId={tid} />
        )}
      </MobileScroll>
    </MobilePage>
  );
}

function _CtTile({ label, value, color }) {
  return (
    <div style={{ padding: "10px 8px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", textAlign: "center", minWidth: 0 }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-3)", textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, marginTop: 3, color: color || "var(--fg-0)" }}>{value}</div>
    </div>
  );
}
function _CtEmpty({ children }) { return <div style={{ textAlign: "center", padding: "32px 12px", color: "var(--fg-3)", fontSize: 13 }}>{children}</div>; }

// Catálogo de uma unidade em tela cheia — leitura. O cadastro/ajuste de mín/máx
// fica no desktop (mexe no estoque de outro tenant).
function _CtUnitSheet({ centralId, unit, onBack }) {
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState("repor");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await dbSupplyUnitAssortment(centralId, unit.tenantId);
      if (cancelled) return;
      if (error) { window.showToast?.(`Erro: ${error.message || error}`, { tone: "crit" }); setRows([]); return; }
      setRows(data || []);
    })();
    return () => { cancelled = true; };
  }, [unit.tenantId]);

  const all = rows || [];
  const shown = filter === "repor"
    ? all.filter((r) => r.reorder > 0 && r.qty < r.reorder)
    : all;

  return (
    <FullSheet
      title={unit.name}
      subtitle={rows === null ? "carregando…" : `${all.length} itens no catálogo · ${unit.coverageDays != null ? `${Math.round(unit.coverageDays)} d de cobertura` : "sem consumo"}`}
      onBack={onBack}
    >
      <SegTabs value={filter} onChange={setFilter} options={[
        { id: "repor", label: "Abaixo do mín.", count: all.filter((r) => r.reorder > 0 && r.qty < r.reorder).length || null, tone: "warn" },
        { id: "all", label: "Todos", count: all.length || null },
      ]} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
        {rows === null && <_CtEmpty>Carregando catálogo…</_CtEmpty>}
        {rows !== null && shown.length === 0 && (
          <_CtEmpty>{filter === "repor" ? "Nenhum item abaixo do mínimo. ✨" : "Nenhum item no catálogo — cadastre pelo desktop."}</_CtEmpty>
        )}
        {shown.map((r) => (
          <div key={r.unitItemId} style={{ padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-3)" }}>
                {r.autoMinMode === "off" ? "manual" : r.autoMinMode === "weekly" ? "auto semanal" : "auto mensal"}
              </span>
            </div>
            <SupplyLevelBar qty={r.qty} reorder={r.reorder} max={r.max} inTransit={r.inTransit} unit={r.unit} />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7, fontSize: 11, color: "var(--fg-3)" }}>
              <span>{r.usage30d > 0 ? `${(r.usage30d / 30).toFixed(2)} ${r.unit}/dia` : "sem consumo 30d"}</span>
              <span style={{ color: r.centralQty <= 0 ? "var(--crit)" : "var(--fg-3)" }}>
                central: {r.centralQty.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} {r.unit}
              </span>
            </div>
          </div>
        ))}
      </div>
    </FullSheet>
  );
}

// Reposição sugerida: mesma regra da lista de compras, agrupada por unidade.
// Gera rascunhos (nada sai do estoque até o envio, feito no desktop).
function _CtReplenish({ centralId, rows, onGenerated }) {
  const [busy, setBusy] = useState(false);

  const byUnit = useMemo(() => {
    const g = {};
    (rows || []).forEach((l) => {
      if (!g[l.tenantId]) g[l.tenantId] = { tenantId: l.tenantId, name: l.tenantName, items: [] };
      g[l.tenantId].items.push(l);
    });
    return Object.values(g).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const total = (rows || []).reduce((s, l) => s + l.suggested * l.centralCost, 0);
  const short = (rows || []).filter((l) => l.suggested > l.centralQty).length;

  const generate = async () => {
    if (busy || byUnit.length === 0) return;
    setBusy(true);
    let created = 0;
    try {
      for (const g of byUnit) {
        const { error } = await dbSupplyCreateTransfer({
          centralId, fromTenantId: centralId, toTenantId: g.tenantId,
          notes: "Reposição automática · cadeia de suprimentos",
          items: g.items.map((l) => ({ fromItemId: l.centralItemId, name: l.name, qty: l.suggested, unit: l.unit })),
        });
        if (error) throw error;
        created += 1;
      }
      window.showToast?.(`${created} rascunho(s) criado(s) — envie pelo desktop`, { tone: "ok", ttl: 6000 });
      await onGenerated();
    } catch (e) {
      window.showToast?.(`Erro (${created} criada(s)): ${e.message || e}`, { tone: "crit", ttl: 7000 });
    }
    setBusy(false);
  };

  if (!rows || rows.length === 0) {
    return <_CtEmpty>Todas as unidades estão acima do mínimo (ou já têm reposição a caminho). ✨</_CtEmpty>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--fg-2)" }}>
          <span>{byUnit.length} unidade(s) · {rows.length} item(ns)</span>
          <span style={{ fontFamily: "var(--mono)", color: "var(--fg-0)", fontWeight: 600 }}>{_ctBRL(total)}</span>
        </div>
        {short > 0 && (
          <div style={{ fontSize: 11.5, color: "var(--crit)", marginTop: 6 }}>
            {short} item(ns) passam do saldo da central — ajuste no desktop antes de enviar.
          </div>
        )}
        <div style={{ marginTop: 10 }}>
          <MPrimaryButton onClick={generate} loading={busy}>
            Gerar {byUnit.length} rascunho(s)
          </MPrimaryButton>
        </div>
      </div>

      {byUnit.map((g) => (
        <div key={g.tenantId} style={{ padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
          <div style={{ fontSize: 13.5, color: "var(--fg-0)", fontWeight: 600, marginBottom: 8 }}>{g.name}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {g.items.map((l) => (
              <div key={l.unitItemId} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                <span style={{ flex: 1, minWidth: 0, color: "var(--fg-1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {l.name}
                  <span style={{ color: "var(--fg-3)", fontSize: 11 }}> · tem {l.qty.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}, mín {l.reorder.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}</span>
                </span>
                <span style={{ fontFamily: "var(--mono)", fontWeight: 600, color: l.suggested > l.centralQty ? "var(--crit)" : "var(--accent-bright)" }}>
                  +{l.suggested.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} {l.unit}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

window.MobileDistribution = MobileDistribution;
