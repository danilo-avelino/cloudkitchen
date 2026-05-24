// Componentes compartilhados (Modal + FormRow + Confirm) usados em várias páginas
function Modal({ title, subtitle, onClose, children, footer, width = 480, minHeight }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose && onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 200,
      background: "rgba(7,8,10,0.6)",
      display: "grid", placeItems: "center", padding: 20,
      animation: "fadeUp 160ms ease both",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width, maxWidth: "calc(100vw - 32px)", maxHeight: "92vh",
        minHeight: minHeight || undefined,
        background: "var(--bg-1)", border: "1px solid var(--line-strong)",
        borderRadius: 6, display: "flex", flexDirection: "column",
        boxShadow: "0 24px 60px -12px rgba(0,0,0,0.6)",
      }}>
        <div style={{
          padding: "16px 20px", borderBottom: "1px solid var(--line)",
          display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12,
        }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.01em" }}>{title}</h2>
            {subtitle && <div style={{ fontSize: 12, color: "var(--fg-2)", marginTop: 4 }}>{subtitle}</div>}
          </div>
          <button type="button" className="btn" data-variant="ghost" data-size="sm" onClick={onClose} title="Fechar">
            <I.X size={13} />
          </button>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "18px 20px" }}>{children}</div>
        {footer && (
          <div style={{
            padding: "14px 20px", borderTop: "1px solid var(--line)",
            display: "flex", justifyContent: "flex-end", gap: 8,
          }}>{footer}</div>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// <ConfirmDialog> · substituto interno para window.confirm()
// =====================================================================
// Use no lugar de confirm() do navegador para ações destrutivas (excluir,
// resetar, etc.). Renderiza por cima de qualquer Modal aberto (z-index 250).
//
// Props:
//   open         · controla visibilidade
//   title        · cabeçalho curto (ex. "Excluir lançamento")
//   message      · descrição da ação — string ou nó React
//   confirmLabel · texto do botão primário (default "Confirmar")
//   cancelLabel  · texto do botão secundário (default "Cancelar")
//   tone         · "danger" (default) | "neutral"
//   busy         · desabilita os botões enquanto a ação roda
//   onConfirm / onCancel · handlers
function ConfirmDialog({
  open,
  title = "Confirmar ação",
  message,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (busy) return;
      if (e.key === "Escape") { e.preventDefault(); onCancel && onCancel(); }
      if (e.key === "Enter")  { e.preventDefault(); onConfirm && onConfirm(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onConfirm, onCancel]);

  if (!open) return null;

  const isDanger = tone === "danger";
  const accent = isDanger ? "var(--crit)" : "var(--accent-bright)";
  const accentSoft = isDanger ? "var(--crit-soft)" : "var(--accent-soft)";
  const accentLine = isDanger ? "var(--crit-line)" : "var(--accent-line)";

  return (
    <div
      onClick={busy ? undefined : onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 250,
        background: "rgba(7,8,10,0.72)",
        display: "grid", placeItems: "center", padding: 20,
        animation: "fadeUp 140ms ease both",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        style={{
          width: 420, maxWidth: "calc(100vw - 32px)",
          background: "var(--bg-1)",
          border: "1px solid var(--line-strong)",
          borderRadius: 6,
          boxShadow: "0 24px 60px -12px rgba(0,0,0,0.7)",
          display: "flex", flexDirection: "column",
        }}
      >
        <div style={{ padding: "20px 22px 16px", display: "flex", gap: 14, alignItems: "flex-start" }}>
          <div style={{
            flexShrink: 0,
            width: 36, height: 36, borderRadius: 6,
            background: accentSoft, border: "1px solid " + accentLine,
            display: "grid", placeItems: "center", color: accent,
          }}>
            <I.AlertTriangle size={18} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2
              id="confirm-dialog-title"
              style={{ margin: 0, fontSize: 15, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.01em" }}
            >
              {title}
            </h2>
            {message && (
              <div style={{ fontSize: 13, color: "var(--fg-2)", marginTop: 6, lineHeight: 1.5 }}>
                {message}
              </div>
            )}
          </div>
        </div>
        <div style={{
          padding: "12px 18px",
          borderTop: "1px solid var(--line)",
          display: "flex", justifyContent: "flex-end", gap: 8,
          background: "var(--bg-0)",
          borderBottomLeftRadius: 6, borderBottomRightRadius: 6,
        }}>
          <button
            type="button"
            className="btn"
            data-size="sm"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn"
            data-variant={isDanger ? "danger" : "primary"}
            data-size="sm"
            onClick={onConfirm}
            disabled={busy}
            autoFocus
          >
            {busy ? "Processando…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function FormRow({ label, hint, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{hint}</span>}
    </label>
  );
}

// Helper de feedback de "ainda em desenvolvimento" — usado por botões que exigem
// integração externa (Exportar, Importar iFood, Conectar, etc.) enquanto não temos backend.
function notImplemented(label, opts = {}) {
  if (typeof window.showToast === "function") {
    window.showToast(`${label} · em breve`, { tone: "warn", ...opts });
  }
}

// =====================================================================
// Helpers de movimentação de estoque (entrada/saída)
// =====================================================================
// Mutam MOCK.STOCK_ITEMS direto — quando o usuário voltar pra página de Estoque,
// o useState reseed de MOCK e enxerga o novo saldo.
// TODO backend: cada chamada vira INSERT em public.stock_movements (entrada com
// kind='in', saída com kind='out'); o trigger já existente atualiza
// stock_items.current_qty + cost médio.

function _normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .trim();
}

// Parse de "12 kg" / "20 und" / "0,5 kg" → { qty, unit }
function parseQtyText(raw) {
  const m = String(raw || "").match(/([\d,.]+)\s*(.*)/);
  if (!m) return { qty: 0, unit: "" };
  return {
    qty:  parseFloat(m[1].replace(",", ".")) || 0,
    unit: (m[2] || "").trim(),
  };
}

// Encontra um item em `pool` (lista) que casa com o nome dado · case + acento-insensitive.
// Tenta match exato primeiro, depois inclusão parcial (qualquer direção).
// Default pool é `MOCK.STOCK_ITEMS` pra retro-compat; chamadas modernas devem passar a lista.
function findStockItemByName(name, pool) {
  const list = pool || (window.MOCK && MOCK.STOCK_ITEMS) || [];
  const target = _normalizeName(name);
  if (!target) return null;
  let found = list.find((it) => _normalizeName(it.name) === target);
  if (found) return found;
  found = list.find((it) => {
    const ni = _normalizeName(it.name);
    return ni.includes(target) || target.includes(ni);
  });
  return found || null;
}

// Recalcula status (ok / warn / crit) com base em qty x reorder.
// Espelha a lógica em page-stock.jsx.
function computeStockStatus(it) {
  if (!it) return "ok";
  if (it.qty <= 0) return "crit";
  if (it.reorder > 0 && it.qty < it.reorder * 0.25) return "crit";
  if (it.qty < it.reorder) return "warn";
  return "ok";
}

// Aplica uma movimentação no item:
//   deltaQty > 0  → entrada (atualiza custo médio se newUnitCost informado)
//   deltaQty < 0  → saída
// Retorna { ok, oldQty, newQty } ou null se item inválido.
function applyStockMovement(stockItem, deltaQty, newUnitCost) {
  if (!stockItem) return null;
  const oldQty  = Number(stockItem.qty)  || 0;
  const oldCost = Number(stockItem.cost) || 0;
  const delta   = Number(deltaQty)       || 0;
  const newQty  = oldQty + delta;

  // Custo médio ponderado · só nas entradas com custo informado
  if (delta > 0 && newUnitCost > 0) {
    const totalValue = oldQty * oldCost + delta * Number(newUnitCost);
    stockItem.cost = newQty > 0 ? Number((totalValue / newQty).toFixed(2)) : oldCost;
  }
  stockItem.qty    = Math.max(0, Number(newQty.toFixed(3)));
  stockItem.status = computeStockStatus(stockItem);
  return { ok: true, oldQty, newQty: stockItem.qty };
}

// =====================================================================
// <PendingFeature> · marcador visual de funcionalidade pendente
// =====================================================================
// Use quando uma parte do produto depende de backend/infra que ainda não foi
// integrada. Deixa o gancho visível (badge inline ou bloco completo) pra
// rastreabilidade — o usuário lembra o que falta sem consultar notas externas.
//
// Variants:
//   "badge"  → pílula compacta inline (default)
//   "block"  → card explicativo com ícone + título + descrição (use em
//              seções inteiras que são placeholders)
//   "inline" → texto pequeno cinza (use em rótulos secundários)
function SummaryStat({ label, value, tone }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</span>
      <span className="mono" style={{
        fontSize: 16, fontWeight: 500,
        color: tone === "crit" ? "var(--crit)" : tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn)" : "var(--fg-0)",
      }}>{value}</span>
    </div>
  );
}

function PendingFeature({ variant = "badge", label, hint, children, style: extra }) {
  if (variant === "block") {
    return (
      <div style={{
        padding: "16px 18px",
        background: "var(--bg-2)",
        border: "1px dashed var(--line-strong)",
        borderRadius: 6,
        display: "flex", alignItems: "flex-start", gap: 12,
        ...(extra || {}),
      }}>
        <div style={{
          flexShrink: 0, width: 32, height: 32, borderRadius: 6,
          background: "var(--warn-soft)", border: "1px solid var(--warn-line)",
          display: "grid", placeItems: "center", color: "var(--warn)",
        }}>
          <I.AlertTriangle size={15} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4,
          }}>
            <span style={{
              fontSize: 13, fontWeight: 500, color: "var(--fg-0)",
            }}>{label || "Em breve"}</span>
            <span style={{
              fontFamily: "var(--mono)", fontSize: 9, color: "var(--warn)",
              letterSpacing: "0.08em", textTransform: "uppercase",
              padding: "1px 6px", border: "1px solid var(--warn-line)",
              background: "var(--warn-soft)", borderRadius: 99,
            }}>pendente</span>
          </div>
          {hint && (
            <div style={{ fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.5 }}>{hint}</div>
          )}
          {children && <div style={{ marginTop: 8 }}>{children}</div>}
        </div>
      </div>
    );
  }
  if (variant === "inline") {
    return (
      <span title={hint} style={{
        fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--warn)",
        letterSpacing: "0.06em", textTransform: "uppercase",
        ...(extra || {}),
      }}>
        {label || "em breve"}
      </span>
    );
  }
  // badge default
  return (
    <span title={hint} style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontFamily: "var(--mono)", fontSize: 9, fontWeight: 500,
      color: "var(--warn)",
      letterSpacing: "0.06em", textTransform: "uppercase",
      padding: "2px 7px",
      background: "var(--warn-soft)", border: "1px solid var(--warn-line)",
      borderRadius: 99, cursor: hint ? "help" : "default",
      ...(extra || {}),
    }}>
      <span style={{ width: 5, height: 5, borderRadius: 50, background: "var(--warn)" }} />
      {label || "em breve"}
    </span>
  );
}

