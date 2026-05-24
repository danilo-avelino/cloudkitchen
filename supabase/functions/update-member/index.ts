// update-member · atualiza role/ops/modules em tenant_members e full_name em profiles
// usando service_role para bypassar a RLS de profiles (que só permite o próprio user).
// Validação: caller precisa ser owner/admin/manager do mesmo tenant que o user alvo.

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
    const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser(token);
    if (authErr || !caller) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }

    const { tenantId, userId, name, role, ops, modules, password } = await req.json();
    if (!tenantId || !userId) {
      return new Response(JSON.stringify({ error: "tenantId e userId obrigatórios" }), { status: 400, headers: corsHeaders });
    }
    if (password !== undefined && password !== null && password !== "") {
      if (typeof password !== "string" || password.length < 6) {
        return new Response(JSON.stringify({ error: "Senha precisa ter pelo menos 6 caracteres" }), { status: 400, headers: corsHeaders });
      }
    }

    // Usa client service_role direto pra validações (callerClient pode aplicar RLS)
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // Caller precisa ser owner/admin/manager do tenant
    const { data: actor, error: actorErr } = await admin
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", caller.id)
      .maybeSingle();
    if (actorErr) {
      return new Response(JSON.stringify({ error: `Lookup do caller falhou: ${actorErr.message}`, caller: caller.id, tenantId }), { status: 500, headers: corsHeaders });
    }
    if (!actor || !["owner", "admin", "manager"].includes(actor.role)) {
      return new Response(JSON.stringify({ error: "Forbidden", caller: caller.id, tenantId, actor }), { status: 403, headers: corsHeaders });
    }

    // Target precisa pertencer ao tenant
    const { data: target } = await admin
      .from("tenant_members")
      .select("user_id")
      .eq("tenant_id", tenantId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!target) {
      return new Response(JSON.stringify({ error: "Usuário não pertence ao tenant" }), { status: 404, headers: corsHeaders });
    }

    // 1) Atualiza tenant_members (role/ops/modules) se algum desses veio
    if (role !== undefined || ops !== undefined || modules !== undefined) {
      const patch: Record<string, unknown> = {};
      if (role !== undefined) patch.role = role;
      if (ops !== undefined) patch.ops = ops || [];
      if (modules !== undefined) patch.modules = Array.isArray(modules) ? modules : null;
      let { error: mErr } = await admin
        .from("tenant_members")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("user_id", userId);
      // Fallback caso a coluna modules ainda não exista
      if (mErr && /modules/i.test(String(mErr.message || ""))) {
        const { modules: _drop, ...basic } = patch;
        ({ error: mErr } = await admin
          .from("tenant_members")
          .update(basic)
          .eq("tenant_id", tenantId)
          .eq("user_id", userId));
      }
      if (mErr) {
        return new Response(JSON.stringify({ error: mErr.message }), { status: 500, headers: corsHeaders });
      }
    }

    // 2) Atualiza full_name em profiles (bypass RLS via service role)
    if (typeof name === "string" && name.trim()) {
      const { error: pErr } = await admin
        .from("profiles")
        .update({ full_name: name.trim() })
        .eq("id", userId);
      if (pErr) {
        return new Response(JSON.stringify({ error: pErr.message }), { status: 500, headers: corsHeaders });
      }
    }

    // 3) Reset de senha (opcional) via Auth Admin API
    if (typeof password === "string" && password.length >= 6) {
      const { error: aErr } = await admin.auth.admin.updateUserById(userId, {
        password, email_confirm: true,
      });
      if (aErr) {
        return new Response(JSON.stringify({ error: `Erro ao atualizar senha: ${aErr.message}` }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ ok: true, userId }), { status: 200, headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});
