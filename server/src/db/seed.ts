/**
 * Seeders. Idempotent — safe to re-run; existing rows are left alone.
 * IMPLEMENTATION.md §4.5 (chart of accounts), §4.4 (items), §6.1 (matrix), §6.11 (settings)
 */
import type { Db } from './client.ts';
import { env } from '../env.ts';
import { hashPassword } from '../lib/password.ts';
import { MATRIX, PERMISSIONS, ROLE_META, ROLES } from '../modules/rbac/matrix.ts';

interface AccountSeed {
  code: string;
  name: string;
  type: string;
  subtype?: string;
  control?: boolean;
  bankName?: string;
}

/** §4.5 — the seeded chart of accounts. */
const ACCOUNTS: AccountSeed[] = [
  { code: '1010', name: 'Cash in Hand', type: 'ASSET', subtype: 'CASH' },
  { code: '1011', name: 'Petty Cash', type: 'ASSET', subtype: 'CASH' },
  { code: '1020', name: 'Bank Account — Primary', type: 'ASSET', subtype: 'BANK', bankName: 'Primary Bank' },
  { code: '1100', name: 'Accounts Receivable', type: 'ASSET', subtype: 'AR', control: true },
  { code: '1200', name: 'Inventory — Used Cooking Oil', type: 'ASSET', subtype: 'INVENTORY', control: true },
  { code: '1210', name: 'Inventory — Used Engine Oil', type: 'ASSET', subtype: 'INVENTORY', control: true },
  { code: '1220', name: 'Inventory — Treated Water', type: 'ASSET', subtype: 'INVENTORY', control: true },
  { code: '1230', name: 'Inventory — Wastewater (memo)', type: 'ASSET', subtype: 'INVENTORY', control: true },
  { code: '1300', name: 'Government Weight Fee Receivable', type: 'ASSET', subtype: 'RECEIVABLE', control: true },
  { code: '2100', name: 'Accounts Payable', type: 'LIABILITY', subtype: 'AP', control: true },
  { code: '2200', name: 'Salaries Payable', type: 'LIABILITY' },
  { code: '3000', name: "Owner's Capital", type: 'EQUITY' },
  { code: '3100', name: "Owner's Drawings", type: 'EQUITY' },
  { code: '4100', name: 'Export Sales — UCO', type: 'INCOME' },
  { code: '4200', name: 'Local Sales — UEO', type: 'INCOME' },
  { code: '4300', name: 'Treatment Service Income', type: 'INCOME' },
  { code: '4400', name: 'Treated Water Sales', type: 'INCOME' },
  { code: '5100', name: 'COGS — UCO', type: 'EXPENSE', subtype: 'COGS' },
  { code: '5200', name: 'COGS — UEO', type: 'EXPENSE', subtype: 'COGS' },
  { code: '5300', name: 'COGS — Treated Water', type: 'EXPENSE', subtype: 'COGS' },
  { code: '5400', name: 'Treatment Processing Cost', type: 'EXPENSE' },
  { code: '6100', name: 'Salaries', type: 'EXPENSE' },
  { code: '6110', name: 'Fuel', type: 'EXPENSE' },
  { code: '6120', name: 'Electricity', type: 'EXPENSE' },
  { code: '6130', name: 'Water', type: 'EXPENSE' },
  { code: '6140', name: 'Rent', type: 'EXPENSE' },
  { code: '6150', name: 'Kitchen', type: 'EXPENSE' },
  { code: '6160', name: 'Vehicle Maintenance', type: 'EXPENSE' },
  { code: '6170', name: 'Machinery Maintenance', type: 'EXPENSE' },
  { code: '6180', name: 'Chemicals', type: 'EXPENSE' },
  { code: '6190', name: 'Office Expenses', type: 'EXPENSE' },
  { code: '6200', name: 'Miscellaneous', type: 'EXPENSE' },
  { code: '6900', name: 'Government Weight Fee Expense', type: 'EXPENSE' },
];

/** Expense category -> account code (§4.9). */
const EXPENSE_CATEGORIES: Array<[string, string]> = [
  ['Salaries', '6100'],
  ['Fuel', '6110'],
  ['Electricity', '6120'],
  ['Water', '6130'],
  ['Rent', '6140'],
  ['Kitchen', '6150'],
  ['Vehicle Maintenance', '6160'],
  ['Machinery Maintenance', '6170'],
  ['Chemicals', '6180'],
  ['Office Expenses', '6190'],
  ['Miscellaneous', '6200'],
];

/** §4.4 — four inventory items. Wastewater is unvalued (BR-07). */
const ITEMS: Array<{ code: string; name: string; division: string; valued: boolean; account: string; low: number }> = [
  { code: 'UCO', name: 'Used Cooking Oil', division: 'UCO', valued: true, account: '1200', low: 50 },
  { code: 'UEO', name: 'Used Engine Oil', division: 'UEO', valued: true, account: '1210', low: 50 },
  { code: 'WASTEWATER', name: 'Wastewater', division: 'WTD', valued: false, account: '1230', low: 0 },
  { code: 'TREATED_WATER', name: 'Treated Water', division: 'WTD', valued: true, account: '1220', low: 100 },
];

