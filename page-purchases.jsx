// Compras — painel central de listas de compras + recebimentos.
//
// Modelo de dados (separação clara · pensado para escalar com backend):
//
//  PurchaseList (pedido) — snapshot imutável de itens no momento da geração.
//    Status: open · partial · received · closed
//    Items:  { id, stock_item_id, name, supplier, category, qty, unit, est_unit_cost, est_cost }
//
//  GoodsReceipt (recebimento) — entrada física no estoque, referencia uma list_id
//    + um supplier. Várias podem existir p/ a mesma lista (parcial).
//    Items:  { id, list_item_id, name, qty_ordered, qty_received, unit, unit_cost,
//              line_cost, divergent, divergence_reason }
//
// Fluxo:
//   Listar listas → Abrir lista → Receber Mercadoria por fornecedor →
//     Modal de Recebimento (edita qty, adiciona/remove, divergências) →
//     Confirma → cria GoodsReceipt + atualiza status da lista
//
// Lista permanece intocada — só o status agregado muda.

const _fmtBRLp = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _fmtBRLshortP = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const _isoDateBR = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};
const _isoTimeBR = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const _dayKey = (iso) => window.spDay(iso); // YYYY-MM-DD no fuso de SP
// Parser BR-safe: aceita "8,50", "1.234,56", "8.5" e devolve Number.
// Sem isso, `Number("8,50")` vira NaN e o unit_cost some antes do stock_movements.
// Parse "68,31" → 68.31, "68.31" → 68.31, "1.234,56" → 1234.56, "1,234.56" → 1234.56.
// Bug anterior fazia replace(/\./g, "") cego achando que todo ponto era milhar;
// quando o operador digitava "68.31" virava 6831 e estoque/CMV iam pro espaço.
// Regra atual: o ÚLTIMO `.` ou `,` é o decimal; tudo antes dele são milhares.
const _parseBR = (raw) => {
  if (raw === "" || raw === null || raw === undefined) return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  let s = String(raw).trim().replace(/\s+/g, "");
  if (!s) return 0;
  const decPos = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  if (decPos >= 0) {
    s = s.slice(0, decPos).replace(/[.,]/g, "") + "." + s.slice(decPos + 1);
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

function Purchases() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  // Quando online, inicia vazio pra evitar flash de MOCK; offline usa MOCK como demo
  const [lists,    setLists]    = useState(() => dbStatus.isOnline ? [] : (MOCK.SHOPPING_LISTS || []));
  const [receipts, setReceipts] = useState(() => dbStatus.isOnline ? [] : (MOCK.GOODS_RECEIPTS || []));
  const [stockItems, setStockItems] = useState(() => dbStatus.isOnline ? [] : (MOCK.STOCK_ITEMS || []));
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource]     = useState(dbStatus.isOnline ? "db" : "mock");
  const [pageLoading, setPageLoading] = useState(true);
  const [selectedListId, setSelectedListId] = useState(null);
  const [viewingSavedListId, setViewingSavedListId] = useState(null); // snapshot tipo Shopping
  const [confirmDeleteId,    setConfirmDeleteId]    = useState(null);
  const [receiving,   setReceiving]   = useState(null); // { listId, supplier }
  const [viewingOrig, setViewingOrig] = useState(null); // { listId, supplier? } — null=todos
  const [tab,         setTab]         = useState("saved"); // saved | suggestion

  // Carrega listas + recebimentos do DB
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
        const [listsRes, receiptsRes, stockRes] = await Promise.all([
          dbListPurchaseOrders(tid),
          dbListGoodsReceipts(tid),
          dbListStockItems(tid),
        ]);
        if (cancelled) return;
        if (listsRes.source === "db") {
          setLists(listsRes.data || []);
          setSource("db");
        }
        if (receiptsRes.source === "db") {
          setReceipts(receiptsRes.data || []);
        }
        if (stockRes.source === "db") {
          setStockItems(stockRes.data || []);
        }
      } finally {
        if (!cancelled) setPageLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  const selectedList = lists.find((l) => l.id === selectedListId) || null;

  // ===== Modelos derivados =====
  // Status por (lista, fornecedor) com base nos recebimentos existentes
  const supplierStatusFor = (list, supplier) => {
    const rs = receipts.filter((r) => r.list_id === list.id && r.supplier === supplier);
    if (rs.length === 0) return "pending";
    // soma qty recebida + flag divergente por list_item_id
    const receivedByItem = {};
    const divergentByItem = {};
    rs.forEach((r) => r.items.forEach((it) => {
      if (!it.list_item_id) return;
      receivedByItem[it.list_item_id] = (receivedByItem[it.list_item_id] || 0) + (it.qty_received || 0);
      if (it.divergent) divergentByItem[it.list_item_id] = true;
    }));
    const itensFornecedor = list.items.filter((li) => li.supplier === supplier);
    // Item é dado por encerrado quando: qty recebida ≥ pedida OU já foi recebido
    // com divergência (operador acusou que aquela quantidade é a final).
    const allClosed = itensFornecedor.every((li) =>
      (receivedByItem[li.id] || 0) >= li.qty || divergentByItem[li.id]
    );
    return allClosed ? "received" : "partial";
  };

  // Status agregado da lista a partir do status de cada fornecedor
  const recomputeListStatus = (list) => {
    const fornecedores = [...new Set(list.items.map((it) => it.supplier))];
    const statuses = fornecedores.map((s) => supplierStatusFor(list, s));
    if (statuses.every((s) => s === "received"))     return "received";
    if (statuses.some((s) => s !== "pending"))       return "partial";
    return "open";
  };

  // ===== Handlers =====
  // Helper: cria uma SHOPPING_LIST a partir de itens já formatados
  const persistList = async ({ items, title, notes }) => {
    if (!items || items.length === 0) {
      window.showToast("Lista vazia · nada para salvar", { tone: "warn" });
      return null;
    }
    // ===== DB path · 1 PO por fornecedor =====
    if (source === "db" && tenantId) {
      // Agrupa items por fornecedor
      const bySupplier = {};
      items.forEach((it) => {
        const sup = it.supplier || "Sem fornecedor cadastrado";
        if (!bySupplier[sup]) bySupplier[sup] = [];
        bySupplier[sup].push(it);
      });
      const code = `LCO-${Date.now().toString(36).slice(-6).toUpperCase()}`;
      const defaultTitle = `Lista de compras · ${_isoDateBR(new Date().toISOString())}`;
      let firstCreated = null;
      for (const [supplierName, supplierItems] of Object.entries(bySupplier)) {
        const { data, error } = await dbInsertPurchaseOrder(tenantId, {
          code: `${code}-${supplierName.slice(0, 6).toUpperCase().replace(/[^A-Z]/g, "")}`,
          supplier: supplierName,
          status: "draft",
          title: title || notes || defaultTitle,
          items: supplierItems,
        });
        if (error) {
          window.showToast(`Erro ao salvar pra "${supplierName}": ${error.message}`, { tone: "crit", ttl: 4500 });
          continue;
        }
        if (!firstCreated) firstCreated = data;
      }
      // Recarrega tudo
      const { data: refreshed } = await dbListPurchaseOrders(tenantId);
      if (refreshed) setLists(refreshed);
      window.showToast(`Lista ${code} salva no Supabase · ${Object.keys(bySupplier).length} pedido(s) por fornecedor`, { tone: "ok", ttl: 4500 });
      return firstCreated ? { id: firstCreated.id } : null;
    }

    // ===== Fallback MOCK =====
    const nextNum = lists.reduce((max, l) => {
      const n = parseInt(String(l.id).replace(/\D/g, ""), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0) + 1;
    const id = `LCO-${String(nextNum).padStart(4, "0")}`;
    const decoratedItems = items.map((it, i) => ({
      id: it.id || `lci-${String(nextNum).padStart(2, "0")}${String(i).padStart(2, "0")}`,
      stock_item_id: it.stock_item_id,
      name: it.name,
      supplier: it.supplier || "Sem fornecedor cadastrado",
      category: it.category,
      qty: it.qty,
      unit: it.unit,
      est_unit_cost: it.est_unit_cost,
      est_cost: it.est_cost,
    }));
    const newList = {
      id,
      title:    title || `Lista de compras · ${_isoDateBR(new Date().toISOString())}`,
      created_at: new Date().toISOString(),
      created_by: "Rafa Medeiros",
      status:   "open",
      notes:    notes || "Gerada automaticamente a partir do estoque atual",
      items:    decoratedItems,
    };
    setLists((prev) => [newList, ...prev]);
    return newList;
  };

  // Botão "Salvar lista" da aba Nova lista (sugestão editável)
  const handleSaveSuggestion = ({ items, total }) => {
    const newList = persistList({ items });
    if (newList) {
      setSelectedListId(newList.id);
      setTab("saved");
      window.showToast(`Lista ${newList.id} salva · ${items.length} itens · ${("R$ " + (total || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}`,
                       { tone: "ok", ttl: 4000 });
    }
  };

  // Modal de seleção de fornecedores antes de gerar
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);

  // Atalho legado: gera + salva uma lista direto a partir do estoque
  const handleNewListAuto = () => {
    const candidates = stockItems.filter((it) => it.qty < it.reorder);
    if (candidates.length === 0) {
      window.showToast("Sem itens abaixo do mínimo · nada a comprar", { tone: "warn" });
      return;
    }
    // Abre o modal de seleção de fornecedores
    setSupplierPickerOpen(true);
  };

  // Gera de fato a lista filtrando pelos stock_item_ids selecionados no modal
  // Itens sem fornecedor são SEMPRE incluídos (forçados no modal)
  const handleGenerateForItems = (selectedItemIds) => {
    const ids = new Set(selectedItemIds);
    const candidates = stockItems
      .filter((it) => it.qty < it.reorder)
      .filter((it) => ids.has(it.id));
    if (candidates.length === 0) {
      window.showToast("Nenhum item selecionado", { tone: "warn" });
      return;
    }
    const items = candidates.map((it) => {
      const target = it.max && it.max > it.reorder ? it.max : it.reorder * 2;
      const qty = Math.max(0, Number((target - it.qty).toFixed(2)));
      return {
        stock_item_id: it.id,
        name: it.name,
        supplier: it.supplier || "Sem fornecedor cadastrado",
        category: it.cat,
        qty, unit: it.unit,
        est_unit_cost: it.cost,
        est_cost: Number((qty * it.cost).toFixed(2)),
      };
    });
    const supCount = new Set(candidates.map((it) => it.supplier || "Sem fornecedor cadastrado")).size;
    const newList = persistList({ items });
    if (newList) {
      setSelectedListId(newList.id);
      setSupplierPickerOpen(false);
      window.showToast(`Lista ${newList.id} gerada · ${items.length} itens · ${supCount} fornecedor(es)`, { tone: "ok" });
    }
  };

  const handleConfirmReceipt = async (draft) => {
    const list = lists.find((l) => l.id === draft.list_id);
    if (!list) return;

    // Cria a entrada de recebimento
    const nextRecNum = receipts.reduce((max, r) => {
      const n = parseInt(String(r.id).replace(/\D/g, ""), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0) + 1;
    const recId = `REC-${String(nextRecNum).padStart(4, "0")}`;

    const newReceipt = {
      id: recId,
      list_id: draft.list_id,
      supplier: draft.supplier,
      received_at: new Date().toISOString(),
      received_by: draft.received_by || "—",
      nf_number: draft.nf_number || "",
      notes: draft.notes || "",
      items: draft.items.map((it, i) => ({
        id: `rci-${String(nextRecNum).padStart(2, "0")}${String(i).padStart(2, "0")}`,
        list_item_id: it.list_item_id || null,
        name: it.name,
        qty_ordered: Number(it.qty_ordered) || 0,
        qty_received: Number(it.qty_received) || 0,
        unit: it.unit,
        unit_cost: Number(it.unit_cost) || 0,
        line_cost: Number(((Number(it.qty_received) || 0) * (Number(it.unit_cost) || 0)).toFixed(2)),
        divergent: !!it.divergent || (it.list_item_id && Number(it.qty_received) !== Number(it.qty_ordered)) || (!it.list_item_id),
        divergence_reason: it.divergence_reason || (it.list_item_id ? "" : "Item adicionado no recebimento"),
      })),
    };

    // ===== DB path · cria recebimento + dispara movimentos de estoque =====
    if (source === "db" && tenantId) {
      const { data, error } = await dbInsertGoodsReceipt(tenantId, {
        ...newReceipt,
        list_id: draft.list_id, // já é uuid (PO id) quando vem do DB
      });
      if (error) {
        window.showToast(`Erro ao salvar recebimento: ${error.message}`, { tone: "crit", ttl: 4500 });
        return;
      }
      // Usa o código real gerado pelo banco (em vez do recId calculado no cliente)
      const realRecId = data?.code || recId;
      // Recarrega recebimentos (e listas pra recomputar status)
      const [{ data: refreshedReceipts }, { data: refreshedLists }] = await Promise.all([
        dbListGoodsReceipts(tenantId), dbListPurchaseOrders(tenantId),
      ]);
      if (refreshedReceipts) setReceipts(refreshedReceipts);
      if (refreshedLists) setLists(refreshedLists);
      setReceiving(null);
      // Movimentos de estoque (entrada) — cria via DB; trigger atualiza current_qty
      let entered = 0;
      let missed = 0;
      const missedNames = [];
      for (const it of newReceipt.items) {
        const inQty = Number(it.qty_received) || 0;
        if (inQty <= 0) continue;
        // 1) Resolve stock_item_id pela list_item_id
        let stockItemId = null;
        if (it.list_item_id) {
          const li = list.items.find((x) => x.id === it.list_item_id);
          stockItemId = li?.stock_item_id || null;
        }
        // 2) Fallback por nome (item adicionado manualmente no recebimento)
        if (!stockItemId) {
          const match = findStockItemByName(it.name, stockItems);
          if (match) stockItemId = match.id;
        }
        if (!stockItemId) { missed++; missedNames.push(it.name); continue; }
        const { error: mvErr } = await dbApplyStockMovement(
          tenantId,
          stockItemId,
          inQty,
          "in",
          `Recebimento ${realRecId} de ${draft.supplier || "—"}`,
          Number(it.unit_cost) || undefined,
        );
        if (mvErr) { missed++; missedNames.push(it.name); continue; }
        entered++;
      }
      if (entered > 0) {
        const { data: refreshedStock } = await dbListStockItems(tenantId);
        if (refreshedStock) setStockItems(refreshedStock);
      }
      const parts = [
        `Recebimento ${realRecId} salvo`,
        `${entered} insumo(s) atualizado(s) no estoque`,
      ];
      if (missed > 0) parts.push(`${missed} sem match (${missedNames.slice(0, 2).join(", ")}${missed > 2 ? "…" : ""})`);
      window.showToast(parts.join(" · "), {
        tone: missed > 0 ? "warn" : "ok",
        ttl: 4800,
      });
      return;
    }

    // ===== Fallback MOCK =====
    setReceipts((prev) => [newReceipt, ...prev]);

    // Atualiza status da lista (recomputado depois)
    setLists((prev) => prev.map((l) => {
      if (l.id !== draft.list_id) return l;
      // Status será recomputado on render; aqui só marcamos o "tocou"
      return { ...l };
    }));

    setReceiving(null);

    // Entrada automática no estoque · cada item recebido vira movimento "in"
    // com atualização do custo médio ponderado. Quando online, persiste em stock_movements.
    let entered = 0, missed = 0;
    const missedNames = [];
    const dbOn = source === "db" && tenantId;
    for (const it of newReceipt.items) {
      const inQty = Number(it.qty_received) || 0;
      if (inQty <= 0) continue;
      // 1. Resolver via list_item_id → stock_item_id (caso conheçamos a ligação)
      let stockItem = null;
      if (it.list_item_id) {
        const li = list.items.find((x) => x.id === it.list_item_id);
        if (li?.stock_item_id) {
          stockItem = stockItems.find((s) => s.id === li.stock_item_id);
        }
      }
      // 2. Fallback por nome (item adicionado manualmente no recebimento)
      if (!stockItem) stockItem = findStockItemByName(it.name, stockItems);
      if (!stockItem) { missed++; missedNames.push(it.name); continue; }
      if (dbOn) {
        const { error } = await dbApplyStockMovement(
          tenantId, stockItem.id, inQty, "in",
          `receipt:${recId}`, Number(it.unit_cost) || undefined,
        );
        if (error) { missed++; missedNames.push(it.name); continue; }
      }
      applyStockMovement(stockItem, inQty, Number(it.unit_cost) || 0);
      entered++;
    }
    if (dbOn && entered > 0) {
      // Refetch estoque pra refletir custos médios atualizados
      const { data } = await dbListStockItems(tenantId);
      if (data) setStockItems(data);
    }

    const divergCount = newReceipt.items.filter((it) => it.divergent).length;
    const parts = [
      `Recebimento ${recId} confirmado`,
      `${entered} insumo(s) entrou no estoque`,
    ];
    if (divergCount > 0) parts.push(`${divergCount} divergência(s)`);
    if (missed > 0)      parts.push(`${missed} sem match (${missedNames.slice(0, 2).join(", ")}${missed > 2 ? "…" : ""})`);
    window.showToast(parts.join(" · "), {
      tone: (divergCount > 0 || missed > 0) ? "warn" : "ok",
      ttl: 4800,
    });
  };

  // Aplica edições feitas na modal "Editar lista" — patches por item + remoções.
  // changes = { updates: [{ id, qty, est_unit_cost }], deletes: [id] }
  // Retorna { ok: bool, errors: [str] }; o caller é responsável por fechar a modal.
  const handleUpdateListItems = async (listId, changes) => {
    const updates = Array.isArray(changes?.updates) ? changes.updates : [];
    const deletes = Array.isArray(changes?.deletes) ? changes.deletes : [];
    const errors = [];

    if (source === "db") {
      for (const u of updates) {
        const patch = {};
        if (u.qty !== undefined)            patch.qty       = Number(u.qty) || 0;
        if (u.est_unit_cost !== undefined)  patch.unit_cost = Number(u.est_unit_cost) || 0;
        const { error } = await dbUpdatePurchaseOrderItem(u.id, patch);
        if (error) errors.push(`update ${u.id}: ${error.message}`);
      }
      for (const id of deletes) {
        const { error } = await dbDeletePurchaseOrderItem(id);
        if (error) errors.push(`delete ${id}: ${error.message}`);
      }
      // Refetch — assim o agrupamento por PO/lista é recalculado
      const { data: refreshed } = await dbListPurchaseOrders(tenantId);
      if (refreshed) setLists(refreshed);
    } else {
      // MOCK: edita em memória
      setLists((prev) => prev.map((l) => {
        if (l.id !== listId) return l;
        const delSet = new Set(deletes);
        const updMap = new Map(updates.map((u) => [u.id, u]));
        const nextItems = l.items
          .filter((it) => !delSet.has(it.id))
          .map((it) => {
            const u = updMap.get(it.id);
            if (!u) return it;
            const qty = u.qty !== undefined ? Number(u.qty) || 0 : it.qty;
            const cost = u.est_unit_cost !== undefined ? Number(u.est_unit_cost) || 0 : it.est_unit_cost;
            return { ...it, qty, est_unit_cost: cost, est_cost: qty * cost };
          });
        return { ...l, items: nextItems };
      }));
    }

    if (errors.length > 0) {
      window.showToast(`Salvou com erros: ${errors[0]}`, { tone: "crit", ttl: 5000 });
      return { ok: false, errors };
    }
    const summary = [];
    if (updates.length > 0) summary.push(`${updates.length} ajustado(s)`);
    if (deletes.length > 0) summary.push(`${deletes.length} removido(s)`);
    if (summary.length > 0) {
      window.showToast(`Lista atualizada · ${summary.join(" · ")}`, { tone: "ok", ttl: 3500 });
    }
    return { ok: true, errors: [] };
  };

  const handleDeleteList = async (id) => {
    const list = lists.find((l) => l.id === id);
    if (!list) return;
    if (source === "db") {
      // Lista agrupada pode ter múltiplos POs (um por fornecedor) — deleta todos
      const ids = Array.isArray(list._pos) && list._pos.length > 0 ? list._pos : [id];
      for (const poId of ids) {
        const { error } = await dbDeletePurchaseOrder(poId);
        if (error) {
          window.showToast(`Erro ao excluir: ${error.message}`, { tone: "crit", ttl: 4500 });
          return;
        }
      }
    }
    setLists((prev)    => prev.filter((l) => l.id !== id));
    setReceipts((prev) => prev.filter((r) => r.list_id !== id));
    if (selectedListId      === id) setSelectedListId(null);
    if (viewingSavedListId  === id) setViewingSavedListId(null);
    setConfirmDeleteId(null);
    window.showToast(`Lista ${id} excluída`, { tone: "warn", ttl: 3500 });
  };

  const enrichedLists = useMemo(() =>
    lists.map((l) => ({ ...l, computedStatus: recomputeListStatus(l) })),
    [lists, receipts],
  );

  const viewingSavedList = enrichedLists.find((l) => l.id === viewingSavedListId) || null;
  const confirmDeleteList = lists.find((l) => l.id === confirmDeleteId) || null;

  if (pageLoading) return <PageLoading label="Carregando compras…" variant="cards" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {viewingSavedList ? (
        <SavedListView
          list={viewingSavedList}
          stockItems={stockItems}
          onBack={() => setViewingSavedListId(null)}
          onReceive={() => { setSelectedListId(viewingSavedList.id); setViewingSavedListId(null); }}
          onDelete={() => setConfirmDeleteId(viewingSavedList.id)}
          onUpdateItems={(changes) => handleUpdateListItems(viewingSavedList.id, changes)}
        />
      ) : selectedList ? (
        <PurchaseDetailView
          list={enrichedLists.find((l) => l.id === selectedList.id) || selectedList}
          receipts={receipts.filter((r) => r.list_id === selectedList.id)}
          supplierStatusFor={supplierStatusFor}
          onBack={() => setSelectedListId(null)}
          onReceive={(supplier, itemId) => setReceiving({ listId: selectedList.id, supplier, itemId: itemId || null })}
          onViewOriginal={(supplier) => setViewingOrig({ listId: selectedList.id, supplier })}
        />
      ) : (
        <PurchasesShell source={source}
          tab={tab}
          setTab={setTab}
          listsCount={enrichedLists.length}
          onNewAuto={handleNewListAuto}
        >
          {tab === "saved" && (
            <PurchasesListView
              lists={enrichedLists}
              receipts={receipts}
              onView={(id) => setViewingSavedListId(id)}
              onReceive={(id) => setSelectedListId(id)}
              onDelete={(id) => setConfirmDeleteId(id)}
              onSwitchToSuggestion={() => setTab("suggestion")}
            />
          )}
          {tab === "suggestion" && (
            <Shopping embedded onSave={handleSaveSuggestion} stockItems={stockItems} />
          )}
        </PurchasesShell>
      )}

      {receiving && (
        <GoodsReceiptModal
          list={lists.find((l) => l.id === receiving.listId)}
          supplier={receiving.supplier}
          itemId={receiving.itemId}
          receipts={receipts.filter((r) => r.list_id === receiving.listId && r.supplier === receiving.supplier)}
          onCancel={() => setReceiving(null)}
          onConfirm={handleConfirmReceipt}
        />
      )}

      {viewingOrig && (
        <OriginalListModal
          list={lists.find((l) => l.id === viewingOrig.listId)}
          supplier={viewingOrig.supplier}
          onClose={() => setViewingOrig(null)}
        />
      )}

      {confirmDeleteList && (
        <DeleteListConfirm
          list={confirmDeleteList}
          receiptsCount={receipts.filter((r) => r.list_id === confirmDeleteList.id).length}
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => handleDeleteList(confirmDeleteList.id)}
        />
      )}

      {supplierPickerOpen && (
        <SupplierPickerModal
          stockItems={stockItems}
          onCancel={() => setSupplierPickerOpen(false)}
          onConfirm={handleGenerateForItems}
        />
      )}
    </div>
  );
}

// ============ Shell unificado · header + tabs ============
function PurchasesShell({ tab, setTab, listsCount, onNewAuto, children, source }) {
  return (
    <>
      <div style={{ padding: "20px 28px 0", display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div className="h-eyebrow" style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 10 }}>
            Painel central de pedidos e recebimentos
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
          <h1 className="h-title">Compras</h1>
          <p className="h-sub">Pedidos, sugestão automática e recebimentos físicos em um único lugar.</p>
        </div>
        {tab === "saved" && (
          <button className="btn" data-size="sm" onClick={onNewAuto} title="Gera e salva uma lista a partir do estoque atual">
            <I.Plus size={13} />Nova lista (auto)
          </button>
        )}
      </div>

      <div style={{ display: "flex", gap: 0, padding: "16px 28px 0", borderBottom: "1px solid var(--line)" }}>
        <PurchaseTabBtn active={tab === "saved"}      onClick={() => setTab("saved")}>
          Listas salvas <span style={tabCountStyle}>{listsCount}</span>
        </PurchaseTabBtn>
        <PurchaseTabBtn active={tab === "suggestion"} onClick={() => setTab("suggestion")}>
          Nova lista <span style={tabCountStyle}>auto</span>
        </PurchaseTabBtn>
      </div>

      <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </>
  );
}

const tabCountStyle = {
  fontFamily: "var(--mono)", fontSize: 10, padding: "1px 6px",
  background: "var(--bg-3)", color: "var(--fg-3)",
  borderRadius: 99, letterSpacing: "0.04em", marginLeft: 6,
};

function PurchaseTabBtn({ active, onClick, children }) {
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

// ============ MASTER VIEW · listas agrupadas por data ============
function PurchasesListView({ lists, receipts, onView, onReceive, onDelete, onSwitchToSuggestion }) {
  // Agrupa por data (YYYY-MM-DD)
  const byDay = useMemo(() => {
    const groups = {};
    lists.forEach((l) => {
      const k = _dayKey(l.created_at);
      if (!groups[k]) groups[k] = [];
      groups[k].push(l);
    });
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  }, [lists]);

  const totals = useMemo(() => {
    const t = { count: lists.length, value: 0, open: 0, partial: 0, received: 0 };
    lists.forEach((l) => {
      t.value += l.items.reduce((s, it) => s + (it.est_cost || 0), 0);
      t[l.computedStatus] = (t[l.computedStatus] || 0) + 1;
    });
    return t;
  }, [lists]);

  return (
    <>
      <div style={{ padding: "14px 28px 14px", borderBottom: "1px solid var(--line)", display: "flex", gap: 24, flexWrap: "wrap" }}>
        <PStat label="Abertas"        value={totals.open || 0}     tone={totals.open > 0 ? "warn" : "neutral"} />
        <PStat label="Parciais"       value={totals.partial || 0}  tone={totals.partial > 0 ? "info" : "neutral"} />
        <PStat label="Recebidas"      value={totals.received || 0} tone="ok" />
        <span style={{ flex: 1 }} />
        <PStat label="Recebimentos"   value={receipts.length} />
        <PStat label="Total estimado" value={_fmtBRLp(totals.value)} />
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 28px" }}>
        {lists.length === 0 ? (
          <div style={{ textAlign: "center", padding: 64 }}>
            <div className="h-eyebrow" style={{ marginBottom: 8 }}>Nenhuma lista salva ainda</div>
            <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 16 }}>
              Use a aba <strong style={{ color: "var(--fg-0)" }}>Nova lista</strong> para gerar uma sugestão a partir do estoque,
              ajustar os itens e salvar.
            </div>
            <button className="btn" data-variant="primary" data-size="sm" onClick={onSwitchToSuggestion}>
              <I.Plus size={13} />Ir para Nova lista
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {byDay.map(([dayKey, dayLists]) => {
              const totalDay = dayLists.reduce((s, l) => s + l.items.reduce((ss, it) => ss + (it.est_cost || 0), 0), 0);
              return (
                <div key={dayKey}>
                  <div style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "0 4px 8px", borderBottom: "1px solid var(--line-soft)", marginBottom: 10,
                  }}>
                    <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)", fontWeight: 500, letterSpacing: "0.04em" }}>
                      {_isoDateBR(dayKey)}
                    </span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                      {dayLists.length} {dayLists.length === 1 ? "lista" : "listas"}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>{_fmtBRLp(totalDay)}</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {dayLists
                      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
                      .map((l) => (
                        <PurchaseListRow
                          key={l.id}
                          list={l}
                          onView={() => onView(l.id)}
                          onReceive={() => onReceive(l.id)}
                          onDelete={() => onDelete(l.id)}
                        />
                      ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function PurchaseListRow({ list, onView, onReceive, onDelete }) {
  const total = list.items.reduce((s, it) => s + (it.est_cost || 0), 0);
  const suppliers = [...new Set(list.items.map((it) => it.supplier))];
  const status = list.computedStatus || list.status;
  const fullyReceived = status === "received";
  return (
    <div onClick={onView} className="card"
      style={{
        display: "grid",
        gridTemplateColumns: "70px 1fr 160px 110px 100px auto",
        gap: 14, alignItems: "center",
        padding: "14px 16px", textAlign: "left", cursor: "pointer",
      }}>
      <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
        {_isoTimeBR(list.created_at)}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500, letterSpacing: "-0.005em" }}>{list.title}</div>
        {list.notes && (
          <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{list.notes}</div>
        )}
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-2)" }}>
        {suppliers.length} {suppliers.length === 1 ? "fornecedor" : "fornecedores"} · {list.items.length} itens
      </div>
      <span className="mono" style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500, textAlign: "right" }}>{_fmtBRLp(total)}</span>
      <ListStatusBadge status={status} />
      <div style={{ display: "flex", gap: 6, justifySelf: "end" }} onClick={(e) => e.stopPropagation()}>
        <button className="btn" data-size="sm" onClick={onView} title="Ver itens com estoque atual e copiar pedido">
          <I.Eye size={12} />Ver lista
        </button>
        <button className="btn" data-variant="primary" data-size="sm"
                onClick={onReceive} disabled={fullyReceived}
                title={fullyReceived ? "Lista totalmente recebida" : "Receber mercadoria"}>
          <I.Box size={12} />Receber
        </button>
        <button className="btn" data-variant="ghost" data-size="sm"
                onClick={onDelete} title="Excluir lista" style={{ padding: "4px 7px" }}>
          <I.Trash size={12} />
        </button>
      </div>
    </div>
  );
}

function ListStatusBadge({ status }) {
  const map = {
    open:     { label: "Aberta",   tone: "warn" },
    partial:  { label: "Parcial",  tone: "info" },
    received: { label: "Recebida", tone: "ok" },
    closed:   { label: "Fechada",  tone: "neutral" },
  };
  const m = map[status] || map.open;
  return <span className="badge" data-tone={m.tone} style={{ justifySelf: "start" }}>{m.label}</span>;
}

// ============ DETAIL VIEW · uma lista ============
function PurchaseDetailView({ list, receipts, supplierStatusFor, onBack, onReceive, onViewOriginal }) {
  const total = list.items.reduce((s, it) => s + (it.est_cost || 0), 0);
  const suppliers = [...new Set(list.items.map((it) => it.supplier))];

  // Busca dentro da lista: filtra itens por nome ou fornecedor, sem alterar o total.
  const [search, setSearch] = useState("");
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const q = norm(search.trim());
  const itemMatches = (it) =>
    !q || norm(it.name).includes(q) || norm(it.supplier).includes(q) || norm(it.category).includes(q);

  return (
    <>
      <div style={{ padding: "20px 28px 14px", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <button className="btn" data-variant="ghost" data-size="sm" onClick={onBack}>
              <I.Chevron size={11} style={{ transform: "rotate(90deg)" }} />Voltar
            </button>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {_isoDateBR(list.created_at)} {_isoTimeBR(list.created_at)} · {list.created_by}
            </span>
            <ListStatusBadge status={list.computedStatus || list.status} />
          </div>
          <h1 className="h-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>{list.title}</h1>
          {list.notes && <p className="h-sub" style={{ marginTop: 4 }}>{list.notes}</p>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ position: "relative", width: 280 }}>
            <I.Search size={12} style={{
              position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)",
              color: "var(--fg-3)", pointerEvents: "none",
            }} />
            <input
              className="input"
              value={search}
              placeholder="Buscar item ou fornecedor…"
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: "100%", paddingLeft: 28, paddingRight: search ? 28 : 10, fontSize: 12 }}
            />
            {search && (
              <button type="button" onClick={() => setSearch("")} title="Limpar busca"
                      style={{
                        position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                        background: "transparent", border: "none", padding: 4,
                        color: "var(--fg-3)", cursor: "pointer", display: "grid", placeItems: "center",
                      }}>
                <I.X size={11} />
              </button>
            )}
          </div>
          <button className="btn" data-size="sm" onClick={() => onViewOriginal(null)} title="Ver a lista como foi gerada (snapshot)">
            <I.Stock size={12} />Ver lista original
          </button>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <span className="h-eyebrow">Total estimado</span>
            <span className="mono" style={{ fontSize: 22, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.02em" }}>{_fmtBRLp(total)}</span>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "8px 28px 28px", display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Aviso reforçando a separação Pedido vs. Recebimento */}
        <div style={{
          padding: "10px 14px", background: "var(--bg-2)",
          border: "1px solid var(--line)", borderRadius: 4,
          display: "flex", alignItems: "center", gap: 12,
          fontSize: 11.5, color: "var(--fg-2)",
        }}>
          <I.AlertTriangle size={13} style={{ color: "var(--fg-3)" }} />
          <span>
            <strong style={{ color: "var(--fg-0)" }}>Pedido</strong> imutável · cada{" "}
            <strong style={{ color: "var(--fg-0)" }}>Recebimento</strong> registra a entrada física.
            Divergências (qtd ou custo) ficam no histórico do recebimento, sem alterar a lista.
          </span>
        </div>

        {/* Cards por fornecedor — só renderiza fornecedor com itens que casam com a busca */}
        {(() => {
          const visibleCards = suppliers
            .map((sup) => {
              const supItems = list.items.filter((it) => it.supplier === sup && itemMatches(it));
              if (supItems.length === 0) return null;
              const supTotal = supItems.reduce((s, it) => s + (it.est_cost || 0), 0);
              const supReceipts = receipts.filter((r) => r.supplier === sup);
              const status = supplierStatusFor(list, sup);
              return (
                <SupplierGroupCard
                  key={sup}
                  supplier={sup}
                  items={supItems}
                  total={supTotal}
                  status={status}
                  receipts={supReceipts}
                  canReceive={status !== "received"}
                  onReceive={() => onReceive(sup)}
                  onReceiveItem={(itemId) => onReceive(sup, itemId)}
                  onViewOriginal={() => onViewOriginal(sup)}
                />
              );
            })
            .filter(Boolean);
          if (visibleCards.length === 0 && q) {
            return (
              <div style={{ textAlign: "center", padding: 48 }}>
                <div className="h-eyebrow" style={{ marginBottom: 8 }}>Nada encontrado</div>
                <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 14 }}>
                  Nenhum item ou fornecedor casa com <strong style={{ color: "var(--fg-0)" }}>"{search}"</strong>.
                </div>
                <button className="btn" data-size="sm" onClick={() => setSearch("")}>
                  Limpar busca
                </button>
              </div>
            );
          }
          return visibleCards;
        })()}

        {/* Histórico de recebimentos da lista */}
        {receipts.length > 0 && <ReceiptsHistory receipts={receipts} />}
      </div>
    </>
  );
}

function SupplierGroupCard({ supplier, items, total, status, receipts, canReceive, onReceive, onReceiveItem, onViewOriginal }) {
  const supInfo = MOCK.supplierByName ? MOCK.supplierByName(supplier) : null;
  const tone = { pending: "warn", partial: "info", received: "ok" }[status] || "warn";
  const lbl  = { pending: "A receber", partial: "Parcial", received: "Recebido" }[status];

  // Soma qty recebida + flag divergente por list_item_id (todos recebimentos do fornecedor)
  const receivedByItem = useMemo(() => {
    const acc = {};
    receipts.forEach((r) => r.items.forEach((it) => {
      if (!it.list_item_id) return;
      acc[it.list_item_id] = (acc[it.list_item_id] || 0) + (it.qty_received || 0);
    }));
    return acc;
  }, [receipts]);

  const divergentByItem = useMemo(() => {
    const acc = {};
    receipts.forEach((r) => r.items.forEach((it) => {
      if (!it.list_item_id) return;
      if (it.divergent) acc[it.list_item_id] = true;
    }));
    return acc;
  }, [receipts]);

  // Custo real recebido: percorre recebimentos do mais antigo ao mais novo e guarda
  // o último unit_cost por item + soma dos line_cost. Quando há recebimentos, exibimos
  // esses valores em vez do estimado, pra refletir o que foi efetivamente pago.
  const actualByItem = useMemo(() => {
    const acc = {}; // { list_item_id: { lastUnit, totalCost } }
    const sorted = [...receipts].sort((a, b) =>
      String(a.received_at || "").localeCompare(String(b.received_at || ""))
    );
    sorted.forEach((r) => r.items.forEach((it) => {
      if (!it.list_item_id) return;
      const prev = acc[it.list_item_id] || { lastUnit: 0, totalCost: 0 };
      const line = Number(it.line_cost) ||
        ((Number(it.qty_received) || 0) * (Number(it.unit_cost) || 0));
      acc[it.list_item_id] = {
        lastUnit: Number(it.unit_cost) > 0 ? Number(it.unit_cost) : prev.lastUnit,
        totalCost: prev.totalCost + line,
      };
    }));
    return acc;
  }, [receipts]);

  return (
    <div className="card">
      <div className="card-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <I.Truck size={15} style={{ color: tone === "ok" ? "var(--ok)" : "var(--fg-2)", flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <h3 className="card-title" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              {supplier}
              <span className="badge" data-tone={tone}>{lbl}</span>
            </h3>
            <div className="card-sub" style={{ display: "block", marginTop: 3 }}>
              {items.length} {items.length === 1 ? "item" : "itens"}
              {supInfo?.contact ? ` · ${supInfo.contact}` : ""}
              {supInfo?.lead ? ` · lead ${supInfo.lead}` : ""}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span className="mono" style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 500, marginRight: 4 }}>{_fmtBRLp(total)}</span>
          {onViewOriginal && (
            <button className="btn" data-size="sm" onClick={onViewOriginal} title="Ver itens como foram pedidos (snapshot)">
              Ver original
            </button>
          )}
          <button className="btn" data-variant="primary" data-size="sm" onClick={onReceive} disabled={!canReceive}
                  title={canReceive ? "Registrar recebimento físico" : "Todos os itens já recebidos"}>
            <I.Box size={12} />Receber Mercadoria
          </button>
        </div>
      </div>
      <table className="table" data-density="compact">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Pedido</th>
            <th className="num">Recebido</th>
            <th className="num">Custo unit.</th>
            <th className="num">Custo composto</th>
            <th>Status</th>
            <th style={{ width: 110 }} />
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const recQty = receivedByItem[it.id] || 0;
            // Divergência confirmada (operador acusou no recebimento) encerra o item,
            // mesmo se qty < pedida ou qty = 0 ("não veio do fornecedor"). Bate com a
            // regra de supplierStatusFor logo acima: presença do recebimento divergente
            // = item fechado, não fica eternamente "A receber".
            const closedByDiverg = !!divergentByItem[it.id];
            const itemStatus = (recQty >= it.qty || closedByDiverg) ? "received"
              : recQty > 0 ? "partial"
              : "pending";
            const itemTone = { pending: "warn", partial: "info", received: "ok" }[itemStatus];
            // "Não veio" distingue cancelamento (qty=0 + diverg) de recebimento normal —
            // mesmo status "received" no fluxo, mas label e cor diferentes pra o operador.
            const isNotComing = itemStatus === "received" && closedByDiverg && recQty <= 0;
            const itemLbl = isNotComing ? "Não veio"
              : { pending: "A receber", partial: "Parcial", received: "OK" }[itemStatus];
            const itemLblTone = isNotComing ? "warn" : itemTone;
            const canReceiveItem = itemStatus !== "received";
            // Quando já houve recebimento, exibe o custo efetivo (último unitário + soma
            // recebida); senão, mostra a estimativa original da lista em tom dim.
            const actual = actualByItem[it.id];
            const displayUnit  = actual ? actual.lastUnit  : it.est_unit_cost;
            const displayTotal = actual ? actual.totalCost : it.est_cost;
            return (
              <tr key={it.id}>
                <td className="row-strong">{it.name}</td>
                <td className="num">{it.qty} {it.unit}</td>
                <td className="num" style={{ color: itemStatus === "received" ? "var(--ok)" : "var(--fg-1)" }}>
                  {recQty > 0 ? `${Number(recQty.toFixed(2))} ${it.unit}` : "—"}
                </td>
                <td className="num" style={actual ? null : { color: "var(--fg-3)" }}
                    title={actual ? "Custo unitário do último recebimento" : "Custo estimado (sem recebimento ainda)"}>
                  {_fmtBRLp(displayUnit)}
                </td>
                <td className="num" style={actual ? null : { color: "var(--fg-3)" }}
                    title={actual ? "Custo efetivo somando todos os recebimentos" : "Custo composto estimado"}>
                  {_fmtBRLp(displayTotal)}
                </td>
                <td><span className="badge" data-tone={itemLblTone}>{itemLbl}</span></td>
                <td style={{ textAlign: "right" }}>
                  {onReceiveItem && canReceiveItem && (
                    <button
                      type="button"
                      className="btn"
                      data-size="sm"
                      onClick={() => onReceiveItem(it.id)}
                      title="Receber apenas este item"
                    >
                      <I.Box size={11} />Receber
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReceiptsHistory({ receipts }) {
  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Histórico de recebimentos</h3>
        <span className="card-sub">{receipts.length} {receipts.length === 1 ? "recebimento" : "recebimentos"}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {receipts
          .slice()
          .sort((a, b) => (b.received_at || "").localeCompare(a.received_at || ""))
          .map((r, idx) => {
            const totalRec = r.items.reduce((s, it) => s + (it.line_cost || 0), 0);
            const divCount = r.items.filter((it) => it.divergent).length;
            return (
              <div key={r.id} style={{
                display: "grid",
                gridTemplateColumns: "1fr 90px 110px 100px",
                gap: 12, alignItems: "center",
                padding: "12px 16px",
                borderBottom: idx < receipts.length - 1 ? "1px solid var(--line-soft)" : "none",
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500 }}>
                    {r.supplier}{r.nf_number ? ` · ${r.nf_number}` : ""}
                  </div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", marginTop: 2 }}>
                    {_isoDateBR(r.received_at)} {_isoTimeBR(r.received_at)} · {r.received_by}
                    {r.notes ? ` · ${r.notes}` : ""}
                  </div>
                </div>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)", textAlign: "right" }}>
                  {r.items.length} itens
                </span>
                <span style={{ display: "flex", justifyContent: "center" }}>
                  {divCount > 0
                    ? <span className="badge" data-tone="warn">{divCount} divergência(s)</span>
                    : <span className="badge" data-tone="ok">sem divergência</span>}
                </span>
                <span className="mono" style={{ fontSize: 12, color: "var(--fg-0)", fontWeight: 500, textAlign: "right" }}>
                  {_fmtBRLp(totalRec)}
                </span>
              </div>
            );
          })}
      </div>
    </div>
  );
}

// ============ Modal de Recebimento de Mercadoria ============
// Quando `itemId` vem preenchido, o modal abre em modo "single item" — útil
// pra confirmar chegada parcial de um insumo sem mexer no resto da solicitação.
function GoodsReceiptModal({ list, supplier, itemId, receipts, onCancel, onConfirm }) {
  if (!list) return null;

  // Itens do fornecedor pendentes (qty - já recebido)
  const receivedByItem = useMemo(() => {
    const acc = {};
    receipts.forEach((r) => r.items.forEach((it) => {
      if (!it.list_item_id) return;
      acc[it.list_item_id] = (acc[it.list_item_id] || 0) + (it.qty_received || 0);
    }));
    return acc;
  }, [receipts]);

  const singleMode = !!itemId;
  const supItems = list.items.filter((it) =>
    it.supplier === supplier && (!singleMode || it.id === itemId)
  );

  // Linhas iniciais: cada item da lista, com qty_received = pendente; manuais com list_item_id null.
  // Fonte da verdade agora é (qty_received, line_total). unit_cost = line_total / qty_received
  // é derivado — usuário digita o total da NF e o sistema calcula o unitário.
  const [lines, setLines] = useState(() =>
    supItems.map((it) => {
      const remaining = Math.max(0, Number((it.qty - (receivedByItem[it.id] || 0)).toFixed(2)));
      const qty = remaining > 0 ? remaining : it.qty;
      const estUnit = Number(it.est_unit_cost) || 0;
      return {
        list_item_id: it.id,
        name: it.name,
        unit: it.unit,
        qty_ordered: it.qty,
        qty_received: qty,
        // line_total pré-preenchido com a estimativa pra não obrigar o operador a redigitar
        line_total: Number((qty * estUnit).toFixed(2)),
        divergent: false,
        divergence_reason: "",
      };
    })
  );

  const [nf,    setNf]    = useState("");
  const [by,    setBy]    = useState("");
  const [notes, setNotes] = useState("");
  // Guarda contra double-submit: `onConfirm` é async (insert no Supabase) e o
  // modal só fecha quando o pai chama setReceiving(null). Sem isso, dois cliques
  // rápidos no botão geram dois GoodsReceipts.
  const [submitting, setSubmitting] = useState(false);

  // Padrão "limpa-no-foco, restaura-no-blur": clicar no campo apaga o valor pra
  // o operador digitar direto; se ele sair sem digitar nada, o valor anterior volta.
  const focusBackup = useRef({});
  const onFocusClear = (i, key, currentValue) => {
    focusBackup.current[`${i}_${key}`] = currentValue;
    setLine(i, key, "");
  };
  const onBlurRestore = (i, key) => {
    const k = `${i}_${key}`;
    const saved = focusBackup.current[k];
    delete focusBackup.current[k];
    // Lê o valor atual da fonte da verdade (state) — `lines` é o snapshot do render.
    const curr = lines[i] ? lines[i][key] : "";
    if (saved !== undefined && (curr === "" || curr === null || curr === undefined)) {
      setLine(i, key, saved);
    }
  };

  // unit_cost derivado: total / qty. Trata divisão por zero.
  const unitCostOf = (ln) => {
    const q = _parseBR(ln.qty_received);
    const t = _parseBR(ln.line_total);
    return q > 0 ? t / q : 0;
  };

  // Auto-flag de divergência: qtd recebida ≠ pedida (manual sempre diverg.)
  const lineWithDiverg = (ln) => {
    if (!ln.list_item_id) return true;
    return _parseBR(ln.qty_received) !== _parseBR(ln.qty_ordered);
  };

  const setLine = (i, key, value) => {
    setLines((prev) => prev.map((ln, j) => {
      if (j !== i) return ln;
      const next = { ...ln, [key]: value };
      if (key === "qty_received") {
        next.divergent = lineWithDiverg(next);
        // qty=0 num item do pedido = "esse item não veio do fornecedor".
        // Zera o total (não faz sentido total>0 com qty=0) e auto-sugere a
        // razão se ainda vazia, pra confirmar com 1 clique sem ambiguidade.
        if (_parseBR(value) === 0 && next.list_item_id) {
          next.line_total = 0;
          if (!String(next.divergence_reason || "").trim()) {
            next.divergence_reason = "Não veio do fornecedor";
          }
        }
      }
      return next;
    }));
  };

  const removeLine = (i) => setLines((prev) => prev.filter((_, j) => j !== i));

  const addManualLine = () => {
    setLines((prev) => [...prev, {
      list_item_id: null,
      name: "",
      unit: "und",
      qty_ordered: 0,
      qty_received: 0,
      line_total: 0,
      divergent: true,
      divergence_reason: "Item adicionado no recebimento",
    }]);
  };

  const totalReceived = lines.reduce((s, ln) => s + _parseBR(ln.line_total), 0);
  const divergentCount = lines.filter((ln) => ln.divergent).length;
  // Linhas recebidas com Total = 0 (qty>0 e total<=0) → o `unit_cost` registrado no
  // stock_movements vai ficar NULL e o custo do insumo no estoque não será atualizado.
  // Aviso amarelo sem bloquear (operador pode confirmar — ex.: cortesia/brinde).
  const zeroCostLines = lines.filter((ln) =>
    _parseBR(ln.qty_received) > 0 && _parseBR(ln.line_total) <= 0
  );
  const zeroCostCount = zeroCostLines.length;
  const zeroCostNames = zeroCostLines.map((ln) => ln.name).slice(0, 3).join(", ");
  const validLines = lines.filter((ln) => ln.name.trim() && _parseBR(ln.qty_received) >= 0);
  // Divergência não bloqueia mais o envio — só sugere observação em amarelo.
  // `notesSuggested` é só pra UX visual (warn), não entra no `valid`.
  const hasNotes = notes.trim().length > 0;
  const notesSuggested = divergentCount > 0 && !hasNotes;
  const valid = validLines.length > 0;

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm({
        list_id: list.id,
        supplier,
        received_by: by.trim() || "—",
        nf_number: nf.trim(),
        notes: notes.trim(),
        items: validLines.map((ln) => {
          const qty = _parseBR(ln.qty_received);
          const total = _parseBR(ln.line_total);
          const unitCost = qty > 0 ? Number((total / qty).toFixed(4)) : 0;
          return {
            list_item_id: ln.list_item_id,
            name: ln.name.trim(),
            unit: ln.unit,
            qty_ordered: _parseBR(ln.qty_ordered),
            qty_received: qty,
            unit_cost: unitCost,
            divergent: ln.divergent || lineWithDiverg(ln),
            divergence_reason: ln.divergence_reason,
          };
        }),
      });
    } finally {
      // Em caso de sucesso o pai já fecha o modal (setReceiving(null)) — esse
      // setState fica sem efeito. Em caso de erro/modal preservado, libera o botão.
      setSubmitting(false);
    }
  };

  const supInfo = MOCK.supplierByName ? MOCK.supplierByName(supplier) : null;

  return (
    <Modal
      title={singleMode
        ? `Receber item · ${supItems[0]?.name || supplier}`
        : `Receber mercadoria · ${supplier}`}
      subtitle={singleMode
        ? `${supplier} · ${list.id} · ${list.title}`
        : `${list.id} · ${list.title}${supInfo?.lead ? ` · lead ${supInfo.lead}` : ""}`}
      onClose={onCancel}
      width={840}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", gap: 12 }}>
          <span style={{
            fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.6,
            color: (divergentCount > 0 || zeroCostCount > 0) ? "var(--warn)" : "var(--fg-3)",
            display: "flex", flexDirection: "column",
          }}>
            <span>
              {notesSuggested
                ? `${divergentCount} divergência(s) · considere descrever nas observações`
                : divergentCount > 0
                  ? `${divergentCount} divergência(s) será(ão) registrada(s)`
                  : "Sem divergências detectadas"}
            </span>
            {zeroCostCount > 0 && (
              <span title={`Sem custo: ${zeroCostNames}${zeroCostCount > 3 ? "…" : ""}`}>
                ⚠ {zeroCostCount} {zeroCostCount === 1 ? "item sem custo" : "itens sem custo"} · estoque não terá custo atualizado
              </span>
            )}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" data-size="sm" onClick={onCancel} disabled={submitting}>Cancelar</button>
            <button className="btn" data-variant="primary" data-size="sm" onClick={submit} disabled={!valid || submitting}>
              <I.Check size={11} />{submitting ? "Salvando…" : "Confirmar recebimento"}
            </button>
          </div>
        </div>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 14 }}>
        <FormRow label="NF / Documento">
          <input className="input mono" value={nf} onChange={(e) => setNf(e.target.value)} placeholder="Ex.: NF 12345" />
        </FormRow>
        <FormRow label="Recebido por">
          <input className="input" value={by} onChange={(e) => setBy(e.target.value)} placeholder="Quem confere a mercadoria" />
        </FormRow>
        <FormRow label="Total recebido (R$)">
          <div style={{
            padding: "6px 10px", background: "var(--bg-2)", border: "1px solid var(--line)",
            borderRadius: 4, fontFamily: "var(--mono)", fontSize: 13, color: "var(--accent-bright)",
            fontWeight: 500, textAlign: "right",
          }}>
            {_fmtBRLp(totalReceived)}
          </div>
        </FormRow>
      </div>

      <div className="h-eyebrow" style={{ marginBottom: 8 }}>Itens recebidos · {lines.length}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {/* Header da grade */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "1.5fr 75px 75px 50px 100px 90px 32px",
          gap: 8, alignItems: "center",
          padding: "0 4px",
          fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)",
          letterSpacing: "0.08em", textTransform: "uppercase",
        }}>
          <span>Item</span>
          <span style={{ textAlign: "right" }}>Pedido</span>
          <span style={{ textAlign: "right" }}>Recebido</span>
          <span>Un.</span>
          <span style={{ textAlign: "right" }}>Total (R$)</span>
          <span style={{ textAlign: "right" }}>Custo unit.</span>
          <span />
        </div>

        {lines.map((ln, i) => {
          const isManual = !ln.list_item_id;
          const isDiverg = ln.divergent || lineWithDiverg(ln);
          const calcUnit = unitCostOf(ln);
          // qty=0 num item do pedido = "não veio do fornecedor" (cancela a linha
          // pra fechar o recebimento sem virar entrada de estoque).
          const isNotComing = !isManual && _parseBR(ln.qty_received) === 0;
          return (
            <div key={i} style={{
              display: "grid",
              gridTemplateColumns: "1.5fr 75px 75px 50px 100px 90px 32px",
              gap: 8, alignItems: "center",
              padding: "4px 0",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <input
                  className="input"
                  value={ln.name}
                  placeholder={isManual ? "Insumo (manual)" : ""}
                  onChange={(e) => setLine(i, "name", e.target.value)}
                  readOnly={!isManual}
                  style={{
                    flex: 1, minWidth: 0,
                    ...(!isManual ? { background: "var(--bg-2)", color: "var(--fg-1)" } : null),
                    ...(isNotComing ? { textDecoration: "line-through", opacity: 0.7 } : null),
                  }}
                />
                {isNotComing && (
                  <span title="Item marcado como não enviado pelo fornecedor (qty 0)" style={{
                    flexShrink: 0,
                    fontFamily: "var(--mono)", fontSize: 9, fontWeight: 500,
                    color: "var(--warn)", letterSpacing: "0.06em", textTransform: "uppercase",
                    padding: "2px 6px",
                    background: "var(--warn-soft)", border: "1px solid var(--warn-line)",
                    borderRadius: 99, whiteSpace: "nowrap",
                  }}>não veio</span>
                )}
              </div>
              <input
                className="input mono" inputMode="decimal"
                value={ln.qty_ordered}
                readOnly={!isManual}
                tabIndex={!isManual ? -1 : undefined}
                onChange={(e) => setLine(i, "qty_ordered", e.target.value)}
                title={!isManual ? "Quantidade pedida (snapshot do pedido — não editável)" : ""}
                style={{
                  textAlign: "right",
                  ...(!isManual ? {
                    background: "var(--bg-2)", color: "var(--fg-2)",
                    cursor: "default", borderColor: "var(--line-soft)",
                  } : null),
                }}
              />
              <input
                className="input mono" inputMode="decimal"
                style={{ textAlign: "right", color: isDiverg ? "var(--warn)" : "var(--fg-0)", fontWeight: 500 }}
                value={ln.qty_received}
                onChange={(e) => setLine(i, "qty_received", e.target.value)}
                onFocus={() => onFocusClear(i, "qty_received", ln.qty_received)}
                onBlur={() => onBlurRestore(i, "qty_received")}
              />
              <input
                className="input mono"
                value={ln.unit}
                onChange={(e) => setLine(i, "unit", e.target.value)}
                readOnly={!isManual}
                tabIndex={!isManual ? -1 : undefined}
                style={{
                  textAlign: "center",
                  ...(!isManual ? {
                    background: "var(--bg-2)", color: "var(--fg-2)",
                    cursor: "default", borderColor: "var(--line-soft)",
                  } : null),
                }}
              />
              {(() => {
                const isZeroCost = _parseBR(ln.qty_received) > 0 && _parseBR(ln.line_total) <= 0;
                return (
                  <input
                    className="input mono" inputMode="decimal"
                    style={{ textAlign: "right", ...(isZeroCost ? { borderColor: "var(--warn)" } : null) }}
                    value={ln.line_total}
                    onChange={(e) => setLine(i, "line_total", e.target.value)}
                    onFocus={() => onFocusClear(i, "line_total", ln.line_total)}
                    onBlur={() => onBlurRestore(i, "line_total")}
                    placeholder="0,00"
                    title={isZeroCost ? "Sem valor — o estoque não vai receber custo atualizado" : ""}
                  />
                );
              })()}
              <div
                className="mono"
                title="Calculado automaticamente: Total ÷ Recebido"
                style={{
                  textAlign: "right", padding: "6px 10px",
                  background: "var(--bg-2)", border: "1px solid var(--line)",
                  borderRadius: 4, fontSize: 12, color: "var(--fg-2)",
                }}
              >
                {_fmtBRLp(calcUnit)}
              </div>
              {!singleMode && (
                <button type="button" className="btn" data-variant="ghost" data-size="sm"
                        onClick={() => removeLine(i)} title="Remover item" style={{ padding: "4px 6px" }}>
                  <I.X size={11} />
                </button>
              )}
              {singleMode && <span />}

            </div>
          );
        })}

        {!singleMode && (
          <button type="button" className="btn" data-variant="ghost" data-size="sm"
                  onClick={addManualLine}
                  style={{ alignSelf: "flex-start", marginTop: 6 }}>
            <I.Plus size={11} />Adicionar item (manual)
          </button>
        )}
      </div>

      <FormRow
        label={notesSuggested ? "Observações · recomendado (há divergências)" : "Observações"}
        hint={notesSuggested
          ? "Há divergências de quantidade — descreva o motivo se for relevante."
          : "Ex.: produto substituto, condição da entrega, atraso etc."}
      >
        <input className="input"
               value={notes}
               onChange={(e) => setNotes(e.target.value)}
               style={notesSuggested ? { borderColor: "var(--warn)" } : null}
               placeholder={notesSuggested ? "Ex.: vieram 3 un em vez de 2 (cortesia do fornecedor)" : ""} />
      </FormRow>
    </Modal>
  );
}

