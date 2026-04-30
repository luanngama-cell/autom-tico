import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHash, timingSafeEqual } from "crypto";

/**
 * Consulta dados de uma tabela espelhada.
 *
 * Auth: Bearer destinationId.rawToken
 *
 * Query params:
 *  - schema     (default "dbo")
 *  - table      (obrigatório)
 *  - limit      (default 1000, max 10000)
 *  - offset     (default 0)
 *  - updated_since (ISO date opcional — retorna só linhas alteradas após essa data)
 *
 * Resposta:
 *  { table: {schema, name}, count, total, rows: [...] }
 *  rows = array de objetos JSON (data + pk).
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const MAX_LIMIT = 10000;
const DEFAULT_LIMIT = 1000;

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

function escapeSqlLiteral(value: string) {
  return value.replace(/'/g, "''");
}

function toJsonbSql(value: unknown) {
  return `'${escapeSqlLiteral(JSON.stringify(value))}'::jsonb`;
}

function parseScalarParam(value: string) {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d*\.\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  return trimmed;
}

function getSearchParamCaseInsensitive(url: URL, name: string) {
  return (
    url.searchParams.get(name) ??
    [...url.searchParams.entries()].find(([param]) => param.toLowerCase() === name.toLowerCase())?.[1] ??
    null
  );
}

function normalizeAfterPkObject(input: Record<string, unknown>, primaryKeys: string[]) {
  const inputEntries = Object.entries(input);
  const normalized = Object.fromEntries(
    primaryKeys
      .map((key) => {
        const entry = inputEntries.find(([inputKey]) => inputKey.toLowerCase() === key.toLowerCase());
        return entry ? ([key, entry[1]] as const) : null;
      })
      .filter((entry): entry is readonly [string, unknown] => entry !== null)
  );

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function hasAfterPkParam(url: URL) {
  return [...url.searchParams.keys()].some((param) => {
    const lower = param.toLowerCase();
    return lower === "after_pk" || lower.startsWith("after_pk[") || lower.startsWith("after_");
  });
}

function parseAfterPk(url: URL, primaryKeys: string[]) {
  const fromJson = getSearchParamCaseInsensitive(url, "after_pk");
  if (fromJson) {
    const trimmed = fromJson.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const normalized = normalizeAfterPkObject(parsed as Record<string, unknown>, primaryKeys);
          if (normalized) return normalized;
        }
      } catch {
        // fallback below
      }
    } else if (primaryKeys.length === 1) {
      return { [primaryKeys[0]]: parseScalarParam(trimmed) };
    }
  }

  const bracketMatches = [...url.searchParams.entries()].reduce<Record<string, unknown>>((acc, [param, value]) => {
    const match = /^after_pk\[(.+)\]$/i.exec(param);
    if (match) {
      acc[match[1]] = parseScalarParam(value);
    }
    return acc;
  }, {});
  const normalizedBracketed = normalizeAfterPkObject(bracketMatches, primaryKeys);
  if (normalizedBracketed) return normalizedBracketed;

  const prefixedMatches = [...url.searchParams.entries()].reduce<Record<string, unknown>>((acc, [param, value]) => {
    const match = /^after_(.+)$/i.exec(param);
    if (match && match[1].toLowerCase() !== "pk") {
      acc[match[1]] = parseScalarParam(value);
    }
    return acc;
  }, {});
  return normalizeAfterPkObject(prefixedMatches, primaryKeys);
}

function buildPkOrderExpressions(primaryKeys: string[]) {
  return primaryKeys.map((key) => `(pk->'${key.replace(/'/g, "''")}') ASC`).join(", ");
}

function buildPkAfterWhere(primaryKeys: string[], afterPk: Record<string, unknown>) {
  const clauses = primaryKeys.map((key, index) => {
    const equals = primaryKeys
      .slice(0, index)
      .map((prevKey) => `(pk->'${prevKey.replace(/'/g, "''")}') = ${toJsonbSql(afterPk[prevKey])}`)
      .join(" AND ");
    const current = `(pk->'${key.replace(/'/g, "''")}') > ${toJsonbSql(afterPk[key])}`;
    return equals ? `(${equals} AND ${current})` : `(${current})`;
  });

  return clauses.length > 0 ? `(${clauses.join(" OR ")})` : null;
}

async function runPkQuery(params: {
  syncTableId: string;
  primaryKeys: string[];
  limit: number;
  offset: number;
  updatedSince: string | null;
  afterPk: Record<string, unknown> | null;
}) {
  const where = [`sync_table_id = '${escapeSqlLiteral(params.syncTableId)}'`];
  if (params.updatedSince) {
    where.push(`updated_at > '${escapeSqlLiteral(params.updatedSince)}'::timestamptz`);
  }
  if (params.afterPk) {
    const keysetWhere = buildPkAfterWhere(params.primaryKeys, params.afterPk);
    if (keysetWhere) where.push(keysetWhere);
  }

  const sql = [
    "SELECT data, pk, updated_at",
    "FROM public.synced_rows",
    `WHERE ${where.join(" AND ")}`,
    `ORDER BY ${buildPkOrderExpressions(params.primaryKeys)}`,
    `LIMIT ${params.limit}`,
    params.afterPk ? null : `OFFSET ${params.offset}`,
  ]
    .filter(Boolean)
    .join("\n");

  const { data, error } = await supabaseAdmin.rpc("execute_bi_script", { _sql: sql });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
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

  return { ok: true as const };
}

export const Route = createFileRoute("/api/public/mirror/query")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      GET: async ({ request }) => {
        const auth = await authorize(request);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        const url = new URL(request.url);
        const schema = (url.searchParams.get("schema") ?? "dbo").trim();
        const table = (url.searchParams.get("table") ?? "").trim();
        const limit = Math.min(
          MAX_LIMIT,
          Math.max(1, parseInt(url.searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT)
        );
        const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
        const updatedSince = url.searchParams.get("updated_since");
        const orderBy = (url.searchParams.get("order") ?? "pk").toLowerCase() === "updated_at" ? "updated_at" : "pk";
        const includeTotal = url.searchParams.get("include_total") !== "false"; // default true

        if (!table) return json({ error: "Missing 'table' query param" }, 400);

        // Resolve sync_table_id
        const { data: syncTable } = await supabaseAdmin
          .from("sync_tables")
          .select("id, primary_keys, row_count, last_synced_at, enabled")
          .eq("schema_name", schema)
          .eq("table_name", table)
          .maybeSingle();

        if (!syncTable)
          return json({ error: `Table ${schema}.${table} not found in mirror` }, 404);
        if (!syncTable.enabled)
          return json({ error: `Table ${schema}.${table} is disabled` }, 403);

        const afterPk = parseAfterPk(url, syncTable.primary_keys ?? []);
        if (hasAfterPkParam(url) && !afterPk)
          return json(
            {
              error:
                "Invalid 'after_pk' cursor. Use after_pk={\"PK\":123}, after_pk[PK]=123, or after_PK=123.",
            },
            400
          );

        // total real da origem quando não há filtro incremental;
        // para consultas incrementais, conta apenas as linhas alteradas.
        let total: number | null = null;
        if (includeTotal) {
          if (updatedSince) {
            let cq = supabaseAdmin
              .from("synced_rows")
              .select("pk", { count: "exact", head: true })
              .eq("sync_table_id", syncTable.id)
              .gt("updated_at", updatedSince);
            const { count: c, error: ce } = await cq;
            if (ce) return json({ error: `count failed: ${ce.message}` }, 500);
            total = c ?? null;
          } else {
            total = Number(syncTable.row_count ?? 0);
          }
        }

        let rows: Array<{ data: Record<string, unknown>; pk: Record<string, unknown>; updated_at: string }> = [];

        if (orderBy === "pk" && Array.isArray(syncTable.primary_keys) && syncTable.primary_keys.length > 0) {
          try {
            rows = (await runPkQuery({
              syncTableId: syncTable.id,
              primaryKeys: syncTable.primary_keys,
              limit,
              offset,
              updatedSince,
              afterPk,
            })) as Array<{ data: Record<string, unknown>; pk: Record<string, unknown>; updated_at: string }>;
          } catch (error) {
            const message = error instanceof Error ? error.message : "query failed";
            return json({ error: message }, 500);
          }
        } else {
          let q = supabaseAdmin
            .from("synced_rows")
            .select("data, pk, updated_at")
            .eq("sync_table_id", syncTable.id)
            .order(orderBy, { ascending: orderBy === "pk" });

          if (updatedSince) q = q.gt("updated_at", updatedSince);
          q = q.range(offset, offset + limit - 1);

          const { data, error } = await q;
          if (error) return json({ error: error.message }, 500);
          rows = (data ?? []) as Array<{ data: Record<string, unknown>; pk: Record<string, unknown>; updated_at: string }>;
        }

        const nextAfterPk =
          orderBy === "pk" && rows.length === limit ? rows[rows.length - 1].pk : null;

        return json({
          table: { schema, name: table, full_name: `${schema}.${table}` },
          primary_keys: syncTable.primary_keys,
          row_count_total: syncTable.row_count,
          last_synced_at: syncTable.last_synced_at,
          count: rows.length,
          total,
          limit,
          offset,
          order: orderBy,
          next_after_pk: nextAfterPk,
          rows: rows.map((r) => ({
            ...((r.data as Record<string, unknown>) ?? {}),
            __pk: r.pk,
            __updated_at: r.updated_at,
          })),
        });
      },
    },
  },
});
