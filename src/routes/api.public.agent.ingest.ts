import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHash, timingSafeEqual } from "crypto";
import { z } from "zod";

/**
 * Agent ingest endpoint.
 * Auth: Bearer token = `${connectionId}.${rawToken}`
 *   - rawToken is hashed (sha256) and compared against agent_tokens.token_hash
 *   - additionally requires X-Agent-Secret header matching AGENT_INGEST_SECRET
 *
 * Body shape:
 * {
 *   connection: { status?: "online" },
 *   tables: [
 *     {
 *       schema_name: string, table_name: string,
 *       primary_keys: string[], has_rowversion: boolean,
 *       strategy: "full_scan" | "rowversion",
 *       row_count: number,
 *       last_checksum?: string,        // hex of max(rowversion) for incremental tables
 *       schema_hash?: string,
 *       upserts: Array<{ pk: Record<string,unknown>, data: Record<string,unknown>, row_hash: string }>,
 *       deletes?: Array<{ pk: Record<string,unknown> }>,
 *       full_replace?: boolean,        // if true, delete pks not in upserts
 *     }
 *   ]
 * }
 */

const TableSchema = z.object({
  schema_name: z.string().min(1).max(128),
  table_name: z.string().min(1).max(128),
  primary_keys: z.array(z.string().min(1).max(128)).max(16),
  has_rowversion: z.boolean(),
  strategy: z.enum(["full_scan", "rowversion"]),
  row_count: z.number().int().min(0),
  last_checksum: z.string().max(64).nullable().optional(),
  schema_hash: z.string().max(128).nullable().optional(),
  upserts: z
    .array(
      z.object({
        pk: z.record(z.string(), z.unknown()),
        data: z.record(z.string(), z.unknown()),
        row_hash: z.string().min(1).max(128),
      })
    )
    .max(5000),
  deletes: z
    .array(z.object({ pk: z.record(z.string(), z.unknown()) }))
    .max(5000)
    .optional(),
  full_replace: z.boolean().optional(),
  // Reconciliation: agent sends the FULL list of PKs that currently exist in source.
  // Server deletes any synced_rows whose pk_hash is not in this set.
  // Lightweight (PKs only, no row data) so it scales for incremental tables too.
  all_pks: z
    .array(z.record(z.string(), z.unknown()))
    .max(2_000_000)
    .optional(),
});

const IngestSchema = z.object({
  connection: z.object({ status: z.string().max(32).optional() }).optional(),
  tables: z.array(TableSchema).max(200),
});

