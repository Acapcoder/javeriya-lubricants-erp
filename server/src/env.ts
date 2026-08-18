/**
 * Environment configuration.
 *
 * DATABASE_URL drives which driver is used:
 *   unset / "pglite"        -> embedded PostgreSQL 16 (WASM), persisted under .data/
 *   "memory://"             -> embedded PostgreSQL, in-memory (tests)
 *   "postgres://..."        -> real PostgreSQL server (production, per IMPLEMENTATION.md §3)
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads .env into process.env if present.
 *
 * Real environment variables always win, so Docker Compose and CI keep
 * control. Skipped under the test runner: a developer's local .env must never
 * change what the suite asserts.
 */
/**
 * Repository root, derived from this file's location.
 *
 * Everything on disk (the .env file, the embedded database directory) is
 * resolved against this rather than process.cwd(). npm workspaces run scripts
 * with cwd set to the workspace, so a cwd-relative path silently produces a
 * *different* database depending on where the command was run from.
 */
export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnvFile(): void {
  // NODE_TEST_CONTEXT is set by node:test in the child process that runs the
  // suite. It is the only reliable signal here: NODE_ENV is not yet set when
  // this module is evaluated (imports resolve before any test file body runs),
  // and a bare "--test" never reaches the child's argv.
  const isTest =
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_TEST_CONTEXT !== undefined ||
    process.execArgv.some((a) => a.startsWith('--test'));
  if (isTest) return;

  try {
    const file = join(projectRoot, '.env');
    if (!existsSync(file)) return;

    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;

      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // A malformed .env must not stop the server from booting.
  }
}

loadEnvFile();

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',

  host: process.env.HOST ?? '0.0.0.0',
  // 3200 rather than 3000: the default is a crowded port on developer
  // machines, and a silent clash with another project is hard to diagnose.
  // Docker Compose overrides this with PORT.
  port: int(process.env.PORT, 3200),

  databaseUrl: process.env.DATABASE_URL ?? 'pglite',
  pgliteDataDir: process.env.PGLITE_DATA_DIR ?? '.data/orcms',

  /** Signs the session cookie. MUST be set in production. */
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-only-insecure-secret-change-me-in-production',
  cookieSecure: bool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),

  /** §6.1: 8 hour session lifetime, 30 minute idle timeout. */
  sessionLifetimeMinutes: int(process.env.SESSION_LIFETIME_MINUTES, 8 * 60),
  sessionIdleMinutes: int(process.env.SESSION_IDLE_MINUTES, 30),

  /** §10: lockout after 5 failed attempts for 15 minutes. */
  maxLoginAttempts: int(process.env.MAX_LOGIN_ATTEMPTS, 5),
  lockoutMinutes: int(process.env.LOCKOUT_MINUTES, 15),

  /** §10: minimum 12-character passwords. */
  minPasswordLength: int(process.env.MIN_PASSWORD_LENGTH, 12),

  totpIssuer: process.env.TOTP_ISSUER ?? 'ORCMS',

  /** Seeded bootstrap administrator. Change immediately after first login. */
  seedAdminUsername: (process.env.SEED_ADMIN_USERNAME ?? 'admin').toLowerCase(),
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMeAdmin2026!',
} as const;

/**
 * Runtime security policy.
 *
 * Separate from `env` because it is mutable: tests flip these directly, and an
 * administrator screen may later change them without a restart.
 */
export const policy = {
  /**
   * §6.1 makes two-factor authentication mandatory for Administrator and
   * Accountant. Setting ENFORCE_2FA=false relaxes that to opt-in: nobody is
   * pushed through enrolment, but anyone who HAS enrolled is still challenged,
   * so turning the flag off never silently weakens an account that opted in.
   */
  enforceTwoFactor: bool(process.env.ENFORCE_2FA, true),
};

export function assertProductionSafety(): void {
  if (!env.isProduction) return;
  const problems: string[] = [];
  if (env.sessionSecret.startsWith('dev-only')) problems.push('SESSION_SECRET is still the development default');
  if (env.databaseUrl.startsWith('pglite') || env.databaseUrl.startsWith('memory'))
    problems.push('DATABASE_URL must point at a real PostgreSQL server in production');
  if (!env.cookieSecure) problems.push('COOKIE_SECURE must be true in production');
  if (problems.length) throw new Error(`Unsafe production configuration:\n  - ${problems.join('\n  - ')}`);
}

/**
 * Warnings that should be visible but must not stop the server. Disabling 2FA
 * is a deliberate operational choice, not a misconfiguration — so it is
 * announced loudly rather than blocked.
 */
export function warnings(): string[] {
  const out: string[] = [];
  if (!policy.enforceTwoFactor) {
    out.push(
      'ENFORCE_2FA=false — two-factor authentication is OPT-IN. ' +
        'IMPLEMENTATION.md §6.1 requires it for Administrator and Accountant. ' +
        'Set ENFORCE_2FA=true before go-live.'
    );
  }
  if (!env.isProduction && env.sessionSecret.startsWith('dev-only')) {
    out.push('SESSION_SECRET is the development default — fine locally, never in production.');
  }
  return out;
}
