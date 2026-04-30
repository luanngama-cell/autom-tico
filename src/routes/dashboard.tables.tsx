import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Ban, RotateCcw } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/dashboard/tables")({
  component: TablesPage,
});

type SyncTable = {
  id: string;
  schema_name: string;
  table_name: string;
  enabled: boolean;
  excluded: boolean;
  excluded_reason: string | null;
  strategy: string;
  row_count: number;
  last_synced_at: string | null;
  last_error: string | null;
  last_rowversion: string | null;
  connection_id: string;
};

function TablesPage() {
  const [rows, setRows] = useState<SyncTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [showExcluded, setShowExcluded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    const { data } = await supabase
      .from("sync_tables")
      .select("*")
      .order("schema_name")
      .order("table_name");
    setRows((data as SyncTable[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return rows.filter((r) => {
      if (!showExcluded && r.excluded) return false;
      if (showExcluded && !r.excluded) return false;
      if (!f) return true;
      return `${r.schema_name}.${r.table_name}`.toLowerCase().includes(f);
    });
  }, [rows, filter, showExcluded]);

  const totalExcluded = rows.filter((r) => r.excluded).length;

  const toggleExclude = async (t: SyncTable) => {
    setBusyId(t.id);
    const next = !t.excluded;
    const reason = next
      ? window.prompt("Motivo (opcional) para excluir esta tabela do sync:", "") ?? ""
      : null;
    const { error } = await supabase
      .from("sync_tables")
      .update({
        excluded: next,
        excluded_reason: next ? reason || null : null,
        excluded_at: next ? new Date().toISOString() : null,
      })
      .eq("id", t.id);
    setBusyId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(next ? "Tabela excluída do sync" : "Tabela reativada");
    load();
  };

  return (
    <div className="p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Tabelas sincronizadas</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length} tabelas descobertas · {totalExcluded} excluídas do sync.
            O agente respeita a exclusão a partir do próximo ciclo.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Filtrar por nome…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-64"
          />
          <Button
            variant={showExcluded ? "default" : "outline"}
            size="sm"
            onClick={() => setShowExcluded((v) => !v)}
          >
            {showExcluded ? "Ver ativas" : `Ver excluídas (${totalExcluded})`}
          </Button>
        </div>
      </div>

      <div className="mt-6 rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : visible.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            Nenhuma tabela {showExcluded ? "excluída" : "ativa"}.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tabela</TableHead>
                <TableHead>Estratégia</TableHead>
                <TableHead className="text-right">Linhas</TableHead>
                <TableHead>Última sync</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((t) => (
                <TableRow key={t.id} className={t.excluded ? "opacity-60" : ""}>
                  <TableCell className="font-mono text-xs">
                    {t.schema_name}.{t.table_name}
                    {t.excluded && t.excluded_reason && (
                      <div className="text-[10px] text-muted-foreground mt-1">
                        Motivo: {t.excluded_reason}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {t.strategy}
                    {t.last_rowversion && (
                      <div className="text-[10px] text-muted-foreground font-mono">
                        rv: {t.last_rowversion.slice(0, 12)}…
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {t.row_count.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {t.last_synced_at ? new Date(t.last_synced_at).toLocaleString() : "—"}
                  </TableCell>
                  <TableCell>
                    {t.excluded ? (
                      <Badge variant="outline">Excluída</Badge>
                    ) : t.last_error ? (
                      <Badge variant="destructive">Erro</Badge>
                    ) : t.enabled ? (
                      <Badge>Ativo</Badge>
                    ) : (
                      <Badge variant="secondary">Pausado</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === t.id}
                      onClick={() => toggleExclude(t)}
                    >
                      {busyId === t.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : t.excluded ? (
                        <>
                          <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reativar
                        </>
                      ) : (
                        <>
                          <Ban className="mr-1 h-3.5 w-3.5" /> Excluir
                        </>
                      )}
                    </Button>
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
