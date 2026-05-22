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

function SuperAdmin({ user, onLogout }) {
  const [tab, setTab] = useState("overview");
  const [tenants, setTenants] = useState(MOCK.SYSTEM_TENANTS);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

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

  const setTenantStatus = (id, status) => {
    setTenants((prev) => prev.map((t) => t.id === id ? { ...t, status } : t));
    window.showToast(`Tenant atualizado para "${SA_STATUS_META[status]?.label}"`, { tone: "ok" });
  };

  const createTenant = (draft) => {
    const id = `ten-${Date.now().toString(36).slice(-6)}`;
    const mrrByPlan = { trial: 0, starter: 189, pro: 489, enterprise: 989 };
    const newTenant = {
      id,
      slug: draft.slug,
      name: draft.name,
      legalName: draft.legalName || draft.name,
      cnpj: draft.cnpj || "",
      region: draft.region || "—",
      plan: draft.plan,
      status: draft.status,
      users: 1, // owner sempre cadastrado junto
      ops: 0,
      mrr: mrrByPlan[draft.plan] || 0,
      revenue30d: 0,
      createdAt: new Date().toISOString().slice(0, 10),
      lastLogin: new Date().toISOString(),
      health: "ok",
      cmvAvg: 0,
    };
    setTenants((prev) => {
      const next = [newTenant, ...prev];
      MOCK.SYSTEM_TENANTS = next; // visível pro SaOverview e outros
      return next;
    });
    // Cadastra owner do tenant em SYSTEM_USERS se foi informado
    if (draft.ownerEmail && draft.ownerName) {
      const newUser = {
        email: draft.ownerEmail.trim().toLowerCase(),
        password: draft.ownerPassword || "trocar123",
        name: draft.ownerName.trim(),
        role: "owner",
        tenantId: id,
        avatar: draft.ownerName.trim().split(" ").map((n) => n[0]).slice(0, 2).join("").toUpperCase(),
      };
      MOCK.SYSTEM_USERS = [...(MOCK.SYSTEM_USERS || []), newUser];
    }
    window.showToast(
      `Tenant "${draft.name}" provisionado · plano ${SA_PLAN_META[draft.plan]?.label}${draft.ownerEmail ? ` · owner ${draft.ownerEmail}` : ""}`,
      { tone: "ok", ttl: 5000 },
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", background: "var(--bg-0)" }}>
      {/* Topbar custom · superadmin */}
      <header style={{
        display: "flex", alignItems: "center",
        padding: "12px 24px", borderBottom: "1px solid var(--line)",
        background: "var(--bg-1)",
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 12, flex: 1,
        }}>
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

      {/* Conteúdo */}
      <div style={{ flex: 1, overflow: "auto" }}>
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
          />
        )}
        {tab === "users" && <SaUsers />}
        {tab === "system" && <SaSystem />}
      </div>
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
            <span className="badge" data-tone="ok">+ {((totalMRR / (MOCK.SYSTEM_MRR_HISTORY[0].mrr || 1) - 1) * 100).toFixed(0)}% YoY</span>
          </div>
          <div className="card-body">
            <SaMrrChart data={MOCK.SYSTEM_MRR_HISTORY} />
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
function SaTenants({ tenants, allTenants, totalCount, search, setSearch, statusFilter, setStatusFilter, onSetStatus, onCreate }) {
  const [creating, setCreating] = useState(false);
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
          {tenants.length} de {totalCount}
        </span>
        <button className="btn" data-variant="primary" data-size="sm" onClick={() => setCreating(true)}>
          <I.Plus size={11} />Novo tenant
        </button>
      </div>

      {creating && (
        <NewTenantModal
          existingSlugs={allTenants.map((t) => t.slug)}
          onCancel={() => setCreating(false)}
          onSave={(draft) => { onCreate(draft); setCreating(false); }}
        />
      )}

      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Região</th>
              <th>Plano</th>
              <th className="num">Usuários</th>
              <th className="num">Operações</th>
              <th className="num">MRR</th>
              <th className="num">GMV 30d</th>
              <th>Status</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {tenants.length === 0 ? (
              <tr><td colSpan={9} className="dim" style={{ textAlign: "center", padding: 32 }}>Nenhum tenant nesse filtro</td></tr>
            ) : tenants.map((t) => {
              const plan = SA_PLAN_META[t.plan];
              const status = SA_STATUS_META[t.status];
              return (
                <tr key={t.id}>
                  <td>
                    <div className="row-strong">{t.name}</div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em", marginTop: 2 }}>
                      {t.id} · {t.slug} · CNPJ {t.cnpj}
                    </div>
                  </td>
                  <td className="dim" style={{ fontSize: 11.5 }}>{t.region}</td>
                  <td>
                    <span style={{
                      fontFamily: "var(--mono)", fontSize: 10, fontWeight: 500,
                      color: plan?.color, letterSpacing: "0.06em", textTransform: "uppercase",
                      padding: "2px 8px", border: `1px solid ${plan?.color}`, borderRadius: 99,
                    }}>{plan?.label}</span>
                  </td>
                  <td className="num">{t.users}</td>
                  <td className="num">{t.ops}</td>
                  <td className="num"><span className="mono" style={{ color: "var(--fg-0)", fontWeight: 500 }}>{_saFmtBRL(t.mrr)}</span></td>
                  <td className="num">{_saFmtBRL(t.revenue30d)}</td>
                  <td><span className="badge" data-tone={status?.tone}>{status?.label}</span></td>
                  <td>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button className="btn" data-variant="ghost" data-size="sm"
                              onClick={() => notImplemented(`Acessar painel de ${t.name}`)}
                              title="Acessar como cliente (impersonate)">
                        <I.Eye size={11} />
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

// ===================== Sistema =====================
function SaSystem() {
  return (
    <div style={{ padding: "16px 28px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      <PendingFeature variant="block" label="Saúde da infraestrutura"
        hint="Uptime, latência média de queries, errors, fila de jobs, status das Edge Functions. Pendente — integrar Supabase Status API + observabilidade externa (Sentry/Logflare)." />

      <PendingFeature variant="block" label="Logs estruturados"
        hint="Stream de eventos do sistema com filtro por tenant/severidade/categoria. Pendente — depende de captura via Edge Functions." />

      <PendingFeature variant="block" label="Feature flags"
        hint="Habilitar/desabilitar módulos (Inventário, etc.) por tenant. Pendente." />

      <PendingFeature variant="block" label="Faturamento da plataforma"
        hint="Painel de billing dos clientes (próximas cobranças, inadimplentes, upgrades). Pendente — depende de integração com gateway (Stripe/Iugu/Pagar.me)." />

      <PendingFeature variant="block" label="Backups e PITR"
        hint="Status de backups automáticos do Supabase + restore point-in-time. Pendente." />
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
function NewTenantModal({ existingSlugs, onCancel, onSave }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [legalName, setLegalName] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [region, setRegion] = useState("");
  const [plan, setPlan] = useState("trial");
  const [status, setStatus] = useState("trial");
  const [withOwner, setWithOwner] = useState(true);
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPwd, setOwnerPwd] = useState("");
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
  const valid = name.trim() && slug && !slugTaken && !slugInvalid && ownerEmailValid && ownerNameValid;

  const submit = () => {
    onSave({
      name: name.trim(),
      slug: slug.trim(),
      legalName: legalName.trim(),
      cnpj: cnpj.trim(),
      region: region.trim(),
      plan, status,
      ownerName: withOwner ? ownerName.trim() : null,
      ownerEmail: withOwner ? ownerEmail.trim() : null,
      ownerPassword: withOwner ? (ownerPwd || "trocar123") : null,
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
        <button className="btn" data-size="sm" onClick={onCancel}>Cancelar</button>
        <button className="btn" data-variant="primary" data-size="sm" disabled={!valid} onClick={submit}>
          <I.Plus size={11} />Provisionar tenant
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
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--fg-1)", cursor: "pointer", marginBottom: withOwner ? 12 : 0 }}>
          <input type="checkbox" checked={withOwner} onChange={(e) => setWithOwner(e.target.checked)} />
          <strong style={{ color: "var(--fg-0)" }}>Cadastrar usuário owner junto</strong>
          <span style={{ color: "var(--fg-3)", fontSize: 11.5 }}>· cria login pra esse tenant</span>
        </label>
        {withOwner && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 140px", gap: 12 }}>
            <FormRow label="Nome do owner">
              <input className="input" value={ownerName} onChange={(e) => setOwnerName(e.target.value)}
                     placeholder="Ex.: João Silva" />
            </FormRow>
            <FormRow label="Email do owner">
              <input className="input" type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)}
                     placeholder="joao@cliente.com.br"
                     style={{
                       borderColor: ownerEmail && !ownerEmailValid ? "var(--crit)" : null,
                     }} />
            </FormRow>
            <FormRow label="Senha inicial" hint="default: trocar123">
              <input className="input mono" type="text" value={ownerPwd} onChange={(e) => setOwnerPwd(e.target.value)}
                     placeholder="trocar123" />
            </FormRow>
          </div>
        )}
        <div style={{ marginTop: 10 }}>
          <PendingFeature variant="inline" label="email de boas-vindas"
            hint="Disparar email pro owner com link mágico de primeiro acesso. Pendente — depende de Edge Function + Resend." />
        </div>
      </div>

      <PendingFeature variant="block" label="Provisionamento real (Edge Function)"
        hint="Em produção, criar Edge Function que: insere em public.tenants, cria auth.users do owner, vincula como member com role='owner', dispara email de boas-vindas e popula seeds (categorias DRE, alertas padrão, métodos de pagamento)." />
    </Modal>
  );
}

window.SuperAdmin = SuperAdmin;
