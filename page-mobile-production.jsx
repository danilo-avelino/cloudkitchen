// page-mobile-production.jsx — Produção no celular (≤480px). Foco operacional:
// ordens de saída (draft → issued → completed). Reaproveita as funções db* do
// desktop (page-production.jsx): a saída baixa insumos no envio; a devolução
// converte o custo em porções. Gestão fina (Transformados/Receitas/Análises) fica
// no desktop. Só funciona online.

const _mpFmt = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _mpNum = (raw) => { if (raw == null) return 0; const s = String(raw).trim().replace(/\./g, "").replace(",", "."); const n = parseFloat(s); return Number.isFinite(n) ? n : 0; };
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

function MobileProduction() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid] = useState(null);
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState([]);
  const [stockItems, setStockItems] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [statusFilter, setStatusFilter] = useState("today");
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(null);      // { edit?: order } — criar/editar
  const [returnFor, setReturnFor] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind:'cancel'|'delete', order }
  const [busy, setBusy] = useState(false);

  const reload = async (t) => {
    const tenant = t || tid;
    if (!tenant) return;
    const [oRes, sRes, rRes] = await Promise.all([
      dbListProductionOrders(tenant), dbListStockItems(tenant), dbListProductionRecipes(tenant),
    ]);
    // Peso atual do estoque manda no aproveitamento (espelha o desktop)
    const items = sRes?.data || [];
    setOrders((oRes?.data || []).map((o) => prodOrderWithLiveWeights(o, items)));
    setStockItems(items); setRecipes(rRes?.data || []);
  };

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const t = ctx?.tenant?.id || null;
      setTid(t);
      if (t) await reload(t);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  const filtered = (statusFilter === "all" || statusFilter === "today")
    ? orders : orders.filter((o) => o.status === statusFilter);

  // Prep list: política mín/máx — saldo ≤ mínimo entra, e a reposição vai até
  // o máximo em lotes inteiros da receita. planProduction vem do desktop
  // (page-production.jsx, carregado antes deste arquivo) para as duas telas
  // não divergirem na regra de arredondamento dos lotes.
  const todo = useMemo(() => {
    const plan = window.planProduction;
    if (typeof plan !== "function") return [];
    return (stockItems || [])
      .filter((i) => i.itemKind === "transformed")
      .map((i) => {
        const recipe = (recipes || []).find((r) => r.outputs.some((o) => o.itemId === i.id)) || null;
        return { item: i, recipe, plan: plan(i, recipe) };
      })
      .filter((r) => r.plan.produce > 0)
      .sort((a, b) => (b.plan.rawNeed / b.plan.target) - (a.plan.rawNeed / a.plan.target));
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
    const cutoff30 = Date.now() - 30 * 86400000;
    const done30 = orders.filter((o) => o.status === "completed" && o.completedAt && new Date(o.completedAt).getTime() >= cutoff30);
    const yields = done30.filter((o) => o.yieldPct != null);
    const avgYield = yields.length ? yields.reduce((s, o) => s + o.yieldPct, 0) / yields.length : null;
    return { waiting: waiting.length, waitingValue, done30: done30.length, avgYield };
  }, [orders]);

  const doConfirm = async () => {
    if (busy || !confirm) return; setBusy(true);
    try {
      if (confirm.kind === "cancel") { const { error } = await dbCancelProductionOrder(confirm.order.id); if (error) throw error; window.showToast?.("Ordem cancelada — insumos devolvidos ao estoque", { tone: "ok" }); }
      else { const { error } = await dbDeleteProductionOrder(confirm.order.id); if (error) throw error; window.showToast?.("Rascunho excluído", { tone: "ok" }); }
      setConfirm(null); setDetail(null); await reload();
    } catch (e) { window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 }); }
    setBusy(false);
  };

  if (loading) return <PageLoading label="Carregando produção…" variant="table" />;
  if (!dbStatus.isOnline || !tid) {
    return <MobilePage><div style={{ padding: 24 }}><div style={{ fontSize: 12.5, color: "var(--warn)", padding: "12px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 8 }}>Produção só fica disponível com Supabase online.</div></div></MobilePage>;
  }

  return (
    <MobilePage>
      <SegTabs value={statusFilter} onChange={setStatusFilter} options={[
        { id: "today", label: "Hoje", count: todo.length || null, tone: todo.length ? "warn" : undefined },
        { id: "all", label: "Histórico", count: counts.all },
        { id: "issued", label: "Pendências", count: counts.issued || null, tone: "crit" },
      ]} />

      <StatStrip stats={[
        { label: "Pendentes", value: kpis.waiting, tone: kpis.waiting > 0 ? "crit" : "ok", sub: "não concluídas" },
        { label: "Travado", value: _mpFmt(kpis.waitingValue).replace(",00", ""), sub: "insumo sem entrada" },
        { label: "Produções 30d", value: kpis.done30 },
        { label: "Aproveit. 30d", value: kpis.avgYield != null ? `${kpis.avgYield.toFixed(0)}%` : "—", tone: kpis.avgYield != null && kpis.avgYield < 90 ? "warn" : "ok" },
      ]} />

      <MobileScroll style={{ padding: "0 14px 12px" }}>
        {statusFilter === "today" ? (
          <>
          {/* Trabalho em aberto: lote entregue devendo devolução, ou solicitação
              ainda na fila de Requisições. */}
          {openOrders.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
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
                      {waiting ? (
                        <button onClick={() => setReturnFor(o)}
                          style={{ flexShrink: 0, height: 44, padding: "0 14px", borderRadius: 10, background: "var(--accent-bright)", color: "var(--accent-fg)", border: "none", fontSize: 13.5, fontWeight: 700 }}>
                          Devolução
                        </button>
                      ) : (
                        <button onClick={() => setDetail(o)}
                          style={{ flexShrink: 0, height: 44, padding: "0 14px", borderRadius: 10, background: "transparent", color: "var(--fg-2)", border: "1px solid var(--line)", fontSize: 13.5, fontWeight: 600 }}>
                          Ver
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {todo.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13 }}>
              Nenhum transformado no estoque mínimo.<br />
              <span style={{ fontSize: 11.5 }}>Defina o estoque mínimo e o máximo dos transformados em Estoque para esta lista funcionar.</span>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {todo.map(({ item, recipe, plan }) => {
                const pct = plan.target > 0 ? (item.qty || 0) / plan.target : 0;
                return (
                  <div key={item.id} style={_mpCard(pct <= 0.25 ? "crit" : pct <= 0.6 ? "warn" : undefined)}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14.5, color: "var(--fg-0)", fontWeight: 500 }}>{item.name}</div>
                        <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 2 }}>
                          saldo {(item.qty || 0).toLocaleString("pt-BR")} {item.unit} · mín {plan.min.toLocaleString("pt-BR")}
                          {plan.max != null ? ` · máx ${plan.max.toLocaleString("pt-BR")}` : ""}
                          {recipe ? "" : " · sem receita"}
                        </div>
                        <div style={{ fontFamily: "var(--mono)", fontSize: 15, color: "var(--fg-0)", fontWeight: 700, marginTop: 4 }}>
                          produzir {plan.produce.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} {item.unit}
                        </div>
                        {plan.batches != null && (
                          <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", marginTop: 2 }}>
                            {plan.batches} {plan.batches === 1 ? "lote" : "lotes"} de {plan.lote.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}
                            {plan.produce > plan.rawNeed && (
                              <span style={{ color: (plan.produce - plan.rawNeed) > plan.lote / 2 ? "var(--warn)" : "var(--fg-3)" }}>
                                {" "}· +{(plan.produce - plan.rawNeed).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} do máx
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <button onClick={() => setForm({ recipeId: recipe?.id || "", batches: plan.batches })}
                        style={{ flexShrink: 0, height: 44, padding: "0 14px", borderRadius: 10, background: inFlight.has(item.id) ? "transparent" : "var(--accent-bright)", color: inFlight.has(item.id) ? "var(--fg-2)" : "var(--accent-fg)", border: inFlight.has(item.id) ? "1px solid var(--line)" : "none", fontSize: 13.5, fontWeight: 700 }}>
                        Solicitar
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          </>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--fg-3)", fontSize: 13 }}>
            Nenhuma produção {statusFilter !== "all" ? "neste filtro" : "registrada ainda"}.<br />
            <span style={{ fontSize: 11.5 }}>Solicite os insumos aqui; a entrega acontece em Requisições e a devolução volta pra esta tela.</span>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filtered.map((o) => <ProdOrderCard key={o.id} order={o} onTap={() => setDetail(o)} />)}
          </div>
        )}
      </MobileScroll>

      <MobileBottomBar>
        <MPrimaryButton onClick={() => setForm({})}><I.Plus size={16} />Solicitar insumos</MPrimaryButton>
      </MobileBottomBar>

      {detail && (
        <ProdOrderSheet
          order={orders.find((o) => o.id === detail.id) || detail}
          busy={busy}
          onClose={() => setDetail(null)}
          onReturn={() => { setReturnFor(orders.find((o) => o.id === detail.id) || detail); setDetail(null); }}
          onCancelOrder={() => setConfirm({ kind: "cancel", order: detail })}
          onDelete={() => setConfirm({ kind: "delete", order: detail })}
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

      {confirm && (
        <BottomSheet
          title={confirm.kind === "cancel" ? "Cancelar ordem?" : "Excluir rascunho?"}
          subtitle={confirm.order.code}
          onClose={() => !busy && setConfirm(null)}
          footer={
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setConfirm(null)} disabled={busy} style={{ flex: 1, height: 50, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14, fontWeight: 600 }}>Voltar</button>
              <button onClick={doConfirm} disabled={busy} style={{ flex: 1, height: 50, borderRadius: 10, background: "var(--crit)", border: "none", color: "#fff", fontSize: 14, fontWeight: 600 }}>{busy ? "…" : (confirm.kind === "cancel" ? "Cancelar ordem" : "Excluir")}</button>
            </div>
          }
        >
          <div style={{ fontSize: 13, color: "var(--fg-2)" }}>
            {confirm.kind === "cancel"
              ? "Os insumos baixados voltam ao estoque com movimentos inversos."
              : "Essa ação não pode ser desfeita."}
          </div>
        </BottomSheet>
      )}
    </MobilePage>
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
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <MBadge tone={m.tone}>{m.label}</MBadge>
        {order.status === "issued" && (() => { const e = _mpElapsed(order.issuedAt); return <MBadge tone={e.tone === "crit" ? "crit" : e.tone === "warn" ? "warn" : "neutral"}>há {e.label}</MBadge>; })()}
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
              <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.name}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-2)" }}>{l.returnedQty != null ? l.returnedQty.toLocaleString("pt-BR") : "—"} porç.</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-0)", fontWeight: 600, width: 84, textAlign: "right" }}>{l.costShare != null ? _mpFmt(l.costShare) : "—"}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {order.status === "completed" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 14 }}>
          <CmvMiniStat label="Aproveit." value={order.yieldPct != null ? `${order.yieldPct.toLocaleString("pt-BR")}%` : "—"} />
          <CmvMiniStat label="Desperdício" value={order.wasteQty != null ? `${order.wasteQty.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}kg` : "—"} />
          <CmvMiniStat label="Devolvido" value={order.outputWeight != null ? `${order.outputWeight.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}kg` : "—"} />
        </div>
      )}
    </BottomSheet>
  );
}

