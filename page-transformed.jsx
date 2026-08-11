// Transformados · componentes embutidos no módulo Produção (page-production.jsx)
// Desde 2026-07-12 NÃO é mais módulo próprio: catálogo (stock_items com
// item_kind='transformed'), receitas de produção (templates de lote) e análises
// (custo da porção, aproveitamento %, desperdício) viraram abas da Produção.
// Spec: PRD-PRODUCAO-E-DISTRIBUICAO.md §5.

const _trFmtBRL = (v) =>
  "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const _trParseNum = (raw) => {
  if (raw == null) return 0;
  const s = String(raw).trim().replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

// Rótulo da porção ("100 g", "1,2 kg")
function _trPortionLabel(item) {
  if (!item || item.portionQty == null) return "—";
  const q = Number(item.portionQty);
  const unit = item.portionUnit || "kg";
  return unit === "kg" && q < 1
    ? `${(q * 1000).toLocaleString("pt-BR")} g`
    : `${q.toLocaleString("pt-BR")} ${unit}`;
}

// ---------------------------------------------------------------------
// Modal de transformado (criar/editar) — cria stock_items item_kind='transformed'
// ---------------------------------------------------------------------
function TransformedItemModal({ tid, categories, initial, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name || "");
  const [catId, setCatId] = useState(initial?.catId || "");
  // Porção exibida em g ou kg; persistida como portion_qty + portion_unit
  const initPortion = initial?.portionQty != null
    ? (initial.portionUnit === "g" ? initial.portionQty : initial.portionQty * 1000)
    : "";
  const [portionG, setPortionG] = useState(initPortion !== "" ? String(initPortion).replace(".", ",") : "");
  const [reorder, setReorder] = useState(initial?.reorder ? String(initial.reorder).replace(".", ",") : "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [saving, setSaving] = useState(false); // guard de duplo-clique

  const portionGN = _trParseNum(portionG);
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
        reorder: _trParseNum(reorder) || 0,
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
        window.showToast?.(`"${data?.name || name}" criado — produza pelo módulo Produção`, { tone: "ok" });
      }
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro ao salvar: ${e.message || e}`, { tone: "crit", ttl: 6000 });
      setSaving(false);
    }
  };

  return (
    <Modal
      title={initial ? `Editar ${initial.name}` : "Novo transformado"}
      subtitle="O transformado entra no estoque em porções (un). O custo vem das ordens de produção."
      width={480}
      onClose={saving ? undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={save} disabled={saving || !canSave}>
            {saving ? "Carregando…" : (initial ? "Salvar" : "Criar transformado")}
          </button>
        </>
      )}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <FormRow label="Nome">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder='Ex.: "Calabresa porcionada 100g"' autoFocus />
        </FormRow>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormRow label="Peso da porção (g)" hint="Usado no aproveitamento % e no rateio de custo em ordens com várias saídas.">
            <input className="input" value={portionG} onChange={(e) => setPortionG(e.target.value)} placeholder="100" inputMode="decimal" />
          </FormRow>
          <FormRow label="Estoque mínimo (porções)">
            <input className="input" value={reorder} onChange={(e) => setReorder(e.target.value)} placeholder="0" inputMode="decimal" />
          </FormRow>
        </div>
        <FormRow label="Categoria">
          <select className="select" value={catId} onChange={(e) => setCatId(e.target.value)}>
            <option value="">Sem categoria</option>
            {(categories || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </FormRow>
        <FormRow label="Observações">
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
        </FormRow>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Modal de receita de produção (template de lote)
// ---------------------------------------------------------------------
function ProductionRecipeModal({ tid, stockItems, initial, onClose, onSaved }) {
  // Combobox com busca — mesmo componente do modal de Requisições. Lido do
  // window aqui dentro (lazy) porque page-requests.jsx carrega DEPOIS deste
  // arquivo: referência solta no topo do módulo daria ReferenceError.
  const StockItemPicker = window.StockItemPicker;
  const rawItems = (stockItems || []).filter((i) => i.itemKind !== "transformed");
  const transformedItems = (stockItems || []).filter((i) => i.itemKind === "transformed");
  const byId = {};
  (stockItems || []).forEach((i) => { byId[i.id] = i; });

  const [name, setName] = useState(initial?.name || "");
  const [inputs, setInputs] = useState(
    initial?.inputs?.length
      ? initial.inputs.map((l) => ({ itemId: l.itemId, qty: String(l.qty).replace(".", ",") }))
      : [{ itemId: "", qty: "" }]
  );
  const [outputs, setOutputs] = useState(
    initial?.outputs?.length
      ? initial.outputs.map((l) => ({ itemId: l.itemId, expectedQty: l.expectedQty != null ? String(l.expectedQty) : "" }))
      : [{ itemId: "", expectedQty: "" }]
  );
  const [notes, setNotes] = useState(initial?.notes || "");
  const [saving, setSaving] = useState(false);

  const validInputs = inputs
    .map((l) => ({ item: byId[l.itemId], qtyN: _trParseNum(l.qty) }))
    .filter((l) => l.item && l.qtyN > 0);
  const validOutputs = outputs
    .map((l) => ({ item: byId[l.itemId], expN: _trParseNum(l.expectedQty) }))
    .filter((l) => l.item);
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

  const lineStyle = { display: "grid", gridTemplateColumns: "1fr 120px 28px", gap: 8, alignItems: "center" };

  return (
    <Modal
      title={initial ? `Editar receita` : "Nova receita de produção"}
      subtitle="Template de lote — pré-preenche ordens de produção. Sem efeito no estoque."
      width={600}
      onClose={saving ? undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={save} disabled={saving || !canSave}>
            {saving ? "Carregando…" : "Salvar receita"}
          </button>
        </>
      )}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <FormRow label="Nome da receita">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder='Ex.: "Porcionamento de calabresa (lote 10kg)"' autoFocus />
        </FormRow>

        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>Insumos do lote</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {inputs.map((l, i) => {
              const item = byId[l.itemId];
              return (
                <div key={i} style={lineStyle}>
                  <StockItemPicker
                    items={rawItems} value={l.itemId}
                    placeholder="Selecione um insumo…"
                    disabledIds={inputs.map((x) => x.itemId).filter(Boolean)}
                    onChange={(id) => setInputs((cur) => cur.map((x, k) => k === i ? { ...x, itemId: id } : x))} />
                  <input className="input" placeholder={`Qtd${item ? ` (${item.unit})` : ""}`} value={l.qty} inputMode="decimal"
                    onChange={(e) => setInputs((cur) => cur.map((x, k) => k === i ? { ...x, qty: e.target.value } : x))} />
                  <button type="button" className="btn" data-variant="ghost" data-size="sm" title="Remover"
                    onClick={() => setInputs((cur) => cur.length > 1 ? cur.filter((_, k) => k !== i) : cur)}>
                    <I.X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
          <button type="button" className="btn" data-size="sm" style={{ marginTop: 8 }}
            onClick={() => setInputs((cur) => [...cur, { itemId: "", qty: "" }])}>
            <I.Plus size={12} /> Adicionar insumo
          </button>
        </div>

        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>Saídas esperadas do lote</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {outputs.map((l, i) => (
              <div key={i} style={lineStyle}>
                <StockItemPicker
                  items={transformedItems} value={l.itemId}
                  placeholder="Selecione um transformado…"
                  emptyLabel="Nenhum transformado encontrado"
                  disabledIds={outputs.map((x) => x.itemId).filter(Boolean)}
                  onChange={(id) => setOutputs((cur) => cur.map((x, k) => k === i ? { ...x, itemId: id } : x))} />
                <input className="input" placeholder="Porções" value={l.expectedQty} inputMode="decimal"
                  onChange={(e) => setOutputs((cur) => cur.map((x, k) => k === i ? { ...x, expectedQty: e.target.value } : x))} />
                <button type="button" className="btn" data-variant="ghost" data-size="sm" title="Remover"
                  onClick={() => setOutputs((cur) => cur.length > 1 ? cur.filter((_, k) => k !== i) : cur)}>
                  <I.X size={11} />
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="btn" data-size="sm" style={{ marginTop: 8 }}
            onClick={() => setOutputs((cur) => [...cur, { itemId: "", expectedQty: "" }])}>
            <I.Plus size={12} /> Adicionar saída
          </button>
        </div>

        <FormRow label="Observações">
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
        </FormRow>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Análises a partir das ordens concluídas
// ---------------------------------------------------------------------
const _TR_PERIODS = [
  { id: "30",  label: "30 dias" },
  { id: "90",  label: "90 dias" },
  { id: "all", label: "Tudo" },
];

function _trAnalytics(orders, periodDays, itemId = null) {
  const cutoff = periodDays === "all" ? null : Date.now() - Number(periodDays) * 86400000;
  const completedAll = (orders || []).filter((o) =>
    o.status === "completed" && (!cutoff || (o.completedAt && new Date(o.completedAt).getTime() >= cutoff)));
  // Filtro por transformado: considera só as ordens que devolveram o item escolhido.
  const completed = itemId
    ? completedAll.filter((o) => (o.outputs || []).some((out) => out.itemId === itemId && out.returnedQty > 0))
    : completedAll;

  const byItem = {};
  let totalCost = 0, totalWaste = 0, wasteCostEst = 0;
  const yields = [];
  for (const o of completed) {
    // Custo total: no modo "todos" é o custo de entrada da ordem; filtrado por um
    // transformado, vira o custo atribuído às porções dele (somado abaixo).
    if (!itemId) totalCost += o.totalInputCost || 0;
    if (o.yieldPct != null) yields.push(o.yieldPct);
    if (o.wasteQty != null) {
      totalWaste += o.wasteQty;
      // Custo do desperdício estimado pelo custo médio por kg de entrada da ordem
      if (o.inputWeight > 0) wasteCostEst += o.wasteQty * ((o.totalInputCost || 0) / o.inputWeight);
    }
    for (const out of o.outputs || []) {
      if (out.returnedQty == null || out.returnedQty <= 0) continue;
      if (itemId && out.itemId !== itemId) continue; // só o transformado selecionado
      const k = out.itemId;
      if (!byItem[k]) byItem[k] = { itemId: k, name: out.name, ordersCount: 0, portions: 0, cost: 0, lastUnitCost: null, lastAt: null };
      byItem[k].ordersCount += 1;
      byItem[k].portions += out.returnedQty;
      byItem[k].cost += out.costShare || 0;
      const at = o.completedAt ? new Date(o.completedAt).getTime() : 0;
      if (byItem[k].lastAt == null || at >= byItem[k].lastAt) {
        byItem[k].lastAt = at;
        byItem[k].lastUnitCost = out.unitCost;
      }
    }
  }
  if (itemId) totalCost = Object.values(byItem).reduce((s, r) => s + r.cost, 0);
  const items = Object.values(byItem).map((r) => ({
    ...r,
    avgUnitCost: r.portions > 0 ? r.cost / r.portions : null,
  })).sort((a, b) => b.cost - a.cost);
  const avgYield = yields.length ? yields.reduce((s, y) => s + y, 0) / yields.length : null;
  return { completedCount: completed.length, totalCost, totalWaste, wasteCostEst, avgYield, items };
}

// Chips de período no padrão do app (botão ativo com bg-3)
function TrPeriodChips({ period, setPeriod }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {_TR_PERIODS.map((p) => (
        <button key={p.id} className="btn" data-size="sm" onClick={() => setPeriod(p.id)}
          style={period === p.id ? { background: "var(--bg-3)", color: "var(--fg-0)", borderColor: "var(--line-strong)" } : undefined}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

function TransformedAnalytics({ orders, stockItems }) {
  const [period, setPeriod] = useState("30");
  const [itemId, setItemId] = useState(""); // "" = todos os transformados
  // Lista de transformados que já tiveram produção concluída (independente do período,
  // pra o seletor não sumir ao trocar de janela).
  const allTransformados = useMemo(() => {
    const m = new Map();
    for (const o of orders || []) {
      if (o.status !== "completed") continue;
      for (const out of o.outputs || []) {
        if (out.returnedQty > 0 && out.itemId && !m.has(out.itemId)) m.set(out.itemId, out.name);
      }
    }
    return [...m.entries()].map(([id, name]) => ({ itemId: id, name })).sort((x, y) => x.name.localeCompare(y.name));
  }, [orders]);
  // Se o item selecionado sair da lista (troca de dados), volta pra "todos".
  const activeItemId = allTransformados.some((t) => t.itemId === itemId) ? itemId : "";
  const a = _trAnalytics(orders, period, activeItemId || null);
  const selectedName = allTransformados.find((t) => t.itemId === activeItemId)?.name || null;

  // Insumo em unidade não-mássica e sem peso cadastrado não entra no peso do
  // lote — e uma única linha assim zera aproveitamento e desperdício da ordem
  // inteira. Aponta quais são, já que o KPI só mostra "—" e não explica.
  const missingWeight = useMemo(() => {
    const byId = new Map((stockItems || []).map((i) => [i.id, i]));
    const m = new Map();
    for (const o of orders || []) {
      if (o.status !== "completed" && o.status !== "issued") continue;
      for (const l of o.inputs || []) {
        const u = String(l.unit || "").toLowerCase();
        if (u === "kg" || u === "g") continue;          // já é peso
        const it = byId.get(l.itemId);
        if (it && it.portionQty > 0) continue;          // peso unitário cadastrado
        if (l.itemId) m.set(l.itemId, it?.name || l.name);
      }
    }
    return [...m.values()];
  }, [orders, stockItems]);

  return (
    <div className="stagger" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Filtro por transformado — escopa KPIs e a tabela. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Transformado
        </span>
        <select className="select" value={activeItemId} onChange={(e) => setItemId(e.target.value)}
          style={{ minWidth: 240, maxWidth: "100%" }}>
          <option value="">Todos os transformados</option>
          {allTransformados.map((t) => (
            <option key={t.itemId} value={t.itemId}>{t.name}</option>
          ))}
        </select>
        {activeItemId && (
          <button className="btn" data-size="sm" onClick={() => setItemId("")}>Limpar filtro</button>
        )}
        {selectedName && (
          <span style={{ fontSize: 12, color: "var(--fg-2)" }}>
            análise apenas de <strong style={{ color: "var(--fg-0)" }}>{selectedName}</strong>
          </span>
        )}
      </div>

      {missingWeight.length > 0 && (
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 14px", borderRadius: 4,
                      background: "var(--warn-soft)", border: "1px solid var(--warn-line)" }}>
          <I.AlertTriangle size={14} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 12, color: "var(--fg-1)", lineHeight: 1.55 }}>
            <strong>Desperdício não pode ser calculado</strong> enquanto houver insumo sem peso.
            Estes estão cadastrados em unidade e não têm peso por unidade:{" "}
            <strong style={{ color: "var(--fg-0)" }}>{missingWeight.join(", ")}</strong>.
            <div style={{ marginTop: 4, color: "var(--fg-2)" }}>
              Preencha <strong>Peso por unidade</strong> no cadastro de cada um, em <strong>Estoque</strong>.
              O desperdício é peso enviado − peso devolvido, então uma linha sem peso zera a conta do lote inteiro.
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
        <div className="kpi">
          <span className="label">Produções concluídas</span>
          <span className="value">{a.completedCount}</span>
          <span className="delta">{_TR_PERIODS.find((p) => p.id === period)?.label?.toLowerCase()}</span>
        </div>
        <div className="kpi">
          <span className="label">Custo produzido</span>
          <span className="value">{_trFmtBRL(a.totalCost)}</span>
          <span className="delta">convertido em porções</span>
        </div>
        <div className="kpi">
          <span className="label">Aproveitamento médio</span>
          <span className="value" style={a.avgYield != null && a.avgYield < 90 ? { color: "var(--warn)" } : undefined}>
            {a.avgYield != null ? `${a.avgYield.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : "—"}
          </span>
          <span className="delta">peso devolvido ÷ peso enviado</span>
        </div>
        <div className="kpi">
          <span className="label">Desperdício</span>
          <span className="value" style={a.totalWaste > 0 ? { color: "var(--warn)" } : undefined}>
            {a.totalWaste > 0 ? `${a.totalWaste.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} kg` : "—"}
          </span>
          <span className="delta" data-tone={a.totalWaste > 0 ? "warn" : undefined}>
            {a.totalWaste > 0 ? `≈ ${_trFmtBRL(a.wasteCostEst)} absorvidos no custo` : "sem desperdício no período"}
          </span>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Por transformado</h3>
            <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
              custo médio e último custo da porção · base: devoluções concluídas
            </span>
          </div>
          <TrPeriodChips period={period} setPeriod={setPeriod} />
        </div>
        {a.items.length === 0 ? (
          <div className="card-body" style={{ padding: "36px 20px", textAlign: "center", fontSize: 12.5, color: "var(--fg-3)" }}>
            Nenhuma produção concluída no período — as análises aparecem após a primeira devolução lançada.
          </div>
        ) : (
          <table className="table" data-density="compact">
            <thead>
              <tr>
                <th>Transformado</th>
                <th className="num">Produções</th>
                <th className="num">Porções devolvidas</th>
                <th className="num">Custo total</th>
                <th className="num">Custo médio/porção</th>
                <th className="num">Último custo/porção</th>
              </tr>
            </thead>
            <tbody>
              {a.items.map((r) => (
                <tr key={r.itemId}>
                  <td className="row-strong">{r.name}</td>
                  <td className="num">{r.ordersCount}</td>
                  <td className="num">{r.portions.toLocaleString("pt-BR")}</td>
                  <td className="num">{_trFmtBRL(r.cost)}</td>
                  <td className="num">{r.avgUnitCost != null ? _trFmtBRL(r.avgUnitCost) : "—"}</td>
                  <td className="num">{r.lastUnitCost != null ? _trFmtBRL(r.lastUnitCost) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Consumo por tenant (só central): transferências recebidas pela rede,
// agregadas por tenant × transformado. Fase D do PRD.
// ---------------------------------------------------------------------
function TransformedByTenant({ tid, transfers }) {
  const [period, setPeriod] = useState("30");
  const cutoff = period === "all" ? null : Date.now() - Number(period) * 86400000;

  const rows = {};
  for (const t of transfers || []) {
    if (t.fromTenantId !== tid || t.status !== "received") continue;
    if (cutoff && (!t.receivedAt || new Date(t.receivedAt).getTime() < cutoff)) continue;
    for (const it of t.items || []) {
      if (it.itemKind !== "transformed") continue;
      const k = `${t.toTenantId}|${it.fromItemId || it.name}`;
      if (!rows[k]) rows[k] = { tenant: t.toName || "—", item: it.name, unit: it.unit, qty: 0, value: 0 };
      rows[k].qty += it.qty;
      rows[k].value += it.qty * it.unitCost;
    }
  }
  const list = Object.values(rows).sort((a, b) => b.value - a.value);
  const totalValue = list.reduce((s, r) => s + r.value, 0);

  return (
    <div className="stagger" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Consumo por tenant</h3>
            <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
              transformados enviados pela rede (a custo) · {_trFmtBRL(totalValue)} no período
            </span>
          </div>
          <TrPeriodChips period={period} setPeriod={setPeriod} />
        </div>
        {list.length === 0 ? (
          <div className="card-body" style={{ padding: "36px 20px", textAlign: "center", fontSize: 12.5, color: "var(--fg-3)" }}>
            Nenhum transformado transferido para a rede no período.
          </div>
        ) : (
          <table className="table" data-density="compact">
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Transformado</th>
                <th className="num">Porções</th>
                <th className="num">Valor (a custo)</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={i}>
                  <td className="row-strong">{r.tenant}</td>
                  <td className="dim">{r.item}</td>
                  <td className="num">{r.qty.toLocaleString("pt-BR")}</td>
                  <td className="num">{_trFmtBRL(r.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Catálogo de transformados (embutido na aba "Transformados" do módulo
// Produção — fusão pedida pelo usuário em 2026-07-12)
// ---------------------------------------------------------------------
function TransformedCatalog({ tid, stockItems, categories, orders, onChanged }) {
  const [itemModal, setItemModal] = useState(null); // null | 'new' | item
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const transformedItems = (stockItems || []).filter((i) => i.itemKind === "transformed");

  // Última produção concluída por transformado
  const lastProdByItem = {};
  for (const o of orders || []) {
    if (o.status !== "completed" || !o.completedAt) continue;
    for (const out of o.outputs || []) {
      // Saída esperada que não voltou fica gravada com returned 0 — não é produção
      if (!(out.returnedQty > 0)) continue;
      const at = new Date(o.completedAt).getTime();
      if (!lastProdByItem[out.itemId] || at > lastProdByItem[out.itemId]) lastProdByItem[out.itemId] = at;
    }
  }

  const doConfirm = async () => {
    if (busy || !confirm) return;
    setBusy(true);
    try {
      const { error } = await dbDeleteStockItem(confirm.id);
      if (error) throw error;
      window.showToast?.("Transformado desativado", { tone: "ok" });
      setConfirm(null);
      await onChanged();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
    }
    setBusy(false);
  };

  return (
    <div className="stagger" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Catálogo de transformados</h3>
            <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
              {transformedItems.length} {transformedItems.length === 1 ? "item ativo" : "itens ativos"} · o custo da porção vem da última devolução da produção
            </span>
          </div>
          <button className="btn" data-variant="primary" data-size="sm" onClick={() => setItemModal("new")}>
            <I.Plus size={12} /> Novo transformado
          </button>
        </div>
        {transformedItems.length === 0 ? (
          <div className="card-body" style={{ padding: "40px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 6 }}>Nenhum transformado cadastrado.</div>
            <div style={{ fontSize: 12, color: "var(--fg-3)", maxWidth: 480, margin: "0 auto", lineHeight: 1.6 }}>
              Cadastre aqui o que a produção devolve porcionado (ex.: "Calabresa porcionada 100g") — as ordens de saída ficam na aba Ordens.
            </div>
          </div>
        ) : (
          <table className="table" data-density="compact">
            <thead>
              <tr>
                <th>Transformado</th>
                <th>Categoria</th>
                <th className="num">Porção</th>
                <th className="num">Custo/porção</th>
                <th className="num">Em estoque</th>
                <th>Última produção</th>
                <th style={{ width: 78 }}></th>
              </tr>
            </thead>
            <tbody>
              {transformedItems.map((it) => (
                <tr key={it.id}>
                  <td className="row-strong">{it.name}</td>
                  <td className="dim">{it.cat}</td>
                  <td className="num">
                    {it.portionQty != null
                      ? <span className="badge" data-tone="neutral" data-flat>{_trPortionLabel(it)}</span>
                      : <span style={{ color: "var(--fg-4)" }}>—</span>}
                  </td>
                  <td className="num">{it.cost > 0 ? _trFmtBRL(it.cost) : "—"}</td>
                  <td className="num" style={it.status === "crit" ? { color: "var(--crit)" } : it.status === "warn" ? { color: "var(--warn)" } : undefined}>
                    {it.qty.toLocaleString("pt-BR")} un
                  </td>
                  <td className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>
                    {lastProdByItem[it.id] ? new Date(lastProdByItem[it.id]).toLocaleDateString("pt-BR") : "—"}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="btn" data-variant="ghost" data-size="sm" title="Editar" onClick={() => setItemModal(it)}><I.Edit size={12} /></button>
                    <button className="btn" data-variant="ghost" data-size="sm" title="Desativar" onClick={() => setConfirm(it)}><I.Trash size={12} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {itemModal && (
        <TransformedItemModal
          tid={tid} categories={categories}
          initial={itemModal === "new" ? null : itemModal}
          onClose={() => setItemModal(null)}
          onSaved={async () => { setItemModal(null); await onChanged(); }}
        />
      )}

      <ConfirmDialog
        open={!!confirm}
        title="Desativar transformado"
        message={confirm ? `Desativar "${confirm.name}"? O item some das listas, mas o histórico de movimentações é preservado.` : ""}
        confirmLabel="Desativar"
        busy={busy}
        onConfirm={doConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------
// Receitas de produção (embutido na aba "Receitas" do módulo Produção)
// ---------------------------------------------------------------------
function ProductionRecipesPanel({ tid, stockItems, recipes, onChanged }) {
  const [recipeModal, setRecipeModal] = useState(null); // null | 'new' | recipe
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const itemNameById = {};
  (stockItems || []).forEach((i) => { itemNameById[i.id] = i.name; });

  const doConfirm = async () => {
    if (busy || !confirm) return;
    setBusy(true);
    try {
      const { error } = await dbDeleteProductionRecipe(confirm.id);
      if (error) throw error;
      window.showToast?.("Receita excluída", { tone: "ok" });
      setConfirm(null);
      await onChanged();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
    }
    setBusy(false);
  };

  return (
    <div className="stagger" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Receitas de produção</h3>
            <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
              templates de lote (insumos → porções esperadas) que pré-preenchem as ordens de saída
            </span>
          </div>
          <button className="btn" data-variant="primary" data-size="sm" onClick={() => setRecipeModal("new")}>
            <I.Plus size={12} /> Nova receita
          </button>
        </div>
        {(recipes || []).length === 0 ? (
          <div className="card-body" style={{ padding: "40px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 6 }}>Nenhuma receita de produção.</div>
            <div style={{ fontSize: 12, color: "var(--fg-3)", maxWidth: 480, margin: "0 auto", lineHeight: 1.6 }}>
              Ex.: "Porcionamento de calabresa (lote 10 kg)" — ao criar a ordem de saída, escolha a receita e os insumos entram preenchidos.
            </div>
          </div>
        ) : (
          <table className="table" data-density="compact">
            <thead>
              <tr>
                <th>Receita</th>
                <th>Insumos</th>
                <th>Saídas esperadas</th>
                <th style={{ width: 78 }}></th>
              </tr>
            </thead>
            <tbody>
              {recipes.map((r) => (
                <tr key={r.id}>
                  <td className="row-strong">{r.name}</td>
                  <td className="dim">{r.inputs.map((l) => `${itemNameById[l.itemId] || "?"} (${l.qty.toLocaleString("pt-BR")} ${l.unit})`).join(", ")}</td>
                  <td className="dim">{r.outputs.map((l) => `${itemNameById[l.itemId] || "?"}${l.expectedQty ? ` · ${l.expectedQty.toLocaleString("pt-BR")} porções` : ""}`).join(", ")}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="btn" data-variant="ghost" data-size="sm" title="Editar" onClick={() => setRecipeModal(r)}><I.Edit size={12} /></button>
                    <button className="btn" data-variant="ghost" data-size="sm" title="Excluir" onClick={() => setConfirm(r)}><I.Trash size={12} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {recipeModal && (
        <ProductionRecipeModal
          tid={tid} stockItems={stockItems}
          initial={recipeModal === "new" ? null : recipeModal}
          onClose={() => setRecipeModal(null)}
          onSaved={async () => { setRecipeModal(null); await onChanged(); }}
        />
      )}

      <ConfirmDialog
        open={!!confirm}
        title="Excluir receita"
        message={confirm ? `Excluir a receita "${confirm.name}"?` : ""}
        confirmLabel="Excluir"
        busy={busy}
        onConfirm={doConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

// Componentes consumidos pelo módulo Produção (page-production.jsx) — o
// Transformados deixou de ser módulo próprio em 2026-07-12 e virou abas lá.
Object.assign(window, {
  TransformedCatalog, ProductionRecipesPanel, TransformedAnalytics, TransformedByTenant,
  TransformedItemModal, ProductionRecipeModal,
});
