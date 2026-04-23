import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/dashboard/connections")({
  component: ConnectionsPage,
});

type Conn = {
  id: string;
  name: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  encrypt: boolean;
  trust_server_cert: boolean;
  status: string;
  last_seen_at: string | null;
  notes: string | null;
};

function ConnectionsPage() {
  const [rows, setRows] = useState<Conn[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("sql_connections")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) toast.error(error.message);
    else setRows((data as Conn[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const remove = async (id: string) => {
    if (!confirm("Remover esta conexão?")) return;
    const { error } = await supabase.from("sql_connections").delete().eq("id", id);
    if (error) toast.error(error.message);
    else {
      toast.success("Conexão removida");
      load();
    }
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Conexões SQL</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Servidores SQL Server locais que o agente irá ler.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Nova conexão
            </Button>
          </DialogTrigger>
          <NewConnectionDialog
            onCreated={() => {
              setOpen(false);
              load();
            }}
          />
        </Dialog>
      </div>

      <div className="mt-6 rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            Nenhuma conexão cadastrada.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Host</TableHead>
                <TableHead>Banco</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Último contato</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {c.host}:{c.port}
                  </TableCell>
                  <TableCell>{c.database_name}</TableCell>
                  <TableCell>
                    <Badge variant={c.status === "online" ? "default" : "secondary"}>
                      {c.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {c.last_seen_at ? new Date(c.last_seen_at).toLocaleString() : "—"}
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => remove(c.id)}>
                      <Trash2 className="h-4 w-4" />
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

function NewConnectionDialog({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState({
    name: "",
    host: "",
    port: 1433,
    database_name: "",
    username: "",
    encrypt: true,
    trust_server_cert: true,
    notes: "",
  });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!form.name || !form.host || !form.database_name || !form.username) {
      toast.error("Preencha os campos obrigatórios");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("sql_connections").insert(form);
    setSaving(false);
    if (error) toast.error(error.message);
    else {
      toast.success("Conexão criada");
      onCreated();
    }
  };

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Nova conexão SQL Server</DialogTitle>
      </DialogHeader>
      <div className="grid gap-4 py-2">
        <div className="grid gap-2">
          <Label>Nome *</Label>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Produção - Matriz"
          />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2 grid gap-2">
            <Label>Host *</Label>
            <Input
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              placeholder="192.168.1.10"
            />
          </div>
          <div className="grid gap-2">
            <Label>Porta</Label>
            <Input
              type="number"
              value={form.port}
              onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-2">
            <Label>Banco *</Label>
            <Input
              value={form.database_name}
              onChange={(e) => setForm({ ...form, database_name: e.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label>Usuário *</Label>
            <Input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          A senha é informada apenas no agente Windows local — nunca é enviada para a nuvem.
        </p>
        <div className="flex items-center justify-between">
          <Label>Encrypt</Label>
          <Switch
            checked={form.encrypt}
            onCheckedChange={(v) => setForm({ ...form, encrypt: v })}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label>Trust server certificate</Label>
          <Switch
            checked={form.trust_server_cert}
            onCheckedChange={(v) => setForm({ ...form, trust_server_cert: v })}
          />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Criar
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
