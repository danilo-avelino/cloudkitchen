// Cliente Supabase + helpers · POC de integração.
//
// Carrega lazy. Se config ou rede falhar, _state vira "offline" e o resto do
// app cai pro MOCK. Componentes que precisam do banco usam useDbStatus()
// pra reagir a mudanças (online/offline).
// =====================================================================

let _client = null;
let _state  = "checking"; // checking | online | tables_missing | error | offline
let _error  = null;
let _listeners = new Set();

function notifyState() {
  _listeners.forEach((fn) => { try { fn(_state); } catch {} });
}
function setState(s, err) {
  _state = s;
  _error = err || null;
  notifyState();
}

// Inicializa o cliente quando há config + biblioteca disponível
async function initSupabase() {
  const cfg = window.SK_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
    setState("offline", new Error("config.local.js não definiu SK_CONFIG"));
    return null;
  }
  if (!window.supabase?.createClient) {
    setState("error", new Error("@supabase/supabase-js não carregou (verifique CDN)"));
    return null;
  }
  try {
    _client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: {
        persistSession:  true,
        autoRefreshToken: true,
        storage: window.localStorage,
        storageKey: "sk.supabase.auth.v1",
      },
    });
    // Healthcheck · usa auth.getSession() (não bloqueado por RLS)
    // RLS em tenants retorna 401 pra anon; getSession() é sempre acessível
    try {
      await _client.auth.getSession();
      setState("online", null);
      // Limpa todos os arrays MOCK — páginas passam a exibir somente dados reais
      if (typeof window.clearMockData === "function") window.clearMockData();
    } catch (e) {
      setState("error", e);
    }
    return _client;
  } catch (e) {
    setState("error", e);
    return null;
  }
}

function getSupabaseClient()    { return _client; }
function getDbState()           { return _state; }
function getDbError()           { return _error; }
function isDbOnline()           { return _state === "online"; }

// Hook React que escuta mudanças de status
function useDbStatus() {
  const [state, setLocalState] = React.useState(_state);
  React.useEffect(() => {
    const fn = (s) => setLocalState(s);
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
  }, []);
  return { state, isOnline: state === "online", error: _error };
}

// Wrapper · executa callback no Supabase ou cai pro fallback se offline
async function dbOrMock(dbFn, mockResult) {
  if (!isDbOnline() || !_client) return { data: mockResult, source: "mock", error: null };
  try {
    const result = await dbFn(_client);
    if (result.error) return { data: mockResult, source: "mock", error: result.error };
    return { data: result.data, source: "db", error: null };
  } catch (e) {
    return { data: mockResult, source: "mock", error: e };
  }
}

// =====================================================================
// AUTH HELPERS · login, logout, sessão
// =====================================================================
async function dbSignIn(email, password) {
  if (!_client) throw new Error("Supabase não inicializado");
  const { data, error } = await _client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function dbSignOut() {
  if (!_client) return;
  await _client.auth.signOut();
}

// Dispara o email com link mágico de recuperação. O usuário cai em `redirectTo`
// já autenticado em modo "recovery" — daí basta chamar dbUpdatePassword.
async function dbResetPassword(email) {
  if (!_client) throw new Error("Supabase não inicializado");
  const redirectTo = window.location.origin + window.location.pathname + "?reset=1";
  const { error } = await _client.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}

// Atualiza a senha do usuário autenticado · usado após o usuário clicar
// no link de recuperação e a sessão temporária estar ativa.
async function dbUpdatePassword(newPassword) {
  if (!_client) throw new Error("Supabase não inicializado");
  const { error } = await _client.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

async function dbGetSession() {
  if (!_client) return null;
  const { data } = await _client.auth.getSession();
  return data?.session || null;
}

// Resolve o profile + tenant_member do usuário atual (após login).
// Retorna { profile, member, tenant } ou null se algo falhar.
async function dbGetCurrentContext() {
  if (!_client) return null;
  try {
    const { data: { user } } = await _client.auth.getUser();
    if (!user) return null;
    const { data: profile } = await _client.from("profiles").select("*").eq("id", user.id).maybeSingle();
    // Seleciona modules separadamente — se a migration de Fase 14 ainda não foi
    // aplicada (coluna inexistente), cai pra select básico em vez de quebrar tudo.
    let members = null;
    {
      const full = await _client.from("tenant_members")
        .select("tenant_id, role, ops, modules").eq("user_id", user.id);
      if (full.error) {
        const basic = await _client.from("tenant_members")
          .select("tenant_id, role, ops").eq("user_id", user.id);
        members = basic.data;
      } else {
        members = full.data;
      }
    }
    const member = members?.[0] || null;
    let tenant = null;
    if (member) {
      const { data: t } = await _client.from("tenants").select("*").eq("id", member.tenant_id).maybeSingle();
      tenant = t;
      // Popula window.MOCK.OPERATIONS com dados reais do DB para que páginas
      // que ainda usam MOCK.OPERATIONS (modais, dropdowns) vejam as ops reais.
      try {
        const { data: ops } = await _client.from("operations")
          .select("id, slug, name, short_label, color, ifood_handle, cmv_goal_pct, sort_order")
          .eq("tenant_id", member.tenant_id)
          .eq("is_active", true)
          .order("sort_order", { ascending: true });
        if (ops && window.MOCK) {
          window.MOCK.OPERATIONS = ops.map((o) => ({
            id: o.id, slug: o.slug, name: o.name,
            short: o.short_label, color: o.color || "#8a9098",
            iFood: o.ifood_handle,
            cmvGoal: o.cmv_goal_pct != null ? Number(o.cmv_goal_pct) : null,
          }));
        }
      } catch {}
    }
    return { user, profile, member, tenant };
  } catch (e) {
    console.warn("dbGetCurrentContext falhou", e);
    return null;
  }
}

// =====================================================================
// OPERATIONS · CRUD (POC do POC)
// =====================================================================
async function dbListRecipeCategories(tenantId) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  const { data, error } = await _client.from("recipe_categories")
    .select("id, name, color, sort_order")
    .eq("tenant_id", tenantId)
    .order("sort_order", { ascending: true });
  if (error) return { data: null, source: "mock", error };
  return { data, source: "db", error: null };
}

async function dbInsertRecipeCategory(tenantId, { name, color }) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { data, error } = await _client.from("recipe_categories")
    .insert({ tenant_id: tenantId, name, color: color || "#8a9098", sort_order: 99 })
    .select().single();
  return { data, error };
}

async function dbListOperations(tenantId) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  const { data, error } = await _client.from("operations")
    .select("id, slug, name, short_label, color, ifood_handle, cmv_goal_pct, is_active, sort_order")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) return { data: null, source: "mock", error };
  return { data, source: "db", error: null };
}

async function dbInsertOperation(tenantId, op) {
  if (!isDbOnline() || !_client) {
    return { data: null, error: new Error("DB offline · operação só salva localmente") };
  }
  const { data, error } = await _client.from("operations").insert({
    tenant_id:    tenantId,
    slug:         op.slug,
    name:         op.name,
    short_label:  op.short || op.short_label,
    color:        op.color,
    ifood_handle: op.iFood || op.ifood_handle,
    cmv_goal_pct: op.cmv_goal_pct ?? null,
    sort_order:   op.sort_order ?? 99,
  }).select().single();
  return { data, error };
}

async function dbUpdateOperation(id, patch) {
  if (!isDbOnline() || !_client) {
    return { data: null, error: new Error("DB offline · operação só salva localmente") };
  }
  const { data, error } = await _client.from("operations")
    .update({
      name:         patch.name,
      short_label:  patch.short || patch.short_label,
      color:        patch.color,
      ifood_handle: patch.iFood || patch.ifood_handle,
      cmv_goal_pct: patch.cmv_goal_pct,
    })
    .eq("id", id)
    .select()
    .single();
  return { data, error };
}

async function dbDeleteOperation(id) {
  if (!isDbOnline() || !_client) {
    return { error: new Error("DB offline · exclusão não persistida") };
  }
  // Soft delete · marca is_active = false (preserva histórico de FKs)
  const { error } = await _client.from("operations").update({ is_active: false }).eq("id", id);
  return { error };
}

// ---------- Turnos por operação ----------
async function dbListOperationShifts(tenantId, operationId) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  let q = _client.from("operation_shifts")
    .select("id, operation_id, name, sort_order, is_active")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (operationId) q = q.eq("operation_id", operationId);
  const { data, error } = await q;
  if (error) return { data: null, source: "mock", error };
  return { data, source: "db", error: null };
}

async function dbInsertOperationShift(tenantId, { operationId, name, sortOrder }) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { data, error } = await _client.from("operation_shifts").insert({
    tenant_id:    tenantId,
    operation_id: operationId,
    name:         String(name || "").trim(),
    sort_order:   sortOrder ?? 0,
  }).select().single();
  return { data, error };
}

async function dbUpdateOperationShift(id, patch) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const update = {};
  if (patch.name !== undefined)       update.name = String(patch.name).trim();
  if (patch.sortOrder !== undefined)  update.sort_order = patch.sortOrder;
  if (patch.isActive !== undefined)   update.is_active = !!patch.isActive;
  const { data, error } = await _client.from("operation_shifts").update(update).eq("id", id).select().single();
  return { data, error };
}

async function dbDeleteOperationShift(id) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  // Tenta delete hard; se houver revenue_entries linkados, cai pra soft delete.
  const hard = await _client.from("operation_shifts").delete().eq("id", id);
  if (hard.error && /foreign key|violates/i.test(hard.error.message || "")) {
    const soft = await _client.from("operation_shifts").update({ is_active: false }).eq("id", id);
    return { error: soft.error, softDeleted: !soft.error };
  }
  return { error: hard.error };
}

// =====================================================================
// STOCK CATEGORIES · CRUD
// =====================================================================
async function dbListStockCategories(tenantId) {
  return dbOrMock(
    (sb) => sb.from("stock_categories")
      .select("id, name, color, sort_order")
      .eq("tenant_id", tenantId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),
    null,
  );
}

async function dbInsertStockCategory(tenantId, name, color = "#8a9098") {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { data, error } = await _client.from("stock_categories")
    .insert({ tenant_id: tenantId, name, color, sort_order: 99 })
    .select().single();
  return { data, error };
}

async function dbRenameStockCategory(id, newName) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { data, error } = await _client.from("stock_categories")
    .update({ name: newName }).eq("id", id).select().single();
  return { data, error };
}

async function dbDeleteStockCategory(id) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("stock_categories").delete().eq("id", id);
  return { error };
}

// =====================================================================
// SUPPLIERS · CRUD
// =====================================================================
async function dbListSuppliers(tenantId) {
  return dbOrMock(
    (sb) => sb.from("suppliers")
      .select("id, name, legal_name, cnpj, contact_channel, contact_value, lead_time_hours, notes, is_active")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .order("name", { ascending: true }),
    null,
  );
}

