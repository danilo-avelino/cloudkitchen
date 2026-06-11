// Página mobile dedicada (#/mobile) — SÓ lançamento de requisição de estoque.
// Tela cheia, sem sidebar/topbar (renderizada fora do AppShell em src/App.jsx).
// Favoritos por usuário, sincronizados via Supabase (user_favorite_items).
//
// Fluxo: tocar num insumo abre o modal de quantidade → adiciona ao carrinho.
// O botão "Finalizar requisição" abre o carrinho (tela cheia) com os itens
// editáveis (zerar a qtd remove) e o "Enviar requisição" no rodapé.

const _mNorm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const _round = (n) => Math.round(n * 100) / 100;
const _SHARED = "shared";

// Distribui 100% entre ids segundo pesos alinhados (fallback igual quando soma 0).
// Mesma lógica do rateio da requisição web (page-requests.jsx · distributeBy).
function _distributeByWeight(ids, weights) {
  const out = {};
  if (ids.length === 0) return out;
  const totalW = weights.reduce((s, v) => s + v, 0);
  if (totalW <= 0) {
    const each = Math.floor((100 / ids.length) * 100) / 100;
    ids.forEach((id, i) => { out[id] = i === ids.length - 1 ? Number((100 - each * (ids.length - 1)).toFixed(2)) : each; });
    return out;
  }
  let assigned = 0;
  ids.forEach((id, i) => {
    if (i === ids.length - 1) { out[id] = Number((100 - assigned).toFixed(2)); }
    else { const pct = Number(((weights[i] / totalW) * 100).toFixed(2)); out[id] = pct; assigned += pct; }
  });
  return out;
}

