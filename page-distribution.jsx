// Central de Distribuição · módulo 'distribution' (só tenant kind='distribution_center')
// Rede (convites por código), transferências de saída, solicitações recebidas
// e painel de Gastos por tenant. Reusa os componentes de page-supply.jsx.
// Spec: PRD-PRODUCAO-E-DISTRIBUICAO.md §6.

const _distFmtBRL = (v) =>
  "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const _distParseNum = (raw) => {
  if (raw == null) return 0;
  const s = String(raw).trim().replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

const _distTh = { fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "left", padding: "8px 10px", borderBottom: "1px solid var(--line)" };
const _distTd = { fontSize: 12.5, color: "var(--fg-1)", padding: "9px 10px", borderBottom: "1px solid var(--line-soft)", verticalAlign: "top" };

// Ajuste manual de gastos de um tenant (acertos / pagamentos à central)
function DistLedgerAdjustModal({ centralId, member, onClose, onSaved }) {
  const [mode, setMode] = useState("decrease"); // decrease = abate gasto (pagamento)
  const [value, setValue] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const valueN = _distParseNum(value);
  const canSave = valueN > 0;

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    try {
      const delta = mode === "decrease" ? -valueN : valueN;
      const { error } = await dbSupplyLedgerAdjust(centralId, member.tenantId, delta, notes || null);
      if (error) throw error;
      window.showToast?.("Ajuste lançado", { tone: "ok" });
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Ajuste de gastos · ${member.name}`}
      subtitle={`Saldo atual: ${_distFmtBRL(member.balance)}. O extrato é imutável — corrigir = novo ajuste.`}
      width={440}
      onClose={saving ? undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={save} disabled={saving || !canSave}>
            {saving ? "Carregando…" : "Lançar ajuste"}
          </button>
        </>
      )}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <FormRow label="Tipo de ajuste">
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="decrease">Abater gasto (ex.: pagamento recebido)</option>
            <option value="increase">Aumentar gasto (ex.: cobrança extra)</option>
          </select>
        </FormRow>
        <FormRow label="Valor (R$)">
          <input className="input" value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder="0,00" autoFocus />
        </FormRow>
        <FormRow label="Observação">
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder='Ex.: "PIX 12/07"' />
        </FormRow>
      </div>
    </Modal>
  );
}

const _DIST_VIEWS = [
  { id: "network",   label: "Rede" },
  { id: "transfers", label: "Transferências" },
  { id: "requests",  label: "Solicitações" },
  { id: "ledger",    label: "Gastos" },
];

function CentralDistribuicao({ scope }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid] = useState(null);
  const [kind, setKind] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("network");
  const [overview, setOverview] = useState(null);
  const [stockItems, setStockItems] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [requests, setRequests] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [inviteCode, setInviteCode] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [transferForm, setTransferForm] = useState(null); // { prefillRequest }
  const [adjustFor, setAdjustFor] = useState(null);
  const [removeFor, setRemoveFor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ledgerFilter, setLedgerFilter] = useState("all");

  const reload = async (tenantId) => {
    const t = tenantId || tid;
    if (!t) return;
    const [oRes, sRes, tRes, rRes, lRes] = await Promise.all([
      dbSupplyOverview(t),
      dbListStockItems(t),
      dbSupplyListTransfers(t),
      dbSupplyListRequests(t),
      dbSupplyListLedger(t, { centralId: t }),
    ]);
    setOverview(oRes?.data || null);
    setStockItems(sRes?.data || []);
    setTransfers(tRes?.data || []);
    setRequests(rRes?.data || []);
    setLedger(lRes?.data || []);
  };

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const t = ctx?.tenant?.id || null;
      setTid(t);
      setKind(ctx?.tenant?.kind || "standard");
      if (t) await reload(t);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  if (loading) return <PageLoading label="Carregando central…" variant="table" />;

  if (!dbStatus.isOnline || !tid) {
    return (
      <div style={{ padding: "24px 28px" }}>
        <div style={{ fontSize: 12.5, color: "var(--warn)", padding: "10px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 4 }}>
          O módulo Central só fica disponível com Supabase online.
        </div>
      </div>
    );
  }

  if (kind !== "distribution_center") {
    return (
      <div style={{ padding: "24px 28px" }}>
        <div style={{ fontSize: 12.5, color: "var(--fg-2)", padding: "14px 16px", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4, lineHeight: 1.6 }}>
          Este módulo é exclusivo de tenants do tipo <strong>Central de Distribuição</strong>.
          Para transformar esta conta em central, fale com o suporte da plataforma.
        </div>
      </div>
    );
  }

  const members = (overview?.asCentral || []);
  const activeMembers = members.filter((m) => m.status === "active");
  const invitedMembers = members.filter((m) => m.status === "invited");
  const nameByTenant = {};
  members.forEach((m) => { nameByTenant[m.tenantId] = m.name; });
  const fmtCode = (c) => (c && c.length === 8 ? `${c.slice(0, 4)} ${c.slice(4)}` : c || "—");

  const pendingRequests = requests.filter((r) => r.supplierTenantId === tid && r.status === "pending");

  const invite = async () => {
    if (inviteBusy || !inviteCode.trim()) return;
    setInviteBusy(true);
    try {
      const { data: found, error: lookErr } = await dbSupplyLookupByCode(tid, inviteCode);
      if (lookErr) throw lookErr;
      if (!found) throw new Error("Nenhum tenant encontrado com esse código");
      const { error } = await dbSupplyInvite(tid, inviteCode);
      if (error) throw error;
      window.showToast?.(`Convite enviado para ${found.tenant_name}`, { tone: "ok" });
      setInviteCode("");
      await reload();
    } catch (e) {
      window.showToast?.(`${e.message || e}`, { tone: "crit", ttl: 6000 });
    }
    setInviteBusy(false);
  };

  const removeMember = async () => {
    if (busy || !removeFor) return;
    setBusy(true);
    try {
      const { error } = await dbSupplyRemoveMember(tid, removeFor.tenantId);
      if (error) throw error;
      window.showToast?.(`${removeFor.name} removido da rede`, { tone: "ok" });
      setRemoveFor(null);
      await reload();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
    }
    setBusy(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "20px 28px 0" }}>
        <div className="h-eyebrow" style={{ marginBottom: 6 }}>Rede de suprimentos</div>
        <h1 className="h-title">Central de Distribuição</h1>
        <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--line)", marginTop: 14 }}>
          {_DIST_VIEWS.map((v) => (
            <button key={v.id} onClick={() => setView(v.id)}
              style={{
                background: "none", border: "none", cursor: "pointer",
                padding: "8px 14px", fontSize: 13, marginBottom: -1,
                color: view === v.id ? "var(--fg-0)" : "var(--fg-3)",
                fontWeight: view === v.id ? 600 : 400,
                borderBottom: view === v.id ? "2px solid var(--accent-bright)" : "2px solid transparent",
                display: "inline-flex", alignItems: "center", gap: 6,
              }}>
              {v.label}
              {v.id === "requests" && pendingRequests.length > 0 && (
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "1px 6px", background: "var(--accent-bright)", color: "var(--accent-fg)", borderRadius: 8, fontWeight: 500 }}>{pendingRequests.length}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 32px" }}>
        {view === "network" && (
          <div>
            <div style={{
              display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 18,
              padding: "14px 16px", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 6,
            }}>
              <FormRow label="Convidar tenant pelo código" hint="O código aparece em Configurações (e no módulo Suprimentos) de cada tenant.">
                <input className="input mono" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="0000 0000" style={{ width: 180, letterSpacing: "0.1em" }}
                  onKeyDown={(e) => { if (e.key === "Enter") invite(); }} />
              </FormRow>
              <button className="btn" data-variant="primary" data-size="sm" onClick={invite}
                disabled={inviteBusy || !inviteCode.trim()} style={{ marginBottom: 4 }}>
                {inviteBusy ? "Carregando…" : "Convidar"}
              </button>
            </div>

            {members.length === 0 ? (
              <div style={{ padding: "40px 20px", textAlign: "center", border: "1px dashed var(--line)", borderRadius: 6 }}>
                <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 6 }}>Nenhum tenant na rede ainda.</div>
                <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
                  Peça o código de 8 dígitos de cada cozinha (Configurações → Conta) e convide acima.
                </div>
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={_distTh}>Tenant</th>
                    <th style={_distTh}>Código</th>
                    <th style={_distTh}>Status</th>
                    <th style={{ ..._distTh, textAlign: "right" }}>Gasto acumulado</th>
                    <th style={_distTh}>Na rede desde</th>
                    <th style={{ ..._distTh, width: 60 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.tenantId}>
                      <td style={{ ..._distTd, color: "var(--fg-0)" }}>{m.name}</td>
                      <td style={{ ..._distTd, fontFamily: "var(--mono)" }}>{fmtCode(m.code)}</td>
                      <td style={_distTd}>
                        {m.status === "active"
                          ? <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ok)", background: "var(--ok-soft)", border: "1px solid var(--ok-line)", borderRadius: 999, padding: "2px 8px" }}>Ativo</span>
                          : <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--warn)", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 999, padding: "2px 8px" }}>Convidado</span>}
                      </td>
                      <td style={{ ..._distTd, textAlign: "right", fontFamily: "var(--mono)" }}>{_distFmtBRL(m.balance)}</td>
                      <td style={_distTd}>{m.respondedAt ? new Date(m.respondedAt).toLocaleDateString("pt-BR") : "—"}</td>
                      <td style={{ ..._distTd, textAlign: "right" }}>
                        <button className="btn" data-variant="ghost" data-size="sm" title="Remover da rede"
                          onClick={() => setRemoveFor(m)}><I.Trash size={12} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {invitedMembers.length > 0 && (
              <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 10 }}>
                Convites pendentes aparecem para o tenant no módulo Suprimentos, onde ele aceita ou recusa.
              </div>
            )}
          </div>
        )}

        {view === "transfers" && (
          <div>
            <div style={{ display: "flex", marginBottom: 14 }}>
              <button className="btn" data-variant="primary" data-size="sm" style={{ marginLeft: "auto" }}
                disabled={activeMembers.length === 0}
                onClick={() => setTransferForm({ prefillRequest: null })}>
                <I.Plus size={12} /> Nova transferência
              </button>
            </div>
            <SupplyTransferList
              tid={tid}
              transfers={transfers}
              myItems={stockItems}
              onChanged={() => reload()}
              emptyHint={activeMembers.length === 0
                ? "Convide tenants na aba Rede para começar a transferir."
                : "Nenhuma transferência na rede ainda."}
            />
          </div>
        )}

        {view === "requests" && (
          <SupplyRequestList
            tid={tid}
            requests={requests.filter((r) => r.supplierTenantId === tid)}
            onChanged={() => reload()}
            onFulfill={(r) => setTransferForm({ prefillRequest: r })}
            emptyHint="Nenhuma solicitação recebida dos tenants."
          />
        )}

        {view === "ledger" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 18 }}>
              <SummaryStat label="Gasto total da rede" value={_distFmtBRL(activeMembers.reduce((s, m) => s + (m.balance || 0), 0))} />
              <SummaryStat label="Tenants ativos" value={String(activeMembers.length)} />
              <SummaryStat label="Lançamentos" value={String(ledger.length)} />
            </div>

            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 22 }}>
              <thead>
                <tr>
                  <th style={_distTh}>Tenant</th>
                  <th style={{ ..._distTh, textAlign: "right" }}>Gasto acumulado</th>
                  <th style={{ ..._distTh, width: 120 }}></th>
                </tr>
              </thead>
              <tbody>
                {activeMembers.map((m) => (
                  <tr key={m.tenantId}>
                    <td style={{ ..._distTd, color: "var(--fg-0)" }}>{m.name}</td>
                    <td style={{ ..._distTd, textAlign: "right", fontFamily: "var(--mono)" }}>{_distFmtBRL(m.balance)}</td>
                    <td style={{ ..._distTd, textAlign: "right" }}>
                      <button className="btn" data-size="sm" onClick={() => setAdjustFor(m)}>Ajuste</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>Extrato</div>
              <select className="select" style={{ width: "auto", marginLeft: "auto" }} value={ledgerFilter}
                onChange={(e) => setLedgerFilter(e.target.value)}>
                <option value="all">Todos os tenants</option>
                {activeMembers.map((m) => <option key={m.tenantId} value={m.tenantId}>{m.name}</option>)}
              </select>
            </div>
            <SupplyLedgerTable
              entries={ledgerFilter === "all" ? ledger : ledger.filter((e) => e.tenantId === ledgerFilter)}
              nameByTenant={nameByTenant}
              showTenant
            />
          </div>
        )}
      </div>

      {transferForm && (
        <SupplyTransferForm
          tid={tid} centralId={tid}
          toOptions={transferForm.prefillRequest
            ? [{ id: transferForm.prefillRequest.requesterTenantId, name: transferForm.prefillRequest.requesterName }]
            : activeMembers.map((m) => ({ id: m.tenantId, name: m.name }))}
          stockItems={stockItems}
          prefillRequest={transferForm.prefillRequest}
          onClose={() => setTransferForm(null)}
          onSaved={async () => { setTransferForm(null); await reload(); }}
        />
      )}

      {adjustFor && (
        <DistLedgerAdjustModal
          centralId={tid} member={adjustFor}
          onClose={() => setAdjustFor(null)}
          onSaved={async () => { setAdjustFor(null); await reload(); }}
        />
      )}

      <ConfirmDialog
        open={!!removeFor}
        title="Remover da rede"
        message={removeFor ? `Remover ${removeFor.name} da rede? O histórico de transferências e gastos é preservado; o tenant pode ser convidado de novo depois.` : ""}
        confirmLabel="Remover"
        busy={busy}
        onConfirm={removeMember}
        onCancel={() => setRemoveFor(null)}
      />
    </div>
  );
}

window.CentralDistribuicao = CentralDistribuicao;
