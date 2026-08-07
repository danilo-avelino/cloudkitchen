// page-mobile-stock.jsx — Estoque no celular (≤480px). Tela dedicada dentro do
// MobileApp. Foco do estoquista: consultar saldo, dar entrada, ver alertas e
// resolver pendências. Reaproveita 100% da camada de dados (funções db*) e os
// primitivos de mobile-ui.jsx. Gestão fina (fornecedores/categorias) fica no desktop.

// Parser BR-safe (vírgula decimal) — ver feedback_brl_number_parse.
const _pbrM = (raw) => {
  if (raw === "" || raw == null) return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  let s = String(raw).trim().replace(/\s+/g, "");
  if (!s) return 0;
  const dp = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  if (dp >= 0) s = s.slice(0, dp).replace(/[.,]/g, "") + "." + s.slice(dp + 1);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};
const _brl = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _brlShort = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 });

// Recalcula status local (usado em updates otimistas). Espelha recomputeStatus do desktop.
const _mRecalc = (it) => {
  if (it.qty <= 0) return "crit";
  if (it.reorder > 0 && it.qty < it.reorder * 0.25) return "crit";
  if (it.reorder > 0 && it.qty < it.reorder) return "warn";
  return "ok";
};

function MobileStock({ scope = "all" }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tab, setTab] = useState("items"); // items | pending | suppliers | categories | inventory | wastes
  const [items, setItems] = useState(MOCK.STOCK_ITEMS || []);
  const [categories, setCategories] = useState([]);
  const [dbCategories, setDbCategories] = useState([]); // [{id,name,...}] p/ CategoriesView
  const [suppliers, setSuppliers] = useState([]);
  const [movements, setMovements] = useState([]);
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState("mock");
  const [pageLoading, setPageLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all"); // all | ok | warn | crit
  const [catFilter, setCatFilter] = useState([]);           // categorias selecionadas
  const [filterOpen, setFilterOpen] = useState(false);

  const [detail, setDetail] = useState(null);   // item em detalhe (sheet)
  const [editing, setEditing] = useState(null);  // item em edição (form)
  const [creating, setCreating] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [flowDetail, setFlowDetail] = useState(null); // "in" | "out"
  const [valueModal, setValueModal] = useState(false);

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
        const [itemsRes, catsRes, supRes] = await Promise.all([
          dbListStockItems(tid),
          dbListStockCategories(tid),
          dbListSuppliers(tid),
        ]);
        if (cancelled) return;
        if (itemsRes.source === "db") { setItems(itemsRes.data || []); setSource("db"); }
        if (catsRes.data) { setDbCategories(catsRes.data); setCategories(catsRes.data.map((c) => c.name).sort()); }
        if (supRes?.data) setSuppliers(supRes.data.map((s) => ({ id: s.id, name: s.name })));
      } finally {
        if (!cancelled) setPageLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  // Movimentações do mês p/ KPIs de entrada/saída + realtime.
  useEffect(() => {
    if (!dbStatus.isOnline || !tenantId) return;
    let cancelled = false, timer = null;
    const load = async () => {
      const first = new Date(); first.setDate(1); first.setHours(0, 0, 0, 0);
      const res = await dbListStockMovements(tenantId, first.toISOString(), new Date().toISOString(), { limit: 5000 });
      if (!cancelled) setMovements(res.data || []);
    };
    const reloadItems = async () => {
      const { data } = await dbListStockItems(tenantId);
      if (!cancelled && data) setItems(data);
    };
    const sched = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { if (!cancelled) { load(); reloadItems(); } }, 400); };
    load();
    const unsubs = [
      dbSubscribeTable?.("stock_movements", tenantId, sched),
      dbSubscribeTable?.("goods_receipts", tenantId, sched),
    ].filter(Boolean);
    return () => { cancelled = true; if (timer) clearTimeout(timer); unsubs.forEach((u) => { try { u(); } catch {} }); };
  }, [dbStatus.isOnline, tenantId]);

  const refetchItems = async () => {
    if (source === "db" && tenantId) {
      const { data } = await dbListStockItems(tenantId);
      if (data) setItems(data);
    }
  };

  // ===== Categorias · CRUD (mesma lógica do desktop) =====
  const createCategory = async (name) => {
    const v = String(name || "").trim();
    if (!v) return null;
    if (allCats.includes(v)) { window.showToast?.(`Categoria "${v}" já existe`, { tone: "warn" }); return null; }
    if (source === "db" && tenantId && typeof dbInsertStockCategory === "function") {
      const { data, error } = await dbInsertStockCategory(tenantId, v);
      if (error) { window.showToast?.(`Erro ao criar: ${error.message}`, { tone: "crit", ttl: 4500 }); return null; }
      if (data) setDbCategories((prev) => [...prev, data]);
    }
    setCategories((prev) => [...prev, v].sort());
    window.showToast?.(`Categoria "${v}" criada`, { tone: "ok" });
    return v;
  };
  const renameCategory = async (oldName, newName) => {
    const target = String(newName || "").trim();
    if (!target || target === oldName) return;
    if (source === "db" && typeof dbRenameStockCategory === "function") {
      const dbCat = dbCategories.find((c) => c.name === oldName);
      if (dbCat?.id) {
        const { data, error } = await dbRenameStockCategory(dbCat.id, target);
        if (error) { window.showToast?.(`Erro ao renomear: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
        setDbCategories((prev) => prev.map((c) => c.id === dbCat.id ? data : c));
      }
    }
    setCategories((prev) => { const w = prev.filter((c) => c !== oldName); return w.includes(target) ? w : [...w, target].sort(); });
    setItems((prev) => prev.map((it) => it.cat === oldName ? { ...it, cat: target } : it));
    window.showToast?.(`Categoria renomeada para "${target}"`, { tone: "ok" });
  };
  const updateCategoryFlags = async (catName, patch) => {
    if (source !== "db" || typeof dbUpdateStockCategory !== "function") { window.showToast?.("Conecte ao Supabase pra ajustar flags", { tone: "warn" }); return false; }
    const dbCat = dbCategories.find((c) => c.name === catName);
    if (!dbCat?.id) { window.showToast?.(`Categoria "${catName}" precisa ser salva primeiro`, { tone: "warn" }); return false; }
    const { data, error } = await dbUpdateStockCategory(dbCat.id, patch);
    if (error) { window.showToast?.(`Erro ao salvar: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; }
    setDbCategories((prev) => prev.map((c) => c.id === dbCat.id ? data : c));
    setItems((prev) => prev.map((it) => it.catId === dbCat.id ? { ...it, catAlertsEnabled: data.alerts_enabled !== false, catAutoShoppingEnabled: data.auto_shopping_enabled !== false } : it));
    return true;
  };
  const setCategoryAutoMinMax = async (catName, enabled) => {
    if (source !== "db" || typeof dbSetCategoryAutoMinMax !== "function") { window.showToast?.("Conecte ao Supabase pra alterar auto min/max", { tone: "warn" }); return false; }
    const dbCat = dbCategories.find((c) => c.name === catName);
    if (!dbCat?.id) { window.showToast?.(`Categoria "${catName}" precisa ser salva primeiro`, { tone: "warn" }); return false; }
    const { error } = await dbSetCategoryAutoMinMax(dbCat.id, enabled);
    if (error) { window.showToast?.(`Erro ao aplicar: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; }
    setDbCategories((prev) => prev.map((c) => c.id === dbCat.id ? { ...c, auto_min_max_enabled: !!enabled } : c));
    await refetchItems();
    return true;
  };
  const deleteCategory = async (name) => {
    if (items.some((it) => it.cat === name)) { window.showToast?.(`Há insumos em "${name}" · migre-os antes de excluir`, { tone: "warn", ttl: 4500 }); return; }
    if (source === "db" && typeof dbDeleteStockCategory === "function") {
      const dbCat = dbCategories.find((c) => c.name === name);
      if (dbCat?.id) {
        const { error } = await dbDeleteStockCategory(dbCat.id);
        if (error) { window.showToast?.(`Erro ao excluir: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
        setDbCategories((prev) => prev.filter((c) => c.id !== dbCat.id));
      }
    }
    setCategories((prev) => prev.filter((c) => c !== name));
    window.showToast?.(`Categoria "${name}" excluída`, { tone: "warn" });
  };

  const allCats = useMemo(() =>
    [...new Set([...categories, ...items.map((i) => i.cat)])].filter(Boolean).sort(),
    [categories, items]
  );

  // Só itens "acompanháveis" (categoria com alertas ligados) entram nas listas/KPIs.
  const visible = useMemo(() => items.filter((i) => i.catAlertsEnabled !== false), [items]);

  const STATUS_ORDER = { crit: 0, warn: 1, ok: 2 };
  const filtered = useMemo(() => {
    const q = search.trim();
    return visible
      .filter((i) => {
        if (statusFilter !== "all" && i.status !== statusFilter) return false;
        if (catFilter.length > 0 && !catFilter.includes(i.cat)) return false;
        if (scope !== "all" && i.alloc && i.alloc[scope] === 0) return false;
        if (q && typeof window.fuzzyMatch === "function" && !window.fuzzyMatch(i.name, q) && !window.fuzzyMatch(i.id, q)) return false;
        return true;
      })
      .sort((a, b) => {
        const d = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
        return d !== 0 ? d : a.name.localeCompare(b.name, "pt-BR");
      });
  }, [visible, statusFilter, catFilter, search, scope]);

  const totals = useMemo(() => ({
    all: visible.length,
    ok: visible.filter((i) => i.status === "ok").length,
    warn: visible.filter((i) => i.status === "warn").length,
    crit: visible.filter((i) => i.status === "crit").length,
  }), [visible]);

  const totalValue = useMemo(() => items.reduce((s, i) => s + Math.max(0, i.qty) * i.cost, 0), [items]);

  const flows = useMemo(() => {
    let entradas = 0, saidas = 0;
    for (const mv of movements) {
      const v = Math.abs(mv.delta || 0) * (mv.unitCost || 0);
      if (mv.kind === "in") entradas += v;
      else if (mv.kind === "out" || mv.kind === "loss" || mv.kind === "expiration") saidas += v;
      else if (mv.kind === "adjust") { if ((mv.delta || 0) > 0) entradas += v; else if ((mv.delta || 0) < 0) saidas += v; }
    }
    return { entradas, saidas };
  }, [movements]);

  const alerts = useMemo(() => {
    let ruptura = 0, baixo = 0;
    for (const i of visible) {
      const qty = Number(i.qty) || 0, reorder = Number(i.reorder) || 0;
      if (qty <= 0) ruptura += 1;
      else if (reorder > 0 && qty < reorder) baixo += 1;
    }
    return { total: ruptura + baixo, ruptura, baixo };
  }, [visible]);

  const pendingItems = useMemo(() =>
    (typeof pendingEntryItems === "function" ? pendingEntryItems(source === "db" ? items : []) : []),
    [items, source]
  );

  // ===== Handlers (mesma lógica dos db* do desktop) =====
  const handleEntry = async (lines, note) => {
    const clean = lines.filter((l) => _pbrM(l.qty) > 0);
    if (clean.length === 0) return { ok: false };
    // otimista
    setItems((prev) => prev.map((it) => {
      const ln = clean.find((l) => l.itemId === it.id);
      if (!ln) return it;
      const qty = _pbrM(ln.qty), cost = _pbrM(ln.cost);
      const updated = { ...it, qty: it.qty + qty, cost: cost > 0 ? cost : it.cost };
      return { ...updated, status: _mRecalc(updated) };
    }));
    if (source === "db" && tenantId) {
      const fails = [];
      for (const ln of clean) {
        const { error } = await dbApplyStockMovement(tenantId, ln.itemId, _pbrM(ln.qty), "in", note || "Entrada manual", _pbrM(ln.cost) || undefined);
        if (error) fails.push(error);
      }
      await refetchItems();
      if (fails.length) { window.showToast?.(`Erro em ${fails.length} item(ns): ${fails[0].message}`, { tone: "crit", ttl: 4500 }); return { ok: false }; }
      window.showToast?.(`${clean.length} entrada(s) registrada(s)`, { tone: "ok" });
      return { ok: true };
    }
    window.showToast?.(`${clean.length} entrada(s) registrada(s)`, { tone: "ok" });
    return { ok: true };
  };

  const handleSaveItem = async (id, draft) => {
    if (source === "db" && tenantId) {
      let catId = null;
      // resolve/cria categoria por nome
      const { data: cats } = await dbListStockCategories(tenantId);
      catId = (cats || []).find((c) => c.name === draft.cat)?.id;
      if (!catId && draft.cat && typeof dbInsertStockCategory === "function") {
        const { data: nc } = await dbInsertStockCategory(tenantId, draft.cat);
        if (nc) catId = nc.id;
      }
      const payload = {
        name: draft.name, unit: draft.unit, cost: draft.cost,
        reorder: draft.min, max: draft.max, exp: draft.exp,
        catId, supplierId: draft.supplierId || null, composeCmv: draft.composeCmv,
      };
      if (id) {
        if (draft.qty !== undefined) payload.qty = draft.qty;
        const { data, error } = await dbUpdateStockItem(id, payload);
        if (error) { window.showToast?.(`Erro ao salvar: ${error.message}`, { tone: "crit", ttl: 5000 }); return { ok: false }; }
        setItems((prev) => prev.map((it) => it.id === id ? data : it));
        window.showToast?.("Insumo atualizado", { tone: "ok" });
      } else {
        const { data, error } = await dbInsertStockItem(tenantId, { ...draft, catId, supplierId: draft.supplierId || null, reorder: draft.min });
        if (error) { window.showToast?.(`Erro ao criar: ${error.message}`, { tone: "crit", ttl: 5000 }); return { ok: false }; }
        setItems((prev) => [data, ...prev]);
        window.showToast?.(`Insumo "${data.name}" criado`, { tone: "ok" });
      }
      return { ok: true };
    }
    // mock
    if (id) {
      setItems((prev) => prev.map((it) => it.id === id ? { ...it, ...draft, reorder: draft.min, status: _mRecalc({ ...it, ...draft, reorder: draft.min }) } : it));
    } else {
      const nid = `INS-${Date.now().toString(36).slice(-4).toUpperCase()}`;
      const ni = { id: nid, ...draft, reorder: draft.min, usage30d: 0, alloc: {}, supplier: suppliers.find((s) => s.id === draft.supplierId)?.name || null };
      ni.status = _mRecalc(ni);
      setItems((prev) => [ni, ...prev]);
    }
    window.showToast?.(id ? "Insumo atualizado (mock)" : "Insumo criado (mock)", { tone: "warn" });
    return { ok: true };
  };

  const handleDeleteItem = async (id) => {
    if (source === "db") {
      const { error } = await dbDeleteStockItem(id);
      if (error) { window.showToast?.(`Erro ao excluir: ${error.message}`, { tone: "crit", ttl: 4500 }); return { ok: false }; }
    }
    setItems((prev) => prev.filter((it) => it.id !== id));
    window.showToast?.("Insumo excluído", { tone: "ok" });
    return { ok: true };
  };

  if (pageLoading) return <PageLoading label="Carregando estoque…" variant="table" />;

  const activeFilterCount = (statusFilter !== "all" ? 1 : 0) + catFilter.length;

  return (
    <MobilePage>
      <SegTabs value={tab} onChange={setTab} options={[
        { id: "items", label: "Insumos", count: totals.all },
        { id: "pending", label: "Pendências", count: pendingItems.length || null, tone: "crit" },
        { id: "inventory", label: "Inventário" },
        { id: "suppliers", label: "Fornecedores" },
        { id: "categories", label: "Categorias" },
        { id: "wastes", label: "Desperdícios", tone: "crit" },
      ]} />

      {tab === "items" && (
        <>
          <StatStrip stats={[
            { label: "Entradas mês", value: _brlShort(flows.entradas), tone: "in", onClick: () => setFlowDetail("in") },
            { label: "Saídas mês", value: _brlShort(flows.saidas), tone: "out", onClick: () => setFlowDetail("out") },
            { label: "Valor estoque", value: _brlShort(totalValue), onClick: () => setValueModal(true) },
            { label: "Alertas", value: alerts.total, sub: `${alerts.ruptura} ruptura · ${alerts.baixo} baixo`, tone: alerts.ruptura > 0 ? "crit" : alerts.total > 0 ? "warn" : "ok", onClick: () => { setStatusFilter("crit"); } },
          ]} />

          <div style={{ padding: "0 14px 10px", display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}><MSearch value={search} onChange={setSearch} placeholder="Buscar insumo…" /></div>
            <button onClick={() => setFilterOpen(true)} aria-label="Filtros" style={{
              width: 44, height: 44, borderRadius: 8, flexShrink: 0, position: "relative",
              background: activeFilterCount > 0 ? "var(--accent-soft)" : "var(--bg-2)",
              border: `1px solid ${activeFilterCount > 0 ? "var(--accent-line)" : "var(--line)"}`,
              color: activeFilterCount > 0 ? "var(--accent-bright)" : "var(--fg-2)", display: "grid", placeItems: "center",
            }}>
              <I.Filter size={17} />
              {activeFilterCount > 0 && (
                <span style={{ position: "absolute", top: -6, right: -6, minWidth: 18, height: 18, padding: "0 5px", borderRadius: 9, background: "var(--accent-bright)", color: "var(--accent-fg, #07080a)", fontSize: 10, fontWeight: 700, display: "grid", placeItems: "center" }}>{activeFilterCount}</span>
              )}
            </button>
          </div>

          <MobileScroll style={{ padding: "0 14px 12px" }}>
            {filtered.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13 }}>
                Nenhum insumo encontrado.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {filtered.map((it) => (
                  <StockItemCard key={it.id} it={it} onTap={() => setDetail(it)} />
                ))}
              </div>
            )}
          </MobileScroll>

          <MobileBottomBar>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setCreating(true)} style={{ height: 52, padding: "0 16px", borderRadius: 10, flexShrink: 0, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                <I.Plus size={16} />Novo
              </button>
              <div style={{ flex: 1 }}>
                <MPrimaryButton onClick={() => setEntryOpen(true)}><I.Plus size={16} />Entrada manual</MPrimaryButton>
              </div>
            </div>
          </MobileBottomBar>
        </>
      )}

      {tab === "pending" && (
        <MobileScroll style={{ padding: "14px" }}>
          {pendingItems.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13 }}>
              Sem pendências de lançamento. 🎉<br />
              <span style={{ fontSize: 11.5 }}>Itens com saldo negativo (saída sem entrada) aparecem aqui.</span>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 12, color: "var(--fg-2)", marginBottom: 2 }}>
                {pendingItems.length} insumo(s) com saldo negativo. Registre a entrada que faltou.
              </div>
              {pendingItems.map((it) => (
                <MobileCard key={it.id} tone="crit" onClick={() => { setDetail(it); }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14.5, color: "var(--fg-0)", fontWeight: 500 }}>{it.name}</div>
                      <div style={{ fontSize: 11.5, color: "var(--crit)", marginTop: 2 }}>Saldo {it.qty} {it.unit}</div>
                    </div>
                    <MBadge tone="crit">Negativo</MBadge>
                  </div>
                </MobileCard>
              ))}
            </div>
          )}
        </MobileScroll>
      )}

      {tab === "inventory" && (
        <MobileScroll>
          {typeof Inventory === "function" ? <Inventory /> : <div style={{ padding: 24, color: "var(--fg-3)" }}>Inventário indisponível.</div>}
        </MobileScroll>
      )}

      {tab === "suppliers" && (
        <MobileScroll style={{ padding: "14px" }}>
          {typeof SuppliersView === "function" ? <SuppliersView /> : <div style={{ padding: 24, color: "var(--fg-3)" }}>Fornecedores indisponível.</div>}
        </MobileScroll>
      )}

      {tab === "categories" && (
        <MobileScroll style={{ padding: "14px" }}>
          {typeof CategoriesView === "function" ? (
            <CategoriesView
              categories={allCats}
              dbCategories={dbCategories}
              items={items}
              isDb={source === "db"}
              onCreate={createCategory}
              onRename={renameCategory}
              onUpdateFlags={updateCategoryFlags}
              onSetAutoMinMax={setCategoryAutoMinMax}
              onDelete={deleteCategory}
            />
          ) : <div style={{ padding: 24, color: "var(--fg-3)" }}>Categorias indisponível.</div>}
        </MobileScroll>
      )}

      {tab === "wastes" && (
        <MobileScroll style={{ padding: "14px" }}>
          {typeof WastesView === "function"
            ? <WastesView tenantId={tenantId} items={items} onApplied={refetchItems} />
            : <div style={{ padding: 24, color: "var(--fg-3)" }}>Desperdícios indisponível.</div>}
        </MobileScroll>
      )}

      {/* ===== Sheets ===== */}
      {filterOpen && (
        <StockFilterSheet
          statusFilter={statusFilter} setStatusFilter={setStatusFilter}
          catFilter={catFilter} setCatFilter={setCatFilter}
          allCats={allCats} totals={totals}
          onClose={() => setFilterOpen(false)}
        />
      )}

      {detail && (
        <StockItemDetailSheet
          it={items.find((x) => x.id === detail.id) || detail}
          onClose={() => setDetail(null)}
          onEdit={() => { setEditing(detail); setDetail(null); }}
          onEntry={() => { setEntryOpen(true); setDetail(null); }}
        />
      )}

      {(creating || editing) && (
        <StockItemFormSheet
          initial={editing}
          allCats={allCats}
          suppliers={suppliers}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSave={async (draft) => {
            const r = await handleSaveItem(editing?.id || null, draft);
            if (r.ok) { setCreating(false); setEditing(null); }
            return r;
          }}
          onDelete={editing ? async () => {
            const r = await handleDeleteItem(editing.id);
            if (r.ok) setEditing(null);
          } : null}
        />
      )}

      {entryOpen && (
        <StockEntrySheet
          items={items}
          onClose={() => setEntryOpen(false)}
          onConfirm={async (lines, note) => {
            const r = await handleEntry(lines, note);
            if (r.ok) setEntryOpen(false);
            return r;
          }}
        />
      )}

      {flowDetail && window.StockFlowDetailModal && (
        <window.StockFlowDetailModal direction={flowDetail} periodLabel="Mês atual" movements={movements} onClose={() => setFlowDetail(null)} />
      )}
      {valueModal && (
        <StockValueSheet items={items} onClose={() => setValueModal(false)} />
      )}
    </MobilePage>
  );
}

