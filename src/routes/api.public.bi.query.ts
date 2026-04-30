import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHash } from "crypto";

/**
 * Executa um SQL BI livre (somente leitura) contra o banco espelho na nuvem.
 *
 * Auth: Bearer destinationId.rawToken
 *
 * Body JSON:
 *   {
 *     "sql": "SELECT ... FROM mirror.\"FICHAS\" ...",
 *     "cache_seconds": 30,        // opcional, default 30, use 0 pra desligar
 *     "no_metrics": false         // opcional, default false
 *   }
 *
 * Resposta:
 *   { rows: [...], count: N, duration_ms: M, cache_hit: bool, cached_at?: ISO }
 *
 * Restrições (forçadas pela função execute_bi_script no banco):
 *   - Transação read-only
 *   - statement_timeout = 120s
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const MAX_SQL_LENGTH = 100_000;
const DEFAULT_CACHE_SECONDS = 30;
const MAX_CACHE_SECONDS = 300;
const MAX_CACHE_ENTRIES = 500;

type CacheEntry = {
  rows: unknown[];
  cachedAt: number;
  ttlMs: number;
};

const queryCache = new Map<string, CacheEntry>();

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

function pruneCache() {
  if (queryCache.size <= MAX_CACHE_ENTRIES) return;
  // Remove a entrada mais antiga
  const oldest = [...queryCache.entries()].sort(
    (a, b) => a[1].cachedAt - b[1].cachedAt
  )[0];
  if (oldest) queryCache.delete(oldest[0]);
}

function getCached(hash: string): CacheEntry | null {
  const entry = queryCache.get(hash);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > entry.ttlMs) {
    queryCache.delete(hash);
    return null;
  }
  return entry;
}

function setCached(hash: string, rows: unknown[], ttlMs: number) {
  if (ttlMs <= 0) return;
  queryCache.set(hash, { rows, cachedAt: Date.now(), ttlMs });
  pruneCache();
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

  // Não bloqueia: atualiza last_used_at sem await
  void supabaseAdmin
    .from("bi_destination_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", tokenRow.id);

  return { ok: true as const, destinationId };
}

async function logMetric(args: {
  destinationId: string | null;
  sqlHash: string;
  sqlPreview: string;
  durationMs: number;
  rowCount: number;
  cacheHit: boolean;
  error: string | null;
}) {
  try {
    await supabaseAdmin.from("bi_query_metrics").insert({
      destination_id: args.destinationId,
      sql_hash: args.sqlHash,
      sql_preview: args.sqlPreview,
      duration_ms: args.durationMs,
      row_count: args.rowCount,
      cache_hit: args.cacheHit,
      error: args.error,
    });
  } catch {
    // métricas nunca devem quebrar a request
  }
}

export const Route = createFileRoute("/api/public/bi/query")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        const auth = await authorize(request);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        let body: { sql?: unknown; cache_seconds?: unknown; no_metrics?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "Invalid JSON body" }, 400);
        }

        const sql = typeof body.sql === "string" ? body.sql.trim() : "";
        if (!sql) return json({ error: "Missing 'sql' field in body" }, 400);
        if (sql.length > MAX_SQL_LENGTH)
          return json({ error: `SQL too large (max ${MAX_SQL_LENGTH} chars)` }, 413);

        const cacheSeconds = Math.min(
          MAX_CACHE_SECONDS,
          Math.max(
            0,
            typeof body.cache_seconds === "number"
              ? body.cache_seconds
              : DEFAULT_CACHE_SECONDS
          )
        );
        const skipMetrics = body.no_metrics === true;

        const sqlHash = sha256Hex(sql);
        const sqlPreview = sql.slice(0, 500);
        const started = Date.now();

        // 1) Cache hit
        if (cacheSeconds > 0) {
          const cached = getCached(sqlHash);
          if (cached) {
            const duration = Date.now() - started;
            if (!skipMetrics) {
              void logMetric({
                destinationId: auth.destinationId ?? null,
                sqlHash,
                sqlPreview,
                durationMs: duration,
                rowCount: cached.rows.length,
                cacheHit: true,
                error: null,
              });
            }
            return json({
              rows: cached.rows,
              count: cached.rows.length,
              duration_ms: duration,
              cache_hit: true,
              cached_at: new Date(cached.cachedAt).toISOString(),
            });
          }
        }

        // 2) Executa
        const { data, error } = await supabaseAdmin.rpc("execute_bi_script", {
          _sql: sql,
        });

        const duration = Date.now() - started;

        if (error) {
          if (!skipMetrics) {
            void logMetric({
              destinationId: auth.destinationId ?? null,
              sqlHash,
              sqlPreview,
              durationMs: duration,
              rowCount: 0,
              cacheHit: false,
              error: error.message,
            });
          }
          return json(
            {
              error: error.message,
              hint:
                'Use SELECT (read-only). Tabelas espelhadas no schema mirror, ex: mirror."FICHAS".',
              duration_ms: duration,
            },
            400
          );
        }

        const rows = Array.isArray(data) ? (data as unknown[]) : [];

        // 3) Cache set
        if (cacheSeconds > 0) {
          setCached(sqlHash, rows, cacheSeconds * 1000);
        }

        if (!skipMetrics) {
          void logMetric({
            destinationId: auth.destinationId ?? null,
            sqlHash,
            sqlPreview,
            durationMs: duration,
            rowCount: rows.length,
            cacheHit: false,
            error: null,
          });
        }

        return json({
          rows,
          count: rows.length,
          duration_ms: duration,
          cache_hit: false,
        });
      },
    },
  },
});
