/**
 * Vercel serverless entry point, as a catch-all route.
 *
 * Different shape from server/src/index.ts, and deliberately so:
 *
 *   - The filename is Vercel's catch-all convention, so every /api/* path
 *     reaches this one function with its original URL intact. That is what
 *     Fastify needs to route on, and it does not depend on a rewrite rule
 *     matching correctly.
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

/**
 * Declared here rather than under `functions` in vercel.json, because that key
 * is matched as a glob and `[...path]` reads as a character class there, so it
 * does not select this file. `memory` is omitted: Vercel ignores it on Active
 * CPU billing and warns on every build.
 */
export const config = { maxDuration: 30 };

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

      // Imported here rather than at module scope on purpose. A failure while
      // loading the server (a dependency missing from the bundle, a module
      // that throws as it initialises) would otherwise happen before this
      // file's own error handling exists, and the platform would report only
      // FUNCTION_INVOCATION_FAILED with no indication of what broke. Inside
      // the try, the same failure comes back as JSON naming the cause.
      const { assertProductionSafety } = await import('../server/src/env.ts');
      const { buildApp } = await import('../server/src/app.ts');

      // Refuses a development session secret, an embedded database, or
      // insecure cookies in production. Having no listen() is not a reason to
      // skip it: the deployment shape does not change what counts as safe.
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

/**
 * Vercel treats the returned promise as the life of the invocation, and tears
 * the container down once it settles. `emit('request')` only *starts* Fastify
 * handling, so returning straight after it ends the invocation while the reply
 * is still being written, and the platform reports FUNCTION_INVOCATION_FAILED.
 * Wait for the response to actually finish.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const app = await getApp();
    await new Promise<void>((resolve) => {
      res.once('close', resolve);
      res.once('finish', resolve);
      app.server.emit('request', req, res);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Startup failed';
    const stack = err instanceof Error ? err.stack : undefined;
    process.stderr.write(`serverless startup failed: ${stack ?? message}\n`);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: {
          code: 'STARTUP_FAILED',
          message,
          // Only with DEBUG_STARTUP set, so a stack trace is never public by
          // default. Startup failures are configuration or packaging faults
          // and the trace is the whole diagnosis, so it needs to be reachable
          // without shell access to the container.
          ...(process.env.DEBUG_STARTUP ? { stack: stack?.split('\n').slice(0, 8) } : {}),
        },
      })
    );
  }
}
