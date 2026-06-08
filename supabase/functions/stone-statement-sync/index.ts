// stone-statement-sync · Sincronização de extrato bancário (open banking)
//
// STUB (v1) — ponto de plugue para o agregador open banking (prioridade Stone).
// Ainda NÃO há credenciais/consentimento configurados, então a função valida o
// chamador e retorna 501 com `reason: 'stone_open_banking_pending'`. A UI usa isso
// para mostrar o botão "Sincronizar Stone" com badge "em breve".
//
// A ingestão FUNCIONAL do v1 é o import OFX/CSV client-side — não depende desta
// função. Quando a Stone for plugada, o corpo abaixo passa a:
//   1. Trocar consentimento → access token (STONE_CLIENT_ID/SECRET nas SECRETS).
//   2. Buscar o extrato da conta (account.external_id) no período.
//   3. Upsert idempotente em public.bank_transactions por `idempotency_hash`
//      (conta + external_id + amount + date), tratando estorno (bank_status).
//
// Auth do chamador: bearer = service_role (cron/manual) ou JWT de membro com
// acesso ao módulo financeiro (owner/admin/manager).

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STONE_CLIENT_ID     = Deno.env.get("STONE_CLIENT_ID") || "";
const STONE_CLIENT_SECRET = Deno.env.get("STONE_CLIENT_SECRET") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    const body = await req.json().catch(() => ({}));
    const { tenantId, accountId } = body as { tenantId?: string; accountId?: string };
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

    // ---- STUB: agregador open banking ainda não configurado ----
    if (!STONE_CLIENT_ID || !STONE_CLIENT_SECRET) {
      return json({
        ok: false,
        reason: "stone_open_banking_pending",
        message: "Integração Stone (open banking) ainda não configurada. " +
                 "Use o import de extrato OFX/CSV enquanto isso.",
        accountId: accountId ?? null,
      }, 501);
    }

    // ---- Quando a Stone for plugada: consentimento → extrato → upsert ----
    // 1. token = await stoneToken(STONE_CLIENT_ID, STONE_CLIENT_SECRET, consent)
    // 2. const account = await admin.from("bank_accounts").select("external_id").eq("id", accountId).single()
    // 3. const stmt = await fetchStatement(token, account.external_id, beginDate, endDate)
    // 4. const rows = stmt.map(toBankTransactionRow)  // calcula idempotency_hash
    // 5. await admin.from("bank_transactions").upsert(rows, { onConflict: "tenant_id,idempotency_hash" })
    return json({ ok: false, reason: "not_implemented" }, 501);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

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
