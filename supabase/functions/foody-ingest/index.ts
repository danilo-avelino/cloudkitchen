// foody-ingest · puxa pedidos da Foody Delivery e normaliza por operação
//
// A Foody Delivery é o sistema de gestão de logística (last-mile). 1 conta =
// 1 token de API; dentro dela os pedidos saem de N pontos de coleta
// (collectionPoint.name) que mapeamos para `operations` via foody_point_map.
// API só-leitura via polling: GET /orders?startDate=&endDate= (máx. 500/req;
// se vierem exatamente 500, avança o startDate além do último e repete).
//
// Fluxo (POST body { tenantId?, accountId?, lookbackDays? }): espelho do
// agilizone-ingest —
//   1. Seleciona contas ativas (todas se service_role; do tenant se manager+).
//   2. Para cada conta: token do Vault → busca pedidos da janela.
//   3. Upsert idempotente em foody_orders (por account_id, uid), com diff
//      (só grava novos ou com status/valor alterado).
//   4. Resolve operation_id pelo ponto de coleta (point_map). Sem mapa → null.
//   5. Recalcula revenue_entries + revenue_payment_breakdown por
//      (operação, dia, origem) a partir dos pedidos da janela (notes='foody').
//
// O token fica no Supabase Vault (secret 'foody_api_tokens', mapa
// { "<account_id>": "<token>" }), lido via RPC service-role-only
// public.foody_get_secret. Fallback: env FOODY_TOKENS (mesmo formato).
//
// Auth do chamador: header x-ingest-secret (== Vault 'foody_ingest_secret')
// p/ cron/máquina, ou bearer service_role, ou JWT de membro manager+.
//
// TRAVA: a exclusividade Agilizone×Foody é garantida no banco (trigger em
// *_accounts) — aqui só processamos contas is_active.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKENS_JSON  = Deno.env.get("FOODY_TOKENS") || "{}";

const BASE = "https://app.foodydelivery.com/rest/1.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ingest-secret",
};

