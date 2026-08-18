import { useEffect, useState } from 'react';
import { api, type PermissionMeta, type Profile } from '../api';
import { Hint } from '../components/Hint';
import { OperationHeader } from '../components/OperationHeader';
import { useAuth } from '../auth/AuthContext';

/**
 * The profiles this system has.
 *
 * Read from the database rather than a list typed into this file, so what is
 * shown here is what is actually enforced. If the two ever disagree, this
 * screen shows the truth.
 */

const GROUP_LABELS: Record<string, string> = {
  operations: 'Day to day work',
  finance: 'Money',
  inventory: 'Stock',
  reports: 'Reports',
  masters: 'Drivers and suppliers',
  admin: 'Administration',
};

const PLAIN_ENGLISH: Record<string, string> = {
  'operations.view': 'See purchases, sales and stock',
  'operations.create': 'Record new purchases and sales',
  'operations.update': 'Correct a record that was entered wrongly',
  'operations.delete': 'Delete a record entirely',
  'finance.view': 'See cash, bank and the accounts',
  'finance.manage': 'Record expenses, payments and salaries',
  'journal.manual': 'Post a direct accounting entry',
  'inventory.backdate': 'Enter stock for an earlier date',
  'inventory.adjust': 'Correct a stock count by hand',
  'profit.view': 'See profit and margins',
  'reports.view': 'Open reports',
  'reports.export': 'Export reports to PDF or Excel',
  'masters.manage': 'Add and edit drivers, suppliers and staff',
  'users.manage': 'Add users and change what they can do',
  'settings.manage': 'Change company settings',
  'activity_log.view': 'See who changed what',
  'activity_log.delete': 'Delete entries from the activity log',
  'backup.run': 'Take a backup',
  'backup.restore': 'Restore from a backup',
  'year.lock': 'Close a financial year, or reopen one',
};

export function ProfilesPage() {
  const { user } = useAuth();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [permissions, setPermissions] = useState<PermissionMeta[]>([]);

  useEffect(() => {
    void api.profiles().then((r) => { setProfiles(r.profiles); setPermissions(r.permissions); }).catch(() => {});
  }, []);

  const groups = [...new Set(permissions.map((p) => p.group))];
  const mine = user?.roles ?? [];

  return (
    <>
      <OperationHeader operation="profiles" />

      <div className="card-grid">
        {profiles.map((p) => (
          <div className="card" key={p.code}>
            <h3>
              {p.name}
              {mine.includes(p.code) && <span className="pill solid" style={{ marginLeft: 8 }}>you</span>}
            </h3>
            <div className="stat">{p.permissions.length}</div>
            <div className="stat-label">of {permissions.length} things they can do</div>
            <p style={{ fontSize: '0.92rem', color: 'var(--fg-muted)', marginTop: 14, marginBottom: 12 }}>
              {p.description}
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span className="pill muted">{p.userCount} {p.userCount === 1 ? 'user' : 'users'}</span>
              {p.requiresTwoFactor && <span className="pill">needs 2FA</span>}
              {p.permissions.includes('operations.delete') && <span className="pill">can delete</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="alert alert-info">
        The Accountant does everything the Administrator does, except delete. Deleting is the one action that rewrites
        history, so it stays with one person. An Accountant who needs a record undone reverses it instead, which leaves
        the trail intact.
      </div>

      <div className="card">
        <h3>
          Exactly what each profile can do
          <Hint text="A tick means that profile is allowed to do that. This comes from the live permission list, not from a document." />
        </h3>

        {/* Phones: one block per profile. */}
        <div className="rows">
          {profiles.map((p) => (
            <div className="row-card" key={p.code}>
              <div className="row-top">
                <span className="row-title">{p.name}</span>
                <span className="pill muted">{p.permissions.length}</span>
              </div>
              <div style={{ marginTop: 10 }}>
                {groups.map((g) => {
                  const held = permissions.filter((x) => x.group === g && p.permissions.includes(x.code));
                  if (held.length === 0) return null;
                  return (
                    <div key={g} style={{ marginBottom: 10 }}>
                      <div className="detail-key">{GROUP_LABELS[g] ?? g}</div>
                      <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.89rem', color: 'var(--fg-muted)' }}>
                        {held.map((x) => (
                          <li key={x.code}>{PLAIN_ENGLISH[x.code] ?? x.label}</li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Tablet and up: the full matrix. */}
        <table className="data">
          <thead>
            <tr>
              <th>What they can do</th>
              {profiles.map((p) => (
                <th key={p.code} style={{ textAlign: 'center' }}>{p.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <>
                <tr key={g}>
                  <td colSpan={profiles.length + 1} style={{ fontWeight: 650, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--fg-faint)' }}>
                    {GROUP_LABELS[g] ?? g}
                  </td>
                </tr>
                {permissions.filter((p) => p.group === g).map((perm) => (
                  <tr key={perm.code}>
                    <td>{PLAIN_ENGLISH[perm.code] ?? perm.label}</td>
                    {profiles.map((p) => (
                      <td key={p.code} style={{ textAlign: 'center', fontWeight: 700 }}>
                        {p.permissions.includes(perm.code) ? 'Yes' : ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
