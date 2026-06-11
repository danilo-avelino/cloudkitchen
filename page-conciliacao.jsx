// Conciliação bancária — aba dentro do Financeiro.
//
// Ingere o extrato da conta PJ (OFX/CSV no v1; Stone open banking depois) e
// concilia os DÉBITOS (saídas) contra os lançamentos de `finance_entries`, para a
// DRE refletir o que de fato saiu da conta. Nada toca a DRE enquanto a transação
// não vira CONCILIADA (vínculo confirmado) ou CRIADA (lançamento novo).
//
// Padrão cross-file (ver feedback_cross_file_jsx_components): componentes de outros
// arquivos são lidos via window.* DENTRO do render — nunca por identificador solto
// no escopo do módulo (esbuild trata cada .jsx como módulo isolado → ReferenceError).
//
// Motor de match (spec §5/§6): identificador (CNPJ/CPF/E2E) > valor > data > fuzzy
// nome. Memória de recorrência por tenant aprende a cada ação.

// ===================== Parsing de extrato =====================

// Parse BR/intl: o último separador é o decimal (igual ao _parseBR do financeiro).
function _num(raw) {
  if (raw === "" || raw == null) return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  let s = String(raw).trim().replace(/[R$\s]/g, "");
  if (!s) return 0;
  const neg = /^-/.test(s) || /\)$/.test(s);
  s = s.replace(/[()-]/g, "");
  const decPos = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  if (decPos >= 0) s = s.slice(0, decPos).replace(/[.,]/g, "") + "." + s.slice(decPos + 1);
  const n = parseFloat(s);
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
}

// OFX (SGML): extrai cada <STMTTRN>…</STMTTRN>. Tags geralmente sem fechamento.
function parseOFX(text) {
  const out = [];
  const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, "i"));
    return m ? m[1].trim() : "";
  };
  for (const b of blocks) {
    const amt = _num(tag(b, "TRNAMT"));
    const dt = tag(b, "DTPOSTED").slice(0, 8); // YYYYMMDD
    const date = dt.length === 8 ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}` : null;
    if (!date || !amt) continue;
    const name = tag(b, "NAME");
    const memo = tag(b, "MEMO");
    out.push({
      externalId: tag(b, "FITID") || null,
      date,
      amount: Math.abs(amt),
      direction: amt < 0 ? "debit" : "credit",
      rawDesc: [name, memo].filter(Boolean).join(" · ") || tag(b, "TRNTYPE"),
    });
  }
  return out;
}

// CSV: detecta delimitador e mapeia colunas data/valor/descrição (PT ou EN).
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const delim = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ";" : ",";
  const split = (l) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, ""));
  const header = split(lines[0]).map((h) => h.toLowerCase());
  const find = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = find("data", "date");
  const iAmt  = find("valor", "amount", "montante");
  const iDesc = find("descri", "histó", "histo", "memo", "lançamento", "lancamento", "description");
  const iDebit = find("débito", "debito", "debit");
  const iCredit = find("crédito", "credito", "credit");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = split(lines[i]);
    const rawDate = iDate >= 0 ? c[iDate] : "";
    const date = _parseDateBR(rawDate);
    if (!date) continue;
    let amount, direction;
    if (iAmt >= 0) {
      const v = _num(c[iAmt]);
      if (!v) continue;
      amount = Math.abs(v); direction = v < 0 ? "debit" : "credit";
    } else if (iDebit >= 0 || iCredit >= 0) {
      const d = iDebit >= 0 ? _num(c[iDebit]) : 0;
      const cr = iCredit >= 0 ? _num(c[iCredit]) : 0;
      if (d) { amount = Math.abs(d); direction = "debit"; }
      else if (cr) { amount = Math.abs(cr); direction = "credit"; }
      else continue;
    } else continue;
    rows.push({ externalId: null, date, amount, direction, rawDesc: iDesc >= 0 ? c[iDesc] : "" });
  }
  return rows;
}

// Aceita DD/MM/AAAA, AAAA-MM-DD, DD-MM-AAAA → ISO.
function _parseDateBR(raw) {
  const s = String(raw || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})[/\-](\d{2})[/\-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2]}-${m[1]}`;
  }
  return null;
}

// ===================== Enriquecimento =====================