// Dia efetivo: corte 05:00 BRT = UTC-8h (3h fuso + 5h corte da madrugada).
const DAY_CUTOFF_SHIFT_MS = 8 * 60 * 60 * 1000;
function effectiveDay(date: string | number | Date): string {
  const t = typeof date === "object" ? date.getTime()
          : typeof date === "number" ? date : new Date(date).getTime();
  return new Date(t - DAY_CUTOFF_SHIFT_MS).toISOString().slice(0, 10);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    const body = await req.json().catch(() => ({}));
    const { tenantId, accountId, lookbackDays = 1 } = body as {
      tenantId?: string; accountId?: string; lookbackDays?: number;
    };

    // ---- Auth do chamador ----
    const ingestHeader = req.headers.get("x-ingest-secret");
    let machineAuth = false;
    if (ingestHeader) {
      const want = await getVaultSecret(admin, "foody_ingest_secret");
      machineAuth = !!want && safeEqual(ingestHeader, want);
    }
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const isService = machineAuth || jwtRole(token) === "service_role" || safeEqual(token, SERVICE_KEY);
    if (!isService) {
      if (!token) return json({ error: "Unauthorized" }, 401);
      if (!tenantId) return json({ error: "tenantId required" }, 400);
      const { data: { user }, error: authErr } = await admin.auth.getUser(token);
      if (authErr || !user) return json({ error: "Unauthorized" }, 401);
      const { data: member } = await admin
        .from("tenant_members").select("role")
        .eq("tenant_id", tenantId).eq("user_id", user.id).maybeSingle();
      if (!member || !["owner", "admin", "manager"].includes(member.role)) {
        return json({ error: "Forbidden" }, 403);
      }
    }

    // tokens das contas: Vault (preferido) ou env
    let tokens = parseSecrets(TOKENS_JSON);
    if (Object.keys(tokens).length === 0) {
      const vaultJson = await getVaultSecret(admin, "foody_api_tokens");
      if (vaultJson) tokens = parseSecrets(vaultJson);
    }

    // ---- Seleciona contas ----
    let q = admin.from("foody_accounts")
      .select("id, tenant_id, label")
      .eq("is_active", true);
    if (accountId) q = q.eq("id", accountId);
    if (tenantId)  q = q.eq("tenant_id", tenantId);
    const { data: accounts, error: accErr } = await q;
    if (accErr) return json({ error: `accounts: ${accErr.message}` }, 500);
    if (!accounts || accounts.length === 0) return json({ error: "Nenhuma conta Foody ativa" }, 400);

    const cutoff = effectiveDay(Date.now() - lookbackDays * 864e5);
    const perAccount: Record<string, unknown> = {};

    for (const acc of accounts) {
      const apiToken = tokens[acc.id];
      if (!apiToken) { perAccount[acc.label] = { error: "token ausente no Vault/env p/ esta conta" }; continue; }

      // point map da conta
      const { data: points } = await admin
        .from("foody_point_map").select("point_name, operation_id").eq("account_id", acc.id);
      const pointMap = new Map((points || []).map((p: any) => [p.point_name, p.operation_id]));

      // janela: início 8h antes do dia de corte (cobre o dia efetivo inteiro)
      const startMs = Date.parse(cutoff + "T00:00:00Z") + DAY_CUTOFF_SHIFT_MS - 3 * 3600 * 1000;
      const orders = await listOrdersWindow(apiToken, new Date(startMs), new Date(Date.now() + 3600 * 1000));

      let mapped = 0, unmapped = 0;
      const unmappedPoints = new Set<string>();
      const fetchedAt = new Date().toISOString();

      // monta as linhas de pedido (descarta pedidos sem uid/data — inválidos)
      const orderRows = orders.flatMap((o) => {
        const createdAt = o.date ?? o.creationDate;
        if (!o.uid || !createdAt) return [];
        const point = resolvePoint(o);
        const operationId = point ? (pointMap.get(point) ?? null) : null;
        if (point) (operationId ? mapped++ : (unmapped++, unmappedPoints.add(point)));
        return [{
          tenant_id:      acc.tenant_id,
          account_id:     acc.id,
          uid:            o.uid,
          operation_id:   operationId,
          point_name:     point,
          external_id:    o.id != null ? String(o.id) : null,
          status:         String(o.status ?? "unknown"),
          is_canceled:    isCanceledStatus(o.status),
          business_date:  effectiveDay(createdAt),
          created_at_src: createdAt,
          ready_at:       o.readyDate ?? null,
          despatched_at:  o.despatchDate ?? null,
          collected_at:   o.collectedDate ?? null,
          delivered_at:   o.deliveryDate ?? null,
          promised_at:    o.deliveryDueDate ?? null,
          amount:         numOrNull(o.orderTotal),
          delivery_fee:   numOrNull(o.deliveryFee),
          courier_fee:    numOrNull(o.courierFee),
          payment_method: o.paymentMethod ?? null,
          courier_name:   o.courier?.courierName ?? null,
          courier_type:   o.courier?.courierType ?? null,
          neighborhood:   o.deliveryPoint?.district ?? o.deliveryPoint?.neighborhood ?? null,
          distance_m:     haversineM(o.collectionPoint?.coordinates, o.deliveryPoint?.coordinates),
          payload:        o,
          fetched_at:     fetchedAt,
        }];
      });

      // diff: só grava pedidos novos ou cujo status/valor mudou (mesma razão do
      // agilizone-ingest: evita churn de UPDATE/WAL a cada poll). Prefetch leve
      // paginando o teto de 1000 do PostgREST.
      const floor = orderRows.reduce((m, r) => r.business_date < m ? r.business_date : m, cutoff);
      const existing = new Map<string, { status: string; amount: number | null }>();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await admin.from("foody_orders")
          .select("uid, status, amount")
          .eq("account_id", acc.id).gte("business_date", floor)
          .range(from, from + 999);
        if (error) return json({ error: `orders prefetch: ${error.message}` }, 500);
        for (const r of data ?? []) existing.set(r.uid, { status: r.status, amount: r.amount });
        if (!data || data.length < 1000) break;
      }
      const changedRows = orderRows.filter((r) => {
        const prev = existing.get(r.uid);
        return !prev || prev.status !== r.status || (prev.amount ?? null) !== (r.amount ?? null);
      });
      const changedUids = new Set(changedRows.map((r) => r.uid));

      for (const chunk of chunked(changedRows, 500)) {
        const { error } = await admin
          .from("foody_orders")
          .upsert(chunk, { onConflict: "account_id,uid" });
        if (error) return json({ error: `orders upsert: ${error.message}` }, 500);
      }
      const upserted = changedRows.length;

      // recalcula faturamento por (operação, dia, origem) — só dias totalmente cobertos
      const revenue = await refreshRevenue(admin, acc, orderRows, cutoff, changedUids);

      await admin.from("foody_accounts")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("id", acc.id);

      perAccount[acc.label] = {
        fetched: orders.length, upserted, skipped: orderRows.length - upserted, mapped, unmapped,
        unmappedPoints: [...unmappedPoints], revenue,
      };
    }

    return json({ ok: true, window: { since: cutoff, lookbackDays }, perAccount });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// ---------- Faturamento (revenue_entries + breakdown) ----------
