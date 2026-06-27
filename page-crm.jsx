// CRM — módulo de relacionamento/atendimento WhatsApp (port do wacrm, Fase A).
// Sub-abas:
//   • Conversas (Inbox)  → "em breve": depende da integração WhatsApp (Fase 1 + conta Meta)
//   • Contatos           → CRUD real (crm_contacts)
//   • Funil (Pipeline)   → real (crm_pipelines/crm_stages/crm_deals); kanban simples
//   • Campanhas (Broadcasts) → "em breve": depende de templates aprovados na Meta
//
// Dados via helpers dbCrm* em lib-supabase.jsx. RLS: leitura por membro do
// tenant, escrita por can_access_module(tenant,'crm').

function _crmBrl(v) {
  if (v == null || v === "") return "—";
  return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
// "8,50" / "R$ 1.234,50" → número (reusa o padrão pt-BR do app)
function _crmParseBR(v) {
  if (v == null) return null;
  const s = String(v).replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const _CRM_VIEWS = [
  { id: "inbox",      label: "Conversas",  soon: true  },
  { id: "contacts",   label: "Contatos",   soon: false },
  { id: "pipeline",   label: "Funil",      soon: false },
  { id: "broadcasts", label: "Campanhas",  soon: true  },
];

// ----------------------------- placeholder "em breve" -----------------------
function CrmSoon({ title, lines }) {
  return (
    <div style={{ padding: "32px 28px" }}>
      <div style={{ maxWidth: 560, margin: "8px auto 0", textAlign: "center", padding: "32px 28px", background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 10 }}>
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 46, height: 46, borderRadius: 12, marginBottom: 14, background: "var(--info-soft)", border: "1px solid var(--info-line)", color: "var(--info)" }}>
          <I.WhatsApp size={22} />
        </span>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: "0 0 10px", color: "var(--fg-0)" }}>
          {title} <span style={{ fontSize: 11, fontWeight: 600, color: "var(--info)", background: "var(--info-soft)", border: "1px solid var(--info-line)", borderRadius: 999, padding: "2px 8px", marginLeft: 6, verticalAlign: "middle" }}>em breve</span>
        </h2>
        {lines.map((l, i) => (
          <p key={i} style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.6, margin: i === 0 ? "0 0 8px" : 0 }}>{l}</p>
        ))}
      </div>
    </div>
  );
}

// ----------------------------- modal de contato -----------------------------
function CrmContactModal({ initial, onClose, onSave }) {
  const [name, setName]       = useState(initial?.name || "");
  const [phone, setPhone]     = useState(initial?.phone || "");
  const [email, setEmail]     = useState(initial?.email || "");
  const [company, setCompany] = useState(initial?.company || "");
  const [notes, setNotes]     = useState(initial?.notes || "");
  const [saving, setSaving]   = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!name.trim()) { window.showToast?.("Informe o nome do contato.", { tone: "warn" }); return; }
    setSaving(true);
    try {
      await onSave({ name: name.trim(), phone: phone.trim(), email: email.trim(), company: company.trim(), notes: notes.trim() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={initial ? "Editar contato" : "Novo contato"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" data-variant="ghost" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn" data-variant="primary" onClick={submit} disabled={saving}>
            {saving ? "Salvando…" : "Salvar"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--fg-2)" }}>Nome *</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--fg-2)" }}>Telefone (WhatsApp)</span>
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+55 85 9 9999-9999" />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--fg-2)" }}>E-mail</span>
          <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--fg-2)" }}>Empresa</span>
          <input className="input" value={company} onChange={(e) => setCompany(e.target.value)} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--fg-2)" }}>Observações</span>
          <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ resize: "vertical" }} />
        </label>
      </div>
    </Modal>
  );
}

