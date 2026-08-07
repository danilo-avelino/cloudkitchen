// page-mobile-recipes.jsx — Fichas técnicas no celular (≤480px). Fichas (pratos) e
// preparos: consulta + CRIAR/EDITAR + composição (adicionar/remover insumos).
// Reaproveita as funções db* do desktop (page-recipes.jsx): custos são recalculados
// pelos triggers do banco. Insumo pode vir do estoque ou de um preparo.

const _rcBRL = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _rcNorm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const _rcNum = (raw) => { const n = parseFloat(String(raw ?? "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };

function MobileRecipes({ scope = "all" }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [mode, setMode] = useState("recipes"); // recipes | preparations
  const [sheets, setSheets] = useState(MOCK.TECH_SHEETS || []);
  const [preps, setPreps] = useState(MOCK.PREPARATIONS || []);
  const [stockItems, setStockItems] = useState(MOCK.STOCK_ITEMS || []);
  const [cats, setCats] = useState(MOCK.RECIPE_CATEGORIES || []);
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState("mock");
  const [query, setQuery] = useState("");
  const [pageLoading, setPageLoading] = useState(true);
  const [detailId, setDetailId] = useState(null);
  const [form, setForm] = useState(null); // { edit?: item }

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
        setSource("db");
        const [sRes, pRes, stRes, cRes] = await Promise.all([
          dbListTechSheets(tid), dbListPreparations(tid), dbListStockItems(tid),
          typeof dbListRecipeCategories === "function" ? dbListRecipeCategories(tid) : Promise.resolve({ data: null }),
        ]);
        if (cancelled) return;
        setSheets(sRes.data || []); setPreps(pRes.data || []);
        setStockItems(stRes.data || []);
        if (cRes?.data) setCats(cRes.data);
      } finally { if (!cancelled) setPageLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  const isPrep = mode === "preparations";
  const reloadSheets = async () => { if (tenantId) { const { data } = await dbListTechSheets(tenantId); if (data) setSheets(data); } };
  const reloadPreps = async () => { if (tenantId) { const { data } = await dbListPreparations(tenantId); if (data) setPreps(data); } };
  const reloadCur = () => isPrep ? reloadPreps() : reloadSheets();

  const recompute = (it) => {
    const theo = (it.items || []).reduce((s, row) => s + (_rcNum(Array.isArray(row) ? row[2] : row.cost)), 0);
    if (isPrep) { const y = _rcNum(it.yieldQty); return { ...it, theo, unitCost: y > 0 ? theo / y : 0 }; }
    return { ...it, theo, cmv: it.price > 0 ? (theo / it.price) * 100 : 0 };
  };
  const setLocal = (updater) => isPrep ? setPreps(updater) : setSheets(updater);

  // ===== create / edit metadata =====
  const handleSave = async (draft, editId) => {
    if (source === "db" && tenantId) {
      if (editId) {
        const partial = isPrep ? { op: draft.op, cat: draft.cat, name: draft.name, yieldQty: draft.yieldQty, yieldUnit: draft.yieldUnit } : { op: draft.op, cat: draft.cat, name: draft.name, price: draft.price };
        const updFn = isPrep ? dbUpdatePreparation : dbUpdateTechSheet;
        const { error } = await updFn(editId, partial);
        if (error) { window.showToast?.(`Erro ao salvar: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; }
        await reloadCur(); window.showToast?.("Atualizado", { tone: "ok" }); return true;
      }
      if (isPrep) {
        const code = `PRP-${Date.now().toString(36).slice(-6).toUpperCase()}`;
        const { data, error } = await dbInsertPreparation(tenantId, { code, op: draft.op, cat: draft.cat, name: draft.name, yieldQty: draft.yieldQty, yieldUnit: draft.yieldUnit });
        if (error) { window.showToast?.(`Erro ao criar: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; }
        await reloadPreps(); window.showToast?.(`Preparo ${code} criado`, { tone: "ok" }); setDetailId(data.id); return true;
      }
      const code = `FIC-${Date.now().toString(36).slice(-6).toUpperCase()}`;
      const { data, error } = await dbInsertTechSheet(tenantId, { code, op: draft.op, cat: draft.cat, name: draft.name, price: draft.price, yieldQty: 1, yieldUnit: "un", items: [] });
      if (error) { window.showToast?.(`Erro ao criar: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; }
      await reloadSheets(); window.showToast?.(`Ficha ${code} criada`, { tone: "ok" }); setDetailId(data.id); return true;
    }
    // mock
    if (editId) { setLocal((prev) => prev.map((it) => it.id === editId ? recompute({ ...it, ...draft }) : it)); return true; }
    const id = `${isPrep ? "PRP" : "FIC"}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
    const base = isPrep ? { id, ...draft, items: [], theo: 0, unitCost: 0 } : { id, ...draft, items: [], theo: 0, cmv: 0 };
    setLocal((prev) => [recompute(base), ...prev]); setDetailId(id);
    window.showToast?.(`${isPrep ? "Preparo" : "Ficha"} criad${isPrep ? "o" : "a"} (offline)`, { tone: "warn" });
    return true;
  };

  const addIngredient = async (item, ingredient) => {
    if (source === "db" && tenantId && /^[0-9a-f]{8}-/i.test(String(item.id))) {
      const fn = isPrep ? () => dbInsertPreparationItem(item.id, ingredient, (item.items || []).length) : () => dbInsertTechSheetItem(item.id, ingredient);
      const { error } = await fn();
      if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit" }); return; }
      await reloadCur(); window.showToast?.("Insumo adicionado", { tone: "ok" });
      return;
    }
    setLocal((prev) => prev.map((it) => it.id === item.id ? recompute({ ...it, items: [...(it.items || []), ingredient] }) : it));
  };
  const removeIngredient = async (item, idx) => {
    const row = (item.items || [])[idx];
    if (source === "db" && tenantId && row && row.id) {
      const del = isPrep ? dbDeletePreparationItem : dbDeleteTechSheetItem;
      const { error } = await del(row.id);
      if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit" }); return; }
      await reloadCur(); window.showToast?.("Insumo removido", { tone: "ok" });
      return;
    }
    setLocal((prev) => prev.map((it) => it.id === item.id ? recompute({ ...it, items: (it.items || []).filter((_, i) => i !== idx) }) : it));
  };

  const base = isPrep ? preps : sheets;
  const q = _rcNorm(query.trim());
  const list = useMemo(() => base
    .filter((it) => scope === "all" || it.op === scope)
    .filter((it) => !q || _rcNorm(it.name).includes(q) || _rcNorm(it.code).includes(q))
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", "pt-BR")),
    [base, scope, q]);
  const detail = detailId ? base.find((it) => it.id === detailId) : null;

  if (pageLoading) return <PageLoading label="Carregando fichas…" variant="table" />;

  return (
    <MobilePage>
      <SegTabs value={mode} onChange={(v) => { setMode(v); setDetailId(null); }} options={[
        { id: "recipes", label: "Fichas", count: sheets.filter((it) => scope === "all" || it.op === scope).length },
        { id: "preparations", label: "Preparos", count: preps.filter((it) => scope === "all" || it.op === scope).length },
      ]} />

      <div style={{ padding: "0 14px 10px" }}>
        <MSearch value={query} onChange={setQuery} placeholder={isPrep ? "Buscar preparo…" : "Buscar ficha…"} />
      </div>

      <MobileScroll style={{ padding: "0 14px 14px" }}>
        {list.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13 }}>Nenhum{isPrep ? " preparo" : "a ficha"} encontrad{isPrep ? "o" : "a"}.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {list.map((it) => <RecipeCard key={it.id} item={it} isPrep={isPrep} onTap={() => setDetailId(it.id)} />)}
          </div>
        )}
      </MobileScroll>

      <MobileBottomBar>
        <MPrimaryButton onClick={() => setForm({})}><I.Plus size={16} />{isPrep ? "Novo preparo" : "Nova ficha"}</MPrimaryButton>
      </MobileBottomBar>

      {detail && (
        <RecipeSheet
          item={detail} isPrep={isPrep} stockItems={stockItems} preparations={preps}
          onClose={() => setDetailId(null)}
          onEdit={() => setForm({ edit: detail })}
          onAddIngredient={(ing) => addIngredient(detail, ing)}
          onRemoveIngredient={(idx) => removeIngredient(detail, idx)}
        />
      )}

      {form && (
        <RecipeForm
          isPrep={isPrep} initial={form.edit || null} cats={cats}
          onClose={() => setForm(null)}
          onSave={async (draft) => { const ok = await handleSave(draft, form.edit?.id || null); if (ok) setForm(null); return ok; }}
        />
      )}
    </MobilePage>
  );
}

function RecipeCard({ item, isPrep, onTap }) {
  const op = MOCK.opById ? MOCK.opById(item.op) : null;
  const theo = Number(item.theo) || 0, price = Number(item.price) || 0;
  const cmv = Number(item.cmv) || (price > 0 ? (theo / price) * 100 : 0);
  const cmvTone = cmv > 35 ? "crit" : cmv > 31 ? "warn" : "ok";
  return (
    <MobileCard onClick={onTap}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</div>
          <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 3, display: "flex", alignItems: "center", gap: 6 }}>
            {op && <span style={{ width: 5, height: 5, borderRadius: 50, background: op.color, flexShrink: 0 }} />}
            {op?.name || "—"} · {(item.items || []).length} insumos
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
          {isPrep ? (
            <><span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-0)", fontWeight: 600 }}>{_rcBRL(item.unitCost || 0)}</span><span style={{ fontSize: 10.5, color: "var(--fg-3)" }}>/{item.yieldUnit || "kg"}</span></>
          ) : (
            <><span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-0)", fontWeight: 600 }}>{_rcBRL(price)}</span><MBadge tone={cmvTone}>CMV {cmv.toFixed(0)}%</MBadge></>
          )}
        </div>
      </div>
    </MobileCard>
  );
}

