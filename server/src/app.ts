/** Fastify application factory. */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.ts';
import { createDb, type Db } from './db/client.ts';
import { AppError } from './lib/errors.ts';
import { resolveSession, type SessionContext } from './modules/auth/service.ts';
import { authRoutes, SESSION_COOKIE } from './modules/auth/routes.ts';
import { metaRoutes } from './modules/meta/routes.ts';
import { financeRoutes } from './modules/finance/index.ts';
import { masterRoutes } from './modules/masters/routes.ts';
import { inventoryRoutes } from './modules/inventory/routes.ts';
import { purchaseRoutes } from './modules/purchases/routes.ts';
import { reportRoutes } from './modules/reports/routes.ts';
import { userRoutes } from './modules/users/routes.ts';
import { attachmentRoutes } from './modules/attachments/routes.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
  interface FastifyRequest {
    auth: SessionContext | null;
  }
}

export interface BuildOptions {
  db?: Db;
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? (!env.isTest && { level: env.isProduction ? 'info' : 'warn' }),
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  const db = opts.db ?? (await createDb());
  app.decorate('db', db);
  app.decorateRequest('auth', null);

  await app.register(cookie, { secret: env.sessionSecret });

  /* ------------------------------------------------------- security headers */
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Permitted-Cross-Domain-Policies', 'none');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
        "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    if (env.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return payload;
  });

  /* ------------------------------------------------------- session resolver */
  app.addHook('preHandler', async (request) => {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) {
      request.auth = null;
      return;
    }
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) {
      request.auth = null;
      return;
    }
    request.auth = await resolveSession(db, unsigned.value);
  });

  /* -------------------------------------------------------- error handling */
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details ?? undefined },
      });
    }

    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      return reply.status(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. The error has been logged.' },
      });
    }
    return reply.status(status).send({
      error: { code: 'REQUEST_ERROR', message: error instanceof Error ? error.message : 'Request failed' },
    });
  });

  await app.register(authRoutes);
  await app.register(metaRoutes);
  await app.register(financeRoutes);
  await app.register(masterRoutes);
  await app.register(inventoryRoutes);
  await app.register(purchaseRoutes);
  await app.register(reportRoutes);
  await app.register(userRoutes);
  await app.register(attachmentRoutes);

  /* ------------------------------------------- built frontend (production) */
  // `npm run build` emits the SPA into server/public. When it is present the
  // API and the UI are served from one origin, which is what makes the
  // SameSite=strict session cookie work without any CORS relaxation.
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const hasBuiltFrontend = existsSync(join(publicDir, 'index.html'));

  if (hasBuiltFrontend) {
    const { default: fastifyStatic } = await import('@fastify/static');
    // index must be enabled, otherwise a request for "/" is treated as a
    // directory listing and refused with 403 rather than serving the SPA.
    await app.register(fastifyStatic, { root: publicDir, index: ['index.html'] });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No route for ${request.url}` } });
    }
    // Single-page app: every other path is routed client-side.
    if (hasBuiltFrontend) return reply.type('text/html').sendFile('index.html');
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Frontend not built. Run `npm run build`, or use the Vite dev server.' },
    });
  });

  return app;
}
