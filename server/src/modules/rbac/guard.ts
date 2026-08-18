/**
 * Route guards (A4).
 *
 * Three layers, matching §10:
 *   requireAuth        — a live session that has cleared 2FA
 *   requirePermission  — a specific permission from the §6.1 matrix
 *   requireRole        — rarely needed; prefer permissions
 *
 * The system has exactly three profiles: Administrator, Accountant, Auditor.
 * The Accountant enters everything the Administrator can; the Administrator
 * alone may delete (operations.delete, activity_log.delete) and administer.
 *
 * Field-level filtering lives in the report DTOs rather than here, because a
 * user without the permission must never receive the numbers — not merely fail
 * to see them rendered.
 *
 * All guards are `async` deliberately. A Fastify hook taking (request, reply)
 * must return a promise; a synchronous one leaves the request hanging while
 * Fastify waits for a `done` callback that never arrives.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.ts';
import type { PermissionCode, RoleCode } from './matrix.ts';

export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const auth = request.auth;
  if (!auth) throw new UnauthorizedError();
  if (auth.twoFactorEnrollmentRequired) {
    throw new UnauthorizedError(
      'Two-factor authentication must be set up before you can continue',
      'TWO_FACTOR_ENROLLMENT_REQUIRED'
    );
  }
  if (!auth.twoFactorOk) {
    throw new UnauthorizedError('Two-factor verification required', 'TWO_FACTOR_REQUIRED');
  }
}

export function requirePermission(...permissions: PermissionCode[]) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuth(request, reply);
    const held = new Set(request.auth!.user.permissions);
    const missing = permissions.filter((p) => !held.has(p));
    if (missing.length > 0) {
      throw new ForbiddenError(`Missing permission: ${missing.join(', ')}`, { required: permissions, missing });
    }
  };
}

export function requireAnyPermission(...permissions: PermissionCode[]) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuth(request, reply);
    const held = new Set(request.auth!.user.permissions);
    if (!permissions.some((p) => held.has(p))) {
      throw new ForbiddenError(`Requires one of: ${permissions.join(', ')}`, { anyOf: permissions });
    }
  };
}

export function requireRole(...roles: RoleCode[]) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuth(request, reply);
    const held = new Set(request.auth!.user.roles);
    if (!roles.some((r) => held.has(r))) {
      throw new ForbiddenError(`Requires role: ${roles.join(' or ')}`, { anyOf: roles });
    }
  };
}

export function can(request: FastifyRequest, permission: PermissionCode): boolean {
  return request.auth?.user.permissions.includes(permission) ?? false;
}