async function dbInsertSupplier(tenantId, supplier) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { data, error } = await _client.from("suppliers").insert({
    tenant_id: tenantId,
    name: supplier.name,
    legal_name: supplier.legal_name || null,
    cnpj: supplier.cnpj || null,
    contact_channel: supplier.contact_channel || null,
    contact_value: supplier.contact_value || supplier.contact || null,
    lead_time_hours: supplier.lead_time_hours ?? supplier.leadHours ?? null,
    notes: supplier.notes || null,
  }).select().single();
  return { data, error };
}

async function dbUpdateSupplier(id, patch) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { data, error } = await _client.from("suppliers").update({
    name: patch.name,
    legal_name: patch.legal_name,
    cnpj: patch.cnpj,
    contact_channel: patch.contact_channel,
    contact_value: patch.contact_value,
    lead_time_hours: patch.lead_time_hours,
    notes: patch.notes,
  }).eq("id", id).select().single();
  return { data, error };
}

async function dbDeleteSupplier(id) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  // Soft delete · preserva FKs históricas
  const { error } = await _client.from("suppliers").update({ is_active: false }).eq("id", id);
  return { error };
}

// =====================================================================
// STOCK ITEMS · CRUD com nested allocations
// =====================================================================
// Mapeia a row do banco pro shape esperado pelo frontend.
// Banco: { id, code, name, unit, unit_cost, current_qty, reorder_point,
//          max_qty, expiration_date, compose_cmv, category, allocations[] }
// Front: { id, name, cat, unit, cost, qty, reorder, max, exp, composeCmv,
//          alloc: { burguer: x, pizzaria: y, ... }, supplier: name }
function mapStockItemFromDb(row) {
  const alloc = {};
  (row.allocations || []).forEach((a) => {
    const slug = a.operation?.slug;
    if (slug) alloc[slug] = Number(a.qty) || 0;
  });
  return {
    id:        row.id,
    code:      row.code,
    name:      row.name,
    cat:       row.category?.name || "Sem categoria",
    catId:     row.category_id,
    unit:      row.unit,
    cost:      Number(row.unit_cost) || 0,
    qty:       Number(row.current_qty) || 0,
    reorder:   Number(row.reorder_point) || 0,
    max:       row.max_qty != null ? Number(row.max_qty) : null,
    exp:       row.expiration_date || "—",
    status:    row.status, // calculado no banco
    composeCmv: row.compose_cmv !== false,
    supplier:  row.supplier?.name || null,
    supplierId: row.supplier_id,
    autoMin:   row.auto_min_enabled === true,
    alloc,
    notes:     row.notes,
  };
}

async function dbSetStockItemAutoMin(itemId, enabled) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("stock_items")
    .update({ auto_min_enabled: !!enabled })
    .eq("id", itemId);
  return { error };
}

async function dbListStockItems(tenantId) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  try {
    const { data, error } = await _client.from("stock_items")
      .select(`
        id, code, name, unit, unit_cost, current_qty, reorder_point,
        max_qty, expiration_date, compose_cmv, notes, status, auto_min_enabled,
        category_id, supplier_id,
        category:stock_categories(id, name, color),
        supplier:suppliers(id, name),
        allocations:stock_allocations(qty, operation:operations(id, slug))
      `)
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .order("name", { ascending: true });
    if (error) return { data: null, source: "mock", error };
    return { data: (data || []).map(mapStockItemFromDb), source: "db", error: null };
  } catch (e) {
    return { data: null, source: "mock", error: e };
  }
}

async function dbInsertStockItem(tenantId, item) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { data, error } = await _client.from("stock_items").insert({
    tenant_id:       tenantId,
    code:            item.code || null,
    name:            item.name,
    unit:            item.unit,
    unit_cost:       Number(item.cost) || 0,
    current_qty:     Number(item.qty) || 0,
    reorder_point:   Number(item.reorder ?? item.min) || 0,
    max_qty:         item.max != null ? Number(item.max) : null,
    expiration_date: item.exp && item.exp !== "—" ? item.exp : null,
    compose_cmv:     item.composeCmv !== false,
    category_id:     item.catId || null,
    supplier_id:     item.supplierId || null,
    notes:           item.notes || null,
  }).select(`
    id, code, name, unit, unit_cost, current_qty, reorder_point,
    max_qty, expiration_date, compose_cmv, notes, status,
    category_id, supplier_id,
    category:stock_categories(id, name, color),
    supplier:suppliers(id, name),
    allocations:stock_allocations(qty, operation:operations(id, slug))
  `).single();
  if (error) return { data: null, error };
  return { data: mapStockItemFromDb(data), error: null };
}

async function dbUpdateStockItem(id, patch) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const update = {};
  if (patch.name        !== undefined) update.name = patch.name;
  if (patch.unit        !== undefined) update.unit = patch.unit;
  if (patch.cost        !== undefined) update.unit_cost = Number(patch.cost) || 0;
  if (patch.qty         !== undefined) update.current_qty = Number(patch.qty) || 0;
  if (patch.reorder !== undefined || patch.min !== undefined)
    update.reorder_point = Number(patch.reorder ?? patch.min) || 0;
  if (patch.max         !== undefined) update.max_qty = patch.max != null ? Number(patch.max) : null;
  if (patch.exp         !== undefined) update.expiration_date = patch.exp && patch.exp !== "—" ? patch.exp : null;
  if (patch.composeCmv  !== undefined) update.compose_cmv = !!patch.composeCmv;
  if (patch.catId       !== undefined) update.category_id = patch.catId || null;
  if (patch.supplierId  !== undefined) update.supplier_id = patch.supplierId || null;
  if (patch.notes       !== undefined) update.notes = patch.notes;
  const { data, error } = await _client.from("stock_items").update(update).eq("id", id).select(`
    id, code, name, unit, unit_cost, current_qty, reorder_point,
    max_qty, expiration_date, compose_cmv, notes, status, auto_min_enabled,
    category_id, supplier_id,
    category:stock_categories(id, name, color),
    supplier:suppliers(id, name),
    allocations:stock_allocations(qty, operation:operations(id, slug))
  `).single();
  if (error) return { data: null, error };
  return { data: mapStockItemFromDb(data), error: null };
}

async function dbDeleteStockItem(id) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("stock_items").update({ is_active: false }).eq("id", id);
  return { error };
}

// Aplica movimento de estoque (in/out/adjust/loss/expiration) · INSERT em stock_movements
// O trigger no banco atualiza current_qty automaticamente.
// `opts.operationId` e `opts.lossReason` são opcionais — usados pela aba Desperdícios.
async function dbApplyStockMovement(tenantId, itemId, deltaQty, kind = "out", reason, unitCost, opts = {}) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  // Schema constraint: in ⇒ qty>0; out/loss/expiration ⇒ qty<0; adjust ⇒ qualquer.
  // Para adjust preservamos o sinal recebido (pode ser falta ou sobra do inventário).
  const rawQty = Number(deltaQty);
  const absQty = Math.abs(rawQty);
  const signedQty = (kind === "out" || kind === "loss" || kind === "expiration")
    ? -absQty
    : kind === "adjust"
      ? rawQty
      : absQty;
  if (signedQty === 0) return { error: null }; // nada a aplicar
  const payload = {
    tenant_id: tenantId,
    stock_item_id: itemId,
    kind, // 'in' | 'out' | 'adjust' | 'loss' | 'expiration'
    qty: signedQty,
    notes: reason || null,
  };
  if (unitCost != null && Number(unitCost) > 0) payload.unit_cost = Number(unitCost);
  if (opts.operationId) payload.operation_id = opts.operationId;
  if (opts.lossReason)  payload.loss_reason  = opts.lossReason;
  if (opts.referenceType) payload.reference_type = opts.referenceType;
  const { error } = await _client.from("stock_movements").insert(payload);
  return { error };
}

// Lista movimentações de estoque no período · usado no Histórico do estoque.
// `fromIso` / `toIso` são timestamps ISO; `toIso` opcional (sem limite superior).
async function dbListStockMovements(tenantId, fromIso, toIso, { limit = 500, stockItemId = null } = {}) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  let q = _client
    .from("stock_movements")
    .select(`
      id, kind, qty, unit_cost, notes, performed_at,
      reference_type, reference_id, loss_reason,
      stock_item:stock_items(id, name, unit, compose_cmv, category:stock_categories(id, name)),
      operation:operations(id, slug, name, short_label, color)
    `)
    .eq("tenant_id", tenantId)
    .order("performed_at", { ascending: false })
    .limit(limit);
  if (stockItemId) q = q.eq("stock_item_id", stockItemId);
  if (fromIso) q = q.gte("performed_at", fromIso);
  if (toIso)   q = q.lt("performed_at", toIso);
  const { data, error } = await q;
  if (error) return { data: null, source: "mock", error };
  const mapped = (data || []).map((m) => ({
    id:    m.id,
    at:    m.performed_at,
    kind:  m.kind,
    delta: Number(m.qty) || 0,
    unitCost: Number(m.unit_cost) || 0,
    itemId: m.stock_item?.id || null,
    item:  m.stock_item?.name || "—",
    unit:  m.stock_item?.unit || "",
    composeCmv: m.stock_item?.compose_cmv !== false,
    categoryId:   m.stock_item?.category?.id   || null,
    categoryName: m.stock_item?.category?.name || null,
    op:    m.operation?.slug || (m.kind === "in" ? "—" : "—"),
    operationId:   m.operation?.id    || null,
    operationName: m.operation?.name  || null,
    operationShort: m.operation?.short_label || null,
    operationColor: m.operation?.color || null,
    lossReason: m.loss_reason || null,
    referenceType: m.reference_type || null,
    notes: m.notes || null,
    ref:   m.notes || m.reference_type || "—",
  }));
  return { data: mapped, source: "db", error: null };
}

// =====================================================================
// PAYMENT METHODS
// =====================================================================
async function dbListPaymentMethods(tenantId) {
  return dbOrMock(
    (sb) => sb.from("payment_methods")
      .select("id, slug, label, short_label, color, is_active, sort_order")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
    null,
  );
}

// =====================================================================
// REVENUE ENTRIES · faturamento por dia × operação × source
// =====================================================================
function mapRevenueFromDb(row) {
  const breakdown = {};
  (row.payment_breakdown || []).forEach((b) => {
    const slug = b.method?.slug;
    if (slug) breakdown[slug] = Number(b.amount) || 0;
  });
  const revenue = Object.values(breakdown).reduce((s, v) => s + v, 0);
  return {
    id:           row.id,
    op:           row.operation?.slug || row.operation_id,
    operationId:  row.operation_id,
    date:         row.business_date,
    source:       row.source,
    status:       row.status,
    ordersCount:  row.orders_count,
    cogs:         Number(row.cogs) || 0,
    notes:        row.notes,
    shiftId:      row.shift_id || null,
    shiftName:    row.shift?.name || null,
    revenue,
    breakdown,
  };
}

async function dbListRevenueEntries(tenantId, fromDate, toDate) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  let q = _client.from("revenue_entries")
    .select(`
      id, business_date, source, status, orders_count, cogs, notes, shift_id,
      operation_id, operation:operations(id, slug, name),
      shift:operation_shifts(id, name),
      payment_breakdown:revenue_payment_breakdown(amount, method:payment_methods(id, slug))
    `)
    .eq("tenant_id", tenantId)
    .order("business_date", { ascending: false });
  if (fromDate) q = q.gte("business_date", fromDate);
  if (toDate)   q = q.lte("business_date", toDate);
  const { data, error } = await q;
  if (error) return { data: null, source: "mock", error };
  return { data: (data || []).map(mapRevenueFromDb), source: "db", error: null };
}

