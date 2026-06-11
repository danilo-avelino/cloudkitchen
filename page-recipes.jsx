// Recipes — Fichas técnicas + Preparos (sub-receitas reutilizáveis)
// Fichas: têm preço de venda, calculam CMV (theo/price)
// Preparos: têm aproveitamento (qty + kg/un), custo unitário = theo/aproveitamento.
//   Preparos aparecem como insumo disponível em outras fichas e preparos.

function Recipes({ scope }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  // ----- Estado das duas coleções
  const [allSheets,       setAllSheets]       = useState(MOCK.TECH_SHEETS);
  const [allPreparations, setAllPreparations] = useState(MOCK.PREPARATIONS);
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource]     = useState("mock");
  const [pageLoading, setPageLoading] = useState(true);

  // Cache de stock items (carregado paralelo às fichas e mantido em window p/ reuso)
  const [stockItems, setStockItems] = useState(window.__stockItemsCache || MOCK.STOCK_ITEMS);

  // Carrega fichas + preparos + stock items do DB em paralelo (precarrega o dropdown)
  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setPageLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const ctx = await dbGetCurrentContext();
        if (cancelled) return;
        const tid = ctx?.tenant?.id;
        setTenantId(tid || null);
        if (!tid) return;
        setSource("db"); // Conectado ao Supabase; queries abaixo só podem retornar do DB.
        const [sheetsRes, prepsRes, stockRes] = await Promise.all([
          dbListTechSheets(tid),
          dbListPreparations(tid),
          dbListStockItems(tid),
        ]);
        if (cancelled) return;
        setAllSheets(sheetsRes.data || []);
        setAllPreparations(prepsRes.data || []);
        const items = stockRes.data || [];
        setStockItems(items);
        window.__stockItemsCache = items; // cache cross-page
      } finally {
        if (!cancelled) setPageLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  // ----- Modo: "recipes" (fichas técnicas) | "preparations" (preparos)
  const [mode, setMode] = useState("recipes");

  // ----- Filtros
  const [filterOp,  setFilterOp]  = useState(scope);
  const [filterCat, setFilterCat] = useState("all");
  const [query,     setQuery]     = useState("");
  useEffect(() => { setFilterOp(scope); }, [scope]);

  // ----- Estado UI
  const [creating,    setCreating]    = useState(false);
  const [editingId,   setEditingId]   = useState(null);
  const [rowMenuOpen, setRowMenuOpen] = useState(null);
  useEffect(() => {
    if (rowMenuOpen === null) return;
    const onDoc = () => setRowMenuOpen(null);
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [rowMenuOpen]);

  // ----- Helpers polimórficos por modo
  const isPrep = mode === "preparations";
  const currentList   = isPrep ? allPreparations : allSheets;
  const setCurrentList = isPrep ? setAllPreparations : setAllSheets;
  const idPrefix       = isPrep ? "PRP" : "FIC";
  const labelSingular  = isPrep ? "preparo" : "ficha";
  const labelPlural    = isPrep ? "preparos" : "fichas técnicas";

  // ----- Filtragem da lista (fichas técnicas ordenadas por CMV desc; preparos mantêm ordem alfabética)
  const items = currentList.filter((it) => {
    // filterOp pode ser UUID (vindo dos chips de MOCK.OPERATIONS recém-populado)
    // enquanto it.op fica como slug ("nippon"). Compara contra ambos os formatos.
    if (filterOp !== "all" && it.op !== filterOp && it.operationId !== filterOp) return false;
    if (filterCat !== "all" && it.cat !== filterCat) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      const hay = `${it.name || ""} ${it.id || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (!isPrep) {
    items.sort((a, b) => (Number(b.cmv) || 0) - (Number(a.cmv) || 0));
  }

  const [selected, setSelected] = useState(items[0]?.id || null);
  const current = currentList.find((it) => it.id === selected) || items[0];
  const editingItem = currentList.find((it) => it.id === editingId) || null;

  // ----- Geração de id sequencial (FIC-001 / PRP-001)
  const nextId = () => {
    const nextNum = currentList.reduce((max, it) => {
      const n = parseInt(String(it.id).replace(/\D/g, ""), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0) + 1;
    return `${idPrefix}-${String(nextNum).padStart(3, "0")}`;
  };

  // Recalcula custos do item conforme tipo
  const recompute = (it) => {
    const theo = (it.items || []).reduce((s, [, , cost]) => s + (parseFloat(cost) || 0), 0);
    if (isPrep) {
      const y = parseFloat(it.yieldQty) || 0;
      const unitCost = y > 0 ? theo / y : 0;
      return { ...it, theo, unitCost };
    }
    const cmv = it.price > 0 ? (theo / it.price) * 100 : 0;
    return { ...it, theo, cmv };
  };

  // ----- Handlers de coleção
  const handleCreate = async (draft) => {
    // DB path · fichas técnicas
    if (!isPrep && tenantId && dbStatus.isOnline) {
      const code = `FIC-${Date.now().toString(36).slice(-6).toUpperCase()}`;
      const { data, error } = await dbInsertTechSheet(tenantId, {
        code, op: draft.op, cat: draft.cat, name: draft.name,
        price: draft.price, yieldQty: 1, yieldUnit: "un",
        items: [],
      });
      if (error) {
        window.showToast(`Erro ao criar: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
      const { data: refreshed } = await dbListTechSheets(tenantId);
      if (refreshed) setAllSheets(refreshed);
      setSelected(data.id);
      setCreating(false);
      window.showToast(`Ficha ${code} criada no Supabase`, { tone: "ok" });
      return;
    }
    // DB path · preparações
    if (isPrep && tenantId && dbStatus.isOnline) {
      const code = `PRP-${Date.now().toString(36).slice(-6).toUpperCase()}`;
      const { data, error } = await dbInsertPreparation(tenantId, {
        code, op: draft.op, cat: draft.cat, name: draft.name,
        yieldQty: draft.yieldQty, yieldUnit: draft.yieldUnit,
      });
      if (error) {
        window.showToast(`Erro ao criar preparo: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
      // Optimistic: insere localmente já no formato esperado pela UI
      const optimistic = {
        id: data.id, code: data.code, name: data.name,
        op: data.operation_id, cat: data.category_id,
        yieldQty: Number(data.yield_qty) || 1,
        yieldUnit: data.yield_unit || "kg",
        items: [], theo: 0, unitCost: 0,
      };
      setAllPreparations((prev) => [optimistic, ...prev]);
      setSelected(data.id);
      setCreating(false);
      window.showToast(`Preparo ${code} criado no Supabase`, { tone: "ok" });
      // Refetch silencioso
      dbListPreparations(tenantId).then(({ data: refreshed }) => {
        if (refreshed) setAllPreparations(refreshed);
      });
      return;
    }
    // Fallback MOCK
    const id = nextId();
    const base = isPrep
      ? { id, op: draft.op, cat: draft.cat, name: draft.name, yieldQty: draft.yieldQty, yieldUnit: draft.yieldUnit, theo: 0, unitCost: 0, items: [] }
      : { id, op: draft.op, cat: draft.cat, name: draft.name, price: draft.price, theo: 0, cmv: 0, items: [] };
    setCurrentList((prev) => [recompute(base), ...prev]);
    setSelected(id);
    setCreating(false);
    window.showToast(`${capitalize(labelSingular)} ${id} criado${!isPrep && source !== "db" ? " (mock)" : ""}`,
                     { tone: !isPrep && source !== "db" ? "warn" : "ok" });
  };

  const handleDuplicate = async (sourceId) => {
    const src = currentList.find((it) => it.id === sourceId);
    if (!src) return;

    const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

    // DB path
    if (dbStatus.isOnline && tenantId && isUuid(sourceId)) {
      try {
        if (isPrep) {
          const code = `PRP-${Date.now().toString(36).slice(-6).toUpperCase()}`;
          const { data: newPrep, error } = await dbInsertPreparation(tenantId, {
            code, op: src.op, operationId: src.operationId,
            name: `${src.name} (cópia)`, cat: src.cat,
            yieldQty: src.yieldQty, yieldUnit: src.yieldUnit,
          });
          if (error) throw error;
          const { data: srcItems } = await getSupabaseClient().from("preparation_items")
            .select("name, qty, unit, unit_cost, total_cost, stock_item_id, source_prep_id, sort_order")
            .eq("preparation_id", sourceId).order("sort_order");
          for (const it of (srcItems || [])) {
            await getSupabaseClient().from("preparation_items").insert({
              preparation_id: newPrep.id,
              name: it.name, qty: it.qty, unit: it.unit,
              unit_cost: it.unit_cost, total_cost: it.total_cost,
              stock_item_id: it.stock_item_id, source_prep_id: it.source_prep_id,
              sort_order: it.sort_order,
            });
          }
          const { data: refreshed } = await dbListPreparations(tenantId);
          if (refreshed) setAllPreparations(refreshed);
          setSelected(newPrep.id);
          window.showToast(`Preparo duplicado · ${code}`, { tone: "ok" });
        } else {
          const code = `FIC-${Date.now().toString(36).slice(-6).toUpperCase()}`;
          const { data: newSheet, error } = await dbInsertTechSheet(tenantId, {
            code, op: src.op, operationId: src.operationId,
            name: `${src.name} (cópia)`, cat: src.cat,
            price: src.price, yieldQty: src.yieldQty, yieldUnit: src.yieldUnit,
            items: [],
          });
          if (error) throw error;
          const { data: srcItems } = await getSupabaseClient().from("tech_sheet_items")
            .select("display_name, qty, unit, unit_cost, line_cost, stock_item_id, source_prep_id, sort_order")
            .eq("tech_sheet_id", sourceId).order("sort_order");
          for (const it of (srcItems || [])) {
            await getSupabaseClient().from("tech_sheet_items").insert({
              tech_sheet_id: newSheet.id,
              display_name: it.display_name, qty: it.qty, unit: it.unit,
              unit_cost: it.unit_cost,
              stock_item_id: it.stock_item_id, source_prep_id: it.source_prep_id,
              sort_order: it.sort_order,
            });
          }
          const { data: refreshed } = await dbListTechSheets(tenantId);
          if (refreshed) setAllSheets(refreshed);
          setSelected(newSheet.id);
          window.showToast(`Ficha duplicada · ${code}`, { tone: "ok" });
        }
      } catch (e) {
        window.showToast(`Erro ao duplicar: ${e.message || e}`, { tone: "crit", ttl: 4500 });
      }
      return;
    }

    // Fallback local (sem DB)
    const id = nextId();
    const cloned = recompute({ ...src, id, name: `${src.name} (cópia)` });
    setCurrentList((prev) => [cloned, ...prev]);
    setSelected(id);
    window.showToast(`Duplicado como ${id} (local)`, { tone: "warn" });
  };

  const handlePatch = (itemId, partial) => {
    setCurrentList((prev) => prev.map((it) => it.id === itemId ? recompute({ ...it, ...partial }) : it));
  };

  const handleAddItem = async (itemId, ingredient) => {
    const sheet = currentList.find(it => it.id === itemId);
    if (!sheet) return;
    const sheetItems = sheet.items || [];

    // DB path: preparação online
    if (isPrep && source === "db" && dbStatus.isOnline && tenantId) {
      const { error } = await dbInsertPreparationItem(sheet.id, ingredient, sheetItems.length);
      if (error) { window.showToast(`Erro: ${error.message}`, { tone: "crit" }); return; }
      const { data: refreshed } = await dbListPreparations(tenantId);
      if (refreshed) setAllPreparations(refreshed);
      window.showToast("Insumo adicionado", { tone: "ok" });
      return;
    }
    // DB path: ficha técnica online → sempre usa DB
    if (!isPrep && source === "db" && dbStatus.isOnline && tenantId) {
      // ingredient is [name, qtyText, cost]
      const { error } = await dbInsertTechSheetItem(sheet.id, ingredient);
      if (error) {
        window.showToast(`Erro ao adicionar insumo: ${error.message}`, { tone: "crit" });
        return;
      }
      // Reload the sheet to get new items with IDs
      const { data: refreshed } = await dbListTechSheets(tenantId);
      if (refreshed) setAllSheets(refreshed);
      window.showToast(`Insumo adicionado`, { tone: "ok" });
      return;
    }

    // Fallback: local state
    setCurrentList((prev) => prev.map((it) => it.id === itemId
      ? recompute({ ...it, items: [...(it.items || []), ingredient] })
      : it));
  };

  const handleRemoveItem = async (itemId, idx) => {
    const sheet = currentList.find(it => it.id === itemId);
    if (!sheet) return;
    const sheetItems = sheet.items || [];
    const item = sheetItems[idx];

    // DB path: if item has id (loaded from DB) and we're online
    if (item && item.id && dbStatus.isOnline && tenantId) {
      const delFn = isPrep ? dbDeletePreparationItem : dbDeleteTechSheetItem;
      const { error } = await delFn(item.id);
      if (error) {
        window.showToast(`Erro ao remover insumo: ${error.message}`, { tone: "crit" });
        return;
      }
      const { data: refreshed } = isPrep
        ? await dbListPreparations(tenantId)
        : await dbListTechSheets(tenantId);
      if (refreshed) {
        if (isPrep) setAllPreparations(refreshed);
        else setAllSheets(refreshed);
      }
      window.showToast(`Insumo removido`, { tone: "ok" });
      return;
    }

    // Fallback: local state
    setCurrentList((prev) => prev.map((it) => it.id === itemId
      ? recompute({ ...it, items: (it.items || []).filter((_, i) => i !== idx) })
      : it));
  };

  const handleUpdateItem = async (itemId, idx, ingredient) => {
    const sheet = currentList.find(it => it.id === itemId);
    if (!sheet) return;
    const item = (sheet.items || [])[idx];

    // DB path: if item has id (loaded from DB) and we're online
    if (item && item.id && dbStatus.isOnline && tenantId) {
      const [name, qtyText, cost] = ingredient;
      const m = String(qtyText || "").match(/([\d,.]+)\s*(.*)/);
      const qty = m ? parseFloat(m[1].replace(",", ".")) || 0 : 0;
      const unit = m ? (m[2] || "un").trim() : "un";
      const unitCost = qty > 0 ? (cost || 0) / qty : 0;

      const updFn = isPrep ? dbUpdatePreparationItem : dbUpdateTechSheetItem;
      const { error } = await updFn(item.id, { name, qty, unit, unitCost });
      if (error) {
        window.showToast(`Erro ao atualizar insumo: ${error.message}`, { tone: "crit" });
        return;
      }
      const { data: refreshed } = isPrep
        ? await dbListPreparations(tenantId)
        : await dbListTechSheets(tenantId);
      if (refreshed) {
        if (isPrep) setAllPreparations(refreshed);
        else setAllSheets(refreshed);
      }
      window.showToast(`Insumo atualizado`, { tone: "ok" });
      return;
    }

    // Fallback: local state
    setCurrentList((prev) => prev.map((it) => it.id === itemId
      ? recompute({ ...it, items: (it.items || []).map((row, i) => i === idx ? ingredient : row) })
      : it));
  };

  const handleEditSubmit = async (draft) => {
    if (!editingId) return;
    const partial = isPrep
      ? { op: draft.op, cat: draft.cat, name: draft.name, yieldQty: draft.yieldQty, yieldUnit: draft.yieldUnit }
      : { op: draft.op, cat: draft.cat, name: draft.name, price: draft.price };

    // DB persist
    if (dbStatus.isOnline && tenantId) {
      const updFn = isPrep ? dbUpdatePreparation : dbUpdateTechSheet;
      const { error } = await updFn(editingId, partial);
      if (error) {
        window.showToast(`Erro ao salvar: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
      // Recarrega lista para refletir custos recalculados pelos triggers
      const { data: refreshed } = isPrep
        ? await dbListPreparations(tenantId)
        : await dbListTechSheets(tenantId);
      if (refreshed) {
        if (isPrep) setAllPreparations(refreshed);
        else setAllSheets(refreshed);
      }
    } else {
      handlePatch(editingId, partial);
    }
    window.showToast(`${capitalize(labelSingular)} atualizado`, { tone: "ok" });
    setEditingId(null);
  };

  const [recomputing, setRecomputing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const recomputeAllCosts = async () => {
    if (recomputing) return;
    if (!tenantId || !dbStatus.isOnline) {
      window.showToast("DB offline · sem nada para recalcular", { tone: "warn" });
      return;
    }
    setRecomputing(true);
    try {
      const { data, error } = await dbRecomputeAllCosts(tenantId);
      if (error) {
        window.showToast(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
      // Recarrega tudo
      const [sheetsRes, prepsRes] = await Promise.all([
        dbListTechSheets(tenantId),
        dbListPreparations(tenantId),
      ]);
      if (sheetsRes.data) setAllSheets(sheetsRes.data);
      if (prepsRes.data) setAllPreparations(prepsRes.data);
      const r = data || {};
      const total = (r.prep_items_updated || 0) + (r.ts_items_from_stock || 0) + (r.ts_items_from_prep || 0);
      window.showToast(
        total === 0
          ? "Custos já estão atualizados ✓"
          : `${r.prep_items_updated || 0} preparo(s) · ${r.ts_items_from_stock || 0} ficha(s) do estoque · ${r.ts_items_from_prep || 0} ficha(s) de preparo`,
        { tone: "ok", ttl: 5000 },
      );
    } finally {
      setRecomputing(false);
    }
  };

  const handleDelete = (itemId) => {
    const target = currentList.find((it) => it.id === itemId);
    if (!target) return;
    setPendingDelete(target);
  };

  const confirmDelete = async () => {
    if (!pendingDelete || deleting) return;
    const itemId = pendingDelete.id;
    setDeleting(true);
    try {
      const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
      if (dbStatus.isOnline && tenantId && isUuid(itemId)) {
        const delFn = isPrep ? dbDeletePreparation : dbDeleteTechSheet;
        const { error } = await delFn(itemId);
        if (error) {
          window.showToast(`Erro ao excluir: ${error.message}`, { tone: "crit", ttl: 4500 });
          return;
        }
      }
      setCurrentList((prev) => prev.filter((it) => it.id !== itemId));
      if (selected === itemId) {
        const remaining = currentList.filter((it) => it.id !== itemId);
        setSelected(remaining[0]?.id || null);
      }
      window.showToast(`${capitalize(labelSingular)} excluído`, { tone: "warn" });
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  const handleSave = (itemId) => {
    window.showToast(`${capitalize(labelSingular)} ${itemId} salvo`, { tone: "ok" });
  };

  // Fonte unificada de insumos disponíveis (usada pelo IngredientModal):
  // estoque + todos os preparos (mesmo os do outro tab) + outros preparos do mesmo tipo
  const availablePreparations = allPreparations;

  const activeOpLabel  = filterOp  === "all" ? "Todas as operações" : MOCK.opById(filterOp).name;
  const activeCatLabel = filterCat === "all" ? "Todas as categorias" : (MOCK.recipeCatById(filterCat)?.label || filterCat);

  if (pageLoading) return <PageLoading label="Carregando fichas técnicas…" variant="table" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "20px 28px 0", display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div className="h-eyebrow" style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 10 }}>
            {items.length} {labelPlural} · {activeOpLabel} · {activeCatLabel}
          </div>
          <h1 className="h-title">Fichas técnicas</h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" data-size="sm" onClick={recomputeAllCosts} disabled={recomputing}
                  title="Recalcula custos: estoque → preparos → fichas técnicas">
            {recomputing ? "Recalculando…" : "↻ Recalcular custos"}
          </button>
          <button className="btn" data-variant="primary" data-size="sm" onClick={() => setCreating(true)}>
            <I.Plus size={13} />{isPrep ? "Novo preparo" : "Nova ficha"}
          </button>
        </div>
      </div>

      {/* Tab switcher: Fichas | Preparos */}
      <ModeTabs mode={mode} setMode={(m) => { setMode(m); setSelected(null); }}
                counts={{ recipes: allSheets.length, preparations: allPreparations.length }} />

      {/* Filtros: Operação (chips) + Categoria (select) */}
      <div style={{
        padding: "12px 28px 14px", display: "flex", alignItems: "center", gap: 12,
        borderBottom: "1px solid var(--line)", flexWrap: "wrap",
      }}>
        <span style={filterLabelStyle}>Operação</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <FilterChip active={filterOp === "all"} onClick={() => setFilterOp("all")}>Todas</FilterChip>
          {MOCK.OPERATIONS.filter((o) => o.id !== "all").map((o) => (
            <FilterChip key={o.id} active={filterOp === o.id} dotColor={o.color} onClick={() => setFilterOp(o.id)}>
              {o.short}
            </FilterChip>
          ))}
        </div>
        <span style={{ width: 1, height: 18, background: "var(--line)" }} />
        <input
          className="input"
          placeholder={`Buscar ${labelSingular} por nome…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ minWidth: 220, flex: 1, maxWidth: 360 }}
        />
        <span style={{ flex: 1 }} />
        {(filterOp !== "all" || filterCat !== "all" || query) && (
          <button className="btn" data-variant="ghost" data-size="sm" onClick={() => { setFilterOp("all"); setFilterCat("all"); setQuery(""); }}>
            Limpar filtros
          </button>
        )}
      </div>

      {/* Lista | Editor */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "320px 1fr", overflow: "hidden" }}>
        <div style={{ borderRight: "1px solid var(--line)", overflow: "auto", background: "var(--bg-1)" }}>
          {items.length === 0 && (
            <div style={{ padding: 24, textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>
              Nenhum {labelSingular} com esses filtros.
            </div>
          )}
          {items.map((it) => (
            <ListRow
              key={it.id}
              item={it}
              mode={mode}
              isActive={selected === it.id}
              onSelect={() => setSelected(it.id)}
              menuOpen={rowMenuOpen === it.id}
              onToggleMenu={(e) => { e.stopPropagation(); setRowMenuOpen(rowMenuOpen === it.id ? null : it.id); }}
              onEdit={() => { setRowMenuOpen(null); setEditingId(it.id); }}
              onDuplicate={() => { setRowMenuOpen(null); handleDuplicate(it.id); }}
              onDelete={() => { setRowMenuOpen(null); handleDelete(it.id); }}
            />
          ))}
        </div>

        {current
          ? <Editor
              key={current.id}
              item={current}
              mode={mode}
              stockItems={stockItems}
              availablePreparations={availablePreparations}
              onDuplicate={() => handleDuplicate(current.id)}
              onSave={() => handleSave(current.id)}
              onEdit={() => setEditingId(current.id)}
              onAddItem={(ing) => handleAddItem(current.id, ing)}
              onRemoveItem={(idx) => handleRemoveItem(current.id, idx)}
              onUpdateItem={(idx, ing) => handleUpdateItem(current.id, idx, ing)}
            />
          : <EmptyEditor mode={mode} onCreate={() => setCreating(true)} />}
      </div>

      {creating && (
        <RecipeModal
          mode={mode}
          defaultOp={filterOp !== "all" ? filterOp : (scope !== "all" ? scope : null)}
          defaultCat={filterCat !== "all" ? filterCat : null}
          onCancel={() => setCreating(false)}
          onSubmit={handleCreate}
        />
      )}

      {editingItem && (
        <RecipeModal
          mode={mode}
          initial={editingItem}
          onCancel={() => setEditingId(null)}
          onSubmit={handleEditSubmit}
        />
      )}

      {pendingDelete && (
        <Modal
          title={`Excluir ${labelSingular}`}
          subtitle={pendingDelete.id}
          width={460}
          onClose={deleting ? undefined : () => setPendingDelete(null)}
          footer={
            <>
              <button className="btn" data-size="sm"
                      onClick={() => setPendingDelete(null)} disabled={deleting}>
                Cancelar
              </button>
              <button className="btn" data-variant="danger" data-size="sm"
                      onClick={confirmDelete} disabled={deleting}>
                {deleting ? "Excluindo…" : "Excluir definitivamente"}
              </button>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 13, color: "var(--fg-1)", lineHeight: 1.5 }}>
              Tem certeza que deseja excluir <strong style={{ color: "var(--fg-0)" }}>{pendingDelete.name}</strong>?
            </div>
            <div style={{
              padding: "10px 12px", background: "var(--crit-soft)",
              border: "1px solid var(--crit-line)", borderRadius: 4,
              display: "flex", alignItems: "center", gap: 10,
              fontSize: 11.5, color: "var(--crit)",
            }}>
              <I.AlertTriangle size={12} />
              <span>Esta ação não pode ser desfeita.</span>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

const filterLabelStyle = {
  fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)",
  letterSpacing: "0.08em", textTransform: "uppercase",
};

const capitalize = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

// ===== Tabs (Fichas | Preparos) =====
function ModeTabs({ mode, setMode, counts }) {
  const tabs = [
    { id: "recipes",      label: "Fichas técnicas", count: counts.recipes },
    { id: "preparations", label: "Preparos",        count: counts.preparations },
  ];
  return (
    <div style={{ display: "flex", gap: 0, padding: "0 28px", borderTop: "1px solid var(--line)", marginTop: 16 }}>
      {tabs.map(({ id, label, count }) => {
        const active = mode === id;
        return (
          <button key={id} onClick={() => setMode(id)} style={{
            background: "transparent", border: "none",
            padding: "12px 14px", fontSize: 13,
            color: active ? "var(--fg-0)" : "var(--fg-2)",
            fontWeight: active ? 500 : 400, letterSpacing: "-0.005em",
            borderBottom: `2px solid ${active ? "var(--accent-bright)" : "transparent"}`,
            marginBottom: -1, display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer",
          }}>
            {label}
            <span style={{
              fontFamily: "var(--mono)", fontSize: 10, padding: "1px 6px",
              background: active ? "var(--bg-3)" : "transparent",
              color: "var(--fg-3)", borderRadius: 8, letterSpacing: "0.04em",
            }}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}

// ===== Linha da lista (suporta fichas e preparos) =====
function ListRow({ item, mode, isActive, onSelect, menuOpen, onToggleMenu, onEdit, onDuplicate, onDelete }) {
  const op = MOCK.opById(item.op);
  const recipeCat = MOCK.recipeCatById(item.cat);
  const isPrep = mode === "preparations";

  const cmvTone = !isPrep && (item.cmv > 36 ? "crit" : item.cmv > 33 ? "warn" : "ok");

  return (
    <div style={{
      position: "relative",
      display: "flex", alignItems: "stretch",
      background: isActive ? "var(--bg-3)" : "transparent",
      borderBottom: "1px solid var(--line-soft)",
      borderLeft: isActive ? "2px solid var(--accent-bright)" : "2px solid transparent",
      transition: "background 100ms",
    }}>
      <button onClick={onSelect} style={{
        flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6,
        padding: "14px 4px 14px 14px", textAlign: "left",
        background: "transparent", border: "none",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ width: 6, height: 6, borderRadius: 50, background: op.color, flexShrink: 0 }} />
          <span style={{
            fontSize: 13, color: "var(--fg-0)", fontWeight: 500, letterSpacing: "-0.005em",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1,
          }}>{item.name}</span>
          {isPrep
            ? <span className="badge" data-tone="info">PREPARO</span>
            : <span className="badge" data-tone={cmvTone}>{item.cmv.toFixed(1)}%</span>}
        </div>
        {recipeCat && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 4, height: 4, borderRadius: 50, background: recipeCat.color }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              {recipeCat.label}
            </span>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 11 }}>
          {isPrep ? (
            <>
              <span style={{ color: "var(--fg-2)" }}>{item.yieldQty} {item.yieldUnit}</span>
              <span style={{ color: "var(--fg-3)" }}>R$ {(item.unitCost || 0).toFixed(2)}/{item.yieldUnit}</span>
            </>
          ) : (
            <>
              <span style={{ color: "var(--fg-2)" }}>R$ {item.price.toFixed(2)}</span>
              <span style={{ color: "var(--fg-3)" }}>custo R$ {item.theo.toFixed(2)}</span>
            </>
          )}
        </div>
      </button>
      <button onClick={onToggleMenu} title="Mais opções" style={{
        width: 32, padding: "0 4px",
        background: "transparent", border: "none",
        color: menuOpen ? "var(--fg-0)" : "var(--fg-3)",
        display: "grid", placeItems: "center", cursor: "pointer",
      }}>
        <I.More size={14} />
      </button>
      {menuOpen && (
        <div onClick={(e) => e.stopPropagation()} style={{
          position: "absolute", right: 8, top: "calc(100% - 6px)", zIndex: 50,
          background: "var(--bg-2)", border: "1px solid var(--line-strong)",
          borderRadius: 4, padding: 4, minWidth: 160,
          boxShadow: "0 8px 24px -8px rgba(0,0,0,0.5)",
        }}>
          <RowMenuItem onClick={onEdit}>Editar</RowMenuItem>
          <RowMenuItem onClick={onDuplicate}>Duplicar</RowMenuItem>
          <RowMenuItem danger onClick={onDelete}>Excluir</RowMenuItem>
        </div>
      )}
    </div>
  );
}

// ===== Estado vazio =====
function EmptyEditor({ mode, onCreate }) {
  const isPrep = mode === "preparations";
  return (
    <div style={{ display: "grid", placeItems: "center", padding: 32 }}>
      <div style={{ textAlign: "center", maxWidth: 320 }}>
        <div className="h-eyebrow" style={{ marginBottom: 8 }}>
          {isPrep ? "Nenhum preparo nesse filtro" : "Nenhuma ficha nesse filtro"}
        </div>
        <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 16 }}>
          {isPrep
            ? "Crie um preparo (ex.: maionese da casa, massa pré-fermentada) para reusar como insumo em outras fichas."
            : "Crie a primeira ficha técnica para começar a calcular CMV teórico e margem."}
        </div>
        <button className="btn" data-variant="primary" data-size="sm" onClick={onCreate}>
          <I.Plus size={13} />{isPrep ? "Novo preparo" : "Nova ficha"}
        </button>
      </div>
    </div>
  );
}

// ===== Editor unificado =====
function Editor({ item, mode, stockItems = [], availablePreparations, onDuplicate, onSave, onEdit, onAddItem, onRemoveItem, onUpdateItem }) {
  const op = MOCK.opById(item.op);
  const isPrep = mode === "preparations";
  const items = item.items || [];
  const hasItems = items.length > 0;

  const [adding, setAdding] = useState(false);
  const [editingIdx, setEditingIdx] = useState(null);
  const [openMenu, setOpenMenu] = useState(null);

  useEffect(() => {
    if (openMenu === null) return;
    const h = () => setOpenMenu(null);
    document.addEventListener("click", h);
    return () => document.removeEventListener("click", h);
  }, [openMenu]);

  // KPIs por modo · valores numéricos defensivos para itens novos do DB
  const theo = Number(item.theo) || 0;
  const price = Number(item.price) || 0;
  const cmv = Number(item.cmv) || 0;
  const kpis = isPrep ? (
    <>
      <KpiCard label="Aproveitamento" data={{ v: `${item.yieldQty || 1} ${item.yieldUnit || "kg"}`, d: "rendimento", tone: "up", sub: "" }} />
      <KpiCard label="Custo total"    data={{ v: `R$ ${theo.toFixed(2)}`, d: `${items.length} insumos`, tone: "warn", sub: "" }} />
      <KpiCard label="Custo unitário" data={{ v: `R$ ${(item.unitCost || 0).toFixed(2)}/${item.yieldUnit || "kg"}`, d: "usado em outras fichas", tone: "up", sub: "" }} accent />
      <KpiCard label="Tipo" data={{ v: "Preparo", d: item.code || item.id, tone: "warn", sub: "" }} />
    </>
  ) : (
    <>
      <KpiCard label="Preço de venda" data={{ v: `R$ ${price.toFixed(2)}`, d: "no iFood", tone: "up", sub: "" }} />
      <KpiCard label="Custo composto" data={{ v: `R$ ${theo.toFixed(2)}`, d: `${items.length} insumos`, tone: "warn", sub: "" }} />
      <KpiCard label="CMV teórico"    data={{ v: `${cmv.toFixed(1)}%`, d: "meta 30%", tone: cmv > 31 ? "down" : "up", sub: "" }} accent />
      <KpiCard label="Margem de contribuição"   data={{
        v: `R$ ${(price - theo).toFixed(2)}`,
        d: price > 0 ? `${(((price - theo) / price) * 100).toFixed(1)}% por unidade` : "—",
        tone: "up", sub: ""
      }} />
    </>
  );

  return (
    <div style={{ overflow: "auto", padding: "24px 28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: 50, background: op.color }} />
            <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
              {op.name}{isPrep ? " · preparo" : ""}
            </span>
          </div>
          <h2 style={{ margin: 0, fontSize: 28, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.025em" }}>{item.name}</h2>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" data-size="sm" onClick={onEdit}>
            <I.Edit size={12} />Editar {isPrep ? "preparo" : "ficha"}
          </button>
          <button className="btn" data-size="sm" onClick={onDuplicate}>Duplicar</button>
          {!isPrep && (
            <button className="btn" data-size="sm" onClick={() => notImplemented("Histórico de custo")}>Histórico de custo</button>
          )}
          <button className="btn" data-variant="primary" data-size="sm" onClick={onSave}>Salvar</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        {kpis}
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Composição</h3>
          <button className="btn" data-variant="ghost" data-size="sm" onClick={() => setAdding(true)}>
            <I.Plus size={12} />Adicionar insumo
          </button>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Insumo</th>
              <th className="num">Qtd</th>
              <th className="num">Custo unit.</th>
              <th className="num">Custo composto</th>
              <th className="num">% do total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!hasItems && (
              <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--fg-3)", padding: "24px 12px" }}>
                Sem insumos · clique em "Adicionar insumo" para compor.
              </td></tr>
            )}
            {items.map((row, i) => {
              const [name, qty, cost] = row;
              const unitCost = row.unitCost != null
                ? row.unitCost
                : (row.qty > 0 ? cost / row.qty : 0);
              const pct = item.theo > 0 ? (cost / item.theo) * 100 : 0;
              return (
                <tr key={i}>
                  <td className="row-strong">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 16, height: 1, background: "var(--fg-4)" }} />
                      {name}
                    </span>
                  </td>
                  <td className="num">{qty}</td>
                  <td className="num">R$ {unitCost.toFixed(2)}</td>
                  <td className="num">R$ {cost.toFixed(2)}</td>
                  <td className="num" style={{ color: "var(--fg-2)" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                      <span style={{ width: 40, height: 3, background: "var(--bg-3)", borderRadius: 1, overflow: "hidden", position: "relative" }}>
                        <span style={{ display: "block", width: `${pct}%`, height: "100%", background: "var(--accent-bright)" }} />
                      </span>
                      {pct.toFixed(1)}%
                    </span>
                  </td>
                  <td style={{ position: "relative" }}>
                    <button className="btn" data-variant="ghost" data-size="sm" style={{ padding: "3px 7px" }}
                            onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === i ? null : i); }}>
                      <I.More size={12} />
                    </button>
                    {openMenu === i && (
                      <div onClick={(e) => e.stopPropagation()} style={{
                        position: "absolute", top: "100%", right: 8, marginTop: 4, zIndex: 30,
                        background: "var(--bg-2)", border: "1px solid var(--line-strong)", borderRadius: 4, padding: 4,
                        minWidth: 160, boxShadow: "0 8px 24px -8px rgba(0,0,0,0.5)",
                      }}>
                        <RowMenuItem onClick={() => { setOpenMenu(null); setEditingIdx(i); }}>Editar insumo</RowMenuItem>
                        <RowMenuItem danger onClick={() => { setOpenMenu(null); onRemoveItem(i); }}>Remover insumo</RowMenuItem>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {adding && (
        <IngredientModal
          stockItems={stockItems}
          availablePreparations={availablePreparations}
          excludeId={isPrep ? item.id : null}  // não permite preparo se referenciar a si mesmo
          onCancel={() => setAdding(false)}
          onSubmit={(ing) => { onAddItem(ing); setAdding(false); }}
        />
      )}

      {editingIdx !== null && (
        <IngredientModal
          stockItems={stockItems}
          initial={items[editingIdx]}
          availablePreparations={availablePreparations}
          excludeId={isPrep ? item.id : null}
          onCancel={() => setEditingIdx(null)}
          onSubmit={(ing) => { onUpdateItem(editingIdx, ing); setEditingIdx(null); }}
          onDelete={() => { onRemoveItem(editingIdx); setEditingIdx(null); }}
        />
      )}
    </div>
  );
}

// ===== Auxiliares =====
function RowMenuItem({ onClick, danger, children }) {
  return (
    <button onClick={onClick} style={{
      display: "block", width: "100%", textAlign: "left",
      padding: "7px 10px", fontSize: 12,
      background: "transparent", border: "none", borderRadius: 2,
      color: danger ? "var(--crit)" : "var(--fg-1)",
      cursor: "pointer",
    }}>{children}</button>
  );
}

function FilterChip({ active, dotColor, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "5px 10px", fontSize: 11.5,
      background: active ? "var(--bg-3)" : "var(--bg-2)",
      border: `1px solid ${active ? "var(--line-strong)" : "var(--line)"}`,
      color: active ? "var(--fg-0)" : "var(--fg-2)",
      fontWeight: active ? 500 : 400,
      borderRadius: 4, cursor: "pointer",
      letterSpacing: "0.04em", fontFamily: "var(--mono)",
    }}>
      {dotColor && <span style={{ width: 6, height: 6, borderRadius: 50, background: dotColor }} />}
      {children}
    </button>
  );
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 11.5, color: "var(--fg-1)", fontWeight: 500, letterSpacing: "-0.005em" }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{hint}</span>}
    </label>
  );
}

// ===== Modal de criar/editar Ficha ou Preparo =====
function RecipeModal({ mode, initial, defaultOp, defaultCat, onCancel, onSubmit }) {
  const isPrep = mode === "preparations";
  const isEdit = !!initial;
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false };
  const ops  = MOCK.OPERATIONS.filter((o) => o.id !== "all");
  const [cats, setCats] = useState(MOCK.RECIPE_CATEGORIES);
  const [tenantId, setTenantId] = useState(null);

  useEffect(() => {
    if (!dbStatus.isOnline) return;
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const tid = ctx?.tenant?.id;
      setTenantId(tid || null);
      if (!tid) return;
      const { data, source } = await dbListRecipeCategories(tid);
      if (cancelled) return;
      if (source === "db") setCats(data || []);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.isOnline]);

  const [showCatManager, setShowCatManager] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [savingCat, setSavingCat] = useState(false);
  const [catPendingDelete, setCatPendingDelete] = useState(null);
  const [deletingCat, setDeletingCat] = useState(false);

  const handleCatChange = (e) => setCat(e.target.value);

  const saveNewCat = async () => {
    const name = newCatName.trim();
    if (!name || savingCat) return;
    setSavingCat(true);
    try {
      if (tenantId) {
        const { data, error } = await dbInsertRecipeCategory(tenantId, { name });
        if (error) { window.showToast(`Erro: ${error.message}`, { tone: "crit" }); return; }
        setCats((prev) => [...prev, data]);
        setCat(data.id);
        window.showToast(`Categoria "${data.name}" criada`, { tone: "ok" });
      } else {
        const newCat = { id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name };
        setCats((prev) => [...prev, newCat]);
        setCat(newCat.id);
      }
      setNewCatName("");
    } finally {
      setSavingCat(false);
    }
  };

  const deleteCat = (id) => {
    const target = cats.find((c) => c.id === id);
    if (!target) return;
    setCatPendingDelete(target);
  };

  const performDeleteCat = async () => {
    const target = catPendingDelete;
    if (!target || deletingCat) return;
    setDeletingCat(true);
    try {
      const cli = typeof getSupabaseClient === "function" ? getSupabaseClient() : null;
      if (tenantId && cli) {
        const { error } = await cli.from("recipe_categories").delete().eq("id", target.id);
        if (error) { window.showToast(`Erro: ${error.message}`, { tone: "crit" }); return; }
      }
      setCats((prev) => prev.filter((c) => c.id !== target.id));
      if (cat === target.id) setCat("");
      window.showToast("Categoria excluída", { tone: "ok" });
      setCatPendingDelete(null);
    } finally {
      setDeletingCat(false);
    }
  };

  const [op, setOp]       = useState(initial?.op    || defaultOp  || ops[0]?.id || "");
  const [cat, setCat]     = useState(initial?.cat   || defaultCat || (isPrep ? "outro" : cats[0]?.id) || "");
  const [name, setName]   = useState(initial?.name  || "");
  const [price, setPrice] = useState(initial?.price != null ? String(initial.price).replace(".", ",") : "");
  const [yieldQty, setYieldQty]   = useState(initial?.yieldQty != null ? String(initial.yieldQty).replace(".", ",") : "");
  const [yieldUnit, setYieldUnit] = useState(initial?.yieldUnit || "kg");

  // Validação: nome + operação obrigatórios; categoria opcional
  // (para preparos sem categoria definida, não bloqueia o save)
  const valid = op && name.trim().length > 0 &&
    (isPrep ? parseFloat(String(yieldQty).replace(",", ".")) > 0 : true);

  const [submitting, setSubmitting] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      if (isPrep) {
        await onSubmit({
          op, cat, name: name.trim(),
          yieldQty:  parseFloat(String(yieldQty).replace(",", ".")) || 0,
          yieldUnit: yieldUnit,
        });
      } else {
        await onSubmit({
          op, cat, name: name.trim(),
          price: parseFloat(String(price).replace(",", ".")) || 0,
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const opObj = MOCK.opById(op);
  const titleNew  = isPrep ? "Novo preparo"  : "Nova ficha técnica";
  const titleEdit = isPrep ? "Editar preparo" : "Editar ficha técnica";

  return (
    <div onClick={onCancel} style={{
      position: "fixed", inset: 0, zIndex: 80,
      background: "rgba(0,0,0,0.55)",
      display: "grid", placeItems: "center",
      animation: "fadeUp 160ms ease both",
    }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card" style={{
        width: 480, maxWidth: "calc(100vw - 32px)",
      }}>
        <div className="card-header">
          <div>
            <h3 className="card-title">{isEdit ? titleEdit : titleNew}</h3>
            {isEdit && <span className="card-sub" style={{ display: "block", marginTop: 4 }}>{initial.id}</span>}
          </div>
          <button type="button" className="btn" data-variant="ghost" data-size="sm" onClick={onCancel} title="Fechar">
            <I.X size={12} />
          </button>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Operação" hint="Marca/cozinha responsável.">
              <select className="select" value={op} onChange={(e) => setOp(e.target.value)} required>
                {ops.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              {opObj && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 50, background: opObj.color }} />
                  <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                    {opObj.short} {opObj.iFood ? `· ${opObj.iFood}` : ""}
                  </span>
                </div>
              )}
            </Field>

            <Field label="Categoria" hint="Tipo de produto.">
              <div style={{ display: "flex", gap: 6 }}>
                <select className="select" value={cat} onChange={handleCatChange} required style={{ flex: 1 }}>
                  <option value="" disabled>Selecione…</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.label || c.name}</option>)}
                </select>
                <button type="button" className="btn" data-size="sm"
                        onClick={() => setShowCatManager(!showCatManager)}
                        title="Gerenciar categorias">
                  {showCatManager ? "×" : "⚙"}
                </button>
              </div>
              {showCatManager && (
                <div style={{ marginTop: 8, padding: 10, background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input className="input" value={newCatName}
                           onChange={(e) => setNewCatName(e.target.value)}
                           onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveNewCat(); } }}
                           placeholder="Nova categoria" style={{ flex: 1 }} />
                    <button type="button" className="btn" data-variant="primary" data-size="sm"
                            onClick={saveNewCat} disabled={!newCatName.trim() || savingCat}>
                      {savingCat ? "…" : "Criar"}
                    </button>
                  </div>
                  {cats.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 160, overflowY: "auto" }}>
                      {cats.map((c) => (
                        <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, padding: "4px 8px", background: "var(--bg-1)", borderRadius: 3 }}>
                          <span>{c.label || c.name}</span>
                          <button type="button" className="btn" data-size="sm" data-variant="ghost"
                                  onClick={() => deleteCat(c.id)} style={{ padding: "2px 6px", color: "var(--crit)" }}>
                            Excluir
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Field>
          </div>

          <Field label={isPrep ? "Nome do preparo" : "Nome do produto"}>
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)}
                   placeholder={isPrep ? "ex.: Maionese da casa" : "ex.: Brasa Cheddar Bacon"} required />
          </Field>

          {isPrep ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 12 }}>
              <Field label="Rendimento" hint="Quantidade que esse preparo rende.">
                <input className="input mono" inputMode="decimal" value={yieldQty}
                       onChange={(e) => setYieldQty(e.target.value)} placeholder="1" required />
              </Field>
              <Field label="Unidade">
                <div style={{ display: "flex", gap: 4 }}>
                  {["kg", "und"].map((u) => (
                    <button key={u} type="button" className="btn" data-size="sm"
                            onClick={() => setYieldUnit(u)}
                            style={{
                              flex: 1, justifyContent: "center",
                              background:   yieldUnit === u ? "var(--accent-soft)" : "var(--bg-2)",
                              borderColor:  yieldUnit === u ? "var(--accent-line)" : "var(--line)",
                              color:        yieldUnit === u ? "var(--accent-bright)" : "var(--fg-1)",
                            }}>
                      {u}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 120px", gap: 12 }}>
              <Field label="Preço de venda (R$)" hint={isEdit ? "Recalcula o CMV teórico automaticamente." : "Pode ser ajustado depois."}>
                <input className="input" type="text" inputMode="decimal" value={price}
                       onChange={(e) => setPrice(e.target.value)} placeholder="0,00" />
              </Field>
              <Field label="Rendimento" hint="Quantas porções/unidades esta ficha rende.">
                <input className="input mono" inputMode="decimal" value={yieldQty}
                       onChange={(e) => setYieldQty(e.target.value)} placeholder="1" />
              </Field>
              <Field label="Unidade">
                <div style={{ display: "flex", gap: 4 }}>
                  {["kg", "und"].map((u) => (
                    <button key={u} type="button" className="btn" data-size="sm"
                            onClick={() => setYieldUnit(u)}
                            style={{
                              flex: 1, justifyContent: "center",
                              background:   yieldUnit === u ? "var(--accent-soft)" : "var(--bg-2)",
                              borderColor:  yieldUnit === u ? "var(--accent-line)" : "var(--line)",
                              color:        yieldUnit === u ? "var(--accent-bright)" : "var(--fg-1)",
                            }}>
                      {u}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          )}
        </div>
        <div style={{
          padding: "12px 16px", borderTop: "1px solid var(--line-soft)",
          display: "flex", justifyContent: "flex-end", gap: 8,
        }}>
          <button type="button" className="btn" data-size="sm" onClick={onCancel}>Cancelar</button>
          <button type="submit" className="btn" data-variant="primary" data-size="sm" disabled={!valid || submitting}>
            {submitting ? "Salvando…" : (isEdit ? "Salvar alterações" : (isPrep ? "Criar preparo" : "Criar ficha"))}
          </button>
        </div>
      </form>

      <ConfirmDialog
        open={!!catPendingDelete}
        tone="danger"
        title="Excluir categoria?"
        message={
          <>
            Remover a categoria <strong style={{ color: "var(--fg-0)" }}>{catPendingDelete?.label || catPendingDelete?.name}</strong>. Fichas que estão nela ficarão sem categoria.
          </>
        }
        confirmLabel="Excluir categoria"
        cancelLabel="Manter"
        busy={deletingCat}
        onCancel={() => { if (!deletingCat) setCatPendingDelete(null); }}
        onConfirm={performDeleteCat}
      />
    </div>
  );
}

// ===== Modal de adicionar/editar insumo (com suporte a Preparos como fonte) =====
// Combo com busca por digitação · filtra estoque/preparos em tempo real
function IngredientSearchCombo({ sources, sourceKey, name, onPick, onTypeName }) {
  const selected = sources.find((s) => s.key === sourceKey);
  const [query, setQuery] = useState(selected ? selected.name : (name || ""));
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Mantém o input sincronizado quando algo é selecionado por fora
  useEffect(() => {
    if (selected) setQuery(selected.name);
  }, [sourceKey]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const norm = (s) => (s || "").toString().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const q = norm(query);
  const filtered = q
    ? sources.filter((s) => norm(s.name).includes(q) || norm(s.label).includes(q))
    : sources;
  const stock = filtered.filter((s) => s.kind === "stock");
  const preps = filtered.filter((s) => s.kind === "preparation");

  const handleType = (v) => {
    setQuery(v);
    setOpen(true);
    // Se o usuário digita algo que não bate exatamente, vira modo manual (sourceKey vazio)
    if (sourceKey) {
      onTypeName(v);
    } else {
      onTypeName(v);
    }
  };

  const select = (key) => {
    onPick(key);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        className="input"
        value={query}
        onChange={(e) => handleType(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder="Buscar no estoque ou preparos · ou digitar manual"
        autoComplete="off"
      />
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50,
          background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 4,
          marginTop: 4, maxHeight: 260, overflowY: "auto", boxShadow: "0 8px 20px rgba(0,0,0,0.35)",
        }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: 11.5, color: "var(--fg-3)" }}>
              Nenhum match · "{query}" será usado como nome manual.
            </div>
          ) : (
            <>
              {stock.length > 0 && (
                <>
                  <div style={{ padding: "6px 12px", fontSize: 9.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.08em", background: "var(--bg-2)" }}>
                    Estoque
                  </div>
                  {stock.map((s) => (
                    <div key={s.key} onMouseDown={(e) => { e.preventDefault(); select(s.key); }}
                         style={{
                           padding: "8px 12px", cursor: "pointer", fontSize: 12,
                           background: s.key === sourceKey ? "var(--bg-2)" : "transparent",
                           borderBottom: "1px solid var(--line-soft)",
                         }}>
                      {s.label}
                    </div>
                  ))}
                </>
              )}
              {preps.length > 0 && (
                <>
                  <div style={{ padding: "6px 12px", fontSize: 9.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.08em", background: "var(--bg-2)" }}>
                    Preparos
                  </div>
                  {preps.map((s) => (
                    <div key={s.key} onMouseDown={(e) => { e.preventDefault(); select(s.key); }}
                         style={{
                           padding: "8px 12px", cursor: "pointer", fontSize: 12,
                           background: s.key === sourceKey ? "var(--bg-2)" : "transparent",
                           borderBottom: "1px solid var(--line-soft)",
                         }}>
                      {s.label}
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function IngredientModal({ initial, stockItems, availablePreparations = [], excludeId, onCancel, onSubmit, onDelete }) {
  const isEdit = !!initial;
  // Recebe stockItems via prop (carregado uma vez no parent · evita fetch a cada abertura)
  const stock = stockItems && stockItems.length ? stockItems : (window.__stockItemsCache || MOCK.STOCK_ITEMS);

  // Fonte unificada: estoque + preparos disponíveis (excluindo o próprio preparo se editando-se mesmo)
  const sources = [
    ...stock.map((si) => ({
      key:   `stock:${si.id}`,
      kind:  "stock",
      label: `${si.name} · ${si.cat} · R$ ${si.cost.toFixed(2)}/${si.unit}`,
      name:  si.name,
      unit:  si.unit,
      cost:  si.cost,
    })),
    ...availablePreparations
      .filter((p) => !excludeId || p.id !== excludeId)
      .map((p) => ({
        key:   `prep:${p.id}`,
        kind:  "preparation",
        label: `🔧 ${p.name} · preparo · R$ ${(p.unitCost || 0).toFixed(2)}/${p.yieldUnit}`,
        name:  p.name,
        unit:  p.yieldUnit,
        cost:  p.unitCost || 0,
      })),
  ];

  // Tenta achar a fonte que bata com o insumo existente
  const findInitialSource = () => {
    if (!initial) return "";
    const [iname, iqty] = initial;
    const m = String(iqty).match(/([a-zA-ZçÇãÃõÕéÉá-ú]+)\s*$/);
    const iunit = m ? m[1].toLowerCase() : null;
    const match = sources.find((src) =>
      src.name.toLowerCase() === String(iname).toLowerCase() &&
      (iunit ? src.unit.toLowerCase() === iunit : true)
    );
    return match ? match.key : "";
  };

  const extractQty  = (raw) => { const m = String(raw || "").match(/^[\s]*([\d.,]+)/); return m ? m[1] : ""; };
  const extractUnit = (raw) => { const m = String(raw || "").match(/([a-zA-ZçÇãÃõÕéÉá-ú]+)\s*$/); return m ? m[1] : ""; };

  const [sourceKey, setSourceKey] = useState(findInitialSource());
  const [name, setName]           = useState(initial?.[0] || "");
  const [qtyVal, setQtyVal]       = useState(initial ? extractQty(initial[1]) : "");
  const [unit, setUnit]           = useState(initial ? extractUnit(initial[1]) : "und");
  const [unitCost, setUnitCost]   = useState("");
  const [cost, setCost]           = useState(initial?.[2] != null ? String(initial[2]).replace(".", ",") : "");
  const [costEdited, setCostEdited] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const onSourceChange = (key) => {
    setSourceKey(key);
    if (!key) return;
    const src = sources.find((s) => s.key === key);
    if (!src) return;
    setName(src.name);
    setUnit(src.unit);
    setUnitCost(String(src.cost).replace(".", ","));
    setCostEdited(false);
  };

  useEffect(() => {
    if (costEdited) return;
    const q = parseFloat(String(qtyVal).replace(",", "."));
    const u = parseFloat(String(unitCost).replace(",", "."));
    if (Number.isFinite(q) && Number.isFinite(u) && q > 0 && u > 0) {
      setCost(((q * u).toFixed(2)).replace(".", ","));
    }
  }, [qtyVal, unitCost, costEdited]);

  const parsedCost = parseFloat(String(cost).replace(",", ".")) || 0;
  const parsedQty  = parseFloat(String(qtyVal).replace(",", "."));
  const valid = name.trim() && Number.isFinite(parsedQty) && parsedQty > 0 && parsedCost >= 0;

  // Guard síncrono contra duplo clique — onSubmit (onAddItem) insere item no banco
  // e o modal fecha logo em seguida; sem isso, 2 cliques no mesmo tick duplicam o insumo.
  const submittedRef = useRef(false);
  const submit = () => {
    if (!valid || submittedRef.current) return;
    submittedRef.current = true;
    const qtyDisplay = `${String(qtyVal).replace(".", ",")}${unit ? " " + unit : ""}`;
    const arr = [name.trim(), qtyDisplay, parsedCost];
    // Preserva stock_item_id e source_prep_id quando origem é selecionada
    if (sourceKey?.startsWith("stock:")) arr.stockItemId = sourceKey.slice(6);
    else if (sourceKey?.startsWith("prep:")) arr.sourcePrepId = sourceKey.slice(5);
    onSubmit(arr);
  };

  const selectedSrc = sources.find((s) => s.key === sourceKey);
  const isPrepSelected = selectedSrc?.kind === "preparation";

  return (
    <Modal
      title={isEdit ? "Editar insumo" : "Adicionar insumo"}
      subtitle="Selecione um insumo do estoque, um preparo, ou edite os campos manualmente."
      onClose={onCancel}
      width={520}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", gap: 8 }}>
          <div>
            {onDelete && (
              <button className="btn" data-variant="danger" data-size="sm"
                      onClick={() => setConfirmDelete(true)}>
                Excluir
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" data-size="sm" onClick={onCancel}>Cancelar</button>
            <button className="btn" data-variant="primary" data-size="sm" disabled={!valid} onClick={submit}>
              {isEdit ? "Salvar alterações" : "Adicionar insumo"}
            </button>
          </div>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <FormRow label="Insumo (estoque ou preparo)" hint="Digite para filtrar · preparos têm 🔧 · clique pra selecionar.">
          <IngredientSearchCombo
            sources={sources}
            sourceKey={sourceKey}
            name={name}
            onPick={(key) => onSourceChange(key)}
            onTypeName={(v) => { setSourceKey(""); setName(v); }}
          />
          {isPrepSelected && (
            <div style={{
              marginTop: 8, padding: "8px 12px",
              background: "var(--bg-2)", border: "1px solid var(--accent-line)", borderRadius: 4,
              fontSize: 11.5, color: "var(--fg-2)",
            }}>
              ⓘ Preparo selecionado · custo importado do preparo (atualiza automaticamente quando o preparo é editado).
            </div>
          )}
        </FormRow>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 1fr", gap: 12 }}>
          <FormRow label="Quantidade">
            <input className="input mono" inputMode="decimal" autoFocus value={qtyVal}
                   onChange={(e) => setQtyVal(e.target.value)} placeholder="0,16" />
          </FormRow>
          <FormRow label="Unidade" hint={sourceKey ? "vem da origem" : null}>
            <input
              className="input mono"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="kg"
              readOnly={!!sourceKey}
              title={sourceKey ? "Unidade vinculada ao insumo de origem" : ""}
              style={sourceKey ? { background: "var(--bg-3)", color: "var(--fg-2)", cursor: "not-allowed" } : null}
            />
          </FormRow>
          <FormRow label="Custo unit. (R$)" hint={sourceKey ? "vem da origem" : "opcional"}>
            <input
              className="input mono"
              inputMode="decimal"
              value={unitCost}
              onChange={(e) => { setUnitCost(e.target.value); setCostEdited(false); }}
              placeholder="0,00"
              readOnly={!!sourceKey}
              title={sourceKey ? "Custo unitário vinculado ao insumo de origem" : ""}
              style={sourceKey ? { background: "var(--bg-3)", color: "var(--fg-2)", cursor: "not-allowed" } : null}
            />
          </FormRow>
        </div>

        <FormRow label="Custo composto (R$)"
                 hint={sourceKey
                   ? "qtd × custo unitário (vem da origem)"
                   : (costEdited ? "valor manual · não recalcula automaticamente" : "qtd × custo unitário (auto)")}>
          <input
            className="input mono"
            inputMode="decimal"
            value={cost}
            onChange={(e) => { setCost(e.target.value); setCostEdited(true); }}
            placeholder="0,00"
            readOnly={!!sourceKey}
            title={sourceKey ? "Calculado a partir da origem · altere a quantidade para mudar" : ""}
            style={{
              fontSize: 14, fontWeight: 500,
              ...(sourceKey ? { background: "var(--bg-3)", color: "var(--fg-2)", cursor: "not-allowed" } : null),
            }}
          />
        </FormRow>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        tone="danger"
        title="Excluir insumo da ficha?"
        message={
          <>
            Remover <strong style={{ color: "var(--fg-0)" }}>{name || "este insumo"}</strong> da ficha técnica. O custo total da receita será recalculado.
          </>
        }
        confirmLabel="Excluir insumo"
        cancelLabel="Manter"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => { setConfirmDelete(false); onDelete && onDelete(); }}
      />
    </Modal>
  );
}

window.Recipes = Recipes;
