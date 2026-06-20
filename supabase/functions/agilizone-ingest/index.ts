// agilizone-ingest · puxa pedidos da Agilizone (nível-loja) e normaliza por operação
//
// A Agilizone é o sistema de gestão de delivery. 1 conta = 1 dark kitchen física
// (storeId); dentro dela rodam N marcas (ifoodOrder.merchant.name) que mapeamos
// para `operations` via agilizone_brand_map. API é só-leitura via polling.
//
// Fluxo (POST body { tenantId?, accountId?, lookbackDays? }):
//   1. Seleciona contas ativas (todas se service_role; do tenant se membro manager+).
//   2. Para cada conta: OAuth client_credentials → pagina GET /orders cobrindo a janela.
//   3. Upsert idempotente em agilizone_orders (por account_id, agz_id) + itens.
//   4. Resolve operation_id pela marca (brand_map). Marca sem mapa fica null.
//   5. Recalcula revenue_entries + revenue_payment_breakdown por
//      (operação, dia, origem) a partir dos pedidos da janela.
//
// O client_secret fica no Supabase Vault (secret 'agilizone_client_secrets'),
// lido via RPC service-role-only public.agilizone_get_secret. Fallback: env
// AGILIZONE_SECRETS (JSON { "<client_id>": "<secret>" }).
//
// Auth do chamador: header x-ingest-secret (== Vault 'agilizone_ingest_secret')
// p/ cron/máquina, ou bearer service_role, ou JWT de membro manager+.
//
// Faturamento (regra do negócio): valor pago pelo cliente + incentivo de
// plataforma, excluindo descontos da loja → amount + Σ(cupons sponsor != MERCHANT).
// Origem (originPlatform) vira o source da revenue_entries. As entries da
// Agilizone são marcadas com notes='agilizone' e recalculadas (não sobrescrevem
// entries manuais com a mesma chave — nesse caso reportam conflito).

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRETS_JSON = Deno.env.get("AGILIZONE_SECRETS") || "{}";

