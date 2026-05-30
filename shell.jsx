// Shell: sidebar + topbar + content area + toast wiring
// (React + hooks vêm como globais via plugin injectLegacyGlobals do Vite)

// Catálogo único de módulos do app — espelha src/App.jsx e page-settings.jsx
// "saas" é exclusivo do superadmin (gestão multi-tenant da plataforma).
const APP_MODULES = ["dashboard","stock","recipes","revenue","requests","purchases","cmv","finance","dre","analise-mercado","settings"];
const SUPERADMIN_MODULES = ["saas"];

// Preset padrão por role do banco quando o membro não tem `modules` customizado
const ROLE_DEFAULT_MODULES = {
  owner:      APP_MODULES,
  admin:      APP_MODULES,
  manager:    APP_MODULES.filter((m) => m !== "settings"),
  kitchen:    ["dashboard", "stock", "requests", "recipes"],
  stock:      ["dashboard", "stock", "requests", "purchases"],
  accountant: ["dashboard", "revenue", "cmv", "finance", "dre"],
  viewer:     ["dashboard"],
};
// Compat: roles vindos do MOCK em português
const ROLE_LABEL_TO_DB = {
  "Super Admin": "owner", "Gestor de marca": "manager",
  "Operador cozinha": "kitchen", "Estoquista": "stock",
  "Contador": "accountant", "Visualização": "viewer",
};

function getAllowedModules(user) {
  if (!user) return ["dashboard"];
  // Superadmin: só "Gestão SaaS" (escopo é global, não há tenant pra operar).
  // Se quiser entrar como owner de algum tenant específico, usar conta diferente.
  if (user.isSuperadmin === true || user.role === "superadmin") return SUPERADMIN_MODULES;
  const dbRole = ROLE_LABEL_TO_DB[user.role] || user.role || "viewer";
  // Owner/admin sempre veem tudo, ignorando customização (evita auto-bloqueio)
  if (dbRole === "owner" || dbRole === "admin") return APP_MODULES;
  if (Array.isArray(user.modules) && user.modules.length > 0) {
    return user.modules.filter((m) => APP_MODULES.includes(m));
  }
  return ROLE_DEFAULT_MODULES[dbRole] || ["dashboard"];
}

window.getAllowedModules = getAllowedModules;
window.APP_MODULES = APP_MODULES;
window.ROLE_DEFAULT_MODULES = ROLE_DEFAULT_MODULES;

