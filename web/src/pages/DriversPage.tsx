import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Driver, type DriverDetail, type DriverCollection, type DriverAdvance, type DriverVacation } from '../api';
import { Money } from '../components/Money';
import { Hint } from '../components/Hint';
import { OperationHeader } from '../components/OperationHeader';
import { Toolbar, useSearch } from '../components/Toolbar';
import { HINTS } from '../content/operations';

/**
 * Drivers in full.
 *
 * A list that drills into one driver, where everything about them lives on a
 * single screen: who they are, what they are holding, every load they have
 * brought in, every advance issued, and their time off.
 *
 * The list is split by type because the two are not variations of one thing.
 * Your own driver is holding your money; an outsourced driver is a supplier
 * with a truck. Keeping them visually apart stops the wrong one being picked.
 */
export function DriversPage() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    driver: DriverDetail;
    totals: { loads: string; drums: string; value: string; issued: string; settled: string };
    collections: DriverCollection[];
    advances: DriverAdvance[];
    vacations: DriverVacation[];
  } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState('');

  const [form, setForm] = useState({
    name: '', driverType: 'IN_HOUSE' as 'IN_HOUSE' | 'OUTSOURCED',
    phone: '', vehicleNumber: '', licenseNumber: '',
  });
  const [advance, setAdvance] = useState({ amount: '', notes: '' });
  const [leave, setLeave] = useState({ startsOn: '', endsOn: '', reason: '' });

  const loadList = useCallback(async () => {
    const r = await api.drivers();
    setDrivers(r.drivers);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const r = await api.driverDetail(id);
    setDetail(r);
  }, []);

  useEffect(() => {
    void loadList().catch(() => {});
  }, [loadList]);

  useEffect(() => {
    if (selected) void loadDetail(selected).catch(() => setDetail(null));
    else setDetail(null);
  }, [selected, loadDetail]);

  async function addDriver(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.createDriver(form);
      setFlash(`${form.name} added`);
      setForm({ name: '', driverType: 'IN_HOUSE', phone: '', vehicleNumber: '', licenseNumber: '' });
      setShowAdd(false);
      await loadList();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add this driver');
    } finally { setBusy(false); }
  }

  async function giveAdvance(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const r = await api.issueAdvance({
        driverId: selected,
        issuedOn: new Date().toISOString().slice(0, 10),
        amount: advance.amount,
        notes: advance.notes || null,
      });
      setFlash(`${r.docNo}: ${r.amount} issued`);
      setAdvance({ amount: '', notes: '' });
      await Promise.all([loadDetail(selected), loadList()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not issue this advance');
    } finally { setBusy(false); }
  }

  async function addLeave(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      await api.addVacation(selected, { startsOn: leave.startsOn, endsOn: leave.endsOn, reason: leave.reason || null });
      setFlash('Leave recorded');
      setLeave({ startsOn: '', endsOn: '', reason: '' });
      await loadDetail(selected);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record this leave');
    } finally { setBusy(false); }
  }

  /* -------------------------------------------------------- detail view */

  if (selected && detail) {
    const d = detail.driver;
    const t = detail.totals;
    const inHouse = d.driverType === 'IN_HOUSE';

    return (
      <>
        <div className="crumb">
          <button onClick={() => setSelected(null)}>Back to all drivers</button>
        </div>

        <div className="op-head">
          <h2>{d.name}</h2>
          <span className={inHouse ? 'pill solid' : 'pill'}>{inHouse ? 'Our driver' : 'Outsourced'}</span>
        </div>

        {flash && <div className="alert alert-success">{flash}</div>}
        {error && <div className="alert alert-error">{error}</div>}

        <div className="card">
          <h3>Who they are</h3>
          <div className="detail-grid">
            <Detail k="Code" v={d.code} />
            <Detail k="Phone" v={d.phone ?? 'Not recorded'} />
            <Detail k="Vehicle" v={d.vehicleNumber ?? 'Not recorded'} />
            <Detail k="Licence" v={d.licenseNumber ?? 'Not recorded'} />
            <Detail k="Joined" v={d.joiningDate ? String(d.joiningDate).slice(0, 10) : 'Not recorded'} />
            <Detail k="Status" v={d.status.toLowerCase()} />
            <Detail
              k="Type"
              hint={HINTS.driverType}
              v={inHouse ? 'Our truck, works on an advance' : 'Their truck, paid per load'}
            />
          </div>
        </div>

        <div className="card-grid">
          <div className="card">
            <h3>Loads brought in</h3>
            <div className="stat">{Number(t.loads)}</div>
            <div className="stat-label">{trim(t.drums)} drums in total</div>
          </div>
          <div className="card">
            <h3>Value collected</h3>
            <div className="stat"><Money value={t.value} /></div>
            <div className="stat-label">across every load</div>
          </div>
          {inHouse && (
            <div className="card">
              <h3>
                Holding now
                <Hint text={HINTS.advanceBalance} />
              </h3>
              <div className="stat"><Money value={d.advanceBalance} /></div>
              <div className="stat-label">
                <Money value={t.issued} /> issued, <Money value={t.settled} /> settled against oil
              </div>
            </div>
          )}
        </div>

        {inHouse && (
          <form className="card" onSubmit={giveAdvance}>
            <h3>
              Issue an advance
            </h3>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="amt">Amount</label>
                <input id="amt" inputMode="decimal" required value={advance.amount}
                  onChange={(e) => setAdvance((a) => ({ ...a, amount: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="anote">Note</label>
                <input id="anote" value={advance.notes}
                  onChange={(e) => setAdvance((a) => ({ ...a, notes: e.target.value }))} />
              </div>
            </div>
            <div className="actions">
              <button className="btn btn-primary" disabled={busy || !advance.amount}>Issue advance</button>
            </div>
          </form>
        )}

        <div className="card">
          <h3>Collections</h3>
          {detail.collections.length === 0 ? (
            <div className="empty-state">No loads recorded against this driver yet.</div>
          ) : (
            <>
              <div className="rows">
                {detail.collections.map((c) => (
                  <div className="row-card" key={c.id}>
                    <div className="row-top">
                      <span className="row-title">{trim(c.drums)} drums {c.division}</span>
                      <span className="row-amount"><Money value={c.total} /></span>
                    </div>
                    <div className="row-meta">
                      <span>{String(c.date).slice(0, 10)}</span>
                      <span>{c.docNo}</span>
                      {c.area && <span>{c.area}</span>}
                      <span className={c.paymentStatus === 'PAID' ? 'pill' : 'pill warn'}>
                        {c.paymentStatus.toLowerCase()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <table className="data ledger-table">
                <thead>
                  <tr>
                    <th>Document</th><th>Date</th><th>Oil</th><th>Area</th>
                    <th className="num">Drums</th><th className="num">Rate</th>
                    <th className="num">Total</th><th className="num">From advance</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.collections.map((c) => (
                    <tr key={c.id}>
                      <td><code>{c.docNo}</code></td>
                      <td>{String(c.date).slice(0, 10)}</td>
                      <td>{c.division}</td>
                      <td>{c.area ?? ''}</td>
                      <td className="num">{trim(c.drums)}</td>
                      <td className="num"><Money value={c.rate} /></td>
                      <td className="num"><Money value={c.total} /></td>
                      <td className="num">{Number(c.advanceUsed) > 0 ? <Money value={c.advanceUsed} /> : ''}</td>
                      <td><span className={c.paymentStatus === 'PAID' ? 'pill' : 'pill warn'}>{c.paymentStatus.toLowerCase()}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        {inHouse && (
          <div className="card">
            <h3>Advances issued</h3>
            {detail.advances.length === 0 ? (
              <div className="empty-state">No advances issued yet.</div>
            ) : (
              <>
                <div className="rows">
                  {detail.advances.map((a) => (
                    <div className="row-card" key={a.id}>
                      <div className="row-top">
                        <span className="row-title">{String(a.issuedOn).slice(0, 10)}</span>
                        <span className="row-amount"><Money value={a.amount} /></span>
                      </div>
                      <div className="row-meta"><span>{a.docNo}</span><span>{a.method}</span></div>
                    </div>
                  ))}
                </div>
                <table className="data ledger-table">
                  <thead><tr><th>Document</th><th>Date</th><th>Method</th><th>Note</th><th className="num">Amount</th></tr></thead>
                  <tbody>
                    {detail.advances.map((a) => (
                      <tr key={a.id}>
                        <td><code>{a.docNo}</code></td>
                        <td>{String(a.issuedOn).slice(0, 10)}</td>
                        <td>{a.method}</td>
                        <td>{a.notes ?? ''}</td>
                        <td className="num"><Money value={a.amount} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}

        <form className="card" onSubmit={addLeave}>
          <h3>Time off</h3>
          {detail.vacations.length > 0 && (
            <div className="rows" style={{ marginBottom: 20 }}>
              {detail.vacations.map((v) => (
                <div className="row-card" key={v.id}>
                  <div className="row-top">
                    <span className="row-title">
                      {String(v.startsOn).slice(0, 10)} to {String(v.endsOn).slice(0, 10)}
                    </span>
                    {v.current && <span className="pill warn">on leave now</span>}
                  </div>
                  {v.reason && <div className="row-meta"><span>{v.reason}</span></div>}
                </div>
              ))}
            </div>
          )}
          <div className="form-grid">
            <div className="field">
              <label htmlFor="ls">From</label>
              <input id="ls" type="date" required value={leave.startsOn}
                onChange={(e) => setLeave((l) => ({ ...l, startsOn: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="le">To</label>
              <input id="le" type="date" required value={leave.endsOn}
                onChange={(e) => setLeave((l) => ({ ...l, endsOn: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="lr">Reason</label>
              <input id="lr" value={leave.reason}
                onChange={(e) => setLeave((l) => ({ ...l, reason: e.target.value }))} />
            </div>
          </div>
          <div className="actions">
            <button className="btn btn-ghost" disabled={busy || !leave.startsOn || !leave.endsOn}>Record leave</button>
          </div>
        </form>
      </>
    );
  }

  /* ---------------------------------------------------------- list view */

  const matched = useSearch(drivers, search, (d) => [d.name, d.code, d.vehicleNumber, d.phone]);
  const ours = matched.filter((d) => d.driverType === 'IN_HOUSE');
  const outsourced = matched.filter((d) => d.driverType === 'OUTSOURCED');

  return (
    <>
      <OperationHeader operation="drivers" />

      {flash && <div className="alert alert-success">{flash}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {showAdd ? (
        <form className="card" onSubmit={addDriver}>
          <h3>Add a driver</h3>
          <div className="label-row">
            <span className="choice-label" style={{ marginBottom: 0 }}>What kind of driver?</span>
            <Hint text={HINTS.driverType} />
          </div>
          <div className="choices">
            <button type="button"
              className={form.driverType === 'IN_HOUSE' ? 'choice active' : 'choice'}
              onClick={() => setForm((f) => ({ ...f, driverType: 'IN_HOUSE' }))}>
              <span className="choice-title">Our driver</span>
              <span className="choice-hint">Our truck, works on an advance</span>
            </button>
            <button type="button"
              className={form.driverType === 'OUTSOURCED' ? 'choice active' : 'choice'}
              onClick={() => setForm((f) => ({ ...f, driverType: 'OUTSOURCED' }))}>
              <span className="choice-title">Outsourced</span>
              <span className="choice-hint">Their truck, paid per load</span>
            </button>
          </div>

          <div className="form-grid">
            <div className="field">
              <label htmlFor="n">Name</label>
              <input id="n" required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="ph">Phone</label>
              <input id="ph" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="vn">Vehicle number</label>
              <input id="vn" value={form.vehicleNumber} onChange={(e) => setForm((f) => ({ ...f, vehicleNumber: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="ln">Licence number</label>
              <input id="ln" value={form.licenseNumber} onChange={(e) => setForm((f) => ({ ...f, licenseNumber: e.target.value }))} />
            </div>
          </div>
          <div className="actions">
            <button className="btn btn-primary" disabled={busy || !form.name}>Add driver</button>
            <button className="btn btn-ghost" type="button" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="actions" style={{ border: 'none', paddingTop: 0, marginTop: 0, marginBottom: 24 }}>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>Add a driver</button>
        </div>
      )}

      <Toolbar
        search={search}
        onSearch={setSearch}
        placeholder="Search by name, code, vehicle or phone"
        resultCount={matched.length}
        totalCount={drivers.length}
      />

      <DriverGroup
        title="Our drivers"
        note="Our trucks. They hold money we have given them until oil comes in against it."
        drivers={ours}
        onPick={setSelected}
        showAdvance
      />
      <DriverGroup
        title="Outsourced drivers"
        note="Their own trucks. Paid for each load, never given an advance."
        drivers={outsourced}
        onPick={setSelected}
      />
    </>
  );
}

function DriverGroup({
  title, note, drivers, onPick, showAdvance,
}: {
  title: string;
  note: string;
  drivers: Driver[];
  onPick: (id: string) => void;
  showAdvance?: boolean;
}) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <p className="field-hint" style={{ marginTop: -8, marginBottom: 18 }}>{note}</p>
      {drivers.length === 0 ? (
        <div className="empty-state">None yet.</div>
      ) : (
        <div className="pick-list">
          {drivers.map((d) => (
            <button className="pick-row" key={d.id} onClick={() => onPick(String(d.id))}>
              <span className="pick-main">
                <span className="pick-title">{d.name}</span>
                <span className="pick-sub">
                  <span>{d.code}</span>
                  {d.vehicleNumber && <span>{d.vehicleNumber}</span>}
                  {d.phone && <span>{d.phone}</span>}
                  {d.onVacation && <span className="pill warn">on leave</span>}
                </span>
              </span>
              {showAdvance && <span className="pick-amount"><Money value={d.advanceBalance} /></span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Detail({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <div className="detail-item">
      <div className="detail-key">
        {k}
        {hint && <Hint text={hint} below />}
      </div>
      <div className="detail-value">{v}</div>
    </div>
  );
}

function trim(q: string): string {
  return String(q).replace(/\.0+$/, '');
}
