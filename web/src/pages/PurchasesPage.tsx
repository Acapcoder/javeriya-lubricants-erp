import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, type Driver, type Party, type Agreement, type PurchaseRow, type Tank } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Money } from '../components/Money';
import { OperationHeader } from '../components/OperationHeader';
import { LabelWithHint } from '../components/Hint';
import { ReceiptUpload } from '../components/ReceiptUpload';
import { HINTS } from '../content/operations';

/**
 * Recording oil coming in — ONE screen for every intake.
 *
 * The old design had four: UCO Purchases, UCO Driver Collections, UCO Direct
 * Agreements, UEO Purchases. They are the same event. What varies is which oil
 * and where it came from, so those are the first two choices on the form and
 * everything below adapts.
 */

type OilType = 'UCO' | 'UEO';
type Source = 'DRIVER_COLLECTION' | 'DIRECT_AGREEMENT' | 'WALK_IN';

const SOURCES: Array<{ value: Source; label: string; hint: string }> = [
  { value: 'DRIVER_COLLECTION', label: 'Driver collection', hint: 'A driver brought it in' },
  { value: 'DIRECT_AGREEMENT', label: 'Company agreement', hint: 'Collected under a contract' },
  { value: 'WALK_IN', label: 'Direct delivery', hint: 'Supplier delivered to the yard' },
];

const today = () => new Date().toISOString().slice(0, 10);

/** Exact decimal multiply, so the on-screen total matches what the server posts. */
function multiply(a: string, b: string): string {
  const toCents = (v: string) => {
    const [w = '0', f = ''] = v.replace(/,/g, '').trim().split('.');
    return BigInt(w || '0') * 100n + BigInt((f + '00').slice(0, 2) || '0');
  };
  try {
    const cents = (toCents(a) * toCents(b)) / 100n;
    return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
  } catch {
    return '0.00';
  }
}

