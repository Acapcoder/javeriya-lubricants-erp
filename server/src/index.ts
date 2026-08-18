/** Server entry point. */
import { buildApp } from './app.ts';
import { assertProductionSafety, env, warnings } from './env.ts';
import { closeDb, getDb } from './db/client.ts';
import { migrate } from './db/migrate.ts';

assertProductionSafety();

for (const w of warnings()) process.stdout.write(`WARNING  ${w}\n`);

const db = await getDb();

// Migrations run at boot so the office server only ever needs `docker compose up`.
const result = await migrate(db, { log: (m) => process.stdout.write(`${m}\n`) });
if (result.applied.length > 0) process.stdout.write(`migrations: ${result.applied.length} applied\n`);

const app = await buildApp({ db });

try {
  await app.listen({ host: env.host, port: env.port });
  process.stdout.write(`ORCMS API listening on http://${env.host}:${env.port}  [${env.nodeEnv}]\n`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

/**
 * Graceful shutdown.
 *
 * The database must be closed, not just the HTTP server. The embedded engine
 * flushes to disk on close; killing the process without it leaves a torn data
 * directory that will not reopen. (A real PostgreSQL server replays its WAL and
 * survives this, which is one more reason production does not run embedded.)
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n${signal} received — shutting down\n`);

  const timer = setTimeout(() => {
    process.stderr.write('shutdown timed out after 10s, exiting anyway\n');
    process.exit(1);
  }, 10_000);
  timer.unref();

  try {
    await app.close();
    await closeDb();
    process.stdout.write('closed cleanly\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`error during shutdown: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => void shutdown(signal));
}
// Windows delivers Ctrl+Break as SIGBREAK, and tsx watch restarts send SIGTERM.
process.on('beforeExit', () => void shutdown('beforeExit'));
