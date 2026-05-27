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
  const [pageLoading, setPageLoading] = useState(true);
  const [showEntry, setShowEntry] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [editingItem, setEditingItem] = useState(null); // insumo sendo editado
  const [categoryPendingDelete, setCategoryPendingDelete] = useState(null);
  const [deletingCategory, setDeletingCategory] = useState(false);
  // KPIs operacionais (mês atual) — para estoquistas que não acessam o dashboard
  const [movements, setMovements] = useState([]);     // stock_movements MTD
  // Drill-down dos KPIs de entrada/saída — clona o modal do dashboard
  const [flowDetail, setFlowDetail] = useState(null); // null | "in" | "out"

  // Carrega tenant + items + categorias do DB quando online
  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setPageLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const ctx = await dbGetCurrentContext();
        if (cancelled) return;
        const tid = ctx?.tenant?.id;
        setTenantId(tid || null);
        if (!tid) return;

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
      } finally {
        if (!cancelled) { setLoading(false); setPageLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  // Carrega movimentações do mês p/ os KPIs de Entradas/Saídas.
  // Realtime: qualquer entrada/saída ou recebimento atualiza os cards.
  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline || !tenantId) return;
    let cancelled = false;
    let reloadTimer = null;
    const load = async () => {
      const mtdFirst = new Date(); mtdFirst.setDate(1); mtdFirst.setHours(0, 0, 0, 0);
      const movRes = await dbListStockMovements(tenantId, mtdFirst.toISOString(), new Date().toISOString(), { limit: 5000 });
      if (cancelled) return;
      setMovements(movRes.data || []);
    };
    const scheduleReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { if (!cancelled) load(); }, 400);
    };
    load();
    const unsubs = [
      dbSubscribeTable?.("stock_movements", tenantId, scheduleReload),
      dbSubscribeTable?.("goods_receipts",  tenantId, scheduleReload),
    ].filter(Boolean);
    return () => {
      cancelled = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      unsubs.forEach((u) => { try { u(); } catch {} });
    };
  }, [dbStatus.state, dbStatus.isOnline, tenantId]);

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
  const createCategory = async (name) => {
    const v = String(name || "").trim();
    if (!v) return null;
    if (allCats.includes(v)) {
      window.showToast(`Categoria "${v}" já existe`, { tone: "warn" });
      return null;
    }
    // Persiste no DB se online
    if (source === "db" && tenantId && typeof dbInsertStockCategory === "function") {
      const { data, error } = await dbInsertStockCategory(tenantId, v);
      if (error) {
        window.showToast(`Erro ao criar: ${error.message}`, { tone: "crit", ttl: 4500 });
        return null;
      }
      if (data) setDbCategories((prev) => [...prev, data]);
    }
    setCategories((prev) => [...prev, v].sort());
    window.showToast(`Categoria "${v}" criada`, { tone: "ok" });
    return v;
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
    setCategoryPendingDelete(name);
  };

  const performDeleteCategory = async () => {
    const name = categoryPendingDelete;
    if (!name || deletingCategory) return;
    setDeletingCategory(true);
    try {
      // Persiste no DB se a categoria existir lá
      if (source === "db" && typeof dbDeleteStockCategory === "function") {
        const dbCat = dbCategories.find((c) => c.name === name);
        if (dbCat?.id) {
          const { error } = await dbDeleteStockCategory(dbCat.id);
          if (error) {
            window.showToast(`Erro ao excluir: ${error.message}`, { tone: "crit", ttl: 4500 });
            return;
          }
          setDbCategories((prev) => prev.filter((c) => c.id !== dbCat.id));
        }
      }
      setCategories((prev) => prev.filter((c) => c !== name));
      window.showToast(`Categoria "${name}" excluída`, { tone: "warn" });
      setCategoryPendingDelete(null);
    } finally {
      setDeletingCategory(false);
    }
  };

  // Inclui categorias gerenciadas + as que aparecem nos items (caso o item
  // foi criado com cat livre que ainda não foi registrada explicitamente)
  const allCats = useMemo(() =>
    [...new Set([...categories, ...items.map((i) => i.cat)])].sort(),
    [categories, items]
  );

  // Itens pendentes de configuração — mesma regra do StockAssistantModal
  const assistantPendingCount = useMemo(() => items.filter((it) =>
    !it.cat || it.cat === "Sem categoria" || it.cat === "Outro" ||
    !it.supplier ||
    !it.reorder || it.reorder <= 0 ||
    !it.max || it.max <= 0 ||
    !it.cost || Number(it.cost) <= 0
  ).length, [items]);

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

  const totalValue = items.reduce((s, i) => s + i.qty * i.cost, 0);

  // Recalcula status (ok / warn / crit) com base em qty x reorder
  const recomputeStatus = (it) => {
    if (it.qty <= 0) return "crit";
    if (it.reorder > 0 && it.qty < it.reorder * 0.25) return "crit";
    if (it.qty < it.reorder) return "warn";
    return "ok";
  };

  const handleEntry = async (draft) => {
    // Aceita formato novo (multi-linha) e formato antigo (linha única) para retro-compat.
    const linesIn = Array.isArray(draft.lines) && draft.lines.length > 0
      ? draft.lines
      : [{ itemId: draft.itemId, qty: draft.qty, cost: draft.cost }];
    const note = draft.note || "Entrada manual";

    // Update otimista: aplica todas as linhas localmente. `unit_cost` na nova regra
    // (última compra) sobrescreve, não faz média ponderada.
    const beforeMap = new Map();
    setItems((prev) => prev.map((it) => {
      const ln = linesIn.find((l) => l.itemId === it.id);
      if (!ln) return it;
      if (!beforeMap.has(it.id)) beforeMap.set(it.id, it);
      const qty = Number(ln.qty) || 0;
      const cost = Number(ln.cost) || 0;
      const newQty = it.qty + qty;
      const newCost = cost > 0 && qty > 0 ? cost : it.cost;
      const updated = { ...it, qty: newQty, cost: newCost };
      return { ...updated, status: recomputeStatus(updated) };
    }));
    setShowEntry(false);

    if (source === "db" && tenantId) {
      const failures = [];
      for (const ln of linesIn) {
        const qty = Number(ln.qty) || 0;
        if (qty <= 0) continue;
        const { error } = await dbApplyStockMovement(
          tenantId, ln.itemId, qty, "in",
          note,
          Number(ln.cost) || undefined,
        );
        if (error) failures.push({ itemId: ln.itemId, error });
      }
      if (failures.length > 0) {
        // Rollback dos itens que falharam
        setItems((prev) => prev.map((it) => {
          const failed = failures.find((f) => f.itemId === it.id);
          return failed && beforeMap.has(it.id) ? beforeMap.get(it.id) : it;
        }));
        window.showToast(`Erro em ${failures.length} item(ns): ${failures[0].error.message}`, { tone: "crit", ttl: 4500 });
      }
      // Refetch p/ refletir qty/custo autoritativo do banco (mesmo com falhas parciais)
      const { data: refreshed } = await dbListStockItems(tenantId);
      if (refreshed) setItems(refreshed);
      const okCount = linesIn.length - failures.length;
      if (okCount > 0) {
        window.showToast(`${okCount} entrada(s) registrada(s) no Supabase · ${note}`, { tone: "ok" });
      }
      return;
    }
    window.showToast(`${linesIn.length} entrada(s) registrada(s) · ${note}`, { tone: "ok" });
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
      // Resolve supplierId pelo nome (cria fornecedor se necessário)
      let supId = draft.supplierId;
      if (!supId && draft.supplier && draft.supplier.trim()) {
        const cli = typeof getSupabaseClient === "function" ? getSupabaseClient() : null;
        if (!cli || !tenantId) {
          console.warn("[supplier] sem cliente ou tenantId · cli=", !!cli, "tenantId=", tenantId);
        } else {
          const { data: existing, error: lookErr } = await cli.from("suppliers")
            .select("id").eq("tenant_id", tenantId).eq("name", draft.supplier.trim()).maybeSingle();
          if (lookErr) console.warn("[supplier] erro lookup:", lookErr);
          if (existing) {
            supId = existing.id;
          } else {
            const { data: created, error: insErr } = await cli.from("suppliers")
              .insert({ tenant_id: tenantId, name: draft.supplier.trim(), is_active: true })
              .select("id").single();
            if (insErr) {
              console.warn("[supplier] erro insert:", insErr);
              window.showToast(`Erro ao criar fornecedor: ${insErr.message}`, { tone: "crit" });
            }
            supId = created?.id;
          }
        }
      }
      const { data, error } = await dbUpdateStockItem(id, {
        name: draft.name, unit: draft.unit, cost: draft.cost,
        reorder: draft.min, max: draft.max,
        ...(draft.qty !== undefined ? { qty: draft.qty } : {}),
        exp: draft.exp, catId,
        supplierId: supId || null,
        composeCmv: draft.composeCmv,
      });
      if (error) {
        console.error("[handleEditItem] erro:", error);
        window.showToast(`Erro ao salvar: ${error.message}`, { tone: "crit", ttl: 6000 });
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
        ...(draft.qty !== undefined ? { qty: draft.qty } : {}),
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

  // KPIs operacionais do topo · espelham as 4 caixas do dashboard
  // (estoquistas não acessam o dashboard principal, então mostramos aqui).
  const stockFlows = useMemo(() => {
    let entradas = 0, saidas = 0;
    for (const mv of (movements || [])) {
      const value = Math.abs(mv.delta || 0) * (mv.unitCost || 0);
      if (mv.kind === "in")  entradas += value;
      else if (mv.kind === "out" || mv.kind === "loss" || mv.kind === "expiration") saidas += value;
      else if (mv.kind === "adjust") {
        // adjust preserva sinal: sobra (delta>0) entra como entrada, falta (delta<0) como saída
        if ((mv.delta || 0) > 0) entradas += value;
        else if ((mv.delta || 0) < 0) saidas += value;
      }
    }
    return { entradas, saidas };
  }, [movements]);
  const stockAlerts = useMemo(() => {
    let ruptura = 0, baixo = 0, acimaMax = 0;
    for (const i of items) {
      const qty = Number(i.qty) || 0;
      const reorder = Number(i.reorder) || 0;
      const max = Number(i.max) || 0;
      if (qty <= 0) ruptura += 1;
      else if (reorder > 0 && qty < reorder) baixo += 1;
      if (max > 0 && qty > max) acimaMax += 1;
    }
    return { total: ruptura + baixo + acimaMax, ruptura, baixo, acimaMax };
  }, [items]);

  if (pageLoading) return <PageLoading label="Carregando estoque…" variant="table" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* KPIs operacionais · espelham o dashboard p/ estoquistas */}
      <div style={{ padding: "16px 28px 4px", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <FlowKpi label="Entradas de estoque" value={stockFlows.entradas} tone="in"  onClick={() => setFlowDetail("in")} />
        <FlowKpi label="Saídas de estoque"   value={stockFlows.saidas}   tone="out" onClick={() => setFlowDetail("out")} />
        <FlowKpi label="Valor em estoque"    value={totalValue} />
        <ModuleKpi
          label="Alertas de estoque"
          value={stockAlerts.total}
          sub={`${stockAlerts.ruptura} ruptura · ${stockAlerts.baixo} baixo · ${stockAlerts.acimaMax} acima do máx`}
          tone={stockAlerts.ruptura > 0 ? "crit" : stockAlerts.total > 0 ? "warn" : "ok"}
          onClick={() => { setView("items"); setFilter("crit"); }}
          icon={<I.AlertTriangle size={11} />}
        />
      </div>

      {/* Sub-tabs Insumos | Inventário | Fornecedores | Categorias | Desperdícios */}
      <div style={{ display: "flex", padding: "14px 28px 0", gap: 0, borderBottom: "1px solid var(--line)" }}>
        <StockSubTab active={view === "items"}     onClick={() => setView("items")}    >Insumos</StockSubTab>
        <StockSubTab active={view === "inventory"} onClick={() => setView("inventory")}>Inventário</StockSubTab>
        <StockSubTab active={view === "suppliers"} onClick={() => setView("suppliers")}>Fornecedores</StockSubTab>
        <StockSubTab active={view === "categories"} onClick={() => setView("categories")}>Categorias</StockSubTab>
        <StockSubTab active={view === "wastes"}    onClick={() => setView("wastes")}    tone="crit">Desperdícios</StockSubTab>
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
      ) : view === "wastes" ? (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "20px 28px 32px" }}>
          <WastesView
            tenantId={tenantId}
            items={items}
            onApplied={async () => {
              if (source === "db" && tenantId) {
                const { data } = await dbListStockItems(tenantId);
                if (data) setItems(data);
              }
            }}
          />
        </div>
      ) : (<>
      {/* Header + filtros · uma linha só */}
      <div style={{ padding: "16px 28px 14px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
        <h1 className="h-title" style={{ margin: 0 }}>Estoque</h1>
        <Tabs value={filter} onChange={setFilter} options={[
          { id: "all",  label: "Todos",     count: items.length },
          { id: "ok",   label: "Em estoque", count: totals.ok,    tone: "ok" },
          { id: "warn", label: "Baixo",      count: totals.warn,  tone: "warn" },
          { id: "crit", label: "Ruptura",    count: totals.crit,  tone: "crit" },
        ]} />
        <span style={{ flex: 1 }} />
        <StockSearchInput value={search} onChange={setSearch} />
        <CategoryFilter allCats={allCats} selected={cats} onChange={setCats} />
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" data-size="sm" onClick={() => setShowAssistant(true)}
                  title={assistantPendingCount > 0
                    ? `${assistantPendingCount} ${assistantPendingCount === 1 ? "item pendente" : "itens pendentes"} de configuração`
                    : "Todos os itens estão configurados"}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            ✨ Assistente de estoque
            <span style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              minWidth: 18, height: 16, padding: "0 5px",
              borderRadius: 99, fontFamily: "var(--mono)", fontSize: 10, fontWeight: 500,
              letterSpacing: "0.02em",
              background: assistantPendingCount > 0 ? "var(--warn)" : "var(--bg-3)",
              color: assistantPendingCount > 0 ? "var(--accent-fg)" : "var(--fg-3)",
              border: `1px solid ${assistantPendingCount > 0 ? "var(--warn)" : "var(--line)"}`,
            }}>
              {assistantPendingCount}
            </span>
          </button>
          <button className="btn" data-size="sm" onClick={() => setShowHistory(true)}>Histórico</button>
          <button className="btn" data-size="sm" onClick={() => setShowEntry(true)}>
            <I.Plus size={13} />Entrada manual
          </button>
          <button className="btn" data-variant="primary" data-size="sm" onClick={() => setShowCreate(true)}>
            <I.Plus size={13} />Novo insumo
          </button>
        </div>
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
                <th>Insumo</th>
                <th>Categoria</th>
                <th>Fornecedor</th>
                <th>Status</th>
                <th className="num">Qtd</th>
                <th className="num">Última compra</th>
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
                    <td className="row-strong">{it.name}</td>
                    <td className="dim">{it.cat}</td>
                    <td className="dim" style={{ fontSize: 11.5 }}>
                      {it.supplier || <span style={{ color: "var(--fg-4)" }}>—</span>}
                    </td>
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

      {flowDetail && window.StockFlowDetailModal && (
        <window.StockFlowDetailModal
          direction={flowDetail}
          periodLabel="Mês atual"
          movements={movements}
          onClose={() => setFlowDetail(null)}
        />
      )}

      {showEntry  && <StockEntryModal items={items} onClose={() => setShowEntry(false)} onSave={handleEntry} />}
      {showHistory && <StockHistoryModal onClose={() => setShowHistory(false)} />}
      {showCreate && <NewStockItemModal items={items} categories={allCats} suppliers={suppliers} onCreateCategory={createCategory} onClose={() => setShowCreate(false)} onSave={handleCreateItem} />}
      {showAssistant && (
        <StockAssistantModal
          items={items}
          categories={allCats}
          suppliers={suppliers}
          tenantId={tenantId}
          onClose={() => setShowAssistant(false)}
          onSaveItem={handleEditItem}
        />
      )}
      {editingItem && (
        <NewStockItemModal
          items={items}
          categories={allCats}
          suppliers={suppliers}
          initial={editingItem}
          onCreateCategory={createCategory}
          onClose={() => setEditingItem(null)}
          onSave={(draft) => handleEditItem(editingItem.id, draft)}
          onDelete={() => handleDeleteItem(editingItem.id)}
        />
      )}

      <ConfirmDialog
        open={!!categoryPendingDelete}
        tone="danger"
        title="Excluir categoria?"
        message={
          <>
            Remover a categoria <strong style={{ color: "var(--fg-0)" }}>{categoryPendingDelete}</strong> do estoque. Essa ação não pode ser desfeita.
          </>
        }
        confirmLabel="Excluir categoria"
        cancelLabel="Manter"
        busy={deletingCategory}
        onCancel={() => { if (!deletingCategory) setCategoryPendingDelete(null); }}
        onConfirm={performDeleteCategory}
      />
    </div>
  );
}

