/**
 * User management (Administrator only).
 *
 * Sign in is by username and password. Email is optional contact detail, kept
 * because it is useful for reaching someone, but never used to identify them.
 *
 * An administrator can set a password directly here. That is deliberate: in a
 * yard office there is often no email to send a reset link to, so the practical
 * mechanism is the admin setting a password and telling the person. Every such
 * action is logged, and setting a password ends that user's live sessions.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../rbac/guard.ts';
import { recordActivity } from '../activity/log.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.ts';
import { hashPassword, validatePasswordStrength } from '../../lib/password.ts';
import { revokeAllSessionsForUser } from '../auth/service.ts';
import { ROLES } from '../rbac/matrix.ts';

const username = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9._-]+$/, 'Use letters, numbers, dots, dashes or underscores. No spaces and no @.');

const idParam = z.object({ id: z.coerce.number().int().positive() });

export const userRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('preHandler', requireAuth);

  app.get('/api/users', { preHandler: requirePermission('users.manage') }, async () => {
    const res = await app.db.query(
      `SELECT u.id, u.username, u.name, u.email, u.is_active AS "isActive",
              u.last_login_at AS "lastLogin", u.locked_until AS "lockedUntil",
              u.two_factor_confirmed_at IS NOT NULL AS "twoFactor",
              COALESCE(
                (SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                  WHERE ur.user_id = u.id LIMIT 1), ''
              ) AS role
         FROM users u
        WHERE u.deleted_at IS NULL
        ORDER BY u.name`
    );
    return { users: res.rows, roles: ROLES };
  });

  app.post('/api/users', { preHandler: requirePermission('users.manage') }, async (request, reply) => {
    const data = z
      .object({
        username,
        name: z.string().trim().min(1).max(120),
        password: z.string().min(1).max(200),
        role: z.enum(ROLES),
        email: z.string().trim().email().max(190).optional().nullable().or(z.literal('')),
      })
      .parse(request.body);

    const strength = validatePasswordStrength(data.password, { name: data.name, email: data.username });
    if (!strength.ok) {
      throw new ValidationError('That password is not strong enough', { problems: strength.problems });
    }

    const hash = await hashPassword(data.password);

    try {
      const created = await app.db.transaction(async (tx) => {
        const ins = await tx.query<{ id: string }>(
          `INSERT INTO users (username, name, email, password_hash, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
          [data.username, data.name, data.email || null, hash, request.auth!.user.id]
        );
        const id = ins.rows[0]!.id;
        await tx.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2`, [
          id,
          data.role,
        ]);
        return id;
      });

      await recordActivity(app.db, {
        userId: request.auth!.user.id,
        userName: request.auth!.user.name,
        module: 'admin.users',
        action: 'CREATE',
        recordType: 'User',
        recordId: created,
        recordLabel: `${data.username} (${data.role})`,
        // The password is redacted by the activity log before it is stored.
        newValues: { username: data.username, name: data.name, role: data.role },
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.status(201).send({ id: created, username: data.username, role: data.role });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError(`The username "${data.username}" is already taken`);
      }
      throw err;
    }
  });

  app.put('/api/users/:id', { preHandler: requirePermission('users.manage') }, async (request) => {
    const { id } = idParam.parse(request.params);
    const data = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        email: z.string().trim().max(190).optional().nullable(),
        role: z.enum(ROLES).optional(),
        isActive: z.boolean().optional(),
      })
      .parse(request.body);

    const before = await app.db.query<{ username: string; is_active: boolean }>(
      'SELECT username, is_active FROM users WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (!before.rows[0]) throw new NotFoundError('User not found');

    // Locking yourself out of the only administrator account would leave the
    // system unadministrable, so it is refused rather than warned about.
    if (data.isActive === false || (data.role && data.role !== 'ADMIN')) {
      const admins = await app.db.query<{ n: string }>(
        `SELECT count(*) AS n FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
          WHERE r.code = 'ADMIN' AND u.is_active AND u.deleted_at IS NULL AND u.id <> $1`,
        [id]
      );
      if (Number(admins.rows[0]!.n) === 0) {
        throw new ValidationError(
          'This is the last active administrator. Give another user the Administrator profile first.'
        );
      }
    }

    await app.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE users
            SET name = COALESCE($2, name), email = COALESCE($3, email),
                is_active = COALESCE($4, is_active), updated_by = $5, updated_at = now()
          WHERE id = $1`,
        [id, data.name ?? null, data.email ?? null, data.isActive ?? null, request.auth!.user.id]
      );

      if (data.role) {
        await tx.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
        await tx.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2`, [
          id,
          data.role,
        ]);
      }
    });

    // A disabled account should not keep an open session.
    if (data.isActive === false) await revokeAllSessionsForUser(app.db, id);

    await recordActivity(app.db, {
      userId: request.auth!.user.id,
      userName: request.auth!.user.name,
      module: 'admin.users',
      action: 'UPDATE',
      recordType: 'User',
      recordId: id,
      recordLabel: before.rows[0]!.username,
      oldValues: before.rows[0],
      newValues: data,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    return { ok: true };
  });

  /** Administrator sets a password directly. Ends that user's sessions. */
  app.post('/api/users/:id/password', { preHandler: requirePermission('users.manage') }, async (request) => {
    const { id } = idParam.parse(request.params);
    const data = z.object({ password: z.string().min(1).max(200) }).parse(request.body);

    const target = await app.db.query<{ username: string; name: string }>(
      'SELECT username, name FROM users WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (!target.rows[0]) throw new NotFoundError('User not found');

    const strength = validatePasswordStrength(data.password, {
      name: target.rows[0].name,
      email: target.rows[0].username,
    });
    if (!strength.ok) {
      throw new ValidationError('That password is not strong enough', { problems: strength.problems });
    }

    const hash = await hashPassword(data.password);
    await app.db.query(
      'UPDATE users SET password_hash = $2, password_changed_at = now(), failed_attempts = 0, locked_until = NULL WHERE id = $1',
      [id, hash]
    );
    await revokeAllSessionsForUser(app.db, id);

    await recordActivity(app.db, {
      userId: request.auth!.user.id,
      userName: request.auth!.user.name,
      module: 'admin.users',
      action: 'PASSWORD_CHANGED',
      recordType: 'User',
      recordId: id,
      recordLabel: `${target.rows[0]!.username}: password set by administrator`,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    return { ok: true, username: target.rows[0]!.username };
  });

  /** Clears a lockout without waiting out the window. */
  app.post('/api/users/:id/unlock', { preHandler: requirePermission('users.manage') }, async (request) => {
    const { id } = idParam.parse(request.params);
    await app.db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [id]);

    await recordActivity(app.db, {
      userId: request.auth!.user.id,
      userName: request.auth!.user.name,
      module: 'admin.users',
      action: 'UPDATE',
      recordType: 'User',
      recordId: id,
      recordLabel: 'Lockout cleared by administrator',
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    return { ok: true };
  });
};
