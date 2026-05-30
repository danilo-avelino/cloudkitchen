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
    if (!ENCRYPTION_SECRET || ENCRYPTION_SECRET.length < 24) {
      return json({ error: "MARKET_KEY_ENCRYPTION_SECRET ausente ou curta" }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const token = getBearer(req);
    if (!token) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const tenantId = await resolveTenantId(admin, user.id, body.tenantId);
    if (!tenantId) return json({ error: "Tenant nao encontrado para o usuario" }, 400);

    const role = await getTenantRole(admin, tenantId, user.id);
    if (!["owner", "admin"].includes(role || "")) {
      return json({ error: "Apenas owner/admin pode salvar a chave OpenAI" }, 403);
    }

    const openaiApiKey = String(body.openaiApiKey || "").trim();
    if (!openaiApiKey.startsWith("sk-")) {
      return json({ error: "Chave OpenAI invalida" }, 400);
    }

    const encrypted = await encryptSecret(openaiApiKey);
    const keyHint = openaiApiKey.slice(-6);
    const row = {
      tenant_id: tenantId,
      encrypted_key: encrypted.ciphertext,
      key_iv: encrypted.iv,
      key_hint: keyHint,
      model: String(body.model || DEFAULT_MODEL),
      updated_by: user.id,
      created_by: user.id,
      updated_at: new Date().toISOString(),
    };

    const { error } = await admin
      .from("market_openai_keys")
      .upsert(row, { onConflict: "tenant_id" });
    if (error) return json({ error: error.message }, 500);

    return json({ ok: true, tenantId, keyHint, model: row.model });
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
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

async function encryptSecret(secret: string) {
  const key = await deriveAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(secret);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    ciphertext: bytesToBase64(new Uint8Array(cipher)),
    iv: bytesToBase64(iv),
  };
}

async function deriveAesKey() {
  const material = new TextEncoder().encode(ENCRYPTION_SECRET);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function bytesToBase64(bytes: Uint8Array) {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return btoa(out);
}

function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
