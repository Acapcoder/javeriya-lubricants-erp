/**
 * A5 — two-factor authentication.
 * Done when: an Accountant without 2FA enrolled is forced through setup before
 * any other route.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createUser, loginAs, STRONG_PASSWORD, type Harness } from './helpers.ts';
import { base32Decode, base32Encode, generateTotp, otpauthUri, verifyTotp } from '../src/lib/totp.ts';
import { policy } from '../src/env.ts';

let h: Harness;
before(async () => {
  h = await createHarness();
  await createUser(h.db, { name: 'Aisha Accountant', email: 'acc@orcms.local', roles: ['ACCOUNTANT'] });
  await createUser(h.db, { name: 'Omar Auditor', email: 'aud@orcms.local', roles: ['AUDITOR'] });
});
after(async () => {
  await h.close();
});

describe('A5 — TOTP primitives (RFC 6238)', () => {
  test('base32 round-trips', () => {
    const buf = Buffer.from('the quick brown fox');
    assert.equal(base32Decode(base32Encode(buf)).toString(), 'the quick brown fox');
  });

  test('matches the RFC 6238 SHA-1 test vector', () => {
    // RFC 6238 Appendix B: secret "12345678901234567890", T = 59 -> 94287082
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(generateTotp(secret, 59_000, { digits: 8 }), '94287082');
    assert.equal(generateTotp(secret, 1_111_111_109_000, { digits: 8 }), '07081804');
    assert.equal(generateTotp(secret, 1_234_567_890_000, { digits: 8 }), '89005924');
  });

  test('a code from the current window verifies', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = Date.now();
    assert.equal(verifyTotp(secret, generateTotp(secret, now), { atMs: now }), true);
  });

  test('a code from one step either side still verifies (clock drift)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = Date.now();
    assert.equal(verifyTotp(secret, generateTotp(secret, now - 30_000), { atMs: now }), true);
    assert.equal(verifyTotp(secret, generateTotp(secret, now + 30_000), { atMs: now }), true);
  });

  test('a code from far outside the window does not verify', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = Date.now();
    assert.equal(verifyTotp(secret, generateTotp(secret, now - 300_000), { atMs: now }), false);
  });

  test('malformed codes are rejected without throwing', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    for (const bad of ['', 'abcdef', '12345', '1234567890123', '  ']) {
      assert.equal(verifyTotp(secret, bad), false);
    }
  });

  test('the otpauth URI carries issuer, account and secret', () => {
    const uri = otpauthUri({ secret: 'ABCDEF', account: 'acc@orcms.local', issuer: 'ORCMS' });
    assert.ok(uri.startsWith('otpauth://totp/'));
    assert.ok(uri.includes('secret=ABCDEF'));
    assert.ok(uri.includes('issuer=ORCMS'));
    assert.ok(uri.includes('acc%40orcms.local'));
  });
});

describe('A5 — enrolment is forced for Accountant and Administrator', () => {
  test('login returns TWO_FACTOR_ENROLLMENT_REQUIRED, not AUTHENTICATED', async () => {
    const r = await loginAs(h.app, 'acc@orcms.local');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'TWO_FACTOR_ENROLLMENT_REQUIRED');
    assert.ok(r.cookie, 'a session is issued, but it cannot reach protected routes yet');
  });

  test('that session is blocked from every guarded route until enrolment completes', async () => {
    const r = await loginAs(h.app, 'acc@orcms.local');
    for (const url of ['/api/accounts', '/api/nav', '/api/reference']) {
      const res = await h.app.inject({ method: 'GET', url, headers: { cookie: r.cookie! } });
      assert.equal(res.statusCode, 401, `${url} should be blocked before enrolment`);
      assert.equal(res.json().error.code, 'TWO_FACTOR_ENROLLMENT_REQUIRED');
    }
  });

  test('a role that does not require 2FA signs straight in', async () => {
    const r = await loginAs(h.app, 'aud@orcms.local');
    assert.equal(r.body.status, 'AUTHENTICATED');
    const res = await h.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: r.cookie! } });
    assert.equal(res.statusCode, 200);
  });
});

describe('A5 — enrolment flow', () => {
  test('enrol, confirm with a live code, then reach protected routes', async () => {
    const email = 'enrol@orcms.local';
    await createUser(h.db, { name: 'Eve Enroller', email, roles: ['ACCOUNTANT'] });

    const login = await loginAs(h.app, email);
    assert.equal(login.body.status, 'TWO_FACTOR_ENROLLMENT_REQUIRED');

    const begin = await h.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/enroll',
      headers: { cookie: login.cookie! },
    });
    assert.equal(begin.statusCode, 200);
    const { secret, qrDataUri, otpauthUri: uri } = begin.json();
    assert.match(secret, /^[A-Z2-7]{32}$/, 'expected a base32 secret');
    assert.ok(qrDataUri.startsWith('data:image/png;base64,'), 'a scannable QR code is returned');
    assert.ok(uri.includes(encodeURIComponent(email)));

    // Not enrolled until confirmed — the secret alone must not unlock anything.
    const stillBlocked = await h.app.inject({
      method: 'GET',
      url: '/api/nav',
      headers: { cookie: login.cookie! },
    });
    assert.equal(stillBlocked.statusCode, 401, 'a stored secret is not enrolment');

    const confirm = await h.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/confirm',
      headers: { cookie: login.cookie! },
      payload: { code: generateTotp(secret) },
    });
    assert.equal(confirm.statusCode, 200);
    const recoveryCodes = confirm.json().recoveryCodes as string[];
    assert.equal(recoveryCodes.length, 10);

    const nav = await h.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: login.cookie! } });
    assert.equal(nav.statusCode, 200, 'enrolment should unblock the session immediately');
  });

  test('confirming with a wrong code fails and does not enrol', async () => {
    const email = 'badcode@orcms.local';
    await createUser(h.db, { name: 'Bad Code', email, roles: ['ACCOUNTANT'] });
    const login = await loginAs(h.app, email);
    await h.app.inject({ method: 'POST', url: '/api/auth/2fa/enroll', headers: { cookie: login.cookie! } });

    const confirm = await h.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/confirm',
      headers: { cookie: login.cookie! },
      payload: { code: '000000' },
    });
    assert.equal(confirm.statusCode, 422);

    const row = await h.db.query<{ two_factor_confirmed_at: string | null }>(
      'SELECT two_factor_confirmed_at FROM users WHERE email = $1',
      [email]
    );
    assert.equal(row.rows[0]!.two_factor_confirmed_at, null);
  });

  test('the raw secret is never stored in the activity log', async () => {
    const res = await h.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM activity_logs
        WHERE new_values::text LIKE '%two_factor_secret%'
           OR old_values::text LIKE '%two_factor_secret%'`
    );
    assert.equal(Number(res.rows[0]!.n), 0);
  });
});

describe('A5 — challenge at login once enrolled', () => {
  const email = 'chal@orcms.local';
  let secret = '';
  let recoveryCodes: string[] = [];

  before(async () => {
    await createUser(h.db, { name: 'Chan Challenge', email, roles: ['ACCOUNTANT'] });
    const login = await loginAs(h.app, email);
    const begin = await h.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/enroll',
      headers: { cookie: login.cookie! },
    });
    secret = begin.json().secret;
    const confirm = await h.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/confirm',
      headers: { cookie: login.cookie! },
      payload: { code: generateTotp(secret) },
    });
    recoveryCodes = confirm.json().recoveryCodes;
  });

  test('a later login demands a code before anything else', async () => {
    const login = await loginAs(h.app, email);
    assert.equal(login.body.status, 'TWO_FACTOR_REQUIRED');

    const blocked = await h.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: login.cookie! } });
    assert.equal(blocked.statusCode, 401);
    assert.equal(blocked.json().error.code, 'TWO_FACTOR_REQUIRED');
  });

  test('a valid code completes the login', async () => {
    const login = await loginAs(h.app, email);
    const verify = await h.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/verify',
      headers: { cookie: login.cookie! },
      payload: { code: generateTotp(secret) },
    });
    assert.equal(verify.statusCode, 200);

    const nav = await h.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: login.cookie! } });
    assert.equal(nav.statusCode, 200);
  });

  test('an invalid code does not complete the login', async () => {
    const login = await loginAs(h.app, email);
    const verify = await h.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/verify',
      headers: { cookie: login.cookie! },
      payload: { code: '111111' },
    });
    assert.equal(verify.statusCode, 401);

    const nav = await h.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: login.cookie! } });
    assert.equal(nav.statusCode, 401);
  });

  test('a wrong password still fails even with 2FA enrolled', async () => {
    const bad = await loginAs(h.app, email, 'definitely-not-the-password');
    assert.equal(bad.status, 401);
  });

  test('a recovery code works once, then never again', async () => {
    const code = recoveryCodes[0]!;

    const first = await loginAs(h.app, email);
    const useIt = await h.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/verify',
      headers: { cookie: first.cookie! },
      payload: { code },
    });
    assert.equal(useIt.statusCode, 200);
    assert.equal(useIt.json().usedRecoveryCode, true);

    const second = await loginAs(h.app, email);
    const reuse = await h.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/verify',
      headers: { cookie: second.cookie! },
      payload: { code },
    });
    assert.equal(reuse.statusCode, 401, 'a recovery code must be single use');
  });

  test('a failed challenge is written to the activity log', async () => {
    const login = await loginAs(h.app, email);
    await h.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/verify',
      headers: { cookie: login.cookie! },
      payload: { code: '222222' },
    });
    const res = await h.db.query<{ action: string }>(
      `SELECT action FROM activity_logs WHERE action = '2FA_FAILED' ORDER BY id DESC LIMIT 1`
    );
    assert.equal(res.rows[0]?.action, '2FA_FAILED');
  });

  test('enrolling twice is refused', async () => {
    const login = await loginAs(h.app, email);
    await h.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/verify',
      headers: { cookie: login.cookie! },
      payload: { code: generateTotp(secret) },
    });
    const again = await h.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/enroll',
      headers: { cookie: login.cookie! },
    });
    assert.equal(again.statusCode, 422);
  });

  test('the stored secret is never returned by /api/auth/me', async () => {
    const login = await loginAs(h.app, email);
    await h.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/verify',
      headers: { cookie: login.cookie! },
      payload: { code: generateTotp(secret) },
    });
    const me = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: login.cookie! } });
    const body = JSON.stringify(me.json());
    assert.ok(!body.includes(secret), 'the TOTP secret must never leave the server after enrolment');
    assert.equal(me.json().user.twoFactorEnrolled, true);
  });
});

describe('A5 — ENFORCE_2FA policy switch', () => {
  after(() => {
    policy.enforceTwoFactor = true; // restore for any later suite
  });

  test('the suite runs with enforcement ON regardless of a local .env', () => {
    assert.equal(policy.enforceTwoFactor, true, 'tests must be hermetic — .env is not read under the test runner');
  });

  test('with enforcement off, an Accountant signs straight in', async () => {
    const email = 'optional2fa@orcms.local';
    await createUser(h.db, { name: 'Opt Out', email, roles: ['ACCOUNTANT'] });

    policy.enforceTwoFactor = false;
    try {
      const login = await loginAs(h.app, email);
      assert.equal(login.body.status, 'AUTHENTICATED', 'no enrolment should be forced');

      const nav = await h.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: login.cookie! } });
      assert.equal(nav.statusCode, 200);
    } finally {
      policy.enforceTwoFactor = true;
    }
  });

  test('with enforcement off, a user who DID enrol is still challenged', async () => {
    const email = 'voluntary2fa@orcms.local';
    await createUser(h.db, { name: 'Vera Voluntary', email, roles: ['ACCOUNTANT'] });

    // Enrol while enforcement is on.
    const setup = await loginAs(h.app, email);
    const begin = await h.app.inject({ method: 'POST', url: '/api/auth/2fa/enroll', headers: { cookie: setup.cookie! } });
    const secret = begin.json().secret;
    await h.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/confirm',
      headers: { cookie: setup.cookie! },
      payload: { code: generateTotp(secret) },
    });

    policy.enforceTwoFactor = false;
    try {
      const login = await loginAs(h.app, email);
      assert.equal(
        login.body.status,
        'TWO_FACTOR_REQUIRED',
        'turning the policy off must not silently weaken an account that opted in'
      );

      const blocked = await h.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: login.cookie! } });
      assert.equal(blocked.statusCode, 401);

      const verify = await h.app.inject({
        method: 'POST',
        url: '/api/auth/2fa/verify',
        headers: { cookie: login.cookie! },
        payload: { code: generateTotp(secret) },
      });
      assert.equal(verify.statusCode, 200);
    } finally {
      policy.enforceTwoFactor = true;
    }
  });

  test('turning enforcement back on restores forced enrolment', async () => {
    const email = 'backon@orcms.local';
    await createUser(h.db, { name: 'Back On', email, roles: ['ADMIN'] });
    const login = await loginAs(h.app, email);
    assert.equal(login.body.status, 'TWO_FACTOR_ENROLLMENT_REQUIRED');
  });
});

describe('A5 — administrator reset', () => {
  test('resetting 2FA revokes sessions and forces re-enrolment', async () => {
    const email = 'resetme@orcms.local';
    await createUser(h.db, { name: 'Rita Reset', email, roles: ['ACCOUNTANT'], password: STRONG_PASSWORD });

    const login = await loginAs(h.app, email);
    const begin = await h.app.inject({ method: 'POST', url: '/api/auth/2fa/enroll', headers: { cookie: login.cookie! } });
    const secret = begin.json().secret;
    await h.app.inject({
      method: 'POST',
      url: '/api/auth/2fa/confirm',
      headers: { cookie: login.cookie! },
      payload: { code: generateTotp(secret) },
    });
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: login.cookie! } })).statusCode, 200);

    const { resetTwoFactor } = await import('../src/modules/twofactor/service.ts');
    const target = await h.db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    await resetTwoFactor(h.db, {
      targetUserId: target.rows[0]!.id,
      actor: { id: '1', name: 'System Administrator' },
    });

    const after = await h.app.inject({ method: 'GET', url: '/api/nav', headers: { cookie: login.cookie! } });
    assert.equal(after.statusCode, 401, 'the live session must be revoked');

    const relogin = await loginAs(h.app, email);
    assert.equal(relogin.body.status, 'TWO_FACTOR_ENROLLMENT_REQUIRED');
  });
});
