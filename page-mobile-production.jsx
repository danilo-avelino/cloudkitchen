// page-mobile-production.jsx — Produção no tablet (e no celular ≤480px).
// Desde 2026-08-12 tem PARIDADE COMPLETA com o desktop (page-production.jsx +
// page-transformed.jsx): a produção roda só no tablet, então nenhuma tarefa
// pode depender de "faça no desktop". Abas: Produzir hoje · Histórico ·
// Transformados · Receitas · Análises · Consumo.
//
// Fork só de layout/interação: as regras vêm das MESMAS funções que o desktop
// chama (planProduction/prodPlanRows em page-production.jsx; trAnalytics,
// trConsumptionRows, trNetworkRows… em page-transformed.jsx). Só funciona online.

const _mpFmt = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _mpNum = (raw) => { if (raw == null) return 0; const s = String(raw).trim().replace(/\./g, "").replace(",", "."); const n = parseFloat(s); return Number.isFinite(n) ? n : 0; };
const _mpQty = (v, d = 2) => (Number(v) || 0).toLocaleString("pt-BR", { maximumFractionDigits: d });
const _MP_STATUS = {
  draft: { label: "Rascunho", tone: "neutral" }, issued: { label: "Aguardando devolução", tone: "warn" },
  completed: { label: "Devolvida", tone: "ok" }, cancelled: { label: "Cancelada", tone: "crit" },
};
function _mpElapsed(fromIso) {
  if (!fromIso) return { label: "—", tone: "ok", ms: 0 };
  const ms = Date.now() - new Date(fromIso).getTime();
  const min = Math.max(0, Math.floor(ms / 60000)), h = Math.floor(min / 60), d = Math.floor(h / 24);
  const label = d >= 1 ? `${d}d ${h % 24}h` : h >= 1 ? `${h}h ${min % 60}min` : `${min}min`;
  return { label, tone: h >= 12 ? "crit" : h >= 4 ? "warn" : "ok", ms };
}
function _mpNextCode(orders) {
  let max = 0;
  for (const o of orders || []) { const m = /^PRD-(\d+)$/.exec(o.code || ""); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return `PRD-${String(max + 1).padStart(4, "0")}`;
}
function _mpPortion(item) {
  if (!item || item.portionQty == null) return null;
  const q = Number(item.portionQty), unit = item.portionUnit || "kg";
  return unit === "kg" && q < 1 ? `${(q * 1000).toLocaleString("pt-BR")} g` : `${q.toLocaleString("pt-BR")} ${unit}`;
}
// Cartão visualmente igual ao <MobileCard>, mas em <div>. Necessário nas listas
// cujo cartão CONTÉM botão: sem onClick o MobileCard vira <button disabled>, e
// botão desabilitado não entrega clique pra nada dentro dele.
function _mpCard(tone) {
  const border = tone === "crit" ? "var(--crit-line)" : tone === "warn" ? "var(--warn-line)" : "var(--line)";
  return {
    display: "block", width: "100%", textAlign: "left",
    padding: "12px 14px", borderRadius: 10,
    background: "var(--bg-2)", border: `1px solid ${border}`, color: "inherit",
  };
}
const _mpBtn = (variant) => ({
  flexShrink: 0, height: 44, padding: "0 14px", borderRadius: 10, fontSize: 13.5, fontWeight: variant === "primary" ? 700 : 600,
  background: variant === "primary" ? "var(--accent-bright)" : "transparent",
  color: variant === "primary" ? "var(--accent-fg)" : variant === "danger" ? "var(--crit)" : "var(--fg-2)",
  border: variant === "primary" ? "none" : `1px solid ${variant === "danger" ? "var(--crit-line)" : "var(--line)"}`,
});
const _mpAddBtn = { marginTop: 10, height: 44, width: "100%", borderRadius: 10, background: "transparent", border: "1px dashed var(--line)", color: "var(--fg-2)", fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 };
const _mpDelBtn = { width: 40, height: 40, borderRadius: 8, flexShrink: 0, background: "transparent", border: "1px solid var(--line)", color: "var(--fg-3)", display: "grid", placeItems: "center" };
const _mpFormCard = { padding: "10px 12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" };

// Abas do módulo — espelham as do desktop (_PROD_VIEWS em page-production.jsx).
const _MP_VIEWS = [
  { id: "today",       label: "Produzir hoje" },
  { id: "orders",      label: "Histórico" },
  { id: "catalog",     label: "Transformados" },
  { id: "recipes",     label: "Receitas" },
  { id: "insights",    label: "Análises" },
  { id: "consumption", label: "Consumo" },
];

const _MP_CONFIRM = {
  cancel: { title: "Cancelar ordem?", msg: "Os insumos baixados voltam ao estoque com movimentos inversos.", label: "Cancelar ordem" },
  delete: { title: "Excluir rascunho?", msg: "Essa ação não pode ser desfeita.", label: "Excluir" },
  item:   { title: "Desativar transformado?", msg: "O item some das listas, mas o histórico de movimentações é preservado.", label: "Desativar" },
  recipe: { title: "Excluir receita?", msg: "Essa ação não pode ser desfeita.", label: "Excluir" },
};

// Chips de filtro DENTRO do conteúdo (status do histórico, período das análises).
// Menores que o SegTabs do topo, que marca em qual aba do módulo se está.
function MpChips({ value, onChange, options }) {
  return (
    <div style={{ display: "flex", gap: 6, overflowX: "auto", WebkitOverflowScrolling: "touch", scrollbarWidth: "none", paddingBottom: 2 }}>
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button key={o.id} onClick={() => onChange(o.id)} style={{
            flexShrink: 0, height: 34, padding: "0 12px", borderRadius: 999,
            background: active ? "var(--bg-3)" : "transparent",
            border: `1px solid ${active ? "var(--line-strong)" : "var(--line)"}`,
            color: active ? "var(--fg-0)" : "var(--fg-2)",
            fontSize: 12.5, fontWeight: active ? 600 : 400, whiteSpace: "nowrap",
            display: "inline-flex", alignItems: "center", gap: 5,
          }}>
            {o.label}
            {o.count > 0 && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: active ? "var(--fg-2)" : "var(--fg-3)" }}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Filtro de período das abas Análises e Consumo (mesmas janelas do desktop).
function MpPeriodFilter({ period, onPeriod, from, onFrom, to, onTo }) {
  const options = window.TR_ANALYTICS_PERIODS || [];
  return (
    <div style={{ marginBottom: 12 }}>
      <MpChips value={period} onChange={onPeriod} options={options} />
      {period === "custom" && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input type="date" value={from} max={to || undefined} onChange={(e) => onFrom(e.target.value)} style={mInput} />
          <input type="date" value={to} min={from || undefined} onChange={(e) => onTo(e.target.value)} style={mInput} />
        </div>
      )}
    </div>
  );
}

// Aviso em faixa (mesmos textos do desktop, no idioma do toque)
function MpNotice({ tone = "warn", children }) {
  const c = tone === "crit"
    ? { bg: "var(--crit-soft)", line: "var(--crit-line)", fg: "var(--crit)" }
    : { bg: "var(--warn-soft)", line: "var(--warn-line)", fg: "var(--warn)" };
  return (
    <div style={{ display: "flex", gap: 8, padding: "10px 12px", borderRadius: 10, background: c.bg, border: `1px solid ${c.line}` }}>
      <I.AlertTriangle size={14} style={{ color: c.fg, flexShrink: 0, marginTop: 1 }} />
      <div style={{ fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}

function MobileProduction() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid] = useState(null);
  const [kind, setKind] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("today");
  const [statusFilter, setStatusFilter] = useState("all");
  const [orders, setOrders] = useState([]);
  const [stockItems, setStockItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [transfers, setTransfers] = useState([]);   // só central (tabela da rede em Consumo)
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(null);           // solicitação de insumos
  const [returnFor, setReturnFor] = useState(null);
  const [itemForm, setItemForm] = useState(null);   // 'new' | transformado
  const [recipeForm, setRecipeForm] = useState(null); // 'new' | receita
  const [confirm, setConfirm] = useState(null);     // { kind, target }
  const [busy, setBusy] = useState(false);

  const reload = async (t, k) => {
    const tenant = t || tid;
    if (!tenant) return;
    const isCentral = (k || kind) === "distribution_center";
    const [oRes, sRes, cRes, rRes, tRes] = await Promise.all([
      dbListProductionOrders(tenant), dbListStockItems(tenant), dbListStockCategories(tenant),
      dbListProductionRecipes(tenant),
      isCentral && typeof dbSupplyListTransfers === "function"
        ? dbSupplyListTransfers(tenant)
        : Promise.resolve({ data: [] }),
    ]);
    // Peso atual do estoque manda no aproveitamento (espelha o desktop)
    const items = sRes?.data || [];
    setOrders((oRes?.data || []).map((o) => prodOrderWithLiveWeights(o, items)));
    // Sem isso a falha some: a lista fica vazia e parece "não tem nada em
    // andamento", quando na verdade a query quebrou.
    if (!oRes?.data && oRes?.error) {
      console.error("[produção] ordens não carregaram:", oRes.error);
      window.showToast?.(`Ordens de produção não carregaram: ${oRes.error.message || oRes.error}`, { tone: "crit", ttl: 8000 });
    }
    setStockItems(items);
    setCategories(cRes?.data || []);
    setRecipes(rRes?.data || []);
    setTransfers(tRes?.data || []);
  };

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const t = ctx?.tenant?.id || null;
      const k = ctx?.tenant?.kind || "standard";
      setTid(t); setKind(k);
      if (t) await reload(t, k);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  const byId = useMemo(() => {
    const m = {}; (stockItems || []).forEach((i) => { m[i.id] = i; }); return m;
  }, [stockItems]);
  const transformados = useMemo(
    () => (stockItems || []).filter((i) => i.itemKind === "transformed"), [stockItems]);

  // Política mín/máx: saldo ≤ mínimo entra na lista e a reposição vai até o
  // máximo em lotes inteiros da receita. prodPlanRows vem do desktop
  // (page-production.jsx, carregado antes deste arquivo) pra as duas telas não
  // divergirem na regra de arredondamento dos lotes.
  const plans = useMemo(() => {
    const fn = window.prodPlanRows;
    return typeof fn === "function" ? fn(stockItems, recipes) : { rows: [], toProduce: [], ok: [], noPar: [] };
  }, [stockItems, recipes]);

  // Ordens abertas: 'issued' devendo devolução vem primeiro (é a que trava
  // dinheiro); 'draft' ainda está na fila de separação em Requisições.
  const openOrders = useMemo(() => {
    const open = (orders || []).filter((o) => o.status === "draft" || o.status === "issued");
    return [...open.filter((o) => o.status === "issued"), ...open.filter((o) => o.status === "draft")];
  }, [orders]);
  // Transformado com lote a caminho — o botão de solicitar fica discreto pra não
  // provocar pedido duplicado.
  const inFlight = useMemo(() => {
    const s = new Set();
    openOrders.forEach((o) => (o.outputs || []).forEach((l) => l.itemId && s.add(l.itemId)));
    return s;
  }, [openOrders]);
  const counts = useMemo(() => ({
    all: orders.length,
    draft: orders.filter((o) => o.status === "draft").length,
    issued: orders.filter((o) => o.status === "issued").length,
    completed: orders.filter((o) => o.status === "completed").length,
    cancelled: orders.filter((o) => o.status === "cancelled").length,
  }), [orders]);

  const kpis = useMemo(() => {
    const waiting = orders.filter((o) => o.status === "issued");
    const waitingValue = waiting.reduce((s, o) => s + (o.totalInputCost || 0), 0);
    const oldest = waiting.length
      ? waiting.reduce((a, b) => _mpElapsed(a.issuedAt).ms >= _mpElapsed(b.issuedAt).ms ? a : b) : null;
    const cutoff30 = Date.now() - 30 * 86400000;
    const done30 = orders.filter((o) => o.status === "completed" && o.completedAt && new Date(o.completedAt).getTime() >= cutoff30);
    const yields = done30.filter((o) => o.yieldPct != null);
    const avgYield = yields.length ? yields.reduce((s, o) => s + o.yieldPct, 0) / yields.length : null;
    return { waiting: waiting.length, waitingValue, oldest, done30: done30.length, avgYield };
  }, [orders]);

  const doConfirm = async () => {
    if (busy || !confirm) return;
    setBusy(true);
    try {
      const { kind: k, target } = confirm;
      if (k === "cancel") {
        const { error } = await dbCancelProductionOrder(target.id); if (error) throw error;
        window.showToast?.("Ordem cancelada — insumos devolvidos ao estoque", { tone: "ok" });
      } else if (k === "delete") {
        const { error } = await dbDeleteProductionOrder(target.id); if (error) throw error;
        window.showToast?.("Rascunho excluído", { tone: "ok" });
      } else if (k === "item") {
        const { error } = await dbDeleteStockItem(target.id); if (error) throw error;
        window.showToast?.("Transformado desativado", { tone: "ok" });
        setItemForm(null);
      } else {
        const { error } = await dbDeleteProductionRecipe(target.id); if (error) throw error;
        window.showToast?.("Receita excluída", { tone: "ok" });
        setRecipeForm(null);
      }
      setConfirm(null); setDetail(null); await reload();
    } catch (e) { window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 }); }
    setBusy(false);
  };

  if (loading) return <PageLoading label="Carregando produção…" variant="table" />;
  if (!dbStatus.isOnline || !tid) {
    return <MobilePage><div style={{ padding: 24 }}><div style={{ fontSize: 12.5, color: "var(--warn)", padding: "12px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 8 }}>Produção só fica disponível com Supabase online.</div></div></MobilePage>;
  }

  const showStats = view === "today" || view === "orders";
  const cta =
    view === "catalog" ? { label: "Novo transformado", onClick: () => setItemForm("new") } :
    view === "recipes" ? { label: "Nova receita", onClick: () => setRecipeForm("new") } :
    showStats ? { label: "Solicitar insumos", onClick: () => setForm({}) } : null;

  return (
    <MobilePage>
      <SegTabs value={view} onChange={setView} options={_MP_VIEWS.map((v) => ({
        ...v,
        count: v.id === "today" ? (plans.toProduce.length || null)
             : v.id === "orders" ? (counts.all || null)
             : v.id === "catalog" ? (transformados.length || null)
             : v.id === "recipes" ? (recipes.length || null) : null,
        tone: v.id === "today" && plans.toProduce.length ? "warn" : undefined,
      }))} />

      {showStats && (
        <StatStrip stats={[
          { label: "Pendentes", value: kpis.waiting, tone: kpis.waiting > 0 ? "crit" : "ok", sub: "não concluídas",
            onClick: kpis.waiting > 0 ? () => { setView("orders"); setStatusFilter("issued"); } : undefined },
          { label: "Travado", value: _mpFmt(kpis.waitingValue).replace(",00", ""), sub: "insumo sem entrada" },
          { label: "Produções 30d", value: kpis.done30 },
          { label: "Aproveit. 30d", value: kpis.avgYield != null ? `${kpis.avgYield.toFixed(0)}%` : "—", tone: kpis.avgYield != null && kpis.avgYield < 90 ? "warn" : "ok" },
        ]} />
      )}

      <MobileScroll style={{ padding: showStats ? "0 14px 16px" : "12px 14px 16px" }}>
        {view === "today" && (
          <MProdToday
            plans={plans} openOrders={openOrders} inFlight={inFlight} byId={byId}
            onProduce={(rid, batches) => setForm({ recipeId: rid || "", batches })}
            onReturn={(o) => setReturnFor(o)}
            onOpenOrder={(o) => setDetail(o)} />
        )}

        {view === "orders" && (
          <MProdHistory
            orders={orders} counts={counts} statusFilter={statusFilter} onFilter={setStatusFilter}
            oldest={kpis.oldest} waiting={kpis.waiting} waitingValue={kpis.waitingValue}
            onOpen={(o) => setDetail(o)} onReturn={(o) => setReturnFor(o)} />
        )}

        {view === "catalog" && (
          <MProdCatalog items={transformados} orders={orders} onEdit={(it) => setItemForm(it)} />
        )}

        {view === "recipes" && (
          <MProdRecipes recipes={recipes} byId={byId} onEdit={(r) => setRecipeForm(r)} />
        )}

        {view === "insights" && <MProdInsights orders={orders} stockItems={stockItems} />}

        {view === "consumption" && (
          <MProdConsumption tid={tid} isCentral={kind === "distribution_center"}
            transfers={transfers} stockItems={stockItems} />
        )}
      </MobileScroll>

      {cta && (
        <MobileBottomBar>
          <MPrimaryButton onClick={cta.onClick}><I.Plus size={16} />{cta.label}</MPrimaryButton>
        </MobileBottomBar>
      )}

      {detail && (
        <ProdOrderSheet
          order={orders.find((o) => o.id === detail.id) || detail}
          busy={busy}
          onClose={() => setDetail(null)}
          onReturn={() => { setReturnFor(orders.find((o) => o.id === detail.id) || detail); setDetail(null); }}
          onCancelOrder={() => setConfirm({ kind: "cancel", target: detail })}
          onDelete={() => setConfirm({ kind: "delete", target: detail })}
        />
      )}

      {form && (
        <ProdBatchForm
          tid={tid} stockItems={stockItems} recipes={recipes}
          nextCode={_mpNextCode(orders)} initialRecipeId={form.recipeId || ""}
          initialBatches={form.batches}
          onClose={() => setForm(null)}
          onSaved={async () => { setForm(null); setDetail(null); await reload(); }}
        />
      )}

      {returnFor && (
        <ProdReturnForm
          order={returnFor} stockItems={stockItems}
          onClose={() => setReturnFor(null)}
          onSaved={async () => { setReturnFor(null); setDetail(null); await reload(); }}
        />
      )}

      {itemForm && (
        <MTransformedForm
          tid={tid} categories={categories}
          initial={itemForm === "new" ? null : itemForm}
          onClose={() => setItemForm(null)}
          onDelete={(it) => setConfirm({ kind: "item", target: it })}
          onSaved={async () => { setItemForm(null); await reload(); }}
        />
      )}

      {recipeForm && (
        <MRecipeForm
          tid={tid} stockItems={stockItems}
          initial={recipeForm === "new" ? null : recipeForm}
          onClose={() => setRecipeForm(null)}
          onDelete={(r) => setConfirm({ kind: "recipe", target: r })}
          onSaved={async () => { setRecipeForm(null); await reload(); }}
        />
      )}

      {/* Por último de propósito: BottomSheet e FullSheet dividem o mesmo
          z-index, então quem vem depois no DOM fica por cima do formulário. */}
      {confirm && (
        <BottomSheet
          title={_MP_CONFIRM[confirm.kind].title}
          subtitle={confirm.target.code || confirm.target.name || null}
          onClose={() => !busy && setConfirm(null)}
          footer={
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setConfirm(null)} disabled={busy} style={{ flex: 1, height: 50, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14, fontWeight: 600 }}>Voltar</button>
              <button onClick={doConfirm} disabled={busy} style={{ flex: 1, height: 50, borderRadius: 10, background: "var(--crit)", border: "none", color: "#fff", fontSize: 14, fontWeight: 600 }}>
                {busy ? "Carregando…" : _MP_CONFIRM[confirm.kind].label}
              </button>
            </div>
          }
        >
          <div style={{ fontSize: 13, color: "var(--fg-2)" }}>{_MP_CONFIRM[confirm.kind].msg}</div>
        </BottomSheet>
      )}
    </MobilePage>
  );
}

// ===== Aba: Produzir hoje =====
function MProdToday({ plans, openOrders, inFlight, byId, onProduce, onReturn, onOpenOrder }) {
  const [showOthers, setShowOthers] = useState(false);
  const others = [...plans.ok, ...plans.noPar];

  if (plans.rows.length === 0 && openOrders.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13, lineHeight: 1.6 }}>
        Nenhum transformado cadastrado.<br />
        <span style={{ fontSize: 11.5 }}>
          Cadastre o que a produção devolve porcionado na aba <strong>Transformados</strong> e defina
          mínimo e máximo de cada um em <strong>Estoque</strong> — são eles que alimentam esta lista.
        </span>
      </div>
    );
  }

  return (
    <>
      {/* Trabalho em aberto: lote entregue devendo devolução, ou solicitação
          ainda na fila de Requisições. */}
      {openOrders.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
          <MSectionLabel>Em andamento</MSectionLabel>
          {openOrders.map((o) => {
            const waiting = o.status === "issued";
            const e = waiting ? _mpElapsed(o.issuedAt) : null;
            return (
              <div key={o.id} style={_mpCard(waiting && e.tone === "crit" ? "crit" : waiting && e.tone === "warn" ? "warn" : undefined)}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-0)", fontWeight: 600 }}>{o.code}</div>
                    <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 2 }}>
                      {waiting
                        ? `aguardando devolução · há ${e.label} · ${_mpFmt(o.totalInputCost)}`
                        : o.separatedAt ? "separada · aguarda entrega em Requisições"
                        : "aguardando separação em Requisições"}
                    </div>
                  </div>
                  {waiting
                    ? <button onClick={() => onReturn(o)} style={_mpBtn("primary")}>Devolução</button>
                    : <button onClick={() => onOpenOrder(o)} style={_mpBtn()}>Ver</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <MSectionLabel>Produzir hoje</MSectionLabel>
        <span style={{ fontSize: 11, color: "var(--fg-3)" }}>saldo ≤ mínimo · repõe até o máximo</span>
      </div>

      {plans.toProduce.length === 0 ? (
        <div style={{ textAlign: "center", padding: "28px 12px", color: "var(--fg-3)", fontSize: 13 }}>
          Nenhum transformado no estoque mínimo. Nada a produzir.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {plans.toProduce.map(({ item, recipe, plan }) => (
            <MProduceCard key={item.id} item={item} recipe={recipe} plan={plan} byId={byId}
              inFlight={inFlight.has(item.id)} onProduce={onProduce} />
          ))}
        </div>
      )}

      {others.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <button onClick={() => setShowOthers((v) => !v)} style={{
            width: "100%", height: 44, borderRadius: 10, background: "transparent",
            border: "1px solid var(--line)", color: "var(--fg-2)", fontSize: 13,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          }}>
            <I.Chevron size={12} style={{ transform: showOthers ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 120ms" }} />
            Demais transformados ({plans.ok.length} acima do mínimo · {plans.noPar.length} sem mín/máx)
          </button>
          {showOthers && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
              {others.map(({ item, plan }) => <MProdLevelCard key={item.id} item={item} plan={plan} />)}
            </div>
          )}
        </div>
      )}
    </>
  );
}

// Linha do "Produzir hoje". Abre os insumos que o plano consome (receita × nº de
// lotes) pra dar de ver, antes de solicitar, se o estoque cobre o lote.
function MProduceCard({ item, recipe, plan, byId, inFlight, onProduce }) {
  const [open, setOpen] = useState(false);
  const pct = plan.target > 0 ? (item.qty || 0) / plan.target : 0;
  const over = plan.produce - plan.rawNeed;   // sobra acima do máximo (≤ 50% do lote)
  const inputs = plan.inputs.map((l) => {
    const ing = byId[l.itemId];
    return { ...l, ing, short: ing ? l.qty > (ing.qty || 0) : false };
  });
  const missing = inputs.filter((l) => l.short);

  return (
    <div style={_mpCard(pct <= 0.25 ? "crit" : pct <= 0.6 ? "warn" : undefined)}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, color: "var(--fg-0)", fontWeight: 500 }}>{item.name}</div>
          <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 2 }}>
            saldo {(item.qty || 0).toLocaleString("pt-BR")} {item.unit} · mín {plan.min.toLocaleString("pt-BR")}
            {plan.max != null ? ` · máx ${plan.max.toLocaleString("pt-BR")}` : ""}
            {recipe ? "" : " · sem receita"}
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 15, color: "var(--fg-0)", fontWeight: 700, marginTop: 4 }}>
            produzir {_mpQty(plan.produce)} {item.unit}
          </div>
          {plan.batches != null && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", marginTop: 2 }}>
              {plan.batches} {plan.batches === 1 ? "lote" : "lotes"} de {_mpQty(plan.lote)}
              {over > 0 && (
                // O arredondamento mantém a sobra em ≤ 50% do lote, exceto quando
                // um único lote já estoura o máximo sozinho — aí avisa.
                <span style={{ color: over > plan.lote / 2 ? "var(--warn)" : "var(--fg-3)" }}>
                  {" "}· +{_mpQty(over)} do máx
                </span>
              )}
            </div>
          )}
          {missing.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--crit)", marginTop: 4 }}>
              {missing.length} {missing.length === 1 ? "insumo insuficiente" : "insumos insuficientes"}
            </div>
          )}
        </div>
        <button onClick={() => onProduce(recipe?.id || "", plan.batches)} style={_mpBtn(inFlight ? "ghost" : "primary")}>
          Solicitar
        </button>
      </div>

      {inFlight && (
        <div style={{ fontSize: 11, color: "var(--info, var(--accent-bright))", marginTop: 6 }}>lote já em andamento</div>
      )}

      {inputs.length > 0 && (
        <>
          <button onClick={() => setOpen((v) => !v)} style={{
            marginTop: 8, height: 34, padding: "0 10px", borderRadius: 8, background: "transparent",
            border: "1px solid var(--line)", color: "var(--fg-2)", fontSize: 12,
            display: "inline-flex", alignItems: "center", gap: 6,
          }}>
            <I.Chevron size={11} style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 120ms" }} />
            Insumos do plano{recipe ? ` · ${recipe.name}` : ""}
          </button>
          {open && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              {inputs.map((l) => (
                <div key={l.itemId} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12 }}>
                  <span style={{ color: "var(--fg-2)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {l.ing ? l.ing.name : l.itemId}
                  </span>
                  <span style={{ fontFamily: "var(--mono)", color: l.short ? "var(--crit)" : "var(--fg-1)", flexShrink: 0 }}>
                    {_mpQty(l.qty)} {l.unit || l.ing?.unit || ""}
                    <span style={{ color: "var(--fg-3)" }}> · saldo {l.ing ? _mpQty(l.ing.qty || 0) : "—"}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Transformado fora da lista de produção: acima do mínimo, ou sem parâmetro.
function MProdLevelCard({ item, plan }) {
  const TransformedLevelBar = window.TransformedLevelBar;  // lazy · page-production.jsx
  return (
    <div style={_mpCard()}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-2)", flexShrink: 0 }}>
          {(item.qty || 0).toLocaleString("pt-BR")} {item.unit}
        </span>
      </div>
      {plan.target == null ? (
        <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 6 }}>defina mínimo e máximo em Estoque</div>
      ) : (
        <>
          {TransformedLevelBar && (
            <div style={{ marginTop: 10 }}>
              <TransformedLevelBar qty={item.qty} min={plan.min} max={plan.max} />
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 6 }}>
            acima do mínimo · mín {plan.min.toLocaleString("pt-BR")}
            {plan.max != null ? ` · máx ${plan.max.toLocaleString("pt-BR")}` : ""}
          </div>
        </>
      )}
    </div>
  );
}

// ===== Aba: Histórico =====
function MProdHistory({ orders, counts, statusFilter, onFilter, oldest, waiting, waitingValue, onOpen, onReturn }) {
  const filtered = statusFilter === "all" ? orders : orders.filter((o) => o.status === statusFilter);
  const chips = [
    { id: "all", label: "Todas", count: counts.all },
    { id: "draft", label: "Rascunhos", count: counts.draft },
    { id: "issued", label: "Em produção", count: counts.issued },
    { id: "completed", label: "Concluídas", count: counts.completed },
    { id: "cancelled", label: "Canceladas", count: counts.cancelled },
  ];
  const e = oldest ? _mpElapsed(oldest.issuedAt) : null;

  return (
    <>
      <div style={{ paddingBottom: 12 }}>
        <MpChips value={statusFilter} onChange={onFilter} options={chips} />
      </div>

      {/* Insumo baixado sem o produzido ter dado entrada: enquanto isso o estoque
          fica subavaliado — é a etapa crítica de desvio. */}
      {waiting > 0 && (
        <div style={{ marginBottom: 12, padding: "10px 12px", borderRadius: 10,
                      background: e.tone === "crit" ? "var(--crit-soft)" : "var(--warn-soft)",
                      border: `1px solid ${e.tone === "crit" ? "var(--crit-line)" : "var(--warn-line)"}` }}>
          <div style={{ fontSize: 12.5, color: "var(--fg-0)", lineHeight: 1.5 }}>
            <strong>{waiting} {waiting === 1 ? "produção não concluída" : "produções não concluídas"}</strong>
            {" · "}{_mpFmt(waitingValue)} em insumo já baixado sem o produzido ter dado entrada.
          </div>
          <button onClick={() => onReturn(oldest)} style={{ ..._mpBtn("primary"), marginTop: 10, width: "100%" }}>
            Concluir {oldest.code}
          </button>
        </div>
      )}

      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13 }}>
          Nenhuma produção {statusFilter !== "all" ? "neste filtro" : "registrada ainda"}.<br />
          <span style={{ fontSize: 11.5 }}>Solicite os insumos aqui; a entrega acontece em Requisições e a devolução volta pra esta tela.</span>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((o) => <ProdOrderCard key={o.id} order={o} onTap={() => onOpen(o)} />)}
        </div>
      )}
    </>
  );
}

