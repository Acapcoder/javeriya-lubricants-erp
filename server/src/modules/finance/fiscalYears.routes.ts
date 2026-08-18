/**
 * Financial year management (feature B2).
 *
 * Locking is the Administrator's alone (`year.lock`). Unlocking a closed year
 * is exceptional and always logged — an auditor needs to see that it happened.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../rbac/guard.ts';
import { recordActivity } from '../activity/log.ts';
import { ConflictError } from '../../lib/errors.ts';
import { createFiscalYear, listFiscalYears, setFiscalYearLock } from './fiscalYear.service.ts';

const createSchema = z.object({
  label: z.string().trim().min(1).max(20),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
});

const idSchema = z.object({ id: z.coerce.number().int().positive() });

export const fiscalYearRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('preHandler', requireAuth);

  app.get('/api/finance/fiscal-years', { preHandler: requirePermission('finance.view') }, async () => {
    return { fiscalYears: await listFiscalYears(app.db) };
  });

  app.post('/api/finance/fiscal-years', { preHandler: requirePermission('finance.manage') }, async (request, reply) => {
    const data = createSchema.parse(request.body);

    let year;
    try {
      year = await createFiscalYear(app.db, data);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError(`A financial year labelled "${data.label}" already exists`);
      }
      throw err;
    }

    await recordActivity(app.db, {
      userId: request.auth!.user.id,
      userName: request.auth!.user.name,
      module: 'finance.fiscal_years',
      action: 'CREATE',
      recordType: 'FiscalYear',
      recordId: year.id,
      recordLabel: year.label,
      newValues: year,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    return reply.status(201).send(year);
  });

  app.post('/api/finance/fiscal-years/:id/lock', { preHandler: requirePermission('year.lock') }, async (request) => {
    const { id } = idSchema.parse(request.params);
    const year = await setFiscalYearLock(app.db, { id, locked: true, userId: request.auth!.user.id });

    await recordActivity(app.db, {
      userId: request.auth!.user.id,
      userName: request.auth!.user.name,
      module: 'finance.fiscal_years',
      action: 'LOCK',
      recordType: 'FiscalYear',
      recordId: year.id,
      recordLabel: `${year.label} closed — no further postings accepted`,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    return year;
  });

  app.post('/api/finance/fiscal-years/:id/unlock', { preHandler: requirePermission('year.lock') }, async (request) => {
    const { id } = idSchema.parse(request.params);
    const year = await setFiscalYearLock(app.db, { id, locked: false, userId: request.auth!.user.id });

    // Deliberately loud: reopening a closed year is the kind of thing an audit
    // asks about, so it is recorded as its own action rather than an UPDATE.
    await recordActivity(app.db, {
      userId: request.auth!.user.id,
      userName: request.auth!.user.name,
      module: 'finance.fiscal_years',
      action: 'UNLOCK',
      recordType: 'FiscalYear',
      recordId: year.id,
      recordLabel: `${year.label} REOPENED by administrator`,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    return year;
  });
};
