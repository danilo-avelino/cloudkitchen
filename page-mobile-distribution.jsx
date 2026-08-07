// page-mobile-distribution.jsx — Central de Distribuição no celular (≤480px), lado
// CENTRAL. Read-focused: membros da rede, transferências e pedidos com status.
// Criar transferência / ajustar ledger (mexe em estoque/financeiro) ficam no
// desktop. Exclusivo de tenants kind='distribution_center'. Só online.

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
  const [view, setView] = useState("members");

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const t = ctx?.tenant?.id || null;
      setTid(t); setKind(ctx?.tenant?.kind || "standard");
      if (t) {
        const [o, tr, rq] = await Promise.all([dbSupplyOverview(t), dbSupplyListTransfers(t), dbSupplyListRequests(t)]);
        if (!cancelled) { setOverview(o?.data || null); setTransfers(tr?.data || []); setRequests(rq?.data || []); }
      }
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

  return (
    <MobilePage>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, padding: "12px 14px" }}>
        <_CtTile label="Membros" value={String(activeMembers.length)} />
        <_CtTile label="Pedidos pend." value={String(pendingRequests)} color={pendingRequests > 0 ? "var(--warn)" : "var(--fg-0)"} />
        <_CtTile label="Transferências" value={String(transfers.length)} />
      </div>

      <SegTabs value={view} onChange={setView} options={[
        { id: "members", label: "Membros", count: members.length },
        { id: "transfers", label: "Transferências" },
        { id: "requests", label: "Pedidos", count: pendingRequests || null, tone: "warn" },
      ]} />

      <MobileScroll style={{ padding: "12px 14px" }}>
        {view === "members" && (
          members.length === 0 ? <_CtEmpty>Nenhum membro na rede. Convide pelo desktop.</_CtEmpty> :
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {members.map((m) => {
                const mm = m.status === "active" ? { l: "Ativo", t: "ok" } : m.status === "invited" ? { l: "Convidado", t: "warn" } : { l: m.status, t: "neutral" };
                return (
                  <div key={m.tenantId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
                    <I.Truck size={16} style={{ color: "var(--fg-2)", flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.name}</span>
                    <MBadge tone={mm.t}>{mm.l}</MBadge>
                  </div>
                );
              })}
            </div>
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

window.MobileDistribution = MobileDistribution;
