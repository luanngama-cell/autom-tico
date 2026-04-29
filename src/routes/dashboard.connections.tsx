import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Copy, Loader2, Plus, Trash2 } from "lucide-react";
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

function randomToken(len = 32) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string) {
  const buf = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function ConnectionsPage() {
  const [rows, setRows] = useState<Conn[]>([]);
  const [activeTokenCounts, setActiveTokenCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [tokenConnection, setTokenConnection] = useState<Conn | null>(null);
  const [newToken, setNewToken] = useState<{ connectionName: string; value: string } | null>(null);

  const load = async () => {
    setLoading(true);
    const [{ data, error }, { data: tokens, error: tokensError }] = await Promise.all([
      supabase.from("sql_connections").select("*").order("created_at", { ascending: false }),
      supabase.from("agent_tokens").select("connection_id, revoked_at"),
    ]);

    if (error) {
      toast.error(error.message);
    } else {
      setRows((data as Conn[]) ?? []);
    }

    if (tokensError) {
      toast.error(tokensError.message);
    } else {
      const nextCounts = ((tokens as Array<{ connection_id: string; revoked_at: string | null }>) ?? [])
        .filter((token) => !token.revoked_at)
        .reduce<Record<string, number>>((acc, token) => {
          acc[token.connection_id] = (acc[token.connection_id] ?? 0) + 1;
          return acc;
        }, {});
      setActiveTokenCounts(nextCounts);
    }

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
                <TableHead>Tokens</TableHead>
                <TableHead>Último contato</TableHead>
                <TableHead className="w-[220px] text-right">Ações</TableHead>
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
                  <TableCell>
                    <Badge variant={activeTokenCounts[c.id] ? "default" : "secondary"}>
                      {activeTokenCounts[c.id] ?? 0} ativo{activeTokenCounts[c.id] === 1 ? "" : "s"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {c.last_seen_at ? new Date(c.last_seen_at).toLocaleString() : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setTokenConnection(c)}>
                        {activeTokenCounts[c.id] ? "Regenerar token" : "Gerar token"}
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => remove(c.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <ManageConnectionTokenDialog
        connection={tokenConnection}
        activeTokens={tokenConnection ? activeTokenCounts[tokenConnection.id] ?? 0 : 0}
        onClose={() => setTokenConnection(null)}
        onGenerated={(token) => {
          setTokenConnection(null);
          setNewToken(token);
          load();
        }}
      />

      <Dialog open={!!newToken} onOpenChange={(open) => !open && setNewToken(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Token gerado</DialogTitle>
            <DialogDescription>
              Copie agora — por segurança ele não poderá ser exibido de novo.
            </DialogDescription>
          </DialogHeader>
          {newToken && (
            <div className="space-y-3">
              <div className="grid gap-2">
                <Label>Conexão</Label>
                <Input readOnly value={newToken.connectionName} />
              </div>
              <div className="grid gap-2">
                <Label>Token do agente</Label>
                <div className="flex gap-2">
                  <Input readOnly value={newToken.value} className="font-mono text-xs" />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => {
                      navigator.clipboard.writeText(newToken.value);
                      toast.success("Token copiado");
                    }}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setNewToken(null)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

function ManageConnectionTokenDialog({
  connection,
  activeTokens,
  onClose,
  onGenerated,
}: {
  connection: Conn | null;
  activeTokens: number;
  onClose: () => void;
  onGenerated: (payload: { connectionName: string; value: string }) => void;
}) {
  const [name, setName] = useState("agente-principal");
  const [revokeExisting, setRevokeExisting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!connection) return;
    setName("agente-principal");
    setRevokeExisting(activeTokens > 0);
  }, [connection, activeTokens]);

  const submit = async () => {
    if (!connection || !name) {
      toast.error("Informe um nome para o token");
      return;
    }

    setSaving(true);

    if (revokeExisting) {
      const { error: revokeError } = await supabase
        .from("agent_tokens")
        .update({ revoked_at: new Date().toISOString() })
        .eq("connection_id", connection.id)
        .is("revoked_at", null);

      if (revokeError) {
        setSaving(false);
        toast.error(revokeError.message);
        return;
      }
    }

    const secret = randomToken();
    const hash = await sha256Hex(secret);
    const { error } = await supabase
      .from("agent_tokens")
      .insert({ connection_id: connection.id, name, token_hash: hash });

    setSaving(false);

    if (error) {
      toast.error(error.message);
      return;
    }

    onGenerated({
      connectionName: connection.name,
      value: `${connection.id}.${secret}`,
    });
  };

  return (
    <Dialog open={!!connection} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{activeTokens ? "Regenerar token" : "Gerar token"}</DialogTitle>
          <DialogDescription>
            O token atual não pode ser lido novamente. Gere um novo aqui direto pela conexão.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-2">
            <Label>Conexão</Label>
            <Input readOnly value={connection?.name ?? ""} />
          </div>
          <div className="grid gap-2">
            <Label>Nome do token</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {activeTokens > 0 && (
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">Revogar tokens ativos desta conexão</p>
                <p className="text-xs text-muted-foreground">
                  Hoje existem {activeTokens} token{activeTokens === 1 ? "" : "s"} ativo
                  {activeTokens === 1 ? "" : "s"}.
                </p>
              </div>
              <Switch checked={revokeExisting} onCheckedChange={setRevokeExisting} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {activeTokens ? "Gerar novo token" : "Gerar token"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