// ----------------------------- modal de negociação --------------------------
function CrmDealModal({ contacts, stages, onClose, onSave }) {
  const [title, setTitle]         = useState("");
  const [contactId, setContactId] = useState(contacts[0]?.id || "");
  const [value, setValue]         = useState("");
  const [stageId, setStageId]     = useState(stages[0]?.id || "");
  const [saving, setSaving]       = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!title.trim()) { window.showToast?.("Informe o título da negociação.", { tone: "warn" }); return; }
    if (!contactId) { window.showToast?.("Cadastre um contato primeiro.", { tone: "warn" }); return; }
    setSaving(true);
    try {
      await onSave({ title: title.trim(), contactId, stageId, value: _crmParseBR(value) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Nova negociação"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" data-variant="ghost" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn" data-variant="primary" onClick={submit} disabled={saving}>
            {saving ? "Salvando…" : "Salvar"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--fg-2)" }}>Título *</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--fg-2)" }}>Contato</span>
          <select className="input" value={contactId} onChange={(e) => setContactId(e.target.value)}>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--fg-2)" }}>Etapa</span>
          <select className="input" value={stageId} onChange={(e) => setStageId(e.target.value)}>
            {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--fg-2)" }}>Valor (R$)</span>
          <input className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0,00" inputMode="decimal" />
        </label>
      </div>
    </Modal>
  );
}

