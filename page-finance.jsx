// Finance — Lançamentos, DRE editável (2 níveis), Checklist de fechamento.
//
// Hierarquia da DRE:
//   Categoria (CMV, Pessoal, Marketing…)
//     └── Subcategoria (Compras hortifruti, Compras carnes, Ajuste de estoque, …)
//          └── Lançamento (entries)
//
// Auto-feeds:
//   * Receita bruta  ← REVENUE_ENTRIES (módulo Faturamento)
//   * Ajuste estoque ← INVENTORIES finalizados no período (financialImpact com sinal invertido:
//     perda no inventário aumenta o CMV; sobra reduz)
//
// Categorias e subcategorias com `locked: true` não podem ser excluídas (essenciais).
// Subcategorias com `autofeed` recebem dados automaticamente — o usuário não cria
// lançamentos manuais nelas.

const fmt = (v) => "R$ " + (v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtShort = (v) => "R$ " + (v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y.slice(2)}`;
};
const monthOf = (iso) => iso ? iso.slice(0, 7) : "";

// Paleta default p/ cores de subcategorias novas
const DRE_SUB_COLORS = [
  "#2d8c66", "#b04545", "#c2843a", "#3d6cb0",
  "#6b5fb0", "#8a9098", "#0e7c97", "#a36c2a",
];

// Calcula ajustes automáticos de estoque a partir dos inventários finalizados.
// Retorna entries sintéticos (não persistidos) p/ entrar no cálculo da DRE.
//
// Convenção: financialImpact negativo = perda → aumenta CMV → entra POSITIVO.
//            financialImpact positivo = sobra → reduz CMV → entra NEGATIVO.
// Em ambos os casos a magnitude é a mesma; o sinal é invertido pra exibir como despesa.
function buildStockAdjustEntries(period) {
  // Não gera ajustes automáticos quando DB online (usa apenas inventários reais)
  if (typeof isDbOnline === "function" && isDbOnline()) return [];
  const list = MOCK.INVENTORIES || [];
  const out = [];
  list.forEach((inv) => {
    if (inv.status !== "finalized") return;
    if (monthOf(inv.finished_at) !== period) return;
    const counted = (inv.items || []).filter((it) => it.counted != null);
    if (counted.length === 0) return;
    const impact = counted.reduce((s, it) => s + ((it.counted - it.expected) * (it.cost || 0)), 0);
    if (Math.abs(impact) < 0.01) return;
    out.push({
      id:    `AUTO-INV-${inv.id}`,
      cat:   "cat-29", // subcategoria "Ajuste de estoque"
      desc:  `Inventário ${inv.id} · ${inv.responsible || "—"}`,
      value: -impact, // perda (negativo) vira despesa positiva no CMV
      comp:  inv.finished_at ? inv.finished_at.slice(0, 10) : null,
      paid:  inv.finished_at ? inv.finished_at.slice(0, 10) : null,
      status: "auto",
      auto:  "stock-adjust",
    });
  });
  return out;
}

function Finance() {
  const [tab, setTab] = useState("entries");
  const [period, setPeriod] = useState("2026-05");
  const [entries, setEntries] = useState(MOCK.ENTRIES);
  const [categories,    setCategories]    = useState(MOCK.DRE_CATEGORIES);
  const [subcategories, setSubcategories] = useState(MOCK.DRE_SUBCATEGORIES);
  const [checklist, setChecklist] = useState(MOCK.CLOSING_CHECKLIST);
  const [stockSnapshot, setStockSnapshot] = useState({ initial: 0, final: 0, initialAt: null, finalAt: null });
  const [draftOpen, setDraftOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState(null);
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState(null);
  const [viewingSub, setViewingSub] = useState(null); // { sub } — abre modal com lançamentos da subcategoria
  const [fillItem, setFillItem] = useState(null);
  const [addingChecklist, setAddingChecklist] = useState(false);
  const [showStructure, setShowStructure] = useState(false);

  // DB state
  const dbStatus = useDbStatus?.() || { isOnline: false, state: "offline" };
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState("mock");
  const [pageLoading, setPageLoading] = useState(true);

  // Load from DB when period changes
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
        const [catsRes, subsRes, entriesRes, checkRes, snapRes] = await Promise.all([
          dbListDreCategories?.(tid) || { data: null },
          dbListDreSubcategories?.(tid) || { data: null },
          dbListFinanceEntries?.(tid, period) || { data: null },
          dbListClosingChecklist?.(tid, period) || { data: null },
          dbGetStockValueSnapshots?.(tid, period) || { data: null },
        ]);
        if (cancelled) return;
        if (catsRes.data) { setCategories(catsRes.data); setSource("db"); }
        if (subsRes.data) setSubcategories(subsRes.data);
        if (entriesRes.data) setEntries(entriesRes.data);
        if (checkRes.data) setChecklist(checkRes.data);
        if (snapRes.data) setStockSnapshot(snapRes.data);
      } finally {
        if (!cancelled) setPageLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline, period]);

  // Auto-feed do Ajuste de estoque · entries sintéticos vindos de inventários
  const autoEntries = useMemo(() => buildStockAdjustEntries(period), [period]);
  const allEntries  = useMemo(() => [...entries, ...autoEntries], [entries, autoEntries]);
  const inPeriod    = useMemo(() =>
    allEntries.filter((e) => monthOf(e.comp) === period),
  [allEntries, period]);

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
    const draft = { cat: item.cat, desc, value, comp, paid, status };
    if (dbStatus.isOnline && tenantId && typeof dbInsertFinanceEntry === "function") {
      const { data, error } = await dbInsertFinanceEntry(tenantId, draft);
      if (error) {
        window.showToast?.(`Erro ao salvar: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
      const refreshed = await dbListFinanceEntries?.(tenantId, period);
      if (refreshed?.data) setEntries(refreshed.data);
      const newId = data?.id;
      setChecklist(checklist.map((c) => c.id === item.id
        ? { ...c, status: "filled", actual: value, entryIds: [...(c.entryIds || []), newId].filter(Boolean) }
        : c));
      setFillItem(null);
      window.showToast?.("Lançamento salvo", { tone: "ok" });
      return;
    }
    const id = "LAN-" + (1100 + entries.length);
    setEntries([{ id, ...draft }, ...entries]);
    setChecklist(checklist.map((c) => c.id === item.id
      ? { ...c, status: "filled", actual: value, entryIds: [...c.entryIds, id] }
      : c));
    setFillItem(null);
  };

  // ===== CRUD da estrutura =====
  const createCategory = (data) => {
    const slug = String(data.name || "")
      .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const id = `usr-${slug}-${Date.now().toString(36).slice(-4)}`;
    const order = categories.length > 0 ? Math.max(...categories.map((c) => c.order)) + 1 : 1;
    setCategories([...categories, { id, name: data.name.trim(), kind: data.kind, order, locked: false }]);
    window.showToast(`Categoria "${data.name}" criada`, { tone: "ok" });
  };
  const renameCategory = (id, newName) => {
    setCategories(categories.map((c) => c.id === id ? { ...c, name: newName.trim() } : c));
  };
  const deleteCategory = (id) => {
    const cat = categories.find((c) => c.id === id);
    if (!cat || cat.locked) return;
    const subsCount = subcategories.filter((s) => s.category === id).length;
    if (subsCount > 0) {
      window.showToast(`Mova as ${subsCount} subcategoria(s) antes de excluir`, { tone: "warn", ttl: 4500 });
      return;
    }
    setCategories(categories.filter((c) => c.id !== id));
    window.showToast(`Categoria "${cat.name}" excluída`, { tone: "warn" });
  };
  const moveCategory = (id, dir) => {
    const idx = categories.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const target = dir === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= categories.length) return;
    const next = [...categories];
    [next[idx], next[target]] = [next[target], next[idx]];
    next.forEach((c, i) => c.order = i + 1);
    setCategories(next);
  };

  const createSubcategory = (data) => {
    const slug = String(data.name || "")
      .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const id = `usr-sub-${slug}-${Date.now().toString(36).slice(-4)}`;
    const color = data.color || DRE_SUB_COLORS[(subcategories.length) % DRE_SUB_COLORS.length];
    setSubcategories([...subcategories, { id, name: data.name.trim(), category: data.category, color, locked: false }]);
    window.showToast(`Subcategoria "${data.name}" criada`, { tone: "ok" });
  };
  const renameSubcategory = (id, newName) => {
    setSubcategories(subcategories.map((s) => s.id === id ? { ...s, name: newName.trim() } : s));
  };
  const recolorSubcategory = (id, color) => {
    setSubcategories(subcategories.map((s) => s.id === id ? { ...s, color } : s));
  };
  const deleteSubcategory = (id) => {
    const sub = subcategories.find((s) => s.id === id);
    if (!sub || sub.locked) return;
    const usage = entries.filter((e) => e.cat === id).length;
    if (usage > 0) {
      window.showToast(`Há ${usage} lançamento(s) nessa subcategoria · migre antes`, { tone: "warn", ttl: 4500 });
      return;
    }
    setSubcategories(subcategories.filter((s) => s.id !== id));
    window.showToast(`Subcategoria "${sub.name}" excluída`, { tone: "warn" });
  };

  if (pageLoading) return <PageLoading label="Carregando financeiro…" variant="table" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "20px 28px 0" }}>
        <div className="h-eyebrow" style={{ marginBottom: 6 }}>Competência · {MOCK.STOCK_BALANCE.monthLabel}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
          <h1 className="h-title">Financeiro &amp; DRE</h1>
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
            {tab === "dre"       && (
              <>
                <button className="btn" data-size="sm" onClick={() => setShowStructure(true)}>
                  <I.Edit size={13} />Editar estrutura
                </button>
                <button className="btn" data-size="sm" onClick={() => notImplemented("Exportar DRE em PDF")}>Exportar DRE</button>
              </>
            )}
            {tab === "checklist" && <button className="btn" data-variant="primary" data-size="sm" onClick={() => setAddingChecklist(true)}><I.Plus size={13} />Adicionar item</button>}
          </div>
        </div>
        <FinanceTabs tab={tab} setTab={setTab} checklist={checklist} />
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
        {tab === "entries"   && <EntriesView entries={inPeriod} subcategories={subcategories} categories={categories} onEdit={setEditingEntry} onDelete={setConfirmDeleteEntry} />}
        {tab === "dre"       && <DREView entries={inPeriod} categories={categories} subcategories={subcategories} period={period} stockSnapshot={stockSnapshot} onViewSub={setViewingSub} />}
        {tab === "checklist" && <ChecklistView checklist={checklist} categories={categories} subcategories={subcategories} onFill={setFillItem} period={period} />}
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
      {viewingSub && (
        <SubEntriesModal
          sub={viewingSub}
          categories={categories}
          subcategories={subcategories}
          entries={inPeriod}
          period={period}
          onClose={() => setViewingSub(null)}
          onEdit={(entry) => { setViewingSub(null); setEditingEntry(entry); }}
          onDelete={(entry) => setConfirmDeleteEntry(entry)}
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
          onSave={(item) => {
            const id = "chk-" + (1000 + checklist.length);
            setChecklist([{ ...item, id, status: "pending", actual: null, entryIds: [] }, ...checklist]);
            setAddingChecklist(false);
            window.showToast("Item adicionado ao checklist", { tone: "ok" });
          }}
        />
      )}
      {showStructure && (
        <CategoryStructureModal
          categories={categories}
          subcategories={subcategories}
          entries={entries}
          onClose={() => setShowStructure(false)}
          handlers={{
            createCategory, renameCategory, deleteCategory, moveCategory,
            createSubcategory, renameSubcategory, recolorSubcategory, deleteSubcategory,
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

function ChecklistItemDraft({ categories, subcategories, onClose, onSave }) {
  const [label, setLabel]     = useState("");
  const [cat, setCat]         = useState(subcategories[0]?.id);
  const [recurrence, setRec]  = useState("monthly");
  const [due, setDue]         = useState("");
  const [owner, setOwner]     = useState("");
  const [expected, setExp]    = useState("");
  const [required, setReq]    = useState(true);
  const [source, setSource]   = useState("");

  const valid = label.trim() && cat;

  return (
    <ModalShell
      title="Adicionar item ao checklist"
      subtitle="Crie uma obrigação recorrente que aparecerá no fechamento mensal."
      onClose={onClose}
      footer={<>
        <button className="btn" data-size="sm" onClick={onClose}>Cancelar</button>
        <button className="btn" data-variant="primary" data-size="sm" disabled={!valid}
                onClick={() => onSave({
                  label: label.trim(), cat, recurrence,
                  due: due ? Number(due) : null,
                  owner: owner.trim() || "—",
                  expected: parseFloat(String(expected).replace(",", ".")) || 0,
                  required, source: source.trim() || "Manual",
                })}>
          Adicionar item
        </button>
      </>}
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

function FinanceTabs({ tab, setTab, checklist }) {
  const pending = checklist.filter((c) => c.status !== "filled" && c.required).length;
  const tabs = [
    { id: "entries",   label: "Lançamentos" },
    { id: "dre",       label: "DRE" },
    { id: "checklist", label: "Checklist de fechamento", count: pending },
  ];
  return (
    <div style={{ display: "flex", gap: 0, marginTop: 16, borderBottom: "1px solid var(--line)" }}>
      {tabs.map(({ id, label, count }) => {
        const active = tab === id;
        return (
          <button key={id} onClick={() => setTab(id)} style={{
            background: "transparent", border: "none",
            padding: "10px 14px", fontSize: 12.5,
            color: active ? "var(--fg-0)" : "var(--fg-2)",
            fontWeight: active ? 500 : 400, letterSpacing: "-0.005em",
            borderBottom: `2px solid ${active ? "var(--accent-bright)" : "transparent"}`,
            marginBottom: -1, display: "inline-flex", alignItems: "center", gap: 8,
          }}>
            {label}
            {count > 0 && (
              <span style={{
                fontFamily: "var(--mono)", fontSize: 10, padding: "1px 6px",
                background: "rgba(194,132,58,0.14)", color: "var(--warn)",
                border: "1px solid rgba(194,132,58,0.3)", borderRadius: 99, letterSpacing: "0.04em",
              }}>{count}</span>
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

// ---------- DRE ----------
function DREView({ entries, categories, subcategories, period, stockSnapshot = { initial: 0, final: 0 }, onViewSub }) {
  // Agrega valores por categoria/subcategoria
  const byCat = {};
  categories.forEach((c) => { byCat[c.id] = { total: 0, bySub: {} }; });
  entries.forEach((e) => {
    const sub = findSubcategory(subcategories, e.cat);
    if (!sub) return;
    if (!byCat[sub.category]) return;
    // Receita auto-feed via REVENUE_ENTRIES — pulamos aqui pra evitar duplicação
    const cat = findCategory(categories, sub.category);
    if (cat?.kind === "revenue") return;
    byCat[sub.category].total += e.value;
    byCat[sub.category].bySub[sub.id] = (byCat[sub.category].bySub[sub.id] || 0) + e.value;
  });

  // Garante que subcategorias autofeed sempre apareçam, mesmo sem dados no período.
  // Sinaliza ao usuário que a integração existe e está zerada agora.
  subcategories.forEach((sub) => {
    if (!sub.autofeed) return;
    if (!byCat[sub.category]) return;
    if (!(sub.id in byCat[sub.category].bySub)) {
      byCat[sub.category].bySub[sub.id] = 0;
    }
  });

  // Receita bruta vem automaticamente de REVENUE_ENTRIES
  const revBySub = {};
  MOCK.REVENUE_ENTRIES.forEach((e) => {
    if (monthOf(e.date) !== period) return;
    const subId = e.source === "ifood" ? "cat-01" : e.source === "rappi" ? "cat-02" : "cat-03";
    revBySub[subId] = (revBySub[subId] || 0) + e.revenue;
  });
  const revenueTotal = Object.values(revBySub).reduce((s, v) => s + v, 0);
  byCat.receita = { total: revenueTotal, bySub: revBySub };

  // Cálculo da DRE
  const sumByKind = (kinds) => categories
    .filter((c) => kinds.includes(c.kind))
    .reduce((s, c) => s + (byCat[c.id]?.total || 0), 0);

  const receita    = byCat.receita?.total || 0;
  const deducoes   = sumByKind(["deduction"]);
  const receitaLiq = receita - deducoes;
  const cogs       = sumByKind(["cogs"]);
  const lucroBruto = receitaLiq - cogs;
  const opex       = sumByKind(["expense", "financial"]);
  const lucroLiq   = lucroBruto - opex;

  const pct = (v) => receita > 0 ? ((v / receita) * 100).toFixed(1) + "%" : "—";

  // CMV real (método contábil) — usa snapshots do cron diário (EI = início do mês, EF = saldo atual/fim)
  // Fallback: MOCK (modo offline)
  const dbOn = typeof isDbOnline === "function" && isDbOnline();
  const ei = dbOn ? (stockSnapshot.initial || 0) : (MOCK.STOCK_BALANCE?.initial?.value || 0);
  // EF só entra na equação se houver EI registrado (evita distorcer mês sem snapshot inicial)
  const ef = ei > 0
    ? (dbOn ? (stockSnapshot.final || 0) : (MOCK.STOCK_BALANCE?.final?.value || 0))
    : 0;
  // Compras = soma das subcategorias do grupo CMV (lançamentos manuais)
  // CMV real (contábil) = Estoque Inicial + Compras − Estoque Final
  const cmvCatIds = categories
    .filter((c) => c.kind === "cogs" || c.groupSlug === "cmv" || c.id === "cmv")
    .map((c) => c.id);
  const comprasTotal = subcategories
    .filter((s) => cmvCatIds.includes(s.category) && !s.autofeed)
    .reduce((acc, sub) => {
      const catBucket = cmvCatIds.map((cid) => byCat[cid]).find(Boolean);
      return acc + ((catBucket?.bySub?.[sub.id]) || 0);
    }, 0);
  const cmvReal = ei + comprasTotal - ef;

  // Ordena categorias por order (e separa por "side" da DRE)
  const sorted = [...categories].sort((a, b) => a.order - b.order);
  const aboveLucroBruto  = sorted.filter((c) => ["revenue", "deduction", "cogs"].includes(c.kind));
  const belowLucroBruto  = sorted.filter((c) => ["expense", "financial"].includes(c.kind));

  return (
    <div style={{ padding: "20px 28px 32px", display: "flex", flexDirection: "column", gap: 16 }} className="stagger">
      <div className="card" style={{ borderColor: "var(--accent-line)", background: "linear-gradient(180deg, rgba(45,140,102,0.05), transparent 70%)" }}>
        <div className="card-body" style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr 1fr 1fr", gap: 20, alignItems: "center" }}>
          <div>
            <div className="h-eyebrow" style={{ marginBottom: 6 }}>CMV Real · método contábil</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-1)", letterSpacing: "-0.005em" }}>
              {ei > 0
                ? <>Estoque inicial <span style={{ color: "var(--fg-3)" }}>+</span> Compras <span style={{ color: "var(--fg-3)" }}>−</span> Estoque final</>
                : <>Compras <span style={{ color: "var(--fg-3)" }}>(sem inventário inicial)</span></>}
            </div>
          </div>
          <DreStat label={`EI${stockSnapshot.initialAt ? ` · ${fmtDate(stockSnapshot.initialAt)}` : ""}`} value={fmt(ei)} />
          <DreStat label="(+) Compras" value={fmt(comprasTotal)} />
          {ei > 0 && (
            <DreStat label={`EF${stockSnapshot.finalAt ? ` · ${fmtDate(stockSnapshot.finalAt)}` : ""}`} value={fmt(ef)} />
          )}
          <DreStat label="= CMV real" value={fmt(cmvReal)} accent sub={receita ? `${((cmvReal / receita) * 100).toFixed(1)}% da receita` : ""} />
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">DRE · {period.replace("-", "/")}</h3>
            <span className="card-sub" style={{ display: "block", marginTop: 4 }}>Por data de competência · {entries.length} lançamentos · estrutura editável</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <span className="badge" data-tone="ok">Receita {fmt(receita)}</span>
            <span className="badge" data-tone={lucroLiq > 0 ? "ok" : "crit"}>Lucro líq. {fmt(lucroLiq)}</span>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: "44%" }}>Conta</th>
              <th className="num">Valor</th>
              <th className="num">% receita</th>
              <th>Composição</th>
            </tr>
          </thead>
          <tbody>
            {/* Linhas acima do lucro bruto */}
            {aboveLucroBruto.map((c) => {
              const sign = c.kind === "revenue" ? "+" : "−";
              const note = c.kind === "revenue"
                ? "vem de Faturamento"
                : c.id === "cmv"
                  ? "compras + ajuste de estoque automático"
                  : null;
              return (
                <DreRow key={c.id}
                  label={`${sign === "−" ? "(−) " : ""}${c.name}`}
                  value={byCat[c.id]?.total || 0}
                  pct={pct(byCat[c.id]?.total || 0)}
                  sign={sign}
                  strong={c.kind === "revenue"}
                  byCat={byCat[c.id]?.bySub || {}}
                  subcategories={subcategories}
                  note={note}
                  onViewSub={c.kind === "revenue" ? null : onViewSub}
                />
              );
            })}
            <DreSub label="= Receita líquida" value={receitaLiq} pct={pct(receitaLiq)} />
            <DreSub label="= Lucro bruto" value={lucroBruto} pct={pct(lucroBruto)} tone={lucroBruto > 0 ? "ok" : "crit"} />

            {/* Linhas abaixo do lucro bruto */}
            {belowLucroBruto.map((c) => (
              <DreRow key={c.id}
                label={`(−) ${c.name}`}
                value={byCat[c.id]?.total || 0}
                pct={pct(byCat[c.id]?.total || 0)}
                sign="−"
                byCat={byCat[c.id]?.bySub || {}}
                subcategories={subcategories}
                onViewSub={onViewSub}
              />
            ))}

            <DreSub label="= Lucro líquido" value={lucroLiq} pct={pct(lucroLiq)} tone={lucroLiq > 0 ? "ok" : "crit"} bold />
          </tbody>
        </table>
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--line-soft)", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
          * EF projetado · finalize o inventário do mês em <a href="#" style={{ color: "var(--accent-bright)", textDecoration: "none" }}>Estoque → Inventário</a>.
        </div>
      </div>
    </div>
  );
}

function DreStat({ label, value, accent, sub }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</span>
      <span className="mono" style={{ fontSize: 18, fontWeight: 500, color: accent ? "var(--accent-bright)" : "var(--fg-0)", letterSpacing: "-0.018em" }}>{value}</span>
      {sub && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>{sub}</span>}
    </div>
  );
}

function DreRow({ label, value, pct, sign, byCat, subcategories, strong, faded, note, onViewSub }) {
  const [open, setOpen] = useState(false);
  // Mostra subs com valor; mantém também as autofeed zeradas pra indicar integração.
  const subs = byCat ? Object.entries(byCat).filter(([id, v]) => {
    if (Math.abs(v) > 0.001) return true;
    const sub = subcategories?.find((s) => s.id === id);
    return !!sub?.autofeed;
  }) : [];
  const hasDetail = subs.length > 0;
  const display = sign === "−" && value > 0 ? `−${fmt(value)}` : value < 0 ? `+${fmt(-value)}` : fmt(value);
  return (
    <>
      <tr style={{ cursor: hasDetail ? "pointer" : "default", opacity: faded ? 0.65 : 1 }} onClick={() => hasDetail && setOpen(!open)}>
        <td>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: strong ? "var(--fg-0)" : "var(--fg-1)", fontWeight: strong ? 500 : 400 }}>
            {hasDetail && <I.Chevron size={11} style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform 120ms", color: "var(--fg-3)" }} />}
            {!hasDetail && <span style={{ width: 11 }} />}
            {label}
            {note && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", marginLeft: 6 }}>{note}</span>}
          </span>
        </td>
        <td className="num">{display}</td>
        <td className="num" style={{ color: "var(--fg-3)" }}>{pct}</td>
        <td className="dim" style={{ fontSize: 11.5 }}>{subs.length} {subs.length === 1 ? "subcategoria" : "subcategorias"}</td>
      </tr>
      {open && subs.map(([subId, val]) => {
        const sub = subcategories.find((s) => s.id === subId);
        if (!sub) return null;
        const total = value || 1;
        const sharePct = total !== 0 ? (val / total) * 100 : 0;
        const canView = !!onViewSub && !sub.autofeed;
        return (
          <tr key={subId} style={{ background: "var(--bg-2)", cursor: canView ? "pointer" : "default" }}
              onClick={() => canView && onViewSub(sub)}
              title={canView ? "Ver e editar lançamentos desta subcategoria" : undefined}>
            <td style={{ paddingLeft: 36 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--fg-1)" }}>
                <span style={{ width: 4, height: 4, borderRadius: 50, background: sub.color }} />
                {sub.name}
                {sub.autofeed && (
                  <span style={{
                    fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent-bright)",
                    letterSpacing: "0.06em", textTransform: "uppercase", padding: "1px 6px",
                    background: "var(--accent-soft)", border: "1px solid var(--accent-line)", borderRadius: 99,
                    display: "inline-flex", alignItems: "center", gap: 3,
                  }} title="Calculado automaticamente">
                    <I.Bell size={9} />auto
                  </span>
                )}
              </span>
            </td>
            <td className="num" style={{ color: "var(--fg-1)" }}>
              {val < 0 ? "+" : ""}{fmt(Math.abs(val))}
            </td>
            <td className="num" style={{ color: "var(--fg-3)" }}>{Math.abs(sharePct).toFixed(1)}%</td>
            <td className="dim" style={{ fontSize: 11 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span style={{ display: "inline-block", width: 100, height: 3, background: "var(--bg-3)", borderRadius: 1, overflow: "hidden" }}>
                  <span style={{ display: "block", width: `${Math.min(100, Math.abs(sharePct))}%`, height: "100%", background: sub.color }} />
                </span>
                {canView && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--accent-bright)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                    editar →
                  </span>
                )}
              </span>
            </td>
          </tr>
        );
      })}
    </>
  );
}

function DreSub({ label, value, pct, tone, bold }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "crit" ? "var(--crit)" : "var(--fg-0)";
  return (
    <tr style={{ background: "var(--bg-2)" }}>
      <td style={{ borderTop: "1px solid var(--line-strong)", borderBottom: "1px solid var(--line-strong)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: bold ? 14 : 13, color: "var(--fg-0)", fontWeight: 500, letterSpacing: "-0.005em" }}>
          <span style={{ width: 11 }} />
          {label}
        </span>
      </td>
      <td className="num" style={{ borderTop: "1px solid var(--line-strong)", borderBottom: "1px solid var(--line-strong)", fontSize: bold ? 15 : 13, color, fontWeight: 500 }}>{fmt(value)}</td>
      <td className="num" style={{ borderTop: "1px solid var(--line-strong)", borderBottom: "1px solid var(--line-strong)", color: "var(--fg-2)" }}>{pct}</td>
      <td style={{ borderTop: "1px solid var(--line-strong)", borderBottom: "1px solid var(--line-strong)" }} />
    </tr>
  );
}

// ---------- Checklist de fechamento ----------
function ChecklistView({ checklist, categories, subcategories, onFill, period }) {
  const [filter, setFilter] = useState("all");

  const filtered = checklist.filter((c) => {
    if (filter === "pending") return c.status !== "filled";
    if (filter === "filled")  return c.status === "filled";
    return true;
  });

  const totalRequired = checklist.filter((c) => c.required).length;
  const totalFilled   = checklist.filter((c) => c.required && c.status === "filled").length;
  const pendingValue  = checklist.filter((c) => c.status !== "filled").reduce((s, c) => s + (c.expected || 0), 0);
  const progress      = totalRequired > 0 ? (totalFilled / totalRequired) * 100 : 0;

  // Agrupa por categoria DRE (categoria pai da subcategoria)
  const grouped = {};
  categories.forEach((g) => grouped[g.id] = []);
  filtered.forEach((c) => {
    const sub = findSubcategory(subcategories, c.cat);
    if (!sub) return;
    if (grouped[sub.category]) grouped[sub.category].push(c);
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
                {items.map((c) => <ChecklistRow key={c.id} item={c} subcategories={subcategories} onFill={onFill} />)}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function ChecklistRow({ item, subcategories, onFill }) {
  const sub = findSubcategory(subcategories, item.cat);
  const recLabel = { monthly: "Mensal", biweekly: "Quinzenal", weekly: "Semanal", variable: "Variável" }[item.recurrence];
  const statusInfo = {
    filled:    { tone: "ok",   label: "Preenchido" },
    estimated: { tone: "warn", label: "Estimado" },
    pending:   { tone: "crit", label: "Pendente" },
  }[item.status];
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
      <td className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{item.due ? `dia ${String(item.due).padStart(2, "0")}` : "—"}</td>
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
        {item.status !== "filled" && (
          <button className="btn" data-variant="primary" data-size="sm" onClick={() => onFill(item)}>
            Preencher
          </button>
        )}
        {item.status === "filled" && item.entryIds.length > 0 && (
          <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>{item.entryIds.length} lanç.</span>
        )}
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

// ---------- Modal · Estrutura da DRE (CRUD) ----------
function CategoryStructureModal({ categories, subcategories, entries, onClose, handlers }) {
  const [creatingCat, setCreatingCat] = useState(false);
  const [creatingSubFor, setCreatingSubFor] = useState(null); // categoryId
  const [editing, setEditing] = useState(null); // { type: "cat"|"sub", id, value }

  const subCount = (catId) => subcategories.filter((s) => s.category === catId).length;
  const entryCount = (subId) => entries.filter((e) => e.cat === subId).length;
  const sortedCats = [...categories].sort((a, b) => a.order - b.order);

  const startEdit = (type, id, value) => setEditing({ type, id, value });
  const cancelEdit = () => setEditing(null);
  const saveEdit = () => {
    if (!editing) return;
    const v = String(editing.value || "").trim();
    if (!v) { cancelEdit(); return; }
    if (editing.type === "cat") handlers.renameCategory(editing.id, v);
    else                        handlers.renameSubcategory(editing.id, v);
    cancelEdit();
  };

  return (
    <ModalShell
      title="Estrutura da DRE"
      subtitle="Categorias, subcategorias e auto-feeds. Itens travados são essenciais para o fechamento."
      onClose={onClose}
      width={760}
      footer={
        <button className="btn" data-variant="primary" data-size="sm" onClick={onClose}>Concluir</button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Adicionar categoria */}
        {creatingCat ? (
          <NewCategoryRow
            onCancel={() => setCreatingCat(false)}
            onSave={(data) => { handlers.createCategory(data); setCreatingCat(false); }}
          />
        ) : (
          <button className="btn" data-variant="ghost" data-size="sm"
                  onClick={() => setCreatingCat(true)}
                  style={{ alignSelf: "flex-start" }}>
            <I.Plus size={11} />Nova categoria
          </button>
        )}

        {/* Lista de categorias */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sortedCats.map((cat, idx) => {
            const subs = subsByCategory(subcategories, cat.id);
            const isEditing = editing?.type === "cat" && editing.id === cat.id;
            const kindLabel = {
              revenue: "Receita", deduction: "Dedução", cogs: "CMV (custos)",
              expense: "Despesa", financial: "Financeiro",
            }[cat.kind] || cat.kind;
            return (
              <div key={cat.id} className="card" style={{ overflow: "hidden" }}>
                <div className="card-header" style={{ alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                    {/* Ordem · setas */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                      <button type="button" className="btn" data-variant="ghost" data-size="sm"
                              onClick={() => handlers.moveCategory(cat.id, "up")}
                              disabled={idx === 0}
                              style={{ padding: "1px 4px" }} title="Mover para cima">
                        <I.ArrowUp size={9} />
                      </button>
                      <button type="button" className="btn" data-variant="ghost" data-size="sm"
                              onClick={() => handlers.moveCategory(cat.id, "down")}
                              disabled={idx === sortedCats.length - 1}
                              style={{ padding: "1px 4px" }} title="Mover para baixo">
                        <I.ArrowDown size={9} />
                      </button>
                    </div>
                    {/* Ordem badge */}
                    <span style={{
                      fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)",
                      letterSpacing: "0.04em", padding: "2px 6px",
                      background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 3,
                    }}>{idx + 1}</span>
                    {/* Nome (editável ou estático) */}
                    {isEditing ? (
                      <input className="input" autoFocus value={editing.value}
                             onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                             onKeyDown={(e) => {
                               if (e.key === "Enter") saveEdit();
                               if (e.key === "Escape") cancelEdit();
                             }}
                             style={{ flex: 1, minWidth: 0 }} />
                    ) : (
                      <h3 className="card-title" style={{ display: "inline-flex", alignItems: "center", gap: 8, flex: 1 }}>
                        {cat.name}
                        {cat.locked && <I.Lock size={10} style={{ color: "var(--fg-3)" }} />}
                      </h3>
                    )}
                    <span style={{
                      fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)",
                      letterSpacing: "0.04em", textTransform: "uppercase",
                      padding: "2px 6px", border: "1px solid var(--line)", borderRadius: 3,
                    }}>
                      {kindLabel}
                    </span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)" }}>
                      {subs.length} {subs.length === 1 ? "subcategoria" : "subcategorias"}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {isEditing ? (
                      <>
                        <button className="btn" data-size="sm" onClick={cancelEdit}>Cancelar</button>
                        <button className="btn" data-variant="primary" data-size="sm" onClick={saveEdit}>Salvar</button>
                      </>
                    ) : (
                      <>
                        <button className="btn" data-variant="ghost" data-size="sm"
                                onClick={() => startEdit("cat", cat.id, cat.name)}
                                disabled={cat.locked}>
                          <I.Edit size={11} />Renomear
                        </button>
                        <button className="btn" data-variant="ghost" data-size="sm"
                                onClick={() => handlers.deleteCategory(cat.id)}
                                disabled={cat.locked || subs.length > 0}
                                title={cat.locked ? "Categoria essencial · não pode ser excluída"
                                                  : subs.length > 0 ? "Mova as subcategorias antes" : "Excluir categoria"}
                                style={{ color: cat.locked || subs.length > 0 ? "var(--fg-3)" : "var(--crit)" }}>
                          <I.Trash size={11} />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Subs */}
                <div style={{ padding: "8px 16px 12px" }}>
                  {subs.length === 0 ? (
                    <div style={{
                      padding: "10px 12px", fontSize: 11.5, color: "var(--fg-3)",
                      background: "var(--bg-2)", border: "1px dashed var(--line)", borderRadius: 4, textAlign: "center",
                    }}>
                      Sem subcategorias
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {subs.map((sub) => {
                        const isSubEditing = editing?.type === "sub" && editing.id === sub.id;
                        const usage = entryCount(sub.id);
                        return (
                          <div key={sub.id} style={{
                            display: "grid",
                            gridTemplateColumns: "20px 1fr 70px 100px",
                            gap: 8, alignItems: "center",
                            padding: "6px 10px",
                            background: "var(--bg-2)", borderRadius: 3,
                            border: "1px solid var(--line)",
                          }}>
                            <input type="color" value={sub.color}
                                   onChange={(e) => handlers.recolorSubcategory(sub.id, e.target.value)}
                                   disabled={sub.locked}
                                   style={{ width: 16, height: 16, padding: 0, border: "none", background: "transparent", cursor: sub.locked ? "not-allowed" : "pointer" }} />
                            {isSubEditing ? (
                              <input className="input" autoFocus value={editing.value}
                                     onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                                     onKeyDown={(e) => {
                                       if (e.key === "Enter") saveEdit();
                                       if (e.key === "Escape") cancelEdit();
                                     }} />
                            ) : (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--fg-0)", minWidth: 0 }}>
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {sub.name}
                                </span>
                                {sub.locked && <I.Lock size={9} style={{ color: "var(--fg-3)", flexShrink: 0 }} />}
                                {sub.autofeed && (
                                  <span style={{
                                    fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent-bright)",
                                    letterSpacing: "0.06em", textTransform: "uppercase", padding: "1px 5px",
                                    background: "var(--accent-soft)", border: "1px solid var(--accent-line)", borderRadius: 99,
                                    display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0,
                                  }} title={
                                    sub.autofeed === "stock-adjust"
                                      ? "Auto-feed: vem do impacto financeiro dos inventários"
                                      : "Auto-feed: alimentado automaticamente"
                                  }>
                                    <I.Bell size={9} />auto
                                  </span>
                                )}
                              </span>
                            )}
                            <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", letterSpacing: "0.04em", textAlign: "right" }}>
                              {usage} {usage === 1 ? "lanç." : "lançs."}
                            </span>
                            <div style={{ display: "flex", gap: 3, justifyContent: "flex-end" }}>
                              {isSubEditing ? (
                                <>
                                  <button className="btn" data-size="sm" onClick={cancelEdit}>×</button>
                                  <button className="btn" data-variant="primary" data-size="sm" onClick={saveEdit}>Salvar</button>
                                </>
                              ) : (
                                <>
                                  <button className="btn" data-variant="ghost" data-size="sm"
                                          onClick={() => startEdit("sub", sub.id, sub.name)}
                                          disabled={sub.locked}
                                          style={{ padding: "3px 6px" }}>
                                    <I.Edit size={10} />
                                  </button>
                                  <button className="btn" data-variant="ghost" data-size="sm"
                                          onClick={() => handlers.deleteSubcategory(sub.id)}
                                          disabled={sub.locked || usage > 0}
                                          title={sub.locked ? "Subcategoria essencial · não pode ser excluída"
                                                            : usage > 0 ? `Há ${usage} lançamento(s) · migre antes` : "Excluir"}
                                          style={{ padding: "3px 6px", color: sub.locked || usage > 0 ? "var(--fg-3)" : "var(--crit)" }}>
                                    <I.Trash size={10} />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Adicionar sub */}
                  {creatingSubFor === cat.id ? (
                    <NewSubcategoryRow
                      categoryId={cat.id}
                      onCancel={() => setCreatingSubFor(null)}
                      onSave={(data) => { handlers.createSubcategory(data); setCreatingSubFor(null); }}
                    />
                  ) : (
                    <button className="btn" data-variant="ghost" data-size="sm"
                            onClick={() => setCreatingSubFor(cat.id)}
                            style={{ alignSelf: "flex-start", marginTop: 8 }}>
                      <I.Plus size={10} />Nova subcategoria
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Aviso */}
        <div style={{
          padding: "10px 12px",
          background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4,
          display: "flex", alignItems: "flex-start", gap: 10,
          fontSize: 11.5, color: "var(--fg-2)",
        }}>
          <I.AlertTriangle size={12} style={{ color: "var(--fg-3)", marginTop: 2, flexShrink: 0 }} />
          <span>
            <strong style={{ color: "var(--fg-0)" }}>Receita</strong>, <strong style={{ color: "var(--fg-0)" }}>Deduções</strong> e <strong style={{ color: "var(--fg-0)" }}>CMV</strong> são travadas porque alimentam fórmulas do fechamento contábil.{" "}
            <strong style={{ color: "var(--fg-0)" }}>Ajuste de estoque</strong> recebe automaticamente o resultado dos inventários finalizados (perda → despesa positiva, sobra → redução).
          </span>
        </div>
      </div>
    </ModalShell>
  );
}

function NewCategoryRow({ onCancel, onSave }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("expense");
  return (
    <div className="card" style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, background: "var(--bg-2)" }}>
      <input className="input" autoFocus value={name}
             placeholder="Nome da categoria"
             onChange={(e) => setName(e.target.value)}
             onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onSave({ name, kind }); if (e.key === "Escape") onCancel(); }}
             style={{ flex: 1 }} />
      <select className="select" value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 160 }}>
        <option value="expense">Despesa</option>
        <option value="financial">Financeira</option>
        <option value="deduction">Dedução</option>
      </select>
      <button className="btn" data-size="sm" onClick={onCancel}>Cancelar</button>
      <button className="btn" data-variant="primary" data-size="sm"
              disabled={!name.trim()}
              onClick={() => onSave({ name, kind })}>
        <I.Check size={11} />Criar
      </button>
    </div>
  );
}

function NewSubcategoryRow({ categoryId, onCancel, onSave }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(DRE_SUB_COLORS[0]);
  return (
    <div style={{
      marginTop: 8, padding: "8px 10px",
      background: "var(--bg-3)", border: "1px solid var(--line-strong)", borderRadius: 4,
      display: "flex", alignItems: "center", gap: 8,
    }}>
      <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
             style={{ width: 20, height: 20, padding: 0, border: "none", background: "transparent", cursor: "pointer" }} />
      <input className="input" autoFocus value={name}
             placeholder="Nome da subcategoria"
             onChange={(e) => setName(e.target.value)}
             onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onSave({ name, category: categoryId, color }); if (e.key === "Escape") onCancel(); }}
             style={{ flex: 1 }} />
      <button className="btn" data-size="sm" onClick={onCancel}>Cancelar</button>
      <button className="btn" data-variant="primary" data-size="sm"
              disabled={!name.trim()}
              onClick={() => onSave({ name, category: categoryId, color })}>
        <I.Check size={11} />Criar
      </button>
    </div>
  );
}

// ---------- Modal · Lançamentos de uma subcategoria (DRE drill-down) ----------
function SubEntriesModal({ sub, categories, subcategories, entries, period, onClose, onEdit, onDelete }) {
  const cat = sub ? findCategory(categories, sub.category) : null;
  // Lista entries da subcategoria no período (já recebemos `entries` filtrado por período)
  const subEntries = entries
    .filter((e) => e.cat === sub.id && !e.auto)
    .sort((a, b) => (b.comp || "").localeCompare(a.comp || ""));
  const total = subEntries.reduce((s, e) => s + (Number(e.value) || 0), 0);

  return (
    <ModalShell
      title={`${sub.name}`}
      subtitle={`${cat?.name || "—"} · ${period.replace("-", "/")} · ${subEntries.length} lançamento(s)`}
      onClose={onClose}
      width={780}
      footer={<button className="btn" data-variant="primary" data-size="sm" onClick={onClose}>Fechar</button>}
    >
      <div style={{
        padding: "10px 14px", marginBottom: 14,
        background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Σ Total da subcategoria
        </span>
        <span className="mono" style={{ fontSize: 16, fontWeight: 500, color: "var(--fg-0)" }}>
          {fmt(total)}
        </span>
      </div>

      {subEntries.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>
          Sem lançamentos nesta subcategoria neste período.
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Descrição</th>
              <th>Competência</th>
              <th>Pagamento</th>
              <th>Status</th>
              <th className="num">Valor</th>
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {subEntries.map((e) => {
              const tone = e.status === "paid" ? "ok" : e.status === "scheduled" ? "info" : "warn";
              const lbl  = e.status === "paid" ? "Pago" : e.status === "scheduled" ? "Agendado" : "Pendente";
              return (
                <tr key={e.id} style={{ cursor: "pointer" }} onClick={() => onEdit?.(e)}>
                  <td className="row-strong">{e.desc}</td>
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
      )}
    </ModalShell>
  );
}

window.Finance = Finance;
