import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Plus, RefreshCw, Trash2, Pencil } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/dashboard/materialized-views")({
  component: MvPage,
});

type Mv = {
  id: string;
  name: string;
  description: string | null;
  sql_definition: string;
  refresh_interval_minutes: number;
  enabled: boolean;
  last_refreshed_at: string | null;
  last_refresh_duration_ms: number | null;
  last_refresh_status: string | null;
  last_refresh_error: string | null;
  row_count: number | null;
};

function MvPage() {
  const [items, setItems] = useState<Mv[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Mv | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const { data, error } = await supabase
      .from("mv_registry")
      .select("*")
      .order("name");
    if (error) toast.error(error.message);
    setItems((data as Mv[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const openNew = () => {
    setEditing({
      id: "",
      name: "",
      description: "",
      sql_definition: "SELECT 1 AS x",
      refresh_interval_minutes: 5,
      enabled: true,
      last_refreshed_at: null,
      last_refresh_duration_ms: null,
      last_refresh_status: null,
      last_refresh_error: null,
      row_count: null,
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!editing) return;
    if (!/^[a-z][a-z0-9_]*$/.test(editing.name)) {
      toast.error("Nome inválido. Use snake_case (a-z, 0-9, _).");
      return;
    }
    const payload = {
      name: editing.name,
      description: editing.description,
      sql_definition: editing.sql_definition,
      refresh_interval_minutes: editing.refresh_interval_minutes,
      enabled: editing.enabled,
    };
    const { error } = editing.id
      ? await supabase.from("mv_registry").update(payload).eq("id", editing.id)
      : await supabase.from("mv_registry").insert(payload);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Salvo");
    setDialogOpen(false);
    load();
  };

  const refresh = async (mv: Mv) => {
    setBusy(mv.id);
    const { data, error } = await supabase.rpc("refresh_mv", { _name: mv.name });
    setBusy(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    const result = data as { ok: boolean; rows?: number; error?: string };
    if (result.ok) toast.success(`Refresh OK (${result.rows} linhas)`);
    else toast.error(result.error ?? "Falha");
    load();
  };

  const remove = async (mv: Mv) => {
    if (!confirm(`Excluir a view "${mv.name}"?`)) return;
    const { error } = await supabase.from("mv_registry").delete().eq("id", mv.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Removida do registro (a view física pode permanecer — drop manual se necessário)");
    load();
  };

  return (
    <div className="p-8">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Views materializadas</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Cache de queries pesadas. Refresh automático a cada N minutos via cron.
            Acesse no BI como <code className="text-xs">mirror.&lt;nome&gt;</code>.
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" /> Nova view
        </Button>
      </div>

      <div className="mt-6 rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            Nenhuma view materializada ainda.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Intervalo</TableHead>
                <TableHead className="text-right">Linhas</TableHead>
                <TableHead>Último refresh</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-mono text-xs">
                    {m.name}
                    {m.description && (
                      <div className="text-[10px] text-muted-foreground font-sans mt-1">
                        {m.description}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{m.refresh_interval_minutes} min</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.row_count?.toLocaleString() ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {m.last_refreshed_at
                      ? new Date(m.last_refreshed_at).toLocaleString()
                      : "—"}
                    {m.last_refresh_duration_ms != null && (
                      <span className="ml-1">({m.last_refresh_duration_ms}ms)</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {!m.enabled ? (
                      <Badge variant="secondary">Pausada</Badge>
                    ) : m.last_refresh_status === "error" ? (
                      <Badge variant="destructive" title={m.last_refresh_error ?? ""}>
                        Erro
                      </Badge>
                    ) : m.last_refresh_status === "ok" ? (
                      <Badge>OK</Badge>
                    ) : (
                      <Badge variant="outline">Pendente</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === m.id}
                        onClick={() => refresh(m)}
                      >
                        {busy === m.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(m);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(m)}>
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Editar view" : "Nova view materializada"}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Nome (snake_case)</Label>
                  <Input
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="ex: pacientes_ativos_por_medico"
                    disabled={!!editing.id}
                  />
                </div>
                <div>
                  <Label>Refresh a cada (minutos)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={editing.refresh_interval_minutes}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        refresh_interval_minutes: Math.max(1, Number(e.target.value) || 5),
                      })
                    }
                  />
                </div>
              </div>
              <div>
                <Label>Descrição</Label>
                <Input
                  value={editing.description ?? ""}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                />
              </div>
              <div>
                <Label>SQL (SELECT)</Label>
                <Textarea
                  rows={10}
                  className="font-mono text-xs"
                  value={editing.sql_definition}
                  onChange={(e) => setEditing({ ...editing, sql_definition: e.target.value })}
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  A view será criada como <code>mirror.&lt;nome&gt;</code> usando este SELECT.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={editing.enabled}
                  onCheckedChange={(v) => setEditing({ ...editing, enabled: v })}
                />
                <Label>Ativa</Label>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
