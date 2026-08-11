// Central de Distribuição · módulo 'distribution' (só tenant kind='distribution_center')
// Rede (convites por código), transferências de saída, solicitações recebidas
// e painel de Gastos por tenant. Reusa os componentes de page-supply.jsx.
// Spec: PRD-PRODUCAO-E-DISTRIBUICAO.md §6.

const _distFmtBRL = (v) =>
  "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const _distParseNum = (raw) => {
  if (raw == null) return 0;
  const s = String(raw).trim().replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

const _distTh = { fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "left", padding: "8px 10px", borderBottom: "1px solid var(--line)" };
const _distTd = { fontSize: 12.5, color: "var(--fg-1)", padding: "9px 10px", borderBottom: "1px solid var(--line-soft)", verticalAlign: "top" };

// Ajuste manual de gastos de um tenant (acertos / pagamentos à central)
function DistLedgerAdjustModal({ centralId, member, onClose, onSaved }) {
  const [mode, setMode] = useState("decrease"); // decrease = abate gasto (pagamento)
  const [value, setValue] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const valueN = _distParseNum(value);
  const canSave = valueN > 0;

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    try {
      const delta = mode === "decrease" ? -valueN : valueN;
      const { error } = await dbSupplyLedgerAdjust(centralId, member.tenantId, delta, notes || null);
      if (error) throw error;
      window.showToast?.("Ajuste lançado", { tone: "ok" });
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Ajuste de gastos · ${member.name}`}
      subtitle={`Saldo atual: ${_distFmtBRL(member.balance)}. O extrato é imutável — corrigir = novo ajuste.`}
      width={440}
      onClose={saving ? undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={save} disabled={saving || !canSave}>
            {saving ? "Carregando…" : "Lançar ajuste"}
          </button>
        </>
      )}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <FormRow label="Tipo de ajuste">
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="decrease">Abater gasto (ex.: pagamento recebido)</option>
            <option value="increase">Aumentar gasto (ex.: cobrança extra)</option>
          </select>
        </FormRow>
        <FormRow label="Valor (R$)">
          <input className="input" value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder="0,00" autoFocus />
        </FormRow>
        <FormRow label="Observação">
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder='Ex.: "PIX 12/07"' />
        </FormRow>
      </div>
    </Modal>
  );
}

// =====================================================================
// Cadeia de suprimentos · catálogo de abastecimento por unidade
// A central define o que cada unidade recebe (o item nasce no estoque dela),
// controla mín/máx/auto e repõe automaticamente o que está abaixo do mínimo.
// =====================================================================

const _distFmtNum = (v, d = 1) => {
  const n = Number(v) || 0;
  return n.toLocaleString("pt-BR", { maximumFractionDigits: d });
};

const _distDaysAgo = (iso) => {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
};

// Saúde do estoque de um item: ruptura → abaixo do mínimo → ok
const _distItemTone = (qty, reorder) => {
  if (qty <= 0) return "crit";
  if (reorder > 0 && qty < reorder * 0.25) return "crit";
  if (reorder > 0 && qty < reorder) return "warn";
  return "ok";
};

const _DIST_TONE = {
  crit: { color: "var(--crit)", soft: "var(--crit-soft)", line: "var(--crit-line)", label: "Ruptura" },
  warn: { color: "var(--warn)", soft: "var(--warn-soft)", line: "var(--warn-line)", label: "Repor" },
  ok:   { color: "var(--ok)",   soft: "var(--ok-soft)",   line: "var(--ok-line)",   label: "Ok" },
};

// Barra de nível com marcadores de mínimo e máximo + fatia do que está a caminho.
// É o elemento didático da tela: mostra numa olhada onde o saldo está na escala.
function SupplyLevelBar({ qty, reorder, max, inTransit = 0, unit, compact = false }) {
  const scaleMax = Math.max(max || 0, reorder * 1.6, qty + inTransit, 1);
  const pct = (v) => Math.max(0, Math.min(100, (v / scaleMax) * 100));
  const tone = _DIST_TONE[_distItemTone(qty, reorder)];
  return (
    <div style={{ width: "100%" }}>
      <div style={{
        position: "relative", height: compact ? 8 : 10, borderRadius: 999,
        background: "var(--bg-3)", border: "1px solid var(--line)", overflow: "hidden",
      }}>
        <div style={{
          position: "absolute", inset: 0, width: `${pct(qty)}%`,
          background: tone.color, opacity: 0.9, borderRadius: 999,
          transition: "width 200ms ease",
        }} />
        {inTransit > 0 && (
          <div title={`${_distFmtNum(inTransit, 2)} ${unit} a caminho`} style={{
            position: "absolute", top: 0, bottom: 0,
            left: `${pct(qty)}%`, width: `${pct(inTransit)}%`,
            background: `repeating-linear-gradient(115deg, var(--info) 0 4px, transparent 4px 8px)`,
            opacity: 0.75,
          }} />
        )}
        {reorder > 0 && (
          <div title={`Mínimo ${_distFmtNum(reorder, 2)} ${unit}`} style={{
            position: "absolute", top: -1, bottom: -1, left: `${pct(reorder)}%`,
            width: 2, background: "var(--fg-2)",
          }} />
        )}
        {max > 0 && (
          <div title={`Máximo ${_distFmtNum(max, 2)} ${unit}`} style={{
            position: "absolute", top: -1, bottom: -1, left: `${pct(max)}%`,
            width: 2, background: "var(--fg-3)", opacity: 0.7,
          }} />
        )}
      </div>
      {!compact && (
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)" }}>
          <span style={{ color: tone.color }}>{_distFmtNum(qty, 2)} {unit}</span>
          <span>mín {_distFmtNum(reorder, 2)}{max ? ` · máx ${_distFmtNum(max, 2)}` : ""}</span>
        </div>
      )}
    </div>
  );
}

// Barra empilhada ok / repor / ruptura — a "saúde" da unidade em uma linha.
function UnitHealthBar({ ok, below, out }) {
  const total = Math.max(ok + below + out, 1);
  const seg = [
    { n: out,   color: "var(--crit)" },
    { n: below, color: "var(--warn)" },
    { n: ok,    color: "var(--ok)" },
  ];
  return (
    <div style={{ display: "flex", height: 6, borderRadius: 999, overflow: "hidden", background: "var(--bg-3)" }}>
      {seg.map((s, i) => s.n > 0 && (
        <div key={i} style={{ width: `${(s.n / total) * 100}%`, background: s.color }} />
      ))}
    </div>
  );
}

function DistUnitCard({ u, onOpen }) {
  const tone = u.out > 0 ? "crit" : u.below > 0 ? "warn" : "ok";
  const m = _DIST_TONE[tone];
  const statusLabel = u.items === 0 ? "Sem catálogo" : u.out > 0 ? "Ruptura" : u.below > 0 ? "Repor" : "Saudável";
  const days = _distDaysAgo(u.lastTransferAt);
  return (
    <button type="button" onClick={() => onOpen(u)} style={{
      textAlign: "left", background: "var(--bg-1)", border: "1px solid var(--line)",
      borderRadius: 10, padding: "16px 18px", cursor: "pointer", display: "flex",
      flexDirection: "column", gap: 14, transition: "border-color 120ms, transform 120ms",
    }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--line-strong)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--line)"; e.currentTarget.style.transform = "none"; }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 8, flexShrink: 0, display: "grid", placeItems: "center",
          background: m.soft, border: `1px solid ${m.line}`, color: m.color,
        }}>
          <I.Box size={16} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {u.name}
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2 }}>
            {u.items} {u.items === 1 ? "item no catálogo" : "itens no catálogo"}
          </div>
        </div>
        <span style={{
          fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase",
          color: m.color, background: m.soft, border: `1px solid ${m.line}`,
          borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap",
        }}>{statusLabel}</span>
      </div>

      <div>
        <UnitHealthBar ok={u.ok} below={u.below} out={u.out} />
        <div style={{ display: "flex", gap: 12, marginTop: 7, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)" }}>
          <span><b style={{ color: "var(--crit)" }}>{u.out}</b> ruptura</span>
          <span><b style={{ color: "var(--warn)" }}>{u.below}</b> repor</span>
          <span><b style={{ color: "var(--ok)" }}>{u.ok}</b> ok</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Cobertura</div>
          <div className="mono" style={{ fontSize: 15, color: "var(--fg-0)", fontWeight: 500 }}>
            {u.coverageDays != null ? `${_distFmtNum(u.coverageDays, 0)} d` : "—"}
          </div>
          {u.soonestDays != null && (
            <div style={{ fontSize: 10, color: u.soonestDays < 3 ? "var(--crit)" : "var(--fg-3)" }}>
              1ª ruptura em {_distFmtNum(u.soonestDays, 0)} d
            </div>
          )}
        </div>
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Estoque</div>
          <div className="mono" style={{ fontSize: 15, color: "var(--fg-0)", fontWeight: 500 }}>{_distFmtBRL(u.stockValue)}</div>
          <div style={{ fontSize: 10, color: "var(--fg-3)" }}>{_distFmtBRL(u.spend30d)} em 30d</div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", borderTop: "1px solid var(--line-soft)", paddingTop: 10 }}>
        {u.inTransit > 0 && (
          <span style={{ fontSize: 10.5, color: "var(--info)", background: "var(--info-soft)", border: "1px solid var(--info-line)", borderRadius: 999, padding: "2px 8px" }}>
            {u.inTransit} em trânsito
          </span>
        )}
        {u.pendingRequests > 0 && (
          <span style={{ fontSize: 10.5, color: "var(--warn)", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 999, padding: "2px 8px" }}>
            {u.pendingRequests} solicitação(ões)
          </span>
        )}
        <span style={{ fontSize: 10.5, color: "var(--fg-3)", marginLeft: "auto" }}>
          {days == null ? "sem entregas" : days === 0 ? "entrega hoje" : `entrega há ${days} d`}
        </span>
        <I.ChevronR size={13} style={{ color: "var(--fg-3)" }} />
      </div>
    </button>
  );
}

// Adiciona itens do estoque da central ao catálogo de uma unidade.
function DistAssortmentAddModal({ centralId, unit, centralItems, existingCentralIds, onClose, onSaved }) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState({}); // { centralItemId: { min, max, autoMode } }
  const [saving, setSaving] = useState(false);

  const available = (centralItems || []).filter((i) => !existingCentralIds.has(i.id));
  const filtered = available.filter((i) =>
    !search.trim() || i.name.toLowerCase().includes(search.trim().toLowerCase()));
  const pickedIds = Object.keys(picked);

  const toggle = (item) => setPicked((cur) => {
    const next = { ...cur };
    if (next[item.id]) delete next[item.id];
    else next[item.id] = { min: "", max: "", autoMode: "weekly" };
    return next;
  });

  const save = async () => {
    if (saving || pickedIds.length === 0) return;
    setSaving(true);
    try {
      const { error } = await dbSupplyAssortmentAdd(centralId, unit.tenantId,
        pickedIds.map((id) => ({
          centralItemId: id,
          min: _distParseNum(picked[id].min),
          max: _distParseNum(picked[id].max),
          autoMode: picked[id].autoMode,
        })));
      if (error) throw error;
      window.showToast?.(`${pickedIds.length} item(ns) adicionado(s) ao catálogo de ${unit.name}`, { tone: "ok" });
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Itens que ${unit.name} recebe`}
      subtitle="O item é criado no estoque da unidade (saldo zero) e passa a ser gerido pela central — mín/máx e cálculo automático ficam sob seu controle."
      width={720}
      onClose={saving ? undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={save} disabled={saving || pickedIds.length === 0}>
            {saving ? "Carregando…" : `Adicionar ${pickedIds.length || ""}`.trim()}
          </button>
        </>
      )}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input className="input" placeholder="Buscar item do estoque da central…" value={search}
          onChange={(e) => setSearch(e.target.value)} autoFocus />

        {available.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--fg-3)", padding: "20px 0", textAlign: "center" }}>
            Todos os itens ativos do seu estoque já estão no catálogo desta unidade.
          </div>
        ) : (
          <div style={{ maxHeight: 340, overflow: "auto", border: "1px solid var(--line)", borderRadius: 6 }}>
            {filtered.map((it) => {
              const p = picked[it.id];
              return (
                <div key={it.id} style={{
                  display: "grid", gridTemplateColumns: "1fr 90px 90px 128px", gap: 8, alignItems: "center",
                  padding: "8px 10px", borderBottom: "1px solid var(--line-soft)",
                  background: p ? "var(--bg-2)" : "transparent",
                }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", minWidth: 0 }}>
                    <input type="checkbox" checked={!!p} onChange={() => toggle(it)} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 12.5, color: "var(--fg-0)" }}>{it.name}</span>
                      <span style={{ fontSize: 10.5, color: "var(--fg-3)", marginLeft: 6, fontFamily: "var(--mono)" }}>
                        {it.unit} · saldo {_distFmtNum(it.qty, 2)}
                      </span>
                    </span>
                  </label>
                  <input className="input" placeholder="mín" inputMode="decimal" disabled={!p}
                    value={p?.min || ""} data-size="sm"
                    onChange={(e) => setPicked((cur) => ({ ...cur, [it.id]: { ...cur[it.id], min: e.target.value } }))} />
                  <input className="input" placeholder="máx" inputMode="decimal" disabled={!p}
                    value={p?.max || ""} data-size="sm"
                    onChange={(e) => setPicked((cur) => ({ ...cur, [it.id]: { ...cur[it.id], max: e.target.value } }))} />
                  <select className="select" disabled={!p} value={p?.autoMode || "weekly"}
                    onChange={(e) => setPicked((cur) => ({ ...cur, [it.id]: { ...cur[it.id], autoMode: e.target.value } }))}>
                    <option value="off">Mín. manual</option>
                    <option value="weekly">Auto · semanal</option>
                    <option value="monthly">Auto · mensal</option>
                  </select>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div style={{ padding: 16, fontSize: 12, color: "var(--fg-3)", textAlign: "center" }}>Nenhum item encontrado.</div>
            )}
          </div>
        )}

        <div style={{ fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
          No modo automático o mín/máx é recalculado pelo consumo real da unidade
          (semanal: repõe pouco e sempre · mensal: compra p/ ~5 semanas). Deixe em branco
          para começar em zero e ajustar depois.
        </div>
      </div>
    </Modal>
  );
}

