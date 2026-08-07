// page-mobile-settings.jsx — Configurações no celular (≤480px). Cobre as duas
// gestões mais úteis no celular: Operações (marcas) e Usuários (membros). As
// integrações (Agilizone/Foody/WhatsApp/iFood) e faturas seguem no desktop.
// Reaproveita as funções db* do desktop (page-settings.jsx). Só online.

const _stRoles = ["Super Admin", "Gestor de marca", "Operador cozinha", "Estoquista", "Contador", "Visualização"];
const _stRoleToDb = { "Super Admin": "owner", "Gestor de marca": "manager", "Operador cozinha": "kitchen", "Estoquista": "stock", "Contador": "accountant", "Visualização": "viewer" };
const _ST_MODULES = [
  { id: "dashboard", label: "Dashboard" }, { id: "stock", label: "Estoque" }, { id: "production", label: "Produção" },
  { id: "supply", label: "Suprimentos" }, { id: "distribution", label: "Central" }, { id: "recipes", label: "Fichas técnicas" },
  { id: "revenue", label: "Faturamento" }, { id: "crm", label: "CRM" }, { id: "requests", label: "Requisições" },
  { id: "purchases", label: "Compras" }, { id: "cmv", label: "CMV & margem" }, { id: "finance", label: "Financeiro" },
  { id: "dre", label: "DRE & Fechamento" }, { id: "settings", label: "Configurações" },
];
const _ST_ALL_MODS = _ST_MODULES.map((m) => m.id);
const _ST_PRESETS = {
  "Super Admin": _ST_ALL_MODS, "Gestor de marca": _ST_ALL_MODS.filter((m) => m !== "settings"),
  "Operador cozinha": ["dashboard", "stock", "requests", "recipes", "production"],
  "Estoquista": ["dashboard", "stock", "requests", "purchases", "production", "supply"],
  "Contador": ["dashboard", "revenue", "cmv", "finance", "dre"], "Visualização": ["dashboard"],
};
function _stGenPwd() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const arr = new Uint32Array(12); (window.crypto || window.msCrypto).getRandomValues(arr);
  let out = ""; for (let i = 0; i < arr.length; i++) out += chars[arr[i] % chars.length]; return out;
}