async function dbInsertRevenueEntry(tenantId, draft) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { breakdown = {}, ...entry } = draft;
  // Resolve operation_id pelo slug se necessário
  let operationId = entry.operationId;
  if (!operationId && entry.op) {
    const __isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.op);
    if (__isUuid) {
      operationId = entry.op;
    } else {
      const { data: op } = await _client.from("operations")
        .select("id").eq("tenant_id", tenantId).eq("slug", entry.op).maybeSingle();
      operationId = op?.id;
    }
  }
  if (!operationId) return { data: null, error: new Error(`Operação "${entry.op}" não encontrada`) };
  // 1. Insert no revenue_entries
  const { data: row, error } = await _client.from("revenue_entries").insert({
    tenant_id:    tenantId,
    operation_id: operationId,
    business_date: entry.date,
    source:       entry.source || "balcao",
    orders_count: entry.ordersCount || 0,
    cogs:         entry.cogs || 0,
    status:       entry.status || "pending",
    notes:        entry.notes || null,
    shift_id:     entry.shiftId || null,
  }).select().single();
  if (error) return { data: null, error };

  // 2. Insert breakdown (precisa do payment_method_id)
  const { data: methods } = await _client.from("payment_methods")
    .select("id, slug").eq("tenant_id", tenantId);
  const slugMap = {};
  (methods || []).forEach((m) => { slugMap[m.slug] = m.id; });
  const breakdownRows = Object.entries(breakdown)
    .filter(([slug, amount]) => slugMap[slug] && amount > 0)
    .map(([slug, amount]) => ({
      revenue_entry_id:  row.id,
      payment_method_id: slugMap[slug],
      amount: Number(amount) || 0,
    }));
  if (breakdownRows.length > 0) {
    const { error: bErr } = await _client.from("revenue_payment_breakdown").insert(breakdownRows);
    if (bErr) return { data: row, error: bErr };
  }
  return { data: { ...mapRevenueFromDb(row), breakdown }, error: null };
}

async function dbUpdateRevenueEntry(id, patch) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const update = {};
  if (patch.cogs !== undefined)        update.cogs = patch.cogs;
  if (patch.ordersCount !== undefined) update.orders_count = patch.ordersCount;
  if (patch.status !== undefined)      update.status = patch.status;
  if (patch.notes !== undefined)       update.notes = patch.notes;
  if (patch.date !== undefined)        update.business_date = patch.date;
  if (patch.source !== undefined)      update.source = patch.source;
  if (patch.shiftId !== undefined)     update.shift_id = patch.shiftId || null;
  const { data, error } = await _client.from("revenue_entries").update(update).eq("id", id).select().single();
  if (error) return { data, error };

  // Atualiza breakdown · delete + reinsert para refletir mudanças nos métodos
  if (patch.breakdown !== undefined) {
    const tenantId = data?.tenant_id;
    if (!tenantId) return { data, error: new Error("tenant_id ausente no update do faturamento") };
    const { error: dErr } = await _client.from("revenue_payment_breakdown")
      .delete().eq("revenue_entry_id", id);
    if (dErr) return { data, error: dErr };
    const { data: methods } = await _client.from("payment_methods")
      .select("id, slug").eq("tenant_id", tenantId);
    const slugMap = {};
    (methods || []).forEach((m) => { slugMap[m.slug] = m.id; });
    const rows = Object.entries(patch.breakdown || {})
      .filter(([slug, amount]) => slugMap[slug] && Number(amount) > 0)
      .map(([slug, amount]) => ({
        revenue_entry_id:  id,
        payment_method_id: slugMap[slug],
        amount:            Number(amount) || 0,
      }));
    if (rows.length > 0) {
      const { error: iErr } = await _client.from("revenue_payment_breakdown").insert(rows);
      if (iErr) return { data, error: iErr };
    }
  }
  return { data, error: null };
}

async function dbDeleteRevenueEntry(id) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("revenue_entries").delete().eq("id", id);
  return { error };
}

// =====================================================================
// KITCHEN REQUESTS · requisições de cozinha
// =====================================================================
function mapKitchenRequestFromDb(row) {
  // splits do DB vem como jsonb [{op, pct}]; calcula value (R$) a partir do total
  const totalNum = (row.items || []).reduce((s, it) => s + (Number(it.line_cost) || 0), 0);
  const splitsRaw = Array.isArray(row.splits) ? row.splits : null;
  const splits = splitsRaw ? splitsRaw.map((s) => ({
    op:    s.op,
    pct:   Number(s.pct) || 0,
    value: Number((((Number(s.pct) || 0) / 100) * totalNum).toFixed(2)),
  })) : null;
  return {
    id:        row.id,
    code:      row.code || row.id?.slice(0, 8),
    op:        row.operation?.slug || row.operation_id,
    operationId: row.operation_id,
    isShared:  !!row.is_shared,
    splits,
    status:    row.status,
    priority:  row.priority,
    by:        row.requested_by_name || "—",
    at:        row.requested_at ? new Date(row.requested_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "",
    requestedAt: row.requested_at,
    items:     (row.items || []).map((it) => [
      it.display_name,
      `${Number(it.qty)} ${it.unit}`,
      it.stock_item_id || null,
    ]),
    itemsCount: (row.items || []).length,
    totalNum,
    total: "R$ " + totalNum.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    notes: row.notes,
  };
}

async function dbListKitchenRequests(tenantId, options = {}) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  let q = _client.from("kitchen_requests")
    .select(`
      id, code, status, priority, requested_by_name, requested_at, notes,
      operation_id, is_shared, splits,
      operation:operations(id, slug, name, short_label),
      items:kitchen_request_items(id, display_name, qty, unit, unit_cost, line_cost, stock_item_id, sort_order)
    `)
    .eq("tenant_id", tenantId)
    .order("requested_at", { ascending: false });
  if (options.limit) q = q.limit(options.limit);
  const { data, error } = await q;
  if (error) return { data: null, source: "mock", error };
  return { data: (data || []).map(mapKitchenRequestFromDb), source: "db", error: null };
}

async function dbInsertKitchenRequest(tenantId, draft) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { items = [], splits: draftSplits = null, ...header } = draft;
  const __isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  // Resolve operation_id (slug → uuid)
  let operationId = header.operationId;
  if (!operationId && header.op) {
    if (__isUuid(header.op)) {
      operationId = header.op;
    } else {
      const { data: op } = await _client.from("operations")
        .select("id").eq("tenant_id", tenantId).eq("slug", header.op).maybeSingle();
      operationId = op?.id;
    }
  }
  if (!operationId) return { data: null, error: new Error(`Operação "${header.op}" não encontrada`) };

  // Normaliza splits (slug → uuid) para persistir sempre com IDs canônicos
  let splitsToSave = null;
  if (Array.isArray(draftSplits) && draftSplits.length > 0) {
    splitsToSave = [];
    for (const s of draftSplits) {
      let sid = s.op;
      if (sid && !__isUuid(sid)) {
        const { data: op } = await _client.from("operations")
          .select("id").eq("tenant_id", tenantId).eq("slug", sid).maybeSingle();
        sid = op?.id || null;
      }
      if (sid) splitsToSave.push({ op: sid, pct: Number(s.pct) || 0 });
    }
    if (splitsToSave.length === 0) splitsToSave = null;
  }
  const isShared = !!(splitsToSave && splitsToSave.length > 1);

  const { data: row, error } = await _client.from("kitchen_requests").insert({
    tenant_id:         tenantId,
    operation_id:      operationId,
    code:              header.code || null,
    status:            header.status || "pending",
    priority:          header.priority || "normal",
    requested_by_name: header.by || "Cozinha",
    notes:             header.notes || null,
    is_shared:         isShared,
    splits:            splitsToSave,
  }).select().single();
  if (error) return { data: null, error };

  // Insere items
  // IMPORTANTE: unit_cost é o custo UNITÁRIO do insumo. line_cost é coluna gerada
  // (qty * unit_cost) no schema, então passar o custo da linha aqui dobra o cálculo.
  const itemRows = items.map((it, i) => {
    // `it.qty` pode vir como "4 kg" (shape moderno do buildSubmitLine) ou "4 kg"
    // dentro de it[1] (legado). `Number("4 kg")` é NaN — use parseFloat pra extrair
    // o número líder, senão o `|| 1` mascara o erro e tudo salva como 1.
    const rawQty = String(it.qty ?? it[1] ?? "").trim();
    const qtyN = parseFloat(rawQty.replace(",", ".")) || 1;
    const unitCost = Number(it.unitCost) > 0
      ? Number(it.unitCost)
      : (qtyN > 0 ? (Number(it.estCost) || 0) / qtyN : 0);
    return {
      kitchen_request_id: row.id,
      stock_item_id:      it.stock_item_id || null,
      display_name:       it.name || it[0],
      qty:                qtyN,
      unit:               it.unit || (rawQty.match(/[a-zA-Z]+\s*$/)?.[0]?.trim() || "un"),
      unit_cost:          unitCost,
      sort_order:         i,
    };
  });
  if (itemRows.length > 0) {
    const { error: iErr } = await _client.from("kitchen_request_items").insert(itemRows);
    if (iErr) return { data: row, error: iErr };
  }
  return { data: row, error: null };
}

// Substitui TODOS os items de uma requisição (delete + insert).
// Usado pelo editor de requisição: ao salvar, o usuário pode ter alterado qty,
// removido linhas ou trocado insumos. Sem isso o save fica só no state local e
// o trigger de baixa (separated → estoque) usa os itens originais do banco.
// `items` segue o mesmo shape de dbInsertKitchenRequest.items.
async function dbReplaceKitchenRequestItems(requestId, items, header = {}) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  // Atualiza o cabeçalho (notes etc.) — independente de a lista de itens mudar,
  // o usuário pode estar editando só a observação.
  if (header && Object.prototype.hasOwnProperty.call(header, "notes")) {
    const { error: hdrErr } = await _client.from("kitchen_requests")
      .update({ notes: header.notes ?? null }).eq("id", requestId);
    if (hdrErr) return { error: hdrErr };
  }
  const { error: delErr } = await _client.from("kitchen_request_items")
    .delete().eq("kitchen_request_id", requestId);
  if (delErr) return { error: delErr };
  if (!items || items.length === 0) return { error: null };
  // unit_cost é o custo UNITÁRIO. line_cost é coluna gerada (qty * unit_cost);
  // gravar o custo da linha aqui dobra o cálculo. Se vier só estCost, divide por qty.
  const itemRows = items.map((it, i) => {
    // `it.qty` chega como "4 kg" (buildSubmitLine) — `Number("4 kg")` é NaN e o
    // `|| 1` antigo mascarava o erro, salvando sempre 1. Ver [[feedback_brl_number_parse]].
    const rawQty = String(it.qty ?? it[1] ?? "").trim();
    const qtyN = parseFloat(rawQty.replace(",", ".")) || 1;
    const unitCost = Number(it.unitCost) > 0
      ? Number(it.unitCost)
      : (qtyN > 0 ? (Number(it.estCost) || 0) / qtyN : 0);
    return {
      kitchen_request_id: requestId,
      stock_item_id:      it.stock_item_id || null,
      display_name:       it.name || it[0],
      qty:                qtyN,
      unit:               it.unit || (rawQty.match(/[a-zA-Z]+\s*$/)?.[0]?.trim() || "un"),
      unit_cost:          unitCost,
      sort_order:         i,
    };
  });
  const { error: insErr } = await _client.from("kitchen_request_items").insert(itemRows);
  return { error: insErr || null };
}