// Ajusta mín/máx/modo de um item do catálogo (grava no estoque da unidade).
function DistAssortmentEditModal({ centralId, unit, row, onClose, onSaved }) {
  const [min, setMin] = useState(row.reorder ? String(row.reorder).replace(".", ",") : "");
  const [max, setMax] = useState(row.max != null ? String(row.max).replace(".", ",") : "");
  const [mode, setMode] = useState(row.autoMinMode || "off");
  const [saving, setSaving] = useState(false);
  const daily = row.usage30d > 0 ? row.usage30d / 30 : 0;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const { error } = await dbSupplyAssortmentSet(centralId, unit.tenantId, row.unitItemId, {
        min: _distParseNum(min), max: _distParseNum(max), autoMode: mode,
      });
      if (error) throw error;
      window.showToast?.("Parâmetros atualizados no estoque da unidade", { tone: "ok" });
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
      setSaving(false);
    }
  };

  return (
    <Modal
      title={row.name}
      subtitle={`${unit.name} · saldo ${_distFmtNum(row.qty, 2)} ${row.unit} · consumo ${_distFmtNum(daily, 2)} ${row.unit}/dia`}
      width={520}
      onClose={saving ? undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={save} disabled={saving}>
            {saving ? "Carregando…" : "Salvar"}
          </button>
        </>
      )}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ padding: "12px 14px", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 6 }}>
          <SupplyLevelBar qty={row.qty} reorder={row.reorder} max={row.max} inTransit={row.inTransit} unit={row.unit} />
        </div>

        <FormRow label="Cálculo do mínimo/máximo">
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="off">Manual — você define os valores</option>
            <option value="weekly">Automático semanal — mín = 7 dias, máx = mín × 1,3</option>
            <option value="monthly">Automático mensal — mín = 7 dias, máx = 35 dias</option>
          </select>
        </FormRow>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <FormRow label={`Mínimo (${row.unit})`} hint={mode !== "off" ? "recalculado pelo consumo" : "dispara a reposição"}>
            <input className="input mono" inputMode="decimal" value={min} disabled={mode !== "off"}
              onChange={(e) => setMin(e.target.value)} placeholder="0" />
          </FormRow>
          <FormRow label={`Máximo (${row.unit})`} hint={mode !== "off" ? "recalculado pelo consumo" : "alvo da reposição"}>
            <input className="input mono" inputMode="decimal" value={max} disabled={mode !== "off"}
              onChange={(e) => setMax(e.target.value)} placeholder="—" />
          </FormRow>
        </div>

        {mode !== "off" && daily > 0 && (
          <div style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
            Pelo consumo atual, o mínimo fica em ~{_distFmtNum(Math.ceil(daily * 7), 0)} {row.unit}
            {" "}e o máximo em ~{_distFmtNum(mode === "monthly" ? Math.ceil(daily * 35) : Math.ceil(Math.ceil(daily * 7) * 1.3), 0)} {row.unit}.
          </div>
        )}
      </div>
    </Modal>
  );
}

