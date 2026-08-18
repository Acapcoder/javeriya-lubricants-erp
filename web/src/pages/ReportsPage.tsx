import { useCallback, useEffect, useState } from 'react';
import { api, type PurchaseReport, type StockReport, type ProfitReport } from '../api';
import { Money } from '../components/Money';
import { OperationHeader } from '../components/OperationHeader';
import { DateRange, usePeriod } from '../components/Toolbar';
import { useAuth } from '../auth/AuthContext';

/**
 * Reports.
 *
 * Four questions, one filter bar. Intake can be grouped by any dimension the
 * business actually asks about, which is why grouping is a control rather than
 * five separate reports with five separate screens.
 */
type Report = 'intake' | 'stock' | 'profit' | 'owing';

export function ReportsPage() {
  const { can } = useAuth();
  const [report, setReport] = useState<Report>('intake');
  const { from, to, setFrom, setTo, presets } = usePeriod();
  const [division, setDivision] = useState('');
  const [groupBy, setGroupBy] = useState<'day' | 'month' | 'driver' | 'supplier' | 'source' | 'area'>('month');

  const [intake, setIntake] = useState<PurchaseReport | null>(null);
  const [stock, setStock] = useState<StockReport | null>(null);
  const [profit, setProfit] = useState<ProfitReport | null>(null);
  const [owing, setOwing] = useState<Awaited<ReturnType<typeof api.balancesReport>> | null>(null);
  const [owingKind, setOwingKind] = useState<'payable' | 'receivable'>('payable');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const q = { from, to, ...(division ? { division } : {}) };
      if (report === 'intake') setIntake(await api.purchaseReport({ ...q, groupBy }));
      if (report === 'stock') setStock(await api.stockReport(q));
      if (report === 'profit' && can('profit.view')) setProfit(await api.profitReport(q));
      if (report === 'owing' && can('finance.view')) setOwing(await api.balancesReport(owingKind));
    } catch {
      /* the empty state covers it */
    } finally {
      setBusy(false);
    }
  }, [report, from, to, division, groupBy, owingKind, can]);

  useEffect(() => {
    void load();
  }, [load]);

  const activePreset = presets.find((p) => p.from === from && p.to === to)?.label;

  return (
    <>
      <OperationHeader operation="reports" title="Reports" />

      <div className="choices">
        <Tab id="intake" now={report} set={setReport} title="Oil in" hint="What arrived, grouped" />
        <Tab id="stock" now={report} set={setReport} title="Stock" hint="Moved in and out" />
        {can('profit.view') && <Tab id="profit" now={report} set={setReport} title="Profit" hint="Income less costs" />}
        {can('finance.view') && <Tab id="owing" now={report} set={setReport} title="Owing" hint="Who owes what" />}
      </div>

      {report !== 'owing' && (
        <div className="card">
          <div className="chips">
            {presets.map((p) => (
              <button
                key={p.label}
                className={activePreset === p.label ? 'chip active' : 'chip'}
                onClick={() => {
                  setFrom(p.from);
                  setTo(p.to);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="toolbar" style={{ marginBottom: 0 }}>
            <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} />

            <select className="toolbar-filter" value={division} onChange={(e) => setDivision(e.target.value)} aria-label="Oil type">
              <option value="">Both oils</option>
              <option value="UCO">Cooking oil</option>
              <option value="UEO">Engine oil</option>
            </select>

            {report === 'intake' && (
              <select
                className="toolbar-filter"
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}
                aria-label="Group by"
              >
                <option value="day">By day</option>
                <option value="month">By month</option>
                <option value="driver">By driver</option>
                <option value="supplier">By supplier</option>
                <option value="source">By source</option>
                <option value="area">By area</option>
              </select>
            )}
          </div>
        </div>
      )}

      {busy && <div className="empty-state">Working…</div>}

      {/* ------------------------------------------------------------ intake */}
      {!busy && report === 'intake' && intake && (
        <div className="card">
          <h3>Oil received, {labelFor(groupBy)}</h3>
          {intake.rows.length === 0 ? (
            <div className="empty-state">Nothing was recorded in this period.</div>
          ) : (
            <>
              <table className="data ledger-table">
                <thead>
                  <tr>
                    <th>{labelFor(groupBy)}</th>
                    <th className="num">Loads</th>
                    <th className="num">Drums</th>
                    <th className="num">Value</th>
                    <th className="num">Paid</th>
                    <th className="num">Still owed</th>
                  </tr>
                </thead>
                <tbody>
                  {intake.rows.map((r) => (
                    <tr key={r.label}>
                      <td>{pretty(r.label)}</td>
                      <td className="num">{Number(r.loads)}</td>
                      <td className="num">{trim(r.drums)}</td>
                      <td className="num"><Money value={r.value} /></td>
                      <td className="num"><Money value={r.paid} /></td>
                      <td className="num">{Number(r.outstanding) > 0 ? <Money value={r.outstanding} /> : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total</td>
                    <td className="num">{intake.totals.loads}</td>
                    <td className="num">{trim(intake.totals.drums)}</td>
                    <td className="num"><Money value={intake.totals.value} /></td>
                    <td className="num"><Money value={intake.totals.paid} /></td>
                    <td className="num"><Money value={intake.totals.outstanding} /></td>
                  </tr>
                </tfoot>
              </table>

              <div className="rows">
                {intake.rows.map((r) => (
                  <div className="row-card" key={r.label}>
                    <div className="row-top">
                      <span className="row-title">{pretty(r.label)}</span>
                      <span className="row-amount"><Money value={r.value} /></span>
                    </div>
                    <div className="row-meta">
                      <span>{Number(r.loads)} loads</span>
                      <span>{trim(r.drums)} drums</span>
                      {Number(r.outstanding) > 0 && <span>owed <Money value={r.outstanding} /></span>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------- stock */}
      {!busy && report === 'stock' && stock && (
        <div className="card">
          <h3>Stock movement</h3>
          <table className="data ledger-table">
            <thead>
              <tr>
                <th>Item</th><th>Division</th>
                <th className="num">In</th><th className="num">Out</th>
                <th className="num">On hand</th><th className="num">Cost each</th><th className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {stock.rows.map((r) => (
                <tr key={r.code}>
                  <td>{r.name}</td>
                  <td>{r.division}</td>
                  <td className="num">{trim(r.in)}</td>
                  <td className="num">{trim(r.out)}</td>
                  <td className="num">{trim(r.onHand)}</td>
                  <td className="num"><Money value={r.avgCost} /></td>
                  <td className="num"><Money value={r.value} /></td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="rows">
            {stock.rows.map((r) => (
              <div className="row-card" key={r.code}>
                <div className="row-top">
                  <span className="row-title">{r.name}</span>
                  <span className="row-amount">{trim(r.onHand)}</span>
                </div>
                <div className="row-meta">
                  <span>in {trim(r.in)}</span>
                  <span>out {trim(r.out)}</span>
                  <span>worth <Money value={r.value} /></span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ profit */}
      {!busy && report === 'profit' && profit && (
        <>
          <div className="card-grid">
            <div className="card">
              <h3>Gross profit</h3>
              <div className="stat"><Money value={profit.totals.gross} /></div>
              <div className="stat-label">sales less what the oil cost</div>
            </div>
            <div className="card">
              <h3>Running costs</h3>
              <div className="stat"><Money value={profit.totals.expenses} /></div>
              <div className="stat-label">fuel, rent, wages and the rest</div>
            </div>
            <div className="card">
              <h3>Net profit</h3>
              <div className="stat"><Money value={profit.totals.net} /></div>
              <div className="stat-label">what the business actually made</div>
            </div>
          </div>

          <div className="card">
            <h3>By oil</h3>
            {profit.divisions.length === 0 ? (
              <div className="empty-state">No sales recorded in this period yet.</div>
            ) : (
              <table className="data ledger-table">
                <thead>
                  <tr><th>Oil</th><th className="num">Sales</th><th className="num">Cost of oil sold</th><th className="num">Gross profit</th></tr>
                </thead>
                <tbody>
                  {profit.divisions.map((d) => (
                    <tr key={d.division}>
                      <td>{d.division === 'UCO' ? 'Cooking oil' : d.division === 'UEO' ? 'Engine oil' : d.division}</td>
                      <td className="num"><Money value={d.income} /></td>
                      <td className="num"><Money value={d.cogs} /></td>
                      <td className="num"><Money value={d.gross} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {profit.expenses.length > 0 && (
            <div className="card">
              <h3>Where the money went</h3>
              <table className="data ledger-table">
                <thead><tr><th>Cost</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {profit.expenses.map((e) => (
                    <tr key={e.code}>
                      <td>{e.name}</td>
                      <td className="num"><Money value={e.amount} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td>Total</td><td className="num"><Money value={profit.totals.expenses} /></td></tr>
                </tfoot>
              </table>
            </div>
          )}

          {Number(profit.totals.drawings) !== 0 && (
            <div className="alert alert-info">
              The owner took <Money value={profit.totals.drawings} /> out of the business in this period. That is not a
              running cost, so it is not in the figures above. It reduces the owner stake instead.
            </div>
          )}
        </>
      )}

      {/* ------------------------------------------------------------- owing */}
      {!busy && report === 'owing' && owing && (
        <div className="card">
          <div className="chips">
            <button className={owingKind === 'payable' ? 'chip active' : 'chip'} onClick={() => setOwingKind('payable')}>
              You owe them
            </button>
            <button className={owingKind === 'receivable' ? 'chip active' : 'chip'} onClick={() => setOwingKind('receivable')}>
              They owe you
            </button>
          </div>

          {owing.rows.length === 0 ? (
            <div className="empty-state">Nothing outstanding.</div>
          ) : (
            <>
              <table className="data ledger-table">
                <thead><tr><th>Name</th><th>Code</th><th>Phone</th><th>Last movement</th><th className="num">Balance</th></tr></thead>
                <tbody>
                  {owing.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name}</td>
                      <td><code>{r.code}</code></td>
                      <td>{r.phone ?? ''}</td>
                      <td>{r.lastMovement ? String(r.lastMovement).slice(0, 10) : ''}</td>
                      <td className="num"><Money value={r.balance} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="rows">
                {owing.rows.map((r) => (
                  <div className="row-card" key={r.id}>
                    <div className="row-top">
                      <span className="row-title">{r.name}</span>
                      <span className="row-amount"><Money value={r.balance} /></span>
                    </div>
                    <div className="row-meta">
                      <span>{r.code}</span>
                      {r.phone && <span>{r.phone}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

function Tab({
  id, now, set, title, hint,
}: { id: Report; now: Report; set: (v: Report) => void; title: string; hint: string }) {
  return (
    <button className={now === id ? 'choice active' : 'choice'} onClick={() => set(id)}>
      <span className="choice-title">{title}</span>
      <span className="choice-hint">{hint}</span>
    </button>
  );
}

function labelFor(g: string): string {
  return { day: 'Day', month: 'Month', driver: 'Driver', supplier: 'Supplier', source: 'Source', area: 'Area' }[g] ?? g;
}

function pretty(label: string): string {
  const sources: Record<string, string> = {
    DRIVER_COLLECTION: 'Driver collection',
    DIRECT_AGREEMENT: 'Company agreement',
    WALK_IN: 'Direct delivery',
  };
  return sources[label] ?? label;
}

function trim(q: string): string {
  return String(q).replace(/\.0+$/, '');
}