function MobileRequests({ user, onLogout, canOpenApp = true }) {
  const dbStatus = useDbStatus();
  const [tenantId, setTenantId]   = useState(null);
  const [loading, setLoading]     = useState(true);
  const [items, setItems]         = useState([]);   // catálogo de insumos
  const [ops, setOps]             = useState([]);
  const [opId, setOpId]           = useState(null);
  const [by, setBy]               = useState(user?.name || "Cozinha");
  const [notes, setNotes]         = useState("");
  const [cart, setCart]           = useState([]);   // [{ id, qty }]
  const [favs, setFavs]           = useState(new Set());
  const [favAvailable, setFavAvailable] = useState(true);
  const [query, setQuery]         = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [menuOpen, setMenuOpen]   = useState(false);
  const [qtyItem, setQtyItem]     = useState(null);  // item em edição no modal de qtd
  const [cartOpen, setCartOpen]   = useState(false);
  const [revenueEntries, setRevenueEntries] = useState(null); // p/ rateio "Uso compartilhado"

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      let tid = null;
      if (dbStatus.isOnline && typeof dbGetCurrentContext === "function") {
        try { const ctx = await dbGetCurrentContext(); tid = ctx?.tenant?.id || null; } catch (_) {}
      }
      if (cancelled) return;
      setTenantId(tid);

      // Operações — MOCK.OPERATIONS é hidratado pelo dbGetCurrentContext acima
      const allOps = (MOCK.OPERATIONS || []).filter((o) => o.id !== "all");
      const userOps = Array.isArray(user?.ops) ? user.ops : [];
      const allowed = userOps.length
        ? allOps.filter((o) => userOps.includes(o.id) || userOps.includes(o.slug))
        : allOps;
      const opList = allowed.length ? allowed : allOps;
      setOps(opList);
      // Operação começa SEM seleção (obrigatória) — o usuário deve escolher.

      // Catálogo de insumos
      let stock = MOCK.STOCK_ITEMS || [];
      if (tid) {
        const { data, source } = await dbListStockItems(tid);
        if (source === "db" && data) stock = data;
      }
      if (cancelled) return;
      setItems(stock);

      // Faturamento por operação — usado p/ ratear "Uso compartilhado" por faturamento
      if (tid && typeof dbListRevenueEntries === "function") {
        const { data } = await dbListRevenueEntries(tid);
        if (!cancelled && data) setRevenueEntries(data);
      }

      // Favoritos (fail-soft: tabela ausente/erro → esconde a seção)
      if (tid && typeof dbListFavoriteItems === "function") {
        const { data, error } = await dbListFavoriteItems(tid);
        if (cancelled) return;
        if (error) setFavAvailable(false);
        else { setFavs(new Set(data || [])); setFavAvailable(true); }
      } else {
        setFavAvailable(false);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  const byId = (id) => items.find((it) => it.id === id);
  const cartQtyOf = (id) => { const c = cart.find((x) => x.id === id); return c ? c.qty : null; };

  // Faturamento confirmado por operação (indexado por slug e por UUID p/ casar qualquer formato)
  const revenueByOp = useMemo(() => {
    const r = {};
    const source = revenueEntries || MOCK.REVENUE_ENTRIES || [];
    source.forEach((e) => {
      if (e.status !== "confirmed") return;
      const rev = e.revenue || 0;
      if (e.op)          r[e.op]          = (r[e.op]          || 0) + rev;
      if (e.operationId) r[e.operationId] = (r[e.operationId] || 0) + rev;
    });
    return r;
  }, [revenueEntries]);

  // Rateio do "Uso compartilhado": sempre por faturamento (fallback igual). Retorna
  // { primaryOp, splits } prontos pro dbInsertKitchenRequest.
  const buildShared = () => {
    const ids = ops.map((o) => o.id);
    const dist = _distributeByWeight(ids, ids.map((id) => revenueByOp[id] || 0));
    const splits = ids.map((id) => ({ op: id, pct: dist[id] || 0 }));
    const primaryOp = splits.slice().sort((a, b) => b.pct - a.pct)[0]?.op || ids[0];
    return { primaryOp, splits };
  };

  // Define a qtd do item no carrinho (qty<=0 remove). Usado pelo modal e pelo carrinho.
  const setCartQty = (id, qty) => {
    setCart((cur) => {
      const n = Number(qty);
      if (!Number.isFinite(n) || n <= 0) return cur.filter((c) => c.id !== id);
      const found = cur.find((c) => c.id === id);
      if (found) return cur.map((c) => c.id === id ? { ...c, qty: _round(n) } : c);
      return [...cur, { id, qty: _round(n) }];
    });
  };
  const removeFromCart = (id) => setCart((cur) => cur.filter((c) => c.id !== id));

  const toggleFav = async (id) => {
    if (!favAvailable || !tenantId) return;
    const wasFav = favs.has(id);
    setFavs((cur) => { const n = new Set(cur); wasFav ? n.delete(id) : n.add(id); return n; });
    const fn = wasFav ? dbRemoveFavoriteItem : dbAddFavoriteItem;
    const { error } = await fn(tenantId, id);
    if (error) {
      setFavs((cur) => { const n = new Set(cur); wasFav ? n.add(id) : n.delete(id); return n; });
      window.showToast?.(`Erro ao salvar favorito: ${error.message}`, { tone: "crit", ttl: 4000 });
    }
  };

  const submit = async () => {
    if (submitting || cart.length === 0) return;
    if (!opId) {
      window.showToast?.("Selecione a operação", { tone: "warn", ttl: 3000 });
      setCartOpen(false);   // volta pra tela inicial onde o seletor fica em vermelho
      return;
    }
    if (!tenantId || !dbStatus.isOnline) {
      window.showToast?.("Sem conexão com o banco — requisição não enviada", { tone: "warn", ttl: 4000 });
      return;
    }
    setSubmitting(true);
    const payload = cart.map((c) => {
      const it = byId(c.id);
      const cost = it?.cost || 0;
      return {
        name:          it?.name || "Item",
        stock_item_id: c.id,
        qty:           it ? `${c.qty} ${it.unit}` : String(c.qty),
        unit:          it?.unit || "un",
        unitCost:      cost,
        estCost:       (cost * c.qty).toFixed(2),
      };
    });
    const shared = opId === _SHARED;
    const { primaryOp, splits } = shared ? buildShared() : { primaryOp: opId, splits: null };
    const code = `REQ-${Date.now().toString(36).slice(-6).toUpperCase()}`;
    const { error } = await dbInsertKitchenRequest(tenantId, {
      op: primaryOp, code, by: by.trim() || "Cozinha", notes: notes.trim() || null, items: payload, splits,
    });
    setSubmitting(false);
    if (error) {
      window.showToast?.(`Erro: ${error.message}`, { tone: "crit", ttl: 4500 });
      return;
    }
    const sharedMsg = shared ? " · rateio por faturamento" : "";
    window.showToast?.(`Requisição ${code} enviada · ${payload.length} ${payload.length === 1 ? "item" : "itens"}${sharedMsg}`, { tone: "ok", ttl: 3500 });
    setCart([]);
    setNotes("");
    setCartOpen(false);
    setQuery("");
  };

  // ---- estilos base (mobile-first) ----
  const screen = {
    position: "fixed", inset: 0, zIndex: 100,
    display: "flex", flexDirection: "column",
    background: "var(--bg-0)", color: "var(--fg-1)",
    fontFamily: "var(--sans, inherit)",
  };
  const inner = { width: "100%", maxWidth: 520, margin: "0 auto", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 };

  if (loading) {
    return (
      <div style={screen}>
        <div style={{ ...inner, alignItems: "center", justifyContent: "center", color: "var(--fg-3)", fontSize: 14 }}>
          Carregando insumos…
        </div>
      </div>
    );
  }

  const q = _mNorm(query.trim());
  const base = q
    ? items.filter((it) => _mNorm(it.name).includes(q) || _mNorm(it.cat).includes(q))
    : items;
  // Favoritos primeiro (sort estável preserva a ordem alfabética dentro de cada grupo)
  const results = favAvailable
    ? [...base].sort((a, b) => (favs.has(b.id) ? 1 : 0) - (favs.has(a.id) ? 1 : 0))
    : base;
  const cartCount = cart.length;
  const isShared = opId === _SHARED;
  const opName = isShared ? "Uso compartilhado" : ops.find((o) => o.id === opId)?.name;

  return (
    <div style={screen}>
      <div style={inner}>

        {/* Cabeçalho */}
        <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid var(--line)", position: "relative" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                Requisição · mobile
              </div>
              <div style={{ fontSize: 18, fontWeight: 600, color: "var(--fg-0)", letterSpacing: "-0.01em" }}>Nova requisição</div>
            </div>
            <button onClick={() => setMenuOpen((v) => !v)} aria-label="Menu" style={{
              width: 40, height: 40, borderRadius: 8, flexShrink: 0,
              background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)",
              display: "grid", placeItems: "center", fontSize: 18,
            }}>⋯</button>
          </div>

          {menuOpen && (
            <div style={{
              position: "absolute", right: 16, top: 56, zIndex: 10,
              background: "var(--bg-1)", border: "1px solid var(--line-strong)", borderRadius: 8,
              boxShadow: "0 12px 30px -8px rgba(0,0,0,0.6)", overflow: "hidden", minWidth: 160,
            }}>
              {canOpenApp && (
                <button onClick={() => { setMenuOpen(false); window.location.hash = "#/dashboard"; }} style={menuItem}>
                  Abrir app completo
                </button>
              )}
              <button onClick={() => { setMenuOpen(false); onLogout && onLogout(); }} style={{ ...menuItem, color: "var(--crit)", borderTop: canOpenApp ? "1px solid var(--line)" : "none" }}>
                Sair
              </button>
            </div>
          )}

          {/* Operação + solicitante */}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <select value={opId || ""} onChange={(e) => setOpId(e.target.value || null)} style={{
              flex: 1, height: 44, padding: "0 12px", borderRadius: 8,
              background: "var(--bg-2)", fontSize: 15,
              border: `1px solid ${opId ? "var(--line)" : "var(--crit)"}`,
              color: opId ? "var(--fg-0)" : "var(--crit)",
              fontWeight: opId ? 400 : 600,
            }}>
              <option value="" disabled hidden>Selecione a operação</option>
              {ops.map((o) => <option key={o.id} value={o.id} style={{ color: "var(--fg-0)", fontWeight: 400 }}>{o.name}</option>)}
              {ops.length >= 2 && (
                <option value={_SHARED} style={{ color: "var(--fg-0)", fontWeight: 400 }}>🔗 Uso compartilhado</option>
              )}
            </select>
          </div>
          {isShared && (
            <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 6 }}>
              Custo rateado por faturamento entre as operações.
            </div>
          )}
          <input value={by} onChange={(e) => setBy(e.target.value)} placeholder="Solicitante" style={{
            width: "100%", height: 40, padding: "0 12px", marginTop: 8, borderRadius: 8,
            background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 16,
          }} />
        </div>

        {/* Conteúdo rolável (catálogo) */}
        <div style={{ flex: 1, overflow: "auto", padding: "12px 16px 16px", WebkitOverflowScrolling: "touch" }}>

          {/* Busca */}
          <SectionLabel>{q ? `Resultados (${results.length})` : "Todos os insumos"}</SectionLabel>
          <div style={{ position: "relative", margin: "8px 0 8px" }}>
            <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--fg-3)", pointerEvents: "none" }}>
              <I.Search size={15} />
            </span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar insumo…" style={{
              width: "100%", height: 44, padding: "0 12px 0 36px", borderRadius: 8,
              background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-0)", fontSize: 16,
            }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {results.length === 0 && (
              <div style={{ fontSize: 13, color: "var(--fg-3)", padding: "12px 4px" }}>Nenhum insumo encontrado.</div>
            )}
            {results.map((it) => (
              <ItemRow key={it.id} it={it} cartQty={cartQtyOf(it.id)} fav={favs.has(it.id)} favAvailable={favAvailable}
                       onPick={() => setQtyItem(it)} onToggleFav={() => toggleFav(it.id)} />
            ))}
          </div>
        </div>

        {/* Rodapé: abrir carrinho / finalizar */}
        <div style={{ padding: "10px 16px calc(10px + env(safe-area-inset-bottom))", borderTop: "1px solid var(--line)", background: "var(--bg-1)" }}>
          <button onClick={() => cartCount > 0 && setCartOpen(true)} disabled={cartCount === 0} style={{
            width: "100%", height: 52, borderRadius: 10, border: "none",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            background: cartCount === 0 ? "var(--bg-3)" : "var(--accent-bright)",
            color: cartCount === 0 ? "var(--fg-3)" : "var(--accent-fg, #07080a)",
            fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em",
          }}>
            {cartCount > 0 && (
              <span style={{
                minWidth: 24, height: 24, padding: "0 7px", borderRadius: 12,
                background: "rgba(0,0,0,0.22)", color: "inherit",
                display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700,
              }}>{cartCount}</span>
            )}
            {cartCount === 0 ? "Adicione itens à requisição" : "Finalizar requisição"}
          </button>
        </div>
      </div>

      {/* Modal de quantidade */}
      {qtyItem && (
        <QtyModal
          it={qtyItem}
          initialQty={cartQtyOf(qtyItem.id)}
          fav={favs.has(qtyItem.id)} favAvailable={favAvailable}
          onToggleFav={() => toggleFav(qtyItem.id)}
          onClose={() => setQtyItem(null)}
          onConfirm={(qty) => { setCartQty(qtyItem.id, qty); setQtyItem(null); }}
          onRemove={cartQtyOf(qtyItem.id) != null ? () => { removeFromCart(qtyItem.id); setQtyItem(null); } : null}
        />
      )}

      {/* Carrinho (tela cheia) */}
      {cartOpen && (
        <CartSheet
          cart={cart} byId={byId} opName={opName} hasOp={!!opId}
          notes={notes} onNotesChange={setNotes}
          submitting={submitting}
          onClose={() => setCartOpen(false)}
          onSetQty={setCartQty}
          onRemove={removeFromCart}
          onClear={() => setCart([])}
          onSubmit={submit}
        />
      )}
    </div>
  );
}

