import { createFileRoute, Navigate, Link, Outlet, useLocation } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Loader2, Database, Network, FileCode2, ScrollText, Settings, LogOut, Server } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard")({
  component: DashboardLayout,
});

const nav = [
  { to: "/dashboard", label: "Visão geral", icon: Network, exact: true },
  { to: "/dashboard/connections", label: "Conexões SQL", icon: Database },
  { to: "/dashboard/agent", label: "Agente Windows", icon: Server },
  { to: "/dashboard/tables", label: "Tabelas sincronizadas", icon: Database },
  { to: "/dashboard/apis", label: "APIs customizadas", icon: FileCode2 },
  { to: "/dashboard/logs", label: "Logs", icon: ScrollText },
  { to: "/dashboard/settings", label: "Configurações", icon: Settings },
];

function DashboardLayout() {
  const { session, isMaster, loading, signOut, user } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) return <Navigate to="/login" />;
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

function Overview() {
  return (
    <div className="p-8">
      <h2 className="text-3xl font-bold tracking-tight">Visão geral</h2>
      <p className="mt-2 text-muted-foreground">
        Bem-vindo ao console de sincronização SQL Server → Lovable Cloud.
      </p>
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <PlaceholderCard title="Conexões" desc="Cadastre seu SQL Server local" />
        <PlaceholderCard title="Agente" desc="Baixe e configure o agente Windows" />
        <PlaceholderCard title="APIs" desc="Construa endpoints sob seus dados" />
      </div>
    </div>
  );
}

function PlaceholderCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-lg border bg-card p-6">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
    </div>
  );
}
