/**
 * Navigation and reference routes.
 *
 * /api/nav returns only the modules the caller may see (§6.1) — the frontend
 * renders what it is given rather than deciding for itself, so a permission
 * change never leaves a stale link visible.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth, requirePermission } from '../rbac/guard.ts';
import type { PermissionCode } from '../rbac/matrix.ts';

interface NavItem {
  label: string;
  path: string;
  permission?: PermissionCode;
  children?: NavItem[];
}

/**
 * Navigation.
 *
 * Deliberately shallow. Operations that differ only by *which oil* or *where it
 * came from* are one screen with a field, not several screens with duplicated
 * forms — a purchase from an in-house driver and a purchase under a company
 * agreement are the same event recorded the same way.
 */
const NAV: NavItem[] = [
  { label: 'Dashboard', path: '/' },
  {
    label: 'Operations',
    path: '/ops',
    permission: 'operations.view',
    children: [
      { label: 'Purchases', path: '/purchases', permission: 'operations.view' },
      { label: 'Sales', path: '/sales', permission: 'operations.view' },
      { label: 'Inventory', path: '/inventory', permission: 'operations.view' },
      { label: 'Reports', path: '/reports/operations', permission: 'reports.view' },
    ],
  },
  {
    label: 'Water Treatment',
    path: '/wtd',
    permission: 'operations.view',
    children: [
      { label: 'Wastewater Receptions', path: '/wtd/receptions', permission: 'operations.view' },
      { label: 'Treatment Batches', path: '/wtd/batches', permission: 'operations.view' },
      { label: 'Treated Water Sales', path: '/wtd/water-sales', permission: 'operations.view' },
    ],
  },
  {
    label: 'Finance',
    path: '/finance',
    permission: 'finance.view',
    children: [
      { label: 'Cash and Bank', path: '/finance/ledgers', permission: 'finance.view' },
      { label: 'Expenses and Salaries', path: '/finance/expenses', permission: 'finance.view' },
      { label: 'Payments', path: '/finance/payments', permission: 'finance.view' },
      { label: 'Weight Fee Refunds', path: '/finance/weight-fees', permission: 'finance.view' },
      { label: 'Journal', path: '/finance/journal', permission: 'journal.manual' },
      { label: 'Profit and Loss', path: '/finance/pnl', permission: 'profit.view' },
    ],
  },
  {
    label: 'Administration',
    path: '/admin',
    children: [
      { label: 'Drivers', path: '/drivers', permission: 'operations.view' },
      { label: 'Suppliers', path: '/suppliers', permission: 'operations.view' },
      { label: 'Profiles', path: '/admin/profiles' },
      { label: 'Users', path: '/admin/users', permission: 'users.manage' },
      { label: 'Activity Log', path: '/admin/activity-log', permission: 'activity_log.view' },
      { label: 'Settings', path: '/admin/settings', permission: 'settings.manage' },
    ],
  },
];

function filterNav(items: NavItem[], held: Set<string>): NavItem[] {
  const out: NavItem[] = [];
  for (const item of items) {
    if (item.permission && !held.has(item.permission)) continue;
    const children = item.children ? filterNav(item.children, held) : undefined;
    // A parent with children but nothing visible under it is dropped.
    if (item.children && (!children || children.length === 0)) continue;
    out.push(children ? { ...item, children } : { ...item });
  }
  return out;
}

export async function metaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    const r = await app.db.query<{ n: number }>('SELECT 1::int AS n');
    return { ok: r.rows[0]?.n === 1, service: 'orcms', time: new Date().toISOString() };
  });

  app.get('/api/nav', { preHandler: requireAuth }, async (request) => {
    const held = new Set(request.auth!.user.permissions);
    return { items: filterNav(NAV, held) };
  });

  /** Reference data the shell needs; safe for any authenticated user. */
  app.get('/api/reference', { preHandler: requireAuth }, async () => {
    const [items, accounts, year, company] = await Promise.all([
      app.db.query('SELECT code, name, division, uom FROM inventory_items ORDER BY id'),
      app.db.query(
        `SELECT code, name, subtype FROM accounts
          WHERE subtype IN ('CASH','BANK') AND is_active ORDER BY code`
      ),
      app.db.query('SELECT label, starts_on, ends_on, is_locked FROM fiscal_years ORDER BY starts_on DESC'),
      app.db.query(`SELECT value FROM settings WHERE key = 'company.profile'`),
    ]);
    return {
      inventoryItems: items.rows,
      paymentAccounts: accounts.rows,
      fiscalYears: year.rows,
      company: company.rows[0]?.value ?? {},
    };
  });

  /**
   * The profiles this system has, read from the database rather than a
   * hardcoded list, so the screen can never drift from what is enforced.
   */
  app.get('/api/profiles', { preHandler: requireAuth }, async () => {
    const roles = await app.db.query<{
      code: string; name: string; description: string; requires_2fa: boolean; users: string;
    }>(
      `SELECT r.code, r.name, r.description, r.requires_2fa,
              (SELECT count(*) FROM user_roles ur
                 JOIN users u ON u.id = ur.user_id
                WHERE ur.role_id = r.id AND u.deleted_at IS NULL) AS users
         FROM roles r ORDER BY r.id`
    );

    const grants = await app.db.query<{ role: string; permission: string; grp: string; label: string }>(
      `SELECT r.code AS role, p.code AS permission, p.grp, p.name AS label
         FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
        ORDER BY p.grp, p.code`
    );

    const all = await app.db.query<{ code: string; grp: string; name: string }>(
      'SELECT code, grp, name FROM permissions ORDER BY grp, code'
    );

    const byRole = new Map<string, Set<string>>();
    for (const g of grants.rows) {
      if (!byRole.has(g.role)) byRole.set(g.role, new Set());
      byRole.get(g.role)!.add(g.permission);
    }

    return {
      profiles: roles.rows.map((r) => ({
        code: r.code,
        name: r.name,
        description: r.description,
        requiresTwoFactor: r.requires_2fa,
        userCount: Number(r.users),
        permissions: [...(byRole.get(r.code) ?? [])],
      })),
      permissions: all.rows.map((p) => ({ code: p.code, group: p.grp, label: p.name })),
    };
  });

  /** Chart of accounts, finance roles only. */
  app.get('/api/accounts', { preHandler: requirePermission('finance.view') }, async () => {
    const r = await app.db.query(
      'SELECT id, code, name, type, subtype, is_control, is_active FROM accounts ORDER BY code'
    );
    return { accounts: r.rows };
  });
}
