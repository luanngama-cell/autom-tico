import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHash, timingSafeEqual } from "crypto";

function sha256Hex(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

export const Route = createFileRoute("/api/public/agent/heartbeat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
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

        const now = new Date().toISOString();
        await Promise.all([
          supabaseAdmin
            .from("sql_connections")
            .update({ status: "online", last_seen_at: now })
            .eq("id", connectionId),
          supabaseAdmin
            .from("agent_tokens")
            .update({ last_used_at: now })
            .eq("id", tokenRow.id),
        ]);

        return json({ ok: true, last_seen_at: now });
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