function MobileSettings() {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tab, setTab] = useState("operations");
  const [tenantId, setTenantId] = useState(null);
  const [source, setSource] = useState("mock");
  const [pageLoading, setPageLoading] = useState(true);
  const [ops, setOps] = useState([]);
  const [users, setUsers] = useState([]);
  const [editOp, setEditOp] = useState(null);     // { initial } | { create:true }
  const [editUser, setEditUser] = useState(null); // { initial } | { create:true }

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setPageLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const ctx = await dbGetCurrentContext();
        if (cancelled) return;
        const tid = ctx?.tenant?.id || null;
        setTenantId(tid);
        if (!tid) return;
        setSource("db");
        const [opsRes, memRes] = await Promise.all([dbListOperations(tid), dbListMembers?.(tid) || { data: [] }]);
        if (cancelled) return;
        if (opsRes.source === "db") setOps((opsRes.data || []).map((r) => ({ id: r.id, slug: r.slug, name: r.name, short: r.short_label, color: r.color, iFood: r.ifood_handle })));
        if (memRes?.data) setUsers(memRes.data);
      } finally { if (!cancelled) setPageLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  const reloadOps = async () => { if (tenantId) { const { data } = await dbListOperations(tenantId); if (data) setOps(data.map((r) => ({ id: r.id, slug: r.slug, name: r.name, short: r.short_label, color: r.color, iFood: r.ifood_handle }))); } };
  const reloadUsers = async () => { if (tenantId) { const r = await dbListMembers?.(tenantId); if (r?.data) setUsers(r.data); } };

  // ===== operações =====
  const saveOp = async (draft, initial) => {
    if (source === "db" && tenantId) {
      if (initial) { const { error } = await dbUpdateOperation(initial.id, draft); if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; } }
      else { const slug = (draft.short || draft.name).toLowerCase().replace(/[^a-z0-9]+/g, "-"); const { error } = await dbInsertOperation(tenantId, { slug, name: draft.name, short: draft.short, color: draft.color, iFood: draft.iFood, sort_order: ops.length + 1 }); if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; } }
      await reloadOps(); window.showToast?.(`Operação ${draft.name} salva`, { tone: "ok" }); return true;
    }
    window.showToast?.("Conecte ao Supabase para gerenciar operações", { tone: "warn" }); return false;
  };
  const deleteOp = async (op) => {
    if (source === "db" && tenantId) { const { error } = await dbDeleteOperation(op.id); if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return; } await reloadOps(); window.showToast?.(`Operação ${op.name} desativada`, { tone: "warn" }); }
  };

  // ===== usuários =====
  const saveUser = async (u, initial) => {
    if (source !== "db" || !tenantId) { window.showToast?.("Conecte ao Supabase para gerenciar usuários", { tone: "warn" }); return false; }
    if (initial?.userId) {
      const patch = { name: u.name, role: _stRoleToDb[u.role], ops: u.ops && u.ops !== "todas" ? [u.ops] : [], modules: Array.isArray(u.modules) ? u.modules : null };
      if (typeof u.password === "string" && u.password.length >= 6) patch.password = u.password;
      const { error } = await dbUpdateMember?.(tenantId, initial.userId, patch);
      if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; }
      await reloadUsers(); window.showToast?.(`${u.name} atualizado`, { tone: "ok" }); return true;
    }
    const { data, error } = await dbInviteMember?.(tenantId, { email: u.email, password: u.password, name: u.name, role: _stRoleToDb[u.role], ops: u.ops && u.ops !== "todas" ? [u.ops] : [], modules: Array.isArray(u.modules) ? u.modules : null });
    if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 }); return false; }
    await reloadUsers();
    window.showToast?.(data?.linkedExisting ? `${u.name || u.email} vinculado (senha não alterada)` : `${u.name || u.email} criado`, { tone: data?.linkedExisting ? "warn" : "ok", ttl: 5000 });
    return true;
  };

  if (pageLoading) return <PageLoading label="Carregando configurações…" variant="table" />;
  if (!dbStatus.isOnline || !tenantId) {
    return <MobilePage><div style={{ padding: 24 }}><div style={{ fontSize: 12.5, color: "var(--warn)", padding: "12px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 8 }}>Configurações só ficam disponíveis com Supabase online.</div></div></MobilePage>;
  }

  return (
    <MobilePage>
      <SegTabs value={tab} onChange={setTab} options={[
        { id: "operations", label: "Operações", count: ops.length },
        { id: "users", label: "Usuários", count: users.length },
      ]} />

      {tab === "operations" ? (
        <>
          <MobileScroll style={{ padding: "12px 14px" }}>
            <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginBottom: 10 }}>
              Cada operação é uma marca virtual que compartilha o mesmo estoque físico.
            </div>
            {ops.length === 0 ? (
              <div style={{ textAlign: "center", padding: "32px 12px", color: "var(--fg-3)", fontSize: 13 }}>Nenhuma operação.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {ops.map((o) => (
                  <MobileCard key={o.id} onClick={() => setEditOp({ initial: o })}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ width: 12, height: 12, borderRadius: 50, background: o.color, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14.5, color: "var(--fg-0)", fontWeight: 500 }}>{o.name}</div>
                        <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", marginTop: 2 }}>{o.short}{o.iFood ? ` · ${o.iFood}` : ""}</div>
                      </div>
                      <I.Chevron size={14} style={{ color: "var(--fg-3)", transform: "rotate(-90deg)", flexShrink: 0 }} />
                    </div>
                  </MobileCard>
                ))}
              </div>
            )}
          </MobileScroll>
          <MobileBottomBar>
            <MPrimaryButton onClick={() => setEditOp({ create: true })}><I.Plus size={16} />Nova operação</MPrimaryButton>
          </MobileBottomBar>
        </>
      ) : (
        <>
          <MobileScroll style={{ padding: "12px 14px" }}>
            {users.length === 0 ? (
              <div style={{ textAlign: "center", padding: "32px 12px", color: "var(--fg-3)", fontSize: 13 }}>Nenhum usuário.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {users.map((u) => (
                  <MobileCard key={u.email || u.userId} onClick={() => setEditUser({ initial: u })}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--bg-3)", color: "var(--fg-1)", fontSize: 11, fontWeight: 600, display: "grid", placeItems: "center", flexShrink: 0 }}>{(u.name || u.email || "?").split(" ").map((n) => n[0]).slice(0, 2).join("")}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.name || u.email}</div>
                        <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.role} · {u.email}</div>
                      </div>
                      <I.Chevron size={14} style={{ color: "var(--fg-3)", transform: "rotate(-90deg)", flexShrink: 0 }} />
                    </div>
                  </MobileCard>
                ))}
              </div>
            )}
          </MobileScroll>
          <MobileBottomBar>
            <MPrimaryButton onClick={() => setEditUser({ create: true })}><I.Plus size={16} />Convidar usuário</MPrimaryButton>
          </MobileBottomBar>
        </>
      )}

      {editOp && (
        <OperationFormSheet
          initial={editOp.initial || null} tenantId={tenantId} dbOnline={source === "db"}
          onClose={() => setEditOp(null)}
          onSave={async (d) => { const ok = await saveOp(d, editOp.initial || null); if (ok) setEditOp(null); return ok; }}
          onDelete={editOp.initial ? async () => { await deleteOp(editOp.initial); setEditOp(null); } : null}
        />
      )}
      {editUser && (
        <UserFormSheet
          initial={editUser.initial || null} ops={ops}
          onClose={() => setEditUser(null)}
          onSave={async (u) => { const ok = await saveUser(u, editUser.initial || null); if (ok) setEditUser(null); return ok; }}
        />
      )}
    </MobilePage>
  );
}

