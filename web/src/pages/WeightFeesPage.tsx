import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type WeightFeeRow } from '../api';
import { Money } from '../components/Money';
import { OperationHeader } from '../components/OperationHeader';
import { Toolbar, useSearch } from '../components/Toolbar';

/**
 * The government weight fee, and getting it back.
 *
 * Three stages, and the screen is organised around them because each needs a
 * different action: slips waiting to be claimed, claims waiting on the
 * government, and refunds that have arrived.
 *
 * This is a receivable where the debtor happens to be the government, so it
 * ages like any other: a slip sitting in "claimed" for two months is the thing
 * this screen exists to make visible.
 */
const today = () => new Date().toISOString().slice(0, 10);

export function WeightFeesPage() {
  const [fees, setFees] = useState<WeightFeeRow[]>([]);
  const [owed, setOwed] = useState('0.00');
  const [accounts, setAccounts] = useState<Array<{ accountId: number; name: string }>>([]);
  const [stage, setStage] = useState<'PENDING' | 'CLAIMED' | 'RECEIVED'>('PENDING');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [claimDate, setClaimDate] = useState(today());
  const [receiving, setReceiving] = useState<WeightFeeRow | null>(null);
  const [refund, setRefund] = useState({ refundAmount: '', receivedOn: today(), accountId: '' });

  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [f, a] = await Promise.all([api.weightFees(), api.cashBank()]);
    setFees(f.fees);
    setOwed(f.owedByGovernment);
    setAccounts(a.accounts);
    setRefund((r) => (r.accountId ? r : { ...r, accountId: String(a.accounts.find((x) => x.name.includes('Bank'))?.accountId ?? a.accounts[0]?.accountId ?? '') }));
  }, []);

  useEffect(() => {
    void load().catch(() => setError('Could not load. Your role may not include finance access.'));
  }, [load]);

  const inStage = fees.filter((f) => f.status === stage);
  const matched = useSearch(inStage, search, (f) => [f.slipNumber, f.purchaseDoc, f.division]);

  const counts = {
    PENDING: fees.filter((f) => f.status === 'PENDING').length,
    CLAIMED: fees.filter((f) => f.status === 'CLAIMED').length,
    RECEIVED: fees.filter((f) => f.status === 'RECEIVED').length,
  };

  function toggle(id: string) {
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.claimFees([...picked].map(Number), claimDate);
      setFlash(`${r.claimed} ${r.claimed === 1 ? 'slip' : 'slips'} submitted to the government`);
      setPicked(new Set());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit those slips');
    } finally {
      setBusy(false);
    }
  }

  async function receive(e: FormEvent) {
    e.preventDefault();
    if (!receiving) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.receiveRefund(receiving.id, {
        refundAmount: refund.refundAmount,
        receivedOn: refund.receivedOn,
        accountId: Number(refund.accountId),
      });
      setFlash(
        Number(r.notRefunded) > 0
          ? `Refund of ${r.refunded} recorded. ${r.notRefunded} was not refunded and is now a cost.`
          : `Refund of ${r.refunded} recorded in full.`
      );
      setReceiving(null);
      setRefund((f) => ({ ...f, refundAmount: '' }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that refund');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <OperationHeader operation="weightFees" title="Weight fee refunds" />

      {flash && <div className="alert alert-success">{flash}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <div className="card-grid">
        <div className="card">
          <h3>Owed by the government</h3>
          <div className="stat"><Money value={owed} /></div>
          <div className="stat-label">paid out and not yet refunded</div>
        </div>
        <div className="card">
          <h3>Waiting to be claimed</h3>
          <div className="stat">{counts.PENDING}</div>
          <div className="stat-label">slips ready to submit</div>
        </div>
        <div className="card">
          <h3>With the government</h3>
          <div className="stat">{counts.CLAIMED}</div>
          <div className="stat-label">claims submitted, not yet paid</div>
        </div>
      </div>

      <div className="choices">
        <button className={stage === 'PENDING' ? 'choice active' : 'choice'} onClick={() => { setStage('PENDING'); setPicked(new Set()); }}>
          <span className="choice-title">To claim</span>
          <span className="choice-hint">{counts.PENDING} slips</span>
        </button>
        <button className={stage === 'CLAIMED' ? 'choice active' : 'choice'} onClick={() => { setStage('CLAIMED'); setPicked(new Set()); }}>
          <span className="choice-title">Claimed</span>
          <span className="choice-hint">{counts.CLAIMED} waiting</span>
        </button>
        <button className={stage === 'RECEIVED' ? 'choice active' : 'choice'} onClick={() => { setStage('RECEIVED'); setPicked(new Set()); }}>
          <span className="choice-title">Refunded</span>
          <span className="choice-hint">{counts.RECEIVED} settled</span>
        </button>
      </div>

      {receiving && (
        <form className="card" onSubmit={receive}>
          <h3>Refund received: slip {receiving.slipNumber}</h3>
          <p className="field-hint" style={{ marginTop: -8, marginBottom: 18 }}>
            <Money value={receiving.feeAmount} /> was originally paid. Enter what actually arrived. Anything the
            government kept becomes a cost rather than sitting as a receivable forever.
          </p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="ra">Amount received</label>
              <input id="ra" required inputMode="decimal" value={refund.refundAmount}
                onChange={(e) => setRefund((f) => ({ ...f, refundAmount: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="rd">Received on</label>
              <input id="rd" type="date" max={today()} required value={refund.receivedOn}
                onChange={(e) => setRefund((f) => ({ ...f, receivedOn: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="racc">Into</label>
              <select id="racc" required value={refund.accountId}
                onChange={(e) => setRefund((f) => ({ ...f, accountId: e.target.value }))}>
                {accounts.map((a) => <option key={a.accountId} value={a.accountId}>{a.name}</option>)}
              </select>
            </div>
          </div>
          <div className="actions">
            <button className="btn btn-primary" disabled={busy || !refund.refundAmount}>Record refund</button>
            <button className="btn btn-ghost" type="button" onClick={() => setReceiving(null)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="card">
        <h3>
          {stage === 'PENDING' ? 'Slips to claim' : stage === 'CLAIMED' ? 'With the government' : 'Refunded'}
        </h3>

        <Toolbar
          search={search} onSearch={setSearch}
          placeholder="Search by slip or document number"
          resultCount={matched.length} totalCount={inStage.length}
        />

        {stage === 'PENDING' && picked.size > 0 && (
          <div className="claim-bar">
            <span>{picked.size} selected</span>
            <input type="date" max={today()} value={claimDate} onChange={(e) => setClaimDate(e.target.value)} aria-label="Claim date" />
            <button className="btn btn-primary" onClick={() => void claim()} disabled={busy}>
              Mark as claimed
            </button>
          </div>
        )}

        {matched.length === 0 ? (
          <div className="empty-state">
            {stage === 'PENDING'
              ? 'No slips waiting. Fees appear here when a purchase records one.'
              : stage === 'CLAIMED'
                ? 'Nothing is currently with the government.'
                : 'No refunds recorded yet.'}
          </div>
        ) : (
          <div className="pick-list">
            {matched.map((f) => (
              <div className="pick-row" key={f.id} style={{ cursor: 'default' }}>
                {stage === 'PENDING' && (
                  <input
                    type="checkbox"
                    checked={picked.has(f.id)}
                    onChange={() => toggle(f.id)}
                    aria-label={`Select slip ${f.slipNumber}`}
                    style={{ width: 21, height: 21, accentColor: 'var(--accent)', flex: 'none', marginRight: 12 }}
                  />
                )}
                <span className="pick-main">
                  <span className="pick-title">Slip {f.slipNumber}</span>
                  <span className="pick-sub">
                    <span>{f.purchaseDoc}</span>
                    <span>{String(f.purchaseDate).slice(0, 10)}</span>
                    {f.daysWaiting !== null && f.daysWaiting > 45 && (
                      <span className="pill warn">waiting {f.daysWaiting} days</span>
                    )}
                    {f.status === 'RECEIVED' && Number(f.refundAmount) < Number(f.feeAmount) && (
                      <span className="pill warn">partly refunded</span>
                    )}
                  </span>
                </span>
                <span className="pick-amount">
                  <Money value={f.status === 'RECEIVED' ? f.refundAmount : f.feeAmount} />
                </span>
                {stage === 'CLAIMED' && (
                  <button className="btn btn-ghost" style={{ minWidth: 0, marginLeft: 12 }}
                    onClick={() => { setReceiving(f); setRefund((r) => ({ ...r, refundAmount: f.feeAmount })); }}>
                    Refund arrived
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
