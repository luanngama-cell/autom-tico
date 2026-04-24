import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Loader2,
  Plus,
  Trash2,
  Play,
  CheckCircle2,
  AlertCircle,
  Clock,
  FileCode2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/dashboard/bi-scripts")({
  component: BiScriptsPage,
});

type BiScript = {
  id: string;
  name: string;
  description: string | null;
  sql_code: string;
  enabled: boolean;
  run_interval_minutes: number;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  last_row_count: number | null;
  created_at: string;
  updated_at: string;
};

function BiScriptsPage() {
  const [scripts, setScripts] = useState<BiScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = async () => {
    const { data } = await supabase
      .from("bi_scripts")
      .select("*")
      .order("created_at", { ascending: false });
    setScripts((data as BiScript[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const selected = scripts.find((s) => s.id === selectedId);

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Scripts BI</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Scripts SQL executados automaticamente contra o banco espelhado. O
            resultado fica disponível para consumo do BI via{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              GET /api/public/bi/snapshot
            </code>
            .
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Atualizar
          </Button>
          <NewScriptDialog onCreated={load} />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : scripts.length === 0 ? (
        <div className="rounded-lg border bg-card py-16 text-center">
          <FileCode2 className="mx-auto h-10 w-10 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            Nenhum script cadastrado.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Cole o SQL que o BI te enviou e o sistema executa periodicamente.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[380px,1fr]">
          <div className="space-y-2">
            {scripts.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`w-full rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 ${selectedId === s.id ? "border-primary ring-1 ring-primary" : ""}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold truncate">{s.name}</span>
                      {!s.enabled && (
                        <Badge variant="secondary" className="text-xs">
                          Pausado
                        </Badge>
                      )}
                    </div>
                    {s.description && (
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {s.description}
                      </div>
                    )}
                  </div>
                  {s.last_status === "success" ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                  ) : s.last_status === "failed" ? (
                    <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
                  ) : (
                    <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                </div>
                <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
                  <span>A cada {s.run_interval_minutes} min</span>
                  {s.last_row_count != null && (
                    <span>· {s.last_row_count.toLocaleString("pt-BR")} linhas</span>
                  )}
                </div>
              </button>
            ))}
          </div>

          <div>
            {selected ? (
              <ScriptDetail script={selected} onChange={load} />
            ) : (
              <div className="flex h-full items-center justify-center rounded-lg border bg-card p-12 text-sm text-muted-foreground">
                Selecione um script para ver detalhes.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NewScriptDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    sql_code: "",
    run_interval_minutes: 5,
  });

  const save = async () => {
    if (!form.name.trim() || !form.sql_code.trim()) {
      toast.error("Nome e SQL são obrigatórios");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("bi_scripts").insert({
      name: form.name.trim(),
      description: form.description.trim() || null,
      sql_code: form.sql_code,
      run_interval_minutes: Math.max(1, Number(form.run_interval_minutes) || 5),
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Script criado");
    setOpen(false);
    setForm({ name: "", description: "", sql_code: "", run_interval_minutes: 5 });
    onCreated();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Novo script
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Novo script BI</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Nome</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Extrair dados médicos"
            />
          </div>
          <div className="space-y-2">
            <Label>Descrição (opcional)</Label>
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="O que esse script retorna"
            />
          </div>
          <div className="space-y-2">
            <Label>Intervalo (minutos)</Label>
            <Input
              type="number"
              min={1}
              value={form.run_interval_minutes}
              onChange={(e) =>
                setForm({ ...form, run_interval_minutes: Number(e.target.value) })
              }
            />
          </div>
          <div className="space-y-2">
            <Label>SQL (Postgres, somente SELECT)</Label>
            <Textarea
              rows={12}
              className="font-mono text-xs"
              value={form.sql_code}
              onChange={(e) => setForm({ ...form, sql_code: e.target.value })}
              placeholder={`SELECT\n  (data->>'id')::uuid AS id,\n  data->>'nome' AS nome\nFROM synced_rows sr\nJOIN sync_tables st ON st.id = sr.sync_table_id\nWHERE st.table_name = 'pacientes'`}
            />
            <p className="text-xs text-muted-foreground">
              Os dados espelhados ficam em{" "}
              <code className="rounded bg-muted px-1 py-0.5">synced_rows</code>{" "}
              (coluna <code className="rounded bg-muted px-1 py-0.5">data</code>{" "}
              é JSONB). A query é executada em transação{" "}
              <strong>READ ONLY</strong> — qualquer escrita é rejeitada.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Criar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScriptDetail({
  script,
  onChange,
}: {
  script: BiScript;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [sql, setSql] = useState(script.sql_code);
  const [interval, setIntervalVal] = useState(script.run_interval_minutes);
  const [name, setName] = useState(script.name);
  const [description, setDescription] = useState(script.description ?? "");
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setSql(script.sql_code);
    setIntervalVal(script.run_interval_minutes);
    setName(script.name);
    setDescription(script.description ?? "");
    setEditing(false);
  }, [script.id, script.sql_code, script.run_interval_minutes, script.name, script.description]);

  const toggleEnabled = async () => {
    await supabase
      .from("bi_scripts")
      .update({ enabled: !script.enabled })
      .eq("id", script.id);
    onChange();
  };

  const save = async () => {
    setSaving(true);
    const { error } = await supabase
      .from("bi_scripts")
      .update({
        name: name.trim(),
        description: description.trim() || null,
        sql_code: sql,
        run_interval_minutes: Math.max(1, interval),
      })
      .eq("id", script.id);
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Script atualizado");
    setEditing(false);
    onChange();
  };

  const remove = async () => {
    if (!confirm(`Remover script "${script.name}"?`)) return;
    const { error } = await supabase.from("bi_scripts").delete().eq("id", script.id);
    if (error) toast.error(error.message);
    else {
      toast.success("Removido");
      onChange();
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      // Força execução imediata zerando last_run_at
      await supabase
        .from("bi_scripts")
        .update({ last_run_at: null })
        .eq("id", script.id);
      toast.success("Agendado para a próxima execução (~1 min)");
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {editing ? (
              <div className="space-y-2">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Descrição (opcional)"
                />
              </div>
            ) : (
              <>
                <h3 className="text-lg font-semibold">{script.name}</h3>
                {script.description && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {script.description}
                  </p>
                )}
              </>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <Label className="text-xs">Ativo</Label>
              <Switch checked={script.enabled} onCheckedChange={toggleEnabled} />
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={runNow} disabled={running}>
                <Play className="mr-1 h-3 w-3" />
                Rodar agora
              </Button>
              <Button size="sm" variant="ghost" onClick={remove}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 border-t pt-4 text-xs">
          <div>
            <div className="text-muted-foreground">Última execução</div>
            <div className="mt-1 font-medium">
              {script.last_run_at
                ? new Date(script.last_run_at).toLocaleString("pt-BR")
                : "—"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Status</div>
            <div className="mt-1 font-medium">
              {script.last_status === "success" ? (
                <Badge variant="outline" className="text-emerald-600 border-emerald-500/30">
                  Sucesso
                </Badge>
              ) : script.last_status === "failed" ? (
                <Badge variant="destructive">Falhou</Badge>
              ) : (
                <Badge variant="secondary">Aguardando</Badge>
              )}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Linhas retornadas</div>
            <div className="mt-1 font-medium">
              {script.last_row_count?.toLocaleString("pt-BR") ?? "—"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Duração</div>
            <div className="mt-1 font-medium">
              {script.last_duration_ms != null ? `${script.last_duration_ms}ms` : "—"}
            </div>
          </div>
        </div>

        {script.last_error && (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <span className="font-medium">Último erro:</span> {script.last_error}
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-card p-5">
        <div className="flex items-center justify-between">
          <h4 className="font-semibold text-sm">SQL</h4>
          {!editing ? (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Editar
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSql(script.sql_code);
                  setIntervalVal(script.run_interval_minutes);
                  setName(script.name);
                  setDescription(script.description ?? "");
                  setEditing(false);
                }}
              >
                Cancelar
              </Button>
              <Button size="sm" onClick={save} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                Salvar
              </Button>
            </div>
          )}
        </div>
        {editing && (
          <div className="mt-3 space-y-2">
            <Label className="text-xs">Intervalo (minutos)</Label>
            <Input
              type="number"
              min={1}
              value={interval}
              onChange={(e) => setIntervalVal(Number(e.target.value))}
            />
          </div>
        )}
        <Textarea
          rows={20}
          readOnly={!editing}
          className="mt-3 font-mono text-xs"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
        />
      </div>
    </div>
  );
}
