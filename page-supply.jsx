// Cadeia de suprimentos · módulo 'supply' (tenants membros de uma rede de distribuição)
// Solicitar da central, pedir/enviar entre tenants, confirmar recebimentos
// (com opção "direto na cozinha" → CMV) e extrato de Gastos.
// Componentes compartilhados com a Central (page-distribution.jsx) vivem aqui.
// Spec: PRD-PRODUCAO-E-DISTRIBUICAO.md §7–§8.

const _supFmtBRL = (v) =>
  "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const _supParseNum = (raw) => {
  if (raw == null) return 0;
  const s = String(raw).trim().replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

const _supFmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("pt-BR") : "—");

const _SUP_TRANSFER_STATUS = {
  draft:     { label: "Rascunho",   color: "var(--fg-3)",  soft: "var(--bg-3)",      line: "var(--line)" },
  sent:      { label: "Em trânsito", color: "var(--warn)", soft: "var(--warn-soft)", line: "var(--warn-line)" },
  received:  { label: "Recebida",   color: "var(--ok)",    soft: "var(--ok-soft)",   line: "var(--ok-line)" },
  cancelled: { label: "Cancelada",  color: "var(--crit)",  soft: "var(--crit-soft)", line: "var(--crit-line)" },
};
const _SUP_REQUEST_STATUS = {
  pending:   { label: "Pendente",  color: "var(--warn)", soft: "var(--warn-soft)", line: "var(--warn-line)" },
  approved:  { label: "Aprovada",  color: "var(--info)", soft: "var(--info-soft)", line: "var(--info-line)" },
  fulfilled: { label: "Atendida",  color: "var(--ok)",   soft: "var(--ok-soft)",   line: "var(--ok-line)" },
  rejected:  { label: "Recusada",  color: "var(--crit)", soft: "var(--crit-soft)", line: "var(--crit-line)" },
  cancelled: { label: "Cancelada", color: "var(--fg-3)", soft: "var(--bg-3)",      line: "var(--line)" },
};

// Motivos da divergência de recebimento (espelham o check do banco)
const _SUP_DIV_REASONS = [
  { id: "faltou",   label: "Não veio" },
  { id: "avaria",   label: "Chegou avariado" },
  { id: "sobra",    label: "Veio a mais" },
  { id: "contagem", label: "Erro de contagem" },
  { id: "outro",    label: "Outro" },
];
const _supReasonLabel = (id) => _SUP_DIV_REASONS.find((r) => r.id === id)?.label || "—";

function SupplyStatusBadge({ status, kind = "transfer" }) {
  const map = kind === "request" ? _SUP_REQUEST_STATUS : _SUP_TRANSFER_STATUS;
  const m = map[status] || map.draft || map.pending;
  return (
    <span style={{
      fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase",
      color: m.color, background: m.soft, border: `1px solid ${m.line}`,
      borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap",
    }}>{m.label}</span>
  );
}

const _supTh = { fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "left", padding: "8px 10px", borderBottom: "1px solid var(--line)" };
const _supTd = { fontSize: 12.5, color: "var(--fg-1)", padding: "9px 10px", borderBottom: "1px solid var(--line-soft)", verticalAlign: "top" };

// ---------------------------------------------------------------------
// Nova transferência (usada pelo membro E pela central)
// prefillRequest: solicitação sendo atendida (to = solicitante, itens copiados)
// ---------------------------------------------------------------------
function SupplyTransferForm({ tid, centralId, toOptions, stockItems, prefillRequest, onClose, onSaved }) {
  const byId = {};
  (stockItems || []).forEach((i) => { byId[i.id] = i; });

  const [toTenantId, setToTenantId] = useState(prefillRequest?.requesterTenantId || (toOptions[0]?.id || ""));
  const [lines, setLines] = useState(() => {
    if (prefillRequest?.items?.length) {
      return prefillRequest.items.map((it) => ({
        itemId: it.supplierItemId || "", qty: String(it.qty).replace(".", ","),
      }));
    }
    return [{ itemId: "", qty: "" }];
  });
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false); // guard de duplo-clique

  const valid = lines
    .map((l) => ({ item: byId[l.itemId], qtyN: _supParseNum(l.qty) }))
    .filter((l) => l.item && l.qtyN > 0);
  const estValue = valid.reduce((s, l) => s + l.qtyN * (l.item.cost || 0), 0);
  const overStock = valid.filter((l) => l.qtyN > (l.item.qty || 0));
  const canSave = !!toTenantId && valid.length > 0;

  const save = async (alsoSend) => {
    if (saving || !canSave) return;
    setSaving(true);
    try {
      const { data, error } = await dbSupplyCreateTransfer({
        centralId,
        fromTenantId: tid,
        toTenantId,
        requestId: prefillRequest?.id || null,
        notes,
        items: valid.map((l) => ({ fromItemId: l.item.id, name: l.item.name, qty: l.qtyN, unit: l.item.unit })),
      });
      if (error) throw error;
      if (alsoSend) {
        const sess = await dbGetSession();
        const { error: sErr } = await dbSupplySendTransfer(data.id, sess?.user?.id);
        if (sErr) throw sErr;
        window.showToast?.("Transferência enviada — itens baixados do estoque", { tone: "ok" });
      } else {
        window.showToast?.("Rascunho de transferência criado", { tone: "ok" });
      }
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
      setSaving(false);
    }
  };

  return (
    <Modal
      title={prefillRequest ? `Atender ${prefillRequest.code}` : "Nova transferência"}
      subtitle="Os itens saem do seu estoque no envio, a custo (sem margem). O destinatário confirma o recebimento."
      width={620}
      onClose={saving ? undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn" data-size="sm" onClick={() => save(false)} disabled={saving || !canSave}>
            {saving ? "Carregando…" : "Salvar rascunho"}
          </button>
          <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={() => save(true)} disabled={saving || !canSave || overStock.length > 0}>
            {saving ? "Carregando…" : "Criar e enviar"}
          </button>
        </>
      )}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <FormRow label="Destinatário">
          <select className="select" value={toTenantId} onChange={(e) => setToTenantId(e.target.value)}
            disabled={!!prefillRequest}>
            {!toTenantId && <option value="">— escolha —</option>}
            {toOptions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </FormRow>

        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>Itens (do seu estoque)</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {lines.map((l, i) => {
              const item = byId[l.itemId];
              const qtyN = _supParseNum(l.qty);
              const over = item && qtyN > (item.qty || 0);
              return (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 110px 90px 28px", gap: 8, alignItems: "center" }}>
                  <select className="select" value={l.itemId}
                    onChange={(e) => setLines((cur) => cur.map((x, k) => k === i ? { ...x, itemId: e.target.value } : x))}>
                    <option value="">— item —</option>
                    {(stockItems || []).map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name}{it.itemKind === "transformed" ? " · transformado" : ""} · {it.qty.toLocaleString("pt-BR")} {it.unit}
                      </option>
                    ))}
                  </select>
                  <input className="input" placeholder={`Qtd${item ? ` (${item.unit})` : ""}`} value={l.qty} inputMode="decimal"
                    style={over ? { borderColor: "var(--crit)", color: "var(--crit)" } : undefined}
                    onChange={(e) => setLines((cur) => cur.map((x, k) => k === i ? { ...x, qty: e.target.value } : x))} />
                  <span style={{ fontSize: 11.5, color: "var(--fg-2)", fontFamily: "var(--mono)", textAlign: "right" }}>
                    {item && qtyN > 0 ? _supFmtBRL(qtyN * (item.cost || 0)) : "—"}
                  </span>
                  <button type="button" className="btn" data-variant="ghost" data-size="sm" title="Remover"
                    onClick={() => setLines((cur) => cur.length > 1 ? cur.filter((_, k) => k !== i) : cur)}>
                    <I.X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
          <button type="button" className="btn" data-size="sm" style={{ marginTop: 8 }}
            onClick={() => setLines((cur) => [...cur, { itemId: "", qty: "" }])}>
            <I.Plus size={12} /> Adicionar item
          </button>
          {overStock.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--crit)", marginTop: 8 }}>
              Saldo insuficiente: {overStock.map((l) => l.item.name).join(", ")}.
            </div>
          )}
        </div>

        <FormRow label="Observações">
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
        </FormRow>

        <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4 }}>
          <span style={{ fontSize: 12, color: "var(--fg-2)" }}>Valor estimado (a custo)</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)", fontFamily: "var(--mono)" }}>{_supFmtBRL(estValue)}</span>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Confirmar recebimento (destinatário)
