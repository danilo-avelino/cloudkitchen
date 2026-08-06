// mobile-ui.jsx — Kit de primitivos mobile (celular ≤480px) + hook useIsMobile.
//
// Modelado no que já funciona em page-mobile-requests.jsx: full-screen, bottom
// sheets, touch targets ≥40px, inputs 16px (anti-zoom iOS), safe-area no rodapé.
// Tudo exposto no window (convenção cross-file dos arquivos legados).
//
// Contexto de uso:
//   - As PÁGINAS mobile (MobileStock, MobilePurchases…) renderizam DENTRO da área
//     de conteúdo do MobileApp (mobile-shell.jsx) → usam <MobilePage>/<MobileScroll>,
//     que preenchem o pai (height:100%), NÃO position:fixed.
//   - Os SHEETS que elas abrem são overlays fixed (BottomSheet / FullSheet).

// Breakpoint único de celular. Mantido aqui pra ser a fonte da verdade.
const MOBILE_QUERY = "(max-width: 480px)";

function useIsMobile() {
  const [m, setM] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(MOBILE_QUERY).matches
      : false
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const on = (e) => setM(e.matches);
    // addEventListener é o caminho moderno; Safari antigo usa addListener.
    if (mq.addEventListener) mq.addEventListener("change", on);
    else mq.addListener(on);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", on);
      else mq.removeListener(on);
    };
  }, []);
  return m;
}

// ---------------------------------------------------------------------------
// Estrutura de página (dentro do shell)
// ---------------------------------------------------------------------------
function MobilePage({ children, style }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", ...style }}>
      {children}
    </div>
  );
}

function MobileScroll({ children, style }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", WebkitOverflowScrolling: "touch", ...style }}>
      {children}
    </div>
  );
}

// Rodapé fixo com safe-area (CTA da página)
function MobileBottomBar({ children }) {
  return (
    <div style={{
      padding: "10px 14px calc(10px + env(safe-area-inset-bottom))",
      borderTop: "1px solid var(--line)", background: "var(--bg-1)", flexShrink: 0,
    }}>
      {children}
    </div>
  );
}

