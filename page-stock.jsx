// Stock page — dense table with allocation drill-down
// Normaliza string p/ busca: minúsculas + sem acentos
function normalizeSearch(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function Stock({ scope }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false };
  const [view, setView] = useState("items"); // items | inventory | suppliers
  const [filter, setFilter] = useState("all"); // all | ok | warn | crit
  const [cats, setCats] = useState([]);   // categorias selecionadas (vazio = todas)
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [items, setItems] = useState(MOCK.STOCK_ITEMS);
  const [categories, setCategories] = useState(() =>
    [...new Set(MOCK.STOCK_ITEMS.map((i) => i.cat))].sort()
  );
  const [dbCategories, setDbCategories] = useState([]); // [{id, name, color}] do DB
  const [suppliers, setSuppliers] = useState([]); // [{id, name}] — usado no select do insumo
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState("mock"); // "db" | "mock"
  const [loading, setLoading] = useState(false);
  const [showEntry, setShowEntry] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editingItem, setEditingItem] = useState(null); // insumo sendo editado

  // Carrega tenant + items + categorias do DB quando online
  useEffect(() => {
    if (!dbStatus.isOnline) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const tid = ctx?.tenant?.id;
      setTenantId(tid || null);
      if (!tid) { setLoading(false); return; }

      const [itemsRes, catsRes, supRes] = await Promise.all([
        dbListStockItems(tid),
        dbListStockCategories(tid),
        dbListSuppliers(tid),
      ]);
      if (cancelled) return;

      if (itemsRes.source === "db") {
        // Mesmo que array vazio, exibe dados reais do DB (não MOCK)
        setItems(itemsRes.data || []);
        setSource("db");
      } else if (itemsRes.error) {
        console.warn("dbListStockItems erro:", itemsRes.error);
      }
      if (catsRes.data) {
        setDbCategories(catsRes.data);
        setCategories(catsRes.data.map((c) => c.name).sort());
      }
      if (supRes?.data) {
        setSuppliers(supRes.data.map((s) => ({ id: s.id, name: s.name })));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.isOnline]);

  const handleCreateItem = async (draft) => {
    if (source === "db" && tenantId) {
      // Resolve catId pelo nome
      let catId = dbCategories.find((c) => c.name === draft.cat)?.id;
      if (!catId && draft.cat) {
        // Cria a categoria se não existir
        const { data: newCat } = await dbInsertStockCategory(tenantId, draft.cat);
        if (newCat) {
          catId = newCat.id;
          setDbCategories((prev) => [...prev, newCat]);
        }
      }
      const { data, error } = await dbInsertStockItem(tenantId, {
        ...draft, catId,
        supplierId: draft.supplierId || null,
        reorder: draft.min, // NewStockItemModal usa "min"
      });
      if (error) {
        window.showToast(`Erro ao criar: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
      setItems((prev) => [data, ...prev]);
      setShowCreate(false);
      window.showToast(`Insumo "${data.name}" criado no Supabase`, { tone: "ok" });
      return;
    }
    // Fallback MOCK
    const nextNum = items.reduce((max, it) => {
      const n = parseInt(String(it.id).replace(/\D/g, ""), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0) + 1;
    const id = `INS-${String(nextNum).padStart(4, "0")}`;
    const supplierName = suppliers.find((s) => s.id === draft.supplierId)?.name || null;
    const newItem = {
      id,
      name: draft.name,
      cat: draft.cat,
      unit: draft.unit,
      cost: draft.cost,
      qty: draft.qty,
      reorder: draft.min,
      max: draft.max,
      usage30d: 0,
      exp: draft.exp || "—",
      supplier: supplierName,
      supplierId: draft.supplierId || null,
      alloc: { burguer: 0, pizzaria: 0, acai: 0, saudavel: 0 },
    };
    newItem.status = recomputeStatus(newItem);
    setItems((prev) => [newItem, ...prev]);
    setCategories((prev) => prev.includes(draft.cat) ? prev : [...prev, draft.cat].sort());
    setShowCreate(false);
    window.showToast(`Insumo ${id} criado (mock)`, { tone: "warn" });
  };

  // ===== Categorias · CRUD =====
  const createCategory = (name) => {
    const v = String(name || "").trim();
    if (!v) return;
    if (allCats.includes(v)) {
      window.showToast(`Categoria "${v}" já existe`, { tone: "warn" });
      return;
    }
    setCategories((prev) => [...prev, v].sort());
    window.showToast(`Categoria "${v}" criada`, { tone: "ok" });
  };

  const renameCategory = (oldName, newName) => {
    const target = String(newName || "").trim();
    if (!target || target === oldName) return;
    const wasMerge = allCats.includes(target);
    setCategories((prev) => {
      const without = prev.filter((c) => c !== oldName);
      return without.includes(target) ? without : [...without, target].sort();
    });
    setItems((prev) => prev.map((it) => it.cat === oldName ? { ...it, cat: target } : it));
    window.showToast(
      wasMerge
        ? `Categoria "${oldName}" mesclada em "${target}"`
        : `Categoria renomeada para "${target}"`,
      { tone: "ok" },
    );
  };

  const deleteCategory = (name) => {
    const inUse = items.some((it) => it.cat === name);
    if (inUse) {
      window.showToast(`Há insumos em "${name}" · migre-os antes de excluir`, { tone: "warn", ttl: 4500 });
      return;
    }
    setCategories((prev) => prev.filter((c) => c !== name));
    window.showToast(`Categoria "${name}" excluída`, { tone: "warn" });
  };

  // Inclui categorias gerenciadas + as que aparecem nos items (caso o item
  // foi criado com cat livre que ainda não foi registrada explicitamente)
  const allCats = useMemo(() =>
    [...new Set([...categories, ...items.map((i) => i.cat)])].sort(),
    [categories, items]
  );

  // Ordem fixa por urgência: ruptura → baixo → ok. Empate: nome alfabético.
  const STATUS_ORDER = { crit: 0, warn: 1, ok: 2 };
  const filtered = useMemo(() => {
    const q = normalizeSearch(search.trim());
    return items
      .filter((i) => {
        if (filter !== "all" && i.status !== filter) return false;
        if (cats.length > 0 && !cats.includes(i.cat)) return false;
        if (scope !== "all" && i.alloc[scope] === 0) return false;
        if (q && !normalizeSearch(i.name).includes(q) && !normalizeSearch(i.id).includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        const sa = STATUS_ORDER[a.status] ?? 9;
        const sb = STATUS_ORDER[b.status] ?? 9;
        if (sa !== sb) return sa - sb;
        return a.name.localeCompare(b.name, "pt-BR");
      });
  }, [items, filter, cats, search, scope]);

  const totals = {
    ok:   items.filter((i) => i.status === "ok").length,
    warn: items.filter((i) => i.status === "warn").length,
    crit: items.filter((i) => i.status === "crit").length,
  };

  const totalValue = filtered.reduce((s, i) => s + i.qty * i.cost, 0);

  // Recalcula status (ok / warn / crit) com base em qty x reorder
  const recomputeStatus = (it) => {
    if (it.qty <= 0) return "crit";
    if (it.reorder > 0 && it.qty < it.reorder * 0.25) return "crit";
    if (it.qty < it.reorder) return "warn";
    return "ok";
  };

  const handleEntry = async ({ itemId, qty, cost, note }) => {
    const before = items.find((it) => it.id === itemId);
    // Update otimista
    setItems((prev) => prev.map((it) => {
      if (it.id !== itemId) return it;
      const newQty = it.qty + qty;
      const newCost = cost > 0 && qty > 0
        ? Number((((it.qty * it.cost) + (qty * cost)) / Math.max(newQty, 0.0001)).toFixed(2))
        : it.cost;
      const updated = { ...it, qty: newQty, cost: newCost };
      return { ...updated, status: recomputeStatus(updated) };
    }));
    setShowEntry(false);

    if (source === "db" && tenantId) {
      const { error } = await dbApplyStockMovement(
        tenantId, itemId, qty, "in",
        note || "Entrada manual",
        cost,
      );
      if (error) {
        // Rollback
        if (before) setItems((prev) => prev.map((it) => it.id === itemId ? before : it));
        window.showToast(`Erro ao salvar entrada: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
      // Refetch p/ refletir qty/custo autoritativo do banco (trigger recalcula)
      const { data: refreshed } = await dbListStockItems(tenantId);
      if (refreshed) setItems(refreshed);
      window.showToast(`+${qty} registrado no Supabase · ${note || "entrada manual"}`, { tone: "ok" });
      return;
    }
    window.showToast(`+${qty} registrado · ${note || "entrada manual"}`, { tone: "ok" });
  };

  // Liga/desliga "Compor CMV" — itens com false são excluídos do cálculo de CMV
  // (ex.: embalagens que estão estocadas mas não fazem parte do custo de venda).
  const toggleComposeCmv = async (id) => {
    const item = items.find((it) => it.id === id);
    if (!item) return;
    const nowOn = !(item.composeCmv ?? true);
    // Update otimista
    setItems((prev) => prev.map((it) => it.id === id ? { ...it, composeCmv: nowOn } : it));

    if (source === "db") {
      const { error } = await dbUpdateStockItem(id, { composeCmv: nowOn });
      if (error) {
        // Rollback
        setItems((prev) => prev.map((it) => it.id === id ? { ...it, composeCmv: !nowOn } : it));
        window.showToast(`Erro ao atualizar: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
    } else {
      // Mock-only · mutar MOCK pra refletir no CMV sibling
      const mockItem = MOCK.STOCK_ITEMS.find((it) => it.id === id);
      if (mockItem) mockItem.composeCmv = nowOn;
    }
    window.showToast(
      nowOn ? `${item.name} agora compõe o CMV` : `${item.name} excluído do CMV`,
      { tone: nowOn ? "ok" : "warn", ttl: 3500 },
    );
  };

  const handleDeleteItem = async (id) => {
    const item = items.find((it) => it.id === id);
    const label = item?.name || id;
    if (source === "db") {
      const { error } = await dbDeleteStockItem(id);
      if (error) {
        window.showToast(`Erro ao excluir: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
      setItems((prev) => prev.filter((it) => it.id !== id));
      setEditingItem(null);
      window.showToast(`Insumo "${label}" excluído`, { tone: "ok" });
      return;
    }
    // Fallback MOCK
    setItems((prev) => prev.filter((it) => it.id !== id));
    setEditingItem(null);
    window.showToast(`Insumo "${label}" excluído (mock)`, { tone: "warn" });
  };

  const handleEditItem = async (id, draft) => {
    if (source === "db") {
      // Resolve catId pelo nome (cria se necessário)
      let catId = dbCategories.find((c) => c.name === draft.cat)?.id;
      if (!catId && draft.cat) {
        const { data: newCat } = await dbInsertStockCategory(tenantId, draft.cat);
        if (newCat) {
          catId = newCat.id;
          setDbCategories((prev) => [...prev, newCat]);
        }
      }
      const { data, error } = await dbUpdateStockItem(id, {
        name: draft.name, unit: draft.unit, cost: draft.cost,
        reorder: draft.min, max: draft.max,
        exp: draft.exp, catId,
        supplierId: draft.supplierId || null,
      });
      if (error) {
        window.showToast(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
      setItems((prev) => prev.map((it) => it.id === id ? data : it));
      setEditingItem(null);
      window.showToast(`Insumo atualizado no Supabase`, { tone: "ok" });
      return;
    }
    // Fallback MOCK (comportamento original)
    setItems((prev) => prev.map((it) => {
      if (it.id !== id) return it;
      // qty/alloc preservados — só metadados editáveis aqui
      const supplierName = suppliers.find((s) => s.id === draft.supplierId)?.name || null;
      const updated = {
        ...it,
        name: draft.name,
        cat:  draft.cat,
        unit: draft.unit,
        cost: draft.cost,
        reorder: draft.min,
        max: draft.max,
        exp: draft.exp || it.exp,
        supplier:   supplierName,
        supplierId: draft.supplierId || null,
      };
      return { ...updated, status: recomputeStatus(updated) };
    }));
    setCategories((prev) => prev.includes(draft.cat) ? prev : [...prev, draft.cat].sort());
    setEditingItem(null);
    window.showToast(`Insumo ${id} atualizado`, { tone: "ok" });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Sub-tabs Insumos | Inventário */}
      <div style={{ display: "flex", padding: "14px 28px 0", gap: 0, borderBottom: "1px solid var(--line)" }}>
        <StockSubTab active={view === "items"}     onClick={() => setView("items")}    >Insumos</StockSubTab>
        <StockSubTab active={view === "inventory"} onClick={() => setView("inventory")}>Inventário</StockSubTab>
        <StockSubTab active={view === "suppliers"} onClick={() => setView("suppliers")}>Fornecedores</StockSubTab>
        <StockSubTab active={view === "categories"} onClick={() => setView("categories")}>Categorias</StockSubTab>
      </div>

      {view === "inventory" ? (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <Inventory />
        </div>
      ) : view === "suppliers" ? (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "20px 28px 32px" }}>
          <SuppliersView />
        </div>
      ) : view === "categories" ? (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "20px 28px 32px" }}>
          <CategoriesView
            categories={allCats}
            items={items}
            onCreate={createCategory}
            onRename={renameCategory}
            onDelete={deleteCategory}
          />
        </div>
      ) : (<>
      {/* Header */}
      <div style={{ padding: "20px 28px 16px", display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div className="h-eyebrow" style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 10 }}>
            Estoque físico compartilhado · {items.length} SKUs
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase",
              padding: "2px 7px", borderRadius: 99,
              color: source === "db" ? "var(--ok)" : "var(--fg-3)",
              background: source === "db" ? "var(--accent-soft)" : "var(--bg-2)",
              border: `1px solid ${source === "db" ? "var(--accent-line)" : "var(--line)"}`,
            }} title={source === "db" ? "Carregado do Supabase" : "Modo MOCK · não persiste"}>
              <span style={{ width: 5, height: 5, borderRadius: 50, background: source === "db" ? "var(--ok)" : "var(--fg-3)" }} />
              {loading ? "carregando…" : source === "db" ? "Supabase" : "Mock"}
            </span>
          </div>
          <h1 className="h-title">Estoque</h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" data-size="sm" onClick={() => setShowHistory(true)}>Histórico</button>
          <button className="btn" data-size="sm" onClick={() => setShowEntry(true)}>
            <I.Plus size={13} />Entrada manual
          </button>
          <button className="btn" data-variant="primary" data-size="sm" onClick={() => setShowCreate(true)}>
            <I.Plus size={13} />Novo insumo
          </button>
        </div>
      </div>

      {/* Filter strip */}
      <div style={{ padding: "0 28px 14px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
        <Tabs value={filter} onChange={setFilter} options={[
          { id: "all",  label: "Todos",     count: items.length },
          { id: "ok",   label: "Em estoque", count: totals.ok,    tone: "ok" },
          { id: "warn", label: "Baixo",      count: totals.warn,  tone: "warn" },
          { id: "crit", label: "Ruptura",    count: totals.crit,  tone: "crit" },
        ]} />
        <span style={{ flex: 1 }} />
        <StockSearchInput value={search} onChange={setSearch} />
        <CategoryFilter allCats={allCats} selected={cats} onChange={setCats} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-2)" }}>
          Valor: <span style={{ color: "var(--fg-0)" }}>R$ {totalValue.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </span>
      </div>

      {/* Resumo do filtro ativo · só aparece quando há algo filtrado */}
      {(search.trim() || cats.length > 0) && (
        <div style={{
          padding: "8px 28px", display: "flex", alignItems: "center", gap: 10,
          borderBottom: "1px solid var(--line-soft)", background: "var(--bg-2)",
          fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-2)", letterSpacing: "0.02em",
        }}>
          <span style={{ color: "var(--fg-3)" }}>
            {filtered.length} {filtered.length === 1 ? "resultado" : "resultados"}
          </span>
          {search.trim() && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              · busca "<span style={{ color: "var(--fg-0)" }}>{search}</span>"
            </span>
          )}
          {cats.length > 0 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              · {cats.length} {cats.length === 1 ? "categoria" : "categorias"}: <span style={{ color: "var(--fg-0)" }}>{cats.join(", ")}</span>
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" data-variant="ghost" data-size="sm"
                  onClick={() => { setSearch(""); setCats([]); }}>
            Limpar filtros
          </button>
        </div>
      )}

      {/* Two-pane */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: selected ? "1fr 380px" : "1fr", overflow: "hidden" }}>
        <div style={{ overflow: "auto" }}>
          <table className="table" data-density="compact">
            <thead>
              <tr>
                <th style={{ width: 90 }}>ID</th>
                <th>Insumo</th>
                <th>Categoria</th>
                <th>Status</th>
                <th className="num">Qtd</th>
                <th className="num">Custo médio</th>
                <th className="num">Valor total</th>
                <th className="num">Mín / Máx</th>
                <th>Validade</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => {
                const tone = it.status === "ok" ? "ok" : it.status === "warn" ? "warn" : "crit";
                const lbl = it.status === "ok" ? "OK" : it.status === "warn" ? "BAIXO" : "RUPTURA";
                const isSelected = selected?.id === it.id;
                return (
                  <tr key={it.id} onClick={() => setSelected(it)} style={{ cursor: "pointer", background: isSelected ? "var(--bg-hover)" : null }}>
                    <td className="mono" style={{ color: "var(--fg-3)", fontSize: 10.5 }}>{it.id}</td>
                    <td className="row-strong">{it.name}</td>
                    <td className="dim">{it.cat}</td>
                    <td><span className="badge" data-tone={tone}>{lbl}</span></td>
                    <td className="num" style={{ color: it.qty === 0 ? "var(--crit)" : null }}>{it.qty} {it.unit}</td>
                    <td className="num">R$ {it.cost.toFixed(2)}</td>
                    <td className="num">R$ {(it.qty * it.cost).toFixed(2)}</td>
                    <td className="num" style={{ color: "var(--fg-2)" }}>
                      {it.reorder} <span style={{ color: "var(--fg-4)" }}>/</span> {it.max ?? "—"} {it.unit}
                    </td>
                    <td className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{it.exp}</td>
                    <td onClick={(e) => e.stopPropagation()} style={{ width: 1, whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <ComposeCmvToggle on={it.composeCmv ?? true} onToggle={() => toggleComposeCmv(it.id)} />
                        <button className="btn" data-variant="ghost" data-size="sm"
                                onClick={() => setEditingItem(it)}
                                title="Editar dados do insumo">
                          <I.Edit size={11} />Editar
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {selected && <AllocationPanel item={selected} onClose={() => setSelected(null)} />}
      </div>
      </>)}

      {showEntry  && <StockEntryModal items={items} onClose={() => setShowEntry(false)} onSave={handleEntry} />}
      {showHistory && <StockHistoryModal onClose={() => setShowHistory(false)} />}
      {showCreate && <NewStockItemModal items={items} categories={allCats} suppliers={suppliers} onClose={() => setShowCreate(false)} onSave={handleCreateItem} />}
      {editingItem && (
        <NewStockItemModal
          items={items}
          categories={allCats}
          suppliers={suppliers}
          initial={editingItem}
          onClose={() => setEditingItem(null)}
          onSave={(draft) => handleEditItem(editingItem.id, draft)}
          onDelete={() => handleDeleteItem(editingItem.id)}
        />
      )}
    </div>
  );
}

// Modal usado tanto para criar (sem `initial`) quanto editar (com `initial`).
// Em modo edição, a quantidade atual NÃO é exibida nem editada — saldo só
// muda via Entrada manual ou Inventário.
function NewStockItemModal({ items, initial, categories, suppliers = [], onClose, onSave, onDelete }) {
  const isEdit = !!initial;
  // Categorias gerenciadas (passadas pelo Stock); caso ausente, deriva dos items.
  const existingCats = categories && categories.length
    ? categories
    : [...new Set(items.map((i) => i.cat))];
  const [name, setName] = useState(initial?.name ?? "");
  const [cat,  setCat]  = useState(initial?.cat  ?? (existingCats[0] || "Outro"));
  const [unit, setUnit] = useState(initial?.unit ?? "kg");
  const [cost, setCost] = useState(initial?.cost != null ? String(initial.cost) : "");
  const [qty,  setQty]  = useState("0"); // só usado em modo criação
  const [min,  setMin]  = useState(initial?.reorder != null ? String(initial.reorder) : "");
  const [max,  setMax]  = useState(initial?.max     != null ? String(initial.max)     : "");
  const [exp,  setExp]  = useState(initial?.exp && initial.exp !== "—" ? initial.exp : "");
  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? "");
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const minN  = parseFloat(String(min).replace(",", "."));
  const maxN  = parseFloat(String(max).replace(",", "."));
  const valid = name.trim()
    && cat.trim()
    && unit.trim()
    && Number.isFinite(minN) && minN >= 0
    && Number.isFinite(maxN) && maxN > minN;

  const handleSubmit = async () => {
    if (saving || !valid) return;
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        cat:  cat.trim(),
        unit: unit.trim(),
        cost: parseFloat(String(cost).replace(",", ".")) || 0,
        ...(isEdit ? {} : { qty: parseFloat(String(qty).replace(",", ".")) || 0 }),
        min:  minN,
        max:  maxN,
        exp:  exp.trim(),
        supplierId: supplierId || null,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (deleting || !onDelete) return;
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      title={isEdit ? "Editar insumo" : "Novo insumo"}
      subtitle={isEdit
        ? `${initial.id} · saldo atual ${initial.qty} ${initial.unit} (não editável aqui)`
        : "Cadastre um item no estoque com mínimo e máximo."}
      onClose={saving || deleting ? undefined : onClose}
      footer={confirmingDelete ? (
        <>
          <span style={{ marginRight: "auto", fontSize: 12, color: "var(--fg-1)" }}>
            Excluir <strong style={{ color: "var(--fg-0)" }}>{initial?.name || "este insumo"}</strong>? Essa ação não pode ser desfeita.
          </span>
          <button className="btn" data-size="sm" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
            Cancelar
          </button>
          <button className="btn" data-variant="danger" data-size="sm" onClick={handleDelete} disabled={deleting}>
            {deleting ? "Excluindo…" : "Excluir definitivamente"}
          </button>
        </>
      ) : (
        <>
          {isEdit && onDelete && (
            <button className="btn" data-variant="danger" data-size="sm"
                    onClick={() => setConfirmingDelete(true)} disabled={saving}
                    style={{ marginRight: "auto" }}>
              <I.Trash size={12} />Excluir insumo
            </button>
          )}
          <button className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
          <button className="btn" data-variant="primary" data-size="sm" disabled={!valid || saving}
                  onClick={handleSubmit}>
            {saving ? "Salvando…" : (isEdit ? "Salvar alterações" : "Cadastrar insumo")}
          </button>
        </>
      )}
      width={560}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <FormRow label="Nome do insumo">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Farinha de trigo integral" />
        </FormRow>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 0.8fr 1fr", gap: 12 }}>
          <FormRow label="Categoria">
            <select className="select" value={cat} onChange={async (e) => {
              const v = e.target.value;
              if (v === "__new__") {
                const name = window.prompt("Nome da nova categoria:");
                if (!name || !name.trim()) return;
                setCat(name.trim());
                if (typeof window.onCreateStockCategory === "function") {
                  await window.onCreateStockCategory(name.trim());
                }
                return;
              }
              setCat(v);
            }} required>
              <option value="" disabled>Selecione…</option>
              {existingCats.map((c) => <option key={c} value={c}>{c}</option>)}
              <option value="__new__">+ Criar categoria…</option>
            </select>
          </FormRow>
          <FormRow label="Unidade">
            <select className="select" value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option value="kg">kg</option>
              <option value="und">und</option>
            </select>
          </FormRow>
          <FormRow label="Custo unit. (R$)">
            <input className="input mono" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0,00" />
          </FormRow>
        </div>

        <div style={{
          display: "grid",
          gridTemplateColumns: isEdit ? "1fr 1fr" : "1fr 1fr 1fr",
          gap: 12,
        }}>
          <FormRow label={`Estoque mínimo (${unit})`} hint="Aciona compra quando atingir.">
            <input className="input mono" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} placeholder="0" />
          </FormRow>
          <FormRow label={`Estoque máximo (${unit})`} hint="Quantidade alvo após compra.">
            <input className="input mono" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} placeholder="0" />
          </FormRow>
          {!isEdit && (
            <FormRow label={`Quantidade inicial (${unit})`}>
              <input className="input mono" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" />
            </FormRow>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <FormRow label="Validade (opcional)" hint="Formato livre · ex.: 12/05 ou 06/2027">
            <input className="input mono" value={exp} onChange={(e) => setExp(e.target.value)} placeholder="—" />
          </FormRow>
          <FormRow label="Fornecedor (opcional)" hint={suppliers.length === 0 ? "Cadastre em Estoque › Fornecedores" : "Selecione um fornecedor"}>
            <select className="select" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} disabled={suppliers.length === 0}>
              <option value="">— Sem fornecedor —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </FormRow>
        </div>

        {Number.isFinite(minN) && Number.isFinite(maxN) && maxN <= minN && (
          <div style={{ fontSize: 11.5, color: "var(--warn)" }}>
            Estoque máximo precisa ser maior que o mínimo.
          </div>
        )}

        {isEdit && (
          <div style={{
            padding: "10px 12px", background: "var(--bg-2)",
            border: "1px solid var(--line)", borderRadius: 4,
            display: "flex", alignItems: "center", gap: 10,
            fontSize: 11.5, color: "var(--fg-2)",
          }}>
            <I.AlertTriangle size={12} style={{ color: "var(--fg-3)" }} />
            <span>
              O <strong style={{ color: "var(--fg-0)" }}>saldo atual</strong> não é alterado por aqui —
              use <strong>Entrada manual</strong> ou um <strong>Inventário</strong> pra mexer no estoque.
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}

function StockEntryModal({ items, onClose, onSave }) {
  const [itemId, setItemId] = useState(items[0]?.id || "");
  const [qty,    setQty]    = useState("");
  const [cost,   setCost]   = useState("");
  const [note,   setNote]   = useState("");
  const item = items.find((i) => i.id === itemId);
  const valid = itemId && parseFloat(qty) > 0;

  const submit = (e) => {
    e.preventDefault();
    if (!valid) return;
    onSave({
      itemId,
      qty:  parseFloat(String(qty).replace(",", ".")),
      cost: parseFloat(String(cost).replace(",", ".")) || 0,
      note: note.trim(),
    });
  };

  return (
    <Modal title="Entrada manual de estoque" subtitle="Registre uma compra recebida ou ajuste positivo." onClose={onClose}
      footer={<>
        <button className="btn" data-size="sm" onClick={onClose}>Cancelar</button>
        <button className="btn" data-variant="primary" data-size="sm" onClick={submit} disabled={!valid}>Confirmar entrada</button>
      </>}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <FormRow label="Insumo">
          <select className="select" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
          </select>
        </FormRow>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <FormRow label={`Qtd (${item?.unit || ""})`}>
            <input className="input mono" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" />
          </FormRow>
          <FormRow label="Custo unit. (R$)" hint="Atualiza custo médio">
            <input className="input mono" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0,00" />
          </FormRow>
        </div>
        <FormRow label="Nota / NF">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: NF 8423 · Hortifruti" />
        </FormRow>
      </form>
    </Modal>
  );
}

// Mock dos últimos 30 dias · usado só quando o Supabase está offline,
// pra UI não ficar quebrada durante desenvolvimento sem backend.
function buildMockMovements() {
  // Catálogo curto p/ amostra (insumo + un + op preferida)
  const catalog = [
    { item: "Muçarela bola",         unit: "kg", op: "PIZZ" },
    { item: "Carne 80/20",            unit: "kg", op: "BURG" },
    { item: "Tomate italiano",        unit: "kg", op: "—"    },
    { item: "Farinha 00",             unit: "kg", op: "PIZZ" },
    { item: "Embalagem isopor 500",   unit: "und", op: "AÇAÍ" },
    { item: "Alface americana",       unit: "und", op: "VERDE"},
    { item: "Cheddar fatiado",        unit: "kg", op: "BURG" },
    { item: "Polpa de açaí 1kg",      unit: "und", op: "AÇAÍ" },
    { item: "Pão brioche burguer",    unit: "und", op: "BURG" },
    { item: "Cebola roxa",            unit: "kg", op: "PIZZ" },
    { item: "Bacon em cubos",         unit: "kg", op: "BURG" },
    { item: "Calabresa defumada",     unit: "kg", op: "PIZZ" },
    { item: "Frango peito desfiado",  unit: "kg", op: "VERDE"},
    { item: "Banana nanica",          unit: "kg", op: "AÇAÍ" },
    { item: "Granola sem açúcar",     unit: "kg", op: "AÇAÍ" },
    { item: "Pote PP 750ml",          unit: "und", op: "VERDE"},
  ];
  const kinds = ["in", "out", "out", "out", "out", "loss"]; // ~enviesado p/ saídas
  const refs = {
    in:   ["NF 8423", "NF 8401", "NF 8388", "NF 8369", "NF 8290", "NF 8254"],
    out:  ["REQ-0418", "REQ-0413", "REQ-0399", "REQ-0408", "REQ-0381", "REQ-0376", "REQ-0349", "REQ-0322", "REQ-0298"],
    loss: ["vencimento", "quebra", "amostra", "descarte"],
  };

  // Hoje 21:00 como âncora (vamos voltando)
  const today = new Date(); today.setHours(20, 30, 0, 0);
  const list = [];
  let cursor = new Date(today.getTime());

  // ~6 movimentos hoje, 4 ontem, depois 1-3 por dia até 30d atrás
  const plan = [];
  // Hoje
  for (let i = 0; i < 6; i++) plan.push(0);
  // Ontem
  for (let i = 0; i < 4; i++) plan.push(1);
  // 2 a 7 dias atrás · ~2/dia
  for (let d = 2; d <= 7; d++) for (let i = 0; i < 2; i++) plan.push(d);
  // 8 a 30 dias atrás · ~1/dia
  for (let d = 8; d <= 30; d++) plan.push(d);

  let idx = 0;
  for (const dayOffset of plan) {
    const c = catalog[idx % catalog.length];
    const k = kinds[idx % kinds.length];
    const refSet = refs[k];
    const ref = refSet[idx % refSet.length];
    // hora aleatória estável (determinística por idx)
    const hour = 7 + (idx * 3) % 14;
    const minute = (idx * 17) % 60;
    const at = new Date(today);
    at.setDate(today.getDate() - dayOffset);
    at.setHours(hour, minute, 0, 0);
    let delta = 0;
    if (k === "in")   delta = +(2 + (idx % 5));
    if (k === "out")  delta = -(0.5 * (1 + (idx % 4)));
    if (k === "loss") delta = -(1 + (idx % 3));
    if (c.unit === "und") delta = Math.round(delta * 8); // unidades em volume maior
    list.push({
      at: at.toISOString(),
      item: c.item, unit: c.unit, op: k === "in" ? "—" : c.op,
      kind: k, delta, ref,
    });
    idx += 1;
  }
  // Mais recente primeiro
  return list.sort((a, b) => b.at.localeCompare(a.at));
}

function StockHistoryModal({ onClose }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false };
  const [period, setPeriod] = useState("7d"); // today | yesterday | 7d | 30d
  const [movements, setMovements] = useState([]);
  const [source, setSource] = useState("mock"); // "db" | "mock"
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Data limite p/ filtragem
  const range = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    if (period === "today") {
      return { from: startOfToday, to: null };
    }
    if (period === "yesterday") {
      const startOfYest = new Date(startOfToday); startOfYest.setDate(startOfYest.getDate() - 1);
      return { from: startOfYest, to: startOfToday };
    }
    if (period === "7d") {
      const c = new Date(now); c.setDate(c.getDate() - 7);
      return { from: c, to: null };
    }
    const c = new Date(now); c.setDate(c.getDate() - 30);
    return { from: c, to: null };
  }, [period]);

  // Carrega movimentações reais do Supabase quando online · refaz a cada período.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        if (dbStatus.isOnline) {
          const ctx = await dbGetCurrentContext();
          if (cancelled) return;
          const tid = ctx?.tenant?.id;
          if (!tid) { setMovements([]); setSource("db"); return; }
          const res = await dbListStockMovements(
            tid,
            range.from?.toISOString(),
            range.to?.toISOString(),
            { limit: 1000 },
          );
          if (cancelled) return;
          if (res.error) {
            console.warn("dbListStockMovements erro:", res.error);
            setError(res.error.message || "Falha ao carregar histórico");
            setMovements([]); setSource("db");
            return;
          }
          setMovements(res.data || []);
          setSource(res.source === "db" ? "db" : "mock");
        } else {
          // Offline · usa mock só pra UI não quebrar
          setMovements(buildMockMovements());
          setSource("mock");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.isOnline, range.from, range.to]);

  // Quando vem do banco já vem filtrado pelo range; mock precisa filtrar no cliente
  const filtered = useMemo(() => {
    if (source === "db") return movements;
    return movements.filter((m) => {
      const d = new Date(m.at);
      if (range.from && d < range.from) return false;
      if (range.to   && d >= range.to)  return false;
      return true;
    });
  }, [movements, range, source]);

  // Resumo · entradas, saídas e perdas no período (expiration conta como perda)
  const summary = useMemo(() => {
    const s = { in: 0, out: 0, loss: 0 };
    filtered.forEach((m) => {
      const bucket = m.kind === "in" ? "in"
                   : (m.kind === "loss" || m.kind === "expiration") ? "loss"
                   : "out";
      s[bucket] += 1;
    });
    return s;
  }, [filtered]);

  const fmtAt = (iso) => {
    const d = new Date(iso);
    const day = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"][d.getDay()];
    const pad = (n) => String(n).padStart(2, "0");
    return `${day} ${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const periodLabel = {
    today: "hoje", yesterday: "ontem", "7d": "últimos 7 dias", "30d": "últimos 30 dias",
  }[period];

  const kindLabel = (k) => k === "in" ? "Entrada"
                        : k === "loss" ? "Perda"
                        : k === "expiration" ? "Vencimento"
                        : k === "adjust" ? "Ajuste"
                        : "Saída";
  const kindTone = (k) => k === "in" ? "ok"
                       : (k === "loss" || k === "expiration") ? "crit"
                       : k === "adjust" ? "warn"
                       : "neutral";

  return (
    <Modal
      title="Histórico de movimentações"
      subtitle={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          {loading ? "carregando…" : `${filtered.length} ${filtered.length === 1 ? "movimentação" : "movimentações"} · ${periodLabel}`}
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase",
            padding: "2px 7px", borderRadius: 99,
            color: source === "db" ? "var(--ok)" : "var(--fg-3)",
            background: source === "db" ? "var(--accent-soft)" : "var(--bg-2)",
            border: `1px solid ${source === "db" ? "var(--accent-line)" : "var(--line)"}`,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: 50, background: source === "db" ? "var(--ok)" : "var(--fg-3)" }} />
            {source === "db" ? "Supabase" : "Mock"}
          </span>
        </span>
      }
      onClose={onClose}
      width={760}
    >
      {/* Filtros de período + resumo */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        padding: "8px 10px", background: "var(--bg-2)",
        border: "1px solid var(--line)", borderRadius: 4, marginBottom: 14,
      }}>
        <Tabs value={period} onChange={setPeriod} options={[
          { id: "today",     label: "Hoje" },
          { id: "yesterday", label: "Ontem" },
          { id: "7d",        label: "7 dias" },
          { id: "30d",       label: "30 dias" },
        ]} />
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-2)", display: "flex", gap: 12 }}>
          <span><span style={{ color: "var(--ok)" }}>{summary.in}</span> entradas</span>
          <span><span style={{ color: "var(--fg-0)" }}>{summary.out}</span> saídas</span>
          <span><span style={{ color: "var(--crit)" }}>{summary.loss}</span> perdas</span>
        </span>
      </div>

      {error && (
        <div style={{
          padding: "10px 12px", marginBottom: 12,
          background: "var(--crit-soft)", border: "1px solid var(--crit)", borderRadius: 4,
          fontSize: 12, color: "var(--crit)",
        }}>
          Erro ao carregar do Supabase: {error}
        </div>
      )}

      <div style={{ maxHeight: 480, overflow: "auto" }}>
        <table className="table" data-density="compact">
          <thead style={{ position: "sticky", top: 0, background: "var(--bg-1)", zIndex: 1 }}>
            <tr>
              <th>Quando</th>
              <th>Insumo</th>
              <th>Tipo</th>
              <th className="num">Delta</th>
              <th>Operação</th>
              <th>Ref.</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="dim" style={{ textAlign: "center", padding: 32 }}>
                  Carregando movimentações…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="dim" style={{ textAlign: "center", padding: 32 }}>
                  Nenhuma movimentação no período selecionado.
                </td>
              </tr>
            ) : filtered.map((m) => (
              <tr key={m.id ?? `${m.at}-${m.item}-${m.delta}`}>
                <td className="mono dim" style={{ fontSize: 11 }}>{fmtAt(m.at)}</td>
                <td className="row-strong">{m.item}</td>
                <td><span className="badge" data-tone={kindTone(m.kind)}>{kindLabel(m.kind)}</span></td>
                <td className="num" style={{ color: m.delta > 0 ? "var(--ok)" : (m.kind === "loss" || m.kind === "expiration") ? "var(--crit)" : "var(--fg-1)" }}>
                  {m.delta > 0 ? "+" : ""}{m.delta} {m.unit}
                </td>
                <td className="dim mono" style={{ fontSize: 10.5 }}>{m.op}</td>
                <td className="dim">{m.ref}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function Tabs({ value, onChange, options }) {
  return (
    <div style={{ display: "flex", gap: 0, padding: 2, background: "var(--bg-2)", borderRadius: 4, border: "1px solid var(--line)" }}>
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "5px 12px",
              background: active ? "var(--bg-3)" : "transparent",
              border: "none",
              borderRadius: 2,
              fontSize: 12, color: active ? "var(--fg-0)" : "var(--fg-2)",
              fontFamily: "var(--sans)",
              fontWeight: active ? 500 : 400,
              letterSpacing: "-0.005em",
            }}
          >
            {o.label}
            {(o.count !== undefined && o.count !== null) && (
              <span style={{
                fontFamily: "var(--mono)", fontSize: 10,
                padding: "0 5px",
                background: active ? "var(--bg-1)" : "transparent",
                color: o.tone === "ok" ? "var(--ok)" : o.tone === "warn" ? "var(--warn)" : o.tone === "crit" ? "var(--crit)" : "var(--fg-3)",
                borderRadius: 2,
              }}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function AllocationPanel({ item, onClose }) {
  const allocs = Object.entries(item.alloc).filter(([, v]) => v > 0);
  const total = item.qty;
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false };
  const [movements, setMovements] = useState(null);

  useEffect(() => {
    if (!dbStatus.isOnline || !item.id) { setMovements([]); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const tid = ctx?.tenant?.id;
      if (!tid) { setMovements([]); return; }
      const { data, source } = await dbListStockMovements(tid, null, null, { stockItemId: item.id, limit: 8 });
      if (cancelled) return;
      if (source === "db") setMovements(data || []);
      else setMovements([]);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.isOnline, item.id]);

  const fmtTime = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  };
  const fmtDelta = (m) => {
    const sign = m.kind === "in" ? "+" : "−";
    const abs = Math.abs(Number(m.delta) || 0);
    return `${sign}${abs.toLocaleString("pt-BR", { maximumFractionDigits: 3 })}`;
  };
  const fmtRef = (m) => {
    if (m.ref && m.ref !== "—") return m.ref;
    if (m.kind === "in") return "Entrada";
    if (m.op && m.op !== "—") return `${m.op.toUpperCase()} requisição`;
    return "Movimentação";
  };

  return (
    <div style={{ borderLeft: "1px solid var(--line)", background: "var(--bg-1)", display: "flex", flexDirection: "column", overflow: "auto" }}>
      <div style={{ padding: "16px 18px 14px", borderBottom: "1px solid var(--line)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em" }}>{item.id}</span>
          <button className="btn" data-variant="ghost" data-size="sm" onClick={onClose}><I.X size={13} /></button>
        </div>
        <h2 style={{ margin: "8px 0 4px", fontSize: 18, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.015em" }}>{item.name}</h2>
        <div style={{ fontSize: 12, color: "var(--fg-2)" }}>
          {item.cat} · mín {item.reorder} {item.unit} · máx {item.max ?? "—"} {item.unit}
        </div>
      </div>

      <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--line-soft)" }}>
        <div className="h-eyebrow" style={{ marginBottom: 10 }}>Estoque atual</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span className="mono" style={{ fontSize: 28, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.02em" }}>{item.qty}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-2)" }}>{item.unit}</span>
          <span style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 13, color: "var(--fg-0)" }}>R$ {(item.qty * item.cost).toFixed(2)}</span>
        </div>
        {/* Barra com marcadores de mínimo e máximo (com folga p/ qty acima do máx) */}
        {item.max
          ? <StockScaleBar qty={item.qty} reorder={item.reorder} max={item.max} unit={item.unit} />
          : (
            <div className="bar" style={{ marginTop: 12 }}>
              <i style={{ width: `${Math.min(100, (item.qty / Math.max(item.reorder * 2, 1)) * 100)}%`, background: item.status === "ok" ? "var(--accent-bright)" : item.status === "warn" ? "var(--warn)" : "var(--crit)" }} />
            </div>
          )
        }
      </div>

      {/* Consumo dos últimos 30 dias + média semanal */}
      <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--line-soft)" }}>
        <div className="h-eyebrow" style={{ marginBottom: 10 }}>Consumo · últimos 30 dias</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>30 dias</div>
            <div className="mono" style={{ fontSize: 22, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.018em" }}>
              {(item.usage30d || 0).toLocaleString("pt-BR")} {item.unit}
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>
              R$ {((item.usage30d || 0) * item.cost).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Média semanal</div>
            <div className="mono" style={{ fontSize: 22, fontWeight: 500, color: "var(--accent-bright)", letterSpacing: "-0.018em" }}>
              {((item.usage30d || 0) / 4).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} {item.unit}
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>
              30 dias ÷ 4
            </div>
          </div>
        </div>
        {item.usage30d > 0 && item.qty > 0 && (
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--fg-2)" }}>
            Cobertura estimada: <span className="mono" style={{ color: "var(--fg-0)" }}>
              {Math.round((item.qty / item.usage30d) * 30)} dias
            </span> com saldo atual.
          </div>
        )}
      </div>

      <div style={{ padding: "16px 18px" }}>
        <div className="h-eyebrow" style={{ marginBottom: 12 }}>Alocação por operação</div>
        {allocs.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Nenhum consumo nas últimas 24h.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {allocs.map(([opId, qty]) => {
              const op = MOCK.opById(opId);
              const pct = (qty / total) * 100;
              return (
                <div key={opId}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 50, background: op.color }} />
                    <span style={{ fontSize: 12, color: "var(--fg-0)" }}>{op.name}</span>
                    <span style={{ flex: 1 }} />
                    <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{qty} {item.unit}</span>
                    <span className="mono" style={{ fontSize: 11, color: "var(--fg-0)", width: 44, textAlign: "right" }}>{pct.toFixed(1)}%</span>
                  </div>
                  <div className="bar" style={{ height: 3 }}>
                    <i style={{ width: `${pct}%`, background: op.color }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ padding: "16px 18px", borderTop: "1px solid var(--line-soft)", marginTop: "auto" }}>
        <div className="h-eyebrow" style={{ marginBottom: 10 }}>Movimentações recentes</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 11.5 }}>
          {movements == null ? (
            <span style={{ color: "var(--fg-3)", fontSize: 11 }}>Carregando…</span>
          ) : movements.length === 0 ? (
            <span style={{ color: "var(--fg-3)", fontSize: 11 }}>Sem movimentações registradas.</span>
          ) : movements.map((m, i) => {
            const isIn = m.kind === "in";
            return (
              <div key={m.id || i} style={{ display: "grid", gridTemplateColumns: "44px 70px 1fr", gap: 8, alignItems: "center" }}>
                <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>{fmtTime(m.at)}</span>
                <span className="mono" style={{ fontSize: 11, color: isIn ? "var(--ok)" : "var(--fg-1)", fontWeight: 500 }}>
                  {fmtDelta(m)} {item.unit}
                </span>
                <span style={{ color: "var(--fg-2)", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {fmtRef(m)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Barra de estoque com escala 0..máx, marcadores em mín e máx,
// e folga proporcional à direita quando qty > máx (estoque acima do desejado).
function StockScaleBar({ qty, reorder, max, unit }) {
  const overMax  = qty > max;
  // Quando passa do máx, expande a escala pra qty caber com ~10% de respiro
  const scaleMax = overMax ? Math.max(qty * 1.05, max * 1.15) : max;
  const fillPct  = Math.max(0, Math.min(100, (qty     / scaleMax) * 100));
  const minPct   = (reorder / scaleMax) * 100;
  const maxPct   = (max     / scaleMax) * 100;

  // Cor do preenchimento por estado
  const state =
    qty <= 0       ? "crit" :
    qty < reorder  ? "warn" :
    overMax        ? "info" :
                     "ok";
  const fillColor = {
    crit: "var(--crit)",
    warn: "var(--warn)",
    info: "var(--info)",
    ok:   "var(--accent-bright)",
  }[state];

  const TRACK_H = 8;
  const TICK_OVERFLOW = 4; // quanto o tick estende além do track (em cima e embaixo)

  const tickStyle = (pct) => ({
    position: "absolute",
    top: -TICK_OVERFLOW, height: TRACK_H + TICK_OVERFLOW * 2,
    left: `${pct}%`, transform: "translateX(-50%)",
    width: 2, borderRadius: 1, background: "var(--fg-1)",
    pointerEvents: "none",
  });

  const labelStyle = (pct, color) => {
    // Alinha à esquerda/direita quando muito próximo da borda pra não vazar
    const tx = pct <= 4 ? "0" : pct >= 96 ? "-100%" : "-50%";
    return {
      position: "absolute", top: TRACK_H + TICK_OVERFLOW + 4,
      left: `${pct}%`, transform: `translateX(${tx})`,
      fontFamily: "var(--mono)", fontSize: 9.5,
      color: color || "var(--fg-2)", letterSpacing: "0.04em",
      whiteSpace: "nowrap",
    };
  };

  return (
    <div style={{ position: "relative", marginTop: 16, paddingTop: TICK_OVERFLOW, paddingBottom: 22 }}>
      {/* Track */}
      <div style={{
        position: "relative", height: TRACK_H, borderRadius: TRACK_H / 2,
        background: "var(--bg-3)", overflow: "hidden",
      }}>
        {/* Zona "abaixo do mínimo" — fundo levemente warn */}
        <div style={{
          position: "absolute", top: 0, bottom: 0, left: 0, width: `${minPct}%`,
          background: "var(--warn-soft)",
        }} />
        {/* Zona "acima do máximo" — fundo levemente info */}
        <div style={{
          position: "absolute", top: 0, bottom: 0, left: `${maxPct}%`, right: 0,
          background: "var(--info-soft)",
        }} />
        {/* Preenchimento */}
        <div style={{
          position: "absolute", top: 0, bottom: 0, left: 0, width: `${fillPct}%`,
          background: fillColor, borderRadius: TRACK_H / 2,
          transition: "width 200ms ease, background 200ms ease",
        }} />
      </div>

      {/* Tick + label · mínimo */}
      <div style={tickStyle(minPct)} title={`Estoque mínimo: ${reorder} ${unit}`} />
      <span style={labelStyle(minPct)}>min {reorder}</span>

      {/* Tick + label · máximo */}
      <div style={tickStyle(maxPct)} title={`Estoque máximo: ${max} ${unit}`} />
      <span style={labelStyle(maxPct)}>máx {max}</span>

      {/* Âncora 0 (esquerda) */}
      <span style={{
        position: "absolute", top: TRACK_H + TICK_OVERFLOW + 4, left: 0,
        fontFamily: "var(--mono)", fontSize: 9.5,
        color: "var(--fg-3)", letterSpacing: "0.04em",
      }}>0</span>

      {/* Quando há excedente, mostra "+X acima" no canto direito */}
      {overMax && (
        <span style={{
          position: "absolute", top: TRACK_H + TICK_OVERFLOW + 4, right: 0,
          fontFamily: "var(--mono)", fontSize: 9.5,
          color: "var(--info)", letterSpacing: "0.04em", fontWeight: 500,
        }}>+{Number((qty - max).toFixed(2))} acima</span>
      )}
    </div>
  );
}

// Input de busca · ícone de lupa, botão "x" pra limpar
function StockSearchInput({ value, onChange }) {
  return (
    <div style={{ position: "relative", width: 240 }}>
      <I.Search size={12} style={{
        position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)",
        color: "var(--fg-3)", pointerEvents: "none",
      }} />
      <input
        className="input"
        value={value}
        placeholder="Buscar por nome ou ID…"
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", paddingLeft: 28, paddingRight: value ? 28 : 10, fontSize: 12 }}
      />
      {value && (
        <button type="button" onClick={() => onChange("")}
                title="Limpar busca"
                style={{
                  position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                  background: "transparent", border: "none", padding: 4,
                  color: "var(--fg-3)", cursor: "pointer", display: "grid", placeItems: "center",
                }}>
          <I.X size={11} />
        </button>
      )}
    </div>
  );
}

// Filtro de categorias · popover com checkboxes (multi-seleção)
function CategoryFilter({ allCats, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = (c) => {
    onChange(selected.includes(c) ? selected.filter((x) => x !== c) : [...selected, c]);
  };
  const allOn = selected.length === 0; // vazio = todas
  const label = allOn ? "Todas as categorias"
              : selected.length === 1 ? selected[0]
              : `${selected.length} categorias`;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="btn" data-size="sm" onClick={() => setOpen((o) => !o)}>
        <I.Filter size={12} />{label}
        <I.Chevron size={10} style={{ marginLeft: 2 }} />
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", right: 0,
          background: "var(--bg-2)", border: "1px solid var(--line-strong)",
          borderRadius: 4, padding: 6, zIndex: 50,
          minWidth: 240, maxHeight: 320, overflow: "auto",
          boxShadow: "0 8px 24px -8px rgba(0,0,0,0.5)",
        }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "4px 6px 8px",
            borderBottom: "1px solid var(--line-soft)", marginBottom: 6,
          }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", flex: 1 }}>
              Categorias · {selected.length}/{allCats.length}
            </span>
            <button className="btn" data-variant="ghost" data-size="sm" onClick={() => onChange([])}>
              Todas
            </button>
            <button className="btn" data-variant="ghost" data-size="sm" onClick={() => onChange(allCats)}>
              Inverter
            </button>
          </div>
          {allCats.map((c) => {
            const on = selected.includes(c);
            return (
              <button key={c} type="button" onClick={() => toggle(c)} style={{
                display: "flex", alignItems: "center", gap: 8,
                width: "100%", textAlign: "left",
                padding: "6px 8px", borderRadius: 3, border: "none",
                background: on ? "var(--accent-soft)" : "transparent",
                color: on ? "var(--fg-0)" : "var(--fg-1)",
                fontSize: 12, cursor: "pointer",
              }}>
                <span style={{
                  width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                  background: on ? "var(--accent-bright)" : "transparent",
                  border: `1px solid ${on ? "var(--accent-bright)" : "var(--line-strong)"}`,
                  display: "grid", placeItems: "center",
                }}>
                  {on && <I.Check size={10} style={{ color: "var(--accent-fg)" }} />}
                </span>
                {c}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Toggle "Compor CMV" — botão pílula com bolinha verde/cinza.
// ON = item entra no cálculo de CMV (default).
// OFF = item é estocado mas não compõe o CMV (ex.: embalagens, descartáveis).
function ComposeCmvToggle({ on, onToggle }) {
  return (
    <button type="button" onClick={onToggle}
      title={on
        ? "Compõe CMV · clique para excluir"
        : "Excluído do CMV · clique para incluir"}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "3px 8px", borderRadius: 99,
        border: `1px solid ${on ? "var(--accent-line)" : "var(--line)"}`,
        background: on ? "var(--accent-soft)" : "var(--bg-2)",
        color: on ? "var(--accent-bright)" : "var(--fg-3)",
        fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.04em",
        textTransform: "uppercase", fontWeight: 500,
        cursor: "pointer",
        textDecoration: on ? "none" : "line-through",
      }}>
      <span style={{
        width: 6, height: 6, borderRadius: 50,
        background: on ? "var(--accent-bright)" : "var(--fg-3)",
      }} />
      CMV
    </button>
  );
}

// Sub-tab que troca entre "Insumos" e "Inventário" no topo da página
function StockSubTab({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: "transparent", border: "none",
      padding: "10px 14px", fontSize: 12.5,
      color: active ? "var(--fg-0)" : "var(--fg-2)",
      fontWeight: active ? 500 : 400, letterSpacing: "-0.005em",
      borderBottom: `2px solid ${active ? "var(--accent-bright)" : "transparent"}`,
      marginBottom: -1, display: "inline-flex", alignItems: "center",
      cursor: "pointer",
    }}>{children}</button>
  );
}

// ============= Categorias (sub-aba do Estoque) =============
function CategoriesView({ categories, items, onCreate, onRename, onDelete }) {
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState(null); // { oldName, value }

  const counts = useMemo(() => {
    const m = {};
    items.forEach((it) => { m[it.cat] = (m[it.cat] || 0) + 1; });
    return m;
  }, [items]);

  const submitNew = () => {
    const v = newName.trim();
    if (!v) return;
    if (categories.includes(v)) {
      window.showToast(`Categoria "${v}" já existe`, { tone: "warn" });
      return;
    }
    onCreate(v);
    setNewName("");
  };

  const saveEdit = () => {
    if (!editing) return;
    const target = editing.value.trim();
    if (!target || target === editing.oldName) { setEditing(null); return; }
    onRename(editing.oldName, target);
    setEditing(null);
  };

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Categorias</h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input className="input" value={newName}
                 placeholder="Nome da nova categoria"
                 onChange={(e) => setNewName(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") submitNew(); }}
                 style={{ width: 240 }} />
          <button className="btn" data-variant="primary" data-size="sm"
                  onClick={submitNew} disabled={!newName.trim()}>
            <I.Plus size={13} />Nova categoria
          </button>
        </div>
      </div>
      <table className="table">
        <thead>
          <tr><th>Categoria</th><th className="num">Itens</th><th /></tr>
        </thead>
        <tbody>
          {categories.length === 0 ? (
            <tr><td colSpan={3} className="dim" style={{ textAlign: "center", padding: 24 }}>
              Nenhuma categoria cadastrada
            </td></tr>
          ) : categories.map((c) => {
            const isEd = editing?.oldName === c;
            const count = counts[c] || 0;
            const canDelete = count === 0;
            return (
              <tr key={c}>
                <td className="row-strong">
                  {isEd ? (
                    <input className="input" autoFocus value={editing.value}
                           onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                           onKeyDown={(e) => {
                             if (e.key === "Enter")  saveEdit();
                             if (e.key === "Escape") setEditing(null);
                           }}
                           style={{ maxWidth: 280 }} />
                  ) : c}
                </td>
                <td className="num">{count}</td>
                <td style={{ width: 1, whiteSpace: "nowrap" }}>
                  <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                    {isEd ? (
                      <>
                        <button className="btn" data-size="sm" onClick={() => setEditing(null)}>Cancelar</button>
                        <button className="btn" data-variant="primary" data-size="sm" onClick={saveEdit}
                                disabled={!editing.value.trim()}>Salvar</button>
                      </>
                    ) : (
                      <>
                        <button className="btn" data-variant="ghost" data-size="sm"
                                onClick={() => setEditing({ oldName: c, value: c })}
                                title="Renomear (digite um nome existente para mesclar)">
                          <I.Edit size={11} />Renomear
                        </button>
                        <button className="btn" data-variant="ghost" data-size="sm"
                                onClick={() => onDelete(c)}
                                disabled={!canDelete}
                                title={canDelete
                                  ? "Excluir categoria"
                                  : `Migre os ${count} insumo${count === 1 ? "" : "s"} antes de excluir`}
                                style={{ color: canDelete ? "var(--crit)" : "var(--fg-3)" }}>
                          <I.Trash size={11} />
                        </button>
                      </>
                    )}
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

// ============= Fornecedores (sub-aba do Estoque) =============
function SuppliersView() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false };
  const [suppliers, setSuppliers] = useState(MOCK.SHOPPING.map((s) => ({
    sup: s.sup, contact: s.contact, lead: s.lead, itemsCount: s.items.length,
  })));
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource]     = useState("mock");
  const [editing, setEditing]   = useState(null);
  const [busy, setBusy]         = useState(false);

  useEffect(() => {
    if (!dbStatus.isOnline) return;
    let cancelled = false;
    (async () => {
      try {
        const ctx = await dbGetCurrentContext();
        if (cancelled) return;
        const tid = ctx?.tenant?.id;
        setTenantId(tid || null);
        if (!tid) return;
        const { data, source: src, error } = await dbListSuppliers(tid);
        if (cancelled) return;
        if (error) { console.warn("dbListSuppliers erro:", error); return; }
        if (data && src === "db") {
          setSuppliers(data.map((s) => ({
            id: s.id, sup: s.name, legalName: s.legal_name, cnpj: s.cnpj,
            contact: s.contact_value || "—",
            contactChannel: s.contact_channel,
            lead: s.lead_time_hours ? `${s.lead_time_hours}h` : "—",
            leadHours: s.lead_time_hours,
            itemsCount: 0,
          })));
          setSource("db");
        }
      } catch (e) {
        console.error("Falha ao carregar fornecedores:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.isOnline]);

  const save = async (s) => {
    setBusy(true);
    try {
      if (source === "db" && tenantId) {
        const leadH = parseInt(String(s.lead).replace(/[^0-9]/g, ""), 10) || null;
        const channel = s.contact?.match(/whats|wpp/i) ? "whatsapp"
                      : s.contact?.includes("@")       ? "email"
                      : null;
        if (editing?.id) {
          const { data, error } = await dbUpdateSupplier(editing.id, {
            name: s.sup, contact_value: s.contact || null, lead_time_hours: leadH, contact_channel: channel,
          });
          if (error) throw error;
          setSuppliers(suppliers.map((x) => x.id === editing.id ? {
            ...x, sup: data.name, contact: data.contact_value || "—", lead: data.lead_time_hours ? `${data.lead_time_hours}h` : "—",
          } : x));
          window.showToast(`${s.sup} atualizado no Supabase`, { tone: "ok" });
        } else {
          const { data, error } = await dbInsertSupplier(tenantId, {
            name: s.sup, contact_value: s.contact || null, lead_time_hours: leadH, contact_channel: channel,
          });
          if (error) throw error;
          if (!data) throw new Error("Insert retornou vazio (verifique RLS ou service worker)");
          setSuppliers([...suppliers, {
            id: data.id, sup: data.name, contact: data.contact_value || "—",
            lead: data.lead_time_hours ? `${data.lead_time_hours}h` : "—",
            itemsCount: 0,
          }]);
          window.showToast(`Fornecedor ${s.sup} cadastrado no Supabase`, { tone: "ok" });
        }
      } else {
        if (editing?.sup) {
          setSuppliers(suppliers.map((x) => x.sup === editing.sup ? { ...x, ...s } : x));
          window.showToast(`${s.sup} atualizado (mock)`, { tone: "warn" });
        } else {
          setSuppliers([...suppliers, { ...s, itemsCount: 0 }]);
          window.showToast(`Fornecedor ${s.sup} cadastrado (mock)`, { tone: "warn" });
        }
      }
      setEditing(null);
    } catch (e) {
      console.error("Falha ao salvar fornecedor:", e);
      window.showToast(`Erro: ${e?.message || e}`, { tone: "crit", ttl: 5000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3 className="card-title">Fornecedores</h3>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase",
            padding: "2px 7px", borderRadius: 99,
            color: source === "db" ? "var(--ok)" : "var(--fg-3)",
            background: source === "db" ? "var(--accent-soft)" : "var(--bg-2)",
            border: `1px solid ${source === "db" ? "var(--accent-line)" : "var(--line)"}`,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: 50, background: source === "db" ? "var(--ok)" : "var(--fg-3)" }} />
            {source === "db" ? "Supabase" : "Mock"}
          </span>
        </div>
        <button className="btn" data-variant="primary" data-size="sm" onClick={() => setEditing({})}>
          <I.Plus size={13} />Novo fornecedor
        </button>
      </div>
      <table className="table">
        <thead>
          <tr><th>Fornecedor</th><th>Contato</th><th>Lead time</th><th className="num">Itens</th><th /></tr>
        </thead>
        <tbody>
          {suppliers.length === 0 ? (
            <tr><td colSpan={5} className="dim" style={{ textAlign: "center", padding: 24 }}>
              Nenhum fornecedor cadastrado
            </td></tr>
          ) : suppliers.map((s) => (
            <tr key={s.id || s.sup}>
              <td className="row-strong">{s.sup}</td>
              <td className="dim mono" style={{ fontSize: 11 }}>{s.contact}</td>
              <td className="dim">{s.lead}</td>
              <td className="num">{s.itemsCount}</td>
              <td><button className="btn" data-variant="ghost" data-size="sm" onClick={() => setEditing(s)}>Editar</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <SupplierModal initial={editing.sup ? editing : null} busy={busy} onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function SupplierModal({ initial, onClose, onSave, busy }) {
  const [sup, setSup]         = useState(initial?.sup || "");
  const [contact, setContact] = useState(initial?.contact || "");
  const [lead, setLead]       = useState(initial?.lead || "24h");
  const valid = !!sup.trim();
  return (
    <Modal title={initial ? "Editar fornecedor" : "Novo fornecedor"} onClose={onClose}
      footer={<>
        <button className="btn" data-size="sm" onClick={onClose} disabled={busy}>Cancelar</button>
        <button className="btn" data-variant="primary" data-size="sm" disabled={!valid || busy}
                onClick={() => onSave({ sup: sup.trim(), contact: contact.trim(), lead: lead.trim() })}>
          {busy ? "Salvando…" : initial ? "Salvar" : "Cadastrar fornecedor"}
        </button>
      </>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <FormRow label="Razão / nome fantasia">
          <input className="input" autoFocus value={sup} onChange={(e) => setSup(e.target.value)} />
        </FormRow>
        <FormRow label="Lead time">
          <input className="input mono" value={lead} onChange={(e) => setLead(e.target.value)} placeholder="24h" />
        </FormRow>
        <FormRow label="Contato" hint="WhatsApp, e-mail, etc. (opcional)">
          <input className="input mono" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="WhatsApp · 11 9 0000-0000" />
        </FormRow>
      </div>
    </Modal>
  );
}

window.Stock = Stock;
window.Tabs = Tabs;
