// ifood-sales-sync · Integração com o iFood (app DISTRIBUÍDO)
//
// App distribuído usa OAuth authorization_code (via userCode) + refresh_token.
// Tokens por operação ficam em operation_integration_auth (só service_role lê).
//
// Ações (POST body { tenantId, operationId, action, ... }):
//   - "start-auth"    → gera userCode p/ o lojista autorizar no Portal do Parceiro.
//   - "complete-auth" → troca o authorizationCode por access/refresh token; lista merchants.
//   - "list-merchants"→ lista merchants visíveis (usa o token guardado).
//   - (default sync)  → puxa vendas do período e grava em ifood_sales.
//
// Auth do chamador: bearer = service_role (cron/manual) ou JWT de membro manager+.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const IFOOD_CLIENT_ID     = Deno.env.get("IFOOD_CLIENT_ID") || "";
const IFOOD_CLIENT_SECRET = Deno.env.get("IFOOD_CLIENT_SECRET") || "";

const IFOOD_BASE = "https://merchant-api.ifood.com.br";
const AUTH = `${IFOOD_BASE}/authentication/v1.0/oauth`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!IFOOD_CLIENT_ID || !IFOOD_CLIENT_SECRET) {
      return json({ error: "IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET não configurados nas secrets" }, 501);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    const body = await req.json().catch(() => ({}));
    const { tenantId, operationId, beginDate, endDate, action,
            authorizationCode, authorizationCodeVerifier, merchantId } = body as {
      tenantId: string; operationId?: string; beginDate?: string; endDate?: string;
      action?: string; authorizationCode?: string; authorizationCodeVerifier?: string; merchantId?: string;
    };
    if (!tenantId) return json({ error: "tenantId required" }, 400);

    // ---- Auth do chamador ----
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Unauthorized" }, 401);
    if (jwtRole(token) !== "service_role" && token !== SERVICE_KEY) {
      const { data: { user }, error: authErr } = await admin.auth.getUser(token);
      if (authErr || !user) return json({ error: "Unauthorized" }, 401);
      const { data: member } = await admin
        .from("tenant_members").select("role")
        .eq("tenant_id", tenantId).eq("user_id", user.id).maybeSingle();
      if (!member || !["owner", "admin", "manager"].includes(member.role)) {
        return json({ error: "Forbidden" }, 403);
      }
    }

    // =========================================================
    // start-auth: gera userCode p/ o lojista autorizar
    // =========================================================
    if (action === "start-auth") {
      if (!operationId) return json({ error: "operationId required" }, 400);

      // Garante a linha de integração (pending)
      const { data: integ, error: upErr } = await admin
        .from("operation_integrations")
        .upsert({ tenant_id: tenantId, operation_id: operationId, provider: "ifood", status: "pending" },
                { onConflict: "tenant_id,operation_id,provider" })
        .select("id").single();
      if (upErr) return json({ error: `integration: ${upErr.message}` }, 500);

      const uc = await postForm(`${AUTH}/userCode`, { clientId: IFOOD_CLIENT_ID });

      await admin.from("operation_integration_auth").upsert({
        integration_id: integ.id,
        authorization_code_verifier: uc.authorizationCodeVerifier,
        updated_at: new Date().toISOString(),
      });

      return json({
        ok: true,
        instructions: "Abra a verificationUrlComplete no Portal do Parceiro e autorize. Depois chame action='complete-auth' com o authorizationCode exibido.",
        userCode: uc.userCode,
        verificationUrl: uc.verificationUrl,
        verificationUrlComplete: uc.verificationUrlComplete,
        expiresIn: uc.expiresIn,
      });
    }

    // =========================================================
    // complete-auth: troca authorizationCode por tokens
    // =========================================================
    if (action === "complete-auth") {
      if (!operationId)        return json({ error: "operationId required" }, 400);
      if (!authorizationCode)  return json({ error: "authorizationCode required" }, 400);

      const integ = await getIntegration(admin, tenantId, operationId);
      if (!integ) return json({ error: "Integração não encontrada · rode start-auth antes" }, 400);

      const { data: authRow } = await admin
        .from("operation_integration_auth").select("authorization_code_verifier")
        .eq("integration_id", integ.id).maybeSingle();
      if (!authRow?.authorization_code_verifier) {
        return json({ error: "Verifier ausente · rode start-auth novamente" }, 400);
      }

      const tok = await postForm(`${AUTH}/token`, {
        grantType: "authorization_code",
        clientId: IFOOD_CLIENT_ID,
        clientSecret: IFOOD_CLIENT_SECRET,
        authorizationCode: authorizationCode.trim(),
        authorizationCodeVerifier: authRow.authorization_code_verifier,
      });

      await persistTokens(admin, integ.id, tok);

      // Lista merchants visíveis com o token recém-obtido (p/ definir o merchantId).
      const merchants = await ifoodGet(`${IFOOD_BASE}/merchant/v1.0/merchants`, tok.accessToken);
      let external_id: string | null = null;
      if (Array.isArray(merchants) && merchants.length === 1) external_id = merchants[0]?.id ?? null;

      await admin.from("operation_integrations")
        .update({ status: "active", external_id })
        .eq("id", integ.id);

      return json({ ok: true, status: "active", external_id, merchants });
    }

    // =========================================================
    // list-merchants: usa o token guardado
    // =========================================================
    if (action === "list-merchants") {
      if (!operationId) return json({ error: "operationId required" }, 400);
      const integ = await getIntegration(admin, tenantId, operationId);
      if (!integ) return json({ error: "Integração não encontrada" }, 400);
      const accessToken = await getValidAccessToken(admin, integ.id);
      const merchants = await ifoodGet(`${IFOOD_BASE}/merchant/v1.0/merchants`, accessToken);
      return json({ ok: true, merchants });
    }

    // =========================================================
    // default: sincroniza vendas das integrações ativas
    // =========================================================
    const today = new Date();
    const end   = endDate   || today.toISOString().slice(0, 10);
    const begin = beginDate || new Date(today.getTime() - 7 * 864e5).toISOString().slice(0, 10);

    let q = admin
      .from("operation_integrations")
      .select("id, operation_id, external_id")
      .eq("tenant_id", tenantId).eq("provider", "ifood")
      .eq("is_active", true).eq("status", "active");
    if (operationId) q = q.eq("operation_id", operationId);
    const { data: integrations } = await q;

    if (!integrations || integrations.length === 0) {
      return json({ error: "Nenhuma integração iFood ativa · autorize a operação (start-auth → complete-auth)" }, 400);
    }

    let upserted = 0;
    const perMerchant: Record<string, number> = {};

    for (const it of integrations) {
      if (!it.external_id) { perMerchant["(sem merchantId)"] = -1; continue; }
      const accessToken = await getValidAccessToken(admin, it.id);
      const sales = await fetchSales(accessToken, it.external_id, begin, end);
      const rows = sales.map((s: any) => mapSale(tenantId, it.operation_id, it.external_id, s));

      if (rows.length > 0) {
        const { error } = await admin.from("ifood_sales")
          .upsert(rows, { onConflict: "tenant_id,ifood_sale_id" });
        if (error) return json({ error: `upsert: ${error.message}`, merchant: it.external_id }, 500);
      }
      await admin.from("operation_integrations")
        .update({ last_synced_at: new Date().toISOString() }).eq("id", it.id);

      upserted += rows.length;
      perMerchant[it.external_id] = rows.length;
    }

    return json({ ok: true, period: { begin, end }, upserted, perMerchant });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// ---------- helpers ----------

async function getIntegration(admin: any, tenantId: string, operationId: string) {
  const { data } = await admin
    .from("operation_integrations").select("id, external_id")
    .eq("tenant_id", tenantId).eq("operation_id", operationId).eq("provider", "ifood")
    .maybeSingle();
  return data;
}

async function persistTokens(admin: any, integrationId: string, tok: any) {
  const expiresAt = new Date(Date.now() + (Number(tok.expiresIn) || 0) * 1000).toISOString();
  await admin.from("operation_integration_auth").upsert({
    integration_id: integrationId,
    access_token: tok.accessToken,
    refresh_token: tok.refreshToken,
    token_expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  });
}

async function getValidAccessToken(admin: any, integrationId: string): Promise<string> {
  const { data: row } = await admin
    .from("operation_integration_auth")
    .select("access_token, refresh_token, token_expires_at")
    .eq("integration_id", integrationId).maybeSingle();
  if (!row) throw new Error("Sem tokens · operação não autorizada");

  const stillValid = row.access_token && row.token_expires_at &&
    new Date(row.token_expires_at).getTime() - 60_000 > Date.now();
  if (stillValid) return row.access_token;

  if (!row.refresh_token) throw new Error("Sem refresh_token · reautorize a operação");
  const tok = await postForm(`${AUTH}/token`, {
    grantType: "refresh_token",
    clientId: IFOOD_CLIENT_ID,
    clientSecret: IFOOD_CLIENT_SECRET,
    refreshToken: row.refresh_token,
  });
  await persistTokens(admin, integrationId, tok);
  return tok.accessToken;
}

async function postForm(url: string, fields: Record<string, string>) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`iFood ${url.split("/").pop()} ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function ifoodGet(url: string, accessToken: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`iFood GET ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function fetchSales(accessToken: string, merchantId: string, begin: string, end: string): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  while (page <= 100) {
    const url = new URL(`${IFOOD_BASE}/financial/v2.1/merchants/${merchantId}/sales`);
    url.searchParams.set("beginLocalDate", begin);
    url.searchParams.set("endLocalDate", end);
    url.searchParams.set("page", String(page));
    const res = await fetch(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`sales ${res.status} (merchant ${merchantId}): ${await res.text()}`);
    const data = await res.json();
    const items = Array.isArray(data) ? data : (data.sales || data.content || data.data || []);
    all.push(...items);
    const hasNext = !Array.isArray(data) && (data.hasNextPage ?? (page < (data.totalPages ?? 1)));
    if (!hasNext || items.length === 0) break;
    page++;
  }
  return all;
}

function mapSale(tenantId: string, operationId: string, merchantId: string, s: any) {
  return {
    tenant_id:         tenantId,
    operation_id:      operationId,
    ifood_merchant_id: merchantId,
    ifood_sale_id:     String(s.id ?? s.saleId ?? s.orderId ?? crypto.randomUUID()),
    order_id:          s.orderId ?? s.shortId ?? null,
    competence_date:   String(s.competence ?? s.date ?? s.createdAt ?? "").slice(0, 10) || null,
    payment_method:    s.payment?.method ?? s.paymentMethod ?? null,
    status:            s.status ?? null,
    gross_value:       numOrNull(s.amount ?? s.grossValue ?? s.value),
    net_value:         numOrNull(s.netValue ?? s.transferValue),
    raw:               s,
    synced_at:         new Date().toISOString(),
  };
}

function numOrNull(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function jwtRole(t: string): string | null {
  try {
    const payload = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const j = JSON.parse(atob(payload + "=".repeat((4 - payload.length % 4) % 4)));
    return j.role ?? null;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
