// SuperAdmin · painel multi-tenant de operação da plataforma StockKitchen.
//
// Visão consolidada de TODOS os clientes (tenants), MRR, saúde, planos,
// tickets de suporte (placeholder), logs de sistema (placeholder).
// Usa um shell próprio (sem sidebar do app normal).
// =====================================================================

const SA_PLAN_META = {
  trial:      { label: "Trial",      color: "var(--fg-3)" },
  starter:    { label: "Starter",    color: "var(--info)" },
  pro:        { label: "Pro",        color: "var(--accent-bright)" },
  enterprise: { label: "Enterprise", color: "#c2843a" },
};

const SA_STATUS_META = {
  active:    { label: "Ativo",    tone: "ok"      },
  trial:     { label: "Trial",    tone: "info"    },
  suspended: { label: "Suspenso", tone: "crit"    },
  canceled:  { label: "Cancelado",tone: "neutral" },
};

const _saFmtBRL = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const SA_MRR_BY_PLAN = { trial: 0, starter: 189, pro: 489, enterprise: 989 };

// Adapta a row do banco (snake_case + colunas que existem na tabela) pro
// shape que os componentes legados esperam (camelCase + métricas derivadas).
// Os campos não persistidos (mrr, revenue30d, cmvAvg, lastLogin, region…)
// ficam vazios ou derivados — vão sumir do painel quando o usuário tiver
// fontes reais (Stripe pra MRR, logs pra lastLogin, etc.).
function _saMapTenantFromDb(row) {
  return {
    id:         row.id,
    slug:       row.slug,
    name:       row.name,
    legalName:  row.legal_name || row.name,
    cnpj:       row.cnpj || "",
    region:     row.region || "—",
    plan:       row.plan,
    status:     row.status,
    users:      row.usersCount ?? 0,
    ops:        0,
    mrr:        SA_MRR_BY_PLAN[row.plan] ?? 0,
    revenue30d: 0,
    createdAt:  row.created_at ? String(row.created_at).slice(0, 10) : "",
    lastLogin:  row.updated_at || row.created_at || null,
    health:     "ok",
    cmvAvg:     0,
    ownerName:  row.ownerName || null,
    ownerUserId: row.ownerUserId || null,
    trialEndsAt: row.trial_ends_at || null,
  };
}

function SuperAdmin({ user, onLogout, embedded = false }) {
  // Aba inicial pode vir dos atalhos da sidebar (window.SA_TAB + evento "sa-set-tab").
  const [tab, setTab] = useState(() => window.SA_TAB || "overview");
  // Mantém window.SA_TAB em sincronia (sidebar usa pra marcar o atalho ativo).
  useEffect(() => { window.SA_TAB = tab; }, [tab]);
  // Troca de aba disparada pelos atalhos da sidebar quando o painel já está aberto.
  useEffect(() => {
    const h = (e) => { if (e?.detail) setTab(e.detail); };
    window.addEventListener("sa-set-tab", h);
    return () => window.removeEventListener("sa-set-tab", h);
  }, []);
  const dbStatus = useDbStatus ? useDbStatus() : { state: "checking", isOnline: false };
  const [tenants, setTenants] = useState(() => dbStatus.isOnline ? [] : MOCK.SYSTEM_TENANTS);
  const [loadingTenants, setLoadingTenants] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // Carrega tenants reais quando o DB sobe (e em todo refresh manual).
  const reloadTenants = React.useCallback(async () => {
    if (!isDbOnline || !isDbOnline()) return;
    setLoadingTenants(true);
    try {
      const { data, error } = await dbListTenantsAdmin();
      if (error) {
        window.showToast?.("Falha ao listar tenants: " + error.message, { tone: "crit", ttl: 5000 });
        return;
      }
      const mapped = (data || []).map(_saMapTenantFromDb);
      setTenants(mapped);
    } finally {
      setLoadingTenants(false);
    }
  }, []);

  useEffect(() => {
    if (dbStatus.isOnline) reloadTenants();
  }, [dbStatus.isOnline, reloadTenants]);

  const totalMRR    = tenants.reduce((s, t) => s + (t.mrr || 0), 0);
  const activeCount = tenants.filter((t) => t.status === "active").length;
  const trialCount  = tenants.filter((t) => t.status === "trial").length;
  const suspended   = tenants.filter((t) => t.status === "suspended").length;
  const totalUsers  = tenants.reduce((s, t) => s + (t.users || 0), 0);
  const totalOps    = tenants.reduce((s, t) => s + (t.ops || 0), 0);
  const totalRevenue30d = tenants.reduce((s, t) => s + (t.revenue30d || 0), 0);

  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const q = norm(search.trim());
  const filtered = tenants.filter((t) => {
    if (statusFilter !== "all" && t.status !== statusFilter) return false;
    if (q && !norm(t.name).includes(q) && !norm(t.slug).includes(q) && !norm(t.region).includes(q)) return false;
    return true;
  });

  const setTenantStatus = async (id, status) => {
    if (dbStatus.isOnline) {
      const { error } = await dbUpdateTenantAdmin(id, { status });
      if (error) {
        window.showToast?.("Falha ao atualizar status: " + error.message, { tone: "crit", ttl: 5000 });
        return;
      }
    }
    setTenants((prev) => prev.map((t) => t.id === id ? { ...t, status } : t));
    window.showToast(`Tenant atualizado para "${SA_STATUS_META[status]?.label}"`, { tone: "ok" });
  };

  // Update inline de qualquer campo editável (usado pelo modal de edição).
  const updateTenant = async (id, patch) => {
    if (dbStatus.isOnline) {
      const { data, error } = await dbUpdateTenantAdmin(id, patch);
      if (error) {
        window.showToast?.("Falha ao salvar: " + error.message, { tone: "crit", ttl: 5000 });
        return { ok: false };
      }
      // Re-aplica via reload pra pegar updated_at fresco e campos derivados
      setTenants((prev) => prev.map((t) => t.id === id ? {
        ...t,
        name: data.name, slug: data.slug,
        legalName: data.legal_name || data.name,
        cnpj: data.cnpj || "",
        plan: data.plan, status: data.status,
        mrr: SA_MRR_BY_PLAN[data.plan] ?? t.mrr,
        trialEndsAt: data.trial_ends_at || null,
      } : t));
    } else {
      setTenants((prev) => prev.map((t) => t.id === id ? { ...t, ...patch, legalName: patch.legal_name ?? t.legalName } : t));
    }
    window.showToast(`Tenant atualizado`, { tone: "ok" });
    return { ok: true };
  };

  const deleteTenant = async (id) => {
    if (dbStatus.isOnline) {
      const { error } = await dbDeleteTenantAdmin(id);
      if (error) {
        window.showToast?.("Falha ao excluir: " + error.message, { tone: "crit", ttl: 5000 });
        return { ok: false };
      }
    }
    setTenants((prev) => prev.filter((t) => t.id !== id));
    window.showToast(`Tenant excluído`, { tone: "ok" });
    return { ok: true };
  };

  const createTenant = async (draft) => {
    // Modo DB: chama edge function provision-tenant (cria tenant + owner + seeds)
    if (dbStatus.isOnline) {
      const { data, error } = await dbProvisionTenant({
        name: draft.name,
        slug: draft.slug,
        plan: draft.plan,
        ownerEmail: draft.ownerEmail,
        ownerName: draft.ownerName,
        ownerPassword: draft.ownerPassword || null,
      });
      if (error) {
        window.showToast?.("Falha ao provisionar: " + error.message, { tone: "crit", ttl: 6000 });
        return { ok: false };
      }
      // Aplica status/cnpj/legal_name extras se foram preenchidos
      const extras = {};
      if (draft.status && draft.status !== "trial") extras.status = draft.status;
      if (draft.legalName) extras.legal_name = draft.legalName;
      if (draft.cnpj) extras.cnpj = draft.cnpj;
      if (Object.keys(extras).length > 0) {
        await dbUpdateTenantAdmin(data.tenantId, extras);
      }
      await reloadTenants();
      const usedPassword = !!(draft.ownerPassword && data?.createdWithPassword);
      window.showToast(
        usedPassword
          ? `Tenant "${draft.name}" provisionado · senha definida pra ${draft.ownerEmail}`
          : `Tenant "${draft.name}" provisionado · convite enviado para ${draft.ownerEmail}`,
        { tone: "ok", ttl: 5000 },
      );
      return { ok: true };
    }

    // Modo MOCK: comportamento legado in-memory
    const id = `ten-${Date.now().toString(36).slice(-6)}`;
    const newTenant = {
      id,
      slug: draft.slug, name: draft.name,
      legalName: draft.legalName || draft.name,
      cnpj: draft.cnpj || "",
      region: draft.region || "—",
      plan: draft.plan, status: draft.status,
      users: 1, ops: 0,
      mrr: SA_MRR_BY_PLAN[draft.plan] || 0,
      revenue30d: 0,
      createdAt: new Date().toISOString().slice(0, 10),
      lastLogin: new Date().toISOString(),
      health: "ok", cmvAvg: 0,
    };
    setTenants((prev) => {
      const next = [newTenant, ...prev];
      MOCK.SYSTEM_TENANTS = next;
      return next;
    });
    if (draft.ownerEmail && draft.ownerName) {
      const newUser = {
        email: draft.ownerEmail.trim().toLowerCase(),
        password: draft.ownerPassword || "trocar123",
        name: draft.ownerName.trim(),
        role: "owner", tenantId: id,
        avatar: draft.ownerName.trim().split(" ").map((n) => n[0]).slice(0, 2).join("").toUpperCase(),
      };
      MOCK.SYSTEM_USERS = [...(MOCK.SYSTEM_USERS || []), newUser];
    }
    window.showToast(
      `Tenant "${draft.name}" provisionado · plano ${SA_PLAN_META[draft.plan]?.label}${draft.ownerEmail ? ` · owner ${draft.ownerEmail}` : ""}`,
      { tone: "ok", ttl: 5000 },
    );
    return { ok: true };
  };

  // Conteúdo das abas — usado tanto no shell standalone quanto embedded.
  const content = (
    <>
      {tab === "overview" && (
        <SaOverview
          totalMRR={totalMRR} activeCount={activeCount} trialCount={trialCount}
          suspended={suspended} totalUsers={totalUsers} totalOps={totalOps}
          totalRevenue30d={totalRevenue30d}
          tenants={tenants}
        />
      )}
      {tab === "tenants" && (
        <SaTenants
          tenants={filtered} allTenants={tenants} totalCount={tenants.length}
          search={search} setSearch={setSearch}
          statusFilter={statusFilter} setStatusFilter={setStatusFilter}
          onSetStatus={setTenantStatus}
          onCreate={createTenant}
          onUpdate={updateTenant}
          onDelete={deleteTenant}
          onReload={reloadTenants}
          loading={loadingTenants}
          dbOnline={dbStatus.isOnline}
        />
      )}
      {tab === "users" && <SaUsers />}
      {tab === "system" && <SaSystem />}
    </>
  );

  // Modo embedded · renderiza só a sub-nav de abas + conteúdo.
  // Sidebar/Topbar do AppShell cuidam de logout, tema, identidade.
  if (embedded) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "12px 24px", borderBottom: "1px solid var(--line-soft)",
          background: "var(--bg-1)",
        }}>
          <SaTabs tab={tab} setTab={setTab} />
          <div style={{ flex: 1 }} />
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
            {tenants.length} tenant{tenants.length === 1 ? "" : "s"}
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>{content}</div>
      </div>
    );
  }

  // Modo standalone · header próprio com logout (compat: chamado direto sem AppShell)
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", background: "var(--bg-0)" }}>
      <header style={{
        display: "flex", alignItems: "center",
        padding: "12px 24px", borderBottom: "1px solid var(--line)",
        background: "var(--bg-1)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 4,
            background: "linear-gradient(135deg, #c2843a, #b04545)",
            display: "grid", placeItems: "center", color: "#fff",
          }}>
            <I.Trophy size={14} />
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.01em" }}>
              StockKitchen · Superadmin
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
              painel da plataforma · {tenants.length} tenants
            </div>
          </div>
        </div>
        <SaTabs tab={tab} setTab={setTab} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 50,
              background: "var(--bg-3)", color: "var(--fg-1)",
              fontSize: 11, fontWeight: 500, display: "grid", placeItems: "center",
            }}>{user.avatar || user.name?.split(" ").map((n) => n[0]).slice(0, 2).join("")}</div>
            <div>
              <div style={{ fontSize: 12, color: "var(--fg-0)", fontWeight: 500 }}>{user.name}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "#c2843a", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                superadmin
              </div>
            </div>
          </div>
          <button className="btn" data-size="sm" onClick={onLogout} title="Sair">
            Sair
          </button>
        </div>
      </header>
      <div style={{ flex: 1, overflow: "auto" }}>{content}</div>
    </div>
  );
}

