// mobile-shell.jsx — MobileApp: shell de celular (top bar + bottom nav + drawer).
// Renderizado no lugar do AppShell quando useIsMobile() é true (ver src/App.jsx).
//
// Páginas com versão mobile dedicada entram por MOBILE_PAGES; as demais caem no
// componente desktop dentro de um wrapper, com aviso "ainda não otimizado" — isso
// permite lançar mobile PÁGINA POR PÁGINA sem quebrar o resto.

// id → componente mobile dedicado (lidos lazy do window no render).
const MOBILE_PAGE_IDS = ["dashboard", "stock", "purchases", "requests", "revenue", "cmv", "production", "finance", "recipes", "settings", "dre", "delivery", "cardapio", "crm", "supply", "distribution"];

// Config de navegação (espelha shell.jsx · label + ícone por módulo).
const MNAV = [
  { id: "dashboard",    label: "Dashboard",       icon: "Dashboard" },
  { id: "stock",        label: "Estoque",          icon: "Stock" },
  { id: "production",   label: "Produção",         icon: "Play" },
  { id: "supply",       label: "Suprimentos",      icon: "Truck" },
  { id: "distribution", label: "Central",          icon: "Truck" },
  { id: "recipes",      label: "Fichas técnicas",  icon: "Recipe" },
  { id: "revenue",      label: "Faturamento",      icon: "Revenue" },
  { id: "delivery",     label: "Logística",        icon: "Clock" },
  { id: "cardapio",     label: "Análise de Cardápio", icon: "Recipe" },
  { id: "crm",          label: "CRM",              icon: "WhatsApp" },
  { id: "requests",     label: "Requisições",      icon: "Request" },
  { id: "purchases",    label: "Compras",          icon: "ShoppingList" },
  { id: "cmv",          label: "CMV & margem",     icon: "CMV", short: "CMV" },
  { id: "finance",      label: "Financeiro",       icon: "Finance" },
  { id: "dre",          label: "DRE & Fechamento", icon: "Lock" },
  { id: "settings",     label: "Configurações",    icon: "Settings" },
];
const MNAV_BY_ID = Object.fromEntries(MNAV.map((n) => [n.id, n]));

// Ordem de prioridade pra escolher os 4 atalhos da bottom nav.
const MNAV_PRIORITY = ["dashboard", "stock", "requests", "purchases", "production", "revenue", "cmv", "finance", "dre", "recipes", "delivery", "supply", "distribution", "cardapio", "crm", "settings"];

const M_TITLE = {
  dashboard: "Dashboard", stock: "Estoque", production: "Produção", supply: "Suprimentos",
  distribution: "Central", recipes: "Fichas técnicas", revenue: "Faturamento",
  delivery: "Logística", cardapio: "Cardápio", crm: "CRM", requests: "Requisições",
  purchases: "Compras", cmv: "CMV & margem", finance: "Financeiro", dre: "DRE",
  settings: "Configurações", saas: "Gestão SaaS",
};

function MobileApp({ t, setTweak, scope, setScope, page, setPage, toasts, user, onLogout, onSwitchTenant }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const allowed = (typeof getAllowedModules === "function" ? getAllowedModules(user) : ["dashboard"])
    .filter((id) => id !== "saas"); // superadmin de plataforma não tem fluxo mobile

  const setTheme = (v) => setTweak && setTweak("theme", v);

  // Atalhos da barra inferior: 4 primeiros por prioridade + CMV fixado + "Mais".
  let primary = MNAV_PRIORITY.filter((id) => allowed.includes(id)).slice(0, 4);
  if (allowed.includes("cmv") && !primary.includes("cmv")) primary = [...primary, "cmv"];
  const showMore = allowed.some((id) => !primary.includes(id));

  // Componente mobile dedicado (lazy do window) ou fallback desktop.
  const MobilePageComp = MOBILE_PAGE_IDS.includes(page) ? window[mobileCompName(page)] : null;

  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--bg-0)", color: "var(--fg-1)" }}>
      {/* Top app bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
        padding: "calc(8px + env(safe-area-inset-top)) 14px 8px",
        borderBottom: "1px solid var(--line)", background: "var(--bg-1)",
      }}>
        <img src={(import.meta.env.BASE_URL || "/") + "icon.png"} alt="" style={{ width: 26, height: 26, objectFit: "contain", flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-0)", letterSpacing: "-0.01em" }}>
            {M_TITLE[page] || "StockKitchen"}
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.05em", textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {user?.tenantName || "Cloud Kitchen"}
          </div>
        </div>
        <button onClick={() => setDrawerOpen(true)} aria-label="Menu" style={{
          width: 40, height: 40, borderRadius: 8, flexShrink: 0,
          background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)",
          display: "grid", placeItems: "center",
        }}><I.More size={18} /></button>
      </div>

      {/* Conteúdo da página */}
      <div key={page} style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {MobilePageComp
          ? <MobilePageComp scope={scope} setPage={setPage} user={user} />
          : <DesktopFallback page={page} scope={scope} setPage={setPage} user={user} onLogout={onLogout} />}
      </div>

      {/* Bottom nav */}
      <div style={{
        display: "flex", flexShrink: 0, borderTop: "1px solid var(--line)", background: "var(--bg-1)",
        padding: "0 0 env(safe-area-inset-bottom)",
      }}>
        {primary.map((id) => (
          <BottomNavItem key={id} nav={MNAV_BY_ID[id]} active={page === id} onClick={() => setPage(id)} />
        ))}
        {showMore && (
          <BottomNavItem nav={{ label: "Mais", icon: "More" }} active={drawerOpen} onClick={() => setDrawerOpen(true)} />
        )}
      </div>

      {/* Drawer (lista completa + conta) */}
      {drawerOpen && (
        <MobileDrawer
          allowed={allowed} page={page} user={user} theme={t?.theme}
          onNavigate={(id) => { setDrawerOpen(false); setPage(id); }}
          onSwitchTenant={onSwitchTenant}
          onToggleTheme={() => setTheme(t?.theme === "dark" ? "light" : "dark")}
          onLogout={onLogout}
          onClose={() => setDrawerOpen(false)}
        />
      )}

      <Toasts toasts={toasts} />
    </div>
  );
}

