import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ENCRYPTION_SECRET = Deno.env.get("MARKET_KEY_ENCRYPTION_SECRET") || "";
const DEFAULT_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4.1-mini";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    if (body.ping) return json({ ok: true, service: "market-analysis" });

    const token = getBearer(req);
    if (!token) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const tenantId = await resolveTenantId(admin, user.id, body.tenantId);
    if (!tenantId) return json({ error: "Tenant nao encontrado para o usuario" }, 400);
    const role = await getTenantRole(admin, tenantId, user.id);
    if (!role) return json({ error: "Forbidden" }, 403);

    const { data: settings, error: keyErr } = await admin
      .from("market_openai_keys")
      .select("encrypted_key,key_iv,model")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (keyErr) return json({ error: keyErr.message }, 500);
    if (!settings) return json({ error: "Chave OpenAI nao configurada para este tenant" }, 400);

    const openaiApiKey = await decryptSecret(settings.encrypted_key, settings.key_iv);
    const brand = normalizeBrand(body.brand);
    const competitors = normalizeCompetitors(body.competitors);
    if (!brand.name || !brand.url || competitors.length === 0) {
      return json({ error: "Marca e pelo menos um concorrente sao obrigatorios" }, 400);
    }

    const pages = await collectPages(brand, competitors);
    const prompt = buildPrompt(brand, competitors, pages);
    const analysis = await callOpenAi(openaiApiKey, settings.model || DEFAULT_MODEL, prompt);

    return json({
      ...analysis,
      source: "api",
      sourceLabel: "OpenAI API",
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error("[market-analysis]", errorMessage(e));
    return json({ error: errorMessage(e) }, status);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

function getBearer(req: Request) {
  const auth = req.headers.get("authorization") || "";
  return auth.replace(/^Bearer\s+/i, "").trim();
}

async function resolveTenantId(admin: any, userId: string, requested?: string) {
  if (requested) {
    const { data } = await admin
      .from("tenant_members")
      .select("tenant_id")
      .eq("tenant_id", requested)
      .eq("user_id", userId)
      .maybeSingle();
    return data?.tenant_id || null;
  }
  const { data } = await admin
    .from("tenant_members")
    .select("tenant_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  return data?.tenant_id || null;
}

async function getTenantRole(admin: any, tenantId: string, userId: string) {
  const { data } = await admin
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  return data?.role || null;
}

function normalizeBrand(input: any) {
  return {
    name: String(input?.name || "").trim(),
    url: String(input?.url || "").trim(),
  };
}

function normalizeCompetitors(input: any[]) {
  return (Array.isArray(input) ? input : [])
    .map((item, index) => ({
      id: String(item?.id || `comp-${index + 1}`),
      name: String(item?.name || `Concorrente ${index + 1}`).trim(),
      url: String(item?.url || "").trim(),
    }))
    .filter((item) => item.name && item.url)
    .slice(0, 8);
}

async function collectPages(brand: any, competitors: any[]) {
  const targets = [{ id: "target", name: brand.name, url: brand.url, isTarget: true }, ...competitors.map((c) => ({ ...c, isTarget: false }))];
  return Promise.all(targets.map(async (target) => {
    try {
      const res = await fetch(target.url, {
        headers: {
          "user-agent": "Mozilla/5.0 MarketAnalysisBot/1.0",
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      const html = await res.text();
      return {
        ...target,
        status: res.status,
        text: extractReadableText(html).slice(0, 14000),
      };
    } catch (e) {
      return { ...target, status: 0, text: `FETCH_ERROR: ${errorMessage(e)}` };
    }
  }));
}

function extractReadableText(html: string) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPrompt(brand: any, competitors: any[], pages: any[]) {
  return `
Voce e um analista de mercado para restaurantes no iFood.
Compare apenas a marca e os concorrentes enviados pelo usuario.
Use os textos coletados das paginas. Quando algum dado nao estiver visivel, estime de forma conservadora e sinalize nas recomendacoes.

Marca analisada:
${JSON.stringify(brand)}

Concorrentes:
${JSON.stringify(competitors)}

Textos coletados:
${JSON.stringify(pages)}

Retorne somente JSON valido, sem markdown, neste formato:
{
  "entities": [
    {
      "id": "target ou id do concorrente",
      "name": "nome",
      "url": "url",
      "isTarget": true,
      "reviews": 0,
      "rating": 0,
      "marketShare": 0,
      "items": [{"id":"slug","name":"item","category":"categoria","price":0,"tokens":["palavras"]}]
    }
  ],
  "matrix": [
    {
      "id": "item-id",
      "name": "item da marca",
      "category": "categoria",
      "price": 0,
      "matches": {
        "id-concorrente": {"name":"item similar","price":0,"delta":0,"deltaLabel":"+0%","tone":"ok|warn|info"}
      },
      "recommendation": "recomendacao curta"
    }
  ],
  "priceIndex": 100,
  "priceTone": "ok|warn|info|crit",
  "pricePosition": "alinhado a cesta",
  "matchCoverage": 0,
  "insights": [{"label":"curto","tone":"ok|warn|info|crit","title":"titulo","text":"texto"}]
}
`.trim();
}

async function callOpenAi(apiKey: string, model: string, prompt: string) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: "Responda somente com JSON valido. Nao use markdown." },
        { role: "user", content: prompt },
      ],
    }),
  });

  const raw = await res.text();
  if (!res.ok) throw new HttpError(openAiErrorMessage(res.status, raw), mapOpenAiStatus(res.status));
  const data = JSON.parse(raw);
  const text = extractResponseText(data);
  const parsed = parseJsonObject(text);
  return normalizeAnalysis(parsed);
}

