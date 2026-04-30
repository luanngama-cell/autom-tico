import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Refresh materialized views that are due (called by pg_cron every minute).
 * Auth: bi_cron_token (same secret used by other BI cron endpoints).
 */
export const Route = createFileRoute("/api/public/bi/refresh-mvs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.replace(/^Bearer\s+/i, "");
        if (!token) return json({ error: "Missing token" }, 401);

        const { data: ok } = await supabaseAdmin.rpc("validate_bi_cron_token", { _token: token });
        if (!ok) return json({ error: "Invalid token" }, 401);

        const { data, error } = await supabaseAdmin.rpc("refresh_due_mvs");
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, results: data });
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
