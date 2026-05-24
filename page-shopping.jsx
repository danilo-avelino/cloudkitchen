// Lista de compras — gerada automaticamente a partir do estoque atual.
// Mostra todos os insumos com qty < min (estoque mínimo). A quantidade sugerida
// para cada item é (max - qty atual) — o suficiente p/ atingir o estoque máximo.

const _fmtBRL = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Shopping({ embedded = false, onSave = null, stockItems: stockItemsProp = null }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [stockItems, setStockItems] = useState(stockItemsProp || MOCK.STOCK_ITEMS || []);
  const [pageLoading, setPageLoading] = useState(!stockItemsProp);

  // Quando vier por prop (Estoque já carregou), prefere; senão busca direto
  useEffect(() => {
    if (stockItemsProp) { setStockItems(stockItemsProp); setPageLoading(false); return; }
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setPageLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const ctx = await dbGetCurrentContext();
        if (cancelled || !ctx?.tenant?.id) return;
        const { data, source: src } = await dbListStockItems(ctx.tenant.id);
        if (cancelled) return;
        if (src === "db") setStockItems(data || []);
      } catch (e) { console.warn("[shopping] falha ao carregar estoque:", e); }
      finally { if (!cancelled) setPageLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline, stockItemsProp]);

  // Computa todos os itens abaixo do mínimo a partir do estoque.
  const baseSuggestions = useMemo(() => {
    return (stockItems || [])
      .filter((it) => it.qty < it.reorder)
      .map((it) => {
        const target = it.max && it.max > it.reorder ? it.max : it.reorder * 2;
        const buyQty = Math.max(0, Number((target - it.qty).toFixed(2)));
        const estCost = Number((buyQty * it.cost).toFixed(2));
        const isCritical = it.qty <= 0 || (it.reorder > 0 && it.qty < it.reorder * 0.25);
        const weeklyAvg = it.usage30d ? Number((it.usage30d / 4).toFixed(1)) : 0;
        return { ...it, target, buyQty, estCost, isCritical, weeklyAvg };
      });
  }, [stockItems]);

  // Permite "desmarcar" (excluir) itens da lista por id
  const [excluded, setExcluded] = useState({}); // { id: true }
  const [overrides, setOverrides] = useState({}); // { id: { buyQty, estCost } }

  const [editing, setEditing] = useState(null); // item sendo editado
  const [regenSeed, setRegenSeed] = useState(0);

  // Aplica overrides + exclusões ao gerar a lista exibida
  const suggestions = useMemo(() => {
    return baseSuggestions.map((s) => {
      const o = overrides[s.id];
      if (!o) return s;
      const buyQty = o.buyQty ?? s.buyQty;
      const estCost = o.estCost ?? Number((buyQty * s.cost).toFixed(2));
      return { ...s, buyQty, estCost };
    });
  }, [baseSuggestions, overrides, regenSeed]);

  const activeItems = suggestions.filter((s) => !excluded[s.id]);

  const total = activeItems.reduce((sum, s) => sum + (s.estCost || 0), 0);

  // Agrupa por fornecedor (e mantém um fallback p/ itens sem fornecedor)
  const bySupplier = useMemo(() => {
    const groups = {};
    activeItems.forEach((s) => {
      const key = s.supplier || "Sem fornecedor definido";
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    });
    // Ordena: críticos primeiro, depois fornecedores cadastrados, "Sem fornecedor" no fim
    return Object.entries(groups).sort(([a], [b]) => {
      if (a === "Sem fornecedor definido") return 1;
      if (b === "Sem fornecedor definido") return -1;
      return a.localeCompare(b);
    });
  }, [activeItems]);

  const criticalCount = activeItems.filter((s) => s.isCritical).length;

  const toggleExcluded = (id) => setExcluded((cur) => ({ ...cur, [id]: !cur[id] }));

  const regenerate = () => {
    setOverrides({});
    setExcluded({});
    setRegenSeed((s) => s + 1);
    window.showToast("Lista regerada · todos os itens abaixo do mínimo incluídos", { tone: "ok" });
  };

  // Texto de UM fornecedor — sem custos (vai pra cotação)
  const buildSupplierText = (supName, items) => {
    const today = new Date().toLocaleDateString("pt-BR");
    const lines = [];
    lines.push(`*🛒 Lista de compras · ${supName}*`);
    lines.push(`_${today}_`);
    lines.push("");
    items.forEach((it) => {
      const flag = it.isCritical ? " ⚠️" : "";
      lines.push(`• ${it.name} — ${it.buyQty} ${it.unit}${flag}`);
    });
    lines.push("");
    lines.push("_Por favor enviar cotação._");
    return lines.join("\n");
  };

  // Texto da lista completa — agrupada por fornecedor, sem custos
  const buildFullText = () => {
    const today = new Date().toLocaleDateString("pt-BR");
    const lines = [];
    lines.push(`*🛒 Lista de compras · ${today}*`);
    lines.push("");
    bySupplier.forEach(([supName, items]) => {
      const supInfo = MOCK.supplierByName ? MOCK.supplierByName(supName) : null;
      lines.push(`*${supName}*${supInfo?.lead ? ` _(lead ${supInfo.lead})_` : ""}`);
      items.forEach((it) => {
        const flag = it.isCritical ? " ⚠️" : "";
        lines.push(`• ${it.name} — ${it.buyQty} ${it.unit}${flag}`);
      });
      lines.push("");
    });
    if (criticalCount > 0) {
      lines.push(`⚠️ ${criticalCount} ${criticalCount === 1 ? "item crítico" : "itens críticos"} (ruptura ou próximo)`);
      lines.push("");
    }
    lines.push("_Por favor enviar cotação._");
    return lines.join("\n");
  };

  // Helper de cópia (Clipboard API + fallback)
  const copyToClipboard = async (text, successMsg) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        window.showToast(successMsg, { tone: "ok", ttl: 4000 });
        return;
      }
      throw new Error("Clipboard API indisponível");
    } catch {
      // Fallback: textarea + execCommand p/ navegadores sem permissão de clipboard
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        const ok = document.execCommand("copy");
        if (ok) window.showToast(successMsg, { tone: "ok" });
        else window.showToast("Falha ao copiar · selecione manualmente", { tone: "warn" });
      } catch {
        window.showToast("Falha ao copiar · selecione manualmente", { tone: "warn" });
      }
      document.body.removeChild(ta);
    }
  };

  const copyList = () => {
    if (activeItems.length === 0) {
      window.showToast("Nenhum item selecionado", { tone: "warn" });
      return;
    }
    copyToClipboard(
      buildFullText(),
      `Lista copiada · ${bySupplier.length} fornecedores · cole no WhatsApp`,
    );
  };

  const copySupplier = (supName, items) => {
    if (items.length === 0) return;
    copyToClipboard(
      buildSupplierText(supName, items),
      `${supName} copiado · ${items.length} ${items.length === 1 ? "item" : "itens"}`,
    );
  };

  const saveItemEdit = ({ id, buyQty, estCost }) => {
    setOverrides((cur) => ({ ...cur, [id]: { buyQty, estCost } }));
    setEditing(null);
    window.showToast("Quantidade ajustada", { tone: "ok" });
  };

  const handleSaveAsList = () => {
    if (!onSave) return;
    if (activeItems.length === 0) {
      window.showToast("Selecione ao menos 1 item pra salvar", { tone: "warn" });
      return;
    }
    onSave({
      items: activeItems.map((s) => ({
        stock_item_id: s.id,
        name: s.name,
        supplier: s.supplier || "Sem fornecedor",
        category: s.cat,
        qty: s.buyQty,
        unit: s.unit,
        est_unit_cost: s.cost,
        est_cost: s.estCost,
      })),
      total,
    });
  };

  if (pageLoading && !embedded) return <PageLoading label="Carregando lista de compras…" variant="table" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: embedded ? "auto" : "100%", overflow: "hidden", flex: 1 }}>
      {!embedded && (
        <div style={{ padding: "20px 28px 14px", display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div>
            <div className="h-eyebrow" style={{ marginBottom: 6 }}>
              Sugestão automática · itens abaixo do estoque mínimo · alvo = estoque máximo
            </div>
            <h1 className="h-title">Lista de compras</h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Total estimado</span>
              <span className="mono" style={{ fontSize: 22, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.02em" }}>
                {_fmtBRL(total)}
              </span>
            </div>
            <button className="btn" data-size="sm" onClick={regenerate}>Re-gerar</button>
            <button className="btn" data-variant="primary" data-size="sm" onClick={copyList} title="Copia para a área de transferência (cole no WhatsApp)">
              <I.WhatsApp size={13} />Copiar lista
            </button>
          </div>
        </div>
      )}

      {embedded && (
        <div style={{
          padding: "12px 28px 14px", display: "flex",
          alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap",
          borderBottom: "1px solid var(--line-soft)",
        }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Sugestão · qty &lt; mínimo · alvo = máximo
            </span>
            <span className="mono" style={{ fontSize: 18, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.018em" }}>
              {_fmtBRL(total)}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" data-size="sm" onClick={regenerate}>Re-gerar</button>
            <button className="btn" data-size="sm" onClick={copyList} title="Copia para a área de transferência">
              <I.WhatsApp size={13} />Copiar
            </button>
            {onSave && (
              <button className="btn" data-variant="primary" data-size="sm"
                      onClick={handleSaveAsList} disabled={activeItems.length === 0}
                      title="Cria uma lista de compras salva no histórico">
                <I.Check size={12} />Salvar lista
              </button>
            )}
          </div>
        </div>
      )}

      <div style={{ padding: "0 28px", borderBottom: "1px solid var(--line)", paddingBottom: 14, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <SummaryStat label="Itens abaixo do mínimo" value={baseSuggestions.length} />
        <SummaryStat label="Selecionados" value={activeItems.length} />
        <SummaryStat label="Críticos / ruptura" value={criticalCount} tone={criticalCount > 0 ? "crit" : "ok"} />
        <SummaryStat label="Fornecedores" value={bySupplier.length} />
        <span style={{ flex: 1 }} />
        <SummaryStat label="Custo da reposição" value={_fmtBRL(total)} />
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
        {baseSuggestions.length === 0 && (
          <div style={{ textAlign: "center", padding: 48 }}>
            <div className="h-eyebrow" style={{ marginBottom: 8 }}>Nada para comprar</div>
            <div style={{ fontSize: 13, color: "var(--fg-2)" }}>
              Todos os insumos estão acima do estoque mínimo. ✨
            </div>
          </div>
        )}

        {bySupplier.map(([supName, items]) => {
          const supInfo = MOCK.supplierByName ? MOCK.supplierByName(supName) : null;
          const supTotal = items.reduce((s, it) => s + (it.estCost || 0), 0);
          const groupCritical = items.some((it) => it.isCritical);
          return (
            <div key={supName} className="card">
              <div className="card-header">
                <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                  <I.Truck size={15} style={{ color: groupCritical ? "var(--crit)" : "var(--fg-2)", flexShrink: 0 }} />
                  <div style={{ minWidth: 0 }}>
                    <h3 className="card-title" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {supName}
                      {groupCritical && <span className="badge" data-tone="crit">crítico</span>}
                    </h3>
                    <div className="card-sub" style={{ display: "block", marginTop: 3 }}>
                      {items.length} {items.length === 1 ? "item" : "itens"}
                      {supInfo?.contact ? ` · ${supInfo.contact}` : ""}
                      {supInfo?.lead ? ` · lead ${supInfo.lead}` : ""}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                  <span className="mono" style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 500 }}>
                    {_fmtBRL(supTotal)}
                  </span>
                  <button className="btn" data-size="sm"
                          onClick={() => copySupplier(supName, items)}
                          title={`Copiar lista de ${supName} para o WhatsApp (sem custos)`}>
                    <I.WhatsApp size={12} />Copiar
                  </button>
                </div>
              </div>
              <table className="table" data-density="compact">
                <thead>
                  <tr>
                    <th style={{ width: 32 }}></th>
                    <th>Insumo</th>
                    <th className="num">Atual</th>
                    <th className="num">Mín</th>
                    <th className="num">Máx</th>
                    <th className="num">Comprar</th>
                    <th className="num">Custo est.</th>
                    <th>Motivo</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((s) => {
                    const isOff = excluded[s.id];
                    return (
                      <tr key={s.id} style={{ opacity: isOff ? 0.4 : 1 }}>
                        <td><CheckBox checked={!isOff} onChange={() => toggleExcluded(s.id)} /></td>
                        <td className="row-strong">
                          <div>{s.name}</div>
                          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.04em", textTransform: "uppercase", marginTop: 2 }}>
                            {s.id}{s.weeklyAvg ? ` · semana ~${s.weeklyAvg} ${s.unit}` : ""}
                          </div>
                        </td>
                        <td className="num" style={{ color: s.qty <= 0 ? "var(--crit)" : "var(--fg-1)" }}>
                          {s.qty} {s.unit}
                        </td>
                        <td className="num" style={{ color: "var(--fg-2)" }}>{s.reorder}</td>
                        <td className="num" style={{ color: "var(--fg-2)" }}>{s.max ?? "—"}</td>
                        <td className="num" style={{ color: "var(--accent-bright)", fontWeight: 500 }}>
                          {s.buyQty} {s.unit}
                        </td>
                        <td className="num">{_fmtBRL(s.estCost)}</td>
                        <td className="dim" style={{ fontSize: 11.5 }}>
                          {s.isCritical ? (
                            <span style={{ color: "var(--crit)", fontWeight: 500 }}>RUPTURA · prioridade alta</span>
                          ) : (
                            <span>Abaixo do mínimo · cobrir até o máximo</span>
                          )}
                        </td>
                        <td>
                          <button className="btn" data-variant="ghost" data-size="sm" style={{ padding: "3px 7px" }}
                                  onClick={() => setEditing(s)}>
                            Editar
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      {editing && (
        <EditBuyQtyModal
          item={editing}
          onCancel={() => setEditing(null)}
          onSave={saveItemEdit}
        />
      )}
    </div>
  );
}

function CheckBox({ checked, onChange }) {
  return (
    <button onClick={onChange} style={{
      width: 16, height: 16, borderRadius: 3,
      background: checked ? "var(--accent-bright)" : "transparent",
      border: `1px solid ${checked ? "var(--accent-bright)" : "var(--line-strong)"}`,
      display: "grid", placeItems: "center", padding: 0, transition: "all 100ms",
    }}>
      {checked && <I.Check size={11} style={{ color: "var(--accent-fg)" }} />}
    </button>
  );
}

function EditBuyQtyModal({ item, onCancel, onSave }) {
  const [qty,  setQty]  = useState(String(item.buyQty).replace(".", ","));
  const [cost, setCost] = useState(String(item.estCost.toFixed(2)).replace(".", ","));
  const [costEdited, setCostEdited] = useState(false);

  // Recalcula custo automaticamente conforme qty muda (até o usuário editar manualmente)
  useEffect(() => {
    if (costEdited) return;
    const q = parseFloat(String(qty).replace(",", "."));
    if (Number.isFinite(q) && q >= 0) {
      setCost(((q * item.cost).toFixed(2)).replace(".", ","));
    }
  }, [qty, costEdited, item.cost]);

  const parsedQty = parseFloat(String(qty).replace(",", "."));
  const parsedCost = parseFloat(String(cost).replace(",", "."));
  const valid = Number.isFinite(parsedQty) && parsedQty > 0 && Number.isFinite(parsedCost) && parsedCost >= 0;

  return (
    <Modal title="Editar quantidade a comprar" subtitle={item.name} onClose={onCancel}
      footer={<>
        <button className="btn" data-size="sm" onClick={onCancel}>Cancelar</button>
        <button className="btn" data-variant="primary" data-size="sm" disabled={!valid}
                onClick={() => onSave({ id: item.id, buyQty: parsedQty, estCost: parsedCost })}>
          Salvar
        </button>
      </>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
        <ShopMini label="Atual" value={`${item.qty} ${item.unit}`} />
        <ShopMini label="Mínimo" value={`${item.reorder} ${item.unit}`} />
        <ShopMini label="Máximo" value={`${item.max ?? "—"} ${item.unit}`} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <FormRow label={`Quantidade (${item.unit})`}>
          <input className="input mono" inputMode="decimal" autoFocus value={qty}
                 onChange={(e) => { setQty(e.target.value); setCostEdited(false); }} />
        </FormRow>
        <FormRow label="Custo estimado (R$)" hint={costEdited ? "manual · não recalcula" : "qtd × custo unit. (auto)"}>
          <input className="input mono" inputMode="decimal" value={cost}
                 onChange={(e) => { setCost(e.target.value); setCostEdited(true); }} />
        </FormRow>
      </div>
    </Modal>
  );
}

function ShopMini({ label, value }) {
  return (
    <div style={{ background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4, padding: "8px 10px" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</div>
      <div className="mono" style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)" }}>{value}</div>
    </div>
  );
}

window.Shopping = Shopping;
window.CheckBox = CheckBox;
