import { useLocation } from 'react-router-dom';

/**
 * Every navigable route resolves to something, so the nav is honest about what
 * exists rather than dead-ending. Each page names the feature that will replace
 * it, using the IDs from the build order in IMPLEMENTATION.md §12.
 */
const FEATURE_BY_PATH: Record<string, string> = {
  '/uco/purchases': 'F1: Purchase entry',
  '/uco/collections': 'F3: Driver collections',
  '/uco/agreements': 'F4: Direct agreement purchases',
  '/uco/export-sales': 'F6: Export sales with container validation',
  '/uco/containers': 'F6: Container records',
  '/uco/reports': 'H5: UCO report set',
  '/ueo/purchases': 'F1 / F7: Purchase entry, UEO division',
  '/ueo/local-sales': 'F7: Local sales with tanker',
  '/ueo/tankers': 'F7: Tanker records',
  '/ueo/reports': 'H6: UEO report set',
  '/wtd/companies': 'D1: Industrial companies',
  '/wtd/receptions': 'F8: Wastewater reception (service income, BR-06)',
  '/wtd/batches': 'F9 / F10: Treatment batch and completion',
  '/wtd/water-sales': 'F11: Treated water sales',
  '/wtd/reports': 'H7: WTD report set',
  '/inventory': 'C1 to C4: inventory core and movement ledger',
  '/finance/expenses': 'G1: Expenses',
  '/finance/salaries': 'G2: Salaries',
  '/finance/drawings': "G3. Owner's drawings (BR-12)",
  '/finance/payments': 'E3: Payments and allocation',
  '/finance/ledgers': 'B6: Cash and bank ledgers',
  '/finance/journal': 'B5: Manual journal entry',
  '/finance/reconciliation': 'G6 / G7: Bank reconciliation',
  '/finance/weight-fees': 'G4 / G5: Weight fee refund pipeline',
  '/finance/pnl': 'H9: Profit and loss',
  '/admin/drivers': 'D4: Drivers and vacations',
  '/admin/parties': 'D1 / D2: Parties and party ledger',
  '/admin/users': 'A4: User management UI',
  '/admin/activity-log': 'A7: Activity log viewer',
  '/admin/settings': 'A8: Settings UI',
};

export function PlaceholderPage() {
  const { pathname } = useLocation();
  const feature = FEATURE_BY_PATH[pathname];

  return (
    <div className="card">
      <div className="empty-state">
        {feature ? (
          <>
            <div style={{ fontSize: '2rem', marginBottom: 8 }}>◻</div>
            <h2 style={{ margin: '0 0 6px', fontSize: '1.05rem', color: 'var(--fg)' }}>Not built yet</h2>
            <p style={{ margin: 0 }}>
              This screen arrives with feature <strong>{feature}</strong>.
            </p>
            <p style={{ marginTop: 12, fontSize: '0.85rem' }}>
              The build order is in IMPLEMENTATION.md §12. Nothing that writes to the ledgers is built until the
              ledger core is proven.
            </p>
          </>
        ) : (
          <>
            <h2 style={{ margin: '0 0 6px', fontSize: '1.05rem', color: 'var(--fg)' }}>Page not found</h2>
            <p style={{ margin: 0 }}>
              No screen is registered at <code>{pathname}</code>.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
