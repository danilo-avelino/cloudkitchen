// page-mobile-supply.jsx — Cadeia de suprimentos no celular (≤480px), lado MEMBRO da rede.
// Read-focused: código de suprimento, convites (aceitar/recusar), transferências e
// pedidos com status. Criar pedido / receber transferência (mexe em estoque) ficam
// no desktop. Reaproveita dbSupply* do desktop (page-supply.jsx). Só online.

const _spBRL = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _spDate = (iso) => { if (!iso) return "—"; const d = new Date(iso); return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`; };
const _SP_STATUS = { draft: { l: "Rascunho", t: "neutral" }, sent: { l: "Enviada", t: "warn" }, received: { l: "Recebida", t: "ok" }, cancelled: { l: "Cancelada", t: "crit" }, pending: { l: "Pendente", t: "warn" }, fulfilled: { l: "Atendido", t: "ok" }, rejected: { l: "Recusado", t: "crit" } };
const _spStatus = (s) => _SP_STATUS[s] || { l: s || "—", t: "neutral" };

function MobileSupply() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid] = useState(null);
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState(null);
  const [transfers, setTransfers] = useState([]);
  const [requests, setRequests] = useState([]);
  const [networkIdx, setNetworkIdx] = useState(0);
  const [view, setView] = useState("transfers");
  const [inviteBusy, setInviteBusy] = useState(false);

  const reload = async (t) => {
    const tenant = t || tid; if (!tenant) return;
    const [o, tr, rq] = await Promise.all([dbSupplyOverview(tenant), dbSupplyListTransfers(tenant), dbSupplyListRequests(tenant)]);
    setOverview(o?.data || null); setTransfers(tr?.data || []); setRequests(rq?.data || []);
  };

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const t = ctx?.tenant?.id || null; setTid(t);
      if (t) await reload(t);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  const respondInvite = async (inv, accept) => {
    if (inviteBusy) return; setInviteBusy(true);
    try { const { error } = await dbSupplyRespondInvite(inv.centralId, tid, accept); if (error) throw error; window.showToast?.(accept ? `Entrou na rede de ${inv.centralName}` : "Convite recusado", { tone: "ok" }); await reload(); }
    catch (e) { window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 }); }
    setInviteBusy(false);
  };

  if (loading) return <PageLoading label="Carregando suprimentos…" variant="table" />;
  if (!dbStatus.isOnline || !tid) {
    return <MobilePage><div style={{ padding: 24 }}><div style={{ fontSize: 12.5, color: "var(--warn)", padding: "12px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 8 }}>Cadeia de suprimentos só fica disponível com Supabase online.</div></div></MobilePage>;
  }

  const asMember = overview?.asMember || [];
  const invites = asMember.filter((n) => n.status === "invited");
  const networks = asMember.filter((n) => n.status === "active");
  const net = networks[Math.min(networkIdx, Math.max(networks.length - 1, 0))] || null;
  const supplyCode = overview?.tenant?.supplyCode || "—";
  const fmtCode = (c) => (c && c.length === 8 ? `${c.slice(0, 4)} ${c.slice(4)}` : c);

  const netTransfers = net ? transfers.filter((t) => t.centralId === net.centralId) : [];
  const netRequests = net ? requests.filter((r) => r.centralId === net.centralId) : [];
  const toReceive = netTransfers.filter((t) => t.toTenantId === tid && t.status === "sent").length;

  return (
    <MobilePage>
      <MobileScroll style={{ padding: "14px 14px 0" }}>
        <MSectionLabel>Meu código de suprimento</MSectionLabel>
        <div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 700, color: "var(--fg-0)", letterSpacing: "0.1em", margin: "6px 0 4px" }}>{fmtCode(supplyCode)}</div>
        <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginBottom: 12 }}>Compartilhe com uma central para entrar na rede dela.</div>

        {invites.map((inv) => (
          <div key={inv.centralId} style={{ padding: "12px 14px", borderRadius: 10, background: "var(--info-soft)", border: "1px solid var(--info-line)", marginBottom: 10 }}>
            <div style={{ fontSize: 12.5, color: "var(--fg-0)", marginBottom: 10 }}>A central <strong>{inv.centralName}</strong> convidou você para a rede dela.</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => respondInvite(inv, false)} disabled={inviteBusy} style={{ flex: 1, height: 44, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14, fontWeight: 600 }}>Recusar</button>
              <div style={{ flex: 1 }}><MPrimaryButton onClick={() => respondInvite(inv, true)} loading={inviteBusy}>Aceitar</MPrimaryButton></div>
            </div>
          </div>
        ))}

        {!net ? (
          invites.length === 0 && <div style={{ textAlign: "center", padding: "32px 12px", color: "var(--fg-3)", fontSize: 13 }}>Você ainda não faz parte de nenhuma rede de suprimentos.</div>
        ) : (
          <>
            {networks.length > 1 && (
              <select value={networkIdx} onChange={(e) => setNetworkIdx(Number(e.target.value))} style={{ ...mInput, height: 40, marginBottom: 10 }}>
                {networks.map((n, i) => <option key={n.centralId} value={i}>Central: {n.centralName}</option>)}
              </select>
            )}
            <div style={{ fontSize: 12, color: "var(--fg-3)", marginBottom: 10 }}>Central: <strong style={{ color: "var(--fg-1)" }}>{net.centralName}</strong></div>
          </>
        )}
      </MobileScroll>

      {net && (
        <>
          <SegTabs value={view} onChange={setView} options={[
            { id: "transfers", label: "Transferências", count: toReceive || null, tone: "warn" },
            { id: "requests", label: "Pedidos", count: netRequests.length || null },
            { id: "divergences", label: "Divergências" },
          ]} />
          <MobileScroll style={{ padding: "12px 14px" }}>
            {view === "transfers" && (
              netTransfers.length === 0 ? <_SpEmpty>Sem transferências.</_SpEmpty> :
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {netTransfers.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((t) => <SupTransferCard key={t.id} t={t} incoming={t.toTenantId === tid} />)}
                </div>
            )}
            {view === "requests" && (
              netRequests.length === 0 ? <_SpEmpty>Nenhum pedido.</_SpEmpty> :
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {netRequests.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((r) => <SupRequestCard key={r.id} r={r} />)}
                </div>
            )}
            {view === "divergences" && (
              <MobileSupplyDivergences tid={tid} scopeCentralId={net.centralId} />
            )}
          </MobileScroll>
        </>
      )}
    </MobilePage>
  );
}

function SupTransferCard({ t, incoming }) {
  const m = _spStatus(t.status);
  const total = t.totalValue != null ? t.totalValue : t.estValue;
  return (
    <div style={{ padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: `1px solid ${incoming && t.status === "sent" ? "var(--warn-line)" : "var(--line)"}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-0)", fontWeight: 600 }}>{t.code}</span>
        <span style={{ flex: 1 }} />
        <MBadge tone={m.t}>{m.l}</MBadge>
      </div>
      <div style={{ fontSize: 12, color: "var(--fg-3)" }}>{t.fromName || "—"} → {t.toName || "—"} · {(t.items || []).length} itens</div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11.5 }}>
        <span style={{ color: "var(--fg-3)" }}>{_spDate(t.createdAt)}</span>
        <span style={{ fontFamily: "var(--mono)", color: "var(--fg-0)", fontWeight: 600 }}>{t.status === "draft" ? "—" : _spBRL(total)}</span>
      </div>
      {incoming && t.status === "sent" && <div style={{ fontSize: 11, color: "var(--warn)", marginTop: 6 }}>Aguardando seu recebimento — confirme no desktop.</div>}
    </div>
  );
}

