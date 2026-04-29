import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHash, timingSafeEqual } from "crypto";

/**
 * Lista todas as tabelas espelhadas disponíveis para consulta pelo BI.
 *
 * Auth: Bearer destinationId.rawToken (mesmo esquema do /bi/snapshot)
 *
 * Resposta:
 *  { tables: [{ id, schema, name, primary_keys, row_count, last_synced_at }] }
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function sha256Hex(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

function getClientIp(req: Request) {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    null
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

async function authorize(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  if (!bearer) return { ok: false as const, error: "Missing token", status: 401 };
  const [destinationId, rawToken] = bearer.split(".");
  if (!destinationId || !rawToken)
    return { ok: false as const, error: "Invalid token format", status: 401 };

  const tokenHash = sha256Hex(rawToken);
  const { data: tokenRow } = await supabaseAdmin
    .from("bi_destination_tokens")
    .select("id, revoked_at")
    .eq("destination_id", destinationId)
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (!tokenRow || tokenRow.revoked_at)
    return { ok: false as const, error: "Unauthorized", status: 401 };

  const { data: dest } = await supabaseAdmin
    .from("bi_destinations")
    .select("id, enabled, allowed_ips")
    .eq("id", destinationId)
    .maybeSingle();
  if (!dest || !dest.enabled)
    return { ok: false as const, error: "Destination disabled", status: 403 };

  const ip = getClientIp(request);
  if (
    dest.allowed_ips &&
    dest.allowed_ips.length > 0 &&
    (!ip || !dest.allowed_ips.includes(ip))
  )
    return { ok: false as const, error: "IP not allowed", status: 403 };

  await supabaseAdmin
    .from("bi_destination_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", tokenRow.id);

  return { ok: true as const, destinationId };
}

export const Route = createFileRoute("/api/public/mirror/tables")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      GET: async ({ request }) => {
        const auth = await authorize(request);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        const { data, error } = await supabaseAdmin
          .from("sync_tables")
          .select("id, schema_name, table_name, primary_keys, row_count, last_synced_at, enabled")
          .eq("enabled", true)
          .order("schema_name")
          .order("table_name");

        if (error) return json({ error: error.message }, 500);

        return json({
          count: data?.length ?? 0,
          tables: (data ?? []).map((t) => ({
            id: t.id,
            schema: t.schema_name,
            name: t.table_name,
            full_name: `${t.schema_name}.${t.table_name}`,
            primary_keys: t.primary_keys,
            row_count: t.row_count,
            last_synced_at: t.last_synced_at,
          })),
        });
      },
    },
  },
});
