// Analise de mercado - modulo isolado.
// Mantem o fluxo de cadastro e analise dentro deste arquivo. A chamada real de IA
// deve entrar em window.SK_CONFIG.marketAnalysisEndpoint quando o backend existir.

const AM_STORAGE_KEY = "stockkitchen.market-analysis.v1";
const AM_CONNECTION_KEY = "stockkitchen.market-analysis.openai.v1";

const AM_INITIAL_COMPETITORS = [
  { id: "comp-1", name: "Concorrente 1", url: "" },
  { id: "comp-2", name: "Concorrente 2", url: "" },
];

const AM_BASE_MENU = [
  { id: "smash", name: "Smash burger", category: "Burger", price: 34.9, tokens: ["smash", "burger", "hamburguer", "carne"] },
  { id: "cheese", name: "Cheeseburger", category: "Burger", price: 29.9, tokens: ["cheese", "burger", "hamburguer", "queijo"] },
  { id: "combo", name: "Combo burger + fritas", category: "Combo", price: 47.9, tokens: ["combo", "burger", "fritas", "bebida"] },
  { id: "fries", name: "Batata frita", category: "Acompanhamento", price: 18.9, tokens: ["batata", "frita", "fritas"] },
  { id: "soda", name: "Refrigerante lata", category: "Bebida", price: 7.9, tokens: ["refrigerante", "lata", "bebida"] },
  { id: "brownie", name: "Brownie", category: "Sobremesa", price: 16.9, tokens: ["brownie", "sobremesa", "chocolate"] },
];

