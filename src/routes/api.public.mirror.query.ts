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
        const afterPk = url.searchParams.get("after_pk"); // keyset pagination (recomendado para tabelas grandes)
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

        // count separado (rápido, head:true), só quando solicitado
        let total: number | null = null;
        if (includeTotal) {
          let cq = supabaseAdmin
            .from("synced_rows")
            .select("pk", { count: "exact", head: true })
            .eq("sync_table_id", syncTable.id);
          if (updatedSince) cq = cq.gt("updated_at", updatedSince);
          const { count: c, error: ce } = await cq;
          if (ce) return json({ error: `count failed: ${ce.message}` }, 500);
          total = c ?? null;
        }

        let q = supabaseAdmin
          .from("synced_rows")
          .select("data, pk, updated_at")
          .eq("sync_table_id", syncTable.id)
          .order(orderBy, { ascending: orderBy === "pk" });

        if (updatedSince) q = q.gt("updated_at", updatedSince);

        // keyset (preferido para varreduras completas e tabelas > 5k)
        if (afterPk && orderBy === "pk") {
          q = q.gt("pk", afterPk).limit(limit);
        } else {
          q = q.range(offset, offset + limit - 1);
        }

        const { data, error } = await q;
        if (error) return json({ error: error.message }, 500);

        const rows = data ?? [];
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