// ===== Card de insumo =====
function StockItemCard({ it, onTap }) {
  const tone = it.status === "ok" ? "ok" : it.status === "warn" ? "warn" : "crit";
  const lbl = it.status === "ok" ? "OK" : it.status === "warn" ? "Baixo" : "Ruptura";
  return (
    <MobileCard onClick={onTap}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</div>
          <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 3, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <span style={{ color: it.qty <= 0 ? "var(--crit)" : "var(--fg-2)", fontWeight: 500 }}>{it.qty} {it.unit}</span>
            <span>· {_brl(it.cost)}</span>
            <span>· mín {it.reorder}{it.max ? ` / máx ${it.max}` : ""}</span>
          </div>
        </div>
        <MBadge tone={tone}>{lbl}</MBadge>
      </div>
    </MobileCard>
  );
}

// ===== Detalhe do insumo (bottom sheet) =====
// Formata quantidade "à la desktop" (até 3 casas, vírgula BR).
const _qtyBR = (n) => (Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 3 });

// Busca as saídas do insumo nos últimos 30/7 dias + splits das requisições
// compartilhadas — mesma lógica do AllocationPanel do desktop. Retorna o consumo
// agregado (janela adaptativa 30d/7d) e a quebra por operação.
function useItemConsumption(itemId) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false };
  const [data, setData] = useState(null); // { window, qty, daily, hasData, byOp:[], sharedLegend }

  useEffect(() => {
    if (!dbStatus.isOnline || !itemId) { setData({ window: 30, qty: 0, daily: 0, hasData: false, byOp: [], sharedLegend: null }); return; }
    setData(null); // estado de carregamento (some dados do item anterior)
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const tid = ctx?.tenant?.id;
      if (!tid) { setData({ window: 30, qty: 0, daily: 0, hasData: false, byOp: [], sharedLegend: null }); return; }
      const d30 = new Date(Date.now() - 30 * 864e5).toISOString();
      const d7  = new Date(Date.now() - 7  * 864e5).toISOString();
      const [m30, m7] = await Promise.all([
        dbListStockMovements(tid, d30, null, { stockItemId: itemId, limit: 500 }),
        dbListStockMovements(tid, d7,  null, { stockItemId: itemId, limit: 500 }),
      ]);
      if (cancelled) return;
      const outs30 = (m30.data || []).filter((m) => m.kind === "out");
      const outs7  = (m7.data  || []).filter((m) => m.kind === "out");
      const total30 = outs30.reduce((s, m) => s + Math.abs(Number(m.delta) || 0), 0);
      const total7  = outs7.reduce((s, m) => s + Math.abs(Number(m.delta) || 0), 0);
      const useMonthly = total30 > 0;
      const daily = useMonthly ? total30 / 30 : total7 / 7;

      const reqIds = outs30
        .filter((m) => m.referenceType === "kitchen_request" && m.referenceId)
        .map((m) => m.referenceId);
      const splitsRes = await (window.dbListSharedSplits?.(tid, reqIds) || { data: {} });
      if (cancelled) return;
      const splits30 = splitsRes.data || {};

      // Agrupa saídas 30d por operação; compartilhado vai numa linha própria com legenda.
      const byOp = new Map();
      const sharedByOp = new Map();
      for (const m of outs30) {
        const qty = Math.abs(Number(m.delta) || 0);
        const sp = (m.referenceType === "kitchen_request" && m.referenceId) ? splits30[m.referenceId] : null;
        const key   = sp ? "__shared__" : (m.operationId || "__none__");
        const label = sp ? "Compartilhado" : (m.operationName || (m.op && m.op !== "—" ? m.op : "Sem operação"));
        const color = sp ? "var(--fg-2)" : (m.operationColor || "var(--fg-3)");
        if (!byOp.has(key)) byOp.set(key, { key, label, color, qty: 0 });
        byOp.get(key).qty += qty;
        if (sp) for (const s of sp) {
          const name = window.MOCK?.opById?.(s.op)?.name || "—";
          sharedByOp.set(name, (sharedByOp.get(name) || 0) + qty * ((Number(s.pct) || 0) / 100));
        }
      }
      const sharedTotal = Array.from(sharedByOp.values()).reduce((s, v) => s + v, 0);
      const sharedLegend = sharedTotal > 0
        ? Array.from(sharedByOp.entries()).sort((a, b) => b[1] - a[1])
            .map(([name, v]) => `${name} ${Math.round((v / sharedTotal) * 100)}%`).join(" · ")
        : null;
      const entries = Array.from(byOp.values()).filter((e) => e.qty > 0).sort((a, b) => b.qty - a.qty);

      setData({
        window: useMonthly ? 30 : 7,
        qty: useMonthly ? total30 : total7,
        daily, hasData: daily > 0,
        byOp: entries, sharedLegend,
      });
    })();
    return () => { cancelled = true; };
  }, [dbStatus.isOnline, itemId]);

  return data;
}

