// agilizone-sync-worker · drena a fila pgmq `agilizone_sync` e processa cada
// conta chamando a edge function `agilizone-ingest` (uma conta por mensagem).
//
// Substitui o poll monolítico: em vez de 1 invocação varrer TODAS as contas
// sequencialmente (gargalo a 280s), o scheduler `agilizone_enqueue_sync()`
// enfileira 1 mensagem por conta e este worker as consome em paralelo com
// concorrência limitada. Retry/visibility-timeout/DLQ são do pgmq:
//   - read() marca a msg invisível por VT_SECONDS e incrementa read_ct;
//   - sucesso (200) → archive (sai da fila);
//   - falha → não arquiva: o VT expira e a msg volta p/ retry;
//   - read_ct >= MAX_READS → archive forçado (DLQ na tabela a_agilizone_sync).
//
// Auth do chamador: header x-ingest-secret (== Vault 'agilizone_ingest_secret')
// ou bearer service_role. Disparado pelo cron via `agilizone_run_worker()`.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BATCH         = 10;       // mensagens lidas por rodada
const CONCURRENCY   = 5;        // contas processadas em paralelo
const VT_SECONDS    = 180;      // visibility timeout (> tempo de 1 sync)
const MAX_READS     = 5;        // após N tentativas → DLQ
const TIME_BUDGET_MS = 60_000;  // dreno máximo por invocação

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ingest-secret",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // secret de máquina (também usado p/ chamar a agilizone-ingest)
  const { data: secret } = await admin.rpc("agilizone_get_secret", { p_name: "agilizone_ingest_secret" });

  // ---- auth do chamador ----
  const ingestHeader = req.headers.get("x-ingest-secret");
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const ok = (!!secret && ingestHeader === secret) || token === SERVICE_KEY;
  if (!ok) return json({ error: "Unauthorized" }, 401);
  if (!secret) return json({ error: "agilizone_ingest_secret ausente no Vault" }, 500);

  const started = Date.now();
  let processed = 0, archived = 0, retried = 0, dead = 0;

  try {
    while (Date.now() - started < TIME_BUDGET_MS) {
      const { data: msgs, error } = await admin.rpc("agilizone_queue_read", { p_qty: BATCH, p_vt: VT_SECONDS });
      if (error) return json({ error: `queue_read: ${error.message}` }, 500);
      if (!msgs || msgs.length === 0) break;

      for (let i = 0; i < msgs.length; i += CONCURRENCY) {
        await Promise.all(msgs.slice(i, i + CONCURRENCY).map(async (m: any) => {
          processed++;
          const accountId    = m.message?.accountId;
          const lookbackDays = m.message?.lookbackDays ?? 1;
          const drop = async () => { await admin.rpc("agilizone_queue_archive", { p_msg_id: m.msg_id }); };
          try {
            const res = await fetch(`${SUPABASE_URL}/functions/v1/agilizone-ingest`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-ingest-secret": secret as string },
              body: JSON.stringify({ accountId, lookbackDays }),
            });
            if (res.ok) { await drop(); archived++; return; }
            // falhou: DLQ se já tentou demais, senão deixa o VT expirar p/ retry
            if ((m.read_ct ?? 0) >= MAX_READS) { await drop(); dead++; } else { retried++; }
          } catch (_e) {
            if ((m.read_ct ?? 0) >= MAX_READS) { await drop(); dead++; } else { retried++; }
          }
        }));
      }
    }
  } catch (e) {
    return json({ error: String(e), processed, archived, retried, dead }, 500);
  }

  return json({ ok: true, processed, archived, retried, dead });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
