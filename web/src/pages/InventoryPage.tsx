import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type StockItem, type Tank } from '../api';
import { Money } from '../components/Money';
import { OperationHeader } from '../components/OperationHeader';
import { Toolbar, useSearch } from '../components/Toolbar';
import { useAuth } from '../auth/AuthContext';

/**
 * Stock and the tanks it sits in.
 *
 * Item totals answer "how much do we have". Tanks answer "where is it, and can
 * we take another load", which is the question that actually stops a delivery
 * at the gate. Both come from the same movement ledger.
 */
export function InventoryPage() {
  const { can } = useAuth();
  const [items, setItems] = useState<StockItem[]>([]);
  const [tanks, setTanks] = useState<Tank[]>([]);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [reading, setReading] = useState<Tank | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [form, setForm] = useState({ code: '', name: '', itemId: '', capacity: '', deadStock: '', location: '' });
  const [dip, setDip] = useState({ measured: '', notes: '' });

  const load = useCallback(async () => {
    const r = await api.inventory();
    setItems(r.items);
    setTanks(r.tanks);
  }, []);

  useEffect(() => {
    void load().catch(() => {});
  }, [load]);

  const matched = useSearch(tanks, search, (t) => [t.code, t.name, t.itemName, t.location]);
  const canManage = can('masters.manage');

  async function addTank(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createTank({
        code: form.code,
        name: form.name,
        itemId: Number(form.itemId),
        capacity: form.capacity,
        deadStock: form.deadStock || '0',
        location: form.location || null,
      });
      setFlash(`${form.name} added`);
      setForm({ code: '', name: '', itemId: '', capacity: '', deadStock: '', location: '' });
      setShowAdd(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add this tank');
    } finally {
      setBusy(false);
    }
  }

  async function saveReading(e: FormEvent) {
    e.preventDefault();
    if (!reading) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.tankReading(reading.id, {
        readOn: new Date().toISOString().slice(0, 10),
        measured: dip.measured,
        notes: dip.notes || null,
      });
      setFlash(
        Number(r.difference) === 0
          ? `${reading.name} matches the books exactly.`
          : `${reading.name}: measured ${r.measured}, books say ${r.book}. Difference of ${r.difference} recorded.`
      );
      setReading(null);
      setDip({ measured: '', notes: '' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that reading');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <OperationHeader operation="inventory" />

      {flash && <div className="alert alert-success">{flash}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <div className="card-grid">
        {items
          .filter((i) => i.division !== 'WTD' || Number(i.quantity) > 0)
          .map((i) => (
            <div className="card" key={i.itemId}>
              <h3>{i.name}</h3>
              <div className="stat">{trim(i.quantity)}</div>
              <div className="stat-label">drums on hand</div>
              <div style={{ marginTop: 14, fontSize: '0.89rem', color: 'var(--fg-muted)' }}>
                Worth <Money value={i.value} /> · <Money value={i.avgUnitCost} /> a drum
              </div>
              {i.isLow && (
                <div style={{ marginTop: 12 }}>
                  <span className="pill warn">running low</span>
                </div>
              )}
            </div>
          ))}
      </div>

      <div className="card">
        <h3>Tanks</h3>

        {canManage && !showAdd && (
          <div className="actions" style={{ border: 'none', paddingTop: 0, marginTop: 0, marginBottom: 20 }}>
            <button className="btn btn-primary" onClick={() => setShowAdd(true)}>Add a tank</button>
          </div>
        )}

        {showAdd && (
          <form onSubmit={addTank} style={{ marginBottom: 26 }}>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="tcode">Tank code</label>
                <input id="tcode" required placeholder="T-01" value={form.code}
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="tname">Name</label>
                <input id="tname" required placeholder="North tank" value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="titem">What it stores</label>
                <select id="titem" required value={form.itemId}
                  onChange={(e) => setForm((f) => ({ ...f, itemId: e.target.value }))}>
                  <option value="">Select…</option>
                  {items.map((i) => (
                    <option key={i.itemId} value={i.itemId}>{i.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="tcap">Capacity in drums</label>
                <input id="tcap" required inputMode="decimal" value={form.capacity}
                  onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="tdead">Unusable bottom</label>
                <input id="tdead" inputMode="decimal" placeholder="0" value={form.deadStock}
                  onChange={(e) => setForm((f) => ({ ...f, deadStock: e.target.value }))} />
                <p className="field-hint">Sludge or heel that cannot be pumped out.</p>
              </div>
              <div className="field">
                <label htmlFor="tloc">Location</label>
                <input id="tloc" value={form.location}
                  onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} />
              </div>
            </div>
            <div className="actions">
              <button className="btn btn-primary" disabled={busy || !form.code || !form.name || !form.itemId || !form.capacity}>
                Add tank
              </button>
              <button className="btn btn-ghost" type="button" onClick={() => setShowAdd(false)}>Cancel</button>
            </div>
          </form>
        )}

        {tanks.length > 0 && (
          <Toolbar
            search={search}
            onSearch={setSearch}
            placeholder="Search tanks by code, name or what they hold"
            resultCount={matched.length}
            totalCount={tanks.length}
          />
        )}

        {matched.length === 0 ? (
          <div className="empty-state">
            {tanks.length === 0
              ? 'No tanks yet. Add your storage tanks so deliveries can be checked against capacity.'
              : 'Nothing matches that search.'}
          </div>
        ) : (
          <div className="tank-grid">
            {matched.map((t) => (
              <div className="tank" key={t.id}>
                <div className="tank-head">
                  <div>
                    <span className="tank-name">{t.name}</span>
                    <span className="tank-sub">
                      {t.code} · {t.itemName}
                      {t.location ? ` · ${t.location}` : ''}
                    </span>
                  </div>
                  {t.status !== 'ACTIVE' && <span className="pill warn">{t.status.toLowerCase()}</span>}
                </div>

                <div className="gauge" role="img" aria-label={`${t.usablePercent} percent full`}>
                  <div
                    className={t.usablePercent >= 90 ? 'gauge-fill full' : 'gauge-fill'}
                    style={{ width: `${Math.min(100, t.usablePercent)}%` }}
                  />
                </div>

                <div className="tank-figures">
                  <span><strong>{trim(t.contents)}</strong> in tank</span>
                  <span><strong>{trim(t.available)}</strong> free</span>
                  <span className="tank-cap">of {trim(t.capacity)}</span>
                </div>

                <button className="btn btn-ghost" onClick={() => setReading(t)}>Record a dip reading</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {reading && (
        <form className="card" onSubmit={saveReading}>
          <h3>Dip reading: {reading.name}</h3>
          <p className="field-hint" style={{ marginTop: -8, marginBottom: 18 }}>
            The books say this tank holds <strong>{trim(reading.contents)}</strong> drums. Enter what was measured. The
            difference is recorded for review, and nothing is changed automatically.
          </p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="measured">Measured drums</label>
              <input id="measured" required inputMode="decimal" value={dip.measured}
                onChange={(e) => setDip((d) => ({ ...d, measured: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="dipnote">Note</label>
              <input id="dipnote" value={dip.notes} onChange={(e) => setDip((d) => ({ ...d, notes: e.target.value }))} />
            </div>
          </div>
          <div className="actions">
            <button className="btn btn-primary" disabled={busy || !dip.measured}>Record reading</button>
            <button className="btn btn-ghost" type="button" onClick={() => setReading(null)}>Cancel</button>
          </div>
        </form>
      )}
    </>
  );
}

function trim(q: string): string {
  return String(q).replace(/\.0+$/, '');
}
