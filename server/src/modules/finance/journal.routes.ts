/**
 * Manual journal entries (feature B5) and the journal viewer.
 *
 * Manual posting is the one path into the ledger that is not driven by a
 * document, so it carries the extra guard rails: control accounts are refused
 * (BR-27), a narration is mandatory, and every entry is flagged `is_manual` so
 * an auditor can review exactly what was posted outside the document flow.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../lib/errors.ts';
import { requireAuth, requirePermission } from '../rbac/guard.ts';
import { recordActivity } from '../activity/log.ts';
import { postJournalEntry, reverseJournalEntry } from './posting.service.ts';

/** Money arrives as a string so no precision is lost before it reaches money.ts. */
const amount = z.union([z.string(), z.number()]).optional().nullable();

const manualEntrySchema = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  narration: z.string().trim().min(3, 'A narration is required so the entry can be understood later'),
  postingKey: z.string().min(1).max(120).optional(),
  lines: z
    .array(
      z.object({
        accountId: z.coerce.number().int().positive(),
        debit: amount,
        credit: amount,
        partyId: z.union([z.string(), z.number()]).optional().nullable(),
        division: z.enum(['UCO', 'UEO']).optional().nullable(),
        memo: z.string().max(255).optional().nullable(),
      })
    )
    .min(2, 'A journal entry needs at least two lines'),
});

export const journalRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('preHandler', requireAuth);

  /* ------------------------------------------------------------ list/view */

  app.get('/api/finance/journal', { preHandler: requirePermission('finance.view') }, async (request) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
        manualOnly: z.coerce.boolean().default(false),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        search: z.string().trim().max(80).optional(),
      })
      .parse(request.query ?? {});

    const res = await app.db.query(
      `SELECT je.id, je.entry_no, je.entry_date, je.narration, je.source_type,
              je.is_manual, je.is_reversal_of, je.posted_at, u.name AS posted_by_name,
              COALESCE(SUM(jl.debit), 0) AS total
         FROM journal_entries je
         JOIN users u ON u.id = je.posted_by
         LEFT JOIN journal_lines jl ON jl.entry_id = je.id
        WHERE ($1::boolean = false OR je.is_manual = true)
          AND ($4::date IS NULL OR je.entry_date >= $4)
          AND ($5::date IS NULL OR je.entry_date <= $5)
          AND ($6::text IS NULL OR je.narration ILIKE '%' || $6 || '%' OR je.entry_no ILIKE '%' || $6 || '%')
        GROUP BY je.id, u.name
        ORDER BY je.entry_date DESC, je.id DESC
        LIMIT $2 OFFSET $3`,
      [q.manualOnly, q.limit, q.offset, q.from ?? null, q.to ?? null, q.search ?? null]
    );
    return { entries: res.rows };
  });

  app.get('/api/finance/journal/:id', { preHandler: requirePermission('finance.view') }, async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);

    const entry = await app.db.query(
      `SELECT je.*, u.name AS posted_by_name
         FROM journal_entries je JOIN users u ON u.id = je.posted_by
        WHERE je.id = $1`,
      [id]
    );
    if (!entry.rows[0]) throw new ValidationError('Journal entry not found');

    const lines = await app.db.query(
      `SELECT jl.id, jl.account_id, a.code AS account_code, a.name AS account_name,
              jl.debit, jl.credit, jl.party_id, jl.division, jl.memo
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1 ORDER BY jl.id`,
      [id]
    );
    return { entry: entry.rows[0], lines: lines.rows };
  });

  /* -------------------------------------------------------- manual posting */

  app.post('/api/finance/journal', { preHandler: requirePermission('journal.manual') }, async (request, reply) => {
    const data = manualEntrySchema.parse(request.body);

    // BR-27: control accounts are maintained by domain services only. Letting a
    // manual entry touch AR, AP or Inventory is how a control account stops
    // agreeing with its subsidiary ledger.
    const accountIds = data.lines.map((l) => l.accountId);
    const control = await app.db.query<{ code: string; name: string }>(
      `SELECT code, name FROM accounts WHERE id = ANY($1::smallint[]) AND is_control = true`,
      [accountIds]
    );
    if (control.rows.length > 0) {
      const names = control.rows.map((a) => `${a.code} ${a.name}`).join(', ');
      throw new ValidationError(
        `A manual entry cannot post to a control account: ${names}. These are maintained by the modules that own them (BR-27).`,
        { accounts: control.rows }
      );
    }

    const inactive = await app.db.query<{ code: string; name: string }>(
      `SELECT code, name FROM accounts WHERE id = ANY($1::smallint[]) AND (is_active = false OR is_postable = false)`,
      [accountIds]
    );
    if (inactive.rows.length > 0) {
      const names = inactive.rows.map((a) => `${a.code} ${a.name}`).join(', ');
      throw new ValidationError(`These accounts cannot be posted to: ${names}`);
    }

    const found = await app.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM accounts WHERE id = ANY($1::smallint[])`,
      [accountIds]
    );
    if (Number(found.rows[0]!.n) !== new Set(accountIds).size) {
      throw new ValidationError('One or more lines reference an account that does not exist');
    }

    const posted = await postJournalEntry(app.db, {
      entryDate: data.entryDate,
      narration: data.narration,
      sourceType: 'ManualJournal',
      sourceId: 0,
      postingKey: data.postingKey ?? `manual:${request.auth!.user.id}:${data.entryDate}:${Date.now()}`,
      isManual: true,
      postedBy: request.auth!.user.id,
      lines: data.lines,
    });

    if (!posted.alreadyPosted) {
      await recordActivity(app.db, {
        userId: request.auth!.user.id,
        userName: request.auth!.user.name,
        module: 'finance.journal',
        action: 'CREATE',
        recordType: 'JournalEntry',
        recordId: posted.id,
        recordLabel: `${posted.entryNo} — ${data.narration}`,
        newValues: { entryDate: data.entryDate, lines: data.lines },
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
    }

    return reply.status(posted.alreadyPosted ? 200 : 201).send(posted);
  });

  /* -------------------------------------------------------------- reversal */

  app.post('/api/finance/journal/:id/reverse', { preHandler: requirePermission('journal.manual') }, async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const body = z
      .object({
        reversalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        narration: z.string().trim().min(3).optional(),
      })
      .parse(request.body ?? {});

    const reversal = await reverseJournalEntry(app.db, {
      entryId: id,
      postedBy: request.auth!.user.id,
      ...(body.reversalDate ? { reversalDate: body.reversalDate } : {}),
      ...(body.narration ? { narration: body.narration } : {}),
    });

    if (!reversal.alreadyPosted) {
      await recordActivity(app.db, {
        userId: request.auth!.user.id,
        userName: request.auth!.user.name,
        module: 'finance.journal',
        action: 'CREATE',
        recordType: 'JournalEntry',
        recordId: reversal.id,
        recordLabel: `${reversal.entryNo} — reversal of entry ${id}`,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
    }

    return reversal;
  });
};