// Limpa ruído típico do extrato pra ter um nome de contraparte comparável.
function normalizeName(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/\b(PIX|TED|DOC|TEF|PAGAMENTO|PAGTO|PAG|TRANSFERENCIA|TRANSFERÊNCIA|ENVIADO|RECEBIDO|COMPRA|DEBITO|DÉBITO|CARTAO|CARTÃO|BOLETO|TARIFA|CObranca|COBRANCA)\b/g, " ")
    .replace(/\b\d{2}[/-]\d{2}([/-]\d{2,4})?\b/g, " ")
    .replace(/[0-9]{4,}/g, " ")
    .replace(/[^A-Z0-9ÁÉÍÓÚÂÊÔÃÕÇ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const _onlyDigits = (s) => String(s || "").replace(/\D/g, "");

function extractDocument(raw) {
  const digits = String(raw || "").match(/\d[\d.\-/]{10,}\d/g) || [];
  for (const d of digits) {
    const n = _onlyDigits(d);
    if (n.length === 14 || n.length === 11) return n; // CNPJ ou CPF
  }
  return null;
}

function extractE2E(raw) {
  const m = String(raw || "").match(/\bE[0-9A-Z]{31,32}\b/i);
  return m ? m[0].toUpperCase() : null;
}

function enrichTx(tx) {
  const document = extractDocument(tx.rawDesc);
  const e2e = extractE2E(tx.rawDesc);
  return {
    ...tx,
    nameNorm: normalizeName(tx.rawDesc),
    document,
    identifiers: { ...(e2e ? { e2e_id: e2e } : {}) },
  };
}

// Hash de idempotência: conta + id externo + valor + data (spec §8).
function idemHash(accountId, tx) {
  const base = `${accountId}|${tx.externalId || tx.rawDesc}|${tx.amount.toFixed(2)}|${tx.date}|${tx.direction}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) { h = (h * 31 + base.charCodeAt(i)) | 0; }
  return `${tx.date}-${tx.amount.toFixed(2)}-${(h >>> 0).toString(36)}`;
}

// ===================== Scoring =====================

function _trigrams(s) {
  const t = ` ${String(s || "").toLowerCase()} `;
  const set = new Set();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}
function trigramSim(a, b) {
  const A = _trigrams(a), B = _trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter); // Jaccard
}

// Palavras genéricas de extrato/razão social que não distinguem a contraparte.
// Removidas antes de comparar nomes, pra sobrar só o token distintivo (CARNES, FRIOS…).
const _NAME_STOP = new Set([
  "boleto","pago","pagto","pagamento","pix","ted","doc","tef","tev","transferencia",
  "compra","cartao","tarifa","cobranca","enviado","recebido","favorecido","credito","debito",
  "distribuidor","distribuidora","distrib","dis","comercio","comercial","industria","industrial",
  "servicos","servico","ltda","eireli","epp","cia","mei","grupo","loja","filial","matriz","dos","das",
]);
function significantTokens(s) {
  return new Set(
    String(s || "").toLowerCase().split(/\s+/)
      .filter((t) => t.length >= 3 && !_NAME_STOP.has(t)),
  );
}
// Similaridade de nome por tokens significativos (Jaccard de palavras). Mais
// confiável que trigrama p/ razão social: mesmo fornecedor com texto diferente
// casa; fornecedores distintos que só compartilham palavra genérica não casam.
function nameSim(a, b) {
  const A = significantTokens(a), B = significantTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function _daysBetween(isoA, isoB) {
  return Math.round((new Date(isoA) - new Date(isoB)) / 86400000);
}

// Pontua um candidato (finance_entry) para uma transação. Pesos spec §6.
// `memHit` (opcional) = memória de recorrência casada por documento/nome — dá peso
// extra quando o lançamento bate a subcategoria/fornecedor já aprendidos.
function scoreCandidate(tx, entry, cfg, supplierById, memHit) {
  const signals = [];
  let score = 0;
  // Valor (filtro forte) — fora da tolerância não é candidato.
  const diff = Math.abs(Number(entry.value) - tx.amount);
  if (diff > (cfg.valueTolerance || 0) + 0.001) return null;
  score += 0.25; signals.push("valor");
  // Data dentro da janela
  const dd = Math.abs(_daysBetween(tx.date, entry.comp));
  if (dd <= cfg.dateWindowDays) { score += 0.1; signals.push("data"); }
  // Documento (CNPJ/CPF) batido via contraparte do lançamento
  const sup = entry.counterpartyId ? supplierById[entry.counterpartyId] : null;
  if (tx.document && sup && _onlyDigits(sup.cnpj) === tx.document) {
    score += 0.5; signals.push("documento");
  }
  // Fuzzy nome (contraparte ou descrição do lançamento)
  const cand = sup?.name || entry.desc || "";
  const sim = trigramSim(tx.nameNorm, normalizeName(cand));
  if (sim > 0.3) { score += 0.15 * sim; signals.push("nome"); }
  // Mês anterior: candidato de competência diferente do mês da saída (boleto pago num
  // mês com competência anterior) — continua candidato, mas com leve desconto pra
  // priorizar o mês corrente em caso de empate.
  const txMonth = (tx.date || "").slice(0, 7);
  const entryMonth = (entry.comp || "").slice(0, 7);
  if (entryMonth && txMonth && entryMonth !== txMonth) { score -= 0.05; signals.push("mês ant."); }
  // Memória de recorrência: já conciliou essa contraparte (CNPJ/nome) antes e o
  // candidato cai na mesma subcategoria/fornecedor → peso proporcional à confiança.
  if (memHit && memHit.mem.action !== "ignore") {
    const conf = Math.min(1, Number(memHit.mem.confidence) || 0.5);
    let b = 0;
    if (memHit.mem.subcategoryId && entry.cat === memHit.mem.subcategoryId) b += 0.35;
    if (memHit.mem.counterpartyId && entry.counterpartyId === memHit.mem.counterpartyId) b += 0.25;
    if (b > 0) { score += b * memHit.strength * conf; signals.push("memória"); }
  }
  const method = signals.includes("documento") ? "identifier"
    : signals.includes("memória") ? "recurrence"
    : sim > 0.5 ? "fuzzy" : "deterministic";
  return { entry, score: Math.min(1, score), method, signals };
}

function buildCandidates(tx, entries, cfg, supplierById, linkedEntryIds, memHit) {
  // Débito casa despesas (todo finance_entry é despesa). Crédito não tem candidato
  // em finance_entries (receita vive no Faturamento).
  if (tx.direction !== "debit") return [];
  return entries
    .filter((e) => !linkedEntryIds.has(e.id))
    .map((e) => scoreCandidate(tx, e, cfg, supplierById, memHit))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// Assinatura de memória: documento OU nome normalizado + direção.
function memorySignature(tx) {
  return `${tx.document || tx.nameNorm}|${tx.direction}`;
}

// Período (YYYY-MM) N meses antes do informado.
function periodMinus(period, months) {
  const [y, m] = String(period || "").split("-").map(Number);
  if (!y || !m) return period;
  const d = new Date(y, (m - 1) - months, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Casa a transação com a memória aprendida por CNPJ E/OU nome (mesma direção).
// Nome via tokens significativos (nameSim) — robusto a variações de texto do extrato.
// Retorna { mem, strength, docMatch, nameMatch }.
const NAME_MEM_THRESHOLD = 0.6;
function matchMemory(tx, memory) {
  let best = null;
  for (const m of memory) {
    if (m.direction && m.direction !== tx.direction) continue;
    const docMatch = !!(m.document && tx.document && m.document === tx.document);
    const ns = m.nameNorm && tx.nameNorm ? nameSim(m.nameNorm, tx.nameNorm) : 0;
    const nameMatch = ns >= NAME_MEM_THRESHOLD;
    if (!docMatch && !nameMatch) continue;
    // Força: doc+nome=1; só doc=0,8; só nome escala 0,5→0,75 conforme a similaridade.
    const strength = docMatch && nameMatch ? 1
      : docMatch ? 0.8
      : Math.min(0.75, 0.5 + (ns - NAME_MEM_THRESHOLD));
    const better = !best || strength > best.strength
      || (strength === best.strength && (m.occurrences || 1) > (best.mem.occurrences || 1));
    if (better) best = { mem: m, strength, docMatch, nameMatch };
  }
  return best;
}

// ===================== Componente =====================

function Conciliacao({ period }) {
  const fmt = window.fmt, fmtDate = window.fmtDate;
  const dbStatus = window.useDbStatus?.() || { isOnline: false, state: "offline" };

  const [tenantId, setTenantId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState(null);
  const [txs, setTxs] = useState([]);
  const [entries, setEntries] = useState([]);
  const [categories, setCategories] = useState([]);
  const [subcategories, setSubcategories] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [memory, setMemory] = useState([]);
  const [reconciledIds, setReconciledIds] = useState([]);
  // lookbackMonths: candidatos incluem o mês atual + N meses anteriores (boleto pago
  // num mês com competência anterior). 2 = mês corrente + 2 anteriores.
  const [cfg] = useState({ autoMin: 0.85, ambiguousMin: 0.55, dateWindowDays: 3, valueTolerance: 0, lookbackMonths: 2 });

  const [filter, setFilter] = useState("pending");
  const [txSearch, setTxSearch] = useState("");        // busca por descrição/valor na lista
  const [sortBy, setSortBy] = useState("suggested");   // ordenação da lista
  const [importing, setImporting] = useState(false);
  const [pickerTx, setPickerTx] = useState(null);     // transação no modal "Buscar"
  const [compare, setCompare] = useState(null);       // { tx, cand } no modal "Conciliar"
  const [addTx, setAddTx] = useState(null);           // transação no modal "+Adicionar"
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const fileRef = useRef(null);

  const supplierById = useMemo(() => Object.fromEntries(suppliers.map((s) => [s.id, s])), [suppliers]);

  async function reloadTxs(tid = tenantId) {
    if (!tid) return;
    const res = await window.dbListBankTransactions?.(tid, { period });
    if (res?.data) setTxs(res.data);
  }

  // Re-busca lançamentos/memória/vínculos sem reimportar o extrato — traz como
  // candidatos os lançamentos criados no Financeiro DEPOIS do upload.
  async function syncEntries() {
    if (!tenantId) return;
    setSyncing(true);
    try {
      const [entRes, recRes, memRes, supRes] = await Promise.all([
        window.dbListFinanceEntriesRange?.(tenantId, periodMinus(period, cfg.lookbackMonths), period),
        window.dbListReconciledEntryIds?.(tenantId),
        window.dbListReconciliationMemory?.(tenantId),
        window.dbListSuppliers?.(tenantId),
      ]);
      const before = entries.length;
      if (entRes?.data) setEntries(entRes.data);
      if (recRes?.data) setReconciledIds(recRes.data);
      if (memRes?.data) setMemory(memRes.data);
      if (supRes?.data) setSuppliers(supRes.data);
      await reloadTxs();
      const added = (entRes?.data?.length ?? before) - before;
      window.showToast?.(
        added > 0 ? `Atualizado · ${added} novo(s) lançamento(s) disponível(is)` : "Lançamentos atualizados",
        { tone: "ok" },
      );
    } finally { setSyncing(false); }
  }

  useEffect(() => {
    if (dbStatus.state === "checking") return;
    if (!dbStatus.isOnline) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const ctx = await window.dbGetCurrentContext?.();
        const tid = ctx?.tenant?.id;
        if (cancelled || !tid) { setLoading(false); return; }
        setTenantId(tid);
        const [accRes, txRes, entRes, catRes, subRes, supRes, memRes, recRes] = await Promise.all([
          window.dbListBankAccounts?.(tid),
          window.dbListBankTransactions?.(tid, { period }),
          window.dbListFinanceEntriesRange?.(tid, periodMinus(period, cfg.lookbackMonths), period),
          window.dbListDreCategories?.(tid),
          window.dbListDreSubcategories?.(tid),
          window.dbListSuppliers?.(tid),
          window.dbListReconciliationMemory?.(tid),
          window.dbListReconciledEntryIds?.(tid),
        ]);
        if (cancelled) return;
        const accs = accRes?.data || [];
        setAccounts(accs);
        setAccountId((cur) => cur || accs[0]?.id || null);
        if (txRes?.data) setTxs(txRes.data);
        if (entRes?.data) setEntries(entRes.data);
        if (catRes?.data) setCategories(catRes.data);
        if (subRes?.data) setSubcategories(subRes.data);
        if (supRes?.data) setSuppliers(supRes.data);
        if (memRes?.data) setMemory(memRes.data);
        if (recRes?.data) setReconciledIds(recRes.data);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dbStatus.state, dbStatus.isOnline, period]);

  // Lançamentos já vinculados (não reaparecem como candidatos). Inclui conciliações
  // confirmadas de QUALQUER mês (reconciledIds) — senão um lançamento já conciliado
  // em outro mês reapareceria como candidato pelo mesmo valor.
  const linkedEntryIds = useMemo(() => {
    const s = new Set(reconciledIds);
    txs.forEach((t) => t.links?.forEach((l) => l.financeEntryId && s.add(l.financeEntryId)));
    return s;
  }, [txs, reconciledIds]);

  // Enriquece candidatos por transação pendente (no cliente).
  const txView = useMemo(() => txs.map((t) => {
    const resolved = t.state === "reconciled" || t.state === "created";
    const memHit = matchMemory(t, memory);
    const candidates = (!resolved && t.state !== "ignored")
      ? buildCandidates(t, entries, cfg, supplierById, linkedEntryIds, memHit) : [];
    const top = candidates[0] || null;
    return { ...t, resolved, candidates, top, memHit, mem: memHit?.mem || null };
  }), [txs, entries, cfg, supplierById, linkedEntryIds, memory]);

  // Cobertura da DRE: % das saídas que ENTRAM na DRE já conciliadas/criadas.
  // Ignoradas não bloqueiam o fechamento nem contam na barra (saem do denominador).
  const coverage = useMemo(() => {
    const debits = txView.filter((t) => t.direction === "debit" && t.state !== "ignored");
    const total = debits.reduce((s, t) => s + t.amount, 0);
    const done = debits.filter((t) => t.resolved);
    const covered = done.reduce((s, t) => s + t.amount, 0);
    return { totalCount: debits.length, doneCount: done.length, total, covered,
             pending: total - covered,
             pct: total > 0 ? (covered / total) * 100 : 100 };
  }, [txView]);

  const visible = useMemo(() => {
    let list;
    if (filter === "pending") list = txView.filter((t) => !t.resolved && t.state !== "ignored");
    else if (filter === "resolved") list = txView.filter((t) => t.resolved);
    else if (filter === "ignored") list = txView.filter((t) => t.state === "ignored");
    else list = txView;
    // Busca por descrição ou valor (mesma lógica do modal "Buscar"): texto casa por
    // substring na descrição; dígitos casam pelos centavos do valor ou pelo CNPJ/CPF.
    const q = txSearch.trim();
    if (q) {
      const qLower = q.toLowerCase();
      const qDigits = q.replace(/\D/g, "");
      list = list.filter((t) => {
        if ((t.rawDesc || "").toLowerCase().includes(qLower)) return true;
        if (qDigits.length < 2) return false;
        const cents = String(Math.round((Number(t.amount) || 0) * 100));
        if (cents.startsWith(qDigits) || cents.includes(qDigits)) return true;
        return (t.document || "").replace(/\D/g, "").includes(qDigits);
      });
    }
    // Ordenação. "suggested" (default): quem tem candidato a match vem primeiro,
    // preservando a ordem cronológica (data desc) dentro de cada grupo. Demais
    // critérios são estáveis, então empates mantêm a ordem por data do banco.
    const sorters = {
      suggested:  (a, b) => (b.top ? 1 : 0) - (a.top ? 1 : 0),
      value_desc: (a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0),
      value_asc:  (a, b) => (Number(a.amount) || 0) - (Number(b.amount) || 0),
      name_asc:   (a, b) => (a.rawDesc || "").localeCompare(b.rawDesc || "", "pt-BR", { sensitivity: "base" }),
      name_desc:  (a, b) => (b.rawDesc || "").localeCompare(a.rawDesc || "", "pt-BR", { sensitivity: "base" }),
    };
    return [...list].sort(sorters[sortBy] || sorters.suggested);
  }, [txView, filter, txSearch, sortBy]);

  // ---------- Ações ----------
  async function ensureAccount() {
    if (accountId) return accountId;
    const { data } = await window.dbUpsertBankAccount(tenantId, { provider: "manual", label: "Conta importada" });
    if (data) { setAccounts((a) => [...a, data]); setAccountId(data.id); return data.id; }
    return null;
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const isOFX = /<STMTTRN>/i.test(text) || /\.ofx$/i.test(file.name);
      const parsed = (isOFX ? parseOFX(text) : parseCSV(text)).map(enrichTx);
      if (!parsed.length) { window.showToast?.("Nenhuma transação reconhecida no arquivo", { tone: "warn" }); return; }
      const acc = await ensureAccount();
      if (!acc) { window.showToast?.("Não foi possível criar a conta", { tone: "crit" }); return; }
      // Ignorar é por transação, nunca via memória — saídas sempre voltam a aparecer
      // pendentes na importação (créditos seguem ignorados pela regra de direção).
      const withHash = parsed.map((t) => ({ ...t, idemHash: idemHash(acc, t) }));
      const { data, error } = await window.dbUpsertBankTransactions(tenantId, acc, withHash);
      if (error) { window.showToast?.(`Erro ao importar: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
      await reloadTxs();
      const added = data?.length ?? 0;
      const dup = parsed.length - added;
      window.showToast?.(
        added > 0
          ? `${added} transação(ões) importada(s)${dup > 0 ? ` · ${dup} já existia(m)` : ""}`
          : "Extrato já importado — nada novo",
        { tone: added > 0 ? "ok" : "info" },
      );
    } finally { setImporting(false); }
  }

  function onStoneSync() {
    window.showToast?.("Integração Stone (open banking) em breve. Use o import OFX/CSV por enquanto.", { tone: "info", ttl: 4200 });
  }

  // Aprende a partir de uma ação (conciliar/criar/ignorar): guarda os sinais da
  // contraparte do banco (CNPJ, nome, direção) + a categoria/fornecedor escolhidos
  // e um rótulo legível, pra próxima transação dessa contraparte pontuar mais alto.
  async function learn(tx, { action, subcategoryId, counterpartyId, sampleLabel }) {
    await window.dbUpsertReconciliationMemory?.(tenantId, {
      signature: memorySignature(tx), action, subcategoryId, counterpartyId,
      document: tx.document || null, nameNorm: tx.nameNorm || null, direction: tx.direction,
      sampleLabel: sampleLabel || tx.rawDesc || null,
    });
    const memRes = await window.dbListReconciliationMemory?.(tenantId);
    if (memRes?.data) setMemory(memRes.data);
  }

  // Conciliar tx → finance_entries (1:N suportado por entryIds[]).
  async function reconcile(tx, entryIds, score, method) {
    setBusy(true);
    try {
      const rel = entryIds.length > 1 ? "one_to_n" : "one_to_one";
      for (const eid of entryIds) {
        await window.dbInsertReconciliationLink(tenantId, {
          bankTransactionId: tx.id, financeEntryId: eid, relationType: rel,
          state: "confirmed", score: score ?? null, method: method || "manual",
        });
      }
      await window.dbUpdateBankTransactionState(tx.id, "reconciled");
      const firstEntry = entries.find((e) => e.id === entryIds[0]);
      const sup = firstEntry?.counterpartyId ? supplierById[firstEntry.counterpartyId] : null;
      await learn(tx, {
        action: "reconcile_default",
        subcategoryId: firstEntry?.cat,
        counterpartyId: firstEntry?.counterpartyId || null,
        sampleLabel: sup?.name || firstEntry?.desc,
      });
      setReconciledIds((cur) => [...cur, ...entryIds]); // não reaparece p/ outras saídas
      await reloadTxs();
      setPickerTx(null);
      window.showToast?.("Conciliado", { tone: "ok" });
    } finally { setBusy(false); }
  }

  // +Adicionar: cria finance_entry e vincula como CRIADA.
  async function createEntry(tx, draft) {
    setBusy(true);
    try {
      // Fornecedor: o do draft ou, na falta, o aprendido pela memória da contraparte.
      const counterpartyId = draft.counterpartyId || tx.memHit?.mem?.counterpartyId || null;
      const { data, error } = await window.dbInsertFinanceEntry(tenantId, { ...draft, counterpartyId });
      if (error || !data) { window.showToast?.(`Erro: ${error?.message}`, { tone: "crit", ttl: 4500 }); return; }
      await window.dbInsertReconciliationLink(tenantId, {
        bankTransactionId: tx.id, financeEntryId: data.id, relationType: "one_to_one",
        state: "confirmed", method: "manual",
      });
      await window.dbUpdateBankTransactionState(tx.id, "created");
      await learn(tx, { action: "classify", subcategoryId: draft.cat, counterpartyId, sampleLabel: draft.desc });
      // Recarrega lançamentos da janela (o novo já conta como vinculado).
      const entRes = await window.dbListFinanceEntriesRange?.(tenantId, periodMinus(period, cfg.lookbackMonths), period);
      if (entRes?.data) setEntries(entRes.data);
      setReconciledIds((cur) => [...cur, data.id]);
      await reloadTxs();
      setAddTx(null);
      window.showToast?.("Lançamento criado e conciliado", { tone: "ok" });
    } finally { setBusy(false); }
  }

  // Ignorar é só por transação — NÃO alimenta a memória (não auto-ignora futuras).
  async function ignore(tx) {
    setBusy(true);
    try {
      await window.dbUpdateBankTransactionState(tx.id, "ignored");
      await reloadTxs();
      window.showToast?.("Transação ignorada", { tone: "warn" });
    } finally { setBusy(false); }
  }

  async function reopen(tx) {
    setBusy(true);
    try {
      await window.dbDeleteReconciliationLinksForTx(tx.id);
      await window.dbUpdateBankTransactionState(tx.id, "unidentified");
      await reloadTxs();
      window.showToast?.("Reaberta", { tone: "info" });
    } finally { setBusy(false); }
  }

  // Transações pendentes (não conciliadas e não ignoradas) do período carregado.
  const pendingTxs = useMemo(
    () => txView.filter((t) => !t.resolved && t.state !== "ignored"),
    [txView],
  );

  // Exclui TODAS as pendentes do período (conciliadas/criadas/ignoradas ficam).
  async function clearPending() {
    setBusy(true);
    try {
      const ids = pendingTxs.map((t) => t.id);
      const { error } = await window.dbDeleteBankTransactions(ids);
      if (error) { window.showToast?.(`Erro ao limpar: ${error.message}`, { tone: "crit", ttl: 4500 }); return; }
      await reloadTxs();
      setConfirmClear(false);
      window.showToast?.(`${ids.length} pendência(s) excluída(s)`, { tone: "warn" });
    } finally { setBusy(false); }
  }

  if (loading) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>Carregando conciliação…</div>;
  }
  if (!dbStatus.isOnline) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>
      Conciliação bancária precisa do banco online.
    </div>;
  }

  const counts = {
    pending: txView.filter((t) => !t.resolved && t.state !== "ignored").length,
    resolved: txView.filter((t) => t.resolved).length,
    ignored: txView.filter((t) => t.state === "ignored").length,
  };

  return (
    <div style={{ padding: "20px 28px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Barra de ações */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <select className="select" value={accountId || ""} onChange={(e) => setAccountId(e.target.value || null)}
                style={{ minWidth: 180 }}>
          {accounts.length === 0 && <option value="">Nenhuma conta</option>}
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        <input ref={fileRef} type="file" accept=".ofx,.csv,.txt" style={{ display: "none" }} onChange={onFile} />
        <button className="btn" data-variant="primary" data-size="sm" disabled={importing}
                onClick={() => fileRef.current?.click()}>
          <I.Plus size={13} />{importing ? "Importando…" : "Importar extrato (OFX/CSV)"}
        </button>
        <button className="btn" data-size="sm" onClick={onStoneSync}
                title="Open banking Stone — em breve">
          Sincronizar Stone
          <span style={{ marginLeft: 6, fontFamily: "var(--mono)", fontSize: 9, padding: "1px 5px", borderRadius: 99,
                         background: "rgba(194,132,58,0.14)", color: "var(--warn)", border: "1px solid rgba(194,132,58,0.3)",
                         letterSpacing: "0.04em", textTransform: "uppercase" }}>em breve</span>
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn" data-size="sm" disabled={syncing}
                onClick={syncEntries}
                title="Atualiza os candidatos com lançamentos criados após o upload do extrato">
          <span style={{ fontSize: 13, lineHeight: 1, display: "inline-block" }}>↻</span>
          {syncing ? "Sincronizando…" : "Sincronizar novos lançamentos"}
        </button>
        <button className="btn" data-size="sm" disabled={busy || pendingTxs.length === 0}
                onClick={() => setConfirmClear(true)}
                title="Excluir todas as transações pendentes deste período"
                style={{ color: pendingTxs.length > 0 ? "var(--crit)" : undefined }}>
          <I.Trash size={12} />Limpar conciliações pendentes
        </button>
      </div>

      {/* Cobertura da DRE */}
      <div className="card" style={{ background: "linear-gradient(180deg, rgba(45,140,102,0.04), transparent 80%)" }}>
        <div className="card-body" style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 20, alignItems: "center" }}>
          <div>
            <div className="h-eyebrow" style={{ marginBottom: 8 }}>
              Cobertura da DRE · {period.replace("-", "/")} · {coverage.doneCount} de {coverage.totalCount} saídas
            </div>
            <div style={{ height: 4, background: "var(--bg-3)", borderRadius: 2, overflow: "hidden", maxWidth: 480 }}>
              <div style={{ height: "100%", width: `${coverage.pct}%`, background: "var(--accent-bright)", transition: "width 240ms ease-out" }} />
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)", marginTop: 8, letterSpacing: "0.04em" }}>
              {coverage.pct.toFixed(0)}% das saídas conciliadas
            </div>
          </div>
          <Stat label="Saídas conciliadas (R$)" value={fmt(coverage.covered)} />
          <Stat label="Saídas pendentes (R$)" value={fmt(coverage.pending)} tone="warn" />
        </div>
      </div>

      {/* Filtros + busca */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {[["pending", "Não conciliadas"], ["resolved", "Conciliadas"], ["ignored", "Ignoradas"], ["all", "Todas"]].map(([id, label]) => {
          const active = filter === id;
          const c = id === "all" ? txView.length : counts[id];
          return (
            <button key={id} onClick={() => setFilter(id)} style={{
              padding: "6px 12px", fontSize: 11.5,
              background: active ? "var(--bg-3)" : "transparent",
              border: `1px solid ${active ? "var(--line-strong)" : "var(--line)"}`,
              color: active ? "var(--fg-0)" : "var(--fg-2)",
              borderRadius: 4, cursor: "pointer", letterSpacing: "-0.005em",
            }}>{label}<span style={{ fontFamily: "var(--mono)", color: "var(--fg-3)", marginLeft: 6, fontSize: 10 }}>{c ?? 0}</span></button>
          );
        })}
        <span style={{ flex: 1 }} />
        <select className="select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}
                title="Ordenar a lista" style={{ width: 200, fontSize: 12 }}>
          <option value="suggested">Sugeridos primeiro</option>
          <option value="value_desc">Valor · maior → menor</option>
          <option value="value_asc">Valor · menor → maior</option>
          <option value="name_asc">Descrição · A → Z</option>
          <option value="name_desc">Descrição · Z → A</option>
        </select>
        <div style={{ position: "relative", width: 280, maxWidth: "40%" }}>
          <I.Search size={12} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--fg-3)", pointerEvents: "none" }} />
          <input className="input" value={txSearch} onChange={(e) => setTxSearch(e.target.value)}
                 placeholder="Buscar por descrição ou valor…"
                 style={{ width: "100%", paddingLeft: 28, paddingRight: txSearch ? 26 : 10, fontSize: 12 }} />
          {txSearch && (
            <button onClick={() => setTxSearch("")} title="Limpar busca"
                    style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                             background: "none", border: "none", color: "var(--fg-3)", cursor: "pointer",
                             fontSize: 15, lineHeight: 1, padding: 2 }}>×</button>
          )}
        </div>
      </div>

      {/* Lista */}
      {visible.length === 0 ? (
        <div className="card" style={{ padding: "40px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 13.5, color: "var(--fg-1)", marginBottom: 6 }}>
            {txs.length === 0 ? "Nenhuma transação importada neste período"
              : txSearch.trim() ? `Nada encontrado para "${txSearch.trim()}"`
              : "Nada neste filtro"}
          </div>
          <div style={{ fontSize: 12, color: "var(--fg-3)", maxWidth: 520, margin: "0 auto" }}>
            Importe o extrato OFX/CSV da conta (Stone, Itaú, etc.) em <strong style={{ color: "var(--accent-bright)" }}>Importar extrato</strong>.
            Cada débito é cruzado com seus lançamentos para fechar a DRE.
          </div>
        </div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Descrição (extrato)</th>
                <th>D/C</th>
                <th className="num">Valor</th>
                <th>Sugestão / vínculo</th>
                <th style={{ width: 230 }}></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <TxRow key={t.id} t={t} fmt={fmt} fmtDate={fmtDate} subcategories={subcategories}
                       onConciliar={() => setCompare({ tx: t, cand: t.top })}
                       onPick={() => setPickerTx(t)} onAdd={() => setAddTx(t)}
                       onIgnore={() => ignore(t)} onReopen={() => reopen(t)} busy={busy} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal Conciliar · comparação lado a lado antes de confirmar */}
      {compare && compare.cand && (() => {
        // Próxima saída pendente com candidato (≠ atual e usando outro lançamento).
        const nextMatch = visible.find((t) =>
          t.id !== compare.tx.id && t.top && t.top.entry.id !== compare.cand.entry.id);
        return (
          <CompareDialog tx={compare.tx} cand={compare.cand} fmt={fmt} fmtDate={fmtDate} busy={busy}
            subcategories={subcategories} supplierById={supplierById} hasNext={!!nextMatch}
            onClose={() => setCompare(null)}
            onConfirm={() => { const c = compare; setCompare(null);
              reconcile(c.tx, [c.cand.entry.id], c.cand.score, c.cand.method); }}
            onConfirmNext={() => { const c = compare;
              reconcile(c.tx, [c.cand.entry.id], c.cand.score, c.cand.method)
                .then(() => setCompare(nextMatch ? { tx: nextMatch, cand: nextMatch.top } : null)); }} />
        );
      })()}

      {/* Modal Buscar · busca manual de lançamentos */}
      {pickerTx && (
        <CandidatePicker tx={pickerTx} entries={entries} linkedEntryIds={linkedEntryIds}
          subcategories={subcategories} categories={categories} fmt={fmt} fmtDate={fmtDate} busy={busy}
          onClose={() => setPickerTx(null)}
          onConfirm={(entryIds) => reconcile(pickerTx, entryIds, null, "manual")} />
      )}

      {/* Modal +Adicionar (reusa EntryDraft do financeiro) — pré-classifica pela memória */}
      {addTx && window.EntryDraft && (
        <window.EntryDraft
          categories={categories} subcategories={subcategories} period={period}
          initial={{
            // Com memória, usa o nome sugerido (sampleLabel) em vez da descrição bruta do extrato.
            desc: (addTx.memHit && addTx.memHit.mem.action !== "ignore" && addTx.memHit.mem.sampleLabel)
              || addTx.rawDesc || "Lançamento do extrato",
            value: addTx.amount,
            comp: addTx.date,
            paid: addTx.date,
            status: "paid",
            cat: addTx.memHit?.mem?.subcategoryId || undefined,
          }}
          onClose={() => setAddTx(null)}
          onSave={(draft) => createEntry(addTx, draft)}
        />
      )}

      {/* Confirmação · limpar pendentes */}
      {confirmClear && window.ConfirmDialog && (
        <window.ConfirmDialog
          open={confirmClear}
          tone="danger"
          title="Limpar conciliações pendentes?"
          message={
            <>
              Esta ação exclui <strong style={{ color: "var(--fg-0)" }}>{pendingTxs.length} transação(ões) pendente(s)</strong> deste período (não conciliadas). As já <strong style={{ color: "var(--fg-1)" }}>conciliadas, criadas e ignoradas permanecem</strong>. A exclusão não pode ser desfeita — reimporte o extrato para trazê-las de volta.
            </>
          }
          confirmLabel="Excluir pendentes"
          cancelLabel="Cancelar"
          onCancel={() => setConfirmClear(false)}
          onConfirm={clearPending}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, color: tone === "warn" ? "var(--warn)" : "var(--fg-0)", letterSpacing: "-0.01em" }}>{value}</div>
    </div>
  );
}

function TxRow({ t, fmt, fmtDate, subcategories, onConciliar, onPick, onAdd, onIgnore, onReopen, busy }) {
  const isDebit = t.direction === "debit";
  const sub = t.top ? subcategories.find((s) => s.id === t.top.entry.cat) : null;
  return (
    <tr>
      <td className="mono" style={{ fontSize: 11.5, color: "var(--fg-1)" }}>{fmtDate(t.date)}</td>
      <td className="row-strong" style={{ maxWidth: 320 }}>
        <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.rawDesc || "—"}</div>
        {(t.document || t.identifiers?.e2e_id) && (
          <div style={{ fontSize: 10, color: "var(--fg-3)", fontFamily: "var(--mono)", marginTop: 2 }}>
            {t.document ? `doc ${t.document}` : ""}{t.document && t.identifiers?.e2e_id ? " · " : ""}{t.identifiers?.e2e_id ? "PIX e2e" : ""}
          </div>
        )}
      </td>
      <td><span className="badge" data-tone={isDebit ? "crit" : "ok"}>{isDebit ? "Saída" : "Entrada"}</span></td>
      <td className="num" style={{ color: isDebit ? "var(--fg-0)" : "var(--ok)" }}>{isDebit ? "−" : "+"}{fmt(t.amount)}</td>
      <td style={{ fontSize: 11.5 }}>
        {t.resolved ? (
          <span className="badge" data-tone="ok">{t.state === "created" ? "Criada" : "Conciliada"}</span>
        ) : t.top ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--fg-1)" }}>
            <span style={{ width: 4, height: 4, borderRadius: 50, background: sub?.color || "#888" }} />
            {t.top.entry.desc}
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: t.top.score >= 0.85 ? "var(--ok)" : "var(--warn)" }}>
              {(t.top.score * 100).toFixed(0)}%
            </span>
            {t.top.signals?.includes("memória") && (
              <span title={`Já conciliado ${t.mem?.occurrences || 1}× com essa contraparte`}
                    style={{ fontFamily: "var(--mono)", fontSize: 9, padding: "1px 5px", borderRadius: 99,
                             background: "rgba(61,108,176,0.16)", color: "#7aa2e3", border: "1px solid rgba(61,108,176,0.35)",
                             letterSpacing: "0.04em", textTransform: "uppercase" }}>memória</span>
            )}
            {(t.top.entry.comp || "").slice(0, 7) !== (t.date || "").slice(0, 7) && (
              <span title="Lançamento de competência de mês anterior"
                    style={{ fontFamily: "var(--mono)", fontSize: 9, padding: "1px 5px", borderRadius: 99,
                             background: "var(--bg-3)", color: "var(--fg-3)", border: "1px solid var(--line)",
                             letterSpacing: "0.04em" }}>comp. {fmtDate(t.top.entry.comp).slice(0, 5)}</span>
            )}
          </span>
        ) : t.mem ? (
          <span style={{ color: "var(--fg-3)", fontSize: 11 }}>memória: {t.mem.action === "ignore" ? "ignorar" : `classificar como ${t.mem.sampleLabel || "—"}`}</span>
        ) : !isDebit ? (
          <span style={{ color: "var(--fg-4)" }}>entrada (Faturamento)</span>
        ) : (
          <span style={{ color: "var(--fg-4)" }}>sem candidato</span>
        )}
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        {t.resolved || t.state === "ignored" ? (
          <button className="btn" data-variant="ghost" data-size="sm" disabled={busy} onClick={onReopen}>Reabrir</button>
        ) : (
          <div style={{ display: "inline-flex", gap: 4 }}>
            {t.top && (
              <button className="btn" data-variant="primary" data-size="sm" disabled={busy} onClick={onConciliar}>Conciliar</button>
            )}
            <button className="btn" data-size="sm" disabled={busy} onClick={onPick}>Buscar</button>
            {isDebit && <button className="btn" data-size="sm" disabled={busy} onClick={onAdd}>+ Adicionar</button>}
            <button className="btn" data-variant="ghost" data-size="sm" disabled={busy} onClick={onIgnore} title="Ignorar esta transação">
              <I.X size={12} />
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

// Modal de conferência: extrato × lançamento candidato, lado a lado, antes de confirmar.
function CompareDialog({ tx, cand, subcategories, supplierById, fmt, fmtDate, busy, hasNext, onClose, onConfirm, onConfirmNext }) {
  const ModalShell = window.ModalShell;
  const entry = cand.entry;
  const sub = subcategories.find((s) => s.id === entry.cat);
  const sup = entry.counterpartyId ? supplierById[entry.counterpartyId] : null;
  const valueOk = Math.abs(Number(entry.value) - tx.amount) < 0.01;
  const docOk = tx.document && sup && String(sup.cnpj || "").replace(/\D/g, "") === tx.document;
  const score = cand.score != null ? `${(cand.score * 100).toFixed(0)}%` : "—";

  const Side = ({ title, accent, children }) => (
    <div style={{ flex: 1, minWidth: 0, border: "1px solid var(--line)", borderRadius: 6, overflow: "hidden" }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)", background: "var(--bg-2)",
                    fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase",
                    color: accent }}>{title}</div>
      <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>
    </div>
  );
  const Row = ({ label, children, tone }) => (
    <div>
      <div style={{ fontSize: 10, color: "var(--fg-3)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, color: tone || "var(--fg-0)", letterSpacing: "-0.005em", wordBreak: "break-word" }}>{children}</div>
    </div>
  );

  return (
    <ModalShell
      title="Conferir e conciliar"
      subtitle="Compare o extrato com o lançamento antes de confirmar o vínculo."
      width={720}
      onClose={onClose}
      footer={<>
        <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 11, color: valueOk ? "var(--ok)" : "var(--warn)" }}>
          {valueOk ? "✓ valores conferem" : "⚠ valores diferentes"} · confiança {score}
        </span>
        <button className="btn" data-size="sm" onClick={onClose}>Cancelar</button>
        {hasNext && (
          <button className="btn" data-size="sm" disabled={busy} onClick={onConfirmNext}
                  title="Confirma esta e abre a próxima saída com candidato">
            Conciliar e continuar
          </button>
        )}
        <button className="btn" data-variant="primary" data-size="sm" disabled={busy} onClick={onConfirm}>
          Confirmar conciliação
        </button>
      </>}
    >
      <div style={{ display: "flex", gap: 14, alignItems: "stretch" }}>
        <Side title="Extrato bancário" accent="var(--crit)">
          <Row label="Valor" tone={valueOk ? "var(--ok)" : "var(--fg-0)"}>− {fmt(tx.amount)}</Row>
          <Row label="Data">{fmtDate(tx.date)}</Row>
          <Row label="Descrição">{tx.rawDesc || "—"}</Row>
          <Row label="Documento (CNPJ/CPF)" tone={docOk ? "var(--ok)" : "var(--fg-1)"}>
            {tx.document || "—"}{tx.identifiers?.e2e_id ? "  · PIX e2e" : ""}
          </Row>
        </Side>

        <div style={{ display: "grid", placeItems: "center", color: "var(--fg-3)" }}>
          <I.ArrowRight size={16} />
        </div>

        <Side title="Lançamento" accent="var(--accent-bright)">
          <Row label="Valor" tone={valueOk ? "var(--ok)" : "var(--fg-0)"}>{fmt(entry.value)}</Row>
          <Row label="Competência">{fmtDate(entry.comp)}</Row>
          <Row label="Descrição">{entry.desc || "—"}</Row>
          <Row label="Subcategoria">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 6, height: 6, borderRadius: 50, background: sub?.color || "#888" }} />
              {sub?.name || "—"}
            </span>
          </Row>
          <Row label="Contraparte" tone={docOk ? "var(--ok)" : "var(--fg-1)"}>
            {sup ? `${sup.name}${sup.cnpj ? ` · ${sup.cnpj}` : ""}` : "— (lançamento sem fornecedor)"}
          </Row>
        </Side>
      </div>

      <div style={{ marginTop: 14, fontSize: 11.5, color: "var(--fg-3)" }}>
        Sinais batidos: <strong style={{ color: "var(--fg-1)" }}>{(cand.signals || []).join(", ") || "—"}</strong>.
        {tx.memHit && tx.memHit.mem.action !== "ignore" && (
          <> Memória: já conciliado <strong style={{ color: "var(--fg-1)" }}>{tx.memHit.mem.occurrences}×</strong> com
            {" "}<strong style={{ color: "var(--fg-1)" }}>{tx.memHit.mem.sampleLabel || "essa contraparte"}</strong>
            {" "}(casou por {tx.memHit.docMatch && tx.memHit.nameMatch ? "CNPJ + nome" : tx.memHit.docMatch ? "CNPJ" : "nome"}).</>
        )}
        {!docOk && tx.document && (
          <> Para subir a confiança, cadastre o CNPJ <strong style={{ color: "var(--fg-1)" }}>{tx.document}</strong> no fornecedor deste lançamento.</>
        )}
      </div>
    </ModalShell>
  );
}

