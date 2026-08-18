/** CLI: npm run migrate | seed | reset */
import { closeDb, getDb } from './client.ts';
import { migrate, reset } from './migrate.ts';
import { seed } from './seed.ts';
import { env } from '../env.ts';

const log = (m: string) => process.stdout.write(`${m}\n`);
const cmd = process.argv[2];

/**
 * A connection string carries a password, and this is printed to a terminal
 * that may be logged or shoulder-read. Show where it points, not how to get in.
 */
function describeDatabase(url: string): string {
  if (!url.startsWith('postgres')) return url;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname} as ${u.username}`;
  } catch {
    return 'postgres (details hidden)';
  }
}

try {
  const db = await getDb();
  log(`database: ${describeDatabase(env.databaseUrl)}`);

  if (cmd === 'reset') {
    await reset(db, env.databaseUrl);
    log('schema dropped');
  }

  if (cmd === 'migrate' || cmd === 'reset') {
    log('migrating...');
    const r = await migrate(db, { log });
    log(`  ${r.applied.length} applied, ${r.skipped.length} already present`);
  }

  if (cmd === 'seed' || cmd === 'reset') {
    log('seeding...');
    const s = await seed(db, { log });
    log(`  fiscal year ${s.fiscalYear}${s.adminCreated ? ', admin created' : ''}`);
  }

  if (!['migrate', 'seed', 'reset'].includes(cmd ?? '')) {
    log('usage: cli.ts <migrate|seed|reset>');
    process.exitCode = 1;
  }

  await closeDb();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
}