// ---- subcomponentes (mesmo arquivo) ----
function SectionLabel({ children }) {
  return (
    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
      {children}
    </span>
  );
}

function ItemRow({ it, cartQty, fav, favAvailable, onPick, onToggleFav }) {
  const inCart = cartQty != null;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "10px 10px 10px 12px", borderRadius: 8,
      background: inCart ? "var(--accent-soft)" : "var(--bg-2)",
      border: `1px solid ${inCart ? "var(--accent-line)" : "var(--line)"}`,
    }}>
      <button onClick={onPick} style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", padding: 0, color: "inherit" }}>
        <div style={{ fontSize: 15, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</div>
        <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 1 }}>
          {it.cat} · {it.unit}{it.cost ? ` · R$ ${Number(it.cost).toFixed(2)}` : ""}
        </div>
      </button>
      {inCart && (
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--accent-bright)", whiteSpace: "nowrap" }}>
          {cartQty} {it.unit}
        </span>
      )}
      {favAvailable && (
        <button onClick={onToggleFav} aria-label="Favoritar" style={{
          width: 40, height: 40, borderRadius: 8, flexShrink: 0,
          background: "transparent", border: "none",
          color: fav ? "#e3b341" : "var(--fg-3)",
          display: "grid", placeItems: "center",
        }}>
          <I.Star size={18} fill={fav ? "currentColor" : "none"} />
        </button>
      )}
      <button onClick={onPick} aria-label="Adicionar" style={{
        width: 40, height: 40, borderRadius: 8, flexShrink: 0,
        background: inCart ? "var(--accent-bright)" : "var(--bg-3)",
        color: inCart ? "var(--accent-fg, #07080a)" : "var(--fg-1)",
        border: "1px solid var(--line)", display: "grid", placeItems: "center",
      }}>
        {inCart ? <I.Check size={16} /> : <I.Plus size={16} />}
      </button>
    </div>
  );
}

