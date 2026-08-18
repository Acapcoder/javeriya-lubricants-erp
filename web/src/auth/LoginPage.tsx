import { useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import { useAuth } from './AuthContext';
import { Logo } from '../components/Logo';

export function LoginPage() {
  const { signIn } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(username, password);
    } catch (err) {
      // The server deliberately returns the same message for an unknown email
      // and a wrong password, so this text must not try to be more specific.
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={onSubmit}>
        <Logo variant="auth" />
        <p className="auth-sub" style={{ textAlign: 'center', marginTop: -8, marginBottom: 24 }}>
          UCO · UEO · Recycling &amp; Water Treatment
        </p>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            autoFocus
            value={username}
            disabled={busy}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <button className="btn btn-primary" type="submit" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="field-hint" style={{ marginTop: 16, textAlign: 'center' }}>
          Five failed attempts lock the account for 15 minutes.
        </p>
      </form>
    </div>
  );
}
