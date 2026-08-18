/** Auth, 2FA and session routes. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../env.ts';
import { ValidationError, UnauthorizedError } from '../../lib/errors.ts';
import { recordActivity } from '../activity/log.ts';
import { changePassword, login, revokeSession } from './service.ts';
import { beginEnrollment, confirmEnrollment, verifyChallenge } from '../twofactor/service.ts';
import { requireAuth } from '../rbac/guard.ts';

export const SESSION_COOKIE = 'orcms_session';

const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(2).max(60),
  password: z.string().min(1).max(200),
});

const codeSchema = z.object({ code: z.string().min(6).max(20) });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

function cookieOptions(maxAgeSeconds: number) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: env.cookieSecure,
    signed: true,
    maxAge: maxAgeSeconds,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------ login */
  app.post('/api/auth/login', async (request, reply) => {
    const body = loginSchema.safeParse(request.body);
    if (!body.success) throw new ValidationError('Username and password are required', body.error.flatten());

    const outcome = await login(app.db, {
      username: body.data.username,
      password: body.data.password,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    switch (outcome.status) {
      case 'INVALID_CREDENTIALS':
        return reply.status(401).send({
          error: { code: 'INVALID_CREDENTIALS', message: 'Username or password is incorrect' },
        });

      case 'ACCOUNT_DISABLED':
        return reply.status(403).send({
          error: { code: 'ACCOUNT_DISABLED', message: 'This account has been disabled' },
        });

      case 'ACCOUNT_LOCKED':
        return reply.status(429).send({
          error: {
            code: 'ACCOUNT_LOCKED',
            message: `Too many failed attempts. Try again after ${outcome.until.toLocaleTimeString()}.`,
            lockedUntil: outcome.until.toISOString(),
          },
        });

      default: {
        reply.setCookie(SESSION_COOKIE, outcome.sessionId, cookieOptions(env.sessionLifetimeMinutes * 60));
        return reply.send({
          status: outcome.status,
          user: publicUser(outcome.user),
        });
      }
    }
  });

  /* ----------------------------------------------------------------- logout */
  app.post('/api/auth/logout', async (request, reply) => {
    if (request.auth) {
      await revokeSession(app.db, request.auth.sessionId);
      await recordActivity(app.db, {
        userId: request.auth.user.id,
        userName: request.auth.user.name,
        module: 'auth',
        action: 'LOGOUT',
        recordType: 'User',
        recordId: request.auth.user.id,
        recordLabel: request.auth.user.email,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  /* --------------------------------------------------------------------- me */
  app.get('/api/auth/me', async (request, reply) => {
    if (!request.auth) throw new UnauthorizedError();
    return reply.send({
      user: publicUser(request.auth.user),
      session: {
        twoFactorOk: request.auth.twoFactorOk,
        twoFactorEnrollmentRequired: request.auth.twoFactorEnrollmentRequired,
      },
    });
  });

  /* ---------------------------------------------------------- 2FA enrolment */
  app.post('/api/auth/2fa/enroll', async (request, reply) => {
    if (!request.auth) throw new UnauthorizedError();
    const challenge = await beginEnrollment(app.db, request.auth.user.id);
    // The secret is returned once, for the QR code and manual entry.
    return reply.send({
      secret: challenge.secret,
      otpauthUri: challenge.otpauthUri,
      qrDataUri: challenge.qrDataUri,
    });
  });

  app.post('/api/auth/2fa/confirm', async (request, reply) => {
    if (!request.auth) throw new UnauthorizedError();
    const body = codeSchema.safeParse(request.body);
    if (!body.success) throw new ValidationError('A 6-digit code is required');

    const result = await confirmEnrollment(app.db, {
      userId: request.auth.user.id,
      code: body.data.code,
      sessionId: request.auth.sessionId,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    // Recovery codes are shown exactly once.
    return reply.send({ ok: true, recoveryCodes: result.recoveryCodes });
  });

  /* ------------------------------------------------------- 2FA login verify */
  app.post('/api/auth/2fa/verify', async (request, reply) => {
    if (!request.auth) throw new UnauthorizedError();
    const body = codeSchema.safeParse(request.body);
    if (!body.success) throw new ValidationError('A 6-digit code is required');

    const result = await verifyChallenge(app.db, {
      userId: request.auth.user.id,
      sessionId: request.auth.sessionId,
      code: body.data.code,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    if (!result.ok) {
      return reply.status(401).send({
        error: { code: 'INVALID_CODE', message: 'That code is not valid' },
      });
    }
    return reply.send({ ok: true, usedRecoveryCode: result.usedRecoveryCode });
  });

  /* -------------------------------------------------------- change password */
  app.post('/api/auth/password', { preHandler: requireAuth }, async (request, reply) => {
    const body = changePasswordSchema.safeParse(request.body);
    if (!body.success) throw new ValidationError('Both current and new password are required');

    await changePassword(app.db, {
      userId: request.auth!.user.id,
      currentPassword: body.data.currentPassword,
      newPassword: body.data.newPassword,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true, message: 'Password changed. Please sign in again.' });
  });
}

function publicUser(u: {
  id: string;
  name: string;
  username: string;
  email: string | null;
  roles: string[];
  permissions: string[];
  twoFactorEnrolled: boolean;
  twoFactorRequired: boolean;
}) {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    email: u.email,
    roles: u.roles,
    permissions: u.permissions,
    twoFactorEnrolled: u.twoFactorEnrolled,
    twoFactorRequired: u.twoFactorRequired,
  };
}
