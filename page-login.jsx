// LoginPage — autenticação local (mock).
// Em produção, substituir por Supabase Auth (signInWithPassword).
// =====================================================================

function LoginPage({ onLogin }) {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [showPwd, setShowPwd]   = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    setError("");
    setLoading(true);

    const cleanEmail = email.trim().toLowerCase();

    // Tenta auth real no Supabase quando o DB está online
    if (typeof isDbOnline === "function" && isDbOnline()) {
      try {
        const data = await dbSignIn(cleanEmail, password);
        // Resolve o profile + tenant do usuário no banco
        const ctx = await dbGetCurrentContext();
        // Encontra o user equivalente no MOCK pra herdar role/avatar
        // (em produção, role vem de tenant_members.role)
        const mockUser = (MOCK.SYSTEM_USERS || []).find((u) => u.email.toLowerCase() === cleanEmail);
        const user = {
          email: cleanEmail,
          name:  ctx?.profile?.full_name || mockUser?.name || cleanEmail.split("@")[0],
          role:  ctx?.member?.role || mockUser?.role || "viewer",
          tenantId: ctx?.tenant?.id || mockUser?.tenantId || null,
          tenantName: ctx?.tenant?.name || mockUser?.tenantName || null,
          ops: ctx?.member?.ops || [],
          modules: Array.isArray(ctx?.member?.modules) ? ctx.member.modules : null,
          avatar: mockUser?.avatar || (ctx?.profile?.full_name || "?").split(" ").map((n) => n[0]).slice(0, 2).join("").toUpperCase(),
          authSource: "supabase",
        };
        try {
          localStorage.setItem("stockkitchen.session.v1", JSON.stringify({
            ...user, loggedAt: new Date().toISOString(),
          }));
        } catch {}
        onLogin(user);
        return;
      } catch (err) {
        // Fallback pro MOCK quando auth real falhar (ex.: usuário não cadastrado no Auth ainda)
        const mockUser = (MOCK.SYSTEM_USERS || []).find(
          (u) => u.email.toLowerCase() === cleanEmail && u.password === password
        );
        if (mockUser) {
          // Loga via MOCK mas avisa que o usuário precisa ser provisionado no banco
          window.showToast(`Logado em modo MOCK · cadastre no Supabase Auth pra usar o DB`, { tone: "warn", ttl: 5000 });
          try {
            localStorage.setItem("stockkitchen.session.v1", JSON.stringify({
              ...mockUser, authSource: "mock", loggedAt: new Date().toISOString(),
            }));
          } catch {}
          onLogin({ ...mockUser, authSource: "mock" });
          return;
        }
        setError(err?.message || "Email ou senha inválidos");
        setLoading(false);
        return;
      }
    }

    // DB offline → modo MOCK puro
    setTimeout(() => {
      const user = (MOCK.SYSTEM_USERS || []).find(
        (u) => u.email.toLowerCase() === cleanEmail && u.password === password
      );
      if (!user) {
        setError("Email ou senha inválidos");
        setLoading(false);
        return;
      }
      try {
        localStorage.setItem("stockkitchen.session.v1", JSON.stringify({
          ...user, authSource: "mock", loggedAt: new Date().toISOString(),
        }));
      } catch {}
      onLogin({ ...user, authSource: "mock" });
    }, 280);
  };

  return (
    <div style={{
      minHeight: "100vh", display: "grid", placeItems: "center",
      background: "var(--bg-0)", padding: 20,
      fontFamily: "var(--sans)",
    }}>
      <div style={{
        width: 420, maxWidth: "100%",
        background: "var(--bg-1)", border: "1px solid var(--line)",
        borderRadius: 8, padding: "32px 28px",
        boxShadow: "0 24px 60px -12px rgba(0,0,0,0.5)",
      }}>
        {/* Logo / Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 6,
            background: "linear-gradient(135deg, var(--accent-bright), #1aa39e)",
            display: "grid", placeItems: "center", color: "#02100a",
          }}>
            <I.Logo size={18} />
          </div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.01em" }}>Cloud Kitchen</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
              gestão para dark kitchen
            </div>
          </div>
        </div>

        <h1 style={{
          fontSize: 22, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.02em",
          margin: "0 0 6px",
        }}>Entrar na conta</h1>
        <p style={{ fontSize: 12.5, color: "var(--fg-2)", marginBottom: 24 }}>
          Use seu email corporativo para acessar o painel.
        </p>

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <FormRow label="Email">
            <input
              className="input"
              type="email"
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu@email.com"
              disabled={loading}
            />
          </FormRow>
          <FormRow label="Senha">
            <div style={{ position: "relative" }}>
              <input
                className="input"
                type={showPwd ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                disabled={loading}
                style={{ width: "100%", paddingRight: 36 }}
              />
              <button
                type="button"
                onClick={() => setShowPwd(!showPwd)}
                style={{
                  position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                  background: "transparent", border: "none", cursor: "pointer",
                  padding: 6, color: "var(--fg-3)",
                }}
                title={showPwd ? "Ocultar senha" : "Mostrar senha"}>
                <I.Eye size={13} />
              </button>
            </div>
          </FormRow>

          {error && (
            <div style={{
              padding: "9px 12px",
              background: "var(--crit-soft)", border: "1px solid var(--crit-line)",
              borderRadius: 4, fontSize: 12, color: "var(--crit)",
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <I.AlertTriangle size={12} />
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn"
            data-variant="primary"
            disabled={loading || !email.trim() || !password}
            style={{ marginTop: 4, padding: "10px 14px", fontSize: 13, justifyContent: "center" }}>
            {loading ? "Entrando…" : "Entrar"}
          </button>

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
            <button type="button" onClick={() => notImplemented("Recuperação de senha")} style={{
              background: "transparent", border: "none", cursor: "pointer",
              fontSize: 11.5, color: "var(--accent-bright)",
            }}>
              Esqueci minha senha
            </button>
            <PendingFeature variant="inline" label="auth real"
              hint="Login mock — produção plugar Supabase Auth (signInWithPassword) + recuperação de senha + 2FA" />
          </div>
        </form>
      </div>

      <div style={{
        marginTop: 18, display: "flex", alignItems: "center", justifyContent: "center", gap: 12,
        fontFamily: "var(--mono)", fontSize: 10,
        color: "var(--fg-3)", letterSpacing: "0.06em",
      }}>
        Cloud Kitchen · v0.9 · ambiente de protótipo
        <DbStatusDot />
      </div>
    </div>
  );
}

// Bolinha de status do DB · usada no rodapé do login e na topbar
function DbStatusDot({ verbose }) {
  const { state } = useDbStatus ? useDbStatus() : { state: "checking" };
  const meta = {
    online:         { color: "var(--ok)",   label: "DB online" },
    checking:       { color: "var(--info)", label: "verificando" },
    tables_missing: { color: "var(--warn)", label: "DB sem schema" },
    error:          { color: "var(--crit)", label: "DB com erro" },
    offline:        { color: "var(--fg-3)", label: "DB offline · modo MOCK" },
  }[state] || { color: "var(--fg-3)", label: state };
  return (
    <span title={meta.label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 6, height: 6, borderRadius: 50, background: meta.color }} />
      {verbose && <span>{meta.label}</span>}
    </span>
  );
}

window.DbStatusDot = DbStatusDot;

// Helper · lê a sessão persistida (se houver)
function getStoredSession() {
  try {
    const raw = localStorage.getItem("stockkitchen.session.v1");
    if (!raw) return null;
    const data = JSON.parse(raw);
    // Sessão Supabase: usa direto os dados salvos no login.
    if (data.authSource === "supabase") return data;
    // Sessão Mock: re-encontra o user (caso senha tenha mudado, etc.)
    const user = (MOCK.SYSTEM_USERS || []).find((u) => u.email === data.email);
    return user || data; // fallback: usa os dados salvos
  } catch { return null; }
}

function clearStoredSession() {
  try { localStorage.removeItem("stockkitchen.session.v1"); } catch {}
}

window.LoginPage = LoginPage;
window.getStoredSession = getStoredSession;
window.clearStoredSession = clearStoredSession;