function StockItemDetailSheet({ it, onClose, onEdit, onEntry }) {
  const tone = it.status === "ok" ? "ok" : it.status === "warn" ? "warn" : "crit";
  const lbl = it.status === "ok" ? "Em estoque" : it.status === "warn" ? "Baixo" : "Ruptura";
  const cons = useItemConsumption(it.id);
  const totalByOp = cons ? cons.byOp.reduce((s, e) => s + e.qty, 0) : 0;
  const coverage = cons?.hasData && cons.daily > 0 && it.qty > 0 ? Math.round(Math.max(0, it.qty) / cons.daily) : null;
  const Row = ({ k, v }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: "1px solid var(--line-soft)", fontSize: 13.5 }}>
      <span style={{ color: "var(--fg-3)" }}>{k}</span>
      <span style={{ color: "var(--fg-0)", fontWeight: 500 }}>{v}</span>
    </div>
  );
  return (
    <BottomSheet
      title={it.name}
      subtitle={<span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>{it.cat}{it.supplier ? ` · ${it.supplier}` : ""}</span>}
      onClose={onClose}
      footer={
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onEdit} style={{ flex: 1, height: 50, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><I.Edit size={15} />Editar</button>
          <div style={{ flex: 1 }}><MPrimaryButton onClick={onEntry}><I.Plus size={16} />Entrada</MPrimaryButton></div>
        </div>
      }
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <MBadge tone={tone}>{lbl}</MBadge>
        <span style={{ fontSize: 20, fontWeight: 600, color: it.qty <= 0 ? "var(--crit)" : "var(--fg-0)" }}>{it.qty} {it.unit}</span>
      </div>
      {/* Barra de escala com marcadores de mín/máx (reusa o componente do desktop) */}
      {it.max && window.StockScaleBar && (
        <window.StockScaleBar qty={it.qty} reorder={it.reorder} max={it.max} unit={it.unit} />
      )}
      <Row k="Última compra" v={_brl(it.cost)} />
      <Row k="Valor em estoque" v={_brl(Math.max(0, it.qty) * it.cost)} />
      <Row k="Mínimo / Máximo" v={`${it.reorder} / ${it.max ?? "—"} ${it.unit}`} />
      {it.exp && it.exp !== "—" && <Row k="Validade" v={it.exp} />}

      {/* Consumo · janela adaptativa 30d/7d + média semanal (dados reais) */}
      <div style={{ marginTop: 16 }}>
        <MSectionLabel>Consumo · {cons == null ? "carregando…" : `últimos ${cons.window} dias`}</MSectionLabel>
        {cons == null ? (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--fg-3)" }}>Carregando…</div>
        ) : !cons.hasData ? (
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--fg-3)" }}>Sem saídas registradas nos últimos {cons.window} dias.</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
              <div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{cons.window} dias</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 600, color: "var(--fg-0)", letterSpacing: "-0.018em" }}>{_qtyBR(cons.qty)} {it.unit}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>{_brl(cons.qty * it.cost)}</div>
              </div>
              <div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Média semanal</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 600, color: "var(--accent-bright)", letterSpacing: "-0.018em" }}>{(cons.daily * 7).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} {it.unit}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>média/dia × 7</div>
              </div>
            </div>
            {coverage != null && (
              <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--fg-2)" }}>
                Cobertura estimada: <span style={{ fontFamily: "var(--mono)", color: "var(--fg-0)" }}>{coverage} dias</span> com saldo atual.
              </div>
            )}
          </>
        )}
      </div>

      {/* Consumo por operação · 30 dias */}
      {cons && cons.byOp.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <MSectionLabel>Consumo por operação · 30 dias</MSectionLabel>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 12 }}>
            {cons.byOp.map((e) => {
              const pct = totalByOp > 0 ? (e.qty / totalByOp) * 100 : 0;
              return (
                <div key={e.key}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 50, background: e.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 12.5, color: "var(--fg-0)" }}>{e.label}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-2)" }}>{_qtyBR(e.qty)} {it.unit}</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-0)", width: 46, textAlign: "right" }}>{pct.toFixed(1)}%</span>
                  </div>
                  <div style={{ height: 3, borderRadius: 2, background: "var(--bg-3)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: e.color }} />
                  </div>
                  {e.key === "__shared__" && cons.sharedLegend && (
                    <div style={{ marginTop: 5, fontSize: 10.5, color: "var(--fg-3)", paddingLeft: 14 }}>{cons.sharedLegend}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </BottomSheet>
  );
}

// ===== Form de criar/editar insumo (full sheet) =====
function StockItemFormSheet({ initial, allCats, suppliers, onClose, onSave, onDelete }) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [cat, setCat] = useState(initial?.cat ?? (allCats[0] || ""));
  const [unit, setUnit] = useState(initial?.unit ?? "kg");
  const [cost, setCost] = useState(initial?.cost != null ? String(initial.cost) : "");
  const [qty, setQty] = useState(initial?.qty != null ? String(initial.qty) : "0");
  const [min, setMin] = useState(initial?.reorder != null ? String(initial.reorder) : "");
  const [max, setMax] = useState(initial?.max != null ? String(initial.max) : "");
  const [exp, setExp] = useState(initial?.exp && initial.exp !== "—" ? initial.exp : "");
  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? "");
  const [composeCmv, setComposeCmv] = useState(initial?.composeCmv !== false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const minN = _pbrM(min), maxN = _pbrM(max);
  const errName = !name.trim();
  const errMax = maxN > 0 && minN > 0 && maxN < minN;
  const valid = !errName && !errMax && !!cat.trim() && !!unit.trim();

  const submit = async () => {
    if (saving || !valid) return;
    setSaving(true);
    try {
      await onSave({
        name: name.trim(), cat: cat.trim(), unit: unit.trim(),
        cost: _pbrM(cost), qty: _pbrM(qty), min: minN, max: maxN,
        exp: exp.trim(), supplierId: supplierId || null, composeCmv,
      });
    } finally { setSaving(false); }
  };
  const doDelete = async () => {
    if (deleting || !onDelete) return;
    setDeleting(true);
    try { await onDelete(); } finally { setDeleting(false); }
  };

  return (
    <FullSheet
      title={isEdit ? "Editar insumo" : "Novo insumo"}
      subtitle={isEdit ? initial.id : "Cadastrar item no estoque"}
      onBack={saving || deleting ? undefined : onClose}
      footer={
        <MPrimaryButton onClick={submit} disabled={!valid} loading={saving}>
          {isEdit ? "Salvar alterações" : "Cadastrar insumo"}
        </MPrimaryButton>
      }
    >
      <MField label="Nome do insumo" error={errName ? "Obrigatório" : null}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Farinha de trigo" autoFocus
               style={{ ...mInput, borderColor: errName ? "var(--crit)" : "var(--line)" }} />
      </MField>

      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <MField label="Categoria">
            <select value={cat} onChange={(e) => setCat(e.target.value)} style={mInput}>
              <option value="" disabled>Selecione…</option>
              {allCats.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </MField>
        </div>
        <div style={{ width: 96 }}>
          <MField label="Unidade">
            <select value={unit} onChange={(e) => setUnit(e.target.value)} style={mInput}>
              <option value="kg">kg</option>
              <option value="un">un</option>
            </select>
          </MField>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <MField label="Custo unit. (R$)">
            <input value={cost} inputMode="decimal" onChange={(e) => setCost(e.target.value)} placeholder="0,00" style={mInput} />
          </MField>
        </div>
        {!isEdit && (
          <div style={{ flex: 1 }}>
            <MField label={`Qtd inicial (${unit})`}>
              <input value={qty} inputMode="decimal" onChange={(e) => setQty(e.target.value)} placeholder="0" style={mInput} />
            </MField>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <MField label={`Mínimo (${unit})`} hint="Aciona compra.">
            <input value={min} inputMode="decimal" onChange={(e) => setMin(e.target.value)} placeholder="0" style={mInput} />
          </MField>
        </div>
        <div style={{ flex: 1 }}>
          <MField label={`Máximo (${unit})`} error={errMax ? "≥ mínimo" : null} hint={errMax ? null : "Alvo após compra."}>
            <input value={max} inputMode="decimal" onChange={(e) => setMax(e.target.value)} placeholder="0"
                   style={{ ...mInput, borderColor: errMax ? "var(--crit)" : "var(--line)" }} />
          </MField>
        </div>
      </div>

      <MField label="Validade (opcional)" hint="Formato livre · ex.: 12/05">
        <input value={exp} onChange={(e) => setExp(e.target.value)} placeholder="—" style={mInput} />
      </MField>

      <MField label="Fornecedor (opcional)" hint={suppliers.length === 0 ? "Cadastre no desktop" : null}>
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} disabled={suppliers.length === 0} style={mInput}>
          <option value="">— Sem fornecedor —</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </MField>

      <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px", borderRadius: 10, background: composeCmv ? "var(--ok-soft)" : "var(--bg-2)", border: `1px solid ${composeCmv ? "var(--ok-line)" : "var(--line)"}` }}>
        <input type="checkbox" checked={composeCmv} onChange={(e) => setComposeCmv(e.target.checked)} style={{ width: 20, height: 20 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }}>Compõe CMV</div>
          <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2 }}>Desligue p/ embalagens, limpeza, descartáveis.</div>
        </div>
      </label>

      {isEdit && onDelete && (
        <div style={{ marginTop: 18 }}>
          {!confirmDelete ? (
            <button onClick={() => setConfirmDelete(true)} style={{ width: "100%", height: 48, borderRadius: 10, background: "transparent", border: "1px solid var(--crit-line)", color: "var(--crit)", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <I.Trash size={15} />Excluir insumo
            </button>
          ) : (
            <div style={{ padding: 12, borderRadius: 10, background: "var(--crit-soft)", border: "1px solid var(--crit-line)" }}>
              <div style={{ fontSize: 12.5, color: "var(--fg-1)", marginBottom: 10 }}>Excluir <strong>{initial.name}</strong>? Não pode ser desfeito.</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setConfirmDelete(false)} disabled={deleting} style={{ flex: 1, height: 46, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14 }}>Cancelar</button>
                <button onClick={doDelete} disabled={deleting} style={{ flex: 1, height: 46, borderRadius: 10, background: "var(--crit)", border: "none", color: "#fff", fontSize: 14, fontWeight: 600 }}>{deleting ? "Excluindo…" : "Excluir"}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </FullSheet>
  );
}

// ===== Entrada manual (full sheet, multi-linha estilo carrinho) =====
function StockEntrySheet({ items, onClose, onConfirm }) {
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState([]); // [{ itemId, qty, cost }]
  const [note, setNote] = useState("");
  const [picking, setPicking] = useState(null); // item sendo configurado
  const [submitting, setSubmitting] = useState(false);

  const byId = (id) => items.find((it) => it.id === id);
  const lineOf = (id) => lines.find((l) => l.itemId === id);
  const setLine = (itemId, qty, cost) => {
    setLines((cur) => {
      const q = _pbrM(qty);
      if (q <= 0) return cur.filter((l) => l.itemId !== itemId);
      const found = cur.find((l) => l.itemId === itemId);
      if (found) return cur.map((l) => l.itemId === itemId ? { ...l, qty, cost } : l);
      return [...cur, { itemId, qty, cost }];
    });
  };

  const q = query.trim().toLowerCase();
  const results = q
    ? items.filter((it) => it.name.toLowerCase().includes(q) || (it.cat || "").toLowerCase().includes(q))
    : items;
  const total = lines.reduce((s, l) => s + _pbrM(l.qty) * _pbrM(l.cost), 0);

  const confirm = async () => {
    if (submitting || lines.length === 0) return;
    setSubmitting(true);
    try { await onConfirm(lines, note.trim() || "Entrada manual"); }
    finally { setSubmitting(false); }
  };

  return (
    <FullSheet
      title="Entrada manual"
      subtitle={lines.length > 0 ? `${lines.length} item(ns) · ${_brl(total)}` : "Adicione insumos recebidos"}
      onBack={submitting ? undefined : onClose}
      footer={
        <>
          {lines.length > 0 && (
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Observação (opcional)"
                   style={{ ...mInput, marginBottom: 8 }} />
          )}
          <MPrimaryButton onClick={confirm} disabled={lines.length === 0} loading={submitting}>
            Registrar {lines.length > 0 ? `${lines.length} entrada(s)` : "entrada"}
          </MPrimaryButton>
        </>
      }
    >
      <div style={{ marginBottom: 10 }}><MSearch value={query} onChange={setQuery} placeholder="Buscar insumo…" /></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {results.length === 0 && <div style={{ fontSize: 13, color: "var(--fg-3)", padding: "12px 4px" }}>Nenhum insumo.</div>}
        {results.map((it) => {
          const ln = lineOf(it.id);
          const inList = !!ln;
          return (
            <button key={it.id} onClick={() => setPicking(it)} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 8, textAlign: "left",
              background: inList ? "var(--accent-soft)" : "var(--bg-2)",
              border: `1px solid ${inList ? "var(--accent-line)" : "var(--line)"}`, color: "inherit",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 1 }}>saldo {it.qty} {it.unit} · {_brl(it.cost)}</div>
              </div>
              {inList
                ? <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--accent-bright)", whiteSpace: "nowrap" }}>+{ln.qty} {it.unit}</span>
                : <span style={{ width: 34, height: 34, borderRadius: 8, background: "var(--bg-3)", border: "1px solid var(--line)", color: "var(--fg-1)", display: "grid", placeItems: "center", flexShrink: 0 }}><I.Plus size={16} /></span>}
            </button>
          );
        })}
      </div>

      {picking && (
        <EntryQtySheet
          it={picking}
          initial={lineOf(picking.id)}
          onClose={() => setPicking(null)}
          onConfirm={(qty, cost) => { setLine(picking.id, qty, cost); setPicking(null); }}
          onRemove={lineOf(picking.id) ? () => { setLine(picking.id, 0); setPicking(null); } : null}
        />
      )}
    </FullSheet>
  );
}

function EntryQtySheet({ it, initial, onClose, onConfirm, onRemove }) {
  const step = (it.unit === "un" || it.unit === "und") ? 1 : 0.5;
  const [qty, setQty] = useState(initial ? initial.qty : 1);
  const [cost, setCost] = useState(initial?.cost != null ? String(initial.cost) : (it.cost != null ? String(it.cost) : ""));
  const valid = _pbrM(qty) > 0;
  return (
    <BottomSheet
      title={it.name}
      subtitle={`${it.cat} · saldo ${it.qty} ${it.unit}`}
      onClose={onClose}
      footer={
        <div style={{ display: "flex", gap: 8 }}>
          {onRemove && (
            <button onClick={onRemove} style={{ height: 50, padding: "0 16px", borderRadius: 10, background: "transparent", border: "1px solid var(--line)", color: "var(--crit)", fontSize: 14, fontWeight: 600 }}>Remover</button>
          )}
          <div style={{ flex: 1 }}>
            <MPrimaryButton onClick={() => valid && onConfirm(qty, cost)} disabled={!valid}>Adicionar</MPrimaryButton>
          </div>
        </div>
      }
    >
      <div style={{ margin: "8px 0 16px" }}>
        <Stepper value={qty} onChange={setQty} step={step} unit={it.unit} />
      </div>
      <MField label="Custo unitário desta compra (R$)" hint="Sobrescreve o custo atual (última compra).">
        <input value={cost} inputMode="decimal" onChange={(e) => setCost(e.target.value)} placeholder="0,00" style={mInput} />
      </MField>
      {valid && _pbrM(cost) > 0 && (
        <div style={{ textAlign: "center", fontSize: 13, color: "var(--fg-2)" }}>Total ≈ {_brl(_pbrM(qty) * _pbrM(cost))}</div>
      )}
    </BottomSheet>
  );
}

// ===== Filtros (bottom sheet) =====
function StockFilterSheet({ statusFilter, setStatusFilter, catFilter, setCatFilter, allCats, totals, onClose }) {
  const statusOpts = [
    { id: "all", label: "Todos", count: totals.all },
    { id: "ok", label: "Em estoque", count: totals.ok, tone: "ok" },
    { id: "warn", label: "Baixo", count: totals.warn, tone: "warn" },
    { id: "crit", label: "Ruptura", count: totals.crit, tone: "crit" },
  ];
  const toggleCat = (c) => setCatFilter((cur) => cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]);
  return (
    <BottomSheet
      title="Filtros"
      onClose={onClose}
      footer={
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setStatusFilter("all"); setCatFilter([]); }} style={{ height: 50, padding: "0 16px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14, fontWeight: 600 }}>Limpar</button>
          <div style={{ flex: 1 }}><MPrimaryButton onClick={onClose}>Aplicar</MPrimaryButton></div>
        </div>
      }
    >
      <MSectionLabel>Status</MSectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "10px 0 18px" }}>
        {statusOpts.map((o) => {
          const active = statusFilter === o.id;
          return (
            <button key={o.id} onClick={() => setStatusFilter(o.id)} style={{
              height: 38, padding: "0 14px", borderRadius: 999,
              background: active ? "var(--accent-bright)" : "var(--bg-2)",
              color: active ? "var(--accent-fg, #07080a)" : "var(--fg-1)",
              border: `1px solid ${active ? "var(--accent-bright)" : "var(--line)"}`, fontSize: 13, fontWeight: active ? 600 : 400,
            }}>{o.label} ({o.count})</button>
          );
        })}
      </div>

      {allCats.length > 0 && (
        <>
          <MSectionLabel>Categorias</MSectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            {allCats.map((c) => {
              const active = catFilter.includes(c);
              return (
                <button key={c} onClick={() => toggleCat(c)} style={{
                  height: 36, padding: "0 12px", borderRadius: 999,
                  background: active ? "var(--accent-soft)" : "var(--bg-2)",
                  color: active ? "var(--accent-bright)" : "var(--fg-1)",
                  border: `1px solid ${active ? "var(--accent-line)" : "var(--line)"}`, fontSize: 12.5,
                  display: "inline-flex", alignItems: "center", gap: 6,
                }}>
                  {active && <I.Check size={13} />}{c}
                </button>
              );
            })}
          </div>
        </>
      )}
    </BottomSheet>
  );
}

