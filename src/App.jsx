// App root — antes vivia inline em StockKitchen.html.
// Componentes (LoginPage, SuperAdmin, Sidebar, Topbar, *Page, TweaksPanel…)
// vêm dos arquivos legados via globals (window.LoginPage etc.) graças aos
// dynamic imports em src/main.jsx.

import React, { useState, useEffect } from "react";

const TWEAK_DEFAULS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "density": "default"
}/*EDITMODE-END*/;

// Roteamento por hash (#/faturamento, #/estoque…). Hash evita config de SPA
// fallback no host — funciona em qualquer estático sem 404 no refresh.
const PAGE_SLUGS = {
  dashboard: "dashboard",
  stock:     "estoque",
  recipes:   "fichas-tecnicas",
  revenue:   "faturamento",
  delivery:  "tempos-delivery",
  cardapio:  "cardapio",
  requests:  "requisicoes",
  purchases: "compras",
  cmv:       "cmv",
  finance:   "financeiro",
  dre:       "dre",
  settings:  "configuracoes",
  saas:      "admin",
};
const SLUG_TO_PAGE = Object.fromEntries(Object.entries(PAGE_SLUGS).map(([id, s]) => [s, id]));
// Rota standalone (tela cheia, sem shell): página mobile de lançamento de requisição.
const MOBILE_SLUG = "mobile";
const _hashSlug = () => window.location.hash.replace(/^#\/?/, "").split(/[/?#]/)[0].trim();
const pageFromHash = () => { try { return SLUG_TO_PAGE[_hashSlug()] || null; } catch { return null; } };

export function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULS);
  const [scope, setScope] = useState("all");
  const [pageRaw, setPageRaw] = useState(() => pageFromHash() || "dashboard");
  const [rawHash, setRawHash] = useState(_hashSlug);
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
  // Usuário "só-mobile": único módulo permitido é "requests" → entra direto na tela
  // mobile e não vê o "Abrir app completo" (não há mais nada pra abrir).
  const mobileOnly = allowedPages.length === 1 && allowedPages[0] === "requests";
  const setPage = (next) => {
    if (!allowedPages.includes(next)) {
      window.showToast?.("Sem acesso a esse módulo. Fale com o admin.", { tone: "warn", ttl: 3500 });
      return;
    }
    setPageRaw(next);
    const slug = PAGE_SLUGS[next] || next;
    if (_hashSlug() !== slug) window.location.hash = `/${slug}`; // empurra entrada no histórico (voltar/avançar)
  };

  // URL → estado: back/forward do browser e edição manual da hash.
  useEffect(() => {
    const onHash = () => { setRawHash(_hashSlug()); const id = pageFromHash(); if (id) setPageRaw(id); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Estado → URL: mantém a hash em sincronia com a página efetiva (já passada pelo
  // gate de acesso). replaceState para não poluir o histórico em auto-correções
  // (hash vazia no load, slug inválido, ou redirect por falta de módulo).
  // Usuário só-mobile: força a rota standalone #/mobile ao logar / no load.
  useEffect(() => {
    if (!user || !mobileOnly) return;
    if (rawHash !== MOBILE_SLUG) window.location.hash = `/${MOBILE_SLUG}`;
  }, [user, mobileOnly, rawHash]);

  useEffect(() => {
    if (!user) return;
    if (rawHash === MOBILE_SLUG || mobileOnly) return; // rota standalone — não força sync com a página do shell
    const slug = PAGE_SLUGS[page] || page;
    if (_hashSlug() !== slug) window.history.replaceState(null, "", `#/${slug}`);
  }, [page, user, rawHash, mobileOnly]);

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

  // Rota standalone (#/mobile): tela cheia de lançamento de requisição, sem o shell.
  // Entra aqui pela hash #/mobile OU quando o usuário é só-mobile (entra direto).
  // Exige acesso ao módulo "requests"; senão volta pro app normal.
  if (rawHash === MOBILE_SLUG || mobileOnly) {
    if (allowedPages.includes("requests")) {
      return (
        <>
          <MobileRequests user={user} onLogout={handleLogout} canOpenApp={!mobileOnly} />
          <Toasts toasts={toasts} />
        </>
      );
    }
    window.location.hash = `/${PAGE_SLUGS[page] || "dashboard"}`;
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
          {page === "delivery"  && <DeliveryTimes scope={scope} />}
          {page === "cardapio"  && <Cardapio scope={scope} />}
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
