// page-mobile-recipes.jsx — Fichas técnicas no celular (≤480px). Fichas (pratos) e
// preparos: consulta + CRIAR/EDITAR + composição (adicionar/remover insumos).
// Reaproveita as funções db* do desktop (page-recipes.jsx): custos são recalculados
// pelos triggers do banco. Insumo pode vir do estoque ou de um preparo.

// Abaixo de R$ 1,00 vira centavos — espelho de _brlText do desktop.
const _rcSubReal = (v) => { const n = Number(v) || 0; return n !== 0 && Math.abs(n) < 1; };
const _rcCents = (v) => {
  const c = (Number(v) || 0) * 100;
  return c.toFixed(2).replace(/\.00$/, "").replace(".", ",") + (c === 1 ? " centavo" : " centavos");
};
const _rcBRL = (v) => _rcSubReal(v) ? _rcCents(v)
  : "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const [filterCat, setFilterCat] = useState("all");
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
        const partial = isPrep
          ? { op: draft.op, cat: draft.cat, name: draft.name, yieldQty: draft.yieldQty, yieldUnit: draft.yieldUnit, instructions: draft.instructions }
          : { op: draft.op, cat: draft.cat, name: draft.name, price: draft.price, instructions: draft.instructions };
        const updFn = isPrep ? dbUpdatePreparation : dbUpdateTechSheet;
        const { error } = await updFn(editId, partial);
        if (error) { window.showToast?.(`Erro ao salvar: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; }
        await reloadCur(); window.showToast?.("Atualizado", { tone: "ok" }); return true;
      }
      if (isPrep) {
        const code = `PRP-${Date.now().toString(36).slice(-6).toUpperCase()}`;
        const { data, error } = await dbInsertPreparation(tenantId, { code, op: draft.op, cat: draft.cat, name: draft.name, yieldQty: draft.yieldQty, yieldUnit: draft.yieldUnit, instructions: draft.instructions });
        if (error) { window.showToast?.(`Erro ao criar: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; }
        await reloadPreps(); window.showToast?.(`Preparo ${code} criado`, { tone: "ok" }); setDetailId(data.id); return true;
      }
      const code = `FIC-${Date.now().toString(36).slice(-6).toUpperCase()}`;
      const { data, error } = await dbInsertTechSheet(tenantId, { code, op: draft.op, cat: draft.cat, name: draft.name, price: draft.price, yieldQty: 1, yieldUnit: "un", instructions: draft.instructions, items: [] });
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

  // Peso de 1 unidade do insumo (kg), informado quando a ficha quer medir em kg
  // um item cadastrado em "un". Grava no mesmo campo do Estoque (portion_qty).
  const saveItemWeight = async (stockItemId, portionKg) => {
    if (source === "db" && tenantId) {
      const { error } = await dbUpdateStockItem(stockItemId, { portionQty: portionKg, portionUnit: "kg" });
      if (error) { window.showToast?.(`Erro ao salvar o peso: ${error.message}`, { tone: "crit", ttl: 4500 }); return null; }
    }
    const next = (stockItems || []).map((si) =>
      si.id === stockItemId ? { ...si, portionQty: portionKg, portionUnit: "kg" } : si);
    setStockItems(next);
    window.__stockItemsCache = next;
    window.showToast?.("Peso por unidade salvo no insumo", { tone: "ok" });
    return next.find((si) => si.id === stockItemId) || null;
  };

  const base = isPrep ? preps : sheets;
  const q = _rcNorm(query.trim());
  const list = useMemo(() => base
    .filter((it) => scope === "all" || it.op === scope)
    .filter((it) => filterCat === "all" || it.cat === filterCat)
    .filter((it) => !q || _rcNorm(it.name).includes(q) || _rcNorm(it.code).includes(q))
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", "pt-BR")),
    [base, scope, q, filterCat]);

  // Só as categorias que têm item no modo atual E na operação do escopo — chip que
  // não filtra nada só ocupa a régua horizontal.
  const catChips = useMemo(() => {
    const inScope = base.filter((it) => scope === "all" || it.op === scope);
    return [
      { id: "all", label: "Todas", count: inScope.length },
      ...cats
        .map((c) => ({ id: c.id, label: c.label || c.name, count: inScope.filter((it) => it.cat === c.id).length }))
        .filter((c) => c.count > 0),
    ];
  }, [base, cats, scope]);

  // Trocar a operação pode tirar da régua o chip que estava ativo; sem isso a lista
  // fica vazia com nenhum chip marcado.
  useEffect(() => {
    if (filterCat !== "all" && !catChips.some((c) => c.id === filterCat)) setFilterCat("all");
  }, [catChips, filterCat]);
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

      {catChips.length > 1 && (
        <div style={{
          display: "flex", gap: 6, padding: "0 14px 10px",
          overflowX: "auto", WebkitOverflowScrolling: "touch", scrollbarWidth: "none",
        }}>
          {catChips.map((c) => {
            const active = filterCat === c.id;
            return (
              <button key={c.id} onClick={() => setFilterCat(c.id)} style={{
                flexShrink: 0, height: 34, padding: "0 12px", borderRadius: 999,
                background: active ? "var(--bg-3)" : "transparent",
                border: `1px solid ${active ? "var(--line-strong)" : "var(--line)"}`,
                color: active ? "var(--fg-0)" : "var(--fg-2)",
                fontSize: 12.5, fontWeight: active ? 600 : 400, whiteSpace: "nowrap",
                display: "inline-flex", alignItems: "center", gap: 5,
              }}>
                {c.label}
                <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: active ? "var(--fg-2)" : "var(--fg-3)" }}>{c.count}</span>
              </button>
            );
          })}
        </div>
      )}

      <MobileScroll style={{ padding: "0 14px 14px" }}>
        {list.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13 }}>
            Nenhum{isPrep ? " preparo" : "a ficha"} encontrad{isPrep ? "o" : "a"}.
            {(filterCat !== "all" || query) && (
              <button onClick={() => { setFilterCat("all"); setQuery(""); }}
                      style={{ display: "block", margin: "10px auto 0", background: "none", border: "none", color: "var(--accent-bright)", fontSize: 13 }}>
                Limpar filtros
              </button>
            )}
          </div>
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
          onSaveItemWeight={saveItemWeight}
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