async function dbUpdateKitchenRequestStatus(id, status, userId) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const update = { status };
  if (status === "separated") { update.separated_at = new Date().toISOString(); update.separated_by = userId; }
  if (status === "delivered") { update.delivered_at = new Date().toISOString(); update.delivered_by = userId; }
  const { error } = await _client.from("kitchen_requests").update(update).eq("id", id);
  return { error };
}

async function dbDeleteKitchenRequest(id) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("kitchen_requests").delete().eq("id", id);
  return { error };
}

// =====================================================================
// PURCHASE ORDERS · pedidos / listas de compras
// =====================================================================
function mapPurchaseOrderFromDb(row) {
  const items = (row.items || []).map((it) => ({
    id:            it.id,
    stock_item_id: it.stock_item_id,
    name:          it.display_name,
    qty:           Number(it.qty) || 0,
    unit:          it.unit,
    est_unit_cost: Number(it.unit_cost) || 0,
    est_cost:      Number(it.line_cost) || 0,
    received_qty:  it.received_qty,
    supplier:      row.supplier?.name,
    category:      it.category || "—",
  }));
  return {
    id:         row.id,
    code:       row.code || row.id?.slice(0, 8),
    title:      row.notes || `Lista ${row.code || ""}`.trim(),
    created_at: row.created_at,
    created_by: row.ordered_by || "—",
    status:     row.status,
    notes:      row.notes,
    supplierId: row.supplier_id,
    supplier:   row.supplier?.name,
    invoice:    row.invoice_number,
    items,
  };
}

async function dbListPurchaseOrders(tenantId) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  const { data, error } = await _client.from("purchase_orders")
    .select(`
      id, code, status, expected_delivery_date, ordered_at, received_at,
      invoice_number, total_override, notes, created_at,
      supplier_id, supplier:suppliers(id, name),
      items:purchase_order_items(id, display_name, qty, unit, unit_cost, line_cost, received_qty, stock_item_id, sort_order, reason)
    `)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  if (error) return { data: null, source: "mock", error };

  // Agrupa POs por prefixo do code (LCO-XXXXXX-FORN → LCO-XXXXXX) para mostrar
  // como UMA lista de compras com múltiplos fornecedores. POs sem prefixo ficam isolados.
  const flat = (data || []).map(mapPurchaseOrderFromDb);
  const groups = {};
  for (const po of flat) {
    const m = String(po.code || "").match(/^(LCO-[A-Z0-9]+)/i);
    const groupKey = m ? m[1] : po.id;
    if (!groups[groupKey]) {
      groups[groupKey] = {
        id: po.id,                       // id do primeiro PO (representa a lista)
        code: groupKey,
        title: po.title?.replace(/ \(.*\)$/, "") || `Lista ${groupKey}`,
        created_at: po.created_at,
        created_by: po.created_by,
        status: po.status,
        notes: po.notes,
        items: [],
        _pos: [],                        // ids dos POs que compõem essa lista (uso interno)
      };
    }
    groups[groupKey].items.push(...po.items);
    groups[groupKey]._pos.push(po.id);
    // status agregado: se algum aberto, fica aberto
    if (po.status === "draft" || po.status === "open" || po.status === "ordered") {
      groups[groupKey].status = po.status;
    }
  }
  const merged = Object.values(groups).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return { data: merged, source: "db", error: null };
}

async function dbInsertPurchaseOrder(tenantId, draft) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { items = [], supplierId, supplier, ...header } = draft;
  // Resolve supplier — se veio pelo nome, busca o id; se não existir, cria
  let supId = supplierId;
  if (!supId && supplier) {
    const { data: sup } = await _client.from("suppliers")
      .select("id").eq("tenant_id", tenantId).eq("name", supplier).maybeSingle();
    supId = sup?.id;
    if (!supId) {
      // Cria automaticamente — útil para "Sem fornecedor cadastrado" e fornecedores ad-hoc
      const { data: created, error: cErr } = await _client.from("suppliers")
        .insert({ tenant_id: tenantId, name: supplier, is_active: true })
        .select("id").single();
      if (cErr) return { data: null, error: new Error(`Erro ao criar fornecedor "${supplier}": ${cErr.message}`) };
      supId = created.id;
    }
  }
  if (!supId) return { data: null, error: new Error(`Fornecedor "${supplier}" não encontrado`) };

  const { data: row, error } = await _client.from("purchase_orders").insert({
    tenant_id:   tenantId,
    supplier_id: supId,
    code:        header.code || null,
    status:      header.status || "draft",
    notes:       header.title || header.notes || null,
  }).select().single();
  if (error) return { data: null, error };

  const itemRows = items.map((it, i) => ({
    purchase_order_id: row.id,
    stock_item_id:     it.stock_item_id || null,
    display_name:      it.name,
    qty:               Number(it.qty) || 1,
    unit:              it.unit || "un",
    unit_cost:         Number(it.est_unit_cost) || 0,
    sort_order:        i,
  }));
  if (itemRows.length > 0) {
    const { error: iErr } = await _client.from("purchase_order_items").insert(itemRows);
    if (iErr) return { data: row, error: iErr };
  }
  return { data: row, error: null };
}

async function dbDeletePurchaseOrder(id) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("purchase_orders").delete().eq("id", id);
  return { error };
}

async function dbUpdatePurchaseOrderItem(itemId, patch) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const update = {};
  if (patch.qty       !== undefined) update.qty = Number(patch.qty) || 0;
  if (patch.unit      !== undefined) update.unit = patch.unit;
  if (patch.unit_cost !== undefined) update.unit_cost = Number(patch.unit_cost) || 0;
  if (patch.name      !== undefined) update.display_name = patch.name;
  const { data, error } = await _client.from("purchase_order_items").update(update).eq("id", itemId).select().single();
  return { data, error };
}

async function dbDeletePurchaseOrderItem(itemId) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("purchase_order_items").delete().eq("id", itemId);
  return { error };
}

// =====================================================================
// GOODS RECEIPTS · recebimentos
// =====================================================================
function mapGoodsReceiptFromDb(row) {
  return {
    id:          row.id,
    code:        row.code || row.id?.slice(0, 8),
    list_id:     row.purchase_order_id,
    supplier:    row.supplier?.name,
    supplierId:  row.supplier_id,
    received_at: row.received_at,
    received_by: row.received_by_name || "—",
    nf_number:   row.nf_number,
    notes:       row.notes,
    status:      row.status,
    items: (row.items || []).map((it) => ({
      id:                it.id,
      list_item_id:      it.purchase_order_item_id,
      stock_item_id:     it.stock_item_id,
      name:              it.display_name,
      qty_ordered:       Number(it.qty_ordered) || 0,
      qty_received:      Number(it.qty_received) || 0,
      unit:              it.unit,
      unit_cost:         Number(it.unit_cost) || 0,
      line_cost:         Number(it.line_cost) || 0,
      divergent:         it.divergent,
      divergence_reason: it.divergence_reason,
    })),
  };
}

async function dbListGoodsReceipts(tenantId) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  const { data, error } = await _client.from("goods_receipts")
    .select(`
      id, code, status, nf_number, notes, received_at,
      purchase_order_id, supplier_id, supplier:suppliers(id, name),
      items:goods_receipt_items(*)
    `)
    .eq("tenant_id", tenantId)
    .order("received_at", { ascending: false });
  if (error) return { data: null, source: "mock", error };
  return { data: (data || []).map(mapGoodsReceiptFromDb), source: "db", error: null };
}

async function dbInsertGoodsReceipt(tenantId, draft) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { items = [], ...header } = draft;
  // Resolve supplier_id pelo nome
  let supId = header.supplierId;
  if (!supId && header.supplier) {
    const { data: sup } = await _client.from("suppliers")
      .select("id").eq("tenant_id", tenantId).eq("name", header.supplier).maybeSingle();
    supId = sup?.id;
  }
  if (!supId) return { data: null, error: new Error(`Fornecedor "${header.supplier}" não encontrado`) };

  // Gera REC-XXXX a partir do max(code) por tenant — ignora código vindo do FE
  // (evita colisão quando o FE conta só o array local). Faz até 5 tentativas
  // em caso de race condition na unique constraint (tenant_id, code).
  // Filtra códigos no formato REC-NNNN (1-9 dígitos) — códigos legados/maiores
  // perdem precisão em parseInt e geram loop infinito de duplicate key.
  const nextReceiptCode = async () => {
    const { data: rows } = await _client.from("goods_receipts")
      .select("code").eq("tenant_id", tenantId)
      .like("code", "REC-%");
    let max = 0;
    for (const r of rows || []) {
      const m = /^REC-(\d{1,9})$/.exec(r.code || "");
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
    return `REC-${String(max + 1).padStart(4, "0")}`;
  };

  let row = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = await nextReceiptCode();
    const { data, error } = await _client.from("goods_receipts").insert({
      tenant_id:         tenantId,
      purchase_order_id: header.list_id,
      supplier_id:       supId,
      code,
      status:            "confirmed",
      nf_number:         header.nf_number || null,
      notes:             header.notes || null,
    }).select().single();
    if (!error) { row = data; lastErr = null; break; }
    lastErr = error;
    // Retry apenas em colisão de unique key; outros erros propagam
    if (!/duplicate key|unique/i.test(error.message || "")) break;
  }
  if (!row) return { data: null, error: lastErr || new Error("Falha ao gerar código do recebimento") };

  const itemRows = items.map((it) => ({
    goods_receipt_id:       row.id,
    purchase_order_item_id: it.list_item_id || null,
    stock_item_id:          it.stock_item_id || null,
    display_name:           it.name,
    unit:                   it.unit || "un",
    qty_ordered:            Number(it.qty_ordered) || 0,
    qty_received:           Number(it.qty_received) || 0,
    unit_cost:              Number(it.unit_cost) || 0,
    divergent:              !!it.divergent,
    divergence_reason:      it.divergence_reason || null,
  }));
  if (itemRows.length > 0) {
    const { error: iErr } = await _client.from("goods_receipt_items").insert(itemRows);
    if (iErr) return { data: row, error: iErr };
  }
  return { data: row, error: null };
}

