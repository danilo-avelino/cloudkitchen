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

Object.assign(window, {
  Modal, FormRow, SummaryStat, notImplemented, PendingFeature,
  parseQtyText, findStockItemByName, computeStockStatus, applyStockMovement,
});
