/**
 * A4 — role-based access control.
 * Done when: a test iterates the whole §6.1 matrix and every cell passes.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createUser, loginAs, type Harness } from './helpers.ts';
import { MATRIX, PERMISSIONS, ROLES, ROLE_META, type PermissionCode, type RoleCode } from '../src/modules/rbac/matrix.ts';

let h: Harness;
const cookies = new Map<RoleCode, string>();

before(async () => {
  h = await createHarness();
  // One user per role. ADMIN and ACCOUNTANT require 2FA, so their sessions are
  // pre-cleared here — 2FA itself is exercised in a5.twofactor.test.ts.
  for (const role of ROLES) {
    // "role-" prefix so these fixtures never collide with the seeded
    // bootstrap administrator at admin@orcms.local
    const email = `role-${role.toLowerCase()}@orcms.local`;
    await createUser(h.db, { name: `${role} User`, email, roles: [role] });
    const login = await loginAs(h.app, email);
    assert.ok(login.cookie, `could not sign in as ${role}`);
    await h.db.query(
      `UPDATE sessions SET two_factor_ok = true
        WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [email]
    );
    // A role that demands 2FA but has not enrolled is still blocked, so mark
    // those users enrolled for the purpose of matrix testing.
    if (ROLE_META[role].requires2fa) {
      await h.db.query(
        `UPDATE users SET two_factor_secret = 'TESTSECRETTESTSECRET', two_factor_confirmed_at = now()
          WHERE email = $1`,
        [email]
      );
    }
    cookies.set(role, login.cookie!);
  }
});

after(async () => {
  await h.close();
});

describe('A4 — the matrix is seeded exactly as documented', () => {
  test('every permission in the matrix file exists in the database', async () => {
    const res = await h.db.query<{ code: string }>('SELECT code FROM permissions');
    const inDb = new Set(res.rows.map((r) => r.code));
    for (const p of PERMISSIONS) {
      assert.ok(inDb.has(p.code), `permission ${p.code} is missing from the database`);
    }
    assert.equal(inDb.size, PERMISSIONS.length, 'the database holds permissions the matrix does not declare');
  });

  test('every role grant in the database matches the matrix, cell by cell', async () => {
    for (const role of ROLES) {
      const res = await h.db.query<{ code: PermissionCode }>(
        `SELECT p.code FROM roles r
           JOIN role_permissions rp ON rp.role_id = r.id
           JOIN permissions p ON p.id = rp.permission_id
          WHERE r.code = $1 ORDER BY p.code`,
        [role]
      );
      const actual = res.rows.map((r) => r.code).sort();
      const expected = [...MATRIX[role]].sort();
      assert.deepEqual(actual, expected, `grants for ${role} do not match the matrix`);
    }
  });

  test('roles are seeded as enabled', async () => {
    const res = await h.db.query<{ code: string; is_enabled: boolean }>('SELECT code, is_enabled FROM roles');
    const byCode = new Map(res.rows.map((r) => [r.code, r.is_enabled]));
    assert.equal(byCode.get('ADMIN'), true);
    assert.equal(byCode.get('ACCOUNTANT'), true);
    assert.equal(byCode.get('AUDITOR'), true);
  });

  test('only Administrator and Accountant require 2FA (§6.1)', async () => {
    const res = await h.db.query<{ code: string; requires_2fa: boolean }>('SELECT code, requires_2fa FROM roles');
    const require2fa = res.rows.filter((r) => r.requires_2fa).map((r) => r.code).sort();
    assert.deepEqual(require2fa, ['ACCOUNTANT', 'ADMIN']);
  });
});

describe('A4 — every cell of the matrix, resolved through the API', () => {
  // The API is the thing that matters: what a role actually receives, not what
  // a table says it should.
  for (const role of ROLES) {
    test(`${role} receives exactly its documented permissions`, async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: cookies.get(role)! },
      });
      assert.equal(res.statusCode, 200, `${role} could not read /api/auth/me`);
      const granted = (res.json().user.permissions as PermissionCode[]).slice().sort();
      assert.deepEqual(granted, [...MATRIX[role]].sort());
    });
  }

  // Explicit negative assertions for the cells that carry business meaning.
  const DENIALS: Array<[RoleCode, PermissionCode]> = [
    ['AUDITOR', 'operations.create'],
    ['AUDITOR', 'operations.update'],
    ['AUDITOR', 'operations.delete'],
    ['AUDITOR', 'finance.manage'],
    ['AUDITOR', 'users.manage'],
    ['ACCOUNTANT', 'users.manage'],
    ['ACCOUNTANT', 'settings.manage'],
    ['ACCOUNTANT', 'activity_log.delete'],
    ['ACCOUNTANT', 'backup.restore'],
    ['ACCOUNTANT', 'year.lock'],
    ['ACCOUNTANT', 'operations.delete'],
  ];

  for (const [role, permission] of DENIALS) {
    test(`${role} is denied ${permission}`, () => {
      assert.ok(
        !MATRIX[role].includes(permission),
        `${role} must not hold ${permission}`
      );
    });
  }

  test('only Administrator may delete activity logs (BR-18)', () => {
    for (const role of ROLES) {
      const held = MATRIX[role].includes('activity_log.delete');
      assert.equal(held, role === 'ADMIN', `${role} activity_log.delete should be ${role === 'ADMIN'}`);
    }
  });

  test('Administrator holds every permission', () => {
    assert.equal(MATRIX.ADMIN.length, PERMISSIONS.length);
  });
});

describe('A4 — guards enforce the matrix on real routes', () => {
  test('an unauthenticated request is refused', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/accounts' });
    assert.equal(res.statusCode, 401);
  });

  test('finance.view opens the chart of accounts to those who hold it', async () => {
    for (const role of ROLES) {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/accounts',
        headers: { cookie: cookies.get(role)! },
      });
      const shouldPass = MATRIX[role].includes('finance.view');
      assert.equal(
        res.statusCode,
        shouldPass ? 200 : 403,
        `${role} expected ${shouldPass ? 200 : 403} on /api/accounts, got ${res.statusCode}`
      );
    }
  });

  test('a 403 explains which permission is missing without leaking data', async () => {
    // The Auditor holds finance.view but not finance.manage, so creating an
    // account is the honest test of a denial on a route they can otherwise see.
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/finance/accounts',
      headers: { cookie: cookies.get('AUDITOR')! },
      payload: { code: '9999', name: 'Should Not Exist', type: 'EXPENSE' },
    });
    assert.equal(res.statusCode, 403);
    const body = res.json();
    assert.equal(body.error.code, 'FORBIDDEN');
    assert.ok(body.error.message.includes('finance.manage'), 'the message should name the missing permission');
    assert.equal(body.id, undefined, 'a denied response must carry no payload');

    const check = await h.db.query<{ n: string }>(`SELECT count(*) AS n FROM accounts WHERE code = '9999'`);
    assert.equal(Number(check.rows[0]!.n), 0, 'the denied write must not have happened');
  });

  test('the Accountant can create but NOT delete — the one right the Admin has extra', async () => {
    // This is the whole distinction between the two entry roles.
    assert.ok(MATRIX.ACCOUNTANT.includes('operations.create'));
    assert.ok(MATRIX.ACCOUNTANT.includes('operations.update'));
    assert.ok(!MATRIX.ACCOUNTANT.includes('operations.delete'), 'the Accountant must not hold operations.delete');
    assert.ok(MATRIX.ADMIN.includes('operations.delete'), 'the Administrator must hold operations.delete');
  });

  test('deletion permissions belong to the Administrator alone', async () => {
    const res = await h.db.query<{ role: string; perm: string }>(
      `SELECT r.code AS role, p.code AS perm
         FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE p.code LIKE '%.delete'`
    );
    for (const row of res.rows) {
      assert.equal(row.role, 'ADMIN', `${row.role} should not hold ${row.perm}`);
    }
  });
});

describe('A4 — navigation reflects permissions, not guesswork', () => {
  test('the Auditor sees reports but no Users or Settings', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: cookies.get('AUDITOR')! } });
    assert.equal(res.statusCode, 200);
    const labels = flatten(res.json().items);
    assert.ok(labels.includes('Dashboard'));
    assert.ok(labels.includes('Activity Log'), 'the Auditor reviews the audit trail');
    assert.ok(!labels.includes('Users'));
    assert.ok(!labels.includes('Settings'));
  });

  test('the Administrator sees Users and Settings', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: cookies.get('ADMIN')! } });
    const labels = flatten(res.json().items);
    assert.ok(labels.includes('Users'));
    assert.ok(labels.includes('Settings'));
    assert.ok(labels.includes('Journal'));
  });

  test('a parent with nothing visible beneath it is dropped entirely', async () => {
    // The Auditor may see Activity Log but not Users or Settings, so the
    // Administration branch must appear with only the permitted children.
    const res = await h.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: cookies.get('AUDITOR')! } });
    const items = res.json().items as Array<{ label: string; children?: Array<{ label: string }> }>;

    for (const item of items) {
      if (item.children) {
        assert.ok(item.children.length > 0, `${item.label} was returned with no visible children`);
      }
    }

    const admin = items.find((i) => i.label === 'Administration');
    assert.ok(admin, 'Administration should still appear for the Auditor');
    const childLabels = (admin.children ?? []).map((c) => c.label);

    // The Auditor reads everything and changes nothing, so they see the
    // read-only entries and none of the management ones.
    assert.ok(childLabels.includes('Activity Log'));
    assert.ok(childLabels.includes('Profiles'), 'who-can-do-what is reference material, visible to all');
    assert.ok(childLabels.includes('Drivers'), 'the Auditor may view drivers');
    assert.ok(childLabels.includes('Suppliers'), 'and suppliers, read-only');
    assert.ok(!childLabels.includes('Users'));
    assert.ok(!childLabels.includes('Settings'));
  });

  test('only the three real profiles exist', async () => {
    const res = await h.db.query<{ code: string }>('SELECT code FROM roles ORDER BY code');
    assert.deepEqual(
      res.rows.map((r) => r.code),
      ['ACCOUNTANT', 'ADMIN', 'AUDITOR'],
      'Manager and Data Entry Operator are not part of this business'
    );
  });
});

function flatten(items: Array<{ label: string; children?: Array<{ label: string }> }>): string[] {
  const out: string[] = [];
  for (const i of items) {
    out.push(i.label);
    if (i.children) out.push(...i.children.map((c) => c.label));
  }
  return out;
}