// Mesma regra do agilizone-ingest: entries marcadas com notes='foody' são
// recalculadas; entry manual na mesma chave → conflito reportado, não sobrescreve.
async function refreshRevenue(admin: any, acc: any, rows: any[], cutoff: string, changedUids: Set<string>) {
  const { data: methods } = await admin
    .from("payment_methods").select("id, slug").eq("tenant_id", acc.tenant_id);
  const methodId = new Map((methods || []).map((m: any) => [m.slug, m.id]));

  type Group = { opId: string; date: string; source: string; count: number; byMethod: Map<string, number> };
  const groups = new Map<string, Group>();

  for (const r of rows) {
    if (r.is_canceled) continue;
    if (!r.operation_id) continue;                        // ponto não mapeado → fora do faturamento
    if (r.business_date < cutoff) continue;               // dia parcial → ignora
    const source = r.payload?.ifoodLocalizer ? "ifood" : "outro";
    const key = `${r.operation_id}|${r.business_date}|${source}`;
    let g = groups.get(key);
    if (!g) { g = { opId: r.operation_id, date: r.business_date, source, count: 0, byMethod: new Map() }; groups.set(key, g); }
    g.count++;
    const slug = paymentSlug(r.payment_method);
    g.byMethod.set(slug, (g.byMethod.get(slug) || 0) + (Number(r.amount) || 0));
  }

  // grupos com ao menos um pedido novo/alterado neste poll — inclui cancelados,
  // que mudam o total mesmo saindo da agregação acima.
  const touched = new Set<string>();
  for (const r of rows) {
    if (!changedUids.has(r.uid)) continue;
    if (!r.operation_id) continue;
    if (r.business_date < cutoff) continue;
    const source = r.payload?.ifoodLocalizer ? "ifood" : "outro";
    touched.add(`${r.operation_id}|${r.business_date}|${source}`);
  }

  let written = 0, conflicts = 0;
  const conflictKeys: string[] = [];

  for (const [key, g] of groups) {
    if (!touched.has(key)) continue;
    await admin.from("revenue_entries").delete()
      .eq("tenant_id", acc.tenant_id).eq("operation_id", g.opId)
      .eq("business_date", g.date).eq("source", g.source)
      .is("shift_id", null).eq("notes", "foody");

    const { data: re, error: reErr } = await admin.from("revenue_entries").insert({
      tenant_id: acc.tenant_id, operation_id: g.opId, business_date: g.date,
      source: g.source, orders_count: g.count, cogs: 0,
      status: "confirmed", notes: "foody",
    }).select("id").single();

    if (reErr) {                                          // unique viol = outra entry ocupa a chave → não sobrescreve
      conflicts++; conflictKeys.push(`${g.source}@${g.date}`); continue;
    }

    const brk = [...g.byMethod.entries()]
      .map(([slug, amount]) => {
        const mId = methodId.get(slug);
        return mId ? { revenue_entry_id: re.id, payment_method_id: mId, amount: round2(amount) } : null;
      })
      .filter(Boolean);
    if (brk.length) await admin.from("revenue_payment_breakdown").insert(brk);
    written++;
  }

  return { entries: written, conflicts, conflictKeys };
}

// paymentMethod (Foody) -> slug de payment_methods do tenant
function paymentSlug(pm: string | null | undefined): string {
  switch (pm) {
    case "money": return "dinheiro";
    case "pix":   return "pix";
    case "card":  return "credito";
    default:      return "online";   // online, e_wallet, on_credit, etc.
  }
}

function round2(n: number) { return Math.round(n * 100) / 100; }

// ---------- Foody API ----------
// GET /orders?startDate=&endDate= — máx. 500 por requisição, ordenado por date.
// Se vierem exatamente 500, avança o startDate acima do último e repete.
async function listOrdersWindow(token: string, start: Date, end: Date): Promise<any[]> {
  const out: any[] = [];
  const seen = new Set<string>();
  let cursor = start;
  for (let page = 0; page < 40; page++) {
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
    if (next <= cursor) break;                            // proteção contra loop
    cursor = next;
  }
  return out;
}

// yyyy-MM-dd'T'HH:mm:ssXXX com offset -03:00 explícito (mais seguro que 'Z'
// p/ o parser da Foody, que é uma plataforma brasileira)
function isoNoMs(d: Date): string {
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "-03:00");
}

// ---------- helpers ----------
// Ponto de coleta do pedido. DEVE ser idêntico ao do foody-admin
// (discover-points) p/ o point_name casar com o foody_point_map.
function resolvePoint(o: any): string | null {
  const name = o?.collectionPoint?.name ?? o?.collectionPoint?.pointName;
  return name != null ? String(name) : null;
}

// cancelled/canceled/rejected → cancelado
function isCanceledStatus(s: unknown): boolean {
  const v = String(s ?? "").toLowerCase();
  return v === "cancelled" || v === "canceled" || v === "rejected";
}

// distância em linha reta (m) entre coleta e entrega — a Foody não expõe a
// distância calculada; raio N km = ceil(km) da linha reta (mesma regra do app)
function haversineM(a: any, b: any): number | null {
  const lat1 = Number(a?.lat), lng1 = Number(a?.lng);
  const lat2 = Number(b?.lat), lng2 = Number(b?.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
  if ((lat1 === 0 && lng1 === 0) || (lat2 === 0 && lng2 === 0)) return null;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(s)));
}

async function getVaultSecret(admin: any, name: string): Promise<string | null> {
  const { data, error } = await admin.rpc("foody_get_secret", { p_name: name });
  if (error) return null;
  return (data as string) ?? null;
}

function parseSecrets(s: string): Record<string, string> {
  try { return JSON.parse(s); } catch { return {}; }
}

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function numOrNull(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// comparação constant-time p/ secrets (evita timing attack na auth de máquina)
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

function jwtRole(t: string): string | null {
  try {
    const payload = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const j = JSON.parse(atob(payload + "=".repeat((4 - payload.length % 4) % 4)));
    return j.role ?? null;
  } catch { return null; }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
