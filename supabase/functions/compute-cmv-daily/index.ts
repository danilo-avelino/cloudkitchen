// compute-cmv-daily · roda a SQL function app.compute_cmv_daily pra cada tenant ativo.
//
// Modo cron (diário):
//   curl -X POST <url>/functions/v1/compute-cmv-daily \
//        -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
//        -H "Content-Type: application/json" \
//        -d '{"days": 7}'
//
// Modo manual (um tenant só):
//   POST { tenantId, days?: 30 }
//
// AUTH: aceita JWT de service_role (cron interno do Supabase) OU JWT de superadmin.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Auth: aceita service_role (cron) OU JWT de superadmin
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    let isAuthorized = false;
    if (token === SERVICE_KEY) {
      isAuthorized = true; // cron interno
    } else {
      const { data: { user } } = await admin.auth.getUser(token);
      if (user) {
        const { data: profile } = await admin
          .from("profiles")
          .select("is_superadmin")
          .eq("id", user.id)
          .maybeSingle();
        if (profile?.is_superadmin) isAuthorized = true;
      }
    }

    if (!isAuthorized) return json({ error: "Forbidden" }, 403);

    const body = await req.json().catch(() => ({}));
    const { tenantId, days = 7 } = body as { tenantId?: string; days?: number };

    const to = new Date();
    const from = new Date(); from.setDate(from.getDate() - Math.max(1, Number(days)));
    const fromYMD = from.toISOString().slice(0, 10);
    const toYMD   = to.toISOString().slice(0, 10);

    // Lista tenants alvo
    let tenants: { id: string }[];
    if (tenantId) {
      tenants = [{ id: tenantId }];
    } else {
      const { data, error } = await admin.from("tenants").select("id");
      if (error) return json({ error: error.message }, 500);
      tenants = data || [];
    }

    const results: Array<{ tenantId: string; rows: number; error?: string }> = [];
    for (const t of tenants) {
      const { data, error } = await admin.rpc("compute_cmv_daily", {
        p_tenant_id: t.id,
        p_from: fromYMD,
        p_to: toYMD,
      });
      if (error) {
        results.push({ tenantId: t.id, rows: 0, error: error.message });
      } else {
        results.push({ tenantId: t.id, rows: Number(data) || 0 });
      }
    }

    return json({ from: fromYMD, to: toYMD, tenants: results.length, results }, 200);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
