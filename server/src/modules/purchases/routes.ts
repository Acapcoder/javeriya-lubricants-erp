/**
 * Intake routes — one endpoint for every kind of oil purchase.
 *
 * There is deliberately no /uco/purchases and /ueo/purchases pair, and no
 * separate driver-collection endpoint: they are the same document with
 * different field values, and splitting them would mean maintaining three
 * copies of the same posting logic.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../rbac/guard.ts';
import { recordActivity } from '../activity/log.ts';
import { createPurchase, listPurchases, purchaseSummary } from './purchase.service.ts';

const money = z.union([z.string(), z.number()]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

const createSchema = z.object({
  division: z.enum(['UCO', 'UEO']),
  purchaseDate: isoDate,
  source: z.enum(['DRIVER_COLLECTION', 'DIRECT_AGREEMENT', 'WALK_IN']),
  partyId: z.union([z.string(), z.number()]).optional().nullable(),
  agreementId: z.union([z.string(), z.number()]).optional().nullable(),
  driverId: z.union([z.string(), z.number()]).optional().nullable(),
  collectionArea: z.string().trim().max(120).optional().nullable(),
  vehicleNumber: z.string().trim().max(40).optional().nullable(),
  tankId: z.coerce.number().int().positive().optional().nullable(),
  drums: money,
  ratePerDrum: money,
  cashPaid: money.optional(),
  onlinePaid: money.optional(),
  advanceUsed: money.optional(),
  cashAccountId: z.coerce.number().int().positive().optional(),
  bankAccountId: z.coerce.number().int().positive().optional(),
  referenceNo: z.string().trim().max(60).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  weightFee: z
    .object({
      feePaid: z.boolean(),
      feeAmount: money.optional(),
      slipNumber: z.string().trim().max(60).optional().nullable(),
      attachmentId: z.coerce.number().int().positive().optional().nullable(),
      refundEligible: z.boolean().optional(),
      notes: z.string().trim().max(500).optional().nullable(),
    })
    .optional()
    .nullable(),
  postingKey: z.string().max(120).optional(),
});

const noPurchaseSchema = z.object({
  division: z.enum(['UCO', 'UEO']),
  purchaseDate: isoDate,
  notes: z.string().trim().max(500).optional().nullable(),
});

const listSchema = z.object({
  division: z.enum(['UCO', 'UEO']).optional(),
  source: z.enum(['DRIVER_COLLECTION', 'DIRECT_AGREEMENT', 'WALK_IN']).optional(),
  driverId: z.coerce.number().int().positive().optional(),
  partyId: z.coerce.number().int().positive().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const purchaseRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('preHandler', requireAuth);

  app.get('/api/purchases', { preHandler: requirePermission('operations.view') }, async (request) => {
    const q = listSchema.parse(request.query ?? {});
    const [rows, summary] = await Promise.all([listPurchases(app.db, q), purchaseSummary(app.db, q)]);
    return { purchases: rows, summary };
  });

  app.post('/api/purchases', { preHandler: requirePermission('operations.create') }, async (request, reply) => {
    const data = createSchema.parse(request.body);

    const result = await createPurchase(app.db, { ...data, createdBy: request.auth!.user.id });

    await recordActivity(app.db, {
      userId: request.auth!.user.id,
      userName: request.auth!.user.name,
      module: 'purchases',
      action: 'CREATE',
      recordType: 'Purchase',
      recordId: result.id,
      recordLabel: `${result.docNo} — ${data.drums} drums ${data.division}`,
      newValues: data,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    return reply.status(201).send(result);
  });

  /** BR-22 — record a day with no intake so the daily record has no silent gaps. */
  app.post('/api/purchases/no-activity', { preHandler: requirePermission('operations.create') }, async (request, reply) => {
    const data = noPurchaseSchema.parse(request.body);
    const result = await createPurchase(app.db, {
      ...data,
      source: 'WALK_IN',
      drums: 0,
      ratePerDrum: 0,
      isNoPurchase: true,
      createdBy: request.auth!.user.id,
    });

    await recordActivity(app.db, {
      userId: request.auth!.user.id,
      userName: request.auth!.user.name,
      module: 'purchases',
      action: 'CREATE',
      recordType: 'Purchase',
      recordId: result.id,
      recordLabel: `${result.docNo} — no ${data.division} purchases on ${data.purchaseDate}`,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    return reply.status(201).send(result);
  });
};