const BASE: Record<string, string> = {
  production: "https://api.agilizone.com/agilizone/v2",
  sandbox:   "https://api.test.agilizone.com/agilizone/v2",
};

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
      const want = await getVaultSecret(admin, "agilizone_ingest_secret");
      machineAuth = !!want && ingestHeader === want;
    }
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const isService = machineAuth || jwtRole(token) === "service_role" || token === SERVICE_KEY;
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

    // secrets dos clients: Vault (preferido) ou env
    let secrets = parseSecrets(SECRETS_JSON);
    if (Object.keys(secrets).length === 0) {
      const vaultJson = await getVaultSecret(admin, "agilizone_client_secrets");
      if (vaultJson) secrets = parseSecrets(vaultJson);
    }

    // ---- Seleciona contas ----
    let q = admin.from("agilizone_accounts")
      .select("id, tenant_id, label, environment, client_id, store_id")
      .eq("is_active", true);
    if (accountId) q = q.eq("id", accountId);
    if (tenantId)  q = q.eq("tenant_id", tenantId);
    const { data: accounts, error: accErr } = await q;
    if (accErr) return json({ error: `accounts: ${accErr.message}` }, 500);
    if (!accounts || accounts.length === 0) return json({ error: "Nenhuma conta Agilizone ativa" }, 400);

    const cutoff = effectiveDay(Date.now() - lookbackDays * 864e5);
    const perAccount: Record<string, unknown> = {};

    for (const acc of accounts) {
      const secret = secrets[acc.client_id];
      if (!secret) { perAccount[acc.label] = { error: "secret ausente no Vault/env p/ este client_id" }; continue; }

      const env = acc.environment === "sandbox" ? "sandbox" : "production";
      const accessToken = await getToken(acc.client_id, secret, env);

      // brand map da conta
      const { data: brands } = await admin
        .from("agilizone_brand_map").select("merchant_name, operation_id").eq("account_id", acc.id);
      const brandMap = new Map((brands || []).map((b: any) => [b.merchant_name, b.operation_id]));

      // pagina cobrindo a janela (orders vêm do mais novo p/ o mais antigo)
      const orders: any[] = [];
      for (let page = 1; page <= 200; page++) {
        const batch = await listOrders(accessToken, env, page, 100);
        if (!batch.length) break;
        orders.push(...batch);
        if (batch.length < 100) break;
        const oldest = batch[batch.length - 1]?.createdAt;
        if (oldest && effectiveDay(oldest) < cutoff) break;
      }

      let mapped = 0, unmapped = 0;
      const unmappedBrands = new Set<string>();
      const fetchedAt = new Date().toISOString();

      // monta as linhas de pedido
      const orderRows = orders.map((o) => {
        const merchant = resolveMerchant(o);
        const operationId = merchant ? (brandMap.get(merchant) ?? null) : null;
        if (merchant) (operationId ? mapped++ : (unmapped++, unmappedBrands.add(merchant)));
        return {
          tenant_id:       acc.tenant_id,
          account_id:      acc.id,
          agz_id:          o._id,
          operation_id:    operationId,
          merchant_name:   merchant,
          order_number:    o.number ?? null,
          status:          o.status,
          is_canceled:     o.status === "CANCELED",
          origin_platform: o.originPlatform ?? null,
          order_type:      o.orderType ?? null,
          business_date:   effectiveDay(o.createdAt),
          created_at_src:  o.createdAt,
          amount:          numOrNull(o.amount),
          subtotal:        numOrNull(o.ifoodOrder?.total?.subTotal),
          delivery_fee:    numOrNull(o.deliveryFee),
          deliveryman_fee: numOrNull(o.deliverymanFee),
          benefits_total:  numOrNull(o.ifoodOrder?.total?.benefits),
          payment_type:    o.paymentType ?? null,
          is_prepaid:      typeof o.isPrepaid === "boolean" ? o.isPrepaid : null,
          neighborhood:    o.address?.neighborhood ?? null,
          deliveryman_id:  o.deliverymanId != null ? String(o.deliverymanId) : null,
          payload:         o,
          fetched_at:      fetchedAt,
        };
      });

      // upsert dos pedidos em lotes; mapeia agz_id -> id do banco
      const idByAgz = new Map<string, string>();
      for (const chunk of chunked(orderRows, 500)) {
        const { data, error } = await admin
          .from("agilizone_orders")
          .upsert(chunk, { onConflict: "account_id,agz_id" })
          .select("id, agz_id");
        if (error) return json({ error: `orders upsert: ${error.message}` }, 500);
        for (const r of (data || [])) idByAgz.set(r.agz_id, r.id);
      }

      // itens: apaga os existentes desses pedidos e reinsere (pedido muda entre polls)
      const orderIds = [...idByAgz.values()];
      for (const chunk of chunked(orderIds, 300)) {
        const { error } = await admin.from("agilizone_order_items").delete().in("order_id", chunk);
        if (error) return json({ error: `items delete: ${error.message}` }, 500);
      }
      const itemRows: any[] = [];
      for (const o of orders) {
        const oid = idByAgz.get(o._id);
        if (!oid) continue;
        orderItemsOf(o).forEach((it: any, i: number) => itemRows.push({
          tenant_id:     acc.tenant_id,
          order_id:      oid,
          idx:           it.index ?? i + 1,
          external_code: it.externalCode ?? it.external_code ?? null,
          name:          it.name ?? "(sem nome)",
          quantity:      numOrNull(it.quantity) ?? 1,
          unit_price:    numOrNull(it.unitPrice ?? it.unit_price),
          total_price:   numOrNull(it.totalPrice ?? it.price ?? it.total_price),
          options:       (it.options && it.options.length) ? it.options : null,
        }));
      }
      for (const chunk of chunked(itemRows, 500)) {
        const { error } = await admin.from("agilizone_order_items").insert(chunk);
        if (error) return json({ error: `items insert: ${error.message}` }, 500);
      }
      const upserted = orderRows.length;

      // recalcula faturamento por (operação, dia, origem) — só dias totalmente cobertos (>= cutoff)
      const revenue = await refreshRevenue(admin, acc, orders, brandMap, cutoff);

      await admin.from("agilizone_accounts")
        .update({ store_id: orders[0]?.storeId ?? acc.store_id, last_synced_at: new Date().toISOString() })
        .eq("id", acc.id);

      perAccount[acc.label] = {
        fetched: orders.length, upserted, mapped, unmapped,
        unmappedBrands: [...unmappedBrands], revenue,
      };
    }

    return json({ ok: true, window: { since: cutoff, lookbackDays }, perAccount });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// ---------- Faturamento (revenue_entries + breakdown) ----------
// Status que NÃO contam como venda firme.
const NON_SALE = new Set(["CANCELED", "PENDING_PAYMENT"]);

