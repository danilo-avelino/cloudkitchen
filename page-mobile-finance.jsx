// page-mobile-finance.jsx — Financeiro no celular (≤480px). Lançar despesas +
// checklist de fechamento. Receita mora no Faturamento (não entra aqui).
// Reaproveita helpers do desktop (window.fmt/monthOf/findCategory/…/getChecklistUrgency)
// e as funções db* (page-finance.jsx). Conciliação bancária fica no desktop.

const _fParse = (raw) => {
  if (raw === "" || raw == null) return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  let s = String(raw).trim().replace(/\s+/g, "");
  if (!s) return 0;
  const dp = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  if (dp >= 0) s = s.slice(0, dp).replace(/[.,]/g, "") + "." + s.slice(dp + 1);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};
const _fBRL = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _fMonthOf = (comp) => String(comp || "").slice(0, 7);
const _fCurPeriod = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const _F_MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const _fPeriodLabel = (p) => { const [y, m] = p.split("-"); return `${_F_MONTHS[Number(m) - 1]}/${y}`; };
const _fPeriodOptions = () => {
  const out = []; const d = new Date(); d.setDate(1);
  for (let i = 0; i < 12; i++) { const p = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; out.push(p); d.setMonth(d.getMonth() - 1); }
  return out;
};

function MobileFinance() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tab, setTab] = useState("entries");
  const [period, setPeriod] = useState(_fCurPeriod());
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState("mock");
  const [pageLoading, setPageLoading] = useState(true);
  const [entries, setEntries] = useState([]);
  const [categories, setCategories] = useState([]);
  const [subcategories, setSubcategories] = useState([]);
  const [checklist, setChecklist] = useState([]);
  const [form, setForm] = useState(null);     // { edit?: entry }
  const [fillItem, setFillItem] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setPageLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const ctx = await dbGetCurrentContext?.();
        const tid = ctx?.tenant?.id;
        if (cancelled || !tid) return;
        setTenantId(tid);
        const [catsRes, subsRes, entRes, chkRes] = await Promise.all([
          dbListDreCategories?.(tid) || { data: null },
          dbListDreSubcategories?.(tid) || { data: null },
          dbListFinanceEntries?.(tid, period) || { data: null },
          dbListClosingChecklist?.(tid, period) || { data: null },
        ]);
        if (cancelled) return;
        if (catsRes.data) { setCategories(catsRes.data); setSource("db"); }
        if (subsRes.data) setSubcategories(subsRes.data);
        if (entRes.data) setEntries(entRes.data);
        if (chkRes.data) setChecklist(chkRes.data);
      } finally { if (!cancelled) setPageLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline, period]);

  const refetchEntries = async () => { const r = await dbListFinanceEntries?.(tenantId, period); if (r?.data) setEntries(r.data); };
  const refetchChecklist = async () => { const r = await dbListClosingChecklist?.(tenantId, period); if (r?.data) setChecklist(r.data); };

  const findSub = (id) => subcategories.find((s) => s.id === id);
  const findCat = (id) => categories.find((c) => c.id === id);

  const inPeriod = useMemo(() => entries.filter((e) => _fMonthOf(e.comp) === period), [entries, period]);

  const expenseEntries = useMemo(() => inPeriod.filter((e) => {
    const sub = findSub(e.cat); if (!sub) return false;
    const cat = findCat(sub.category); if (!cat || cat.kind === "revenue") return false;
    if (e.auto || sub.autofeed) return false;
    return true;
  }).sort((a, b) => String(b.comp).localeCompare(String(a.comp))), [inPeriod, subcategories, categories]);

  const totalExpense = expenseEntries.reduce((s, e) => s + (Number(e.value) || 0), 0);

  const checklistForPeriod = useMemo(() => {
    const visible = checklist.filter((c) => !c.startPeriod || c.startPeriod <= period);
    return visible.map((c) => {
      const linked = inPeriod.filter((e) => e.checklistItemId === c.id);
      if (linked.length > 0) return { ...c, status: "filled", actual: linked.reduce((s, e) => s + (Number(e.value) || 0), 0), entryIds: linked.map((e) => e.id) };
      if (c.status === "filled" && (!c.entryIds || c.entryIds.length === 0)) return { ...c, status: c.expected > 0 ? "estimated" : "pending", actual: null, entryIds: [] };
      return c;
    });
  }, [checklist, inPeriod, period]);

  const pendingCount = checklistForPeriod.filter((c) => c.required && c.status !== "filled").length;

  // ===== handlers (mesma lógica db* do desktop) =====
  const addEntry = async (e) => {
    if (source === "db" && tenantId) {
      const { error } = await dbInsertFinanceEntry(tenantId, e);
      if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; }
      await refetchEntries(); window.showToast?.("Lançamento salvo", { tone: "ok" }); return true;
    }
    setEntries((p) => [{ ...e, id: "LAN-" + Date.now() }, ...p]); window.showToast?.("Salvo (offline)", { tone: "warn" }); return true;
  };
  const updateEntry = async (id, patch) => {
    if (source === "db" && tenantId) {
      const { error } = await dbUpdateFinanceEntry(id, patch);
      if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; }
      await refetchEntries(); window.showToast?.("Lançamento atualizado", { tone: "ok" }); return true;
    }
    setEntries((p) => p.map((x) => x.id === id ? { ...x, ...patch } : x)); return true;
  };
  const deleteEntry = async (id) => {
    if (source === "db" && tenantId) {
      const { error } = await dbDeleteFinanceEntry(id);
      if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
      await refetchEntries();
    } else setEntries((p) => p.filter((x) => x.id !== id));
    window.showToast?.("Lançamento excluído", { tone: "warn" });
  };
  const fillChecklistItem = async ({ item, value, comp, paid, status }) => {
    const desc = `${item.label} · ${period.replace("-", "/")}`;
    const checklistItemId = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(item.id)) ? item.id : null;
    const draft = { cat: item.cat, desc, value, comp, paid, status, checklistItemId };
    if (source === "db" && tenantId) {
      const { error } = await dbInsertFinanceEntry(tenantId, draft);
      if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
      await refetchEntries();
    } else setEntries((p) => [{ ...draft, id: "LAN-" + Date.now() }, ...p]);
    window.showToast?.("Lançamento salvo", { tone: "ok" });
  };

  if (pageLoading) return <PageLoading label="Carregando financeiro…" variant="table" />;

  return (
    <MobilePage>
      <SegTabs value={tab} onChange={setTab} options={[
        { id: "entries", label: "Lançamentos", count: expenseEntries.length },
        { id: "checklist", label: "Checklist", count: pendingCount || null, tone: "warn" },
      ]} />

      <div style={{ padding: "10px 14px 6px" }}>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ ...mInput, height: 40 }}>
          {_fPeriodOptions().map((p) => <option key={p} value={p}>{_fPeriodLabel(p)}</option>)}
        </select>
      </div>

      {tab === "entries" ? (
        <>
          <StatStrip stats={[
            { label: "Despesas", value: _fBRL(totalExpense).replace(",00", ""), tone: "out" },
            { label: "Lançamentos", value: expenseEntries.length },
            { label: "Pagos", value: expenseEntries.filter((e) => e.status === "paid").length, tone: "ok" },
            { label: "Pendentes", value: expenseEntries.filter((e) => e.status === "pending").length, tone: "warn" },
          ]} />
          <MobileScroll style={{ padding: "0 14px 12px" }}>
            {expenseEntries.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13 }}>
                Sem despesas neste mês.<br /><span style={{ fontSize: 11.5 }}>Receitas ficam em Faturamento.</span>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {expenseEntries.map((e) => {
                  const sub = findSub(e.cat); const cat = sub ? findCat(sub.category) : null;
                  const tone = e.status === "paid" ? "ok" : e.status === "scheduled" ? "info" : "warn";
                  const lbl = e.status === "paid" ? "Pago" : e.status === "scheduled" ? "Agendado" : "Pendente";
                  return (
                    <MobileCard key={e.id} onClick={() => setForm({ edit: e })}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.desc}</div>
                          <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 3, display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ width: 5, height: 5, borderRadius: 50, background: sub?.color || "#888", flexShrink: 0 }} />
                            {sub?.name || "—"}{cat ? ` · ${cat.name}` : ""}
                          </div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
                          <span style={{ fontFamily: "var(--mono)", fontSize: 13.5, color: "var(--fg-0)", fontWeight: 600 }}>−{_fBRL(e.value)}</span>
                          <MBadge tone={tone}>{lbl}</MBadge>
                        </div>
                      </div>
                    </MobileCard>
                  );
                })}
              </div>
            )}
          </MobileScroll>
          <MobileBottomBar>
            <MPrimaryButton onClick={() => setForm({})}><I.Plus size={16} />Novo lançamento</MPrimaryButton>
          </MobileBottomBar>
        </>
      ) : (
        <MobileScroll style={{ padding: "12px 14px" }}>
          {checklistForPeriod.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13 }}>Sem itens no checklist.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {checklistForPeriod.map((c) => {
                const sub = findSub(c.cat); const filled = c.status === "filled";
                const urg = typeof window.getChecklistUrgency === "function" ? window.getChecklistUrgency(c, period) : { level: "none" };
                const tone = filled ? "ok" : urg.level === "overdue" ? "crit" : urg.level === "soon" ? "warn" : "neutral";
                const lbl = filled ? "Preenchido" : urg.level === "overdue" ? "Vencido" : urg.level === "soon" ? "Vence logo" : "Pendente";
                return (
                  <MobileCard key={c.id} tone={filled ? undefined : (urg.level === "overdue" ? "crit" : undefined)} onClick={filled ? undefined : () => setFillItem(c)}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 500 }}>{c.label}</div>
                        <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 2 }}>
                          {sub?.name || "—"}{c.expected ? ` · esperado ${_fBRL(c.expected)}` : ""}{filled && c.actual != null ? ` · real ${_fBRL(c.actual)}` : ""}
                        </div>
                      </div>
                      <MBadge tone={tone}>{lbl}</MBadge>
                    </div>
                  </MobileCard>
                );
              })}
            </div>
          )}
        </MobileScroll>
      )}

      {form && (
        <FinanceEntryForm
          initial={form.edit || null}
          categories={categories} subcategories={subcategories} period={period}
          onClose={() => setForm(null)}
          onSave={async (draft) => { const ok = form.edit ? await updateEntry(form.edit.id, draft) : await addEntry(draft); if (ok) setForm(null); return ok; }}
          onDelete={form.edit ? () => setConfirmDel(form.edit) : null}
        />
      )}
      {fillItem && (
        <FinanceFillForm
          item={fillItem} categories={categories} subcategories={subcategories} period={period}
          onClose={() => setFillItem(null)}
          onSave={async (d) => { await fillChecklistItem(d); setFillItem(null); }}
        />
      )}
      {confirmDel && (
        <BottomSheet title="Excluir lançamento?" subtitle={confirmDel.desc} onClose={() => setConfirmDel(null)}
          footer={
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setConfirmDel(null)} style={{ flex: 1, height: 50, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14, fontWeight: 600 }}>Voltar</button>
              <button onClick={async () => { const id = confirmDel.id; setConfirmDel(null); setForm(null); await deleteEntry(id); }} style={{ flex: 1, height: 50, borderRadius: 10, background: "var(--crit)", border: "none", color: "#fff", fontSize: 14, fontWeight: 600 }}>Excluir</button>
            </div>
          }>
          <div style={{ fontSize: 13, color: "var(--fg-2)" }}>Remove <strong>{confirmDel.desc}</strong> ({_fBRL(confirmDel.value)}). Não pode ser desfeito.</div>
        </BottomSheet>
      )}
    </MobilePage>
  );
}