function subtract(a: string, b: string): string {
  const toCents = (v: string) => {
    const [w = '0', f = ''] = (v || '0').replace(/,/g, '').trim().split('.');
    const neg = w.startsWith('-');
    const abs = BigInt(w.replace('-', '') || '0') * 100n + BigInt((f + '00').slice(0, 2) || '0');
    return neg ? -abs : abs;
  };
  const c = toCents(a) - toCents(b);
  const neg = c < 0n;
  const abs = neg ? -c : c;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export function PurchasesPage() {
  const { can } = useAuth();
  const [oil, setOil] = useState<OilType>('UCO');
  const [source, setSource] = useState<Source>('DRIVER_COLLECTION');

  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [rows, setRows] = useState<PurchaseRow[]>([]);
  const [tanks, setTanks] = useState<Tank[]>([]);

  const [form, setForm] = useState({
    purchaseDate: today(),
    driverId: '',
    partyId: '',
    agreementId: '',
    collectionArea: '',
    vehicleNumber: '',
    tankId: '',
    drums: '',
    ratePerDrum: '',
    cashPaid: '',
    onlinePaid: '',
    advanceUsed: '',
    notes: '',
    feePaid: false,
    feeAmount: '',
    slipNumber: '',
    refundEligible: true,
    attachmentId: null as string | null,
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const load = useCallback(async () => {
    const [d, p, a, list, t] = await Promise.all([
      api.drivers(),
      api.parties('SUPPLIER'),
      api.agreements(oil),
      api.purchases({ division: oil, limit: 15 }),
      api.tanks(),
    ]);
    setDrivers(d.drivers);
    setSuppliers(p.parties);
    setAgreements(a.agreements);
    setRows(list.purchases);
    setTanks(t.tanks.filter((x) => x.itemCode === oil && x.status === 'ACTIVE'));
  }, [oil]);

  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  const total = useMemo(
    () => multiply(form.drums || '0', form.ratePerDrum || '0'),
    [form.drums, form.ratePerDrum]
  );

  const paid = useMemo(() => {
    const sum = ['cashPaid', 'onlinePaid', 'advanceUsed']
      .map((k) => form[k as 'cashPaid'] || '0')
      .reduce((acc, v) => subtract(acc, `-${v || '0'}`), '0.00');
    return sum;
  }, [form.cashPaid, form.onlinePaid, form.advanceUsed]);

  const balance = useMemo(() => subtract(total, paid), [total, paid]);

  const selectedDriver = drivers.find((d) => String(d.id) === form.driverId);
  const selectedTank = tanks.find((t) => String(t.id) === form.tankId);
  const isInHouse = selectedDriver?.driverType === 'IN_HOUSE';

  // Picking an agreement pre-fills its contracted rate, but leaves it editable —
  // rates get renegotiated before the paperwork catches up.
  function chooseAgreement(id: string) {
    set('agreementId', id);
    const ag = agreements.find((a) => String(a.id) === id);
    if (ag) {
      set('partyId', String(ag.partyId));
      if (ag.ratePerDrum && !form.ratePerDrum) set('ratePerDrum', ag.ratePerDrum);
    }
  }

  const contractRate = agreements.find((a) => String(a.id) === form.agreementId)?.ratePerDrum;
  const rateVaries =
    contractRate && form.ratePerDrum && contractRate !== form.ratePerDrum ? contractRate : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.createPurchase({
        division: oil,
        purchaseDate: form.purchaseDate,
        source,
        driverId: source === 'DRIVER_COLLECTION' ? form.driverId || null : null,
        agreementId: source === 'DIRECT_AGREEMENT' ? form.agreementId || null : null,
        partyId: form.partyId || null,
        collectionArea: form.collectionArea || null,
        vehicleNumber: form.vehicleNumber || null,
        tankId: form.tankId ? Number(form.tankId) : null,
        drums: form.drums,
        ratePerDrum: form.ratePerDrum,
        cashPaid: form.cashPaid || '0',
        onlinePaid: form.onlinePaid || '0',
        advanceUsed: form.advanceUsed || '0',
        notes: form.notes || null,
        weightFee: form.feePaid
          ? {
              feePaid: true,
              feeAmount: form.feeAmount,
              slipNumber: form.slipNumber,
              refundEligible: form.refundEligible,
              attachmentId: form.attachmentId ? Number(form.attachmentId) : null,
            }
          : null,
      });

      setFlash(
        res.tankAfter
          ? `${res.docNo} recorded. Stock is now ${res.stockAfter} drums, tank holds ${res.tankAfter}`
          : `${res.docNo} recorded. Stock is now ${res.stockAfter} drums`
      );
      setForm((f) => ({
        ...f,
        drums: '', ratePerDrum: '', cashPaid: '', onlinePaid: '', advanceUsed: '',
        notes: '', feePaid: false, feeAmount: '', slipNumber: '', collectionArea: '', attachmentId: null,
      }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record this purchase');
    } finally {
      setBusy(false);
    }
  }

  async function recordNoActivity() {
    setError(null);
    setBusy(true);
    try {
      const res = await api.noPurchaseDay({ division: oil, purchaseDate: form.purchaseDate });
      setFlash(`${res.docNo}: recorded a day with no ${oil} intake`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that');
    } finally {
      setBusy(false);
    }
  }

  const canCreate = can('operations.create');

  return (
    <>
      <OperationHeader operation="purchases" />

      {flash && <div className="alert alert-success">{flash}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <form className="card" onSubmit={submit}>
        {/* Two big choices drive the whole form. */}
        <span className="choice-label">Which oil?</span>
        <div className="choices">
          {(['UCO', 'UEO'] as OilType[]).map((t) => (
            <button type="button" key={t} className={oil === t ? 'choice active' : 'choice'} onClick={() => setOil(t)}>
              <span className="choice-title">{t === 'UCO' ? 'Cooking Oil' : 'Engine Oil'}</span>
              <span className="choice-hint">{t === 'UCO' ? 'From kitchens' : 'From workshops'}</span>
            </button>
          ))}
        </div>

        <span className="choice-label">Where did it come from?</span>
        <div className="choices">
          {SOURCES.map((s) => (
            <button
              type="button"
              key={s.value}
              className={source === s.value ? 'choice active' : 'choice'}
              onClick={() => setSource(s.value)}
            >
              <span className="choice-title">{s.label}</span>
              <span className="choice-hint">{s.hint}</span>
            </button>
          ))}
        </div>

        <div className="form-section">
          <div className="section-title">Details</div>
          <div className="form-grid">
          <div className="field">
            <label htmlFor="date">Date</label>
            <input
              id="date"
              type="date"
              max={today()}
              value={form.purchaseDate}
              onChange={(e) => set('purchaseDate', e.target.value)}
              required
            />
          </div>

          {source === 'DRIVER_COLLECTION' && (
            <>
              <div className="field">
                <label htmlFor="driver">Driver</label>
                <select id="driver" value={form.driverId} onChange={(e) => set('driverId', e.target.value)} required>
                  <option value="">Select a driver…</option>
                  <optgroup label="Our drivers">
                    {drivers.filter((d) => d.driverType === 'IN_HOUSE').map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {d.onVacation ? '. on leave' : ''}
                        {Number(d.advanceBalance) > 0 ? ` · advance ${d.advanceBalance}` : ''}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Outsourced drivers">
                    {drivers.filter((d) => d.driverType === 'OUTSOURCED').map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </optgroup>
                </select>
                {selectedDriver?.onVacation && (
                  <p className="field-hint warn">This driver is marked on leave for today.</p>
                )}
              </div>

              <div className="field">
                <label htmlFor="area">Collection area</label>
                <input id="area" value={form.collectionArea} onChange={(e) => set('collectionArea', e.target.value)} />
              </div>
            </>
          )}

          {source === 'DIRECT_AGREEMENT' && (
            <div className="field">
              <label htmlFor="agreement">Agreement</label>
              <select id="agreement" value={form.agreementId} onChange={(e) => chooseAgreement(e.target.value)} required>
                <option value="">Select an agreement…</option>
                {agreements.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.partyName}. {a.agreementNo}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="field">
            <label htmlFor="supplier">Supplier {source === 'DRIVER_COLLECTION' && <span className="opt">optional</span>}</label>
            <select id="supplier" value={form.partyId} onChange={(e) => set('partyId', e.target.value)}>
              <option value="">Select…</option>
              {suppliers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="vehicle">Vehicle number</label>
            <input id="vehicle" value={form.vehicleNumber} onChange={(e) => set('vehicleNumber', e.target.value)} />
          </div>

          {tanks.length > 0 && (
            <div className="field">
              <label htmlFor="tank">Into which tank</label>
              <select id="tank" value={form.tankId} onChange={(e) => set('tankId', e.target.value)}>
                <option value="">Not recorded</option>
                {tanks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({trimQty(t.available)} free of {trimQty(t.capacity)})
                  </option>
                ))}
              </select>
              {selectedTank && form.drums && Number(form.drums) > Number(selectedTank.available) && (
                <p className="field-hint warn">
                  {selectedTank.name} only has room for {trimQty(selectedTank.available)} drums.
                </p>
              )}
            </div>
          )}
          </div>
        </div>

        <div className="form-section">
          <div className="section-title">What arrived</div>
          <div className="form-grid">
          <div className="field">
            <label htmlFor="drums">Drums received</label>
            <input
              id="drums" inputMode="decimal" placeholder="0"
              value={form.drums} onChange={(e) => set('drums', e.target.value)} required
            />
          </div>
          <div className="field">
            <label htmlFor="rate">Rate per drum</label>
            <input
              id="rate" inputMode="decimal" placeholder="0.00"
              value={form.ratePerDrum} onChange={(e) => set('ratePerDrum', e.target.value)} required
            />
            {rateVaries && (
              <p className="field-hint warn">Contract rate is {rateVaries}. this entry differs.</p>
            )}
          </div>
          <div className="field total-field">
            <span className="field-label">Total</span>
            <div className="total-value"><Money value={total} /></div>
          </div>
          </div>
        </div>

        <div className="form-section">
          <div className="section-title">How it was paid</div>
          <div className="form-grid">
          <div className="field">
            <label htmlFor="cash">Cash paid</label>
            <input id="cash" inputMode="decimal" placeholder="0.00" value={form.cashPaid} onChange={(e) => set('cashPaid', e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="online">Bank or online</label>
            <input id="online" inputMode="decimal" placeholder="0.00" value={form.onlinePaid} onChange={(e) => set('onlinePaid', e.target.value)} />
          </div>

          {isInHouse && (
            <div className="field">
              <LabelWithHint htmlFor="adv" hint={HINTS.advanceUsed}>From driver advance</LabelWithHint>
              <input id="adv" inputMode="decimal" placeholder="0.00" value={form.advanceUsed} onChange={(e) => set('advanceUsed', e.target.value)} />
              <p className="field-hint">Holds {selectedDriver?.advanceBalance ?? '0.00'}</p>
            </div>
          )}

          <div className="field total-field">
            <LabelWithHint hint={HINTS.balanceOwed}>Balance owed</LabelWithHint>
            <div className={balance.startsWith('-') ? 'total-value danger' : 'total-value'}>
              <Money value={balance} />
            </div>
          </div>
          </div>

          {balance.startsWith('-') && (
            <div className="alert alert-warn">Payment is more than the total by {balance.replace('-', '')}.</div>
          )}
        </div>

        {/* Weight fee. hidden until it applies. */}
        <label className="checkline">
          <input type="checkbox" checked={form.feePaid} onChange={(e) => set('feePaid', e.target.checked)} />
          <span>Government weight fee was paid</span>
        </label>

        {form.feePaid && (
          <div className="form-grid">
            <div className="field">
              <label htmlFor="fee">Fee amount</label>
              <input id="fee" inputMode="decimal" value={form.feeAmount} onChange={(e) => set('feeAmount', e.target.value)} required />
            </div>
            <div className="field">
              <LabelWithHint htmlFor="slip" hint={HINTS.slipNumber}>Slip number</LabelWithHint>
              <input id="slip" value={form.slipNumber} onChange={(e) => set('slipNumber', e.target.value)} required />
            </div>
            <label className="checkline">
              <input type="checkbox" checked={form.refundEligible} onChange={(e) => set('refundEligible', e.target.checked)} />
              <span>Refundable</span>
            </label>

            <ReceiptUpload
              value={form.attachmentId}
              onChange={(id) => set('attachmentId', id)}
              kind="SLIP"
              label="Photograph of the slip"
            />
          </div>
        )}

        <div className="field">
          <label htmlFor="notes">Notes</label>
          <input id="notes" value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </div>

        <div className="actions">
          <button className="btn btn-primary" type="submit" disabled={busy || !canCreate || !form.drums || !form.ratePerDrum}>
            {busy ? 'Recording…' : 'Record purchase'}
          </button>
          <button className="btn btn-ghost" type="button" disabled={busy || !canCreate} onClick={() => void recordNoActivity()}>
            No intake today
          </button>
        </div>
        {!canCreate && <p className="field-hint">Your role can view purchases but not record them.</p>}
      </form>

      {/* Recent entries. */}
      <div className="card">
        <h3>Recent {oil === 'UCO' ? 'cooking oil' : 'engine oil'} intake</h3>
        {rows.length === 0 ? (
          <div className="empty-state">Nothing recorded yet.</div>
        ) : (
          <>
            {/* Phones get cards; the table appears once there is width for it. */}
            <div className="rows">
              {rows.map((r) => (
                <div className="row-card" key={r.id}>
                  <div className="row-top">
                    <span className="row-title">
                      {r.is_no_purchase
                        ? 'No intake'
                        : `${r.drums} drums · ${r.driver_name ?? r.party_name ?? r.agreement_no ?? 'direct'}`}
                    </span>
                    <span className="row-amount">
                      {r.is_no_purchase ? '. ' : <Money value={r.total_amount} />}
                    </span>
                  </div>
                  <div className="row-meta">
                    <span>{String(r.purchase_date).slice(0, 10)}</span>
                    <span>{r.doc_no}</span>
                    {r.driver_type && (
                      <span className="pill muted">{r.driver_type === 'IN_HOUSE' ? 'ours' : 'outsourced'}</span>
                    )}
                    <span className={r.payment_status === 'PAID' ? 'pill' : 'pill warn'}>
                      {r.payment_status.toLowerCase()}
                    </span>
                    {Number(r.balance_due) > 0 && (
                      <span>owed <Money value={r.balance_due} /></span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <table className="data">
              <thead>
                <tr>
                  <th>Document</th><th>Date</th><th>From</th><th>Drums</th>
                  <th>Rate</th><th>Total</th><th>Owed</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><code>{r.doc_no}</code></td>
                    <td>{String(r.purchase_date).slice(0, 10)}</td>
                    <td>
                      {r.is_no_purchase ? (
                        <span className="pill muted">no intake</span>
                      ) : (
                        <>
                          {r.driver_name ?? r.party_name ?? r.agreement_no ?? '. '}
                          {r.driver_type && (
                            <span className="pill muted" style={{ marginLeft: 6 }}>
                              {r.driver_type === 'IN_HOUSE' ? 'ours' : 'outsourced'}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td>{r.is_no_purchase ? '. ' : r.drums}</td>
                    <td>{r.is_no_purchase ? '. ' : <Money value={r.rate_per_drum} />}</td>
                    <td>{r.is_no_purchase ? '. ' : <Money value={r.total_amount} />}</td>
                    <td>{Number(r.balance_due) > 0 ? <Money value={r.balance_due} /> : '. '}</td>
                    <td>
                      <span className={`pill ${r.payment_status === 'PAID' ? '' : 'warn'}`}>
                        {r.payment_status.toLowerCase()}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </>
  );
}

function trimQty(q: string): string {
  return String(q).replace(/.0+$/, '');
}
