/**
 * What money goes out on: expenses, salaries, and owner's drawings.
 *
 * Three screens rather than one, because they are three different things in the
 * books and confusing them is the classic small-business accounting error:
 *
 *   Expense   a cost of running the business. Reduces profit.
 *   Salary    a cost too, but owed monthly and often paid in parts, so it
 *             carries an advance and a remaining balance.
 *   Drawing   the owner taking money out. NOT a cost. It reduces the owner's
 *             stake, and including it in expenses understates profit, which
 *             then distorts every margin the owner prices against (BR-12).
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../rbac/guard.ts';
import { recordActivity } from '../activity/log.ts';
import { NotFoundError, ValidationError } from '../../lib/errors.ts';
import { toDecimal, toMinor } from '../../lib/money.ts';
import { postJournalEntry } from './posting.service.ts';
import { requireOpenFiscalYear } from './fiscalYear.service.ts';
import { nextDocumentNumber } from './sequence.service.ts';

const money = z.union([z.string(), z.number()]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

async function accountByCode(db: import('../../db/client.ts').Db, code: string): Promise<number> {
  const r = await db.query<{ id: number }>('SELECT id FROM accounts WHERE code = $1', [code]);
  if (!r.rows[0]) throw new ValidationError(`Chart of accounts is missing account ${code}`);
  return Number(r.rows[0].id);
}

export const spendingRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('preHandler', requireAuth);

  /* ==================================================================== */
  /* Expense categories                                                    */
  /* ==================================================================== */

  app.get('/api/finance/expense-categories', { preHandler: requirePermission('finance.view') }, async () => {
    const r = await app.db.query(
      `SELECT c.id, c.name, c.is_active AS "isActive", a.code AS "accountCode"
         FROM expense_categories c JOIN accounts a ON a.id = c.account_id
        WHERE c.is_active ORDER BY c.name`
    );
    return { categories: r.rows };
  });

  /* ==================================================================== */
  /* Expenses                                                              */
  /* ==================================================================== */

  app.get('/api/finance/expenses', { preHandler: requirePermission('finance.view') }, async (request) => {
    const q = z
      .object({
        from: isoDate.optional(),
        to: isoDate.optional(),
        categoryId: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      })
      .parse(request.query ?? {});

    const rows = await app.db.query(
      `SELECT e.id, e.doc_no AS "docNo", e.expense_date AS "date", e.description,
              e.amount, e.method_label AS "method", e.notes,
              c.name AS "category", a.name AS "paidFrom"
         FROM expenses e
         JOIN expense_categories c ON c.id = e.category_id
         JOIN accounts a ON a.id = e.account_id
        WHERE e.deleted_at IS NULL
          AND ($1::date IS NULL OR e.expense_date >= $1)
          AND ($2::date IS NULL OR e.expense_date <= $2)
          AND ($3::smallint IS NULL OR e.category_id = $3)
        ORDER BY e.expense_date DESC, e.id DESC LIMIT $4`,
      [q.from ?? null, q.to ?? null, q.categoryId ?? null, q.limit]
    );

    const summary = await app.db.query<{ category: string; total: string; count: string }>(
      `SELECT c.name AS category, COALESCE(SUM(e.amount),0) AS total, count(*) AS count
         FROM expenses e JOIN expense_categories c ON c.id = e.category_id
        WHERE e.deleted_at IS NULL
          AND ($1::date IS NULL OR e.expense_date >= $1)
          AND ($2::date IS NULL OR e.expense_date <= $2)
        GROUP BY c.name ORDER BY 2 DESC`,
      [q.from ?? null, q.to ?? null]
    );

    let total = 0n;
    for (const s of summary.rows) total += toMinor(s.total);

    return { expenses: rows.rows, byCategory: summary.rows, total: toDecimal(total) };
  });

  app.post('/api/finance/expenses', { preHandler: requirePermission('finance.manage') }, async (request, reply) => {
    const data = z
      .object({
        expenseDate: isoDate,
        categoryId: z.coerce.number().int().positive(),
        description: z.string().trim().min(1).max(500),
        amount: money,
        accountId: z.coerce.number().int().positive(),
        methodLabel: z.string().trim().max(40).default('Cash'),
        notes: z.string().trim().max(1000).optional().nullable(),
      })
      .parse(request.body);

    const amount = toMinor(data.amount);
    if (amount <= 0n) throw new ValidationError('An expense must be more than zero');

    const cat = await app.db.query<{ account_id: number; name: string }>(
      'SELECT account_id, name FROM expense_categories WHERE id = $1 AND is_active',
      [data.categoryId]
    );
    if (!cat.rows[0]) throw new ValidationError('Choose a cost category');

    const result = await app.db.transaction(async (tx) => {
      const fiscalYearId = await requireOpenFiscalYear(tx, data.expenseDate);
      const docNo = await nextDocumentNumber(tx, 'EXP', Number(data.expenseDate.slice(0, 4)));

      const ins = await tx.query<{ id: string }>(
        `INSERT INTO expenses (doc_no, expense_date, category_id, description, amount,
                               account_id, method_label, notes, fiscal_year_id, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
        [
          docNo, data.expenseDate, data.categoryId, data.description, toDecimal(amount),
          data.accountId, data.methodLabel, data.notes ?? null, fiscalYearId, request.auth!.user.id,
        ]
      );
      const id = ins.rows[0]!.id;

      await postJournalEntry(tx, {
        entryDate: data.expenseDate,
        narration: `${docNo}: ${cat.rows[0]!.name}, ${data.description}`,
        sourceType: 'Expense',
        sourceId: id,
        postingKey: `Expense:${id}`,
        postedBy: request.auth!.user.id,
        lines: [
          { accountId: Number(cat.rows[0]!.account_id), debit: toDecimal(amount) },
          { accountId: data.accountId, credit: toDecimal(amount) },
        ],
      });

      return { id, docNo, amount: toDecimal(amount) };
    });

    await recordActivity(app.db, {
      userId: request.auth!.user.id, userName: request.auth!.user.name,
      module: 'finance.expenses', action: 'CREATE', recordType: 'Expense',
      recordId: result.id, recordLabel: `${result.docNo}: ${data.description}`,
      newValues: data, ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
    });

    return reply.status(201).send(result);
  });

  /* ==================================================================== */
  /* Salaries                                                              */
  /* ==================================================================== */

  app.get('/api/finance/employees', { preHandler: requirePermission('finance.view') }, async () => {
    const r = await app.db.query(
      `SELECT id, code, name, designation, base_salary AS "baseSalary", is_active AS "isActive"
         FROM employees WHERE deleted_at IS NULL AND is_active ORDER BY name`
    );
    return { employees: r.rows };
  });

  app.post('/api/finance/employees', { preHandler: requirePermission('masters.manage') }, async (request, reply) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(120),
        designation: z.string().trim().max(80).optional().nullable(),
        baseSalary: money.optional(),
        joiningDate: isoDate.optional().nullable(),
      })
      .parse(request.body);

    const count = await app.db.query<{ n: string }>('SELECT count(*) AS n FROM employees');
    const code = `EMP-${String(Number(count.rows[0]!.n) + 1).padStart(4, '0')}`;

    const r = await app.db.query<{ id: string }>(
      `INSERT INTO employees (code, name, designation, base_salary, joining_date, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
      [
        code, data.name, data.designation ?? null,
        data.baseSalary ? toDecimal(toMinor(data.baseSalary)) : '0.00',
        data.joiningDate ?? null, request.auth!.user.id,
      ]
    );
    return reply.status(201).send({ id: r.rows[0]!.id, code, ...data });
  });

  app.get('/api/finance/salaries', { preHandler: requirePermission('finance.view') }, async (request) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(request.query ?? {});
    const month = q.month ? `${q.month}-01` : null;

    const rows = await app.db.query(
      `SELECT s.id, s.period_month AS "month", s.salary_amount AS "salary",
              s.advance_amount AS "advance", s.paid_amount AS "paid", s.remaining,
              s.payment_date AS "paidOn", s.method_label AS "method", s.notes,
              e.id AS "employeeId", e.name AS "employee", e.designation
         FROM salaries s JOIN employees e ON e.id = s.employee_id
        WHERE s.deleted_at IS NULL AND ($1::date IS NULL OR s.period_month = $1)
        ORDER BY s.period_month DESC, e.name`,
      [month]
    );
    return { salaries: rows.rows };
  });

  /**
   * Records a month's pay for one employee.
   *
   * The advance is money already handed over earlier in the month, so what is
   * paid now is salary less advance less anything already paid. Whatever is
   * still owed sits in Salaries Payable rather than vanishing.
   */
  app.post('/api/finance/salaries', { preHandler: requirePermission('finance.manage') }, async (request, reply) => {
    const data = z
      .object({
        employeeId: z.coerce.number().int().positive(),
        month: z.string().regex(/^\d{4}-\d{2}$/, 'Month must be YYYY-MM'),
        salaryAmount: money,
        advanceAmount: money.optional(),
        payNow: money.optional(),
        paymentDate: isoDate.optional(),
        accountId: z.coerce.number().int().positive().optional(),
        methodLabel: z.string().trim().max(40).default('Cash'),
        notes: z.string().trim().max(1000).optional().nullable(),
      })
      .parse(request.body);

    const salary = toMinor(data.salaryAmount);
    const advance = data.advanceAmount ? toMinor(data.advanceAmount) : 0n;
    const payNow = data.payNow ? toMinor(data.payNow) : 0n;

    if (salary <= 0n) throw new ValidationError('Salary must be more than zero');
    if (advance + payNow > salary) {
      throw new ValidationError(
        `Advance and payment together come to ${toDecimal(advance + payNow)}, which is more than the salary of ${toDecimal(salary)}.`
      );
    }

    const emp = await app.db.query<{ name: string }>('SELECT name FROM employees WHERE id = $1', [data.employeeId]);
    if (!emp.rows[0]) throw new NotFoundError('Employee not found');

    const periodMonth = `${data.month}-01`;
    const paidTotal = advance + payNow;
    const remaining = salary - paidTotal;
    const payDate = data.paymentDate ?? `${data.month}-01`;

    const result = await app.db.transaction(async (tx) => {
      const fiscalYearId = await requireOpenFiscalYear(tx, payDate);

      const existing = await tx.query<{ id: string }>(
        'SELECT id FROM salaries WHERE employee_id = $1 AND period_month = $2 AND deleted_at IS NULL',
        [data.employeeId, periodMonth]
      );
      if (existing.rows[0]) {
        throw new ValidationError(`${emp.rows[0]!.name} already has a salary recorded for ${data.month}.`);
      }

      const ins = await tx.query<{ id: string }>(
        `INSERT INTO salaries (employee_id, period_month, salary_amount, advance_amount,
                               paid_amount, remaining, payment_date, account_id, method_label,
                               notes, fiscal_year_id, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
        [
          data.employeeId, periodMonth, toDecimal(salary), toDecimal(advance),
          toDecimal(payNow), toDecimal(remaining), payDate,
          data.accountId ?? null, data.methodLabel, data.notes ?? null,
          fiscalYearId, request.auth!.user.id,
        ]
      );
      const id = ins.rows[0]!.id;

      const salaryExpense = await accountByCode(tx, '6100');
      const payable = await accountByCode(tx, '2200');
      const cashAccount = data.accountId ?? (await accountByCode(tx, '1010'));

      // The whole salary is a cost of the month it belongs to. What has been
      // handed over reduces cash; what has not yet is a liability.
      const lines: Array<Record<string, unknown>> = [
        { accountId: salaryExpense, debit: toDecimal(salary), memo: emp.rows[0]!.name },
      ];
      if (paidTotal > 0n) lines.push({ accountId: cashAccount, credit: toDecimal(paidTotal) });
      if (remaining > 0n) lines.push({ accountId: payable, credit: toDecimal(remaining), memo: emp.rows[0]!.name });

      await postJournalEntry(tx, {
        entryDate: payDate,
        narration: `Salary ${data.month}: ${emp.rows[0]!.name}`,
        sourceType: 'Salary',
        sourceId: id,
        postingKey: `Salary:${id}`,
        postedBy: request.auth!.user.id,
        lines: lines as never,
      });

      return { id, employee: emp.rows[0]!.name, salary: toDecimal(salary), remaining: toDecimal(remaining) };
    });

    await recordActivity(app.db, {
      userId: request.auth!.user.id, userName: request.auth!.user.name,
      module: 'finance.salaries', action: 'CREATE', recordType: 'Salary',
      recordId: result.id, recordLabel: `${result.employee}, ${data.month}`,
      newValues: data, ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
    });

    return reply.status(201).send(result);
  });

  /* ==================================================================== */
  /* Owner's drawings                                                      */
  /* ==================================================================== */

  app.get('/api/finance/drawings', { preHandler: requirePermission('finance.view') }, async (request) => {
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(request.query ?? {});

    const rows = await app.db.query(
      `SELECT d.id, d.doc_no AS "docNo", d.drawing_date AS "date", d.amount,
              d.purpose, d.method_label AS "method", d.notes, a.name AS "takenFrom"
         FROM owner_drawings d JOIN accounts a ON a.id = d.account_id
        WHERE d.deleted_at IS NULL
          AND ($1::date IS NULL OR d.drawing_date >= $1)
          AND ($2::date IS NULL OR d.drawing_date <= $2)
        ORDER BY d.drawing_date DESC, d.id DESC LIMIT 100`,
      [q.from ?? null, q.to ?? null]
    );

    let total = 0n;
    for (const r of rows.rows as Array<{ amount: string }>) total += toMinor(r.amount);

    return { drawings: rows.rows, total: toDecimal(total) };
  });

  app.post('/api/finance/drawings', { preHandler: requirePermission('finance.manage') }, async (request, reply) => {
    const data = z
      .object({
        drawingDate: isoDate,
        amount: money,
        accountId: z.coerce.number().int().positive(),
        methodLabel: z.string().trim().max(40).default('Cash'),
        purpose: z.string().trim().max(160).optional().nullable(),
        notes: z.string().trim().max(1000).optional().nullable(),
      })
      .parse(request.body);

    const amount = toMinor(data.amount);
    if (amount <= 0n) throw new ValidationError('A drawing must be more than zero');

    const result = await app.db.transaction(async (tx) => {
      const fiscalYearId = await requireOpenFiscalYear(tx, data.drawingDate);
      const docNo = await nextDocumentNumber(tx, 'DRW', Number(data.drawingDate.slice(0, 4)));

      const ins = await tx.query<{ id: string }>(
        `INSERT INTO owner_drawings (doc_no, drawing_date, amount, account_id, method_label,
                                     purpose, notes, fiscal_year_id, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
        [
          docNo, data.drawingDate, toDecimal(amount), data.accountId, data.methodLabel,
          data.purpose ?? null, data.notes ?? null, fiscalYearId, request.auth!.user.id,
        ]
      );
      const id = ins.rows[0]!.id;

      // BR-12: equity, not expense. This is the whole reason drawings have
      // their own screen and their own account.
      await postJournalEntry(tx, {
        entryDate: data.drawingDate,
        narration: `${docNo}: owner drawing${data.purpose ? `, ${data.purpose}` : ''}`,
        sourceType: 'OwnerDrawing',
        sourceId: id,
        postingKey: `OwnerDrawing:${id}`,
        postedBy: request.auth!.user.id,
        lines: [
          { accountId: await accountByCode(tx, '3100'), debit: toDecimal(amount) },
          { accountId: data.accountId, credit: toDecimal(amount) },
        ],
      });

      return { id, docNo, amount: toDecimal(amount) };
    });

    await recordActivity(app.db, {
      userId: request.auth!.user.id, userName: request.auth!.user.name,
      module: 'finance.drawings', action: 'CREATE', recordType: 'OwnerDrawing',
      recordId: result.id, recordLabel: `${result.docNo}: ${result.amount}`,
      newValues: data, ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
    });

    return reply.status(201).send(result);
  });
};