function AnaliseMercado() {
  const saved = loadMarketDraft();
  const [brand, setBrand] = useState(saved.brand || { name: "", url: "" });
  const [competitors, setCompetitors] = useState(saved.competitors || AM_INITIAL_COMPETITORS);
  const [analysis, setAnalysis] = useState(saved.analysis || null);
  const [openAiConnection, setOpenAiConnection] = useState(() => loadOpenAiConnection());
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState("matrix");

  useEffect(() => {
    saveMarketDraft({ brand, competitors, analysis });
  }, [brand, competitors, analysis]);

  useEffect(() => {
    saveOpenAiConnection(openAiConnection);
  }, [openAiConnection]);

  const validCompetitors = useMemo(
    () => competitors.filter((item) => item.name.trim() && item.url.trim()),
    [competitors],
  );

  const canAnalyze = brand.name.trim() && brand.url.trim() && validCompetitors.length > 0 && !busy;

  const updateCompetitor = (id, patch) => {
    setCompetitors((cur) => cur.map((item) => item.id === id ? { ...item, ...patch } : item));
  };

  const addCompetitor = () => {
    const next = competitors.length + 1;
    setCompetitors((cur) => [...cur, { id: `comp-${Date.now()}`, name: `Concorrente ${next}`, url: "" }]);
  };

  const removeCompetitor = (id) => {
    setCompetitors((cur) => cur.length <= 1 ? cur : cur.filter((item) => item.id !== id));
  };

  const runAnalysis = async () => {
    if (!canAnalyze) return;
    setBusy(true);
    try {
      const result = await runMarketAiAnalysis({ brand, competitors: validCompetitors }, openAiConnection);
      setAnalysis(result);
      setActiveTab("matrix");
      window.showToast?.("Analise de mercado atualizada.", { tone: "ok" });
    } catch (err) {
      window.showToast?.(`Erro na analise: ${err?.message || err}`, { tone: "crit", ttl: 5000 });
    } finally {
      setBusy(false);
    }
  };

  const resetAnalysis = () => {
    setBrand({ name: "", url: "" });
    setCompetitors(AM_INITIAL_COMPETITORS);
    setAnalysis(null);
    setActiveTab("matrix");
  };

  return (
    <div style={am.page} className="stagger">
      <div style={am.header}>
        <div style={{ minWidth: 0 }}>
          <div className="h-eyebrow" style={{ marginBottom: 6 }}>Inteligencia competitiva</div>
          <h1 className="h-title">Analise de mercado</h1>
          <p className="h-sub">Marca, concorrentes do iFood, leitura de cardapio, avaliacoes e preco.</p>
        </div>
        <div style={am.headerActions}>
          <button className="btn" data-size="sm" onClick={resetAnalysis}>Limpar</button>
          <button className="btn" data-variant="primary" data-size="sm" disabled={!canAnalyze} onClick={runAnalysis}>
            {busy ? "Analisando..." : "Analisar com IA"}
          </button>
        </div>
      </div>

      <OpenAiConnectionCard connection={openAiConnection} onChange={setOpenAiConnection} />

      <div style={am.setupGrid}>
        <section className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">Marca analisada</h3>
              <span className="card-sub">Origem: link publico do iFood</span>
            </div>
          </div>
          <div style={am.formBody}>
            <FieldLabel label="Nome da marca">
              <input
                className="input"
                value={brand.name}
                onChange={(e) => setBrand((cur) => ({ ...cur, name: e.target.value }))}
                placeholder="Ex.: MobyDick Burger"
              />
            </FieldLabel>
            <FieldLabel label="Link do iFood">
              <input
                className="input"
                value={brand.url}
                onChange={(e) => setBrand((cur) => ({ ...cur, url: e.target.value }))}
                placeholder="https://www.ifood.com.br/delivery/..."
              />
            </FieldLabel>
            <UrlSignal url={brand.url} />
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">Concorrentes indicados</h3>
              <span className="card-sub">{validCompetitors.length} link(s) valido(s) para comparar</span>
            </div>
            <button className="btn" data-variant="ghost" data-size="sm" onClick={addCompetitor}>
              <I.Plus size={12} />Adicionar
            </button>
          </div>
          <div style={am.competitorList}>
            {competitors.map((item, index) => (
              <div key={item.id} style={am.competitorRow}>
                <div style={am.competitorIndex}>{String(index + 1).padStart(2, "0")}</div>
                <input
                  className="input"
                  value={item.name}
                  onChange={(e) => updateCompetitor(item.id, { name: e.target.value })}
                  placeholder="Nome do concorrente"
                  style={am.nameInput}
                />
                <input
                  className="input"
                  value={item.url}
                  onChange={(e) => updateCompetitor(item.id, { url: e.target.value })}
                  placeholder="Link do iFood"
                  style={am.urlInput}
                />
                <button
                  className="btn"
                  data-variant="ghost"
                  data-size="sm"
                  onClick={() => removeCompetitor(item.id)}
                  disabled={competitors.length <= 1}
                  title="Remover concorrente"
                >
                  <I.X size={12} />
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>

      {analysis ? (
        <MarketAnalysisResult analysis={analysis} activeTab={activeTab} setActiveTab={setActiveTab} />
      ) : (
        <MarketEmptyState canAnalyze={canAnalyze} busy={busy} onAnalyze={runAnalysis} />
      )}
    </div>
  );
}

function MarketAnalysisResult({ analysis, activeTab, setActiveTab }) {
  const target = analysis.entities[0];
  const competitors = analysis.entities.slice(1);

  return (
    <>
      <div style={am.kpiGrid}>
        <MarketKpi label="Share estimado" value={`${target.marketShare.toFixed(1)}%`} sub="entre links indicados" tone="ok" />
        <MarketKpi label="Avaliacoes" value={target.reviews.toLocaleString("pt-BR")} sub={`${target.rating.toFixed(1)} estrelas`} tone="info" />
        <MarketKpi label="Indice de preco" value={`${analysis.priceIndex.toFixed(0)}%`} sub={analysis.pricePosition} tone={analysis.priceTone} />
        <MarketKpi label="Cobertura comparavel" value={`${analysis.matchCoverage.toFixed(0)}%`} sub="itens com similaridade" tone="neutral" />
      </div>

      <div style={am.resultGrid}>
        <section className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">Mercado indicado</h3>
              <span className="card-sub">Percentual calculado por volume de avaliacoes</span>
            </div>
            <span className="badge" data-tone={analysis.source === "api" ? "ok" : "warn"}>{analysis.sourceLabel}</span>
          </div>
          <div style={am.shareRows}>
            {analysis.entities.map((item) => (
              <div key={item.id} style={am.shareRow}>
                <div style={am.shareHeader}>
                  <span style={am.entityName}>{item.name}</span>
                  <span className="mono" style={am.shareValue}>{item.marketShare.toFixed(1)}%</span>
                </div>
                <div style={am.shareTrack}>
                  <div style={{ ...am.shareFill, width: `${item.marketShare}%`, background: item.isTarget ? "var(--ok)" : "var(--info)" }} />
                </div>
                <div style={am.entityMeta}>
                  {item.reviews.toLocaleString("pt-BR")} avaliacoes / {item.rating.toFixed(1)} estrelas / {item.items.length} itens
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">Diagnostico de posicionamento</h3>
              <span className="card-sub">Preco, prova social e sortimento</span>
            </div>
          </div>
          <div style={am.insightList}>
            {analysis.insights.map((item) => (
              <div key={item.title} style={am.insight}>
                <span className="badge" data-tone={item.tone}>{item.label}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={am.insightTitle}>{item.title}</div>
                  <div style={am.insightText}>{item.text}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Comparativo item a item</h3>
            <span className="card-sub">Linhas: itens da marca / colunas: concorrentes indicados</span>
          </div>
          <div style={am.tabs}>
            <button className="btn" data-size="sm" data-variant={activeTab === "matrix" ? "primary" : "ghost"} onClick={() => setActiveTab("matrix")}>Tabela</button>
            <button className="btn" data-size="sm" data-variant={activeTab === "menu" ? "primary" : "ghost"} onClick={() => setActiveTab("menu")}>Cardapios</button>
          </div>
        </div>

        {activeTab === "matrix" ? (
          <PriceMatrix rows={analysis.matrix} competitors={competitors} />
        ) : (
          <MenuExtraction entities={analysis.entities} />
        )}
      </section>
    </>
  );
}

function OpenAiConnectionCard({ connection, onChange }) {
  const endpoint = connection?.endpoint || "";
  const keyEndpoint = connection?.keyEndpoint || "";
  const token = connection?.token || "";
  const configuredByEnv = Boolean(window.SK_CONFIG?.marketAnalysisEndpoint);
  const keyEndpointConfiguredByEnv = Boolean(window.SK_CONFIG?.marketOpenAiKeyEndpoint);
  const endpointLooksLikeOpenAiKey = looksLikeOpenAiKey(endpoint);
  const tokenLooksLikeOpenAiKey = looksLikeOpenAiKey(token);
  const configuredEndpoint = getMarketAnalysisEndpoint(connection);
  const configuredKeyEndpoint = getOpenAiKeyEndpoint(connection);
  const endpointIsUrl = !configuredEndpoint || isHttpUrl(configuredEndpoint);
  const analysisEndpointReady = Boolean(configuredEndpoint) && endpointIsUrl && !endpointLooksLikeOpenAiKey && !tokenLooksLikeOpenAiKey;
  const keyEndpointReady = Boolean(configuredKeyEndpoint) && isHttpUrl(configuredKeyEndpoint) && isSecureBackendUrl(configuredKeyEndpoint);
  const backendReady = analysisEndpointReady && keyEndpointReady;
  const [testState, setTestState] = useState(null);
  const [openAiKey, setOpenAiKey] = useState("");
  const [sendKeyState, setSendKeyState] = useState(null);
  const [sendingKey, setSendingKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const update = (patch) => {
    setTestState(null);
    setSendKeyState(null);
    onChange((cur) => ({ ...(cur || {}), ...patch }));
  };

  const testConnection = async () => {
    const target = getMarketAnalysisEndpoint(connection);
    if (!target) {
      setTestState({ tone: "warn", label: "Informe um endpoint" });
      return;
    }
    if (looksLikeOpenAiKey(target)) {
      setTestState({ tone: "warn", label: "Use a URL do backend, nao a chave" });
      return;
    }
    if (!isHttpUrl(target)) {
      setTestState({ tone: "warn", label: "Endpoint deve iniciar com http" });
      return;
    }
    try {
      const res = await fetch(target, {
        method: "POST",
        headers: await buildMarketAnalysisHeaders(connection),
        body: JSON.stringify(withMarketTenant({ ping: true })),
      });
      setTestState({
        tone: res.ok ? "ok" : "warn",
        label: res.ok ? "Endpoint respondeu" : `Resposta ${res.status}`,
      });
    } catch {
      setTestState({ tone: "crit", label: "Falha ao conectar" });
    }
  };

  const sendOpenAiKey = async () => {
    const target = getOpenAiKeyEndpoint(connection);
    const key = openAiKey.trim();
    if (!target) {
      setSendKeyState({ tone: "warn", label: "Informe endpoint de chave" });
      return;
    }
    if (!isHttpUrl(target)) {
      setSendKeyState({ tone: "warn", label: "Endpoint deve iniciar com http" });
      return;
    }
    if (!isSecureBackendUrl(target)) {
      setSendKeyState({ tone: "warn", label: "Use HTTPS para enviar a chave" });
      return;
    }
    if (!looksLikeOpenAiKey(key)) {
      setSendKeyState({ tone: "warn", label: "Chave OpenAI invalida" });
      return;
    }

    setSendingKey(true);
    setSendKeyState(null);
    try {
      const res = await fetch(target, {
        method: "POST",
        headers: await buildMarketAnalysisHeaders(connection),
        body: JSON.stringify(withMarketTenant({ openaiApiKey: key })),
      });
      if (!res.ok) throw new Error(await readMarketError(res));
      setOpenAiKey("");
      setSendKeyState({ tone: "ok", label: "Chave enviada ao backend" });
      window.showToast?.("Chave OpenAI enviada ao backend.", { tone: "ok" });
    } catch (err) {
      setSendKeyState({ tone: "crit", label: err?.message || "Falha ao enviar" });
    } finally {
      setSendingKey(false);
    }
  };

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">OpenAI para analises</h3>
          <span className="card-sub">{backendReady ? "Conexao tecnica pronta" : "Configuracao tecnica pendente"}</span>
        </div>
        <span className="badge" data-tone={backendReady ? "ok" : (endpointLooksLikeOpenAiKey || tokenLooksLikeOpenAiKey) ? "warn" : "neutral"}>
          {backendReady ? "Pronto" : (endpointLooksLikeOpenAiKey || tokenLooksLikeOpenAiKey) ? "Chave no campo errado" : "Backend pendente"}
        </span>
      </div>
      <div style={am.connectionBody}>
        <FieldLabel label="Chave OpenAI">
          <input
            className="input"
            type="password"
            value={openAiKey}
            onChange={(e) => {
              setOpenAiKey(e.target.value);
              setSendKeyState(null);
            }}
            placeholder="Cole a chave aqui somente para enviar ao backend"
            autoComplete="off"
          />
        </FieldLabel>
        <div style={am.simpleKeyActions}>
          <a
            href="https://platform.openai.com/api-keys"
            target="_blank"
            rel="noreferrer"
            className="btn"
            data-size="sm"
            style={am.connectionLink}
          >
            Gerar chave OpenAI
          </a>
          <button
            className="btn"
            data-variant="primary"
            data-size="sm"
            onClick={sendOpenAiKey}
            disabled={sendingKey || !keyEndpointReady || !openAiKey.trim()}
          >
            {sendingKey ? "Salvando..." : "Salvar chave"}
          </button>
          {sendKeyState && <span className="badge" data-tone={sendKeyState.tone}>{sendKeyState.label}</span>}
        </div>
        {!keyEndpointReady && (
          <div style={am.connectionWarning}>
            Voce ja pode colar a chave aqui, mas o administrador precisa configurar o backend antes de salvar.
          </div>
        )}
        {(endpointLooksLikeOpenAiKey || tokenLooksLikeOpenAiKey) && (
          <div style={am.connectionWarning}>
            Voce colou uma chave OpenAI na tela. Essa chave deve ficar em uma variavel de ambiente do backend,
            como OPENAI_API_KEY. Nos campos tecnicos, informe apenas URLs do backend.
          </div>
        )}
        <div style={am.connectionActions}>
          <span style={am.securityNote}>A chave nao fica salva no navegador; ela e enviada ao backend seguro e o campo e limpo.</span>
          <a
            href="https://platform.openai.com/docs/api-reference/introduction#authentication"
            target="_blank"
            rel="noreferrer"
            className="btn"
            data-variant="ghost"
            data-size="sm"
            style={am.connectionLink}
          >
            Docs API
          </a>
          <button className="btn" data-variant="ghost" data-size="sm" onClick={() => setShowAdvanced((cur) => !cur)}>
            Configuracao tecnica
          </button>
        </div>

        {showAdvanced && (
          <div style={am.advancedConnection}>
            <FieldLabel label="Endpoint de analise">
              <input
                className="input"
                value={endpoint}
                onChange={(e) => update({ endpoint: e.target.value })}
                placeholder={configuredByEnv ? "Configurado por VITE_MARKET_ANALYSIS_ENDPOINT" : "https://sua-api.com/market-analysis"}
                disabled={configuredByEnv}
              />
            </FieldLabel>
            <FieldLabel label="Endpoint para salvar chave">
              <input
                className="input"
                value={keyEndpoint}
                onChange={(e) => update({ keyEndpoint: e.target.value })}
                placeholder={keyEndpointConfiguredByEnv ? "Configurado por VITE_MARKET_OPENAI_KEY_ENDPOINT" : "https://sua-api.com/openai-key"}
                disabled={keyEndpointConfiguredByEnv}
              />
            </FieldLabel>
            <FieldLabel label="Token da sua API">
              <input
                className="input"
                type="password"
                value={token}
                onChange={(e) => update({ token: e.target.value })}
                placeholder="Opcional"
              />
            </FieldLabel>
            <div style={am.advancedActions}>
              <button className="btn" data-variant="ghost" data-size="sm" onClick={() => update({ endpoint: "", keyEndpoint: "", token: "" })} disabled={(configuredByEnv && keyEndpointConfiguredByEnv) || (!endpoint && !keyEndpoint && !token)}>
                Limpar conexao
              </button>
              <button className="btn" data-size="sm" onClick={testConnection} disabled={!configuredEndpoint || endpointLooksLikeOpenAiKey || tokenLooksLikeOpenAiKey}>Testar analise</button>
              {testState && <span className="badge" data-tone={testState.tone}>{testState.label}</span>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function PriceMatrix({ rows, competitors }) {
  return (
    <div style={am.tableScroll}>
      <table className="table" data-density="compact" style={am.matrixTable}>
        <thead>
          <tr>
            <th style={am.stickyCol}>Item da marca</th>
            <th className="num">Preco</th>
            {competitors.map((item) => (
              <th key={item.id} className="num">{item.name}</th>
            ))}
            <th>Leitura IA</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td style={am.stickyCell}>
                <div className="row-strong">{row.name}</div>
                <div className="dim" style={{ fontSize: 11 }}>{row.category}</div>
              </td>
              <td className="num">{fmtMarketMoney(row.price)}</td>
              {competitors.map((comp) => {
                const match = row.matches[comp.id];
                return (
                  <td key={comp.id} className="num">
                    {match ? (
                      <div style={am.matchCell}>
                        <span>{fmtMarketMoney(match.price)}</span>
                        <span className="badge" data-tone={match.tone}>{match.deltaLabel}</span>
                        <span style={am.matchName}>{match.name}</span>
                      </div>
                    ) : (
                      <span className="dim">Sem similar</span>
                    )}
                  </td>
                );
              })}
              <td style={am.recommendationCell}>{row.recommendation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MenuExtraction({ entities }) {
  return (
    <div style={am.menuGrid}>
      {entities.map((entity) => (
        <div key={entity.id} style={am.menuPanel}>
          <div style={am.menuPanelHeader}>
            <div style={am.entityName}>{entity.name}</div>
            <span className="badge" data-tone={entity.isTarget ? "ok" : "info"}>{entity.items.length} itens</span>
          </div>
          <div style={am.menuItems}>
            {entity.items.map((item) => (
              <div key={item.id} style={am.menuItem}>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
                <span className="mono">{fmtMarketMoney(item.price)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function MarketEmptyState({ canAnalyze, busy, onAnalyze }) {
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">Fila de analise</h3>
          <span className="card-sub">Coleta, extracao, similaridade e recomendacoes</span>
        </div>
        <button className="btn" data-variant="primary" data-size="sm" disabled={!canAnalyze} onClick={onAnalyze}>
          {busy ? "Analisando..." : "Executar"}
        </button>
      </div>
      <div style={am.pipeline}>
        {[
          ["1", "Coleta das paginas", "Marca e concorrentes informados"],
          ["2", "Extracao do cardapio", "Itens, precos, categorias e promocoes"],
          ["3", "Leitura de prova social", "Avaliacoes, nota e volume relativo"],
          ["4", "Comparacao semantica", "Itens parecidos cruzados por concorrente"],
          ["5", "Recomendacao de preco", "Tabela item a item e posicionamento"],
        ].map(([step, title, text]) => (
          <div key={step} style={am.pipelineStep}>
            <div style={am.pipelineNumber}>{step}</div>
            <div>
              <div style={am.pipelineTitle}>{title}</div>
              <div style={am.pipelineText}>{text}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function FieldLabel({ label, children }) {
  return (
    <label style={am.field}>
      <span style={am.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

function UrlSignal({ url }) {
  if (!url.trim()) return <span className="badge" data-tone="neutral">Link pendente</span>;
  const ok = isLikelyIfoodUrl(url);
  return <span className="badge" data-tone={ok ? "ok" : "warn"}>{ok ? "Link iFood detectado" : "Verificar dominio"}</span>;
}

function MarketKpi({ label, value, sub, tone }) {
  const color =
    tone === "ok" ? "var(--ok)" :
    tone === "info" ? "var(--info)" :
    tone === "warn" ? "var(--warn)" :
    tone === "crit" ? "var(--crit)" :
    "var(--fg-0)";

  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value" style={{ color }}>{value}</div>
      <div className="sub" style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 6 }}>{sub}</div>
    </div>
  );
}

async function runMarketAiAnalysis(payload, connection) {
  const endpoint = getMarketAnalysisEndpoint(connection);
  if (endpoint) {
    if (looksLikeOpenAiKey(endpoint)) {
      throw new Error("Cole a URL do backend no endpoint. A chave OpenAI fica no servidor.");
    }
    if (looksLikeOpenAiKey(connection?.token)) {
      throw new Error("O token da tela nao deve ser a chave OpenAI. Use a chave apenas no backend.");
    }
    if (!isHttpUrl(endpoint)) {
      throw new Error("Endpoint de analise deve iniciar com http:// ou https://.");
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers: await buildMarketAnalysisHeaders(connection),
      body: JSON.stringify(withMarketTenant(payload)),
    });
    if (!res.ok) throw new Error(await readMarketError(res));
    const data = await res.json();
    return { ...data, source: "api", sourceLabel: "OpenAI API" };
  }

  await delay(900);
  return buildLocalMarketAnalysis(payload);
}

function getMarketAnalysisEndpoint(connection) {
  return String(
    window.SK_CONFIG?.marketAnalysisEndpoint ||
    connection?.endpoint ||
    getSupabaseFunctionUrl("market-analysis") ||
    ""
  ).trim();
}

function getOpenAiKeyEndpoint(connection) {
  return String(
    window.SK_CONFIG?.marketOpenAiKeyEndpoint ||
    connection?.keyEndpoint ||
    getSupabaseFunctionUrl("market-openai-key") ||
    ""
  ).trim();
}

function getSupabaseFunctionUrl(name) {
  const base = String(window.SK_CONFIG?.supabaseUrl || "").replace(/\/+$/, "");
  return base ? `${base}/functions/v1/${name}` : "";
}

async function buildMarketAnalysisHeaders(connection) {
  const headers = { "content-type": "application/json" };
  const session = typeof dbGetSession === "function" ? await dbGetSession() : null;
  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
    return headers;
  }
  const token = String(connection?.token || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function withMarketTenant(payload) {
  const tenantId = getMarketTenantId();
  return tenantId ? { ...payload, tenantId } : payload;
}

async function readMarketError(res) {
  const fallback = `API IA retornou ${res.status}`;
  try {
    const text = await res.text();
    if (!text) return fallback;
    try {
      const data = JSON.parse(text);
      return data?.error || data?.message || fallback;
    } catch {
      return text.slice(0, 240) || fallback;
    }
  } catch {
    return fallback;
  }
}

function getMarketTenantId() {
  try {
    const sess = typeof getSession === "function" ? getSession() : JSON.parse(localStorage.getItem("stockkitchen.session.v1") || "null");
    return sess?.tenantId || null;
  } catch {
    return null;
  }
}

function looksLikeOpenAiKey(value) {
  return String(value || "").trim().startsWith("sk-");
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isSecureBackendUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function buildLocalMarketAnalysis({ brand, competitors }) {
  const target = buildEntity({
    id: "target",
    name: brand.name.trim() || "Minha marca",
    url: brand.url,
    index: 0,
    isTarget: true,
    priceFactor: 1,
  });

  const compEntities = competitors.map((item, index) => buildEntity({
    id: item.id,
    name: item.name.trim() || `Concorrente ${index + 1}`,
    url: item.url,
    index: index + 1,
    isTarget: false,
    priceFactor: 0.92 + ((stableScore(item.name + item.url) % 28) / 100),
  }));

  const entities = [target, ...compEntities];
  const totalReviews = entities.reduce((sum, item) => sum + item.reviews, 0) || 1;
  entities.forEach((item) => {
    item.marketShare = (item.reviews / totalReviews) * 100;
  });

  const matrix = target.items.map((item) => {
    const matches = {};
    for (const comp of compEntities) {
      const match = findClosestItem(item, comp.items);
      if (!match) continue;
      const delta = ((item.price - match.price) / match.price) * 100;
      matches[comp.id] = {
        name: match.name,
        price: match.price,
        delta,
        deltaLabel: `${delta > 0 ? "+" : ""}${delta.toFixed(0)}%`,
        tone: Math.abs(delta) <= 5 ? "ok" : delta > 5 ? "warn" : "info",
      };
    }
    return {
      ...item,
      matches,
      recommendation: buildItemRecommendation(item, matches),
    };
  });

  const avgTarget = avg(target.items.map((item) => item.price));
  const avgMarket = avg(compEntities.flatMap((item) => item.items.map((menuItem) => menuItem.price)));
  const priceIndex = avgMarket > 0 ? (avgTarget / avgMarket) * 100 : 100;
  const matchedCells = matrix.reduce((sum, row) => sum + Object.keys(row.matches).length, 0);
  const possibleCells = matrix.length * Math.max(compEntities.length, 1);
  const matchCoverage = possibleCells > 0 ? (matchedCells / possibleCells) * 100 : 0;
  const priceTone = priceIndex > 108 ? "warn" : priceIndex < 92 ? "info" : "ok";
  const pricePosition =
    priceIndex > 108 ? "acima da cesta" :
    priceIndex < 92 ? "abaixo da cesta" :
    "alinhado a cesta";

  return {
    source: "local",
    sourceLabel: "Previa local",
    generatedAt: new Date().toISOString(),
    entities,
    matrix,
    priceIndex,
    priceTone,
    pricePosition,
    matchCoverage,
    insights: buildMarketInsights(target, compEntities, priceIndex),
  };
}

function buildEntity({ id, name, url, index, isTarget, priceFactor }) {
  const seed = stableScore(name + url + index);
  const reviews = Math.max(80, Math.round((isTarget ? 740 : 480) + (seed % 1800) + index * 130));
  const rating = Math.min(5, 4.1 + ((seed % 8) / 10));
  const itemOffset = ((seed % 13) - 6) / 100;
  const items = AM_BASE_MENU.map((item, menuIndex) => {
    const compNoise = isTarget ? 0 : (((seed + menuIndex * 7) % 17) - 8) / 100;
    const price = roundMoney(item.price * (priceFactor + itemOffset + compNoise));
    return {
      ...item,
      id: `${id}-${item.id}`,
      name: isTarget ? item.name : renameCompetitorItem(item.name, menuIndex, seed),
      price,
    };
  });

  return { id, name, url, isTarget, reviews, rating, items };
}

function renameCompetitorItem(name, index, seed) {
  const suffixes = ["classico", "especial", "da casa", "premium", "combo"];
  if (index === 4) return "Bebida lata";
  if (index === 5) return (seed % 2 === 0) ? "Brownie chocolate" : "Sobremesa brownie";
  return `${name} ${suffixes[(seed + index) % suffixes.length]}`;
}

function findClosestItem(target, items) {
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const score = similarityScore(target, item);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= 0.34 ? best : null;
}

function similarityScore(a, b) {
  const tokensA = new Set([...(a.tokens || []), ...tokenize(a.name), tokenize(a.category)].flat());
  const tokensB = new Set([...(b.tokens || []), ...tokenize(b.name), tokenize(b.category)].flat());
  const intersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size || 1;
  const categoryBoost = a.category === b.category ? 0.25 : 0;
  return (intersection / union) + categoryBoost;
}

function buildItemRecommendation(item, matches) {
  const values = Object.values(matches);
  if (!values.length) return "Sem base suficiente para comparar.";
  const avgComp = avg(values.map((match) => match.price));
  const diff = ((item.price - avgComp) / avgComp) * 100;
  if (diff > 12) return "Preco acima dos similares; validar valor percebido ou reduzir ancoragem.";
  if (diff > 5) return "Levemente acima; manter se houver diferencial claro no cardapio.";
  if (diff < -12) return "Preco abaixo dos similares; ha espaco para testar reajuste.";
  if (diff < -5) return "Levemente abaixo; bom para aquisicao, mas revisar margem.";
  return "Preco alinhado aos similares indicados.";
}

function buildMarketInsights(target, competitors, priceIndex) {
  const avgCompetitorRating = avg(competitors.map((item) => item.rating));
  const avgCompetitorReviews = avg(competitors.map((item) => item.reviews));
  return [
    {
      label: priceIndex > 108 ? "Preco alto" : priceIndex < 92 ? "Preco baixo" : "Preco ok",
      tone: priceIndex > 108 ? "warn" : priceIndex < 92 ? "info" : "ok",
      title: "Posicionamento de preco",
      text: `A cesta da marca esta em ${priceIndex.toFixed(0)}% da media dos concorrentes indicados.`,
    },
    {
      label: target.reviews >= avgCompetitorReviews ? "Forte" : "Atencao",
      tone: target.reviews >= avgCompetitorReviews ? "ok" : "warn",
      title: "Prova social",
      text: `${target.reviews.toLocaleString("pt-BR")} avaliacoes contra media competitiva de ${Math.round(avgCompetitorReviews).toLocaleString("pt-BR")}.`,
    },
    {
      label: target.rating >= avgCompetitorRating ? "Acima" : "Abaixo",
      tone: target.rating >= avgCompetitorRating ? "ok" : "warn",
      title: "Nota relativa",
      text: `Nota ${target.rating.toFixed(1)} vs. media ${avgCompetitorRating.toFixed(1)} nos concorrentes cadastrados.`,
    },
  ];
}

function loadMarketDraft() {
  try {
    const raw = localStorage.getItem(AM_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveMarketDraft(payload) {
  try {
    localStorage.setItem(AM_STORAGE_KEY, JSON.stringify(payload));
  } catch {}
}

function loadOpenAiConnection() {
  try {
    const raw = localStorage.getItem(AM_CONNECTION_KEY);
    return raw ? JSON.parse(raw) : { endpoint: "", keyEndpoint: "", token: "" };
  } catch {
    return { endpoint: "", keyEndpoint: "", token: "" };
  }
}

function saveOpenAiConnection(payload) {
  try {
    localStorage.setItem(AM_CONNECTION_KEY, JSON.stringify(payload || { endpoint: "", keyEndpoint: "", token: "" }));
  } catch {}
}

function isLikelyIfoodUrl(url) {
  try {
    return new URL(url).hostname.includes("ifood.com");
  } catch {
    return false;
  }
}

function stableScore(input) {
  const str = String(input || "");
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function avg(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : 0;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function fmtMarketMoney(value) {
  return `R$ ${Number(value || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const am = {
  page: { padding: "24px 28px 32px", display: "flex", flexDirection: "column", gap: 20 },
  header: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, flexWrap: "wrap" },
  headerActions: { display: "flex", alignItems: "center", gap: 8 },
  setupGrid: { display: "grid", gridTemplateColumns: "minmax(280px, 0.72fr) minmax(380px, 1.28fr)", gap: 12, alignItems: "stretch" },
  connectionBody: { padding: 16, display: "grid", gridTemplateColumns: "minmax(260px, 1fr) minmax(200px, 0.45fr)", gap: 12, alignItems: "end" },
  simpleKeyActions: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  connectionActions: { gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  connectionLink: { textDecoration: "none" },
  connectionWarning: { gridColumn: "1 / -1", padding: "8px 10px", borderRadius: 4, border: "1px solid var(--warn-line)", background: "var(--warn-soft)", color: "var(--warn)", fontSize: 11.5, lineHeight: 1.45 },
  securityNote: { flex: 1, minWidth: 260, fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.4 },
  advancedConnection: { gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "minmax(220px, 1fr) minmax(220px, 1fr) minmax(160px, 0.6fr)", gap: 12, padding: 12, border: "1px solid var(--line-soft)", borderRadius: 4, background: "var(--bg-1)" },
  advancedActions: { gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  formBody: { padding: 16, display: "flex", flexDirection: "column", gap: 12 },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  fieldLabel: { fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", textTransform: "uppercase" },
  competitorList: { display: "flex", flexDirection: "column", padding: 12, gap: 8 },
  competitorRow: { display: "grid", gridTemplateColumns: "34px minmax(130px, 0.45fr) minmax(220px, 1fr) 34px", gap: 8, alignItems: "center" },
  competitorIndex: { fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", textAlign: "center" },
  nameInput: { minWidth: 0 },
  urlInput: { minWidth: 0 },
  kpiGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 },
  resultGrid: { display: "grid", gridTemplateColumns: "minmax(360px, 1fr) minmax(320px, 0.85fr)", gap: 12, alignItems: "stretch" },
  shareRows: { padding: 16, display: "flex", flexDirection: "column", gap: 14 },
  shareRow: { display: "flex", flexDirection: "column", gap: 6 },
  shareHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
  shareTrack: { height: 8, borderRadius: 2, overflow: "hidden", background: "var(--bg-3)", border: "1px solid var(--line-soft)" },
  shareFill: { height: "100%", minWidth: 2 },
  shareValue: { fontSize: 12, color: "var(--fg-0)" },
  entityName: { fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  entityMeta: { fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.04em" },
  insightList: { padding: 16, display: "flex", flexDirection: "column", gap: 14 },
  insight: { display: "grid", gridTemplateColumns: "96px 1fr", gap: 12, alignItems: "flex-start" },
  insightTitle: { fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500, marginBottom: 3 },
  insightText: { fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.45 },
  tabs: { display: "flex", gap: 6, alignItems: "center" },
  tableScroll: { overflowX: "auto" },
  matrixTable: { minWidth: 980 },
  stickyCol: { position: "sticky", left: 0, background: "var(--bg-1)", zIndex: 2 },
  stickyCell: { position: "sticky", left: 0, background: "var(--bg-1)", zIndex: 1, minWidth: 190 },
  matchCell: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 },
  matchName: { maxWidth: 180, color: "var(--fg-3)", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  recommendationCell: { minWidth: 230, color: "var(--fg-1)", fontSize: 11.5, lineHeight: 1.4 },
  menuGrid: { padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 },
  menuPanel: { border: "1px solid var(--line-soft)", borderRadius: 4, overflow: "hidden", background: "var(--bg-1)" },
  menuPanelHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--line-soft)" },
  menuItems: { display: "flex", flexDirection: "column" },
  menuItem: { display: "grid", gridTemplateColumns: "1fr auto", gap: 12, padding: "8px 12px", borderBottom: "1px solid var(--line-soft)", fontSize: 11.5, color: "var(--fg-1)" },
  pipeline: { padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 },
  pipelineStep: { display: "grid", gridTemplateColumns: "30px 1fr", gap: 10, padding: 12, border: "1px solid var(--line-soft)", borderRadius: 4, background: "var(--bg-1)" },
  pipelineNumber: { width: 24, height: 24, borderRadius: 3, display: "grid", placeItems: "center", background: "var(--accent-soft)", color: "var(--accent-bright)", fontFamily: "var(--mono)", fontSize: 10 },
  pipelineTitle: { fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500, marginBottom: 2 },
  pipelineText: { fontSize: 11, color: "var(--fg-3)", lineHeight: 1.35 },
};

window.AnaliseMercado = AnaliseMercado;
