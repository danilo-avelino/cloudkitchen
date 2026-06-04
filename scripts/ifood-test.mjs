// ifood-test.mjs — teste local do fluxo distribuído do iFood (app de testes).
//
// Espelha a edge function `ifood-sales-sync`, mas roda local em ETAPAS (subcomandos),
// salvando o estado em scripts/.ifood-state.json (gitignored) entre cada uma — assim
// a autorização no navegador acontece "no meio" sem precisar de terminal interativo.
//
//   node scripts/ifood-test.mjs auth
//        → gera userCode + URL. Você abre a URL, autoriza a loja e copia o authorizationCode.
//   node scripts/ifood-test.mjs token <authorizationCode>
//        → troca o código por access/refresh token e lista os merchants.
//   node scripts/ifood-test.mjs sales [beginLocalDate] [endLocalDate]
//        → puxa as vendas do período (default: últimos 7 dias) e salva em ifood-out.json.
//
// Credenciais: arquivo `.env.ifood` (gitignored) na raiz, com:
//   IFOOD_CLIENT_ID=...
//   IFOOD_CLIENT_SECRET=...

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATE_PATH = join(__dirname, ".ifood-state.json");
const OUT_PATH = join(__dirname, "ifood-out.json");

const IFOOD_BASE = "https://merchant-api.ifood.com.br";
const AUTH = `${IFOOD_BASE}/authentication/v1.0/oauth`;

// ---------- credenciais ----------
function loadCreds() {
  let id = process.env.IFOOD_CLIENT_ID || "";
  let secret = process.env.IFOOD_CLIENT_SECRET || "";
  try {
    const txt = readFileSync(join(ROOT, ".env.ifood"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, "");
      if (m[1] === "IFOOD_CLIENT_ID" && !id) id = val;
      if (m[1] === "IFOOD_CLIENT_SECRET" && !secret) secret = val;
    }
  } catch { /* sem arquivo, usa env */ }
  if (!id || !secret) {
    console.error("✗ Faltam IFOOD_CLIENT_ID / IFOOD_CLIENT_SECRET (crie .env.ifood ou exporte as vars).");
    process.exit(1);
  }
  return { id, secret };
}

// ---------- estado ----------
function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}
function saveState(patch) {
  const next = { ...loadState(), ...patch };
  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
  return next;
}

// ---------- http ----------
async function postForm(url, fields) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url.split("/").pop()} ${res.status}: ${text}`);
  return JSON.parse(text);
}
async function apiGet(url, accessToken) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

// ---------- token válido (refresh automático) ----------
async function getValidAccessToken(creds) {
  const st = loadState();
  if (!st.access_token) throw new Error("Sem token — rode `token <authorizationCode>` antes.");
  if (st.token_expires_at && st.token_expires_at - 60_000 > Date.now()) return st.access_token;
  if (!st.refresh_token) throw new Error("Token expirado e sem refresh_token — refaça `auth` + `token`.");
  const tok = await postForm(`${AUTH}/token`, {
    grantType: "refresh_token",
    clientId: creds.id,
    clientSecret: creds.secret,
    refreshToken: st.refresh_token,
  });
  persistTokens(tok);
  return tok.accessToken;
}
function persistTokens(tok) {
  saveState({
    access_token: tok.accessToken,
    refresh_token: tok.refreshToken,
    token_expires_at: Date.now() + (Number(tok.expiresIn) || 0) * 1000,
  });
}

// ---------- comandos ----------
async function cmdAuth(creds) {
  console.log("[auth] Gerando userCode…");
  const uc = await postForm(`${AUTH}/userCode`, { clientId: creds.id });
  saveState({ authorization_code_verifier: uc.authorizationCodeVerifier });
  console.log("  resposta crua:", JSON.stringify(uc, null, 2));
  console.log("\n  ➜ Abra esta URL e autorize a loja de testes:");
  console.log(`     ${uc.verificationUrlComplete || uc.verificationUrl}`);
  console.log(`  ➜ userCode: ${uc.userCode}`);
  console.log(`  ➜ Expira em ~${uc.expiresIn}s`);
  console.log("\n  Depois rode:  node scripts/ifood-test.mjs token <authorizationCode>\n");
}

async function cmdToken(creds, authorizationCode) {
  if (!authorizationCode) throw new Error("Uso: token <authorizationCode>");
  const st = loadState();
  if (!st.authorization_code_verifier) throw new Error("Verifier ausente — rode `auth` antes.");
  console.log("[token] Trocando authorizationCode por token…");
  const tok = await postForm(`${AUTH}/token`, {
    grantType: "authorization_code",
    clientId: creds.id,
    clientSecret: creds.secret,
    authorizationCode: authorizationCode.trim(),
    authorizationCodeVerifier: st.authorization_code_verifier,
  });
  persistTokens(tok);
  console.log(`  ✓ access_token OK (expira em ${tok.expiresIn}s). refresh_token: ${tok.refreshToken ? "sim" : "não"}`);

  console.log("[token] Listando merchants…");
  const merchants = await apiGet(`${IFOOD_BASE}/merchant/v1.0/merchants`, tok.accessToken);
  if (Array.isArray(merchants)) {
    console.log(`  ✓ ${merchants.length} merchant(s):`);
    merchants.forEach((m, i) => console.log(`     [${i}] ${m.name || m.corporateName || "?"}  id=${m.id}`));
    if (merchants.length >= 1) saveState({ merchant_id: merchants[0].id, merchants });
  } else {
    console.log("  merchants (resposta crua):", JSON.stringify(merchants).slice(0, 800));
  }
  console.log("\n  Depois rode:  node scripts/ifood-test.mjs sales [begin] [end]\n");
}

async function cmdSales(creds, begin, end, merchantArg) {
  const accessToken = await getValidAccessToken(creds);
  const st = loadState();
  const merchantId = merchantArg || st.merchant_id;
  if (!merchantId) throw new Error("Sem merchantId — rode `token` (lista merchants) ou passe o id.");

  const today = new Date();
  end = end || today.toISOString().slice(0, 10);
  begin = begin || new Date(today.getTime() - 7 * 864e5).toISOString().slice(0, 10);

  console.log(`[sales] Puxando vendas de ${begin} a ${end} (merchant ${merchantId})…`);
  const all = [];
  let page = 1;
  while (page <= 100) {
    const url = new URL(`${IFOOD_BASE}/financial/v2.1/merchants/${merchantId}/sales`);
    url.searchParams.set("beginLocalDate", begin);
    url.searchParams.set("endLocalDate", end);
    url.searchParams.set("page", String(page));
    const res = await fetch(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`sales ${res.status} (merchant ${merchantId}): ${text}`);
    const data = JSON.parse(text);
    const items = Array.isArray(data) ? data : (data.sales || data.content || data.data || []);
    all.push(...items);
    const hasNext = !Array.isArray(data) && (data.hasNextPage ?? (page < (data.totalPages ?? 1)));
    if (!hasNext || items.length === 0) break;
    page++;
  }

  console.log(`  ✓ ${all.length} venda(s).`);
  writeFileSync(OUT_PATH, JSON.stringify({ merchantId, period: { begin, end }, count: all.length, sales: all }, null, 2));
  console.log(`  ✓ salvo em ${OUT_PATH}`);
  if (all.length > 0) {
    console.log("\n  Amostra (primeira venda):");
    console.log(JSON.stringify(all[0], null, 2).split("\n").map((l) => "    " + l).join("\n"));
  }
}

// ---------- Order API (homologação) ----------
// Passos 1–3 do guia: polling de eventos → acknowledgment → detalhes do pedido.

async function cmdPoll(creds, autoAck) {
  const accessToken = await getValidAccessToken(creds);
  const data = await apiGet(`${IFOOD_BASE}/order/v1.0/orders/events:polling`, accessToken);
  const events = Array.isArray(data) ? data : (data.events || []);
  console.log(`[poll] ${events.length} evento(s).`);
  events.forEach((e) =>
    console.log(`   • ${e.fullCode || e.code}  order=${e.orderId}  evt=${e.id}  ${e.createdAt || ""}`));
  writeFileSync(join(__dirname, "ifood-events.json"), JSON.stringify(events, null, 2));
  if (events.length) console.log(`   ✓ salvo em ${join(__dirname, "ifood-events.json")}`);

  if (autoAck && events.length) {
    const ids = events.map((e) => e.id);
    await ackEvents(accessToken, ids);
    console.log(`   ✓ acknowledged ${ids.length} evento(s).`);
  } else if (events.length) {
    console.log(`   ➜ para confirmar a leitura: node scripts/ifood-test.mjs ack ${events.map((e) => e.id).join(",")}`);
  }
}

async function ackEvents(accessToken, ids) {
  // Guia: POST /order/v1.0/orders/events/acknowledgment  { acknowledgedEventIds: [...] }
  const res = await fetch(`${IFOOD_BASE}/order/v1.0/orders/events/acknowledgment`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ acknowledgedEventIds: ids }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ack ${res.status}: ${text}`);
}

