import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { getExternalBaseUrl } from "@/lib/public-base-url";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Copy, Trash2, Download } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/dashboard/agent")({
  component: AgentPage,
});

type Conn = { id: string; name: string };
type TokenRow = {
  id: string;
  name: string;
  connection_id: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

function randomToken(len = 40) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s: string) {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function AgentPage() {
  const publicBaseUrl = getExternalBaseUrl(
    typeof window !== "undefined" ? window.location.origin : undefined
  );
  const [conns, setConns] = useState<Conn[]>([]);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [newToken, setNewToken] = useState<{ connectionId: string; secret: string } | null>(null);

  const load = async () => {
    setLoading(true);
    const [{ data: c }, { data: t }] = await Promise.all([
      supabase.from("sql_connections").select("id, name").order("name"),
      supabase
        .from("agent_tokens")
        .select("id, name, connection_id, created_at, last_used_at, revoked_at")
        .order("created_at", { ascending: false }),
    ]);
    setConns((c as Conn[]) ?? []);
    setTokens((t as TokenRow[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const revoke = async (id: string) => {
    if (!confirm("Revogar este token? O agente que estiver usando vai parar.")) return;
    const { error } = await supabase
      .from("agent_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id);
    if (error) toast.error(error.message);
    else load();
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Agente Windows</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Baixe o agente, gere um token por conexão e execute no servidor que tem acesso ao SQL Server.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button disabled={conns.length === 0}>
              <Plus className="mr-2 h-4 w-4" />
              Novo token
            </Button>
          </DialogTrigger>
          <NewTokenDialog
            conns={conns}
            onCreated={(payload) => {
              setOpen(false);
              setNewToken(payload);
              load();
            }}
          />
        </Dialog>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border bg-card p-6">
          <h3 className="font-semibold">1. Baixar o agente</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Worker Service em .NET 8. Roda como Windows Service. Código-fonte em <code>/agent</code>.
          </p>
          <div className="mt-4 space-y-2 text-sm">
            <div>
              <strong>Pré-requisitos:</strong> .NET 8 SDK no servidor (apenas para compilar) e
              acesso de rede ao SQL Server.
            </div>
            <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 font-mono text-xs">{`# No servidor Windows
git clone <seu-repo> sqlsync
cd sqlsync\\agent
dotnet publish -c Release -r win-x64 --self-contained true ^
  -p:PublishSingleFile=true -o C:\\sqlsync-agent`}</pre>
          </div>
        </section>

        <section className="rounded-lg border bg-card p-6">
          <h3 className="font-semibold">2. Configurar</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Edite <code>appsettings.json</code> ao lado do executável:
          </p>
          <pre className="mt-3 overflow-x-auto rounded bg-muted p-3 font-mono text-xs">{`{
  "Cloud": {
    "BaseUrl": "${publicBaseUrl}",
    "AgentSecret": "<AGENT_INGEST_SECRET>",
    "Token": "<conexaoId>.<tokenGerado>"
  },
  "Sql": {
    "Host": "192.168.1.10",
    "Port": 1433,
    "Database": "MeuBanco",
    "AuthMode": "Sql",            // "Sql" ou "Windows"
    "Username": "sa",
    "Password": "***",
    "Encrypt": true,
    "TrustServerCertificate": true
  },
  "Sync": {
    "IntervalSeconds": 60,
    "Schema": "dbo"
  }
}`}</pre>
        </section>

        <section className="rounded-lg border bg-card p-6">
          <h3 className="font-semibold">3. Instalar como serviço</h3>
          <pre className="mt-3 overflow-x-auto rounded bg-muted p-3 font-mono text-xs">{`# PowerShell como Administrador
sc.exe create SqlSyncAgent binPath= "C:\\sqlsync-agent\\SqlSyncAgent.exe" start= auto
sc.exe start SqlSyncAgent

# Logs
Get-EventLog -LogName Application -Source SqlSyncAgent -Newest 20`}</pre>
        </section>

        <section className="rounded-lg border bg-card p-6">
          <h3 className="font-semibold">Como funciona</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>A cada 60 s, o agente lista as tabelas de <code>dbo</code>.</li>
            <li>
              Tabelas com coluna <code>rowversion</code>: envia só linhas alteradas desde o
              último ciclo (incremental).
            </li>
            <li>
              Tabelas sem <code>rowversion</code>: full scan + hash por linha; envia só o que
              mudou.
            </li>
            <li>A senha do SQL nunca sai do servidor — só os dados das tabelas.</li>
          </ul>
        </section>
      </div>

      <div className="mt-8">
        <h3 className="text-lg font-semibold">Tokens do agente</h3>
        <p className="text-sm text-muted-foreground">
          Cada conexão SQL pode ter um ou mais tokens. Use um por instalação do agente.
        </p>
        <div className="mt-4 rounded-lg border bg-card">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : tokens.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Nenhum token gerado.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Conexão</TableHead>
                  <TableHead>Criado</TableHead>
                  <TableHead>Último uso</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((t) => {
                  const conn = conns.find((c) => c.id === t.connection_id);
                  return (
                    <TableRow key={t.id}>
                      <TableCell className="font-medium">{t.name}</TableCell>
                      <TableCell>{conn?.name ?? t.connection_id}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(t.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "—"}
                      </TableCell>
                      <TableCell>
                        {t.revoked_at ? (
                          <Badge variant="destructive">Revogado</Badge>
                        ) : (
                          <Badge>Ativo</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {!t.revoked_at && (
                          <Button variant="ghost" size="icon" onClick={() => revoke(t.id)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      <Dialog open={!!newToken} onOpenChange={(o) => !o && setNewToken(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Token gerado</DialogTitle>
            <DialogDescription>
              Copie agora — por segurança não exibimos novamente.
            </DialogDescription>
          </DialogHeader>
          {newToken && (
            <div className="space-y-3">
              <div>
                <Label>Token (cole em <code>Cloud.Token</code> do appsettings.json)</Label>
                <div className="mt-1 flex gap-2">
                  <Input
                    readOnly
                    value={`${newToken.connectionId}.${newToken.secret}`}
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => {
                      navigator.clipboard.writeText(`${newToken.connectionId}.${newToken.secret}`);
                      toast.success("Copiado");
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

function NewTokenDialog({
  conns,
  onCreated,
}: {
  conns: Conn[];
  onCreated: (p: { connectionId: string; secret: string }) => void;
}) {
  const [connectionId, setConnectionId] = useState("");
  const [name, setName] = useState("agente-principal");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!connectionId || !name) {
      toast.error("Selecione conexão e informe um nome");
      return;
    }
    setSaving(true);
    const secret = randomToken(32);
    const hash = await sha256Hex(secret);
    const { error } = await supabase
      .from("agent_tokens")
      .insert({ connection_id: connectionId, name, token_hash: hash });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    onCreated({ connectionId, secret });
  };

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Gerar token do agente</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="grid gap-2">
          <Label>Conexão</Label>
          <Select value={connectionId} onValueChange={setConnectionId}>
            <SelectTrigger>
              <SelectValue placeholder="Selecione" />
            </SelectTrigger>
            <SelectContent>
              {conns.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label>Nome (referência)</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <Download className="mr-2 h-4 w-4" />
          Gerar
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
