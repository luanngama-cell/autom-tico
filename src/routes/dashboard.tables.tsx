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

export const Route = createFileRoute("/dashboard/tables")({
  component: TablesPage,
});

type SyncTable = {
  id: string;
  schema_name: string;
  table_name: string;
  enabled: boolean;
  strategy: string;
  row_count: number;
  last_synced_at: string | null;
  last_error: string | null;
  connection_id: string;
};

function TablesPage() {
  const [rows, setRows] = useState<SyncTable[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("sync_tables")
        .select("*")
        .order("schema_name")
        .order("table_name");
      setRows((data as SyncTable[]) ?? []);
      setLoading(false);
    })();
  }, []);

  return (
    <div className="p-8">
      <h2 className="text-3xl font-bold tracking-tight">Tabelas sincronizadas</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Tabelas espelhadas pelo agente para a nuvem.
      </p>

      <div className="mt-6 rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            Nenhuma tabela sincronizada ainda. Configure-as no agente Windows.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tabela</TableHead>
                <TableHead>Estratégia</TableHead>
                <TableHead>Linhas</TableHead>
                <TableHead>Última sync</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs">
                    {t.schema_name}.{t.table_name}
                  </TableCell>
                  <TableCell>{t.strategy}</TableCell>
                  <TableCell>{t.row_count.toLocaleString()}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {t.last_synced_at ? new Date(t.last_synced_at).toLocaleString() : "—"}
                  </TableCell>
                  <TableCell>
                    {t.last_error ? (
                      <Badge variant="destructive">Erro</Badge>
                    ) : t.enabled ? (
                      <Badge>Ativo</Badge>
                    ) : (
                      <Badge variant="secondary">Pausado</Badge>
                    )}
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
