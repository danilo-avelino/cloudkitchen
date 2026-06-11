// Settings — operations, users, billing
function Settings() {
  const [tab, setTab] = useState("operations");
  const sess = (typeof useSession === "function") ? useSession() : null;
  const headerParts = [
    sess?.tenantName || "Tenant local",
    sess?.tenantId ? `TEN-${sess.tenantId.slice(0, 4).toUpperCase()}` : null,
  ].filter(Boolean);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "20px 28px 0" }}>
        <div className="h-eyebrow" style={{ marginBottom: 6 }}>{headerParts.join(" · ")}</div>
        <h1 className="h-title">Configurações</h1>
        <div style={{ display: "flex", gap: 0, marginTop: 16, borderBottom: "1px solid var(--line)" }}>
          {[
            ["operations",   "Operações"],
            ["users",        "Usuários & permissões"],
            ["integrations", "Integrações"],
            ["billing",      "Plano & cobrança"],
          ].map(([id, label]) => {
            const active = tab === id;
            return (
              <button key={id} onClick={() => setTab(id)} style={{
                background: "transparent", border: "none",
                padding: "10px 14px",
                fontSize: 12.5, color: active ? "var(--fg-0)" : "var(--fg-2)",
                fontWeight: active ? 500 : 400, letterSpacing: "-0.005em",
                borderBottom: `2px solid ${active ? "var(--accent-bright)" : "transparent"}`,
                marginBottom: -1,
              }}>{label}</button>
            );
          })}
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "24px 28px 32px" }}>
        {tab === "operations"   && <OperationsTab />}
        {tab === "users"        && <UsersTab />}
        {tab === "integrations" && <IntegrationsTab />}
        {tab === "billing"      && <BillingTab />}
      </div>
    </div>
  );
}

function OperationsTab() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [ops, setOps]         = useState(MOCK.OPERATIONS.filter((o) => o.id !== "all"));
  const [editing, setEditing] = useState(null);
  const [source, setSource]   = useState("mock"); // "db" | "mock"
  const [tenantId, setTenantId] = useState(null);
  const [tabLoading, setTabLoading] = useState(true);

  // Resolve o tenantId do usuário autenticado (uma vez)
  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setTabLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const ctx = await dbGetCurrentContext();
        if (cancelled) return;
        const tid = ctx?.tenant?.id || null;
        setTenantId(tid);
        if (!tid) return; // usuário sem tenant_member · fica no mock
        const { data, source: src, error } = await dbListOperations(tid);
        if (cancelled) return;
        if (src === "db") {
          // Adapta shape do banco para shape do mock; aceita lista vazia
          const mapped = (data || []).map((row) => ({
            id: row.id, slug: row.slug, name: row.name,
            short: row.short_label, color: row.color,
            iFood: row.ifood_handle,
          }));
          setOps(mapped);
          setSource("db");
        } else if (error) {
          console.warn("dbListOperations falhou", error);
        }
      } finally {
        if (!cancelled) setTabLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  const save = async (op) => {
    if (editing?.initial) {
      // Update otimista
      const prev = ops;
      const next = ops.map((o) => o.id === editing.initial.id ? { ...o, ...op } : o);
      setOps(next);
      if (source === "db" && dbStatus.isOnline) {
        const { error } = await dbUpdateOperation(editing.initial.id, op);
        if (error) {
          setOps(prev);
          window.showToast(`Erro ao salvar: ${error.message}`, { tone: "crit", ttl: 4500 });
        } else {
          window.showToast(`Operação ${op.name} salva no Supabase`, { tone: "ok" });
        }
      } else {
        window.showToast(`Operação ${op.name} atualizada (mock)`, { tone: "warn" });
      }
    } else {
      // Insert · tenta DB se online e tenantId resolvido (independente de source)
      if (dbStatus.isOnline && tenantId) {
        const slug = (op.short || op.name || "op").toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const { data, error } = await dbInsertOperation(tenantId, {
          slug, name: op.name, short: op.short, color: op.color, iFood: op.iFood,
          sort_order: ops.length + 1,
        });
        if (error) {
          window.showToast(`Erro ao criar: ${error.message}`, { tone: "crit", ttl: 4500 });
        } else if (data) {
          setOps([...ops, {
            id: data.id, slug: data.slug, name: data.name,
            short: data.short_label, color: data.color, iFood: data.ifood_handle,
          }]);
          setSource("db");
          window.showToast(`Operação ${op.name} criada no Supabase`, { tone: "ok" });
        }
      } else {
        const id = (op.short || op.name || "op").toLowerCase().replace(/[^a-z0-9]+/g, "-");
        setOps([...ops, { ...op, id }]);
        window.showToast(`Operação ${op.name} criada (mock · DB offline ou sem tenant)`, { tone: "warn" });
      }
    }
    setEditing(null);
  };

  const remove = async (op) => {
    const prev = ops;
    setOps(ops.filter((o) => o.id !== op.id));
    if (source === "db" && dbStatus.isOnline) {
      const { error } = await dbDeleteOperation(op.id);
      if (error) {
        setOps(prev);
        window.showToast(`Erro ao excluir: ${error.message}`, { tone: "crit", ttl: 4500 });
      } else {
        window.showToast(`Operação ${op.name} desativada no Supabase`, { tone: "warn", ttl: 4500 });
      }
    } else {
      window.showToast(`Operação ${op.name} excluída (mock)`, { tone: "warn", ttl: 4500 });
    }
    setEditing(null);
  };

  if (tabLoading) return <PageLoading label="Carregando operações…" variant="table" hint="" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12 }}>
        <p style={{ margin: 0, color: "var(--fg-2)", fontSize: 13, maxWidth: 600 }}>
          Cada operação é uma marca virtual independente que compartilha o mesmo estoque físico.
          Pausar uma operação não exclui histórico — apenas oculta da consolidação.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="btn" data-variant="primary" data-size="sm" onClick={() => setEditing({ initial: null })}>
            <I.Plus size={13} />Nova operação
          </button>
        </div>
      </div>
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Operação</th>
              <th>iFood</th>
              <th>Meta CMV</th>
              <th className="num">Faturamento 7d</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ops.map((o) => (
              <tr key={o.id}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 50, background: o.color }} />
                    <div>
                      <div style={{ color: "var(--fg-0)", fontWeight: 500 }}>{o.name}</div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>OPER-{o.short}</div>
                    </div>
                  </div>
                </td>
                <td className="dim" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{o.iFood || "—"}</td>
                <td className="num">{o.cmvGoal != null ? `${Number(o.cmvGoal).toFixed(1)}%` : "—"}</td>
                <td className="num">—</td>
                <td><span className="badge" data-tone="ok">Ativa</span></td>
                <td><button className="btn" data-variant="ghost" data-size="sm" onClick={() => setEditing({ initial: o })}>Editar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <OperationModal
          initial={editing.initial}
          tenantId={tenantId}
          dbOnline={source === "db" && dbStatus.isOnline}
          onClose={() => setEditing(null)}
          onSave={save}
          onDelete={editing.initial ? () => remove(editing.initial) : null}
        />
      )}
    </div>
  );
}

