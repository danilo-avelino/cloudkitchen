// foody-admin · administração da integração Foody Delivery (chamado pela UI)
//
// Ações (POST body { tenantId, action, ... }) — auth: JWT de membro owner/admin:
//   - "list-accounts"    → contas do tenant (sem token).
//   - "save-account"     → cria/atualiza conta + grava o api token no Vault.
//                          Conta nova nasce PAUSADA se a Agilizone estiver ativa
//                          (trava de exclusividade) — resposta traz lockedPaused.
//   - "toggle-account"   → ativa/desativa. Ativação com Agilizone ativa → 409
//                          com mensagem amigável (o trigger no banco é o backstop).
//   - "discover-points"  → busca pedidos recentes na Foody e devolve os pontos
//                          de coleta (collectionPoint.name) distintos + mapa atual.
//   - "list-point-map"   → mapeamentos salvos (sem chamar a Foody).
//   - "save-point-map"   → grava vínculo ponto→operação (apaga linha se sem operação).
//   - "sync"             → dispara o ingest em background (pg_net).
//
// O token vai pro Vault ('foody_api_tokens') via RPC service-role-only;
// nunca volta pro cliente. A função roda com SERVICE_ROLE_KEY.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BASE = "https://app.foodydelivery.com/rest/1.2";
const LOCK_MSG = "Desative a integração Agilizone antes de ativar a Foody Delivery.";

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

    // trava: tenant tem alguma conta Agilizone ativa?
    const agilizoneActive = async () => {
      const { count } = await admin.from("agilizone_accounts")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId).eq("is_active", true);
      return (count || 0) > 0;
    };

    // ===================== list-accounts =====================
    if (action === "list-accounts") {
      const { data, error } = await admin.from("foody_accounts")
        .select("id, label, token_hint, is_active, last_synced_at")
        .eq("tenant_id", tenantId).order("created_at");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, accounts: data || [], otherActive: await agilizoneActive() });
    }

    // ===================== save-account =====================
    if (action === "save-account") {
      const { id, label, apiToken } = body as { id?: string; label?: string; apiToken?: string };
      if (!label?.trim()) return json({ error: "label obrigatório" }, 400);

      let accountId = id;
      let lockedPaused = false;
      if (id) {
        const patch: Record<string, unknown> = { label: label.trim() };
        if (apiToken?.trim()) patch.token_hint = apiToken.trim().slice(-4);
        const { error } = await admin.from("foody_accounts")
          .update(patch).eq("id", id).eq("tenant_id", tenantId);
        if (error) return json({ error: error.message }, 500);
      } else {
        if (!apiToken?.trim()) return json({ error: "apiToken obrigatório" }, 400);
        // conta nova nasce pausada se a Agilizone estiver ativa (trava)
        lockedPaused = await agilizoneActive();
        const { data, error } = await admin.from("foody_accounts")
          .insert({
            tenant_id: tenantId, label: label.trim(),
            token_hint: apiToken.trim().slice(-4), is_active: !lockedPaused,
          })
          .select("id").single();
        if (error) return json({ error: error.message }, 500);
        accountId = data.id;
      }

      // token → Vault (só se enviado)
      if (apiToken?.trim() && accountId) {
        const { error: secErr } = await admin.rpc("foody_set_api_token",
          { p_account_id: accountId, p_token: apiToken.trim() });
        if (secErr) return json({ error: `token: ${secErr.message}` }, 500);
      }
      return json({ ok: true, id: accountId, lockedPaused });
    }

    // ===================== toggle-account =====================
    if (action === "toggle-account") {
      const { id, isActive } = body as { id?: string; isActive?: boolean };
      if (!id) return json({ error: "id required" }, 400);
      if (isActive && await agilizoneActive()) return json({ error: LOCK_MSG }, 409);
      const { error } = await admin.from("foody_accounts")
        .update({ is_active: !!isActive }).eq("id", id).eq("tenant_id", tenantId);
      if (error) return json({ error: error.message }, 500);   // trigger backstop cai aqui
      return json({ ok: true });
    }

    // ===================== list-point-map (salvos, sem API) =====================
    if (action === "list-point-map") {
      const { accountId } = body as { accountId?: string };
      if (!accountId) return json({ error: "accountId required" }, 400);
      const { data, error } = await admin.from("foody_point_map")
        .select("point_name, operation_id").eq("account_id", accountId).eq("tenant_id", tenantId);
      if (error) return json({ error: error.message }, 500);
      const points = (data || []).map((r: any) => ({ point: r.point_name, operationId: r.operation_id, count: null }));
      return json({ ok: true, points });
    }

    // ===================== sync (dispara ingest em background) =====================
    if (action === "sync") {
      const { accountId, lookbackDays } = body as { accountId?: string; lookbackDays?: number };
      if (!accountId) return json({ error: "accountId required" }, 400);
      const { data: rq, error } = await admin.rpc("foody_trigger_ingest",
        { p_account: accountId, p_lookback: lookbackDays || 7 });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, ingestQueued: rq != null });
    }

    // ===================== discover-points =====================
    if (action === "discover-points") {
      const { accountId } = body as { accountId?: string };
      if (!accountId) return json({ error: "accountId required" }, 400);

      const { data: acc, error: accErr } = await admin.from("foody_accounts")
        .select("id").eq("id", accountId).eq("tenant_id", tenantId).maybeSingle();
      if (accErr || !acc) return json({ error: "Conta não encontrada" }, 404);

      const apiToken = await getApiToken(admin, accountId);
      if (!apiToken) return json({ error: "Token não cadastrado para esta conta" }, 400);

      // varre os últimos 14 dias p/ descobrir pontos de coleta + contagem
      const end = new Date(Date.now() + 3600 * 1000);
      const start = new Date(Date.now() - 14 * 864e5);
      const orders = await listOrdersWindow(apiToken, start, end);

      const agg = new Map<string, number>();
      for (const o of orders) {
        const p = resolvePoint(o);
        if (!p) continue;
        agg.set(p, (agg.get(p) || 0) + 1);
      }

      // mapeamento atual + pontos já mapeados (mesmo sem pedidos recentes)
      const { data: maps } = await admin.from("foody_point_map")
        .select("point_name, operation_id").eq("account_id", accountId);
      const mapByName = new Map((maps || []).map((r: any) => [r.point_name, r.operation_id]));
      for (const r of (maps || [])) if (!agg.has(r.point_name)) agg.set(r.point_name, 0);

      const points = [...agg.entries()]
        .map(([point, count]) => ({ point, count, operationId: mapByName.get(point) || null }))
        .sort((a, b) => b.count - a.count);
      return json({ ok: true, points });
    }

    // ===================== save-point-map =====================
    if (action === "save-point-map") {
      const { accountId, mappings } = body as {
        accountId?: string; mappings?: { point: string; operationId: string | null }[];
      };
      if (!accountId || !Array.isArray(mappings)) return json({ error: "accountId e mappings[] obrigatórios" }, 400);

      let saved = 0, removed = 0;
      for (const m of mappings) {
        if (!m.point) continue;
        if (m.operationId) {
          const { error } = await admin.from("foody_point_map").upsert({
            tenant_id: tenantId, account_id: accountId,
            point_name: m.point, operation_id: m.operationId,
          }, { onConflict: "account_id,point_name" });
          if (error) return json({ error: error.message }, 500);
          saved++;
        } else {
          await admin.from("foody_point_map").delete()
            .eq("account_id", accountId).eq("point_name", m.point);
          removed++;
        }
      }

      // efeito imediato: re-aplica operation_id nos pedidos já ingeridos
      for (const m of mappings) {
        if (!m.point) continue;
        await admin.from("foody_orders")
          .update({ operation_id: m.operationId || null })
          .eq("account_id", accountId).eq("point_name", m.point);
      }

      // refresca faturamento + pedidos em background (pg_net)
      let ingestQueued = false;
      try {
        const { data: rq } = await admin.rpc("foody_trigger_ingest", { p_account: accountId, p_lookback: 31 });
        ingestQueued = rq != null;
      } catch (_) { /* best effort */ }

      return json({ ok: true, saved, removed, ingestQueued });
    }

    return json({ error: `ação desconhecida: ${action}` }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// ---------- token + Foody API ----------
async function getApiToken(admin: any, accountId: string): Promise<string | null> {
  const { data } = await admin.rpc("foody_get_secret", { p_name: "foody_api_tokens" });
  if (!data) return null;
  try { return (JSON.parse(data as string) as Record<string, string>)[accountId] || null; } catch { return null; }
}

// GET /orders?startDate=&endDate= — máx. 500/req; se vierem 500, avança o
// startDate acima do último e repete. Mesma lógica do foody-ingest.
async function listOrdersWindow(token: string, start: Date, end: Date): Promise<any[]> {
  const out: any[] = [];
  const seen = new Set<string>();
  let cursor = start;
  for (let page = 0; page < 20; page++) {
    const url = `${BASE}/orders?startDate=${encodeURIComponent(isoNoMs(cursor))}&endDate=${encodeURIComponent(isoNoMs(end))}`;
    const res = await fetch(url, {
      headers: { authorization: token, "content-type": "application/json;charset=UTF-8" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`foody orders ${res.status}: ${text}`);
    const batch = JSON.parse(text);
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const o of batch) {
      if (o?.uid && !seen.has(o.uid)) { seen.add(o.uid); out.push(o); }
    }
    if (batch.length < 500) break;
    const last = batch[batch.length - 1]?.date ?? batch[batch.length - 1]?.creationDate;
    if (!last) break;
    const next = new Date(Date.parse(last) + 1000);
    if (next <= cursor) break;
    cursor = next;
  }
  return out;
}

// offset -03:00 explícito — mesma razão do foody-ingest
function isoNoMs(d: Date): string {
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "-03:00");
}

// Ponto de coleta do pedido. DEVE ser idêntico ao do foody-ingest
// p/ o point_name salvo casar na hora de atribuir pedidos.
function resolvePoint(o: any): string | null {
  const name = o?.collectionPoint?.name ?? o?.collectionPoint?.pointName;
  return name != null ? String(name) : null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