// Modal usado tanto para criar (sem `initial`) quanto editar (com `initial`).
// Em modo edição, a quantidade atual NÃO é exibida nem editada — saldo só
// muda via Entrada manual ou Inventário.
function NewStockItemModal({ items, initial, categories, suppliers = [], onClose, onSave, onDelete, onCreateCategory }) {
  const isEdit = !!initial;
  const [creatingCat, setCreatingCat] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [savingCat, setSavingCat] = useState(false);
  // Categorias gerenciadas (passadas pelo Stock); caso ausente, deriva dos items.
  const existingCats = categories && categories.length
    ? categories
    : [...new Set(items.map((i) => i.cat))];
  const [name, setName] = useState(initial?.name ?? "");
  const [cat,  setCat]  = useState(initial?.cat  ?? (existingCats[0] || "Outro"));
  const [unit, setUnit] = useState(initial?.unit ?? "kg");
  const [cost, setCost] = useState(initial?.cost != null ? String(initial.cost) : "");
  const [qty,  setQty]  = useState(initial?.qty != null ? String(initial.qty) : "0");
  const [min,  setMin]  = useState(initial?.reorder != null ? String(initial.reorder) : "");
  const [max,  setMax]  = useState(initial?.max     != null ? String(initial.max)     : "");
  const [exp,  setExp]  = useState(initial?.exp && initial.exp !== "—" ? initial.exp : "");
  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? "");
  const [composeCmv, setComposeCmv] = useState(initial?.composeCmv !== false);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Min/max opcionais · vazios viram 0
  const minN  = Number.isFinite(parseFloat(String(min).replace(",", "."))) ? parseFloat(String(min).replace(",", ".")) : 0;
  const maxN  = Number.isFinite(parseFloat(String(max).replace(",", "."))) ? parseFloat(String(max).replace(",", ".")) : 0;
  // Validação granular por campo (para feedback visual)
  const errs = {
    name: !name.trim(),
    cat:  !cat.trim(),
    unit: !unit.trim(),
    min:  minN < 0,
    max:  maxN < 0 || (maxN > 0 && minN > 0 && maxN < minN),
  };
  const valid = !errs.name && !errs.cat && !errs.unit && !errs.min && !errs.max;
  const errorMessages = [
    errs.name && "Nome do insumo obrigatório",
    errs.cat  && "Categoria obrigatória",
    errs.unit && "Unidade obrigatória",
    errs.min  && "Estoque mínimo não pode ser negativo",
    errs.max  && "Estoque máximo precisa ser ≥ mínimo",
  ].filter(Boolean);

  const handleSubmit = async () => {
    if (saving || !valid) return;
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        cat:  cat.trim(),
        unit: unit.trim(),
        cost: parseFloat(String(cost).replace(",", ".")) || 0,
        qty: parseFloat(String(qty).replace(",", ".")) || 0,
        min:  minN,
        max:  maxN,
        exp:  exp.trim(),
        supplierId: supplierId || null,
        composeCmv,
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
        ? `${initial.id} · ajuste mínimo e máximo`
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
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Farinha de trigo integral"
                 style={errs.name ? { borderColor: "var(--crit)" } : null} />
        </FormRow>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 0.8fr 1fr", gap: 12 }}>
          <FormRow label="Categoria">
            {creatingCat ? (
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="input"
                  autoFocus
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  placeholder="Nome da nova categoria"
                  disabled={savingCat}
                  onKeyDown={async (e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const v = newCatName.trim();
                      if (!v || savingCat) return;
                      setSavingCat(true);
                      try {
                        const created = typeof onCreateCategory === "function" ? await onCreateCategory(v) : v;
                        if (created) {
                          setCat(created);
                          setCreatingCat(false);
                          setNewCatName("");
                        }
                      } finally {
                        setSavingCat(false);
                      }
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setCreatingCat(false);
                      setNewCatName("");
                    }
                  }}
                />
                <button className="btn" data-variant="primary" data-size="sm" disabled={!newCatName.trim() || savingCat}
                        onClick={async () => {
                          const v = newCatName.trim();
                          if (!v) return;
                          setSavingCat(true);
                          try {
                            const created = typeof onCreateCategory === "function" ? await onCreateCategory(v) : v;
                            if (created) {
                              setCat(created);
                              setCreatingCat(false);
                              setNewCatName("");
                            }
                          } finally {
                            setSavingCat(false);
                          }
                        }}>
                  {savingCat ? "…" : "Criar"}
                </button>
                <button className="btn" data-size="sm" disabled={savingCat}
                        onClick={() => { setCreatingCat(false); setNewCatName(""); }}>
                  Cancelar
                </button>
              </div>
            ) : (
              <select className="select" value={cat} onChange={(e) => {
                const v = e.target.value;
                if (v === "__new__") { setCreatingCat(true); return; }
                setCat(v);
              }} required style={errs.cat ? { borderColor: "var(--crit)" } : null}>
                <option value="" disabled>Selecione…</option>
                {existingCats.map((c) => <option key={c} value={c}>{c}</option>)}
                <option value="__new__">+ Criar categoria…</option>
              </select>
            )}
          </FormRow>
          <FormRow label="Unidade">
            <select className="select" value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option value="kg">kg</option>
              <option value="un">un</option>
            </select>
          </FormRow>
          <FormRow label="Custo unit. (R$)">
            <input className="input mono" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0,00" />
          </FormRow>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: isEdit ? "1fr 1fr" : "1fr 1fr 1fr", gap: 12 }}>
          <FormRow label={`Estoque mínimo (${unit})`} hint="Aciona compra quando atingir.">
            <input className="input mono" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} placeholder="0"
                   style={errs.min ? { borderColor: "var(--crit)" } : null} />
          </FormRow>
          <FormRow label={`Estoque máximo (${unit})`} hint="Quantidade alvo após compra.">
            <input className="input mono" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} placeholder="0"
                   style={errs.max ? { borderColor: "var(--crit)" } : null} />
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

        {errorMessages.length > 0 && (
          <div style={{
            padding: "8px 12px", background: "var(--crit-soft)",
            border: "1px solid var(--crit-line)", borderRadius: 4,
            fontSize: 11.5, color: "var(--crit)",
          }}>
            <strong>Não pode salvar:</strong>
            <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
              {errorMessages.map((m, i) => <li key={i}>{m}</li>)}
            </ul>
          </div>
        )}

        <label style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 12px", marginTop: 2,
          background: composeCmv ? "var(--ok-soft)" : "var(--bg-2)",
          border: `1px solid ${composeCmv ? "var(--ok-line)" : "var(--line)"}`,
          borderRadius: 6, cursor: "pointer",
        }}>
          <input type="checkbox" checked={composeCmv} onChange={(e) => setComposeCmv(e.target.checked)} />
          <div style={{ flex: 1, fontSize: 12 }}>
            <strong style={{ color: "var(--fg-0)" }}>Compõe CMV</strong>
            <div style={{ color: "var(--fg-3)", fontSize: 10.5, marginTop: 2 }}>
              Quando desligado, esse insumo é ignorado nos cálculos de CMV (descartáveis, embalagens, limpeza, etc).
            </div>
          </div>
        </label>

        {Number.isFinite(minN) && Number.isFinite(maxN) && maxN < minN && (
          <div style={{ fontSize: 11.5, color: "var(--warn)" }}>
            Estoque máximo não pode ser menor que o mínimo.
          </div>
        )}

      </div>
    </Modal>
  );
}

