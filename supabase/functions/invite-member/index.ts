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
    // Extract and verify caller's JWT
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

    const { tenantId, email, role, ops } = await req.json();
    if (!tenantId || !email || !role) {
      return new Response(JSON.stringify({ error: "tenantId, email, role required" }), { status: 400, headers: corsHeaders });
    }

    // Verify caller is owner/admin of this tenant
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

    // Invite user
    const { data: invite, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { tenantId, role },
    });
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }

    // Insert tenant_members row
    await admin.from("tenant_members").upsert(
      { tenant_id: tenantId, user_id: invite.user.id, role, ops: ops || [] },
      { onConflict: "tenant_id,user_id" }
    );

    return new Response(JSON.stringify({ userId: invite.user.id }), { status: 201, headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});