function RecipeSheet({ item, isPrep, stockItems, preparations, onClose, onEdit, onAddIngredient, onRemoveIngredient }) {
  const op = MOCK.opById ? MOCK.opById(item.op) : null;
  const items = item.items || [];
  const theo = Number(item.theo) || 0, price = Number(item.price) || 0;
  const cmv = Number(item.cmv) || (price > 0 ? (theo / price) * 100 : 0);
  const margin = price - theo;
  const [adding, setAdding] = useState(false);

  return (
    <BottomSheet
      title={item.name}
      subtitle={<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{op && <span style={{ width: 6, height: 6, borderRadius: 50, background: op.color }} />}{op?.name || "—"}{isPrep ? " · preparo" : ""} · {item.code || item.id}</span>}
      onClose={onClose}
      footer={
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onEdit} style={{ height: 50, padding: "0 16px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}><I.Edit size={15} />Editar</button>
          <div style={{ flex: 1 }}><MPrimaryButton onClick={() => setAdding(true)}><I.Plus size={16} />Adicionar insumo</MPrimaryButton></div>
        </div>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
        {isPrep ? (
          <>
            <_RcTile label="Rendimento" value={`${item.yieldQty || 1} ${item.yieldUnit || "kg"}`} />
            <_RcTile label="Custo total" value={_rcBRL(theo)} />
            <_RcTile label="Custo unitário" value={`${_rcBRL(item.unitCost || 0)}/${item.yieldUnit || "kg"}`} />
            <_RcTile label="Insumos" value={String(items.length)} />
          </>
        ) : (
          <>
            <_RcTile label="Preço de venda" value={_rcBRL(price)} />
            <_RcTile label="Custo composto" value={_rcBRL(theo)} />
            <_RcTile label="CMV teórico" value={`${cmv.toFixed(1)}%`} color={cmv > 35 ? "var(--crit)" : cmv > 31 ? "var(--warn)" : "var(--ok)"} />
            <_RcTile label="Margem" value={_rcBRL(margin)} sub={price > 0 ? `${((margin / price) * 100).toFixed(1)}%` : "—"} />
          </>
        )}
      </div>

      <MSectionLabel>Composição</MSectionLabel>
      <div style={{ marginTop: 8 }}>
        {items.length === 0 ? (
          <div style={{ padding: "20px 0", textAlign: "center", color: "var(--fg-3)", fontSize: 13 }}>Sem insumos · toque em “Adicionar insumo”.</div>
        ) : items.map((row, i) => {
          const name = Array.isArray(row) ? row[0] : row.name;
          const qty = Array.isArray(row) ? row[1] : row.qty;
          const cost = Array.isArray(row) ? row[2] : row.cost;
          const pct = theo > 0 ? (Number(cost) / theo) * 100 : 0;
          return (
            <div key={i} style={{ padding: "10px 0", borderBottom: i < items.length - 1 ? "1px solid var(--line-soft)" : "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-3)" }}>{typeof qty === "number" ? qty.toLocaleString("pt-BR", { maximumFractionDigits: 3 }) : qty}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-0)", fontWeight: 600, width: 74, textAlign: "right" }}>{_rcBRL(cost)}</span>
                <button onClick={() => onRemoveIngredient(i)} aria-label="Remover" style={{ width: 30, height: 30, borderRadius: 7, flexShrink: 0, background: "transparent", border: "none", color: "var(--crit)", display: "grid", placeItems: "center" }}><I.Trash size={14} /></button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
                <div style={{ flex: 1, height: 4, borderRadius: 2, background: "var(--bg-3)", overflow: "hidden" }}><div style={{ height: "100%", width: `${Math.min(100, pct)}%`, background: "var(--accent-bright)" }} /></div>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", width: 42, textAlign: "right" }}>{pct.toFixed(1)}%</span>
              </div>
            </div>
          );
        })}
      </div>

      {adding && (
        <IngredientSheet
          stockItems={stockItems} preparations={preparations} excludeId={isPrep ? item.id : null}
          onClose={() => setAdding(false)}
          onConfirm={(ing) => { onAddIngredient(ing); setAdding(false); }}
        />
      )}
    </BottomSheet>
  );
}

// ===== Form: criar/editar ficha ou preparo =====
function RecipeForm({ isPrep, initial, cats, onClose, onSave }) {
  const ops = (MOCK.OPERATIONS || []).filter((o) => o.id !== "all");
  const [op, setOp] = useState(initial?.op || ops[0]?.id || "");
  const [cat, setCat] = useState(initial?.cat || "");
  const [name, setName] = useState(initial?.name || "");
  const [price, setPrice] = useState(initial?.price != null ? String(initial.price).replace(".", ",") : "");
  const [yieldQty, setYieldQty] = useState(initial?.yieldQty != null ? String(initial.yieldQty).replace(".", ",") : "");
  const [yieldUnit, setYieldUnit] = useState(initial?.yieldUnit || "kg");
  const [saving, setSaving] = useState(false);
  const valid = op && name.trim() && (isPrep ? _rcNum(yieldQty) > 0 : true);

  const submit = async () => {
    if (saving || !valid) return; setSaving(true);
    try {
      const draft = isPrep
        ? { op, cat, name: name.trim(), yieldQty: _rcNum(yieldQty), yieldUnit }
        : { op, cat, name: name.trim(), price: _rcNum(price) };
      await onSave(draft);
    } finally { setSaving(false); }
  };

  return (
    <FullSheet
      title={initial ? (isPrep ? "Editar preparo" : "Editar ficha") : (isPrep ? "Novo preparo" : "Nova ficha técnica")}
      subtitle={initial ? (initial.code || initial.id) : "Cadastre e depois componha os insumos"}
      onBack={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={submit} disabled={!valid} loading={saving}>{initial ? "Salvar" : "Criar"}</MPrimaryButton>}
    >
      <MField label="Nome"><input value={name} onChange={(e) => setName(e.target.value)} placeholder={isPrep ? "Ex.: Molho de tomate" : "Ex.: Pizza calabresa"} autoFocus style={mInput} /></MField>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><MField label="Operação">
          <select value={op} onChange={(e) => setOp(e.target.value)} style={mInput}>{ops.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
        </MField></div>
        <div style={{ flex: 1 }}><MField label="Categoria">
          <select value={cat} onChange={(e) => setCat(e.target.value)} style={mInput}>
            <option value="">— Sem categoria —</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.label || c.name}</option>)}
          </select>
        </MField></div>
      </div>
      {isPrep ? (
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}><MField label="Rendimento"><input value={yieldQty} inputMode="decimal" onChange={(e) => setYieldQty(e.target.value)} placeholder="0" style={mInput} /></MField></div>
          <div style={{ width: 110 }}><MField label="Unidade">
            <select value={yieldUnit} onChange={(e) => setYieldUnit(e.target.value)} style={mInput}><option value="kg">kg</option><option value="un">un</option><option value="L">L</option></select>
          </MField></div>
        </div>
      ) : (
        <MField label="Preço de venda (R$)" hint="Usado no CMV teórico."><input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} placeholder="0,00" style={mInput} /></MField>
      )}
    </FullSheet>
  );
}