function SaTabs({ tab, setTab }) {
  const tabs = [
    { id: "overview", label: "Visão geral" },
    { id: "tenants",  label: "Tenants" },
    { id: "users",    label: "Usuários globais" },
    { id: "system",   label: "Sistema" },
  ];
  return (
    <nav style={{ display: "flex", gap: 0 }}>
      {tabs.map(({ id, label }) => {
        const active = tab === id;
        return (
          <button key={id} onClick={() => setTab(id)} style={{
            background: active ? "var(--bg-3)" : "transparent",
            border: "none", borderRadius: 4,
            padding: "6px 12px", fontSize: 12, cursor: "pointer",
            color: active ? "var(--fg-0)" : "var(--fg-2)",
            fontWeight: active ? 500 : 400,
          }}>{label}</button>
        );
      })}
    </nav>
  );
}

// ===================== Visão Geral =====================
function SaOverview({ totalMRR, activeCount, trialCount, suspended, totalUsers, totalOps, totalRevenue30d, tenants }) {
  // Top tenants por MRR
  const topByMRR = [...tenants].sort((a, b) => b.mrr - a.mrr).slice(0, 5);
  // Tenants em risco (suspensos ou CMV alto)
  const atRisk = tenants.filter((t) =>
    t.status === "suspended" || t.cmvAvg > 38
  );
  // Últimos a logar
  const recent = [...tenants].sort((a, b) => (b.lastLogin || "").localeCompare(a.lastLogin || "")).slice(0, 6);

  return (
    <div style={{ padding: "20px 28px 32px", display: "flex", flexDirection: "column", gap: 16 }} className="stagger">
      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        <SaKpi label="MRR total" value={_saFmtBRL(totalMRR)} sub="receita recorrente mensal" accent valueColor="var(--accent-bright)" />
        <SaKpi label="Tenants ativos" value={activeCount} sub={`${trialCount} em trial · ${suspended} suspenso(s)`} />
        <SaKpi label="Usuários da plataforma" value={totalUsers} sub={`${totalOps} operações ativas`} />
        <SaKpi label="GMV últimos 30 dias" value={_saFmtBRL(totalRevenue30d)} sub="soma de todos os tenants" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        <SaKpi label="Tickets abertos" value="—"
               sub={<PendingFeature variant="inline" label="suporte" hint="Sistema de tickets — pendente" />} />
        <SaKpi label="Uptime 30d" value="99.97%"
               sub={<PendingFeature variant="inline" label="observabilidade" hint="Métricas reais via Logflare/Datadog" />} />
        <SaKpi label="Erros 24h" value="0"
               sub={<PendingFeature variant="inline" label="logs reais" hint="Captura de erros via Sentry — pendente" />} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
        {/* MRR ao longo do tempo */}
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">Crescimento de MRR · 12 meses</h3>
              <span className="card-sub" style={{ display: "block", marginTop: 4 }}>Receita recorrente mensal consolidada</span>
            </div>
            {(() => {
              const hist = MOCK.SYSTEM_MRR_HISTORY || [];
              const base = hist[0]?.mrr;
              if (!base || !totalMRR) return <PendingFeature variant="inline" label="histórico MRR" hint="Integração Stripe pendente" />;
              const yoy = ((totalMRR / base - 1) * 100).toFixed(0);
              return <span className="badge" data-tone="ok">+ {yoy}% YoY</span>;
            })()}
          </div>
          <div className="card-body">
            {(MOCK.SYSTEM_MRR_HISTORY || []).length > 0
              ? <SaMrrChart data={MOCK.SYSTEM_MRR_HISTORY} />
              : <PendingFeature variant="card" label="Histórico de MRR" hint="Aguardando integração com Stripe · sem dados pra plotar" />}
          </div>
        </div>

        {/* Top tenants por MRR */}
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">Top 5 · MRR</h3>
              <span className="card-sub" style={{ display: "block", marginTop: 4 }}>Maiores assinaturas</span>
            </div>
          </div>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {topByMRR.map((t, i) => {
              const max = topByMRR[0].mrr;
              const pct = max > 0 ? (t.mrr / max) * 100 : 0;
              const plan = SA_PLAN_META[t.plan];
              return (
                <div key={t.id} style={{ display: "grid", gridTemplateColumns: "20px 1fr 80px", gap: 10, alignItems: "center" }}>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{i + 1}</span>
                  <div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: "var(--fg-0)", fontWeight: 500 }}>{t.name}</span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: plan?.color, letterSpacing: "0.06em", textTransform: "uppercase" }}>{plan?.label}</span>
                    </div>
                    <div style={{ position: "relative", height: 4, background: "var(--bg-3)", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${pct}%`, background: plan?.color }} />
                    </div>
                  </div>
                  <span className="mono" style={{ fontSize: 12, color: "var(--fg-0)", fontWeight: 500, textAlign: "right" }}>{_saFmtBRL(t.mrr)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {/* Em risco */}
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">Tenants em risco</h3>
              <span className="card-sub" style={{ display: "block", marginTop: 4 }}>Suspensos · CMV &gt; 38</span>
            </div>
            {atRisk.length > 0 && <span className="badge" data-tone="crit">{atRisk.length}</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {atRisk.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>
                Nenhum tenant em risco. ✨
              </div>
            ) : atRisk.map((t, i) => (
              <div key={t.id} style={{
                display: "grid", gridTemplateColumns: "1fr auto auto", gap: 10, alignItems: "center",
                padding: "10px 16px",
                borderBottom: i < atRisk.length - 1 ? "1px solid var(--line-soft)" : "none",
              }}>
                <div>
                  <div style={{ fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500 }}>{t.name}</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.04em", marginTop: 2 }}>
                    {t.region} · {t.users} users · CMV {t.cmvAvg}%
                  </div>
                </div>
                <span className="badge" data-tone={SA_STATUS_META[t.status]?.tone}>
                  {SA_STATUS_META[t.status]?.label}
                </span>
                <span className="mono" style={{ fontSize: 11, color: "var(--crit)" }}>
                  {t.status === "suspended" ? "suspenso" : "CMV alto"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Últimos a logar */}
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">Atividade recente</h3>
              <span className="card-sub" style={{ display: "block", marginTop: 4 }}>Últimos logins na plataforma</span>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {recent.map((t, i) => {
              const minutes = Math.floor((Date.now() - new Date(t.lastLogin).getTime()) / 60000);
              const ago = minutes < 60 ? `${minutes}min` : minutes < 1440 ? `${Math.floor(minutes/60)}h` : `${Math.floor(minutes/1440)}d`;
              return (
                <div key={t.id} style={{
                  display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "center",
                  padding: "10px 16px",
                  borderBottom: i < recent.length - 1 ? "1px solid var(--line-soft)" : "none",
                }}>
                  <div>
                    <div style={{ fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500 }}>{t.name}</div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.04em", marginTop: 2 }}>
                      {t.region} · há {ago}
                    </div>
                  </div>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-2)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                    {SA_PLAN_META[t.plan]?.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function SaKpi({ label, value, sub, valueColor, accent }) {
  return (
    <div className="kpi" style={{
      padding: "14px 16px",
      ...(accent ? { borderColor: "var(--accent-line)", background: "linear-gradient(180deg, rgba(45,140,102,0.04), transparent 60%)" } : null),
    }}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 22, color: valueColor || "var(--fg-0)" }}>{value}</div>
      {sub && <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function SaMrrChart({ data }) {
  const W = 720, H = 160;
  const padL = 56, padR = 12, padT = 14, padB = 26;
  const max = Math.max(...data.map((d) => d.mrr));
  const min = 0;
  const xOf = (i) => padL + (i / Math.max(1, data.length - 1)) * (W - padL - padR);
  const yOf = (v) => padT + (1 - (v - min) / Math.max(1, max - min)) * (H - padT - padB);
  const points = data.map((d, i) => ({ x: xOf(i), y: yOf(d.mrr), v: d.mrr, l: d.month }));

  const path = points.length > 1
    ? points.reduce((acc, p, i) => {
        if (i === 0) return `M${p.x},${p.y}`;
        const prev = points[i - 1];
        const cx = (prev.x + p.x) / 2;
        return `${acc} C ${cx},${prev.y} ${cx},${p.y} ${p.x},${p.y}`;
      }, "")
    : "";
  const area = points.length > 1 ? `${path} L ${points[points.length - 1].x},${H - padB} L ${points[0].x},${H - padB} Z` : "";

  const ticks = [0, 0.5, 1].map((p) => ({ v: max * p, y: yOf(max * p) }));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", maxWidth: "100%" }}>
      <defs>
        <linearGradient id="saMrrGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-bright)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--accent-bright)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={t.y} y2={t.y} stroke="var(--line-soft)" strokeDasharray={i === 0 ? "" : "2 4"} />
          <text x={padL - 6} y={t.y + 3} textAnchor="end" fontFamily="var(--mono)" fontSize="9.5" fill="var(--fg-3)">
            R$ {Math.round(t.v).toLocaleString("pt-BR")}
          </text>
        </g>
      ))}
      {points.map((p, i) => i % 2 === 0 || i === points.length - 1 ? (
        <text key={i} x={p.x} y={H - padB + 14} textAnchor="middle" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-3)">{p.l}</text>
      ) : null)}
      <path d={area} fill="url(#saMrrGrad)" />
      <path d={path} fill="none" stroke="var(--accent-bright)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.6} fill="var(--bg-1)" stroke="var(--accent-bright)" strokeWidth="1.5" />
      ))}
    </svg>
  );
}

// ===================== Tenants =====================
function SaTenants({
  tenants, allTenants, totalCount, search, setSearch, statusFilter, setStatusFilter,
  onSetStatus, onCreate, onUpdate, onDelete, onReload, loading, dbOnline,
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing]   = useState(null); // tenant em edição
  const [deleting, setDeleting] = useState(null); // tenant a confirmar exclusão
  const [busy, setBusy]         = useState(false);

  const submitCreate = async (draft) => {
    setBusy(true);
    try {
      const res = await onCreate(draft);
      if (res?.ok) setCreating(false);
    } finally { setBusy(false); }
  };
  const submitEdit = async (patch) => {
    if (!editing) return;
    setBusy(true);
    try {
      const res = await onUpdate(editing.id, patch);
      if (res?.ok) setEditing(null);
    } finally { setBusy(false); }
  };
  const submitDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      const res = await onDelete(deleting.id);
      if (res?.ok) setDeleting(null);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ padding: "16px 28px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <input className="input" value={search} onChange={(e) => setSearch(e.target.value)}
               placeholder="Buscar tenant…" style={{ width: 280 }} />
        <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">Todos os status</option>
          <option value="active">Ativos</option>
          <option value="trial">Em trial</option>
          <option value="suspended">Suspensos</option>
          <option value="canceled">Cancelados</option>
        </select>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
          {loading ? "carregando…" : `${tenants.length} de ${totalCount}`}
          {!dbOnline && <span style={{ color: "var(--warn)", marginLeft: 6 }}>· DB offline (modo MOCK)</span>}
        </span>
        {dbOnline && (
          <button className="btn" data-size="sm" onClick={onReload} title="Recarregar lista do banco" disabled={loading}>
            Atualizar
          </button>
        )}
        <button className="btn" data-variant="primary" data-size="sm" onClick={() => setCreating(true)}>
          <I.Plus size={11} />Novo tenant
        </button>
      </div>

      {creating && (
        <NewTenantModal
          existingSlugs={allTenants.map((t) => t.slug)}
          dbOnline={dbOnline} busy={busy}
          onCancel={() => setCreating(false)}
          onSave={submitCreate}
        />
      )}

      {editing && (
        <EditTenantModal
          tenant={editing} existingSlugs={allTenants.map((t) => t.slug)}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={submitEdit}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        title={deleting ? `Excluir tenant "${deleting.name}"?` : ""}
        message={deleting ? (
          <>Essa ação é <strong>irreversível</strong>. Todos os dados associados (operações, estoque, faturamento, fichas, etc.) serão excluídos em cascata. Usuários no <code>auth.users</code> não são removidos.</>
        ) : ""}
        confirmLabel="Excluir tenant"
        tone="danger"
        busy={busy}
        onConfirm={submitDelete}
        onCancel={() => setDeleting(null)}
      />

      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Owner</th>
              <th>Plano</th>
              <th className="num">Usuários</th>
              <th>Criado</th>
              <th>Status</th>
              <th style={{ width: 1, whiteSpace: "nowrap" }}>Ações</th>
            </tr>
          </thead>
          <tbody>
            {tenants.length === 0 ? (
              <tr><td colSpan={7} className="dim" style={{ textAlign: "center", padding: 32 }}>
                {loading ? "Carregando tenants…" : "Nenhum tenant nesse filtro"}
              </td></tr>
            ) : tenants.map((t) => {
              const plan = SA_PLAN_META[t.plan];
              const status = SA_STATUS_META[t.status];
              return (
                <tr key={t.id}>
                  <td>
                    <div className="row-strong">{t.name}</div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", marginTop: 2 }}>
                      {t.slug} · CNPJ {t.cnpj || "—"}
                    </div>
                  </td>
                  <td className="dim" style={{ fontSize: 11.5 }}>
                    {t.ownerName || <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>sem owner</span>}
                  </td>
                  <td>
                    <span style={{
                      fontFamily: "var(--mono)", fontSize: 10, fontWeight: 500,
                      color: plan?.color, letterSpacing: "0.06em", textTransform: "uppercase",
                      padding: "2px 8px", border: `1px solid ${plan?.color}`, borderRadius: 99,
                    }}>{plan?.label}</span>
                  </td>
                  <td className="num">{t.users}</td>
                  <td className="dim mono" style={{ fontSize: 10.5 }}>{t.createdAt || "—"}</td>
                  <td><span className="badge" data-tone={status?.tone}>{status?.label}</span></td>
                  <td>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button className="btn" data-variant="ghost" data-size="sm"
                              onClick={() => setEditing(t)}
                              title="Editar tenant">
                        <I.Edit size={11} />
                      </button>
                      {t.status === "active" || t.status === "trial" ? (
                        <button className="btn" data-variant="ghost" data-size="sm"
                                onClick={() => onSetStatus(t.id, "suspended")}
                                style={{ color: "var(--warn)" }} title="Suspender">
                          <I.Lock size={11} />
                        </button>
                      ) : (
                        <button className="btn" data-variant="ghost" data-size="sm"
                                onClick={() => onSetStatus(t.id, "active")}
                                style={{ color: "var(--ok)" }} title="Reativar">
                          <I.Check size={11} />
                        </button>
                      )}
                      <button className="btn" data-variant="ghost" data-size="sm"
                              onClick={() => setDeleting(t)}
                              style={{ color: "var(--crit)" }} title="Excluir tenant">
                        <I.Trash size={11} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ===================== Usuários globais =====================
function SaUsers() {
  const [search, setSearch] = useState("");
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const q = norm(search.trim());
  const users = (MOCK.SYSTEM_USERS || []).filter((u) => !q || norm(u.name).includes(q) || norm(u.email).includes(q));

  return (
    <div style={{ padding: "16px 28px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input className="input" value={search} onChange={(e) => setSearch(e.target.value)}
               placeholder="Buscar usuário…" style={{ width: 280 }} />
        <span style={{ flex: 1 }} />
        <PendingFeature label="convites" hint="Disparar email de convite real — depende de Supabase Auth + Resend" />
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>Usuário</th>
              <th>Email</th>
              <th>Tenant</th>
              <th>Papel</th>
              <th>Avatar</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const tenant = MOCK.SYSTEM_TENANTS.find((t) => t.id === u.tenantId);
              return (
                <tr key={u.email}>
                  <td className="row-strong">{u.name}</td>
                  <td className="dim mono" style={{ fontSize: 11 }}>{u.email}</td>
                  <td>{u.tenantId ? tenant?.name : <span className="mono" style={{ fontSize: 10, color: "#c2843a", letterSpacing: "0.06em", textTransform: "uppercase" }}>plataforma</span>}</td>
                  <td>
                    <span style={{
                      fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase",
                      padding: "2px 8px", borderRadius: 99,
                      color: u.role === "superadmin" ? "#c2843a" : "var(--fg-1)",
                      background: u.role === "superadmin" ? "var(--warn-soft)" : "var(--bg-2)",
                      border: `1px solid ${u.role === "superadmin" ? "var(--warn-line)" : "var(--line)"}`,
                    }}>
                      {u.role}
                    </span>
                  </td>
                  <td>
                    <div style={{
                      width: 24, height: 24, borderRadius: 50,
                      background: "var(--bg-3)", color: "var(--fg-1)",
                      fontSize: 10, fontWeight: 500, display: "grid", placeItems: "center",
                    }}>{u.avatar || u.name?.split(" ").map((n) => n[0]).slice(0, 2).join("")}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <PendingFeature variant="block" label="Audit log de acessos por usuário"
        hint="Registro de logins, IPs, sessions ativas e revogação remota. Pendente — depende de tabela de sessions e backend de auth." />
    </div>
  );
}

// ===================== Sistema · diagnóstico do Supabase =====================
// Dados via edge function `platform-diagnostics`. O painel traduz advisors,
// erros de log e estrutura do banco pra linguagem de leigo, com "como corrigir".

const SYS_LEVEL_TONE = { ERROR: "crit", WARN: "warn", INFO: "info", LOG: "neutral" };

// Explicações leigas por código de advisor/lint. Cobre tanto os códigos SQL do
// nosso RPC (definer_exposed, function_no_search_path) quanto os nomes oficiais
// do advisor do Supabase (authenticated_security_definer_function_executable…).
const SYS_LINT_EXPLAIN = {
  rls_enabled_no_policy: {
    titulo: "Tabela protegida, mas sem regra de quem pode ler/escrever",
    oQueE: "A trava de segurança por linha (RLS) está ligada nessa tabela, porém não há nenhuma regra dizendo quem acessa. Na prática a tabela fica fechada pra todo mundo (só o sistema interno entra).",
    risco: "Baixo. Geralmente é proposital em tabelas de uso interno (integrações, config). Vira problema só se o app de fato precisar ler essa tabela e estiver dando erro de acesso.",
    corrigir: "Se for tabela interna, pode ignorar. Se o app precisa dela, crie uma policy de acesso (peça pro dev rodar uma migration com a regra adequada).",
  },
  definer_exposed: {
    titulo: "Função poderosa que qualquer usuário logado pode chamar",
    oQueE: "Essa função roda com privilégios elevados (SECURITY DEFINER) e está exposta na API: qualquer usuário autenticado consegue executá-la pela internet.",
    risco: "Médio. Se a função não validar direito quem está chamando, um usuário pode acessar dados de outro. As nossas validam o tenant por dentro — mas o ideal é também travar o acesso.",
    corrigir: "Se só o backend deveria chamar: revogar o EXECUTE de 'authenticated' e expor via edge function. Se usuários precisam chamar, garantir a validação de tenant dentro da função (já fazemos).",
  },
  authenticated_security_definer_function_executable: {
    titulo: "Função poderosa que qualquer usuário logado pode chamar",
    oQueE: "Essa função roda com privilégios elevados (SECURITY DEFINER) e está exposta na API: qualquer usuário autenticado consegue executá-la pela internet.",
    risco: "Médio. Se a função não validar direito quem está chamando, um usuário pode acessar dados de outro. As nossas validam o tenant por dentro — mas o ideal é também travar o acesso.",
    corrigir: "Se só o backend deveria chamar: revogar o EXECUTE de 'authenticated' e expor via edge function. Se usuários precisam chamar, garantir a validação de tenant dentro da função (já fazemos).",
  },
  extension_in_public: {
    titulo: "Extensão instalada no lugar 'público' do banco",
    oQueE: "Uma extensão (aqui o pg_net, que faz chamadas HTTP) está instalada no schema 'public' em vez de um schema separado. É uma recomendação de organização/segurança do Supabase.",
    risco: "Muito baixo. O pg_net não dá pra mover sem quebrar coisas hoje; é uma limitação conhecida da própria extensão. Não afeta o funcionamento.",
    corrigir: "Pode conviver com esse aviso. Quando o Supabase permitir mover o pg_net de schema sem efeitos colaterais, a gente realoca. Nada urgente.",
  },
  function_no_search_path: {
    titulo: "Função sem 'caminho de busca' fixado",
    oQueE: "Uma função com privilégio elevado não fixou o search_path. Em teoria, alguém com permissão de criar objetos poderia enganar a função pra usar uma tabela falsa.",
    risco: "Baixo no nosso caso (ninguém de fora cria objetos no banco), mas é boa prática corrigir.",
    corrigir: "Adicionar 'SET search_path = public, pg_temp' na definição da função (migration simples).",
  },
  function_search_path_mutable: {
    titulo: "Função sem 'caminho de busca' fixado",
    oQueE: "Uma função com privilégio elevado não fixou o search_path. Em teoria, alguém com permissão de criar objetos poderia enganar a função pra usar uma tabela falsa.",
    risco: "Baixo no nosso caso (ninguém de fora cria objetos no banco), mas é boa prática corrigir.",
    corrigir: "Adicionar 'SET search_path = public, pg_temp' na definição da função (migration simples).",
  },
  auth_leaked_password_protection: {
    titulo: "Proteção contra senhas vazadas está desligada",
    oQueE: "O Supabase pode bloquear que usuários escolham senhas que já apareceram em vazamentos públicos (base HaveIBeenPwned). Hoje está desativado.",
    risco: "Médio. Usuários podem usar senhas fracas/já comprometidas, facilitando invasão de contas.",
    corrigir: "Liga num clique: painel Supabase → Authentication → Policies → 'Leaked password protection'. Recomendado ativar.",
  },
  unindexed_foreign_keys: {
    titulo: "Chave estrangeira sem índice (pode deixar consultas lentas)",
    oQueE: "Existe uma ligação entre tabelas (foreign key) sem índice. Consultas e exclusões que usam essa ligação podem ficar lentas conforme os dados crescem.",
    risco: "Performance, não segurança. Sentido só quando a tabela tem muitos registros.",
    corrigir: "Criar um índice na coluna da foreign key (migration de uma linha). Vale priorizar nas tabelas maiores.",
  },
  unused_index: {
    titulo: "Índice que nunca é usado (ocupa espaço à toa)",
    oQueE: "Há um índice que o banco não usou em nenhuma consulta. Ele só ocupa espaço e deixa as escritas um pouquinho mais lentas.",
    risco: "Baixíssimo. É só desperdício de espaço/manutenção.",
    corrigir: "Se confirmar que não serve, dá pra remover (DROP INDEX). Sem pressa.",
  },
};

// Padrões de mensagem de erro de log → explicação leiga.
const SYS_LOG_PATTERNS = [
  {
    re: /relation\s+"?([\w.]+)"?\s+does not exist/i,
    titulo: "O sistema tentou usar uma tabela que não existe mais",
    explica: (m) => `Algo no banco consultou "${m[1]}", que foi removida (provável tabela legada). O erro se repete porque uma rotina agendada ou integração ainda aponta pra ela.`,
    corrigir: "Achar quem ainda chama essa tabela (cron job, edge function ou integração externa) e atualizar/desligar. Enquanto não corrige, não quebra o app — mas polui os logs.",
  },
  {
    re: /(connection reset by peer|could not receive data from client|unexpected EOF|terminating connection)/i,
    titulo: "Conexão de rede caiu no meio (geralmente inofensivo)",
    explica: () => "Um cliente fechou a conexão antes de terminar. Acontece normalmente com apps web/celular trocando de rede. Só vira problema se for muito frequente.",
    corrigir: "Normalmente ignorar. Se for constante, investigar instabilidade de rede ou timeouts curtos demais.",
  },
  {
    re: /permission denied for (schema|table|relation)/i,
    titulo: "Permissão negada (faltou GRANT)",
    explica: () => "Um papel do banco tentou acessar algo sem permissão. Costuma derrubar funções/edge functions inteiras.",
    corrigir: "Rodar os GRANTs do schema afetado (ver CLAUDE.md §5). Se for no schema 'app' ou 'public', há migration idempotente pronta.",
  },
  {
    re: /violates (foreign key|unique|not-null|check) constraint/i,
    titulo: "Tentativa de gravar dado inválido (regra do banco barrou)",
    explica: () => "O banco recusou um dado que viola uma regra (duplicado, campo obrigatório vazio, ou referência inexistente). O dado não entrou.",
    corrigir: "Em geral é o app mandando dado incompleto — ajustar a validação na tela. O banco está se protegendo corretamente.",
  },
  {
    re: /(statement timeout|canceling statement due to)/i,
    titulo: "Uma consulta demorou demais e foi cancelada",
    explica: () => "Uma query passou do tempo limite. Costuma ser consulta pesada sem índice ou volume grande de dados.",
    corrigir: "Otimizar a query/adicionar índice, ou paginar o volume. Ver a aba de performance.",
  },
];

function sysExplainLog(msg) {
  for (const p of SYS_LOG_PATTERNS) {
    const m = String(msg || "").match(p.re);
    if (m) return { titulo: p.titulo, explica: p.explica(m), corrigir: p.corrigir };
  }
  return null;
}

function sysFmtBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1e9) return (b / 1e9).toFixed(2) + " GB";
  if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB";
  if (b >= 1e3) return (b / 1e3).toFixed(0) + " kB";
  return b + " B";
}

// timestamps dos logs vêm em microssegundos (postgres) ou ms/ISO (edge). Normaliza.
function sysToDate(ts) {
  if (ts == null) return null;
  if (typeof ts === "string") { const d = new Date(ts); return isNaN(d) ? null : d; }
  const n = Number(ts);
  if (!n) return null;
  if (n > 1e15) return new Date(n / 1000); // microssegundos
  if (n > 1e12) return new Date(n);        // milissegundos
  return new Date(n * 1000);               // segundos
}
function sysAgo(d) {
  if (!d) return "—";
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min}min`;
  if (min < 1440) return `há ${Math.floor(min / 60)}h`;
  return `há ${Math.floor(min / 1440)}d`;
}

// Agrupa erros idênticos (ex.: o mesmo erro repetindo a cada 5min) → 1 card + contagem.
function sysGroupLogs(rows) {
  const map = new Map();
  (rows || []).forEach((r) => {
    const key = String(r.event_message || "").trim();
    const d = sysToDate(r.timestamp);
    if (!map.has(key)) map.set(key, { message: key, count: 0, last: d, severity: r.severity });
    const g = map.get(key);
    g.count++;
    if (d && (!g.last || d > g.last)) g.last = d;
  });
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function SaSystem() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState(null);
  const [tokenInput, setTokenInput] = useState("");
  const [savingToken, setSavingToken] = useState(false);
  const [showToken, setShowToken]     = useState(false);
  const dbStatus = useDbStatus ? useDbStatus() : { isOnline: false };

  const load = React.useCallback(async () => {
    if (!isDbOnline || !isDbOnline()) { setErr("Banco offline (modo MOCK) — diagnóstico indisponível."); return; }
    setLoading(true); setErr(null);
    const { data, error } = await dbPlatformDiagnostics("status");
    if (error) setErr(error.message);
    else setData(data);
    setLoading(false);
  }, []);

  useEffect(() => { if (dbStatus.isOnline) load(); }, [dbStatus.isOnline, load]);

  const saveToken = async () => {
    if (savingToken || !tokenInput.trim()) return;
    setSavingToken(true);
    const { data: res, error } = await dbPlatformDiagnostics("set-token", { token: tokenInput.trim() });
    setSavingToken(false);
    if (error) { window.showToast?.("Falha ao salvar token: " + error.message, { tone: "crit", ttl: 5000 }); return; }
    if (res && res.valid === false) {
      window.showToast?.("Token salvo, mas não validou na Management API: " + (res.probeError || "erro"), { tone: "warn", ttl: 6000 });
    } else {
      window.showToast?.("Token salvo e validado ✓", { tone: "ok" });
    }
    setTokenInput(""); setShowToken(false);
    load();
  };

  if (loading && !data) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--fg-3)", fontSize: 13 }}>Carregando diagnóstico…</div>;
  }
  if (err && !data) {
    return (
      <div style={{ padding: "16px 28px 32px" }}>
        <div className="card" style={{ padding: 20, borderColor: "var(--crit-line)" }}>
          <div style={{ fontSize: 13, color: "var(--crit)", fontWeight: 500, marginBottom: 6 }}>Não foi possível carregar o diagnóstico</div>
          <div style={{ fontSize: 12, color: "var(--fg-2)", fontFamily: "var(--mono)" }}>{err}</div>
          <button className="btn" data-size="sm" onClick={load} disabled={loading} style={{ marginTop: 12 }}>
            {loading ? "Carregando…" : "Tentar de novo"}
          </button>
        </div>
      </div>
    );
  }

  const ov = data?.dbOverview || null;
  const totals = ov?.totals || {};
  const configured = !!data?.configured;

  // Fonte das descobertas de segurança: advisor oficial (se token) senão lints SQL.
  const officialSec = configured && data?.advisors?.security && !data.advisors.security.error
    ? data.advisors.security : null;
  const secFindings = (officialSec || ov?.lints || []).map((f) => ({
    code: f.name || f.code,
    level: f.level || "WARN",
    object: f.metadata?.name ? `${f.metadata.schema || "public"}.${f.metadata.name}` : f.object,
    detail: f.detail || null,
    remediation: f.remediation || null,
  }));
  const perfFindings = configured && Array.isArray(data?.advisors?.performance) ? data.advisors.performance : [];

  const pgLogs   = data?.logs?.postgres;
  const edgeLogs = data?.logs?.edge;

  return (
    <div style={{ padding: "16px 28px 32px", display: "flex", flexDirection: "column", gap: 16 }} className="stagger">
      {/* Cabeçalho + refresh */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }}>Diagnóstico do sistema · Supabase</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", marginTop: 2 }}>
            projeto {data?.projectRef || "—"} · gerado {ov?.generated_at ? sysAgo(sysToDate(Date.parse(ov.generated_at))) : "—"}
          </div>
        </div>
        <button className="btn" data-size="sm" onClick={load} disabled={loading}>
          {loading ? "Atualizando…" : "Atualizar"}
        </button>
      </div>

      {/* Token da Management API */}
      <SysTokenCard
        configured={configured}
        show={showToken} setShow={setShowToken}
        value={tokenInput} setValue={setTokenInput}
        onSave={saveToken} saving={savingToken}
        logsErr={configured ? (typeof pgLogs === "object" && pgLogs?.error) || (typeof edgeLogs === "object" && edgeLogs?.error) || null : null}
      />

      {/* KPIs do banco */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        <SaKpi label="Tamanho do banco" value={sysFmtBytes(totals.db_bytes)} sub={`schema public: ${sysFmtBytes(totals.public_bytes)}`} />
        <SaKpi label="Tabelas (public)" value={totals.public_tables ?? "—"} sub={`${totals.extensions ?? "—"} extensões ativas`} />
        <SaKpi label="Migrations aplicadas" value={totals.migrations ?? "—"} sub={`última: ${totals.latest_migration || "—"}`} />
        <SaKpi label="Jobs agendados" value={`${totals.cron_jobs_active ?? "—"}/${totals.cron_jobs ?? "—"}`} sub="ativos / total (pg_cron)" />
      </div>

      {/* Segurança */}
      <SysFindingsCard
        title="Segurança"
        subtitle={configured ? "Advisors oficiais do Supabase" : "Verificação local (configure o token pra ver os advisors oficiais + o de Auth)"}
        findings={secFindings}
        emptyMsg="Nenhum alerta de segurança. ✨"
      />

      {/* Performance (só com token) */}
      {configured && (
        <SysFindingsCard
          title="Performance"
          subtitle="Sugestões de índices e otimização do Supabase"
          findings={perfFindings.map((f) => ({
            code: f.name, level: f.level || "INFO",
            object: f.metadata?.name || (f.metadata ? JSON.stringify(f.metadata).slice(0, 60) : null),
            detail: f.detail, remediation: f.remediation,
          }))}
          emptyMsg="Nenhuma sugestão de performance no momento."
        />
      )}

      {/* Logs de erro */}
      <SysLogsCard title="Erros do banco · últimas 24h" data={pgLogs} configured={configured} />
      <SysLogsCard title="Erros das edge functions · últimas 24h" data={edgeLogs} configured={configured} />

      {/* Estrutura: tabelas + extensões + cron */}
      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 12 }}>
        <SysTablesCard tables={ov?.tables || []} />
        <SysCronCard jobs={ov?.cron_jobs || []} />
      </div>
      <SysExtensionsCard extensions={ov?.extensions || []} edgeFns={configured ? data?.edgeFns : null} />

      <PendingFeature variant="block" label="Ainda não cobertos aqui"
        hint="Faturamento da plataforma (gateway de pagamento), feature flags por tenant e status de backups/PITR continuam pendentes — não são expostos pela Management API que este painel usa." />
    </div>
  );
}