// Modal de quantidade (bottom sheet) — selecionar qtd antes de adicionar ao carrinho.
function QtyModal({ it, initialQty, fav, favAvailable, onToggleFav, onClose, onConfirm, onRemove }) {
  const editing = initialQty != null;
  const [qty, setQty] = useState(editing ? initialQty : 1);
  const step = (it.unit === "un" || it.unit === "und") ? 1 : 0.5;
  const dec = () => setQty((v) => _round(Math.max(step, (Number(v) || 0) - step)));
  const inc = () => setQty((v) => _round((Number(v) || 0) + step));
  const valid = Number(qty) > 0;

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 210,
      background: "rgba(7,8,10,0.6)", display: "flex", flexDirection: "column", justifyContent: "flex-end",
      animation: "fadeUp 140ms ease both",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: "var(--bg-1)", borderTop: "1px solid var(--line-strong)",
        borderTopLeftRadius: 16, borderTopRightRadius: 16,
        padding: "16px 18px calc(18px + env(safe-area-inset-bottom))",
        width: "100%", maxWidth: 520, margin: "0 auto",
      }}>
        <div style={{ width: 38, height: 4, borderRadius: 2, background: "var(--line-strong)", margin: "0 auto 14px" }} />
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-0)" }}>{it.name}</div>
            <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 2 }}>
              {it.cat} · {it.unit}{it.cost ? ` · R$ ${Number(it.cost).toFixed(2)}/${it.unit}` : ""}
            </div>
          </div>
          {favAvailable && (
            <button onClick={onToggleFav} aria-label={fav ? "Remover dos favoritos" : "Favoritar"} style={{
              width: 44, height: 44, borderRadius: 10, flexShrink: 0,
              background: fav ? "rgba(227,179,65,0.12)" : "var(--bg-2)",
              border: `1px solid ${fav ? "rgba(227,179,65,0.4)" : "var(--line)"}`,
              color: fav ? "#e3b341" : "var(--fg-3)",
              display: "grid", placeItems: "center",
            }}>
              <I.Star size={20} fill={fav ? "currentColor" : "none"} />
            </button>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, margin: "22px 0 8px" }}>
          <button onClick={dec} style={bigStep}>−</button>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <input value={qty} inputMode="decimal" autoFocus
              onChange={(e) => {
                const v = e.target.value.replace(",", ".");
                if (v === "") { setQty(""); return; }
                const n = parseFloat(v); setQty(Number.isFinite(n) ? n : "");
              }}
              onBlur={(e) => { const n = parseFloat(String(e.target.value).replace(",", ".")); setQty(Number.isFinite(n) && n > 0 ? _round(n) : ""); }}
              style={{ width: 96, height: 56, textAlign: "center", borderRadius: 10, background: "var(--bg-0)", border: "1px solid var(--line)", color: "var(--fg-0)", fontSize: 26, fontWeight: 600 }} />
            <span style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 4 }}>{it.unit}</span>
          </div>
          <button onClick={inc} style={bigStep}>+</button>
        </div>

        {it.cost > 0 && valid && (
          <div style={{ textAlign: "center", fontSize: 12.5, color: "var(--fg-2)", marginBottom: 14 }}>
            ≈ R$ {(Number(qty) * Number(it.cost)).toFixed(2)}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          {onRemove && (
            <button onClick={onRemove} style={{
              height: 50, padding: "0 16px", borderRadius: 10, flexShrink: 0,
              background: "transparent", border: "1px solid var(--line)", color: "var(--crit)",
              fontSize: 14, fontWeight: 600,
            }}>Remover</button>
          )}
          <button onClick={() => valid && onConfirm(Number(qty))} disabled={!valid} style={{
            flex: 1, height: 50, borderRadius: 10, border: "none",
            background: valid ? "var(--accent-bright)" : "var(--bg-3)",
            color: valid ? "var(--accent-fg, #07080a)" : "var(--fg-3)",
            fontSize: 15, fontWeight: 600,
          }}>{editing ? "Salvar quantidade" : "Adicionar ao carrinho"}</button>
        </div>
      </div>
    </div>
  );
}

