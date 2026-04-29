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

    const [connectionsRes, tablesRes, errorsRes, recentLogsRes, hourlyRes, biDestRes, biSnapRes, biDelivRes] =
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
        supabase
          .from("bi_destinations")
          .select("id, name, enabled, last_status, last_error, last_pushed_at"),
        supabase
          .from("bi_snapshots")
          .select("destination_id, updated_at, payload_hash"),
        supabase
          .from("bi_deliveries")
          .select("destination_id, status, http_status, error_message, created_at")
          .order("created_at", { ascending: false })
          .limit(50),
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

    // Recompute connection effective status based on real freshness
    const STALE_CONNECTION_MS = 5 * 60 * 1000; // 5 min sem heartbeat = degraded
    const now = Date.now();
    const connections = (connectionsRes.data ?? []).map((c) => {
      const lastSeen = c.last_seen_at ? new Date(c.last_seen_at).getTime() : 0;
      const ageMs = lastSeen ? now - lastSeen : null;
      let effective_status: "online" | "stale" | "offline" = "offline";
      if (ageMs !== null && ageMs < STALE_CONNECTION_MS) effective_status = "online";
      else if (ageMs !== null && ageMs < STALE_CONNECTION_MS * 6) effective_status = "stale";
      return { ...c, effective_status, age_ms: ageMs };
    });

    // BI health: snapshot mais antigo + falhas recentes
    const STALE_SNAPSHOT_MS = 30 * 60 * 1000; // 30 min
    const snaps = biSnapRes.data ?? [];
    const dests = biDestRes.data ?? [];
    const deliveries = biDelivRes.data ?? [];

    const biDestinations = dests.map((d) => {
      const snap = snaps.find((s) => s.destination_id === d.id);
      const ageMs = snap ? now - new Date(snap.updated_at).getTime() : null;
      const recentDeliv = deliveries.filter((dl) => dl.destination_id === d.id).slice(0, 5);
      const lastDeliv = recentDeliv[0] ?? null;
      const recentFailures = recentDeliv.filter((dl) => dl.status === "failed").length;
      let health: "healthy" | "stale" | "failing" | "no_data" = "no_data";
      if (snap) {
        if (ageMs !== null && ageMs > STALE_SNAPSHOT_MS) health = "stale";
        else health = "healthy";
        if (recentFailures >= 3) health = "failing";
      }
      return {
        id: d.id,
        name: d.name,
        enabled: d.enabled,
        last_status: d.last_status,
        last_error: d.last_error,
        snapshot_age_ms: ageMs,
        last_snapshot_at: snap?.updated_at ?? null,
        last_delivery: lastDeliv,
        recent_failures: recentFailures,
        health,
      };
    });

    const biHealthy = biDestinations.filter((d) => d.health === "healthy").length;
    const biDegraded = biDestinations.filter((d) => d.health === "stale" || d.health === "failing").length;

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
      connections,
      stats: {
        totalTables: tables.length,
        syncedTables: synced,
        errorTables: withErrors,
        totalRows,
        lastSync: lastSync ?? null,
      },
      biDestinations,
      biStats: {
        total: biDestinations.length,
        healthy: biHealthy,
        degraded: biDegraded,
      },
      tableErrors: errorsRes.data ?? [],
      recentLogs: recentLogsRes.data ?? [],
      activity,
    };
  });