async function refreshRevenue(admin: any, acc: any, orders: any[], brandMap: Map<string, string>, cutoff: string) {
  // métodos de pagamento do tenant: slug -> id
  const { data: methods } = await admin
    .from("payment_methods").select("id, slug").eq("tenant_id", acc.tenant_id);
  const methodId = new Map((methods || []).map((m: any) => [m.slug, m.id]));

  // agrupa por (operation_id | business_date | source)
  type Group = { opId: string; date: string; source: string; count: number; byMethod: Map<string, number> };
  const groups = new Map<string, Group>();

  for (const o of orders) {
    if (NON_SALE.has(o.status)) continue;
    const merchant = resolveMerchant(o);
    const opId = merchant ? brandMap.get(merchant) : undefined;
    if (!opId) continue;                                  // marca não mapeada → não entra no faturamento
    const date = effectiveDay(o.createdAt);
    if (date < cutoff) continue;                          // dia parcial (cauda abaixo do corte) → ignora
    const source = originToSource(o.originPlatform);
    const key = `${opId}|${date}|${source}`;
    let g = groups.get(key);
    if (!g) { g = { opId, date, source, count: 0, byMethod: new Map() }; groups.set(key, g); }
    g.count++;
    const fat = (Number(o.amount) || 0) + platformIncentive(o);
    const slug = paymentSlug(o);
    g.byMethod.set(slug, (g.byMethod.get(slug) || 0) + fat);
  }

  let written = 0, conflicts = 0;
  const conflictKeys: string[] = [];

  for (const g of groups.values()) {
    // remove a entry anterior da Agilizone (mesma chave) antes de regravar
    await admin.from("revenue_entries").delete()
      .eq("tenant_id", acc.tenant_id).eq("operation_id", g.opId)
      .eq("business_date", g.date).eq("source", g.source)
      .is("shift_id", null).eq("notes", "agilizone");

    const { data: re, error: reErr } = await admin.from("revenue_entries").insert({
      tenant_id: acc.tenant_id, operation_id: g.opId, business_date: g.date,
      source: g.source, orders_count: g.count, cogs: 0,
      status: "confirmed", notes: "agilizone",
    }).select("id").single();

    if (reErr) {                                          // unique viol = entry manual ocupa a chave → não sobrescreve
      conflicts++; conflictKeys.push(`${g.source}@${g.date}`); continue;
    }

    const rows = [...g.byMethod.entries()]
      .map(([slug, amount]) => {
        const mId = methodId.get(slug);
        return mId ? { revenue_entry_id: re.id, payment_method_id: mId, amount: round2(amount) } : null;
      })
      .filter(Boolean);
    if (rows.length) await admin.from("revenue_payment_breakdown").insert(rows);
    written++;
  }

  return { entries: written, conflicts, conflictKeys };
}

// originPlatform (Agilizone) -> app.revenue_source
function originToSource(origin: string | null | undefined): string {
  switch (origin) {
    case "IFOOD":    return "ifood";
    case "ANOTA_AI": return "anota_ai";
    case "BEEFOOD":  return "beefood";
    default:         return "outro";
  }
}

// incentivo de plataforma = cupons cujo sponsor não é a loja
function platformIncentive(o: any): number {
  return (o.discountCoupons || [])
    .filter((c: any) => c?.sponsor && c.sponsor !== "MERCHANT")
    .reduce((s: number, c: any) => s + (Number(c.value) || 0), 0);
}

// paymentType (Agilizone) -> slug de payment_methods do tenant
function paymentSlug(o: any): string {
  if (o.isPrepaid) return "online";
  switch (o.paymentType) {
    case "CREDIT":       return "credito";
    case "DEBIT":        return "debito";
    case "PIX":          return "pix";
    case "CASH":         return "dinheiro";
    case "MEAL_VOUCHER":
    case "FOOD_VOUCHER": return "voucher";
    default:             return "online";   // DIGITAL_WALLET, OTHER, etc.
  }
}

function round2(n: number) { return Math.round(n * 100) / 100; }

// ---------- Agilizone API ----------
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

// ---------- helpers ----------
async function getVaultSecret(admin: any, name: string): Promise<string | null> {
  const { data, error } = await admin.rpc("agilizone_get_secret", { p_name: name });
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

// Nome da marca, robusto às origens da Agilizone. DEVE ser idêntico ao do
// agilizone-admin (discover-brands) p/ o merchant_name casar com o brand_map.
//   iFood → ifoodOrder.merchant.name · SAIPOS/PDVs → originOrder.merchant.name
//   AnotaAI/Mogo/Neemo → *.merchant.name · sem nome (ex.: CARDAPIO_WEB que só
//   traz merchant_id numérico) → "<Origem> #<id>".
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

// Itens em qualquer origem: iFood usa ifoodOrder.items; SAIPOS/CARDAPIO_WEB usam
// originOrder.items. Todos têm ao menos { name, quantity }.
function orderItemsOf(o: any): any[] {
  const arr = o?.ifoodOrder?.items ?? o?.originOrder?.items ?? [];
  return Array.isArray(arr) ? arr : [];
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