function CmvMiniStat({ label, value }) {
  return (
    <div style={{ padding: "10px 8px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", textAlign: "center" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-3)", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, marginTop: 3, color: "var(--fg-0)" }}>{value}</div>
    </div>
  );
}

// ===== Form: solicitar insumos (primeira fase) =====
// Espelha o ProductionRequestModal do desktop: só cria a ordem em 'draft'. Nada
// sai do estoque aqui — a baixa é na entrega, feita no módulo Requisições.
function ProdBatchForm({ tid, stockItems, recipes, nextCode, initialRecipeId, initialBatches, onClose, onSaved }) {
  const rawItems = (stockItems || []).filter((i) => i.itemKind !== "transformed");
  const byId = {}; (stockItems || []).forEach((i) => { byId[i.id] = i; });

  // Vindo de "Hoje", a receita e o nº de lotes que repõe até o máximo já chegam
  // calculados — as linhas nascem escaladas por esse nº.
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
  // Aviso (não trava): a porção em kg/g só é exigida na devolução, que é onde o
  // rateio por peso roda.
  const noPortion = expectedOutputs.length > 1 ? expectedOutputs.filter((l) => !(l.item.portionQty > 0)) : [];
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

  const card = { padding: "10px 12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" };
  const delBtn = { width: 40, height: 40, borderRadius: 8, flexShrink: 0, background: "transparent", border: "1px solid var(--line)", color: "var(--fg-3)", display: "grid", placeItems: "center" };
  const addBtn = { marginTop: 10, height: 44, width: "100%", borderRadius: 10, background: "transparent", border: "1px dashed var(--line)", color: "var(--fg-2)", fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 };

  return (
    <FullSheet
      title="Solicitar insumos"
      subtitle={validIn.length > 0 ? `${validIn.length} insumo(s) · ${_mpFmt(estCost)}` : "Vai para a fila de Requisições"}
      onBack={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={save} disabled={!canSave} loading={saving}><I.Check size={15} />{saving ? (step || "…") : "Enviar para Requisições"}</MPrimaryButton>}
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
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        {inputs.map((l, i) => {
          const item = byId[l.itemId]; const qtyN = _mpNum(l.qty);
          return (
            <div key={i} style={card}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <MStockPicker items={rawItems} value={l.itemId}
                    placeholder="Selecione um insumo…"
                    disabledIds={inputs.map((x) => x.itemId).filter(Boolean)}
                    onChange={(id) => setLine(i, { itemId: id })} />
                </div>
                {inputs.length > 1 && <button onClick={() => dropLine(i)} aria-label="Remover" style={delBtn}><I.X size={14} /></button>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input value={l.qty} inputMode="decimal" placeholder={`Qtd${item ? ` (${item.unit})` : ""}`} onChange={(e) => setLine(i, { qty: e.target.value })} style={{ ...mInput, height: 40 }} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg-2)", width: 96, textAlign: "right", flexShrink: 0 }}>{item && qtyN > 0 ? _mpFmt(qtyN * (item.cost || 0)) : "—"}</span>
              </div>
            </div>
          );
        })}
      </div>
      <button onClick={() => setInputs((cur) => [...cur, { itemId: "", qty: "" }])} style={addBtn}><I.Plus size={14} />Adicionar insumo</button>

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
              <div key={l.item.id} style={{ ...card, display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--fg-0)" }}>{l.item.name}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--fg-0)", fontWeight: 700 }}>
                  {l.expected.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {noPortion.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", gap: 8, padding: "10px 12px", borderRadius: 10, background: "var(--crit-soft)", border: "1px solid var(--crit-line)" }}>
          <I.AlertTriangle size={14} style={{ color: "var(--crit)", flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.5 }}>
            Com 2+ transformados o custo é rateado por peso: {noPortion.map((l) => l.item.name).join(", ")} precisa(m) de porção definida (kg ou g). Ajuste no desktop, aba Transformados.
          </div>
        </div>
      )}

      {overStock.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", gap: 8, padding: "10px 12px", borderRadius: 10, background: "var(--warn-soft)", border: "1px solid var(--warn-line)" }}>
          <I.AlertTriangle size={14} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.5 }}>Sem saldo — o estoque fica negativo em: {overStock.map((l) => l.item.name).join(", ")}. Regularize com a entrada da compra.</div>
        </div>
      )}

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
          Nenhum transformado cadastrado — crie primeiro no desktop (aba Transformados).
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
                <div key={i} style={{ padding: "10px 12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {fromRecipe ? (
                        <>
                          <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item?.name || l.name}</div>
                          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: portion ? "var(--fg-3)" : "var(--warn)" }}>{portion ? `porção ${portion}` : "porção não cadastrada"}</div>
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
                      <button onClick={() => setLines((cur) => cur.filter((_, k) => k !== i))} aria-label="Remover" style={{ width: 40, height: 40, borderRadius: 8, flexShrink: 0, background: "transparent", border: "1px solid var(--line)", color: "var(--fg-3)", display: "grid", placeItems: "center" }}><I.X size={14} /></button>
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
            <button onClick={() => setLines((cur) => [...cur, { itemId: "", qty: "" }])} style={{ marginTop: 10, height: 44, width: "100%", borderRadius: 10, background: "transparent", border: "1px dashed var(--line)", color: "var(--fg-2)", fontSize: 13.5, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <I.Plus size={14} />Adicionar transformado
            </button>
          )}
          {multiMissingPortion && (
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--warn)", padding: "8px 12px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 8 }}>
              Vários transformados: todos precisam ter <strong>porção definida</strong> (custo rateado por peso).
            </div>
          )}
          <div style={{ marginTop: 12, fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
            Voltou menos que o enviado? O desperdício fica absorvido no custo da porção (nada vira perda no CMV).
          </div>
        </>
      )}
    </FullSheet>
  );
}

window.MobileProduction = MobileProduction;