// ===== Form: operação (+ turnos) =====
function OperationFormSheet({ initial, tenantId, dbOnline, onClose, onSave, onDelete }) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name || "");
  const [short, setShort] = useState(initial?.short || "");
  const [color, setColor] = useState(initial?.color || "#2d8c66");
  const [iFood, setIFood] = useState(initial?.iFood || "");
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [shifts, setShifts] = useState([]);
  const [newShift, setNewShift] = useState("");
  const canShifts = !!initial?.id && dbOnline && tenantId;

  useEffect(() => {
    if (!canShifts) { setShifts([]); return; }
    let cancelled = false;
    (async () => { const { data } = await dbListOperationShifts(tenantId, initial.id); if (!cancelled) setShifts(data || []); })();
    return () => { cancelled = true; };
  }, [canShifts, tenantId, initial?.id]);

  const addShift = async () => {
    const t = newShift.trim(); if (!t || !canShifts) return;
    const { data, error } = await dbInsertOperationShift(tenantId, { operationId: initial.id, name: t, sortOrder: shifts.length });
    if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit" }); return; }
    setShifts([...shifts, data]); setNewShift(""); window.showToast?.(`Turno "${t}" criado`, { tone: "ok" });
  };
  const removeShift = async (s) => {
    if (!canShifts) return;
    const { error } = await dbDeleteOperationShift(s.id);
    if (error) { window.showToast?.(`Erro: ${error.message}`, { tone: "crit" }); return; }
    setShifts(shifts.filter((x) => x.id !== s.id)); window.showToast?.(`Turno "${s.name}" removido`, { tone: "warn" });
  };

  const valid = name.trim() && short.trim();
  const submit = async () => { if (saving || !valid) return; setSaving(true); try { await onSave({ name: name.trim(), short: short.trim().toUpperCase(), color, iFood: iFood.trim() || null }); } finally { setSaving(false); } };

  return (
    <FullSheet
      title={isEdit ? "Editar operação" : "Nova operação"} subtitle={isEdit ? initial.short : "Marca virtual"}
      onBack={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={submit} disabled={!valid} loading={saving}>{isEdit ? "Salvar" : "Criar operação"}</MPrimaryButton>}
    >
      <MField label="Nome da marca"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Forno & Brasa" autoFocus style={mInput} /></MField>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><MField label="Sigla curta"><input value={short} maxLength={6} onChange={(e) => setShort(e.target.value.toUpperCase())} placeholder="BURG" style={{ ...mInput, textTransform: "uppercase" }} /></MField></div>
        <div style={{ width: 90 }}><MField label="Cor"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: "100%", height: 44, padding: 3, background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 8 }} /></MField></div>
      </div>
      <MField label="Handle iFood (opcional)"><input value={iFood} onChange={(e) => setIFood(e.target.value)} placeholder="@minhamarca" style={mInput} /></MField>

      {isEdit && (
        <div style={{ marginTop: 6 }}>
          <MSectionLabel>Turnos</MSectionLabel>
          <div style={{ fontSize: 11, color: "var(--fg-3)", margin: "4px 0 10px" }}>Múltiplos faturamentos no mesmo dia (Almoço, Jantar…).</div>
          {!dbOnline ? (
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Conecte ao Supabase para gerenciar turnos.</div>
          ) : (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
                {shifts.map((s) => (
                  <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, background: "var(--bg-2)", border: "1px solid var(--line)" }}>
                    <span style={{ flex: 1, fontSize: 13.5, color: "var(--fg-0)" }}>{s.name}</span>
                    <button onClick={() => removeShift(s)} aria-label="Remover" style={{ width: 30, height: 30, borderRadius: 7, background: "transparent", border: "none", color: "var(--crit)", display: "grid", placeItems: "center" }}><I.Trash size={14} /></button>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={newShift} onChange={(e) => setNewShift(e.target.value)} placeholder="Novo turno" style={{ ...mInput, height: 44 }} />
                <button onClick={addShift} disabled={!newShift.trim()} style={{ height: 44, padding: "0 16px", borderRadius: 8, flexShrink: 0, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14, fontWeight: 600 }}>Add</button>
              </div>
            </>
          )}
        </div>
      )}

      {isEdit && onDelete && (
        <div style={{ marginTop: 18 }}>
          {!confirmDel ? (
            <button onClick={() => setConfirmDel(true)} style={{ width: "100%", height: 48, borderRadius: 10, background: "transparent", border: "1px solid var(--crit-line)", color: "var(--crit)", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><I.Trash size={15} />Excluir operação</button>
          ) : (
            <div style={{ padding: 12, borderRadius: 10, background: "var(--crit-soft)", border: "1px solid var(--crit-line)" }}>
              <div style={{ fontSize: 12.5, color: "var(--fg-1)", marginBottom: 10 }}>Desativar <strong>{initial.name}</strong>? O histórico é preservado.</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setConfirmDel(false)} style={{ flex: 1, height: 46, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14 }}>Cancelar</button>
                <button onClick={onDelete} style={{ flex: 1, height: 46, borderRadius: 10, background: "var(--crit)", border: "none", color: "#fff", fontSize: 14, fontWeight: 600 }}>Excluir</button>
              </div>
            </div>
          )}
        </div>
      )}
    </FullSheet>
  );
}

