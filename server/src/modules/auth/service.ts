/**
 * Authentication service (A3) and the identity half of RBAC (A4).
 *
 * §10: scrypt hashing, lockout after 5 failures for 15 minutes, every attempt
 * logged. §6.1: 8h session lifetime, 30m idle timeout.
 */
import { randomBytes, createHash } from 'node:crypto';
import type { Db } from '../../db/client.ts';
import { env, policy } from '../../env.ts';
import { verifyPassword, hashPassword, validatePasswordStrength } from '../../lib/password.ts';
import { recordActivity } from '../activity/log.ts';
import { ValidationError } from '../../lib/errors.ts';
import type { PermissionCode, RoleCode } from '../rbac/matrix.ts';

export interface AuthUser {
  id: string;
  name: string;
  username: string;
  email: string | null;
  isActive: boolean;
  roles: RoleCode[];
  permissions: PermissionCode[];
  twoFactorEnrolled: boolean;
  twoFactorRequired: boolean;
}

export interface SessionContext {
  sessionId: string;
  user: AuthUser;
  twoFactorOk: boolean;
  /** True when the role demands 2FA but the user has not enrolled yet. */
  twoFactorEnrollmentRequired: boolean;
}

export type LoginOutcome =
  | { status: 'AUTHENTICATED'; sessionId: string; user: AuthUser }
  | { status: 'TWO_FACTOR_REQUIRED'; sessionId: string; user: AuthUser }
  | { status: 'TWO_FACTOR_ENROLLMENT_REQUIRED'; sessionId: string; user: AuthUser }
  | { status: 'INVALID_CREDENTIALS' }
  | { status: 'ACCOUNT_LOCKED'; until: Date }
  | { status: 'ACCOUNT_DISABLED' };

interface UserRow {
  id: string;
  name: string;
  username: string;
  email: string | null;
  password_hash: string;
  is_active: boolean;
  failed_attempts: number;
  locked_until: Date | string | null;
  two_factor_confirmed_at: Date | string | null;
}

function toDate(v: Date | string | null): Date | null {
  if (v === null) return null;
  return v instanceof Date ? v : new Date(v);
}

