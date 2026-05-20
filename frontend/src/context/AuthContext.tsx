// ============================================================================
// AuthContext — sessão do user logado.
//
// Estados:
//   undefined  → ainda checando /auth/me (mostra Splash)
//   null       → não autenticado (mostra <Login />)
//   AuthUser   → autenticado (mostra o app)
// ============================================================================

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthUser } from '../types/api';
import { api } from '../lib/api';

interface AuthState {
  user: AuthUser | null | undefined;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setUser(me);
    } catch {
      setUser(null);
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const u = await api.login(email, password);
    setUser(u);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  // Boot: pega o user atual.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Escuta o evento global do interceptor 401 — zera o user e força login.
  useEffect(() => {
    const handler = () => setUser(null);
    window.addEventListener('auth:expired', handler);
    return () => window.removeEventListener('auth:expired', handler);
  }, []);

  const value = useMemo(() => ({ user, refresh, login, logout }), [user, refresh, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth fora do AuthProvider');
  return v;
}