function sha256Hex(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

function pkHash(connId: string, schema: string, table: string, pk: Record<string, unknown>) {
  // stable stringify (sorted keys)
  const keys = Object.keys(pk).sort();
  const norm = keys.map((k) => `${k}=${JSON.stringify(pk[k])}`).join("|");
  return sha256Hex(`${connId}::${schema}.${table}::${norm}`);
}

export const Route = createFileRoute("/api/public/agent/ingest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          // 1. Auth headers
          const auth = request.headers.get("authorization") ?? "";
          const agentSecret = request.headers.get("x-agent-secret") ?? "";
          const expectedSecret = process.env.AGENT_INGEST_SECRET;

          if (!expectedSecret) {
            return json({ error: "Server misconfigured" }, 500);
          }
          const a = Buffer.from(agentSecret);
          const b = Buffer.from(expectedSecret);
          if (a.length !== b.length || !timingSafeEqual(a, b)) {
            return json({ error: "Invalid agent secret" }, 401);
          }

          const bearer = auth.replace(/^Bearer\s+/i, "");
          const [connectionId, rawToken] = bearer.split(".");
          if (!connectionId || !rawToken) {
            return json({ error: "Invalid token format" }, 401);
          }

          const tokenHash = sha256Hex(rawToken);

          const { data: tokenRow, error: tErr } = await supabaseAdmin
            .from("agent_tokens")
            .select("id, connection_id, revoked_at")
            .eq("connection_id", connectionId)
            .eq("token_hash", tokenHash)
            .maybeSingle();

          if (tErr || !tokenRow || tokenRow.revoked_at) {
            return json({ error: "Unauthorized" }, 401);
          }

          // 2. Validate body
          const raw = await request.json();
          const parsed = IngestSchema.safeParse(raw);
          if (!parsed.success) {
            return json({ error: "Invalid payload", details: parsed.error.issues }, 400);
          }
          const body = parsed.data;

          const startedAt = Date.now();
          const summary: Array<Record<string, unknown>> = [];

          // 3. Update connection heartbeat
          await supabaseAdmin
            .from("sql_connections")
            .update({
              status: body.connection?.status ?? "online",
              last_seen_at: new Date().toISOString(),
            })
            .eq("id", connectionId);

          await supabaseAdmin
            .from("agent_tokens")
            .update({ last_used_at: new Date().toISOString() })
            .eq("id", tokenRow.id);

          // 4. Process each table
          for (const t of body.tables) {
            const tableStart = Date.now();
            // upsert sync_tables row
            const { data: existing } = await supabaseAdmin
              .from("sync_tables")
              .select("id")
              .eq("connection_id", connectionId)
              .eq("schema_name", t.schema_name)
              .eq("table_name", t.table_name)
              .maybeSingle();

            let syncTableId = existing?.id;
            if (!syncTableId) {
              const { data: created, error: cErr } = await supabaseAdmin
                .from("sync_tables")
                .insert({
                  connection_id: connectionId,
                  schema_name: t.schema_name,
                  table_name: t.table_name,
                  strategy: t.strategy,
                  primary_keys: t.primary_keys,
                  has_rowversion: t.has_rowversion,
                  row_count: t.row_count,
                  last_checksum: t.last_checksum ?? null,
                  schema_hash: t.schema_hash ?? null,
                  last_synced_at: new Date().toISOString(),
                })
                .select("id")
                .single();
              if (cErr || !created) {
                summary.push({ table: `${t.schema_name}.${t.table_name}`, error: cErr?.message });
                continue;
              }
              syncTableId = created.id;
            } else {
              await supabaseAdmin
                .from("sync_tables")
                .update({
                  strategy: t.strategy,
                  primary_keys: t.primary_keys,
                  has_rowversion: t.has_rowversion,
                  row_count: t.row_count,
                  last_checksum: t.last_checksum ?? null,
                  schema_hash: t.schema_hash ?? null,
                  last_synced_at: new Date().toISOString(),
                  last_error: null,
                })
                .eq("id", syncTableId);
            }

            // Upserts
            let inserted = 0;
            let updated = 0;
            if (t.upserts.length > 0) {
              const rows = t.upserts.map((r) => ({
                sync_table_id: syncTableId!,
                pk: r.pk as never,
                pk_hash: pkHash(connectionId, t.schema_name, t.table_name, r.pk),
                data: r.data as never,
                row_hash: r.row_hash,
                updated_at: new Date().toISOString(),
              }));

              // chunk
              const chunkSize = 500;
              for (let i = 0; i < rows.length; i += chunkSize) {
                const chunk = rows.slice(i, i + chunkSize);
                const { error: upErr } = await supabaseAdmin
                  .from("synced_rows")
                  .upsert(chunk, { onConflict: "sync_table_id,pk_hash" });
                if (upErr) {
                  summary.push({
                    table: `${t.schema_name}.${t.table_name}`,
                    error: upErr.message,
                  });
                }
              }
              updated = rows.length;
            }

            // Deletes
            let deleted = 0;
            if (t.deletes && t.deletes.length > 0) {
              const hashes = t.deletes.map((d) =>
                pkHash(connectionId, t.schema_name, t.table_name, d.pk)
              );
              const chunkSize = 500;
              for (let i = 0; i < hashes.length; i += chunkSize) {
                const chunk = hashes.slice(i, i + chunkSize);
                await supabaseAdmin
                  .from("synced_rows")
                  .delete()
                  .eq("sync_table_id", syncTableId!)
                  .in("pk_hash", chunk);
              }
              deleted = hashes.length;
            }

            // Full replace: delete rows not in current upserts set
            if (t.full_replace && t.upserts.length > 0) {
              const keepHashes = t.upserts.map((r) =>
                pkHash(connectionId, t.schema_name, t.table_name, r.pk)
              );
              // Postgres .not('pk_hash','in', ...) — chunk to keep URL small
              // Strategy: fetch all existing pk_hashes, compute diff, delete in batches.
              const { data: existingRows } = await supabaseAdmin
                .from("synced_rows")
                .select("pk_hash")
                .eq("sync_table_id", syncTableId!);
              const keepSet = new Set(keepHashes);
              const toDelete = (existingRows ?? [])
                .map((r) => r.pk_hash)
                .filter((h) => !keepSet.has(h));
              const chunkSize = 500;
              for (let i = 0; i < toDelete.length; i += chunkSize) {
                const chunk = toDelete.slice(i, i + chunkSize);
                if (chunk.length === 0) continue;
                await supabaseAdmin
                  .from("synced_rows")
                  .delete()
                  .eq("sync_table_id", syncTableId!)
                  .in("pk_hash", chunk);
                deleted += chunk.length;
              }
            }

            // Reconciliation via all_pks: cheaper than full_replace because
            // the agent only sends PKs (not row data). Deletes ghost rows.
            if (t.all_pks && t.all_pks.length >= 0 && !t.full_replace) {
              const keepHashes = new Set(
                t.all_pks.map((pk) => pkHash(connectionId, t.schema_name, t.table_name, pk))
              );
              const { data: existingRows } = await supabaseAdmin
                .from("synced_rows")
                .select("pk_hash")
                .eq("sync_table_id", syncTableId!);
              const toDelete = (existingRows ?? [])
                .map((r) => r.pk_hash)
                .filter((h) => !keepHashes.has(h));
              const chunkSize = 500;
              for (let i = 0; i < toDelete.length; i += chunkSize) {
                const chunk = toDelete.slice(i, i + chunkSize);
                if (chunk.length === 0) continue;
                await supabaseAdmin
                  .from("synced_rows")
                  .delete()
                  .eq("sync_table_id", syncTableId!)
                  .in("pk_hash", chunk);
                deleted += chunk.length;
              }
            }

            await supabaseAdmin.from("sync_logs").insert({
              connection_id: connectionId,
              sync_table_id: syncTableId!,
              level: "info",
              event: "table_synced",
              message: `${t.schema_name}.${t.table_name}`,
              rows_inserted: inserted,
              rows_updated: updated,
              rows_deleted: deleted,
              duration_ms: Date.now() - tableStart,
            });

            summary.push({
              table: `${t.schema_name}.${t.table_name}`,
              upserts: updated,
              deletes: deleted,
            });
          }

          await supabaseAdmin.from("sync_logs").insert({
            connection_id: connectionId,
            level: "info",
            event: "cycle_complete",
            message: `${body.tables.length} tables`,
            rows_inserted: 0,
            rows_updated: 0,
            rows_deleted: 0,
            duration_ms: Date.now() - startedAt,
          });

          return json({ ok: true, tables: summary });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "unknown";
          console.error("agent ingest error", e);
          return json({ error: msg }, 500);
        }
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