function ProdOrderCard({ order, onTap }) {
  const m = _MP_STATUS[order.status] || _MP_STATUS.draft;
  const el = order.status === "issued" ? _mpElapsed(order.issuedAt) : null;
  return (
    <MobileCard onClick={onTap}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-0)", fontWeight: 600 }}>{order.code}</span>
            {el && <MBadge tone={el.tone === "crit" ? "crit" : el.tone === "warn" ? "warn" : "neutral"}>há {el.label}</MBadge>}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {order.inputs.map((l) => l.name).join(", ") || "—"}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
          <MBadge tone={m.tone}>{m.label}</MBadge>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-0)", fontWeight: 600 }}>{_mpFmt(order.totalInputCost != null ? order.totalInputCost : order.estCost)}</span>
        </div>
      </div>
    </MobileCard>
  );
}

function ProdOrderSheet({ order, busy, onClose, onReturn, onCancelOrder, onDelete }) {
  const m = _MP_STATUS[order.status] || _MP_STATUS.draft;
  const Row = ({ l, draft }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.name}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-2)" }}>{l.qty.toLocaleString("pt-BR")} {l.unit}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-0)", fontWeight: 600, width: 84, textAlign: "right" }}>{draft ? "—" : _mpFmt(l.lineCost)}</span>
    </div>
  );
  const footer = (
    order.status === "draft" ? (
      // A entrega (que baixa os insumos) fica no módulo Requisições — aqui só dá
      // pra desistir da solicitação.
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={onDelete} disabled={busy} style={{ height: 50, padding: "0 14px", borderRadius: 10, background: "transparent", border: "1px solid var(--crit-line)", color: "var(--crit)", fontSize: 14, fontWeight: 600 }}>Excluir</button>
        <div style={{ flex: 1, fontSize: 12, color: "var(--fg-3)", lineHeight: 1.4 }}>
          Separação e entrega no módulo <strong style={{ color: "var(--fg-2)" }}>Requisições</strong>.
        </div>
      </div>
    ) : order.status === "issued" ? (
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onCancelOrder} disabled={busy} style={{ height: 50, padding: "0 14px", borderRadius: 10, background: "transparent", border: "1px solid var(--crit-line)", color: "var(--crit)", fontSize: 14, fontWeight: 600 }}>Cancelar</button>
        <div style={{ flex: 1 }}><MPrimaryButton onClick={onReturn} loading={busy}><I.Box size={15} />Lançar devolução</MPrimaryButton></div>
      </div>
    ) : null
  );
  return (
    <BottomSheet title={`Ordem ${order.code}`} subtitle={order.notes || null} onClose={onClose} footer={footer}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <MBadge tone={m.tone}>{m.label}</MBadge>
        {order.status === "issued" && (() => { const e = _mpElapsed(order.issuedAt); return <MBadge tone={e.tone === "crit" ? "crit" : e.tone === "warn" ? "warn" : "neutral"}>há {e.label}</MBadge>; })()}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginBottom: 12, lineHeight: 1.5 }}>
        criada em {order.createdAt ? new Date(order.createdAt).toLocaleDateString("pt-BR") : "—"}
        {order.issuedAt ? ` · saída ${new Date(order.issuedAt).toLocaleString("pt-BR")}` : ""}
        {order.completedAt ? ` · devolvida ${new Date(order.completedAt).toLocaleString("pt-BR")}` : ""}
      </div>
      <MSectionLabel>Insumos</MSectionLabel>
      <div style={{ marginTop: 6 }}>
        {order.inputs.map((l) => <Row key={l.id} l={l} draft={order.status === "draft"} />)}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0 2px", fontSize: 13 }}>
          <span style={{ color: "var(--fg-2)", fontWeight: 600 }}>Custo total dos insumos</span>
          <span style={{ fontFamily: "var(--mono)", color: "var(--fg-0)", fontWeight: 700 }}>{_mpFmt(order.totalInputCost != null ? order.totalInputCost : order.estCost)}</span>
        </div>
      </div>

      {order.status === "issued" && order.outputs.length === 0 && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--fg-2)", padding: "10px 12px", background: "var(--bg-2)", border: "1px dashed var(--line)", borderRadius: 8 }}>
          Aguardando a produção devolver — use <strong>Lançar devolução</strong> quando os itens voltarem.
        </div>
      )}
      {order.outputs.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <MSectionLabel>Transformados devolvidos</MSectionLabel>
          <div style={{ marginTop: 6 }}>
            {order.outputs.map((l) => (
              <div key={l.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.name}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-2)" }}>{l.returnedQty != null ? l.returnedQty.toLocaleString("pt-BR") : "—"} porç.</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-0)", fontWeight: 600, width: 84, textAlign: "right" }}>{l.costShare != null ? _mpFmt(l.costShare) : "—"}</span>
                </div>
                {l.unitCost != null && (
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", marginTop: 2 }}>
                    {_mpFmt(l.unitCost)}/porção
                    {l.expectedQty > 0 ? ` · esperado ${l.expectedQty.toLocaleString("pt-BR")}` : ""}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {order.status === "completed" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 14 }}>
          <CmvMiniStat label="Aproveit." value={order.yieldPct != null ? `${order.yieldPct.toLocaleString("pt-BR")}%` : "—"} />
          <CmvMiniStat label="Desperdício" value={order.wasteQty != null ? `${_mpQty(order.wasteQty)}kg` : "—"} />
          <CmvMiniStat label="Devolvido" value={order.outputWeight != null ? `${_mpQty(order.outputWeight)}kg` : "—"} />
        </div>
      )}
    </BottomSheet>
  );
}

