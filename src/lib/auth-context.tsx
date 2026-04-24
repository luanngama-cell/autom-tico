import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface AuthState {
  session: Session | null;
  user: User | null;
  isMaster: boolean;
  loading: boolean;
  roleError: string | null;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

const projectRef =
  import.meta.env.VITE_SUPABASE_URL?.split("//")[1]?.split(".")[0] ??
  import.meta.env.VITE_SUPABASE_PROJECT_ID ??
  "project";

function roleCacheKey(userId: string) {
  return `sql-sync:is-master:${userId}`;
}

function readCachedMasterRole(userId: string) {
  if (typeof window === "undefined") return false;

  try {
    return window.localStorage.getItem(roleCacheKey(userId)) === "1";
  } catch {
    return false;
  }
}

function writeCachedMasterRole(userId: string, isMaster: boolean) {
  if (typeof window === "undefined") return;

  try {
    if (isMaster) {
      window.localStorage.setItem(roleCacheKey(userId), "1");
    } else {
      window.localStorage.removeItem(roleCacheKey(userId));
    }
  } catch {
    // ignore storage failures
  }
}

function clearStoredAuthSession() {
  if (typeof window === "undefined") return;

  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(`sb-${projectRef}-auth-token`)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // ignore storage failures
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isMaster, setIsMaster] = useState(false);
  const [loading, setLoading] = useState(true);
  const [roleError, setRoleError] = useState<string | null>(null);
  const checkedRoleUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const resetAuthState = () => {
      checkedRoleUserIdRef.current = null;
      if (!mounted) return;
      setSession(null);
      setIsMaster(false);
      setRoleError(null);
      setLoading(false);
    };

    const checkRole = async (userId: string) => {
      const hasCachedMasterRole = readCachedMasterRole(userId);

      if (hasCachedMasterRole && mounted) {
        setIsMaster(true);
        setRoleError(null);
      }

      if (checkedRoleUserIdRef.current === userId) {
        if (mounted) setLoading(false);
        return;
      }

      checkedRoleUserIdRef.current = userId;

      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .eq("role", "master")
        .maybeSingle();

      if (!mounted) return;

      if (error) {
        checkedRoleUserIdRef.current = null;
        if (!hasCachedMasterRole) {
          setIsMaster(false);
          setRoleError("Não foi possível validar seu acesso agora. Tente novamente.");
        }
        setLoading(false);
        return;
      }

      const hasMasterRole = !!data;
      writeCachedMasterRole(userId, hasMasterRole);
      setIsMaster(hasMasterRole);
      setRoleError(null);
      setLoading(false);
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!mounted) return;

      setSession(newSession);

      if (newSession?.user) {
        setLoading(true);
        setRoleError(null);
        setTimeout(() => {
          void checkRole(newSession.user.id);
        }, 0);
      } else {
        resetAuthState();
      }
    });

    supabase.auth
      .getSession()
      .then(({ data: { session: existing } }) => {
        if (!mounted) return;

        setSession(existing);

        if (existing?.user) {
          setLoading(true);
          void checkRole(existing.user.id);
        } else {
          resetAuthState();
        }
      })
      .catch(() => {
        resetAuthState();
      });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  };

  const signOut = async () => {
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // ignore remote logout failures and clear local state anyway
    } finally {
      checkedRoleUserIdRef.current = null;
      clearStoredAuthSession();
      setSession(null);
      setIsMaster(false);
      setRoleError(null);
      setLoading(false);

      if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        window.location.replace("/login");
      }
    }
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        isMaster,
        loading,
        roleError,
        signIn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
