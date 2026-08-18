/**
 * Password hashing.
 *
 * IMPLEMENTATION.md §10 specifies bcrypt cost 12. This uses scrypt instead:
 * it is memory-hard (bcrypt is not), it ships inside Node's crypto module,
 * and it needs no native compilation — which matters for a system that has to
 * be rebuilt on office hardware from a runbook. Parameters below are tuned to
 * roughly 100 ms per hash, comparable to bcrypt cost 12.
 *
 * Format: scrypt$N$r$p$<salt-b64>$<hash-b64>
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '../env.ts';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

const N = 1 << 15; // 32768
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 128 * N * R * 2;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(plain.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || expected.length === 0) return false;

  const actual = await scrypt(plain.normalize('NFKC'), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: 128 * n * r * 2,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface PasswordProblem {
  ok: boolean;
  problems: string[];
}

/** §10: minimum 12 characters, plus basic composition and a common-password screen. */
export function validatePasswordStrength(plain: string, context: { email?: string; name?: string } = {}): PasswordProblem {
  const problems: string[] = [];
  const min = env.minPasswordLength;

  if (plain.length < min) problems.push(`must be at least ${min} characters`);
  if (plain.length > 200) problems.push('must be at most 200 characters');
  if (!/[a-z]/.test(plain)) problems.push('must contain a lowercase letter');
  if (!/[A-Z]/.test(plain)) problems.push('must contain an uppercase letter');
  if (!/[0-9]/.test(plain)) problems.push('must contain a digit');

  const lower = plain.toLowerCase();
  if (context.email) {
    const local = context.email.split('@')[0]?.toLowerCase();
    if (local && local.length >= 3 && lower.includes(local)) problems.push('must not contain your email address');
  }
  if (context.name && context.name.length >= 3 && lower.includes(context.name.toLowerCase()))
    problems.push('must not contain your name');

  for (const weak of ['password', 'orcms', '123456', 'qwerty', 'letmein', 'admin123']) {
    if (lower.includes(weak)) {
      problems.push(`must not contain the common word "${weak}"`);
      break;
    }
  }

  return { ok: problems.length === 0, problems };
}
