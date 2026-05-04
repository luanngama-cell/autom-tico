import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHash, timingSafeEqual } from "crypto";
import { z } from "zod";

/**
 * BI push endpoint.
 *
 * Recebe um JSON snapshot completo do agente Windows (resultado do script
 * extrair-pmedico_19.sql) e distribui para todos os destinos `bi_destinations`
 * habilitados.
 *
 * Auth:
 *  - Bearer token = `${destinationId}.${rawToken}` OU header X-Agent-Secret
 *    (modo "broadcast" - quando o agente tem o segredo geral, distribui para
 *    todos os destinos enabled)
 *
 * Estratégia delta:
 *  - Calcula sha256 do payload completo + sha256 por seção (top-level keys)
 *  - Compara com bi_snapshots da última entrega
 *  - Se payload_hash igual → no-op (loga skipped)
 *  - Se mudou → POST para destination.endpoint_url com o JSON completo
 *  - Salva snapshot novo + registra bi_deliveries
 *
 * Body: JSON livre (snapshot completo do BI). Limite ~10MB.
 */

const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

function sha256Hex(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

function computeSectionHashes(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(payload)) {
    try {
      out[key] = sha256Hex(JSON.stringify(payload[key]));
    } catch {
      out[key] = "";
    }
  }
  return out;
}

function diffSections(
  oldHashes: Record<string, string>,
  newHashes: Record<string, string>
): string[] {
  const changed: string[] = [];
  const allKeys = new Set([...Object.keys(oldHashes), ...Object.keys(newHashes)]);
  for (const k of allKeys) {
    if (oldHashes[k] !== newHashes[k]) changed.push(k);
  }
  return changed;
}

function getClientIp(request: Request): string | null {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    null
  );
}

function ipAllowed(ip: string | null, allowed: string[]): boolean {
  if (!allowed || allowed.length === 0) return true; // sem restrição
  if (!ip) return false;
  return allowed.includes(ip);
}

async function parseDeliveryResponse(res: Response): Promise<{
  ok: boolean;
  errorMessage: string | null;
}> {
  const bodyText = res.status === 204 ? "" : await res.text().catch(() => "");
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const trimmed = bodyText.trim().toLowerCase();
  const looksHtml =
    contentType.includes("text/html") ||
    trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html");

  if (!res.ok) {
    return {
      ok: false,
      errorMessage: `HTTP ${res.status}: ${bodyText.slice(0, 500)}`,
    };
  }

  if (looksHtml) {
    return {
      ok: false,
      errorMessage:
        "Destination URL returned HTML instead of an API response. Configure the webhook/API endpoint, not a dashboard page.",
    };
  }

  return { ok: true, errorMessage: null };
}

async function authenticate(
  request: Request
): Promise<
  | { mode: "broadcast" }
  | { mode: "destination"; destinationId: string }
  | { error: string; status: number }
> {
  const auth = request.headers.get("authorization") ?? "";
  const agentSecret = request.headers.get("x-agent-secret") ?? "";
  const expectedSecret = process.env.AGENTE_INGEST_SECRETO;

  // Modo broadcast: agente confiável envia para todos os destinos enabled
  if (agentSecret && expectedSecret) {
    const a = Buffer.from(agentSecret);
    const b = Buffer.from(expectedSecret);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { mode: "broadcast" };
    }
  }

  // Modo destino-específico: token de um bi_destination
  const bearer = auth.replace(/^Bearer\s+/i, "");
  if (!bearer) return { error: "Missing credentials", status: 401 };

  const [destinationId, rawToken] = bearer.split(".");
  if (!destinationId || !rawToken) {
    return { error: "Invalid token format", status: 401 };
  }

  const tokenHash = sha256Hex(rawToken);
  const { data: tokenRow } = await supabaseAdmin
    .from("bi_destination_tokens")
    .select("id, destination_id, revoked_at")
    .eq("destination_id", destinationId)
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (!tokenRow || tokenRow.revoked_at) {
    return { error: "Unauthorized", status: 401 };
  }

  await supabaseAdmin
    .from("bi_destination_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", tokenRow.id);

  return { mode: "destination", destinationId };
}

