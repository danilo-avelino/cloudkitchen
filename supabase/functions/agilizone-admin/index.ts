// agilizone-admin · administração da integração Agilizone (chamado pela UI)
//
// Ações (POST body { tenantId, action, ... }) — auth: JWT de membro owner/admin:
//   - "list-accounts"   → contas do tenant (sem secret).
//   - "save-account"    → cria/atualiza conta + grava client_secret no Vault.
//   - "toggle-account"  → ativa/desativa a integração da conta.
//   - "discover-brands" → autentica na Agilizone, pagina /orders e devolve as
//                         marcas (merchant.name) distintas + o mapeamento atual.
//   - "save-brand-map"  → grava o vínculo marca→operação (apaga linha se sem operação).
//
// O client_secret vai pro Vault (agilizone_client_secrets) via RPC service-role-only;
// nunca volta pro cliente. A função roda com SERVICE_ROLE_KEY.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BASE: Record<string, string> = {
  production: "https://api.agilizone.com/agilizone/v2",
  sandbox:   "https://api.test.agilizone.com/agilizone/v2",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));
    const { tenantId, action } = body as { tenantId?: string; action?: string };
    if (!tenantId) return json({ error: "tenantId required" }, 400);
    if (!action)   return json({ error: "action required" }, 400);

    // ---- Auth: membro owner/admin ----
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Unauthorized" }, 401);
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);
    const { data: member } = await admin
      .from("tenant_members").select("role")
      .eq("tenant_id", tenantId).eq("user_id", user.id).maybeSingle();
    if (!member || !["owner", "admin"].includes(member.role)) {
      return json({ error: "Forbidden · requer owner/admin" }, 403);
    }

    // ===================== list-accounts =====================
    if (action === "list-accounts") {
      const { data, error } = await admin.from("agilizone_accounts")
        .select("id, label, environment, client_id, store_id, is_active, last_synced_at")
        .eq("tenant_id", tenantId).order("created_at");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, accounts: data || [] });
    }

    // ===================== save-account =====================
    if (action === "save-account") {
      const { id, label, environment, clientId, clientSecret } = body as {
        id?: string; label?: string; environment?: string; clientId?: string; clientSecret?: string;
      };
      if (!label?.trim()) return json({ error: "label obrigatório" }, 400);
      const env = environment === "sandbox" ? "sandbox" : "production";

      let accountId = id;
      if (id) {
        const patch: Record<string, unknown> = { label: label.trim(), environment: env };
        if (clientId?.trim()) patch.client_id = clientId.trim();
        const { error } = await admin.from("agilizone_accounts")
          .update(patch).eq("id", id).eq("tenant_id", tenantId);
        if (error) return json({ error: error.message }, 500);
      } else {
        if (!clientId?.trim()) return json({ error: "clientId obrigatório" }, 400);
        const { data, error } = await admin.from("agilizone_accounts")
          .insert({ tenant_id: tenantId, label: label.trim(), environment: env, client_id: clientId.trim(), is_active: true })
          .select("id").single();
        if (error) return json({ error: error.message }, 500);
        accountId = data.id;
      }

      // secret → Vault (só se enviado)
      if (clientSecret?.trim() && clientId?.trim()) {
        const { error: secErr } = await admin.rpc("agilizone_set_client_secret",
          { p_client_id: clientId.trim(), p_secret: clientSecret.trim() });
        if (secErr) return json({ error: `secret: ${secErr.message}` }, 500);
      }
      return json({ ok: true, id: accountId });
    }

    // ===================== toggle-account =====================
    if (action === "toggle-account") {
      const { id, isActive } = body as { id?: string; isActive?: boolean };
      if (!id) return json({ error: "id required" }, 400);
      const { error } = await admin.from("agilizone_accounts")
        .update({ is_active: !!isActive }).eq("id", id).eq("tenant_id", tenantId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ===================== list-brand-map (salvos, sem API) =====================
    if (action === "list-brand-map") {
      const { accountId } = body as { accountId?: string };
      if (!accountId) return json({ error: "accountId required" }, 400);
      const { data, error } = await admin.from("agilizone_brand_map")
        .select("merchant_name, operation_id").eq("account_id", accountId).eq("tenant_id", tenantId);
      if (error) return json({ error: error.message }, 500);
      const brands = (data || []).map((r: any) => ({ merchant: r.merchant_name, operationId: r.operation_id, count: null }));
      return json({ ok: true, brands });
    }

    // ===================== sync (dispara ingest em background) =====================
    if (action === "sync") {
      const { accountId, lookbackDays } = body as { accountId?: string; lookbackDays?: number };
      if (!accountId) return json({ error: "accountId required" }, 400);
      const { data: rq, error } = await admin.rpc("agilizone_trigger_ingest",
        { p_account: accountId, p_lookback: lookbackDays || 7 });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, ingestQueued: rq != null });
    }

    // ===================== discover-brands =====================
    if (action === "discover-brands") {
      const { accountId } = body as { accountId?: string };
      if (!accountId) return json({ error: "accountId required" }, 400);

      const { data: acc, error: accErr } = await admin.from("agilizone_accounts")
        .select("id, environment, client_id").eq("id", accountId).eq("tenant_id", tenantId).maybeSingle();
      if (accErr || !acc) return json({ error: "Conta não encontrada" }, 404);

      const secret = await getClientSecret(admin, acc.client_id);
      if (!secret) return json({ error: "Secret não cadastrado para esta conta" }, 400);

      const env = acc.environment === "sandbox" ? "sandbox" : "production";
      const accessToken = await getToken(acc.client_id, secret, env);

      // pagina algumas páginas p/ descobrir marcas + os 3 itens mais vendidos
      // de cada uma (ajuda o usuário a classificar marca/id → operação).
      const agg = new Map<string, { count: number; items: Map<string, number> }>();
      for (let page = 1; page <= 8; page++) {
        const batch = await listOrders(accessToken, env, page, 100);
        if (!batch.length) break;
        for (const o of batch) {
          const m = resolveMerchant(o);
          if (!m) continue;
          let e = agg.get(m);
          if (!e) { e = { count: 0, items: new Map() }; agg.set(m, e); }
          e.count++;
          for (const it of orderItemsOf(o)) {
            const nm = it?.name;
            if (!nm) continue;
            e.items.set(nm, (e.items.get(nm) || 0) + (Number(it?.quantity) || 1));
          }
        }
        if (batch.length < 100) break;
      }

      // mapeamento atual + marcas já mapeadas (mesmo que não tenham aparecido agora)
      const { data: maps } = await admin.from("agilizone_brand_map")
        .select("merchant_name, operation_id").eq("account_id", accountId);
      const mapByName = new Map((maps || []).map((r: any) => [r.merchant_name, r.operation_id]));
      for (const r of (maps || [])) if (!agg.has(r.merchant_name)) agg.set(r.merchant_name, { count: 0, items: new Map() });

      const brands = [...agg.entries()]
        .map(([merchant, e]) => ({
          merchant,
          count: e.count,
          operationId: mapByName.get(merchant) || null,
          topItems: [...e.items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
            .map(([name, qty]) => ({ name, qty })),
        }))
        .sort((a, b) => b.count - a.count);
      return json({ ok: true, brands });
    }

    // ===================== save-brand-map =====================
    if (action === "save-brand-map") {
      const { accountId, mappings } = body as {
        accountId?: string; mappings?: { merchant: string; operationId: string | null }[];
      };
      if (!accountId || !Array.isArray(mappings)) return json({ error: "accountId e mappings[] obrigatórios" }, 400);

      let saved = 0, removed = 0;
      for (const m of mappings) {
        if (!m.merchant) continue;
        if (m.operationId) {
          const { error } = await admin.from("agilizone_brand_map").upsert({
            tenant_id: tenantId, account_id: accountId,
            merchant_name: m.merchant, operation_id: m.operationId,
          }, { onConflict: "account_id,merchant_name" });
          if (error) return json({ error: error.message }, 500);
          saved++;
        } else {
          await admin.from("agilizone_brand_map").delete()
            .eq("account_id", accountId).eq("merchant_name", m.merchant);
          removed++;
        }
      }

      // efeito imediato: re-aplica operation_id nos pedidos já ingeridos
      for (const m of mappings) {
        if (!m.merchant) continue;
        await admin.from("agilizone_orders")
          .update({ operation_id: m.operationId || null })
          .eq("account_id", accountId).eq("merchant_name", m.merchant);
      }

      // refresca faturamento + pedidos em background (pg_net) p/ popular Cardápio/Faturamento
      let ingestQueued = false;
      try {
        const { data: rq } = await admin.rpc("agilizone_trigger_ingest", { p_account: accountId, p_lookback: 31 });
        ingestQueued = rq != null;
      } catch (_) { /* best effort */ }

      return json({ ok: true, saved, removed, ingestQueued });
    }

    return json({ error: `ação desconhecida: ${action}` }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// ---------- secret + Agilizone API ----------
async function getClientSecret(admin: any, clientId: string): Promise<string | null> {
  const { data } = await admin.rpc("agilizone_get_secret", { p_name: "agilizone_client_secrets" });
  if (!data) return null;
  try { return (JSON.parse(data as string) as Record<string, string>)[clientId] || null; } catch { return null; }
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
async function getToken(clientId: string, clientSecret: string, env: string): Promise<string> {
  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
  const res = await fetch(`${BASE[env]}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`agilizone auth ${res.status}: ${text}`);
  const j = JSON.parse(text) as { access_token: string; expires_in: number };
  tokenCache.set(clientId, { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 0) * 1000 });
  return j.access_token;
}

async function listOrders(token: string, env: string, page: number, pageSize: number): Promise<any[]> {
  const res = await fetch(`${BASE[env]}/orders?page=${page}&pageSize=${pageSize}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`agilizone orders ${res.status}: ${text}`);
  return JSON.parse(text);
}

// Nome da marca, robusto às origens da Agilizone. DEVE ser idêntico ao do
// agilizone-ingest p/ o merchant_name salvo casar na hora de atribuir pedidos.
//   iFood → ifoodOrder.merchant.name · SAIPOS/PDVs → originOrder.merchant.name
//   AnotaAI/Mogo/Neemo → *.merchant.name · sem nome (ex.: CARDAPIO_WEB que só
//   traz merchant_id numérico) → "<Origem> #<id>" (rótulo mapeável manualmente).
const ORIGIN_LABEL: Record<string, string> = { CARDAPIO_WEB: "Cardápio Web", SAIPOS: "SAIPOS" };
function resolveMerchant(o: any): string | null {
  const byName = o?.ifoodOrder?.merchant?.name
              ?? o?.originOrder?.merchant?.name
              ?? o?.anotaAIOrder?.merchant?.name
              ?? o?.mogoOrder?.merchant?.name
              ?? o?.neemoOrder?.merchant?.name;
  if (byName) return String(byName);
  const mid = o?.originOrder?.merchant_id ?? o?.originOrder?.merchant?.id;
  if (mid != null) {
    const label = ORIGIN_LABEL[o?.originPlatform] ?? o?.originPlatform ?? "Origem";
    return `${label} #${mid}`;
  }
  return null;
}

// Itens do pedido em qualquer origem: iFood usa ifoodOrder.items; SAIPOS e
// CARDAPIO_WEB usam originOrder.items. Todos têm ao menos { name, quantity }.
function orderItemsOf(o: any): any[] {
  const arr = o?.ifoodOrder?.items ?? o?.originOrder?.items ?? [];
  return Array.isArray(arr) ? arr : [];
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