function CmvMiniStat({ label, value, tone, sub }) {
  const color = tone === "warn" ? "var(--warn)" : tone === "crit" ? "var(--crit)" : "var(--fg-0)";
  return (
    <div style={{ padding: "10px 8px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", textAlign: "center" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-3)", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, marginTop: 3, color }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--fg-3)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ===== Form: solicitar insumos (primeira fase) =====
// Espelha o ProductionRequestModal do desktop: só cria a ordem em 'draft'. Nada
// sai do estoque aqui — a baixa é na entrega, feita no módulo Requisições.
function ProdBatchForm({ tid, stockItems, recipes, nextCode, initialRecipeId, initialBatches, onClose, onSaved }) {
  const rawItems = (stockItems || []).filter((i) => i.itemKind !== "transformed");
  const byId = {}; (stockItems || []).forEach((i) => { byId[i.id] = i; });

  // Vindo de "Produzir hoje", a receita e o nº de lotes que repõe até o máximo já
  // chegam calculados — as linhas nascem escaladas por esse nº.
  const seed = (recipes || []).find((r) => r.id === initialRecipeId) || null;
  const seedN = initialBatches > 0 ? initialBatches : 1;
  const seedLines = (arr, key) => (arr || []).map((l) => ({
    itemId: l.itemId, qty: l[key] != null ? String(Number((l[key] * seedN).toFixed(4))).replace(".", ",") : "",
  }));
  const [recipeId, setRecipeId] = useState(seed ? seed.id : "");
  const [batches, setBatches] = useState(seed ? String(seedN) : "1");
  const [inputs, setInputs] = useState(seed ? seedLines(seed.inputs, "qty") : [{ itemId: "", qty: "" }]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState("");

  const recipe = (recipes || []).find((r) => r.id === recipeId) || null;
  const batchN = _mpNum(batches) || 0;
  // Insumo vindo de receita é receita × lotes: linha travada (igual ao desktop).
  const fromRecipe = !!recipe;

  // Rendimento esperado = receita × lotes. Não é digitável; sem receita, não
  // existe (os transformados entram na devolução).
  const expectedOutputs = (recipe?.outputs || [])
    .map((l) => ({ item: byId[l.itemId], expected: l.expectedQty != null ? l.expectedQty * batchN : null }))
    .filter((l) => l.item && l.expected > 0);

  const applyRecipe = (rid, n) => {
    const r = (recipes || []).find((x) => x.id === rid);
    if (!r) { setInputs([{ itemId: "", qty: "" }]); return; }
    const mult = _mpNum(n) || 1;
    const fmt = (v) => String(Number((v * mult).toFixed(4))).replace(".", ",");
    setInputs(r.inputs.map((l) => ({ itemId: l.itemId, qty: fmt(l.qty) })));
  };
  const pickRecipe = (rid) => { setRecipeId(rid); applyRecipe(rid, batches); };
  const setBatchCount = (v) => { setBatches(v); if (recipeId) applyRecipe(recipeId, v); };

  const setLine = (i, patch) => setInputs((cur) => cur.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const dropLine = (i) => setInputs((cur) => cur.filter((_, k) => k !== i));

  const validIn = inputs.map((l) => ({ ...l, item: byId[l.itemId], qtyN: _mpNum(l.qty) })).filter((l) => l.item && l.qtyN > 0);
  const estCost = validIn.reduce((s, l) => s + l.qtyN * (l.item.cost || 0), 0);
  const overStock = validIn.filter((l) => l.qtyN > (l.item.qty || 0));
  const expectedPortions = expectedOutputs.reduce((s, l) => s + l.expected, 0);
  // Insumo em unidade sem peso cadastrado: o lote inteiro fica sem peso de
  // entrada e o desperdício não fecha. Avisa agora, com tempo de cadastrar.
  const noWeight = validIn.filter((l) => {
    const u = String(l.item.unit || "").toLowerCase();
    return u !== "kg" && u !== "g" && !(l.item.portionQty > 0);
  });
  // Aviso (não trava): a porção em kg/g só é exigida na devolução, que é onde o
  // rateio por peso roda.
  const noPortion = expectedOutputs.length > 1 ? expectedOutputs.filter((l) => !(l.item.portionQty > 0)) : [];

  // Variância de insumo: o que foi pedido vs. o teórico da receita. O lado do
  // rendimento não tem variância aqui — a expectativa É a receita.
  const variance = (() => {
    if (!recipe || batchN <= 0) return null;
    const theoIn = recipe.inputs.reduce((s, l) => s + (byId[l.itemId]?.cost || 0) * l.qty * batchN, 0);
    return { inPct: theoIn > 0 ? (estCost - theoIn) / theoIn * 100 : null, inBRL: estCost - theoIn };
  })();

  // A solicitação só precisa dos insumos — as porções reais vêm na devolução.
  const canSave = validIn.length > 0;

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    try {
      setStep("Criando solicitação…");
      const { data, error } = await dbInsertProductionOrder(tid, {
        code: nextCode,
        notes: notes || (recipe ? recipe.name + (batchN !== 1 ? ` · ${batchN} lotes` : "") : null),
        inputs: validIn.map((l) => ({ itemId: l.item.id, name: l.item.name, qty: l.qtyN, unit: l.item.unit })),
        // expected_qty: o padrão da receita fica gravado na ordem — é contra ele
        // que a variância é medida depois, na aba Análises.
        outputs: expectedOutputs.map((l) => ({ itemId: l.item.id, name: l.item.name, expectedQty: l.expected })),
      });
      if (error) throw error;
      // Sem baixa aqui: a ordem nasce 'draft' e vai para a fila de Requisições.
      window.showToast?.(`Solicitação ${data.code || ""} enviada para Requisições`, { tone: "ok", ttl: 5000 });
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 7000 });
      setSaving(false); setStep("");
    }
  };

  return (
    <FullSheet
      title="Solicitar insumos"
      subtitle={validIn.length > 0 ? `${validIn.length} insumo(s) · ${_mpFmt(estCost)}` : "Vai para a fila de Requisições"}
      onBack={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={save} disabled={!canSave} loading={saving}><I.Check size={15} />{saving ? (step || "Carregando…") : "Enviar para Requisições"}</MPrimaryButton>}
    >
      {(recipes || []).length > 0 && (
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <MField label="Receita" hint="Traz insumo e rendimento esperado.">
              <select value={recipeId} onChange={(e) => pickRecipe(e.target.value)} style={mInput}>
                <option value="">— sem receita —</option>
                {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </MField>
          </div>
          <div style={{ width: 90 }}>
            <MField label="Lotes">
              <input value={batches} inputMode="decimal" onChange={(e) => setBatchCount(e.target.value)}
                disabled={!recipeId} style={{ ...mInput, textAlign: "right" }} />
            </MField>
          </div>
        </div>
      )}

      <MSectionLabel>Insumos a separar</MSectionLabel>
      {fromRecipe && (
        <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.45 }}>
          Travados pela receita × {batchN.toLocaleString("pt-BR")} {batchN === 1 ? "lote" : "lotes"} — mude
          os lotes para ajustar, ou escolha "sem receita" para montar à mão.
        </div>
      )}
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        {inputs.map((l, i) => {
          const item = byId[l.itemId]; const qtyN = _mpNum(l.qty);
          if (fromRecipe) {
            return (
              <div key={i} style={{ ..._mpFormCard, display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item?.name || "—"}</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-3)" }}>
                    saldo {(item?.qty ?? 0).toLocaleString("pt-BR")} {item?.unit}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 14, fontWeight: 700, color: qtyN > (item?.qty || 0) ? "var(--crit)" : "var(--fg-0)" }}>
                    {qtyN.toLocaleString("pt-BR", { maximumFractionDigits: 3 })} {item?.unit}
                  </div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-3)" }}>
                    {item && qtyN > 0 ? _mpFmt(qtyN * (item.cost || 0)) : "—"}
                  </div>
                </div>
              </div>
            );
          }
          return (
            <div key={i} style={_mpFormCard}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <MStockPicker items={rawItems} value={l.itemId}
                    placeholder="Selecione um insumo…"
                    disabledIds={inputs.map((x) => x.itemId).filter(Boolean)}
                    onChange={(id) => setLine(i, { itemId: id })} />
                </div>
                {inputs.length > 1 && <button onClick={() => dropLine(i)} aria-label="Remover" style={_mpDelBtn}><I.X size={14} /></button>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input value={l.qty} inputMode="decimal" placeholder={`Qtd${item ? ` (${item.unit})` : ""}`} onChange={(e) => setLine(i, { qty: e.target.value })} style={{ ...mInput, height: 40 }} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-2)", width: 96, textAlign: "right", flexShrink: 0 }}>{item && qtyN > 0 ? _mpFmt(qtyN * (item.cost || 0)) : "—"}</span>
              </div>
            </div>
          );
        })}
      </div>
      {!fromRecipe && (
        <button onClick={() => setInputs((cur) => [...cur, { itemId: "", qty: "" }])} style={_mpAddBtn}><I.Plus size={14} />Adicionar insumo</button>
      )}

      {/* Leitura pura, direto da receita. Sem receita a seção nem aparece. */}
      {expectedOutputs.length > 0 && (
        <>
          <div style={{ marginTop: 18 }}><MSectionLabel>Rendimento esperado</MSectionLabel></div>
          <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.45 }}>
            Pela receita, {batchN.toLocaleString("pt-BR")} {batchN === 1 ? "lote" : "lotes"}. As porções
            reais você informa na devolução — é de lá que sai o custo da porção.
          </div>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            {expectedOutputs.map((l) => (
              <div key={l.item.id} style={{ ..._mpFormCard, display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)" }}>{l.item.name}</span>
                {_mpPortion(l.item) && (
                  <span style={{ fontSize: 10.5, color: "var(--fg-3)" }}>porção {_mpPortion(l.item)}</span>
                )}
                <span style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--fg-0)", fontWeight: 700 }}>
                  {_mpQty(l.expected)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: variance ? "1fr 1fr 1fr" : "1fr", gap: 8 }}>
        <CmvMiniStat label="Custo insumos" value={_mpFmt(estCost)} />
        {variance && (
          <CmvMiniStat
            label="Variância"
            value={variance.inPct == null ? "—" : `${variance.inPct > 0 ? "+" : ""}${variance.inPct.toFixed(1)}%`}
            tone={variance.inPct == null || Math.abs(variance.inPct) < 2 ? undefined : "warn"}
            sub={variance.inPct != null ? `${variance.inBRL >= 0 ? "+" : "−"}${_mpFmt(Math.abs(variance.inBRL))} vs. receita` : null} />
        )}
        {variance && (
          // Custo/porção teórico. O real sai na devolução, quando o custo dos
          // insumos é dividido pelas porções que voltaram de fato.
          <CmvMiniStat
            label="Custo/porção teór."
            value={expectedPortions > 0 ? _mpFmt(estCost / expectedPortions) : "—"}
            sub={expectedPortions > 0 ? `se voltarem ${expectedPortions.toLocaleString("pt-BR")}` : null} />
        )}
      </div>

      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        {noPortion.length > 0 && (
          <MpNotice tone="crit">
            Com 2+ transformados o custo é rateado por peso: <strong>{noPortion.map((l) => l.item.name).join(", ")}</strong>{" "}
            {noPortion.length === 1 ? "precisa" : "precisam"} de porção definida (kg ou g). Ajuste na aba <strong>Transformados</strong>.
          </MpNotice>
        )}
        {noWeight.length > 0 && (
          <MpNotice>
            Sem <strong>peso por unidade</strong> em {noWeight.map((l) => l.item.name).join(", ")} — cadastre
            em <strong>Estoque</strong> para esta produção calcular desperdício e aproveitamento.
            Um insumo sem peso zera a conta do lote inteiro.
          </MpNotice>
        )}
        {overStock.length > 0 && (
          <MpNotice>
            Saldo atual não cobre a solicitação — na <strong>entrega</strong> o estoque vai ficar negativo em:{" "}
            {overStock.map((l) => `${l.item.name} (${(l.item.qty - l.qtyN).toLocaleString("pt-BR")} ${l.item.unit})`).join(", ")}.
            {" "}Regularize com a entrada da compra.
          </MpNotice>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <MField label="Observações (opcional)"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={recipe ? recipe.name : "—"} style={mInput} /></MField>
      </div>
    </FullSheet>
  );
}

// ===== Form: devolução da produção =====
function ProdReturnForm({ order, stockItems, onClose, onSaved }) {
  const transformed = (stockItems || []).filter((i) => i.itemKind === "transformed");
  const byId = {}; transformed.forEach((i) => { byId[i.id] = i; });
  // O item e a gramatura vêm da receita (gravada na ordem como saída esperada):
  // travados, só a quantidade é digitável. Ordem avulsa não tem o que travar.
  const fromRecipe = (order.outputs || []).length > 0;
  // Quantidade em branco de propósito: preenchida com o esperado, a devolução
  // viraria confirmação de um clique, e a diferença entre teórico e contado
  // sumiria dentro do custo da porção. Quem devolve conta.
  const [lines, setLines] = useState(() => fromRecipe
    ? order.outputs.map((o) => ({ itemId: o.itemId, name: o.name, expectedQty: o.expectedQty, qty: "" }))
    : [{ itemId: "", qty: "" }]);
  const [saving, setSaving] = useState(false);

  const valid = lines.map((l) => ({ item: byId[l.itemId], qtyN: _mpNum(l.qty) })).filter((l) => l.item && l.qtyN > 0);
  const multiMissingPortion = valid.length > 1 && valid.some((l) => !(l.item.portionQty > 0));
  const canSave = valid.length > 0 && !multiMissingPortion;
  // Peso de entrada indefinido = desperdício não fecha nesta ordem. Checagem
  // pelo cadastro ATUAL do insumo: é dele que o aproveitamento é derivado, então
  // cadastrar o peso agora ainda resolve esta ordem.
  const inputsNoWeight = (order.inputs || []).filter((l) => {
    const u = String(l.unit || "").toLowerCase();
    if (u === "kg" || u === "g") return false;
    const it = (stockItems || []).find((s) => s.id === l.itemId);
    return !(it && it.portionQty > 0);
  });
  const previews = (() => {
    const total = Number(order.totalInputCost) || 0;
    if (valid.length === 0) return {};
    if (valid.length === 1) return { [valid[0].item.id]: total / valid[0].qtyN };
    const weights = valid.map((l) => ({ id: l.item.id, qtyN: l.qtyN, w: l.qtyN * (l.item.portionQty || 0) }));
    const sumW = weights.reduce((s, x) => s + x.w, 0); if (sumW <= 0) return {};
    const out = {}; for (const x of weights) out[x.id] = (total * x.w / sumW) / x.qtyN; return out;
  })();
  const setLine = (i, patch) => setLines((cur) => cur.map((x, k) => k === i ? { ...x, ...patch } : x));

  const save = async () => {
    if (saving || !canSave) return; setSaving(true);
    try {
      const sess = await dbGetSession();
      // Linha travada sem retorno vai como 0, com o esperado preservado.
      const payload = fromRecipe
        ? lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, name: byId[l.itemId]?.name || l.name, returnedQty: _mpNum(l.qty), expectedQty: l.expectedQty }))
        : valid.map((l) => ({ itemId: l.item.id, name: l.item.name, returnedQty: l.qtyN }));
      const { error } = await dbCompleteProductionOrder(order.id, payload, sess?.user?.id);
      if (error) throw error;
      window.showToast?.("Devolução lançada — transformados no estoque com custo convertido", { tone: "ok" });
      onSaved();
    } catch (e) { window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 }); setSaving(false); }
  };

  return (
    <FullSheet
      title={`Devolução · ${order.code}`}
      subtitle={`Custo dos insumos: ${_mpFmt(order.totalInputCost)} → vira o custo das porções`}
      onBack={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={save} disabled={!canSave} loading={saving}><I.Box size={16} />Confirmar devolução</MPrimaryButton>}
    >
      <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginBottom: 12 }}>
        Insumos retirados: {order.inputs.map((l) => `${l.name} (${l.qty.toLocaleString("pt-BR")} ${l.unit})`).join(", ")}
      </div>

      {transformed.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--warn)", padding: "10px 12px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 8 }}>
          Nenhum transformado cadastrado — crie primeiro na aba <strong>Transformados</strong>.
        </div>
      ) : (
        <>
          <MSectionLabel>Quantas porções voltaram</MSectionLabel>
          {fromRecipe && (
            <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
              Os transformados e a gramatura vêm da receita da ordem — informe só a contagem. O que não voltou fica como zero.
            </div>
          )}
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
            {lines.map((l, i) => {
              const item = byId[l.itemId]; const qtyN = _mpNum(l.qty); const prev = item && qtyN > 0 ? previews[item.id] : null;
              const portion = _mpPortion(item);
              return (
                <div key={i} style={_mpFormCard}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {fromRecipe ? (
                        <>
                          <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item?.name || l.name}</div>
                          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: portion ? "var(--fg-3)" : "var(--warn)" }}>
                            {portion ? `porção ${portion}` : "porção não cadastrada"}
                            {l.expectedQty > 0 ? ` · esperado ${l.expectedQty.toLocaleString("pt-BR")}` : ""}
                          </div>
                        </>
                      ) : (
                        <MStockPicker items={transformed} value={l.itemId}
                          placeholder="Selecione um transformado…"
                          emptyLabel="Nenhum transformado encontrado"
                          disabledIds={lines.map((x) => x.itemId).filter(Boolean)}
                          onChange={(id) => setLine(i, { itemId: id })} />
                      )}
                    </div>
                    {!fromRecipe && lines.length > 1 && (
                      <button onClick={() => setLines((cur) => cur.filter((_, k) => k !== i))} aria-label="Remover" style={_mpDelBtn}><I.X size={14} /></button>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input value={l.qty} inputMode="decimal" placeholder="Porções" onChange={(e) => setLine(i, { qty: e.target.value })} style={{ ...mInput, height: 40 }} />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-2)", width: 110, textAlign: "right", flexShrink: 0 }}>{prev != null && isFinite(prev) ? `≈ ${_mpFmt(prev)}/porç.` : ""}</span>
                  </div>
                </div>
              );
            })}
          </div>
          {!fromRecipe && (
            <button onClick={() => setLines((cur) => [...cur, { itemId: "", qty: "" }])} style={_mpAddBtn}>
              <I.Plus size={14} />Adicionar transformado
            </button>
          )}
          {multiMissingPortion && (
            <div style={{ marginTop: 12 }}>
              <MpNotice>
                Vários transformados: todos precisam ter <strong>porção definida</strong> (o custo é rateado por peso).
                Ajuste na aba <strong>Transformados</strong>.
              </MpNotice>
            </div>
          )}
          {inputsNoWeight.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <MpNotice>
                <strong>Sem desperdício calculado nesta ordem.</strong>{" "}
                {inputsNoWeight.map((l) => l.name).join(", ")} {inputsNoWeight.length === 1 ? "está cadastrado" : "estão cadastrados"} em
                unidade, sem <strong>peso por unidade</strong> — preencha em <strong>Estoque</strong> e o aproveitamento
                desta ordem (e das anteriores) passa a ser calculado.
              </MpNotice>
            </div>
          )}
          <div style={{ marginTop: 12, fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
            Voltou menos que o enviado? O desperdício fica absorvido no custo da porção (nada vira perda no CMV)
            e aparece na aba Análises — o aproveitamento % denuncia desvios.
          </div>
        </>
      )}
    </FullSheet>
  );
}

