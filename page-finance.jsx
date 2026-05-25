// Financeiro — fluxo de caixa: Lançamentos (CRUD de despesas) + Checklist de
// fechamento (obrigações recorrentes que precisam virar lançamento p/ o mês fechar).
//
// A visão contábil (DRE estruturada, validação de fechamento, comparativo anual)
// vive no módulo separado **DRE & Fechamento** em page-dre.jsx, que reaproveita
// vários helpers daqui via globais (window.fmt, window.findCategory, window.EntryDraft, …).
//
// Hierarquia usada nos lançamentos:
//   Categoria DRE (CMV, Pessoal, Marketing…)
//     └── Subcategoria (Compras hortifruti, Folha cozinha, Aluguel, …)
//          └── Lançamento (entries) ← CRUD aqui no Financeiro
//
// Categorias e subcategorias com `locked: true` não podem ser excluídas (essenciais).
// Subcategorias com `autofeed` recebem dados automaticamente — o usuário não cria
// lançamentos manuais nelas. Receita bruta vem de REVENUE_ENTRIES (Faturamento) e
// é renderizada na DRE.

const fmt = (v) => "R$ " + (v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtShort = (v) => "R$ " + (v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y.slice(2)}`;
};
const monthOf = (iso) => iso ? iso.slice(0, 7) : "";

// Urgência de um item do checklist em relação ao vencimento no período selecionado.
// "overdue" → já passou da data; "soon" → ≤5 dias do vencimento; "none" → ainda longe ou
// item sem data de vencimento (variáveis). Retorna { level, daysLeft }.
const CHECKLIST_SOON_DAYS = 5;
function getChecklistUrgency(item, period) {
  if (!item || item.recurrence === "variable" || !item.due) return { level: "none", daysLeft: null };
  const [y, m] = (period || "").split("-").map(Number);
  if (!y || !m) return { level: "none", daysLeft: null };
  const dueDay = Math.max(1, Math.min(31, Number(item.due)));
  const dueDate = new Date(y, m - 1, dueDay);
  // Se day overflow (ex.: dia 31 de fev) o JS rola pro mês seguinte — clampa pro último
  // dia do mês original p/ não distorcer ("vence no fim do mês").
  if (dueDate.getMonth() !== m - 1) dueDate.setDate(0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  dueDate.setHours(0, 0, 0, 0);
  const daysLeft = Math.round((dueDate - today) / 86400000);
  if (daysLeft < 0) return { level: "overdue", daysLeft };
  if (daysLeft <= CHECKLIST_SOON_DAYS) return { level: "soon", daysLeft };
  return { level: "none", daysLeft };
}

// Paleta default p/ cores de subcategorias novas — exposta via window p/ o módulo DRE
const DRE_SUB_COLORS = [
  "#2d8c66", "#b04545", "#c2843a", "#3d6cb0",
  "#6b5fb0", "#8a9098", "#0e7c97", "#a36c2a",
];

function Finance() {
  const [tab, setTab] = useState("entries");
  const [period, setPeriod] = useState("2026-05");
  const [entries, setEntries] = useState(MOCK.ENTRIES);
  const [categories,    setCategories]    = useState(MOCK.DRE_CATEGORIES);
  const [subcategories, setSubcategories] = useState(MOCK.DRE_SUBCATEGORIES);
  const [checklist, setChecklist] = useState(MOCK.CLOSING_CHECKLIST);
  const [draftOpen, setDraftOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState(null);
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState(null);
  const [fillItem, setFillItem] = useState(null);
  const [addingChecklist, setAddingChecklist] = useState(false);
  const [editingChecklistItem, setEditingChecklistItem] = useState(null);
  const [confirmDeleteChecklist, setConfirmDeleteChecklist] = useState(null);

  // DB state
  const dbStatus = useDbStatus?.() || { isOnline: false, state: "offline" };
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState("mock");
  const [pageLoading, setPageLoading] = useState(true);

  // Load from DB when period changes — só o necessário pra Lançamentos + Checklist.
  // DRE/Fechamento moram em page-dre.jsx e fazem fetch próprio (revenue, snapshots, closedPeriods).
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

        const [catsRes, subsRes, entriesRes, checkRes] = await Promise.all([
          dbListDreCategories?.(tid) || { data: null },
          dbListDreSubcategories?.(tid) || { data: null },
          dbListFinanceEntries?.(tid, period) || { data: null },
          dbListClosingChecklist?.(tid, period) || { data: null },
        ]);
        if (cancelled) return;
        if (catsRes.data) { setCategories(catsRes.data); setSource("db"); }
        if (subsRes.data) setSubcategories(subsRes.data);
        if (entriesRes.data) setEntries(entriesRes.data);
        if (checkRes.data) setChecklist(checkRes.data);
      } finally {
        if (!cancelled) setPageLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline, period]);

  const inPeriod = useMemo(() =>
    entries.filter((e) => monthOf(e.comp) === period),
  [entries, period]);

  // Status do checklist é DERIVADO por competência: cada item-template é
  // re-avaliado com base nos lançamentos do período (linkados via checklistItemId).
  // Assim "Taxas iFood" preenchida em Maio volta a aparecer "Pendente" em Junho.
  // Itens criados em Maio NÃO aparecem em Abril (não retroagem).
  const checklistForPeriod = useMemo(() => {
    const visible = checklist.filter((c) => !c.startPeriod || c.startPeriod <= period);
    return visible.map((c) => {
      const linked = inPeriod.filter((e) => e.checklistItemId === c.id);
      if (linked.length > 0) {
        const total = linked.reduce((s, e) => s + (Number(e.value) || 0), 0);
        return { ...c, status: "filled", actual: total, entryIds: linked.map((e) => e.id) };
      }
      // Sem entries no período → preserva status canned (mock) ou recai em pending/estimated
      if (c.status === "filled" && (!c.entryIds || c.entryIds.length === 0)) {
        const fallback = c.expected > 0 ? "estimated" : "pending";
        return { ...c, status: fallback, actual: null, entryIds: [] };
      }
      return c;
    });
  }, [checklist, inPeriod, period]);

  const addEntry = async (e) => {
    // DB path · persiste e recarrega lista do período
    if (dbStatus.isOnline && tenantId && typeof dbInsertFinanceEntry === "function") {
      const { data, error } = await dbInsertFinanceEntry(tenantId, e);
      if (error) {
        window.showToast?.(`Erro ao salvar lançamento: ${error.message}`, { tone: "crit", ttl: 4500 });
        return null;
      }
      const refreshed = await dbListFinanceEntries?.(tenantId, period);
      if (refreshed?.data) setEntries(refreshed.data);
      setDraftOpen(false);
      window.showToast?.("Lançamento salvo", { tone: "ok" });
      return data?.id || null;
    }
    // Fallback local
    const id = "LAN-" + (1100 + entries.length);
    setEntries([{ ...e, id }, ...entries]);
    setDraftOpen(false);
    window.showToast?.("Lançamento salvo localmente (offline)", { tone: "warn" });
    return id;
  };

  const updateEntry = async (id, patch) => {
    if (dbStatus.isOnline && tenantId && typeof dbUpdateFinanceEntry === "function") {
      const { error } = await dbUpdateFinanceEntry(id, patch);
      if (error) {
        window.showToast?.(`Erro ao atualizar: ${error.message}`, { tone: "crit", ttl: 4500 });
        return false;
      }
      const refreshed = await dbListFinanceEntries?.(tenantId, period);
      if (refreshed?.data) setEntries(refreshed.data);
      setEditingEntry(null);
      window.showToast?.("Lançamento atualizado", { tone: "ok" });
      return true;
    }
    setEntries(entries.map((x) => x.id === id ? { ...x, ...patch } : x));
    setEditingEntry(null);
    window.showToast?.("Lançamento atualizado (offline)", { tone: "warn" });
    return true;
  };

  const deleteEntry = async (id) => {
    if (dbStatus.isOnline && tenantId && typeof dbDeleteFinanceEntry === "function") {
      const { error } = await dbDeleteFinanceEntry(id);
      if (error) {
        window.showToast?.(`Erro ao excluir: ${error.message}`, { tone: "crit", ttl: 4500 });
        return false;
      }
      const refreshed = await dbListFinanceEntries?.(tenantId, period);
      if (refreshed?.data) setEntries(refreshed.data);
      setConfirmDeleteEntry(null);
      setEditingEntry(null);
      window.showToast?.("Lançamento excluído", { tone: "warn" });
      return true;
    }
    setEntries(entries.filter((x) => x.id !== id));
    setConfirmDeleteEntry(null);
    setEditingEntry(null);
    window.showToast?.("Lançamento excluído (offline)", { tone: "warn" });
    return true;
  };

  const fillChecklistItem = async ({ item, value, comp, paid, status }) => {
    const desc = `${item.label} · ${period.replace("-", "/")}`;
    // Só linka no DB se o id for UUID real (mocks usam "chk-*").
    const checklistItemId = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(item.id)) ? item.id : null;
    const draft = { cat: item.cat, desc, value, comp, paid, status, checklistItemId };
    if (dbStatus.isOnline && tenantId && typeof dbInsertFinanceEntry === "function") {
      const { error } = await dbInsertFinanceEntry(tenantId, draft);
      if (error) {
        window.showToast?.(`Erro ao salvar: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
      const refreshed = await dbListFinanceEntries?.(tenantId, period);
      if (refreshed?.data) setEntries(refreshed.data);
      // Status do item é derivado por checklistForPeriod — não setamos manualmente.
      setFillItem(null);
      window.showToast?.("Lançamento salvo", { tone: "ok" });
      return;
    }
    const id = "LAN-" + (1100 + entries.length);
    setEntries([{ id, ...draft, checklistItemId: item.id }, ...entries]);
    setFillItem(null);
  };

  if (pageLoading) return <PageLoading label="Carregando financeiro…" variant="table" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "20px 28px 0" }}>
        <div className="h-eyebrow" style={{ marginBottom: 6 }}>Competência · {MOCK.STOCK_BALANCE.monthLabel}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
          <h1 className="h-title">Financeiro</h1>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select className="select" value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="2026-04">Abril / 2026</option>
              <option value="2026-05">Maio / 2026</option>
              <option value="2026-06">Junho / 2026</option>
            </select>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase",
              padding: "2px 7px", borderRadius: 99,
              color: source === "db" ? "var(--ok)" : "var(--fg-3)",
              background: source === "db" ? "var(--accent-soft)" : "var(--bg-2)",
              border: `1px solid ${source === "db" ? "var(--accent-line)" : "var(--line)"}`,
            }} title={source === "db" ? "Dados do Supabase" : "Modo MOCK"}>
              <span style={{ width: 5, height: 5, borderRadius: 50, background: source === "db" ? "var(--ok)" : "var(--fg-3)" }} />
              {source === "db" ? "Supabase" : "Mock"}
            </span>
            {tab === "entries"   && <button className="btn" data-variant="primary" data-size="sm" onClick={() => setDraftOpen(true)}><I.Plus size={13} />Novo lançamento</button>}
            {tab === "checklist" && <button className="btn" data-variant="primary" data-size="sm" onClick={() => setAddingChecklist(true)}><I.Plus size={13} />Adicionar item</button>}
          </div>
        </div>
        <FinanceTabs tab={tab} setTab={setTab} checklist={checklistForPeriod} period={period} />
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
        {tab === "entries"   && <EntriesView entries={inPeriod} subcategories={subcategories} categories={categories} onEdit={setEditingEntry} onDelete={setConfirmDeleteEntry} />}
        {tab === "checklist" && <ChecklistView checklist={checklistForPeriod} categories={categories} subcategories={subcategories} onFill={setFillItem} onEdit={setEditingChecklistItem} onDelete={setConfirmDeleteChecklist} period={period} />}
      </div>

      {draftOpen  && <EntryDraft  categories={categories} subcategories={subcategories} onClose={() => setDraftOpen(false)} onSave={addEntry} period={period} />}
      {editingEntry && (
        <EntryDraft
          categories={categories}
          subcategories={subcategories}
          initial={editingEntry}
          period={period}
          onClose={() => setEditingEntry(null)}
          onSave={(draft) => updateEntry(editingEntry.id, draft)}
          onDelete={() => setConfirmDeleteEntry(editingEntry)}
        />
      )}
      {confirmDeleteEntry && (
        <ConfirmDialog
          open={!!confirmDeleteEntry}
          tone="danger"
          title="Excluir lançamento?"
          message={
            <>
              Esta ação remove <strong style={{ color: "var(--fg-0)" }}>{confirmDeleteEntry.desc || "este lançamento"}</strong>
              {Number(confirmDeleteEntry.value) > 0 && <> no valor de <strong style={{ color: "var(--fg-0)" }}>{fmt(confirmDeleteEntry.value)}</strong></>}
              . A exclusão não pode ser desfeita.
            </>
          }
          confirmLabel="Excluir"
          cancelLabel="Cancelar"
          onCancel={() => setConfirmDeleteEntry(null)}
          onConfirm={() => deleteEntry(confirmDeleteEntry.id)}
        />
      )}
      {fillItem   && <FillDraft   item={fillItem} categories={categories} subcategories={subcategories} period={period} onClose={() => setFillItem(null)} onSave={fillChecklistItem} />}
      {addingChecklist && (
        <ChecklistItemDraft
          categories={categories}
          subcategories={subcategories}
          onClose={() => setAddingChecklist(false)}
          onSave={async (item) => {
            if (dbStatus.isOnline && tenantId && typeof dbInsertClosingChecklistItem === "function") {
              const { data, error } = await dbInsertClosingChecklistItem(tenantId, item, period);
              if (error) {
                window.showToast?.(`Erro ao adicionar: ${error.message}`, { tone: "crit", ttl: 4500 });
                return;
              }
              const refreshed = await dbListClosingChecklist?.(tenantId, period);
              if (refreshed?.data) setChecklist(refreshed.data);
              setAddingChecklist(false);
              window.showToast("Item adicionado ao checklist", { tone: "ok" });
              return;
            }
            const id = "chk-" + (1000 + checklist.length);
            const startPeriod = new Date().toISOString().slice(0, 7);
            setChecklist([{ ...item, id, status: "pending", actual: null, entryIds: [], startPeriod }, ...checklist]);
            setAddingChecklist(false);
            window.showToast("Item adicionado ao checklist (offline)", { tone: "warn" });
          }}
        />
      )}
      {editingChecklistItem && (
        <ChecklistItemDraft
          initial={editingChecklistItem}
          categories={categories}
          subcategories={subcategories}
          onClose={() => setEditingChecklistItem(null)}
          onDelete={() => setConfirmDeleteChecklist(editingChecklistItem)}
          onSave={async (patch) => {
            if (dbStatus.isOnline && tenantId && typeof dbUpdateClosingChecklistItem === "function") {
              const { error } = await dbUpdateClosingChecklistItem(editingChecklistItem.id, patch);
              if (error) {
                window.showToast?.(`Erro ao salvar: ${error.message}`, { tone: "crit", ttl: 4500 });
                return;
              }
              const refreshed = await dbListClosingChecklist?.(tenantId, period);
              if (refreshed?.data) setChecklist(refreshed.data);
              setEditingChecklistItem(null);
              window.showToast("Item atualizado", { tone: "ok" });
              return;
            }
            setChecklist(checklist.map((c) => c.id === editingChecklistItem.id ? { ...c, ...patch } : c));
            setEditingChecklistItem(null);
            window.showToast("Item atualizado (offline)", { tone: "warn" });
          }}
        />
      )}
      {confirmDeleteChecklist && (
        <ConfirmDialog
          open={!!confirmDeleteChecklist}
          tone="danger"
          title="Excluir item do checklist?"
          message={
            <>
              Esta ação remove <strong style={{ color: "var(--fg-0)" }}>{confirmDeleteChecklist.label}</strong> do checklist de fechamento — o item deixa de aparecer nos próximos meses.
              {" "}
              <span style={{ color: "var(--fg-2)" }}>
                Os lançamentos já feitos em qualquer mês <strong style={{ color: "var(--fg-1)" }}>permanecem intactos na DRE</strong>; apenas o vínculo com este item é desfeito.
              </span>
              {" "}A exclusão não pode ser desfeita.
            </>
          }
          confirmLabel="Excluir"
          cancelLabel="Cancelar"
          onCancel={() => setConfirmDeleteChecklist(null)}
          onConfirm={async () => {
            if (dbStatus.isOnline && tenantId && typeof dbDeleteClosingChecklistItem === "function") {
              const { error } = await dbDeleteClosingChecklistItem(confirmDeleteChecklist.id);
              if (error) {
                window.showToast?.(`Erro ao excluir: ${error.message}`, { tone: "crit", ttl: 4500 });
                return;
              }
              const refreshed = await dbListClosingChecklist?.(tenantId, period);
              if (refreshed?.data) setChecklist(refreshed.data);
            } else {
              setChecklist(checklist.filter((c) => c.id !== confirmDeleteChecklist.id));
            }
            setConfirmDeleteChecklist(null);
            setEditingChecklistItem(null);
            window.showToast("Item excluído", { tone: "warn" });
          }}
        />
      )}
    </div>
  );
}

