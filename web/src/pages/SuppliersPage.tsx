import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Party } from '../api';
import { Money } from '../components/Money';
import { OperationHeader } from '../components/OperationHeader';
import { Toolbar, useSearch } from '../components/Toolbar';

/**
 * Suppliers, on their own page.
 *
 * Previously this shared a screen with drivers behind a toggle, which meant
 * the page title said one thing and the content said another. They are
 * different records maintained by different people at different times, so they
 * are now two destinations in the sidebar.
 */
export function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [search, setSearch] = useState('');
  const [owing, setOwing] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [form, setForm] = useState({ name: '', company: '', phone: '', address: '' });

  const load = useCallback(async () => {
    const r = await api.parties('SUPPLIER');
    setSuppliers(r.parties);
  }, []);

  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  const matched = useSearch(suppliers, search, (p) => [p.name, p.code, p.company, p.phone]);
  const rows = owing === 'owed' ? matched.filter((p) => Number(p.outstandingPayable) > 0) : matched;

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createParty({ type: 'SUPPLIER', ...form });
      setFlash(`${form.name} added`);
      setForm({ name: '', company: '', phone: '', address: '' });
      setShowAdd(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add this supplier');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <OperationHeader operation="suppliers" />

      {flash && <div className="alert alert-success">{flash}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {showAdd ? (
        <form className="card" onSubmit={add}>
          <h3>Add a supplier</h3>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="sname">Name</label>
              <input id="sname" required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="scomp">Company</label>
              <input id="scomp" value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="sphone">Phone</label>
              <input id="sphone" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="saddr">Address</label>
              <input id="saddr" value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
            </div>
          </div>
          <div className="actions">
            <button className="btn btn-primary" disabled={busy || !form.name}>Add supplier</button>
            <button className="btn btn-ghost" type="button" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="actions" style={{ border: 'none', paddingTop: 0, marginTop: 0, marginBottom: 24 }}>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>Add a supplier</button>
        </div>
      )}

      <div className="card">
        <h3>Suppliers</h3>

        <Toolbar
          search={search}
          onSearch={setSearch}
          placeholder="Search by name, code, company or phone"
          resultCount={rows.length}
          totalCount={suppliers.length}
          filters={[
            {
              label: 'Balance',
              value: owing,
              onChange: setOwing,
              options: [
                { label: 'All suppliers', value: '' },
                { label: 'We owe money', value: 'owed' },
              ],
            },
          ]}
        />

        {rows.length === 0 ? (
          <div className="empty-state">
            {suppliers.length === 0 ? 'No suppliers yet.' : 'Nothing matches that search.'}
          </div>
        ) : (
          <>
            <div className="rows">
              {rows.map((p) => (
                <div className="row-card" key={p.id}>
                  <div className="row-top">
                    <span className="row-title">{p.name}</span>
                    {Number(p.outstandingPayable) > 0 && (
                      <span className="row-amount"><Money value={p.outstandingPayable} /></span>
                    )}
                  </div>
                  <div className="row-meta">
                    <span>{p.code}</span>
                    {p.company && <span>{p.company}</span>}
                    {p.phone && <span>{p.phone}</span>}
                  </div>
                </div>
              ))}
            </div>

            <table className="data ledger-table">
              <thead>
                <tr><th>Code</th><th>Name</th><th>Company</th><th>Phone</th><th className="num">We owe</th></tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td><code>{p.code}</code></td>
                    <td>{p.name}</td>
                    <td>{p.company ?? ''}</td>
                    <td>{p.phone ?? ''}</td>
                    <td className="num">{Number(p.outstandingPayable) > 0 ? <Money value={p.outstandingPayable} /> : ''}</td>
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
