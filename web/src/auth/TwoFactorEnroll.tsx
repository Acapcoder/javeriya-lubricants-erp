import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from './AuthContext';

/**
 * Forced enrolment for Administrator and Accountant (§6.1).
 *
 * Three steps, because a user who saves a secret their authenticator never
 * received would lock themselves out permanently:
 *   1. scan   — show the QR and the manual key
 *   2. verify — prove a live code works before anything is committed
 *   3. codes  — show recovery codes exactly once
 */
export function TwoFactorEnroll() {
  const { user, signOut, refresh } = useAuth();
  const [step, setStep] = useState<'scan' | 'codes'>('scan');
  const [secret, setSecret] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .beginEnrollment()
      .then((r) => {
        if (cancelled) return;
        setSecret(r.secret);
        setQr(r.qrDataUri);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not start setup'));
    return () => {
      cancelled = true;
    };
  }, []);

  async function onConfirm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.confirmEnrollment(code);
      setRecoveryCodes(r.recoveryCodes);
      setStep('codes');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not confirm the code');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (step === 'codes') {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1 className="auth-title">Save your recovery codes</h1>
          <p className="auth-sub">
            Each code works once, if you lose access to your authenticator. This is the only time they are shown.
          </p>

          <div className="recovery-codes">
            {recoveryCodes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>

          <button
            className="btn btn-ghost"
            style={{ width: '100%', marginBottom: 12 }}
            onClick={() => {
              void navigator.clipboard?.writeText(recoveryCodes.join('\n'));
            }}
          >
            Copy to clipboard
          </button>

          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.88rem', marginBottom: 16 }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            <span>I have saved these codes somewhere safe.</span>
          </label>

          <button className="btn btn-primary" disabled={!saved} onClick={() => void refresh()}>
            Continue to Javeriya Lubricants ERP
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={onConfirm}>
        <h1 className="auth-title">Set up two-factor authentication</h1>
        <p className="auth-sub">
          Required for the {user?.roles.includes('ADMIN') ? 'Administrator' : 'Accountant'} role, because this account
          can change financial records.
        </p>

        {error && <div className="alert alert-error">{error}</div>}

        {qr ? (
          <img className="qr" src={qr} alt="QR code for your authenticator app" width={200} height={200} />
        ) : (
          <div className="empty-state">Preparing your setup key…</div>
        )}

        <p className="field-hint" style={{ marginBottom: 6 }}>
          Scan with Google Authenticator, Microsoft Authenticator or 1Password. Cannot scan? Enter this key manually:
        </p>
        {secret && <div className="secret-manual">{secret}</div>}

        <div className="field" style={{ marginTop: 20 }}>
          <label htmlFor="code">Enter the 6-digit code to confirm</label>
          <input
            id="code"
            className="code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            value={code}
            disabled={busy || !secret}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        </div>

        <button className="btn btn-primary" type="submit" disabled={busy || code.length !== 6}>
          {busy ? 'Confirming…' : 'Confirm and enable'}
        </button>

        <p style={{ textAlign: 'center', marginTop: 16 }}>
          <button type="button" className="btn-link" onClick={() => void signOut()}>
            Sign out instead
          </button>
        </p>
      </form>
    </div>
  );
}