// =====================================================================
// TECH SHEETS · Fichas técnicas / Receitas
// =====================================================================
function mapTechSheetFromDb(row) {
  // Mantém id em propriedade do array para que update/delete funcionem por posição
  const items = (row.items || [])
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((it) => {
      const arr = [it.display_name, `${Number(it.qty)} ${it.unit}`, Number(it.line_cost) || 0];
      arr.id = it.id;
      arr.unitCost = Number(it.unit_cost) || 0;
      arr.qty = Number(it.qty) || 0;
      arr.unit = it.unit;
      return arr;
    });
  const cost = items.reduce((s, it) => s + Number(it[2] || 0), 0);
  const cmv = row.sale_price > 0 ? (cost / Number(row.sale_price)) * 100 : 0;
  return {
    id:    row.id,
    code:  row.code,
    op:    row.operation?.slug || row.operation_id,
    operationId: row.operation_id,
    cat:   row.notes?.match(/^cat:(\w+)/)?.[1] || "outro",
    name:  row.name,
    price: Number(row.sale_price) || 0,
    theo:  cost,
    cmv:   Number(cmv.toFixed(1)),
    yieldQty:  Number(row.yield_qty) || 1,
    yieldUnit: row.yield_unit,
    notes: row.notes,
    items, // formato [[name, "X kg", cost], ...]
  };
}

async function dbListTechSheets(tenantId) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  const { data, error } = await _client.from("tech_sheets")
    .select(`
      id, code, name, sale_price, yield_qty, yield_unit, notes, is_active,
      operation_id, operation:operations(id, slug, name),
      items:tech_sheet_items(id, display_name, qty, unit, unit_cost, line_cost, stock_item_id, sort_order)
    `)
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("name", { ascending: true });
  if (error) return { data: null, source: "mock", error };
  return { data: (data || []).map(mapTechSheetFromDb), source: "db", error: null };
}

// =====================================================================
// PREPARATIONS · CRUD
// =====================================================================
async function dbListPreparations(tenantId) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  const { data, error } = await _client.from("preparations")
    .select(`
      id, code, name, operation_id, category_id, yield_qty, yield_unit, notes,
      operation:operations(slug),
      category:recipe_categories(name),
      items:preparation_items!preparation_id(id, name, qty, unit, unit_cost, total_cost, stock_item_id, source_prep_id, sort_order)
    `)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  if (error) return { data: null, source: "mock", error };
  return {
    data: (data || []).map((r) => {
      const items = (r.items || [])
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((it) => {
          const arr = [it.name, `${Number(it.qty)} ${it.unit}`, Number(it.total_cost) || 0];
          arr.id = it.id;
          arr.stockItemId = it.stock_item_id;
          arr.unitCost = Number(it.unit_cost) || 0;
          arr.qty = Number(it.qty) || 0;
          arr.unit = it.unit;
          return arr;
        });
      const theo = items.reduce((s, it) => s + Number(it[2] || 0), 0);
      const yieldQty = Number(r.yield_qty) || 1;
      return {
        id: r.id, code: r.code, name: r.name,
        op: r.operation_id, opSlug: r.operation?.slug,
        cat: r.category_id, catName: r.category?.name,
        yieldQty, yieldUnit: r.yield_unit,
        notes: r.notes, items,
        theo,
        unitCost: yieldQty > 0 ? theo / yieldQty : 0,
      };
    }),
    source: "db", error: null,
  };
}

async function dbInsertPreparation(tenantId, draft) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  let operationId = draft.operationId || (isUuid(draft.op) ? draft.op : null);
  if (!operationId && draft.op) {
    const { data: op } = await _client.from("operations")
      .select("id").eq("tenant_id", tenantId).eq("slug", draft.op).maybeSingle();
    operationId = op?.id;
  }
  const { data, error } = await _client.from("preparations").insert({
    tenant_id:    tenantId,
    operation_id: operationId,
    code:         draft.code || null,
    name:         draft.name,
    category_id:  isUuid(draft.cat) ? draft.cat : null,
    yield_qty:    Number(draft.yieldQty) || 1,
    yield_unit:   draft.yieldUnit || "kg",
    notes:        draft.notes || null,
  }).select().single();
  return { data, error };
}

async function dbUpdatePreparation(id, patch) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const update = {};
  if (patch.name      !== undefined) update.name = patch.name;
  if (patch.yieldQty  !== undefined) update.yield_qty = Number(patch.yieldQty) || 1;
  if (patch.yieldUnit !== undefined) update.yield_unit = patch.yieldUnit;
  if (patch.notes     !== undefined) update.notes = patch.notes;
  const { data, error } = await _client.from("preparations").update(update).eq("id", id).select().single();
  return { data, error };
}

async function dbRecomputeAllCosts(tenantId) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { data, error } = await _client.rpc("recompute_all_costs", { p_tenant: tenantId });
  return { data, error };
}

async function dbDeletePreparation(id) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("preparations").delete().eq("id", id);
  return { error };
}

async function dbInsertPreparationItem(preparationId, ingredient, sortOrder = 0) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const [name, qtyText, lineCost] = Array.isArray(ingredient) ? ingredient : [ingredient.name, ingredient.qtyText, ingredient.cost];
  const m = String(qtyText || "").match(/([\d,.]+)\s*(.*)/);
  const qty = m ? parseFloat(m[1].replace(",", ".")) || 0 : 0;
  const unit = m ? (m[2] || "kg").trim() : "kg";
  const totalCost = Number(lineCost) || 0;
  const unitCost = qty > 0 ? totalCost / qty : 0;
  const { data, error } = await _client.from("preparation_items").insert({
    preparation_id: preparationId,
    stock_item_id:  ingredient.stockItemId || null,
    source_prep_id: ingredient.sourcePrepId || null,
    name, qty, unit, unit_cost: unitCost, total_cost: totalCost,
    sort_order: sortOrder,
  }).select().single();
  return { data, error };
}

async function dbUpdatePreparationItem(itemId, patch) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const updates = {};
  if (patch.name != null) updates.name = patch.name;
  if (patch.qty != null) updates.qty = Number(patch.qty);
  if (patch.unit != null) updates.unit = patch.unit;
  if (patch.unitCost != null) {
    updates.unit_cost = Number(patch.unitCost);
    if (patch.qty != null) updates.total_cost = Number(patch.qty) * Number(patch.unitCost);
  }
  const { error } = await _client.from("preparation_items").update(updates).eq("id", itemId);
  return { error };
}

async function dbDeletePreparationItem(itemId) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("preparation_items").delete().eq("id", itemId);
  return { error };
}

async function dbInsertTechSheet(tenantId, draft) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { items = [], ...header } = draft;
  // Resolve operation_id: aceita id (uuid) direto ou slug
  let operationId = header.operationId;
  const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  if (!operationId && header.op) {
    if (isUuid(header.op)) {
      operationId = header.op;
    } else {
      const { data: op } = await _client.from("operations")
        .select("id").eq("tenant_id", tenantId).eq("slug", header.op).maybeSingle();
      operationId = op?.id;
    }
  }
  if (!operationId) return { data: null, error: new Error(`Operação "${header.op}" não encontrada`) };

  const { data: row, error } = await _client.from("tech_sheets").insert({
    tenant_id:    tenantId,
    operation_id: operationId,
    code:         header.code || null,
    name:         header.name,
    sale_price:   Number(header.price) || 0,
    yield_qty:    Number(header.yieldQty) || 1,
    yield_unit:   header.yieldUnit || "un",
    notes:        header.cat ? `cat:${header.cat}` : header.notes,
  }).select().single();
  if (error) return { data: null, error };

  const itemRows = items.map((it, i) => {
    // Mock format: [name, "X kg", cost]
    const [name, qtyText, lineCost] = Array.isArray(it) ? it : [it.name, it.qtyText, it.cost];
    const m = String(qtyText || "").match(/([\d,.]+)\s*(.*)/);
    const qty  = m ? parseFloat(m[1].replace(",", ".")) || 0 : 0;
    const unit = m ? (m[2] || "un").trim() : "un";
    const totalCost = Number(lineCost) || 0;
    const unitCost = qty > 0 ? totalCost / qty : 0;
    return {
      tech_sheet_id: row.id,
      stock_item_id: it.stock_item_id || null,
      display_name:  name,
      qty,
      unit,
      unit_cost:     unitCost,
      sort_order:    i,
    };
  });
  if (itemRows.length > 0) {
    const { error: iErr } = await _client.from("tech_sheet_items").insert(itemRows);
    if (iErr) return { data: row, error: iErr };
  }
  return { data: row, error: null };
}

async function dbUpdateTechSheet(id, patch) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const update = {};
  if (patch.name      !== undefined) update.name = patch.name;
  if (patch.price     !== undefined) update.sale_price = Number(patch.price) || 0;
  if (patch.yieldQty  !== undefined) update.yield_qty = Number(patch.yieldQty) || 1;
  if (patch.yieldUnit !== undefined) update.yield_unit = patch.yieldUnit;
  if (patch.notes     !== undefined) update.notes = patch.notes;
  const { data, error } = await _client.from("tech_sheets").update(update).eq("id", id).select().single();
  return { data, error };
}

async function dbDeleteTechSheet(id) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("tech_sheets").update({ is_active: false }).eq("id", id);
  return { error };
}

async function dbInsertTechSheetItem(techSheetId, item, sortOrder = 0) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const [name, qtyText, cost] = Array.isArray(item) ? item : [item.name, item.qtyText, item.cost];
  const m = String(qtyText || "").match(/([\d,.]+)\s*(.*)/);
  const qty = m ? parseFloat(m[1].replace(",", ".")) || 0 : 0;
  const unit = m ? (m[2] || "un").trim() : "un";
  const unitCost = qty > 0 ? (Number(cost) || 0) / qty : 0;
  const { data, error } = await _client.from("tech_sheet_items").insert({
    tech_sheet_id: techSheetId,
    stock_item_id: item.stock_item_id || item.stockItemId || null,
    source_prep_id: item.source_prep_id || item.sourcePrepId || null,
    display_name:  name,
    qty,
    unit,
    unit_cost:     unitCost,
    sort_order:    sortOrder,
  }).select().single();
  return { data, error };
}

async function dbUpdateTechSheetItem(itemId, patch) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const update = {};
  if (patch.name         !== undefined) update.display_name = patch.name;
  if (patch.qty          !== undefined) update.qty = Number(patch.qty) || 0;
  if (patch.unit         !== undefined) update.unit = patch.unit;
  if (patch.unitCost     !== undefined) update.unit_cost = Number(patch.unitCost) || 0;
  if (patch.stock_item_id !== undefined) update.stock_item_id = patch.stock_item_id;
  const { data, error } = await _client.from("tech_sheet_items").update(update).eq("id", itemId).select().single();
  return { data, error };
}

async function dbDeleteTechSheetItem(itemId) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("tech_sheet_items").delete().eq("id", itemId);
  return { error };
}