const SETTINGS: Array<[string, unknown]> = [
  ['company.profile', { name: 'Javeriya Lubricants', address: '', phone: '', email: '', taxId: '' }],
  ['fee.label', { singular: 'Weight Fee', plural: 'Weight Fees' }],
  ['refund.aging_days', { threshold: 45 }],
  ['year_end.lock_policy', { lockClosedYears: true, allowUnlockByAdmin: true }],
  [
    'payment_methods',
    [
      { label: 'Cash', accountCode: '1010' },
      { label: 'Petty Cash', accountCode: '1011' },
      { label: 'Bank Transfer', accountCode: '1020' },
      { label: 'Online', accountCode: '1020' },
      { label: 'Cheque', accountCode: '1020' },
    ],
  ],
  ['inventory.costing_method', { method: 'WEIGHTED_MOVING_AVERAGE' }],
  ['treatment.allocation_method', { method: 'RELATIVE_SALES_VALUE' }],
  ['container.default_capacity_drums', { value: 80 }],
  ['tanker.default_capacity_drums', { value: 60 }],
  ['batch.yield_tolerance', { factor: 1.05 }],
  ['base.currency', { code: 'PKR', symbol: 'Rs' }],
];

export interface SeedResult {
  accounts: number;
  items: number;
  roles: number;
  permissions: number;
  settings: number;
  adminCreated: boolean;
  fiscalYear: string;
}

export async function seed(db: Db, opts: { log?: (m: string) => void } = {}): Promise<SeedResult> {
  const log = opts.log ?? (() => {});

  return db.transaction(async (tx) => {
    /* ---------------------------------------------------- chart of accounts */
    for (const a of ACCOUNTS) {
      await tx.query(
        `INSERT INTO accounts (code, name, type, subtype, is_control, bank_name)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`,
        [a.code, a.name, a.type, a.subtype ?? null, a.control ?? false, a.bankName ?? null]
      );
    }
    log(`  ${ACCOUNTS.length} accounts`);

    const accountIdByCode = new Map<string, number>();
    const accRows = await tx.query<{ id: number; code: string }>('SELECT id, code FROM accounts');
    for (const r of accRows.rows) accountIdByCode.set(r.code, r.id);

    /* ------------------------------------------------------ expense categories */
    for (const [name, accountCode] of EXPENSE_CATEGORIES) {
      await tx.query(
        `INSERT INTO expense_categories (name, account_id) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING`,
        [name, accountIdByCode.get(accountCode)]
      );
    }

    /* -------------------------------------------------------- inventory items */
    for (const i of ITEMS) {
      await tx.query(
        `INSERT INTO inventory_items (code, name, division, is_valued, account_id, low_threshold)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`,
        [i.code, i.name, i.division, i.valued, accountIdByCode.get(i.account), i.low]
      );
    }
    await tx.query(
      `INSERT INTO stock_balances (item_id)
       SELECT id FROM inventory_items
       ON CONFLICT (item_id) DO NOTHING`
    );
    log(`  ${ITEMS.length} inventory items`);

    /* -------------------------------------------------- roles and permissions */
    for (const p of PERMISSIONS) {
      await tx.query(`INSERT INTO permissions (code, grp, name) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING`, [
        p.code,
        p.grp,
        p.name,
      ]);
    }
    for (const code of ROLES) {
      const meta = ROLE_META[code];
      await tx.query(
        `INSERT INTO roles (code, name, description, is_enabled, requires_2fa)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (code) DO UPDATE
           SET name = EXCLUDED.name,
               description = EXCLUDED.description,
               requires_2fa = EXCLUDED.requires_2fa`,
        [code, meta.name, meta.description, meta.enabled, meta.requires2fa]
      );
    }

    const roleIdByCode = new Map<string, number>();
    const roleRows = await tx.query<{ id: number; code: string }>('SELECT id, code FROM roles');
    for (const r of roleRows.rows) roleIdByCode.set(r.code, r.id);

    const permIdByCode = new Map<string, number>();
    const permRows = await tx.query<{ id: number; code: string }>('SELECT id, code FROM permissions');
    for (const r of permRows.rows) permIdByCode.set(r.code, r.id);

    // Rewrite grants from the matrix so the database always mirrors the doc.
    for (const roleCode of ROLES) {
      const roleId = roleIdByCode.get(roleCode)!;
      await tx.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
      for (const permCode of MATRIX[roleCode]) {
        await tx.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2)', [
          roleId,
          permIdByCode.get(permCode),
        ]);
      }
    }
    log(`  ${ROLES.length} roles, ${PERMISSIONS.length} permissions`);

    /* ---------------------------------------------------------- fiscal year */
    const year = new Date().getUTCFullYear();
    await tx.query(
      `INSERT INTO fiscal_years (label, starts_on, ends_on)
       VALUES ($1,$2,$3) ON CONFLICT (label) DO NOTHING`,
      [String(year), `${year}-01-01`, `${year}-12-31`]
    );

    /* ------------------------------------------------------------- settings */
    for (const [key, value] of SETTINGS) {
      await tx.query(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [
        key,
        JSON.stringify(value),
      ]);
    }

    /* --------------------------------------------- bootstrap administrator */
    const existing = await tx.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [
      env.seedAdminUsername,
    ]);
    let adminCreated = false;
    if (existing.rows.length === 0) {
      const hash = await hashPassword(env.seedAdminPassword);
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO users (name, username, password_hash) VALUES ($1,$2,$3) RETURNING id`,
        ['System Administrator', env.seedAdminUsername, hash]
      );
      await tx.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [
        ins.rows[0]!.id,
        roleIdByCode.get('ADMIN'),
      ]);
      adminCreated = true;
      log(`  bootstrap admin, username "${env.seedAdminUsername}"`);
    }

    return {
      accounts: ACCOUNTS.length,
      items: ITEMS.length,
      roles: ROLES.length,
      permissions: PERMISSIONS.length,
      settings: SETTINGS.length,
      adminCreated,
      fiscalYear: String(year),
    };
  });
}