// ============ Modal · ver lista original (snapshot read-only) ============
// Mostra os itens como foram gerados, sem mistura com recebimentos.
// Se supplier for null, mostra todos os fornecedores da lista.
function OriginalListModal({ list, supplier, onClose }) {
  if (!list) return null;
  const filtered = supplier ? list.items.filter((it) => it.supplier === supplier) : list.items;
  const groups = useMemo(() => {
    const g = {};
    filtered.forEach((it) => {
      if (!g[it.supplier]) g[it.supplier] = [];
      g[it.supplier].push(it);
    });
    return Object.entries(g);
  }, [filtered]);

  const total = filtered.reduce((s, it) => s + (it.est_cost || 0), 0);

  return (
    <Modal
      title={supplier ? `Lista original · ${supplier}` : "Lista original (todos fornecedores)"}
      subtitle={`${list.id} · ${_isoDateBR(list.created_at)} ${_isoTimeBR(list.created_at)} · ${filtered.length} ${filtered.length === 1 ? "item" : "itens"}`}
      onClose={onClose}
      width={680}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-3)" }}>
            Snapshot imutável · diferente do recebimento físico
          </span>
          <button className="btn" data-variant="primary" data-size="sm" onClick={onClose}>Fechar</button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {groups.map(([supName, items]) => {
          const supInfo = MOCK.supplierByName ? MOCK.supplierByName(supName) : null;
          const supTotal = items.reduce((s, it) => s + (it.est_cost || 0), 0);
          return (
            <div key={supName} style={{
              background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4, overflow: "hidden",
            }}>
              <div style={{
                padding: "10px 14px",
                display: "flex", alignItems: "center", gap: 10,
                borderBottom: "1px solid var(--line-soft)",
              }}>
                <I.Truck size={13} style={{ color: "var(--fg-2)" }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg-0)" }}>{supName}</div>
                  {supInfo && (
                    <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", marginTop: 2 }}>
                      {supInfo.contact}{supInfo.lead ? ` · lead ${supInfo.lead}` : ""}
                    </div>
                  )}
                </div>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }}>{_fmtBRLp(supTotal)}</span>
              </div>
              <table className="table" data-density="compact">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Qtd</th>
                    <th>Un.</th>
                    <th className="num">Custo unit.</th>
                    <th className="num">Custo composto</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.id}>
                      <td className="row-strong">{it.name}</td>
                      <td className="num">{it.qty}</td>
                      <td className="dim">{it.unit}</td>
                      <td className="num">{_fmtBRLp(it.est_unit_cost)}</td>
                      <td className="num">{_fmtBRLp(it.est_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
        <div style={{
          padding: "10px 14px", display: "flex", justifyContent: "space-between",
          alignItems: "center", background: "linear-gradient(180deg, rgba(45,140,102,0.08), transparent)",
          border: "1px solid var(--accent-line)", borderRadius: 4,
        }}>
          <span className="h-eyebrow">Σ Total da lista</span>
          <span className="mono" style={{ fontSize: 18, fontWeight: 500, color: "var(--accent-bright)", letterSpacing: "-0.018em" }}>
            {_fmtBRLp(total)}
          </span>
        </div>
      </div>
    </Modal>
  );
}

// ============ SAVED LIST VIEW · snapshot estilo Shopping (mín/máx + copiar) ============
// Mostra os itens da lista salva com referência ao estoque atual (qty, mín, máx).
// Permite copiar p/ WhatsApp (full ou por fornecedor) e atalhos pra Receber/Excluir.
function SavedListView({ list, onBack, onReceive, onDelete, onUpdateItems, stockItems = MOCK.STOCK_ITEMS || [] }) {
  const total = list.items.reduce((s, it) => s + (it.est_cost || 0), 0);
  const status = list.computedStatus || list.status;
  const fullyReceived = status === "received";

  // Cruza com estoque atual via stock_item_id
  const stockBy = useMemo(() => {
    const m = {};
    (stockItems || []).forEach((it) => { m[it.id] = it; });
    return m;
  }, [stockItems]);

  const itemsEnriched = useMemo(() => list.items.map((it) => {
    const stock = stockBy[it.stock_item_id];
    return {
      ...it,
      currentQty: stock?.qty,
      reorder:    stock?.reorder,
      max:        stock?.max,
      stockUnit:  stock?.unit,
      isCritical: stock ? (stock.qty <= 0 || (stock.reorder > 0 && stock.qty < stock.reorder * 0.25)) : false,
    };
  }), [list, stockBy]);

  const bySupplier = useMemo(() => {
    const g = {};
    itemsEnriched.forEach((it) => {
      const k = it.supplier || "Sem fornecedor cadastrado";
      if (!g[k]) g[k] = [];
      g[k].push(it);
    });
    return Object.entries(g).sort(([a], [b]) => {
      if (a === "Sem fornecedor cadastrado") return 1;
      if (b === "Sem fornecedor cadastrado") return -1;
      return a.localeCompare(b);
    });
  }, [itemsEnriched]);

  const criticalCount = itemsEnriched.filter((it) => it.isCritical).length;

  const copyToClipboard = async (text, successMsg) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        window.showToast(successMsg, { tone: "ok", ttl: 4000 });
        return;
      }
      throw new Error();
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); window.showToast(successMsg, { tone: "ok", ttl: 4000 }); }
      catch { window.showToast("Não foi possível copiar", { tone: "crit" }); }
      document.body.removeChild(ta);
    }
  };

  const buildSupplierText = (supName, items) => {
    const today = new Date(list.created_at).toLocaleDateString("pt-BR");
    const lines = [];
    lines.push(`*🛒 Lista de compras · ${supName}*`);
    lines.push(`_${today} · ${list.id}_`);
    lines.push("");
    items.forEach((it) => {
      const flag = it.isCritical ? " ⚠️" : "";
      lines.push(`• ${it.name} — ${it.qty} ${it.unit}${flag}`);
    });
    lines.push("");
    lines.push("_Por favor enviar cotação._");
    return lines.join("\n");
  };

  const buildFullText = () => {
    const today = new Date(list.created_at).toLocaleDateString("pt-BR");
    const lines = [];
    lines.push(`*🛒 Lista de compras · ${today}*`);
    lines.push(`_${list.id}_`);
    lines.push("");
    bySupplier.forEach(([supName, items]) => {
      const supInfo = MOCK.supplierByName ? MOCK.supplierByName(supName) : null;
      lines.push(`*${supName}*${supInfo?.lead ? ` _(lead ${supInfo.lead})_` : ""}`);
      items.forEach((it) => {
        const flag = it.isCritical ? " ⚠️" : "";
        lines.push(`• ${it.name} — ${it.qty} ${it.unit}${flag}`);
      });
      lines.push("");
    });
    if (criticalCount > 0) {
      lines.push(`⚠️ ${criticalCount} ${criticalCount === 1 ? "item crítico" : "itens críticos"}`);
      lines.push("");
    }
    lines.push("_Por favor enviar cotação._");
    return lines.join("\n");
  };

  const copyFull = () => copyToClipboard(buildFullText(), `Lista ${list.id} copiada · ${list.items.length} itens`);
  const copySupplier = (supName, items) =>
    copyToClipboard(buildSupplierText(supName, items), `${supName} copiada · ${items.length} itens`);

  return (
    <>
      <div style={{ padding: "20px 28px 14px", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
            <button className="btn" data-variant="ghost" data-size="sm" onClick={onBack}>
              <I.Chevron size={11} style={{ transform: "rotate(90deg)" }} />Voltar
            </button>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {list.id} · {_isoDateBR(list.created_at)} {_isoTimeBR(list.created_at)} · {list.created_by}
            </span>
            <ListStatusBadge status={status} />
          </div>
          <h1 className="h-title">{list.title}</h1>
          {list.notes && <p className="h-sub" style={{ marginTop: 4 }}>{list.notes}</p>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <button className="btn" data-variant="ghost" data-size="sm" onClick={onDelete} title="Excluir lista">
            <I.Trash size={12} />Excluir
          </button>
          <button className="btn" data-size="sm" onClick={copyFull}
                  title="Copia toda a lista para o WhatsApp (sem custos)">
            <I.WhatsApp size={13} />Copiar lista
          </button>
          <button className="btn" data-size="sm" onClick={() => printShoppingList(list, bySupplier)}
                  title="Imprime a lista (todos os fornecedores)">
            Imprimir
          </button>
          <button className="btn" data-variant="primary" data-size="sm"
                  onClick={onReceive} disabled={fullyReceived}
                  title={fullyReceived ? "Lista totalmente recebida" : "Registrar recebimento físico"}>
            <I.Box size={12} />Receber mercadoria
          </button>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, marginLeft: 4 }}>
            <span className="h-eyebrow">Total estimado</span>
            <span className="mono" style={{ fontSize: 22, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.02em" }}>{_fmtBRLp(total)}</span>
          </div>
        </div>
      </div>

      <div style={{ padding: "0 28px 14px", borderBottom: "1px solid var(--line)", display: "flex", gap: 16, flexWrap: "wrap" }}>
        <PStat label="Itens" value={list.items.length} />
        <PStat label="Fornecedores" value={bySupplier.length} />
        <PStat label="Críticos / ruptura" value={criticalCount} tone={criticalCount > 0 ? "crit" : "ok"} />
        <span style={{ flex: 1 }} />
        <PStat label="Custo estimado" value={_fmtBRLp(total)} />
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "18px 28px 28px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{
          padding: "10px 14px", background: "var(--bg-2)",
          border: "1px solid var(--line)", borderRadius: 4,
          display: "flex", alignItems: "center", gap: 12,
          fontSize: 11.5, color: "var(--fg-2)",
        }}>
          <I.AlertTriangle size={13} style={{ color: "var(--fg-3)" }} />
          <span>
            <strong style={{ color: "var(--fg-0)" }}>Snapshot do pedido</strong> · quantidades fixas no momento da geração.{" "}
            <strong style={{ color: "var(--fg-0)" }}>Atual / Mín / Máx</strong> refletem o estoque agora — apenas referência.
          </span>
        </div>

        <SupplierCardsGrid
          list={list}
          bySupplier={bySupplier}
          total={total}
          onCopy={copySupplier}
          onPrint={(items, supName) => printShoppingList(list, [[supName, items]], { single: true })}
          onUpdateItems={onUpdateItems}
        />
      </div>
    </>
  );
}

