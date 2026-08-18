import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, type ApiUser, type LoginStatus } from '../api';

/**
 * Auth state machine.
 *
 *   loading -> anonymous -> two-factor-enroll ┐
 *                        -> two-factor-verify ┼-> authenticated
 *                        -> authenticated ────┘
 *
 * The server decides which stage applies; the client only renders it. That way
 * a permission or 2FA policy change takes effect without a frontend release.
 */
export type AuthStage =
  | 'loading'
  | 'anonymous'
  | 'two-factor-enroll'
  | 'two-factor-verify'
  | 'authenticated';

interface AuthState {
  stage: AuthStage;
  user: ApiUser | null;
  signIn(username: string, password: string): Promise<LoginStatus>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
  can(permission: string): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<AuthStage>('loading');
  const [user, setUser] = useState<ApiUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { user: u, session } = await api.me();
      setUser(u);
      if (session.twoFactorEnrollmentRequired) setStage('two-factor-enroll');
      else if (!session.twoFactorOk) setStage('two-factor-verify');
      else setStage('authenticated');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // A session may exist but be mid-2FA; the error code says which.
        if (err.code === 'TWO_FACTOR_ENROLLMENT_REQUIRED') return setStage('two-factor-enroll');
        if (err.code === 'TWO_FACTOR_REQUIRED') return setStage('two-factor-verify');
      }
      setUser(null);
      setStage('anonymous');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async (username: string, password: string) => {
    const res = await api.login(username, password);
    setUser(res.user);
    setStage(
      res.status === 'AUTHENTICATED'
        ? 'authenticated'
        : res.status === 'TWO_FACTOR_ENROLLMENT_REQUIRED'
          ? 'two-factor-enroll'
          : 'two-factor-verify'
    );
    return res.status;
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    setUser(null);
    setStage('anonymous');
  }, []);

  const can = useCallback(
    (permission: string) => user?.permissions.includes(permission) ?? false,
    [user]
  );

  const value = useMemo<AuthState>(
    () => ({ stage, user, signIn, signOut, refresh, can }),
    [stage, user, signIn, signOut, refresh, can]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