function BottomNavItem({ nav, active, onClick }) {
  const Ico = I[nav.icon] || I.Dashboard;
  return (
    <button onClick={onClick} style={{
      flex: 1, minWidth: 0, height: 56, background: "transparent", border: "none",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
      color: active ? "var(--accent-bright)" : "var(--fg-3)",
    }}>
      <Ico size={19} stroke={active ? 2 : 1.5} />
      <span style={{ fontSize: 10, fontWeight: active ? 600 : 400, whiteSpace: "nowrap", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>
        {nav.short || nav.label}
      </span>
    </button>
  );
}

function MobileDrawer({ allowed, page, user, theme, onNavigate, onSwitchTenant, onToggleTheme, onLogout, onClose }) {
  const tenants = Array.isArray(user?.tenants) ? user.tenants : [];
  const items = allowed.map((id) => MNAV_BY_ID[id]).filter(Boolean);
  const initials = user?.name?.split(" ").map((n) => n[0]).slice(0, 2).join("") || "?";
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(7,8,10,0.6)", display: "flex", justifyContent: "flex-end", animation: "fadeUp 140ms ease both" }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "82%", maxWidth: 340, height: "100%", background: "var(--bg-1)",
        borderLeft: "1px solid var(--line-strong)", display: "flex", flexDirection: "column",
      }}>
        {/* Header do drawer */}
        <div style={{ padding: "calc(14px + env(safe-area-inset-top)) 16px 14px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: "var(--accent)", color: "#cfeede", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 600, flexShrink: 0 }}>{initials}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{user?.name || "Usuário"}</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>{(user?.role || "").toUpperCase()}</div>
          </div>
          <button onClick={onClose} aria-label="Fechar" style={{ width: 36, height: 36, borderRadius: 8, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-2)", display: "grid", placeItems: "center" }}><I.X size={15} /></button>
        </div>

        {/* Lista de módulos */}
        <div style={{ flex: 1, overflow: "auto", WebkitOverflowScrolling: "touch", padding: "10px 10px" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.1em", textTransform: "uppercase", padding: "6px 8px" }}>Módulos</div>
          {items.map((nav) => {
            const Ico = I[nav.icon] || I.Dashboard;
            const active = page === nav.id;
            // Módulos sem tela mobile dedicada abrem a versão desktop (não otimizada).
            const adapted = MOBILE_PAGE_IDS.includes(nav.id);
            return (
              <button key={nav.id} onClick={() => onNavigate(nav.id)} style={{
                display: "flex", alignItems: "center", gap: 12, width: "100%",
                padding: "12px 10px", borderRadius: 8, border: "none",
                background: active ? "var(--bg-3)" : "transparent",
                color: active ? "var(--fg-0)" : "var(--fg-1)", textAlign: "left",
              }}>
                <Ico size={17} stroke={1.5} style={{ color: active ? "var(--accent-bright)" : "var(--fg-2)", flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 14, color: adapted ? undefined : "var(--fg-2)" }}>{nav.label}</span>
                {!adapted && (
                  <span style={{
                    flexShrink: 0, fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.04em", textTransform: "uppercase",
                    color: "var(--fg-3)", background: "var(--bg-2)", border: "1px solid var(--line)",
                    borderRadius: 999, padding: "2px 7px",
                  }}>desktop</span>
                )}
              </button>
            );
          })}

          {/* Trocar conta */}
          {tenants.length > 1 && (
            <>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.1em", textTransform: "uppercase", padding: "14px 8px 6px" }}>Conta</div>
              {tenants.map((tn) => {
                const active = tn.id === user?.tenantId;
                return (
                  <button key={tn.id} onClick={() => { if (!active) onSwitchTenant?.(tn.id); }} style={{
                    display: "flex", alignItems: "center", gap: 10, width: "100%",
                    padding: "11px 10px", borderRadius: 8, border: "none",
                    background: active ? "var(--bg-3)" : "transparent", textAlign: "left",
                  }}>
                    <span style={{ width: 7, height: 7, borderRadius: 50, flexShrink: 0, background: active ? "var(--accent-bright)" : "var(--fg-4)" }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 13, color: active ? "var(--fg-0)" : "var(--fg-1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tn.name}</span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-3)", textTransform: "uppercase" }}>{tn.role}</span>
                    </span>
                    {active && <I.Check size={14} style={{ color: "var(--accent-bright)", flexShrink: 0 }} />}
                  </button>
                );
              })}
            </>
          )}
        </div>

        {/* Rodapé: tema + sair */}
        <div style={{ padding: "10px 10px calc(10px + env(safe-area-inset-bottom))", borderTop: "1px solid var(--line)" }}>
          <button onClick={onToggleTheme} style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 10px", borderRadius: 8, border: "none", background: "transparent", color: "var(--fg-1)", textAlign: "left" }}>
            {theme === "dark" ? <I.Sun size={17} /> : <I.Moon size={17} />}
            <span style={{ fontSize: 14 }}>{theme === "dark" ? "Tema claro" : "Tema escuro"}</span>
          </button>
          <button onClick={onLogout} style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 10px", borderRadius: 8, border: "none", background: "transparent", color: "var(--crit)", textAlign: "left" }}>
            <I.X size={16} /><span style={{ fontSize: 14 }}>Sair da conta</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// Fallback: renderiza a página desktop com um aviso. Mantém a página acessível
// no celular enquanto a versão mobile dedicada não existe.
function DesktopFallback({ page, scope, setPage, user, onLogout }) {
  const [dismissed, setDismissed] = useState(false);
  const Comp = window[desktopCompName(page)];
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {!dismissed && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--warn-soft)", borderBottom: "1px solid var(--warn-line)", flexShrink: 0 }}>
          <I.AlertTriangle size={13} style={{ color: "var(--warn)", flexShrink: 0 }} />
          <span style={{ fontSize: 11.5, color: "var(--fg-1)", flex: 1 }}>Tela ainda não otimizada para celular.</span>
          <button onClick={() => setDismissed(true)} aria-label="Ok" style={{ width: 26, height: 26, borderRadius: 6, background: "transparent", border: "none", color: "var(--fg-3)", display: "grid", placeItems: "center", flexShrink: 0 }}><I.X size={13} /></button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", WebkitOverflowScrolling: "touch" }}>
        {Comp ? <DesktopPageRender page={page} Comp={Comp} scope={scope} setPage={setPage} user={user} onLogout={onLogout} /> : (
          <div style={{ padding: 32, textAlign: "center", color: "var(--fg-3)", fontSize: 13 }}>Página indisponível.</div>
        )}
      </div>
    </div>
  );
}

// Alguns componentes desktop têm props próprias — repassa o que cada um espera.
function DesktopPageRender({ page, Comp, scope, setPage, user, onLogout }) {
  if (page === "dashboard") return <Comp scope={scope} setPage={setPage} />;
  if (page === "cmv")       return <Comp setPage={setPage} />;
  if (page === "saas")      return <Comp user={user} onLogout={onLogout} embedded />;
  return <Comp scope={scope} />;
}

// Nome do componente mobile dedicado por página.
function mobileCompName(page) {
  return { dashboard: "MobileDashboard", stock: "MobileStock", purchases: "MobilePurchases", requests: "MobileRequestsBoard", revenue: "MobileRevenue", cmv: "MobileCMV", production: "MobileProduction", finance: "MobileFinance", recipes: "MobileRecipes", settings: "MobileSettings",
    dre: "MobileDre", delivery: "MobileDelivery", cardapio: "MobileCardapio", crm: "MobileCRM", supply: "MobileSupply", distribution: "MobileDistribution" }[page] || null;
}
// Nome do componente desktop por página (globais).
function desktopCompName(page) {
  return {
    dashboard: "Dashboard", stock: "Stock", production: "Production", supply: "Suprimentos",
    distribution: "CentralDistribuicao", recipes: "Recipes", revenue: "Revenue",
    delivery: "DeliveryTimes", cardapio: "Cardapio", crm: "CRM", requests: "Requests",
    purchases: "Purchases", cmv: "CMV", finance: "Finance", dre: "Dre",
    settings: "Settings", saas: "SuperAdmin",
  }[page] || null;
}

Object.assign(window, { MobileApp });
