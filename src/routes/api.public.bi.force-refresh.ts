import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPublicBaseUrl } from "@/lib/public-base-url";

/**
 * Força a atualização do snapshot de um destino BI.
 *
 * - Se o destino tem `bi_script_id` vinculado: zera `last_run_at` do script e
 *   chama o endpoint interno `/api/public/bi/run-scripts` para regerar.
 * - Se não tem script vinculado: o snapshot só pode ser atualizado pelo agente
 *   local (push do SQL Server). Nesse caso retorna 409 com instrução.
 *
 * Auth: requer sessão Supabase autenticada com role `master`.
 */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/public/bi/force-refresh")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Auth: usa o JWT do usuário logado para checar role master
        const authHeader = request.headers.get("authorization") ?? "";
        const token = authHeader.replace(/^Bearer\s+/i, "");
        if (!token) return json({ error: "Missing auth token" }, 401);

        const { data: userData, error: userErr } =
          await supabaseAdmin.auth.getUser(token);
        if (userErr || !userData.user) {
          return json({ error: "Invalid session" }, 401);
        }

        const { data: hasMaster } = await (
          supabaseAdmin.rpc as unknown as (
            fn: string,
            args: Record<string, unknown>
          ) => Promise<{ data: boolean | null }>
        )("has_role", { _user_id: userData.user.id, _role: "master" });
        if (hasMaster !== true) {
          return json({ error: "Forbidden" }, 403);
        }

        let body: { destination_id?: string } = {};
        try {
          body = (await request.json()) as { destination_id?: string };
        } catch {
          return json({ error: "Invalid JSON body" }, 400);
        }

        const destinationId = body.destination_id;
        if (!destinationId) {
          return json({ error: "destination_id required" }, 400);
        }

        const { data: dest, error: destErr } = await supabaseAdmin
          .from("bi_destinations")
          .select("id, name, bi_script_id, enabled")
          .eq("id", destinationId)
          .maybeSingle();

        if (destErr) return json({ error: destErr.message }, 500);
        if (!dest) return json({ error: "Destination not found" }, 404);

        if (!dest.bi_script_id) {
          return json(
            {
              ok: false,
              reason: "no_script_linked",
              message:
                "Este destino não tem script SQL vinculado. O snapshot é atualizado pelo agente local (Windows) via push. Verifique se o serviço SqlSyncAgent está rodando na máquina onde o SQL Server está instalado.",
            },
            409
          );
        }

        // Zera last_run_at do script para que o run-scripts não pule por intervalo
        await supabaseAdmin
          .from("bi_scripts")
          .update({ last_run_at: null })
          .eq("id", dest.bi_script_id);

        const agentSecret = process.env.AGENT_INGEST_SECRET;
        if (!agentSecret) {
          return json({ error: "AGENT_INGEST_SECRET not configured" }, 500);
        }

        const baseUrl = getPublicBaseUrl(request);
        const runUrl = `${baseUrl}/api/public/bi/run-scripts`;

        try {
          const res = await fetch(runUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Agent-Secret": agentSecret,
              "X-Triggered-By": "manual-force-refresh",
            },
            signal: AbortSignal.timeout(90_000),
          });
          const text = await res.text();
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* keep raw */
          }
          return json(
            {
              ok: res.ok,
              http_status: res.status,
              run_result: parsed,
            },
            res.ok ? 200 : 502
          );
        } catch (e) {
          return json(
            {
              ok: false,
              error: e instanceof Error ? e.message : "fetch failed",
            },
            500
          );
        }
      },
    },
  },
});