function OperationModal({ initial, tenantId, dbOnline, onClose, onSave, onDelete }) {
  const [name, setName]   = useState(initial?.name || "");
  const [short, setShort] = useState(initial?.short || "");
  const [color, setColor] = useState(initial?.color || "#2d8c66");
  const [iFood, setIFood] = useState(initial?.iFood || "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Guard contra duplo clique — onSave é async (insere/atualiza operação no banco).
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // Turnos (apenas ao editar uma operação existente — precisa do id pra linkar)
  const [shifts, setShifts] = useState([]);
  const [shiftsLoading, setShiftsLoading] = useState(false);
  const [newShiftName, setNewShiftName] = useState("");
  const canManageShifts = !!initial?.id && dbOnline && tenantId;

  useEffect(() => {
    if (!canManageShifts) { setShifts([]); return; }
    let cancelled = false;
    setShiftsLoading(true);
    (async () => {
      const { data } = await dbListOperationShifts(tenantId, initial.id);
      if (cancelled) return;
      setShifts(data || []);
      setShiftsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [canManageShifts, tenantId, initial?.id]);

  const addShift = async () => {
    const trimmed = newShiftName.trim();
    if (!trimmed || !canManageShifts) return;
    const { data, error } = await dbInsertOperationShift(tenantId, {
      operationId: initial.id,
      name:        trimmed,
      sortOrder:   shifts.length,
    });
    if (error) {
      window.showToast(`Erro ao criar turno: ${error.message}`, { tone: "crit", ttl: 4500 });
      return;
    }
    setShifts([...shifts, data]);
    setNewShiftName("");
    window.showToast(`Turno "${trimmed}" criado`, { tone: "ok" });
  };

  const removeShift = async (shift) => {
    if (!canManageShifts) return;
    const { error, softDeleted } = await dbDeleteOperationShift(shift.id);
    if (error) {
      window.showToast(`Erro ao excluir turno: ${error.message}`, { tone: "crit", ttl: 4500 });
      return;
    }
    setShifts(shifts.filter((s) => s.id !== shift.id));
    window.showToast(
      softDeleted ? `Turno "${shift.name}" desativado (tem faturamentos linkados)` : `Turno "${shift.name}" excluído`,
      { tone: "warn" },
    );
  };

  const valid = name.trim() && short.trim();
  const save = async () => {
    if (savingRef.current || !valid) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave({ name: name.trim(), short: short.trim().toUpperCase(), color, iFood: iFood.trim() || null });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <Modal title={initial ? "Editar operação" : "Nova operação"} onClose={onClose}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", gap: 8 }}>
          <div>
            {initial && onDelete && (
              <button className="btn" data-size="sm" onClick={() => setConfirmingDelete(true)}
                      style={{ color: "var(--crit)", borderColor: "var(--crit-line)" }}>
                <I.Trash size={11} />Excluir operação
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
            <button className="btn" data-variant="primary" data-size="sm" disabled={!valid || saving}
                    onClick={save}>
              {saving ? "Salvando…" : initial ? "Salvar alterações" : "Criar operação"}
            </button>
          </div>
        </div>
      }>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 12 }}>
        <FormRow label="Nome da marca">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Forno & Brasa" />
        </FormRow>
        <FormRow label="Sigla curta">
          <input className="input mono" maxLength={6} value={short} onChange={(e) => setShort(e.target.value)} placeholder="BURG" style={{ textTransform: "uppercase" }} />
        </FormRow>
        <FormRow label="Cor">
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: "100%", height: 36, padding: 2, background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4 }} />
        </FormRow>
        <FormRow label="Handle iFood" hint="opcional">
          <input className="input mono" value={iFood} onChange={(e) => setIFood(e.target.value)} placeholder="@minhamarca" />
        </FormRow>
      </div>

      {/* Turnos — apenas pra operações já salvas */}
      {initial?.id && (
        <div style={{ marginTop: 20, borderTop: "1px solid var(--line-soft)", paddingTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500, letterSpacing: "-0.005em" }}>Turnos</div>
              <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 2 }}>
                Permite múltiplos faturamentos no mesmo dia (ex.: Almoço, Jantar, Madrugada).
              </div>
            </div>
          </div>

          {!dbOnline && (
            <div style={{ fontSize: 12, color: "var(--warn)", padding: "8px 12px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 4 }}>
              Turnos só podem ser gerenciados com Supabase online.
            </div>
          )}

          {dbOnline && (
            <>
              {shiftsLoading ? (
                <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Carregando turnos…</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                  {shifts.length === 0 && (
                    <div style={{ fontSize: 12, color: "var(--fg-3)", padding: "6px 0" }}>
                      Nenhum turno cadastrado ainda. Adicione abaixo.
                    </div>
                  )}
                  {shifts.map((s) => (
                    <div key={s.id} style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "6px 10px", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4,
                    }}>
                      <span style={{ flex: 1, fontSize: 12.5, color: "var(--fg-1)" }}>{s.name}</span>
                      <button className="btn" data-variant="ghost" data-size="sm"
                              onClick={() => removeShift(s)}
                              title="Excluir turno"
                              style={{ padding: "3px 6px", color: "var(--crit)" }}>
                        <I.Trash size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="input"
                  placeholder="Ex.: Almoço, Jantar, Madrugada…"
                  value={newShiftName}
                  onChange={(e) => setNewShiftName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addShift(); } }}
                  style={{ flex: 1 }}
                />
                <button className="btn" data-variant="primary" data-size="sm"
                        onClick={addShift} disabled={!newShiftName.trim()}>
                  <I.Plus size={11} />Criar turno
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {confirmingDelete && (
        <OperationDeleteConfirm
          name={initial.name}
          short={initial.short}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => { setConfirmingDelete(false); onDelete && onDelete(); }}
        />
      )}
    </Modal>
  );
}

// Modal de confirmação de exclusão de operação · alerta forte (perda de dados)
function OperationDeleteConfirm({ name, short, onCancel, onConfirm }) {
  const [typed, setTyped] = useState("");
  const matchesName = typed.trim().toLowerCase() === (name || "").trim().toLowerCase();
  return (
    <Modal title="Excluir operação?" subtitle={`${name} · ${short}`} onClose={onCancel} width={460}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, width: "100%" }}>
          <button className="btn" data-size="sm" onClick={onCancel}>Cancelar</button>
          <button className="btn" data-size="sm" disabled={!matchesName} onClick={onConfirm}
                  style={{
                    background: matchesName ? "var(--crit)" : "var(--bg-3)",
                    borderColor: matchesName ? "var(--crit)" : "var(--line)",
                    color: matchesName ? "#fff" : "var(--fg-3)",
                  }}>
            <I.Trash size={11} />Excluir definitivamente
          </button>
        </div>
      }>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{
          padding: "12px 14px", borderRadius: 4,
          background: "var(--crit-soft)", border: "1px solid var(--crit)",
          display: "flex", alignItems: "flex-start", gap: 10,
        }}>
          <I.AlertTriangle size={14} style={{ color: "var(--crit)", marginTop: 1, flexShrink: 0 }} />
          <div style={{ fontSize: 12.5, color: "var(--fg-1)", lineHeight: 1.5 }}>
            Esta ação é <strong style={{ color: "var(--crit)" }}>irreversível</strong>. Todos os dados
            vinculados a <strong style={{ color: "var(--fg-0)" }}>{name}</strong> serão perdidos:
            faturamento, requisições, fichas técnicas, alocações de estoque e histórico financeiro.
          </div>
        </div>
        <FormRow label={`Digite "${name}" para confirmar`}>
          <input className="input" autoFocus value={typed}
                 onChange={(e) => setTyped(e.target.value)}
                 placeholder={name}
                 onKeyDown={(e) => { if (e.key === "Enter" && matchesName) onConfirm(); }} />
        </FormRow>
      </div>
    </Modal>
  );
}

const ROLE_TO_DB = {
  "Super Admin": "owner", "Gestor de marca": "manager",
  "Operador cozinha": "kitchen", "Estoquista": "stock",
  "Contador": "accountant", "Visualização": "viewer"
};

function UsersTab() {
  const dbStatus = useDbStatus?.() || { isOnline: false, state: "offline" };
  const [users, setUsers] = useState([]);
  const [editing, setEditing] = useState(null);
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState("loading");
  const [loadError, setLoadError] = useState(null);
  const [tabLoading, setTabLoading] = useState(true);

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setSource("offline"); setTabLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const ctx = await dbGetCurrentContext?.();
        const tid = ctx?.tenant?.id;
        if (cancelled) return;
        if (!tid) { setSource("offline"); return; }
        setTenantId(tid);
        const res = await dbListMembers?.(tid);
        if (cancelled) return;
        if (res?.error) {
          setLoadError(res.error.message || String(res.error));
          setSource("offline");
        } else if (res?.data) {
          setUsers(res.data);
          setSource("db");
        } else {
          setSource("offline");
        }
      } finally {
        if (!cancelled) setTabLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  const formatOps = (ops) => {
    if (!ops) return "—";
    if (Array.isArray(ops)) {
      if (ops.length === 0) return "todas";
      return ops.join(", ");
    }
    return String(ops);
  };
  const formatLast = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1)    return "agora";
    if (diffMin < 60)   return `há ${diffMin} min`;
    if (diffMin < 1440) return `há ${Math.floor(diffMin / 60)}h`;
    return d.toLocaleDateString("pt-BR");
  };

  const save = async (u) => {
    if (editing?.userId) {
      // Edit existing member · update atômico via edge function `update-member`
      if (dbStatus.isOnline && tenantId) {
        const patch = {
          name: u.name,
          role: ROLE_TO_DB[u.role],
          ops: u.ops ? [u.ops] : [],
          modules: Array.isArray(u.modules) ? u.modules : null,
        };
        // Só envia password quando o toggle "Trocar senha" está ligado no modal —
        // o UserModal só inclui u.password no payload nesse caso.
        if (typeof u.password === "string" && u.password.length >= 6) {
          patch.password = u.password;
        }
        const { error } = await dbUpdateMember?.(tenantId, editing.userId, patch);
        if (error) {
          window.showToast(`Erro ao atualizar: ${error.message}`, { tone: "crit", ttl: 4500 });
          return;
        }
        const res = await dbListMembers?.(tenantId);
        if (res?.data) setUsers(res.data);
        window.showToast(`${u.name} atualizado`, { tone: "ok" });
      } else {
        setUsers(users.map((x) => x.email === editing.email ? { ...x, ...u } : x));
        window.showToast(`${u.name} atualizado`, { tone: "ok" });
      }
    } else {
      // Create member with password (no email confirmation)
      if (dbStatus.isOnline && tenantId) {
        const { error } = await dbInviteMember?.(tenantId, {
          email: u.email,
          password: u.password,
          name: u.name,
          role: ROLE_TO_DB[u.role],
          ops: u.ops ? [u.ops] : [],
          modules: Array.isArray(u.modules) ? u.modules : null,
        });
        if (error) {
          window.showToast(`Erro ao criar usuário: ${error.message}`, { tone: "crit" });
          return;
        }
        // Reload members
        const res = await dbListMembers?.(tenantId);
        if (res?.data) setUsers(res.data);
        window.showToast(`${u.name || u.email} criado com acesso ativo`, { tone: "ok" });
      } else {
        setUsers([...users, { ...u, last: "criado agora", userId: null }]);
        window.showToast(`${u.name || u.email} criado com acesso ativo`, { tone: "ok" });
      }
    }
    setEditing(null);
  };

  if (tabLoading) return <PageLoading label="Carregando usuários…" variant="table" hint="" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <p style={{ margin: 0, color: "var(--fg-2)", fontSize: 13 }}>{users.length} usuários ativos</p>
        </div>
        <button className="btn" data-variant="primary" data-size="sm" onClick={() => setEditing({})}>
          <I.Plus size={13} />Convidar usuário
        </button>
      </div>
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Usuário</th>
              <th>Função</th>
              <th>Operações</th>
              <th>Último acesso</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr><td colSpan={5} className="dim" style={{ textAlign: "center", padding: 24 }}>
                {source === "loading" ? "Carregando…" : (source === "offline" ? (loadError || "DB offline") : "Nenhum usuário")}
              </td></tr>
            ) : users.map((u) => (
              <tr key={u.email || u.userId}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 24, height: 24, borderRadius: 3, background: "var(--bg-3)", color: "var(--fg-1)", fontSize: 10, fontWeight: 500, display: "grid", placeItems: "center", letterSpacing: "0.02em" }}>
                      {(u.name || u.email || "?").split(" ").map((n) => n[0]).slice(0, 2).join("")}
                    </div>
                    <div>
                      <div style={{ color: "var(--fg-0)", fontWeight: 500 }}>{u.name || u.email}</div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)" }}>{u.email}</div>
                    </div>
                  </div>
                </td>
                <td className="dim">{u.role}</td>
                <td className="dim">{formatOps(u.ops)}</td>
                <td className="dim mono" style={{ fontSize: 11 }}>{formatLast(u.joinedAt || u.last)}</td>
                <td><button className="btn" data-variant="ghost" data-size="sm" onClick={() => setEditing(u)}>Editar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <UserModal initial={editing.email ? editing : null} onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

