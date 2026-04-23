import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";

export const Route = createFileRoute("/dashboard/logs")({
  component: LogsPage,
});

type Log = {
  id: string;
  level: string;
  event: string;
  message: string | null;
  rows_inserted: number;
  rows_updated: number;
  rows_deleted: number;
  duration_ms: number | null;
  created_at: string;
};

const levelVariant = (l: string) =>
  l === "error" ? "destructive" : l === "warn" ? "secondary" : "outline";

function LogsPage() {
  const [rows, setRows] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("sync_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      setRows((data as Log[]) ?? []);
      setLoading(false);
    })();
  }, []);

  return (
    <div className="p-8">
      <h2 className="text-3xl font-bold tracking-tight">Logs</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Últimos 200 eventos do agente e da sincronização.
      </p>

      <div className="mt-6 rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            Nenhum log registrado.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quando</TableHead>
                <TableHead>Nível</TableHead>
                <TableHead>Evento</TableHead>
                <TableHead>Mensagem</TableHead>
                <TableHead>Δ Linhas</TableHead>
                <TableHead>Duração</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(l.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Badge variant={levelVariant(l.level) as never}>{l.level}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{l.event}</TableCell>
                  <TableCell className="max-w-md truncate text-sm">
                    {l.message ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    +{l.rows_inserted} ~{l.rows_updated} −{l.rows_deleted}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {l.duration_ms ? `${l.duration_ms} ms` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
