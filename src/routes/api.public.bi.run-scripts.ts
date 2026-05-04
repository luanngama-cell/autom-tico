import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHash, timingSafeEqual } from "crypto";

/**
 * BI script runner (cron-triggered).
 *
 * Para cada `bi_script` habilitado:
 *   1. Executa o SQL via RPC `execute_bi_script` (read-only forçado).
 *   2. Monta envelope { generated_at, source: script.name, sections: { rows: [...] } }.
 *   3. Para cada `bi_destination` ligado a esse script:
 *        - calcula hash, faz delta vs `bi_snapshots`,
 *        - se mudou: salva snapshot + (se endpoint_url presente) faz POST.
 *
 * Auth: header X-Agent-Secret = AGENTE_INGEST_SECRETO (mesma chave usada pelo cron).
 * Respeita `run_interval_minutes` por script.
 */

function sha256Hex(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

async function isAuthorized(request: Request): Promise<boolean> {
  // Método 1: X-Agent-Secret (para testes manuais)
  const agentSecret = request.headers.get("x-agent-secret") ?? "";
  const expected = process.env.AGENTE_INGEST_SECRETO;
  if (agentSecret && expected) {
    const a = Buffer.from(agentSecret);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }

  // Método 2: X-Cron-Token (usado pelo pg_cron, validado no banco)
  const cronToken = request.headers.get("x-cron-token");
  if (cronToken) {
    const { data } = await (
      supabaseAdmin.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>
      ) => Promise<{ data: boolean | null }>
    )("validate_bi_cron_token", { _token: cronToken });
    if (data === true) return true;
  }

  return false;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

export const Route = createFileRoute("/api/public/bi/run-scripts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorized(request))) {
          return json({ error: "Unauthorized" }, 401);
        }

        const triggeredBy =
          (request.headers.get("x-triggered-by") ?? "cron").slice(0, 64);

        const { data: scripts, error: scrErr } = await supabaseAdmin
          .from("bi_scripts")
          .select(
            "id, name, sql_code, enabled, run_interval_minutes, last_run_at"
          )
          .eq("enabled", true);

        if (scrErr) return json({ error: scrErr.message }, 500);
        if (!scripts || scripts.length === 0) {
          return json({ ok: true, ran: [], message: "No enabled scripts" });
        }

        const results: Array<Record<string, unknown>> = [];
        const now = Date.now();

        for (const script of scripts) {
          // Respeita intervalo configurado
          if (script.last_run_at) {
            const last = new Date(script.last_run_at).getTime();
            const dueIn =
              script.run_interval_minutes * 60_000 - (now - last);
            if (dueIn > 0) {
              results.push({
                script_id: script.id,
                name: script.name,
                status: "skipped",
                reason: "not_due",
                next_run_in_ms: dueIn,
              });
              continue;
            }
          }

          const start = Date.now();
          let rowsResult: unknown = null;
          let errorMessage: string | null = null;
          let status: "success" | "failed" = "failed";

          try {
            const { data, error } = await (
              supabaseAdmin.rpc as unknown as (
                fn: string,
                args: Record<string, unknown>
              ) => Promise<{ data: unknown; error: { message: string } | null }>
            )("execute_bi_script", { _sql: script.sql_code });
            if (error) {
              errorMessage = error.message;
            } else {
              rowsResult = data;
              status = "success";
            }
          } catch (e) {
            errorMessage = e instanceof Error ? e.message : "rpc failed";
          }

          const duration = Date.now() - start;
          const rows = Array.isArray(rowsResult) ? rowsResult : [];

          // Atualiza estado do script
          await supabaseAdmin
            .from("bi_scripts")
            .update({
              last_run_at: new Date().toISOString(),
              last_status: status,
              last_error: errorMessage,
              last_duration_ms: duration,
              last_row_count: rows.length,
            })
            .eq("id", script.id);

          if (status === "failed") {
            results.push({
              script_id: script.id,
              name: script.name,
              status,
              error: errorMessage,
              duration_ms: duration,
            });
            continue;
          }

          // Envelope no estilo BiScriptRunner.cs (compatível com BI atual)
          const envelope = {
            generated_at: new Date().toISOString(),
            source: script.name,
            sections: {
              rows,
            },
          };
          const payloadStr = JSON.stringify(envelope);
          const payloadHash = sha256Hex(payloadStr);

          // Destinos ligados a este script
          const { data: destinations } = await supabaseAdmin
            .from("bi_destinations")
            .select("id, name, endpoint_url, enabled, allowed_ips, bi_script_id")
            .eq("bi_script_id", script.id)
            .eq("enabled", true);

          const deliveries: Array<Record<string, unknown>> = [];

          for (const dest of destinations ?? []) {
            const { data: prev } = await supabaseAdmin
              .from("bi_snapshots")
              .select("payload_hash")
              .eq("destination_id", dest.id)
              .maybeSingle();

            const changed = prev?.payload_hash !== payloadHash;

            if (!changed) {
              await supabaseAdmin.from("bi_deliveries").insert({
                destination_id: dest.id,
                status: "skipped",
                payload_kind: "snapshot",
                triggered_by: triggeredBy,
                payload_bytes: payloadStr.length,
                changed_sections: [],
                rows_affected: rows.length,
                duration_ms: 0,
              });
              deliveries.push({ destination_id: dest.id, status: "skipped" });
              continue;
            }

            // Salva snapshot novo (sempre, independente de webhook)
            await supabaseAdmin.from("bi_snapshots").upsert(
              {
                destination_id: dest.id,
                payload: envelope as never,
                payload_hash: payloadHash,
                section_hashes: { rows: sha256Hex(JSON.stringify(rows)) } as never,
                generated_at: envelope.generated_at,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "destination_id" }
            );

            // Push opcional para webhook externo (se endpoint_url estiver setado)
            let httpStatus: number | null = null;
            let pushErr: string | null = null;
            let pushStatus: "success" | "failed" | "no_endpoint" = "no_endpoint";
            const pushStart = Date.now();

            if (dest.endpoint_url) {
              try {
                const res = await fetch(dest.endpoint_url, {
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
                pushStatus = delivery.ok ? "success" : "failed";
                pushErr = delivery.errorMessage;
              } catch (e) {
                pushErr = e instanceof Error ? e.message : "fetch failed";
                pushStatus = "failed";
              }
            }

            const finalStatus =
              pushStatus === "no_endpoint" ? "success" : pushStatus;

            await supabaseAdmin
              .from("bi_destinations")
              .update({
                last_pushed_at: new Date().toISOString(),
                last_status: finalStatus,
                last_error: pushErr,
              })
              .eq("id", dest.id);

            await supabaseAdmin.from("bi_deliveries").insert({
              destination_id: dest.id,
              status: finalStatus,
              payload_kind: "snapshot",
              triggered_by: triggeredBy,
              http_status: httpStatus,
              payload_bytes: payloadStr.length,
              changed_sections: ["rows"],
              rows_affected: rows.length,
              duration_ms: Date.now() - pushStart,
              error_message: pushErr,
            });

            deliveries.push({
              destination_id: dest.id,
              name: dest.name,
              status: finalStatus,
              http_status: httpStatus,
              error: pushErr,
            });
          }

          results.push({
            script_id: script.id,
            name: script.name,
            status,
            duration_ms: duration,
            rows: rows.length,
            payload_hash: payloadHash.slice(0, 12),
            deliveries,
          });
        }

        return json({ ok: true, ran: results });
      },
    },
  },
});
