import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Loader2,
  Plus,
  Webhook,
  Key,
  Trash2,
  Copy,
  CheckCircle2,
  AlertCircle,
  Clock,
  RefreshCw,
  FileCode2,
} from "lucide-react";
import { toast } from "sonner";

type Destination = {
  id: string;
  name: string;
  description: string | null;
  endpoint_url: string;
  allowed_ips: string[];
  push_interval_minutes: number;
  enabled: boolean;
  include_patient_registry: boolean;
  source_database_name: string | null;
  last_pushed_at: string | null;
  last_status: string | null;
  last_error: string | null;
  bi_script_id: string | null;
};

type Snapshot = {
  destination_id: string;
  generated_at: string;
  updated_at: string;
  payload_hash: string | null;
};

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

type ScriptOption = {
  id: string;
  name: string;
  enabled: boolean;
};

type Token = {
  id: string;
  destination_id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

type Delivery = {
  id: string;
  destination_id: string;
  triggered_by: string;
  payload_kind: string;
  status: string;
  http_status: number | null;
  payload_bytes: number | null;
  duration_ms: number | null;
  changed_sections: string[];
  rows_affected: number;
  error_message: string | null;
  created_at: string;
};

function isLikelyApiEndpoint(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.includes("/api/") || parsed.pathname.startsWith("/webhook");
  } catch {
    return false;
  }
}

