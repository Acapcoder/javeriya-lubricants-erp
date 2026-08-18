/**
 * Database access.
 *
 * One narrow interface over two drivers so the same SQL runs in tests
 * (embedded PostgreSQL 16 via PGlite) and in production (real PostgreSQL).
 * All SQL in this codebase is plain PostgreSQL — there is no dialect layer
 * and no ORM, because the schema in IMPLEMENTATION.md §4 leans on PostgreSQL
 * features (deferred constraint triggers, enums, partial indexes, FOR UPDATE)
 * that an abstraction would only get in the way of.
 */
import { isAbsolute, join } from 'node:path';
import { env, projectRoot } from '../env.ts';

export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
  /**
   * Runs a multi-statement script (migrations, DDL). Uses the simple query
   * protocol, so it takes no parameters — never build one of these by
   * concatenating user input.
   */
  exec(sql: string): Promise<void>;
  /** Runs fn inside a transaction, rolling back on any throw. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ PGlite */

/**
 * PostgreSQL OIDs whose values must stay strings.
 *
 * node-postgres returns int8/numeric as strings because they exceed the range
 * and precision of a JS number. PGlite parses them into numbers by default,
 * which would silently round money the moment a figure grows large enough.
 * Forcing both drivers to the same string representation keeps the test
 * environment honest about what production will do.
 */
const STRING_OIDS = {
  INT8: 20,
  NUMERIC: 1700,
} as const;

async function createPglite(dataDir: string | undefined): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');

  // PGlite creates only the leaf directory, so a nested default like
  // ".data/orcms" fails on a fresh clone. Create the parents ourselves.
  if (dataDir) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dataDir, { recursive: true });
  }

  const identity = (v: string) => v;
  const options = {
    parsers: {
      [STRING_OIDS.INT8]: identity,
      [STRING_OIDS.NUMERIC]: identity,
    },
  };
  const pg = dataDir ? new PGlite(dataDir, options) : new PGlite(options);
  await pg.waitReady;

  const wrap = (inTx: boolean): Db => ({
    async query<R>(sql: string, params: unknown[] = []) {
      const res = await pg.query<R>(sql, params as never[]);
      return { rows: res.rows as R[], rowCount: res.rows.length };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // PGlite is single-connection; nested transactions reuse the outer one.
      if (inTx) return fn(wrap(true));
      await pg.exec('BEGIN');
      try {
        const out = await fn(wrap(true));
        await pg.exec('COMMIT');
        return out;
      } catch (err) {
        await pg.exec('ROLLBACK').catch(() => {});
        throw err;
      }
    },
    async close() {
      if (!inTx) await pg.close();
    },
  });

  return wrap(false);
}

/* -------------------------------------------------------------- PostgreSQL */

async function createPostgres(url: string): Promise<Db> {
  const { default: pgLib } = await import('pg');

  // Hosted PostgreSQL (Supabase, RDS, and friends) requires TLS, and
  // node-postgres does not enable it from the connection string alone. A
  // local server on the office LAN does not, so it is decided by host.
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === 'db' || host === '';

  // A serverless container handles one request at a time, so a large pool per
  // container multiplies straight into the database's connection limit. On
  // Vercel we hold one or two; on a long-running server, ten.
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const maxConnections = Number(process.env.DB_POOL_MAX ?? (isServerless ? 2 : 10));

  const pool = new pgLib.Pool({
    connectionString: url,
    max: maxConnections,
    // Supabase terminates TLS at the pooler with its own chain; verifying it
    // needs their CA bundle, which is not something to hardcode. The
    // connection is still encrypted.
    ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
    connectionTimeoutMillis: 20_000,
    // Idle connections are released quickly on serverless: a container that is
    // about to be frozen should not be holding one open.
    idleTimeoutMillis: isServerless ? 10_000 : 30_000,
    allowExitOnIdle: isServerless,
  });

  pool.on('error', (err) => {
    process.stderr.write(`postgres pool error: ${err.message}\n`);
  });

  const fromClient = (client: import('pg').PoolClient): Db => ({
    async query<R>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return { rows: res.rows as R[], rowCount: res.rowCount ?? res.rows.length };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return fn(fromClient(client)); // already inside one
    },
    async close() {
      /* client is released by the owning transaction */
    },
  });

  return {
    async query<R>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return { rows: res.rows as R[], rowCount: res.rowCount ?? res.rows.length };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(fromClient(client));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/* ---------------------------------------------------------------- factory */

export async function createDb(url: string = env.databaseUrl): Promise<Db> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return createPostgres(url);
  if (url === 'memory://' || url === 'memory') return createPglite(undefined);

  const dir = url === 'pglite' ? env.pgliteDataDir : url.replace(/^pglite:\/\//, '');
  // Anchored to the repository root, never to cwd — otherwise `npm run migrate`
  // (cwd = server/) and a script run from the root would use two different
  // databases, and the second would silently appear empty.
  return createPglite(isAbsolute(dir) ? dir : join(projectRoot, dir));
}

let singleton: Db | null = null;

export async function getDb(): Promise<Db> {
  if (!singleton) singleton = await createDb();
  return singleton;
}

export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = null;
  }
}
