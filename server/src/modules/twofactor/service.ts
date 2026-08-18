/**
 * Two-factor authentication (A5).
 *
 * §6.1: mandatory for Administrator and Accountant, optional for others.
 * Enrolment is two-step — a secret is only committed once the user has proved
 * they can generate a code from it, so nobody can lock themselves out by
 * saving a secret their authenticator never received.
 */
import QRCode from 'qrcode';
import type { Db } from '../../db/client.ts';
import { env } from '../../env.ts';
import { generateRecoveryCodes, generateSecret, otpauthUri, verifyTotp } from '../../lib/totp.ts';
import { hashRecoveryCode, markSessionTwoFactorOk } from '../auth/service.ts';
import { recordActivity } from '../activity/log.ts';
import { ValidationError } from '../../lib/errors.ts';

export interface EnrollmentChallenge {
  secret: string;
  otpauthUri: string;
  qrDataUri: string;
}

/**
 * Starts enrolment. The secret is written to the user row but
 * two_factor_confirmed_at stays null, so it does not count as enrolled and
 * cannot satisfy a login until confirmed.
 */
export async function beginEnrollment(db: Db, userId: string): Promise<EnrollmentChallenge> {
  const res = await db.query<{ email: string; two_factor_confirmed_at: Date | null }>(
    'SELECT email, two_factor_confirmed_at FROM users WHERE id = $1 AND deleted_at IS NULL',
    [userId]
  );
  const row = res.rows[0];
  if (!row) throw new ValidationError('User not found');
  if (row.two_factor_confirmed_at) throw new ValidationError('Two-factor authentication is already enabled');

  const secret = generateSecret();
  await db.query('UPDATE users SET two_factor_secret = $2 WHERE id = $1', [userId, secret]);

  const uri = otpauthUri({ secret, account: row.email, issuer: env.totpIssuer });
  const qrDataUri = await QRCode.toDataURL(uri, { margin: 1, width: 240 });

  return { secret, otpauthUri: uri, qrDataUri };
}

export interface ConfirmResult {
  recoveryCodes: string[];
}

/** Confirms enrolment with a live code and issues recovery codes. */
export async function confirmEnrollment(
  db: Db,
  args: { userId: string; code: string; sessionId?: string; ip?: string | null; userAgent?: string | null }
): Promise<ConfirmResult> {
  const res = await db.query<{ email: string; name: string; two_factor_secret: string | null; two_factor_confirmed_at: Date | null }>(
    'SELECT email, name, two_factor_secret, two_factor_confirmed_at FROM users WHERE id = $1 AND deleted_at IS NULL',
    [args.userId]
  );
  const row = res.rows[0];
  if (!row) throw new ValidationError('User not found');
  if (row.two_factor_confirmed_at) throw new ValidationError('Two-factor authentication is already enabled');
  if (!row.two_factor_secret) throw new ValidationError('Start enrolment before confirming');

  if (!verifyTotp(row.two_factor_secret, args.code)) {
    throw new ValidationError('That code is not valid. Check your authenticator and try again.');
  }

  const codes = generateRecoveryCodes();
  const hashed = codes.map((c) => ({ hash: hashRecoveryCode(c), usedAt: null as string | null }));

  await db.query(
    `UPDATE users SET two_factor_confirmed_at = now(), two_factor_recovery = $2 WHERE id = $1`,
    [args.userId, JSON.stringify(hashed)]
  );

  if (args.sessionId) await markSessionTwoFactorOk(db, args.sessionId);

  await recordActivity(db, {
    userId: args.userId,
    userName: row.name,
    module: 'auth',
    action: '2FA_ENROLLED',
    recordType: 'User',
    recordId: args.userId,
    recordLabel: row.email,
    ip: args.ip,
    userAgent: args.userAgent,
  });

  return { recoveryCodes: codes };
}

export type VerifyResult = { ok: true; usedRecoveryCode: boolean } | { ok: false };

/** Verifies a login-time code — a TOTP or a single-use recovery code. */
export async function verifyChallenge(
  db: Db,
  args: { userId: string; sessionId: string; code: string; ip?: string | null; userAgent?: string | null }
): Promise<VerifyResult> {
  const res = await db.query<{
    email: string;
    name: string;
    two_factor_secret: string | null;
    two_factor_confirmed_at: Date | null;
    two_factor_recovery: Array<{ hash: string; usedAt: string | null }> | null;
  }>(
    `SELECT email, name, two_factor_secret, two_factor_confirmed_at, two_factor_recovery
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [args.userId]
  );
  const row = res.rows[0];
  if (!row || !row.two_factor_confirmed_at || !row.two_factor_secret) return { ok: false };

  if (verifyTotp(row.two_factor_secret, args.code)) {
    await markSessionTwoFactorOk(db, args.sessionId);
    await recordActivity(db, {
      userId: args.userId,
      userName: row.name,
      module: 'auth',
      action: 'LOGIN',
      recordType: 'User',
      recordId: args.userId,
      recordLabel: row.email,
      ip: args.ip,
      userAgent: args.userAgent,
    });
    return { ok: true, usedRecoveryCode: false };
  }

  // Recovery codes: single use, burned on success.
  const codes = row.two_factor_recovery ?? [];
  const candidate = hashRecoveryCode(args.code);
  const idx = codes.findIndex((c) => c.hash === candidate && c.usedAt === null);
  if (idx >= 0) {
    codes[idx]!.usedAt = new Date().toISOString();
    await db.query('UPDATE users SET two_factor_recovery = $2 WHERE id = $1', [args.userId, JSON.stringify(codes)]);
    await markSessionTwoFactorOk(db, args.sessionId);
    await recordActivity(db, {
      userId: args.userId,
      userName: row.name,
      module: 'auth',
      action: 'LOGIN',
      recordType: 'User',
      recordId: args.userId,
      recordLabel: `${row.email} (recovery code used)`,
      ip: args.ip,
      userAgent: args.userAgent,
    });
    return { ok: true, usedRecoveryCode: true };
  }

  await recordActivity(db, {
    userId: args.userId,
    userName: row.name,
    module: 'auth',
    action: '2FA_FAILED',
    recordType: 'User',
    recordId: args.userId,
    recordLabel: row.email,
    ip: args.ip,
    userAgent: args.userAgent,
  });
  return { ok: false };
}

/** Administrator action — resets a user's 2FA so they can re-enrol. */
export async function resetTwoFactor(db: Db, args: { targetUserId: string; actor: { id: string; name: string } }): Promise<void> {
  const res = await db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [args.targetUserId]);
  if (!res.rows[0]) throw new ValidationError('User not found');

  await db.query(
    `UPDATE users SET two_factor_secret = NULL, two_factor_confirmed_at = NULL, two_factor_recovery = NULL
      WHERE id = $1`,
    [args.targetUserId]
  );
  await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [args.targetUserId]);

  await recordActivity(db, {
    userId: args.actor.id,
    userName: args.actor.name,
    module: 'users',
    action: 'UPDATE',
    recordType: 'User',
    recordId: args.targetUserId,
    recordLabel: `${res.rows[0].email} — two-factor reset by administrator`,
  });
}