// Catálogo de módulos do app (espelha a sidebar em shell.jsx).
// Mantenha sincronizado quando adicionar/remover módulos da navegação.
const USER_MODULES = [
  { id: "dashboard", label: "Dashboard"        },
  { id: "stock",     label: "Estoque"          },
  { id: "recipes",   label: "Fichas técnicas"  },
  { id: "revenue",   label: "Faturamento"      },
  { id: "requests",  label: "Requisições"      },
  { id: "purchases", label: "Compras"          },
  { id: "cmv",       label: "CMV & margem"     },
  { id: "finance",   label: "Financeiro"       },
  { id: "dre",       label: "DRE & Fechamento" },
  { id: "settings",  label: "Configurações"    },
];
const ALL_MODULE_IDS = USER_MODULES.map((m) => m.id);

// Sugestão padrão de módulos por papel — usuário pode customizar livremente depois.
const ROLE_MODULE_PRESETS = {
  "Super Admin":      ALL_MODULE_IDS,
  "Gestor de marca":  ALL_MODULE_IDS.filter((m) => m !== "settings"),
  "Operador cozinha": ["dashboard", "stock", "requests", "recipes"],
  "Estoquista":       ["dashboard", "stock", "requests", "purchases"],
  "Contador":         ["dashboard", "revenue", "cmv", "finance", "dre"],
  "Visualização":     ["dashboard"],
};

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  const arr = new Uint32Array(12);
  (window.crypto || window.msCrypto).getRandomValues(arr);
  for (let i = 0; i < arr.length; i++) out += chars[arr[i] % chars.length];
  return out;
}

