import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHash } from "crypto";

/**
 * Executa um SQL BI livre (somente leitura) contra o banco espelho na nuvem.
 *
 * Auth: Bearer destinationId.rawToken  (mesmo token usado em /api/public/mirror/query)
 *
 * Body JSON:
 *   { "sql": "SELECT COUNT(*) FROM mirror.\"FICHAS\" WHERE ..." }
 *
 * Resposta:
 *   { rows: [...], count: N, duration_ms: M }
 *
 * Restrições (forçadas pela função execute_bi_script no banco):
 *   - Transação read-only (qualquer INSERT/UPDATE/DELETE/DDL falha)
 *   - statement_timeout = 120s
 *   - Apenas o resultado da query é retornado, agregado como JSON
 *
 * Use os schemas:
 *   - mirror.<TABELA>     → tabelas espelhadas (FICHAS, fichas_atendimento, etc.)
 *   - public.bi_*         → metadados (não recomendado)
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

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

export const Route = createFileRoute("/api/public/bi/query")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        const auth = await authorize(request);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        let body: { sql?: unknown };
        try {
          body = (await request.json()) as { sql?: unknown };
        } catch {
          return json({ error: "Invalid JSON body" }, 400);
        }

        const sql = typeof body.sql === "string" ? body.sql.trim() : "";
        if (!sql) return json({ error: "Missing 'sql' field in body" }, 400);
        if (sql.length > 100_000)
          return json({ error: "SQL too large (max 100k chars)" }, 413);

        const started = Date.now();
        const { data, error } = await supabaseAdmin.rpc("execute_bi_script", {
          _sql: sql,
        });

        if (error) {
          return json(
            {
              error: error.message,
              hint:
                "A query precisa ser SELECT (read-only). Tabelas espelhadas estão no schema mirror, ex: mirror.\"FICHAS\".",
              duration_ms: Date.now() - started,
            },
            400
          );
        }

        const rows = Array.isArray(data) ? data : [];
        return json({
          rows,
          count: rows.length,
          duration_ms: Date.now() - started,
        });
      },
    },
  },
});