// ===== Valor em estoque · Top 25 (simplificado p/ mobile: item · qtd · valor) =====
function StockValueSheet({ items, onClose }) {
  const top = useMemo(() => (Array.isArray(items) ? items : [])
    .map((it) => ({ ...it, _value: Math.max(0, Number(it.qty) || 0) * (Number(it.cost) || 0) }))
    .filter((it) => it._value > 0)
    .sort((a, b) => b._value - a._value)
    .slice(0, 25), [items]);
  const totalTop = top.reduce((s, it) => s + it._value, 0);
  const totalAll = (items || []).reduce((s, it) => s + Math.max(0, Number(it.qty) || 0) * (Number(it.cost) || 0), 0);
  const sharePct = totalAll > 0 ? (totalTop / totalAll) * 100 : 0;

  return (
    <BottomSheet
      title="Valor em estoque · Top 25"
      subtitle={`${top.length} insumos · ${_brl(totalTop)} (${sharePct.toFixed(0)}% do total)`}
      onClose={onClose}
    >
      {top.length === 0 ? (
        <div style={{ padding: "32px 0", textAlign: "center", color: "var(--fg-3)", fontSize: 13 }}>
          Nenhum insumo com valor em estoque.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {top.map((it, i) => (
            <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: "1px solid var(--line-soft)" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-4)", width: 20, textAlign: "right", flexShrink: 0 }}>{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 2 }}>{Number(Math.max(0, it.qty) || 0).toLocaleString("pt-BR")} {it.unit}</div>
              </div>
              <span style={{ fontFamily: "var(--mono)", fontSize: 13.5, color: "var(--fg-0)", fontWeight: 600, whiteSpace: "nowrap" }}>{_brl(it._value)}</span>
            </div>
          ))}
        </div>
      )}
    </BottomSheet>
  );
}

window.MobileStock = MobileStock;