export async function loadAuthUser(db: Db, userId: string | number): Promise<AuthUser | null> {
  const u = await db.query<UserRow>(
    `SELECT id, name, username, email, password_hash, is_active, failed_attempts, locked_until, two_factor_confirmed_at
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId]
  );
  const row = u.rows[0];
  if (!row) return null;

  const roles = await db.query<{ code: RoleCode; requires_2fa: boolean }>(
    `SELECT r.code, r.requires_2fa
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1`,
    [userId]
  );

  const perms = await db.query<{ code: PermissionCode }>(
    `SELECT DISTINCT p.code
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p       ON p.id = rp.permission_id
      WHERE ur.user_id = $1`,
    [userId]
  );

  return {
    id: String(row.id),
    name: row.name,
    username: row.username,
    email: row.email,
    isActive: row.is_active,
    roles: roles.rows.map((r) => r.code),
    permissions: perms.rows.map((p) => p.code),
    twoFactorEnrolled: row.two_factor_confirmed_at !== null,
    // With ENFORCE_2FA=false nobody is pushed through enrolment. A user who
    // enrolled voluntarily is still challenged — see policy.enforceTwoFactor.
    twoFactorRequired: policy.enforceTwoFactor && roles.rows.some((r) => r.requires_2fa),
  };
}

async function logAttempt(
  db: Db,
  args: { email: string; userId?: string | null; ok: boolean; reason?: string; ip?: string | null; ua?: string | null }
): Promise<void> {
  await db.query(
    `INSERT INTO login_attempts (email, user_id, succeeded, reason, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [args.email, args.userId ?? null, args.ok, args.reason ?? null, args.ip ?? null, args.ua ?? null]
  );
}

export async function login(
  db: Db,
  args: { username: string; password: string; ip?: string | null; userAgent?: string | null }
): Promise<LoginOutcome> {
  const username = args.username.trim().toLowerCase();
  const res = await db.query<UserRow>(
    `SELECT id, name, username, email, password_hash, is_active, failed_attempts, locked_until, two_factor_confirmed_at
       FROM users WHERE username = $1 AND deleted_at IS NULL`,
    [username]
  );
  const row = res.rows[0];

  // Always spend comparable time on unknown accounts so the response time
  // does not reveal whether a username exists.
  if (!row) {
    await verifyPassword(args.password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await logAttempt(db, { email: username, ok: false, reason: 'NO_SUCH_USER', ip: args.ip, ua: args.userAgent });
    return { status: 'INVALID_CREDENTIALS' };
  }

  const lockedUntil = toDate(row.locked_until);
  if (lockedUntil && lockedUntil.getTime() > Date.now()) {
    await logAttempt(db, { email: username, userId: row.id, ok: false, reason: 'LOCKED', ip: args.ip, ua: args.userAgent });
    return { status: 'ACCOUNT_LOCKED', until: lockedUntil };
  }

  if (!row.is_active) {
    await logAttempt(db, { email: username, userId: row.id, ok: false, reason: 'DISABLED', ip: args.ip, ua: args.userAgent });
    return { status: 'ACCOUNT_DISABLED' };
  }

  const ok = await verifyPassword(args.password, row.password_hash);

  if (!ok) {
    const attempts = row.failed_attempts + 1;
    const shouldLock = attempts >= env.maxLoginAttempts;
    await db.query(
      `UPDATE users
          SET failed_attempts = $2,
              locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
        WHERE id = $1`,
      [row.id, shouldLock ? 0 : attempts, shouldLock, String(env.lockoutMinutes)]
    );
    await logAttempt(db, {
      email: username,
      userId: row.id,
      ok: false,
      reason: shouldLock ? 'BAD_PASSWORD_LOCKOUT' : 'BAD_PASSWORD',
      ip: args.ip,
      ua: args.userAgent,
    });
    await recordActivity(db, {
      userId: row.id,
      userName: row.name,
      module: 'auth',
      action: shouldLock ? 'LOCKOUT' : 'LOGIN_FAILED',
      recordType: 'User',
      recordId: row.id,
      recordLabel: row.username,
      ip: args.ip,
      userAgent: args.userAgent,
    });

    if (shouldLock) {
      const until = new Date(Date.now() + env.lockoutMinutes * 60_000);
      return { status: 'ACCOUNT_LOCKED', until };
    }
    return { status: 'INVALID_CREDENTIALS' };
  }

  // Success — clear the counter and open a session.
  await db.query(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
    [row.id]
  );
  await logAttempt(db, { email: username, userId: row.id, ok: true, ip: args.ip, ua: args.userAgent });

  const user = (await loadAuthUser(db, row.id))!;
  const needs2fa = user.twoFactorRequired || user.twoFactorEnrolled;
  const sessionId = await createSession(db, {
    userId: row.id,
    ip: args.ip,
    userAgent: args.userAgent,
    twoFactorOk: !needs2fa,
  });

  if (user.twoFactorRequired && !user.twoFactorEnrolled) {
    return { status: 'TWO_FACTOR_ENROLLMENT_REQUIRED', sessionId, user };
  }
  if (needs2fa) {
    return { status: 'TWO_FACTOR_REQUIRED', sessionId, user };
  }

  await recordActivity(db, {
    userId: row.id,
    userName: row.name,
    module: 'auth',
    action: 'LOGIN',
    recordType: 'User',
    recordId: row.id,
    recordLabel: row.username,
    ip: args.ip,
    userAgent: args.userAgent,
  });
  return { status: 'AUTHENTICATED', sessionId, user };
}

/* --------------------------------------------------------------- sessions */

export async function createSession(
  db: Db,
  args: { userId: string | number; ip?: string | null; userAgent?: string | null; twoFactorOk: boolean }
): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (id, user_id, ip_address, user_agent, two_factor_ok, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' minutes')::interval)`,
    [id, args.userId, args.ip ?? null, args.userAgent ?? null, args.twoFactorOk, String(env.sessionLifetimeMinutes)]
  );
  return id;
}

export async function resolveSession(db: Db, sessionId: string): Promise<SessionContext | null> {
  const res = await db.query<{
    id: string;
    user_id: string;
    two_factor_ok: boolean;
    expires_at: Date | string;
    last_seen_at: Date | string;
  }>(
    `SELECT id, user_id, two_factor_ok, expires_at, last_seen_at
       FROM sessions
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId]
  );
  const row = res.rows[0];
  if (!row) return null;

  const now = Date.now();
  const expiresAt = toDate(row.expires_at)!.getTime();
  const lastSeen = toDate(row.last_seen_at)!.getTime();

  if (now > expiresAt) {
    await revokeSession(db, sessionId);
    return null;
  }
  if (now - lastSeen > env.sessionIdleMinutes * 60_000) {
    await revokeSession(db, sessionId);
    return null;
  }

  const user = await loadAuthUser(db, row.user_id);
  if (!user || !user.isActive) {
    await revokeSession(db, sessionId);
    return null;
  }

  await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [sessionId]);

  return {
    sessionId: row.id,
    user,
    twoFactorOk: row.two_factor_ok,
    twoFactorEnrollmentRequired: user.twoFactorRequired && !user.twoFactorEnrolled,
  };
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

export async function revokeAllSessionsForUser(db: Db, userId: string | number): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

export async function markSessionTwoFactorOk(db: Db, sessionId: string): Promise<void> {
  await db.query('UPDATE sessions SET two_factor_ok = true WHERE id = $1', [sessionId]);
}

/* -------------------------------------------------------- password change */

export async function changePassword(
  db: Db,
  args: { userId: string; currentPassword: string; newPassword: string; ip?: string | null; userAgent?: string | null }
): Promise<void> {
  const res = await db.query<{ password_hash: string; username: string; email: string | null; name: string }>(
    'SELECT password_hash, username, email, name FROM users WHERE id = $1 AND deleted_at IS NULL',
    [args.userId]
  );
  const row = res.rows[0];
  if (!row) throw new ValidationError('User not found');

  if (!(await verifyPassword(args.currentPassword, row.password_hash))) {
    throw new ValidationError('Current password is incorrect');
  }

  const strength = validatePasswordStrength(args.newPassword, {
    email: row.email ?? row.username,
    name: row.name,
  });
  if (!strength.ok) throw new ValidationError('Password is not strong enough', { problems: strength.problems });

  const hash = await hashPassword(args.newPassword);
  await db.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [args.userId, hash]);

  // §10: changing a password invalidates other sessions.
  await revokeAllSessionsForUser(db, args.userId);

  await recordActivity(db, {
    userId: args.userId,
    userName: row.name,
    module: 'auth',
    action: 'PASSWORD_CHANGED',
    recordType: 'User',
    recordId: args.userId,
    recordLabel: row.username,
    ip: args.ip,
    userAgent: args.userAgent,
  });
}

/** Stable hash for recovery codes — they are stored, never echoed back. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.replace(/-/g, '').toUpperCase()).digest('hex');
}