// =====================================================================
// INVENTORIES · sessões de inventário físico (Fase 11 do schema)
// =====================================================================
function mapInventoryFromDb(row) {
  return {
    id:           row.id,
    started_at:   row.started_at,
    finished_at:  row.finished_at,
    responsible:  row.responsible_name || "—",
    role:         row.responsible_role || null,
    status:       row.status,
    categories:   row.scope_categories || [],
    score:        Number(row.score) || 0,
    financialImpact: Number(row.financial_impact) || 0,
    items: (row.items || []).map((it) => ({
      stock_item_id: it.stock_item_id,
      name:          it.display_name,
      cat:           it.category_name,
      unit:          it.unit,
      expected:      Number(it.expected_qty) || 0,
      counted:       it.counted_qty != null ? Number(it.counted_qty) : null,
      cost:          Number(it.unit_cost) || 0,
    })),
  };
}

async function dbListInventories(tenantId) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  const { data, error } = await _client.from("inventory_sessions")
    .select(`
      id, started_at, finished_at, status, score, financial_impact,
      scope_categories, responsible_name, responsible_role,
      items:inventory_session_items(*)
    `)
    .eq("tenant_id", tenantId)
    .order("started_at", { ascending: false });
  if (error) return { data: null, source: "mock", error };
  return { data: (data || []).map(mapInventoryFromDb), source: "db", error: null };
}

async function dbInsertInventory(tenantId, draft) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { items = [], ...header } = draft;
  const { data: row, error } = await _client.from("inventory_sessions").insert({
    tenant_id:        tenantId,
    started_at:       header.started_at || new Date().toISOString(),
    finished_at:      header.finished_at || null,
    status:           header.status || "in_progress",
    score:            header.score ?? null,
    financial_impact: header.financialImpact ?? null,
    scope_categories: header.categories || [],
    responsible_name: header.responsible || "—",
    responsible_role: header.role || null,
  }).select().single();
  if (error) return { data: null, error };

  const itemRows = items.map((it) => ({
    inventory_session_id: row.id,
    stock_item_id:        it.stock_item_id || null,
    display_name:         it.name,
    category_name:        it.cat || null,
    unit:                 it.unit,
    expected_qty:         Number(it.expected) || 0,
    counted_qty:          it.counted != null ? Number(it.counted) : null,
    unit_cost:            Number(it.cost) || 0,
  }));
  if (itemRows.length > 0) {
    const { error: iErr } = await _client.from("inventory_session_items").insert(itemRows);
    if (iErr) return { data: row, error: iErr };
  }

  // Quando o inventário é finalizado, gera movimentos `adjust` p/ cada item contado
  // cujo valor diverge do esperado. O trigger app.tg_apply_stock_movement atualiza
  // stock_items.current_qty automaticamente.
  if (header.status === "finalized") {
    const adjustments = items
      .filter((it) => it.stock_item_id && it.counted != null)
      .map((it) => ({
        stock_item_id: it.stock_item_id,
        delta: Number(it.counted) - Number(it.expected || 0),
        cost: Number(it.cost) || 0,
      }))
      .filter((a) => a.delta !== 0);

    for (const a of adjustments) {
      const payload = {
        tenant_id: tenantId,
        stock_item_id: a.stock_item_id,
        kind: "adjust",
        qty: a.delta, // sinal preservado (negativo = falta, positivo = sobra)
        notes: `inventory:${row.id}`,
        reference_type: "closing_count",
        reference_id: row.id,
      };
      if (a.cost > 0) payload.unit_cost = a.cost;
      const { error: mErr } = await _client.from("stock_movements").insert(payload);
      if (mErr) {
        return { data: row, error: new Error(`Movimento de ajuste falhou para item ${a.stock_item_id}: ${mErr.message}`) };
      }
    }
  }

  return { data: row, error: null };
}

// Atualiza uma sessão de inventário existente (usado pelo botão "Continuar").
// Substitui os items por completo (delete + insert) e, se status='finalized',
// gera os mesmos ajustes de estoque que o insert.
async function dbUpdateInventory(tenantId, sessionId, draft) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { items = [], ...header } = draft;

  const { data: row, error } = await _client.from("inventory_sessions").update({
    finished_at:      header.finished_at || null,
    status:           header.status || "in_progress",
    score:            header.score ?? null,
    financial_impact: header.financialImpact ?? null,
    scope_categories: header.categories || [],
    responsible_name: header.responsible || "—",
    responsible_role: header.role || null,
  }).eq("id", sessionId).eq("tenant_id", tenantId).select().single();
  if (error) return { data: null, error };

  const { error: delErr } = await _client.from("inventory_session_items")
    .delete().eq("inventory_session_id", sessionId);
  if (delErr) return { data: row, error: delErr };

  const itemRows = items.map((it) => ({
    inventory_session_id: sessionId,
    stock_item_id:        it.stock_item_id || null,
    display_name:         it.name,
    category_name:        it.cat || null,
    unit:                 it.unit,
    expected_qty:         Number(it.expected) || 0,
    counted_qty:          it.counted != null ? Number(it.counted) : null,
    unit_cost:            Number(it.cost) || 0,
  }));
  if (itemRows.length > 0) {
    const { error: iErr } = await _client.from("inventory_session_items").insert(itemRows);
    if (iErr) return { data: row, error: iErr };
  }

  if (header.status === "finalized") {
    const adjustments = items
      .filter((it) => it.stock_item_id && it.counted != null)
      .map((it) => ({
        stock_item_id: it.stock_item_id,
        delta: Number(it.counted) - Number(it.expected || 0),
        cost: Number(it.cost) || 0,
      }))
      .filter((a) => a.delta !== 0);

    for (const a of adjustments) {
      const payload = {
        tenant_id: tenantId,
        stock_item_id: a.stock_item_id,
        kind: "adjust",
        qty: a.delta,
        notes: `inventory:${sessionId}`,
        reference_type: "closing_count",
        reference_id: sessionId,
      };
      if (a.cost > 0) payload.unit_cost = a.cost;
      const { error: mErr } = await _client.from("stock_movements").insert(payload);
      if (mErr) {
        return { data: row, error: new Error(`Movimento de ajuste falhou para item ${a.stock_item_id}: ${mErr.message}`) };
      }
    }
  }

  return { data: row, error: null };
}

// =====================================================================
// MEMBERS · multi-user management (Fase 12)
// =====================================================================
function mapMemberFromDb(row) {
  const ROLE_LABELS = {
    owner: "Super Admin", manager: "Gestor de marca", kitchen: "Operador cozinha",
    stock: "Estoquista", accountant: "Contador", viewer: "Visualização"
  };
  return {
    userId: row.user_id, email: row.email, name: row.full_name || row.email,
    role: ROLE_LABELS[row.role] || row.role, dbRole: row.role,
    ops: row.ops || [],
    modules: Array.isArray(row.modules) ? row.modules : null,
    joinedAt: row.joined_at,
  };
}

async function dbListMembers(tenantId) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  const { data, error } = await _client
    .from("tenant_member_profiles")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("joined_at", { ascending: true });
  if (error) return { data: null, source: "mock", error };
  return { data: data.map(mapMemberFromDb), source: "db", error: null };
}

async function dbInviteMember(tenantId, { email, password, role, ops, modules, name }) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  try {
    const { data: { session } } = await _client.auth.getSession();
    if (!session) return { data: null, error: new Error("Não autenticado") };
    const url = window.SK_CONFIG?.supabaseUrl + "/functions/v1/invite-member";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + session.access_token,
      },
      body: JSON.stringify({ tenantId, email, password, role, ops, modules, name }),
    });
    const rawBody = await res.text();
    let json = null;
    try { json = rawBody ? JSON.parse(rawBody) : null; } catch (_) { /* non-JSON */ }
    if (!res.ok) {
      const detail = json?.error || rawBody || res.statusText || "sem mensagem";
      return { data: null, error: new Error(`[${res.status}] ${detail}`) };
    }
    return { data: json, error: null };
  } catch (e) {
    return { data: null, error: e };
  }
}

// Update único de membro (role/ops/modules em tenant_members + full_name em profiles).
// Roteia pelo edge function `update-member` (service_role) — bypassa RLS de profiles
// e evita roundtrips separados que silenciavam por policy.
async function dbUpdateMember(tenantId, userId, patch) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  try {
    const { data: { session } } = await _client.auth.getSession();
    if (!session) return { error: new Error("Não autenticado") };
    const url = window.SK_CONFIG?.supabaseUrl + "/functions/v1/update-member";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + session.access_token,
      },
      body: JSON.stringify({ tenantId, userId, ...patch }),
    });
    const raw = await res.text();
    let json = null; try { json = raw ? JSON.parse(raw) : null; } catch (_) { /* non-json */ }
    if (!res.ok) {
      const detail = json?.error || raw || res.statusText || "sem mensagem";
      return { error: new Error(`[${res.status}] ${detail}`) };
    }
    return { error: null, data: json };
  } catch (e) {
    return { error: e };
  }
}

// Wrappers de compat — chamam dbUpdateMember por baixo
async function dbUpdateMemberProfile(userId, { name }, tenantId) {
  return dbUpdateMember(tenantId, userId, { name });
}
async function dbUpdateMemberRole(userId, tenantId, { role, ops, modules }) {
  return dbUpdateMember(tenantId, userId, { role, ops, modules });
}

async function dbRemoveMember(userId, tenantId) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client
    .from("tenant_members")
    .delete()
    .eq("user_id", userId)
    .eq("tenant_id", tenantId);
  return { error };
}

// =====================================================================
// FINANCE/DRE · categories, subcategories, entries, closing checklist (Fase 12)
// =====================================================================
function financePeriodRange(period) {
  const [y, m] = String(period || "").split("-").map((n) => parseInt(n, 10));
  if (!y || !m) return null;
  const mm = String(m).padStart(2, "0");
  const start = `${y}-${mm}-01`;
  const endDay = new Date(y, m, 0).getDate();
  const end = `${y}-${mm}-${String(endDay).padStart(2, "0")}`;
  return { start, end };
}

function mapFinanceEntryFromDb(row) {
  const comp = row.competence_date;
  const paid = row.payment_date ?? row.paid_date;
  return {
    id: row.code || row.id,
    cat: row.subcategory_id || row.category_id,
    desc: row.description,
    value: Number(row.value ?? row.amount) || 0,
    comp: comp ? String(comp).slice(0, 10) : null,
    paid: paid ? String(paid).slice(0, 10) : null,
    status: row.status,
    auto: row.auto_source || row.auto || undefined,
    checklistItemId: row.checklist_item_id || null,
  };
}

function mapClosingChecklistFromDb(row) {
  // Templates de checklist: o STATUS é derivado no cliente por competência,
  // não vindo da view (que conta todas as entries de qualquer mês).
  return {
    id:         row.id,
    // Front usa `cat` como id da SUBCATEGORIA DRE (cor/nome na linha).
    // Cai pro category_id se a subcategoria não estiver associada.
    cat:        row.subcategory_id || row.category_id || null,
    categoryId: row.category_id || null,
    label:      row.label,
    recurrence: row.recurrence || "monthly",
    due:        row.due_day ?? null,
    owner:      row.owner_role || "",
    status:     "pending",   // recomputado em Finance com base nos entries do período
    expected:   Number(row.expected_amount) || 0,
    actual:     null,         // idem
    entryIds:   [],           // idem
    required:   row.is_required ?? true,
    source:     row.source || "",
    formula:    row.formula || "",
    // Mês a partir do qual o item passa a aparecer no checklist (YYYY-MM).
    // Derivado de created_at — itens criados em maio não retroagem pra abril.
    startPeriod: row.created_at ? String(row.created_at).slice(0, 7) : null,
  };
}

