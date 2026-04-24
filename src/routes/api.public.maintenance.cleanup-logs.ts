import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Scheduled maintenance: delete log rows older than 30 days.
 * Called by pg_cron daily. Auth: X-Maintenance-Token validated against vault.
 */
export const Route = createFileRoute("/api/public/maintenance/cleanup-logs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = request.headers.get("x-maintenance-token") ?? "";
        if (!token) {
          return json({ error: "Missing token" }, 401);
        }

        const { data: valid, error: vErr } = await supabaseAdmin.rpc(
          "validate_maintenance_token",
          { _token: token }
        );
        if (vErr || !valid) {
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