// =====================================================================
// <PageLoading> · skeleton de carregamento para páginas inteiras
// =====================================================================
// Use no topo do return da página enquanto o fetch inicial não terminou:
//   if (loading) return <PageLoading label="Carregando faturamento…" variant="table" />;
//
// Variants:
//   "dashboard" · grid de KPIs + dois cards grandes (Dashboard, CMV)
//   "table"     · linha de filtros + tabela (Stock, Revenue, Recipes, etc.)
//   "cards"     · grid de cards (Requests, Purchases)
//   "form"      · coluna de campos (Settings)
//   "minimal"   · só spinner + label centralizado
function PageLoading({ label = "Carregando…", hint = "Buscando dados do servidor", variant = "table" }) {
  const skel = (w, h, extra) => (
    <div className="skel" style={{ width: w, height: h, ...(extra || {}) }} />
  );

  const block = (children) => (
    <div style={{
      position: "relative",
      flex: 1, minHeight: 0, height: "100%",
      padding: "20px 28px 32px",
      display: "flex", flexDirection: "column", gap: 18,
      animation: "fadeUp 200ms ease both",
    }}>
      {children}
    </div>
  );

  const headerRow = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 4 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {skel(80, 9)}
        {skel(220, 22)}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {skel(96, 30, { borderRadius: 4 })}
        {skel(120, 30, { borderRadius: 4 })}
      </div>
    </div>
  );

  let body;
  if (variant === "dashboard") {
    body = (
      <>
        {headerRow}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{
              padding: 14, background: "var(--bg-1)", border: "1px solid var(--line)",
              borderRadius: 6, display: "flex", flexDirection: "column", gap: 10,
            }}>
              {skel(60, 9)}
              {skel(120, 24)}
              {skel(80, 9)}
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 12 }}>
          <div style={{ padding: 16, background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 6, display: "flex", flexDirection: "column", gap: 12 }}>
            {skel(140, 12)}
            {skel("100%", 180, { borderRadius: 4 })}
          </div>
          <div style={{ padding: 16, background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: 6, display: "flex", flexDirection: "column", gap: 10 }}>
            {skel(140, 12)}
            {Array.from({ length: 4 }).map((_, i) => skel("100%", 28, { borderRadius: 4 }))}
          </div>
        </div>
      </>
    );
  } else if (variant === "cards") {
    body = (
      <>
        {headerRow}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{
              padding: 14, background: "var(--bg-1)", border: "1px solid var(--line)",
              borderRadius: 6, display: "flex", flexDirection: "column", gap: 10,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                {skel(80, 11)}
                {skel(50, 11)}
              </div>
              {skel("80%", 16)}
              {skel("100%", 10)}
              {skel("90%", 10)}
              <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                {skel(56, 22, { borderRadius: 99 })}
                {skel(56, 22, { borderRadius: 99 })}
              </div>
            </div>
          ))}
        </div>
      </>
    );
  } else if (variant === "form") {
    body = (
      <>
        {headerRow}
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {skel(100, 9)}
              {skel("100%", 32, { borderRadius: 4 })}
            </div>
          ))}
        </div>
      </>
    );
  } else if (variant === "minimal") {
    body = null;
  } else {
    // "table" default
    body = (
      <>
        {headerRow}
        <div style={{ display: "flex", gap: 8 }}>
          {skel(120, 28, { borderRadius: 99 })}
          {skel(96, 28, { borderRadius: 99 })}
          {skel(96, 28, { borderRadius: 99 })}
        </div>
        <div style={{
          background: "var(--bg-1)", border: "1px solid var(--line)",
          borderRadius: 6, padding: 14, display: "flex", flexDirection: "column", gap: 10,
        }}>
          <div style={{ display: "flex", gap: 10 }}>
            {skel(140, 11)}
            <div style={{ flex: 1 }} />
            {skel(80, 11)}
            {skel(80, 11)}
            {skel(80, 11)}
          </div>
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0", borderTop: i === 0 ? "1px solid var(--line)" : "1px solid var(--line-soft)" }}>
              {skel(180, 12)}
              <div style={{ flex: 1 }} />
              {skel(64, 11)}
              {skel(64, 11)}
              {skel(64, 11)}
            </div>
          ))}
        </div>
      </>
    );
  }

  return block(
    <>
      {body}
      <div style={{
        position: "absolute", bottom: 24, left: "50%", transform: "translateX(-50%)",
        display: "flex", alignItems: "center", gap: 10,
        padding: "8px 14px",
        background: "var(--bg-1)", border: "1px solid var(--line-strong)",
        borderRadius: 99,
        boxShadow: "0 8px 24px -6px rgba(0,0,0,0.4)",
        pointerEvents: "none",
      }}>
        <span
          aria-hidden="true"
          style={{
            width: 12, height: 12, borderRadius: "50%",
            border: "1.5px solid var(--line-strong)",
            borderTopColor: "var(--accent-bright)",
            animation: "pl-spin 0.9s linear infinite",
          }}
        />
        <span style={{ fontSize: 11.5, color: "var(--fg-1)", fontWeight: 500 }}>{label}</span>
        {hint && <span style={{ fontSize: 11, color: "var(--fg-3)" }}>· {hint}</span>}
      </div>
    </>
  );
}

Object.assign(window, {
  Modal, ConfirmDialog, FormRow, SummaryStat, notImplemented, PendingFeature, PageLoading,
  parseQtyText, findStockItemByName, computeStockStatus, applyStockMovement,
});