// Select de subcategoria agrupado por categoria DRE (exclui receita e autofeed).
function _FinSubSelect({ categories, subcategories, value, onChange }) {
  const revenueCatIds = new Set(categories.filter((c) => c.kind === "revenue").map((c) => c.id));
  const pickable = subcategories.filter((s) => !revenueCatIds.has(s.category) && !s.autofeed);
  const cats = categories.filter((c) => c.kind !== "revenue").sort((a, b) => (a.order || 0) - (b.order || 0));
  return (
    <select value={value || ""} onChange={(e) => onChange(e.target.value)} style={mInput}>
      {!value && <option value="" disabled>— Selecione —</option>}
      {cats.map((c) => {
        const subs = pickable.filter((s) => s.category === c.id);
        if (subs.length === 0) return null;
        return <optgroup key={c.id} label={c.name}>{subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>;
      })}
    </select>
  );
}

function FinanceEntryForm({ initial, categories, subcategories, period, onClose, onSave, onDelete }) {
  const isEdit = !!initial;
  const today = new Date(); const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const revenueCatIds = new Set(categories.filter((c) => c.kind === "revenue").map((c) => c.id));
  const pickable = subcategories.filter((s) => !revenueCatIds.has(s.category) && !s.autofeed);
  const defaultCat = pickable.find((s) => /fornecedor/i.test(s.name || ""))?.id || pickable[0]?.id;
  const [cat, setCat] = useState(initial?.cat || defaultCat);
  const [desc, setDesc] = useState(initial?.desc || "");
  const [value, setValue] = useState(initial?.value != null ? Number(initial.value).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "");
  const [comp, setComp] = useState(initial?.comp || `${period}-15`);
  const [paid, setPaid] = useState(initial?.paid || `${period}-15`);
  const [status, setStatus] = useState(initial?.status || "paid");
  const [saving, setSaving] = useState(false);

  const parsed = _fParse(value);
  const valid = desc.trim() && parsed > 0 && cat && comp;
  const submit = async () => { if (saving || !valid) return; setSaving(true); try { await onSave({ cat, desc: desc.trim(), value: parsed, comp, paid, status }); } finally { setSaving(false); } };

  return (
    <FullSheet
      title={isEdit ? "Editar lançamento" : "Novo lançamento"}
      subtitle={parsed > 0 ? `Despesa · ${_fBRL(parsed)}` : "A DRE usa a data de competência"}
      onBack={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={submit} disabled={!valid} loading={saving}>{isEdit ? "Salvar" : "Salvar lançamento"}</MPrimaryButton>}
    >
      <MField label="Descrição"><input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Ex.: Aluguel cozinha" autoFocus style={mInput} /></MField>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><MField label="Valor (R$)"><input value={value} inputMode="decimal" onChange={(e) => setValue(e.target.value)} placeholder="0,00" style={mInput} /></MField></div>
        <div style={{ flex: 1 }}><MField label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={mInput}>
            <option value="paid">Pago</option><option value="scheduled">Agendado</option><option value="pending">Pendente</option>
          </select>
        </MField></div>
      </div>
      <MField label="Subcategoria"><_FinSubSelect categories={categories} subcategories={subcategories} value={cat} onChange={setCat} /></MField>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><MField label="Competência" hint="Mês contábil (DRE)"><input type="date" value={comp} onChange={(e) => setComp(e.target.value)} style={mInput} /></MField></div>
        <div style={{ flex: 1 }}><MField label="Pagamento"><input type="date" value={paid} onChange={(e) => setPaid(e.target.value)} style={mInput} /></MField></div>
      </div>
      {isEdit && onDelete && (
        <button onClick={onDelete} style={{ marginTop: 8, width: "100%", height: 48, borderRadius: 10, background: "transparent", border: "1px solid var(--crit-line)", color: "var(--crit)", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <I.Trash size={15} />Excluir lançamento
        </button>
      )}
    </FullSheet>
  );
}

function FinanceFillForm({ item, categories, subcategories, period, onClose, onSave }) {
  const sub = subcategories.find((s) => s.id === item.cat);
  const parent = sub ? categories.find((c) => c.id === sub.category) : null;
  const dueDay = item.due ? String(item.due).padStart(2, "0") : "15";
  const [value, setValue] = useState(item.expected ? Number(item.expected).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "");
  const [comp, setComp] = useState(`${period}-${dueDay}`);
  const [paid, setPaid] = useState(`${period}-${dueDay}`);
  const [status, setStatus] = useState("paid");
  const [saving, setSaving] = useState(false);
  const parsed = _fParse(value);
  const submit = async () => { if (saving || parsed <= 0) return; setSaving(true); try { await onSave({ item, value: parsed, comp, paid, status }); } finally { setSaving(false); } };
  return (
    <FullSheet
      title={item.label}
      subtitle={`${parent?.name || ""}${sub ? " → " + sub.name : ""}`}
      onBack={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={submit} disabled={parsed <= 0} loading={saving}>Confirmar e adicionar à DRE</MPrimaryButton>}
    >
      {item.expected > 0 && <div style={{ fontSize: 12, color: "var(--fg-3)", marginBottom: 12 }}>Esperado: {_fBRL(item.expected)}</div>}
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><MField label="Valor real (R$)"><input value={value} inputMode="decimal" onChange={(e) => setValue(e.target.value)} placeholder="0,00" autoFocus style={mInput} /></MField></div>
        <div style={{ flex: 1 }}><MField label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={mInput}>
            <option value="paid">Pago</option><option value="scheduled">Agendado</option><option value="pending">Pendente</option>
          </select>
        </MField></div>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><MField label="Competência"><input type="date" value={comp} onChange={(e) => setComp(e.target.value)} style={mInput} /></MField></div>
        <div style={{ flex: 1 }}><MField label="Pagamento"><input type="date" value={paid} onChange={(e) => setPaid(e.target.value)} style={mInput} /></MField></div>
      </div>
    </FullSheet>
  );
}

window.MobileFinance = MobileFinance;
