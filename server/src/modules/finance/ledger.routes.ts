/**
 * Cash & bank ledgers (B6) and the trial balance (B7).
 *
 * Both are pure queries over journal_lines. There is no separate transactions
 * table for cash or bank — that would be a second record of the same fact, and
 * the usual reason a bank ledger stops agreeing with the trial balance.
 *
 * Amounts are returned as strings throughout: `numeric` exceeds JS number
 * precision, and rounding a ledger for transport defeats the point of it.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { NotFoundError } from '../../lib/errors.ts';
import { requireAuth, requirePermission } from '../rbac/guard.ts';
import { toDecimal, toMinor } from '../../lib/money.ts';

const rangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const ledgerRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('preHandler', requireAuth);

  /* --------------------------------------------------------- trial balance */

  app.get('/api/finance/trial-balance', { preHandler: requirePermission('finance.view') }, async (request) => {
    const q = rangeSchema.parse(request.query ?? {});
    const from = q.from ?? '0001-01-01';
    const to = q.to ?? '9999-12-31';

    const res = await app.db.query<{
      id: number;
      code: string;
      name: string;
      type: string;
      debit: string;
      credit: string;
    }>(
      `SELECT a.id, a.code, a.name, a.type,
              COALESCE(SUM(jl.debit), 0)  AS debit,
              COALESCE(SUM(jl.credit), 0) AS credit
         FROM accounts a
         JOIN journal_lines jl ON jl.account_id = a.id
        WHERE jl.entry_date BETWEEN $1::date AND $2::date
        GROUP BY a.id
       HAVING COALESCE(SUM(jl.debit), 0) <> 0 OR COALESCE(SUM(jl.credit), 0) <> 0
        ORDER BY a.code`,
      [from, to]
    );

    let totalDebit = 0n;
    let totalCredit = 0n;
    const rows = res.rows.map((r) => {
      const d = toMinor(r.debit);
      const c = toMinor(r.credit);
      totalDebit += d;
      totalCredit += c;

      // Net the account into its natural side so the report reads the way an
      // accountant expects, rather than showing both columns for every row.
      const net = d - c;
      const naturallyDebit = r.type === 'ASSET' || r.type === 'EXPENSE';
      return {
        accountId: Number(r.id),
        code: r.code,
        name: r.name,
        type: r.type,
        debit: toDecimal(d),
        credit: toDecimal(c),
        balance: toDecimal(naturallyDebit ? net : -net),
      };
    });

    return {
      from: q.from ?? null,
      to: q.to ?? null,
      rows,
      totals: {
        debit: toDecimal(totalDebit),
        credit: toDecimal(totalCredit),
        // BR-25 makes this structurally impossible to violate; it is reported
        // anyway, because a trial balance that cannot show it is not a check.
        balanced: totalDebit === totalCredit,
        difference: toDecimal(totalDebit - totalCredit),
      },
    };
  });

  /* ---------------------------------------------------------- account ledger */

  app.get('/api/finance/ledger/:accountId', { preHandler: requirePermission('finance.view') }, async (request) => {
    const { accountId } = z.object({ accountId: z.coerce.number().int().positive() }).parse(request.params);
    const q = rangeSchema.parse(request.query ?? {});
    const from = q.from ?? '0001-01-01';
    const to = q.to ?? '9999-12-31';

    const acc = await app.db.query<{ id: number; code: string; name: string; type: string }>(
      'SELECT id, code, name, type FROM accounts WHERE id = $1',
      [accountId]
    );
    const account = acc.rows[0];
    if (!account) throw new NotFoundError('Account not found');

    // Everything before `from` collapses into one opening figure.
    const opening = await app.db.query<{ debit: string; credit: string }>(
      `SELECT COALESCE(SUM(debit),0) AS debit, COALESCE(SUM(credit),0) AS credit
         FROM journal_lines WHERE account_id = $1 AND entry_date < $2::date`,
      [accountId, from]
    );

    const lines = await app.db.query<{
      id: number;
      entry_id: number;
      entry_no: string;
      entry_date: string | Date;
      narration: string | null;
      memo: string | null;
      debit: string;
      credit: string;
      party_name: string | null;
    }>(
      `SELECT jl.id, jl.entry_id, je.entry_no, jl.entry_date, je.narration, jl.memo,
              jl.debit, jl.credit, p.name AS party_name
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         LEFT JOIN parties p ON p.id = jl.party_id
        WHERE jl.account_id = $1 AND jl.entry_date BETWEEN $2::date AND $3::date
        ORDER BY jl.entry_date, jl.entry_id, jl.id`,
      [accountId, from, to]
    );

    const naturallyDebit = account.type === 'ASSET' || account.type === 'EXPENSE';
    const sign = naturallyDebit ? 1n : -1n;

    let running = sign * (toMinor(opening.rows[0]?.debit ?? '0') - toMinor(opening.rows[0]?.credit ?? '0'));
    const openingBalance = toDecimal(running);

    const rows = lines.rows.map((l) => {
      const d = toMinor(l.debit);
      const c = toMinor(l.credit);
      running += sign * (d - c);
      return {
        lineId: Number(l.id),
        entryId: Number(l.entry_id),
        entryNo: l.entry_no,
        date: l.entry_date instanceof Date ? l.entry_date.toISOString().slice(0, 10) : String(l.entry_date).slice(0, 10),
        description: l.memo ?? l.narration ?? '',
        party: l.party_name,
        debit: toDecimal(d),
        credit: toDecimal(c),
        balance: toDecimal(running),
      };
    });

    return {
      account: { id: Number(account.id), code: account.code, name: account.name, type: account.type },
      from: q.from ?? null,
      to: q.to ?? null,
      openingBalance,
      closingBalance: toDecimal(running),
      rows,
    };
  });

  /* ------------------------------------------------- cash & bank summary */

  app.get('/api/finance/cash-bank', { preHandler: requirePermission('finance.view') }, async () => {
    const res = await app.db.query<{
      id: number;
      code: string;
      name: string;
      subtype: string;
      debit: string;
      credit: string;
    }>(
      `SELECT a.id, a.code, a.name, a.subtype,
              COALESCE(SUM(jl.debit), 0)  AS debit,
              COALESCE(SUM(jl.credit), 0) AS credit
         FROM accounts a
         LEFT JOIN journal_lines jl ON jl.account_id = a.id
        WHERE a.subtype IN ('CASH','BANK') AND a.is_active
        GROUP BY a.id
        ORDER BY a.code`
    );

    let cash = 0n;
    let bank = 0n;
    const accounts = res.rows.map((r) => {
      const balance = toMinor(r.debit) - toMinor(r.credit);
      if (r.subtype === 'CASH') cash += balance;
      else bank += balance;
      return {
        accountId: Number(r.id),
        code: r.code,
        name: r.name,
        subtype: r.subtype,
        balance: toDecimal(balance),
      };
    });

    return {
      accounts,
      totals: { cash: toDecimal(cash), bank: toDecimal(bank), combined: toDecimal(cash + bank) },
    };
  });
};
