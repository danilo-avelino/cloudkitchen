// provision-tenant · cria um novo tenant + owner + seeds.
//
// Autenticação: JWT do chamador deve resolver pra um profile com
// is_superadmin = true (flag adicionada na Fase 13). Não usa mais
// SK_ADMIN_KEY (segredo compartilhado vazava via config.local.js no front).
//
// Pré-requisitos no DB:
//   1. Coluna public.profiles.is_superadmin (Fase 13)
//   2. Função app.is_superadmin(uuid) — não usada aqui mas disponível pra RLS
//
// Pra promover um usuário a superadmin (uma vez, via SQL editor):
//   update public.profiles set is_superadmin = true where id = '<auth-user-id>';

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
    // 1. JWT → user
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      return json({ error: "Unauthorized · sem JWT" }, 401);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) {
      return json({ error: "Unauthorized · JWT inválido" }, 401);
    }

    // 2. Profile · checa is_superadmin
    const { data: profile, error: profErr } = await admin
      .from("profiles")
      .select("is_superadmin")
      .eq("id", user.id)
      .maybeSingle();

    if (profErr) return json({ error: profErr.message }, 500);
    if (!profile?.is_superadmin) {
      return json({ error: "Forbidden · requer is_superadmin" }, 403);
    }

    // 3. Validação do payload
    const { name, slug, plan = "starter", ownerEmail, ownerName } = await req.json();
    if (!name || !slug || !ownerEmail) {
      return json({ error: "name, slug, ownerEmail required" }, 400);
    }
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
      return json({ error: "slug inválido (use kebab-case, sem espaços)" }, 400);
    }

    // 4. Insert tenant
    const { data: tenant, error: tErr } = await admin
      .from("tenants")
      .insert({ name, slug, plan })
      .select()
      .single();
    if (tErr) return json({ error: tErr.message }, 500);

    // 5. Convida owner (cria auth user + envia email). Se já existe, recupera por listUsers.
    let userId: string;
    const { data: invite, error: iErr } = await admin.auth.admin.inviteUserByEmail(ownerEmail, {
      data: { full_name: ownerName || name },
    });
    if (iErr) {
      // Se erro for "already registered", busca o user existente
      if (/already (been )?registered|exists/i.test(iErr.message)) {
        const { data: existing } = await admin.auth.admin.listUsers();
        const found = existing?.users?.find((u) => u.email?.toLowerCase() === ownerEmail.toLowerCase());
        if (!found) {
          await admin.from("tenants").delete().eq("id", tenant.id); // rollback
          return json({ error: "Email existe mas não foi possível resolver" }, 500);
        }
        userId = found.id;
      } else {
        await admin.from("tenants").delete().eq("id", tenant.id);
        return json({ error: iErr.message }, 500);
      }
    } else {
      userId = invite.user.id;
    }

    // 6. tenant_members (owner)
    const { error: mErr } = await admin
      .from("tenant_members")
      .insert({ tenant_id: tenant.id, user_id: userId, role: "owner" });
    if (mErr) {
      console.warn("tenant_members insert falhou (talvez já exista):", mErr.message);
    }

    // 7. Seeds: métodos de pagamento + categorias de estoque
    const PAYMENT_SEEDS = [
      { name: "iFood online", kind: "online" },
      { name: "Rappi online", kind: "online" },
      { name: "Dinheiro",     kind: "cash" },
      { name: "Débito",       kind: "debit" },
      { name: "Crédito",      kind: "credit" },
      { name: "Pix",          kind: "pix" },
    ];
    await admin
      .from("payment_methods")
      .insert(PAYMENT_SEEDS.map((m) => ({ ...m, tenant_id: tenant.id, is_active: true })));

    const CAT_SEEDS = ["Carnes", "Hortifruti", "Laticínios", "Secos", "Embalagens", "Descartáveis", "Limpeza", "Outros"];
    await admin
      .from("stock_categories")
      .insert(CAT_SEEDS.map((name, i) => ({ name, tenant_id: tenant.id, sort_order: i })));

    return json({ tenantId: tenant.id, userId, slug }, 201);
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