function Sidebar({ scope, setScope, page, setPage, opMenuOpen, setOpMenuOpen, user }) {
  const role = user?.role || "operator";
  const allowed = getAllowedModules(user);
  const has = (id) => allowed.includes(id);

  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false };
  const [stockCrit, setStockCrit] = useState(0);
  const [stockOut,  setStockOut]  = useState(0);
  const [pendingReq, setPendingReq] = useState(0);
  // Checklist financeiro: itens vencidos / próximos do vencimento neste mês.
  const [financeOverdue, setFinanceOverdue] = useState(0);
  const [financeSoon,    setFinanceSoon]    = useState(0);

  useEffect(() => {
    if (!dbStatus.isOnline || !user?.tenantId) {
      setStockCrit(0); setStockOut(0); setPendingReq(0);
      setFinanceOverdue(0); setFinanceSoon(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const currentPeriod = new Date().toISOString().slice(0, 7);
        const [stockRes, reqRes, checkRes, entriesRes] = await Promise.all([
          dbListStockItems(user.tenantId),
          dbListKitchenRequests(user.tenantId),
          typeof dbListClosingChecklist === "function" ? dbListClosingChecklist(user.tenantId) : Promise.resolve({ data: [] }),
          typeof dbListFinanceEntries  === "function" ? dbListFinanceEntries(user.tenantId, currentPeriod)  : Promise.resolve({ data: [] }),
        ]);
        if (cancelled) return;
        const stockItems = stockRes?.data || [];
        const requests   = reqRes?.data   || [];
        const checklist  = checkRes?.data || [];
        const entries    = entriesRes?.data || [];
        // Badge do sidebar respeita a flag da categoria: itens em categoria
        // com alertas desligados não devem aparecer no contador.
        const alertable = stockItems.filter((i) => i.catAlertsEnabled !== false);
        const out  = alertable.filter((i) => (i.qty || 0) <= 0).length;
        const crit = alertable.filter((i) => (i.qty || 0) > 0 && (i.qty || 0) < (i.reorder || 0)).length;
        setStockOut(out);
        setStockCrit(out + crit);
        setPendingReq(requests.filter((r) => r.status === "pending").length);

        // Conta itens obrigatórios ainda pendentes neste mês com urgência soon/overdue.
        // Itens criados em meses futuros ainda não valem (não retroagem pro mês atual).
        let over = 0, sn = 0;
        const urgFn = typeof window.getChecklistUrgency === "function" ? window.getChecklistUrgency : null;
        for (const c of checklist) {
          if (!c.required) continue;
          if (c.startPeriod && c.startPeriod > currentPeriod) continue;
          const filled = entries.some((e) => e.checklistItemId === c.id);
          if (filled) continue;
          const u = urgFn ? urgFn(c, currentPeriod) : { level: "none" };
          if (u.level === "overdue") over++;
          else if (u.level === "soon") sn++;
        }
        setFinanceOverdue(over);
        setFinanceSoon(sn);
      } catch (e) {
        console.warn("[sidebar] falha ao carregar badges:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.isOnline, user?.tenantId, page]);

  const isSuperadmin = user?.isSuperadmin === true || user?.role === "superadmin";
  const allNav = [
    { id: "saas",       label: "Gestão SaaS",     icon: I.Trophy },
    { id: "dashboard",  label: "Dashboard",      icon: I.Dashboard },
    { id: "stock",      label: "Estoque",         icon: I.Stock,       badge: stockCrit || null, badgeTone: stockOut > 0 ? "crit" : "warn" },
    { id: "recipes",    label: "Fichas técnicas", icon: I.Recipe },
    { id: "revenue",    label: "Faturamento",     icon: I.Revenue },
    { id: "requests",   label: "Requisições",     icon: I.Request,     pulse: pendingReq || null },
    { id: "purchases",  label: "Compras",         icon: I.ShoppingList },
    { id: "cmv",        label: "CMV & margem",    icon: I.CMV },
    { id: "finance",    label: "Financeiro",      icon: I.Finance, badge: (financeOverdue + financeSoon) || null, badgeTone: financeOverdue > 0 ? "crit" : "warn" },
    { id: "dre",        label: "DRE & Fechamento", icon: I.Lock },
    { id: "analise-mercado", label: "Analise de mercado", icon: I.CMV },
    { id: "settings",   label: "Configurações",   icon: I.Settings },
  ].filter((item) => has(item.id));

  const initials = user?.name?.split(" ").map((n) => n[0]).slice(0, 2).join("") || "?";
  const tenantName = isSuperadmin
    ? "StockKitchen · Plataforma"
    : (user?.tenantName || "Cloud Kitchen");

  return (
    <aside style={sb.aside}>
      {/* Tenant header */}
      <div style={sb.tenant}>
        <div style={sb.tenantMark}>
          <I.Logo size={14} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
          <div style={sb.tenantName}>{tenantName}</div>
          <div style={sb.tenantId}>
            {isSuperadmin
              ? "MULTI-TENANT"
              : (user?.tenantId ? user.tenantId.slice(0, 8).toUpperCase() : "LOCAL")}
            {!isSuperadmin && (() => {
              const n = (window.MOCK?.OPERATIONS || []).filter((o) => o.id !== "all").length;
              return n > 0 ? ` · ${n} ops` : "";
            })()}
          </div>
        </div>
      </div>

      <div style={{ height: 1, background: "var(--line-soft)", margin: "8px 16px 0" }} />

      {/* Nav */}
      <nav style={sb.nav}>
        <div style={sb.sectionLbl}>Módulos</div>
        {allNav.map((item) => {
          const active = page === item.id;
          const Ico = item.icon;
          return (
            <button
              key={item.id}
              style={{ ...sb.navItem, ...(active ? sb.navItemActive : null) }}
              onClick={() => setPage(item.id)}
            >
              <Ico size={15} stroke={1.5} style={{ color: active ? "var(--accent-bright)" : "var(--fg-2)" }} />
              <span style={{ flex: 1, textAlign: "left", color: active ? "var(--fg-0)" : "var(--fg-1)" }}>
                {item.label}
              </span>
              {item.pulse && <span style={sb.pulse}>{item.pulse}</span>}
              {item.badge && !item.pulse && (
                <span style={{
                  ...sb.badgeNum,
                  ...(item.badgeTone === "crit" ? { background: "var(--crit-soft)", color: "var(--crit)" } :
                      item.badgeTone === "warn" ? { background: "var(--warn-soft)", color: "var(--warn)" } : null),
                }}>{item.badge}</span>
              )}
            </button>
          );
        })}
      </nav>

      {/* User */}
      <button
        style={{ ...sb.user, width: "100%", background: "transparent", textAlign: "left", cursor: has("settings") ? "pointer" : "default" }}
        onClick={() => { if (has("settings")) setPage("settings"); }}
        title={has("settings") ? "Abrir configurações" : user?.name || "Usuário"}
      >
        <div style={sb.avatar}>{initials}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, color: "var(--fg-0)", fontWeight: 500 }}>{user?.name || "Usuário"}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" }}>
            {(role || "").toUpperCase()}
          </div>
        </div>
        <I.More size={14} style={{ color: "var(--fg-3)" }} />
      </button>
    </aside>
  );
}

function Topbar({ page, scope, theme, setTheme, user, onLogout }) {
  const op = MOCK.opById(scope);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef(null);

  useEffect(() => {
    if (!userMenuOpen) return;
    const onDoc = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [userMenuOpen]);

  const titleMap = {
    saas: "Gestão SaaS",
    dashboard: "Dashboard",
    stock: "Estoque",
    recipes: "Fichas técnicas",
    revenue: "Faturamento",
    requests: "Requisições",
    purchases: "Compras",
    cmv: "CMV & margem",
    finance: "Financeiro",
    dre: "DRE & Fechamento",
    "analise-mercado": "Analise de mercado",
    settings: "Configurações",
  };
  const initials = user?.avatar || user?.name?.split(" ").map((n) => n[0]).slice(0, 2).join("") || "?";

  return (
    <header style={tb.bar}>
      <div style={tb.crumbs}>
        <span style={tb.crumbDim}>Cloud Kitchen</span>
        <I.ChevronR size={11} style={{ color: "var(--fg-4)" }} />
        <span style={tb.crumb}>{titleMap[page]}</span>
      </div>
      <div style={tb.spacer} />
      <button style={tb.iconBtn} onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Alternar tema">
        {theme === "dark" ? <I.Sun size={15} /> : <I.Moon size={15} />}
      </button>
      {/* Indicador de status do DB · clique pra ver detalhes */}
      <DbStatusButton />


      {/* Menu do usuário */}
      {user && (
        <div ref={userMenuRef} style={{ position: "relative" }}>
          <button style={{
            ...tb.iconBtn,
            width: "auto", padding: "4px 10px 4px 4px", gap: 8,
            display: "flex", alignItems: "center",
          }} onClick={() => setUserMenuOpen(!userMenuOpen)}>
            <span style={{
              width: 22, height: 22, borderRadius: 4,
              background: "var(--accent)", color: "#cfeede",
              fontSize: 10, fontWeight: 500, display: "grid", placeItems: "center",
            }}>{initials}</span>
            <span style={{ fontSize: 11.5, color: "var(--fg-1)" }}>{user.name?.split(" ")[0]}</span>
          </button>
          {userMenuOpen && (
            <div style={{
              position: "absolute", top: "calc(100% + 4px)", right: 0,
              background: "var(--bg-2)", border: "1px solid var(--line-strong)",
              borderRadius: 4, padding: 6, zIndex: 100, minWidth: 220,
              boxShadow: "0 8px 24px -8px rgba(0,0,0,0.5)",
            }}>
              <div style={{ padding: "6px 10px 10px", borderBottom: "1px solid var(--line-soft)" }}>
                <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg-0)" }}>{user.name}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", marginTop: 2 }}>
                  {user.email}
                </div>
                <div style={{
                  display: "inline-block", marginTop: 6,
                  fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent-bright)", letterSpacing: "0.06em", textTransform: "uppercase",
                  padding: "1px 6px", background: "var(--accent-soft)", border: "1px solid var(--accent-line)", borderRadius: 99,
                }}>
                  {user.role}
                </div>
              </div>
              <button onClick={onLogout} style={{
                display: "flex", alignItems: "center", gap: 8,
                width: "100%", padding: "8px 10px", marginTop: 4,
                background: "transparent", border: "none", borderRadius: 3,
                color: "var(--crit)", fontSize: 12, cursor: "pointer", textAlign: "left",
              }}>
                <I.X size={11} />Sair da conta
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  );
}

function StatusBar({ scope }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false };
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const DOW_PT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  const time = `${DOW_PT[now.getDay()]} ${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")} · ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const opsCount = (window.MOCK?.OPERATIONS || []).filter((o) => o.id !== "all").length;
  return (
    <div style={statusBar.bar}>
      <span style={statusBar.item}>
        <span style={{ color: dbStatus.isOnline ? "var(--ok)" : "var(--warn)" }}>●</span>
        {dbStatus.isOnline ? "Conectado ao Supabase" : "Modo offline (mock)"}
      </span>
      {opsCount > 0 && (
        <span style={statusBar.item}>{opsCount} {opsCount === 1 ? "operação" : "operações"} ativa(s)</span>
      )}
      <span style={statusBar.spacer} />
      <span style={statusBar.item}>{time}</span>
      <span style={statusBar.item}>v1.2</span>
    </div>
  );
}

function Toasts({ toasts }) {
  const dotColor = (tone) => {
    if (tone === "ok") return "var(--ok)";
    if (tone === "warn") return "var(--warn)";
    if (tone === "crit") return "var(--crit)";
    return "var(--accent-bright)";
  };
  const critStyle = {
    borderColor: "var(--crit-line)",
    background: "var(--crit-soft)",
    color: "var(--crit)",
  };
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className="toast" style={t.tone === "crit" ? critStyle : undefined}>
          <span className="dot" style={{ background: dotColor(t.tone) }} />
          <span>{t.msg}</span>
          <span className="meta">{t.meta}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- styles (component-scoped to avoid global collision) ----------
const sb = {
  aside: { width: 244, background: "var(--bg-1)", borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", flexShrink: 0, height: "100%", overflow: "hidden" },
  tenant: { display: "flex", alignItems: "center", gap: 10, padding: "16px 16px 14px" },
  tenantMark: { width: 28, height: 28, borderRadius: 4, background: "var(--bg-3)", border: "1px solid var(--line)", display: "grid", placeItems: "center", color: "var(--accent-bright)", flexShrink: 0 },
  tenantName: { fontSize: 13, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.005em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  tenantId: { fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" },

  opBlock: { padding: "4px 12px 12px", position: "relative" },
  sectionLbl: { fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.12em", textTransform: "uppercase", padding: "8px 4px 6px" },
  opSelect: { width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4, color: "var(--fg-0)", fontSize: 12.5, transition: "border-color 100ms" },
  opDot: { width: 8, height: 8, borderRadius: 50, flexShrink: 0 },
  opName: { flex: 1, textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: "-0.005em" },
  opShort: { fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.06em" },
  opMenu: { position: "absolute", top: "100%", left: 12, right: 12, background: "var(--bg-2)", border: "1px solid var(--line-strong)", borderRadius: 4, padding: 4, zIndex: 50, boxShadow: "0 8px 24px -8px rgba(0,0,0,0.5)" },
  opMenuItem: { width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", background: "transparent", border: "none", borderRadius: 2, color: "var(--fg-1)", fontSize: 12 },
  opMenuItemActive: { background: "var(--bg-3)", color: "var(--fg-0)" },
  opIfood: { fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-3)" },

  nav: { padding: "12px 12px", display: "flex", flexDirection: "column", gap: 1, flex: 1, overflowY: "auto" },
  navItem: { display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", background: "transparent", border: "none", borderRadius: 4, fontSize: 12.5, letterSpacing: "-0.005em", transition: "background 100ms" },
  navItemActive: { background: "var(--bg-3)" },
  pulse: { fontFamily: "var(--mono)", fontSize: 10, padding: "1px 6px", background: "var(--accent-bright)", color: "var(--accent-fg)", borderRadius: 8, fontWeight: 500 },
  badgeNum: { fontFamily: "var(--mono)", fontSize: 10, padding: "1px 6px", background: "var(--bg-3)", color: "var(--fg-2)", borderRadius: 8 },

  user: { display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderTop: "1px solid var(--line-soft)" },
  avatar: { width: 28, height: 28, borderRadius: 4, background: "var(--accent)", color: "#cfeede", fontSize: 11, fontWeight: 500, display: "grid", placeItems: "center", letterSpacing: "0.02em", flexShrink: 0 },
};

const tb = {
  bar: { display: "flex", alignItems: "center", gap: 12, padding: "10px 20px", borderBottom: "1px solid var(--line)", background: "var(--bg-1)", flexShrink: 0, height: 48 },
  crumbs: { display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 },
  crumb: { color: "var(--fg-0)", fontWeight: 500, letterSpacing: "-0.005em" },
  crumbDim: { color: "var(--fg-3)" },
  spacer: { flex: 1 },
  iconBtn: { width: 32, height: 32, borderRadius: 4, background: "transparent", border: "1px solid var(--line)", color: "var(--fg-1)", display: "grid", placeItems: "center", position: "relative" },
};

const statusBar = {
  bar: { display: "flex", alignItems: "center", gap: 18, padding: "0 20px", height: 24, background: "var(--bg-1)", borderTop: "1px solid var(--line)", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", textTransform: "uppercase", flexShrink: 0 },
  item: { display: "flex", alignItems: "center", gap: 6 },
  spacer: { flex: 1 },
};

// Botão de status do DB · mostra dot colorido + popover com detalhes
function DbStatusButton() {
  const status = (typeof useDbStatus === "function") ? useDbStatus() : { state: "offline", isOnline: false, error: null };
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const meta = {
    online:         { color: "var(--ok)",   label: "DB online",          desc: "Conectado ao Supabase · queries reais" },
    checking:       { color: "var(--info)", label: "Verificando…",        desc: "Healthcheck em andamento" },
    tables_missing: { color: "var(--warn)", label: "Schema não aplicado", desc: "Conectado ao projeto, mas as tabelas não existem · rode supabase/schema.sql" },
    error:          { color: "var(--crit)", label: "Erro de conexão",     desc: "Não foi possível conectar · veja o console" },
    offline:        { color: "var(--fg-3)", label: "DB offline",          desc: "Sem credenciais · usando MOCK" },
  }[status.state] || { color: "var(--fg-3)", label: status.state, desc: "" };

  const cfgUrl = window.SK_CONFIG?.supabaseUrl;
  const projRef = cfgUrl ? cfgUrl.match(/\/\/([^.]+)\./)?.[1] : null;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button style={tb.iconBtn} onClick={() => setOpen(!open)} title={meta.label}>
        <span style={{ width: 8, height: 8, borderRadius: 50, background: meta.color }} />
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", right: 0,
          background: "var(--bg-2)", border: "1px solid var(--line-strong)",
          borderRadius: 4, padding: 12, minWidth: 280, zIndex: 100,
          boxShadow: "0 8px 24px -8px rgba(0,0,0,0.5)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: 50, background: meta.color }} />
            <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg-0)" }}>{meta.label}</span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.5, marginBottom: 10 }}>{meta.desc}</div>
          {projRef && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", marginBottom: 6 }}>
              Projeto: <span style={{ color: "var(--fg-1)" }}>{projRef}</span>
            </div>
          )}
          {status.error && (
            <div style={{
              padding: "6px 8px", background: "var(--crit-soft)", border: "1px solid var(--crit-line)",
              borderRadius: 3, fontFamily: "var(--mono)", fontSize: 10, color: "var(--crit)",
              marginTop: 6, wordBreak: "break-word",
            }}>
              {String(status.error.message || status.error)}
            </div>
          )}
          {status.state === "tables_missing" && (
            <div style={{
              marginTop: 8, padding: "8px 10px",
              background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 3,
              fontSize: 11, color: "var(--fg-1)", lineHeight: 1.5,
            }}>
              Aplique o schema: abra o <strong>SQL Editor</strong> do Supabase e cole o conteúdo de <code style={{ fontFamily: "var(--mono)", fontSize: 10 }}>supabase/schema.sql</code>.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { Sidebar, Topbar, StatusBar, Toasts, DbStatusButton });