// ---------------------------------------------------------------------
// Escolha da operação de um item (modalzinho em cima do recebimento)
function SupplyKitchenOpModal({ itemName, ops, value, onPick, onClose }) {
  return (
    <Modal
      title="Direto na cozinha"
      subtitle={`Para qual operação vai "${itemName}"? O valor entra no CMV do dia dela.`}
      width={380}
      onClose={onClose}
      footer={<button type="button" className="btn" data-size="sm" onClick={onClose}>Cancelar</button>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {ops.length === 0 && (
          <div style={{ fontSize: 12.5, color: "var(--warn)" }}>
            Nenhuma operação cadastrada — crie uma em Configurações → Operações.
          </div>
        )}
        {ops.map((o) => {
          const on = value === o.id;
          return (
            <button key={o.id} type="button" onClick={() => onPick(o.id)} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
              borderRadius: 4, cursor: "pointer", textAlign: "left",
              background: on ? "var(--ok-soft)" : "var(--bg-2)",
              border: `1px solid ${on ? "var(--ok-line)" : "var(--line)"}`,
              color: "var(--fg-0)", fontSize: 12.5,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: o.color || "var(--fg-3)", flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{o.name}</span>
              {on && <I.Check size={13} style={{ color: "var(--ok)" }} />}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Confirmar recebimento (destinatário)
// ---------------------------------------------------------------------
function SupplyReceiveModal({ transfer, myItems, onClose, onSaved }) {
  // O destino é sempre o que a central enviou: o banco resolve pelo vínculo do
  // item na rede, cai no equivalente por nome+unidade ou cria o item. O
  // destinatário não escolhe — aqui só mostramos onde vai entrar.
  const [ops, setOps] = useState([]);
  const [links, setLinks] = useState(null);   // { fromItemId: toItemId } — null = carregando
  const [rows, setRows] = useState({});       // { transferItemId: { direct, operationId, recv, reason } }
  const [pickFor, setPickFor] = useState(null); // item cuja operação está sendo escolhida
  const [checking, setChecking] = useState(false); // modo conferência (relatar divergência)
  const [divNotes, setDivNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const itemById = {};
  (myItems || []).forEach((m) => { itemById[m.id] = m; });

  // Item de destino: vínculo da rede primeiro, equivalente por nome+unidade depois.
  const destFor = (it) => {
    const linked = links && it.fromItemId ? itemById[links[it.fromItemId]] : null;
    if (linked) return linked;
    return (myItems || []).find((m) =>
      m.name.trim().toLowerCase() === (it.name || "").trim().toLowerCase() && m.unit === it.unit) || null;
  };

  // Pré-marca cada linha com a última escolha feita para aquele insumo.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [opRes, lkRes] = await Promise.all([
        dbListOperations(transfer.toTenantId),
        dbSupplyItemLinks(transfer.centralId, transfer.toTenantId),
      ]);
      if (cancelled) return;
      const opList = opRes?.data || [];
      setOps(opList);
      const map = lkRes?.data || {};
      setLinks(map);
      const next = {};
      (transfer.items || []).forEach((it) => {
        const dest = (it.fromItemId && itemById[map[it.fromItemId]])
          || (myItems || []).find((m) =>
              m.name.trim().toLowerCase() === (it.name || "").trim().toLowerCase() && m.unit === it.unit);
        const opId = dest?.directKitchenOperationId || "";
        const valid = opList.some((o) => o.id === opId);
        next[it.id] = {
          direct: !!dest?.autoDirectKitchen && valid,
          operationId: valid ? opId : "",
          recv: String(it.qty).replace(".", ","), // conferência começa no enviado
          reason: "",
        };
      });
      setRows(next);
    })();
    return () => { cancelled = true; };
  }, [transfer.id]);

  const opName = (id) => ops.find((o) => o.id === id)?.name || "";
  const directRows = Object.values(rows).filter((r) => r.direct);

  // Divergência = conferido − enviado. Só existe no modo conferência.
  const deltaOf = (it) => {
    if (!checking) return 0;
    const r = rows[it.id];
    if (!r) return 0;
    return _supParseNum(r.recv) - it.qty;
  };
  const diverged = (transfer.items || []).filter((it) => deltaOf(it) !== 0);
  const divValue = diverged.reduce((s, it) => s + deltaOf(it) * it.unitCost, 0);
  const recvValue = (transfer.items || [])
    .reduce((s, it) => s + (checking ? _supParseNum(rows[it.id]?.recv) : it.qty) * it.unitCost, 0);

  const canSave = links !== null
    && directRows.every((r) => !!r.operationId)
    && diverged.every((it) => !!rows[it.id]?.reason);

  // Marcar "direto na cozinha" abre a escolha da operação; desmarcar é direto.
  const toggleDirect = (it) => {
    const cur = rows[it.id] || { direct: false, operationId: "" };
    if (cur.direct) {
      setRows((r) => ({ ...r, [it.id]: { ...cur, direct: false } }));
    } else {
      setPickFor(it);
    }
  };

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    try {
      const { error } = await dbSupplyReceiveTransfer(transfer, {
        items: (transfer.items || []).map((it) => ({
          itemId: it.id,
          direct: !!rows[it.id]?.direct,
          operationId: rows[it.id]?.operationId || null,
          // fora do modo conferência, null = "chegou tudo o que foi enviado"
          receivedQty: checking ? _supParseNum(rows[it.id]?.recv) : null,
          reason: deltaOf(it) !== 0 ? (rows[it.id]?.reason || null) : null,
        })),
        notes: diverged.length > 0 ? divNotes : null,
      });
      if (error) throw error;
      window.showToast?.(diverged.length > 0
        ? `Recebimento confirmado com ${diverged.length} divergência(s) · ${_supFmtBRL(Math.abs(divValue))}`
        : directRows.length > 0
          ? `Recebimento confirmado — ${directRows.length} item(ns) direto no CMV da cozinha`
          : "Recebimento confirmado — itens no estoque", { tone: "ok" });
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro ao receber: ${e.message || e}`, { tone: "crit", ttl: 6000 });
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Confirmar recebimento · ${transfer.code}`}
      subtitle={`De ${transfer.fromName || "—"} · valor ${_supFmtBRL(transfer.totalValue)} (vira "Compras · Rede de suprimentos" no seu financeiro).`}
      width={checking ? 800 : 680}
      onClose={saving ? undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn" data-size="sm" disabled={saving}
            style={{ marginRight: "auto" }}
            onClick={() => { setChecking((c) => !c); if (checking) setDivNotes(""); }}>
            {checking ? "Recebi tudo certo" : "Relatar divergência"}
          </button>
          <button type="button" className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={save} disabled={saving || !canSave}>
            {saving ? "Carregando…" : diverged.length > 0 ? "Confirmar com divergência" : "Confirmar recebimento"}
          </button>
        </>
      )}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
            {checking ? "Confira o que chegou" : "Itens e destino no seu estoque"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {(transfer.items || []).map((it) => {
              const dest = destFor(it);
              const row = rows[it.id] || { direct: false, operationId: "", recv: "", reason: "" };
              const delta = deltaOf(it);
              const tone = delta === 0 ? null : delta < 0 ? "crit" : "warn";
              return (
                <div key={it.id} style={{
                  padding: "8px 10px", borderRadius: 4,
                  background: tone ? `var(--${tone}-soft)` : row.direct ? "var(--ok-soft)" : "var(--bg-2)",
                  border: `1px solid ${tone ? `var(--${tone}-line)` : row.direct ? "var(--ok-line)" : "var(--line)"}`,
                }}>
                  <div style={{
                    display: "grid", alignItems: "center", gap: 10,
                    gridTemplateColumns: checking ? "1fr 130px 150px 170px" : "1fr 150px 190px",
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, color: "var(--fg-0)" }}>{it.name}</div>
                      <div style={{ fontSize: 11, color: "var(--fg-3)", fontFamily: "var(--mono)" }}>
                        {checking ? "enviado " : ""}{it.qty.toLocaleString("pt-BR")} {it.unit} · {_supFmtBRL(it.unitCost)}/{it.unit}
                      </div>
                    </div>
                    <div style={{ fontSize: 11.5, color: dest ? "var(--fg-2)" : "var(--fg-3)", minWidth: 0 }}>
                      → {dest ? dest.name : "novo item no seu estoque"}
                    </div>
                    {checking && (
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input className="input mono" value={row.recv} inputMode="decimal"
                            onChange={(e) => setRows((r) => ({ ...r, [it.id]: { ...row, recv: e.target.value } }))}
                            style={{ width: 84, textAlign: "right", height: 28 }} />
                          <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{it.unit}</span>
                        </div>
                        {delta !== 0 && (
                          <div style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: `var(--${tone})`, marginTop: 3 }}>
                            {delta > 0 ? "+" : "−"}{Math.abs(delta).toLocaleString("pt-BR")} · {_supFmtBRL(Math.abs(delta * it.unitCost))}
                          </div>
                        )}
                      </div>
                    )}
                    <div>
                      <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
                        <input type="checkbox" checked={row.direct} onChange={() => toggleDirect(it)} />
                        <span style={{ fontSize: 11.5, color: "var(--fg-1)" }}>Direto na cozinha</span>
                      </label>
                      {row.direct && (
                        <button type="button" onClick={() => setPickFor(it)} style={{
                          marginTop: 4, marginLeft: 24, background: "none", border: "none", padding: 0,
                          cursor: "pointer", fontSize: 11,
                          color: row.operationId ? "var(--ok)" : "var(--crit)",
                          textDecoration: "underline", textUnderlineOffset: 2,
                        }}>
                          {row.operationId ? opName(row.operationId) : "escolher operação"}
                        </button>
                      )}
                    </div>
                  </div>
                  {delta !== 0 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                      <span style={{ fontSize: 11, color: "var(--fg-2)" }}>Motivo</span>
                      <select className="select" style={{ width: 240, height: 28 }} value={row.reason}
                        onChange={(e) => setRows((r) => ({ ...r, [it.id]: { ...row, reason: e.target.value } }))}>
                        <option value="">Selecione…</option>
                        {_SUP_DIV_REASONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                      </select>
                      {!row.reason && <span style={{ fontSize: 11, color: "var(--crit)" }}>obrigatório</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {checking && (
            <div style={{
              display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
              marginTop: 10, padding: "10px 12px", borderRadius: 4,
              background: diverged.length > 0 ? "var(--warn-soft)" : "var(--bg-2)",
              border: `1px solid ${diverged.length > 0 ? "var(--warn-line)" : "var(--line)"}`,
            }}>
              <SummaryStat label="Itens divergentes" value={String(diverged.length)}
                tone={diverged.length > 0 ? "warn" : "ok"} />
              <SummaryStat label="Divergência" value={_supFmtBRL(divValue)}
                tone={divValue < 0 ? "crit" : divValue > 0 ? "warn" : "ok"} />
              <SummaryStat label="Valor a lançar" value={_supFmtBRL(recvValue)} />
              <span style={{ flex: 1 }} />
              <div style={{ fontSize: 11, color: "var(--fg-3)", maxWidth: 300, lineHeight: 1.5 }}>
                Entra no estoque e é cobrado só o que você conferiu. A diferença fica
                registrada na aba <strong style={{ color: "var(--fg-2)" }}>Divergências</strong>.
              </div>
            </div>
          )}

          {checking && diverged.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <FormRow label="Observação da divergência" hint="Opcional — o que aconteceu (caixa violada, veio trocado, motorista informou…).">
                <textarea className="input" rows={2} value={divNotes}
                  onChange={(e) => setDivNotes(e.target.value)} style={{ resize: "vertical" }} />
              </FormRow>
            </div>
          )}

          <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 8, lineHeight: 1.5 }}>
            O destino segue o item enviado pela central — se ele já entrou aqui antes,
            cai no mesmo insumo; se for a primeira vez, o insumo é criado.
            <br />
            <strong style={{ color: "var(--fg-2)" }}>Direto na cozinha</strong>: dá entrada e saída imediata
            do estoque, e o valor conta no CMV do dia da operação escolhida. A marcação fica salva
            e já vem preenchida no próximo recebimento do mesmo insumo.
          </div>
        </div>
      </div>

      {pickFor && (
        <SupplyKitchenOpModal
          itemName={pickFor.name}
          ops={ops}
          value={rows[pickFor.id]?.operationId || ""}
          onPick={(opId) => {
            setRows((r) => ({ ...r, [pickFor.id]: { ...r[pickFor.id], direct: true, operationId: opId } }));
            setPickFor(null);
          }}
          onClose={() => setPickFor(null)}
        />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Detalhe read-only de transferência
// ---------------------------------------------------------------------
function SupplyTransferDetail({ transfer, onClose }) {
  return (
    <Modal
      title={`Transferência ${transfer.code}`}
      subtitle={`${transfer.fromName || "—"} → ${transfer.toName || "—"}${transfer.notes ? ` · ${transfer.notes}` : ""}`}
      width={560}
      onClose={onClose}
      footer={<button type="button" className="btn" data-size="sm" onClick={onClose}>Fechar</button>}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <SupplyStatusBadge status={transfer.status} />
        <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
          criada {_supFmtDate(transfer.createdAt)}
          {transfer.sentAt ? ` · enviada ${_supFmtDate(transfer.sentAt)}` : ""}
          {transfer.receivedAt ? ` · recebida ${_supFmtDate(transfer.receivedAt)}` : ""}
          {transfer.directToKitchen && transfer.status === "received" ? " · direto na cozinha" : ""}
        </span>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th style={_supTh}>Item</th><th style={{ ..._supTh, textAlign: "right" }}>Qtd</th><th style={{ ..._supTh, textAlign: "right" }}>Custo un.</th><th style={{ ..._supTh, textAlign: "right" }}>Total</th></tr></thead>
        <tbody>
          {transfer.items.map((it) => {
            // Conferência do recebimento: null = recebeu o que foi enviado
            const recv = it.receivedQty != null ? it.receivedQty : it.qty;
            const delta = recv - it.qty;
            return (
              <tr key={it.id}>
                <td style={_supTd}>
                  {it.name}
                  {it.directToKitchen && (
                    <div style={{ fontSize: 10.5, color: "var(--ok)" }}>direto na cozinha</div>
                  )}
                  {delta !== 0 && (
                    <div style={{ fontSize: 10.5, color: delta < 0 ? "var(--crit)" : "var(--warn)" }}>
                      {_supReasonLabel(it.divergenceReason)} · enviado {it.qty.toLocaleString("pt-BR")} {it.unit}
                    </div>
                  )}
                </td>
                <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)", color: delta !== 0 ? (delta < 0 ? "var(--crit)" : "var(--warn)") : undefined }}>
                  {recv.toLocaleString("pt-BR")} {it.unit}
                </td>
                <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)" }}>{transfer.status === "draft" ? "—" : _supFmtBRL(it.unitCost)}</td>
                <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)" }}>{transfer.status === "draft" ? "—" : _supFmtBRL(recv * it.unitCost)}</td>
              </tr>
            );
          })}
          <tr>
            <td style={{ ..._supTd, fontWeight: 600, color: "var(--fg-0)" }} colSpan={3}>Total</td>
            <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)", fontWeight: 600, color: "var(--fg-0)" }}>
              {_supFmtBRL(transfer.receivedValue != null ? transfer.receivedValue
                : transfer.totalValue != null ? transfer.totalValue : transfer.estValue)}
            </td>
          </tr>
          {transfer.divergenceValue !== 0 && (
            <tr>
              <td style={{ ..._supTd, color: "var(--fg-2)" }} colSpan={3}>
                Divergência (enviado {_supFmtBRL(transfer.totalValue)})
                {transfer.divergenceNotes && (
                  <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{transfer.divergenceNotes}</div>
                )}
              </td>
              <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)", fontWeight: 600, color: transfer.divergenceValue < 0 ? "var(--crit)" : "var(--warn)" }}>
                {_supFmtBRL(transfer.divergenceValue)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Lista de transferências com ações por perspectiva (compartilhada)
// ---------------------------------------------------------------------
function SupplyTransferList({ tid, transfers, myItems, onChanged, emptyHint }) {
  const [detail, setDetail] = useState(null);
  const [receiveFor, setReceiveFor] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind: 'cancel'|'delete'|'send', transfer }
  const [busy, setBusy] = useState(false);

  const doConfirm = async () => {
    if (busy || !confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "send") {
        const sess = await dbGetSession();
        const { error } = await dbSupplySendTransfer(confirm.transfer.id, sess?.user?.id);
        if (error) throw error;
        window.showToast?.("Transferência enviada — itens baixados do estoque", { tone: "ok" });
      } else if (confirm.kind === "cancel") {
        const { error } = await dbSupplyCancelTransfer(confirm.transfer.id);
        if (error) throw error;
        window.showToast?.("Transferência cancelada" + (confirm.transfer.status === "sent" ? " — itens devolvidos ao estoque" : ""), { tone: "ok" });
      } else {
        const { error } = await dbSupplyDeleteTransfer(confirm.transfer.id);
        if (error) throw error;
        window.showToast?.("Rascunho excluído", { tone: "ok" });
      }
      setConfirm(null);
      await onChanged();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
    }
    setBusy(false);
  };

  if (!transfers || transfers.length === 0) {
    return (
      <div style={{ padding: "32px 20px", textAlign: "center", border: "1px dashed var(--line)", borderRadius: 6, fontSize: 12.5, color: "var(--fg-3)" }}>
        {emptyHint || "Nenhuma transferência ainda."}
      </div>
    );
  }

  return (
    <div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={_supTh}>Código</th>
            <th style={_supTh}>Rota</th>
            <th style={_supTh}>Itens</th>
            <th style={{ ..._supTh, textAlign: "right" }}>Valor</th>
            <th style={_supTh}>Status</th>
            <th style={{ ..._supTh, width: 170 }}></th>
          </tr>
        </thead>
        <tbody>
          {transfers.map((t) => {
            const iAmFrom = t.fromTenantId === tid;
            const iAmTo   = t.toTenantId === tid;
            return (
              <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => setDetail(t)}>
                <td style={_supTd}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-0)" }}>{t.code}</div>
                  <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{_supFmtDate(t.createdAt)}</div>
                </td>
                <td style={_supTd}>{iAmFrom ? `→ ${t.toName || "—"}` : `${t.fromName || "—"} →`}</td>
                <td style={_supTd}>{t.items.map((it) => it.name).join(", ") || "—"}</td>
                <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)" }}>
                  {_supFmtBRL(t.receivedValue != null ? t.receivedValue : t.totalValue != null ? t.totalValue : t.estValue)}
                  {t.divergenceValue !== 0 && (
                    <div style={{ fontSize: 10.5, color: t.divergenceValue < 0 ? "var(--crit)" : "var(--warn)" }}>
                      enviado {_supFmtBRL(t.totalValue)}
                    </div>
                  )}
                </td>
                <td style={_supTd}>
                  <SupplyStatusBadge status={t.status} />
                  {t.divergenceValue !== 0 && (
                    <div style={{ fontSize: 10.5, color: "var(--warn)", marginTop: 3 }}>
                      divergência {_supFmtBRL(t.divergenceValue)}
                    </div>
                  )}
                </td>
                <td style={{ ..._supTd, textAlign: "right", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                  {t.status === "draft" && iAmFrom && (
                    <>
                      <button className="btn" data-size="sm" data-variant="primary" disabled={busy}
                        onClick={() => setConfirm({ kind: "send", transfer: t })}>Enviar</button>
                      {" "}
                      <button className="btn" data-size="sm" data-variant="ghost" title="Excluir rascunho" disabled={busy}
                        onClick={() => setConfirm({ kind: "delete", transfer: t })}><I.Trash size={12} /></button>
                    </>
                  )}
                  {t.status === "sent" && iAmTo && (
                    <button className="btn" data-size="sm" data-variant="primary" disabled={busy}
                      onClick={() => setReceiveFor(t)}>Confirmar recebimento</button>
                  )}
                  {t.status === "sent" && iAmFrom && (
                    <button className="btn" data-size="sm" disabled={busy}
                      onClick={() => setConfirm({ kind: "cancel", transfer: t })}>Cancelar</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {detail && <SupplyTransferDetail transfer={detail} onClose={() => setDetail(null)} />}
      {receiveFor && (
        <SupplyReceiveModal
          transfer={receiveFor} myItems={myItems}
          onClose={() => setReceiveFor(null)}
          onSaved={async () => { setReceiveFor(null); await onChanged(); }}
        />
      )}
      <ConfirmDialog
        open={!!confirm}
        tone={confirm?.kind === "send" ? "neutral" : "danger"}
        title={confirm?.kind === "send" ? "Enviar transferência" : confirm?.kind === "cancel" ? "Cancelar transferência" : "Excluir rascunho"}
        message={confirm?.kind === "send"
          ? `Enviar ${confirm?.transfer?.code} para ${confirm?.transfer?.toName}? Os itens saem do seu estoque agora.`
          : confirm?.kind === "cancel"
            ? `Cancelar ${confirm?.transfer?.code}?${confirm?.transfer?.status === "sent" ? " Os itens voltam ao seu estoque com movimentos inversos." : ""}`
            : `Excluir o rascunho ${confirm?.transfer?.code}?`}
        confirmLabel={confirm?.kind === "send" ? "Enviar" : confirm?.kind === "cancel" ? "Cancelar transferência" : "Excluir"}
        busy={busy}
        onConfirm={doConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------
// Nova solicitação (catálogo do fornecedor, sem custo)
// ---------------------------------------------------------------------
function SupplyRequestForm({ tid, centralId, suppliers, onClose, onSaved }) {
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id || "");
  const [catalog, setCatalog] = useState(null); // null = carregando
  const [lines, setLines] = useState([{ itemId: "", qty: "" }]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!supplierId) { setCatalog([]); return; }
    let cancelled = false;
    setCatalog(null);
    (async () => {
      const { data, error } = await dbSupplyCatalog(tid, supplierId);
      if (cancelled) return;
      if (error) {
        window.showToast?.(`Erro ao carregar catálogo: ${error.message || error}`, { tone: "crit", ttl: 6000 });
        setCatalog([]);
        return;
      }
      setCatalog(data || []);
    })();
    return () => { cancelled = true; };
  }, [supplierId]);

  const byId = {};
  (catalog || []).forEach((i) => { byId[i.id] = i; });
  const valid = lines
    .map((l) => ({ item: byId[l.itemId], qtyN: _supParseNum(l.qty) }))
    .filter((l) => l.item && l.qtyN > 0);
  const canSave = !!supplierId && valid.length > 0;

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    try {
      const { error } = await dbSupplyCreateRequest({
        centralId,
        requesterId: tid,
        supplierId,
        notes,
        items: valid.map((l) => ({ supplierItemId: l.item.id, name: l.item.name, qty: l.qtyN, unit: l.item.unit })),
      });
      if (error) throw error;
      window.showToast?.("Solicitação enviada", { tone: "ok" });
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Nova solicitação"
      subtitle="O fornecedor aprova e atende com uma transferência — os preços são definidos pelo custo dele no envio."
      width={600}
      onClose={saving ? undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={save} disabled={saving || !canSave}>
            {saving ? "Carregando…" : "Enviar solicitação"}
          </button>
        </>
      )}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <FormRow label="Fornecedor">
          <select className="select" value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setLines([{ itemId: "", qty: "" }]); }}
            disabled={suppliers.length === 1}>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </FormRow>

        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
            Itens (catálogo do fornecedor)
          </div>
          {catalog === null ? (
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Carregando catálogo…</div>
          ) : catalog.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--warn)" }}>O fornecedor não tem itens ativos no estoque.</div>
          ) : (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {lines.map((l, i) => {
                  const item = byId[l.itemId];
                  return (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 110px 28px", gap: 8, alignItems: "center" }}>
                      <select className="select" value={l.itemId}
                        onChange={(e) => setLines((cur) => cur.map((x, k) => k === i ? { ...x, itemId: e.target.value } : x))}>
                        <option value="">— item —</option>
                        {catalog.map((it) => (
                          <option key={it.id} value={it.id}>
                            {it.name}{it.itemKind === "transformed" ? " · transformado" : ""} ({it.unit})
                          </option>
                        ))}
                      </select>
                      <input className="input" placeholder={`Qtd${item ? ` (${item.unit})` : ""}`} value={l.qty} inputMode="decimal"
                        onChange={(e) => setLines((cur) => cur.map((x, k) => k === i ? { ...x, qty: e.target.value } : x))} />
                      <button type="button" className="btn" data-variant="ghost" data-size="sm" title="Remover"
                        onClick={() => setLines((cur) => cur.length > 1 ? cur.filter((_, k) => k !== i) : cur)}>
                        <I.X size={11} />
                      </button>
                    </div>
                  );
                })}
              </div>
              <button type="button" className="btn" data-size="sm" style={{ marginTop: 8 }}
                onClick={() => setLines((cur) => [...cur, { itemId: "", qty: "" }])}>
                <I.Plus size={12} /> Adicionar item
              </button>
            </>
          )}
        </div>

        <FormRow label="Observações">
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
        </FormRow>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Lista de solicitações com ações (compartilhada)
// onFulfill(request) — abre a transferência pré-preenchida (lado fornecedor)
// ---------------------------------------------------------------------
function SupplyRequestList({ tid, requests, onChanged, onFulfill, emptyHint }) {
  const [confirm, setConfirm] = useState(null); // { action, request }
  const [busy, setBusy] = useState(false);

  const doConfirm = async () => {
    if (busy || !confirm) return;
    setBusy(true);
    try {
      const sess = await dbGetSession();
      const { error } = await dbSupplyUpdateRequestStatus(confirm.request.id, confirm.action, { userId: sess?.user?.id });
      if (error) throw error;
      window.showToast?.(confirm.action === "approved" ? "Solicitação aprovada"
        : confirm.action === "rejected" ? "Solicitação recusada" : "Solicitação cancelada", { tone: "ok" });
      setConfirm(null);
      await onChanged();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
    }
    setBusy(false);
  };

  if (!requests || requests.length === 0) {
    return (
      <div style={{ padding: "32px 20px", textAlign: "center", border: "1px dashed var(--line)", borderRadius: 6, fontSize: 12.5, color: "var(--fg-3)" }}>
        {emptyHint || "Nenhuma solicitação."}
      </div>
    );
  }

  return (
    <div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={_supTh}>Código</th>
            <th style={_supTh}>Rota</th>
            <th style={_supTh}>Itens</th>
            <th style={_supTh}>Status</th>
            <th style={{ ..._supTh, width: 210 }}></th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => {
            const iAmSupplier  = r.supplierTenantId === tid;
            const iAmRequester = r.requesterTenantId === tid;
            return (
              <tr key={r.id}>
                <td style={_supTd}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-0)" }}>{r.code}</div>
                  <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{_supFmtDate(r.requestedAt)}</div>
                </td>
                <td style={_supTd}>{iAmSupplier ? `${r.requesterName || "—"} pediu` : `para ${r.supplierName || "—"}`}</td>
                <td style={_supTd}>
                  {r.items.map((it) => `${it.name} (${it.qty.toLocaleString("pt-BR")} ${it.unit})`).join(", ") || "—"}
                  {r.notes ? <div style={{ fontSize: 11, color: "var(--fg-3)" }}>{r.notes}</div> : null}
                  {r.status === "rejected" && r.rejectionReason ? <div style={{ fontSize: 11, color: "var(--crit)" }}>{r.rejectionReason}</div> : null}
                </td>
                <td style={_supTd}><SupplyStatusBadge status={r.status} kind="request" /></td>
                <td style={{ ..._supTd, textAlign: "right", whiteSpace: "nowrap" }}>
                  {iAmSupplier && r.status === "pending" && (
                    <>
                      <button className="btn" data-size="sm" data-variant="primary" disabled={busy}
                        onClick={() => setConfirm({ action: "approved", request: r })}>Aprovar</button>
                      {" "}
                      <button className="btn" data-size="sm" disabled={busy}
                        onClick={() => setConfirm({ action: "rejected", request: r })}>Recusar</button>
                    </>
                  )}
                  {iAmSupplier && r.status === "approved" && (
                    <button className="btn" data-size="sm" data-variant="primary" disabled={busy}
                      onClick={() => onFulfill(r)}>Atender</button>
                  )}
                  {iAmRequester && (r.status === "pending" || r.status === "approved") && (
                    <button className="btn" data-size="sm" data-variant="ghost" disabled={busy}
                      onClick={() => setConfirm({ action: "cancelled", request: r })}>Cancelar</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <ConfirmDialog
        open={!!confirm}
        tone={confirm?.action === "approved" ? "neutral" : "danger"}
        title={confirm?.action === "approved" ? "Aprovar solicitação" : confirm?.action === "rejected" ? "Recusar solicitação" : "Cancelar solicitação"}
        message={confirm ? `${confirm.request.code} · ${confirm.request.items.length} item(ns)` : ""}
        confirmLabel={confirm?.action === "approved" ? "Aprovar" : confirm?.action === "rejected" ? "Recusar" : "Cancelar solicitação"}
        busy={busy}
        onConfirm={doConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------
// Extrato de gastos (compartilhado)
// ---------------------------------------------------------------------
function SupplyLedgerTable({ entries, nameByTenant, showTenant = false }) {
  if (!entries || entries.length === 0) {
    return (
      <div style={{ padding: "32px 20px", textAlign: "center", border: "1px dashed var(--line)", borderRadius: 6, fontSize: 12.5, color: "var(--fg-3)" }}>
        Nenhum lançamento de gastos ainda — eles surgem na confirmação de recebimento das transferências.
      </div>
    );
  }
  const kindLabel = { transfer_in: "Recebimento", transfer_out: "Repasse", adjustment: "Ajuste manual" };
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={_supTh}>Data</th>
          {showTenant && <th style={_supTh}>Tenant</th>}
          <th style={_supTh}>Tipo</th>
          <th style={_supTh}>Obs.</th>
          <th style={{ ..._supTh, textAlign: "right" }}>Valor</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id}>
            <td style={{ ..._supTd, fontFamily: "var(--mono)" }}>{_supFmtDate(e.createdAt)}</td>
            {showTenant && <td style={_supTd}>{nameByTenant?.[e.tenantId] || "—"}</td>}
            <td style={_supTd}>{kindLabel[e.kind] || e.kind}</td>
            <td style={_supTd}>{e.notes || "—"}</td>
            <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)", color: e.delta >= 0 ? "var(--fg-0)" : "var(--ok)" }}>
              {e.delta >= 0 ? "+" : "−"}{_supFmtBRL(Math.abs(e.delta))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------
// Divergências de recebimento (compartilhada: Central e Cadeia de suprimentos)
// ---------------------------------------------------------------------
const _supMonthKey = (iso) => (iso ? String(iso).slice(0, 7) : "");
const _supMonthLabel = (key) => {
  const [y, m] = key.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString("pt-BR", { month: "short", year: "numeric" }).replace(".", "");
};

function SupplyDivergenceView({ tid, isCentral = false, scopeCentralId = null }) {
  const [data, setData] = useState(null); // { lines, receipts } — null = carregando
  const [month, setMonth] = useState(() => _supMonthKey(new Date().toISOString()));
  const [party, setParty] = useState("all");   // contraparte (unidade / rota)
  const [reason, setReason] = useState("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await dbSupplyDivergences(tid);
      if (!cancelled) setData(res?.data || { lines: [], receipts: [] });
    })();
    return () => { cancelled = true; };
  }, [tid]);

  if (data === null) return <PageLoading label="Carregando divergências…" variant="table" />;

  // Na Cadeia de suprimentos o tenant pode estar em 2+ redes — restringe à ativa.
  const inScope = (r) => !scopeCentralId || r.centralId === scopeCentralId;
  const allLines = data.lines.filter(inScope);
  const allReceipts = data.receipts.filter(inScope);

  // A contraparte é sempre "o outro lado" da rota, do ponto de vista deste tenant.
  const otherOf = (r) => (r.toTenantId === tid
    ? { id: r.fromTenantId, name: r.fromName || "—" }
    : { id: r.toTenantId, name: r.toName || "—" });

  const months = Array.from(new Set(allReceipts.map((r) => _supMonthKey(r.receivedAt)).filter(Boolean)));
  const nowKey = _supMonthKey(new Date().toISOString());
  if (!months.includes(nowKey)) months.push(nowKey);
  months.sort().reverse();

  const parties = [];
  const seen = {};
  allReceipts.forEach((r) => {
    const o = otherOf(r);
    if (o.id && !seen[o.id]) { seen[o.id] = true; parties.push(o); }
  });

  const inPeriod = (r) => month === "all" || _supMonthKey(r.receivedAt) === month;
  const inParty = (r) => party === "all" || otherOf(r).id === party;

  const receipts = allReceipts.filter((r) => inPeriod(r) && inParty(r));
  const lines = allLines
    .filter((r) => inPeriod(r) && inParty(r) && (reason === "all" || r.reason === reason))
    .sort((a, b) => Math.abs(b.deltaValue) - Math.abs(a.deltaValue));

  const sentValue = receipts.reduce((s, r) => s + r.sentValue, 0);
  const recvValue = receipts.reduce((s, r) => s + r.receivedValue, 0);
  const missing = lines.filter((l) => l.deltaQty < 0).reduce((s, l) => s + l.deltaValue, 0); // ≤ 0
  const surplus = lines.filter((l) => l.deltaQty > 0).reduce((s, l) => s + l.deltaValue, 0); // ≥ 0
  const netValue = missing + surplus;
  const pct = sentValue > 0 ? (Math.abs(netValue) / sentValue) * 100 : 0;
  const pctTone = pct >= 3 ? "crit" : pct >= 1 ? "warn" : "ok";
  const affected = new Set(lines.map((l) => l.transferId)).size;

  // Ranking por insumo — onde a perda se concentra
  const byItem = {};
  lines.forEach((l) => {
    const k = l.name.trim().toLowerCase();
    if (!byItem[k]) byItem[k] = { name: l.name, unit: l.unit, qty: 0, value: 0, n: 0 };
    byItem[k].qty += l.deltaQty;
    byItem[k].value += l.deltaValue;
    byItem[k].n += 1;
  });
  const topItems = Object.values(byItem)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 6);

  // Ranking por contraparte — qual rota/unidade mais diverge
  const byParty = {};
  lines.forEach((l) => {
    const o = otherOf(l);
    if (!byParty[o.id]) byParty[o.id] = { name: o.name, value: 0, n: 0 };
    byParty[o.id].value += l.deltaValue;
    byParty[o.id].n += 1;
  });
  const topParties = Object.values(byParty)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 6);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <FormRow label="Período">
          <select className="select" style={{ width: 150 }} value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="all">Todos os períodos</option>
            {months.map((m) => <option key={m} value={m}>{_supMonthLabel(m)}</option>)}
          </select>
        </FormRow>
        <FormRow label={isCentral ? "Unidade" : "Contraparte"}>
          <select className="select" style={{ width: 190 }} value={party} onChange={(e) => setParty(e.target.value)}>
            <option value="all">{isCentral ? "Todas as unidades" : "Todas"}</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </FormRow>
        <FormRow label="Motivo">
          <select className="select" style={{ width: 170 }} value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="all">Todos os motivos</option>
            {_SUP_DIV_REASONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </FormRow>
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14,
        paddingBottom: 16, borderBottom: "1px solid var(--line)", marginBottom: 18,
      }}>
        <SummaryStat label="% de divergência" value={`${pct.toFixed(2).replace(".", ",")}%`} tone={pctTone} />
        <SummaryStat label="Impacto no período" value={_supFmtBRL(netValue)}
          tone={netValue < 0 ? "crit" : netValue > 0 ? "warn" : "ok"} />
        <SummaryStat label="Faltas" value={_supFmtBRL(missing)} tone={missing < 0 ? "crit" : "ok"} />
        <SummaryStat label="Sobras" value={_supFmtBRL(surplus)} tone={surplus > 0 ? "warn" : "ok"} />
        <SummaryStat label="Itens divergentes" value={String(lines.length)} tone={lines.length > 0 ? "warn" : "ok"} />
        <SummaryStat label="Recebimentos afetados" value={`${affected} de ${receipts.length}`} />
        <SummaryStat label="Valor enviado" value={_supFmtBRL(sentValue)} />
        <SummaryStat label="Valor recebido" value={_supFmtBRL(recvValue)} />
      </div>

      {receipts.length === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center", border: "1px dashed var(--line)", borderRadius: 6, fontSize: 12.5, color: "var(--fg-3)" }}>
          Nenhum recebimento {month === "all" ? "na rede" : `em ${_supMonthLabel(month)}`}.
        </div>
      ) : lines.length === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center", border: "1px dashed var(--line)", borderRadius: 6 }}>
          <div style={{ fontSize: 13, color: "var(--ok)", marginBottom: 6 }}>Nenhuma divergência no período.</div>
          <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
            As divergências aparecem aqui quando quem recebe usa <strong>Relatar divergência</strong> na
            confirmação do recebimento e informa uma quantidade diferente da enviada.
          </div>
        </div>
      ) : (
        <>
          {(topItems.length > 1 || topParties.length > 1) && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 18, marginBottom: 22 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)", marginBottom: 8 }}>Insumos que mais divergem</div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>
                    <th style={_supTh}>Insumo</th>
                    <th style={{ ..._supTh, textAlign: "right" }}>Ocorr.</th>
                    <th style={{ ..._supTh, textAlign: "right" }}>Qtd</th>
                    <th style={{ ..._supTh, textAlign: "right" }}>Valor</th>
                  </tr></thead>
                  <tbody>
                    {topItems.map((i) => (
                      <tr key={i.name}>
                        <td style={_supTd}>{i.name}</td>
                        <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)" }}>{i.n}</td>
                        <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)" }}>
                          {i.qty > 0 ? "+" : ""}{i.qty.toLocaleString("pt-BR")} {i.unit}
                        </td>
                        <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)", color: i.value < 0 ? "var(--crit)" : "var(--warn)" }}>
                          {_supFmtBRL(i.value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)", marginBottom: 8 }}>
                  {isCentral ? "Unidades com mais divergência" : "Contrapartes com mais divergência"}
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>
                    <th style={_supTh}>{isCentral ? "Unidade" : "Contraparte"}</th>
                    <th style={{ ..._supTh, textAlign: "right" }}>Ocorr.</th>
                    <th style={{ ..._supTh, textAlign: "right" }}>Valor</th>
                  </tr></thead>
                  <tbody>
                    {topParties.map((p) => (
                      <tr key={p.name}>
                        <td style={_supTd}>{p.name}</td>
                        <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)" }}>{p.n}</td>
                        <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)", color: p.value < 0 ? "var(--crit)" : "var(--warn)" }}>
                          {_supFmtBRL(p.value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)", marginBottom: 8 }}>
            Ocorrências ({lines.length})
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={_supTh}>Data</th>
                <th style={_supTh}>Código</th>
                <th style={_supTh}>Rota</th>
                <th style={_supTh}>Insumo</th>
                <th style={{ ..._supTh, textAlign: "right" }}>Enviado</th>
                <th style={{ ..._supTh, textAlign: "right" }}>Recebido</th>
                <th style={{ ..._supTh, textAlign: "right" }}>Δ</th>
                <th style={{ ..._supTh, textAlign: "right" }}>Valor</th>
                <th style={_supTh}>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td style={{ ..._supTd, fontFamily: "var(--mono)" }}>{_supFmtDate(l.receivedAt)}</td>
                  <td style={{ ..._supTd, fontFamily: "var(--mono)" }}>{l.code}</td>
                  <td style={{ ..._supTd, color: "var(--fg-2)" }}>{l.fromName || "—"} → {l.toName || "—"}</td>
                  <td style={{ ..._supTd, color: "var(--fg-0)" }}>
                    {l.name}
                    {l.notes && <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{l.notes}</div>}
                  </td>
                  <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)" }}>{l.sentQty.toLocaleString("pt-BR")} {l.unit}</td>
                  <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)" }}>{l.receivedQty.toLocaleString("pt-BR")} {l.unit}</td>
                  <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)", color: l.deltaQty < 0 ? "var(--crit)" : "var(--warn)" }}>
                    {l.deltaQty > 0 ? "+" : "−"}{Math.abs(l.deltaQty).toLocaleString("pt-BR")}
                  </td>
                  <td style={{ ..._supTd, textAlign: "right", fontFamily: "var(--mono)", color: l.deltaValue < 0 ? "var(--crit)" : "var(--warn)" }}>
                    {_supFmtBRL(l.deltaValue)}
                  </td>
                  <td style={{ ..._supTd, color: "var(--fg-2)" }}>{_supReasonLabel(l.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Página raiz · Suprimentos (tenant membro)
// ---------------------------------------------------------------------
const _SUP_VIEWS = [
  { id: "receipts",    label: "Recebimentos" },
  { id: "central",     label: "Solicitar da central" },
  { id: "peers",       label: "Entre tenants" },
  { id: "divergences", label: "Divergências" },
  { id: "ledger",      label: "Gastos" },
];

function Suprimentos({ scope }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("receipts");
  const [overview, setOverview] = useState(null);
  const [stockItems, setStockItems] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [requests, setRequests] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [networkIdx, setNetworkIdx] = useState(0); // rede ativa quando membro de 2+
  const [requestForm, setRequestForm] = useState(null);   // { suppliers }
  const [transferForm, setTransferForm] = useState(null); // { toOptions, prefillRequest }
  const [inviteBusy, setInviteBusy] = useState(false);

  const reload = async (tenantId) => {
    const t = tenantId || tid;
    if (!t) return;
    const [oRes, sRes, tRes, rRes, lRes] = await Promise.all([
      dbSupplyOverview(t),
      dbListStockItems(t),
      dbSupplyListTransfers(t),
      dbSupplyListRequests(t),
      dbSupplyListLedger(t),
    ]);
    setOverview(oRes?.data || null);
    setStockItems(sRes?.data || []);
    setTransfers(tRes?.data || []);
    setRequests(rRes?.data || []);
    setLedger(lRes?.data || []);
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

  if (loading) return <PageLoading label="Carregando suprimentos…" variant="table" />;

  if (!dbStatus.isOnline || !tid) {
    return (
      <div style={{ padding: "24px 28px" }}>
        <div style={{ fontSize: 12.5, color: "var(--warn)", padding: "10px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 4 }}>
          O módulo Cadeia de suprimentos só fica disponível com Supabase online.
        </div>
      </div>
    );
  }

  const asMember = overview?.asMember || [];
  const invites  = asMember.filter((n) => n.status === "invited");
  const networks = asMember.filter((n) => n.status === "active");
  const net = networks[Math.min(networkIdx, Math.max(networks.length - 1, 0))] || null;
  const supplyCode = overview?.tenant?.supplyCode || "—";
  const fmtCode = (c) => (c && c.length === 8 ? `${c.slice(0, 4)} ${c.slice(4)}` : c);

  const respondInvite = async (inv, accept) => {
    if (inviteBusy) return;
    setInviteBusy(true);
    try {
      const { error } = await dbSupplyRespondInvite(inv.centralId, tid, accept);
      if (error) throw error;
      window.showToast?.(accept ? `Você entrou na rede de ${inv.centralName}` : "Convite recusado", { tone: "ok" });
      await reload();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
    }
    setInviteBusy(false);
  };

  // Recortes por rede ativa
  const netTransfers = net ? transfers.filter((t) => t.centralId === net.centralId) : [];
  const netRequests  = net ? requests.filter((r) => r.centralId === net.centralId) : [];
  const netLedger    = net ? ledger.filter((l) => l.centralId === net.centralId && l.tenantId === tid) : [];
  const peers        = net ? (net.peers || []) : [];
  const central      = net ? { id: net.centralId, name: net.centralName } : null;

  const toReceive = netTransfers.filter((t) => t.toTenantId === tid && t.status === "sent");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "20px 28px 0" }}>
        <div className="h-eyebrow" style={{ marginBottom: 6 }}>Rede de suprimentos</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h1 className="h-title" style={{ margin: 0 }}>Cadeia de suprimentos</h1>
          {networks.length > 1 && (
            <select className="select" style={{ width: "auto" }} value={networkIdx}
              onChange={(e) => setNetworkIdx(Number(e.target.value))}>
              {networks.map((n, i) => <option key={n.centralId} value={i}>Central: {n.centralName}</option>)}
            </select>
          )}
          {net && networks.length === 1 && (
            <span style={{ fontSize: 12, color: "var(--fg-3)" }}>Central: <strong style={{ color: "var(--fg-1)" }}>{net.centralName}</strong></span>
          )}
        </div>

        {invites.map((inv) => (
          <div key={inv.centralId} style={{
            marginTop: 12, padding: "12px 14px", borderRadius: 4,
            background: "var(--info-soft)", border: "1px solid var(--info-line)",
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <div style={{ flex: 1, fontSize: 12.5, color: "var(--fg-0)" }}>
              A central <strong>{inv.centralName}</strong> convidou você para a rede de suprimentos dela.
            </div>
            <button className="btn" data-size="sm" data-variant="primary" disabled={inviteBusy}
              onClick={() => respondInvite(inv, true)}>{inviteBusy ? "Carregando…" : "Aceitar"}</button>
            <button className="btn" data-size="sm" disabled={inviteBusy}
              onClick={() => respondInvite(inv, false)}>Recusar</button>
          </div>
        ))}

        {net && (
          <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--line)", marginTop: 14 }}>
            {_SUP_VIEWS.map((v) => (
              <button key={v.id} onClick={() => setView(v.id)}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  padding: "8px 14px", fontSize: 13, marginBottom: -1,
                  color: view === v.id ? "var(--fg-0)" : "var(--fg-3)",
                  fontWeight: view === v.id ? 600 : 400,
                  borderBottom: view === v.id ? "2px solid var(--accent-bright)" : "2px solid transparent",
                  display: "inline-flex", alignItems: "center", gap: 6,
                }}>
                {v.label}
                {v.id === "receipts" && toReceive.length > 0 && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "1px 6px", background: "var(--accent-bright)", color: "var(--accent-fg)", borderRadius: 8, fontWeight: 500 }}>{toReceive.length}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 32px" }}>
        {!net ? (
          <div style={{ padding: "40px 20px", textAlign: "center", border: "1px dashed var(--line)", borderRadius: 6 }}>
            {overview?.tenant?.kind === "distribution_center" ? (
              <>
                <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 8 }}>
                  Sua conta é uma Central de Distribuição — a gestão da <strong>sua</strong> rede (convites, transferências, gastos) fica no módulo <strong>Central</strong>.
                </div>
                <div style={{ fontSize: 12.5, color: "var(--fg-3)", marginBottom: 14 }}>
                  A Cadeia de suprimentos é usada quando a sua central participa da rede de <em>outra</em> central. Para isso, passe o código abaixo para ela convidar você:
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 8 }}>
                  Você ainda não participa de nenhuma rede de suprimentos.
                </div>
                <div style={{ fontSize: 12.5, color: "var(--fg-3)", marginBottom: 14 }}>
                  Passe o código abaixo para a central de distribuição convidar a sua cozinha:
                </div>
              </>
            )}
            <div style={{ display: "inline-block", padding: "10px 22px", background: "var(--bg-2)", border: "1px solid var(--line-strong)", borderRadius: 6, fontFamily: "var(--mono)", fontSize: 22, letterSpacing: "0.15em", color: "var(--fg-0)" }}>
              {fmtCode(supplyCode)}
            </div>
          </div>
        ) : (
          <>
            {view === "central" && (
              <div>
                <div style={{ display: "flex", marginBottom: 14 }}>
                  <button className="btn" data-variant="primary" data-size="sm" style={{ marginLeft: "auto" }}
                    onClick={() => setRequestForm({ suppliers: [central] })}>
                    <I.Plus size={12} /> Nova solicitação
                  </button>
                </div>
                <SupplyRequestList
                  tid={tid}
                  requests={netRequests.filter((r) => r.requesterTenantId === tid && r.supplierTenantId === net.centralId)}
                  onChanged={() => reload()}
                  onFulfill={() => {}}
                  emptyHint="Nenhuma solicitação à central ainda — peça insumos brutos ou transformados pelo botão acima."
                />
              </div>
            )}

            {view === "peers" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>Pedidos entre tenants</div>
                    <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                      <button className="btn" data-size="sm" disabled={peers.length === 0}
                        onClick={() => setRequestForm({ suppliers: peers.map((p) => ({ id: p.tenantId, name: p.name })) })}>
                        <I.Plus size={12} /> Pedir de outro tenant
                      </button>
                      <button className="btn" data-variant="primary" data-size="sm" disabled={peers.length === 0}
                        onClick={() => setTransferForm({ toOptions: peers.map((p) => ({ id: p.tenantId, name: p.name })), prefillRequest: null })}>
                        <I.ArrowRight size={12} /> Enviar para outro tenant
                      </button>
                    </div>
                  </div>
                  {peers.length === 0 && (
                    <div style={{ fontSize: 12, color: "var(--fg-3)", marginBottom: 10 }}>
                      A rede ainda não tem outros tenants ativos.
                    </div>
                  )}
                  <SupplyRequestList
                    tid={tid}
                    requests={netRequests.filter((r) =>
                      (r.requesterTenantId === tid && r.supplierTenantId !== net.centralId) || r.supplierTenantId === tid)}
                    onChanged={() => reload()}
                    onFulfill={(r) => setTransferForm({
                      toOptions: [{ id: r.requesterTenantId, name: r.requesterName }],
                      prefillRequest: r,
                    })}
                    emptyHint="Nenhum pedido entre tenants ainda."
                  />
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)", marginBottom: 10 }}>Transferências enviadas por você</div>
                  <SupplyTransferList
                    tid={tid}
                    transfers={netTransfers.filter((t) => t.fromTenantId === tid)}
                    myItems={stockItems}
                    onChanged={() => reload()}
                    emptyHint="Você ainda não enviou transferências."
                  />
                </div>
              </div>
            )}

            {view === "receipts" && (
              <SupplyTransferList
                tid={tid}
                transfers={netTransfers.filter((t) => t.toTenantId === tid)}
                myItems={stockItems}
                onChanged={() => reload()}
                emptyHint="Nenhuma transferência para você ainda."
              />
            )}

            {view === "divergences" && (
              <SupplyDivergenceView tid={tid} scopeCentralId={net.centralId} />
            )}

            {view === "ledger" && (
              <div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 18 }}>
                  <SummaryStat label="Gasto acumulado com a rede" value={_supFmtBRL(net.myBalance)} />
                  <SummaryStat label="Lançamentos" value={String(netLedger.length)} />
                  <SummaryStat label="Central" value={net.centralName} />
                </div>
                <SupplyLedgerTable entries={netLedger} />
              </div>
            )}
          </>
        )}
      </div>

      {requestForm && net && (
        <SupplyRequestForm
          tid={tid} centralId={net.centralId} suppliers={requestForm.suppliers}
          onClose={() => setRequestForm(null)}
          onSaved={async () => { setRequestForm(null); await reload(); }}
        />
      )}

      {transferForm && net && (
        <SupplyTransferForm
          tid={tid} centralId={net.centralId}
          toOptions={transferForm.toOptions}
          stockItems={stockItems}
          prefillRequest={transferForm.prefillRequest}
          onClose={() => setTransferForm(null)}
          onSaved={async () => { setTransferForm(null); await reload(); }}
        />
      )}
    </div>
  );
}

Object.assign(window, {
  Suprimentos, SupplyStatusBadge, SupplyTransferForm, SupplyReceiveModal, SupplyTransferDetail,
  SupplyTransferList, SupplyRequestForm, SupplyRequestList, SupplyLedgerTable,
  SupplyDivergenceView, _supReasonLabel,
});
