import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Overview } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Money } from '../components/Money';
import { Icon, type IconName } from '../components/Icon';

/**
 * Home: what is true right now, and the day's work one tap away.
 *
 * The quick tiles are all equal. An earlier version highlighted "Record oil in"
 * as though it were selected, which read as state rather than as a link; these
 * are navigation, so none of them is preselected.
 */

interface Quick {
  to: string;
  icon: IconName;
  title: string;
  sub: string;
  permission?: string;
}

const QUICK: Quick[] = [
  { to: '/purchases', icon: 'buy', title: 'Record oil in', sub: 'Purchases and collections' },
  { to: '/sales', icon: 'sell', title: 'Record oil out', sub: 'Exports and local sales' },
  { to: '/inventory', icon: 'stock', title: 'Stock', sub: 'What is in the yard' },
  { to: '/drivers', icon: 'truck', title: 'Drivers', sub: 'Advances and collections' },
  { to: '/finance/ledgers', icon: 'wallet', title: 'Cash and bank', sub: 'Balances and movements', permission: 'finance.view' },
  { to: '/reports/operations', icon: 'reports', title: 'Reports', sub: 'Totals and trends', permission: 'reports.view' },
];

export function DashboardPage() {
  const { user, can } = useAuth();
  const [ov, setOv] = useState<Overview | null>(null);
  const [cash, setCash] = useState<{ cash: string; bank: string; combined: string } | null>(null);

  useEffect(() => {
    void api.overview().then(setOv).catch(() => {});
    if (can('finance.view')) void api.cashBank().then((r) => setCash(r.totals)).catch(() => {});
  }, [can]);

  const firstName = (user?.name ?? '').split(' ')[0];
  const tiles = QUICK.filter((q) => !q.permission || can(q.permission));

  const uco = ov?.byDivision.find((d) => d.division === 'UCO');
  const ueo = ov?.byDivision.find((d) => d.division === 'UEO');

  return (
    <>
      <div className="op-head">
        <h2>
          {greeting()}
          {firstName ? `, ${firstName}` : ''}
        </h2>
      </div>

      <div className="quick-grid">
        {tiles.map((q) => (
          <Link className="quick" to={q.to} key={q.to}>
            <span className="quick-icon">
              <Icon name={q.icon} size={22} />
            </span>
            <span className="quick-title">{q.title}</span>
            <span className="quick-sub">{q.sub}</span>
          </Link>
        ))}
      </div>

      {/* ---- today and this month ---- */}
      <div className="card-grid">
        <div className="card">
          <h3>Today</h3>
          <div className="stat">{trim(ov?.today.drums ?? '0')}</div>
          <div className="stat-label">drums in, across {Number(ov?.today.loads ?? 0)} loads</div>
          <div style={{ marginTop: 14, fontSize: '0.9rem', color: 'var(--fg-muted)' }}>
            Worth <Money value={ov?.today.value} />
          </div>
        </div>

        <div className="card">
          <h3>This month</h3>
          <div className="stat">{trim(ov?.month.drums ?? '0')}</div>
          <div className="stat-label">drums in, across {Number(ov?.month.loads ?? 0)} loads</div>
          <div style={{ marginTop: 14, fontSize: '0.9rem', color: 'var(--fg-muted)' }}>
            Worth <Money value={ov?.month.value} />
          </div>
        </div>

        {cash && (
          <div className="card">
            <h3>Cash and bank</h3>
            <div className="stat">
              <Money value={cash.combined} />
            </div>
            <div className="stat-label">across all accounts</div>
            <div style={{ marginTop: 14, fontSize: '0.9rem', color: 'var(--fg-muted)' }}>
              Cash <Money value={cash.cash} /> · Bank <Money value={cash.bank} />
            </div>
          </div>
        )}

        {ov && Number(ov.driverAdvances.out_with_drivers) > 0 && (
          <div className="card">
            <h3>Out with drivers</h3>
            <div className="stat">
              <Money value={ov.driverAdvances.out_with_drivers} />
            </div>
            <div className="stat-label">
              held by {Number(ov.driverAdvances.count)}{' '}
              {Number(ov.driverAdvances.count) === 1 ? 'driver' : 'drivers'}
            </div>
            <div style={{ marginTop: 14, fontSize: '0.9rem', color: 'var(--fg-muted)' }}>
              Still yours until oil arrives
            </div>
          </div>
        )}
      </div>

      {/* ---- stock ---- */}
      <div className="card">
        <h3>Stock on hand</h3>
        <div className="pick-list">
          {(ov?.stock ?? []).map((s) => (
            <div className="pick-row" key={s.code} style={{ cursor: 'default' }}>
              <span className="pick-main">
                <span className="pick-title">{s.name}</span>
                <span className="pick-sub">
                  <span>{trim(s.quantity)} drums</span>
                  {s.low && <span className="pill warn">running low</span>}
                </span>
              </span>
              <span className="pick-amount">
                <Money value={s.value} />
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ---- year to date, by division ---- */}
      {ov && (uco || ueo) && (
        <div className="card">
          <h3>This year, by oil</h3>
          <table className="data ledger-table">
            <thead>
              <tr>
                <th>Oil</th>
                <th className="num">Loads</th>
                <th className="num">Drums</th>
                <th className="num">Value</th>
                <th className="num">Still owed</th>
              </tr>
            </thead>
            <tbody>
              {ov.byDivision.map((d) => (
                <tr key={d.division}>
                  <td>{d.division === 'UCO' ? 'Cooking oil' : 'Engine oil'}</td>
                  <td className="num">{Number(d.loads)}</td>
                  <td className="num">{trim(d.drums)}</td>
                  <td className="num">
                    <Money value={d.value} />
                  </td>
                  <td className="num">{Number(d.outstanding) > 0 ? <Money value={d.outstanding} /> : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="rows">
            {ov.byDivision.map((d) => (
              <div className="row-card" key={d.division}>
                <div className="row-top">
                  <span className="row-title">{d.division === 'UCO' ? 'Cooking oil' : 'Engine oil'}</span>
                  <span className="row-amount">
                    <Money value={d.value} />
                  </span>
                </div>
                <div className="row-meta">
                  <span>{Number(d.loads)} loads</span>
                  <span>{trim(d.drums)} drums</span>
                  {Number(d.outstanding) > 0 && (
                    <span>
                      owed <Money value={d.outstanding} />
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- who owes what ---- */}
      {ov && can('finance.view') && (Number(ov.owed.payable) > 0 || Number(ov.owed.receivable) > 0) && (
        <div className="card-grid">
          <div className="card">
            <h3>You owe suppliers</h3>
            <div className="stat">
              <Money value={ov.owed.payable} />
            </div>
            <div className="stat-label">unpaid purchases</div>
          </div>
          <div className="card">
            <h3>Owed to you</h3>
            <div className="stat">
              <Money value={ov.owed.receivable} />
            </div>
            <div className="stat-label">unpaid sales</div>
          </div>
        </div>
      )}
    </>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function trim(q: string): string {
  return String(q).replace(/\.0+$/, '');
}