export function BiDestinationsPanel() {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [scripts, setScripts] = useState<ScriptOption[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const load = async () => {
    const [d, t, dl, s, sn] = await Promise.all([
      supabase.from("bi_destinations").select("*").order("created_at", { ascending: false }),
      supabase.from("bi_destination_tokens").select("*").order("created_at", { ascending: false }),
      supabase
        .from("bi_deliveries")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("bi_scripts")
        .select("id, name, enabled")
        .order("name", { ascending: true }),
      supabase
        .from("bi_snapshots")
        .select("destination_id, generated_at, updated_at, payload_hash"),
    ]);
    setDestinations((d.data as Destination[]) ?? []);
    setTokens((t.data as Token[]) ?? []);
    setDeliveries((dl.data as Delivery[]) ?? []);
    setScripts((s.data as ScriptOption[]) ?? []);
    setSnapshots((sn.data as Snapshot[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const selectedDest = destinations.find((d) => d.id === selected);
  const selectedTokens = tokens.filter((t) => t.destination_id === selected);
  const selectedDeliveries = deliveries.filter((d) => d.destination_id === selected);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xl font-semibold tracking-tight">Destinos BI</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Endpoints para sistemas externos (ex: BI Hospital CMO) consumirem o snapshot.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Atualizar
          </Button>
          <NewDestinationDialog onCreated={load} />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : destinations.length === 0 ? (
        <div className="rounded-lg border bg-card py-16 text-center">
          <Webhook className="mx-auto h-10 w-10 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            Nenhum destino cadastrado ainda.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Crie um destino para começar a enviar dados ao seu BI.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[380px,1fr]">
          {/* List */}
          <div className="space-y-2">
            {destinations.map((d) => {
              const active = selected === d.id;
              const status = d.last_status;
              const snap = snapshots.find((s) => s.destination_id === d.id);
              const ageMs = snap ? Date.now() - new Date(snap.updated_at).getTime() : null;
              const isStale = ageMs !== null && ageMs > STALE_THRESHOLD_MS;
              return (
                <button
                  key={d.id}
                  onClick={() => setSelected(d.id)}
                  className={`w-full rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 ${active ? "border-primary ring-1 ring-primary" : ""} ${isStale ? "border-destructive/40" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold truncate">{d.name}</span>
                        {!d.enabled && (
                          <Badge variant="secondary" className="text-xs">
                            Pausado
                          </Badge>
                        )}
                        {isStale && (
                          <Badge variant="destructive" className="text-xs">
                            Desatualizado {ageMs ? `(${formatAge(ageMs)})` : ""}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {d.endpoint_url}
                      </div>
                    </div>
                    {isStale ? (
                      <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
                    ) : status === "success" || status === "pull_only" ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    ) : status === "error" || status === "failed" ? (
                      <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
                    ) : (
                      <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                  </div>
                  <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                    <span>A cada {d.push_interval_minutes} min</span>
                    {snap && (
                      <span>
                        · snapshot: {new Date(snap.updated_at).toLocaleString("pt-BR")}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Detail */}
          <div>
            {selectedDest ? (
              <DestinationDetail
                destination={selectedDest}
                tokens={selectedTokens}
                deliveries={selectedDeliveries}
                scripts={scripts}
                snapshot={snapshots.find((s) => s.destination_id === selectedDest.id) ?? null}
                onChange={load}
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-lg border bg-card p-12 text-sm text-muted-foreground">
                Selecione um destino para ver detalhes.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- New destination dialog ----------------
function NewDestinationDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    endpoint_url: "",
    allowed_ips: "",
    push_interval_minutes: 5,
    include_patient_registry: true,
    source_database_name: "",
  });

  const save = async () => {
    if (!form.name.trim() || !form.endpoint_url.trim()) {
      toast.error("Nome e URL são obrigatórios");
      return;
    }
    try {
      new URL(form.endpoint_url);
    } catch {
      toast.error("URL inválida");
      return;
    }
    if (!isLikelyApiEndpoint(form.endpoint_url.trim())) {
      toast.error("Use a URL de API/webhook, não uma página do dashboard");
      return;
    }
    setSaving(true);
    const allowed_ips = form.allowed_ips
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const { error } = await supabase.from("bi_destinations").insert({
      name: form.name.trim(),
      description: form.description.trim() || null,
      endpoint_url: form.endpoint_url.trim(),
      allowed_ips,
      push_interval_minutes: Math.max(1, Number(form.push_interval_minutes) || 5),
      include_patient_registry: form.include_patient_registry,
      source_database_name: form.source_database_name.trim() || null,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Destino criado");
    setOpen(false);
    setForm({
      name: "",
      description: "",
      endpoint_url: "",
      allowed_ips: "",
      push_interval_minutes: 5,
      include_patient_registry: true,
      source_database_name: "",
    });
    onCreated();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Novo destino
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Novo destino BI</DialogTitle>
          <DialogDescription>
            Configure o webhook que receberá os snapshots JSON.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Nome</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="BI Hospital CMO"
            />
          </div>
          <div className="space-y-2">
            <Label>URL do endpoint</Label>
            <Input
              value={form.endpoint_url}
              onChange={(e) => setForm({ ...form, endpoint_url: e.target.value })}
              placeholder="https://bihospitalcmo.lovable.app/api/public/bi/ingest"
            />
          </div>
          <div className="space-y-2">
            <Label>Descrição (opcional)</Label>
            <Textarea
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Quem usa, qual ambiente, etc."
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Intervalo (minutos)</Label>
              <Input
                type="number"
                min={1}
                value={form.push_interval_minutes}
                onChange={(e) =>
                  setForm({ ...form, push_interval_minutes: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Banco de origem (opcional)</Label>
              <Input
                value={form.source_database_name}
                onChange={(e) =>
                  setForm({ ...form, source_database_name: e.target.value })
                }
                placeholder="HOSPITAL"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>IPs permitidos (separe por vírgula ou espaço)</Label>
            <Input
              value={form.allowed_ips}
              onChange={(e) => setForm({ ...form, allowed_ips: e.target.value })}
              placeholder="0.0.0.0 — vazio aceita qualquer IP"
            />
            <p className="text-xs text-muted-foreground">
              Vazio = sem restrição de IP. Recomendado: lista o IP público do seu BI.
            </p>
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label>Incluir cadastro de pacientes</Label>
              <p className="text-xs text-muted-foreground">
                Envia o array completo de pacientes em cada snapshot.
              </p>
            </div>
            <Switch
              checked={form.include_patient_registry}
              onCheckedChange={(v) => setForm({ ...form, include_patient_registry: v })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Criar destino
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Detail panel ----------------
function DestinationDetail({
  destination,
  tokens,
  deliveries,
  scripts,
  snapshot,
  onChange,
}: {
  destination: Destination;
  tokens: Token[];
  deliveries: Delivery[];
  scripts: ScriptOption[];
  snapshot: Snapshot | null;
  onChange: () => void;
}) {
  const [forcing, setForcing] = useState(false);
  const autoTriggeredRef = useRef<string | null>(null);

  const ageMs = snapshot ? Date.now() - new Date(snapshot.updated_at).getTime() : null;
  const isStale = ageMs !== null && ageMs > STALE_THRESHOLD_MS;

  const forceRefresh = async (auto = false) => {
    setForcing(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        toast.error("Sessão expirada — faça login novamente");
        return;
      }
      const res = await fetch("/api/public/bi/force-refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ destination_id: destination.id }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        message?: string;
        error?: string;
        run_result?: unknown;
      };
      if (res.ok && body.ok) {
        toast.success(auto ? "Snapshot atualizado automaticamente" : "Snapshot atualizado");
        onChange();
      } else if (res.status === 409 && body.reason === "no_script_linked") {
        toast.warning(body.message ?? "Sem script vinculado", { duration: 8000 });
      } else {
        toast.error(body.error ?? body.message ?? `Falha (HTTP ${res.status})`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro inesperado");
    } finally {
      setForcing(false);
    }
  };

  // Auto-trigger 1x por destino quando snapshot está parado >30min e há script vinculado
  useEffect(() => {
    if (
      isStale &&
      destination.enabled &&
      destination.bi_script_id &&
      autoTriggeredRef.current !== destination.id &&
      !forcing
    ) {
      autoTriggeredRef.current = destination.id;
      forceRefresh(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination.id, isStale, destination.enabled, destination.bi_script_id]);

  const toggleEnabled = async () => {
    await supabase
      .from("bi_destinations")
      .update({ enabled: !destination.enabled })
      .eq("id", destination.id);
    onChange();
  };

  const linkScript = async (scriptId: string | null) => {
    const { error } = await supabase
      .from("bi_destinations")
      .update({ bi_script_id: scriptId })
      .eq("id", destination.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(scriptId ? "Script vinculado" : "Script desvinculado");
    onChange();
  };

  const remove = async () => {
    if (!confirm(`Remover destino "${destination.name}"? Tokens e logs serão apagados.`))
      return;
    const { error } = await supabase
      .from("bi_destinations")
      .delete()
      .eq("id", destination.id);
    if (error) toast.error(error.message);
    else {
      toast.success("Destino removido");
      onChange();
    }
  };

  const linkedScript = scripts.find((s) => s.id === destination.bi_script_id);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold">{destination.name}</h3>
            {destination.description && (
              <p className="mt-1 text-sm text-muted-foreground">
                {destination.description}
              </p>
            )}
            <div className="mt-3 space-y-1 text-xs text-muted-foreground">
              <div>
                <span className="font-medium text-foreground">URL:</span>{" "}
                <span className="font-mono">{destination.endpoint_url}</span>
              </div>
              <div>
                <span className="font-medium text-foreground">Intervalo:</span>{" "}
                {destination.push_interval_minutes} min
              </div>
              <div>
                <span className="font-medium text-foreground">IPs permitidos:</span>{" "}
                {destination.allowed_ips.length === 0
                  ? "qualquer IP"
                  : destination.allowed_ips.join(", ")}
              </div>
              {destination.source_database_name && (
                <div>
                  <span className="font-medium text-foreground">Banco origem:</span>{" "}
                  {destination.source_database_name}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <Label className="text-xs">Ativo</Label>
              <Switch checked={destination.enabled} onCheckedChange={toggleEnabled} />
            </div>
            <Button size="sm" variant="ghost" onClick={remove}>
              <Trash2 className="mr-1 h-4 w-4" />
              Excluir
            </Button>
          </div>
        </div>
        {destination.last_error && (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <span className="font-medium">Último erro:</span> {destination.last_error}
          </div>
        )}
      </div>

      {/* Script vinculado */}
      <div className="rounded-lg border bg-card p-5">
        <h4 className="font-semibold text-sm flex items-center gap-2">
          <FileCode2 className="h-4 w-4" />
          Script SQL vinculado
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Este destino só recebe snapshots quando há um script vinculado. Gerencie scripts em{" "}
          <a href="/dashboard/bi-scripts" className="underline">
            /dashboard/bi-scripts
          </a>
          .
        </p>
        {scripts.length === 0 ? (
          <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400">
            Nenhum script cadastrado. Crie um em{" "}
            <a href="/dashboard/bi-scripts" className="underline font-medium">
              Scripts BI
            </a>{" "}
            antes de vincular.
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={destination.bi_script_id ?? ""}
              onChange={(e) => linkScript(e.target.value || null)}
            >
              <option value="">— nenhum —</option>
              {scripts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.enabled ? "" : "(desativado)"}
                </option>
              ))}
            </select>
            {linkedScript ? (
              <Badge variant="outline" className="text-xs">
                Vinculado: {linkedScript.name}
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-xs">
                Sem script — snapshots não serão gerados
              </Badge>
            )}
          </div>
        )}
      </div>

      {/* Tokens */}
      <div className="rounded-lg border bg-card p-5">
        <div className="flex items-center justify-between">
          <h4 className="font-semibold text-sm flex items-center gap-2">
            <Key className="h-4 w-4" />
            API Tokens
          </h4>
          <NewTokenDialog destinationId={destination.id} onCreated={onChange} />
        </div>
        {tokens.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Nenhum token. Crie um para que o sistema autentique nos pushes.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {tokens.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-md border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{t.name}</span>
                    {t.revoked_at ? (
                      <Badge variant="secondary" className="text-xs">
                        Revogado
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">
                        Ativo
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">
                    {t.token_prefix}…
                    {t.last_used_at && (
                      <span className="ml-3">
                        último uso: {new Date(t.last_used_at).toLocaleString("pt-BR")}
                      </span>
                    )}
                  </div>
                </div>
                {!t.revoked_at && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if (!confirm("Revogar este token?")) return;
                      await supabase
                        .from("bi_destination_tokens")
                        .update({ revoked_at: new Date().toISOString() })
                        .eq("id", t.id);
                      onChange();
                    }}
                  >
                    Revogar
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Deliveries */}
      <div className="rounded-lg border bg-card p-5">
        <h4 className="font-semibold text-sm mb-3">Últimas entregas</h4>
        {deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhuma entrega registrada ainda.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quando</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>HTTP</TableHead>
                  <TableHead>Linhas</TableHead>
                  <TableHead>Tamanho</TableHead>
                  <TableHead>Duração</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="text-xs">
                      {new Date(d.created_at).toLocaleString("pt-BR")}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          d.status === "success"
                            ? "default"
                            : d.status === "error"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {d.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{d.payload_kind}</TableCell>
                    <TableCell className="text-xs">{d.http_status ?? "—"}</TableCell>
                    <TableCell className="text-xs">{d.rows_affected}</TableCell>
                    <TableCell className="text-xs">
                      {d.payload_bytes
                        ? `${(d.payload_bytes / 1024).toFixed(1)} KB`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {d.duration_ms ? `${d.duration_ms}ms` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- New token dialog ----------------
function NewTokenDialog({
  destinationId,
  onCreated,
}: {
  destinationId: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) {
      toast.error("Dê um nome ao token");
      return;
    }
    setSaving(true);
    // Generate a secure random token client-side, then store its SHA-256 hash
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const raw =
      "bi_" +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const enc = new TextEncoder().encode(raw);
    const hashBuf = await crypto.subtle.digest("SHA-256", enc);
    const hash = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const prefix = raw.slice(0, 12);

    const { error } = await supabase.from("bi_destination_tokens").insert({
      destination_id: destinationId,
      name: name.trim(),
      token_hash: hash,
      token_prefix: prefix,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setGenerated(raw);
    onCreated();
  };

  const reset = () => {
    setOpen(false);
    setTimeout(() => {
      setName("");
      setGenerated(null);
    }, 200);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : reset())}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="mr-1 h-4 w-4" />
          Novo token
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{generated ? "Token gerado" : "Novo token"}</DialogTitle>
          <DialogDescription>
            {generated
              ? "Copie e guarde agora — ele não será exibido novamente."
              : "Tokens autenticam o agente / serviços externos no push."}
          </DialogDescription>
        </DialogHeader>
        {generated ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Cole este valor exatamente como está no campo de token do BI
              (formato <code className="font-mono">DESTINATION_ID.RAW_TOKEN</code>):
            </p>
            <div className="rounded-md border bg-muted p-3 font-mono text-xs break-all">
              {destinationId}.{generated}
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                navigator.clipboard.writeText(`${destinationId}.${generated}`);
                toast.success("Copiado");
              }}
            >
              <Copy className="mr-2 h-4 w-4" />
              Copiar token completo
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Label>Nome do token</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="agente-windows-prod"
            />
          </div>
        )}
        <DialogFooter>
          {generated ? (
            <Button onClick={reset}>Pronto</Button>
          ) : (
            <>
              <Button variant="outline" onClick={reset} disabled={saving}>
                Cancelar
              </Button>
              <Button onClick={create} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Gerar
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
