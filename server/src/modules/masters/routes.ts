/**
 * Master data the intake screen needs: suppliers, drivers, agreements.
 *
 * Drivers carry the distinction that matters operationally:
 *   IN_HOUSE    our driver, our truck, works against an advance we issue
 *   OUTSOURCED  independent, brings oil, is paid for the delivery
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../rbac/guard.ts';
import { recordActivity } from '../activity/log.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.ts';
import { toDecimal, toMinor } from '../../lib/money.ts';
import { postJournalEntry } from '../finance/posting.service.ts';
import { requireOpenFiscalYear } from '../finance/fiscalYear.service.ts';
import { nextDocumentNumber } from '../finance/sequence.service.ts';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

async function nextCode(db: import('../../db/client.ts').Db, table: string, prefix: string): Promise<string> {
  const res = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
  return `${prefix}-${String(Number(res.rows[0]!.n) + 1).padStart(4, '0')}`;
}

/* -------------------------------------------------------------- parties */

const partySchema = z.object({
  type: z.enum(['SUPPLIER', 'CUSTOMER', 'INDUSTRIAL_COMPANY']),
  name: z.string().trim().min(1).max(160),
  company: z.string().trim().max(160).optional().nullable(),
  contactPerson: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().max(190).optional().nullable(),
  address: z.string().trim().max(500).optional().nullable(),
  division: z.enum(['UCO', 'UEO', 'WTD']).optional().nullable(),
  creditTermsDays: z.coerce.number().int().min(0).max(365).default(0),
  notes: z.string().trim().max(1000).optional().nullable(),
});

/* -------------------------------------------------------------- drivers */

