import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/dashboard/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const { user, signOut } = useAuth();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.email) return;

    if (newPassword.length < 6) {
      toast.error("A nova senha deve ter pelo menos 6 caracteres");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("A confirmação não corresponde à nova senha");
      return;
    }
    if (oldPassword === newPassword) {
      toast.error("A nova senha deve ser diferente da atual");
      return;
    }

    setLoading(true);
    try {
      // Verifica senha antiga
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: oldPassword,
      });
      if (signInError) {
        toast.error("Senha atual incorreta");
        return;
      }

      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });
      if (updateError) {
        toast.error(updateError.message);
        return;
      }

      toast.success("Senha alterada com sucesso");
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } finally {
      setLoading(false);
    }
  };

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

      <div className="mt-6 max-w-xl rounded-lg border bg-card p-6">
        <h3 className="text-lg font-semibold">Alterar senha</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Informe sua senha atual e a nova senha.
        </p>
        <form onSubmit={handleChangePassword} className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="old-password">Senha atual</Label>
            <Input
              id="old-password"
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password">Nova senha</Label>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirmar nova senha</Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? "Alterando..." : "Alterar senha"}
          </Button>
        </form>
      </div>
    </div>
  );
}
