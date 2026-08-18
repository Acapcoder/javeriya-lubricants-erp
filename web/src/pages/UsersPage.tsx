import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type UserRow } from '../api';
import { OperationHeader } from '../components/OperationHeader';
import { Toolbar, useSearch } from '../components/Toolbar';
import { useAuth } from '../auth/AuthContext';

/**
 * Users.
 *
 * Sign in is by username and password. Email is optional, kept only as contact
 * detail, because in a yard office not everyone has one and a login screen
 * should not require what people do not have.
 *
 * An administrator sets passwords directly. There is no reset-by-email flow for
 * the same reason: the practical mechanism here is the admin setting one and
 * telling the person. Doing so ends that user's sessions, and is logged.
 */
const ROLE_NAMES: Record<string, string> = {
  ADMIN: 'Administrator',
  ACCOUNTANT: 'Accountant',
  AUDITOR: 'Auditor',
};

export function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [form, setForm] = useState({ username: '', name: '', password: '', role: 'ACCOUNTANT', email: '' });
  const [newPassword, setNewPassword] = useState('');

  const load = useCallback(async () => {
    const r = await api.users();
    setUsers(r.users);
    setRoles(r.roles);
  }, []);

  useEffect(() => {
    void load().catch(() => setError('Only an administrator can manage users.'));
  }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.createUser({ ...form, email: form.email || null });
      setFlash(`${r.username} created. Give them the password you set.`);
      setForm({ username: '', name: '', password: '', role: 'ACCOUNTANT', email: '' });
      setShowAdd(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? detail(err) : 'Could not create that user');
    } finally {
      setBusy(false);
    }
  }

  async function setPassword(e: FormEvent) {
    e.preventDefault();
    if (!resetting) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.setUserPassword(resetting.id, newPassword);
      setFlash(`Password set for ${r.username}. They have been signed out everywhere.`);
      setResetting(null);
      setNewPassword('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? detail(err) : 'Could not set that password');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(u: UserRow) {
    setBusy(true);
    setError(null);
    try {
      await api.updateUser(u.id, { isActive: !u.isActive });
      setFlash(`${u.username} ${u.isActive ? 'disabled' : 'enabled'}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that');
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(u: UserRow, role: string) {
    setBusy(true);
    setError(null);
    try {
      await api.updateUser(u.id, { role });
      setFlash(`${u.username} is now ${ROLE_NAMES[role] ?? role}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that profile');
    } finally {
      setBusy(false);
    }
  }

  async function unlock(u: UserRow) {
    setBusy(true);
    try {
      await api.unlockUser(u.id);
      setFlash(`${u.username} can sign in again`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const matched = useSearch(users, search, (u) => [u.username, u.name, u.email, u.role]);

  return (
    <>
      <OperationHeader operation="users" title="Users" />

      {flash && <div className="alert alert-success">{flash}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {showAdd ? (
        <form className="card" onSubmit={add}>
          <h3>Add a user</h3>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="uu">Username</label>
              <input id="uu" required autoCapitalize="none" autoCorrect="off" spellCheck={false}
                placeholder="e.g. imran" value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value.toLowerCase() }))} />
              <p className="field-hint">This is what they type to sign in. Letters, numbers, dots, dashes.</p>
            </div>
            <div className="field">
              <label htmlFor="un">Full name</label>
              <input id="un" required value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="up">Password</label>
              <input id="up" type="text" required value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
              <p className="field-hint">Shown so you can read it out. At least 12 characters, with upper, lower and a digit.</p>
            </div>
            <div className="field">
              <label htmlFor="ur">Profile</label>
              <select id="ur" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
                {roles.map((r) => <option key={r} value={r}>{ROLE_NAMES[r] ?? r}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ue">Email <span className="opt">optional</span></label>
              <input id="ue" type="email" value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
              <p className="field-hint">Contact detail only. It is not used to sign in.</p>
            </div>
          </div>
          <div className="actions">
            <button className="btn btn-primary" disabled={busy || !form.username || !form.name || !form.password}>
              Create user
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="actions" style={{ border: 'none', paddingTop: 0, marginTop: 0, marginBottom: 24 }}>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>Add a user</button>
        </div>
      )}

      {resetting && (
        <form className="card" onSubmit={setPassword}>
          <h3>Set a new password for {resetting.username}</h3>
          <p className="field-hint" style={{ marginTop: -8, marginBottom: 18 }}>
            They will be signed out everywhere, and will need this password next time.
          </p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="np">New password</label>
              <input id="np" type="text" required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </div>
          </div>
          <div className="actions">
            <button className="btn btn-primary" disabled={busy || !newPassword}>Set password</button>
            <button className="btn btn-ghost" type="button" onClick={() => setResetting(null)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="card">
        <h3>Everyone with access</h3>
        <Toolbar
          search={search} onSearch={setSearch}
          placeholder="Search by username, name or profile"
          resultCount={matched.length} totalCount={users.length}
        />

        {matched.length === 0 ? (
          <div className="empty-state">No users match that search.</div>
        ) : (
          <div className="pick-list">
            {matched.map((u) => {
              const locked = u.lockedUntil && new Date(u.lockedUntil) > new Date();
              return (
                <div className="pick-row" key={u.id} style={{ cursor: 'default', flexWrap: 'wrap' }}>
                  <span className="pick-main">
                    <span className="pick-title">
                      {u.username}
                      {u.id === me?.id && <span className="pill solid" style={{ marginLeft: 8 }}>you</span>}
                      {!u.isActive && <span className="pill warn" style={{ marginLeft: 8 }}>disabled</span>}
                      {locked && <span className="pill warn" style={{ marginLeft: 8 }}>locked</span>}
                    </span>
                    <span className="pick-sub">
                      <span>{u.name}</span>
                      {u.email && <span>{u.email}</span>}
                      {u.twoFactor && <span>2FA on</span>}
                      <span>{u.lastLogin ? `last in ${String(u.lastLogin).slice(0, 10)}` : 'never signed in'}</span>
                    </span>
                  </span>

                  <div className="user-actions">
                    <select value={u.role} onChange={(e) => void changeRole(u, e.target.value)}
                      disabled={busy} aria-label={`Profile for ${u.username}`}>
                      {roles.map((r) => <option key={r} value={r}>{ROLE_NAMES[r] ?? r}</option>)}
                    </select>
                    <button className="btn btn-ghost" onClick={() => setResetting(u)} disabled={busy}>Password</button>
                    {locked && <button className="btn btn-ghost" onClick={() => void unlock(u)} disabled={busy}>Unlock</button>}
                    {u.id !== me?.id && (
                      <button className="btn btn-ghost" onClick={() => void toggleActive(u)} disabled={busy}>
                        {u.isActive ? 'Disable' : 'Enable'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

/** Password rules come back as a list; showing them beats "not strong enough". */
function detail(err: ApiError): string {
  const problems = (err.details as { problems?: string[] } | undefined)?.problems;
  return problems?.length ? `${err.message}: it ${problems.join(', ')}.` : err.message;
}