function SupRequestCard({ r }) {
  const m = _spStatus(r.status);
  return (
    <div style={{ padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-0)", fontWeight: 600 }}>{r.code || "Pedido"}</span>
        <span style={{ flex: 1 }} />
        <MBadge tone={m.t}>{m.l}</MBadge>
      </div>
      <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 4 }}>{(r.items || []).length} itens · {_spDate(r.createdAt)}</div>
    </div>
  );
}

function _SpEmpty({ children }) { return <div style={{ textAlign: "center", padding: "32px 12px", color: "var(--fg-3)", fontSize: 13 }}>{children}</div>; }

// ---------------------------------------------------------------------------
// Divergências de recebimento (compartilhada com a Central no celular).
// Read-only: relatar divergência é no desktop, na confirmação do recebimento.
// ---------------------------------------------------------------------------
function MobileSupplyDivergences({ tid, scopeCentralId = null }) {
  const [data, setData] = useState(null);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await dbSupplyDivergences(tid);
      if (!cancelled) setData(res?.data || { lines: [], receipts: [] });
    })();
    return () => { cancelled = true; };
  }, [tid]);

  if (data === null) return <_SpEmpty>Carregando divergências…</_SpEmpty>;

  const inScope = (r) => !scopeCentralId || r.centralId === scopeCentralId;
  const monthOf = (iso) => (iso ? String(iso).slice(0, 7) : "");
  const monthLabel = (key) => {
    const [y, m] = key.split("-");
    return new Date(Number(y), Number(m) - 1, 1)
      .toLocaleDateString("pt-BR", { month: "short", year: "numeric" }).replace(".", "");
  };

  const allReceipts = data.receipts.filter(inScope);
  const months = Array.from(new Set(allReceipts.map((r) => monthOf(r.receivedAt)).filter(Boolean)));
  const nowKey = monthOf(new Date().toISOString());
  if (!months.includes(nowKey)) months.push(nowKey);
  months.sort().reverse();

  const inPeriod = (r) => month === "all" || monthOf(r.receivedAt) === month;
  const receipts = allReceipts.filter(inPeriod);
  const lines = data.lines.filter((l) => inScope(l) && inPeriod(l))
    .sort((a, b) => Math.abs(b.deltaValue) - Math.abs(a.deltaValue));

  const sentValue = receipts.reduce((s, r) => s + r.sentValue, 0);
  const missing = lines.filter((l) => l.deltaQty < 0).reduce((s, l) => s + l.deltaValue, 0);
  const surplus = lines.filter((l) => l.deltaQty > 0).reduce((s, l) => s + l.deltaValue, 0);
  const netValue = missing + surplus;
  const pct = sentValue > 0 ? (Math.abs(netValue) / sentValue) * 100 : 0;

  return (
    <div>
      <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ ...mInput, height: 40, marginBottom: 12 }}>
        <option value="all">Todos os períodos</option>
        {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
      </select>

      <div style={{ margin: "0 -14px" }}>
        <StatStrip stats={[
          { label: "% divergência", value: `${pct.toFixed(2).replace(".", ",")}%`, tone: pct >= 3 ? "crit" : pct >= 1 ? "warn" : "ok" },
          { label: "Impacto", value: _spBRL(netValue), tone: netValue < 0 ? "crit" : netValue > 0 ? "warn" : "ok" },
          { label: "Faltas", value: _spBRL(missing), tone: missing < 0 ? "crit" : "ok" },
          { label: "Sobras", value: _spBRL(surplus), tone: surplus > 0 ? "warn" : "ok" },
          { label: "Itens", value: String(lines.length), sub: `${receipts.length} recebimentos` },
          { label: "Enviado", value: _spBRL(sentValue) },
        ]} />
      </div>

      {lines.length === 0 ? (
        <_SpEmpty>
          {receipts.length === 0
            ? `Nenhum recebimento ${month === "all" ? "na rede" : `em ${monthLabel(month)}`}.`
            : "Nenhuma divergência no período."}
        </_SpEmpty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
          {lines.map((l) => (
            <div key={l.id} style={{
              padding: "12px", borderRadius: 10, background: "var(--bg-2)",
              border: `1px solid ${l.deltaQty < 0 ? "var(--crit-line)" : "var(--warn-line)"}`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)", fontWeight: 500 }}>{l.name}</span>
                <MBadge tone={l.deltaQty < 0 ? "crit" : "warn"}>{l.deltaQty < 0 ? "Falta" : "Sobra"}</MBadge>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 4 }}>
                {l.fromName || "—"} → {l.toName || "—"} · {l.code} · {_spDate(l.receivedAt)}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 12, fontFamily: "var(--mono)" }}>
                <span style={{ color: "var(--fg-2)" }}>
                  {l.sentQty.toLocaleString("pt-BR")} → {l.receivedQty.toLocaleString("pt-BR")} {l.unit}
                </span>
                <span style={{ color: l.deltaValue < 0 ? "var(--crit)" : "var(--warn)", fontWeight: 600 }}>{_spBRL(l.deltaValue)}</span>
              </div>
              {(l.reason || l.notes) && (
                <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 5 }}>
                  {_supReasonLabel(l.reason)}{l.notes ? ` · ${l.notes}` : ""}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

window.MobileSupply = MobileSupply;
window.MobileSupplyDivergences = MobileSupplyDivergences;
