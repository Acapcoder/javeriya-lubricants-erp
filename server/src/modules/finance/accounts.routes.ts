/**
 * Chart of accounts (feature B1).
 *
 * Multiple cash and bank accounts are supported by design — every money
 * movement names an account_id rather than a free-text "CASH" string, so
 * adding a second bank is configuration, not a migration.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.ts';
import { requireAuth, requirePermission } from '../rbac/guard.ts';
import { recordActivity } from '../activity/log.ts';

const createSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']),
  subtype: z.string().trim().max(40).optional().nullable(),
  bankName: z.string().trim().max(120).optional().nullable(),
  accountNumber: z.string().trim().max(60).optional().nullable(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  bankName: z.string().trim().max(120).optional().nullable(),
  accountNumber: z.string().trim().max(60).optional().nullable(),
  isActive: z.boolean().optional(),
});

const idSchema = z.object({ id: z.coerce.number().int().positive() });

export const accountsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('preHandler', requireAuth);

  app.get('/api/finance/accounts', { preHandler: requirePermission('finance.view') }, async () => {
    const res = await app.db.query(
      `SELECT id, code, name, type, subtype,
              is_control AS "isControl", is_postable AS "isPostable", is_active AS "isActive",
              bank_name AS "bankName", account_number AS "accountNumber"
         FROM accounts ORDER BY code`
    );
    return { accounts: res.rows };
  });

  app.post('/api/finance/accounts', { preHandler: requirePermission('finance.manage') }, async (request, reply) => {
    const data = createSchema.parse(request.body);

    // is_control is deliberately NOT settable through the API. Flipping it
    // decides whether manual journals may touch the account (BR-27); that is a
    // schema-level decision, not a screen-level one.
    try {
      const res = await app.db.query<{ id: number }>(
        `INSERT INTO accounts (code, name, type, subtype, bank_name, account_number)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [data.code, data.name, data.type, data.subtype ?? null, data.bankName ?? null, data.accountNumber ?? null]
      );
      const id = Number(res.rows[0]!.id);

      await recordActivity(app.db, {
        userId: request.auth!.user.id,
        userName: request.auth!.user.name,
        module: 'finance.accounts',
        action: 'CREATE',
        recordType: 'Account',
        recordId: id,
        recordLabel: `${data.code} ${data.name}`,
        newValues: data,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.status(201).send({ id, ...data });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError(`Account code ${data.code} is already in use`);
      }
      throw err;
    }
  });

  app.put('/api/finance/accounts/:id', { preHandler: requirePermission('finance.manage') }, async (request) => {
    const { id } = idSchema.parse(request.params);
    const data = updateSchema.parse(request.body);

    const before = await app.db.query<Record<string, unknown>>(
      'SELECT id, code, name, type, is_control, is_active FROM accounts WHERE id = $1',
      [id]
    );
    if (!before.rows[0]) throw new NotFoundError('Account not found');

    // A control account that still carries a balance must not be deactivated —
    // its subsidiary ledger would have nowhere to tie back to.
    if (data.isActive === false) {
      const bal = await app.db.query<{ n: string }>(
        'SELECT count(*) AS n FROM journal_lines WHERE account_id = $1',
        [id]
      );
      if (Number(bal.rows[0]!.n) > 0) {
        throw new ValidationError(
          'This account has postings against it and cannot be deactivated. Accounts are kept for historical reporting (BR-19).'
        );
      }
    }

    const res = await app.db.query(
      `UPDATE accounts
          SET name = COALESCE($2, name),
              bank_name = COALESCE($3, bank_name),
              account_number = COALESCE($4, account_number),
              is_active = COALESCE($5, is_active)
        WHERE id = $1
        RETURNING id, code, name, type, subtype, is_control AS "isControl", is_active AS "isActive"`,
      [id, data.name ?? null, data.bankName ?? null, data.accountNumber ?? null, data.isActive ?? null]
    );

    await recordActivity(app.db, {
      userId: request.auth!.user.id,
      userName: request.auth!.user.name,
      module: 'finance.accounts',
      action: 'UPDATE',
      recordType: 'Account',
      recordId: id,
      recordLabel: String(before.rows[0]!.code),
      oldValues: before.rows[0],
      newValues: data,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    return res.rows[0];
  });
};