function MSectionLabel({ children, style }) {
  return (
    <span style={{
      fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)",
      letterSpacing: "0.08em", textTransform: "uppercase", ...style,
    }}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Segmented tabs (rolável) — substitui as sub-abas densas do desktop
// options: [{ id, label, count, tone }]
// ---------------------------------------------------------------------------
function SegTabs({ value, onChange, options }) {
  return (
    <div style={{
      display: "flex", gap: 6, padding: "10px 14px", overflowX: "auto",
      borderBottom: "1px solid var(--line)", WebkitOverflowScrolling: "touch",
      scrollbarWidth: "none",
    }}>
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button key={o.id} onClick={() => onChange(o.id)} style={{
            flexShrink: 0, height: 34, padding: "0 14px", borderRadius: 999,
            display: "inline-flex", alignItems: "center", gap: 6,
            background: active ? "var(--accent-bright)" : "var(--bg-2)",
            color: active ? "var(--accent-fg, #07080a)" : "var(--fg-1)",
            border: `1px solid ${active ? "var(--accent-bright)" : "var(--line)"}`,
            fontSize: 13, fontWeight: active ? 600 : 400, whiteSpace: "nowrap",
          }}>
            {o.label}
            {(o.count != null) && (
              <span style={{
                fontFamily: "var(--mono)", fontSize: 10.5,
                padding: "0 5px", borderRadius: 999,
                background: active ? "rgba(0,0,0,0.18)" : "var(--bg-3)",
                color: active ? "inherit"
                  : o.tone === "crit" ? "var(--crit)"
                  : o.tone === "warn" ? "var(--warn)" : "var(--fg-3)",
              }}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatStrip — KPIs numa faixa horizontal rolável (substitui repeat(4,1fr))
// stats: [{ label, value, sub, tone, onClick }]
// ---------------------------------------------------------------------------
function StatStrip({ stats }) {
  const toneColor = (t) =>
    t === "crit" ? "var(--crit)" : t === "warn" ? "var(--warn)"
    : t === "ok" ? "var(--ok)" : t === "in" ? "var(--ok)"
    : t === "out" ? "var(--crit)" : "var(--fg-0)";
  return (
    <div style={{
      display: "flex", gap: 10, padding: "12px 14px", overflowX: "auto",
      WebkitOverflowScrolling: "touch", scrollbarWidth: "none",
    }}>
      {stats.map((s, i) => (
        <button key={i} onClick={s.onClick} disabled={!s.onClick} style={{
          flexShrink: 0, minWidth: 128, textAlign: "left",
          padding: "10px 12px", borderRadius: 10,
          background: "var(--bg-2)", border: "1px solid var(--line)",
          cursor: s.onClick ? "pointer" : "default",
        }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
            {s.label}
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4, color: toneColor(s.tone), letterSpacing: "-0.01em" }}>
            {s.value}
          </div>
          {s.sub && <div style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 2 }}>{s.sub}</div>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MobileCard — card tocável genérico (linha de lista)
// ---------------------------------------------------------------------------
function MobileCard({ onClick, children, tone, style }) {
  const border =
    tone === "crit" ? "var(--crit-line)" :
    tone === "warn" ? "var(--warn-line)" :
    tone === "accent" ? "var(--accent-line)" : "var(--line)";
  const bg =
    tone === "accent" ? "var(--accent-soft)" : "var(--bg-2)";
  return (
    <button onClick={onClick} disabled={!onClick} style={{
      display: "block", width: "100%", textAlign: "left",
      padding: "12px 14px", borderRadius: 10,
      background: bg, border: `1px solid ${border}`,
      cursor: onClick ? "pointer" : "default", color: "inherit", ...style,
    }}>
      {children}
    </button>
  );
}

// Badge de status reaproveitável (mesmos tons do desktop)
function MBadge({ tone, children }) {
  const map = {
    ok:   { c: "var(--ok)",   b: "var(--ok-soft)",   l: "var(--ok-line)" },
    warn: { c: "var(--warn)", b: "var(--warn-soft)", l: "var(--warn-line)" },
    crit: { c: "var(--crit)", b: "var(--crit-soft)", l: "var(--crit-line)" },
    info: { c: "var(--info, var(--accent-bright))", b: "var(--bg-3)", l: "var(--line)" },
    neutral: { c: "var(--fg-2)", b: "var(--bg-3)", l: "var(--line)" },
  };
  const m = map[tone] || map.neutral;
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 600, padding: "2px 8px", borderRadius: 999,
      color: m.c, background: m.b, border: `1px solid ${m.l}`, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

// ---------------------------------------------------------------------------
// BottomSheet — modal ancorado no rodapé (ações curtas, detalhe de item)
// ---------------------------------------------------------------------------
function BottomSheet({ title, subtitle, onClose, children, footer, maxHeight = "86vh" }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose && onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 300,
      background: "rgba(7,8,10,0.6)",
      display: "flex", flexDirection: "column", justifyContent: "flex-end",
      animation: "fadeUp 140ms ease both",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: "var(--bg-1)", borderTop: "1px solid var(--line-strong)",
        borderTopLeftRadius: 16, borderTopRightRadius: 16,
        width: "100%", maxWidth: 520, margin: "0 auto",
        display: "flex", flexDirection: "column", maxHeight,
      }}>
        <div style={{ width: 38, height: 4, borderRadius: 2, background: "var(--line-strong)", margin: "10px auto 6px", flexShrink: 0 }} />
        {(title || onClose) && (
          <div style={{ padding: "4px 18px 10px", display: "flex", alignItems: "flex-start", gap: 10, flexShrink: 0 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {title && <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-0)" }}>{title}</div>}
              {subtitle && <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 2 }}>{subtitle}</div>}
            </div>
            {onClose && (
              <button onClick={onClose} aria-label="Fechar" style={{
                width: 34, height: 34, borderRadius: 8, flexShrink: 0,
                background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-2)",
                display: "grid", placeItems: "center",
              }}><I.X size={15} /></button>
            )}
          </div>
        )}
        <div style={{ overflow: "auto", WebkitOverflowScrolling: "touch", padding: "0 18px 16px" }}>
          {children}
        </div>
        {footer && (
          <div style={{ padding: "12px 18px calc(12px + env(safe-area-inset-bottom))", borderTop: "1px solid var(--line)", flexShrink: 0 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FullSheet — tela cheia p/ fluxos longos (formulários, recebimento em etapas)
// ---------------------------------------------------------------------------
function FullSheet({ title, subtitle, onBack, children, footer }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onBack && onBack(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 300, background: "var(--bg-0)",
      display: "flex", flexDirection: "column", animation: "fadeUp 160ms ease both",
    }}>
      <div style={{ width: "100%", maxWidth: 520, margin: "0 auto", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          <button onClick={onBack} aria-label="Voltar" style={{
            width: 40, height: 40, borderRadius: 8, flexShrink: 0,
            background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)",
            display: "grid", placeItems: "center",
          }}><I.Chevron size={18} style={{ transform: "rotate(90deg)" }} /></button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
            {subtitle && <div style={{ fontSize: 11.5, color: "var(--fg-3)" }}>{subtitle}</div>}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", WebkitOverflowScrolling: "touch", padding: "14px 16px" }}>
          {children}
        </div>
        {footer && (
          <div style={{ padding: "10px 16px calc(10px + env(safe-area-inset-bottom))", borderTop: "1px solid var(--line)", background: "var(--bg-1)", flexShrink: 0 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stepper — controle numérico grande (qtd). value string/number, onChange(number)
// ---------------------------------------------------------------------------
function Stepper({ value, onChange, step = 1, unit, min = 0 }) {
  const round = (n) => Math.round(n * 100) / 100;
  const num = Number(String(value).replace(",", ".")) || 0;
  const dec = () => onChange(round(Math.max(min, num - step)));
  const inc = () => onChange(round(num + step));
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14 }}>
      <button onClick={dec} style={mBigStep}>−</button>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <input value={value} inputMode="decimal"
          onChange={(e) => {
            const v = e.target.value.replace(",", ".");
            if (v === "") { onChange(""); return; }
            const n = parseFloat(v); onChange(Number.isFinite(n) ? n : "");
          }}
          onBlur={(e) => { const n = parseFloat(String(e.target.value).replace(",", ".")); onChange(Number.isFinite(n) && n >= min ? round(n) : min); }}
          style={{ width: 96, height: 56, textAlign: "center", borderRadius: 10, background: "var(--bg-0)", border: "1px solid var(--line)", color: "var(--fg-0)", fontSize: 26, fontWeight: 600 }} />
        {unit && <span style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 4 }}>{unit}</span>}
      </div>
      <button onClick={inc} style={mBigStep}>+</button>
    </div>
  );
}

// Campo de formulário mobile (label + children), inputs 16px
function MField({ label, hint, children, error }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div style={{ fontSize: 12.5, color: "var(--fg-2)", marginBottom: 6, fontWeight: 500 }}>{label}</div>
      {children}
      {hint && !error && <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 4 }}>{hint}</div>}
      {error && <div style={{ fontSize: 11, color: "var(--crit)", marginTop: 4 }}>{error}</div>}
    </label>
  );
}

// Botão CTA primário full-width (com estado carregando + guard de duplo-clique)
function MPrimaryButton({ onClick, disabled, loading, children }) {
  const off = disabled || loading;
  return (
    <button onClick={() => { if (!off && onClick) onClick(); }} disabled={off} style={{
      width: "100%", height: 52, borderRadius: 10, border: "none",
      background: off ? "var(--bg-3)" : "var(--accent-bright)",
      color: off ? "var(--fg-3)" : "var(--accent-fg, #07080a)",
      fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em",
      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
      opacity: loading ? 0.75 : 1,
    }}>
      {loading ? "Carregando…" : children}
    </button>
  );
}

// Input de busca padrão mobile
function MSearch({ value, onChange, placeholder = "Buscar…" }) {
  return (
    <div style={{ position: "relative" }}>
      <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--fg-3)", pointerEvents: "none" }}>
        <I.Search size={15} />
      </span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={{
        width: "100%", height: 44, padding: value ? "0 40px 0 36px" : "0 12px 0 36px", borderRadius: 8,
        background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-0)", fontSize: 16,
      }} />
      {value && (
        <button onClick={() => onChange("")} aria-label="Limpar" style={{
          position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
          width: 28, height: 28, borderRadius: 6, background: "transparent", border: "none",
          color: "var(--fg-3)", display: "grid", placeItems: "center",
        }}><I.X size={14} /></button>
      )}
    </div>
  );
}

// mInput: estilo base p/ inputs mobile (16px anti-zoom)
const mInput = {
  width: "100%", height: 44, padding: "0 12px", borderRadius: 8,
  background: "var(--bg-2)", border: "1px solid var(--line)",
  color: "var(--fg-0)", fontSize: 16,
};
const mStep = {
  width: 40, height: 40, borderRadius: 8, flexShrink: 0,
  background: "var(--bg-3)", border: "1px solid var(--line)", color: "var(--fg-0)",
  fontSize: 18, display: "grid", placeItems: "center",
};
const mBigStep = {
  width: 56, height: 56, borderRadius: 12, flexShrink: 0,
  background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-0)",
  fontSize: 26, display: "grid", placeItems: "center",
};

Object.assign(window, {
  useIsMobile, MOBILE_QUERY,
  MobilePage, MobileScroll, MobileBottomBar, MSectionLabel,
  SegTabs, StatStrip, MobileCard, MBadge,
  BottomSheet, FullSheet, Stepper, MField, MPrimaryButton, MSearch,
  mInput, mStep, mBigStep,
});