// --------- Card: token da Management API ---------
function SysTokenCard({ configured, show, setShow, value, setValue, onSave, saving, logsErr }) {
  return (
    <div className="card" style={{ padding: "14px 16px", borderColor: configured ? "var(--accent-line)" : "var(--warn-line)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="badge" data-tone={configured ? "ok" : "warn"}>{configured ? "Token configurado" : "Token ausente"}</span>
        <div style={{ flex: 1, fontSize: 12, color: "var(--fg-2)" }}>
          {configured
            ? "Logs e advisors oficiais ao vivo estão habilitados."
            : "Sem o token da Management API, o painel mostra só o que o banco enxerga (estrutura + verificação local). Logs e advisors oficiais ficam indisponíveis."}
        </div>
        <button className="btn" data-size="sm" onClick={() => setShow(!show)}>
          {show ? "Fechar" : configured ? "Trocar token" : "Configurar token"}
        </button>
      </div>

      {logsErr && (
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--warn)", fontFamily: "var(--mono)" }}>
          ⚠ Logs não carregaram: {String(logsErr)}
        </div>
      )}

      {show && (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--line-soft)", paddingTop: 12 }}>
          <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginBottom: 8, lineHeight: 1.5 }}>
            Gere um <strong>Personal Access Token</strong> em{" "}
            <a href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noreferrer" style={{ color: "var(--accent-bright)" }}>
              supabase.com/dashboard/account/tokens
            </a>{" "}
            e cole abaixo. Ele é gravado criptografado no Vault e usado só por esta função no servidor — <strong>nunca</strong> fica salvo no navegador.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input mono" type="password" value={value} placeholder="sbp_..."
                   onChange={(e) => setValue(e.target.value)} style={{ flex: 1 }} />
            <button className="btn" data-variant="primary" data-size="sm" onClick={onSave} disabled={saving || !value.trim()}>
              {saving ? "Salvando…" : "Salvar token"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --------- Card: descobertas (advisors/lints) ---------
function SysFindingsCard({ title, subtitle, findings, emptyMsg }) {
  const counts = findings.reduce((a, f) => { a[f.level] = (a[f.level] || 0) + 1; return a; }, {});
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">{title}</h3>
          <span className="card-sub" style={{ display: "block", marginTop: 4 }}>{subtitle}</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {["ERROR", "WARN", "INFO"].map((lv) => counts[lv]
            ? <span key={lv} className="badge" data-tone={SYS_LEVEL_TONE[lv]}>{counts[lv]} {lv}</span> : null)}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {findings.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>{emptyMsg}</div>
        ) : findings.map((f, i) => <SysFinding key={i} f={f} last={i === findings.length - 1} />)}
      </div>
    </div>
  );
}

function SysFinding({ f, last }) {
  const ex = SYS_LINT_EXPLAIN[f.code];
  return (
    <div style={{ padding: "12px 16px", borderBottom: last ? "none" : "1px solid var(--line-soft)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: ex ? 6 : 0 }}>
        <span className="badge" data-tone={SYS_LEVEL_TONE[f.level] || "neutral"}>{f.level}</span>
        <span style={{ fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500 }}>
          {ex?.titulo || f.code}
        </span>
        {f.object && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", marginLeft: "auto" }}>{f.object}</span>}
      </div>
      {ex ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5, lineHeight: 1.5 }}>
          <div style={{ color: "var(--fg-2)" }}><strong style={{ color: "var(--fg-1)" }}>O que é:</strong> {ex.oQueE}</div>
          <div style={{ color: "var(--fg-2)" }}><strong style={{ color: "var(--fg-1)" }}>Risco:</strong> {ex.risco}</div>
          <div style={{ color: "var(--fg-2)" }}><strong style={{ color: "var(--ok)" }}>Como corrigir:</strong> {ex.corrigir}</div>
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.5 }}>{f.detail || "Sem detalhe."}</div>
      )}
      {f.remediation && (
        <a href={f.remediation} target="_blank" rel="noreferrer"
           style={{ fontSize: 10.5, color: "var(--accent-bright)", marginTop: 6, display: "inline-block" }}>
          Documentação ↗
        </a>
      )}
    </div>
  );
}

