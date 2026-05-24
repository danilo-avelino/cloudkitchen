import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }

    const callerClient = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: { user }, error: authErr } = await callerClient.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }

    const { tenantId, email, password, role, ops, modules, name } = await req.json();
    if (!tenantId || !email || !role || !password) {
      return new Response(JSON.stringify({ error: "tenantId, email, password, role required" }), { status: 400, headers: corsHeaders });
    }
    if (typeof password !== "string" || password.length < 6) {
      return new Response(JSON.stringify({ error: "Senha precisa ter pelo menos 6 caracteres" }), { status: 400, headers: corsHeaders });
    }

    const { data: member } = await callerClient
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .single();

    if (!member || !["owner", "admin"].includes(member.role)) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: corsHeaders });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // Try to create user with password (already confirmed, no email needed)
    let userId: string | null = null;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { tenantId, role, full_name: name || null, name: name || null },
    });

    if (createErr) {
      // If user already exists, look them up and reset their password
      const msg = String(createErr.message || "").toLowerCase();
      if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
        const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
        if (listErr) {
          return new Response(JSON.stringify({ error: listErr.message }), { status: 500, headers: corsHeaders });
        }
        const existing = list?.users?.find((u: any) => (u.email || "").toLowerCase() === email.toLowerCase());
        if (!existing) {
          return new Response(JSON.stringify({ error: createErr.message }), { status: 500, headers: corsHeaders });
        }
        userId = existing.id;
        await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
      } else {
        return new Response(JSON.stringify({ error: createErr.message }), { status: 500, headers: corsHeaders });
      }
    } else {
      userId = created.user.id;
    }

    if (!userId) {
      return new Response(JSON.stringify({ error: "Falha ao obter user id" }), { status: 500, headers: corsHeaders });
    }

    const memberRow: Record<string, unknown> = {
      tenant_id: tenantId, user_id: userId, role, ops: ops || [],
    };
    if (Array.isArray(modules)) memberRow.modules = modules;
    let { error: upsertErr } = await admin.from("tenant_members").upsert(
      memberRow,
      { onConflict: "tenant_id,user_id" }
    );
    // Fallback: migration de modules ainda não aplicada
    if (upsertErr && /modules/i.test(String(upsertErr.message || ""))) {
      const { modules: _drop, ...basic } = memberRow as any;
      ({ error: upsertErr } = await admin.from("tenant_members").upsert(
        basic, { onConflict: "tenant_id,user_id" }
      ));
    }
    if (upsertErr) {
      return new Response(JSON.stringify({ error: upsertErr.message }), { status: 500, headers: corsHeaders });
    }

    // Garante full_name em profiles (trigger só preenche no INSERT inicial e
    // pode ter feito fallback pro email quando o user já existia).
    if (name && typeof name === "string" && name.trim()) {
      await admin.from("profiles").update({ full_name: name.trim() }).eq("id", userId);
    }

    return new Response(JSON.stringify({ userId, email }), { status: 201, headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});