// ===== Aba: Transformados (catálogo) =====
function MProdCatalog({ items, orders, onEdit }) {
  const lastProd = (window.trLastProdByItem || (() => ({})))(orders);

  if (items.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13, lineHeight: 1.6 }}>
        Nenhum transformado cadastrado.<br />
        <span style={{ fontSize: 11.5 }}>
          Cadastre aqui o que a produção devolve porcionado (ex.: "Calabresa porcionada 100g").
          O custo da porção vem da última devolução.
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <MSectionLabel>{items.length} {items.length === 1 ? "item ativo" : "itens ativos"} · custo da porção vem da última devolução</MSectionLabel>
      {items.map((it) => (
        <MobileCard key={it.id} onClick={() => onEdit(it)}
          tone={it.status === "crit" ? "crit" : it.status === "warn" ? "warn" : undefined}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14.5, color: "var(--fg-0)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 3 }}>
                {it.cat || "sem categoria"}
                {_mpPortion(it) ? ` · porção ${_mpPortion(it)}` : " · porção não definida"}
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", marginTop: 3 }}>
                última produção {lastProd[it.id] ? new Date(lastProd[it.id]).toLocaleDateString("pt-BR") : "—"}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700,
                             color: it.status === "crit" ? "var(--crit)" : it.status === "warn" ? "var(--warn)" : "var(--fg-0)" }}>
                {(it.qty || 0).toLocaleString("pt-BR")} un
              </span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-2)" }}>
                {it.cost > 0 ? `${_mpFmt(it.cost)}/porç.` : "—"}
              </span>
            </div>
          </div>
        </MobileCard>
      ))}
    </div>
  );
}

