/** Test harness: a fresh in-memory PostgreSQL per suite. */
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDb, type Db } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';
import { hashPassword } from '../src/lib/password.ts';
import { SESSION_COOKIE } from '../src/modules/auth/routes.ts';
import type { RoleCode } from '../src/modules/rbac/matrix.ts';

process.env.NODE_ENV = 'test';

export interface Harness {
  app: FastifyInstance;
  db: Db;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const db = await createDb('memory://');
  await migrate(db);
  await seed(db);
  const app = await buildApp({ db, logger: false });
  await app.ready();
  return {
    app,
    db,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

/** Tests still identify fixtures by email; the login credential is the local part. */
export function toUsername(identifier: string): string {
  return (identifier.includes('@') ? identifier.split('@')[0]! : identifier).toLowerCase();
}

export const STRONG_PASSWORD = 'Zx9-Marlin-Fjord-2026';

export async function createUser(
  db: Db,
  args: { name: string; email: string; password?: string; roles: RoleCode[]; active?: boolean }
): Promise<string> {
  const hash = await hashPassword(args.password ?? STRONG_PASSWORD);
  const ins = await db.query<{ id: string }>(
    `INSERT INTO users (name, username, email, password_hash, is_active) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [args.name, toUsername(args.email), args.email, hash, args.active ?? true]
  );
  const userId = ins.rows[0]!.id;
  for (const role of args.roles) {
    await db.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2`,
      [userId, role]
    );
  }
  return userId;
}

/** Extracts the session cookie value from a Set-Cookie header. */
export function sessionCookieFrom(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  for (const c of list) {
    const m = /^orcms_session=([^;]+)/.exec(c);
    if (m && m[1] && m[1].length > 1) return `${SESSION_COOKIE}=${m[1]}`;
  }
  return null;
}

export interface LoginResult {
  status: number;
  body: Record<string, unknown>;
  cookie: string | null;
}

export async function loginAs(
  app: FastifyInstance,
  email: string,
  password = STRONG_PASSWORD
): Promise<LoginResult> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: toUsername(email), password },
  });
  return {
    status: res.statusCode,
    body: res.json(),
    cookie: sessionCookieFrom(res as unknown as { headers: Record<string, unknown> }),
  };
}

/** Logs in a role that does not require 2FA, returning a ready-to-use cookie. */
export async function authedCookie(h: Harness, email: string): Promise<string> {
  const r = await loginAs(h.app, email);
  if (!r.cookie) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.cookie;
}