// ===== Sheet: adicionar insumo (estoque ou preparo) =====
function IngredientSheet({ stockItems, preparations, excludeId, onClose, onConfirm }) {
  const sources = [
    ...(stockItems || []).map((si) => ({ key: `stock:${si.id}`, kind: "stock", name: si.name, unit: si.unit, cost: si.cost, label: `${si.name} · ${_rcBRL(si.cost)}/${si.unit}` })),
    ...(preparations || []).filter((p) => !excludeId || p.id !== excludeId).map((p) => ({ key: `prep:${p.id}`, kind: "preparation", name: p.name, unit: p.yieldUnit, cost: p.unitCost || 0, label: `🔧 ${p.name} · ${_rcBRL(p.unitCost || 0)}/${p.yieldUnit}` })),
  ];
  const [sourceKey, setSourceKey] = useState("");
  const [qty, setQty] = useState("");
  const src = sources.find((s) => s.key === sourceKey);
  const unitCost = src ? src.cost : 0;
  const cost = _rcNum(qty) * unitCost;
  const valid = src && _rcNum(qty) > 0;

  const confirm = () => {
    if (!valid) return;
    const arr = [src.name, `${String(qty).replace(".", ",")} ${src.unit}`, Number(cost.toFixed(2))];
    if (sourceKey.startsWith("stock:")) arr.stockItemId = sourceKey.slice(6);
    else if (sourceKey.startsWith("prep:")) arr.sourcePrepId = sourceKey.slice(5);
    onConfirm(arr);
  };

  return (
    <BottomSheet
      title="Adicionar insumo"
      subtitle="Do estoque ou de um preparo"
      onClose={onClose}
      footer={<MPrimaryButton onClick={confirm} disabled={!valid}>Adicionar{valid ? ` · ${_rcBRL(cost)}` : ""}</MPrimaryButton>}
    >
      <MField label="Insumo / preparo">
        <select value={sourceKey} onChange={(e) => setSourceKey(e.target.value)} style={mInput}>
          <option value="">— Selecione —</option>
          {sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </MField>
      <MField label={`Quantidade${src ? ` (${src.unit})` : ""}`}>
        <input value={qty} inputMode="decimal" onChange={(e) => setQty(e.target.value)} placeholder="0" style={mInput} />
      </MField>
      {valid && (
        <div style={{ fontSize: 12.5, color: "var(--fg-2)", textAlign: "center" }}>
          {_rcNum(qty).toLocaleString("pt-BR")} {src.unit} × {_rcBRL(unitCost)} = <strong style={{ color: "var(--fg-0)" }}>{_rcBRL(cost)}</strong>
        </div>
      )}
    </BottomSheet>
  );
}

function _RcTile({ label, value, sub, color }) {
  return (
    <div style={{ padding: "12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", minWidth: 0 }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4, color: color || "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

window.MobileRecipes = MobileRecipes;
