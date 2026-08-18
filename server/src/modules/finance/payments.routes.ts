/**
 * Settling balances: money paid to suppliers, money received from buyers.
 *
 * One payment can clear several documents, because that is how it happens in
 * practice: a supplier is paid a round figure covering three loads. The
 * remainder, if any, stays visible as a credit on the party rather than being
 * forced onto an arbitrary invoice, which is how party balances become fiction.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../rbac/guard.ts';
import { recordActivity } from '../activity/log.ts';
import { ValidationError } from '../../lib/errors.ts';
import { toDecimal, toMinor } from '../../lib/money.ts';
import { postJournalEntry } from './posting.service.ts';
import { requireOpenFiscalYear } from './fiscalYear.service.ts';
import { nextDocumentNumber } from './sequence.service.ts';

const money = z.union([z.string(), z.number()]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

export const paymentRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('preHandler', requireAuth);

  /** What is still open for a party, oldest first, ready to be settled. */
  app.get('/api/finance/open-documents', { preHandler: requirePermission('finance.view') }, async (request) => {
    const q = z.object({ partyId: z.coerce.number().int().positive() }).parse(request.query ?? {});

    const purchases = await app.db.query(
      `SELECT p.id, p.doc_no AS "docNo", p.purchase_date AS "date", p.division,
              p.total_amount AS "total", p.balance_due AS "balance", p.drums
         FROM purchases p
        WHERE p.party_id = $1 AND p.deleted_at IS NULL AND p.balance_due > 0
        ORDER BY p.purchase_date, p.id`,
      [q.partyId]
    );

    let total = 0n;
    for (const r of purchases.rows as Array<{ balance: string }>) total += toMinor(r.balance);

    return { documents: purchases.rows, totalOutstanding: toDecimal(total) };
  });

  app.get('/api/finance/payments', { preHandler: requirePermission('finance.view') }, async (request) => {
    const q = z
      .object({
        from: isoDate.optional(),
        to: isoDate.optional(),
        direction: z.enum(['IN', 'OUT']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      })
      .parse(request.query ?? {});

    const rows = await app.db.query(
      `SELECT pm.id, pm.doc_no AS "docNo", pm.payment_date AS "date", pm.direction,
              pm.amount, pm.method_label AS "method", pm.reference_no AS "reference", pm.notes,
              p.name AS "party", a.name AS "account",
              COALESCE((SELECT SUM(amount) FROM payment_allocations pa WHERE pa.payment_id = pm.id), 0) AS allocated
         FROM payments pm
         LEFT JOIN parties p ON p.id = pm.party_id
         JOIN accounts a ON a.id = pm.account_id
        WHERE pm.deleted_at IS NULL
          AND ($1::date IS NULL OR pm.payment_date >= $1)
          AND ($2::date IS NULL OR pm.payment_date <= $2)
          AND ($3::text IS NULL OR pm.direction = $3)
        ORDER BY pm.payment_date DESC, pm.id DESC LIMIT $4`,
      [q.from ?? null, q.to ?? null, q.direction ?? null, q.limit]
    );
    return { payments: rows.rows };
  });

  /**
   * Records a payment and applies it to open documents.
   *
   * The allocation is what makes a payment meaningful: without it the party
   * balance moves but nobody can say which loads were settled.
   */
  app.post('/api/finance/payments', { preHandler: requirePermission('finance.manage') }, async (request, reply) => {
    const data = z
      .object({
        paymentDate: isoDate,
        direction: z.enum(['IN', 'OUT']),
        partyId: z.coerce.number().int().positive(),
        amount: money,
        accountId: z.coerce.number().int().positive(),
        methodLabel: z.string().trim().max(40).default('Cash'),
        referenceNo: z.string().trim().max(60).optional().nullable(),
        notes: z.string().trim().max(1000).optional().nullable(),
        allocations: z
          .array(z.object({ targetType: z.string().max(60), targetId: z.coerce.number().int().positive(), amount: money }))
          .default([]),
      })
      .parse(request.body);

    const amount = toMinor(data.amount);
    if (amount <= 0n) throw new ValidationError('A payment must be more than zero');

    let allocated = 0n;
    for (const a of data.allocations) allocated += toMinor(a.amount);
    if (allocated > amount) {
      throw new ValidationError(
        `You have applied ${toDecimal(allocated)} against a payment of ${toDecimal(amount)}. Reduce the amounts applied.`,
        { amount: toDecimal(amount), allocated: toDecimal(allocated) }
      );
    }

    const party = await app.db.query<{ name: string }>('SELECT name FROM parties WHERE id = $1', [data.partyId]);
    if (!party.rows[0]) throw new ValidationError('Choose who this payment is with');

    const result = await app.db.transaction(async (tx) => {
      const fiscalYearId = await requireOpenFiscalYear(tx, data.paymentDate);
      const docNo = await nextDocumentNumber(tx, data.direction === 'OUT' ? 'PAY' : 'RCT', Number(data.paymentDate.slice(0, 4)));

      const ins = await tx.query<{ id: string }>(
        `INSERT INTO payments (doc_no, payment_date, direction, party_id, amount, account_id,
                               method_label, reference_no, notes, fiscal_year_id, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING id`,
        [
          docNo, data.paymentDate, data.direction, data.partyId, toDecimal(amount), data.accountId,
          data.methodLabel, data.referenceNo ?? null, data.notes ?? null, fiscalYearId, request.auth!.user.id,
        ]
      );
      const id = ins.rows[0]!.id;

      // Apply to documents and refresh their cached balance. The ledger is the
      // authority; these columns are a display cache (design rule 4).
      for (const a of data.allocations) {
        const amt = toMinor(a.amount);
        if (amt <= 0n) continue;

        await tx.query(
          `INSERT INTO payment_allocations (payment_id, target_type, target_id, amount)
           VALUES ($1,$2,$3,$4)`,
          [id, a.targetType, a.targetId, toDecimal(amt)]
        );

        if (a.targetType === 'Purchase') {
          const p = await tx.query<{ balance_due: string; total_amount: string }>(
            'SELECT balance_due, total_amount FROM purchases WHERE id = $1 FOR UPDATE',
            [a.targetId]
          );
          if (!p.rows[0]) throw new ValidationError('That purchase no longer exists');

          const remaining = toMinor(p.rows[0].balance_due) - amt;
          if (remaining < 0n) {
            throw new ValidationError(
              `You have applied more to one load than is owed on it. It has ${p.rows[0].balance_due} outstanding.`
            );
          }
          // payment_status is an enum, so the CASE result needs an explicit cast.
          await tx.query(
            `UPDATE purchases
                SET balance_due = $2,
                    payment_status = (CASE WHEN $2::numeric = 0 THEN 'PAID' ELSE 'PARTIAL' END)::pay_status_t
              WHERE id = $1`,
            [a.targetId, toDecimal(remaining)]
          );
        }
      }

      const control = data.direction === 'OUT' ? '2100' : '1100';
      const controlId = Number(
        (await tx.query<{ id: number }>('SELECT id FROM accounts WHERE code = $1', [control])).rows[0]!.id
      );

      await postJournalEntry(tx, {
        entryDate: data.paymentDate,
        narration: `${docNo}: ${data.direction === 'OUT' ? 'paid' : 'received from'} ${party.rows[0]!.name}`,
        sourceType: 'Payment',
        sourceId: id,
        postingKey: `Payment:${id}`,
        postedBy: request.auth!.user.id,
        lines:
          data.direction === 'OUT'
            ? [
                { accountId: controlId, debit: toDecimal(amount), partyId: data.partyId },
                { accountId: data.accountId, credit: toDecimal(amount) },
              ]
            : [
                { accountId: data.accountId, debit: toDecimal(amount) },
                { accountId: controlId, credit: toDecimal(amount), partyId: data.partyId },
              ],
      });

      return {
        id,
        docNo,
        amount: toDecimal(amount),
        allocated: toDecimal(allocated),
        onAccount: toDecimal(amount - allocated),
        party: party.rows[0]!.name,
      };
    });

    await recordActivity(app.db, {
      userId: request.auth!.user.id, userName: request.auth!.user.name,
      module: 'finance.payments', action: 'CREATE', recordType: 'Payment',
      recordId: result.id, recordLabel: `${result.docNo}: ${result.amount} with ${result.party}`,
      newValues: data, ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
    });

    return reply.status(201).send(result);
  });

  /* ==================================================================== */
  /* Government weight fee refunds                                         */
  /* ==================================================================== */

  /**
   * The refund pipeline: paid, then claimed, then received.
   *
   * This is effectively an accounts-receivable subledger where the debtor is
   * the government, which is why it gets aging like any other receivable.
   */
  app.get('/api/finance/weight-fees', { preHandler: requirePermission('finance.view') }, async (request) => {
    const q = z
      .object({ status: z.enum(['PENDING', 'CLAIMED', 'RECEIVED', 'NOT_ELIGIBLE']).optional() })
      .parse(request.query ?? {});

    const rows = await app.db.query(
      `SELECT wf.id, wf.fee_amount AS "feeAmount", wf.slip_number AS "slipNumber",
              wf.refund_status AS "status", wf.claimed_on AS "claimedOn",
              wf.refund_amount AS "refundAmount", wf.refund_received_on AS "receivedOn",
              wf.refund_eligible AS "eligible", wf.notes,
              p.doc_no AS "purchaseDoc", p.purchase_date AS "purchaseDate", p.division,
              CASE WHEN wf.refund_status = 'CLAIMED' AND wf.claimed_on IS NOT NULL
                   THEN (current_date - wf.claimed_on) ELSE NULL END AS "daysWaiting"
         FROM weight_fees wf JOIN purchases p ON p.id = wf.purchase_id
        WHERE ($1::refund_t IS NULL OR wf.refund_status = $1)
        ORDER BY wf.refund_status, p.purchase_date DESC`,
      [q.status ?? null]
    );

    const summary = await app.db.query<{ status: string; count: string; fees: string; refunds: string }>(
      `SELECT refund_status AS status, count(*) AS count,
              COALESCE(SUM(fee_amount),0) AS fees,
              COALESCE(SUM(refund_amount),0) AS refunds
         FROM weight_fees GROUP BY refund_status`
    );

    const outstanding = await app.db.query<{ amount: string }>(
      `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS amount
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '1300'`
    );

    return {
      fees: rows.rows,
      summary: summary.rows,
      owedByGovernment: toDecimal(toMinor(outstanding.rows[0]?.amount ?? '0')),
    };
  });

  /** Submit a batch of slips as claimed. */
  app.post('/api/finance/weight-fees/claim', { preHandler: requirePermission('finance.manage') }, async (request) => {
    const data = z
      .object({ ids: z.array(z.coerce.number().int().positive()).min(1), claimedOn: isoDate })
      .parse(request.body);

    const res = await app.db.query<{ id: string }>(
      `UPDATE weight_fees SET refund_status = 'CLAIMED', claimed_on = $2
        WHERE id = ANY($1::bigint[]) AND refund_status = 'PENDING' AND refund_eligible
        RETURNING id`,
      [data.ids, data.claimedOn]
    );

    await recordActivity(app.db, {
      userId: request.auth!.user.id, userName: request.auth!.user.name,
      module: 'finance.weight_fees', action: 'UPDATE', recordType: 'WeightFee',
      recordLabel: `${res.rows.length} slips submitted to the government on ${data.claimedOn}`,
      newValues: data, ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
    });

    return { claimed: res.rows.length };
  });

  /**
   * Records a refund actually arriving.
   *
   * BR-20: the amount refunded can differ from the amount paid. Whatever the
   * government kept is a cost, not a receivable that sits there forever.
   */
  app.post('/api/finance/weight-fees/:id/received', { preHandler: requirePermission('finance.manage') }, async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const data = z
      .object({ refundAmount: money, receivedOn: isoDate, accountId: z.coerce.number().int().positive() })
      .parse(request.body);

    const fee = await app.db.query<{ fee_amount: string; slip_number: string; refund_status: string }>(
      'SELECT fee_amount, slip_number, refund_status FROM weight_fees WHERE id = $1',
      [id]
    );
    if (!fee.rows[0]) throw new ValidationError('Slip not found');
    if (fee.rows[0].refund_status === 'RECEIVED') throw new ValidationError('That refund is already recorded');

    const paid = toMinor(fee.rows[0].fee_amount);
    const refund = toMinor(data.refundAmount);
    if (refund < 0n) throw new ValidationError('A refund cannot be negative');
    if (refund > paid) {
      throw new ValidationError(
        `The refund of ${toDecimal(refund)} is more than the ${toDecimal(paid)} originally paid. Check the figure.`
      );
    }
    const shortfall = paid - refund;

    await app.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE weight_fees
            SET refund_status = 'RECEIVED', refund_amount = $2, refund_received_on = $3,
                gov_return_status = 'RETURNED'
          WHERE id = $1`,
        [id, toDecimal(refund), data.receivedOn]
      );

      const receivable = Number(
        (await tx.query<{ id: number }>(`SELECT id FROM accounts WHERE code = '1300'`)).rows[0]!.id
      );
      const feeExpense = Number(
        (await tx.query<{ id: number }>(`SELECT id FROM accounts WHERE code = '6900'`)).rows[0]!.id
      );

      const lines: Array<Record<string, unknown>> = [];
      if (refund > 0n) lines.push({ accountId: data.accountId, debit: toDecimal(refund) });
      if (shortfall > 0n) lines.push({ accountId: feeExpense, debit: toDecimal(shortfall), memo: 'Not refunded' });
      lines.push({ accountId: receivable, credit: toDecimal(paid) });

      await postJournalEntry(tx, {
        entryDate: data.receivedOn,
        narration: `Weight fee refund, slip ${fee.rows[0]!.slip_number}`,
        sourceType: 'WeightFeeRefund',
        sourceId: id,
        postingKey: `WeightFeeRefund:${id}`,
        postedBy: request.auth!.user.id,
        lines: lines as never,
      });
    });

    await recordActivity(app.db, {
      userId: request.auth!.user.id, userName: request.auth!.user.name,
      module: 'finance.weight_fees', action: 'UPDATE', recordType: 'WeightFee',
      recordId: id,
      recordLabel: `Slip ${fee.rows[0]!.slip_number}: ${toDecimal(refund)} refunded of ${toDecimal(paid)} paid`,
      newValues: data, ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
    });

    return { ok: true, refunded: toDecimal(refund), notRefunded: toDecimal(shortfall) };
  });
};
