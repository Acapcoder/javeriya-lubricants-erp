/** Stock balances, the movement ledger, and storage tanks. */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../rbac/guard.ts';
import { recordActivity } from '../activity/log.ts';
import { listBalances } from './stock.service.ts';
import {
  createTank, getTank, listTanks, recordReading, tankMovements, tankReadings, updateTank,
} from './tank.service.ts';

const qty = z.union([z.string(), z.number()]);
const idParam = z.object({ id: z.coerce.number().int().positive() });

const tankSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(80),
  itemId: z.coerce.number().int().positive(),
  capacity: qty,
  deadStock: qty.optional(),
  location: z.string().trim().max(120).optional().nullable(),
  status: z.enum(['ACTIVE', 'MAINTENANCE', 'RETIRED']).optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const inventoryRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('preHandler', requireAuth);

  app.get('/api/inventory', { preHandler: requirePermission('operations.view') }, async () => {
    const [items, tanks] = await Promise.all([listBalances(app.db), listTanks(app.db)]);
    return { items, tanks };
  });

  app.get('/api/inventory/:itemId/movements', { preHandler: requirePermission('operations.view') }, async (request) => {
    const { itemId } = z.object({ itemId: z.coerce.number().int().positive() }).parse(request.params);
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query ?? {});

    const res = await app.db.query(
      `SELECT sm.id, sm.moved_on AS "movedOn", sm.direction, sm.quantity,
              sm.unit_cost AS "unitCost", sm.value, sm.balance_after AS "balanceAfter",
              sm.source_type AS "sourceType", sm.source_id AS "sourceId", sm.notes,
              t.name AS "tankName", u.name AS "createdByName"
         FROM stock_movements sm
         JOIN users u ON u.id = sm.created_by
         LEFT JOIN tanks t ON t.id = sm.tank_id
        WHERE sm.item_id = $1
        ORDER BY sm.moved_on DESC, sm.id DESC
        LIMIT $2 OFFSET $3`,
      [itemId, q.limit, q.offset]
    );
    return { movements: res.rows };
  });

  /* ------------------------------------------------------------- tanks */

  app.get('/api/tanks', { preHandler: requirePermission('operations.view') }, async (request) => {
    const q = z.object({ itemId: z.coerce.number().int().positive().optional() }).parse(request.query ?? {});
    return { tanks: await listTanks(app.db, q.itemId) };
  });

  app.get('/api/tanks/:id', { preHandler: requirePermission('operations.view') }, async (request) => {
    const { id } = idParam.parse(request.params);
    const [tank, movements, readings] = await Promise.all([
      getTank(app.db, id),
      tankMovements(app.db, id),
      tankReadings(app.db, id),
    ]);
    return { tank, movements, readings };
  });

  app.post('/api/tanks', { preHandler: requirePermission('masters.manage') }, async (request, reply) => {
    const data = tankSchema.parse(request.body);
    const tank = await createTank(app.db, data, request.auth!.user.id);

    await recordActivity(app.db, {
      userId: request.auth!.user.id, userName: request.auth!.user.name,
      module: 'inventory.tanks', action: 'CREATE', recordType: 'Tank',
      recordId: tank.id, recordLabel: `${tank.code} ${tank.name}`, newValues: data,
      ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
    });

    return reply.status(201).send(tank);
  });

  app.put('/api/tanks/:id', { preHandler: requirePermission('masters.manage') }, async (request) => {
    const { id } = idParam.parse(request.params);
    const data = tankSchema.partial().parse(request.body);

    const before = await getTank(app.db, id);
    const tank = await updateTank(app.db, id, data, request.auth!.user.id);

    await recordActivity(app.db, {
      userId: request.auth!.user.id, userName: request.auth!.user.name,
      module: 'inventory.tanks', action: 'UPDATE', recordType: 'Tank',
      recordId: id, recordLabel: `${before.code} ${before.name}`,
      oldValues: before, newValues: data,
      ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
    });

    return tank;
  });

  /** A physical dip reading, recorded against the book figure. */
  app.post('/api/tanks/:id/readings', { preHandler: requirePermission('operations.create') }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const data = z
      .object({
        readOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        measured: qty,
        notes: z.string().trim().max(500).optional().nullable(),
      })
      .parse(request.body);

    const result = await recordReading(app.db, { tankId: id, ...data, userId: request.auth!.user.id });

    await recordActivity(app.db, {
      userId: request.auth!.user.id, userName: request.auth!.user.name,
      module: 'inventory.tanks', action: 'CREATE', recordType: 'TankReading',
      recordId: result.id,
      recordLabel: `${result.tank}: measured ${result.measured}, books say ${result.book}`,
      newValues: result,
      ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
    });

    return reply.status(201).send(result);
  });
};
