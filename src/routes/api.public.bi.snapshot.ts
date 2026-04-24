import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHash, timingSafeEqual } from "crypto";

/**
 * BI snapshot read endpoint (pull model).
 *
 * Permite que o BI Hospital CMO (ou qualquer cliente autorizado) leia o último
 * snapshot enviado pelo agente, sem precisar de webhook server-side.
 *
 * Auth: Bearer destinationId.rawToken
 *  - O BI usa um token próprio gerado no painel /dashboard/bi
 *  - IP allowlist é verificado se configurado no destino
 *
 * Resposta:
 *  {
 *    destination: { id, name, last_pushed_at },
 *    payload_hash: string,
 *    generated_at: string,
 *    payload: <objeto completo do snapshot>
 *  }
 *
 * Header opcional: If-None-Match: <payload_hash> → retorna 304 se igual.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-None-Match",
};

function sha256Hex(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

function getClientIp(request: Request): string | null {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    null
  );
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders, ...extraHeaders },
  });
}

export const Route = createFileRoute("/api/public/bi/snapshot")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      GET: async ({ request }) => {
        const reqIp = getClientIp(request);
        const ua = request.headers.get("user-agent") ?? "";
        const url = new URL(request.url);
        console.log(
          `[bi-snapshot] GET hit url=${url.pathname}${url.search} ip=${reqIp} ua=${ua.slice(0, 80)}`
        );
        try {
          const auth = request.headers.get("authorization") ?? "";
          const bearer = auth.replace(/^Bearer\s+/i, "");
          if (!bearer) {
            console.log("[bi-snapshot] reject: missing token");
            return json({ error: "Missing token" }, 401);
          }

          const [destinationId, rawToken] = bearer.split(".");
          if (!destinationId || !rawToken) {
            console.log("[bi-snapshot] reject: invalid token format");
            return json({ error: "Invalid token format" }, 401);
          }
          console.log(`[bi-snapshot] auth attempt destination=${destinationId}`);

          const tokenHash = sha256Hex(rawToken);

          const { data: tokenRow } = await supabaseAdmin
            .from("bi_destination_tokens")
            .select("id, destination_id, revoked_at")
            .eq("destination_id", destinationId)
            .eq("token_hash", tokenHash)
            .maybeSingle();

          if (!tokenRow || tokenRow.revoked_at) {
            return json({ error: "Unauthorized" }, 401);
          }

          // Carrega destino + valida IP
          const { data: dest } = await supabaseAdmin
            .from("bi_destinations")
            .select("id, name, enabled, allowed_ips, last_pushed_at")
            .eq("id", destinationId)
            .maybeSingle();

          if (!dest || !dest.enabled) {
            return json({ error: "Destination disabled" }, 403);
          }

          const ip = getClientIp(request);
          if (
            dest.allowed_ips &&
            dest.allowed_ips.length > 0 &&
            (!ip || !dest.allowed_ips.includes(ip))
          ) {
            return json({ error: "IP not allowed" }, 403);
          }

          // Atualiza last_used_at do token (best-effort)
          await supabaseAdmin
            .from("bi_destination_tokens")
            .update({ last_used_at: new Date().toISOString() })
            .eq("id", tokenRow.id);

          // Carrega snapshot
          const { data: snap } = await supabaseAdmin
            .from("bi_snapshots")
            .select("payload, payload_hash, generated_at")
            .eq("destination_id", destinationId)
            .maybeSingle();

          if (!snap) {
            return json(
              { error: "No snapshot available yet", destination: { id: dest.id, name: dest.name } },
              404
            );
          }

          // Cache validation via ETag
          const ifNoneMatch = request.headers.get("if-none-match");
          if (ifNoneMatch && snap.payload_hash && ifNoneMatch === snap.payload_hash) {
            return new Response(null, {
              status: 304,
              headers: {
                ...corsHeaders,
                ETag: snap.payload_hash,
              },
            });
          }

          return json(
            {
              destination: {
                id: dest.id,
                name: dest.name,
                last_pushed_at: dest.last_pushed_at,
              },
              payload_hash: snap.payload_hash,
              generated_at: snap.generated_at,
              payload: snap.payload,
            },
            200,
            { ETag: snap.payload_hash ?? "" }
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : "unknown";
          console.error("bi snapshot error", e);
          return json({ error: msg }, 500);
        }
      },
    },
  },
});
