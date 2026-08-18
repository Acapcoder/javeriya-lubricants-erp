import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, type OpenDocument, type Party, type PaymentRow } from '../api';
import { Money } from '../components/Money';
import { OperationHeader } from '../components/OperationHeader';
import { Toolbar, useSearch } from '../components/Toolbar';

/**
 * Settling up.
 *
 * Choosing a supplier lists what is still open against them, oldest first, and
 * the amount entered is applied down that list automatically. The accountant
 * can override any line. Anything left over is held as a credit rather than
 * being forced onto a load it does not belong to.
 */
const today = () => new Date().toISOString().slice(0, 10);

function subtract(a: string, b: string): string {
  const cents = (v: string) => {
    const [w = '0', f = ''] = (v || '0').replace(/,/g, '').trim().split('.');
    const neg = w.startsWith('-');
    const abs = BigInt(w.replace('-', '') || '0') * 100n + BigInt((f + '00').slice(0, 2) || '0');
    return neg ? -abs : abs;
  };
  const c = cents(a) - cents(b);
  const neg = c < 0n;
  const abs = neg ? -c : c;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export function PaymentsPage() {
  const [parties, setParties] = useState<Party[]>([]);
  const [accounts, setAccounts] = useState<Array<{ accountId: number; name: string }>>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [open, setOpen] = useState<OpenDocument[]>([]);
  const [outstanding, setOutstanding] = useState('0.00');

  const [form, setForm] = useState({ partyId: '', amount: '', paymentDate: today(), accountId: '', methodLabel: 'Cash', referenceNo: '' });
  const [alloc, setAlloc] = useState<Record<number, string>>({});
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, a, pay] = await Promise.all([api.parties('SUPPLIER'), api.cashBank(), api.payments({})]);
    setParties(p.parties);
    setAccounts(a.accounts);
    setPayments(pay.payments);
    setForm((f) => (f.accountId ? f : { ...f, accountId: String(a.accounts[0]?.accountId ?? '') }));
  }, []);

  useEffect(() => {
    void load().catch(() => setError('Could not load. Your role may not include finance access.'));
  }, [load]);

  // Picking a supplier pulls their open loads and clears any prior allocation.
  useEffect(() => {
    if (!form.partyId) {
      setOpen([]);
      setOutstanding('0.00');
      setAlloc({});
      return;
    }
    void api
      .openDocuments(form.partyId)
      .then((r) => {
        setOpen(r.documents);
        setOutstanding(r.totalOutstanding);
        setAlloc({});
      })
      .catch(() => setOpen([]));
  }, [form.partyId]);

  /** Spreads the entered amount down the open loads, oldest first. */
  function autoApply() {
    let left = form.amount || '0';
    const next: Record<number, string> = {};
    for (const d of open) {
      if (Number(left) <= 0) break;
      const take = Number(left) >= Number(d.balance) ? d.balance : left;
      next[d.id] = take;
      left = subtract(left, take);
    }
    setAlloc(next);
  }

  const applied = useMemo(
    () => Object.values(alloc).reduce((acc, v) => subtract(acc, `-${v || '0'}`), '0.00'),
    [alloc]
  );
  const leftOver = useMemo(() => subtract(form.amount || '0', applied), [form.amount, applied]);
  const overApplied = leftOver.startsWith('-');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const allocations = Object.entries(alloc)
        .filter(([, v]) => Number(v) > 0)
        .map(([id, amount]) => ({ targetType: 'Purchase', targetId: Number(id), amount }));

      const r = await api.createPayment({
        ...form,
        direction: 'OUT',
        partyId: Number(form.partyId),
        accountId: Number(form.accountId),
        allocations,
      });

      setFlash(
        Number(r.onAccount) > 0
          ? `${r.docNo}: ${r.amount} paid to ${r.party}. ${r.onAccount} is held as a credit.`
          : `${r.docNo}: ${r.amount} paid to ${r.party}`
      );
      setForm((f) => ({ ...f, amount: '', referenceNo: '' }));
      setAlloc({});
      await load();
      if (form.partyId) {
        const fresh = await api.openDocuments(form.partyId);
        setOpen(fresh.documents);
        setOutstanding(fresh.totalOutstanding);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record this payment');
    } finally {
      setBusy(false);
    }
  }

  const matched = useSearch(payments, search, (p) => [p.party, p.docNo, p.reference, p.method]);

  return (
    <>
      <OperationHeader operation="payments" title="Payments" />

      {flash && <div className="alert alert-success">{flash}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <form className="card" onSubmit={submit}>
        <h3>Pay a supplier</h3>

        <div className="form-grid">
          <div className="field">
            <label htmlFor="pp">Who are you paying</label>
            <select id="pp" required value={form.partyId}
              onChange={(e) => setForm((f) => ({ ...f, partyId: e.target.value }))}>
              <option value="">Select…</option>
              {parties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {Number(p.outstandingPayable) > 0 ? ` (owed ${p.outstandingPayable})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pd">Date</label>
            <input id="pd" type="date" max={today()} required value={form.paymentDate}
              onChange={(e) => setForm((f) => ({ ...f, paymentDate: e.target.value }))} />
          </div>
          <div className="field">
            <label htmlFor="pa">Amount</label>
            <input id="pa" required inputMode="decimal" value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
          </div>
          <div className="field">
            <label htmlFor="pac">Paid from</label>
            <select id="pac" required value={form.accountId}
              onChange={(e) => setForm((f) => ({ ...f, accountId: e.target.value }))}>
              {accounts.map((a) => <option key={a.accountId} value={a.accountId}>{a.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pm">How</label>
            <select id="pm" value={form.methodLabel}
              onChange={(e) => setForm((f) => ({ ...f, methodLabel: e.target.value }))}>
              <option>Cash</option><option>Bank transfer</option><option>Online</option><option>Cheque</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="pr">Reference</label>
            <input id="pr" value={form.referenceNo}
              onChange={(e) => setForm((f) => ({ ...f, referenceNo: e.target.value }))} />
          </div>
        </div>

        {form.partyId && (
          <div className="form-section">
            <div className="section-title">
              What this covers
              <span style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>
                <Money value={outstanding} /> outstanding
              </span>
            </div>

            {open.length === 0 ? (
              <div className="empty-state">Nothing outstanding for this supplier.</div>
            ) : (
              <>
                <div className="actions" style={{ border: 'none', paddingTop: 0, marginTop: 0, marginBottom: 18 }}>
                  <button type="button" className="btn btn-ghost" onClick={autoApply} disabled={!form.amount}>
                    Apply to oldest first
                  </button>
                </div>

                <div className="pick-list">
                  {open.map((d) => (
                    <div className="pick-row" key={d.id} style={{ cursor: 'default' }}>
                      <span className="pick-main">
                        <span className="pick-title">{d.docNo}</span>
                        <span className="pick-sub">
                          <span>{String(d.date).slice(0, 10)}</span>
                          <span>{d.division}</span>
                          <span>owed <Money value={d.balance} /></span>
                        </span>
                      </span>
                      <input
                        className="alloc-input"
                        inputMode="decimal"
                        placeholder="0.00"
                        aria-label={`Amount to apply to ${d.docNo}`}
                        value={alloc[d.id] ?? ''}
                        onChange={(e) => setAlloc((a) => ({ ...a, [d.id]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>

                <div className="alloc-summary">
                  <span>Applied <strong><Money value={applied} /></strong></span>
                  <span className={overApplied ? 'over' : ''}>
                    {overApplied ? 'Over-applied by ' : 'Held as credit '}
                    <strong><Money value={leftOver.replace('-', '')} /></strong>
                  </span>
                </div>

                {overApplied && (
                  <div className="alert alert-warn">
                    You have applied more than the payment amount. Reduce one of the lines.
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="actions">
          <button className="btn btn-primary" disabled={busy || !form.partyId || !form.amount || overApplied}>
            Record payment
          </button>
        </div>
      </form>

      <div className="card">
        <h3>Payments made</h3>
        <Toolbar
          search={search} onSearch={setSearch}
          placeholder="Search by supplier, document or reference"
          resultCount={matched.length} totalCount={payments.length}
        />
        {matched.length === 0 ? (
          <div className="empty-state">No payments recorded yet.</div>
        ) : (
          <>
            <table className="data ledger-table">
              <thead><tr><th>Document</th><th>Date</th><th>Who</th><th>How</th><th>From</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {matched.map((p) => (
                  <tr key={p.id}>
                    <td><code>{p.docNo}</code></td>
                    <td>{String(p.date).slice(0, 10)}</td>
                    <td>{p.party ?? ''}</td>
                    <td>{p.method}</td>
                    <td>{p.account}</td>
                    <td className="num"><Money value={p.amount} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="rows">
              {matched.map((p) => (
                <div className="row-card" key={p.id}>
                  <div className="row-top">
                    <span className="row-title">{p.party ?? p.docNo}</span>
                    <span className="row-amount"><Money value={p.amount} /></span>
                  </div>
                  <div className="row-meta">
                    <span>{String(p.date).slice(0, 10)}</span><span>{p.docNo}</span><span>{p.method}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