// ===== Form: usuário (membro) =====
function UserFormSheet({ initial, ops, onClose, onSave }) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name || "");
  const [email, setEmail] = useState(initial?.email || "");
  const [password, setPassword] = useState(isEdit ? "" : _stGenPwd());
  const [changePwd, setChangePwd] = useState(false);
  const [role, setRole] = useState(initial?.role && _stRoles.includes(initial.role) ? initial.role : "Operador cozinha");
  const [opSel, setOpSel] = useState(Array.isArray(initial?.ops) ? (initial.ops[0] || "todas") : (initial?.ops || "todas"));
  const [modules, setModules] = useState(initial?.modules || _ST_PRESETS[initial?.role] || _ST_PRESETS["Operador cozinha"]);
  const [saving, setSaving] = useState(false);

  const pwdProvided = typeof password === "string" && password.length >= 6;
  const pwdOk = isEdit ? (!changePwd || pwdProvided) : pwdProvided;
  const valid = name.trim() && /\S+@\S+\.\S+/.test(email) && modules.length > 0 && pwdOk;

  const onRole = (r) => { setRole(r); setModules(_ST_PRESETS[r] || ["dashboard"]); };
  const toggleMod = (id) => setModules((cur) => cur.includes(id) ? cur.filter((m) => m !== id) : [...cur, id]);
  const copyPwd = async () => { try { await navigator.clipboard.writeText(password); window.showToast?.("Senha copiada", { tone: "ok", ttl: 1800 }); } catch {} };

  const submit = async () => {
    if (saving || !valid) return; setSaving(true);
    try {
      const payload = { name: name.trim(), email: email.trim(), role, ops: opSel, modules };
      if (!isEdit) payload.password = password; else if (changePwd && pwdProvided) payload.password = password;
      await onSave(payload);
    } finally { setSaving(false); }
  };

  return (
    <FullSheet
      title={isEdit ? "Editar usuário" : "Convidar usuário"} subtitle={isEdit ? initial.email : "Acesso imediato com e-mail e senha"}
      onBack={saving ? undefined : onClose}
      footer={<MPrimaryButton onClick={submit} disabled={!valid} loading={saving}>{isEdit ? "Salvar" : "Criar usuário"}</MPrimaryButton>}
    >
      <MField label="Nome"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus style={mInput} /></MField>
      <MField label="E-mail"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={isEdit} style={{ ...mInput, opacity: isEdit ? 0.6 : 1 }} /></MField>

      {!isEdit ? (
        <MField label="Senha inicial" hint="Mín. 6 caracteres. Compartilhe com o usuário.">
          <div style={{ display: "flex", gap: 6 }}>
            <input value={password} onChange={(e) => setPassword(e.target.value)} style={{ ...mInput, flex: 1, fontFamily: "var(--mono)" }} />
            <button onClick={() => setPassword(_stGenPwd())} style={_stMini}>↻</button>
            <button onClick={copyPwd} style={_stMini}>Copiar</button>
          </div>
        </MField>
      ) : (
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, background: changePwd ? "var(--warn-soft)" : "var(--bg-2)", border: `1px solid ${changePwd ? "var(--warn-line)" : "var(--line)"}` }}>
            <input type="checkbox" checked={changePwd} onChange={(e) => { setChangePwd(e.target.checked); if (e.target.checked && !password) setPassword(_stGenPwd()); if (!e.target.checked) setPassword(""); }} style={{ width: 20, height: 20 }} />
            <div style={{ flex: 1 }}><div style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }}>Trocar senha</div><div style={{ fontSize: 11, color: "var(--fg-3)" }}>Invalida a senha atual.</div></div>
          </label>
          {changePwd && (
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Nova senha" style={{ ...mInput, flex: 1, fontFamily: "var(--mono)", borderColor: pwdProvided ? "var(--line)" : "var(--crit)" }} />
              <button onClick={() => setPassword(_stGenPwd())} style={_stMini}>↻</button>
              <button onClick={copyPwd} style={_stMini}>Copiar</button>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><MField label="Função"><select value={role} onChange={(e) => onRole(e.target.value)} style={mInput}>{_stRoles.map((r) => <option key={r} value={r}>{r}</option>)}</select></MField></div>
        <div style={{ flex: 1 }}><MField label="Operação"><select value={opSel} onChange={(e) => setOpSel(e.target.value)} style={mInput}><option value="todas">Todas</option>{ops.map((o) => <option key={o.id} value={o.slug}>{o.name}</option>)}</select></MField></div>
      </div>

      <MSectionLabel>Módulos ({modules.length})</MSectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
        {_ST_MODULES.map((m) => {
          const on = modules.includes(m.id);
          return (
            <button key={m.id} onClick={() => toggleMod(m.id)} style={{
              height: 34, padding: "0 12px", borderRadius: 999, fontSize: 12.5,
              background: on ? "var(--accent-soft)" : "var(--bg-2)", color: on ? "var(--accent-bright)" : "var(--fg-2)",
              border: `1px solid ${on ? "var(--accent-line)" : "var(--line)"}`, display: "inline-flex", alignItems: "center", gap: 6,
            }}>{on && <I.Check size={12} />}{m.label}</button>
          );
        })}
      </div>
    </FullSheet>
  );
}

const _stMini = { height: 44, padding: "0 12px", borderRadius: 8, flexShrink: 0, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 13, fontWeight: 600 };

window.MobileSettings = MobileSettings;