// Criar/editar transformado — mesmo payload do TransformedItemModal do desktop.
function MTransformedForm({ tid, categories, initial, onClose, onDelete, onSaved }) {
  const [name, setName] = useState(initial?.name || "");
  const [catId, setCatId] = useState(initial?.catId || "");
  // Porção exibida em g; persistida como portion_qty (kg) + portion_unit
  const initPortion = initial?.portionQty != null
    ? (initial.portionUnit === "g" ? initial.portionQty : initial.portionQty * 1000)
    : "";
  const [portionG, setPortionG] = useState(initPortion !== "" ? String(initPortion).replace(".", ",") : "");
  const [reorder, setReorder] = useState(initial?.reorder ? String(initial.reorder).replace(".", ",") : "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [saving, setSaving] = useState(false);

  const portionGN = _mpNum(portionG);
  const canSave = name.trim().length > 0;

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        unit: "un",                                   // transformado é estocado em porções
        itemKind: "transformed",
        portionQty: portionGN > 0 ? portionGN / 1000 : null,  // grava em kg
        portionUnit: portionGN > 0 ? "kg" : null,
        catId: catId || null,
        reorder: _mpNum(reorder) || 0,
        notes: notes || null,
        composeCmv: true,
      };
      if (initial?.id) {
        const { error } = await dbUpdateStockItem(initial.id, payload);
        if (error) throw error;
        window.showToast?.("Transformado atualizado", { tone: "ok" });
      } else {
        const { data, error } = await dbInsertStockItem(tid, { ...payload, qty: 0, cost: 0 });
        if (error) throw error;
        window.showToast?.(`"${data?.name || name}" criado — produza pela aba Produzir hoje`, { tone: "ok" });
      }
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro ao salvar: ${e.message || e}`, { tone: "crit", ttl: 6000 });
      setSaving(false);
    }
  };

  return (
    <FullSheet
      title={initial ? initial.name : "Novo transformado"}
      subtitle="Entra no estoque em porções (un). O custo vem das ordens de produção."
      onBack={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={save} disabled={!canSave} loading={saving}><I.Check size={15} />{initial ? "Salvar" : "Criar transformado"}</MPrimaryButton>}
    >
      <MField label="Nome">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder='Ex.: "Calabresa porcionada 100g"' style={mInput} />
      </MField>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <MField label="Peso da porção (g)" hint="Usado no aproveitamento % e no rateio de custo.">
            <input value={portionG} inputMode="decimal" onChange={(e) => setPortionG(e.target.value)} placeholder="100" style={mInput} />
          </MField>
        </div>
        <div style={{ flex: 1 }}>
          <MField label="Estoque mínimo (porções)" hint="O máximo se define em Estoque.">
            <input value={reorder} inputMode="decimal" onChange={(e) => setReorder(e.target.value)} placeholder="0" style={mInput} />
          </MField>
        </div>
      </div>
      <MField label="Categoria">
        <select value={catId} onChange={(e) => setCatId(e.target.value)} style={mInput}>
          <option value="">Sem categoria</option>
          {(categories || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </MField>
      <MField label="Observações (opcional)">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="—" style={mInput} />
      </MField>

      {initial && (
        <button onClick={() => onDelete(initial)} disabled={saving} style={{
          marginTop: 6, width: "100%", height: 46, borderRadius: 10, background: "transparent",
          border: "1px solid var(--crit-line)", color: "var(--crit)", fontSize: 13.5, fontWeight: 600,
        }}>
          Desativar transformado
        </button>
      )}
    </FullSheet>
  );
}

// ===== Aba: Receitas de produção =====
function MProdRecipes({ recipes, byId, onEdit }) {
  if ((recipes || []).length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13, lineHeight: 1.6 }}>
        Nenhuma receita de produção.<br />
        <span style={{ fontSize: 11.5 }}>
          Ex.: "Porcionamento de calabresa (lote 10 kg)" — ao solicitar insumos, escolha a receita
          e as linhas entram preenchidas por lote.
        </span>
      </div>
    );
  }
  const nameOf = (id) => byId[id]?.name || "?";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <MSectionLabel>templates de lote · insumos → porções esperadas</MSectionLabel>
      {recipes.map((r) => (
        <MobileCard key={r.id} onClick={() => onEdit(r)}>
          <div style={{ fontSize: 14.5, color: "var(--fg-0)", fontWeight: 500 }}>{r.name}</div>
          <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 4, lineHeight: 1.45 }}>
            {r.inputs.map((l) => `${nameOf(l.itemId)} (${l.qty.toLocaleString("pt-BR")} ${l.unit})`).join(", ") || "—"}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 4, lineHeight: 1.45 }}>
            → {r.outputs.map((l) => `${nameOf(l.itemId)}${l.expectedQty ? ` · ${l.expectedQty.toLocaleString("pt-BR")} porções` : ""}`).join(", ") || "—"}
          </div>
        </MobileCard>
      ))}
    </div>
  );
}

// Criar/editar receita — mesmo payload do ProductionRecipeModal do desktop.
function MRecipeForm({ tid, stockItems, initial, onClose, onDelete, onSaved }) {
  const rawItems = (stockItems || []).filter((i) => i.itemKind !== "transformed");
  const transformedItems = (stockItems || []).filter((i) => i.itemKind === "transformed");
  const byId = {}; (stockItems || []).forEach((i) => { byId[i.id] = i; });

  const [name, setName] = useState(initial?.name || "");
  const [inputs, setInputs] = useState(
    initial?.inputs?.length
      ? initial.inputs.map((l) => ({ itemId: l.itemId, qty: String(l.qty).replace(".", ",") }))
      : [{ itemId: "", qty: "" }]);
  const [outputs, setOutputs] = useState(
    initial?.outputs?.length
      ? initial.outputs.map((l) => ({ itemId: l.itemId, expectedQty: l.expectedQty != null ? String(l.expectedQty) : "" }))
      : [{ itemId: "", expectedQty: "" }]);
  const [notes, setNotes] = useState(initial?.notes || "");
  const [saving, setSaving] = useState(false);

  const validInputs = inputs.map((l) => ({ item: byId[l.itemId], qtyN: _mpNum(l.qty) })).filter((l) => l.item && l.qtyN > 0);
  const validOutputs = outputs.map((l) => ({ item: byId[l.itemId], expN: _mpNum(l.expectedQty) })).filter((l) => l.item);
  const canSave = name.trim().length > 0 && validInputs.length > 0 && validOutputs.length > 0;

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    try {
      const { error } = await dbSaveProductionRecipe(tid, {
        id: initial?.id || null,
        name: name.trim(),
        notes: notes || null,
        inputs: validInputs.map((l) => ({ itemId: l.item.id, qty: l.qtyN, unit: l.item.unit })),
        outputs: validOutputs.map((l) => ({ itemId: l.item.id, expectedQty: l.expN > 0 ? l.expN : null })),
      });
      if (error) throw error;
      window.showToast?.(initial ? "Receita atualizada" : "Receita criada", { tone: "ok" });
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro ao salvar: ${e.message || e}`, { tone: "crit", ttl: 6000 });
      setSaving(false);
    }
  };

  const line = (l, i, list, setList, kind) => {
    const item = byId[l.itemId];
    const isIn = kind === "in";
    return (
      <div key={i} style={_mpFormCard}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <MStockPicker items={isIn ? rawItems : transformedItems} value={l.itemId}
              placeholder={isIn ? "Selecione um insumo…" : "Selecione um transformado…"}
              emptyLabel={isIn ? "Nenhum item encontrado" : "Nenhum transformado encontrado"}
              disabledIds={list.map((x) => x.itemId).filter(Boolean)}
              onChange={(id) => setList((cur) => cur.map((x, k) => k === i ? { ...x, itemId: id } : x))} />
          </div>
          {list.length > 1 && (
            <button onClick={() => setList((cur) => cur.filter((_, k) => k !== i))} aria-label="Remover" style={_mpDelBtn}><I.X size={14} /></button>
          )}
        </div>
        <input
          value={isIn ? l.qty : l.expectedQty} inputMode="decimal"
          placeholder={isIn ? `Qtd por lote${item ? ` (${item.unit})` : ""}` : "Porções esperadas por lote"}
          onChange={(e) => setList((cur) => cur.map((x, k) => k === i ? { ...x, [isIn ? "qty" : "expectedQty"]: e.target.value } : x))}
          style={{ ...mInput, height: 40 }} />
      </div>
    );
  };

  return (
    <FullSheet
      title={initial ? initial.name : "Nova receita"}
      subtitle="Template de lote — pré-preenche a solicitação. Sem efeito no estoque."
      onBack={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={save} disabled={!canSave} loading={saving}><I.Check size={15} />Salvar receita</MPrimaryButton>}
    >
      <MField label="Nome da receita">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder='Ex.: "Porcionamento de calabresa (lote 10kg)"' style={mInput} />
      </MField>

      <MSectionLabel>Insumos do lote</MSectionLabel>
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        {inputs.map((l, i) => line(l, i, inputs, setInputs, "in"))}
      </div>
      <button onClick={() => setInputs((cur) => [...cur, { itemId: "", qty: "" }])} style={_mpAddBtn}><I.Plus size={14} />Adicionar insumo</button>

      <div style={{ marginTop: 18 }}><MSectionLabel>Saídas esperadas do lote</MSectionLabel></div>
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        {outputs.map((l, i) => line(l, i, outputs, setOutputs, "out"))}
      </div>
      <button onClick={() => setOutputs((cur) => [...cur, { itemId: "", expectedQty: "" }])} style={_mpAddBtn}><I.Plus size={14} />Adicionar saída</button>

      <div style={{ marginTop: 18 }}>
        <MField label="Observações (opcional)">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="—" style={mInput} />
        </MField>
      </div>

      {initial && (
        <button onClick={() => onDelete(initial)} disabled={saving} style={{
          marginTop: 6, width: "100%", height: 46, borderRadius: 10, background: "transparent",
          border: "1px solid var(--crit-line)", color: "var(--crit)", fontSize: 13.5, fontWeight: 600,
        }}>
          Excluir receita
        </button>
      )}
    </FullSheet>
  );
}

