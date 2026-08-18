import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type ExpenseRow, type SalaryRow, type DrawingRow } from '../api';
import { Money } from '../components/Money';
import { OperationHeader } from '../components/OperationHeader';
import { Hint } from '../components/Hint';
import { Toolbar, useSearch, DateRange, usePeriod } from '../components/Toolbar';

/**
 * Money going out: running costs, wages, and what the owner takes.
 *
 * Three tabs rather than one list, because the three are different things in
 * the books. The distinction that matters most is the last one: an owner's
 * drawing is not a cost. Recording it as one understates profit, which then
 * distorts every margin the owner prices against.
 */
type Tab = 'expenses' | 'salaries' | 'drawings';

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);

export function SpendingPage() {
  const [tab, setTab] = useState<Tab>('expenses');
  const { from, to, setFrom, setTo } = usePeriod();

  const [categories, setCategories] = useState<Array<{ id: number; name: string }>>([]);
  const [accounts, setAccounts] = useState<Array<{ accountId: number; code: string; name: string }>>([]);
  const [employees, setEmployees] = useState<Array<{ id: string; name: string; baseSalary: string }>>([]);

  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [byCategory, setByCategory] = useState<Array<{ category: string; total: string; count: string }>>([]);
  const [expenseTotal, setExpenseTotal] = useState('0.00');
  const [salaries, setSalaries] = useState<SalaryRow[]>([]);
  const [drawings, setDrawings] = useState<DrawingRow[]>([]);
  const [drawingTotal, setDrawingTotal] = useState('0.00');

  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [expForm, setExpForm] = useState({ expenseDate: today(), categoryId: '', description: '', amount: '', accountId: '' });
  const [salForm, setSalForm] = useState({ employeeId: '', month: thisMonth(), salaryAmount: '', advanceAmount: '', payNow: '', accountId: '' });
  const [drwForm, setDrwForm] = useState({ drawingDate: today(), amount: '', purpose: '', accountId: '' });
  const [newEmployee, setNewEmployee] = useState({ name: '', designation: '', baseSalary: '' });
  const [showEmployee, setShowEmployee] = useState(false);

  const loadRef = useCallback(async () => {
    const [c, a, e] = await Promise.all([api.expenseCategories(), api.cashBank(), api.employees()]);
    setCategories(c.categories);
    setAccounts(a.accounts);
    setEmployees(e.employees);
    const first = String(a.accounts[0]?.accountId ?? '');
    setExpForm((f) => (f.accountId ? f : { ...f, accountId: first }));
    setSalForm((f) => (f.accountId ? f : { ...f, accountId: first }));
    setDrwForm((f) => (f.accountId ? f : { ...f, accountId: first }));
  }, []);

  const loadData = useCallback(async () => {
    if (tab === 'expenses') {
      const r = await api.expenses({ from, to });
      setExpenses(r.expenses);
      setByCategory(r.byCategory);
      setExpenseTotal(r.total);
    }
    if (tab === 'salaries') setSalaries((await api.salaries()).salaries);
    if (tab === 'drawings') {
      const r = await api.drawings({ from, to });
      setDrawings(r.drawings);
      setDrawingTotal(r.total);
    }
  }, [tab, from, to]);

  useEffect(() => {
    void loadRef().catch(() => setError('Could not load reference data. Your role may not include finance access.'));
  }, [loadRef]);

  useEffect(() => {
    void loadData().catch(() => {});
  }, [loadData]);

  async function submit(e: FormEvent, kind: Tab) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (kind === 'expenses') {
        const r = await api.createExpense({ ...expForm, categoryId: Number(expForm.categoryId), accountId: Number(expForm.accountId) });
        setFlash(`${r.docNo} recorded`);
        setExpForm((f) => ({ ...f, description: '', amount: '' }));
      }
      if (kind === 'salaries') {
        const r = await api.createSalary({ ...salForm, employeeId: Number(salForm.employeeId), accountId: Number(salForm.accountId) });
        setFlash(
          Number(r.remaining) > 0
            ? `${r.employee}: recorded, ${r.remaining} still owed`
            : `${r.employee}: recorded and paid in full`
        );
        setSalForm((f) => ({ ...f, salaryAmount: '', advanceAmount: '', payNow: '' }));
      }
      if (kind === 'drawings') {
        const r = await api.createDrawing({ ...drwForm, accountId: Number(drwForm.accountId) });
        setFlash(`${r.docNo} recorded`);
        setDrwForm((f) => ({ ...f, amount: '', purpose: '' }));
      }
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that');
    } finally {
      setBusy(false);
    }
  }

  async function addEmployee(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createEmployee(newEmployee);
      setFlash(`${newEmployee.name} added`);
      setNewEmployee({ name: '', designation: '', baseSalary: '' });
      setShowEmployee(false);
      await loadRef();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that person');
    } finally {
      setBusy(false);
    }
  }

  const matchedExpenses = useSearch(expenses, search, (e) => [e.description, e.category, e.docNo, e.method]);
  const matchedSalaries = useSearch(salaries, search, (s) => [s.employee, s.designation, s.month]);
  const matchedDrawings = useSearch(drawings, search, (d) => [d.purpose, d.docNo, d.method]);

  return (
    <>
      <OperationHeader operation="expenses" title="Money out" />

      {flash && <div className="alert alert-success">{flash}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <div className="choices">
        <Tabbed id="expenses" now={tab} set={setTab} title="Running costs" hint="Fuel, rent, power, repairs" />
        <Tabbed id="salaries" now={tab} set={setTab} title="Wages" hint="Monthly pay and advances" />
        <Tabbed id="drawings" now={tab} set={setTab} title="Owner drawings" hint="Money the owner takes" />
      </div>

      {/* ================================================== running costs === */}
      {tab === 'expenses' && (
        <>
          <form className="card" onSubmit={(e) => submit(e, 'expenses')}>
            <h3>Record a cost</h3>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="ed">Date</label>
                <input id="ed" type="date" max={today()} required value={expForm.expenseDate}
                  onChange={(e) => setExpForm((f) => ({ ...f, expenseDate: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="ec">What kind of cost</label>
                <select id="ec" required value={expForm.categoryId}
                  onChange={(e) => setExpForm((f) => ({ ...f, categoryId: e.target.value }))}>
                  <option value="">Select…</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="edesc">What was it for</label>
                <input id="edesc" required value={expForm.description}
                  onChange={(e) => setExpForm((f) => ({ ...f, description: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="eamt">Amount</label>
                <input id="eamt" required inputMode="decimal" value={expForm.amount}
                  onChange={(e) => setExpForm((f) => ({ ...f, amount: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="eacc">Paid from</label>
                <select id="eacc" required value={expForm.accountId}
                  onChange={(e) => setExpForm((f) => ({ ...f, accountId: e.target.value }))}>
                  {accounts.map((a) => <option key={a.accountId} value={a.accountId}>{a.name}</option>)}
                </select>
              </div>
            </div>
            <div className="actions">
              <button className="btn btn-primary" disabled={busy || !expForm.amount || !expForm.categoryId || !expForm.description}>
                Record cost
              </button>
            </div>
          </form>

          {byCategory.length > 0 && (
            <div className="card">
              <h3>Where it went</h3>
              <table className="data ledger-table">
                <thead><tr><th>Kind of cost</th><th className="num">Entries</th><th className="num">Total</th></tr></thead>
                <tbody>
                  {byCategory.map((c) => (
                    <tr key={c.category}>
                      <td>{c.category}</td>
                      <td className="num">{Number(c.count)}</td>
                      <td className="num"><Money value={c.total} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td>Total</td><td className="num" /><td className="num"><Money value={expenseTotal} /></td></tr></tfoot>
              </table>
              <div className="rows">
                {byCategory.map((c) => (
                  <div className="row-card" key={c.category}>
                    <div className="row-top">
                      <span className="row-title">{c.category}</span>
                      <span className="row-amount"><Money value={c.total} /></span>
                    </div>
                    <div className="row-meta"><span>{Number(c.count)} entries</span></div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <ListCard
            title="Costs recorded"
            from={from} to={to} setFrom={setFrom} setTo={setTo}
            search={search} setSearch={setSearch}
            count={matchedExpenses.length} total={expenses.length}
            empty="No costs recorded in this period."
          >
            <table className="data ledger-table">
              <thead><tr><th>Document</th><th>Date</th><th>Kind</th><th>What for</th><th>Paid from</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {matchedExpenses.map((x) => (
                  <tr key={x.id}>
                    <td><code>{x.docNo}</code></td>
                    <td>{String(x.date).slice(0, 10)}</td>
                    <td>{x.category}</td>
                    <td>{x.description}</td>
                    <td>{x.paidFrom}</td>
                    <td className="num"><Money value={x.amount} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="rows">
              {matchedExpenses.map((x) => (
                <div className="row-card" key={x.id}>
                  <div className="row-top">
                    <span className="row-title">{x.description}</span>
                    <span className="row-amount"><Money value={x.amount} /></span>
                  </div>
                  <div className="row-meta">
                    <span>{String(x.date).slice(0, 10)}</span><span>{x.category}</span><span>{x.paidFrom}</span>
                  </div>
                </div>
              ))}
            </div>
          </ListCard>
        </>
      )}

      {/* ========================================================= wages === */}
      {tab === 'salaries' && (
        <>
          {showEmployee ? (
            <form className="card" onSubmit={addEmployee}>
              <h3>Add someone to the payroll</h3>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="empn">Name</label>
                  <input id="empn" required value={newEmployee.name}
                    onChange={(e) => setNewEmployee((f) => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="field">
                  <label htmlFor="empd">Job</label>
                  <input id="empd" value={newEmployee.designation}
                    onChange={(e) => setNewEmployee((f) => ({ ...f, designation: e.target.value }))} />
                </div>
                <div className="field">
                  <label htmlFor="emps">Usual monthly pay</label>
                  <input id="emps" inputMode="decimal" value={newEmployee.baseSalary}
                    onChange={(e) => setNewEmployee((f) => ({ ...f, baseSalary: e.target.value }))} />
                </div>
              </div>
              <div className="actions">
                <button className="btn btn-primary" disabled={busy || !newEmployee.name}>Add</button>
                <button className="btn btn-ghost" type="button" onClick={() => setShowEmployee(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <div className="actions" style={{ border: 'none', paddingTop: 0, marginTop: 0, marginBottom: 24 }}>
              <button className="btn btn-ghost" onClick={() => setShowEmployee(true)}>Add someone to the payroll</button>
            </div>
          )}

          <form className="card" onSubmit={(e) => submit(e, 'salaries')}>
            <h3>Record a month's pay</h3>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="se">Who</label>
                <select id="se" required value={salForm.employeeId}
                  onChange={(e) => {
                    const emp = employees.find((x) => String(x.id) === e.target.value);
                    setSalForm((f) => ({
                      ...f,
                      employeeId: e.target.value,
                      salaryAmount: f.salaryAmount || (emp?.baseSalary && Number(emp.baseSalary) > 0 ? emp.baseSalary : ''),
                    }));
                  }}>
                  <option value="">Select…</option>
                  {employees.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="sm">Month</label>
                <input id="sm" type="month" required value={salForm.month}
                  onChange={(e) => setSalForm((f) => ({ ...f, month: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="ssal">Salary for the month</label>
                <input id="ssal" required inputMode="decimal" value={salForm.salaryAmount}
                  onChange={(e) => setSalForm((f) => ({ ...f, salaryAmount: e.target.value }))} />
              </div>
              <div className="field">
                <div className="label-row">
                  <label htmlFor="sadv">Advance already taken</label>
                  <Hint text="Money handed over earlier in the month. It counts towards the salary, not on top of it." />
                </div>
                <input id="sadv" inputMode="decimal" placeholder="0.00" value={salForm.advanceAmount}
                  onChange={(e) => setSalForm((f) => ({ ...f, advanceAmount: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="spay">Paying now</label>
                <input id="spay" inputMode="decimal" placeholder="0.00" value={salForm.payNow}
                  onChange={(e) => setSalForm((f) => ({ ...f, payNow: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="sacc">Paid from</label>
                <select id="sacc" value={salForm.accountId}
                  onChange={(e) => setSalForm((f) => ({ ...f, accountId: e.target.value }))}>
                  {accounts.map((a) => <option key={a.accountId} value={a.accountId}>{a.name}</option>)}
                </select>
              </div>
            </div>
            <p className="field-hint">Anything not paid now stays recorded as owed to them.</p>
            <div className="actions">
              <button className="btn btn-primary" disabled={busy || !salForm.employeeId || !salForm.salaryAmount}>
                Record pay
              </button>
            </div>
          </form>

          <ListCard
            title="Pay recorded"
            search={search} setSearch={setSearch}
            count={matchedSalaries.length} total={salaries.length}
            empty="No pay recorded yet."
          >
            <table className="data ledger-table">
              <thead><tr><th>Who</th><th>Month</th><th className="num">Salary</th><th className="num">Advance</th><th className="num">Paid</th><th className="num">Still owed</th></tr></thead>
              <tbody>
                {matchedSalaries.map((s) => (
                  <tr key={s.id}>
                    <td>{s.employee}</td>
                    <td>{String(s.month).slice(0, 7)}</td>
                    <td className="num"><Money value={s.salary} /></td>
                    <td className="num">{Number(s.advance) > 0 ? <Money value={s.advance} /> : ''}</td>
                    <td className="num"><Money value={s.paid} /></td>
                    <td className="num">{Number(s.remaining) > 0 ? <Money value={s.remaining} /> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="rows">
              {matchedSalaries.map((s) => (
                <div className="row-card" key={s.id}>
                  <div className="row-top">
                    <span className="row-title">{s.employee}</span>
                    <span className="row-amount"><Money value={s.salary} /></span>
                  </div>
                  <div className="row-meta">
                    <span>{String(s.month).slice(0, 7)}</span>
                    {Number(s.remaining) > 0 && <span className="pill warn">owed <Money value={s.remaining} /></span>}
                  </div>
                </div>
              ))}
            </div>
          </ListCard>
        </>
      )}

      {/* ============================================== owner drawings === */}
      {tab === 'drawings' && (
        <>
          <div className="alert alert-info">
            This is money the owner takes out for personal use. It is <strong>not</strong> a business cost, so it does
            not reduce profit. It reduces the owner's stake in the business instead.
          </div>

          <form className="card" onSubmit={(e) => submit(e, 'drawings')}>
            <h3>Record a drawing</h3>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="dd">Date</label>
                <input id="dd" type="date" max={today()} required value={drwForm.drawingDate}
                  onChange={(e) => setDrwForm((f) => ({ ...f, drawingDate: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="damt">Amount</label>
                <input id="damt" required inputMode="decimal" value={drwForm.amount}
                  onChange={(e) => setDrwForm((f) => ({ ...f, amount: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="dpur">What for</label>
                <input id="dpur" value={drwForm.purpose}
                  onChange={(e) => setDrwForm((f) => ({ ...f, purpose: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="dacc">Taken from</label>
                <select id="dacc" required value={drwForm.accountId}
                  onChange={(e) => setDrwForm((f) => ({ ...f, accountId: e.target.value }))}>
                  {accounts.map((a) => <option key={a.accountId} value={a.accountId}>{a.name}</option>)}
                </select>
              </div>
            </div>
            <div className="actions">
              <button className="btn btn-primary" disabled={busy || !drwForm.amount}>Record drawing</button>
            </div>
          </form>

          <ListCard
            title={`Drawings, totalling ${drawingTotal}`}
            from={from} to={to} setFrom={setFrom} setTo={setTo}
            search={search} setSearch={setSearch}
            count={matchedDrawings.length} total={drawings.length}
            empty="No drawings in this period."
          >
            <table className="data ledger-table">
              <thead><tr><th>Document</th><th>Date</th><th>What for</th><th>Taken from</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {matchedDrawings.map((d) => (
                  <tr key={d.id}>
                    <td><code>{d.docNo}</code></td>
                    <td>{String(d.date).slice(0, 10)}</td>
                    <td>{d.purpose ?? ''}</td>
                    <td>{d.takenFrom}</td>
                    <td className="num"><Money value={d.amount} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="rows">
              {matchedDrawings.map((d) => (
                <div className="row-card" key={d.id}>
                  <div className="row-top">
                    <span className="row-title">{d.purpose || 'Drawing'}</span>
                    <span className="row-amount"><Money value={d.amount} /></span>
                  </div>
                  <div className="row-meta"><span>{String(d.date).slice(0, 10)}</span><span>{d.takenFrom}</span></div>
                </div>
              ))}
            </div>
          </ListCard>
        </>
      )}
    </>
  );
}

function ListCard({
  title, from, to, setFrom, setTo, search, setSearch, count, total, empty, children,
}: {
  title: string;
  from?: string; to?: string;
  setFrom?: (v: string) => void; setTo?: (v: string) => void;
  search: string; setSearch: (v: string) => void;
  count: number; total: number; empty: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <Toolbar
        search={search}
        onSearch={setSearch}
        placeholder="Search"
        resultCount={count}
        totalCount={total}
        right={from && setFrom && setTo && to ? <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} /> : undefined}
      />
      {count === 0 ? <div className="empty-state">{empty}</div> : children}
    </div>
  );
}

function Tabbed({
  id, now, set, title, hint,
}: { id: Tab; now: Tab; set: (v: Tab) => void; title: string; hint: string }) {
  return (
    <button className={now === id ? 'choice active' : 'choice'} onClick={() => set(id)}>
      <span className="choice-title">{title}</span>
      <span className="choice-hint">{hint}</span>
    </button>
  );
}
