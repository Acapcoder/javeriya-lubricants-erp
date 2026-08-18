/**
 * A3 — authentication.
 * Done when: a wrong password 5x locks the account for 15 minutes and logs every attempt.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createUser, loginAs, STRONG_PASSWORD, type Harness } from './helpers.ts';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../src/lib/password.ts';
import { env } from '../src/env.ts';

let h: Harness;
before(async () => {
  h = await createHarness();
  await createUser(h.db, { name: 'Ayesha Auditor', email: 'auditor@orcms.local', roles: ['AUDITOR'] });
  await createUser(h.db, { name: 'Dana Entry', email: 'entry@orcms.local', roles: ['AUDITOR'] });
  await createUser(h.db, { name: 'Disabled User', email: 'disabled@orcms.local', roles: ['AUDITOR'], active: false });
});
after(async () => {
  await h.close();
});

describe('A3 — password hashing', () => {
  test('hashes are salted: the same password hashes differently each time', async () => {
    const a = await hashPassword(STRONG_PASSWORD);
    const b = await hashPassword(STRONG_PASSWORD);
    assert.notEqual(a, b);
    assert.ok(await verifyPassword(STRONG_PASSWORD, a));
    assert.ok(await verifyPassword(STRONG_PASSWORD, b));
  });

  test('the wrong password does not verify', async () => {
    const hash = await hashPassword(STRONG_PASSWORD);
    assert.equal(await verifyPassword('not-the-password', hash), false);
  });

  test('a malformed stored hash is rejected rather than throwing', async () => {
    assert.equal(await verifyPassword('anything', 'garbage'), false);
    assert.equal(await verifyPassword('anything', ''), false);
  });

  test('the plaintext password never appears in the stored hash', async () => {
    const hash = await hashPassword(STRONG_PASSWORD);
    assert.ok(!hash.includes(STRONG_PASSWORD));
  });
});

describe('A3 — password policy (§10)', () => {
  test(`rejects anything under ${env.minPasswordLength} characters`, () => {
    const r = validatePasswordStrength('Short1a');
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('at least')));
  });

  test('requires mixed case and a digit', () => {
    assert.equal(validatePasswordStrength('alllowercaseletters').ok, false);
    assert.equal(validatePasswordStrength('ALLUPPERCASELETTERS').ok, false);
    assert.equal(validatePasswordStrength('NoDigitsInHereAtAll').ok, false);
  });

  test('rejects a password containing the user name or login', () => {
    const r = validatePasswordStrength('Ayesha-Strong-99', { name: 'Ayesha' });
    assert.equal(r.ok, false);
    const r2 = validatePasswordStrength('Auditor-Strong-99', { email: 'auditor@orcms.local' });
    assert.equal(r2.ok, false);
  });

  test('accepts a genuinely strong password', () => {
    assert.equal(validatePasswordStrength(STRONG_PASSWORD).ok, true);
  });
});

describe('A3 — login', () => {
  test('valid credentials sign a user in and set a session cookie', async () => {
    const r = await loginAs(h.app, 'auditor@orcms.local');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'AUTHENTICATED');
    assert.ok(r.cookie, 'expected a session cookie');
  });

  test('the login response never leaks the password hash', async () => {
    const r = await loginAs(h.app, 'auditor@orcms.local');
    const serialised = JSON.stringify(r.body);
    assert.ok(!serialised.includes('scrypt'));
    assert.ok(!serialised.includes('password'));
  });

  test('a wrong password is rejected', async () => {
    const r = await loginAs(h.app, 'auditor@orcms.local', 'wrong-password-here');
    assert.equal(r.status, 401);
    assert.equal((r.body.error as { code: string }).code, 'INVALID_CREDENTIALS');
  });

  test('an unknown username returns the same error as a wrong password', async () => {
    const unknown = await loginAs(h.app, 'nobody@orcms.local', 'whatever-password');
    const wrong = await loginAs(h.app, 'auditor@orcms.local', 'wrong-password-here');
    assert.equal(unknown.status, wrong.status);
    assert.deepEqual(unknown.body, wrong.body, 'responses must not reveal whether an account exists');
  });

  test('a disabled account cannot sign in', async () => {
    const r = await loginAs(h.app, 'disabled@orcms.local');
    assert.equal(r.status, 403);
    assert.equal((r.body.error as { code: string }).code, 'ACCOUNT_DISABLED');
  });
});

describe('A3 — lockout after 5 failures (§10)', () => {
  beforeEach(async () => {
    await h.db.query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = 'entry'`);
  });

  test('the 5th failure locks the account, and the correct password then fails too', async () => {
    for (let i = 1; i <= env.maxLoginAttempts - 1; i++) {
      const r = await loginAs(h.app, 'entry@orcms.local', `bad-password-${i}`);
      assert.equal(r.status, 401, `attempt ${i} should be a plain rejection`);
    }

    const locking = await loginAs(h.app, 'entry@orcms.local', 'bad-password-5');
    assert.equal(locking.status, 429);
    assert.equal((locking.body.error as { code: string }).code, 'ACCOUNT_LOCKED');

    // Even the RIGHT password is refused while the lock holds.
    const correct = await loginAs(h.app, 'entry@orcms.local', STRONG_PASSWORD);
    assert.equal(correct.status, 429, 'a locked account must refuse the correct password too');
  });

  test('the lock expires after the configured window', async () => {
    for (let i = 1; i <= env.maxLoginAttempts; i++) await loginAs(h.app, 'entry@orcms.local', `bad-${i}`);
    assert.equal((await loginAs(h.app, 'entry@orcms.local')).status, 429);

    // Move the lock into the past rather than waiting 15 real minutes.
    await h.db.query(`UPDATE users SET locked_until = now() - interval '1 minute' WHERE username = 'entry'`);

    const r = await loginAs(h.app, 'entry@orcms.local');
    assert.equal(r.status, 200, 'the account should unlock once the window passes');
  });

  test('a successful login clears the failure counter', async () => {
    await loginAs(h.app, 'entry@orcms.local', 'bad-1');
    await loginAs(h.app, 'entry@orcms.local', 'bad-2');
    await loginAs(h.app, 'entry@orcms.local');
    const r = await h.db.query<{ failed_attempts: number }>(
      `SELECT failed_attempts FROM users WHERE username = 'entry'`
    );
    assert.equal(Number(r.rows[0]!.failed_attempts), 0);
  });

  test('every attempt is logged, successful or not', async () => {
    const before = await h.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM login_attempts WHERE email = 'entry'`
    );
    await loginAs(h.app, 'entry@orcms.local', 'bad-x');
    await loginAs(h.app, 'entry@orcms.local');
    const after = await h.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM login_attempts WHERE email = 'entry'`
    );
    assert.equal(Number(after.rows[0]!.n), Number(before.rows[0]!.n) + 2);

    const outcomes = await h.db.query<{ succeeded: boolean }>(
      `SELECT succeeded FROM login_attempts WHERE email = 'entry' ORDER BY id DESC LIMIT 2`
    );
    assert.deepEqual(outcomes.rows.map((r) => r.succeeded), [true, false]);
  });

  test('a lockout is written to the activity log', async () => {
    for (let i = 1; i <= env.maxLoginAttempts; i++) await loginAs(h.app, 'entry@orcms.local', `bad-${i}`);
    const r = await h.db.query<{ action: string }>(
      `SELECT action FROM activity_logs WHERE module = 'auth' AND action = 'LOCKOUT' ORDER BY id DESC LIMIT 1`
    );
    assert.equal(r.rows[0]?.action, 'LOCKOUT');
  });
});

describe('A3 — sessions', () => {
  test('/api/auth/me requires a session', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/auth/me' });
    assert.equal(res.statusCode, 401);
  });

  test('/api/auth/me returns the signed-in user with roles and permissions', async () => {
    const login = await loginAs(h.app, 'auditor@orcms.local');
    const res = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: login.cookie! } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.user.email, 'auditor@orcms.local');
    assert.deepEqual(body.user.roles, ['AUDITOR']);
    assert.ok(body.user.permissions.includes('reports.view'));
  });

  test('a forged cookie is rejected — the signature is checked', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'orcms_session=i-made-this-up' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('logout revokes the session immediately', async () => {
    const login = await loginAs(h.app, 'auditor@orcms.local');
    const out = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: login.cookie! } });
    assert.equal(out.statusCode, 200);

    const after = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: login.cookie! } });
    assert.equal(after.statusCode, 401, 'the revoked cookie must stop working');
  });

  test('an expired session is refused', async () => {
    const login = await loginAs(h.app, 'auditor@orcms.local');
    await h.db.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE revoked_at IS NULL`);
    const res = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: login.cookie! } });
    assert.equal(res.statusCode, 401);
  });

  test('an idle session times out (§6.1: 30 minutes)', async () => {
    const login = await loginAs(h.app, 'auditor@orcms.local');
    await h.db.query(
      `UPDATE sessions SET last_seen_at = now() - ($1 || ' minutes')::interval WHERE revoked_at IS NULL`,
      [String(env.sessionIdleMinutes + 5)]
    );
    const res = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: login.cookie! } });
    assert.equal(res.statusCode, 401);
  });

  test('deactivating a user kills their live session', async () => {
    const login = await loginAs(h.app, 'auditor@orcms.local');
    await h.db.query(`UPDATE users SET is_active = false WHERE username = 'auditor'`);
    const res = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: login.cookie! } });
    assert.equal(res.statusCode, 401);
    await h.db.query(`UPDATE users SET is_active = true WHERE username = 'auditor'`);
  });
});

describe('A3 — password change', () => {
  test('changing a password revokes every other session', async () => {
    const email = 'changer@orcms.local';
    await createUser(h.db, { name: 'Cam Changer', email, roles: ['AUDITOR'] });

    const first = await loginAs(h.app, email);
    const second = await loginAs(h.app, email);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: second.cookie! },
      payload: { currentPassword: STRONG_PASSWORD, newPassword: 'Qq7-Basalt-Heron-2026' },
    });
    assert.equal(res.statusCode, 200);

    const check = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first.cookie! } });
    assert.equal(check.statusCode, 401, 'the other session must be revoked');

    assert.equal((await loginAs(h.app, email, STRONG_PASSWORD)).status, 401);
    assert.equal((await loginAs(h.app, email, 'Qq7-Basalt-Heron-2026')).status, 200);
  });

  test('a weak new password is refused', async () => {
    const email = 'weak@orcms.local';
    await createUser(h.db, { name: 'Wes Weak', email, roles: ['AUDITOR'] });
    const login = await loginAs(h.app, email);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: login.cookie! },
      payload: { currentPassword: STRONG_PASSWORD, newPassword: 'short' },
    });
    assert.equal(res.statusCode, 422);
  });

  test('the wrong current password is refused', async () => {
    const email = 'wrongcur@orcms.local';
    await createUser(h.db, { name: 'Wanda Wrong', email, roles: ['AUDITOR'] });
    const login = await loginAs(h.app, email);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: login.cookie! },
      payload: { currentPassword: 'not-my-password', newPassword: 'Qq7-Basalt-Heron-2026' },
    });
    assert.equal(res.statusCode, 422);
  });
});