// Usa o catálogo de outra unidade como modelo (copia itens + mín/máx/modo).
function DistCopyCatalogModal({ centralId, unit, units, existingCentralIds, onClose, onSaved }) {
  const others = (units || []).filter((u) => u.tenantId !== unit.tenantId);
  const [fromId, setFromId] = useState(others[0]?.tenantId || "");
  const [preview, setPreview] = useState(null); // null = carregando
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!fromId) { setPreview([]); return; }
    let cancelled = false;
    setPreview(null);
    (async () => {
      const { data, error } = await dbSupplyUnitAssortment(centralId, fromId);
      if (cancelled) return;
      if (error) {
        window.showToast?.(`Erro ao ler o catálogo: ${error.message || error}`, { tone: "crit", ttl: 6000 });
        setPreview([]);
        return;
      }
      setPreview((data || []).filter((r) => !existingCentralIds.has(r.centralItemId)));
    })();
    return () => { cancelled = true; };
  }, [fromId]);

  const save = async () => {
    if (saving || !preview || preview.length === 0) return;
    setSaving(true);
    try {
      const { error } = await dbSupplyAssortmentAdd(centralId, unit.tenantId,
        preview.map((r) => ({ centralItemId: r.centralItemId, min: r.reorder, max: r.max, autoMode: r.autoMinMode })));
      if (error) throw error;
      window.showToast?.(`${preview.length} item(ns) copiado(s) para ${unit.name}`, { tone: "ok" });
      onSaved();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Copiar catálogo para ${unit.name}`}
      subtitle="Traz os itens que faltam, junto com o mín/máx e o modo de cálculo da unidade de origem."
      width={520}
      onClose={saving ? undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn" data-size="sm" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn" data-variant="primary" data-size="sm" onClick={save}
            disabled={saving || !preview || preview.length === 0}>
            {saving ? "Carregando…" : `Copiar ${preview?.length || 0} item(ns)`}
          </button>
        </>
      )}
    >
      {others.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--fg-3)" }}>Não há outra unidade ativa na rede para servir de modelo.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <FormRow label="Copiar de">
            <select className="select" value={fromId} onChange={(e) => setFromId(e.target.value)}>
              {others.map((u) => <option key={u.tenantId} value={u.tenantId}>{u.name} · {u.items} itens</option>)}
            </select>
          </FormRow>
          {preview === null ? (
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Carregando catálogo…</div>
          ) : preview.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--warn)" }}>
              Nada a copiar — {unit.name} já tem todos os itens dessa unidade.
            </div>
          ) : (
            <div style={{ maxHeight: 260, overflow: "auto", border: "1px solid var(--line)", borderRadius: 6 }}>
              {preview.map((r) => (
                <div key={r.centralItemId} style={{ display: "flex", justifyContent: "space-between", padding: "7px 10px", borderBottom: "1px solid var(--line-soft)", fontSize: 12.5 }}>
                  <span style={{ color: "var(--fg-1)" }}>{r.name}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-3)" }}>
                    mín {_distFmtNum(r.reorder, 2)}{r.max ? ` · máx ${_distFmtNum(r.max, 2)}` : ""} · {r.unit}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// Detalhe de uma unidade: catálogo com estoque, cobertura e parâmetros.
function DistUnitDetail({ centralId, unit, units, centralItems, onBack, onChanged }) {
  const [rows, setRows] = useState(null); // null = carregando
  const [addOpen, setAddOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);
  const [removeRow, setRemoveRow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("all"); // all | repor | ruptura

  const load = async () => {
    const { data, error } = await dbSupplyUnitAssortment(centralId, unit.tenantId);
    if (error) {
      window.showToast?.(`Erro ao carregar o catálogo: ${error.message || error}`, { tone: "crit", ttl: 6000 });
      setRows([]);
      return;
    }
    setRows(data || []);
  };

  useEffect(() => { setRows(null); load(); }, [unit.tenantId]);

  const existingCentralIds = new Set((rows || []).map((r) => r.centralItemId));

  const shown = (rows || []).filter((r) => {
    if (filter === "ruptura") return r.qty <= 0;
    if (filter === "repor") return r.reorder > 0 && r.qty < r.reorder;
    return true;
  });

  const doRemove = async () => {
    if (busy || !removeRow) return;
    setBusy(true);
    try {
      const { error } = await dbSupplyAssortmentRemove(centralId, unit.tenantId, removeRow.unitItemId);
      if (error) throw error;
      window.showToast?.(`${removeRow.name} saiu do catálogo — o item continua no estoque da unidade`, { tone: "ok" });
      setRemoveRow(null);
      await load();
      await onChanged();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
    }
    setBusy(false);
  };

  const toRepor = (rows || []).filter((r) => r.reorder > 0 && r.qty + r.inTransit < r.reorder).length;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <button className="btn" data-size="sm" onClick={onBack}>← Unidades</button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-0)" }}>{unit.name}</div>
          <div style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
            {rows === null ? "carregando…" : `${rows.length} itens no catálogo · ${toRepor} para repor`}
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn" data-size="sm" onClick={() => setCopyOpen(true)} disabled={rows === null}>
            Copiar catálogo
          </button>
          <button className="btn" data-variant="primary" data-size="sm" onClick={() => setAddOpen(true)} disabled={rows === null}>
            <I.Plus size={12} /> Adicionar itens
          </button>
        </div>
      </div>

      {rows === null ? (
        <div style={{ fontSize: 12.5, color: "var(--fg-3)", padding: 24, textAlign: "center" }}>Carregando catálogo…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center", border: "1px dashed var(--line)", borderRadius: 8 }}>
          <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 6 }}>
            {unit.name} ainda não recebe nenhum item da central.
          </div>
          <div style={{ fontSize: 12.5, color: "var(--fg-3)", marginBottom: 16, lineHeight: 1.6 }}>
            Cadastre aqui o que essa unidade vai receber — cada item é criado no estoque dela
            automaticamente e o mín/máx passa a ser gerido por você.
          </div>
          <button className="btn" data-variant="primary" data-size="sm" onClick={() => setAddOpen(true)}>
            <I.Plus size={12} /> Adicionar itens
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            {[{ id: "all", label: `Todos (${rows.length})` },
              { id: "repor", label: `Abaixo do mínimo (${rows.filter((r) => r.reorder > 0 && r.qty < r.reorder).length})` },
              { id: "ruptura", label: `Ruptura (${rows.filter((r) => r.qty <= 0).length})` }].map((f) => (
              <button key={f.id} className="btn" data-size="sm"
                data-variant={filter === f.id ? "primary" : undefined}
                onClick={() => setFilter(f.id)}>{f.label}</button>
            ))}
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={_distTh}>Item</th>
                <th style={{ ..._distTh, width: 210 }}>Nível na unidade</th>
                <th style={{ ..._distTh, textAlign: "right" }}>Cobertura</th>
                <th style={{ ..._distTh, textAlign: "right" }}>Consumo 30d</th>
                <th style={{ ..._distTh, textAlign: "right" }}>Na central</th>
                <th style={{ ..._distTh, width: 96 }}></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const daily = r.usage30d > 0 ? r.usage30d / 30 : 0;
                const cover = daily > 0 ? r.qty / daily : null;
                const tone = _DIST_TONE[_distItemTone(r.qty, r.reorder)];
                return (
                  <tr key={r.unitItemId}>
                    <td style={_distTd}>
                      <div style={{ color: "var(--fg-0)", display: "flex", alignItems: "center", gap: 6 }}>
                        {r.name}
                        {!r.isActive && <span className="badge" data-tone="crit">inativo na unidade</span>}
                      </div>
                      <div style={{ fontSize: 10.5, color: "var(--fg-3)", fontFamily: "var(--mono)" }}>
                        {r.category || "sem categoria"} · {r.autoMinMode === "off" ? "manual" : `auto ${r.autoMinMode === "weekly" ? "semanal" : "mensal"}`}
                        {r.inTransit > 0 ? ` · ${_distFmtNum(r.inTransit, 2)} ${r.unit} a caminho` : ""}
                      </div>
                    </td>
                    <td style={_distTd}>
                      <SupplyLevelBar qty={r.qty} reorder={r.reorder} max={r.max} inTransit={r.inTransit} unit={r.unit} />
                    </td>
                    <td style={{ ..._distTd, textAlign: "right", fontFamily: "var(--mono)", color: cover != null && cover < 3 ? "var(--crit)" : "var(--fg-1)" }}>
                      {cover != null ? `${_distFmtNum(cover, 0)} d` : "—"}
                    </td>
                    <td style={{ ..._distTd, textAlign: "right", fontFamily: "var(--mono)", color: "var(--fg-2)" }}>
                      {_distFmtNum(r.usage30d, 2)} {r.unit}
                    </td>
                    <td style={{ ..._distTd, textAlign: "right", fontFamily: "var(--mono)", color: r.centralQty <= 0 ? "var(--crit)" : "var(--fg-2)" }}>
                      {_distFmtNum(r.centralQty, 2)} {r.unit}
                    </td>
                    <td style={{ ..._distTd, textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn" data-size="sm" data-variant="ghost" title="Ajustar mín/máx" disabled={busy}
                        onClick={() => setEditRow(r)}><I.Edit size={12} /></button>
                      {" "}
                      <button className="btn" data-size="sm" data-variant="ghost" title="Tirar do catálogo" disabled={busy}
                        onClick={() => setRemoveRow(r)}><I.Trash size={12} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {addOpen && (
        <DistAssortmentAddModal
          centralId={centralId} unit={unit} centralItems={centralItems}
          existingCentralIds={existingCentralIds}
          onClose={() => setAddOpen(false)}
          onSaved={async () => { setAddOpen(false); await load(); await onChanged(); }}
        />
      )}
      {copyOpen && (
        <DistCopyCatalogModal
          centralId={centralId} unit={unit} units={units} existingCentralIds={existingCentralIds}
          onClose={() => setCopyOpen(false)}
          onSaved={async () => { setCopyOpen(false); await load(); await onChanged(); }}
        />
      )}
      {editRow && (
        <DistAssortmentEditModal
          centralId={centralId} unit={unit} row={editRow}
          onClose={() => setEditRow(null)}
          onSaved={async () => { setEditRow(null); await load(); await onChanged(); }}
        />
      )}
      <ConfirmDialog
        open={!!removeRow}
        title="Tirar do catálogo"
        message={removeRow ? `${removeRow.name} deixa de ser gerido pela central. O item continua no estoque de ${unit.name} com o saldo atual, e a unidade volta a controlar o mín/máx dele.` : ""}
        confirmLabel="Tirar do catálogo"
        busy={busy}
        onConfirm={doRemove}
        onCancel={() => setRemoveRow(null)}
      />
    </div>
  );
}

// Reposição: mesma lógica da lista de compras, mas de dentro pra fora da rede.
function DistReplenishView({ centralId, rows, onGenerated }) {
  const [excluded, setExcluded] = useState({});   // { unitItemId: true }
  const [overrides, setOverrides] = useState({}); // { unitItemId: qtyText }
  const [capToStock, setCapToStock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const lines = (rows || []).map((r) => {
    const raw = overrides[r.unitItemId] != null ? _distParseNum(overrides[r.unitItemId]) : r.suggested;
    const qty = capToStock ? Math.min(raw, Math.max(r.centralQty, 0)) : raw;
    return { ...r, qty, cost: qty * r.centralCost, short: qty > r.centralQty };
  }).filter((l) => l.qty > 0);

  const active = lines.filter((l) => !excluded[l.unitItemId]);
  const total = active.reduce((s, l) => s + l.cost, 0);
  const shortLines = active.filter((l) => l.short);

  // Necessidade agregada: o que a central precisa ter em casa p/ atender a rede
  const aggregated = useMemo(() => {
    const by = {};
    active.forEach((l) => {
      if (!by[l.centralItemId]) {
        by[l.centralItemId] = { id: l.centralItemId, name: l.name, unit: l.unit, need: 0, have: l.centralQty, cost: l.centralCost, units: 0 };
      }
      by[l.centralItemId].need += l.qty;
      by[l.centralItemId].units += 1;
    });
    return Object.values(by)
      .map((a) => ({ ...a, missing: Math.max(0, a.need - a.have) }))
      .sort((a, b) => b.missing - a.missing || b.need - a.need);
  }, [active.map((l) => `${l.unitItemId}:${l.qty}`).join("|")]);

  const missingTotal = aggregated.reduce((s, a) => s + a.missing * a.cost, 0);
  const missingCount = aggregated.filter((a) => a.missing > 0).length;

  const byUnit = useMemo(() => {
    const g = {};
    active.forEach((l) => {
      if (!g[l.tenantId]) g[l.tenantId] = { tenantId: l.tenantId, name: l.tenantName, items: [] };
      g[l.tenantId].items.push(l);
    });
    return Object.values(g).sort((a, b) => a.name.localeCompare(b.name));
  }, [active.map((l) => `${l.unitItemId}:${l.qty}`).join("|")]);

  const generate = async () => {
    if (busy || byUnit.length === 0) return;
    setBusy(true);
    let created = 0;
    try {
      for (const g of byUnit) {
        const { error } = await dbSupplyCreateTransfer({
          centralId,
          fromTenantId: centralId,
          toTenantId: g.tenantId,
          notes: "Reposição automática · cadeia de suprimentos",
          items: g.items.map((l) => ({ fromItemId: l.centralItemId, name: l.name, qty: l.qty, unit: l.unit })),
        });
        if (error) throw error;
        created += 1;
      }
      window.showToast?.(`${created} rascunho(s) de transferência criado(s) — revise e envie na aba Transferências`, { tone: "ok", ttl: 6000 });
      setConfirmOpen(false);
      setExcluded({}); setOverrides({});
      await onGenerated();
    } catch (e) {
      window.showToast?.(`Erro ao gerar (${created} criada(s)): ${e.message || e}`, { tone: "crit", ttl: 7000 });
      setConfirmOpen(false);
    }
    setBusy(false);
  };

  if (!rows || rows.length === 0) {
    return (
      <div style={{ padding: "48px 20px", textAlign: "center" }}>
        <div className="h-eyebrow" style={{ marginBottom: 8 }}>Nada para repor</div>
        <div style={{ fontSize: 13, color: "var(--fg-2)" }}>
          Todas as unidades estão acima do mínimo (ou já têm reposição em trânsito). ✨
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-end", paddingBottom: 14, borderBottom: "1px solid var(--line)", marginBottom: 18 }}>
        <SummaryStat label="Unidades a atender" value={String(byUnit.length)} />
        <SummaryStat label="Itens a enviar" value={String(active.length)} />
        <SummaryStat label="Sem saldo na central" value={String(shortLines.length)} tone={shortLines.length > 0 ? "crit" : "ok"} />
        <SummaryStat label="Valor da reposição" value={_distFmtBRL(total)} />
        <span style={{ flex: 1 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--fg-2)", cursor: "pointer" }}>
          <input type="checkbox" checked={capToStock} onChange={(e) => setCapToStock(e.target.checked)} />
          Limitar ao saldo da central
        </label>
        <button className="btn" data-variant="primary" data-size="sm" disabled={busy || active.length === 0}
          onClick={() => setConfirmOpen(true)}>
          {busy ? "Carregando…" : `Gerar ${byUnit.length} rascunho(s)`}
        </button>
      </div>

      {missingCount > 0 && (
        <div style={{
          marginBottom: 18, padding: "12px 14px", borderRadius: 6,
          background: "var(--crit-soft)", border: "1px solid var(--crit-line)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <I.AlertTriangle size={13} style={{ color: "var(--crit)" }} />
            <span style={{ fontSize: 12.5, color: "var(--fg-0)", fontWeight: 600 }}>
              Necessidade da rede · falta {missingCount} item(ns) no estoque da central
            </span>
            <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 12, color: "var(--crit)" }}>
              {_distFmtBRL(missingTotal)} a comprar
            </span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {aggregated.filter((a) => a.missing > 0).map((a) => (
              <span key={a.id} style={{
                fontSize: 11, fontFamily: "var(--mono)", color: "var(--fg-1)",
                background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 999, padding: "3px 9px",
              }}>
                {a.name} · falta <b style={{ color: "var(--crit)" }}>{_distFmtNum(a.missing, 2)} {a.unit}</b>
                {" "}<span style={{ color: "var(--fg-3)" }}>({a.units} un.)</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {byUnit.map((g) => {
          const gTotal = g.items.reduce((s, l) => s + l.cost, 0);
          const gShort = g.items.some((l) => l.short);
          return (
            <div key={g.tenantId} className="card">
              <div className="card-header">
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <I.Truck size={15} style={{ color: gShort ? "var(--crit)" : "var(--fg-2)", flexShrink: 0 }} />
                  <div>
                    <h3 className="card-title" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {g.name}
                      {gShort && <span className="badge" data-tone="crit">saldo insuficiente</span>}
                    </h3>
                    <div className="card-sub" style={{ display: "block", marginTop: 3 }}>
                      {g.items.length} {g.items.length === 1 ? "item" : "itens"} abaixo do mínimo
                    </div>
                  </div>
                </div>
                <span className="mono" style={{ fontSize: 14, color: "var(--fg-0)", fontWeight: 500 }}>{_distFmtBRL(gTotal)}</span>
              </div>
              <table className="table" data-density="compact">
                <thead>
                  <tr>
                    <th style={{ width: 32 }}></th>
                    <th>Item</th>
                    <th className="num">Na unidade</th>
                    <th className="num">Mín / Máx</th>
                    <th className="num">A caminho</th>
                    <th className="num">Enviar</th>
                    <th className="num">Na central</th>
                    <th className="num">Custo</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map((l) => {
                    const off = !!excluded[l.unitItemId];
                    return (
                      <tr key={l.unitItemId} style={{ opacity: off ? 0.4 : 1 }}>
                        <td>
                          <CheckBox checked={!off}
                            onChange={() => setExcluded((cur) => ({ ...cur, [l.unitItemId]: !cur[l.unitItemId] }))} />
                        </td>
                        <td className="row-strong">
                          <div>{l.name}</div>
                          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-3)", marginTop: 2 }}>
                            {l.coverageDays != null ? `cobertura ${_distFmtNum(l.coverageDays, 0)} d` : "sem consumo registrado"}
                          </div>
                        </td>
                        <td className="num" style={{ color: l.qty <= 0 ? "var(--crit)" : "var(--fg-1)" }}>
                          {_distFmtNum(l.qty, 2)} {l.unit}
                        </td>
                        <td className="num" style={{ color: "var(--fg-2)" }}>
                          {_distFmtNum(l.reorder, 2)} / {l.max != null ? _distFmtNum(l.max, 2) : "—"}
                        </td>
                        <td className="num" style={{ color: l.inTransit > 0 ? "var(--info)" : "var(--fg-3)" }}>
                          {l.inTransit > 0 ? `${_distFmtNum(l.inTransit, 2)} ${l.unit}` : "—"}
                        </td>
                        <td className="num">
                          <input className="input mono" inputMode="decimal" disabled={off}
                            style={{ width: 90, textAlign: "right", padding: "3px 6px" }}
                            value={overrides[l.unitItemId] != null ? overrides[l.unitItemId] : String(l.qty).replace(".", ",")}
                            onChange={(e) => setOverrides((cur) => ({ ...cur, [l.unitItemId]: e.target.value }))} />
                        </td>
                        <td className="num" style={{ color: l.short ? "var(--crit)" : "var(--fg-2)" }}>
                          {_distFmtNum(l.centralQty, 2)} {l.unit}
                        </td>
                        <td className="num">{_distFmtBRL(l.cost)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        tone="neutral"
        title="Gerar reposição"
        message={`Cria ${byUnit.length} transferência(s) em rascunho com ${active.length} item(ns), no total de ${_distFmtBRL(total)}.`
          + (shortLines.length > 0 ? ` Atenção: ${shortLines.length} linha(s) passam do saldo da central e vão travar no envio.` : "")
          + " Nada sai do estoque até você enviar."}
        confirmLabel="Gerar rascunhos"
        busy={busy}
        onConfirm={generate}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

const _DIST_VIEWS = [
  { id: "units",       label: "Unidades" },
  { id: "replenish",   label: "Reposição" },
  { id: "transfers",   label: "Transferências" },
  { id: "requests",    label: "Solicitações" },
  { id: "divergences", label: "Divergências" },
  { id: "network",     label: "Rede" },
  { id: "ledger",      label: "Gastos" },
];

function CentralDistribuicao({ scope }) {
  const dbStatus = (typeof useDbStatus === "function") ? useDbStatus() : { isOnline: false, state: "offline" };
  const [tid, setTid] = useState(null);
  const [kind, setKind] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("units");
  const [overview, setOverview] = useState(null);
  const [stockItems, setStockItems] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [requests, setRequests] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [units, setUnits] = useState([]);
  const [replenish, setReplenish] = useState([]);
  const [openUnit, setOpenUnit] = useState(null); // unidade em detalhe (aba Unidades)
  const [inviteCode, setInviteCode] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [transferForm, setTransferForm] = useState(null); // { prefillRequest }
  const [adjustFor, setAdjustFor] = useState(null);
  const [removeFor, setRemoveFor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ledgerFilter, setLedgerFilter] = useState("all");

  const reload = async (tenantId) => {
    const t = tenantId || tid;
    if (!t) return;
    const [oRes, sRes, tRes, rRes, lRes, uRes, repRes] = await Promise.all([
      dbSupplyOverview(t),
      dbListStockItems(t),
      dbSupplyListTransfers(t),
      dbSupplyListRequests(t),
      dbSupplyListLedger(t, { centralId: t }),
      dbSupplyUnitsSummary(t),
      dbSupplyReplenishment(t),
    ]);
    setOverview(oRes?.data || null);
    setStockItems(sRes?.data || []);
    setTransfers(tRes?.data || []);
    setRequests(rRes?.data || []);
    setLedger(lRes?.data || []);
    // As RPCs de catálogo são novas — se ainda não estiverem no banco, o módulo
    // segue funcionando sem as abas Unidades/Reposição populadas.
    setUnits(uRes?.data || []);
    setReplenish(repRes?.data || []);
  };

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const ctx = await dbGetCurrentContext();
      if (cancelled) return;
      const t = ctx?.tenant?.id || null;
      setTid(t);
      setKind(ctx?.tenant?.kind || "standard");
      if (t) await reload(t);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline]);

  if (loading) return <PageLoading label="Carregando central…" variant="table" />;

  if (!dbStatus.isOnline || !tid) {
    return (
      <div style={{ padding: "24px 28px" }}>
        <div style={{ fontSize: 12.5, color: "var(--warn)", padding: "10px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 4 }}>
          O módulo Central só fica disponível com Supabase online.
        </div>
      </div>
    );
  }

  if (kind !== "distribution_center") {
    return (
      <div style={{ padding: "24px 28px" }}>
        <div style={{ fontSize: 12.5, color: "var(--fg-2)", padding: "14px 16px", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 4, lineHeight: 1.6 }}>
          Este módulo é exclusivo de tenants do tipo <strong>Central de Distribuição</strong>.
          Para transformar esta conta em central, fale com o suporte da plataforma.
        </div>
      </div>
    );
  }

  const members = (overview?.asCentral || []);
  const activeMembers = members.filter((m) => m.status === "active");
  const invitedMembers = members.filter((m) => m.status === "invited");
  const nameByTenant = {};
  members.forEach((m) => { nameByTenant[m.tenantId] = m.name; });
  const fmtCode = (c) => (c && c.length === 8 ? `${c.slice(0, 4)} ${c.slice(4)}` : c || "—");

  const pendingRequests = requests.filter((r) => r.supplierTenantId === tid && r.status === "pending");
  const unitsCritical = units.filter((u) => u.out > 0).length;

  const invite = async () => {
    if (inviteBusy || !inviteCode.trim()) return;
    setInviteBusy(true);
    try {
      const { data: found, error: lookErr } = await dbSupplyLookupByCode(tid, inviteCode);
      if (lookErr) throw lookErr;
      if (!found) throw new Error("Nenhum tenant encontrado com esse código");
      const { error } = await dbSupplyInvite(tid, inviteCode);
      if (error) throw error;
      window.showToast?.(`Convite enviado para ${found.tenant_name}`, { tone: "ok" });
      setInviteCode("");
      await reload();
    } catch (e) {
      window.showToast?.(`${e.message || e}`, { tone: "crit", ttl: 6000 });
    }
    setInviteBusy(false);
  };

  const removeMember = async () => {
    if (busy || !removeFor) return;
    setBusy(true);
    try {
      const { error } = await dbSupplyRemoveMember(tid, removeFor.tenantId);
      if (error) throw error;
      window.showToast?.(`${removeFor.name} removido da rede`, { tone: "ok" });
      setRemoveFor(null);
      await reload();
    } catch (e) {
      window.showToast?.(`Erro: ${e.message || e}`, { tone: "crit", ttl: 6000 });
    }
    setBusy(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "20px 28px 0" }}>
        <div className="h-eyebrow" style={{ marginBottom: 6 }}>Rede de suprimentos</div>
        <h1 className="h-title">Central de Distribuição</h1>
        <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--line)", marginTop: 14 }}>
          {_DIST_VIEWS.map((v) => (
            <button key={v.id} onClick={() => setView(v.id)}
              style={{
                background: "none", border: "none", cursor: "pointer",
                padding: "8px 14px", fontSize: 13, marginBottom: -1,
                color: view === v.id ? "var(--fg-0)" : "var(--fg-3)",
                fontWeight: view === v.id ? 600 : 400,
                borderBottom: view === v.id ? "2px solid var(--accent-bright)" : "2px solid transparent",
                display: "inline-flex", alignItems: "center", gap: 6,
              }}>
              {v.label}
              {v.id === "requests" && pendingRequests.length > 0 && (
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "1px 6px", background: "var(--accent-bright)", color: "var(--accent-fg)", borderRadius: 8, fontWeight: 500 }}>{pendingRequests.length}</span>
              )}
              {v.id === "replenish" && replenish.length > 0 && (
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "1px 6px", background: "var(--warn)", color: "var(--bg-0)", borderRadius: 8, fontWeight: 500 }}>{replenish.length}</span>
              )}
              {v.id === "units" && unitsCritical > 0 && (
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "1px 6px", background: "var(--crit)", color: "var(--bg-0)", borderRadius: 8, fontWeight: 500 }}>{unitsCritical}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 28px 32px" }}>
        {view === "units" && (
          openUnit ? (
            <DistUnitDetail
              centralId={tid}
              // pega a versão recarregada do resumo (contadores atualizados)
              unit={units.find((u) => u.tenantId === openUnit.tenantId) || openUnit}
              units={units}
              centralItems={stockItems}
              onBack={() => setOpenUnit(null)}
              onChanged={() => reload()}
            />
          ) : activeMembers.length === 0 ? (
            <div style={{ padding: "48px 20px", textAlign: "center", border: "1px dashed var(--line)", borderRadius: 8 }}>
              <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 6 }}>Nenhuma unidade ativa na rede.</div>
              <div style={{ fontSize: 12.5, color: "var(--fg-3)", marginBottom: 14 }}>
                Convide as cozinhas pelo código de 8 dígitos na aba <strong>Rede</strong>. Depois de aceito,
                cada unidade aparece aqui com o estoque dela.
              </div>
              <button className="btn" data-size="sm" onClick={() => setView("network")}>Ir para a Rede</button>
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-end", paddingBottom: 14, borderBottom: "1px solid var(--line)", marginBottom: 18 }}>
                <SummaryStat label="Unidades ativas" value={String(units.length)} />
                <SummaryStat label="Itens geridos" value={String(units.reduce((s, u) => s + u.items, 0))} />
                <SummaryStat label="Unidades em ruptura" value={String(unitsCritical)} tone={unitsCritical > 0 ? "crit" : "ok"} />
                <SummaryStat label="Estoque na rede" value={_distFmtBRL(units.reduce((s, u) => s + u.stockValue, 0))} />
                <span style={{ flex: 1 }} />
                {replenish.length > 0 && (
                  <button className="btn" data-variant="primary" data-size="sm" onClick={() => setView("replenish")}>
                    Repor {replenish.length} item(ns)
                  </button>
                )}
              </div>
              {units.length === 0 ? (
                <div style={{ padding: "40px 20px", textAlign: "center", border: "1px dashed var(--line)", borderRadius: 8, fontSize: 12.5, color: "var(--fg-3)" }}>
                  As unidades aparecem aqui assim que o catálogo de abastecimento estiver disponível no banco.
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
                  {units.map((u) => <DistUnitCard key={u.tenantId} u={u} onOpen={setOpenUnit} />)}
                </div>
              )}
            </div>
          )
        )}

        {view === "replenish" && (
          <DistReplenishView
            centralId={tid} rows={replenish}
            onGenerated={async () => { await reload(); setView("transfers"); }}
          />
        )}

        {view === "network" && (
          <div>
            <div style={{
              display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 18,
              padding: "14px 16px", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 6,
            }}>
              <FormRow label="Convidar tenant pelo código" hint="O código aparece em Configurações (e no módulo Cadeia de suprimentos) de cada tenant.">
                <input className="input mono" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="0000 0000" style={{ width: 180, letterSpacing: "0.1em" }}
                  onKeyDown={(e) => { if (e.key === "Enter") invite(); }} />
              </FormRow>
              <button className="btn" data-variant="primary" data-size="sm" onClick={invite}
                disabled={inviteBusy || !inviteCode.trim()} style={{ marginBottom: 4 }}>
                {inviteBusy ? "Carregando…" : "Convidar"}
              </button>
            </div>

            {members.length === 0 ? (
              <div style={{ padding: "40px 20px", textAlign: "center", border: "1px dashed var(--line)", borderRadius: 6 }}>
                <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 6 }}>Nenhum tenant na rede ainda.</div>
                <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
                  Peça o código de 8 dígitos de cada cozinha (Configurações → Conta) e convide acima.
                </div>
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={_distTh}>Tenant</th>
                    <th style={_distTh}>Código</th>
                    <th style={_distTh}>Status</th>
                    <th style={{ ..._distTh, textAlign: "right" }}>Gasto acumulado</th>
                    <th style={_distTh}>Na rede desde</th>
                    <th style={{ ..._distTh, width: 60 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.tenantId}>
                      <td style={{ ..._distTd, color: "var(--fg-0)" }}>{m.name}</td>
                      <td style={{ ..._distTd, fontFamily: "var(--mono)" }}>{fmtCode(m.code)}</td>
                      <td style={_distTd}>
                        {m.status === "active"
                          ? <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ok)", background: "var(--ok-soft)", border: "1px solid var(--ok-line)", borderRadius: 999, padding: "2px 8px" }}>Ativo</span>
                          : <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--warn)", background: "var(--warn-soft)", border: "1px solid var(--warn-line)", borderRadius: 999, padding: "2px 8px" }}>Convidado</span>}
                      </td>
                      <td style={{ ..._distTd, textAlign: "right", fontFamily: "var(--mono)" }}>{_distFmtBRL(m.balance)}</td>
                      <td style={_distTd}>{m.respondedAt ? new Date(m.respondedAt).toLocaleDateString("pt-BR") : "—"}</td>
                      <td style={{ ..._distTd, textAlign: "right" }}>
                        <button className="btn" data-variant="ghost" data-size="sm" title="Remover da rede"
                          onClick={() => setRemoveFor(m)}><I.Trash size={12} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {invitedMembers.length > 0 && (
              <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 10 }}>
                Convites pendentes aparecem para o tenant no módulo Cadeia de suprimentos, onde ele aceita ou recusa.
              </div>
            )}
          </div>
        )}

        {view === "transfers" && (
          <div>
            <div style={{ display: "flex", marginBottom: 14 }}>
              <button className="btn" data-variant="primary" data-size="sm" style={{ marginLeft: "auto" }}
                disabled={activeMembers.length === 0}
                onClick={() => setTransferForm({ prefillRequest: null })}>
                <I.Plus size={12} /> Nova transferência
              </button>
            </div>
            <SupplyTransferList
              tid={tid}
              transfers={transfers}
              myItems={stockItems}
              onChanged={() => reload()}
              emptyHint={activeMembers.length === 0
                ? "Convide tenants na aba Rede para começar a transferir."
                : "Nenhuma transferência na rede ainda."}
            />
          </div>
        )}

        {view === "requests" && (
          <SupplyRequestList
            tid={tid}
            requests={requests.filter((r) => r.supplierTenantId === tid)}
            onChanged={() => reload()}
            onFulfill={(r) => setTransferForm({ prefillRequest: r })}
            emptyHint="Nenhuma solicitação recebida dos tenants."
          />
        )}

        {view === "divergences" && (
          <SupplyDivergenceView tid={tid} isCentral scopeCentralId={tid} />
        )}

        {view === "ledger" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 18 }}>
              <SummaryStat label="Gasto total da rede" value={_distFmtBRL(activeMembers.reduce((s, m) => s + (m.balance || 0), 0))} />
              <SummaryStat label="Tenants ativos" value={String(activeMembers.length)} />
              <SummaryStat label="Lançamentos" value={String(ledger.length)} />
            </div>

            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 22 }}>
              <thead>
                <tr>
                  <th style={_distTh}>Tenant</th>
                  <th style={{ ..._distTh, textAlign: "right" }}>Gasto acumulado</th>
                  <th style={{ ..._distTh, width: 120 }}></th>
                </tr>
              </thead>
              <tbody>
                {activeMembers.map((m) => (
                  <tr key={m.tenantId}>
                    <td style={{ ..._distTd, color: "var(--fg-0)" }}>{m.name}</td>
                    <td style={{ ..._distTd, textAlign: "right", fontFamily: "var(--mono)" }}>{_distFmtBRL(m.balance)}</td>
                    <td style={{ ..._distTd, textAlign: "right" }}>
                      <button className="btn" data-size="sm" onClick={() => setAdjustFor(m)}>Ajuste</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>Extrato</div>
              <select className="select" style={{ width: "auto", marginLeft: "auto" }} value={ledgerFilter}
                onChange={(e) => setLedgerFilter(e.target.value)}>
                <option value="all">Todos os tenants</option>
                {activeMembers.map((m) => <option key={m.tenantId} value={m.tenantId}>{m.name}</option>)}
              </select>
            </div>
            <SupplyLedgerTable
              entries={ledgerFilter === "all" ? ledger : ledger.filter((e) => e.tenantId === ledgerFilter)}
              nameByTenant={nameByTenant}
              showTenant
            />
          </div>
        )}
      </div>

      {transferForm && (
        <SupplyTransferForm
          tid={tid} centralId={tid}
          toOptions={transferForm.prefillRequest
            ? [{ id: transferForm.prefillRequest.requesterTenantId, name: transferForm.prefillRequest.requesterName }]
            : activeMembers.map((m) => ({ id: m.tenantId, name: m.name }))}
          stockItems={stockItems}
          prefillRequest={transferForm.prefillRequest}
          onClose={() => setTransferForm(null)}
          onSaved={async () => { setTransferForm(null); await reload(); }}
        />
      )}

      {adjustFor && (
        <DistLedgerAdjustModal
          centralId={tid} member={adjustFor}
          onClose={() => setAdjustFor(null)}
          onSaved={async () => { setAdjustFor(null); await reload(); }}
        />
      )}

      <ConfirmDialog
        open={!!removeFor}
        title="Remover da rede"
        message={removeFor ? `Remover ${removeFor.name} da rede? O histórico de transferências e gastos é preservado; o tenant pode ser convidado de novo depois.` : ""}
        confirmLabel="Remover"
        busy={busy}
        onConfirm={removeMember}
        onCancel={() => setRemoveFor(null)}
      />
    </div>
  );
}

Object.assign(window, {
  CentralDistribuicao,
  // reusados pela versão mobile (page-mobile-distribution.jsx)
  SupplyLevelBar, UnitHealthBar,
  DistAssortmentAddModal, DistAssortmentEditModal,
});