// Snapshots de valor de estoque (alimentado pelo cron diário)
async function dbGetStockValueSnapshots(tenantId, period) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  const { data, error } = await _client.from("stock_value_snapshots")
    .select("period, kind, total_value, items_count, snapshot_at")
    .eq("tenant_id", tenantId)
    .eq("period", period);
  if (error) return { data: null, source: "mock", error };
  const result = { initial: 0, final: 0, initialAt: null, finalAt: null };
  (data || []).forEach((s) => {
    result[s.kind] = Number(s.total_value) || 0;
    result[`${s.kind}At`] = s.snapshot_at;
  });
  return { data: result, source: "db", error: null };
}

async function dbListDreCategories(tenantId) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  const { data, error } = await _client
    .from("dre_categories")
    .select("*, group:dre_groups(slug, label, sign, is_subtotal)")
    .eq("tenant_id", tenantId)
    .order("sort_order", { ascending: true });
  if (error) return { data: null, source: "mock", error };
  // Mapeia "kind" a partir do slug do grupo para o front (que espera c.kind)
  // Front conhece: revenue, deduction, cogs, expense, financial
  const SLUG_TO_KIND = {
    revenue: "revenue",
    deductions: "deduction",
    cmv: "cogs",
    fixed_expenses: "expense",
    personnel: "expense",
    operational: "expense",
    logistics: "expense",
    financial: "financial",
    owner: "expense",
  };
  const mapped = (data || []).map((c) => ({
    ...c,
    kind: SLUG_TO_KIND[c.group?.slug] || "expense",
    groupSlug: c.group?.slug,
    sign: c.group?.sign,
    isSubtotal: c.group?.is_subtotal,
    order: c.sort_order ?? 99, // front usa c.order
  }));
  return { data: mapped, source: "db", error: null };
}

async function dbListDreSubcategories(tenantId) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  const { data, error } = await _client
    .from("dre_subcategories")
    .select("*, category:dre_categories(id, name, color, group_id)")
    .eq("tenant_id", tenantId)
    .order("sort_order", { ascending: true });
  if (error) return { data: null, source: "mock", error };
  // Mapeia "category" para apontar para o id (front usa sub.category como id da categoria pai)
  const mapped = (data || []).map((s) => ({
    ...s,
    category: s.category_id,
    categoryName: s.category?.name,
    order: s.sort_order ?? 99,
    label: s.name,
  }));
  return { data: mapped, source: "db", error: null };
}

async function dbListFinanceEntries(tenantId, period) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  const range = financePeriodRange(period);
  if (!range) return { data: [], source: "db", error: null };

  const { data, error } = await _client
    .from("finance_entries")
    .select("*, subcategory:dre_subcategories(id, name, category_id)")
    .eq("tenant_id", tenantId)
    .gte("competence_date", range.start)
    .lte("competence_date", range.end)
    .order("competence_date", { ascending: false });

  if (error) return { data: null, source: "mock", error };
  return { data: (data || []).map(mapFinanceEntryFromDb), source: "db", error: null };
}

async function dbInsertFinanceEntry(tenantId, draft) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { data, error } = await _client.from("finance_entries").insert({
    tenant_id:         tenantId,
    subcategory_id:    draft.cat,
    description:       draft.desc || "",
    value:             Number(draft.value) || 0,
    competence_date:   draft.comp,
    payment_date:      draft.paid || null,
    status:            draft.status || "pending",
    notes:             draft.notes || null,
    checklist_item_id: draft.checklistItemId || null,
  }).select().single();
  return { data, error };
}

async function dbUpdateFinanceEntry(id, patch) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const update = {};
  if (patch.desc !== undefined) update.description = patch.desc;
  if (patch.value !== undefined) update.value = Number(patch.value);
  if (patch.comp !== undefined) update.competence_date = patch.comp;
  if (patch.paid !== undefined) update.payment_date = patch.paid;
  if (patch.status !== undefined) update.status = patch.status;
  const { data, error } = await _client
    .from("finance_entries")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  return { data, error };
}

async function dbDeleteFinanceEntry(id) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("finance_entries").delete().eq("id", id);
  return { error };
}

async function dbListClosingChecklist(tenantId, _period) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  // Lemos da view pra obter actual_amount + derived_status (filled/estimated/pending)
  // calculados a partir de finance_entries linkados via checklist_item_id.
  // `_period` mantido por compat com chamadores; checklist canonical é template
  // recorrente, não por competência.
  const { data, error } = await _client
    .from("v_closing_checklist")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("sort_order", { ascending: true });
  if (error) return { data: null, source: "mock", error };
  return { data: (data || []).map(mapClosingChecklistFromDb), source: "db", error: null };
}

async function dbUpdateClosingChecklistItem(id, patch) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const update = {};
  if (patch.label !== undefined)      update.label = String(patch.label).trim();
  if (patch.recurrence !== undefined) update.recurrence = patch.recurrence;
  if (patch.due !== undefined)        update.due_day = patch.due == null ? null : Number(patch.due);
  if (patch.owner !== undefined)      update.owner_role = patch.owner || null;
  if (patch.expected !== undefined)   update.expected_amount = Number(patch.expected) || 0;
  if (patch.required !== undefined)   update.is_required = !!patch.required;
  if (patch.source !== undefined)     update.source = patch.source || null;
  if (patch.formula !== undefined)    update.formula = patch.formula || null;
  if (patch.cat !== undefined && patch.cat) {
    // `cat` no front é subcategory_id; armazenamos como subcategory_id e
    // resolvemos o category_id pai (NOT NULL).
    const { data: sub } = await _client.from("dre_subcategories")
      .select("category_id").eq("id", patch.cat).maybeSingle();
    if (!sub?.category_id) return { error: new Error("Subcategoria inválida") };
    update.category_id = sub.category_id;
    update.subcategory_id = patch.cat;
  }
  if (Object.keys(update).length === 0) return { error: null };
  const { error } = await _client.from("closing_checklist_items").update(update).eq("id", id);
  return { error };
}

async function dbInsertClosingChecklistItem(tenantId, draft /*, period */) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  // closing_checklist_items.category_id é NOT NULL (DRE category).
  // Front guarda subcategoria em draft.cat — armazenamos como subcategory_id
  // e resolvemos o category_id pai para satisfazer o NOT NULL.
  let categoryId = null;
  if (draft.cat) {
    const { data: sub } = await _client.from("dre_subcategories")
      .select("category_id").eq("id", draft.cat).maybeSingle();
    categoryId = sub?.category_id || null;
  }
  if (!categoryId) {
    return { data: null, error: new Error("Selecione uma subcategoria válida (categoria DRE não encontrada)") };
  }
  const { data, error } = await _client.from("closing_checklist_items").insert({
    tenant_id:       tenantId,
    category_id:     categoryId,
    subcategory_id:  draft.cat,
    label:           String(draft.label || "").trim(),
    recurrence:      draft.recurrence || "monthly",
    due_day:         draft.due == null ? null : Number(draft.due),
    owner_role:      draft.owner || null,
    expected_amount: Number(draft.expected) || 0,
    is_required:     draft.required ?? true,
    source:          draft.source || null,
    formula:         draft.formula || null,
    sort_order:      draft.sort_order ?? 99,
  }).select().single();
  return { data, error };
}

async function dbDeleteClosingChecklistItem(id) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("closing_checklist_items").delete().eq("id", id);
  return { error };
}

// =====================================================================
// CLOSING PERIODS · meses formalmente fechados
// =====================================================================

async function dbListClosedPeriods(tenantId, { fromPeriod, toPeriod } = {}) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  let q = _client.from("closing_periods")
    .select("id, period, closed_at, closed_by, notes")
    .eq("tenant_id", tenantId)
    .order("period", { ascending: false });
  if (fromPeriod) q = q.gte("period", fromPeriod);
  if (toPeriod)   q = q.lte("period", toPeriod);
  const { data, error } = await q;
  if (error) return { data: null, source: "mock", error };
  return { data: data || [], source: "db", error: null };
}

async function dbClosePeriod(tenantId, period, { notes } = {}) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { data: session } = await _client.auth.getUser();
  const userId = session?.user?.id || null;
  const { data, error } = await _client.from("closing_periods").insert({
    tenant_id: tenantId,
    period,
    closed_by: userId,
    notes: notes || null,
  }).select().single();
  return { data, error };
}

async function dbReopenPeriod(tenantId, period) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("closing_periods")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("period", period);
  return { error };
}

async function dbInsertDreCategory(tenantId, { name, color }) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { data, error } = await _client
    .from("dre_categories")
    .insert({ tenant_id: tenantId, name, color })
    .select()
    .single();
  return { data, error };
}

async function dbInsertDreSubcategory(tenantId, { categoryId, name, color, autofeed }) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const { data, error } = await _client
    .from("dre_subcategories")
    .insert({ tenant_id: tenantId, category_id: categoryId, name, color, autofeed })
    .select()
    .single();
  return { data, error };
}

async function dbDeleteDreCategory(id) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("dre_categories").delete().eq("id", id);
  return { error };
}

async function dbDeleteDreSubcategory(id) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("dre_subcategories").delete().eq("id", id);
  return { error };
}

// =====================================================================
// CMV · daily CMV por operação + top consumed items
// =====================================================================
async function dbListCmvDaily(tenantId, fromDate, toDate) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  const { data, error } = await _client
    .from("revenue_entries")
    .select("business_date, operation_id, cogs, operation:operations(slug), revenue_payment_breakdown(amount)")
    .eq("tenant_id", tenantId)
    .gte("business_date", fromDate)
    .lte("business_date", toDate);
  if (error) return { data: null, source: "mock", error };

  const grouped = {};
  for (const row of data || []) {
    const key = `${row.business_date}|${row.operation?.slug}`;
    if (!grouped[key]) {
      grouped[key] = { date: row.business_date, op: row.operation?.slug, revenue: 0, cogs: 0 };
    }
    grouped[key].cogs += Number(row.cogs) || 0;
    grouped[key].revenue += (row.revenue_payment_breakdown || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  }
  return { data: Object.values(grouped), source: "db", error: null };
}

async function dbTopConsumedItems(tenantId, fromDate, toDate, limit = 10) {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  const { data, error } = await _client
    .from("stock_movements")
    .select("stock_item_id, qty, stock_item:stock_items(name, unit, unit_cost)")
    .eq("tenant_id", tenantId)
    .eq("kind", "out")
    .gte("created_at", fromDate)
    .lte("created_at", toDate);
  if (error) return { data: null, source: "mock", error };

  // `kind='out'` grava qty negativa (schema constraint). Pra consumo, usamos
  // valor absoluto — assim o sort DESC traz o MAIOR consumo primeiro, em vez de
  // ordenar pelo "menos negativo" (que aparecia como -R$ 1,29 no topo).
  const agg = {};
  for (const mv of data || []) {
    const id = mv.stock_item_id;
    if (!agg[id]) {
      agg[id] = { name: mv.stock_item?.name, unit: mv.stock_item?.unit, totalQty: 0, totalCost: 0 };
    }
    const qtyAbs = Math.abs(Number(mv.qty) || 0);
    agg[id].totalQty += qtyAbs;
    agg[id].totalCost += qtyAbs * (Number(mv.stock_item?.unit_cost) || 0);
  }
  const sorted = Object.values(agg).sort((a, b) => b.totalCost - a.totalCost);
  return { data: sorted.slice(0, limit), source: "db", error: null };
}

