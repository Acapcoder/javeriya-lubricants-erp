import { useCallback, useEffect, useState } from 'react';
import { api, type AccountRow, type JournalRow, type LedgerView } from '../api';
import { Money } from '../components/Money';
import { Hint } from '../components/Hint';
import { OperationHeader } from '../components/OperationHeader';
import { HINTS } from '../content/operations';

/**
 * Finance in full.
 *
 * Four views on the same ledger, because they answer four different questions:
 *   Balances       what have we got, right now
 *   Account        where did one account's balance come from
 *   Trial balance  do the books hold together
 *   Journal        what has been posted, and by whom
 *
 * Nothing here is editable. Every figure traces back to a document, and the
 * way to change one is to correct that document.
 */
type View = 'balances' | 'account' | 'trial' | 'journal';

export function FinancePage() {
  const [view, setView] = useState<View>('balances');

  const [cash, setCash] = useState<Awaited<ReturnType<typeof api.cashBank>> | null>(null);
  const [trial, setTrial] = useState<Awaited<ReturnType<typeof api.trialBalance>> | null>(null);
  const [journal, setJournal] = useState<JournalRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [ledger, setLedger] = useState<LedgerView | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([api.cashBank(), api.accounts()]);
      setCash(c);
      setAccounts(a.accounts);
      if (accountId === null && c.accounts[0]) setAccountId(c.accounts[0].accountId);
    } catch {
      setError('Could not load the finance data. Your role may not include finance access.');
    }
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (view === 'trial' && !trial) void api.trialBalance().then(setTrial).catch(() => {});
    if (view === 'journal' && journal.length === 0) void api.journal({ limit: 60 }).then((r) => setJournal(r.entries)).catch(() => {});
  }, [view, trial, journal.length]);

  useEffect(() => {
    if (view === 'account' && accountId) void api.ledger(accountId).then(setLedger).catch(() => setLedger(null));
  }, [view, accountId]);

  return (
    <>
      <OperationHeader operation="finance" />
      {error && <div className="alert alert-error">{error}</div>}

      <div className="choices">
        <ViewTab id="balances" now={view} set={setView} title="Balances" hint="What you hold right now" />
        <ViewTab id="account" now={view} set={setView} title="Account" hint="Every movement, in order" />
        <ViewTab id="trial" now={view} set={setView} title="Trial balance" hint="Do the books agree" />
        <ViewTab id="journal" now={view} set={setView} title="Journal" hint="What has been posted" />
      </div>

      {/* ------------------------------------------------------- balances */}
      {view === 'balances' && cash && (
        <>
          <div className="card-grid">
            <div className="card">
              <h3>Cash in hand</h3>
              <div className="stat"><Money value={cash.totals.cash} /></div>
              <div className="stat-label">across every cash box</div>
            </div>
            <div className="card">
              <h3>In the bank</h3>
              <div className="stat"><Money value={cash.totals.bank} /></div>
              <div className="stat-label">across every bank account</div>
            </div>
            <div className="card">
              <h3>Total held</h3>
              <div className="stat"><Money value={cash.totals.combined} /></div>
              <div className="stat-label">cash and bank together</div>
            </div>
          </div>

          <div className="card">
            <h3>Each account</h3>
            <div className="pick-list">
              {cash.accounts.map((a) => (
                <button className="pick-row" key={a.accountId}
                  onClick={() => { setAccountId(a.accountId); setView('account'); }}>
                  <span className="pick-main">
                    <span className="pick-title">{a.name}</span>
                    <span className="pick-sub">
                      <span>{a.code}</span>
                      <span className="pill muted">{a.subtype === 'CASH' ? 'cash' : 'bank'}</span>
                    </span>
                  </span>
                  <span className="pick-amount"><Money value={a.balance} /></span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* -------------------------------------------------------- account */}
      {view === 'account' && (
        <>
          <div className="card">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="acc">Which account?</label>
              <select id="acc" value={accountId ?? ''} onChange={(e) => setAccountId(Number(e.target.value))}>
                {accounts.filter((a) => a.isActive).map((a) => (
                  <option key={a.id} value={a.id}>{a.code} {a.name}</option>
                ))}
              </select>
            </div>
          </div>

          {ledger && (
            <div className="card">
              <h3>{ledger.account.code} {ledger.account.name}</h3>
              <div className="detail-grid" style={{ marginBottom: 24 }}>
                <div className="detail-item">
                  <div className="detail-key">Opening</div>
                  <div className="detail-value"><Money value={ledger.openingBalance} /></div>
                </div>
                <div className="detail-item">
                  <div className="detail-key">Closing</div>
                  <div className="detail-value big"><Money value={ledger.closingBalance} /></div>
                </div>
                <div className="detail-item">
                  <div className="detail-key">Movements</div>
                  <div className="detail-value">{ledger.rows.length}</div>
                </div>
              </div>

              {ledger.rows.length === 0 ? (
                <div className="empty-state">Nothing has moved through this account yet.</div>
              ) : (
                <>
                  <div className="rows">
                    {ledger.rows.map((r) => (
                      <div className="row-card" key={r.lineId}>
                        <div className="row-top">
                          <span className="row-title">{r.description || r.entryNo}</span>
                          <span className="row-amount">
                            {Number(r.debit) > 0 ? <Money value={r.debit} /> : <>-<Money value={r.credit} /></>}
                          </span>
                        </div>
                        <div className="row-meta">
                          <span>{r.date}</span>
                          <span>{r.entryNo}</span>
                          <span>balance <Money value={r.balance} /></span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <table className="data ledger-table">
                    <thead>
                      <tr>
                        <th>Date</th><th>Entry</th><th>Description</th>
                        <th className="num">In</th><th className="num">Out</th>
                        <th className="num">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.rows.map((r) => (
                        <tr key={r.lineId}>
                          <td>{r.date}</td>
                          <td><code>{r.entryNo}</code></td>
                          <td>{r.description}</td>
                          <td className="num">{Number(r.debit) > 0 ? <Money value={r.debit} /> : ''}</td>
                          <td className="num">{Number(r.credit) > 0 ? <Money value={r.credit} /> : ''}</td>
                          <td className="num"><Money value={r.balance} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* --------------------------------------------------- trial balance */}
      {view === 'trial' && trial && (
        <div className="card">
          <h3>Trial balance<Hint text={HINTS.trialBalance} /></h3>

          <div className={trial.totals.balanced ? 'alert alert-success' : 'alert alert-error'}>
            {trial.totals.balanced
              ? 'The books balance. Total debits equal total credits exactly.'
              : `The books are out by ${trial.totals.difference}. This should be impossible, so report it.`}
          </div>

          {trial.rows.length === 0 ? (
            <div className="empty-state">Nothing has been posted yet.</div>
          ) : (
            <>
              <div className="rows">
                {trial.rows.map((r) => (
                  <div className="row-card" key={r.code}>
                    <div className="row-top">
                      <span className="row-title">{r.name}</span>
                      <span className="row-amount"><Money value={r.balance} /></span>
                    </div>
                    <div className="row-meta">
                      <span>{r.code}</span>
                      <span className="pill muted">{r.type.toLowerCase()}</span>
                    </div>
                  </div>
                ))}
              </div>

              <table className="data ledger-table">
                <thead>
                  <tr>
                    <th>Code</th><th>Account</th><th>Kind</th>
                    <th className="num">Debit<Hint text={HINTS.debit} below /></th>
                    <th className="num">Credit<Hint text={HINTS.credit} below /></th>
                  </tr>
                </thead>
                <tbody>
                  {trial.rows.map((r) => (
                    <tr key={r.code}>
                      <td><code>{r.code}</code></td>
                      <td>{r.name}</td>
                      <td>{r.type.toLowerCase()}</td>
                      <td className="num">{Number(r.debit) > 0 ? <Money value={r.debit} /> : ''}</td>
                      <td className="num">{Number(r.credit) > 0 ? <Money value={r.credit} /> : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>Total</td>
                    <td className="num"><Money value={trial.totals.debit} /></td>
                    <td className="num"><Money value={trial.totals.credit} /></td>
                  </tr>
                </tfoot>
              </table>
            </>
          )}
        </div>
      )}

      {/* -------------------------------------------------------- journal */}
      {view === 'journal' && (
        <div className="card">
          <h3>Everything posted</h3>
          {journal.length === 0 ? (
            <div className="empty-state">Nothing has been posted yet.</div>
          ) : (
            <>
              <div className="rows">
                {journal.map((j) => (
                  <div className="row-card" key={j.id}>
                    <div className="row-top">
                      <span className="row-title">{j.narration ?? j.source_type}</span>
                      <span className="row-amount"><Money value={j.total} /></span>
                    </div>
                    <div className="row-meta">
                      <span>{String(j.entry_date).slice(0, 10)}</span>
                      <span>{j.entry_no}</span>
                      {j.is_manual && <span className="pill">manual</span>}
                      {j.is_reversal_of && <span className="pill warn">reversal</span>}
                      <span>{j.posted_by_name}</span>
                    </div>
                  </div>
                ))}
              </div>

              <table className="data ledger-table">
                <thead>
                  <tr><th>Entry</th><th>Date</th><th>Description</th><th>Source</th><th>Posted by</th><th className="num">Amount</th></tr>
                </thead>
                <tbody>
                  {journal.map((j) => (
                    <tr key={j.id}>
                      <td><code>{j.entry_no}</code></td>
                      <td>{String(j.entry_date).slice(0, 10)}</td>
                      <td>
                        {j.narration}
                        {j.is_manual && <span className="pill" style={{ marginLeft: 8 }}>manual</span>}
                        {j.is_reversal_of && <span className="pill warn" style={{ marginLeft: 8 }}>reversal</span>}
                      </td>
                      <td>{j.source_type}</td>
                      <td>{j.posted_by_name}</td>
                      <td className="num"><Money value={j.total} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </>
  );
}

function ViewTab({
  id, now, set, title, hint,
}: {
  id: View; now: View; set: (v: View) => void; title: string; hint: string;
}) {
  return (
    <button className={now === id ? 'choice active' : 'choice'} onClick={() => set(id)}>
      <span className="choice-title">{title}</span>
      <span className="choice-hint">{hint}</span>
    </button>
  );
}