async function deliverToDestination(args: {
  destination: {
    id: string;
    name: string;
    endpoint_url: string;
    enabled: boolean;
    allowed_ips: string[];
    last_status?: string | null;
  };
  payload: Record<string, unknown>;
  payloadStr: string;
  payloadHash: string;
  sectionHashes: Record<string, string>;
  triggeredBy: string;
  requestIp: string | null;
}) {
  const { destination, payload, payloadStr, payloadHash, sectionHashes, triggeredBy, requestIp } =
    args;

  if (!destination.enabled) {
    return { destinationId: destination.id, status: "skipped", reason: "disabled" };
  }

  // Carrega snapshot anterior
  const { data: prev } = await supabaseAdmin
    .from("bi_snapshots")
    .select("payload_hash, section_hashes")
    .eq("destination_id", destination.id)
    .maybeSingle();

  const prevHashes = (prev?.section_hashes as Record<string, string> | null) ?? {};
  const changedSections = prev?.payload_hash
    ? diffSections(prevHashes, sectionHashes)
    : Object.keys(sectionHashes);

  if (prev?.payload_hash === payloadHash && destination.last_status !== "failed") {
    await supabaseAdmin.from("bi_deliveries").insert({
      destination_id: destination.id,
      status: "skipped",
      payload_kind: "snapshot",
      triggered_by: triggeredBy,
      request_ip: requestIp,
      payload_bytes: payloadStr.length,
      changed_sections: [],
      rows_affected: 0,
      duration_ms: 0,
    });
    return {
      destinationId: destination.id,
      status: "skipped",
      reason: "no_changes",
    };
  }

  // Envia para o endpoint do BI
  const start = Date.now();
  let httpStatus: number | null = null;
  let errorMessage: string | null = null;
  let deliveryStatus: "success" | "failed" = "failed";
  const attemptedAt = new Date().toISOString();

  await supabaseAdmin.from("bi_snapshots").upsert(
    {
      destination_id: destination.id,
      payload: payload as never,
      payload_hash: payloadHash,
      section_hashes: sectionHashes as never,
      generated_at: attemptedAt,
      updated_at: attemptedAt,
    },
    { onConflict: "destination_id" }
  );

  await supabaseAdmin
    .from("bi_destinations")
    .update({ last_pushed_at: attemptedAt })
    .eq("id", destination.id);

  try {
    const res = await fetch(destination.endpoint_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BI-Source": "lovable-cmo-sync",
        "X-Payload-Hash": payloadHash,
      },
      body: payloadStr,
      signal: AbortSignal.timeout(60_000),
    });
    httpStatus = res.status;
    const delivery = await parseDeliveryResponse(res);
    if (delivery.ok) {
      deliveryStatus = "success";
    } else {
      errorMessage = delivery.errorMessage;
    }
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : "fetch failed";
  }

  const duration = Date.now() - start;

  if (deliveryStatus === "success") {
    await supabaseAdmin
      .from("bi_destinations")
      .update({
        last_status: "success",
        last_error: null,
      })
      .eq("id", destination.id);
  } else {
    await supabaseAdmin
      .from("bi_destinations")
      .update({
        last_status: "failed",
        last_error: errorMessage,
      })
      .eq("id", destination.id);
  }

  await supabaseAdmin.from("bi_deliveries").insert({
    destination_id: destination.id,
    status: deliveryStatus,
    payload_kind: "snapshot",
    triggered_by: triggeredBy,
    request_ip: requestIp,
    http_status: httpStatus,
    payload_bytes: payloadStr.length,
    changed_sections: changedSections,
    rows_affected: 0,
    duration_ms: duration,
    error_message: errorMessage,
  });

  return {
    destinationId: destination.id,
    name: destination.name,
    status: deliveryStatus,
    http_status: httpStatus,
    changed_sections: changedSections.length,
    duration_ms: duration,
    error: errorMessage,
  };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Agent-Secret, X-Triggered-By",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export const Route = createFileRoute("/api/public/bi/push")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        try {
          const auth = await authenticate(request);
          if ("error" in auth) return json({ error: auth.error }, auth.status);

          const requestIp = getClientIp(request);
          const triggeredBy = (request.headers.get("x-triggered-by") ?? "agent").slice(0, 64);

          // Lê body com limite
          const raw = await request.text();
          if (raw.length > MAX_PAYLOAD_BYTES) {
            return json({ error: "Payload too large" }, 413);
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            return json({ error: "Invalid JSON" }, 400);
          }

          const payloadShape = z.record(z.string(), z.unknown()).safeParse(parsed);
          if (!payloadShape.success) {
            return json({ error: "Payload must be a JSON object" }, 400);
          }
          const payload = payloadShape.data;

          // Hashes
          const payloadStr = JSON.stringify(payload);
          const payloadHash = sha256Hex(payloadStr);
          const sectionHashes = computeSectionHashes(payload);

          // Carrega destinos elegíveis
          let destQuery = supabaseAdmin
            .from("bi_destinations")
            .select("id, name, endpoint_url, enabled, allowed_ips");

          if (auth.mode === "destination") {
            destQuery = destQuery.eq("id", auth.destinationId);
          } else {
            destQuery = destQuery.eq("enabled", true);
          }

          const { data: destinations, error: dErr } = await destQuery;
          if (dErr) return json({ error: dErr.message }, 500);
          if (!destinations || destinations.length === 0) {
            return json({ ok: true, accepted: 0, message: "No destinations" });
          }

          // CRÍTICO: persiste o snapshot SÍNCRONAMENTE antes do 202.
          // Assim o BI consegue puxar via /api/public/bi/snapshot mesmo que
          // o webhook de push externo falhe ou o background não execute.
          const persistedAt = new Date().toISOString();
          for (const dest of destinations) {
            try {
              await supabaseAdmin.from("bi_snapshots").upsert(
                {
                  destination_id: dest.id,
                  payload: payload as never,
                  payload_hash: payloadHash,
                  section_hashes: sectionHashes as never,
                  generated_at: persistedAt,
                  updated_at: persistedAt,
                },
                { onConflict: "destination_id" }
              );

              await supabaseAdmin
                .from("bi_destinations")
                .update({ last_pushed_at: persistedAt })
                .eq("id", dest.id);
            } catch (err) {
              console.error("bi snapshot persist error", dest.id, err);
            }
          }

          // Processa entregas em background (evita timeout do Cloudflare em payloads grandes).
          // Responde 202 Accepted imediatamente; cliente acompanha pelo bi_deliveries.
          const processInBackground = async () => {
            for (const dest of destinations) {
              try {
                if (!ipAllowed(requestIp, dest.allowed_ips ?? [])) {
                  await supabaseAdmin.from("bi_deliveries").insert({
                    destination_id: dest.id,
                    status: "rejected",
                    payload_kind: "snapshot",
                    triggered_by: triggeredBy,
                    request_ip: requestIp,
                    payload_bytes: payloadStr.length,
                    changed_sections: [],
                    rows_affected: 0,
                    error_message: `IP ${requestIp ?? "unknown"} not in allowlist`,
                  });
                  continue;
                }

                await deliverToDestination({
                  destination: dest,
                  payload,
                  payloadStr,
                  payloadHash,
                  sectionHashes,
                  triggeredBy,
                  requestIp,
                });
              } catch (err) {
                console.error("bi push background delivery error", dest.id, err);
                await supabaseAdmin.from("bi_deliveries").insert({
                  destination_id: dest.id,
                  status: "failed",
                  payload_kind: "snapshot",
                  triggered_by: triggeredBy,
                  request_ip: requestIp,
                  payload_bytes: payloadStr.length,
                  changed_sections: [],
                  rows_affected: 0,
                  error_message: err instanceof Error ? err.message : "background error",
                });
              }
            }
          };

          // Cloudflare Workers: waitUntil mantém o worker vivo após o response.
          const ctx = (request as unknown as { cf?: { waitUntil?: (p: Promise<unknown>) => void } }).cf;
          const globalCtx = (globalThis as unknown as {
            __cf_ctx?: { waitUntil?: (p: Promise<unknown>) => void };
          }).__cf_ctx;
          const waitUntil = ctx?.waitUntil ?? globalCtx?.waitUntil;
          const backgroundScheduled = Boolean(waitUntil);

          if (waitUntil) {
            waitUntil(processInBackground());
          } else {
            console.warn("bi push background scheduling unavailable; snapshot persisted for pull consumption only");

            for (const dest of destinations) {
              await supabaseAdmin.from("bi_deliveries").insert({
                destination_id: dest.id,
                status: "accepted",
                payload_kind: "snapshot",
                triggered_by: triggeredBy,
                request_ip: requestIp,
                payload_bytes: payloadStr.length,
                changed_sections: Object.keys(sectionHashes),
                rows_affected: 0,
                duration_ms: 0,
                error_message:
                  "Snapshot persisted and ready for pull, but background processing is unavailable in this runtime.",
              });
            }

            void processInBackground().catch((err) => {
              console.error("bi push best-effort background delivery error", err);
            });
          }

          return json(
            {
              ok: true,
              accepted: destinations.length,
              payload_hash: payloadHash,
              payload_bytes: payloadStr.length,
              background_scheduled: backgroundScheduled,
              message: backgroundScheduled
                ? "Push aceito; processamento em background. Acompanhe em bi_deliveries."
                : "Push aceito; snapshot persistido e pronto para pull. O processamento em background não ficou disponível neste runtime.",
            },
            202
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : "unknown";
          console.error("bi push error", e);
          return json({ error: msg }, 500);
        }
      },
    },
  },
});
