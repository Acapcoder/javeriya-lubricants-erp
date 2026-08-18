import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, type AccountRow, type JournalRow } from '../api';
import { Money } from '../components/Money';
import { Hint } from '../components/Hint';
import { OperationHeader } from '../components/OperationHeader';
import { Toolbar, useSearch } from '../components/Toolbar';
import { HINTS } from '../content/operations';
import { useAuth } from '../auth/AuthContext';

/**
 * The journal: the books themselves.
 *
 * Two jobs. Reading everything that has been posted, whatever created it, and
 * posting the handful of entries no document covers: opening balances,
 * accruals, corrections.
 *
 * The entry form will not submit unless debits equal credits, and control
 * accounts are not offered at all. Those are amounts owed to and by the
 * business and stock value, all maintained by the screens that own them; a
 * manual entry against one is how a control account stops agreeing with its
 * subsidiary ledger (BR-27).
 */
const today = () => new Date().toISOString().slice(0, 10);

interface Line {
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
}

const emptyLine = (): Line => ({ accountId: '', debit: '', credit: '', memo: '' });

/** Exact decimal addition, so the on-screen balance check matches the server. */
function addAll(values: string[]): string {
  let cents = 0n;
  for (const v of values) {
    const t = (v || '0').replace(/,/g, '').trim();
    if (!/^\d*(\.\d{0,2})?$/.test(t)) continue;
    const [w = '0', f = ''] = t.split('.');
    cents += BigInt(w || '0') * 100n + BigInt((f + '00').slice(0, 2) || '0');
  }
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

function difference(a: string, b: string): string {
  const cents = (v: string) => {
    const [w = '0', f = ''] = v.split('.');
    return BigInt(w) * 100n + BigInt((f + '00').slice(0, 2));
  };
  const d = cents(a) - cents(b);
  const neg = d < 0n;
  const abs = neg ? -d : d;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export function JournalPage() {
  const { can } = useAuth();
  const [entries, setEntries] = useState<JournalRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [detail, setDetail] = useState<{ entry: Record<string, unknown>; lines: Array<Record<string, unknown>> } | null>(null);

  const [writing, setWriting] = useState(false);
  const [manualOnly, setManualOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [head, setHead] = useState({ entryDate: today(), narration: '' });
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);

  const load = useCallback(async () => {
    const [j, a] = await Promise.all([api.journal({ limit: 80, manualOnly }), api.accounts()]);
    setEntries(j.entries);
    setAccounts(a.accounts);
  }, [manualOnly]);

  useEffect(() => {
    void load().catch(() => setError('Could not load the journal. Your role may not include finance access.'));
  }, [load]);

  // Control accounts are deliberately absent from the picker rather than
  // offered and then rejected on save.
  const postable = useMemo(() => accounts.filter((a) => a.isActive && !a.isControl), [accounts]);

  const totalDebit = useMemo(() => addAll(lines.map((l) => l.debit)), [lines]);
  const totalCredit = useMemo(() => addAll(lines.map((l) => l.credit)), [lines]);
  const diff = useMemo(() => difference(totalDebit, totalCredit), [totalDebit, totalCredit]);
  const balanced = diff === '0.00' && totalDebit !== '0.00';

  const filled = lines.filter((l) => l.accountId && (Number(l.debit) > 0 || Number(l.credit) > 0));
  const canPost = balanced && filled.length >= 2 && head.narration.trim().length >= 3;

  function setLine(i: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function post(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.postJournal({
        entryDate: head.entryDate,
        narration: head.narration,
        lines: filled.map((l) => ({
          accountId: Number(l.accountId),
          debit: l.debit || null,
          credit: l.credit || null,
          memo: l.memo || null,
        })),
      });
      setFlash(`${r.entryNo} posted`);
      setHead({ entryDate: today(), narration: '' });
      setLines([emptyLine(), emptyLine()]);
      setWriting(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not post this entry');
    } finally {
      setBusy(false);
    }
  }

  async function reverse(id: number) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.reverseJournal(id);
      setFlash(`Reversed as ${r.entryNo}. The original is untouched.`);
      setDetail(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reverse that entry');
    } finally {
      setBusy(false);
    }
  }

  const matched = useSearch(entries, search, (e) => [e.narration, e.entry_no, e.source_type, e.posted_by_name]);

  /* ------------------------------------------------------------ detail --- */

  if (detail) {
    const e = detail.entry as Record<string, string | boolean | null>;
    const totals = {
      debit: addAll(detail.lines.map((l) => String(l.debit ?? '0'))),
      credit: addAll(detail.lines.map((l) => String(l.credit ?? '0'))),
    };

    return (
      <>
        <div className="crumb">
          <button onClick={() => setDetail(null)}>Back to the journal</button>
        </div>

        <div className="op-head">
          <h2>{String(e.entry_no)}</h2>
          {e.is_manual ? <span className="pill">manual</span> : <span className="pill muted">{String(e.source_type)}</span>}
        </div>

        {flash && <div className="alert alert-success">{flash}</div>}
        {error && <div className="alert alert-error">{error}</div>}

        <div className="card">
          <div className="detail-grid">
            <div className="detail-item">
              <div className="detail-key">Date</div>
              <div className="detail-value">{String(e.entry_date).slice(0, 10)}</div>
            </div>
            <div className="detail-item">
              <div className="detail-key">Posted by</div>
              <div className="detail-value">{String(e.posted_by_name)}</div>
            </div>
            <div className="detail-item">
              <div className="detail-key">Total</div>
              <div className="detail-value big"><Money value={totals.debit} /></div>
            </div>
          </div>

          <p style={{ marginTop: 0, marginBottom: 22, fontSize: '1.02rem' }}>{String(e.narration ?? '')}</p>

          <table className="data ledger-table">
            <thead>
              <tr><th>Account</th><th>Note</th><th className="num">Debit</th><th className="num">Credit</th></tr>
            </thead>
            <tbody>
              {detail.lines.map((l, i) => (
                <tr key={i}>
                  <td><code>{String(l.account_code)}</code> {String(l.account_name)}</td>
                  <td>{String(l.memo ?? '')}</td>
                  <td className="num">{Number(l.debit) > 0 ? <Money value={String(l.debit)} /> : ''}</td>
                  <td className="num">{Number(l.credit) > 0 ? <Money value={String(l.credit)} /> : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Total</td>
                <td className="num"><Money value={totals.debit} /></td>
                <td className="num"><Money value={totals.credit} /></td>
              </tr>
            </tfoot>
          </table>

          <div className="rows">
            {detail.lines.map((l, i) => (
              <div className="row-card" key={i}>
                <div className="row-top">
                  <span className="row-title">{String(l.account_name)}</span>
                  <span className="row-amount">
                    {Number(l.debit) > 0 ? <Money value={String(l.debit)} /> : <>-<Money value={String(l.credit)} /></>}
                  </span>
                </div>
                <div className="row-meta">
                  <span>{String(l.account_code)}</span>
                  <span>{Number(l.debit) > 0 ? 'debit' : 'credit'}</span>
                </div>
              </div>
            ))}
          </div>

          {can('journal.manual') && !e.is_reversal_of && (
            <div className="actions">
              <button className="btn btn-ghost" disabled={busy} onClick={() => void reverse(Number(e.id))}>
                Reverse this entry
              </button>
            </div>
          )}
        </div>
      </>
    );
  }

  /* -------------------------------------------------------------- list --- */

  return (
    <>
      <OperationHeader operation="journal" />

      {flash && <div className="alert alert-success">{flash}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {can('journal.manual') &&
        (writing ? (
          <form className="card" onSubmit={post}>
            <h3>Write an entry</h3>

            <div className="form-grid">
              <div className="field">
                <label htmlFor="jd">Date</label>
                <input id="jd" type="date" max={today()} required value={head.entryDate}
                  onChange={(e) => setHead((h) => ({ ...h, entryDate: e.target.value }))} />
              </div>
              <div className="field" style={{ gridColumn: 'span 2' }}>
                <div className="label-row">
                  <label htmlFor="jn">What is this for</label>
                  <Hint text={HINTS.narration} />
                </div>
                <input id="jn" required value={head.narration}
                  onChange={(e) => setHead((h) => ({ ...h, narration: e.target.value }))} />
              </div>
            </div>

            <div className="form-section">
              <div className="section-title">Lines</div>

              <div className="jl-head">
                <span>Account</span>
                <span>Note</span>
                <span className="jl-num">Debit</span>
                <span className="jl-num">Credit</span>
                <span />
              </div>

              {lines.map((l, i) => (
                <div className="jl-row" key={i}>
                  <select value={l.accountId} onChange={(e) => setLine(i, { accountId: e.target.value })} aria-label={`Account for line ${i + 1}`}>
                    <option value="">Select an account…</option>
                    {postable.map((a) => (
                      <option key={a.id} value={a.id}>{a.code} {a.name}</option>
                    ))}
                  </select>

                  <input value={l.memo} onChange={(e) => setLine(i, { memo: e.target.value })}
                    placeholder="Optional" aria-label={`Note for line ${i + 1}`} />

                  <input className="jl-num-input" inputMode="decimal" placeholder="0.00" value={l.debit}
                    aria-label={`Debit for line ${i + 1}`}
                    onChange={(e) => setLine(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} />

                  <input className="jl-num-input" inputMode="decimal" placeholder="0.00" value={l.credit}
                    aria-label={`Credit for line ${i + 1}`}
                    onChange={(e) => setLine(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} />

                  <button type="button" className="jl-remove" aria-label={`Remove line ${i + 1}`}
                    disabled={lines.length <= 2}
                    onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}>
                    ×
                  </button>
                </div>
              ))}

              <div className="actions" style={{ border: 'none', paddingTop: 0, marginTop: 12 }}>
                <button type="button" className="btn btn-ghost" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
                  Add another line
                </button>
              </div>

              <div className={balanced ? 'jl-totals balanced' : 'jl-totals'}>
                <span>
                  Debits <strong><Money value={totalDebit} /></strong>
                </span>
                <span>
                  Credits <strong><Money value={totalCredit} /></strong>
                </span>
                <span className="jl-verdict">
                  {totalDebit === '0.00' && totalCredit === '0.00'
                    ? 'Nothing entered yet'
                    : balanced
                      ? 'Balanced'
                      : `Out by ${diff.replace('-', '')}`}
                </span>
              </div>
            </div>

            <div className="actions">
              <button className="btn btn-primary" disabled={busy || !canPost}>Post entry</button>
              <button className="btn btn-ghost" type="button" onClick={() => setWriting(false)}>Cancel</button>
            </div>

            {!balanced && totalDebit !== '0.00' && (
              <p className="field-hint warn">An entry has to balance before it can be posted.</p>
            )}
          </form>
        ) : (
          <div className="actions" style={{ border: 'none', paddingTop: 0, marginTop: 0, marginBottom: 24 }}>
            <button className="btn btn-primary" onClick={() => setWriting(true)}>Write an entry</button>
          </div>
        ))}

      <div className="card">
        <h3>The books</h3>

        <Toolbar
          search={search}
          onSearch={setSearch}
          placeholder="Search by description, entry number or who posted it"
          resultCount={matched.length}
          totalCount={entries.length}
          filters={[
            {
              label: 'Source',
              value: manualOnly ? 'manual' : '',
              onChange: (v) => setManualOnly(v === 'manual'),
              options: [
                { label: 'Everything posted', value: '' },
                { label: 'Manual entries only', value: 'manual' },
              ],
            },
          ]}
        />

        {matched.length === 0 ? (
          <div className="empty-state">
            {entries.length === 0 ? 'Nothing has been posted yet.' : 'Nothing matches that search.'}
          </div>
        ) : (
          <div className="pick-list">
            {matched.map((j) => (
              <button className="pick-row" key={j.id}
                onClick={() => void api.journalEntry(j.id).then(setDetail).catch(() => {})}>
                <span className="pick-main">
                  <span className="pick-title">{j.narration ?? j.source_type}</span>
                  <span className="pick-sub">
                    <span>{String(j.entry_date).slice(0, 10)}</span>
                    <span>{j.entry_no}</span>
                    {j.is_manual && <span className="pill">manual</span>}
                    {j.is_reversal_of && <span className="pill warn">reversal</span>}
                    <span>{j.posted_by_name}</span>
                  </span>
                </span>
                <span className="pick-amount"><Money value={j.total} /></span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