const driverSchema = z.object({
  name: z.string().trim().min(1).max(120),
  driverType: z.enum(['IN_HOUSE', 'OUTSOURCED']),
  phone: z.string().trim().max(40).optional().nullable(),
  vehicleNumber: z.string().trim().max(40).optional().nullable(),
  licenseNumber: z.string().trim().max(60).optional().nullable(),
  salary: z.union([z.string(), z.number()]).optional().nullable(),
  joiningDate: isoDate.optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

const advanceSchema = z.object({
  driverId: z.coerce.number().int().positive(),
  issuedOn: isoDate,
  amount: z.union([z.string(), z.number()]),
  accountId: z.coerce.number().int().positive().optional(),
  methodLabel: z.string().trim().max(40).default('Cash'),
  notes: z.string().trim().max(500).optional().nullable(),
});

export const masterRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('preHandler', requireAuth);

  /* ------------------------------------------------------------ parties */

  app.get('/api/parties', { preHandler: requirePermission('operations.view') }, async (request) => {
    const q = z
      .object({
        type: z.enum(['SUPPLIER', 'CUSTOMER', 'INDUSTRIAL_COMPANY']).optional(),
        search: z.string().trim().max(80).optional(),
      })
      .parse(request.query ?? {});

    const res = await app.db.query(
      `SELECT p.id, p.code, p.type, p.name, p.company, p.contact_person AS "contactPerson",
              p.phone, p.address, p.division, p.credit_terms_days AS "creditTermsDays", p.is_active AS "isActive",
              COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) AS "outstandingPayable"
         FROM parties p
         LEFT JOIN journal_lines jl ON jl.party_id = p.id
        WHERE p.deleted_at IS NULL
          AND ($1::party_type_t IS NULL OR p.type = $1)
          AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%' OR p.code ILIKE '%' || $2 || '%')
        GROUP BY p.id
        ORDER BY p.name`,
      [q.type ?? null, q.search ?? null]
    );
    return { parties: res.rows };
  });

  app.post('/api/parties', { preHandler: requirePermission('masters.manage') }, async (request, reply) => {
    const data = partySchema.parse(request.body);
    const prefix = data.type === 'SUPPLIER' ? 'SUP' : data.type === 'CUSTOMER' ? 'CUS' : 'IND';
    const code = await nextCode(app.db, 'parties', prefix);

    try {
      const res = await app.db.query<{ id: string }>(
        `INSERT INTO parties (code, type, name, company, contact_person, phone, email, address,
                              division, credit_terms_days, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
        [
          code, data.type, data.name, data.company ?? null, data.contactPerson ?? null,
          data.phone ?? null, data.email ?? null, data.address ?? null,
          data.division ?? null, data.creditTermsDays, data.notes ?? null, request.auth!.user.id,
        ]
      );
      const id = res.rows[0]!.id;

      await recordActivity(app.db, {
        userId: request.auth!.user.id, userName: request.auth!.user.name,
        module: 'masters.parties', action: 'CREATE', recordType: 'Party',
        recordId: id, recordLabel: `${code} ${data.name}`, newValues: data,
        ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.status(201).send({ id, code, ...data });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ConflictError('That party already exists');
      throw err;
    }
  });

  /* ------------------------------------------------------------ drivers */

  app.get('/api/drivers', { preHandler: requirePermission('operations.view') }, async (request) => {
    const q = z
      .object({ driverType: z.enum(['IN_HOUSE', 'OUTSOURCED']).optional(), activeOnly: z.coerce.boolean().default(true) })
      .parse(request.query ?? {});

    const res = await app.db.query(
      `SELECT d.id, d.code, d.name, d.driver_type AS "driverType", d.phone,
              d.vehicle_number AS "vehicleNumber", d.license_number AS "licenseNumber",
              d.salary, d.joining_date AS "joiningDate", d.status,
              d.advance_balance AS "advanceBalance",
              EXISTS (
                SELECT 1 FROM driver_vacations v
                 WHERE v.driver_id = d.id AND current_date BETWEEN v.starts_on AND v.ends_on
              ) AS "onVacation"
         FROM drivers d
        WHERE d.deleted_at IS NULL
          AND ($1::driver_type_t IS NULL OR d.driver_type = $1)
          AND ($2::boolean = false OR d.status = 'ACTIVE')
        ORDER BY d.driver_type, d.name`,
      [q.driverType ?? null, q.activeOnly]
    );
    return { drivers: res.rows };
  });

  app.post('/api/drivers', { preHandler: requirePermission('masters.manage') }, async (request, reply) => {
    const data = driverSchema.parse(request.body);
    const code = await nextCode(app.db, 'drivers', data.driverType === 'IN_HOUSE' ? 'DRV' : 'ODR');

    const res = await app.db.query<{ id: string }>(
      `INSERT INTO drivers (code, name, driver_type, phone, vehicle_number, license_number,
                            salary, joining_date, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
      [
        code, data.name, data.driverType, data.phone ?? null, data.vehicleNumber ?? null,
        data.licenseNumber ?? null, data.salary ?? null, data.joiningDate ?? null,
        data.notes ?? null, request.auth!.user.id,
      ]
    );
    const id = res.rows[0]!.id;

    await recordActivity(app.db, {
      userId: request.auth!.user.id, userName: request.auth!.user.name,
      module: 'masters.drivers', action: 'CREATE', recordType: 'Driver',
      recordId: id, recordLabel: `${code} ${data.name} (${data.driverType})`, newValues: data,
      ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
    });

    return reply.status(201).send({ id, code, ...data });
  });

  /**
   * Issue an advance to an in-house driver.
   *
   * This is NOT an expense. The money is an asset we hold against the driver
   * until they deliver oil, at which point the purchase draws it down.
   */
  app.post('/api/drivers/advances', { preHandler: requirePermission('finance.manage') }, async (request, reply) => {
    const data = advanceSchema.parse(request.body);
    const amount = toMinor(data.amount);
    if (amount <= 0n) throw new ValidationError('Advance amount must be greater than zero');

    const drv = await app.db.query<{ name: string; driver_type: string }>(
      'SELECT name, driver_type FROM drivers WHERE id = $1 AND deleted_at IS NULL',
      [data.driverId]
    );
    const driver = drv.rows[0];
    if (!driver) throw new ValidationError('Driver not found');
    if (driver.driver_type !== 'IN_HOUSE') {
      throw new ValidationError(
        `${driver.name} is an outsourced driver. They are paid per delivery and are never issued an advance.`
      );
    }

    const result = await app.db.transaction(async (tx) => {
      const fiscalYearId = await requireOpenFiscalYear(tx, data.issuedOn);
      const year = Number(data.issuedOn.slice(0, 4));
      const docNo = await nextDocumentNumber(tx, 'ADV', year);

      const cashAccount =
        data.accountId ??
        Number((await tx.query<{ id: number }>(`SELECT id FROM accounts WHERE code = '1010'`)).rows[0]!.id);
      const advAccount = Number(
        (await tx.query<{ id: number }>(`SELECT id FROM accounts WHERE code = '1250'`)).rows[0]!.id
      );

      const ins = await tx.query<{ id: string }>(
        `INSERT INTO driver_advances (doc_no, driver_id, issued_on, amount, account_id, method_label,
                                      notes, fiscal_year_id, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
        [
          docNo, data.driverId, data.issuedOn, toDecimal(amount), cashAccount,
          data.methodLabel, data.notes ?? null, fiscalYearId, request.auth!.user.id,
        ]
      );
      const id = ins.rows[0]!.id;

      await postJournalEntry(tx, {
        entryDate: data.issuedOn,
        narration: `${docNo} — advance issued to ${driver.name}`,
        sourceType: 'DriverAdvance',
        sourceId: id,
        postingKey: `DriverAdvance:${id}`,
        postedBy: request.auth!.user.id,
        lines: [
          { accountId: advAccount, debit: toDecimal(amount), memo: driver.name },
          { accountId: cashAccount, credit: toDecimal(amount) },
        ],
      });

      await tx.query('UPDATE drivers SET advance_balance = advance_balance + $2 WHERE id = $1', [
        data.driverId,
        toDecimal(amount),
      ]);

      return { id, docNo, amount: toDecimal(amount) };
    });

    await recordActivity(app.db, {
      userId: request.auth!.user.id, userName: request.auth!.user.name,
      module: 'masters.drivers', action: 'CREATE', recordType: 'DriverAdvance',
      recordId: result.id, recordLabel: `${result.docNo} — ${result.amount} to ${driver.name}`,
      ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
    });

    return reply.status(201).send(result);
  });

  /**
   * Everything about one driver on a single screen: who they are, what they
   * hold, what they have brought in, and every advance they were given.
   */
  app.get('/api/drivers/:id', { preHandler: requirePermission('operations.view') }, async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);

    const d = await app.db.query(
      `SELECT d.id, d.code, d.name, d.driver_type AS "driverType", d.phone,
              d.vehicle_number AS "vehicleNumber", d.license_number AS "licenseNumber",
              d.salary, d.joining_date AS "joiningDate", d.status, d.notes,
              d.advance_balance AS "advanceBalance", d.created_at AS "createdAt"
         FROM drivers d WHERE d.id = $1 AND d.deleted_at IS NULL`,
      [id]
    );
    const driver = d.rows[0];
    if (!driver) throw new NotFoundError('Driver not found');

    const [collections, advances, vacations, totals] = await Promise.all([
      app.db.query(
        `SELECT p.id, p.doc_no AS "docNo", p.purchase_date AS "date", p.division,
                p.drums, p.rate_per_drum AS "rate", p.total_amount AS "total",
                p.advance_used AS "advanceUsed", p.balance_due AS "balanceDue",
                p.payment_status AS "paymentStatus", p.collection_area AS "area"
           FROM purchases p
          WHERE p.driver_id = $1 AND p.deleted_at IS NULL AND p.is_no_purchase = false
          ORDER BY p.purchase_date DESC, p.id DESC LIMIT 50`,
        [id]
      ),
      app.db.query(
        `SELECT a.id, a.doc_no AS "docNo", a.issued_on AS "issuedOn", a.amount,
                a.method_label AS "method", a.notes
           FROM driver_advances a
          WHERE a.driver_id = $1 AND a.deleted_at IS NULL
          ORDER BY a.issued_on DESC, a.id DESC LIMIT 50`,
        [id]
      ),
      app.db.query(
        `SELECT id, starts_on AS "startsOn", ends_on AS "endsOn", reason,
                (current_date BETWEEN starts_on AND ends_on) AS "current"
           FROM driver_vacations WHERE driver_id = $1 ORDER BY starts_on DESC LIMIT 20`,
        [id]
      ),
      app.db.query<{ loads: string; drums: string; value: string; issued: string; settled: string }>(
        `SELECT
           (SELECT count(*) FROM purchases WHERE driver_id = $1 AND deleted_at IS NULL AND is_no_purchase = false) AS loads,
           (SELECT COALESCE(SUM(drums),0) FROM purchases WHERE driver_id = $1 AND deleted_at IS NULL) AS drums,
           (SELECT COALESCE(SUM(total_amount),0) FROM purchases WHERE driver_id = $1 AND deleted_at IS NULL) AS value,
           (SELECT COALESCE(SUM(amount),0) FROM driver_advances WHERE driver_id = $1 AND deleted_at IS NULL) AS issued,
           (SELECT COALESCE(SUM(advance_used),0) FROM purchases WHERE driver_id = $1 AND deleted_at IS NULL) AS settled`,
        [id]
      ),
    ]);

    return {
      driver,
      totals: totals.rows[0],
      collections: collections.rows,
      advances: advances.rows,
      vacations: vacations.rows,
    };
  });

  app.put('/api/drivers/:id', { preHandler: requirePermission('masters.manage') }, async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const data = driverSchema.partial().extend({ status: z.enum(['ACTIVE', 'ON_LEAVE', 'INACTIVE']).optional() }).parse(request.body);

    const before = await app.db.query('SELECT * FROM drivers WHERE id = $1', [id]);
    if (!before.rows[0]) throw new NotFoundError('Driver not found');

    const res = await app.db.query(
      `UPDATE drivers
          SET name = COALESCE($2, name), phone = COALESCE($3, phone),
              vehicle_number = COALESCE($4, vehicle_number),
              license_number = COALESCE($5, license_number),
              salary = COALESCE($6, salary), status = COALESCE($7, status),
              notes = COALESCE($8, notes), updated_by = $9, updated_at = now()
        WHERE id = $1
        RETURNING id, code, name, driver_type AS "driverType", status`,
      [
        id, data.name ?? null, data.phone ?? null, data.vehicleNumber ?? null,
        data.licenseNumber ?? null, data.salary ?? null, data.status ?? null,
        data.notes ?? null, request.auth!.user.id,
      ]
    );

    await recordActivity(app.db, {
      userId: request.auth!.user.id, userName: request.auth!.user.name,
      module: 'masters.drivers', action: 'UPDATE', recordType: 'Driver',
      recordId: id, recordLabel: String(before.rows[0]!.name),
      oldValues: before.rows[0], newValues: data,
      ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
    });

    return res.rows[0];
  });

  /** Time off, so a driver on leave is flagged when someone picks them. */
  app.post('/api/drivers/:id/vacations', { preHandler: requirePermission('masters.manage') }, async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const data = z
      .object({ startsOn: isoDate, endsOn: isoDate, reason: z.string().trim().max(500).optional().nullable() })
      .parse(request.body);

    if (data.endsOn < data.startsOn) throw new ValidationError('Leave cannot end before it starts');

    const res = await app.db.query<{ id: string }>(
      `INSERT INTO driver_vacations (driver_id, starts_on, ends_on, reason, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [id, data.startsOn, data.endsOn, data.reason ?? null, request.auth!.user.id]
    );
    return reply.status(201).send({ id: res.rows[0]!.id, ...data });
  });

  /* --------------------------------------------------------- agreements */

  app.get('/api/agreements', { preHandler: requirePermission('operations.view') }, async (request) => {
    const q = z.object({ division: z.enum(['UCO', 'UEO', 'WTD']).optional() }).parse(request.query ?? {});
    const res = await app.db.query(
      `SELECT a.id, a.agreement_no AS "agreementNo", a.agreement_date AS "agreementDate",
              a.expires_on AS "expiresOn", a.division, a.rate_per_drum AS "ratePerDrum",
              a.payment_terms AS "paymentTerms", a.is_active AS "isActive",
              p.id AS "partyId", p.name AS "partyName"
         FROM agreements a JOIN parties p ON p.id = a.party_id
        WHERE a.deleted_at IS NULL AND a.is_active
          AND ($1::division_t IS NULL OR a.division = $1)
        ORDER BY p.name`,
      [q.division ?? null]
    );
    return { agreements: res.rows };
  });

  app.post('/api/agreements', { preHandler: requirePermission('masters.manage') }, async (request, reply) => {
    const data = z
      .object({
        partyId: z.coerce.number().int().positive(),
        agreementNo: z.string().trim().min(1).max(50),
        agreementDate: isoDate,
        expiresOn: isoDate.optional().nullable(),
        division: z.enum(['UCO', 'UEO', 'WTD']),
        ratePerDrum: z.union([z.string(), z.number()]).optional().nullable(),
        paymentTerms: z.string().trim().max(120).optional().nullable(),
        notes: z.string().trim().max(1000).optional().nullable(),
      })
      .parse(request.body);

    try {
      const res = await app.db.query<{ id: string }>(
        `INSERT INTO agreements (party_id, agreement_no, agreement_date, expires_on, division,
                                 rate_per_drum, payment_terms, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
        [
          data.partyId, data.agreementNo, data.agreementDate, data.expiresOn ?? null, data.division,
          data.ratePerDrum ?? null, data.paymentTerms ?? null, data.notes ?? null, request.auth!.user.id,
        ]
      );
      return reply.status(201).send({ id: res.rows[0]!.id, ...data });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError(`Agreement number ${data.agreementNo} already exists`);
      }
      throw err;
    }
  });
};
