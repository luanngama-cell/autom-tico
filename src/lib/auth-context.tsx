import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface AuthState {
  session: Session | null;
  user: User | null;
  isMaster: boolean;
  loading: boolean;
  roleResolved: boolean;
  roleError: string | null;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

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

  const clearStore = (store: Storage) => {
    for (const key of Object.keys(store)) {
      if (key.startsWith("sb-") || key.startsWith("sql-sync:is-master:")) {
        store.removeItem(key);
      }
    }
  };

  try {
    clearStore(window.localStorage);
    clearStore(window.sessionStorage);
  } catch {
    // ignore storage failures
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isMaster, setIsMaster] = useState(false);
  const [loading, setLoading] = useState(true);
  const [roleResolved, setRoleResolved] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const activeRoleUserIdRef = useRef<string | null>(null);
  const activeRolePromiseRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let mounted = true;

    const resetAuthState = () => {
      activeRoleUserIdRef.current = null;
      activeRolePromiseRef.current = null;

      if (!mounted) return;

      setSession(null);
      setIsMaster(false);
      setRoleResolved(false);
      setRoleError(null);
      setLoading(false);
    };

    const checkRole = async (userId: string) => {
      const hasCachedMasterRole = readCachedMasterRole(userId);

      if (mounted) {
        if (hasCachedMasterRole) {
          setIsMaster(true);
          setRoleResolved(true);
          setRoleError(null);
        } else {
          setRoleResolved(false);
        }
      }

      if (activeRoleUserIdRef.current === userId && activeRolePromiseRef.current) {
        return activeRolePromiseRef.current;
      }

      activeRoleUserIdRef.current = userId;

      const rolePromise = (async () => {
        const { data, error } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userId)
          .eq("role", "master")
          .maybeSingle();

        if (!mounted) return;

        if (error) {
          activeRoleUserIdRef.current = null;

          if (!hasCachedMasterRole) {
            setIsMaster(false);
            setRoleResolved(false);
            setRoleError("Não foi possível validar seu acesso agora. Tente novamente.");
          }

          return;
        }

        const hasMasterRole = !!data;
        writeCachedMasterRole(userId, hasMasterRole);
        setIsMaster(hasMasterRole);
        setRoleResolved(true);
        setRoleError(null);
      })().finally(() => {
        if (activeRoleUserIdRef.current === userId) {
          activeRolePromiseRef.current = null;
        }

        if (mounted) {
          setLoading(false);
        }
      });

      activeRolePromiseRef.current = rolePromise;
      return rolePromise;
    };

    const handleSession = (nextSession: Session | null) => {
      if (!mounted) return;

      setSession(nextSession);

      if (nextSession?.user) {
        setLoading(true);
        setRoleError(null);
        void checkRole(nextSession.user.id);
      } else {
        resetAuthState();
      }
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      handleSession(newSession);
    });

    supabase.auth
      .getSession()
      .then(({ data: { session: existing } }) => {
        handleSession(existing);
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
      activeRoleUserIdRef.current = null;
      activeRolePromiseRef.current = null;
      clearStoredAuthSession();
      setSession(null);
      setIsMaster(false);
      setRoleResolved(false);
      setRoleError(null);
      setLoading(false);

      if (typeof window !== "undefined") {
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
        roleResolved,
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
