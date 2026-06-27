// platform-diagnostics · alimenta o painel Superadmin > Sistema.
//
// Auth: JWT de um usuário com profiles.is_superadmin = true.
// Ações (POST body { action }):
//   - "set-token"  { token }  → grava o Personal Access Token da Management API
//                               no Vault (via RPC service_role). Nunca volta pro cliente.
//   - "status" (default)      → devolve um diagnóstico consolidado:
//       * dbOverview  → sempre (tabelas, tamanhos, extensões, cron, lints SQL)
//       * configured  → se o token da Management API está gravado
//       * advisors    → advisors oficiais (security+performance) — só com token
//       * logs        → erros das últimas 24h (postgres + edge functions) — só com token
//       * edgeFns     → lista de edge functions e versões — só com token
//
// Roda com SERVICE_ROLE_KEY. O token da Management API fica só no Vault e só
// esta função o lê — o navegador nunca o vê.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PROJECT_REF  = SUPABASE_URL.replace(/^https?:\/\//, "").split(".")[0];
const MGMT         = "https://api.supabase.com/v1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // ---- Auth: superadmin global ----
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Unauthorized" }, 401);
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);
    const { data: prof } = await admin
      .from("profiles").select("is_superadmin").eq("id", user.id).maybeSingle();
    if (!prof?.is_superadmin) return json({ error: "Forbidden · requer superadmin" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = (body as { action?: string }).action || "status";

    // ===================== set-token =====================
    if (action === "set-token") {
      const t = String((body as { token?: string }).token || "").trim();
      if (!t) return json({ error: "Token vazio" }, 400);
      const { error } = await admin.rpc("platform_set_mgmt_token", { p_token: t });
      if (error) return json({ error: error.message }, 500);
      // valida na hora: tenta um GET barato na Management API
      const probe = await mgmt(`/projects/${PROJECT_REF}`, t);
      return json({ ok: true, valid: !probe.error, probeError: probe.error || null });
    }

    // ===================== status (default) =====================
    const { data: overview, error: ovErr } = await admin.rpc("platform_diag_overview");
    const { data: pat } = await admin.rpc("platform_get_mgmt_token");

    const result: Record<string, unknown> = {
      ok: true,
      projectRef: PROJECT_REF,
      configured: !!pat,
      dbOverview: overview ?? null,
      dbError: ovErr?.message ?? null,
    };

    if (pat) {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const until = new Date().toISOString();

      const [sec, perf, fns, pgLogs, fnLogs] = await Promise.all([
        mgmt(`/projects/${PROJECT_REF}/advisors/security`, pat),
        mgmt(`/projects/${PROJECT_REF}/advisors/performance`, pat),
        mgmt(`/projects/${PROJECT_REF}/functions`, pat),
        mgmtLogs(pat, since, until, PG_ERRORS_SQL),
        mgmtLogs(pat, since, until, FN_ERRORS_SQL),
      ]);

      result.advisors = {
        security:    sec.error    ? { error: sec.error }    : (sec.data as { lints?: unknown })?.lints ?? [],
        performance: perf.error   ? { error: perf.error }   : (perf.data as { lints?: unknown })?.lints ?? [],
      };
      result.edgeFns = fns.error ? { error: fns.error } : (fns.data ?? []);
      result.logs = {
        postgres: pgLogs.error ? { error: pgLogs.error } : pgLogs.rows,
        edge:     fnLogs.error ? { error: fnLogs.error } : fnLogs.rows,
      };
    }

    return json(result);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// ---------- Management API helpers ----------
async function mgmt(path: string, pat: string): Promise<{ data?: unknown; error?: string }> {
  try {
    const res = await fetch(MGMT + path, { headers: { Authorization: `Bearer ${pat}` } });
    const text = await res.text();
    if (!res.ok) return { error: `[${res.status}] ${text.slice(0, 300)}` };
    return { data: text ? JSON.parse(text) : null };
  } catch (e) {
    return { error: String(e) };
  }
}

// Logs via endpoint analítico (Logflare). Devolve { rows } ou { error }.
async function mgmtLogs(
  pat: string, isoStart: string, isoEnd: string, sql: string,
): Promise<{ rows?: unknown[]; error?: string }> {
  try {
    const qs = new URLSearchParams({
      sql,
      iso_timestamp_start: isoStart,
      iso_timestamp_end: isoEnd,
    });
    const res = await fetch(
      `${MGMT}/projects/${PROJECT_REF}/analytics/endpoints/logs.all?${qs.toString()}`,
      { headers: { Authorization: `Bearer ${pat}` } },
    );
    const text = await res.text();
    if (!res.ok) return { error: `[${res.status}] ${text.slice(0, 300)}` };
    const j = JSON.parse(text) as { result?: unknown[] };
    return { rows: Array.isArray(j.result) ? j.result : [] };
  } catch (e) {
    return { error: String(e) };
  }
}

// Erros do Postgres (ERROR/FATAL/PANIC) nas últimas 24h.
const PG_ERRORS_SQL = `
select t.timestamp, t.event_message, m.error_severity as severity
from postgres_logs t
cross join unnest(t.metadata) as m
where m.error_severity in ('ERROR','FATAL','PANIC')
order by t.timestamp desc
limit 100`;

// Erros das edge functions (status >= 400) nas últimas 24h.
const FN_ERRORS_SQL = `
select t.timestamp, t.event_message, response.status_code as severity, request.method as method
from function_edge_logs t
cross join unnest(t.metadata) as m
cross join unnest(m.request) as request
cross join unnest(m.response) as response
where response.status_code >= 400
order by t.timestamp desc
limit 100`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
