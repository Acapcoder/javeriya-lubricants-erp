/**
 * A2 — schema migrations and seeders.
 * Done when: a fresh database migrates and seeds with no manual step.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from './helpers.ts';
import { createDb } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';

let h: Harness;
before(async () => {
  h = await createHarness();
});
after(async () => {
  await h.close();
});

describe('A2 — schema', () => {
  test('every table from IMPLEMENTATION.md §4 exists', async () => {
    const expected = [
      'users', 'roles', 'permissions', 'role_permissions', 'user_roles', 'sessions',
      'login_attempts', 'fiscal_years', 'settings',
      'attachments', 'activity_logs', 'notifications',
      'parties', 'agreements', 'drivers', 'driver_vacations', 'employees',
      'accounts', 'journal_entries', 'journal_lines',
      'inventory_items', 'stock_movements', 'stock_balances',
      'purchases', 'weight_fees', 'export_sales', 'containers',
      'local_sales', 'tankers',
      'wastewater_receptions', 'treatment_batches', 'treatment_outputs', 'treated_water_sales',
      'expense_categories', 'expenses', 'salaries', 'owner_drawings',
      'payments', 'payment_allocations', 'bank_statement_lines', 'monthly_summaries',
    ];
    const res = await h.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const present = new Set(res.rows.map((r) => r.table_name));
    const missing = expected.filter((t) => !present.has(t));
    assert.deepEqual(missing, [], `missing tables: ${missing.join(', ')}`);
  });

  test('migrations are idempotent — re-running applies nothing', async () => {
    const result = await migrate(h.db);
    assert.equal(result.applied.length, 0);
    assert.ok(result.skipped.length >= 7);
  });

  test('an applied migration cannot be silently edited', async () => {
    await h.db.query(`UPDATE schema_migrations SET checksum = 'deadbeef' WHERE filename = '001_types_and_config.sql'`);
    await assert.rejects(() => migrate(h.db), /has changed since it was applied/);
    // restore so later tests are unaffected
    const { createHash } = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
    const sql = await readFile(join(dir, '001_types_and_config.sql'), 'utf8');
    const sum = createHash('sha256').update(sql).digest('hex');
    await h.db.query(`UPDATE schema_migrations SET checksum = $1 WHERE filename = '001_types_and_config.sql'`, [sum]);
  });

  test('seed is idempotent', async () => {
    const before = await h.db.query<{ n: string }>('SELECT count(*) AS n FROM accounts');
    await seed(h.db);
    const after = await h.db.query<{ n: string }>('SELECT count(*) AS n FROM accounts');
    assert.equal(after.rows[0]!.n, before.rows[0]!.n);
  });
});

describe('A2 — seeded reference data', () => {
  test('chart of accounts includes the control accounts', async () => {
    const res = await h.db.query<{ code: string; is_control: boolean }>(
      `SELECT code, is_control FROM accounts WHERE code IN ('1100','1200','1210','1220','2100','1300')`
    );
    assert.equal(res.rows.length, 6);
    for (const row of res.rows) {
      assert.equal(row.is_control, true, `${row.code} must be a control account (BR-27)`);
    }
  });

  test('multiple cash and bank accounts are supported', async () => {
    const res = await h.db.query<{ subtype: string }>(
      `SELECT subtype FROM accounts WHERE subtype IN ('CASH','BANK')`
    );
    const cash = res.rows.filter((r) => r.subtype === 'CASH').length;
    const bank = res.rows.filter((r) => r.subtype === 'BANK').length;
    assert.ok(cash >= 2, 'expected more than one cash account');
    assert.ok(bank >= 1);
  });

  test('four inventory items, wastewater unvalued (BR-07)', async () => {
    const res = await h.db.query<{ code: string; is_valued: boolean; division: string }>(
      'SELECT code, is_valued, division FROM inventory_items ORDER BY id'
    );
    assert.deepEqual(res.rows.map((r) => r.code), ['UCO', 'UEO', 'WASTEWATER', 'TREATED_WATER']);
    const ww = res.rows.find((r) => r.code === 'WASTEWATER')!;
    assert.equal(ww.is_valued, false, 'wastewater carries no cost basis — the company is paid to take it');
    assert.equal(ww.division, 'WTD');
  });

  test('every inventory item has an opening balance row', async () => {
    const res = await h.db.query<{ n: string }>(
      'SELECT count(*) AS n FROM stock_balances sb JOIN inventory_items i ON i.id = sb.item_id'
    );
    assert.equal(res.rows[0]!.n, '4');
  });

  test('a fiscal year and a bootstrap administrator exist', async () => {
    const fy = await h.db.query('SELECT * FROM fiscal_years');
    assert.equal(fy.rows.length, 1);
    const admin = await h.db.query<{ email: string }>(
      `SELECT u.email FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE r.code = 'ADMIN'`
    );
    assert.equal(admin.rows.length, 1);
  });
});

describe('A2 — BR-25: the database itself rejects an unbalanced entry', () => {
  test('a balanced multi-line entry commits', async () => {
    await h.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO journal_entries (entry_no, entry_date, source_type, source_id, posting_key, fiscal_year_id, posted_by)
         VALUES ('JE-TEST-1', current_date, 'Test', 1, 'test:1',
                 (SELECT id FROM fiscal_years LIMIT 1), (SELECT id FROM users LIMIT 1))`
      );
      await tx.query(
        `INSERT INTO journal_lines (entry_id, entry_date, account_id, debit)
         SELECT id, entry_date, (SELECT id FROM accounts WHERE code='1010'), 500
           FROM journal_entries WHERE entry_no='JE-TEST-1'`
      );
      await tx.query(
        `INSERT INTO journal_lines (entry_id, entry_date, account_id, credit)
         SELECT id, entry_date, (SELECT id FROM accounts WHERE code='3000'), 500
           FROM journal_entries WHERE entry_no='JE-TEST-1'`
      );
    });
    const r = await h.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id WHERE je.entry_no = 'JE-TEST-1'`
    );
    assert.equal(r.rows[0]!.n, '2');
  });

  test('an unbalanced entry is rejected at COMMIT, by raw SQL, not by the app', async () => {
    await assert.rejects(
      () =>
        h.db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO journal_entries (entry_no, entry_date, source_type, source_id, posting_key, fiscal_year_id, posted_by)
             VALUES ('JE-TEST-BAD', current_date, 'Test', 2, 'test:2',
                     (SELECT id FROM fiscal_years LIMIT 1), (SELECT id FROM users LIMIT 1))`
          );
          await tx.query(
            `INSERT INTO journal_lines (entry_id, entry_date, account_id, debit)
             SELECT id, entry_date, (SELECT id FROM accounts WHERE code='1010'), 300
               FROM journal_entries WHERE entry_no='JE-TEST-BAD'`
          );
          await tx.query(
            `INSERT INTO journal_lines (entry_id, entry_date, account_id, credit)
             SELECT id, entry_date, (SELECT id FROM accounts WHERE code='3000'), 250
               FROM journal_entries WHERE entry_no='JE-TEST-BAD'`
          );
        }),
      /unbalanced/i
    );

    // the whole transaction rolled back — no orphan entry survives
    const r = await h.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM journal_entries WHERE entry_no = 'JE-TEST-BAD'`
    );
    assert.equal(r.rows[0]!.n, '0');
  });

  test('BR-26: posting_key is unique, so a retried post cannot double-post', async () => {
    await assert.rejects(
      () =>
        h.db.query(
          `INSERT INTO journal_entries (entry_no, entry_date, source_type, source_id, posting_key, fiscal_year_id, posted_by)
           VALUES ('JE-TEST-DUP', current_date, 'Test', 1, 'test:1',
                   (SELECT id FROM fiscal_years LIMIT 1), (SELECT id FROM users LIMIT 1))`
        ),
      /duplicate key|unique/i
    );
  });
});

describe('A2 — schema invariants that protect the business rules', () => {
  test('BR-02: a purchase cannot belong to the water treatment division', async () => {
    await assert.rejects(
      () =>
        h.db.query(
          `INSERT INTO purchases (doc_no, division, purchase_date, source, fiscal_year_id)
           VALUES ('PUR-BAD-1', 'WTD', current_date, 'WALK_IN', (SELECT id FROM fiscal_years LIMIT 1))`
        ),
      /violates check constraint/i
    );
  });

  test('BR-22: a "no purchase" day must carry zero drums and zero value', async () => {
    await assert.rejects(
      () =>
        h.db.query(
          `INSERT INTO purchases (doc_no, division, purchase_date, source, drums, total_amount, is_no_purchase, fiscal_year_id)
           VALUES ('PUR-BAD-2', 'UCO', current_date, 'WALK_IN', 10, 5000, true, (SELECT id FROM fiscal_years LIMIT 1))`
        ),
      /violates check constraint/i
    );
  });

  test('a journal line cannot be both a debit and a credit', async () => {
    await assert.rejects(
      () =>
        h.db.query(
          `INSERT INTO journal_lines (entry_id, entry_date, account_id, debit, credit)
           VALUES ((SELECT id FROM journal_entries LIMIT 1), current_date,
                   (SELECT id FROM accounts WHERE code='1010'), 100, 100)`
        ),
      /violates check constraint/i
    );
  });

  test('a stock movement direction must be +1 or -1', async () => {
    await assert.rejects(
      () =>
        h.db.query(
          `INSERT INTO stock_movements
             (item_id, moved_on, direction, quantity, posting_key, balance_after, fiscal_year_id, created_by, source_type, source_id)
           VALUES ((SELECT id FROM inventory_items WHERE code='UCO'), current_date, 0, 5, 'sm:bad', 5,
                   (SELECT id FROM fiscal_years LIMIT 1), (SELECT id FROM users LIMIT 1), 'Test', 1)`
        ),
      /violates check constraint/i
    );
  });
});

describe('A2 — a genuinely fresh database', () => {
  test('migrate + seed from empty succeeds with no manual step', async () => {
    // Counted from the directory rather than hardcoded, so adding a migration
    // does not fail a test that has nothing to do with it.
    const { readdir } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
    const expected = (await readdir(dir)).filter((f) => f.endsWith('.sql')).length;

    const db = await createDb('memory://');
    const m = await migrate(db);
    assert.equal(m.applied.length, expected);
    const s = await seed(db);
    assert.equal(s.adminCreated, true);
    assert.equal(s.items, 4);
    await db.close();
  });
});
