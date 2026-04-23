import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHash, timingSafeEqual } from "crypto";

/**
 * Agent manifest endpoint.
 * Returns the current state the agent needs to plan a sync cycle:
 *   - list of known tables for this connection (with last_checksum / strategy)
 * The agent uses this to decide between full scan and rowversion incremental.
 */
function sha256Hex(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

export const Route = createFileRoute("/api/public/agent/manifest")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const agentSecret = request.headers.get("x-agent-secret") ?? "";
        const expectedSecret = process.env.AGENT_INGEST_SECRET;
        if (!expectedSecret) return json({ error: "Server misconfigured" }, 500);

        const a = Buffer.from(agentSecret);
        const b = Buffer.from(expectedSecret);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return json({ error: "Invalid agent secret" }, 401);
        }

        const bearer = auth.replace(/^Bearer\s+/i, "");
        const [connectionId, rawToken] = bearer.split(".");
        if (!connectionId || !rawToken) return json({ error: "Invalid token" }, 401);

        const tokenHash = sha256Hex(rawToken);
        const { data: tokenRow } = await supabaseAdmin
          .from("agent_tokens")
          .select("id, revoked_at")
          .eq("connection_id", connectionId)
          .eq("token_hash", tokenHash)
          .maybeSingle();
        if (!tokenRow || tokenRow.revoked_at) return json({ error: "Unauthorized" }, 401);

        const { data: conn } = await supabaseAdmin
          .from("sql_connections")
          .select("id, name, host, port, database_name, username, encrypt, trust_server_cert")
          .eq("id", connectionId)
          .maybeSingle();
        if (!conn) return json({ error: "Connection not found" }, 404);

        const { data: tables } = await supabaseAdmin
          .from("sync_tables")
          .select("schema_name, table_name, strategy, primary_keys, has_rowversion, last_checksum, enabled")
          .eq("connection_id", connectionId);

        return json({
          connection: conn,
          tables: tables ?? [],
          poll_interval_seconds: 60,
        });
      },
    },
  },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