// ============ Modal · confirmação de exclusão ============
function DeleteListConfirm({ list, receiptsCount, onCancel, onConfirm }) {
  return (
    <Modal
      title="Excluir lista de compras?"
      subtitle={`${list.id} · ${list.title}`}
      onClose={onCancel}
      width={460}
      footer={<>
        <button className="btn" data-size="sm" onClick={onCancel}>Cancelar</button>
        <button className="btn" data-size="sm" onClick={onConfirm}
                style={{ background: "var(--crit)", borderColor: "var(--crit)", color: "#fff" }}>
          <I.Trash size={11} />Excluir lista
        </button>
      </>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ fontSize: 13, color: "var(--fg-1)", margin: 0, lineHeight: 1.5 }}>
          Remove permanentemente a lista <strong style={{ color: "var(--fg-0)" }}>{list.id}</strong> com{" "}
          <strong style={{ color: "var(--fg-0)" }}>{list.items.length}</strong>{" "}
          {list.items.length === 1 ? "item" : "itens"}.
        </p>
        {receiptsCount > 0 && (
          <div style={{
            padding: "10px 12px", background: "var(--bg-2)",
            border: "1px solid var(--warn)", borderRadius: 4,
            display: "flex", alignItems: "flex-start", gap: 10,
            fontSize: 12, color: "var(--fg-1)",
          }}>
            <I.AlertTriangle size={13} style={{ color: "var(--warn)", marginTop: 1, flexShrink: 0 }} />
            <span>
              Esta lista possui <strong style={{ color: "var(--fg-0)" }}>{receiptsCount}</strong>{" "}
              {receiptsCount === 1 ? "recebimento" : "recebimentos"} associado{receiptsCount === 1 ? "" : "s"} —
              também serão excluídos.
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}

function PStat({ label, value, tone }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</span>
      <span className="mono" style={{
        fontSize: 16, fontWeight: 500,
        color: tone === "crit" ? "var(--crit)"
             : tone === "warn" ? "var(--warn)"
             : tone === "ok"   ? "var(--ok)"
             : tone === "info" ? "var(--info)"
             : "var(--fg-0)",
      }}>{value}</span>
    </div>
  );
}

// ===================== Grid de fornecedores estilo inventário =====================
function SupplierCardsGrid({ list, bySupplier, total, onCopy, onPrint, onUpdateItems }) {
  const [editing, setEditing] = useState(null); // supplier name sendo editado (abre modal)

  const editingEntry = editing ? bySupplier.find(([n]) => n === editing) : null;

  return (
    <>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 12,
      }}>
        {bySupplier.map(([supName, items]) => {
          const supTotal = items.reduce((s, it) => s + (it.est_cost || 0), 0);
          const groupCritical = items.some((it) => it.isCritical);
          const pct = total > 0 ? Math.round((supTotal / total) * 100) : 0;
          return (
            <div key={supName} style={{
              padding: "16px 16px 14px",
              background: "var(--bg-1)",
              border: `1px solid ${groupCritical ? "var(--crit-line)" : "var(--line)"}`,
              borderRadius: 6,
              display: "flex", flexDirection: "column", gap: 10,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                    <I.Truck size={13} style={{ color: groupCritical ? "var(--crit)" : "var(--fg-2)", flexShrink: 0 }} />
                    <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {supName}
                    </div>
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                    {items.length} {items.length === 1 ? "item" : "itens"}
                    {groupCritical && <span style={{ color: "var(--crit)", marginLeft: 6 }}>· crítico</span>}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <span className="mono" style={{ fontSize: 18, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.02em" }}>
                  {_fmtBRLp(supTotal)}
                </span>
                <span style={{ fontSize: 10, color: "var(--fg-3)" }}>{pct}% da lista</span>
              </div>

              <div className="bar" style={{ height: 3 }}>
                <i style={{ width: `${pct}%`, background: groupCritical ? "var(--crit)" : "var(--accent-bright)" }} />
              </div>

              {/* Itens inline · sempre visíveis */}
              <div style={{
                display: "flex", flexDirection: "column", gap: 4,
                padding: "8px 0 2px",
                borderTop: "1px solid var(--line-soft)",
                fontSize: 11,
                maxHeight: 240, overflowY: "auto",
              }}>
                {items.map((s) => (
                  <div key={s.id} style={{
                    display: "grid", gridTemplateColumns: "1fr auto",
                    gap: 6, alignItems: "baseline",
                    padding: "3px 2px",
                  }}>
                    <span style={{
                      color: s.isCritical ? "var(--crit)" : "var(--fg-1)",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }} title={s.name}>{s.name}</span>
                    <span className="mono" style={{ color: "var(--accent-bright)", fontSize: 11, whiteSpace: "nowrap" }}>
                      {s.qty} {s.unit}
                    </span>
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                <button className="btn" data-size="sm" style={{ flex: 1 }}
                        onClick={() => setEditing(supName)}
                        title="Editar quantidades e remover itens com comparativo de estoque">
                  <I.Edit size={11} />Editar lista
                </button>
                <button className="btn" data-size="sm" title="Copiar para WhatsApp"
                        onClick={() => onCopy(supName, items)}>
                  <I.WhatsApp size={12} />
                </button>
                <button className="btn" data-size="sm" title="Imprimir"
                        onClick={() => onPrint(items, supName)}>
                  ⎙
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {editingEntry && (
        <EditListModal
          supplierName={editingEntry[0]}
          items={editingEntry[1]}
          onClose={() => setEditing(null)}
          onSave={async (changes) => {
            if (!onUpdateItems) { setEditing(null); return; }
            const res = await onUpdateItems(changes);
            if (res?.ok !== false) setEditing(null);
          }}
        />
      )}
    </>
  );
}

// ===================== Modal "Editar lista" =====================
// Mostra todos os itens de um fornecedor com estoque atual / mín / máx
// ao lado da quantidade pedida (editável). Permite remover itens.
// Persiste via callback onSave({ updates: [{id, qty}], deletes: [id] }).
function EditListModal({ supplierName, items, onClose, onSave }) {
  // Estado local: clones dos itens + ids marcados pra remover
  const [drafts, setDrafts]   = useState(() => items.map((it) => ({
    id: it.id,
    qty: String(it.qty ?? ""),
    name: it.name,
    unit: it.unit,
    stock_item_id: it.stock_item_id,
    est_unit_cost: it.est_unit_cost,
    currentQty: it.currentQty,
    reorder: it.reorder,
    max: it.max,
    stockUnit: it.stockUnit,
    isCritical: it.isCritical,
  })));
  const [removed, setRemoved] = useState(() => new Set());
  const [saving, setSaving]   = useState(false);

  const visibleDrafts = drafts.filter((d) => !removed.has(d.id));
  const total = visibleDrafts.reduce((s, d) =>
    s + ((Number(d.qty) || 0) * (Number(d.est_unit_cost) || 0)), 0);

  // Diff vs estado original (items)
  const originalById = useMemo(() => {
    const m = new Map();
    items.forEach((it) => m.set(it.id, it));
    return m;
  }, [items]);

  const updates = drafts
    .filter((d) => !removed.has(d.id))
    .filter((d) => {
      const orig = originalById.get(d.id);
      if (!orig) return false;
      const qNew = Number(d.qty) || 0;
      const qOld = Number(orig.qty) || 0;
      return qNew !== qOld;
    })
    .map((d) => ({ id: d.id, qty: Number(d.qty) || 0 }));
  const deletes = Array.from(removed);
  const dirty = updates.length > 0 || deletes.length > 0;

  const setQty = (id, value) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, qty: value } : d)));
  };

  const toggleRemoved = (id) => {
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try { await onSave({ updates, deletes }); }
    finally { setSaving(false); }
  };

  return (
    <Modal
      title={`Editar lista · ${supplierName}`}
      subtitle={`${visibleDrafts.length} ${visibleDrafts.length === 1 ? "item" : "itens"} · ${_fmtBRLp(total)}`}
      onClose={onClose}
      width={820}
      footer={<>
        <button className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
        <button className="btn" data-size="sm" data-variant="primary"
                onClick={submit} disabled={!dirty || saving}>
          {saving ? "Salvando…" : (dirty ? `Salvar (${updates.length + deletes.length})` : "Sem alterações")}
        </button>
      </>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{
          padding: "9px 12px", background: "var(--bg-2)",
          border: "1px solid var(--line)", borderRadius: 4,
          display: "flex", alignItems: "center", gap: 10,
          fontSize: 11.5, color: "var(--fg-2)",
        }}>
          <I.AlertTriangle size={12} style={{ color: "var(--fg-3)", flexShrink: 0 }} />
          <span>
            Ajuste as quantidades a comprar comparando com o estoque{" "}
            <strong style={{ color: "var(--fg-0)" }}>Atual / Mín / Máx</strong>. Itens removidos
            só são gravados ao clicar em <strong style={{ color: "var(--fg-0)" }}>Salvar</strong>.
          </span>
        </div>

        <table className="table" data-density="compact">
          <thead>
            <tr>
              <th style={{ width: "36%" }}>Insumo</th>
              <th className="num">Atual</th>
              <th className="num">Mín</th>
              <th className="num">Máx</th>
              <th className="num" style={{ width: 140 }}>Comprar</th>
              <th className="num">Custo unit.</th>
              <th className="num">Custo composto</th>
              <th style={{ width: 36 }}></th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((d) => {
              const isRemoved = removed.has(d.id);
              const qtyNum = Number(d.qty) || 0;
              const lineCost = qtyNum * (Number(d.est_unit_cost) || 0);
              const currentTone = d.currentQty == null
                ? "var(--fg-3)"
                : (d.currentQty <= 0 ? "var(--crit)" : "var(--fg-1)");
              return (
                <tr key={d.id} style={{
                  opacity: isRemoved ? 0.45 : 1,
                  textDecoration: isRemoved ? "line-through" : "none",
                }}>
                  <td className="row-strong">
                    <div>{d.name}</div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.04em", textTransform: "uppercase", marginTop: 2 }}>
                      {d.stock_item_id || "—"}
                      {d.isCritical ? <span style={{ color: "var(--crit)", marginLeft: 6 }}>· ruptura</span> : null}
                    </div>
                  </td>
                  <td className="num" style={{ color: currentTone }}>
                    {d.currentQty == null ? "—" : `${d.currentQty} ${d.stockUnit || d.unit}`}
                  </td>
                  <td className="num" style={{ color: "var(--fg-2)" }}>{d.reorder ?? "—"}</td>
                  <td className="num" style={{ color: "var(--fg-2)" }}>{d.max ?? "—"}</td>
                  <td className="num">
                    <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                      <input
                        type="number" step="any" min="0"
                        value={d.qty}
                        disabled={isRemoved}
                        onChange={(e) => setQty(d.id, e.target.value)}
                        style={{
                          width: 70, textAlign: "right",
                          background: "var(--bg-2)", border: "1px solid var(--line)",
                          borderRadius: 3, padding: "3px 6px",
                          color: "var(--accent-bright)", fontFamily: "var(--mono)",
                          fontSize: 11.5,
                        }}
                      />
                      <span style={{ fontSize: 10.5, color: "var(--fg-3)", minWidth: 24, textAlign: "left" }}>{d.unit}</span>
                    </div>
                  </td>
                  <td className="num">{_fmtBRLp(d.est_unit_cost)}</td>
                  <td className="num">{_fmtBRLp(lineCost)}</td>
                  <td className="num">
                    <button
                      className="btn" data-size="sm" data-variant="ghost"
                      onClick={() => toggleRemoved(d.id)}
                      title={isRemoved ? "Desfazer remoção" : "Remover item"}
                      style={isRemoved ? { color: "var(--warn)" } : { color: "var(--crit)" }}
                    >
                      {isRemoved ? "↺" : <I.Trash size={11} />}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

// ===================== Imprimir lista de compras (todos ou um fornecedor) =====================
function printShoppingList(list, bySupplier, { single = false } = {}) {
  const dt = new Date(list.created_at || Date.now());
  const dateStr = dt.toLocaleDateString("pt-BR") + " " + dt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  const esc = (s) => String(s ?? "").replace(/[<>&]/g, (c) => ({"<":"&lt;",">":"&gt;","&":"&amp;"})[c]);

  const sections = bySupplier.map(([supName, items]) => {
    const total = items.reduce((s, it) => s + (Number(it.est_cost) || (Number(it.qty) * Number(it.est_unit_cost || 0))), 0);
    const rows = items.map((it, i) => {
      const qty = Number(it.qty) || 0;
      const cost = Number(it.est_cost) || (qty * Number(it.est_unit_cost || 0));
      return `<tr>
        <td class="num">${i + 1}</td>
        <td>${esc(it.name)}</td>
        <td class="num">${qty.toLocaleString("pt-BR", { maximumFractionDigits: 3 })} ${esc(it.unit || "")}</td>
        <td class="num">R$ ${Number(it.est_unit_cost || 0).toFixed(2).replace(".", ",")}</td>
        <td class="num">R$ ${cost.toFixed(2).replace(".", ",")}</td>
        <td class="check"></td>
        <td class="notes"></td>
      </tr>`;
    }).join("");
    return `<section>
      <h2>${esc(supName)} <span class="sub">· ${items.length} ${items.length === 1 ? "item" : "itens"} · R$ ${total.toFixed(2).replace(".", ",")}</span></h2>
      <table>
        <thead>
          <tr>
            <th class="num">#</th>
            <th>Insumo</th>
            <th class="num">Qtd</th>
            <th class="num">Custo unit.</th>
            <th class="num">Custo total</th>
            <th>Recebido</th>
            <th>Observações</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }).join("");

  const html = `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8">
<title>Lista de Compras · ${esc(list.id || "")}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 11px/1.4 -apple-system, "Segoe UI", sans-serif; color: #111; margin: 0; padding: 14mm 12mm; }
  h1 { font-size: 17px; margin: 0 0 4px; }
  h2 { font-size: 13px; margin: 16px 0 6px; padding-bottom: 4px; border-bottom: 1px solid #aaa; }
  h2 .sub { font-weight: 400; color: #555; font-size: 11px; margin-left: 6px; }
  .meta { font-size: 11px; color: #555; margin-bottom: 8px; display: flex; gap: 20px; flex-wrap: wrap; }
  .meta b { color: #111; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #888; padding: 5px 7px; text-align: left; vertical-align: top; font-size: 10.5px; }
  th { background: #eee; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.check { width: 60px; background: repeating-linear-gradient(0deg, transparent, transparent 13px, #ddd 13px, #ddd 14px); }
  td.notes { width: 180px; background: repeating-linear-gradient(0deg, transparent, transparent 13px, #ddd 13px, #ddd 14px); }
  section { page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  .sig { margin-top: 18px; display: flex; gap: 28px; font-size: 10.5px; }
  .sig div { flex: 1; }
  .sig .line { border-bottom: 1px solid #000; height: 28px; }
  @media print { .noprint { display: none; } body { padding: 12mm 10mm; } }
  .noprint { margin-bottom: 10px; }
  button { padding: 8px 14px; font-size: 12px; cursor: pointer; }
</style>
</head><body>
<div class="noprint"><button onclick="window.print()">Imprimir</button></div>
<h1>Lista de Compras${single ? "" : " — Consolidada"}</h1>
<div class="meta">
  <span><b>Código:</b> ${esc(list.id || list.code || "—")}</span>
  <span><b>Criada em:</b> ${dateStr}</span>
  ${list.title ? `<span><b>Título:</b> ${esc(list.title)}</span>` : ""}
  ${list.notes ? `<span><b>Obs:</b> ${esc(list.notes)}</span>` : ""}
</div>
${sections || `<p style="color:#888;text-align:center;padding:24px">Lista vazia.</p>`}
<div class="sig">
  <div><div class="line"></div>Comprador</div>
  <div><div class="line"></div>Conferente</div>
  <div><div class="line"></div>Data / hora</div>
</div>
</body></html>`;

  const w = window.open("", "_blank", "width=900,height=800");
  if (!w) {
    window.showToast?.("Bloqueado pelo navegador · permita pop-ups", { tone: "crit", ttl: 4500 });
    return;
  }
  w.document.write(html);
  w.document.close();
}

// ===================== Modal: Selecionar fornecedores para gerar lista =====================
function SupplierPickerModal({ stockItems: initialStockItems, onCancel, onConfirm }) {
  // Refresca stockItems do DB ao abrir (garante que cream cheese & co. apareçam atualizados)
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false };
  const [stockItems, setStockItems] = useState(initialStockItems || []);
  useEffect(() => {
    if (!dbStatus.isOnline) return;
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const tid = ctx?.tenant?.id;
      if (!tid) return;
      const { data, source } = await dbListStockItems(tid);
      if (!cancelled && source === "db") setStockItems(data || []);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.isOnline]);

  const NO_SUPPLIER = "Sem fornecedor cadastrado";

  // Candidatos (qty < reorder) já com buyQty + estCost calculados
  const candidates = useMemo(() => {
    return (stockItems || []).filter((it) => it.qty < it.reorder).map((it) => {
      const target = it.max && it.max > it.reorder ? it.max : it.reorder * 2;
      const buyQty = Math.max(0, Number((target - it.qty).toFixed(2)));
      const estCost = Number((buyQty * (it.cost || 0)).toFixed(2));
      return { ...it, _buyQty: buyQty, _estCost: estCost };
    });
  }, [stockItems]);

  // Agrupa por fornecedor; "Sem fornecedor cadastrado" fica em destaque
  const groups = useMemo(() => {
    const map = {};
    for (const it of candidates) {
      const s = it.supplier || NO_SUPPLIER;
      if (!map[s]) map[s] = { supplier: s, items: [], totalEstCost: 0, noSupplier: !it.supplier };
      map[s].items.push(it);
      map[s].totalEstCost += it._estCost;
    }
    return Object.values(map).sort((a, b) => {
      if (a.noSupplier && !b.noSupplier) return -1;
      if (b.noSupplier && !a.noSupplier) return 1;
      return b.items.length - a.items.length;
    });
  }, [candidates]);

  // Seleção por item (stock_item_id) — começa com todos marcados
  const [selectedIds, setSelectedIds] = useState(
    () => new Set((initialStockItems || []).filter((it) => it.qty < it.reorder).map((it) => it.id))
  );

  // Quando o conjunto de candidatos muda (refresh do DB), re-marca tudo por padrão
  const candidateIdsKey = candidates.map((it) => it.id).join(",");
  useEffect(() => {
    setSelectedIds(new Set(candidates.map((it) => it.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateIdsKey]);

  // Fornecedores expandidos (set de nomes)
  const [expanded, setExpanded] = useState(new Set());
  const toggleExpand = (s) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(s)) next.delete(s); else next.add(s);
    return next;
  });

  const [search, setSearch] = useState("");
  const visible = groups.filter((g) => g.supplier.toLowerCase().includes(search.toLowerCase()));

  // Estado tri-state do fornecedor: "all" | "some" | "none"
  const supplierState = (g) => {
    const sel = g.items.filter((it) => selectedIds.has(it.id)).length;
    if (sel === 0) return "none";
    if (sel === g.items.length) return "all";
    return "some";
  };

  const toggleItem = (itemId, locked) => {
    if (locked) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  };

  const toggleSupplier = (g) => {
    if (g.noSupplier) return;
    const state = supplierState(g);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (state === "all") g.items.forEach((it) => next.delete(it.id));
      else g.items.forEach((it) => next.add(it.id));
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(candidates.map((it) => it.id)));
  const selectNone = () => {
    // mantém os itens do "Sem fornecedor cadastrado" marcados sempre
    setSelectedIds(new Set(candidates.filter((it) => !it.supplier).map((it) => it.id)));
  };

  const allVisibleAllSelected = visible.length > 0 && visible.every((g) => supplierState(g) === "all");
  const toggleAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      visible.forEach((g) => {
        if (g.noSupplier) return;
        if (allVisibleAllSelected) g.items.forEach((it) => next.delete(it.id));
        else g.items.forEach((it) => next.add(it.id));
      });
      return next;
    });
  };

  // Totais a partir do que está realmente marcado
  const selectedItems = candidates.filter((it) => selectedIds.has(it.id));
  const selectedSuppliers = new Set(selectedItems.map((it) => it.supplier || NO_SUPPLIER));
  const totalCost = selectedItems.reduce((s, it) => s + it._estCost, 0);
  const totalItems = selectedItems.length;

  const submit = () => {
    if (totalItems === 0) return;
    onConfirm([...selectedIds]);
  };

  return (
    <div onClick={onCancel} style={{
      position: "fixed", inset: 0, zIndex: 90,
      background: "rgba(0,0,0,0.55)", display: "grid", placeItems: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 680, maxHeight: "85vh", display: "flex", flexDirection: "column",
        background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 8,
      }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--line)" }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Nova lista de compras</h3>
          <p style={{ margin: "4px 0 0", fontSize: 11.5, color: "var(--fg-2)" }}>
            Itens abaixo do mínimo agrupados por fornecedor. Clique em um fornecedor para escolher itens individualmente.
          </p>
        </div>

        <div style={{ display: "flex", gap: 8, padding: "10px 20px", borderBottom: "1px solid var(--line-soft)" }}>
          <input className="input" placeholder="Filtrar fornecedor…" value={search}
                 onChange={(e) => setSearch(e.target.value)} style={{ flex: 1 }} />
          <button className="btn" data-size="sm" onClick={selectAll}>Todos</button>
          <button className="btn" data-size="sm" onClick={selectNone}>Nenhum</button>
        </div>

        {visible.length > 0 && (
          <div style={{ padding: "8px 20px", borderBottom: "1px solid var(--line-soft)", fontSize: 11.5, color: "var(--fg-2)" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={allVisibleAllSelected} onChange={toggleAllVisible} />
              Marcar/desmarcar todos visíveis ({visible.length})
            </label>
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
          {visible.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>
              {groups.length === 0 ? "Sem itens abaixo do mínimo." : "Nenhum fornecedor com esse nome."}
            </div>
          ) : visible.map((g) => {
            const state = supplierState(g);
            const isOpen = expanded.has(g.supplier);
            const selectedInGroup = g.items.filter((it) => selectedIds.has(it.id)).length;
            return (
              <div key={g.supplier} style={{ borderBottom: "1px solid var(--line-soft)" }}>
                <div style={{
                  display: "grid", gridTemplateColumns: "auto auto 1fr auto auto",
                  gap: 12, alignItems: "center",
                  padding: "10px 20px",
                  background: state !== "none" ? "var(--bg-2)" : "transparent",
                  borderLeft: g.noSupplier ? "3px solid var(--warn)" : "3px solid transparent",
                }}>
                  <input
                    type="checkbox"
                    checked={state === "all"}
                    ref={(el) => { if (el) el.indeterminate = state === "some"; }}
                    disabled={g.noSupplier}
                    onChange={() => toggleSupplier(g)}
                  />
                  <button type="button" onClick={() => toggleExpand(g.supplier)} style={{
                    background: "transparent", border: "none", padding: "2px 4px",
                    cursor: "pointer", color: "var(--fg-3)", display: "inline-flex", alignItems: "center",
                  }} title={isOpen ? "Recolher" : "Expandir itens"}>
                    <I.Chevron size={11} style={{ transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 100ms" }} />
                  </button>
                  <div style={{ cursor: "pointer", minWidth: 0 }} onClick={() => toggleExpand(g.supplier)}>
                    <div style={{ fontSize: 13, color: "var(--fg-0)", display: "flex", alignItems: "center", gap: 6 }}>
                      {g.supplier}
                      {g.noSupplier && <span style={{ fontSize: 9.5, color: "var(--warn)", letterSpacing: "0.05em", textTransform: "uppercase" }}>· sempre incluído</span>}
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--fg-3)", fontFamily: "var(--mono)", marginTop: 2 }}>
                      {selectedInGroup}/{g.items.length} {g.items.length === 1 ? "item selecionado" : "itens selecionados"}
                    </div>
                  </div>
                  <span style={{ fontSize: 11, color: "var(--fg-2)", fontFamily: "var(--mono)" }}>
                    {g.items.length} {g.items.length === 1 ? "item" : "itens"}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--fg-1)", fontFamily: "var(--mono)" }}>
                    R$ {g.totalEstCost.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>

                {isOpen && (
                  <div style={{ padding: "4px 0 8px", background: "var(--bg-3)" }}>
                    {g.items.map((it) => {
                      const isSel = selectedIds.has(it.id);
                      const isLocked = g.noSupplier;
                      return (
                        <label key={it.id} style={{
                          display: "grid",
                          gridTemplateColumns: "auto 1fr auto auto",
                          gap: 10, alignItems: "center",
                          padding: "6px 20px 6px 56px",
                          cursor: isLocked ? "default" : "pointer",
                          opacity: isLocked ? 0.85 : 1,
                          fontSize: 12, color: "var(--fg-1)",
                        }}>
                          <input
                            type="checkbox"
                            checked={isSel}
                            disabled={isLocked}
                            onChange={() => toggleItem(it.id, isLocked)}
                          />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ color: "var(--fg-0)" }}>{it.name}</div>
                            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", marginTop: 1 }}>
                              {it.id} · atual {it.qty} {it.unit} · mín {it.reorder}
                            </div>
                          </div>
                          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent-bright)", fontWeight: 500 }}>
                            {it._buyQty} {it.unit}
                          </span>
                          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-2)" }}>
                            R$ {it._estCost.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{
          padding: "12px 20px", borderTop: "1px solid var(--line)",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <div style={{ fontSize: 12, color: "var(--fg-2)" }}>
            <strong style={{ color: "var(--fg-0)" }}>{selectedSuppliers.size}</strong> fornecedor(es) · <strong style={{ color: "var(--fg-0)" }}>{totalItems}</strong> itens · <strong style={{ color: "var(--fg-0)" }}>R$ {totalCost.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" data-size="sm" onClick={onCancel}>Cancelar</button>
            <button className="btn" data-variant="primary" data-size="sm" disabled={totalItems === 0} onClick={submit}>
              Gerar lista
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

window.Purchases = Purchases;