// ===== Helpers locais =====
function findCategory(categories, id)    { return categories.find((c) => c.id === id);     }
function findSubcategory(subs, id)       { return subs.find((s) => s.id === id);            }
function subsByCategory(subs, catId)     { return subs.filter((s) => s.category === catId); }

function ChecklistItemDraft({ categories, subcategories, onClose, onSave, onDelete, initial }) {
  const isEditing = !!initial;
  const [label, setLabel]     = useState(initial?.label || "");
  const [cat, setCat]         = useState(initial?.cat || subcategories[0]?.id);
  const [recurrence, setRec]  = useState(initial?.recurrence || "monthly");
  const [due, setDue]         = useState(initial?.due != null ? String(initial.due) : "");
  const [owner, setOwner]     = useState(initial?.owner && initial.owner !== "—" ? initial.owner : "");
  const [expected, setExp]    = useState(initial?.expected
    ? Number(initial.expected).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "");
  const [required, setReq]    = useState(initial?.required ?? true);
  const [source, setSource]   = useState(initial?.source && initial.source !== "Manual" ? initial.source : "");

  const valid = label.trim() && cat;
  const buildPatch = () => ({
    label: label.trim(), cat, recurrence,
    due: due ? Number(due) : null,
    owner: owner.trim() || "—",
    expected: parseFloat(String(expected).replace(/\./g, "").replace(",", ".")) || 0,
    required, source: source.trim() || "Manual",
  });

  return (
    <ModalShell
      title={isEditing ? "Editar item do checklist" : "Adicionar item ao checklist"}
      subtitle={isEditing
        ? "Atualize os dados desta obrigação recorrente."
        : "Crie uma obrigação recorrente que aparecerá no fechamento mensal."}
      onClose={onClose}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", width: "100%", gap: 8 }}>
          <div>
            {isEditing && onDelete && (
              <button className="btn" data-variant="danger" data-size="sm" onClick={onDelete}>
                <I.Trash size={11} />Excluir
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" data-size="sm" onClick={onClose}>Cancelar</button>
            <button className="btn" data-variant="primary" data-size="sm" disabled={!valid}
                    onClick={() => onSave(buildPatch())}>
              {isEditing ? "Salvar alterações" : "Adicionar item"}
            </button>
          </div>
        </div>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <FormField label="Descrição">
          <input className="input" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ex.: Conta de luz" />
        </FormField>
        <FormField label="Subcategoria DRE">
          <select className="select" value={cat} onChange={(e) => setCat(e.target.value)}>
            {categories.map((g) => (
              <optgroup key={g.id} label={g.name}>
                {subsByCategory(subcategories, g.id).filter((s) => !s.autofeed).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </FormField>
        <FormField label="Recorrência">
          <select className="select" value={recurrence} onChange={(e) => setRec(e.target.value)}>
            <option value="monthly">Mensal</option>
            <option value="biweekly">Quinzenal</option>
            <option value="weekly">Semanal</option>
            <option value="variable">Variável</option>
          </select>
        </FormField>
        <FormField label="Vencimento (dia do mês)" hint="opcional">
          <input className="input mono" type="number" min="1" max="31" value={due} onChange={(e) => setDue(e.target.value)} placeholder="—" />
        </FormField>
        <FormField label="Responsável">
          <input className="input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Ex.: Contador" />
        </FormField>
        <FormField label="Valor esperado (R$)">
          <input className="input mono" inputMode="decimal" value={expected} onChange={(e) => setExp(e.target.value)} placeholder="0,00" />
        </FormField>
        <FormField label="Fonte do valor" hint="Ex.: Fatura Enel, Holerite">
          <input className="input" value={source} onChange={(e) => setSource(e.target.value)} />
        </FormField>
        <FormField label="Tipo">
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--fg-1)", cursor: "pointer", marginTop: 6 }}>
            <input type="checkbox" checked={required} onChange={(e) => setReq(e.target.checked)} />
            Obrigatório (bloqueia fechamento)
          </label>
        </FormField>
      </div>
    </ModalShell>
  );
}

function FinanceTabs({ tab, setTab, checklist, period }) {
  // Conta só itens obrigatórios pendentes que JÁ estão próximos ou vencidos.
  // Pendentes longe do vencimento não alertam (era o caso da screenshot do usuário).
  let overdue = 0, soon = 0;
  for (const c of checklist) {
    if (!c.required || c.status === "filled") continue;
    const u = getChecklistUrgency(c, period);
    if (u.level === "overdue") overdue++;
    else if (u.level === "soon") soon++;
  }
  const count = overdue + soon;
  const tone = overdue > 0 ? "crit" : "warn";
  const badgeStyle = tone === "crit"
    ? { background: "var(--crit-soft)", color: "var(--crit)", border: "1px solid var(--crit-line)" }
    : { background: "rgba(194,132,58,0.14)", color: "var(--warn)", border: "1px solid rgba(194,132,58,0.3)" };
  const tabs = [
    { id: "entries",   label: "Lançamentos" },
    { id: "checklist", label: "Checklist de fechamento", count },
  ];
  return (
    <div style={{ display: "flex", gap: 0, marginTop: 16, borderBottom: "1px solid var(--line)" }}>
      {tabs.map(({ id, label, count: c }) => {
        const active = tab === id;
        return (
          <button key={id} onClick={() => setTab(id)} style={{
            background: "transparent", border: "none",
            padding: "10px 14px", fontSize: 12.5,
            color: active ? "var(--fg-0)" : "var(--fg-2)",
            fontWeight: active ? 500 : 400, letterSpacing: "-0.005em",
            borderBottom: `2px solid ${active ? "var(--accent-bright)" : "transparent"}`,
            marginBottom: -1, display: "inline-flex", alignItems: "center", gap: 8,
          }}
          title={id === "checklist" && c > 0
            ? `${overdue > 0 ? `${overdue} vencido(s)` : ""}${overdue > 0 && soon > 0 ? " · " : ""}${soon > 0 ? `${soon} próximo(s) do vencimento` : ""}`
            : undefined}>
            {label}
            {c > 0 && (
              <span style={{
                fontFamily: "var(--mono)", fontSize: 10, padding: "1px 6px",
                borderRadius: 99, letterSpacing: "0.04em", ...badgeStyle,
              }}>{c}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------- Lançamentos ----------
function EntriesView({ entries, subcategories, categories, onEdit, onDelete }) {
  // Filtra despesas (não-receita) e remove auto-feeds (que são exibidos apenas na DRE)
  const expenseOnly = entries.filter((e) => {
    const sub = findSubcategory(subcategories, e.cat);
    if (!sub) return false;
    const cat = findCategory(categories, sub.category);
    if (!cat || cat.kind === "revenue") return false;
    if (e.auto || sub.autofeed) return false;
    return true;
  });
  const sorted = [...expenseOnly].sort((a, b) => b.comp.localeCompare(a.comp));
  const total = sorted.reduce((s, e) => s + e.value, 0);
  return (
    <div>
      <div style={{ display: "flex", padding: "16px 28px", gap: 24, borderBottom: "1px solid var(--line)" }}>
        <SummaryStat label="Lançamentos" value={sorted.length} />
        <SummaryStat label="Pagos" value={sorted.filter((e) => e.status === "paid").length} />
        <SummaryStat label="Agendados" value={sorted.filter((e) => e.status === "scheduled").length} />
        <SummaryStat label="Pendentes" value={sorted.filter((e) => e.status === "pending").length} tone="warn" />
        <span style={{ flex: 1 }} />
        <SummaryStat label="Total despesas" value={fmt(total)} tone="crit" />
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Descrição</th>
            <th>Subcategoria</th>
            <th>Categoria DRE</th>
            <th>Competência</th>
            <th>Pagamento</th>
            <th>Status</th>
            <th className="num">Valor</th>
            <th style={{ width: 90 }}></th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr><td colSpan="8" style={{ padding: "32px", textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>
              Sem lançamentos de despesa neste período. Receitas são consolidadas em <span style={{ color: "var(--accent-bright)" }}>Faturamento</span>.
            </td></tr>
          )}
          {sorted.map((e) => {
            const sub = findSubcategory(subcategories, e.cat);
            const cat = sub ? findCategory(categories, sub.category) : null;
            const tone = e.status === "paid" ? "ok" : e.status === "scheduled" ? "info" : "warn";
            const lbl = e.status === "paid" ? "Pago" : e.status === "scheduled" ? "Agendado" : "Pendente";
            return (
              <tr key={e.id} style={{ cursor: onEdit ? "pointer" : "default" }} onClick={() => onEdit?.(e)}>
                <td className="row-strong">{e.desc}</td>
                <td className="dim">
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 4, height: 4, borderRadius: 50, background: sub?.color || "#888" }} />
                    {sub?.name || "—"}
                  </span>
                </td>
                <td className="dim" style={{ fontSize: 11.5 }}>{cat?.name || "—"}</td>
                <td className="mono" style={{ fontSize: 11.5, color: "var(--fg-1)" }}>{fmtDate(e.comp)}</td>
                <td className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{fmtDate(e.paid)}</td>
                <td><span className="badge" data-tone={tone}>{lbl}</span></td>
                <td className="num" style={{ color: "var(--fg-0)" }}>−{fmt(e.value)}</td>
                <td onClick={(ev) => ev.stopPropagation()}>
                  <div style={{ display: "inline-flex", gap: 4 }}>
                    <button className="btn" data-variant="ghost" data-size="sm" title="Editar"
                            onClick={() => onEdit?.(e)} style={{ padding: "3px 6px" }}>
                      <I.Edit size={11} />
                    </button>
                    <button className="btn" data-variant="ghost" data-size="sm" title="Excluir"
                            onClick={() => onDelete?.(e)} style={{ padding: "3px 6px", color: "var(--crit)" }}>
                      <I.Trash size={11} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Checklist de fechamento ----------
function ChecklistView({ checklist, categories, subcategories, onFill, onEdit, onDelete, period }) {
  const [filter, setFilter] = useState("pending");

  const filtered = checklist.filter((c) => {
    if (filter === "pending") return c.status !== "filled";
    if (filter === "filled")  return c.status === "filled";
    return true;
  });

  const totalRequired = checklist.filter((c) => c.required).length;
  const totalFilled   = checklist.filter((c) => c.required && c.status === "filled").length;
  const pendingValue  = checklist.filter((c) => c.status !== "filled").reduce((s, c) => s + (c.expected || 0), 0);
  const progress      = totalRequired > 0 ? (totalFilled / totalRequired) * 100 : 0;

  // Agrupa por categoria DRE. Preferência: categoria pai da subcategoria; fallback
  // pra categoryId direto (itens sem subcategoria). Nunca silenciar item — se nada
  // mapear, joga no bucket da primeira categoria pra ficar visível.
  const grouped = {};
  categories.forEach((g) => grouped[g.id] = []);
  filtered.forEach((c) => {
    const sub = findSubcategory(subcategories, c.cat);
    const catId = sub?.category || c.categoryId || categories[0]?.id;
    if (grouped[catId]) grouped[catId].push(c);
  });

  return (
    <div style={{ padding: "20px 28px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card" style={{ background: "linear-gradient(180deg, rgba(45,140,102,0.04), transparent 80%)" }}>
        <div className="card-body" style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 20, alignItems: "center" }}>
          <div>
            <div className="h-eyebrow" style={{ marginBottom: 8 }}>Fechamento {period.replace("-", "/")} · {totalFilled} de {totalRequired} obrigatórios</div>
            <div style={{ height: 4, background: "var(--bg-3)", borderRadius: 2, overflow: "hidden", maxWidth: 480 }}>
              <div style={{ height: "100%", width: `${progress}%`, background: "var(--accent-bright)", transition: "width 240ms ease-out" }} />
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", marginTop: 8, letterSpacing: "0.04em" }}>
              {progress.toFixed(0)}% completo · {checklist.filter((c) => c.required && c.status !== "filled").length} pendência(s) crítica(s)
            </div>
          </div>
          <DreStat label="Itens preenchidos" value={`${checklist.filter((c) => c.status === "filled").length}/${checklist.length}`} />
          <DreStat label="Estimados" value={checklist.filter((c) => c.status === "estimated").length} />
          <DreStat label="Pendentes (R$)" value={fmtShort(pendingValue)} sub="aguardando preenchimento" />
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {[["all", "Todos"], ["pending", "Pendentes"], ["filled", "Preenchidos"]].map(([id, label]) => {
          const active = filter === id;
          const count = id === "all" ? checklist.length : id === "filled" ? checklist.filter((c) => c.status === "filled").length : checklist.filter((c) => c.status !== "filled").length;
          return (
            <button key={id} onClick={() => setFilter(id)} style={{
              padding: "6px 12px", fontSize: 11.5,
              background: active ? "var(--bg-3)" : "transparent",
              border: `1px solid ${active ? "var(--line-strong)" : "var(--line)"}`,
              color: active ? "var(--fg-0)" : "var(--fg-2)",
              borderRadius: 4, cursor: "pointer", letterSpacing: "-0.005em",
            }}>{label} <span style={{ fontFamily: "var(--mono)", color: "var(--fg-3)", marginLeft: 6, fontSize: 10 }}>{count}</span></button>
          );
        })}
      </div>

      {checklist.length === 0 && (
        <div className="card" style={{ padding: "40px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 13.5, color: "var(--fg-1)", marginBottom: 6, letterSpacing: "-0.005em" }}>
            Nenhum item no checklist ainda
          </div>
          <div style={{ fontSize: 12, color: "var(--fg-3)", maxWidth: 480, margin: "0 auto" }}>
            Cadastre as obrigações recorrentes do seu fechamento (aluguel, energia, folha, taxas dos apps…) clicando em
            <strong style={{ color: "var(--accent-bright)" }}> + Adicionar item</strong> no canto superior direito.
            Cada item aparece em todos os meses e fica marcado como preenchido quando você lança o valor real.
          </div>
        </div>
      )}

      {categories.sort((a, b) => a.order - b.order).map((g) => {
        const items = grouped[g.id];
        if (!items || items.length === 0) return null;
        const groupFilled = items.filter((i) => i.status === "filled").length;
        const groupTotal = items.reduce((s, i) => s + (i.actual ?? i.expected ?? 0), 0);
        return (
          <div key={g.id} className="card">
            <div className="card-header">
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <h3 className="card-title">{g.name}</h3>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
                  {groupFilled}/{items.length} preenchidos · {fmt(groupTotal)}
                </span>
              </div>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}></th>
                  <th>Item</th>
                  <th>Subcategoria</th>
                  <th>Recorrência</th>
                  <th>Vence</th>
                  <th>Responsável</th>
                  <th className="num">Esperado</th>
                  <th className="num">Real</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => <ChecklistRow key={c.id} item={c} subcategories={subcategories} period={period} onFill={onFill} onEdit={onEdit} onDelete={onDelete} />)}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function ChecklistRow({ item, subcategories, period, onFill, onEdit, onDelete }) {
  const sub = findSubcategory(subcategories, item.cat);
  const recLabel = { monthly: "Mensal", biweekly: "Quinzenal", weekly: "Semanal", variable: "Variável" }[item.recurrence];
  const urgency = getChecklistUrgency(item, period);
  // Pendentes longe do vencimento ficam neutros (info/cinza); só fica crit se vencido.
  const pendingTone = urgency.level === "overdue" ? "crit" : urgency.level === "soon" ? "warn" : "info";
  const pendingLabel = urgency.level === "overdue" ? "Vencido" : "Pendente";
  const statusInfo = {
    filled:    { tone: "ok",       label: "Preenchido" },
    estimated: { tone: "warn",     label: "Estimado" },
    pending:   { tone: pendingTone, label: pendingLabel },
  }[item.status];
  const dueCaption = item.status === "filled" || urgency.level === "none" || urgency.daysLeft == null
    ? null
    : urgency.level === "overdue"
      ? `vencido há ${Math.abs(urgency.daysLeft)}d`
      : urgency.daysLeft === 0
        ? "vence hoje"
        : `em ${urgency.daysLeft}d`;
  const drift = item.actual !== null && item.actual !== undefined ? item.actual - item.expected : null;
  const driftPct = drift !== null && item.expected ? (drift / item.expected) * 100 : null;
  return (
    <tr>
      <td>
        <span style={{
          display: "inline-block", width: 14, height: 14, borderRadius: 3,
          border: `1.5px solid ${item.status === "filled" ? "var(--ok)" : "var(--line-strong)"}`,
          background: item.status === "filled" ? "var(--ok)" : "transparent",
          position: "relative",
        }}>
          {item.status === "filled" && <span style={{ position: "absolute", inset: 0, color: "#02100a", fontSize: 10, display: "grid", placeItems: "center", lineHeight: 1 }}>✓</span>}
        </span>
      </td>
      <td>
        <div className="row-strong">
          {item.label}
          {item.required && <span style={{ marginLeft: 8, fontFamily: "var(--mono)", fontSize: 9, color: "var(--warn)", letterSpacing: "0.06em", textTransform: "uppercase" }}>obrig.</span>}
        </div>
        <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2 }}>
          {item.source}
          {item.formula && <span style={{ marginLeft: 8, fontFamily: "var(--mono)", color: "var(--fg-2)" }}>· {item.formula}</span>}
        </div>
      </td>
      <td className="dim">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 4, height: 4, borderRadius: 50, background: sub?.color || "#888" }} />
          {sub?.name || "—"}
        </span>
      </td>
      <td className="dim" style={{ fontSize: 11.5 }}>{recLabel}</td>
      <td className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
        {item.due ? `dia ${String(item.due).padStart(2, "0")}` : "—"}
        {dueCaption && (
          <div style={{
            fontFamily: "var(--mono)", fontSize: 10, marginTop: 2, letterSpacing: "0.04em",
            color: urgency.level === "overdue" ? "var(--crit)" : "var(--warn)",
          }}>{dueCaption}</div>
        )}
      </td>
      <td className="dim" style={{ fontSize: 11.5 }}>{item.owner}</td>
      <td className="num" style={{ color: "var(--fg-2)" }}>{fmt(item.expected || 0)}</td>
      <td className="num">
        {item.actual !== null && item.actual !== undefined ? (
          <>
            <span style={{ color: "var(--fg-0)" }}>{fmt(item.actual)}</span>
            {drift !== null && Math.abs(driftPct) > 1 && (
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: drift > 0 ? "var(--crit)" : "var(--ok)", marginTop: 2, letterSpacing: "0.04em" }}>
                {drift > 0 ? "+" : ""}{driftPct.toFixed(1)}%
              </div>
            )}
          </>
        ) : <span style={{ color: "var(--fg-4)" }}>—</span>}
      </td>
      <td><span className="badge" data-tone={statusInfo.tone}>{statusInfo.label}</span></td>
      <td>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {item.status !== "filled" && onFill && (
            <button className="btn" data-variant="primary" data-size="sm" onClick={() => onFill(item)}>
              Preencher
            </button>
          )}
          {item.status === "filled" && item.entryIds.length > 0 && (
            <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>{item.entryIds.length} lanç.</span>
          )}
          {onEdit && (
            <button className="btn" data-variant="ghost" data-size="sm" title="Editar item"
                    onClick={() => onEdit(item)} style={{ padding: "3px 6px" }}>
              <I.Edit size={11} />
            </button>
          )}
          {onDelete && (
            <button className="btn" data-variant="ghost" data-size="sm" title="Excluir item"
                    onClick={() => onDelete(item)} style={{ padding: "3px 6px", color: "var(--crit)" }}>
              <I.Trash size={11} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ---------- Drafts ----------
function ModalShell({ title, subtitle, onClose, children, footer, width = 560 }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(7,8,10,0.6)", zIndex: 200, display: "grid", placeItems: "center", padding: 20 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width, maxWidth: "calc(100vw - 32px)", background: "var(--bg-1)", border: "1px solid var(--line-strong)", borderRadius: 6, display: "flex", flexDirection: "column", maxHeight: "92vh", boxShadow: "0 24px 60px -12px rgba(0,0,0,0.6)" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.01em" }}>{title}</h2>
            {subtitle && <div style={{ fontSize: 12, color: "var(--fg-2)", marginTop: 4 }}>{subtitle}</div>}
          </div>
          <button className="btn" data-variant="ghost" data-size="sm" onClick={onClose}><I.X size={13} /></button>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "18px 20px" }}>{children}</div>
        {footer && (
          <div style={{ padding: "14px 20px", borderTop: "1px solid var(--line)", display: "flex", justifyContent: "flex-end", gap: 8 }}>{footer}</div>
        )}
      </div>
    </div>
  );
}

function FormField({ label, hint, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{hint}</span>}
    </label>
  );
}

function EntryDraft({ categories, subcategories, onClose, onSave, onDelete, period, initial }) {
  // Receita é lançada no Faturamento — não aparece como subcategoria selecionável aqui.
  const revenueCatIds = new Set(categories.filter((c) => c.kind === "revenue").map((c) => c.id));
  subcategories = subcategories.filter((s) => !revenueCatIds.has(s.category));
  categories = categories.filter((c) => c.kind !== "revenue");
  // Subcategorias selecionáveis: exclui as autofeed (Ajuste de estoque vem do inventário)
  const pickable = subcategories.filter((s) => !s.autofeed);
  const defaultCat = pickable.find((s) => /fornecedor/i.test(s.name || s.label || ""))?.id || pickable[0]?.id;
  const initialValueStr = initial?.value != null
    ? Number(initial.value).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "";
  const [cat, setCat] = useState(initial?.cat || defaultCat);
  const [desc, setDesc] = useState(initial?.desc || "");
  const [value, setValue] = useState(initialValueStr);
  const [comp, setComp] = useState(initial?.comp || `${period}-15`);
  const [paid, setPaid] = useState(initial?.paid || `${period}-20`);
  const [status, setStatus] = useState(initial?.status || "paid");
  const [touched, setTouched] = useState(false);
  const isEditing = !!initial;

  const sub = pickable.find((x) => x.id === cat);
  const parent = sub ? findCategory(categories, sub.category) : null;

  const parsedValue = parseFloat(String(value).replace(/\./g, "").replace(",", "."));
  const errs = {
    desc:  !desc.trim(),
    value: !Number.isFinite(parsedValue) || parsedValue <= 0,
    cat:   !cat,
    comp:  !comp,
  };
  const show = (k) => touched && errs[k];
  const errorMessages = [
    errs.desc  && "Descrição obrigatória",
    errs.value && "Valor precisa ser maior que zero",
    errs.cat   && "Selecione uma subcategoria",
    errs.comp  && "Data de competência obrigatória",
  ].filter(Boolean);

  const save = () => {
    if (Object.values(errs).some(Boolean)) {
      setTouched(true);
      window.showToast?.(`Faltam campos: ${errorMessages.join(", ")}`, { tone: "warn", ttl: 4000 });
      return;
    }
    onSave({ cat, desc, value: parsedValue, comp, paid, status });
  };

  const errBorder = { borderColor: "var(--crit)", boxShadow: "0 0 0 1px var(--crit-line) inset" };

  return (
    <ModalShell
      title={isEditing ? "Editar lançamento" : "Novo lançamento"}
      subtitle="A DRE usa a data de competência. A data de pagamento é apenas para fluxo de caixa."
      onClose={onClose}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", width: "100%", gap: 8 }}>
          <div>
            {isEditing && onDelete && (
              <button className="btn" data-variant="danger" data-size="sm" onClick={onDelete}>
                <I.Trash size={11} />Excluir
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" data-size="sm" onClick={onClose}>Cancelar</button>
            <button className="btn" data-variant="primary" data-size="sm" onClick={save}>
              {isEditing ? "Salvar alterações" : "Salvar lançamento"}
            </button>
          </div>
        </div>
      }
    >
      {touched && errorMessages.length > 0 && (
        <div style={{
          padding: "8px 12px", marginBottom: 12,
          background: "var(--crit-soft)", border: "1px solid var(--crit-line)",
          borderRadius: 4, fontSize: 11.5, color: "var(--crit)",
        }}>
          <strong>Não pode salvar:</strong>
          <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
            {errorMessages.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <FormField label="Descrição" hint={show("desc") ? "Obrigatório" : null}>
          <input className="input" placeholder="Ex.: Aluguel cozinha · maio" value={desc}
                 onChange={(e) => setDesc(e.target.value)}
                 style={show("desc") ? errBorder : null} />
        </FormField>
        <FormField label="Valor (R$)" hint={show("value") ? "Informe um valor maior que zero" : null}>
          <input className="input mono" placeholder="0,00" value={value}
                 onChange={(e) => setValue(e.target.value)}
                 style={show("value") ? errBorder : null} />
        </FormField>
        <FormField label="Subcategoria"
                   hint={show("cat") ? "Selecione uma subcategoria" : (parent ? `Entrará em: ${parent.name}` : null)}>
          <select className="select" value={cat || ""} onChange={(e) => setCat(e.target.value)}
                  style={show("cat") ? errBorder : null}>
            {!cat && <option value="" disabled>— Selecione —</option>}
            {categories.sort((a, b) => a.order - b.order).map((c) => (
              <optgroup key={c.id} label={c.name}>
                {pickable.filter((s) => s.category === c.id).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </FormField>
        <FormField label="Status">
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="paid">Pago</option>
            <option value="scheduled">Agendado</option>
            <option value="pending">Pendente</option>
          </select>
        </FormField>
        <FormField label="Data de competência" hint={show("comp") ? "Obrigatório" : "Mês contábil — usado na DRE"}>
          <input className="input mono" type="date" value={comp} onChange={(e) => setComp(e.target.value)}
                 style={show("comp") ? errBorder : null} />
        </FormField>
        <FormField label="Data de pagamento" hint="Quando sai/entra do caixa">
          <input className="input mono" type="date" value={paid} onChange={(e) => setPaid(e.target.value)} />
        </FormField>
      </div>
    </ModalShell>
  );
}

function FillDraft({ item, categories, subcategories, period, onClose, onSave }) {
  const sub = findSubcategory(subcategories, item.cat);
  const parent = sub ? findCategory(categories, sub.category) : null;
  const expectedStr = (item.expected || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const [value, setValue] = useState(expectedStr);
  const dueDay = item.due ? String(item.due).padStart(2, "0") : "15";
  const [comp, setComp] = useState(`${period}-${dueDay}`);
  const [paid, setPaid] = useState(`${period}-${dueDay}`);
  const [status, setStatus] = useState("paid");

  const save = () => {
    const v = parseFloat(String(value).replace(/\./g, "").replace(",", "."));
    if (!v) return;
    onSave({ item, value: v, comp, paid, status });
  };

  return (
    <ModalShell
      title={item.label}
      subtitle={`Pré-cadastrado · ${parent?.name || ""} → ${sub?.name || ""}`}
      onClose={onClose}
      footer={<>
        <button className="btn" data-size="sm" onClick={onClose}>Cancelar</button>
        <button className="btn" data-variant="primary" data-size="sm" onClick={save}>Confirmar e adicionar à DRE</button>
      </>}
    >
      <div style={{ background: "var(--bg-2)", border: "1px solid var(--line)", padding: 14, borderRadius: 4, marginBottom: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        <DreStat label="Esperado" value={fmt(item.expected || 0)} />
        <DreStat label="Recorrência" value={({ monthly: "Mensal", biweekly: "Quinzenal", weekly: "Semanal", variable: "Variável" })[item.recurrence]} />
        <DreStat label="Fonte" value={item.source} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <FormField label="Valor real (R$)" hint={item.formula ? `Cálculo: ${item.formula}` : "Você pode ajustar para o valor da NF/extrato"}>
          <input className="input mono" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        </FormField>
        <FormField label="Status">
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="paid">Pago</option>
            <option value="scheduled">Agendado</option>
            <option value="pending">Pendente</option>
          </select>
        </FormField>
        <FormField label="Data de competência" hint="Mês contábil — usado na DRE">
          <input className="input mono" type="date" value={comp} onChange={(e) => setComp(e.target.value)} />
        </FormField>
        <FormField label="Data de pagamento">
          <input className="input mono" type="date" value={paid} onChange={(e) => setPaid(e.target.value)} />
        </FormField>
      </div>
    </ModalShell>
  );
}

window.Finance = Finance;
// Exposto pro Sidebar calcular o badge de urgência do checklist sem duplicar lógica.
window.getChecklistUrgency = getChecklistUrgency;

// Helpers compartilhados com o módulo DRE & Fechamento (page-dre.jsx).
// page-finance.jsx é importado antes do page-dre.jsx em src/main.jsx, então
// quando o Dre() roda, esses globais já estão disponíveis.
window.fmt              = fmt;
window.fmtShort         = fmtShort;
window.fmtDate          = fmtDate;
window.monthOf          = monthOf;
window.findCategory     = findCategory;
window.findSubcategory  = findSubcategory;
window.subsByCategory   = subsByCategory;
window.DRE_SUB_COLORS   = DRE_SUB_COLORS;
window.ModalShell       = ModalShell;
window.FormField        = FormField;
window.EntryDraft       = EntryDraft;
