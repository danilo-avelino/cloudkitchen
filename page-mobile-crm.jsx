// page-mobile-crm.jsx — CRM no celular (≤480px). Contatos (CRUD) + Negócios
// (funil, read + mover etapa) + Conversas/Campanhas ("em breve", como no desktop).
// Reaproveita os helpers dbCrm* do desktop (page-crm.jsx). Só online.

const _crBRL = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _crParse = (raw) => { const n = parseFloat(String(raw ?? "").replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };

function MobileCRM() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid] = useState(null);
  const [view, setView] = useState("contacts");
  const [loading, setLoading] = useState(true);
  const [contacts, setContacts] = useState([]);
  const [pipeline, setPipeline] = useState(null);
  const [stages, setStages] = useState([]);
  const [deals, setDeals] = useState([]);
  const [editContact, setEditContact] = useState(null); // { initial } | { create }
  const [addDeal, setAddDeal] = useState(false);

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const t = ctx?.tenant?.id || null; setTid(t);
      if (!t) { setLoading(false); return; }
      const cRes = await dbCrmListContacts(t);
      if (!cancelled) { setContacts(cRes.data || []); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  // Carrega funil ao abrir a aba Negócios
  useEffect(() => {
    if (view !== "pipeline" || !tid || pipeline) return;
    let cancelled = false;
    (async () => {
      const { data } = await dbCrmGetOrCreateDefaultPipeline(tid);
      if (cancelled || !data) return;
      setPipeline(data.pipeline); setStages(data.stages || []);
      const [dRes, cRes] = await Promise.all([dbCrmListDeals(tid, data.pipeline.id), dbCrmListContacts(tid)]);
      if (cancelled) return;
      setDeals(dRes.data || []); if (cRes.data) setContacts(cRes.data);
    })();
    return () => { cancelled = true; };
  }, [view, tid, pipeline]);

  const reloadContacts = async () => { const r = await dbCrmListContacts(tid); if (r.data) setContacts(r.data); };
  const saveContact = async (payload, id) => {
    const { error } = id ? await dbCrmUpdateContact(id, payload) : await dbCrmInsertContact(tid, payload);
    if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; }
    await reloadContacts(); window.showToast?.(id ? "Contato atualizado" : "Contato criado", { tone: "ok" }); return true;
  };
  const deleteContact = async (id) => { const { error } = await dbCrmDeleteContact(id); if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit" }); return; } await reloadContacts(); window.showToast?.("Contato excluído", { tone: "warn" }); };
  const createDeal = async (payload) => { const { error } = await dbCrmInsertDeal(tid, { ...payload, pipelineId: pipeline.id }); if (error) { window.showToast?.(error.message, { tone: "crit" }); return false; } const r = await dbCrmListDeals(tid, pipeline.id); if (r.data) setDeals(r.data); window.showToast?.("Negociação criada", { tone: "ok" }); return true; };
  const moveDeal = async (deal, stageId) => { if (stageId === deal.stage_id) return; setDeals((cur) => cur.map((d) => d.id === deal.id ? { ...d, stage_id: stageId } : d)); const { error } = await dbCrmUpdateDeal(deal.id, { stage_id: stageId }); if (error) window.showToast?.(error.message, { tone: "crit" }); };

  if (loading) return <PageLoading label="Carregando CRM…" variant="cards" />;
  if (!dbStatus.isOnline || !tid) {
    return <MobilePage><div style={{ padding: 24 }}><div style={{ fontSize: 12.5, color: "var(--warn)", padding: "12px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 8 }}>O CRM só fica disponível com Supabase online.</div></div></MobilePage>;
  }

  const contactName = (id) => contacts.find((c) => c.id === id)?.name || "—";

  return (
    <MobilePage>
      <SegTabs value={view} onChange={setView} options={[
        { id: "contacts", label: "Contatos", count: contacts.length },
        { id: "pipeline", label: "Negócios" },
        { id: "inbox", label: "Conversas" },
        { id: "broadcasts", label: "Campanhas" },
      ]} />

      {view === "contacts" && (
        <>
          <MobileScroll style={{ padding: "12px 14px" }}>
            {contacts.length === 0 ? <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13 }}>Nenhum contato.</div>
              : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {contacts.map((c) => (
                  <MobileCard key={c.id} onClick={() => setEditContact({ initial: c })}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14.5, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</div>
                        <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 2 }}>{c.phone || c.email || c.company || "—"}</div>
                      </div>
                      {c.phone && <a href={`https://wa.me/${String(c.phone).replace(/\D/g, "")}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ width: 36, height: 36, borderRadius: 8, background: "var(--bg-3)", display: "grid", placeItems: "center", color: "#25d366", flexShrink: 0 }}><I.WhatsApp size={16} /></a>}
                    </div>
                  </MobileCard>
                ))}
              </div>}
          </MobileScroll>
          <MobileBottomBar><MPrimaryButton onClick={() => setEditContact({ create: true })}><I.Plus size={16} />Novo contato</MPrimaryButton></MobileBottomBar>
        </>
      )}

      {view === "pipeline" && (
        <>
          <MobileScroll style={{ padding: "12px 14px" }}>
            {stages.length === 0 ? <div style={{ textAlign: "center", padding: 32, color: "var(--fg-3)", fontSize: 13 }}>Carregando funil…</div>
              : stages.map((st) => {
                const stDeals = deals.filter((d) => d.stage_id === st.id);
                const total = stDeals.reduce((s, d) => s + (Number(d.value) || 0), 0);
                return (
                  <div key={st.id} style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <MSectionLabel>{st.name}</MSectionLabel>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-4)" }}>{stDeals.length} · {_crBRL(total)}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {stDeals.length === 0 ? <div style={{ fontSize: 12, color: "var(--fg-4)", padding: "4px 2px" }}>—</div>
                        : stDeals.map((d) => (
                          <div key={d.id} style={{ padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                              <span style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 500, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.title}</span>
                              <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700, color: "var(--fg-0)" }}>{_crBRL(d.value)}</span>
                            </div>
                            <div style={{ fontSize: 11.5, color: "var(--fg-3)", margin: "4px 0 8px" }}>{contactName(d.contact_id)}</div>
                            <select value={d.stage_id} onChange={(e) => moveDeal(d, e.target.value)} style={{ ...mInput, height: 38 }}>
                              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                          </div>
                        ))}
                    </div>
                  </div>
                );
              })}
          </MobileScroll>
          {stages.length > 0 && <MobileBottomBar><MPrimaryButton onClick={() => setAddDeal(true)}><I.Plus size={16} />Nova negociação</MPrimaryButton></MobileBottomBar>}
        </>
      )}

      {(view === "inbox" || view === "broadcasts") && (
        <MobileScroll style={{ padding: "24px 16px" }}>
          <div style={{ textAlign: "center", padding: "32px 12px" }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--info)", background: "var(--info-soft)", border: "1px solid var(--info-line)", borderRadius: 999, padding: "3px 10px" }}>em breve</span>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-0)", margin: "14px 0 8px" }}>{view === "inbox" ? "Conversas" : "Campanhas"}</div>
            <div style={{ fontSize: 13, color: "var(--fg-2)", lineHeight: 1.6 }}>
              {view === "inbox" ? "O inbox de WhatsApp depende da integração com a Meta Cloud API (Fase 1)." : "Disparos em massa usam templates aprovados pela Meta — junto da integração WhatsApp."}
            </div>
          </div>
        </MobileScroll>
      )}

      {editContact && (
        <CrmContactSheet
          initial={editContact.initial || null}
          onClose={() => setEditContact(null)}
          onSave={async (p) => { const ok = await saveContact(p, editContact.initial?.id || null); if (ok) setEditContact(null); return ok; }}
          onDelete={editContact.initial ? async () => { await deleteContact(editContact.initial.id); setEditContact(null); } : null}
        />
      )}
      {addDeal && <CrmDealSheet contacts={contacts} onClose={() => setAddDeal(false)} onSave={async (p) => { const ok = await createDeal(p); if (ok) setAddDeal(false); return ok; }} />}
    </MobilePage>
  );
}

function CrmContactSheet({ initial, onClose, onSave, onDelete }) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name || "");
  const [phone, setPhone] = useState(initial?.phone || "");
  const [email, setEmail] = useState(initial?.email || "");
  const [company, setCompany] = useState(initial?.company || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const valid = name.trim();
  const submit = async () => { if (saving || !valid) return; setSaving(true); try { await onSave({ name: name.trim(), phone: phone.trim() || null, email: email.trim() || null, company: company.trim() || null, notes: notes.trim() || null }); } finally { setSaving(false); } };
  return (
    <FullSheet title={isEdit ? "Editar contato" : "Novo contato"} onBack={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={submit} disabled={!valid} loading={saving}>{isEdit ? "Salvar" : "Criar contato"}</MPrimaryButton>}>
      <MField label="Nome"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus style={mInput} /></MField>
      <MField label="Telefone / WhatsApp"><input value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} placeholder="+55 11 90000-0000" style={mInput} /></MField>
      <MField label="E-mail"><input value={email} type="email" onChange={(e) => setEmail(e.target.value)} style={mInput} /></MField>
      <MField label="Empresa"><input value={company} onChange={(e) => setCompany(e.target.value)} style={mInput} /></MField>
      <MField label="Notas"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} style={{ ...mInput, height: "auto", padding: "10px 12px", resize: "vertical" }} /></MField>
      {isEdit && onDelete && (
        <div style={{ marginTop: 8 }}>
          {!confirmDel ? (
            <button onClick={() => setConfirmDel(true)} style={{ width: "100%", height: 48, borderRadius: 10, background: "transparent", border: "1px solid var(--crit-line)", color: "var(--crit)", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><I.Trash size={15} />Excluir contato</button>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setConfirmDel(false)} style={{ flex: 1, height: 46, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14 }}>Cancelar</button>
              <button onClick={onDelete} style={{ flex: 1, height: 46, borderRadius: 10, background: "var(--crit)", border: "none", color: "#fff", fontSize: 14, fontWeight: 600 }}>Excluir</button>
            </div>
          )}
        </div>
      )}
    </FullSheet>
  );
}

function CrmDealSheet({ contacts, onClose, onSave }) {
  const [title, setTitle] = useState("");
  const [contactId, setContactId] = useState(contacts[0]?.id || "");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const valid = title.trim();
  const submit = async () => { if (saving || !valid) return; setSaving(true); try { await onSave({ title: title.trim(), contactId: contactId || null, value: _crParse(value) }); } finally { setSaving(false); } };
  return (
    <FullSheet title="Nova negociação" onBack={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={submit} disabled={!valid} loading={saving}>Criar</MPrimaryButton>}>
      <MField label="Título"><input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus style={mInput} /></MField>
      <MField label="Contato"><select value={contactId} onChange={(e) => setContactId(e.target.value)} style={mInput}><option value="">— Sem contato —</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></MField>
      <MField label="Valor (R$)"><input value={value} inputMode="decimal" onChange={(e) => setValue(e.target.value)} placeholder="0,00" style={mInput} /></MField>
    </FullSheet>
  );
}

window.MobileCRM = MobileCRM;
