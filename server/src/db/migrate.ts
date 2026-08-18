/**
 * Migration runner.
 *
 * Plain .sql files applied in filename order, each inside a transaction and
 * recorded in schema_migrations. No down-migrations: corrections are new
 * forward migrations, which is the same principle the ledger uses.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from './client.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

async function ensureMigrationsTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   varchar(200) PRIMARY KEY,
      checksum   char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function migrate(db: Db, opts: { log?: (m: string) => void } = {}): Promise<MigrationResult> {
  const log = opts.log ?? (() => {});
  await ensureMigrationsTable(db);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await db.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM schema_migrations'
  );
  const already = new Map(rows.map((r) => [r.filename, r.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const prior = already.get(file);

    if (prior) {
      if (prior !== checksum) {
        throw new Error(
          `Migration ${file} has changed since it was applied.\n` +
            `Applied migrations are immutable — add a new forward migration instead.`
        );
      }
      skipped.push(file);
      continue;
    }

    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
    });
    applied.push(file);
    log(`  applied ${file}`);
  }

  return { applied, skipped };
}

/** Drops everything. Test helper — refuses to run against a real server. */
export async function reset(db: Db, databaseUrl: string): Promise<void> {
  if (databaseUrl.startsWith('postgres')) {
    throw new Error('reset() refuses to run against a PostgreSQL server. Drop the database manually.');
  }
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