function openAiErrorMessage(status: number, raw: string) {
  let detail = raw.slice(0, 420);
  try {
    const parsed = JSON.parse(raw);
    detail = parsed?.error?.message || parsed?.message || detail;
  } catch {}
  if (status === 401) return `Chave OpenAI invalida ou sem permissao. Detalhe: ${detail}`;
  if (status === 429) return `Limite/cota da OpenAI atingido. Detalhe: ${detail}`;
  if (status === 400) return `Requisicao OpenAI invalida. Detalhe: ${detail}`;
  return `OpenAI retornou ${status}. Detalhe: ${detail}`;
}

function mapOpenAiStatus(status: number) {
  if (status === 401 || status === 403) return status;
  if (status === 400 || status === 429) return status;
  return 502;
}

function extractResponseText(data: any) {
  if (typeof data.output_text === "string") return data.output_text;
  const parts: string[] = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n");
}

function parseJsonObject(text: string) {
  const trimmed = String(text || "").trim();
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new HttpError("OpenAI nao retornou JSON valido. Tente novamente.", 502);
}

function normalizeAnalysis(data: any) {
  if (!Array.isArray(data?.entities) || !Array.isArray(data?.matrix)) {
    throw new HttpError("OpenAI retornou JSON de analise incompleto. Tente novamente.", 502);
  }
  return {
    entities: data.entities,
    matrix: data.matrix,
    priceIndex: Number(data.priceIndex || 100),
    priceTone: data.priceTone || "ok",
    pricePosition: data.pricePosition || "alinhado a cesta",
    matchCoverage: Number(data.matchCoverage || 0),
    insights: Array.isArray(data.insights) ? data.insights : [],
  };
}

async function decryptSecret(ciphertextB64: string, ivB64: string) {
  if (!ENCRYPTION_SECRET || ENCRYPTION_SECRET.length < 24) {
    throw new Error("MARKET_KEY_ENCRYPTION_SECRET ausente ou curta");
  }
  const key = await deriveAesKey();
  const cipher = base64ToBytes(ciphertextB64);
  const iv = base64ToBytes(ivB64);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

async function deriveAesKey() {
  const material = new TextEncoder().encode(ENCRYPTION_SECRET);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

class HttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
