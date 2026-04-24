import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { timingSafeEqual } from "crypto";

/**
 * Scheduled maintenance: delete log rows older than 30 days.
 * Called by pg_cron daily. Auth: X-Maintenance-Secret = AGENT_INGEST_SECRET.
 */
export const Route = createFileRoute("/api/public/maintenance/cleanup-logs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = request.headers.get("x-maintenance-secret") ?? "";
        const expected = process.env.AGENT_INGEST_SECRET;
        if (!expected) {
          return json({ error: "Server misconfigured" }, 500);
        }
        const a = Buffer.from(secret);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return json({ error: "Unauthorized" }, 401);
        }

        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        const { count: syncLogsDeleted } = await supabaseAdmin
          .from("sync_logs")
          .delete({ count: "exact" })
          .lt("created_at", cutoff);

        const { count: biDeliveriesDeleted } = await supabaseAdmin
          .from("bi_deliveries")
          .delete({ count: "exact" })
          .lt("created_at", cutoff);

        return json({
          ok: true,
          cutoff,
          sync_logs_deleted: syncLogsDeleted ?? 0,
          bi_deliveries_deleted: biDeliveriesDeleted ?? 0,
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