function UserModal({ initial, onClose, onSave }) {
  const [name, setName]     = useState(initial?.name || "");
  const [email, setEmail]   = useState(initial?.email || "");
  const [password, setPassword] = useState(initial ? "" : generatePassword());
  const [showPwd, setShowPwd]   = useState(true);
  // Em modo edição: toggle "Trocar senha" — quando ligado, gera nova senha
  const [changePwd, setChangePwd] = useState(false);
  const [role, setRole]   = useState(initial?.role || "Operador cozinha");
  const [ops, setOps]     = useState(initial?.ops || "todas");
  const [saving, setSaving] = useState(false);
  const [modules, setModules] = useState(
    initial?.modules || ROLE_MODULE_PRESETS[initial?.role || "Operador cozinha"] || ["dashboard"]
  );
  // Senha é obrigatória ao criar; ao editar só importa se "Trocar senha" estiver ligado
  const pwdProvided = typeof password === "string" && password.length >= 6;
  const pwdOk = initial ? (!changePwd || pwdProvided) : pwdProvided;
  const valid = name.trim() && /\S+@\S+\.\S+/.test(email) && modules.length > 0 && pwdOk;

  const copyPwd = async () => {
    try {
      await navigator.clipboard.writeText(password);
      window.showToast?.("Senha copiada", { tone: "ok", ttl: 1800 });
    } catch (_) { /* noop */ }
  };

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const payload = { name: name.trim(), email: email.trim(), role, ops, modules };
      if (!initial) payload.password = password;
      else if (changePwd && pwdProvided) payload.password = password;
      await onSave(payload);
    } finally {
      setSaving(false);
    }
  };

  const toggleChangePwd = (on) => {
    setChangePwd(on);
    if (on && !password) setPassword(generatePassword());
    if (!on) setPassword("");
  };

  // Trocar de papel substitui os módulos pelo preset; o usuário pode ajustar depois.
  const onRoleChange = (next) => {
    setRole(next);
    setModules(ROLE_MODULE_PRESETS[next] || ["dashboard"]);
  };

  const toggleModule = (id) => {
    setModules((cur) => cur.includes(id) ? cur.filter((m) => m !== id) : [...cur, id]);
  };
  const selectAll  = () => setModules(ALL_MODULE_IDS);
  const selectNone = () => setModules([]);
  const applyPreset = () => setModules(ROLE_MODULE_PRESETS[role] || []);

  return (
    <Modal title={initial ? "Editar usuário" : "Criar usuário"}
      subtitle={initial ? null : "O usuário poderá entrar imediatamente com o e-mail e a senha definidos aqui."}
      onClose={saving ? undefined : onClose}
      width={560}
      footer={<>
        <button className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
        <button className="btn" data-variant="primary" data-size="sm" disabled={!valid || saving}
                onClick={submit}>
          {saving ? (initial ? "Salvando…" : "Criando…") : (initial ? "Salvar" : "Criar usuário")}
        </button>
      </>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <FormRow label="Nome">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </FormRow>
        <FormRow label="E-mail">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!!initial} />
        </FormRow>

        {!initial && (
          <div style={{ gridColumn: "1 / -1" }}>
            <FormRow label="Senha inicial" hint="Mínimo 6 caracteres. Compartilhe com o usuário — ele pode trocar depois.">
              <div style={{ display: "flex", gap: 6 }}>
                <input className="input mono" type={showPwd ? "text" : "password"}
                       value={password} onChange={(e) => setPassword(e.target.value)}
                       style={{ flex: 1 }} />
                <button type="button" className="btn" data-size="sm" data-variant="ghost"
                        onClick={() => setShowPwd((v) => !v)} title={showPwd ? "Ocultar" : "Mostrar"}>
                  {showPwd ? "Ocultar" : "Mostrar"}
                </button>
                <button type="button" className="btn" data-size="sm" data-variant="ghost"
                        onClick={() => setPassword(generatePassword())} title="Gerar nova senha">
                  ↻ Gerar
                </button>
                <button type="button" className="btn" data-size="sm" data-variant="ghost"
                        onClick={copyPwd} title="Copiar senha">
                  Copiar
                </button>
              </div>
            </FormRow>
          </div>
        )}

        {initial && (
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 12px",
              background: changePwd ? "var(--warn-soft)" : "var(--bg-2)",
              border: `1px solid ${changePwd ? "var(--warn-line)" : "var(--line)"}`,
              borderRadius: 6, cursor: "pointer",
            }}>
              <input type="checkbox" checked={changePwd} onChange={(e) => toggleChangePwd(e.target.checked)} />
              <div style={{ flex: 1, fontSize: 12 }}>
                <strong style={{ color: "var(--fg-0)" }}>Trocar senha</strong>
                <div style={{ color: "var(--fg-3)", fontSize: 10.5, marginTop: 2 }}>
                  Define uma nova senha de acesso para o usuário. A senha atual será invalidada.
                </div>
              </div>
            </label>
            {changePwd && (
              <div style={{ marginTop: 10 }}>
                <FormRow label="Nova senha" hint={pwdProvided ? "Compartilhe com o usuário." : "Mínimo 6 caracteres."}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input className="input mono" type={showPwd ? "text" : "password"}
                           value={password} onChange={(e) => setPassword(e.target.value)}
                           style={{ flex: 1, ...(pwdProvided ? null : { borderColor: "var(--crit)" }) }} />
                    <button type="button" className="btn" data-size="sm" data-variant="ghost"
                            onClick={() => setShowPwd((v) => !v)}>
                      {showPwd ? "Ocultar" : "Mostrar"}
                    </button>
                    <button type="button" className="btn" data-size="sm" data-variant="ghost"
                            onClick={() => setPassword(generatePassword())}>
                      ↻ Gerar
                    </button>
                    <button type="button" className="btn" data-size="sm" data-variant="ghost"
                            onClick={copyPwd}>
                      Copiar
                    </button>
                  </div>
                </FormRow>
              </div>
            )}
          </div>
        )}

        <FormRow label="Função">
          <select className="select" value={role} onChange={(e) => onRoleChange(e.target.value)}>
            <option>Super Admin</option>
            <option>Gestor de marca</option>
            <option>Operador cozinha</option>
            <option>Estoquista</option>
            <option>Contador</option>
            <option>Visualização</option>
          </select>
        </FormRow>
        <FormRow label="Operações">
          <select className="select" value={ops} onChange={(e) => setOps(e.target.value)}>
            <option value="todas">Todas as operações</option>
            {MOCK.OPERATIONS.filter((o) => o.id !== "all").map((o) => (
              <option key={o.id} value={o.name}>{o.name}</option>
            ))}
          </select>
        </FormRow>

        {/* Módulos de acesso · ocupa as duas colunas */}
        <div style={{ gridColumn: "1 / -1", marginTop: 4 }}>
          <div style={{
            display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8,
          }}>
            <span style={{
              fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)",
              letterSpacing: "0.08em", textTransform: "uppercase",
            }}>Módulos de acesso</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>
              {modules.length}/{ALL_MODULE_IDS.length}
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn" data-variant="ghost" data-size="sm"
                    onClick={applyPreset} title={`Aplicar preset de "${role}"`}>
              Preset · {role}
            </button>
            <button type="button" className="btn" data-variant="ghost" data-size="sm"
                    onClick={selectAll}>Todos</button>
            <button type="button" className="btn" data-variant="ghost" data-size="sm"
                    onClick={selectNone}>Nenhum</button>
          </div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 6,
          }}>
            {USER_MODULES.map((m) => {
              const on = modules.includes(m.id);
              return (
                <button
                  key={m.id} type="button"
                  onClick={() => toggleModule(m.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "8px 10px", borderRadius: 4, cursor: "pointer",
                    background:   on ? "var(--accent-soft)" : "var(--bg-2)",
                    border: `1px solid ${on ? "var(--accent-line)" : "var(--line)"}`,
                    color: on ? "var(--fg-0)" : "var(--fg-2)",
                    fontSize: 12, textAlign: "left",
                    transition: "all 120ms ease",
                  }}>
                  <span style={{
                    width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                    background: on ? "var(--accent-bright)" : "transparent",
                    border: `1px solid ${on ? "var(--accent-bright)" : "var(--line-strong)"}`,
                    display: "grid", placeItems: "center",
                  }}>
                    {on && <I.Check size={10} style={{ color: "var(--accent-fg)" }} />}
                  </span>
                  {m.label}
                </button>
              );
            })}
          </div>
          {modules.length === 0 && (
            <div style={{
              marginTop: 8, padding: "8px 10px",
              background: "var(--warn-soft)", border: "1px solid var(--warn-line)",
              borderRadius: 4, fontSize: 11.5, color: "var(--warn)",
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <I.AlertTriangle size={12} />
              <span>Selecione ao menos 1 módulo — usuário sem acesso não consegue entrar.</span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function BillingTab() {
  return (
    <div style={{ maxWidth: 720 }}>
      <div className="card">
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
            <div style={{ flex: 1 }}>
              <div className="h-eyebrow" style={{ marginBottom: 4 }}>Plano atual</div>
              <h3 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: "var(--fg-0)", letterSpacing: "-0.018em" }}>Pro · 4 operações</h3>
              <div style={{ color: "var(--fg-2)", fontSize: 12.5, marginTop: 4 }}>Próxima cobrança · 28/05/2026</div>
            </div>
            <span className="mono" style={{ fontSize: 26, color: "var(--fg-0)", fontWeight: 500, letterSpacing: "-0.02em" }}>R$ 489/mês</span>
          </div>
          <div className="hr" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
            <SummaryStat label="SKUs" value={`${(MOCK.STOCK_ITEMS || []).length} / 250`} />
            <SummaryStat label="Operações" value={`${(MOCK.OPERATIONS || []).filter((o) => o.id !== "all").length} / 6`} />
            <SummaryStat label="Usuários" value="— / 10" />
          </div>
          <div className="hr" />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 12.5, color: "var(--fg-2)" }}>Próximo plano: <span style={{ color: "var(--fg-0)" }}>Scale</span> · 10 operações · R$ 989/mês</div>
            <button className="btn" data-size="sm" onClick={() => notImplemented("Upgrade de plano")}>Ver upgrade</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Catálogo de integrações disponíveis. Por enquanto é só front: vincular uma
// integração apenas registra o link na operação — a conexão/sincronização real
// virá com o backend (por isso o badge "Em breve" na aba).
const INTEGRATION_CATALOG = [
  { id: "ifood",    label: "iFood",    category: "Delivery",    color: "#ea1d2c", accountLabel: "Handle / loja", placeholder: "@minhamarca" },
  { id: "rappi",    label: "Rappi",    category: "Delivery",    color: "#ff5a1f", accountLabel: "ID da loja",    placeholder: "store_123" },
  { id: "food99",   label: "99Food",   category: "Delivery",    color: "#ffca00", accountLabel: "ID da loja",    placeholder: "loja_123" },
  { id: "whatsapp", label: "WhatsApp", category: "Pedidos",     color: "#25d366", accountLabel: "Número",        placeholder: "+55 11 90000-0000" },
  { id: "stone",    label: "Stone",    category: "Pagamentos",  color: "#00a868", accountLabel: "Stone code",    placeholder: "Código do ponto" },
  { id: "anotaai",  label: "Anota AI", category: "Cardápio",    color: "#7c3aed", accountLabel: "Subdomínio",    placeholder: "minhaloja" },
];
const integrationById = (id) => INTEGRATION_CATALOG.find((c) => c.id === id);

function IntegrationsTab() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [ops, setOps]       = useState(MOCK.OPERATIONS.filter((o) => o.id !== "all"));
  const [links, setLinks]   = useState({}); // { [opId]: [{ id, account }] }
  const [adding, setAdding] = useState(null); // operação em configuração
  const [tabLoading, setTabLoading] = useState(true);

  // Mesma fonte da aba Operações: usa as operações reais do tenant quando online.
  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setTabLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const ctx = await dbGetCurrentContext();
        if (cancelled) return;
        const tid = ctx?.tenant?.id || null;
        if (!tid) return;
        const { data, source: src } = await dbListOperations(tid);
        if (cancelled) return;
        if (src === "db") {
          setOps((data || []).map((row) => ({
            id: row.id, slug: row.slug, name: row.name,
            short: row.short_label, color: row.color, iFood: row.ifood_handle,
          })));
        }
      } finally {
        if (!cancelled) setTabLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  const addLink = (opId, link) => {
    setLinks((cur) => ({ ...cur, [opId]: [...(cur[opId] || []), link] }));
    const cat = integrationById(link.id);
    window.showToast?.(`${cat?.label || "Integração"} vinculada · em breve`, { tone: "ok" });
  };
  const removeLink = (opId, catalogId) => {
    setLinks((cur) => ({ ...cur, [opId]: (cur[opId] || []).filter((l) => l.id !== catalogId) }));
  };

  if (tabLoading) return <PageLoading label="Carregando integrações…" variant="table" hint="" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <p style={{ margin: 0, color: "var(--fg-2)", fontSize: 13, maxWidth: 620 }}>
          Conecte plataformas externas — delivery, pagamentos e pedidos — a cada operação.
          Cada integração fica vinculada a uma marca específica.
        </p>
        <span className="badge" data-tone="warn">Em breve</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {ops.map((o) => {
          const opLinks = links[o.id] || [];
          return (
            <div key={o.id} className="card">
              <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 50, background: o.color }} />
                    <div>
                      <div style={{ color: "var(--fg-0)", fontWeight: 500 }}>{o.name}</div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>OPER-{o.short}</div>
                    </div>
                  </div>
                  <button className="btn" data-variant="primary" data-size="sm" onClick={() => setAdding(o)}>
                    <I.Plus size={13} />Adicionar integração
                  </button>
                </div>

                {opLinks.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: "var(--fg-3)", padding: "4px 0" }}>
                    Nenhuma integração vinculada ainda.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {opLinks.map((l) => {
                      const cat = integrationById(l.id);
                      if (!cat) return null;
                      return (
                        <div key={l.id} style={{
                          display: "flex", alignItems: "center", gap: 10,
                          padding: "8px 10px", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4,
                        }}>
                          <span style={{
                            width: 26, height: 26, borderRadius: 6, flexShrink: 0,
                            background: cat.color, color: "#fff", fontSize: 12, fontWeight: 600,
                            display: "grid", placeItems: "center",
                          }}>{cat.label[0]}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12.5, color: "var(--fg-1)", fontWeight: 500 }}>
                              {cat.label} <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>· {cat.category}</span>
                            </div>
                            {l.account && (
                              <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", marginTop: 1 }}>{l.account}</div>
                            )}
                          </div>
                          <span className="badge" data-tone="warn">Em breve</span>
                          <button className="btn" data-variant="ghost" data-size="sm"
                                  onClick={() => removeLink(o.id, l.id)}
                                  title="Remover integração"
                                  style={{ padding: "3px 6px", color: "var(--crit)" }}>
                            <I.Trash size={11} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {adding && (
        <IntegrationModal
          operation={adding}
          existing={(links[adding.id] || []).map((l) => l.id)}
          onClose={() => setAdding(null)}
          onAdd={(link) => { addLink(adding.id, link); setAdding(null); }}
        />
      )}
    </div>
  );
}

function IntegrationModal({ operation, existing, onClose, onAdd }) {
  const [selected, setSelected] = useState(null);
  const [account, setAccount]   = useState("");
  const cat = selected ? integrationById(selected) : null;

  const pick = (id) => {
    setSelected(id);
    setAccount("");
  };

  return (
    <Modal title="Adicionar integração" subtitle={`${operation.name} · OPER-${operation.short}`} onClose={onClose} width={520}
      footer={<>
        <button className="btn" data-size="sm" onClick={onClose}>Cancelar</button>
        <button className="btn" data-variant="primary" data-size="sm" disabled={!selected}
                onClick={() => onAdd({ id: selected, account: account.trim() || null })}>
          Vincular à operação
        </button>
      </>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Plataforma
          </span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginTop: 8 }}>
            {INTEGRATION_CATALOG.map((c) => {
              const linked = existing.includes(c.id);
              const on = selected === c.id;
              return (
                <button
                  key={c.id} type="button"
                  disabled={linked}
                  onClick={() => pick(c.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "8px 10px", borderRadius: 4, textAlign: "left",
                    cursor: linked ? "not-allowed" : "pointer",
                    opacity: linked ? 0.45 : 1,
                    background:   on ? "var(--accent-soft)" : "var(--bg-2)",
                    border: `1px solid ${on ? "var(--accent-line)" : "var(--line)"}`,
                    color: on ? "var(--fg-0)" : "var(--fg-2)",
                    transition: "all 120ms ease",
                  }}>
                  <span style={{
                    width: 22, height: 22, borderRadius: 5, flexShrink: 0,
                    background: c.color, color: "#fff", fontSize: 11, fontWeight: 600,
                    display: "grid", placeItems: "center",
                  }}>{c.label[0]}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500 }}>{c.label}</div>
                    <div style={{ fontSize: 10, color: "var(--fg-3)" }}>{linked ? "vinculado" : c.category}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {cat && (
          <FormRow label={cat.accountLabel} hint="opcional">
            <input className="input mono" autoFocus value={account}
                   onChange={(e) => setAccount(e.target.value)}
                   placeholder={cat.placeholder} />
          </FormRow>
        )}
      </div>
    </Modal>
  );
}

window.Settings = Settings;
