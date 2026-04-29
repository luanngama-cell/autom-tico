import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHash } from "crypto";

/**
 * Stream de TODAS as PKs de uma tabela espelhada (sem cap), em NDJSON.
 *
 * Auth: Bearer destinationId.rawToken
 *
 * Query params:
 *  - schema     (default "dbo")
 *  - table      (obrigatório)
 *  - format     "ndjson" (default) | "json" (array único — só recomendado < 200k linhas)
 *  - chunk      tamanho de leitura interna (default 5000, max 10000)
 *
 * Resposta NDJSON: uma linha por PK = {"pk":"..."}\n
 * Permite ao BI reconciliar deleções comparando o conjunto de PKs do espelho
 * com o que ele tem armazenado.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const MAX_CHUNK = 10000;
const DEFAULT_CHUNK = 5000;

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

export const Route = createFileRoute("/api/public/mirror/all-pks")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      GET: async ({ request }) => {
        const auth = await authorize(request);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        const url = new URL(request.url);
        const schema = (url.searchParams.get("schema") ?? "dbo").trim();
        const table = (url.searchParams.get("table") ?? "").trim();
        const format = (url.searchParams.get("format") ?? "ndjson").toLowerCase();
        const chunk = Math.min(
          MAX_CHUNK,
          Math.max(
            500,
            parseInt(url.searchParams.get("chunk") ?? `${DEFAULT_CHUNK}`, 10) || DEFAULT_CHUNK
          )
        );

        if (!table) return json({ error: "Missing 'table' query param" }, 400);

        const { data: syncTable } = await supabaseAdmin
          .from("sync_tables")
          .select("id, enabled, row_count")
          .eq("schema_name", schema)
          .eq("table_name", table)
          .maybeSingle();

        if (!syncTable)
          return json({ error: `Table ${schema}.${table} not found in mirror` }, 404);
        if (!syncTable.enabled)
          return json({ error: `Table ${schema}.${table} is disabled` }, 403);

        const tableId = syncTable.id;
        const isJsonArray = format === "json";

        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            let lastPk: string | null = null;
            let total = 0;
            let first = true;

            if (isJsonArray) controller.enqueue(encoder.encode("["));

            try {
              while (true) {
                let q = supabaseAdmin
                  .from("synced_rows")
                  .select("pk")
                  .eq("sync_table_id", tableId)
                  .order("pk", { ascending: true })
                  .limit(chunk);
                if (lastPk !== null) q = q.gt("pk", lastPk);

                const { data, error } = await q;
                if (error) {
                  controller.enqueue(
                    encoder.encode(
                      (isJsonArray ? "" : "") +
                        JSON.stringify({ __error: error.message }) +
                        "\n"
                    )
                  );
                  break;
                }
                if (!data || data.length === 0) break;

                for (const row of data) {
                  const pk = row.pk as string;
                  if (isJsonArray) {
                    controller.enqueue(
                      encoder.encode((first ? "" : ",") + JSON.stringify(pk))
                    );
                  } else {
                    controller.enqueue(encoder.encode(JSON.stringify({ pk }) + "\n"));
                  }
                  first = false;
                  lastPk = pk;
                  total++;
                }

                if (data.length < chunk) break;
              }

              if (isJsonArray) {
                controller.enqueue(encoder.encode("]"));
              } else {
                // marcador final em NDJSON
                controller.enqueue(
                  encoder.encode(JSON.stringify({ __done: true, total }) + "\n")
                );
              }
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              controller.enqueue(
                encoder.encode(JSON.stringify({ __error: msg }) + "\n")
              );
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": isJsonArray
              ? "application/json; charset=utf-8"
              : "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Mirror-Table": `${schema}.${table}`,
            "X-Mirror-Row-Count-Hint": String(syncTable.row_count ?? 0),
            ...corsHeaders,
          },
        });
      },
    },
  },
});
