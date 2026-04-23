import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/dashboard/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const { user, signOut } = useAuth();
  return (
    <div className="p-8">
      <h2 className="text-3xl font-bold tracking-tight">Configurações</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Conta e preferências do console.
      </p>

      <div className="mt-6 max-w-xl space-y-4 rounded-lg border bg-card p-6">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Email</div>
          <div className="mt-1 font-medium">{user?.email}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Função</div>
          <div className="mt-1 font-medium">master</div>
        </div>
        <Button variant="outline" onClick={signOut}>
          Sair da conta
        </Button>
      </div>
    </div>
  );
}
