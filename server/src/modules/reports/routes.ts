/**
 * Reports.
 *
 * Every figure here is derived from the two ledgers, never from a stored
 * summary, so a report can always be reconciled back to the documents behind
 * it. Filters are the same everywhere: a date range plus whatever dimension
 * the report groups by.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../rbac/guard.ts';
import { toDecimal, toMinor } from '../../lib/money.ts';
// Drums carry 3 decimals, money carries 2. They are summed with different
// helpers on purpose: feeding a quantity to the money parser is a bug, and
// money.ts refuses it rather than silently rounding.
import { qtyToDecimal, qtyToMinor } from '../inventory/stock.service.ts';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const rangeSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  division: z.enum(['UCO', 'UEO']).optional(),
});

/** Defaults to the current calendar year when no range is given. */
function range(q: { from?: string; to?: string }) {
  const year = new Date().getUTCFullYear();
  return { from: q.from ?? `${year}-01-01`, to: q.to ?? `${year}-12-31` };
}

export const reportRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('preHandler', requireAuth);

  /* ---------------------------------------------------------- headline */

  /**
   * The numbers the dashboard leads with. One round trip rather than five,
   * because this loads on every sign-in.
   */
  app.get('/api/reports/overview', { preHandler: requirePermission('operations.view') }, async (request) => {
    const q = rangeSchema.parse(request.query ?? {});
    const { from, to } = range(q);
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 8) + '01';

    const [purchases, today_, month, stock, owed, drivers] = await Promise.all([
      app.db.query<{ division: string; loads: string; drums: string; value: string; outstanding: string }>(
        `SELECT division, count(*) AS loads,
                COALESCE(SUM(drums),0) AS drums,
                COALESCE(SUM(total_amount),0) AS value,
                COALESCE(SUM(balance_due),0) AS outstanding
           FROM purchases
          WHERE deleted_at IS NULL AND is_no_purchase = false
            AND purchase_date BETWEEN $1::date AND $2::date
          GROUP BY division`,
        [from, to]
      ),
      app.db.query<{ loads: string; drums: string; value: string }>(
        `SELECT count(*) AS loads, COALESCE(SUM(drums),0) AS drums, COALESCE(SUM(total_amount),0) AS value
           FROM purchases WHERE deleted_at IS NULL AND is_no_purchase = false AND purchase_date = $1::date`,
        [today]
      ),
      app.db.query<{ loads: string; drums: string; value: string }>(
        `SELECT count(*) AS loads, COALESCE(SUM(drums),0) AS drums, COALESCE(SUM(total_amount),0) AS value
           FROM purchases WHERE deleted_at IS NULL AND is_no_purchase = false
             AND purchase_date BETWEEN $1::date AND $2::date`,
        [monthStart, today]
      ),
      app.db.query<{ code: string; name: string; quantity: string; value: string; low: boolean }>(
        `SELECT i.code, i.name, sb.quantity, sb.value, (sb.quantity < i.low_threshold) AS low
           FROM stock_balances sb JOIN inventory_items i ON i.id = sb.item_id
          WHERE i.division IN ('UCO','UEO') ORDER BY i.id`
      ),
      app.db.query<{ payable: string; receivable: string }>(
        `SELECT
           COALESCE((SELECT SUM(credit) - SUM(debit) FROM journal_lines jl
                      JOIN accounts a ON a.id = jl.account_id WHERE a.code = '2100'), 0) AS payable,
           COALESCE((SELECT SUM(debit) - SUM(credit) FROM journal_lines jl
                      JOIN accounts a ON a.id = jl.account_id WHERE a.code = '1100'), 0) AS receivable`
      ),
      app.db.query<{ out_with_drivers: string; count: string }>(
        `SELECT COALESCE(SUM(advance_balance),0) AS out_with_drivers,
                count(*) FILTER (WHERE advance_balance > 0) AS count
           FROM drivers WHERE deleted_at IS NULL AND driver_type = 'IN_HOUSE'`
      ),
    ]);

    return {
      range: { from, to },
      byDivision: purchases.rows,
      today: today_.rows[0],
      month: month.rows[0],
      stock: stock.rows,
      owed: owed.rows[0],
      driverAdvances: drivers.rows[0],
    };
  });

  /* --------------------------------------------------------- purchases */

  /**
   * Intake grouped by whichever dimension is asked for. One query shape
   * covering five reports, because they differ only in what they group by.
   */
  app.get('/api/reports/purchases', { preHandler: requirePermission('reports.view') }, async (request) => {
    const q = rangeSchema
      .extend({ groupBy: z.enum(['day', 'month', 'driver', 'supplier', 'source', 'area']).default('month') })
      .parse(request.query ?? {});
    const { from, to } = range(q);

    const dimension: Record<string, string> = {
      day: `to_char(p.purchase_date, 'YYYY-MM-DD')`,
      month: `to_char(p.purchase_date, 'YYYY-MM')`,
      driver: `COALESCE(d.name, 'No driver')`,
      supplier: `COALESCE(pa.name, 'No supplier')`,
      source: `p.source`,
      area: `COALESCE(NULLIF(p.collection_area, ''), 'Not recorded')`,
    };

    const res = await app.db.query<{
      label: string; loads: string; drums: string; value: string; paid: string; outstanding: string; fees: string;
    }>(
      `SELECT ${dimension[q.groupBy]} AS label,
              count(*) AS loads,
              COALESCE(SUM(p.drums),0) AS drums,
              COALESCE(SUM(p.total_amount),0) AS value,
              COALESCE(SUM(p.cash_paid + p.online_paid + p.advance_used),0) AS paid,
              COALESCE(SUM(p.balance_due),0) AS outstanding,
              COALESCE(SUM(wf.fee_amount),0) AS fees
         FROM purchases p
         LEFT JOIN drivers d ON d.id = p.driver_id
         LEFT JOIN parties pa ON pa.id = p.party_id
         LEFT JOIN weight_fees wf ON wf.purchase_id = p.id
        WHERE p.deleted_at IS NULL AND p.is_no_purchase = false
          AND p.purchase_date BETWEEN $1::date AND $2::date
          AND ($3::division_t IS NULL OR p.division = $3)
        GROUP BY 1
        ORDER BY 1`,
      [from, to, q.division ?? null]
    );

    // Totals are summed in exact minor units, not by a second SQL pass, so the
    // footer can never disagree with the rows above it.
    let drums = 0n;
    let value = 0n;
    let paid = 0n;
    let outstanding = 0n;
    for (const r of res.rows) {
      drums += qtyToMinor(r.drums);
      value += toMinor(r.value);
      paid += toMinor(r.paid);
      outstanding += toMinor(r.outstanding);
    }

    return {
      range: { from, to },
      groupBy: q.groupBy,
      rows: res.rows,
      totals: {
        loads: res.rows.reduce((a, r) => a + Number(r.loads), 0),
        drums: qtyToDecimal(drums),
        value: toDecimal(value),
        paid: toDecimal(paid),
        outstanding: toDecimal(outstanding),
      },
    };
  });

  /* ------------------------------------------------------------- stock */

  app.get('/api/reports/stock', { preHandler: requirePermission('reports.view') }, async (request) => {
    const q = rangeSchema.parse(request.query ?? {});
    const { from, to } = range(q);

    const res = await app.db.query(
      `SELECT i.code, i.name, i.division, i.uom,
              COALESCE(SUM(sm.quantity) FILTER (WHERE sm.direction = 1 AND sm.moved_on BETWEEN $1::date AND $2::date), 0) AS "in",
              COALESCE(SUM(sm.quantity) FILTER (WHERE sm.direction = -1 AND sm.moved_on BETWEEN $1::date AND $2::date), 0) AS "out",
              sb.quantity AS "onHand", sb.value, sb.avg_unit_cost AS "avgCost",
              i.low_threshold AS "lowThreshold"
         FROM inventory_items i
         JOIN stock_balances sb ON sb.item_id = i.id
         LEFT JOIN stock_movements sm ON sm.item_id = i.id
        GROUP BY i.id, sb.quantity, sb.value, sb.avg_unit_cost
        ORDER BY i.id`,
      [from, to]
    );
    return { range: { from, to }, rows: res.rows };
  });

  /* ------------------------------------------------------------ profit */

  /**
   * Gross profit per division, from the income and COGS lines. Operating
   * expenses are company-wide (BR-13) and so are reported separately rather
   * than split across divisions on an invented basis.
   */
  app.get('/api/reports/profit', { preHandler: requirePermission('profit.view') }, async (request) => {
    const q = rangeSchema.parse(request.query ?? {});
    const { from, to } = range(q);

    const byDivision = await app.db.query<{ division: string | null; income: string; cogs: string }>(
      `SELECT jl.division,
              COALESCE(SUM(jl.credit) FILTER (WHERE a.type = 'INCOME'), 0) AS income,
              COALESCE(SUM(jl.debit)  FILTER (WHERE a.subtype = 'COGS'), 0) AS cogs
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_date BETWEEN $1::date AND $2::date
          AND (a.type = 'INCOME' OR a.subtype = 'COGS')
        GROUP BY jl.division`,
      [from, to]
    );

    const expenses = await app.db.query<{ code: string; name: string; amount: string }>(
      `SELECT a.code, a.name, COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS amount
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_date BETWEEN $1::date AND $2::date
          AND a.type = 'EXPENSE' AND COALESCE(a.subtype, '') <> 'COGS'
        GROUP BY a.id
       HAVING COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) <> 0
        ORDER BY a.code`,
      [from, to]
    );

    let grossTotal = 0n;
    const divisions = byDivision.rows.map((r) => {
      const income = toMinor(r.income);
      const cogs = toMinor(r.cogs);
      grossTotal += income - cogs;
      return {
        division: r.division ?? 'Unallocated',
        income: toDecimal(income),
        cogs: toDecimal(cogs),
        gross: toDecimal(income - cogs),
      };
    });

    let expenseTotal = 0n;
    for (const e of expenses.rows) expenseTotal += toMinor(e.amount);

    // Owner's drawings reduce equity, never profit (BR-12). Reported beside the
    // result so the owner can see both without them being confused.
    const drawings = await app.db.query<{ amount: string }>(
      `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS amount
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE a.code = '3100' AND jl.entry_date BETWEEN $1::date AND $2::date`,
      [from, to]
    );

    return {
      range: { from, to },
      divisions,
      expenses: expenses.rows,
      totals: {
        gross: toDecimal(grossTotal),
        expenses: toDecimal(expenseTotal),
        net: toDecimal(grossTotal - expenseTotal),
        drawings: toDecimal(toMinor(drawings.rows[0]?.amount ?? '0')),
      },
    };
  });

  /* -------------------------------------------------- who owes what */

  app.get('/api/reports/balances', { preHandler: requirePermission('finance.view') }, async (request) => {
    const q = z.object({ kind: z.enum(['payable', 'receivable']).default('payable') }).parse(request.query ?? {});
    const account = q.kind === 'payable' ? '2100' : '1100';
    const sign = q.kind === 'payable' ? 'SUM(jl.credit) - SUM(jl.debit)' : 'SUM(jl.debit) - SUM(jl.credit)';

    const res = await app.db.query(
      `SELECT p.id, p.code, p.name, p.phone, p.type,
              COALESCE(${sign}, 0) AS balance,
              max(jl.entry_date) AS "lastMovement"
         FROM parties p
         JOIN journal_lines jl ON jl.party_id = p.id
         JOIN accounts a ON a.id = jl.account_id
        WHERE a.code = $1 AND p.deleted_at IS NULL
        GROUP BY p.id
       HAVING COALESCE(${sign}, 0) <> 0
        ORDER BY 6 DESC`,
      [account]
    );
    return { kind: q.kind, rows: res.rows };
  });
};