// --------- Card: logs de erro ---------
function SysLogsCard({ title, data, configured }) {
  const isErr = data && typeof data === "object" && !Array.isArray(data) && data.error;
  const groups = Array.isArray(data) ? sysGroupLogs(data) : [];
  const total = Array.isArray(data) ? data.length : 0;

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">{title}</h3>
          <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
            {!configured ? "Requer o token da Management API"
              : isErr ? "Falha ao consultar os logs"
              : total === 0 ? "Nenhum erro no período 🎉"
              : `${total} ocorrência(s) em ${groups.length} tipo(s)`}
          </span>
        </div>
        {!isErr && total > 0 && <span className="badge" data-tone="crit">{total}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {!configured ? (
          <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>
            Configure o token acima pra ver os logs ao vivo.
          </div>
        ) : isErr ? (
          <div style={{ padding: "12px 16px", fontSize: 11.5, color: "var(--warn)", fontFamily: "var(--mono)" }}>{String(data.error)}</div>
        ) : groups.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>Sem erros nas últimas 24h. 🎉</div>
        ) : groups.map((g, i) => <SysLogRow key={i} g={g} last={i === groups.length - 1} />)}
      </div>
    </div>
  );
}

function SysLogRow({ g, last }) {
  const ex = sysExplainLog(g.message);
  return (
    <div style={{ padding: "12px 16px", borderBottom: last ? "none" : "1px solid var(--line-soft)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        {g.count > 1 && <span className="badge" data-tone="warn">{g.count}×</span>}
        <span style={{ fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500 }}>{ex?.titulo || "Erro"}</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", marginLeft: "auto" }}>{sysAgo(g.last)}</span>
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--crit)", background: "var(--bg-2)", padding: "6px 8px", borderRadius: 4, marginBottom: ex ? 6 : 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {g.message}
      </div>
      {ex && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11.5, lineHeight: 1.5 }}>
          <div style={{ color: "var(--fg-2)" }}>{ex.explica}</div>
          <div style={{ color: "var(--fg-2)" }}><strong style={{ color: "var(--ok)" }}>Como corrigir:</strong> {ex.corrigir}</div>
        </div>
      )}
    </div>
  );
}

