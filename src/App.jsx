// App root — antes vivia inline em StockKitchen.html.
// Componentes (LoginPage, SuperAdmin, Sidebar, Topbar, *Page, TweaksPanel…)
// vêm dos arquivos legados via globals (window.LoginPage etc.) graças aos
// dynamic imports em src/main.jsx.

import React, { useState, useEffect } from "react";

const TWEAK_DEFAULS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "density": "default"
}/*EDITMODE-END*/;

export function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULS);
  const [scope, setScope] = useState("all");
  const [pageRaw, setPageRaw] = useState("dashboard");
  const [opMenuOpen, setOpMenuOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  // Quando o link de recuperação de senha é aberto (?reset=1), forçamos a tela
  // de login mesmo que haja sessão local — assim o usuário cai direto no
  // formulário de "definir nova senha" da LoginPage.
  const isRecoveryUrl = (() => {
    try { return new URLSearchParams(window.location.search).get("reset") === "1"; }
    catch { return false; }
  })();
  const [user, setUser] = useState(() => isRecoveryUrl ? null : getStoredSession());

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", t.theme);
  }, [t.theme]);

  useEffect(() => {
    let counter = 0;
    window.showToast = (msg, opts = {}) => {
      const id = `t-${Date.now()}-${counter++}`;
      const { tone = "ok", meta = "agora", ttl = 3200 } = opts;
      setToasts((cur) => [...cur, { id, msg, tone, meta }]);
      setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), ttl);
      return id;
    };
    return () => { delete window.showToast; };
  }, []);

  const handleLogin = (u) => {
    setUser(u);
    if (u.role === "superadmin") {
      window.showToast(`Bem-vindo, ${u.name} · acesso superadmin`, { tone: "ok", ttl: 4500 });
    } else {
      window.showToast(`Bem-vindo, ${u.name}`, { tone: "ok", ttl: 3000 });
    }
  };

  // Gate de acesso a páginas — se o usuário não tem o módulo, redireciona p/ um permitido
  const allowedPages = typeof getAllowedModules === "function" ? getAllowedModules(user) : ["dashboard"];
  const page = allowedPages.includes(pageRaw) ? pageRaw : (allowedPages[0] || "dashboard");
  const setPage = (next) => {
    if (allowedPages.includes(next)) { setPageRaw(next); return; }
    window.showToast?.("Sem acesso a esse módulo. Fale com o admin.", { tone: "warn", ttl: 3500 });
  };

  const handleLogout = () => {
    clearStoredSession();
    setUser(null);
    setPageRaw("dashboard");
    setScope("all");
  };

  // Troca o tenant ativo (usuários com acesso a mais de um). Atualiza a sessão
  // persistida com o role/módulos/nome do tenant escolhido e recarrega — assim
  // todas as páginas re-resolvem o contexto do zero via dbGetCurrentContext.
  const handleSwitchTenant = (tenantId) => {
    const t = (user?.tenants || []).find((x) => x.id === tenantId);
    if (!t || tenantId === user?.tenantId) return;
    window.dbSetActiveTenant?.(tenantId);
    const updated = {
      ...user,
      tenantId: t.id,
      tenantName: t.name,
      role: user.isSuperadmin ? user.role : t.role,
      modules: t.modules ?? null,
      ops: t.ops || [],
    };
    try {
      localStorage.setItem("stockkitchen.session.v1", JSON.stringify({
        ...updated, loggedAt: new Date().toISOString(),
      }));
    } catch {}
    window.location.reload();
  };

  if (!user) {
    return (
      <>
        <LoginPage onLogin={handleLogin} />
        <Toasts toasts={toasts} />
      </>
    );
  }

  return <AppShell
    t={t} setTweak={setTweak} scope={scope} setScope={setScope}
    page={page} setPage={setPage} opMenuOpen={opMenuOpen} setOpMenuOpen={setOpMenuOpen}
    toasts={toasts} setToasts={setToasts} user={user} onLogout={handleLogout}
    onSwitchTenant={handleSwitchTenant}
  />;
}

function AppShell({ t, setTweak, scope, setScope, page, setPage, opMenuOpen, setOpMenuOpen, toasts, setToasts, user, onLogout, onSwitchTenant }) {
  useEffect(() => {
    if (!user?.name) return;
    const id = Date.now();
    const firstName = user.name.split(" ")[0];
    setToasts([{ id, msg: `Bem-vindo, ${firstName}`, meta: "agora", tone: "ok" }]);
    const x = setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 3500);
    return () => clearTimeout(x);
  }, [user?.name]);

  const setTheme = (v) => setTweak("theme", v);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("sk_sidebar_collapsed") === "1"; } catch { return false; }
  });
  const toggleSidebar = () => setSidebarCollapsed((c) => {
    const next = !c;
    try { localStorage.setItem("sk_sidebar_collapsed", next ? "1" : "0"); } catch {}
    return next;
  });

  return (
    <div data-screen-label={`page-${page}`} style={{ display: "flex", height: "100vh", overflow: "hidden", background: "var(--bg-0)" }}>
      {!sidebarCollapsed && (
        <Sidebar scope={scope} setScope={setScope} page={page} setPage={setPage} opMenuOpen={opMenuOpen} setOpMenuOpen={setOpMenuOpen} user={user} />
      )}

      <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <Topbar page={page} scope={scope} theme={t.theme} setTheme={setTheme}
                user={user} onLogout={onLogout} onSwitchTenant={onSwitchTenant}
                sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />

        <div key={`${page}-${scope}`} style={{ flex: 1, overflow: "auto", background: "var(--bg-0)", animation: "fadeUp 220ms ease both" }}>
          {page === "saas"      && <SuperAdmin user={user} onLogout={onLogout} embedded />}
          {page === "dashboard" && <Dashboard scope={scope} setPage={setPage} />}
          {page === "stock"     && <Stock scope={scope} />}
          {page === "recipes"   && <Recipes scope={scope} />}
          {page === "revenue"   && <Revenue scope={scope} />}
          {page === "requests"  && <Requests scope={scope} />}
          {page === "purchases" && <Purchases />}
          {page === "cmv"       && <CMV setPage={setPage} />}
          {page === "finance"   && <Finance />}
          {page === "dre"       && <Dre />}
          {page === "settings"  && <Settings />}
        </div>

        <StatusBar scope={scope} />
      </main>

      <Toasts toasts={toasts} />

      <TweaksPanel title="Tweaks">
        <TweakSection title="Aparência">
          <TweakRadio label="Tema" value={t.theme} onChange={(v) => setTweak("theme", v)} options={[
            { value: "dark", label: "Escuro" },
            { value: "light", label: "Claro" },
          ]} />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}