// =====================================================================
// STORAGE · upload e URL de evidências (bucket: evidence-photos)
// Path convention: {tenantId}/{executionId}/{timestamp}_{filename}
// =====================================================================
async function dbUploadEvidence(tenantId, executionId, file) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const ext  = file.name?.split(".").pop() || "jpg";
  const path = `${tenantId}/${executionId || "misc"}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const { data, error } = await _client.storage
    .from("evidence-photos")
    .upload(path, file, { contentType: file.type || "image/jpeg", upsert: false });
  if (error) return { data: null, error };
  return { data: { path: data.path }, error: null };
}

async function dbGetSignedUrl(path, expiresInSeconds = 3600) {
  if (!isDbOnline() || !_client) return null;
  const { data } = await _client.storage
    .from("evidence-photos")
    .createSignedUrl(path, expiresInSeconds);
  return data?.signedUrl || null;
}

// =====================================================================
// REALTIME · subscriptions por tabela + tenant
// Retorna função de cancelamento (call pra unsubscribe).
// =====================================================================
function dbSubscribeTable(table, tenantId, callback, event = "*") {
  if (!_client) return () => {};
  const channel = _client
    .channel(`rt-${table}-${tenantId}-${Date.now()}`)
    .on(
      "postgres_changes",
      { event, schema: "public", table, filter: `tenant_id=eq.${tenantId}` },
      (payload) => {
        try { callback(payload); } catch (e) { console.warn("[realtime]", e); }
      },
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") console.info(`[realtime] ${table} online`);
    });
  return () => { _client.removeChannel(channel); };
}

// =====================================================================
// SUPERADMIN · CRUD global de tenants (painel /admin)
// =====================================================================
// Depende das policies de phase-15-tenant-admin.sql:
//   profiles.is_superadmin = true → SELECT/INSERT/UPDATE/DELETE em tenants
//
// Provisionamento completo (tenant + owner + seeds) continua via edge
// function `provision-tenant` que cria auth.users e popula payment_methods
// + stock_categories iniciais. Updates simples e exclusões usam DB direto.

async function dbListTenantsAdmin() {
  if (!isDbOnline() || !_client) return { data: null, source: "mock", error: null };
  const { data, error } = await _client
    .from("tenants")
    .select("id, slug, name, legal_name, cnpj, plan, status, trial_ends_at, created_at, updated_at")
    .order("created_at", { ascending: false });
  if (error) return { data: null, source: "mock", error };

  // Anota cada tenant com contagem de members + email/nome do owner.
  // Faz em um único select por relação pra evitar N+1.
  const ids = (data || []).map((t) => t.id);
  let membersByTenant = {};
  if (ids.length) {
    const { data: members } = await _client
      .from("tenant_members")
      .select("tenant_id, user_id, role")
      .in("tenant_id", ids);
    (members || []).forEach((m) => {
      if (!membersByTenant[m.tenant_id]) membersByTenant[m.tenant_id] = [];
      membersByTenant[m.tenant_id].push(m);
    });
  }
  // Resolve nomes/emails dos owners
  const ownerIds = Array.from(new Set(
    Object.values(membersByTenant).flat().filter((m) => m.role === "owner").map((m) => m.user_id),
  ));
  let profilesById = {};
  if (ownerIds.length) {
    const { data: profs } = await _client
      .from("profiles")
      .select("id, full_name")
      .in("id", ownerIds);
    (profs || []).forEach((p) => { profilesById[p.id] = p; });
  }
  const enriched = (data || []).map((t) => {
    const ms = membersByTenant[t.id] || [];
    const owner = ms.find((m) => m.role === "owner");
    return {
      ...t,
      usersCount: ms.length,
      ownerName: owner ? (profilesById[owner.user_id]?.full_name || null) : null,
      ownerUserId: owner?.user_id || null,
    };
  });
  return { data: enriched, source: "db", error: null };
}

// Cria tenant + owner via edge function provision-tenant (usa SERVICE_ROLE).
// Convida o owner por email e dispara seeds (payment_methods, stock_categories).
async function dbProvisionTenant({ name, slug, plan, ownerEmail, ownerName, ownerPassword }) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  try {
    const { data: { session } } = await _client.auth.getSession();
    if (!session) return { data: null, error: new Error("Não autenticado") };
    const url = window.SK_CONFIG?.supabaseUrl + "/functions/v1/provision-tenant";
    const payload = { name, slug, plan, ownerEmail, ownerName };
    if (ownerPassword) payload.ownerPassword = ownerPassword;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + session.access_token,
      },
      body: JSON.stringify(payload),
    });
    const raw = await res.text();
    let json = null; try { json = raw ? JSON.parse(raw) : null; } catch (_) { /* non-json */ }
    if (!res.ok) {
      const detail = json?.error || raw || res.statusText || "sem mensagem";
      return { data: null, error: new Error(`[${res.status}] ${detail}`) };
    }
    return { data: json, error: null };
  } catch (e) {
    return { data: null, error: e };
  }
}

// Atualiza campos editáveis de um tenant (RLS exige is_superadmin).
async function dbUpdateTenantAdmin(id, patch) {
  if (!isDbOnline() || !_client) return { data: null, error: new Error("DB offline") };
  const update = {};
  if (patch.name       !== undefined) update.name = patch.name;
  if (patch.slug       !== undefined) update.slug = patch.slug;
  if (patch.legal_name !== undefined) update.legal_name = patch.legal_name;
  if (patch.cnpj       !== undefined) update.cnpj = patch.cnpj;
  if (patch.plan       !== undefined) update.plan = patch.plan;
  if (patch.status     !== undefined) update.status = patch.status;
  if (patch.trial_ends_at !== undefined) update.trial_ends_at = patch.trial_ends_at;
  const { data, error } = await _client
    .from("tenants").update(update).eq("id", id)
    .select().single();
  return { data, error };
}

// Exclui o tenant. ON DELETE CASCADE remove members, operations, etc.
// Auth users do owner NÃO são removidos (continuam no auth.users).
async function dbDeleteTenantAdmin(id) {
  if (!isDbOnline() || !_client) return { error: new Error("DB offline") };
  const { error } = await _client.from("tenants").delete().eq("id", id);
  return { error };
}

// =====================================================================
// SESSION · hook React + helpers de role
// =====================================================================
function getSession() {
  try { return JSON.parse(localStorage.getItem("stockkitchen.session.v1")); } catch { return null; }
}

function useSession() {
  const [sess, setSess] = React.useState(getSession);
  React.useEffect(() => {
    const onStorage = () => setSess(getSession());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const role = sess?.role || "operator";
  return {
    ...sess,
    role,
    tenantId:   sess?.tenantId || null,
    tenantName: sess?.tenantName || null,
    isAdmin:    ["owner", "admin"].includes(role),
    isManager:  ["owner", "admin", "manager"].includes(role),
    canWrite:   ["owner", "admin", "manager"].includes(role),
    canDelete:  ["owner", "admin"].includes(role),
    isAuditor:  role === "auditor",
    isOperator: role === "operator",
  };
}

// =====================================================================
// Exposição global
// =====================================================================
Object.assign(window, {
  initSupabase, getSupabaseClient, getDbState, getDbError, isDbOnline, useDbStatus,
  dbOrMock, dbSignIn, dbSignOut, dbGetSession, dbGetCurrentContext, dbResetPassword, dbUpdatePassword,
  dbListOperations, dbInsertOperation, dbUpdateOperation, dbDeleteOperation,
  dbListOperationShifts, dbInsertOperationShift, dbUpdateOperationShift, dbDeleteOperationShift,
  dbListRecipeCategories, dbInsertRecipeCategory,
  dbListStockCategories, dbInsertStockCategory, dbRenameStockCategory, dbDeleteStockCategory,
  dbListSuppliers, dbInsertSupplier, dbUpdateSupplier, dbDeleteSupplier,
  dbListStockItems, dbInsertStockItem, dbUpdateStockItem, dbDeleteStockItem, dbApplyStockMovement, dbListStockMovements,
  dbSetStockItemAutoMin,
  dbListPaymentMethods,
  dbListRevenueEntries, dbInsertRevenueEntry, dbUpdateRevenueEntry, dbDeleteRevenueEntry,
  dbListKitchenRequests, dbInsertKitchenRequest, dbUpdateKitchenRequestStatus, dbDeleteKitchenRequest,
  dbReplaceKitchenRequestItems,
  dbListPurchaseOrders, dbInsertPurchaseOrder, dbDeletePurchaseOrder,
  dbUpdatePurchaseOrderItem, dbDeletePurchaseOrderItem,
  dbListGoodsReceipts, dbInsertGoodsReceipt,
  dbListTechSheets, dbInsertTechSheet, dbUpdateTechSheet, dbDeleteTechSheet,
  dbListPreparations, dbInsertPreparation, dbUpdatePreparation, dbDeletePreparation, dbRecomputeAllCosts,
  dbInsertPreparationItem, dbUpdatePreparationItem, dbDeletePreparationItem,
  dbInsertTechSheetItem, dbUpdateTechSheetItem, dbDeleteTechSheetItem,
  dbListInventories, dbInsertInventory, dbUpdateInventory,
  dbListMembers, dbInviteMember, dbUpdateMember, dbUpdateMemberRole, dbUpdateMemberProfile, dbRemoveMember,
  dbListTenantsAdmin, dbProvisionTenant, dbUpdateTenantAdmin, dbDeleteTenantAdmin,
  dbListDreCategories, dbListDreSubcategories, dbListFinanceEntries, dbInsertFinanceEntry, dbUpdateFinanceEntry, dbDeleteFinanceEntry,
  dbGetStockValueSnapshots,
  dbListClosingChecklist, dbUpdateClosingChecklistItem, dbInsertClosingChecklistItem, dbDeleteClosingChecklistItem,
  dbListClosedPeriods, dbClosePeriod, dbReopenPeriod,
  dbInsertDreCategory, dbInsertDreSubcategory, dbDeleteDreCategory, dbDeleteDreSubcategory,
  dbListCmvDaily, dbTopConsumedItems,
  dbUploadEvidence, dbGetSignedUrl,
  dbSubscribeTable,
  getSession, useSession,
  mapStockItemFromDb, mapRevenueFromDb, mapKitchenRequestFromDb, mapPurchaseOrderFromDb, mapGoodsReceiptFromDb,
  mapTechSheetFromDb, mapInventoryFromDb,
});

// Auto-init na carga
initSupabase().then(() => {
  console.info("[supabase] estado inicial:", _state, _error?.message || "");
});