async function cmdAck(creds, idsArg) {
  if (!idsArg) throw new Error("Uso: ack <evt1,evt2,...>");
  const accessToken = await getValidAccessToken(creds);
  const ids = idsArg.split(",").map((s) => s.trim()).filter(Boolean);
  await ackEvents(accessToken, ids);
  console.log(`[ack] ✓ ${ids.length} evento(s) confirmado(s).`);
}

async function cmdOrder(creds, orderId) {
  if (!orderId) throw new Error("Uso: order <orderId>");
  const accessToken = await getValidAccessToken(creds);
  const order = await apiGet(`${IFOOD_BASE}/order/v1.0/orders/${orderId}`, accessToken);
  const outPath = join(__dirname, `ifood-order-${orderId}.json`);
  writeFileSync(outPath, JSON.stringify(order, null, 2));
  console.log(`[order] ✓ detalhes salvos em ${outPath}`);
  console.log(JSON.stringify(order, null, 2).split("\n").slice(0, 40).map((l) => "    " + l).join("\n"));
}

// ---------- entry ----------
const creds = loadCreds();
const [cmd, ...args] = process.argv.slice(2);

try {
  if (cmd === "auth") await cmdAuth(creds);
  else if (cmd === "token") await cmdToken(creds, args[0]);
  else if (cmd === "sales") await cmdSales(creds, args[0], args[1], args[2]);
  else if (cmd === "poll") await cmdPoll(creds, args[0] === "--ack");
  else if (cmd === "ack") await cmdAck(creds, args[0]);
  else if (cmd === "order") await cmdOrder(creds, args[0]);
  else {
    console.log("Uso:");
    console.log("  node scripts/ifood-test.mjs auth");
    console.log("  node scripts/ifood-test.mjs token <authorizationCode>");
    console.log("  node scripts/ifood-test.mjs sales [beginLocalDate] [endLocalDate] [merchantId]");
    console.log("  node scripts/ifood-test.mjs poll [--ack]      # Order: puxa eventos (--ack confirma leitura)");
    console.log("  node scripts/ifood-test.mjs ack <evt1,evt2>   # Order: confirma leitura de eventos");
    console.log("  node scripts/ifood-test.mjs order <orderId>   # Order: detalhes de um pedido");
  }
} catch (e) {
  console.error("\n✗ Erro:", e.message, "\n");
  process.exitCode = 1;
}