// Carrinho em tela cheia — revisar/editar itens e enviar.
function CartSheet({ cart, byId, opName, hasOp, notes, onNotesChange, submitting, onClose, onSetQty, onRemove, onClear, onSubmit }) {
  const step = (unit) => (unit === "un" || unit === "und") ? 1 : 0.5;
  const total = cart.reduce((s, c) => { const it = byId(c.id); return s + (it?.cost || 0) * c.qty; }, 0);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 220, background: "var(--bg-0)",
      display: "flex", flexDirection: "column", animation: "fadeUp 160ms ease both",
    }}>
      <div style={{ width: "100%", maxWidth: 520, margin: "0 auto", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>

        {/* Header */}
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onClose} aria-label="Voltar" style={{
            width: 40, height: 40, borderRadius: 8, flexShrink: 0,
            background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)",
            display: "grid", placeItems: "center", fontSize: 18,
          }}>←</button>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-0)" }}>Carrinho</div>
            <div style={{ fontSize: 11.5, color: "var(--fg-3)" }}>{cart.length} {cart.length === 1 ? "item" : "itens"} · {opName || ""}</div>
          </div>
          {cart.length > 0 && (
            <button onClick={onClear} style={{ background: "none", border: "none", color: "var(--fg-3)", fontSize: 13 }}>Limpar</button>
          )}
        </div>

        {/* Lista */}
        <div style={{ flex: 1, overflow: "auto", padding: "12px 16px", WebkitOverflowScrolling: "touch" }}>
          {cart.length === 0 ? (
            <div style={{ textAlign: "center", color: "var(--fg-3)", fontSize: 14, marginTop: 48 }}>
              Carrinho vazio.<br />
              <button onClick={onClose} style={{ marginTop: 14, height: 44, padding: "0 18px", borderRadius: 8, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)", fontSize: 14 }}>
                Voltar e adicionar itens
              </button>
            </div>
          ) : cart.map((c) => {
            const it = byId(c.id);
            const st = step(it?.unit);
            return (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, color: "var(--fg-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it?.name || "Item"}</div>
                  <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 1 }}>
                    {it?.unit || "un"}{it?.cost ? ` · R$ ${(it.cost * c.qty).toFixed(2)}` : ""}
                  </div>
                </div>
                <button onClick={() => onSetQty(c.id, _round(c.qty - st))} style={stepBtn}>−</button>
                <input value={c.qty} inputMode="decimal"
                  onChange={(e) => {
                    const v = e.target.value.replace(",", ".");
                    if (v === "") { onSetQty(c.id, ""); return; }
                    const n = parseFloat(v); if (Number.isFinite(n)) onSetQty(c.id, n);
                  }}
                  style={{ width: 52, height: 38, textAlign: "center", borderRadius: 6, background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-0)", fontSize: 15 }} />
                <button onClick={() => onSetQty(c.id, _round(c.qty + st))} style={stepBtn}>+</button>
                <button onClick={() => onRemove(c.id)} aria-label="Remover" style={{ ...stepBtn, color: "var(--crit)", borderColor: "transparent", background: "transparent" }}>
                  <I.Trash size={15} />
                </button>
              </div>
            );
          })}
        </div>

        {/* Rodapé: observação + enviar */}
        <div style={{ padding: "10px 16px calc(10px + env(safe-area-inset-bottom))", borderTop: "1px solid var(--line)", background: "var(--bg-1)" }}>
          {cart.length > 0 && (
            <textarea value={notes} onChange={(e) => onNotesChange(e.target.value)}
              placeholder="Observação (opcional)" rows={2} style={{
                width: "100%", padding: "8px 12px", marginBottom: 8, borderRadius: 8,
                background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-1)",
                fontSize: 14, fontFamily: "inherit", resize: "vertical", minHeight: 44,
              }} />
          )}
          {total > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--fg-2)", marginBottom: 8 }}>
              <span>Custo estimado</span><span className="mono" style={{ color: "var(--fg-0)" }}>R$ {total.toFixed(2)}</span>
            </div>
          )}
          {!hasOp && cart.length > 0 && (
            <div style={{ fontSize: 12.5, color: "var(--crit)", marginBottom: 8 }}>Selecione a operação na tela inicial.</div>
          )}
          <button onClick={onSubmit} disabled={cart.length === 0 || !hasOp || submitting} style={{
            width: "100%", height: 52, borderRadius: 10, border: "none",
            background: (cart.length === 0 || !hasOp) ? "var(--bg-3)" : "var(--accent-bright)",
            color: (cart.length === 0 || !hasOp) ? "var(--fg-3)" : "var(--accent-fg, #07080a)",
            fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em",
            opacity: submitting ? 0.7 : 1,
          }}>
            {submitting ? "Enviando…" : `Enviar requisição${opName ? ` · ${opName}` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

const menuItem = {
  display: "block", width: "100%", textAlign: "left",
  padding: "12px 14px", background: "var(--bg-1)", border: "none",
  color: "var(--fg-1)", fontSize: 14,
};
const stepBtn = {
  width: 38, height: 38, borderRadius: 6, flexShrink: 0,
  background: "var(--bg-3)", border: "1px solid var(--line)", color: "var(--fg-0)",
  fontSize: 18, display: "grid", placeItems: "center",
};
const bigStep = {
  width: 56, height: 56, borderRadius: 12, flexShrink: 0,
  background: "var(--bg-2)", border: "1px solid var(--line)", color: "var(--fg-0)",
  fontSize: 26, display: "grid", placeItems: "center",
};

window.MobileRequests = MobileRequests;
