import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from './AuthContext';

export function TwoFactorVerify() {
  const { signOut, refresh } = useAuth();
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.verifyTwoFactor(code.trim());
      if (r.usedRecoveryCode) {
        // Deliberately not silent: a burned recovery code needs replacing.
        window.alert('You signed in with a recovery code. That code is now used up.');
      }
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify that code');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={onSubmit}>
        <h1 className="auth-title">Two-factor verification</h1>
        <p className="auth-sub">
          {useRecovery
            ? 'Enter one of the recovery codes you saved during setup.'
            : 'Enter the 6-digit code from your authenticator app.'}
        </p>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="field">
          <label htmlFor="code">{useRecovery ? 'Recovery code' : 'Authentication code'}</label>
          <input
            id="code"
            className={useRecovery ? undefined : 'code-input'}
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoFocus
            maxLength={useRecovery ? 12 : 6}
            placeholder={useRecovery ? 'XXXXX-XXXXX' : '000000'}
            value={code}
            disabled={busy}
            onChange={(e) =>
              setCode(useRecovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ''))
            }
          />
        </div>

        <button
          className="btn btn-primary"
          type="submit"
          disabled={busy || (useRecovery ? code.length < 10 : code.length !== 6)}
        >
          {busy ? 'Verifying…' : 'Verify'}
        </button>

        <p style={{ textAlign: 'center', marginTop: 16, display: 'flex', gap: 16, justifyContent: 'center' }}>
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              setUseRecovery((v) => !v);
              setCode('');
              setError(null);
            }}
          >
            {useRecovery ? 'Use authenticator app' : 'Use a recovery code'}
          </button>
          <button type="button" className="btn-link" onClick={() => void signOut()}>
            Sign out
          </button>
        </p>
      </form>
    </div>
  );
}