// ----------------------------- aba Contatos ---------------------------------
function CrmContacts({ tid }) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ]             = useState("");
  const [modal, setModal]     = useState(null);   // null | "new" | contact obj
  const [confirm, setConfirm] = useState(null);   // contact a excluir
  const [busy, setBusy]       = useState(false);

  const load = async () => {
    const { data } = await dbCrmListContacts(tid);
    setRows(data || []);
    setLoading(false);
  };
  useEffect(() => { if (tid) load(); }, [tid]);

  const save = async (payload) => {
    const isEdit = modal && modal !== "new";
    const { error } = isEdit
      ? await dbCrmUpdateContact(modal.id, payload)
      : await dbCrmInsertContact(tid, payload);
    if (error) { window.showToast?.(error.message, { tone: "crit" }); return; }
    window.showToast?.(isEdit ? "Contato atualizado." : "Contato criado.", { tone: "ok" });
    setModal(null);
    await load();
  };

  const remove = async () => {
    if (busy || !confirm) return;
    setBusy(true);
    const { error } = await dbCrmDeleteContact(confirm.id);
    setBusy(false);
    if (error) { window.showToast?.(error.message, { tone: "crit" }); return; }
    window.showToast?.("Contato excluído.", { tone: "ok" });
    setConfirm(null);
    await load();
  };

  if (loading) return <PageLoading label="Carregando contatos…" variant="table" hint="" />;

  const filtered = q.trim()
    ? rows.filter((r) => `${r.name} ${r.phone || ""} ${r.email || ""} ${r.company || ""}`.toLowerCase().includes(q.trim().toLowerCase()))
    : rows;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <input className="input" style={{ width: 260 }} placeholder="Buscar contato…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span style={{ fontSize: 12, color: "var(--fg-3)" }}>{filtered.length} de {rows.length}</span>
        <button className="btn" data-variant="primary" data-size="sm" style={{ marginLeft: "auto" }} onClick={() => setModal("new")}>
          <I.Plus size={13} /> Novo contato
        </button>
      </div>

      {filtered.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--fg-3)", padding: "20px 0" }}>
          {rows.length === 0 ? "Nenhum contato ainda. Crie o primeiro." : "Nenhum contato corresponde à busca."}
        </div>
      ) : (
        <div className="card"><div className="card-body" style={{ padding: 0 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--fg-3)", fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                <th style={{ padding: "10px 14px" }}>Nome</th>
                <th style={{ padding: "10px 14px" }}>Telefone</th>
                <th style={{ padding: "10px 14px" }}>E-mail</th>
                <th style={{ padding: "10px 14px" }}>Empresa</th>
                <th style={{ padding: "10px 14px", width: 84 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} style={{ borderTop: "1px solid var(--line)" }}>
                  <td style={{ padding: "10px 14px", color: "var(--fg-0)" }}>{c.name}</td>
                  <td style={{ padding: "10px 14px", color: "var(--fg-1)", fontFamily: "var(--mono)" }}>{c.phone || "—"}</td>
                  <td style={{ padding: "10px 14px", color: "var(--fg-1)" }}>{c.email || "—"}</td>
                  <td style={{ padding: "10px 14px", color: "var(--fg-1)" }}>{c.company || "—"}</td>
                  <td style={{ padding: "10px 14px" }}>
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <button className="btn" data-variant="ghost" data-size="sm" title="Editar" onClick={() => setModal(c)}><I.Edit size={13} /></button>
                      <button className="btn" data-variant="ghost" data-size="sm" title="Excluir" onClick={() => setConfirm(c)}><I.Trash size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      )}

      {modal && (
        <CrmContactModal
          initial={modal === "new" ? null : modal}
          onClose={() => setModal(null)}
          onSave={save}
        />
      )}
      <ConfirmDialog
        open={!!confirm}
        title="Excluir contato"
        message={confirm ? `Excluir "${confirm.name}"? Conversas e negociações vinculadas também serão removidas.` : ""}
        confirmLabel="Excluir"
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

// ----------------------------- aba Funil (kanban) ---------------------------
function CrmPipeline({ tid }) {
  const [pipeline, setPipeline] = useState(null);
  const [stages, setStages]     = useState([]);
  const [deals, setDeals]       = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [confirm, setConfirm]   = useState(null);
  const [busy, setBusy]         = useState(false);

  const load = async () => {
    const { data, error } = await dbCrmGetOrCreateDefaultPipeline(tid);
    if (error || !data) { setLoading(false); window.showToast?.(error?.message || "Falha ao carregar funil", { tone: "crit" }); return; }
    setPipeline(data.pipeline);
    setStages(data.stages);
    const [dRes, cRes] = await Promise.all([
      dbCrmListDeals(tid, data.pipeline.id),
      dbCrmListContacts(tid),
    ]);
    setDeals(dRes.data || []);
    setContacts(cRes.data || []);
    setLoading(false);
  };
  useEffect(() => { if (tid) load(); }, [tid]);

  const contactName = (id) => contacts.find((c) => c.id === id)?.name || "—";

  const addDeal = async (payload) => {
    const { error } = await dbCrmInsertDeal(tid, { ...payload, pipelineId: pipeline.id });
    if (error) { window.showToast?.(error.message, { tone: "crit" }); return; }
    window.showToast?.("Negociação criada.", { tone: "ok" });
    setShowModal(false);
    await load();
  };

  const moveDeal = async (deal, stageId) => {
    if (stageId === deal.stage_id) return;
    const { error } = await dbCrmUpdateDeal(deal.id, { stage_id: stageId });
    if (error) { window.showToast?.(error.message, { tone: "crit" }); return; }
    setDeals((cur) => cur.map((d) => (d.id === deal.id ? { ...d, stage_id: stageId } : d)));
  };

  const remove = async () => {
    if (busy || !confirm) return;
    setBusy(true);
    const { error } = await dbCrmDeleteDeal(confirm.id);
    setBusy(false);
    if (error) { window.showToast?.(error.message, { tone: "crit" }); return; }
    setConfirm(null);
    setDeals((cur) => cur.filter((d) => d.id !== confirm.id));
  };

  if (loading) return <PageLoading label="Carregando funil…" variant="cards" hint="" />;

  const total = deals.reduce((s, d) => s + (Number(d.value) || 0), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, color: "var(--fg-2)" }}>
          {deals.length} negociações · <b style={{ color: "var(--fg-0)" }}>{_crmBrl(total)}</b> em aberto
        </span>
        <button className="btn" data-variant="primary" data-size="sm" style={{ marginLeft: "auto" }}
                onClick={() => setShowModal(true)} disabled={contacts.length === 0}
                title={contacts.length === 0 ? "Cadastre um contato primeiro" : undefined}>
          <I.Plus size={13} /> Nova negociação
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 8, alignItems: "flex-start" }}>
        {stages.map((st) => {
          const col = deals.filter((d) => d.stage_id === st.id);
          const colTotal = col.reduce((s, d) => s + (Number(d.value) || 0), 0);
          return (
            <div key={st.id} style={{ flex: "0 0 260px", background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 8 }}>
              <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--fg-0)" }}>{st.name}</span>
                <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{col.length} · {_crmBrl(colTotal)}</span>
              </div>
              <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8, minHeight: 60 }}>
                {col.length === 0 && <div style={{ fontSize: 12, color: "var(--fg-3)", textAlign: "center", padding: "12px 0" }}>—</div>}
                {col.map((d) => (
                  <div key={d.id} style={{ background: "var(--bg-0)", border: "1px solid var(--line)", borderRadius: 6, padding: "10px 10px 8px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                      <span style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }}>{d.title}</span>
                      <button className="btn" data-variant="ghost" data-size="sm" title="Excluir" onClick={() => setConfirm(d)}><I.Trash size={12} /></button>
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 2 }}>{contactName(d.contact_id)}</div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 6 }}>
                      <span style={{ fontSize: 12.5, color: "var(--accent-bright)", fontWeight: 600 }}>{_crmBrl(d.value)}</span>
                      <select className="input" data-size="sm" style={{ fontSize: 11, padding: "2px 4px", maxWidth: 110 }}
                              value={d.stage_id} onChange={(e) => moveDeal(d, e.target.value)} title="Mover etapa">
                        {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {showModal && (
        <CrmDealModal contacts={contacts} stages={stages} onClose={() => setShowModal(false)} onSave={addDeal} />
      )}
      <ConfirmDialog
        open={!!confirm}
        title="Excluir negociação"
        message={confirm ? `Excluir "${confirm.title}"?` : ""}
        confirmLabel="Excluir"
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

// ----------------------------- componente raiz ------------------------------
function CRM({ scope }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid]   = useState(null);
  const [view, setView] = useState("contacts");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      setTid(ctx?.tenant?.id || null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  if (loading) return <PageLoading label="Carregando CRM…" variant="cards" hint="" />;

  if (!dbStatus.isOnline || !tid) {
    return (
      <div style={{ padding: "24px 28px" }}>
        <div style={{ fontSize: 12.5, color: "var(--warn)", padding: "10px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 4 }}>
          O CRM só fica disponível com Supabase online.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "20px 28px 0" }}>
        <div className="h-eyebrow" style={{ marginBottom: 6 }}>Relacionamento · WhatsApp</div>
        <h1 className="h-title">CRM</h1>

        <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--line)", marginTop: 14 }}>
          {_CRM_VIEWS.map((v) => (
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
              {v.soon && <span style={{ fontSize: 9.5, fontWeight: 600, color: "var(--info)", background: "var(--info-soft)", border: "1px solid var(--info-line)", borderRadius: 999, padding: "1px 6px" }}>em breve</span>}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 32px" }}>
        {view === "contacts"   && <CrmContacts tid={tid} />}
        {view === "pipeline"   && <CrmPipeline tid={tid} />}
        {view === "inbox" && (
          <CrmSoon
            title="Conversas"
            lines={[
              "O inbox compartilhado de WhatsApp depende da integração com a Meta Cloud API.",
              "Será ativado na Fase 1 (edge functions de webhook/envio), após o provisionamento da conta WhatsApp Business.",
            ]}
          />
        )}
        {view === "broadcasts" && (
          <CrmSoon
            title="Campanhas"
            lines={[
              "Disparos em massa usam templates aprovados pela Meta.",
              "Ficará disponível junto com a integração WhatsApp (Fase 1).",
            ]}
          />
        )}
      </div>
    </div>
  );
}

window.CRM = CRM;