function RecipeSheet({ item, isPrep, stockItems, preparations, onSaveItemWeight, onClose, onEdit, onAddIngredient, onRemoveIngredient }) {
  const op = MOCK.opById ? MOCK.opById(item.op) : null;
  const items = item.items || [];
  const theo = Number(item.theo) || 0, price = Number(item.price) || 0;
  const cmv = Number(item.cmv) || (price > 0 ? (theo / price) * 100 : 0);
  const margin = price - theo;
  const [adding, setAdding] = useState(false);
  const [printing, setPrinting] = useState(false);

  // Mesmo documento A4 do desktop — buildRecipePrintHtml vive em page-recipes.jsx e
  // é lido do window (arquivos legados não compartilham escopo de módulo).
  //
  // No celular ele vai para um iframe oculto, não para uma aba nova: a aba ficava
  // órfã atrás do app depois de imprimir e o bloqueador de pop-up matava a
  // impressão antes de começar. O documento traz o próprio ajuste de zoom e chama
  // window.print() sozinho — dentro do iframe isso imprime só a ficha, e o
  // diálogo do sistema é quem oferece "Salvar/Compartilhar PDF".
  const printSheet = () => {
    if (printing) return;
    const build = window.buildRecipePrintHtml;
    if (typeof build !== "function") {
      window.showToast?.("Impressão indisponível nesta tela", { tone: "warn" });
      return;
    }
    setPrinting(true);
    const tenantName = (typeof getSession === "function" && getSession()?.tenantName) || null;

    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    // Fora da tela, mas no tamanho de um A4: o script do documento mede
    // scrollHeight pra decidir o zoom, e num iframe 0×0 a medida não vale nada.
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;";

    let done = false, fallback = null;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearTimeout(fallback);
      window.removeEventListener("afterprint", cleanup);
      frame.remove();
      setPrinting(false);
    };

    frame.onload = () => {
      const w = frame.contentWindow;
      if (!w) { cleanup(); return; }
      // Safari só imprime o frame focado; sem isso pode sair o app inteiro.
      w.focus();
      // Onde o afterprint chega varia (frame no Chrome, topo no iOS): escuta os
      // dois, e o guard 'done' garante que só o primeiro limpa.
      w.addEventListener("afterprint", cleanup, { once: true });
      window.addEventListener("afterprint", cleanup, { once: true });
      // Rede: sem afterprint o iframe vazaria na página e o botão ficaria travado.
      fallback = setTimeout(cleanup, 60000);
    };

    // srcdoc antes de inserir: iframe vazio já dispara um load de about:blank, e
    // aí o handler rodaria duas vezes.
    frame.srcdoc = build({ item, isPrep, opName: op?.name || null, tenantName });
    document.body.appendChild(frame);
  };

  return (
    <BottomSheet
      title={item.name}
      subtitle={<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>{op && <span style={{ width: 6, height: 6, borderRadius: 50, background: op.color }} />}{op?.name || "—"}{isPrep ? " · preparo" : ""} · {item.code || item.id}</span>}
      onClose={onClose}
      footer={
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onEdit} style={{ height: 50, padding: "0 16px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}><I.Edit size={15} />Editar</button>
          <button onClick={printSheet} disabled={printing} aria-label="Imprimir ou salvar PDF" title="Imprimir ou salvar PDF"
                  style={{ height: 50, width: 50, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: printing ? "var(--fg-3)" : "var(--fg-1)", display: "grid", placeItems: "center" }}><I.Print size={16} /></button>
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

      <MSectionLabel>Modo de preparo</MSectionLabel>
      <div style={{ marginTop: 8, marginBottom: 4 }}>
        {item.instructions ? (
          // pre-wrap: as quebras de linha são a estrutura das etapas.
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.6, color: "var(--fg-1)" }}>{item.instructions}</div>
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--fg-3)" }}>Sem modo de preparo · toque em Editar para escrever.</div>
        )}
      </div>

      {adding && (
        <IngredientSheet
          stockItems={stockItems} preparations={preparations} excludeId={isPrep ? item.id : null}
          onSaveItemWeight={onSaveItemWeight}
          onClose={() => setAdding(false)}
          onConfirm={(ing) => { onAddIngredient(ing); setAdding(false); }}
        />
      )}
    </BottomSheet>
  );
}