// --------- Card: tabelas por tamanho ---------
function SysTablesCard({ tables }) {
  const max = tables[0]?.bytes || 1;
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">Maiores tabelas</h3>
          <span className="card-sub" style={{ display: "block", marginTop: 4 }}>Top {tables.length} por espaço em disco</span>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", padding: "8px 16px 12px", gap: 8 }}>
        {tables.map((t) => (
          <div key={t.name} style={{ display: "grid", gridTemplateColumns: "1fr 70px", gap: 10, alignItems: "center" }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-1)" }}>{t.name}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>~{Number(t.est_rows).toLocaleString("pt-BR")} linhas</span>
              </div>
              <div style={{ position: "relative", height: 4, background: "var(--bg-3)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${(t.bytes / max) * 100}%`, background: "var(--accent)" }} />
              </div>
            </div>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-0)", textAlign: "right" }}>{t.pretty}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --------- Card: jobs agendados ---------
function SysCronCard({ jobs }) {
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">Jobs agendados</h3>
          <span className="card-sub" style={{ display: "block", marginTop: 4 }}>Rotinas automáticas (pg_cron)</span>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {jobs.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}>Nenhum job.</div>
        ) : jobs.map((j, i) => (
          <div key={j.jobid} style={{ padding: "10px 16px", borderBottom: i < jobs.length - 1 ? "1px solid var(--line-soft)" : "none", display: "flex", alignItems: "center", gap: 8 }}>
            <span className="badge" data-tone={j.active ? "ok" : "neutral"} style={{ flexShrink: 0 }}>{j.active ? "on" : "off"}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.command}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", marginTop: 2 }}>cron: {j.schedule}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --------- Card: extensões + edge functions ---------
function SysExtensionsCard({ extensions, edgeFns }) {
  const fns = Array.isArray(edgeFns) ? edgeFns : null;
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">Extensões & Edge functions</h3>
          <span className="card-sub" style={{ display: "block", marginTop: 4 }}>
            {extensions.length} extensão(ões){fns ? ` · ${fns.length} edge function(s)` : ""}
          </span>
        </div>
      </div>
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {extensions.map((e) => (
            <span key={e.name} style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-1)", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 99, padding: "2px 8px" }}>
              {e.name} <span style={{ color: "var(--fg-3)" }}>{e.version}</span>
            </span>
          ))}
        </div>
        {fns && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {fns.map((fn) => (
              <span key={fn.id || fn.slug} style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-1)", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 99, padding: "2px 8px" }}>
                <span style={{ width: 6, height: 6, borderRadius: 50, background: fn.status === "ACTIVE" ? "var(--ok)" : "var(--warn)", display: "inline-block", marginRight: 5 }} />
                {fn.slug} <span style={{ color: "var(--fg-3)" }}>v{fn.version}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ===================== Modal · Provisionar novo tenant =====================
// Cria o cliente na plataforma (linha em SYSTEM_TENANTS) e opcionalmente um
// usuário owner em SYSTEM_USERS pra que ele possa logar e administrar.
//
// TODO backend: virar Edge Function `provision-tenant` que:
//   1. Insere em public.tenants
//   2. Cria/encontra auth.users do owner (signUp ou inviteByEmail)
//   3. Insere em public.tenant_members com role='owner'
//   4. Provisiona métodos de pagamento padrão (já tem create_tenant_with_owner)
//   5. Dispara email de boas-vindas (Resend) com link de acesso
function NewTenantModal({ existingSlugs, onCancel, onSave, busy = false, dbOnline = false }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [legalName, setLegalName] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [region, setRegion] = useState("");
  const [plan, setPlan] = useState("trial");
  const [status, setStatus] = useState("trial");
  const [withOwner, setWithOwner] = useState(true); // sempre true em DB mode (edge function exige owner)
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPwd, setOwnerPwd] = useState("");
  // authMode controla como o owner recebe acesso:
  //   "invite"   → envia convite por email (Supabase magic link) — padrão em DB
  //   "password" → superadmin define a senha aqui mesmo e entrega pro cliente
  const [authMode, setAuthMode] = useState(dbOnline ? "invite" : "password");
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

  // Auto-gera slug a partir do nome (até o usuário editar manualmente)
  useEffect(() => {
    if (slugManuallyEdited) return;
    const auto = String(name)
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40);
    setSlug(auto);
  }, [name, slugManuallyEdited]);

  // Sincroniza status com plano (trial → trial; senão → active)
  useEffect(() => {
    if (plan === "trial") setStatus("trial");
    else if (status === "trial") setStatus("active");
  }, [plan]);

  const slugTaken = slug && existingSlugs.includes(slug);
  const slugInvalid = slug && !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(slug);
  const ownerEmailValid = !withOwner || /\S+@\S+\.\S+/.test(ownerEmail);
  const ownerNameValid = !withOwner || ownerName.trim().length > 0;
  // Senha só é obrigatória quando o modo é "password" — em "invite" o owner
  // recebe um magic link e define a senha depois.
  const ownerPwdRequired = withOwner && authMode === "password";
  const ownerPwdValid = !ownerPwdRequired || (ownerPwd && ownerPwd.length >= 6);
  const valid = name.trim() && slug && !slugTaken && !slugInvalid && ownerEmailValid && ownerNameValid && ownerPwdValid;

  const submit = () => {
    // Em MOCK sempre temos senha (default "trocar123"). Em DB só mandamos
    // ownerPassword quando o superadmin escolheu o modo "password"; em "invite"
    // a edge function chama inviteUserByEmail e o owner define a senha depois.
    const pwdToSend = !withOwner
      ? null
      : dbOnline
        ? (authMode === "password" ? ownerPwd : null)
        : (ownerPwd || "trocar123");
    onSave({
      name: name.trim(),
      slug: slug.trim(),
      legalName: legalName.trim(),
      cnpj: cnpj.trim(),
      region: region.trim(),
      plan, status,
      ownerName: withOwner ? ownerName.trim() : null,
      ownerEmail: withOwner ? ownerEmail.trim() : null,
      ownerPassword: pwdToSend,
    });
  };

  const planMeta = SA_PLAN_META[plan];
  const monthlyByPlan = { trial: 0, starter: 189, pro: 489, enterprise: 989 };

  return (
    <Modal
      title="Provisionar novo tenant"
      subtitle="Cria o cliente na plataforma e (opcionalmente) o usuário owner do tenant"
      onClose={onCancel}
      width={680}
      footer={<>
        <button className="btn" data-size="sm" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button className="btn" data-variant="primary" data-size="sm" disabled={!valid || busy} onClick={submit}>
          <I.Plus size={11} />{busy ? "Provisionando…" : "Provisionar tenant"}
        </button>
      </>}
    >
      {/* Identificação */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
        <FormRow label="Nome do cliente">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)}
                 placeholder="Ex.: Hub das Pizzas SP" />
        </FormRow>
        <FormRow label="Slug · URL única"
                 hint={slugTaken ? "Já existe outro tenant com esse slug" : slugInvalid ? "Use só letras minúsculas, números e hífen" : "Auto-gerado · clique pra editar"}>
          <input className="input mono" value={slug}
                 onChange={(e) => { setSlug(e.target.value); setSlugManuallyEdited(true); }}
                 placeholder="hub-das-pizzas"
                 style={{
                   borderColor: slugTaken || slugInvalid ? "var(--crit)" : null,
                   color: slugTaken || slugInvalid ? "var(--crit)" : null,
                 }} />
        </FormRow>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr", gap: 12, marginBottom: 14 }}>
        <FormRow label="Razão social" hint="opcional">
          <input className="input" value={legalName} onChange={(e) => setLegalName(e.target.value)}
                 placeholder="Hub das Pizzas SP Ltda" />
        </FormRow>
        <FormRow label="CNPJ" hint="opcional">
          <input className="input mono" value={cnpj} onChange={(e) => setCnpj(e.target.value)}
                 placeholder="00.000.000/0001-00" />
        </FormRow>
        <FormRow label="Região">
          <input className="input" value={region} onChange={(e) => setRegion(e.target.value)}
                 placeholder="São Paulo · SP" />
        </FormRow>
      </div>

      {/* Plano */}
      <div style={{ marginBottom: 14 }}>
        <div className="h-eyebrow" style={{ marginBottom: 8 }}>Plano de assinatura</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          {[
            { id: "trial",      label: "Trial",      desc: "14 dias grátis",   price: "R$ 0" },
            { id: "starter",    label: "Starter",    desc: "1-2 operações",    price: "R$ 189/mês" },
            { id: "pro",        label: "Pro",        desc: "Até 6 operações",  price: "R$ 489/mês" },
            { id: "enterprise", label: "Enterprise", desc: "Customizado",      price: "R$ 989/mês" },
          ].map((p) => {
            const active = plan === p.id;
            const c = SA_PLAN_META[p.id];
            return (
              <button key={p.id} type="button" onClick={() => setPlan(p.id)} style={{
                padding: "10px 12px", textAlign: "left", borderRadius: 4, cursor: "pointer",
                background: active ? "var(--bg-3)" : "var(--bg-2)",
                border: `1px solid ${active ? c.color : "var(--line)"}`,
                color: "var(--fg-0)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 50, background: c.color }} />
                  <span style={{ fontSize: 12, fontWeight: 500 }}>{p.label}</span>
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.04em", marginBottom: 4 }}>
                  {p.desc}
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: c.color, fontWeight: 500 }}>
                  {p.price}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
        <FormRow label="Status inicial">
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Ativo</option>
            <option value="trial">Trial</option>
          </select>
        </FormRow>
        <FormRow label="MRR estimado · linha 1 da fatura">
          <div style={{
            padding: "6px 10px", background: "var(--bg-2)", border: "1px solid var(--line)",
            borderRadius: 4, fontFamily: "var(--mono)", fontSize: 13, color: planMeta?.color, fontWeight: 500,
          }}>
            R$ {monthlyByPlan[plan].toLocaleString("pt-BR")}/mês
          </div>
        </FormRow>
      </div>

      {/* Owner */}
      <div style={{
        padding: "12px 14px", background: "var(--bg-2)",
        border: "1px solid var(--line)", borderRadius: 4, marginBottom: 14,
      }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--fg-1)", cursor: dbOnline ? "default" : "pointer", marginBottom: withOwner ? 12 : 0 }}>
          <input type="checkbox" checked={withOwner} disabled={dbOnline}
                 onChange={(e) => setWithOwner(e.target.checked)} />
          <strong style={{ color: "var(--fg-0)" }}>Cadastrar usuário owner junto</strong>
          <span style={{ color: "var(--fg-3)", fontSize: 11.5 }}>· {dbOnline ? "obrigatório em modo DB" : "cria login pra esse tenant"}</span>
        </label>
        {withOwner && (
          <>
            {dbOnline && (
              <div style={{ marginBottom: 12 }}>
                <div className="h-eyebrow" style={{ marginBottom: 6 }}>Como o owner vai acessar</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {[
                    { id: "invite",   label: "Enviar convite por email", desc: "Owner recebe magic link e define a senha" },
                    { id: "password", label: "Definir senha aqui",       desc: "Você entrega a credencial pro cliente" },
                  ].map((m) => {
                    const active = authMode === m.id;
                    return (
                      <button key={m.id} type="button" onClick={() => setAuthMode(m.id)} style={{
                        padding: "8px 10px", textAlign: "left", borderRadius: 4, cursor: "pointer",
                        background: active ? "var(--bg-3)" : "var(--bg-1)",
                        border: `1px solid ${active ? "var(--accent)" : "var(--line)"}`,
                        color: "var(--fg-0)",
                      }}>
                        <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 2 }}>{m.label}</div>
                        <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{m.desc}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div style={{
              display: "grid",
              gridTemplateColumns: (dbOnline && authMode !== "password") ? "1fr 1fr" : "1fr 1fr 160px",
              gap: 12,
            }}>
              <FormRow label="Nome do owner">
                <input className="input" value={ownerName} onChange={(e) => setOwnerName(e.target.value)}
                       placeholder="Ex.: João Silva" />
              </FormRow>
              <FormRow label="Email do owner"
                       hint={dbOnline && authMode === "invite" ? "Convite Supabase será enviado nesse email" : null}>
                <input className="input" type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)}
                       placeholder="joao@cliente.com.br"
                       style={{
                         borderColor: ownerEmail && !ownerEmailValid ? "var(--crit)" : null,
                       }} />
              </FormRow>
              {(!dbOnline || authMode === "password") && (
                <FormRow label="Senha inicial"
                         hint={dbOnline
                           ? (ownerPwd && !ownerPwdValid ? "Mínimo 6 caracteres" : "Mínimo 6 caracteres · entregue pro cliente")
                           : "default: trocar123"}>
                  <input className="input mono" type="text" value={ownerPwd}
                         onChange={(e) => setOwnerPwd(e.target.value)}
                         placeholder={dbOnline ? "ex.: Cliente@2026" : "trocar123"}
                         style={{
                           borderColor: dbOnline && ownerPwd && !ownerPwdValid ? "var(--crit)" : null,
                         }} />
                </FormRow>
              )}
            </div>
          </>
        )}
      </div>

      {!dbOnline && (
        <PendingFeature variant="block" label="DB offline · modo MOCK"
          hint="O tenant será criado só na memória local. Conecte o Supabase pra provisionar de verdade via Edge Function `provision-tenant`." />
      )}
    </Modal>
  );
}

// ===================== Modal · Editar tenant existente =====================
// Edita campos persistidos em public.tenants (name, slug, legal_name, cnpj, plan,
// status, trial_ends_at). Owner/usuários têm gestão separada — aqui só os dados
// do próprio tenant.
function EditTenantModal({ tenant, existingSlugs, onCancel, onSave, busy = false }) {
  const [name, setName]           = useState(tenant.name || "");
  const [slug, setSlug]           = useState(tenant.slug || "");
  const [legalName, setLegalName] = useState(tenant.legalName || "");
  const [cnpj, setCnpj]           = useState(tenant.cnpj || "");
  const [plan, setPlan]           = useState(tenant.plan || "trial");
  const [status, setStatus]       = useState(tenant.status || "active");
  const [trialEndsAt, setTrialEndsAt] = useState(
    tenant.trialEndsAt ? String(tenant.trialEndsAt).slice(0, 10) : ""
  );

  const otherSlugs = (existingSlugs || []).filter((s) => s !== tenant.slug);
  const slugTaken   = slug && otherSlugs.includes(slug);
  const slugInvalid = slug && !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/.test(slug);
  const valid = name.trim() && slug && !slugTaken && !slugInvalid;

  const submit = () => {
    onSave({
      name: name.trim(),
      slug: slug.trim(),
      legal_name: legalName.trim() || null,
      cnpj: cnpj.trim() || null,
      plan, status,
      trial_ends_at: trialEndsAt || null,
    });
  };

  return (
    <Modal
      title={`Editar tenant · ${tenant.name}`}
      subtitle="Altera dados do cadastro. Owner e membros têm gestão separada."
      onClose={onCancel}
      width={620}
      footer={<>
        <button className="btn" data-size="sm" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button className="btn" data-variant="primary" data-size="sm" disabled={!valid || busy} onClick={submit}>
          {busy ? "Salvando…" : "Salvar alterações"}
        </button>
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
        <FormRow label="Nome do cliente">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </FormRow>
        <FormRow label="Slug · URL única"
                 hint={slugTaken ? "Já existe outro tenant com esse slug" : slugInvalid ? "Use só letras minúsculas, números e hífen" : null}>
          <input className="input mono" value={slug} onChange={(e) => setSlug(e.target.value)}
                 style={{
                   borderColor: slugTaken || slugInvalid ? "var(--crit)" : null,
                   color:       slugTaken || slugInvalid ? "var(--crit)" : null,
                 }} />
        </FormRow>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12, marginBottom: 14 }}>
        <FormRow label="Razão social" hint="opcional">
          <input className="input" value={legalName} onChange={(e) => setLegalName(e.target.value)} />
        </FormRow>
        <FormRow label="CNPJ" hint="opcional">
          <input className="input mono" value={cnpj} onChange={(e) => setCnpj(e.target.value)} />
        </FormRow>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div className="h-eyebrow" style={{ marginBottom: 8 }}>Plano de assinatura</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          {[
            { id: "trial",      label: "Trial",      desc: "14 dias grátis",   price: "R$ 0" },
            { id: "starter",    label: "Starter",    desc: "1-2 operações",    price: "R$ 189/mês" },
            { id: "pro",        label: "Pro",        desc: "Até 6 operações",  price: "R$ 489/mês" },
            { id: "enterprise", label: "Enterprise", desc: "Customizado",      price: "R$ 989/mês" },
          ].map((p) => {
            const active = plan === p.id;
            const c = SA_PLAN_META[p.id];
            return (
              <button key={p.id} type="button" onClick={() => setPlan(p.id)} style={{
                padding: "10px 12px", textAlign: "left", borderRadius: 4, cursor: "pointer",
                background: active ? "var(--bg-3)" : "var(--bg-2)",
                border: `1px solid ${active ? c.color : "var(--line)"}`,
                color: "var(--fg-0)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 50, background: c.color }} />
                  <span style={{ fontSize: 12, fontWeight: 500 }}>{p.label}</span>
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.04em", marginBottom: 4 }}>
                  {p.desc}
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: c.color, fontWeight: 500 }}>
                  {p.price}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 4 }}>
        <FormRow label="Status">
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Ativo</option>
            <option value="trial">Trial</option>
            <option value="suspended">Suspenso</option>
            <option value="canceled">Cancelado</option>
          </select>
        </FormRow>
        <FormRow label="Fim do trial" hint="opcional · só se aplicar">
          <input className="input mono" type="date" value={trialEndsAt}
                 onChange={(e) => setTrialEndsAt(e.target.value)} />
        </FormRow>
      </div>
    </Modal>
  );
}

window.SuperAdmin = SuperAdmin;