function StockEntryModal({ items, onClose, onSave }) {
  // Picker vem do page-requests.jsx via window — lazy lookup pra evitar
  // ReferenceError cross-file quando esbuild trata cada .jsx como módulo strict.
  const StockItemPicker = window.StockItemPicker;
  const catalog = useMemo(
    () => [...(items || [])].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [items],
  );

  const [lines, setLines] = useState([{ stock_item_id: "", qty: "", cost: "" }]);
  const [note,  setNote]  = useState("");
  const [openSignals, setOpenSignals] = useState({});
  // Abre o picker da primeira linha automaticamente quando o modal monta.
  useEffect(() => { setOpenSignals({ 0: 1 }); }, []);

  const parseN = (raw) => parseFloat(String(raw ?? "").replace(",", ".")) || 0;
  const setLine    = (i, k, v) => setLines((prev) => prev.map((ln, j) => j === i ? { ...ln, [k]: v } : ln));
  const removeLine = (i) => setLines((prev) => prev.filter((_, j) => j !== i));
  const addLine    = () => {
    const newIdx = lines.length; // posição do item recém-criado (após o push)
    setLines((prev) => [...prev, { stock_item_id: "", qty: "", cost: "" }]);
    setOpenSignals((cur) => ({ ...cur, [newIdx]: (cur[newIdx] || 0) + 1 }));
  };

  // Não permite o mesmo insumo em duas linhas
  const usedIds = (currentIdx) =>
    new Set(lines.filter((_, j) => j !== currentIdx).map((ln) => ln.stock_item_id).filter(Boolean));

  const validLines = lines.filter((ln) => ln.stock_item_id && parseN(ln.qty) > 0);
  const total = validLines.reduce((s, ln) => s + parseN(ln.qty) * parseN(ln.cost), 0);
  const valid = validLines.length > 0;

  // Enter no campo de custo da última linha vira "Adicionar item"
  const onCostKeyDown = (e, i) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const ln = lines[i];
    if (!ln.stock_item_id || parseN(ln.qty) <= 0) return;
    if (i === lines.length - 1) addLine();
  };

  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      await onSave({
        note: note.trim(),
        lines: validLines.map((ln) => ({
          itemId: ln.stock_item_id,
          qty:    parseN(ln.qty),
          cost:   parseN(ln.cost),
        })),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Entrada manual de estoque"
           subtitle="Selecione insumos do estoque · qty e custo unitário por linha."
           onClose={onClose}
           width={760}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", gap: 12 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-3)" }}>
            {validLines.length} {validLines.length === 1 ? "item" : "itens"} · total R$ {total.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" data-size="sm" onClick={onClose} disabled={submitting}>Cancelar</button>
            <button className="btn" data-variant="primary" data-size="sm" onClick={submit} disabled={!valid || submitting}>
              {submitting ? "Salvando…" : "Confirmar entrada"}
            </button>
          </div>
        </div>
      }>
      <div className="h-eyebrow" style={{ marginBottom: 8 }}>Itens · {lines.length}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {/* Header da grade */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 90px 110px 100px 32px",
          gap: 10, alignItems: "center",
          padding: "0 4px",
          fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)",
          letterSpacing: "0.08em", textTransform: "uppercase",
        }}>
          <span>Insumo</span>
          <span style={{ textAlign: "right" }}>Qtd</span>
          <span style={{ textAlign: "right" }}>Custo unit.</span>
          <span style={{ textAlign: "right" }}>Subtotal</span>
          <span />
        </div>

        {lines.map((ln, i) => {
          const item = catalog.find((it) => it.id === ln.stock_item_id);
          const qtyN = parseN(ln.qty);
          const subtotal = qtyN * parseN(ln.cost);
          const taken = usedIds(i);
          return (
            <div key={i} style={{
              display: "grid",
              gridTemplateColumns: "1fr 90px 110px 100px 32px",
              gap: 10, alignItems: "center",
            }}>
              {StockItemPicker ? (
                <StockItemPicker
                  items={catalog}
                  value={ln.stock_item_id}
                  onChange={(id) => setLine(i, "stock_item_id", id)}
                  openSignal={openSignals[i]}
                  disabledIds={Array.from(taken)}
                />
              ) : (
                // Fallback raríssimo caso page-requests.jsx ainda não tenha carregado
                <select className="select" value={ln.stock_item_id}
                        onChange={(e) => setLine(i, "stock_item_id", e.target.value)}>
                  <option value="">Selecione…</option>
                  {catalog.filter((it) => !taken.has(it.id)).map((it) =>
                    <option key={it.id} value={it.id}>{it.name} ({it.unit})</option>
                  )}
                </select>
              )}
              <input className="input mono" inputMode="decimal"
                     value={ln.qty} placeholder="0"
                     onChange={(e) => setLine(i, "qty", e.target.value)}
                     style={{ textAlign: "right" }}
                     disabled={!item} />
              <input className="input mono" inputMode="decimal"
                     value={ln.cost} placeholder="0,00"
                     onChange={(e) => setLine(i, "cost", e.target.value)}
                     onKeyDown={(e) => onCostKeyDown(e, i)}
                     style={{ textAlign: "right" }}
                     disabled={!item} />
              <span className="mono" style={{
                fontSize: 11.5,
                color: subtotal > 0 ? "var(--fg-1)" : "var(--fg-3)",
                textAlign: "right",
              }}>
                {subtotal > 0
                  ? "R$ " + subtotal.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                  : "—"}
              </span>
              <button type="button" className="btn" data-variant="ghost" data-size="sm"
                      onClick={() => removeLine(i)}
                      disabled={lines.length === 1}
                      style={{ padding: "4px 6px" }}
                      title={lines.length === 1 ? "É preciso ao menos uma linha" : "Remover item"}>
                <I.X size={11} />
              </button>
            </div>
          );
        })}

        <button type="button" className="btn" data-variant="ghost" data-size="sm"
                onClick={addLine}
                style={{ alignSelf: "flex-start", marginTop: 4 }}>
          <I.Plus size={11} />Adicionar item
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        <FormRow label="Nota / NF (aplica a todos os itens)">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)}
                 placeholder="Ex.: NF 8423 · Hortifruti" />
        </FormRow>
      </div>
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
  const [consumption7d, setConsumption7d] = useState(null);
  const [autoMin, setAutoMin] = useState(item.autoMin === true);
  const [savingAutoMin, setSavingAutoMin] = useState(false);

  useEffect(() => { setAutoMin(item.autoMin === true); }, [item.id, item.autoMin]);

  const toggleAutoMin = async (next) => {
    setAutoMin(next);
    if (typeof dbSetStockItemAutoMin === "function") {
      setSavingAutoMin(true);
      try {
        const { error } = await dbSetStockItemAutoMin(item.id, next);
        if (error) {
          setAutoMin(!next);
          window.showToast(`Erro: ${error.message}`, { tone: "crit" });
        } else {
          window.showToast(next ? "Auto-cálculo ativado · min/max recalculados" : "Auto-cálculo desativado", { tone: "ok" });
        }
      } finally {
        setSavingAutoMin(false);
      }
    }
  };

  useEffect(() => {
    if (!dbStatus.isOnline || !item.id) { setMovements([]); setConsumption7d({ qty: 0, daily: 0, hasData: false }); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const tid = ctx?.tenant?.id;
      if (!tid) { setMovements([]); return; }
      const days30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const days7  = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString();
      const [recent, m30, m7] = await Promise.all([
        dbListStockMovements(tid, null, null, { stockItemId: item.id, limit: 8 }),
        dbListStockMovements(tid, days30, null, { stockItemId: item.id, limit: 500 }),
        dbListStockMovements(tid, days7,  null, { stockItemId: item.id, limit: 500 }),
      ]);
      if (cancelled) return;
      setMovements(recent.source === "db" ? (recent.data || []) : []);
      const outs30 = (m30.data || []).filter((m) => m.kind === "out");
      const outs7  = (m7.data  || []).filter((m) => m.kind === "out");
      const total30 = outs30.reduce((s, m) => s + Math.abs(Number(m.delta) || 0), 0);
      const total7  = outs7.reduce((s, m) => s + Math.abs(Number(m.delta) || 0), 0);
      const useMonthly = total30 > 0;
      const daily = useMonthly ? (total30 / 30) : (total7 / 7);
      setConsumption7d({
        qty: useMonthly ? total30 : total7,
        daily,
        window: useMonthly ? 30 : 7,
        hasData: daily > 0,
      });
    })();
    return () => { cancelled = true; };
  }, [dbStatus.isOnline, item.id]);

  const suggestedMin = consumption7d?.hasData ? Math.ceil(consumption7d.daily * 3) : null;
  const suggestedMax = suggestedMin != null ? suggestedMin * 2 : null;

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

      <div style={{ padding: "14px 18px", borderTop: "1px solid var(--line-soft)" }}>
        <div className="h-eyebrow" style={{ marginBottom: 8 }}>Consumo recente</div>
        {consumption7d == null ? (
          <span style={{ fontSize: 11, color: "var(--fg-3)" }}>Carregando…</span>
        ) : consumption7d.hasData ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--fg-1)" }}>
              <span>Janela: <strong>{consumption7d.window}d</strong></span>
              <span>Total: <strong className="mono">{consumption7d.qty.toFixed(2)} {item.unit}</strong></span>
              <span>Média/dia: <strong className="mono">{consumption7d.daily.toFixed(2)} {item.unit}</strong></span>
            </div>
            <label style={{
              display: "flex", alignItems: "center", gap: 8,
              marginTop: 10, padding: "8px 10px",
              background: autoMin ? "var(--ok-soft)" : "var(--bg-2)",
              border: `1px solid ${autoMin ? "var(--ok-line)" : "var(--line)"}`,
              borderRadius: 4, fontSize: 11.5, color: "var(--fg-1)", cursor: "pointer",
            }}>
              <input type="checkbox" checked={autoMin} disabled={savingAutoMin}
                     onChange={(e) => toggleAutoMin(e.target.checked)} />
              <span style={{ flex: 1 }}>
                Auto-calcular min/max ({suggestedMin ?? "—"} / {suggestedMax ?? "—"} {item.unit})
              </span>
              {savingAutoMin && <span style={{ fontSize: 10, color: "var(--fg-3)" }}>…</span>}
            </label>
            {autoMin && (
              <div style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.4 }}>
                Sistema atualiza min/max sozinho a cada nova movimentação (média 7d × 3 dias).
              </div>
            )}
          </>
        ) : (
          <span style={{ fontSize: 11, color: "var(--fg-3)" }}>
            Sem movimentações de saída registradas nos últimos 30 dias.
          </span>
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

// Sub-tab das vistas do Estoque (Insumos / Inventário / etc).
// `tone="crit"` mantém a cor padrão do texto mas pinta o underline em vermelho
// — sinaliza Desperdícios como área operacional de atenção sem destoar do menu.
function StockSubTab({ active, onClick, tone, children }) {
  const isCrit = tone === "crit";
  return (
    <button onClick={onClick} style={{
      background: "transparent", border: "none",
      padding: "10px 14px", fontSize: 12.5,
      color: active ? "var(--fg-0)" : "var(--fg-2)",
      fontWeight: active ? 500 : 400,
      letterSpacing: "-0.005em",
      borderBottom: `2px solid ${active ? (isCrit ? "var(--crit)" : "var(--accent-bright)") : "transparent"}`,
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

  const deleteCurrent = async () => {
    if (!editing?.id) {
      setEditing(null);
      return;
    }
    setBusy(true);
    try {
      const { error } = await dbDeleteSupplier(editing.id);
      if (error) {
        window.showToast(`Erro ao excluir: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
      setSuppliers((prev) => prev.filter((x) => x.id !== editing.id));
      window.showToast(`Fornecedor ${editing.sup} excluído`, { tone: "warn" });
      setEditing(null);
    } finally {
      setBusy(false);
    }
  };

  // Calcula quantos insumos cada fornecedor possui
  const [itemsByFornecedor, setItemsByFornecedor] = useState({});
  useEffect(() => {
    if (!tenantId || !dbStatus.isOnline) return;
    let cancelled = false;
    dbListStockItems(tenantId).then(({ data }) => {
      if (cancelled || !data) return;
      const counts = {};
      for (const it of data) {
        const sid = it.supplierId;
        if (sid) counts[sid] = (counts[sid] || 0) + 1;
      }
      setItemsByFornecedor(counts);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [tenantId, dbStatus.isOnline, suppliers.length]);

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
      {editing && <SupplierModal
        initial={editing.sup ? editing : null}
        busy={busy}
        itemsCount={editing?.id ? (itemsByFornecedor[editing.id] || 0) : 0}
        onClose={() => setEditing(null)}
        onSave={save}
        onDelete={editing?.id && source === "db" ? deleteCurrent : null}
      />}
    </div>
  );
}

function SupplierModal({ initial, onClose, onSave, onDelete, itemsCount = 0, busy }) {
  const [sup, setSup]         = useState(initial?.sup || "");
  const [contact, setContact] = useState(initial?.contact || "");
  const [lead, setLead]       = useState(initial?.lead || "24h");
  const [confirming, setConfirming] = useState(false);
  const valid = !!sup.trim();
  const canDelete = !!initial && !!onDelete && itemsCount === 0;
  return (
    <Modal title={initial ? "Editar fornecedor" : "Novo fornecedor"} onClose={onClose}
      footer={<>
        {initial && onDelete && (
          <button className="btn" data-variant="danger" data-size="sm"
                  disabled={!canDelete || busy}
                  onClick={() => setConfirming(true)}
                  title={canDelete ? "Excluir este fornecedor" : `Não é possível excluir: ${itemsCount} insumo(s) vinculado(s)`}
                  style={{ marginRight: "auto" }}>
            <I.Trash size={12} />Excluir fornecedor
          </button>
        )}
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

      {initial && !canDelete && (
        <div style={{ marginTop: 12, padding: "8px 12px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 4, fontSize: 11.5, color: "var(--fg-1)" }}>
          ⚠ Esse fornecedor está vinculado a <strong>{itemsCount}</strong> insumo(s). Para excluir, primeiro remova o vínculo nos insumos do estoque.
        </div>
      )}

      {confirming && (
        <div onClick={() => setConfirming(false)} style={{
          position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.6)",
          display: "grid", placeItems: "center",
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            width: 380, background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 8,
            padding: 20,
          }}>
            <h3 style={{ margin: 0, fontSize: 15, color: "var(--fg-0)" }}>Excluir fornecedor?</h3>
            <p style={{ fontSize: 12, color: "var(--fg-2)", marginTop: 8 }}>
              Esta ação não pode ser desfeita. O fornecedor <strong>{initial.sup}</strong> será removido.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
              <button className="btn" data-size="sm" onClick={() => setConfirming(false)} disabled={busy}>Cancelar</button>
              <button className="btn" data-variant="danger" data-size="sm" disabled={busy}
                      onClick={async () => { await onDelete(); setConfirming(false); }}>
                {busy ? "Excluindo…" : "Excluir"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ===================== Assistente de Estoque =====================
// Walkthrough item-a-item para preencher campos faltantes (categoria, fornecedor,
// mínimo, máximo). Opção de calcular mínimo automaticamente baseado em consumo 7d.
function StockAssistantModal({ items, categories = [], suppliers: initialSuppliers = [], tenantId, onClose, onSaveItem }) {
  // Carrega fornecedores reais do DB (caso a prop venha vazia ou desatualizada)
  const [suppliers, setSuppliers] = useState(initialSuppliers || []);
  useEffect(() => {
    if (!tenantId || typeof dbListSuppliers !== "function") return;
    let cancelled = false;
    dbListSuppliers(tenantId).then(({ data }) => {
      if (!cancelled && Array.isArray(data) && data.length > 0) setSuppliers(data);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [tenantId]);
  const itemsToReview = useMemo(() => {
    return items.filter((it) =>
      !it.cat || it.cat === "Sem categoria" || it.cat === "Outro" ||
      !it.supplier ||
      !it.reorder || it.reorder <= 0 ||
      !it.max || it.max <= 0 ||
      !it.cost || Number(it.cost) <= 0
    );
  }, [items]);

  const [started, setStarted] = useState(false);
  const [idx, setIdx] = useState(0);
  const [savingItem, setSavingItem] = useState(false);
  const [itemAutoMin, setItemAutoMin] = useState(false);

  // Estado por item · editado
  const [draft, setDraft] = useState({});
  const [consumption7d, setConsumption7d] = useState(null); // { qty, daily, hasData }

  const current = itemsToReview[idx];

  // Quando o item muda, carrega defaults e consumo 7d
  useEffect(() => {
    if (!current) return;
    setDraft({
      name: current.name,
      cat: current.cat || "",
      supplier: current.supplier || "",
      cost: current.cost || 0,
      reorder: current.reorder || "",
      max: current.max || "",
      unit: current.unit || "kg",
      exp: current.exp && current.exp !== "—" ? current.exp : "",
      composeCmv: current.composeCmv !== false,
    });
    setItemAutoMin(current.autoMin === true);
    setConsumption7d(null);
    if (tenantId && typeof dbListStockMovements === "function") {
      const days30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const days7  = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString();
      Promise.all([
        dbListStockMovements(tenantId, days30, null, { stockItemId: current.id, limit: 500 }),
        dbListStockMovements(tenantId, days7,  null, { stockItemId: current.id, limit: 500 }),
      ]).then(([res30, res7]) => {
        const outs30 = (res30.data || []).filter((m) => m.kind === "out");
        const outs7  = (res7.data  || []).filter((m) => m.kind === "out");
        const total30 = outs30.reduce((s, m) => s + Math.abs(Number(m.delta) || 0), 0);
        const total7  = outs7.reduce((s, m) => s + Math.abs(Number(m.delta) || 0), 0);
        // Prioriza 30d, fallback 7d
        const useMonthly = total30 > 0;
        const daily = useMonthly ? (total30 / 30) : (total7 / 7);
        setConsumption7d({
          qty: useMonthly ? total30 : total7,
          daily,
          window: useMonthly ? 30 : 7,
          hasData: daily > 0,
        });
      }).catch(() => setConsumption7d({ qty: 0, daily: 0, window: 7, hasData: false }));
    } else {
      setConsumption7d({ qty: 0, daily: 0, window: 7, hasData: false });
    }
  }, [current?.id, tenantId]);

  // Sugestão automática · mesma fórmula do trigger compute_auto_min_max no banco:
  //   min = ceil(daily * 7)   — 7 dias de consumo
  //   max = ceil(min * 1.3)   — min + 30% de margem
  const suggestedMin = consumption7d?.hasData
    ? Math.ceil(consumption7d.daily * 7)
    : null;
  const suggestedMax = suggestedMin != null ? Math.ceil(suggestedMin * 1.3) : null;

  // Compara sugestão vs. valores atuais do draft · alerta quando algum dos dois ficou abaixo
  const minMaxAlert = useMemo(() => {
    if (suggestedMin == null) return null;
    const currentMin = Number(draft.reorder) || 0;
    const currentMax = Number(draft.max) || 0;
    const minBelow = currentMin > 0 ? suggestedMin > currentMin : true;
    const maxBelow = currentMax > 0 ? suggestedMax > currentMax : true;
    if (!minBelow && !maxBelow) return null;
    const scope = minBelow && maxBelow ? "both" : minBelow ? "min" : "max";
    return { scope, minBelow, maxBelow, suggestedMin, suggestedMax };
  }, [suggestedMin, suggestedMax, draft.reorder, draft.max]);

  const applySuggested = () => {
    setDraft((d) => ({
      ...d,
      reorder: suggestedMin ?? d.reorder,
      max: suggestedMax ?? d.max,
    }));
  };

  const saveAndNext = async () => {
    if (savingItem || !current) return;
    setSavingItem(true);
    try {
      const patch = {
        name: draft.name,
        cat: draft.cat,
        supplier: draft.supplier,
        supplierId: draft.supplierId || null,
        cost: Number(draft.cost) || 0,
        unit: draft.unit,
        min: Number(draft.reorder) || 0,
        max: Number(draft.max) || 0,
        exp: draft.exp,
        composeCmv: draft.composeCmv !== false,
      };
      await onSaveItem(current.id, patch);
      // Persiste flag auto_min (dispara trigger que recalcula min/max no banco)
      if (typeof dbSetStockItemAutoMin === "function") {
        await dbSetStockItemAutoMin(current.id, itemAutoMin);
      }
      if (idx < itemsToReview.length - 1) {
        setIdx(idx + 1);
      } else {
        window.showToast(`Assistente concluído · ${itemsToReview.length} itens revisados`, { tone: "ok" });
        onClose();
      }
    } finally {
      setSavingItem(false);
    }
  };

  const skip = () => {
    if (idx < itemsToReview.length - 1) setIdx(idx + 1);
    else onClose();
  };

  // Tela inicial · explicação
  if (!started) {
    return (
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, zIndex: 90,
        background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center",
      }}>
        <div onClick={(e) => e.stopPropagation()} style={{
          width: 540, background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 8,
          padding: "24px 24px 20px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <span style={{ fontSize: 22 }}>✨</span>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500, color: "var(--fg-0)" }}>
              Assistente de Estoque
            </h2>
          </div>
          <p style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--fg-1)", margin: "0 0 14px" }}>
            Esse assistente revisa <strong>item a item</strong> os insumos que estão sem alguma configuração importante
            (categoria, fornecedor, estoque mínimo/máximo). Você confirma os dados e avança.
          </p>

          <div style={{
            padding: "12px 14px", background: "var(--bg-2)",
            border: "1px solid var(--line)", borderRadius: 6,
            marginBottom: 14, fontSize: 11.5, color: "var(--fg-2)",
          }}>
            <strong style={{ color: "var(--fg-0)", fontSize: 12.5, display: "block", marginBottom: 6 }}>
              Estoque mínimo automático
            </strong>
            <span>
              Em cada item você pode <strong>ligar/desligar</strong> o cálculo automático de mínimo e máximo,
              baseado no <strong>consumo médio dos últimos 7 dias</strong> (3 dias de buffer).
              Quando ativado, o sistema atualiza sozinho sempre que houver nova movimentação.
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "var(--bg-2)", borderRadius: 6, marginBottom: 16 }}>
            <span style={{ fontSize: 12, color: "var(--fg-2)" }}>Itens a revisar</span>
            <span className="mono" style={{ fontSize: 18, fontWeight: 500, color: itemsToReview.length === 0 ? "var(--ok)" : "var(--warn)" }}>
              {itemsToReview.length}
            </span>
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn" data-size="sm" onClick={onClose}>Fechar</button>
            <button className="btn" data-variant="primary" data-size="sm"
                    disabled={itemsToReview.length === 0}
                    onClick={() => setStarted(true)}>
              {itemsToReview.length === 0 ? "Tudo configurado" : "Iniciar revisão →"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!current) return null;
  const missing = {
    cat: !current.cat || current.cat === "Sem categoria" || current.cat === "Outro",
    supplier: !current.supplier,
    reorder: !current.reorder || current.reorder <= 0,
    max: !current.max || current.max <= 0,
    cost: !current.cost || Number(current.cost) <= 0,
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 90,
      background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 620, maxHeight: "90vh", display: "flex", flexDirection: "column",
        background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 8,
      }}>
        {/* Header */}
        <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid var(--line)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span className="h-eyebrow">Item {idx + 1} de {itemsToReview.length}</span>
            <button className="btn" data-variant="ghost" data-size="sm" onClick={onClose}>×</button>
          </div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500, color: "var(--fg-0)" }}>{current.name}</h2>
          <div className="bar" style={{ height: 3, marginTop: 10 }}>
            <i style={{ width: `${((idx + 1) / itemsToReview.length) * 100}%`, background: "var(--accent-bright)" }} />
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Consumo 7d */}
          <div style={{
            padding: "10px 12px", background: "var(--bg-2)",
            border: "1px solid var(--line)", borderRadius: 6, fontSize: 11.5,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <strong style={{ color: "var(--fg-0)" }}>Consumo últimos 7 dias</strong>
              {consumption7d == null && <span style={{ color: "var(--fg-3)" }}>carregando…</span>}
            </div>
            {consumption7d && consumption7d.hasData ? (
              <div style={{ color: "var(--fg-1)" }}>
                Janela usada: <strong>{consumption7d.window} dias</strong> ·
                Total: <strong className="mono">{consumption7d.qty.toFixed(2)} {current.unit}</strong> ·
                Média diária: <strong className="mono">{consumption7d.daily.toFixed(2)} {current.unit}</strong>
                {suggestedMin != null && (
                  <div style={{ marginTop: 6, padding: "8px 10px", background: "var(--bg-1)", borderRadius: 4, color: "var(--fg-1)", fontSize: 11 }}>
                    Cálculo: <strong>min {suggestedMin} {current.unit}</strong> · <strong>max {suggestedMax} {current.unit}</strong>
                    <button className="btn" data-size="sm" style={{ marginLeft: 10 }} onClick={applySuggested}>
                      Preencher campos
                    </button>
                  </div>
                )}
                {minMaxAlert && (
                  <div style={{
                    marginTop: 8, padding: "10px 12px",
                    background: "var(--ok-soft)", border: "1px solid var(--ok-line)",
                    borderRadius: 4, color: "var(--fg-1)", fontSize: 11,
                    display: "flex", flexDirection: "column", gap: 6,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="badge" data-tone="ok">AJUSTE SUGERIDO</span>
                      <strong style={{ color: "var(--fg-0)" }}>
                        {minMaxAlert.scope === "both" && "Mínimo e máximo abaixo do consumo"}
                        {minMaxAlert.scope === "min"  && "Mínimo abaixo do consumo"}
                        {minMaxAlert.scope === "max"  && "Máximo abaixo do consumo"}
                      </strong>
                    </div>
                    <div>
                      {minMaxAlert.scope === "both" && (
                        <>O consumo calculado (<strong className="mono">{suggestedMin} {current.unit}</strong> / <strong className="mono">{suggestedMax} {current.unit}</strong>) é maior que o mínimo e o máximo configurados.</>
                      )}
                      {minMaxAlert.scope === "min" && (
                        <>O mínimo sugerido (<strong className="mono">{suggestedMin} {current.unit}</strong>) é maior que o configurado.</>
                      )}
                      {minMaxAlert.scope === "max" && (
                        <>O máximo sugerido (<strong className="mono">{suggestedMax} {current.unit}</strong>) é maior que o configurado.</>
                      )}
                      {" "}Ative o <strong>cálculo automático</strong> abaixo para o sistema reajustar sozinho a cada movimentação.
                    </div>
                  </div>
                )}
              </div>
            ) : consumption7d ? (
              <div style={{ color: "var(--fg-3)" }}>
                Sem movimentações registradas nos últimos 30 dias · auto-cálculo indisponível para esse item.
              </div>
            ) : null}
          </div>

          {/* Toggle auto-min por item · realça com anel verde quando há alerta de min/max */}
          <label style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "10px 12px",
            background: itemAutoMin ? "var(--ok-soft)" : (minMaxAlert ? "var(--ok-soft)" : "var(--bg-2)"),
            border: `1px solid ${itemAutoMin || minMaxAlert ? "var(--ok-line)" : "var(--line)"}`,
            boxShadow: minMaxAlert && !itemAutoMin ? "0 0 0 2px var(--ok-line)" : null,
            borderRadius: 6, cursor: consumption7d?.hasData ? "pointer" : "not-allowed",
            opacity: consumption7d?.hasData ? 1 : 0.5,
          }}>
            <input type="checkbox" checked={itemAutoMin}
                   disabled={!consumption7d?.hasData}
                   onChange={(e) => setItemAutoMin(e.target.checked)} />
            <div style={{ flex: 1, fontSize: 11.5, color: "var(--fg-1)" }}>
              <strong style={{ color: "var(--fg-0)" }}>Auto-calcular mínimo e máximo</strong>
              <div style={{ color: "var(--fg-3)", fontSize: 10.5, marginTop: 2 }}>
                {consumption7d?.hasData
                  ? "Sistema atualiza min/max a cada movimentação. Você ainda pode editar manualmente quando quiser."
                  : "Precisa ter histórico de saídas nos últimos 7 dias."}
              </div>
            </div>
          </label>

          {/* Campos */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <FormRow label={`Categoria ${missing.cat ? "·  faltando" : ""}`}>
              <select className="select" value={draft.cat || ""} onChange={(e) => setDraft({ ...draft, cat: e.target.value })}>
                <option value="">Selecione…</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </FormRow>
            <FormRow label={`Fornecedor ${missing.supplier ? "·  faltando" : ""}`}>
              <select className="select" value={draft.supplier || ""} onChange={(e) => {
                const v = e.target.value;
                const sup = (suppliers || []).find((s) => (s.name || s) === v);
                setDraft({ ...draft, supplier: v, supplierId: sup?.id || null });
              }}>
                <option value="">Selecione…</option>
                {(suppliers || []).map((s) => {
                  const name = s.name || s;
                  return <option key={s.id || name} value={name}>{name}</option>;
                })}
              </select>
            </FormRow>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <FormRow label={`Mínimo (${draft.unit}) ${missing.reorder ? "·  faltando" : minMaxAlert?.minBelow ? "·  abaixo do consumo" : ""}`}>
              <input className="input mono" inputMode="decimal" value={draft.reorder || ""} onChange={(e) => setDraft({ ...draft, reorder: e.target.value })} placeholder="0"
                     style={minMaxAlert?.minBelow ? { borderColor: "var(--ok)" } : null} />
            </FormRow>
            <FormRow label={`Máximo (${draft.unit}) ${missing.max ? "·  faltando" : minMaxAlert?.maxBelow ? "·  abaixo do consumo" : ""}`}>
              <input className="input mono" inputMode="decimal" value={draft.max || ""} onChange={(e) => setDraft({ ...draft, max: e.target.value })} placeholder="0"
                     style={minMaxAlert?.maxBelow ? { borderColor: "var(--ok)" } : null} />
            </FormRow>
            <FormRow label={`Custo unit. (R$) ${missing.cost ? "·  faltando" : ""}`}>
              <input className="input mono" inputMode="decimal" value={draft.cost || ""} onChange={(e) => setDraft({ ...draft, cost: e.target.value })} placeholder="0,00" />
            </FormRow>
          </div>

          {/* Toggle Compõe CMV */}
          <label style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "10px 12px",
            background: draft.composeCmv !== false ? "var(--ok-soft)" : "var(--bg-2)",
            border: `1px solid ${draft.composeCmv !== false ? "var(--ok-line)" : "var(--line)"}`,
            borderRadius: 6, cursor: "pointer",
          }}>
            <input type="checkbox" checked={draft.composeCmv !== false}
                   onChange={(e) => setDraft({ ...draft, composeCmv: e.target.checked })} />
            <div style={{ flex: 1, fontSize: 11.5, color: "var(--fg-1)" }}>
              <strong style={{ color: "var(--fg-0)" }}>Compõe CMV</strong>
              <div style={{ color: "var(--fg-3)", fontSize: 10.5, marginTop: 2 }}>
                Desligue para insumos que não devem entrar no CMV (descartáveis, embalagens, limpeza, etc).
              </div>
            </div>
          </label>
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--line)", display: "flex", justifyContent: "space-between", gap: 8 }}>
          <button className="btn" data-size="sm" onClick={skip}>Pular</button>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" data-size="sm" onClick={onClose}>Fechar</button>
            <button className="btn" data-variant="primary" data-size="sm" disabled={savingItem} onClick={saveAndNext}>
              {savingItem ? "Salvando…" : (idx === itemsToReview.length - 1 ? "Salvar e finalizar" : "Salvar e próximo →")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Desperdícios — sub-aba do Estoque
// =====================================================================
// Saídas categorizadas (Vencido / Danificado / Estragado / Fora de uso) que
// dão baixa no estoque e pesam no CMV. Toda movimentação aqui é gravada como
// kind='loss' ou 'expiration' em stock_movements, com loss_reason setado.

const WASTE_REASONS = [
  { code: "vencido",      label: "Vencido",       kind: "expiration", color: "var(--crit)",  desc: "Insumo passou da validade" },
  { code: "danificado",   label: "Danificado",    kind: "loss",       color: "var(--warn)",  desc: "Quebra, embalagem rompida, contaminação física" },
  { code: "estragado",    label: "Estragado",     kind: "loss",       color: "var(--crit)",  desc: "Apodreceu / fermentou / mofou antes do vencimento" },
  { code: "fora_de_uso",  label: "Fora de uso",   kind: "loss",       color: "var(--fg-2)",  desc: "Descarte por descontinuação, recall, troca de receita" },
];

function wasteReasonMeta(code) {
  return WASTE_REASONS.find((r) => r.code === code) || { code, label: code || "—", kind: "loss", color: "var(--fg-2)" };
}

function WastesView({ tenantId, items, onApplied }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false };
  const [period, setPeriod] = useState("mtd"); // mtd | 7d | 30d | prev_month
  const [showEntry, setShowEntry] = useState(false);
  const [movements, setMovements] = useState([]);       // wastes do período
  const [allMovements, setAllMovements] = useState([]); // todos os movimentos (p/ CMV)
  const [prevWastes, setPrevWastes]   = useState([]);   // 7d anteriores (tendência)
  const [operations, setOperations]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [reasonFilter, setReasonFilter] = useState("all");
  const [opFilter, setOpFilter] = useState("all");

  // Resolve janela de datas
  const range = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    if (period === "mtd") {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from, to: null, label: "mês atual" };
    }
    if (period === "prev_month") {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const to   = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from, to, label: "mês anterior" };
    }
    const days = period === "7d" ? 7 : 30;
    const from = new Date(now); from.setDate(from.getDate() - days);
    return { from, to: null, label: `últimos ${days} dias` };
  }, [period]);

  // Janela equivalente anterior (mesmo tamanho) — pra cálculo de tendência
  const prevRange = useMemo(() => {
    const ms = (range.to || new Date()) - range.from;
    const prevTo   = new Date(range.from);
    const prevFrom = new Date(range.from.getTime() - ms);
    return { from: prevFrom, to: prevTo };
  }, [range]);

  // Carrega operações + movimentações
  useEffect(() => {
    if (!dbStatus.isOnline || !tenantId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const fromIso = range.from.toISOString();
        const toIso   = range.to ? range.to.toISOString() : null;
        const prevFromIso = prevRange.from.toISOString();
        const prevToIso   = prevRange.to.toISOString();

        const [opsRes, movRes, prevRes] = await Promise.all([
          dbListOperations(tenantId),
          dbListStockMovements(tenantId, fromIso, toIso, { limit: 10000 }),
          dbListStockMovements(tenantId, prevFromIso, prevToIso, { limit: 10000 }),
        ]);
        if (cancelled) return;
        setOperations(opsRes.data || []);
        const movs = movRes.data || [];
        setAllMovements(movs);
        setMovements(movs.filter((m) => m.kind === "loss" || m.kind === "expiration"));
        setPrevWastes((prevRes.data || []).filter((m) => m.kind === "loss" || m.kind === "expiration"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.isOnline, tenantId, range.from, range.to]);

  // Filtro aplicado (motivo + operação)
  const filtered = useMemo(() => {
    return movements.filter((m) => {
      if (reasonFilter !== "all" && m.lossReason !== reasonFilter) return false;
      if (opFilter !== "all") {
        if (opFilter === "__shared__") {
          if (m.operationId) return false;
        } else if (m.operationId !== opFilter) {
          return false;
        }
      }
      return true;
    });
  }, [movements, reasonFilter, opFilter]);

  // Helpers de cálculo
  const costOf = (m) => Math.abs(Number(m.delta) || 0) * Number(m.unitCost || 0);
  const wasteCost = (list) => list.reduce((s, m) => s + costOf(m), 0);

  const totals = useMemo(() => {
    const total = wasteCost(movements);
    const events = movements.length;
    return { total, events };
  }, [movements]);

  // Total de CMV do período (consumo + ajustes + desperdício) p/ % CMV
  const cmvTotal = useMemo(() => {
    let cogsOut = 0, cogsWaste = 0, cogsAdjust = 0;
    for (const mv of allMovements) {
      if (mv.composeCmv === false) continue;
      const c = Math.abs(Number(mv.delta) || 0) * Number(mv.unitCost || 0);
      if (mv.kind === "out") cogsOut += c;
      else if (mv.kind === "loss" || mv.kind === "expiration") cogsWaste += c;
      else if (mv.kind === "adjust") cogsAdjust += -Number(mv.delta || 0) * Number(mv.unitCost || 0);
    }
    return cogsOut + cogsWaste + cogsAdjust;
  }, [allMovements]);

  const pctCmv = cmvTotal > 0 ? (totals.total / cmvTotal) * 100 : 0;

  // Tendência: cost da janela atual vs anterior (mesmo tamanho)
  const trend = useMemo(() => {
    const cur  = wasteCost(movements);
    const prev = wasteCost(prevWastes);
    const delta = cur - prev;
    const pct = prev > 0 ? (delta / prev) * 100 : (cur > 0 ? 100 : 0);
    return { cur, prev, delta, pct, direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat" };
  }, [movements, prevWastes]);

  // Por motivo (todos os 4)
  const byReason = useMemo(() => {
    const m = {};
    for (const code of WASTE_REASONS.map((r) => r.code)) m[code] = { code, total: 0, count: 0 };
    for (const mv of movements) {
      const code = mv.lossReason || (mv.kind === "expiration" ? "vencido" : "danificado");
      if (!m[code]) m[code] = { code, total: 0, count: 0 };
      m[code].total += costOf(mv);
      m[code].count += 1;
    }
    return Object.values(m).sort((a, b) => b.total - a.total);
  }, [movements]);

  const topReason = byReason[0] && byReason[0].total > 0 ? byReason[0] : null;

  // Por operação (com "Compartilhado" pra movimentações sem op)
  const byOperation = useMemo(() => {
    const m = new Map();
    const SHARED = "__shared__";
    for (const op of operations) m.set(op.id, { opId: op.id, label: op.short_label || op.name, color: op.color, total: 0, count: 0 });
    m.set(SHARED, { opId: SHARED, label: "Compartilhado", color: "var(--fg-3)", total: 0, count: 0 });
    for (const mv of movements) {
      const k = mv.operationId || SHARED;
      if (!m.has(k)) m.set(k, { opId: k, label: "—", color: "var(--fg-3)", total: 0, count: 0 });
      const entry = m.get(k);
      entry.total += costOf(mv);
      entry.count += 1;
    }
    return Array.from(m.values()).sort((a, b) => b.total - a.total);
  }, [movements, operations]);

  // Top categorias (R$)
  const byCategory = useMemo(() => {
    const m = new Map();
    for (const mv of filtered) {
      const k = mv.categoryName || "Sem categoria";
      if (!m.has(k)) m.set(k, { name: k, total: 0, count: 0 });
      const entry = m.get(k);
      entry.total += costOf(mv);
      entry.count += 1;
    }
    return Array.from(m.values()).sort((a, b) => b.total - a.total).slice(0, 8);
  }, [filtered]);

  // Top itens (R$)
  const byItem = useMemo(() => {
    const m = new Map();
    for (const mv of filtered) {
      const k = mv.itemId || mv.item;
      if (!m.has(k)) m.set(k, { id: mv.itemId, name: mv.item, unit: mv.unit, total: 0, qty: 0, count: 0 });
      const entry = m.get(k);
      entry.total += costOf(mv);
      entry.qty   += Math.abs(Number(mv.delta) || 0);
      entry.count += 1;
    }
    return Array.from(m.values()).sort((a, b) => b.total - a.total).slice(0, 8);
  }, [filtered]);

  const fmtBR = (v) => Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtAt = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const wasteCatalog = useMemo(
    () => [...(items || [])].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [items],
  );

  const handleApplied = async () => {
    setShowEntry(false);
    if (typeof onApplied === "function") await onApplied();
    // Recarrega movimentações do período
    if (dbStatus.isOnline && tenantId) {
      const fromIso = range.from.toISOString();
      const toIso   = range.to ? range.to.toISOString() : null;
      const movRes = await dbListStockMovements(tenantId, fromIso, toIso, { limit: 10000 });
      const movs = movRes.data || [];
      setAllMovements(movs);
      setMovements(movs.filter((m) => m.kind === "loss" || m.kind === "expiration"));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header: título + período + botão */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h2 className="h-title" style={{ margin: 0, color: "var(--fg-0)" }}>Desperdícios</h2>
        <span style={{ fontSize: 12, color: "var(--fg-3)" }}>· {range.label}</span>
        <Tabs value={period} onChange={setPeriod} options={[
          { id: "mtd",        label: "Mês atual" },
          { id: "prev_month", label: "Mês anterior" },
          { id: "7d",         label: "7 dias" },
          { id: "30d",        label: "30 dias" },
        ]} />
        <span style={{ flex: 1 }} />
        <button className="btn" data-variant="danger" data-size="sm" onClick={() => setShowEntry(true)}
                disabled={!dbStatus.isOnline || !tenantId}>
          <I.Plus size={13} />Registrar desperdício
        </button>
      </div>

      {!dbStatus.isOnline && (
        <div style={{
          padding: "10px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)",
          borderRadius: 4, fontSize: 12, color: "var(--fg-1)",
        }}>
          Conecte ao Supabase pra registrar e consultar desperdícios.
        </div>
      )}

      {/* 4 KPIs principais */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <div className="kpi">
          <div className="label">Total desperdiçado</div>
          <div className="value" style={{ color: "var(--crit)" }}>R$ {fmtBR(totals.total)}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", marginTop: 6 }}>
            {totals.events} {totals.events === 1 ? "ocorrência" : "ocorrências"} · {range.label}
          </div>
        </div>
        <div className="kpi">
          <div className="label">% sobre CMV</div>
          <div className="value" style={{ color: pctCmv > 5 ? "var(--crit)" : pctCmv > 2 ? "var(--warn)" : "var(--fg-0)" }}>
            {cmvTotal > 0 ? `${pctCmv.toFixed(1)}%` : "—"}
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", marginTop: 6 }}>
            CMV do período: R$ {fmtBR(cmvTotal)}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Tendência</div>
          <div className="value" style={{
            color: trend.direction === "up" ? "var(--crit)" : trend.direction === "down" ? "var(--ok)" : "var(--fg-0)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            {trend.direction === "up" ? "▲" : trend.direction === "down" ? "▼" : "—"} {Math.abs(trend.pct).toFixed(0)}%
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", marginTop: 6 }}>
            vs período anterior: R$ {fmtBR(trend.prev)}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Top motivo</div>
          <div className="value" style={{ color: topReason ? wasteReasonMeta(topReason.code).color : "var(--fg-3)", fontSize: 18 }}>
            {topReason ? wasteReasonMeta(topReason.code).label : "—"}
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", marginTop: 6 }}>
            {topReason ? `R$ ${fmtBR(topReason.total)} · ${topReason.count} ev.` : "Sem registros no período"}
          </div>
        </div>
      </div>

      {/* Por motivo (4 boxes) */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Por motivo</h3>
          <span className="card-sub">Distribuição em R$ no período</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 0 }}>
          {WASTE_REASONS.map((r, i) => {
            const entry = byReason.find((b) => b.code === r.code) || { total: 0, count: 0 };
            const pct   = totals.total > 0 ? (entry.total / totals.total) * 100 : 0;
            return (
              <button key={r.code} type="button"
                onClick={() => setReasonFilter(reasonFilter === r.code ? "all" : r.code)}
                style={{
                  textAlign: "left", padding: "14px 16px",
                  background: reasonFilter === r.code ? "var(--bg-2)" : "transparent",
                  border: "none",
                  borderLeft: i > 0 ? "1px solid var(--line-soft)" : "none",
                  cursor: "pointer",
                }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 50, background: r.color }} />
                  <span style={{ fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500 }}>{r.label}</span>
                </div>
                <div className="mono" style={{ fontSize: 17, color: "var(--fg-0)", letterSpacing: "-0.01em" }}>
                  R$ {fmtBR(entry.total)}
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", marginTop: 4 }}>
                  {entry.count} ev. · {pct.toFixed(1)}%
                </div>
                <div className="bar" style={{ height: 3, marginTop: 8 }}>
                  <i style={{ width: `${pct}%`, background: r.color }} />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Por operação */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Desperdício por operação</h3>
          <span className="card-sub">Clique pra filtrar a lista abaixo</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(Math.max(byOperation.length, 1), 5)}, 1fr)`, gap: 0 }}>
          {byOperation.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>
              Sem desperdícios no período
            </div>
          ) : byOperation.map((o, i) => {
            const pct = totals.total > 0 ? (o.total / totals.total) * 100 : 0;
            const active = opFilter === o.opId;
            return (
              <button key={o.opId} type="button"
                onClick={() => setOpFilter(active ? "all" : o.opId)}
                style={{
                  textAlign: "left", padding: "14px 16px",
                  background: active ? "var(--bg-2)" : "transparent",
                  border: "none",
                  borderLeft: i > 0 ? "1px solid var(--line-soft)" : "none",
                  cursor: "pointer",
                }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 50, background: o.color || "var(--fg-3)" }} />
                  <span style={{ fontSize: 12, color: "var(--fg-0)", fontWeight: 500 }}>{o.label}</span>
                </div>
                <div className="mono" style={{ fontSize: 16, color: "var(--fg-0)" }}>
                  R$ {fmtBR(o.total)}
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", marginTop: 4 }}>
                  {o.count} ev. · {pct.toFixed(1)}%
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Rankings · Categoria + Item */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Top categorias</h3>
            <span className="card-sub">Por valor desperdiçado</span>
          </div>
          {byCategory.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>
              Sem registros
            </div>
          ) : (
            <div style={{ padding: "10px 16px 16px" }}>
              {byCategory.map((c, i) => {
                const pct = byCategory[0].total > 0 ? (c.total / byCategory[0].total) * 100 : 0;
                return (
                  <div key={c.name} style={{ marginTop: i > 0 ? 12 : 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: "var(--fg-0)" }}>{c.name}</span>
                      <span className="mono" style={{ fontSize: 11, color: "var(--fg-1)" }}>
                        R$ {fmtBR(c.total)} <span style={{ color: "var(--fg-3)" }}>· {c.count} ev.</span>
                      </span>
                    </div>
                    <div className="bar" style={{ height: 4 }}>
                      <i style={{ width: `${pct}%`, background: "var(--crit)" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Top itens</h3>
            <span className="card-sub">Por valor desperdiçado</span>
          </div>
          {byItem.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>
              Sem registros
            </div>
          ) : (
            <div style={{ padding: "10px 16px 16px" }}>
              {byItem.map((it, i) => {
                const pct = byItem[0].total > 0 ? (it.total / byItem[0].total) * 100 : 0;
                return (
                  <div key={it.id || it.name} style={{ marginTop: i > 0 ? 12 : 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: "var(--fg-0)" }}>{it.name}</span>
                      <span className="mono" style={{ fontSize: 11, color: "var(--fg-1)" }}>
                        R$ {fmtBR(it.total)} <span style={{ color: "var(--fg-3)" }}>· {it.qty.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} {it.unit}</span>
                      </span>
                    </div>
                    <div className="bar" style={{ height: 4 }}>
                      <i style={{ width: `${pct}%`, background: "var(--crit)" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Filtros + lista */}
      <div className="card">
        <div className="card-header">
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h3 className="card-title">Lançamentos · {filtered.length}</h3>
            {(reasonFilter !== "all" || opFilter !== "all") && (
              <button className="btn" data-variant="ghost" data-size="sm"
                      onClick={() => { setReasonFilter("all"); setOpFilter("all"); }}>
                Limpar filtros
              </button>
            )}
          </div>
          <span className="card-sub">{range.label}</span>
        </div>
        <table className="table" data-density="compact">
          <thead>
            <tr>
              <th>Quando</th>
              <th>Insumo</th>
              <th>Categoria</th>
              <th>Motivo</th>
              <th>Operação</th>
              <th className="num">Qtd</th>
              <th className="num">Custo unit.</th>
              <th className="num">Total</th>
              <th>Observação</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="dim" style={{ textAlign: "center", padding: 32 }}>Carregando…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={9} className="dim" style={{ textAlign: "center", padding: 32 }}>
                Sem desperdícios registrados {reasonFilter !== "all" || opFilter !== "all" ? "no filtro selecionado" : "no período"}.
              </td></tr>
            ) : filtered.map((m) => {
              const rm = wasteReasonMeta(m.lossReason || (m.kind === "expiration" ? "vencido" : null));
              const cost = costOf(m);
              return (
                <tr key={m.id}>
                  <td className="mono dim" style={{ fontSize: 11 }}>{fmtAt(m.at)}</td>
                  <td className="row-strong">{m.item}</td>
                  <td className="dim">{m.categoryName || "—"}</td>
                  <td>
                    <span style={{
                      display: "inline-flex", alignItems: "center", gap: 5,
                      padding: "2px 8px", borderRadius: 99,
                      background: "var(--bg-2)", border: `1px solid ${rm.color}`,
                      color: rm.color, fontFamily: "var(--mono)", fontSize: 10,
                      letterSpacing: "0.04em", textTransform: "uppercase", fontWeight: 500,
                    }}>
                      <span style={{ width: 5, height: 5, borderRadius: 50, background: rm.color }} />
                      {rm.label}
                    </span>
                  </td>
                  <td className="dim mono" style={{ fontSize: 10.5 }}>
                    {m.operationName ? (m.operationShort || m.operationName) : <span style={{ color: "var(--fg-3)" }}>compartilhado</span>}
                  </td>
                  <td className="num">{Math.abs(m.delta).toLocaleString("pt-BR", { maximumFractionDigits: 3 })} {m.unit}</td>
                  <td className="num">R$ {fmtBR(m.unitCost)}</td>
                  <td className="num" style={{ color: "var(--crit)" }}>R$ {fmtBR(cost)}</td>
                  <td className="dim" style={{ fontSize: 11.5, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.notes || ""}>
                    {m.notes || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showEntry && (
        <WasteEntryModal
          items={wasteCatalog}
          operations={operations}
          tenantId={tenantId}
          onClose={() => setShowEntry(false)}
          onApplied={handleApplied}
        />
      )}
    </div>
  );
}

// =====================================================================
// Modal de registro de desperdício
// =====================================================================
function WasteEntryModal({ items, operations, tenantId, onClose, onApplied }) {
  const StockItemPicker = window.StockItemPicker;
  const catalog = useMemo(
    () => [...(items || [])].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [items],
  );

  const [lines, setLines] = useState([{ stock_item_id: "", qty: "", cost: "" }]);
  const [reason, setReason]   = useState("");      // vencido | danificado | estragado | fora_de_uso
  const [opId, setOpId]       = useState("");      // uuid | "__shared__"
  const [note, setNote]       = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [openSignals, setOpenSignals] = useState({});
  useEffect(() => { setOpenSignals({ 0: 1 }); }, []);

  const parseN = (raw) => parseFloat(String(raw ?? "").replace(",", ".")) || 0;
  const setLine    = (i, k, v) => setLines((prev) => prev.map((ln, j) => {
    if (j !== i) return ln;
    if (k === "stock_item_id") {
      // Quando muda o insumo, puxa o custo da última compra como default editável
      const it = catalog.find((c) => c.id === v);
      return { ...ln, stock_item_id: v, cost: it ? String(it.cost ?? "") : ln.cost };
    }
    return { ...ln, [k]: v };
  }));
  const removeLine = (i) => setLines((prev) => prev.filter((_, j) => j !== i));
  const addLine    = () => {
    const newIdx = lines.length;
    setLines((prev) => [...prev, { stock_item_id: "", qty: "", cost: "" }]);
    setOpenSignals((cur) => ({ ...cur, [newIdx]: (cur[newIdx] || 0) + 1 }));
  };

  const usedIds = (currentIdx) =>
    new Set(lines.filter((_, j) => j !== currentIdx).map((ln) => ln.stock_item_id).filter(Boolean));

  const validLines = lines.filter((ln) => ln.stock_item_id && parseN(ln.qty) > 0);
  const total = validLines.reduce((s, ln) => s + parseN(ln.qty) * parseN(ln.cost), 0);

  const errs = {
    lines:  validLines.length === 0,
    reason: !reason,
    op:     !opId,
    note:   !note.trim(),
  };
  const valid = !errs.lines && !errs.reason && !errs.op && !errs.note;
  const errorMessages = [
    errs.lines  && "Adicione ao menos um insumo com quantidade",
    errs.reason && "Selecione o motivo do desperdício",
    errs.op     && "Selecione a operação (ou marque compartilhado)",
    errs.note   && "Descreva o que aconteceu na observação",
  ].filter(Boolean);

  const reasonMeta = reason ? wasteReasonMeta(reason) : null;

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const operationId = opId === "__shared__" ? null : opId;
      const reasonLabel = wasteReasonMeta(reason).label.toUpperCase();
      const fullNote = `[${reasonLabel}] ${note.trim()}`;
      const kind = wasteReasonMeta(reason).kind; // expiration | loss

      let okCount = 0;
      const failures = [];
      for (const ln of validLines) {
        const qty = parseN(ln.qty);
        const cost = parseN(ln.cost);
        const { error } = await dbApplyStockMovement(
          tenantId, ln.stock_item_id, qty, kind,
          fullNote, cost > 0 ? cost : undefined,
          { operationId, lossReason: reason, referenceType: "waste" },
        );
        if (error) failures.push({ itemId: ln.stock_item_id, error });
        else okCount += 1;
      }
      if (failures.length > 0) {
        window.showToast(`Erro em ${failures.length} item(ns): ${failures[0].error.message}`, { tone: "crit", ttl: 4500 });
      }
      if (okCount > 0) {
        window.showToast(`${okCount} desperdício(s) registrado(s)`, { tone: "ok" });
        if (typeof onApplied === "function") await onApplied();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Registrar desperdício"
      subtitle="Saída de estoque por perda · entra no CMV"
      onClose={submitting ? undefined : onClose}
      width={780}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", gap: 12 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-3)" }}>
            {validLines.length} {validLines.length === 1 ? "item" : "itens"} · total R$ {total.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" data-size="sm" onClick={onClose} disabled={submitting}>Cancelar</button>
            <button className="btn" data-variant="danger" data-size="sm" onClick={submit} disabled={!valid || submitting}>
              {submitting ? "Salvando…" : "Confirmar desperdício"}
            </button>
          </div>
        </div>
      }
    >
      {/* Motivo · radio cards */}
      <div className="h-eyebrow" style={{ marginBottom: 8 }}>Motivo · obrigatório</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 16 }}>
        {WASTE_REASONS.map((r) => {
          const active = reason === r.code;
          return (
            <button key={r.code} type="button" onClick={() => setReason(r.code)} style={{
              textAlign: "left", padding: "12px 12px",
              borderRadius: 6,
              border: `1px solid ${active ? r.color : "var(--line)"}`,
              background: active ? "var(--bg-2)" : "transparent",
              boxShadow: active ? `0 0 0 1px ${r.color}` : "none",
              cursor: "pointer",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: 50, background: r.color }} />
                <span style={{ fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500 }}>{r.label}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.35 }}>{r.desc}</div>
            </button>
          );
        })}
      </div>

      {/* Operação + observação */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 16 }}>
        <FormRow label="Operação · obrigatório">
          <select className="select" value={opId} onChange={(e) => setOpId(e.target.value)}
                  style={errs.op ? { borderColor: "var(--crit)" } : null}>
            <option value="">Selecione…</option>
            <option value="__shared__">Compartilhado (rateado no CMV)</option>
            {(operations || []).map((op) => (
              <option key={op.id} value={op.id}>{op.name}</option>
            ))}
          </select>
        </FormRow>
        <FormRow label="Observação · obrigatório" hint="Descreva o que aconteceu (lote, fornecedor, falha, etc).">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)}
                 placeholder="Ex.: lote 2245 com odor azedo · descarte total"
                 style={errs.note ? { borderColor: "var(--crit)" } : null} />
        </FormRow>
      </div>

      {/* Itens */}
      <div className="h-eyebrow" style={{ marginBottom: 8 }}>Itens · {lines.length}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 90px 110px 100px 32px",
          gap: 10, alignItems: "center",
          padding: "0 4px",
          fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)",
          letterSpacing: "0.08em", textTransform: "uppercase",
        }}>
          <span>Insumo</span>
          <span style={{ textAlign: "right" }}>Qtd</span>
          <span style={{ textAlign: "right" }}>Custo unit.</span>
          <span style={{ textAlign: "right" }}>Subtotal</span>
          <span />
        </div>

        {lines.map((ln, i) => {
          const item = catalog.find((it) => it.id === ln.stock_item_id);
          const qtyN = parseN(ln.qty);
          const subtotal = qtyN * parseN(ln.cost);
          const taken = usedIds(i);
          return (
            <div key={i} style={{
              display: "grid",
              gridTemplateColumns: "1fr 90px 110px 100px 32px",
              gap: 10, alignItems: "center",
            }}>
              {StockItemPicker ? (
                <StockItemPicker
                  items={catalog}
                  value={ln.stock_item_id}
                  onChange={(id) => setLine(i, "stock_item_id", id)}
                  openSignal={openSignals[i]}
                  disabledIds={Array.from(taken)}
                />
              ) : (
                <select className="select" value={ln.stock_item_id}
                        onChange={(e) => setLine(i, "stock_item_id", e.target.value)}>
                  <option value="">Selecione…</option>
                  {catalog.filter((it) => !taken.has(it.id)).map((it) =>
                    <option key={it.id} value={it.id}>{it.name} ({it.unit})</option>
                  )}
                </select>
              )}
              <input className="input mono" inputMode="decimal"
                     value={ln.qty} placeholder="0"
                     onChange={(e) => setLine(i, "qty", e.target.value)}
                     style={{ textAlign: "right" }}
                     disabled={!item} />
              <input className="input mono" inputMode="decimal"
                     value={ln.cost} placeholder="0,00"
                     onChange={(e) => setLine(i, "cost", e.target.value)}
                     style={{ textAlign: "right" }}
                     disabled={!item}
                     title="Custo unitário · pré-preenchido com a última compra" />
              <span className="mono" style={{
                fontSize: 11.5,
                color: subtotal > 0 ? "var(--crit)" : "var(--fg-3)",
                textAlign: "right",
              }}>
                {subtotal > 0
                  ? "R$ " + subtotal.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                  : "—"}
              </span>
              <button type="button" className="btn" data-variant="ghost" data-size="sm"
                      onClick={() => removeLine(i)}
                      disabled={lines.length === 1}
                      style={{ padding: "4px 6px" }}
                      title={lines.length === 1 ? "É preciso ao menos uma linha" : "Remover item"}>
                <I.X size={11} />
              </button>
            </div>
          );
        })}

        <button type="button" className="btn" data-variant="ghost" data-size="sm"
                onClick={addLine}
                style={{ alignSelf: "flex-start", marginTop: 4 }}>
          <I.Plus size={11} />Adicionar item
        </button>
      </div>

      {errorMessages.length > 0 && (
        <div style={{
          marginTop: 14,
          padding: "8px 12px", background: "var(--crit-soft)",
          border: "1px solid var(--crit-line)", borderRadius: 4,
          fontSize: 11.5, color: "var(--crit)",
        }}>
          <strong>Preencha antes de salvar:</strong>
          <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
            {errorMessages.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
        </div>
      )}

      {reasonMeta && (
        <div style={{
          marginTop: 14,
          padding: "10px 12px",
          background: "var(--bg-2)", border: "1px solid var(--line-soft)",
          borderRadius: 4, fontSize: 11.5, color: "var(--fg-2)",
        }}>
          <strong style={{ color: reasonMeta.color }}>{reasonMeta.label}</strong> · será gravado
          como <code className="mono" style={{ color: "var(--fg-1)" }}>{reasonMeta.kind === "expiration" ? "expiration" : "loss"}</code>{" "}
          em stock_movements e descontado do saldo do insumo.
        </div>
      )}
    </Modal>
  );
}

window.Stock = Stock;
window.Tabs = Tabs;
window.WastesView = WastesView;
window.WasteEntryModal = WasteEntryModal;