// Espelho de _normUnit do desktop: 'und' gravado antigamente casa com 'un'.
const _rcNormUnit = (u) => (/^(und|unid|unidade)$/i.test(String(u || "")) ? "un" : String(u || ""));

// ===== Form: criar/editar ficha ou preparo =====
function RecipeForm({ isPrep, initial, cats, onClose, onSave }) {
  const ops = (MOCK.OPERATIONS || []).filter((o) => o.id !== "all");
  const [op, setOp] = useState(initial?.op || ops[0]?.id || "");
  const [cat, setCat] = useState(initial?.cat || "");
  const [name, setName] = useState(initial?.name || "");
  const [price, setPrice] = useState(initial?.price != null ? String(initial.price).replace(".", ",") : "");
  const [yieldQty, setYieldQty] = useState(initial?.yieldQty != null ? String(initial.yieldQty).replace(".", ",") : "");
  const [yieldUnit, setYieldUnit] = useState(_rcNormUnit(initial?.yieldUnit) || "kg");
  const [instructions, setInstructions] = useState(initial?.instructions || "");
  const [saving, setSaving] = useState(false);
  const valid = op && name.trim() && (isPrep ? _rcNum(yieldQty) > 0 : true);

  const submit = async () => {
    if (saving || !valid) return; setSaving(true);
    try {
      const draft = isPrep
        ? { op, cat, name: name.trim(), yieldQty: _rcNum(yieldQty), yieldUnit, instructions: instructions.trim() }
        : { op, cat, name: name.trim(), price: _rcNum(price), instructions: instructions.trim() };
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
      <MField label="Modo de preparo" hint="Etapas, tempos, pontos de atenção — sai na impressão da ficha.">
        <textarea value={instructions} rows={6} onChange={(e) => setInstructions(e.target.value)}
                  placeholder={isPrep ? "1. Hidratar o fermento\n2. Sovar por 10 min" : "1. Abrir a massa\n2. Forno 280°C por 6 min"}
                  style={{ ...mInput, height: "auto", minHeight: 120, resize: "vertical", lineHeight: 1.5, fontFamily: "inherit" }} />
      </MField>
    </FullSheet>
  );
}

// Unidades oferecidas na ficha (espelha _measureOptions do desktop).
const _rcMeasures = (item) => [...new Set([String(item?.unit || "").toLowerCase(), "kg", "g", "un"].filter(Boolean))];
const _rcIsMass = (u) => ["kg", "g"].includes(String(u || "").toLowerCase());
// Preparo tem rendimento (kg ou und), não peso por unidade — só converte kg ↔ g.
const _rcMassCostIn = (cost, from, to) => {
  const c = Number(cost) || 0;
  const f = String(from || "").toLowerCase(), t = String(to || "").toLowerCase();
  if (f === t) return c;
  if (!_rcIsMass(f) || !_rcIsMass(t)) return null;
  return t === "g" ? c / 1000 : c * 1000;
};

// ===== Sheet: adicionar insumo (estoque ou preparo) =====
function IngredientSheet({ stockItems, preparations, excludeId, onClose, onConfirm, onSaveItemWeight }) {
  const sources = [
    ...(stockItems || []).map((si) => ({ key: `stock:${si.id}`, kind: "stock", name: si.name, unit: si.unit, cost: si.cost, item: si })),
    ...(preparations || []).filter((p) => !excludeId || p.id !== excludeId).map((p) => ({ key: `prep:${p.id}`, kind: "preparation", name: p.name, unit: p.yieldUnit, cost: p.unitCost || 0 })),
  ];
  // O <select> nativo abre o picker do sistema, que não tem busca — com catálogo
  // grande vira rolagem interminável. MStockPicker é o padrão mobile: bottom sheet
  // com campo de busca, filtrando por nome ou categoria (acento/caixa ignorados).
  const pickerItems = sources.map((s) => ({
    id:   s.key,
    name: s.kind === "preparation" ? `🔧 ${s.name}` : s.name,
    cat:  s.kind === "preparation" ? "Preparo" : (s.item?.cat || "Sem categoria"),
    unit: `${_rcBRL(s.cost)}/${s.unit}`,
  }));
  const [sourceKey, setSourceKey] = useState("");
  const [qty, setQty] = useState("");
  // Unidade usada NESTA ficha — pode diferir da unidade do estoque (kg × un).
  const [unit, setUnit] = useState("");
  const [askWeightFor, setAskWeightFor] = useState(null);
  const [savingWeight, setSavingWeight] = useState(false);

  const src = sources.find((s) => s.key === sourceKey);
  const stockSrc = src?.kind === "stock" ? src.item : null;
  const lineUnit = unit || src?.unit || "";
  // Estoque converte pelo peso da unidade; preparo só entre kg e g.
  const srcCostIn = (u) => !src ? null
    : stockSrc ? stockItemCostIn(stockSrc, u) : _rcMassCostIn(src.cost, src.unit, u);
  const unitCost = srcCostIn(lineUnit) ?? 0;
  const cost = _rcNum(qty) * unitCost;
  const valid = !!src && _rcNum(qty) > 0 && unitCost > 0;

  // Vazio = origem sem conversão possível (preparo que rende em "und"): sem seletor.
  const measureUnits = !src ? []
    : stockSrc ? _rcMeasures(stockSrc)
    : (_rcIsMass(src.unit) ? [...new Set([String(src.unit).toLowerCase(), "kg", "g"])] : []);

  const pickSource = (key) => {
    setSourceKey(key);
    setUnit(sources.find((s) => s.key === key)?.unit || "");
  };

  // Converter de/para "un" exige saber quanto pesa 1 unidade do insumo; sem isso,
  // pede antes. Só insumo de estoque tem como destravar (preparo nem oferece).
  const changeMeasure = (u) => {
    if (u === lineUnit) return;
    if (!src) { setUnit(u); return; }
    if (srcCostIn(u) == null) { if (stockSrc) setAskWeightFor(u); return; }
    setUnit(u);
  };

  const saveItemWeight = async (grams) => {
    if (savingWeight || !stockSrc || !askWeightFor) return;
    setSavingWeight(true);
    try {
      const updated = typeof onSaveItemWeight === "function"
        ? await onSaveItemWeight(stockSrc.id, grams / 1000)
        : null;
      if (!updated) return;
      setUnit(askWeightFor);
      setAskWeightFor(null);
    } finally {
      setSavingWeight(false);
    }
  };

  const confirmedRef = useRef(false);
  const confirm = () => {
    if (!valid || confirmedRef.current) return;
    confirmedRef.current = true;
    const arr = [src.name, `${String(qty).replace(".", ",")} ${lineUnit}`, Number(cost.toFixed(2))];
    if (sourceKey.startsWith("stock:")) arr.stockItemId = sourceKey.slice(6);
    else if (sourceKey.startsWith("prep:")) arr.sourcePrepId = sourceKey.slice(5);
    arr.unitCost = unitCost;
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
        <MStockPicker
          items={pickerItems}
          value={sourceKey}
          onChange={pickSource}
          placeholder="Selecione um insumo ou preparo…"
          emptyLabel="Nenhum insumo ou preparo encontrado"
        />
      </MField>
      {measureUnits.length > 0 && (
        <MField label="Unidade na ficha"
                hint={stockSrc
                  ? "Medir em kg/g um insumo em un (ou o contrário) converte o custo pelo peso da unidade."
                  : "O custo do preparo é convertido junto (kg ↔ g)."}>
          <select value={lineUnit} onChange={(e) => changeMeasure(e.target.value)} style={mInput}>
            {measureUnits.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </MField>
      )}
      <MField label={`Quantidade${lineUnit ? ` (${lineUnit})` : ""}`}>
        <input value={qty} inputMode="decimal" onChange={(e) => setQty(e.target.value)} placeholder="0" style={mInput} />
      </MField>
      {valid && (
        <div style={{ fontSize: 12.5, color: "var(--fg-2)", textAlign: "center" }}>
          {_rcNum(qty).toLocaleString("pt-BR")} {lineUnit} × {_rcBRL(unitCost)} = <strong style={{ color: "var(--fg-0)" }}>{_rcBRL(cost)}</strong>
        </div>
      )}

      {askWeightFor && stockSrc && (
        <StockWeightSheet
          item={stockSrc} targetUnit={askWeightFor} saving={savingWeight}
          onClose={() => setAskWeightFor(null)}
          onSubmit={saveItemWeight}
        />
      )}
    </BottomSheet>
  );
}

// Pergunta quanto pesa 1 unidade do insumo — espelho mobile do StockWeightModal.
// Grava no cadastro do insumo (portion_qty), não na ficha.
function StockWeightSheet({ item, targetUnit, saving, onClose, onSubmit }) {
  const [grams, setGrams] = useState("");
  const g = _rcNum(grams);
  const valid = g > 0;
  const preview = valid ? stockItemCostIn({ ...item, portionQty: g / 1000, portionUnit: "kg" }, targetUnit) : null;

  const rows = [
    ["SKU", item.code || "—"],
    ["Categoria", item.cat || "—"],
    ["Unidade no estoque", item.unit],
    ["Custo unit.", `${_rcBRL(item.cost)}/${item.unit}`],
    ["Saldo atual", `${Number(item.qty || 0).toLocaleString("pt-BR", { maximumFractionDigits: 3 })} ${item.unit}`],
    ["Fornecedor", item.supplier || "—"],
  ];

  return (
    <BottomSheet
      title="Quanto pesa 1 unidade?"
      subtitle={`${item.name} · para medir em ${targetUnit} na ficha`}
      onClose={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={() => onSubmit(g)} disabled={!valid} loading={saving}>Salvar peso e usar</MPrimaryButton>}
    >
      <div style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
        {rows.map(([label, value], i) => (
          <div key={label} style={{
            display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 12px", fontSize: 12.5,
            borderTop: i === 0 ? "none" : "1px solid var(--line-soft)",
          }}>
            <span style={{ color: "var(--fg-3)" }}>{label}</span>
            <span style={{ fontFamily: "var(--mono)", color: "var(--fg-0)", textAlign: "right" }}>{value}</span>
          </div>
        ))}
      </div>

      <MField label="Peso por unidade (g)" hint="Salvo no cadastro do insumo — a Produção usa o mesmo peso.">
        <input value={grams} inputMode="decimal" autoFocus onChange={(e) => setGrams(e.target.value)} placeholder="ex.: 3000 para 3 kg" style={mInput} />
      </MField>

      {preview != null && (
        <div style={{ fontSize: 12.5, color: "var(--fg-2)", textAlign: "center", marginTop: 10 }}>
          1 un = {g.toLocaleString("pt-BR")} g → <strong style={{ color: "var(--fg-0)" }}>{_rcBRL(preview)}/{targetUnit}</strong> na ficha
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
