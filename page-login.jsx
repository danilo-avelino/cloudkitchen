// LoginPage — autenticação local (mock).
// Em produção, substituir por Supabase Auth (signInWithPassword).
// =====================================================================

function LoginPage({ onLogin }) {
  const [view, setView] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("reset") === "1" ? "recover" : "login";
    } catch { return "login"; }
  });
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [showPwd, setShowPwd]   = useState(false);
  // Estados do fluxo de recuperação
  const [forgotSent, setForgotSent] = useState(false);
  const [newPwd, setNewPwd]   = useState("");
  const [newPwd2, setNewPwd2] = useState("");
  const [recoveryDone, setRecoveryDone] = useState(false);

  const goLogin = () => {
    setView("login");
    setError("");
    setForgotSent(false);
    setRecoveryDone(false);
    setNewPwd(""); setNewPwd2("");
    // Remove ?reset=1 da URL se voltarmos pro login
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("reset")) {
        url.searchParams.delete("reset");
        window.history.replaceState({}, "", url.toString());
      }
    } catch {}
  };

  const submitForgot = async (e) => {
    e?.preventDefault();
    setError("");
    if (!email.trim()) { setError("Informe o email cadastrado"); return; }
    if (!(typeof isDbOnline === "function" && isDbOnline())) {
      setError("Recuperação de senha exige DB online (não disponível em modo MOCK)");
      return;
    }
    setLoading(true);
    try {
      await dbResetPassword(email.trim().toLowerCase());
      setForgotSent(true);
    } catch (err) {
      setError(err?.message || "Falha ao enviar email de recuperação");
    } finally {
      setLoading(false);
    }
  };

  const submitRecover = async (e) => {
    e?.preventDefault();
    setError("");
    if (newPwd.length < 6) { setError("Senha precisa ter no mínimo 6 caracteres"); return; }
    if (newPwd !== newPwd2) { setError("As senhas não conferem"); return; }
    if (!(typeof isDbOnline === "function" && isDbOnline())) {
      setError("Sem conexão com o banco · tente novamente");
      return;
    }
    setLoading(true);
    try {
      await dbUpdatePassword(newPwd);
      // Encerra a sessão temporária criada pelo link de recuperação
      try { await dbSignOut(); } catch {}
      setRecoveryDone(true);
    } catch (err) {
      setError(err?.message || "Falha ao redefinir senha");
    } finally {
      setLoading(false);
    }
  };

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
        // Superadmin tem prioridade · profile.is_superadmin == true ignora role
        // do tenant_members (que pode estar vazio para um superadmin "puro" sem tenant).
        const isSuperadmin = ctx?.profile?.is_superadmin === true;
        const user = {
          email: cleanEmail,
          name:  ctx?.profile?.full_name || mockUser?.name || cleanEmail.split("@")[0],
          role:  isSuperadmin ? "superadmin" : (ctx?.member?.role || mockUser?.role || "viewer"),
          isSuperadmin,
          tenantId: ctx?.tenant?.id || mockUser?.tenantId || null,
          tenantName: ctx?.tenant?.name || mockUser?.tenantName || null,
          ops: ctx?.member?.ops || [],
          modules: Array.isArray(ctx?.member?.modules) ? ctx.member.modules : null,
          // Todos os tenants do usuário · alimenta o seletor "Trocar conta".
          tenants: Array.isArray(ctx?.tenants) ? ctx.tenants : [],
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
          <img src={import.meta.env.BASE_URL + "icon.png"} alt="Cloud Kitchen"
               style={{ width: 40, height: 40, objectFit: "contain", borderRadius: 8 }} />
          <div>
            <div style={{ fontSize: 17, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.01em" }}>Cloud Kitchen</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
              gestão para dark kitchen
            </div>
          </div>
        </div>

        {view === "login" && (<>
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

            <div style={{ marginTop: 6 }}>
              <button type="button" onClick={() => { setError(""); setView("forgot"); }} style={{
                background: "transparent", border: "none", cursor: "pointer",
                fontSize: 11.5, color: "var(--accent-bright)", padding: 0,
              }}>
                Esqueci minha senha
              </button>
            </div>
          </form>
        </>)}

        {view === "forgot" && (<>
          <h1 style={{
            fontSize: 22, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.02em",
            margin: "0 0 6px",
          }}>Recuperar senha</h1>
          <p style={{ fontSize: 12.5, color: "var(--fg-2)", marginBottom: 24 }}>
            Informe o email cadastrado · enviaremos um link para criar uma nova senha.
          </p>

          {forgotSent ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{
                padding: "12px 14px",
                background: "var(--ok-soft)", border: "1px solid var(--ok-line)",
                borderRadius: 4, fontSize: 12.5, color: "var(--ok)",
              }}>
                Se este email estiver cadastrado, você receberá um link em alguns segundos.
                Confira a caixa de entrada e o spam.
              </div>
              <button type="button" className="btn" onClick={goLogin}
                      style={{ padding: "10px 14px", fontSize: 13, justifyContent: "center" }}>
                Voltar para login
              </button>
            </div>
          ) : (
            <form onSubmit={submitForgot} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
                disabled={loading || !email.trim()}
                style={{ marginTop: 4, padding: "10px 14px", fontSize: 13, justifyContent: "center" }}>
                {loading ? "Enviando…" : "Enviar link"}
              </button>

              <button type="button" onClick={goLogin} style={{
                background: "transparent", border: "none", cursor: "pointer",
                fontSize: 11.5, color: "var(--accent-bright)", padding: 0, marginTop: 2,
              }}>
                ← Voltar para login
              </button>
            </form>
          )}
        </>)}

        {view === "recover" && (<>
          <h1 style={{
            fontSize: 22, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.02em",
            margin: "0 0 6px",
          }}>Definir nova senha</h1>
          <p style={{ fontSize: 12.5, color: "var(--fg-2)", marginBottom: 24 }}>
            Escolha uma nova senha · mínimo 6 caracteres.
          </p>

          {recoveryDone ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{
                padding: "12px 14px",
                background: "var(--ok-soft)", border: "1px solid var(--ok-line)",
                borderRadius: 4, fontSize: 12.5, color: "var(--ok)",
              }}>
                Senha redefinida com sucesso. Faça login com a nova senha.
              </div>
              <button type="button" className="btn" data-variant="primary" onClick={goLogin}
                      style={{ padding: "10px 14px", fontSize: 13, justifyContent: "center" }}>
                Ir para login
              </button>
            </div>
          ) : (
            <form onSubmit={submitRecover} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <FormRow label="Nova senha">
                <input
                  className="input"
                  type={showPwd ? "text" : "password"}
                  autoFocus
                  autoComplete="new-password"
                  value={newPwd}
                  onChange={(e) => setNewPwd(e.target.value)}
                  placeholder="••••••••"
                  disabled={loading}
                />
              </FormRow>
              <FormRow label="Confirmar nova senha">
                <input
                  className="input"
                  type={showPwd ? "text" : "password"}
                  autoComplete="new-password"
                  value={newPwd2}
                  onChange={(e) => setNewPwd2(e.target.value)}
                  placeholder="••••••••"
                  disabled={loading}
                />
              </FormRow>

              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--fg-2)", cursor: "pointer" }}>
                <input type="checkbox" checked={showPwd} onChange={(e) => setShowPwd(e.target.checked)} />
                Mostrar senha
              </label>

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
                disabled={loading || !newPwd || !newPwd2}
                style={{ marginTop: 4, padding: "10px 14px", fontSize: 13, justifyContent: "center" }}>
                {loading ? "Salvando…" : "Definir nova senha"}
              </button>

              <button type="button" onClick={goLogin} style={{
                background: "transparent", border: "none", cursor: "pointer",
                fontSize: 11.5, color: "var(--accent-bright)", padding: 0, marginTop: 2,
              }}>
                Cancelar
              </button>
            </form>
          )}
        </>)}
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
