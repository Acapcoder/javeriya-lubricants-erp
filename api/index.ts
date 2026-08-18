/**
 * Vercel serverless entry point.
 *
 * Different shape from server/src/index.ts, and deliberately so:
 *
 *   - No app.listen(). Vercel owns the socket; we hand Fastify the raw
 *     request and let it reply.
 *   - No migrations. On a platform that may start a dozen containers at once,
 *     running migrations at boot means running them concurrently. They are a
 *     deploy step here, not a boot step: `npm run migrate` against the same
 *     DATABASE_URL, once, before the release goes out.
 *   - The app is built once per container and reused across invocations, so a
 *     warm container pays no startup cost and holds one connection pool
 *     rather than one per request.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/src/app.ts';
import { assertProductionSafety } from '../server/src/env.ts';

/**
 * Held across invocations on a warm container. The promise, not the instance,
 * so two requests arriving during a cold start share one initialisation
 * instead of racing to build two apps.
 */
let appPromise: Promise<FastifyInstance> | null = null;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Add it under Settings, Environment Variables in the Vercel project, then redeploy.`
    );
  }
  return value;
}

async function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = (async () => {
      // Fail with something readable rather than a stack trace from deep
      // inside the pool when configuration is missing.
      required('DATABASE_URL');
      required('SESSION_SECRET');

      // The same guard the office deployment runs at boot: refuses a
      // development session secret, an embedded database, or insecure cookies
      // in production. A deployment shape should not change what counts as
      // safe, so this must not be skipped just because there is no listen().
      assertProductionSafety();

      const app = await buildApp();
      await app.ready();
      return app;
    })().catch((err) => {
      // Do not cache a failed start, or the container serves 500s until it is
      // recycled even after the configuration is fixed.
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const app = await getApp();
    app.server.emit('request', req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Startup failed';
    process.stderr.write(`serverless startup failed: ${message}\n`);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'STARTUP_FAILED', message } }));
  }
}
