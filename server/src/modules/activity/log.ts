/**
 * Activity log (§4.10, §6.9).
 *
 * Every write in the system lands here. user_name is denormalised so the trail
 * survives deletion of the user who made the change — an audit trail that
 * disappears with its author is not an audit trail.
 */
import type { Db } from '../../db/client.ts';

export type ActivityAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'LOGIN'
  | 'LOGIN_FAILED'
  | 'LOGOUT'
  | 'LOCKOUT'
  | 'EXPORT'
  | 'LOCK'
  | 'UNLOCK'
  | 'RESTORE'
  | 'RECOST'
  | '2FA_ENROLLED'
  | '2FA_FAILED'
  | 'PASSWORD_CHANGED'
  | 'OVERRIDE';

export interface ActivityInput {
  userId?: string | number | null;
  userName: string;
  module: string;
  action: ActivityAction;
  recordType?: string | null;
  recordId?: string | number | null;
  recordLabel?: string | null;
  oldValues?: unknown;
  newValues?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/** Fields that must never reach the activity log. */
const REDACTED = new Set([
  'password',
  'password_hash',
  'passwordHash',
  'two_factor_secret',
  'twoFactorSecret',
  'two_factor_recovery',
  'secret',
  'token',
]);

export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED.has(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

/** Only the fields that actually changed, so the log reads as a diff. */
export function diff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): { old: Record<string, unknown>; new: Record<string, unknown> } {
  const oldOut: Record<string, unknown> = {};
  const newOut: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    const b = before?.[k];
    const a = after?.[k];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      oldOut[k] = b ?? null;
      newOut[k] = a ?? null;
    }
  }
  return { old: redact(oldOut) as Record<string, unknown>, new: redact(newOut) as Record<string, unknown> };
}

export async function recordActivity(db: Db, input: ActivityInput): Promise<void> {
  await db.query(
    `INSERT INTO activity_logs
       (user_id, user_name, module, action, record_type, record_id, record_label,
        old_values, new_values, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      input.userId ?? null,
      input.userName,
      input.module,
      input.action,
      input.recordType ?? null,
      input.recordId ?? null,
      input.recordLabel ?? null,
      input.oldValues === undefined ? null : JSON.stringify(redact(input.oldValues)),
      input.newValues === undefined ? null : JSON.stringify(redact(input.newValues)),
      input.ip ?? null,
      input.userAgent ?? null,
    ]
  );
}
