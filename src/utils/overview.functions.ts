import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getOverviewStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;

    // Verify master role server-side
    const { data: roleCheck } = await supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "master",
    });
    if (!roleCheck) {
      throw new Response("Forbidden", { status: 403 });
    }

    const [connectionsRes, tablesRes, errorsRes, recentLogsRes, hourlyRes] =
      await Promise.all([
        supabase
          .from("sql_connections")
          .select("id, name, status, last_seen_at, host, database_name"),
        supabase
          .from("sync_tables")
          .select("id, row_count, last_synced_at, last_error, enabled"),
        supabase
          .from("sync_tables")
          .select("schema_name, table_name, last_error, last_synced_at")
          .not("last_error", "is", null)
          .limit(10),
        supabase
          .from("sync_logs")
          .select("id, event, level, message, created_at, duration_ms")
          .order("created_at", { ascending: false })
          .limit(15),
        supabase
          .from("sync_logs")
          .select("created_at, event, rows_inserted, rows_updated, rows_deleted")
          .gte(
            "created_at",
            new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
          )
          .eq("event", "table_synced"),
      ]);

    const tables = tablesRes.data ?? [];
    const totalRows = tables.reduce((s, t) => s + Number(t.row_count ?? 0), 0);
    const synced = tables.filter((t) => t.last_synced_at).length;
    const withErrors = tables.filter((t) => t.last_error).length;
    const lastSync = tables
      .map((t) => t.last_synced_at)
      .filter(Boolean)
      .sort()
      .pop();

    // Group hourly activity into buckets
    const buckets: Record<string, { ts: string; rows: number }> = {};
    for (const log of hourlyRes.data ?? []) {
      const d = new Date(log.created_at);
      d.setMinutes(0, 0, 0);
      const key = d.toISOString();
      if (!buckets[key]) buckets[key] = { ts: key, rows: 0 };
      buckets[key].rows +=
        Number(log.rows_inserted ?? 0) +
        Number(log.rows_updated ?? 0) +
        Number(log.rows_deleted ?? 0);
    }
    const activity = Object.values(buckets).sort((a, b) =>
      a.ts.localeCompare(b.ts)
    );

    return {
      connections: connectionsRes.data ?? [],
      stats: {
        totalTables: tables.length,
        syncedTables: synced,
        errorTables: withErrors,
        totalRows,
        lastSync: lastSync ?? null,
      },
      tableErrors: errorsRes.data ?? [],
      recentLogs: recentLogsRes.data ?? [],
      activity,
    };
  });