// Modal de busca manual de lançamentos (1:1 ou N:1 por seleção múltipla).
function CandidatePicker({ tx, entries, linkedEntryIds, subcategories, fmt, fmtDate, busy, onClose, onConfirm }) {
  const ModalShell = window.ModalShell;
  // Categoria aprendida pela memória (quando a saída não tem match mas já foi
  // classificada antes) — vira o filtro padrão do Buscar, removível.
  const memCat = tx.memHit && tx.memHit.mem.action !== "ignore" ? tx.memHit.mem.subcategoryId : null;
  const memCatName = memCat ? subcategories.find((s) => s.id === memCat)?.name : null;
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState(memCat || null);
  const [selected, setSelected] = useState([]);
  const available = entries.filter((e) => !linkedEntryIds.has(e.id));
  const q = search.trim();
  // Busca por valor: ignora R$, pontos e vírgulas. Compara os dígitos digitados com
  // os centavos do lançamento (517,87 → "51787"), casando por prefixo ou contido —
  // exibe valores parecidos com o que foi digitado.
  const qDigits = q.replace(/\D/g, "");
  const matchValue = (e) => {
    if (qDigits.length < 2) return false;
    const cents = String(Math.round((Number(e.value) || 0) * 100));
    return cents.startsWith(qDigits) || cents.includes(qDigits);
  };
  const matchText = (e) =>
    window.fuzzyMatch ? window.fuzzyMatch(e.desc, q) : (e.desc || "").toLowerCase().includes(q.toLowerCase());
  // Sem busca: lista filtrada pela categoria da memória (se ativa). Ao digitar, a
  // busca atravessa todas as categorias (o texto manda).
  const list = q
    ? available.filter((e) => matchText(e) || matchValue(e))
    : (catFilter ? available.filter((e) => e.cat === catFilter) : available);
  const toggle = (id) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  const selTotal = selected.reduce((s, id) => s + (entries.find((e) => e.id === id)?.value || 0), 0);
  const matchOk = Math.abs(selTotal - tx.amount) < 0.01;

  const isDebit = tx.direction === "debit";
  const FRow = ({ label, children, tone }) => (
    <div>
      <div style={{ fontSize: 10, color: "var(--fg-3)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 12.5, color: tone || "var(--fg-0)", wordBreak: "break-word" }}>{children}</div>
    </div>
  );

  return (
    <ModalShell
      title="Conciliar com lançamento(s)"
      subtitle="Compare a movimentação do extrato (à esquerda) e selecione o(s) lançamento(s)."
      width={760}
      onClose={onClose}
      footer={<>
        <span style={{ flex: 1, fontSize: 11.5, color: matchOk ? "var(--ok)" : "var(--fg-3)", fontFamily: "var(--mono)" }}>
          {selected.length > 0 ? `Selecionado: ${fmt(selTotal)} ${matchOk ? "✓ bate" : `(extrato ${fmt(tx.amount)})`}` : "Selecione 1+ lançamentos"}
        </span>
        <button className="btn" data-size="sm" onClick={onClose}>Cancelar</button>
        <button className="btn" data-variant="primary" data-size="sm" disabled={busy || selected.length === 0}
                onClick={() => onConfirm(selected)}>Conciliar</button>
      </>}
    >
     <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
      {/* Esquerda · movimentação do extrato sendo comparada */}
      <div style={{ width: 240, flexShrink: 0, border: "1px solid var(--line)", borderRadius: 6, overflow: "hidden" }}>
        <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)", background: "var(--bg-2)",
                      fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--crit)" }}>
          Extrato bancário
        </div>
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
          <FRow label="Valor" tone={matchOk ? "var(--ok)" : "var(--fg-0)"}>{isDebit ? "− " : "+ "}{fmt(tx.amount)}</FRow>
          <FRow label="Data">{fmtDate(tx.date)}</FRow>
          <FRow label="Tipo">{isDebit ? "Saída (débito)" : "Entrada (crédito)"}</FRow>
          <FRow label="Descrição">{tx.rawDesc || "—"}</FRow>
          <FRow label="Documento (CNPJ/CPF)">{tx.document || "—"}{tx.identifiers?.e2e_id ? "  · PIX e2e" : ""}</FRow>
        </div>
      </div>

      {/* Direita · busca + lista de lançamentos */}
      <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ position: "relative", marginBottom: 10 }}>
        <I.Search size={12} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--fg-3)" }} />
        <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus
               placeholder="Buscar por descrição ou valor (ex.: 517,87)…" style={{ width: "100%", paddingLeft: 28, fontSize: 12 }} />
      </div>
      {catFilter && !q && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 11, color: "var(--fg-3)" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 8px", borderRadius: 99,
                         background: "rgba(61,108,176,0.16)", color: "#7aa2e3", border: "1px solid rgba(61,108,176,0.35)" }}>
            memória · {memCatName || "categoria"}
          </span>
          <button className="btn" data-variant="ghost" data-size="sm" onClick={() => setCatFilter(null)}
                  style={{ padding: "2px 6px", fontSize: 10.5 }}>mostrar todos</button>
        </div>
      )}
      <div style={{ maxHeight: 360, overflow: "auto", border: "1px solid var(--line)", borderRadius: 4 }}>
        {list.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>
            {catFilter && !q
              ? <>Nenhum lançamento em <strong>{memCatName}</strong>. <button className="btn" data-variant="ghost" data-size="sm" onClick={() => setCatFilter(null)} style={{ padding: "1px 5px" }}>mostrar todos</button> ou use <strong>+ Adicionar</strong>.</>
              : <>Nenhum lançamento disponível. Use <strong>+ Adicionar</strong> para criar.</>}
          </div>
        )}
        {list.map((e) => {
          const sub = subcategories.find((s) => s.id === e.cat);
          const on = selected.includes(e.id);
          const close = Math.abs(e.value - tx.amount) < 0.01;
          return (
            <div key={e.id} onClick={() => toggle(e.id)} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", cursor: "pointer",
              borderBottom: "1px solid var(--line)", background: on ? "var(--bg-3)" : "transparent",
            }}>
              <input type="checkbox" checked={on} readOnly />
              <span style={{ width: 4, height: 4, borderRadius: 50, background: sub?.color || "#888" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row-strong" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.desc}</div>
                <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{sub?.name || "—"} · {fmtDate(e.comp)}</div>
              </div>
              <span className="num" style={{ color: close ? "var(--ok)" : "var(--fg-1)", fontFamily: "var(--mono)", fontSize: 12 }}>{fmt(e.value)}</span>
            </div>
          );
        })}
      </div>
      </div>
     </div>
    </ModalShell>
  );
}

window.Conciliacao = Conciliacao;
