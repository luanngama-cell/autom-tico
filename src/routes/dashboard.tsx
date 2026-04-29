import { createFileRoute, Navigate, Link, Outlet, useLocation } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  Database,
  Network,
  FileCode2,
  ScrollText,
  Settings,
  LogOut,
  Server,
  Webhook,
  CheckCircle2,
  AlertCircle,
  Activity,
  Rows,
  Clock,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getOverviewStats } from "@/utils/overview.functions";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/dashboard")({
  component: DashboardLayout,
});

const nav = [
  { to: "/dashboard", label: "Visão geral", icon: Network, exact: true },
  { to: "/dashboard/connections", label: "Conexões SQL", icon: Database },
  { to: "/dashboard/agent", label: "Agente Windows", icon: Server },
  { to: "/dashboard/tables", label: "Tabelas sincronizadas", icon: Database },
  { to: "/dashboard/apis", label: "APIs customizadas", icon: FileCode2 },
  { to: "/dashboard/bi-scripts", label: "Scripts BI", icon: Webhook },
  { to: "/dashboard/logs", label: "Logs", icon: ScrollText },
  { to: "/dashboard/settings", label: "Configurações", icon: Settings },
];

function DashboardLayout() {
  const { session, isMaster, loading, roleResolved, roleError, signOut, user } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) return <Navigate to="/login" />;
  if (roleError) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-bold">Falha ao validar acesso</h1>
          <p className="mt-2 text-sm text-muted-foreground">{roleError}</p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button variant="outline" onClick={() => window.location.reload()}>
              Tentar novamente
            </Button>
            <Button onClick={signOut}>Sair</Button>
          </div>
        </div>
      </div>
    );
  }
  if (!roleResolved) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!isMaster) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-bold">Acesso negado</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sua conta não possui a função master.
          </p>
          <Button className="mt-4" variant="outline" onClick={signOut}>
            Sair
          </Button>
        </div>
      </div>
    );
  }

  const isOverview = location.pathname === "/dashboard" || location.pathname === "/dashboard/";

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="flex w-64 flex-col border-r bg-card">
        <div className="border-b px-6 py-5">
          <h1 className="text-lg font-semibold tracking-tight">SQL Sync</h1>
          <p className="text-xs text-muted-foreground">Cloud Mirror Console</p>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {nav.map((item) => {
            const active = item.exact
              ? location.pathname === item.to || location.pathname === item.to + "/"
              : location.pathname.startsWith(item.to);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t p-3">
          <div className="px-3 pb-2 text-xs text-muted-foreground">{user?.email}</div>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={signOut}>
            <LogOut className="mr-2 h-4 w-4" />
            Sair
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        {isOverview ? <Overview /> : <Outlet />}
      </main>
    </div>
  );
}

type OverviewData = Awaited<ReturnType<typeof getOverviewStats>>;

function Overview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Sessão expirada");
      const result = await getOverviewStats({
        headers: { authorization: `Bearer ${token}` },
      });
      setData(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    const i = setInterval(load, 15000);
    return () => clearInterval(i);
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-8">
        <p className="text-sm text-destructive">Erro: {error}</p>
      </div>
    );
  }

  const { stats, connections, tableErrors, recentLogs, activity, biDestinations, biStats } = data;
  const conn = connections[0];
  const lastSyncDate = stats.lastSync ? new Date(stats.lastSync) : null;
  const minutesAgo = lastSyncDate
    ? Math.floor((Date.now() - lastSyncDate.getTime()) / 60000)
    : null;
  const maxBucket = Math.max(1, ...activity.map((a) => a.rows));

  const formatAge = (ms: number | null) => {
    if (ms === null) return "—";
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
    return `${Math.floor(ms / 86_400_000)}d`;
  };

  const connStatusLabel: Record<string, string> = {
    online: "online",
    stale: "atrasado",
    offline: "offline",
  };
  const connStatusClass: Record<string, string> = {
    online: "bg-emerald-500 animate-pulse",
    stale: "bg-amber-500",
    offline: "bg-destructive",
  };

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Visão geral</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Atualizado automaticamente a cada 15 segundos.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setRefreshing(true);
            load();
          }}
          disabled={refreshing}
        >
          <RefreshCw className={cn("mr-2 h-4 w-4", refreshing && "animate-spin")} />
          Atualizar
        </Button>
      </div>

      {conn && (
        <div className="rounded-lg border bg-card p-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-3 w-3 rounded-full",
                conn.status === "online"
                  ? "bg-emerald-500 animate-pulse"
                  : "bg-muted-foreground"
              )}
            />
            <div>
              <div className="font-semibold">{conn.name}</div>
              <div className="text-xs text-muted-foreground">
                {conn.host} · {conn.database_name}
              </div>
            </div>
          </div>
          <Badge variant={conn.status === "online" ? "default" : "secondary"}>
            {conn.status}
          </Badge>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard
          icon={Database}
          label="Tabelas sincronizadas"
          value={`${stats.syncedTables} / ${stats.totalTables}`}
        />
        <StatCard
          icon={Rows}
          label="Total de linhas"
          value={stats.totalRows.toLocaleString("pt-BR")}
        />
        <StatCard
          icon={Clock}
          label="Último sync"
          value={
            minutesAgo === null
              ? "—"
              : minutesAgo < 1
                ? "agora"
                : `há ${minutesAgo} min`
          }
        />
        <StatCard
          icon={stats.errorTables > 0 ? AlertCircle : CheckCircle2}
          label="Tabelas com erro"
          value={stats.errorTables.toString()}
          tone={stats.errorTables > 0 ? "danger" : "ok"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-semibold text-sm">Atividade (últimas 6h)</h3>
          </div>
          {activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem atividade.</p>
          ) : (
            <div className="flex h-32 items-end gap-1">
              {activity.map((b) => (
                <div
                  key={b.ts}
                  className="flex-1 bg-primary/80 rounded-t hover:bg-primary transition-colors"
                  style={{ height: `${(b.rows / maxBucket) * 100}%` }}
                  title={`${new Date(b.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} — ${b.rows.toLocaleString("pt-BR")} linhas`}
                />
              ))}
            </div>
          )}
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>6h atrás</span>
            <span>agora</span>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-5">
          <h3 className="font-semibold text-sm mb-4">Tabelas com erro</h3>
          {tableErrors.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-emerald-600">
              <CheckCircle2 className="h-4 w-4" />
              Nenhum erro nos últimos ciclos.
            </div>
          ) : (
            <div className="space-y-2 max-h-40 overflow-auto">
              {tableErrors.map((t, i) => (
                <div key={i} className="text-xs border-l-2 border-destructive pl-2">
                  <div className="font-mono font-medium">
                    {t.schema_name}.{t.table_name}
                  </div>
                  <div className="text-muted-foreground truncate">
                    {t.last_error}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border bg-card p-5">
        <h3 className="font-semibold text-sm mb-4">Eventos recentes</h3>
        <div className="space-y-2 max-h-72 overflow-auto">
          {recentLogs.map((log) => (
            <div
              key={log.id}
              className="flex items-start gap-3 text-xs border-b border-border/50 pb-2 last:border-0"
            >
              <span
                className={cn(
                  "mt-1 h-2 w-2 rounded-full shrink-0",
                  log.level === "error"
                    ? "bg-destructive"
                    : log.level === "warn"
                      ? "bg-amber-500"
                      : "bg-emerald-500"
                )}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium">{log.event}</span>
                  {log.duration_ms != null && (
                    <span className="text-muted-foreground">
                      {log.duration_ms}ms
                    </span>
                  )}
                </div>
                {log.message && (
                  <div className="text-muted-foreground truncate">
                    {log.message}
                  </div>
                )}
              </div>
              <span className="text-muted-foreground shrink-0">
                {new Date(log.created_at).toLocaleTimeString("pt-BR")}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone?: "ok" | "danger";
}) {
  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon
          className={cn(
            "h-4 w-4",
            tone === "danger" && "text-destructive",
            tone === "ok" && "text-emerald-500"
          )}
        />
        {label}
      </div>
      <div className="mt-2 text-2xl font-bold tracking-tight">{value}</div>
    </div>
  );
}