// ===== Aba: Análises =====
// Mesmos números do desktop (trAnalytics), no formato de lista do tablet.
function MProdInsights({ orders, stockItems }) {
  const trAnalytics = window.trAnalytics, trRange = window.trRange, trPeriodLabel = window.trPeriodLabel;
  const [period, setPeriod] = useState("30");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [itemId, setItemId] = useState("");   // "" = todos os transformados

  const produced = useMemo(() => (window.trProducedItems || (() => []))(orders), [orders]);
  const missingWeight = useMemo(
    () => (window.trMissingWeightInputs || (() => []))(orders, stockItems), [orders, stockItems]);

  if (typeof trAnalytics !== "function") return null;   // page-transformed.jsx ainda não carregou

  // Se o item selecionado sair da lista (troca de dados), volta pra "todos".
  const activeItemId = produced.some((t) => t.itemId === itemId) ? itemId : "";
  const a = trAnalytics(orders, trRange(period, from, to), activeItemId || null);
  const periodLabel = trPeriodLabel(period, from, to);

  return (
    <>
      <MpPeriodFilter period={period} onPeriod={setPeriod} from={from} onFrom={setFrom} to={to} onTo={setTo} />

      {produced.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <select value={activeItemId} onChange={(e) => setItemId(e.target.value)} style={mInput}>
            <option value="">Todos os transformados</option>
            {produced.map((t) => <option key={t.itemId} value={t.itemId}>{t.name}</option>)}
          </select>
        </div>
      )}

      {missingWeight.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <MpNotice>
            <strong>Desperdício não pode ser calculado</strong> enquanto houver insumo sem peso:{" "}
            <strong>{missingWeight.join(", ")}</strong>. Preencha <strong>Peso por unidade</strong> no
            cadastro de cada um, em <strong>Estoque</strong> — uma linha sem peso zera a conta do lote inteiro.
          </MpNotice>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <CmvMiniStat label="Produções" value={a.completedCount} sub={periodLabel} />
        <CmvMiniStat label="Custo produzido" value={_mpFmt(a.totalCost)} sub="convertido em porções" />
        <CmvMiniStat label="Aproveitamento" value={a.avgYield != null ? `${a.avgYield.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : "—"}
          tone={a.avgYield != null && a.avgYield < 90 ? "warn" : undefined} sub="devolvido ÷ enviado" />
        <CmvMiniStat label="Desperdício" value={a.totalWaste > 0 ? `${_mpQty(a.totalWaste)} kg` : "—"}
          tone={a.totalWaste > 0 ? "warn" : undefined}
          sub={a.totalWaste > 0 ? `≈ ${_mpFmt(a.wasteCostEst)} no custo` : "sem desperdício"} />
      </div>

      <div style={{ marginTop: 16 }}><MSectionLabel>Por transformado · {periodLabel}</MSectionLabel></div>
      {a.items.length === 0 ? (
        <div style={{ textAlign: "center", padding: "32px 12px", color: "var(--fg-3)", fontSize: 12.5 }}>
          Nenhuma produção concluída no período — as análises aparecem após a primeira devolução lançada.
        </div>
      ) : (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          {a.items.map((r) => (
            <div key={r.itemId} style={_mpCard()}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: "var(--fg-0)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-0)", fontWeight: 700, flexShrink: 0 }}>{_mpFmt(r.cost)}</span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 4 }}>
                {r.ordersCount} {r.ordersCount === 1 ? "produção" : "produções"} · {r.portions.toLocaleString("pt-BR")} porções
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-3)", marginTop: 3 }}>
                médio {r.avgUnitCost != null ? _mpFmt(r.avgUnitCost) : "—"}/porç. · último {r.lastUnitCost != null ? _mpFmt(r.lastUnitCost) : "—"}/porç.
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ===== Aba: Consumo por operação (e pela rede, na central) =====
function MProdConsumption({ tid, isCentral, transfers, stockItems }) {
  const [period, setPeriod] = useState("30");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [movements, setMovements] = useState(null);   // null = carregando
  const [splits, setSplits] = useState({});
  const [operations, setOperations] = useState([]);
  const [loadError, setLoadError] = useState(null);

  const trRange = window.trRange, trPeriodLabel = window.trPeriodLabel;

  // As saídas vêm do banco por janela. A dependência é o filtro (period + datas)
  // e nunca o range calculado: em período relativo ele muda a cada render e o
  // efeito entraria em laço.
  useEffect(() => {
    if (!tid || typeof trRange !== "function") return;
    let cancelled = false;
    setMovements(null); setLoadError(null);
    (async () => {
      const r = trRange(period, from, to);
      const fromIso = r.from != null ? new Date(r.from).toISOString() : null;
      const toIso   = r.to   != null ? new Date(r.to).toISOString()   : null;
      const [movRes, opRes] = await Promise.all([
        dbListStockMovements(tid, fromIso, toIso, { limit: 10000 }),
        dbListOperations(tid),
      ]);
      if (cancelled) return;
      if (movRes?.error) { setLoadError(movRes.error.message || String(movRes.error)); setMovements([]); return; }
      const movs = movRes?.data || [];
      const reqIds = movs.filter((m) => m.referenceType === "kitchen_request" && m.referenceId).map((m) => m.referenceId);
      const spRes = await dbListSharedSplits(tid, reqIds);
      if (cancelled) return;
      setOperations(opRes?.data || []);
      setSplits(spRes?.data || {});
      setMovements(movs);
    })();
    return () => { cancelled = true; };
  }, [tid, period, from, to]);

  const byOp = useMemo(
    () => (window.trConsumptionRows || (() => null))(movements, splits, operations, stockItems),
    [movements, splits, operations, stockItems]);
  const netList = useMemo(
    () => (isCentral && typeof trRange === "function"
      ? (window.trNetworkRows || (() => []))(transfers, tid, trRange(period, from, to))
      : []),
    [isCentral, transfers, tid, period, from, to]);

  const opTotal = (byOp || []).reduce((s, r) => s + r.value, 0);
  const netTotal = netList.reduce((s, r) => s + r.value, 0);
  const periodLabel = typeof trPeriodLabel === "function" ? trPeriodLabel(period, from, to) : "";

  const row = (key, title, sub, qty, value, isInventory) => (
    <div key={key} style={_mpCard()}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </span>
        {isInventory && <MBadge tone="warn">inventário</MBadge>}
        <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-0)", fontWeight: 700, flexShrink: 0 }}>{_mpFmt(value)}</span>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 3 }}>
        {sub} · {_mpQty(qty)} porções
      </div>
    </div>
  );

  return (
    <>
      <MpPeriodFilter period={period} onPeriod={setPeriod} from={from} onFrom={setFrom} to={to} onTo={setTo} />

      <MSectionLabel>Por operação · {_mpFmt(opTotal)} · {periodLabel}</MSectionLabel>
      <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 4, lineHeight: 1.45 }}>
        transformados baixados no consumo da própria unidade e faltas de inventário (a custo)
      </div>
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
        {loadError ? (
          <div style={{ textAlign: "center", padding: "28px 12px", color: "var(--crit)", fontSize: 12.5 }}>Erro ao carregar as saídas: {loadError}</div>
        ) : byOp == null ? (
          <div style={{ textAlign: "center", padding: "28px 12px", color: "var(--fg-3)", fontSize: 12.5 }}>Carregando consumo…</div>
        ) : byOp.length === 0 ? (
          <div style={{ textAlign: "center", padding: "28px 12px", color: "var(--fg-3)", fontSize: 12.5, lineHeight: 1.5 }}>
            Nenhum transformado consumido no período — as baixas por requisição e os ajustes de inventário alimentam esta lista.
          </div>
        ) : byOp.map((r, i) => row(`op-${i}`, r.item, r.op, r.qty, r.value, r.isInventory))}
      </div>

      {isCentral && (
        <>
          <div style={{ marginTop: 18 }}>
            <MSectionLabel>Por unidade da rede · {_mpFmt(netTotal)} · {periodLabel}</MSectionLabel>
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 4, lineHeight: 1.45 }}>
            transformados enviados e recebidos pelas unidades (a custo)
          </div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {netList.length === 0 ? (
              <div style={{ textAlign: "center", padding: "28px 12px", color: "var(--fg-3)", fontSize: 12.5 }}>
                Nenhum transformado transferido para a rede no período.
              </div>
            ) : netList.map((r, i) => row(`net-${i}`, r.item, r.unidade, r.qty, r.value, false))}
          </div>
        </>
      )}
    </>
  );
}

window.MobileProduction = MobileProduction;
