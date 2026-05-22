// ingest-revenue · ponto único de entrada para faturamento externo (iFood, Rappi)
//
// Suporta 3 modos:
//   1. POST body com array de entries — chamada manual ou de scripts
//   2. POST com { provider: "ifood", since: ISO } — pull autenticado (TODO)
//   3. Webhook (rota futura) — POST de evento individual
//
// Cada entry vira uma linha em revenue_entries + revenue_payment_breakdown.
// Idempotente por (tenant_id, provider, external_id) — re-importar não duplica.
//
// AUTH:
//   - Modo manual / pull: JWT do usuário com role >= manager no tenant
//   - Webhook iFood: header X-Webhook-Secret (env IFOOD_WEBHOOK_SECRET)
//
// Pré-requisitos no DB:
//   - Coluna revenue_entries.external_id (text) + unique (tenant_id, source, external_id)
//     → criar via migration separada quando integrar de fato.
//
// Por enquanto isto é um STUB: aceita entries explícitos e insere, sem
// chamar a API do iFood (precisa do client_id/client_secret do merchant).

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const IFOOD_TOKEN  = Deno.env.get("IFOOD_TOKEN") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
};

type IncomingEntry = {
  business_date: string;        // YYYY-MM-DD
  operation_slug: string;       // resolve pra operation_id
  external_id?: string;         // ID no provedor (pra idempotência)
  source: "ifood" | "rappi" | "pdv" | "balcao" | "manual";
  orders_count: number;
  cogs?: number;
  breakdown: Array<{ method_slug: string; amount: number }>;
  notes?: string;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Auth: JWT
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const { tenantId, entries, provider, since } = body as {
      tenantId: string;
      entries?: IncomingEntry[];
      provider?: "ifood" | "rappi";
      since?: string;
    };

    if (!tenantId) return json({ error: "tenantId required" }, 400);

    // Checa membership com role suficiente
    const { data: member } = await admin
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!member || !["owner", "admin", "manager"].includes(member.role)) {
      return json({ error: "Forbidden" }, 403);
    }

    // Modo 1: entries explícitos
    if (entries && Array.isArray(entries) && entries.length > 0) {
      const result = await ingestEntries(admin, tenantId, entries);
      return json(result, 200);
    }

    // Modo 2: pull do provedor (stub — exige credenciais do merchant)
    if (provider === "ifood") {
      if (!IFOOD_TOKEN) {
        return json({ error: "IFOOD_TOKEN não configurada nas env vars do projeto" }, 501);
      }
      // TODO: chamar https://merchant-api.ifood.com.br/order/v1.0/orders?since=...
      // Aguarda credenciais reais.
      return json({ error: "iFood pull ainda não implementado · use modo entries[]", provider, since }, 501);
    }

    return json({ error: "Forneça entries[] ou provider" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

async function ingestEntries(admin: any, tenantId: string, entries: IncomingEntry[]) {
  // Resolve operation_slug → operation_id em lote
  const slugs = [...new Set(entries.map((e) => e.operation_slug).filter(Boolean))];
  const { data: ops } = await admin
    .from("operations")
    .select("id, slug")
    .eq("tenant_id", tenantId)
    .in("slug", slugs);
  const opBySlug = new Map((ops || []).map((o: any) => [o.slug, o.id]));

  // Resolve method_slug → payment_method_id em lote
  const methodSlugs = [...new Set(entries.flatMap((e) => e.breakdown.map((b) => b.method_slug)))];
  const { data: methods } = await admin
    .from("payment_methods")
    .select("id, slug")
    .eq("tenant_id", tenantId)
    .in("slug", methodSlugs);
  const methodBySlug = new Map((methods || []).map((m: any) => [m.slug, m.id]));

  let inserted = 0, skipped = 0, failed = 0;
  const errors: string[] = [];

  for (const e of entries) {
    const opId = opBySlug.get(e.operation_slug);
    if (!opId) { failed++; errors.push(`op '${e.operation_slug}' não existe`); continue; }

    // Idempotência: se external_id já existe pra (tenant, source), pula
    if (e.external_id) {
      const { data: existing } = await admin
        .from("revenue_entries")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("source", e.source)
        .eq("notes", `external_id:${e.external_id}`)  // armazena no notes até ter coluna dedicada
        .maybeSingle();
      if (existing) { skipped++; continue; }
    }

    const totalRevenue = e.breakdown.reduce((s, b) => s + (Number(b.amount) || 0), 0);

    const { data: re, error: reErr } = await admin
      .from("revenue_entries")
      .insert({
        tenant_id:      tenantId,
        operation_id:   opId,
        business_date:  e.business_date,
        source:         e.source,
        orders_count:   e.orders_count,
        cogs:           e.cogs ?? totalRevenue * 0.31,  // fallback heurístico
        status:         "confirmed",
        notes:          e.external_id ? `external_id:${e.external_id}` : (e.notes || null),
      })
      .select()
      .single();

    if (reErr) { failed++; errors.push(reErr.message); continue; }

    const breakdownRows = e.breakdown
      .map((b) => {
        const mId = methodBySlug.get(b.method_slug);
        if (!mId) return null;
        return {
          revenue_entry_id:  re.id,
          payment_method_id: mId,
          amount:            Number(b.amount) || 0,
        };
      })
      .filter(Boolean);

    if (breakdownRows.length > 0) {
      const { error: bErr } = await admin.from("revenue_payment_breakdown").insert(breakdownRows);
      if (bErr) {
        // Rollback do entry pra manter consistência
        await admin.from("revenue_entries").delete().eq("id", re.id);
        failed++;
        errors.push(`breakdown: ${bErr.message}`);
        continue;
      }
    }

    inserted++;
  }

  return { inserted, skipped, failed, errors: errors.slice(0, 10) };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
