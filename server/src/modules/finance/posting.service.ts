/**
 * The posting engine (feature B4).
 *
 * This is the single choke point through which every document reaches the
 * financial ledger — see FLOWS.md Part 3. Nothing else in the codebase may
 * INSERT into journal_entries or journal_lines.
 *
 * Guarantees:
 *   BR-25  entries balance — checked here in exact minor units, and again by
 *          the je_must_balance database trigger, which is the real authority
 *   BR-26  a posting_key posts at most once, however often it is retried
 *   BR-24  a locked financial year accepts nothing, including reversals
 *
 * Every check runs INSIDE the transaction. Validating first and inserting
 * afterwards leaves a window where the year is locked, or a concurrent retry
 * posts, between the two.
 */
import type { Db } from '../../db/client.ts';
import { ConflictError, ValidationError } from '../../lib/errors.ts';
import { abs, toDecimal, toMinor } from '../../lib/money.ts';
import { requireOpenFiscalYear } from './fiscalYear.service.ts';
import { nextDocumentNumber } from './sequence.service.ts';

export interface PostLine {
  accountId: number;
  /** Decimal strings preferred. Exactly one of debit/credit must be non-zero. */
  debit?: string | number | null;
  credit?: string | number | null;
  partyId?: string | number | null;
  division?: 'UCO' | 'UEO' | null;
  memo?: string | null;
}

export interface PostRequest {
  entryDate: string;
  narration?: string | null;
  sourceType: string;
  sourceId: number | string;
  /** Idempotency key. Same key twice returns the first entry (BR-26). */
  postingKey: string;
  isManual?: boolean;
  postedBy: string | number;
  lines: PostLine[];
  /** Numbering series; defaults to JE for machine postings, JV for manual. */
  series?: string;
}

export interface PostedEntry {
  id: number;
  entryNo: string;
  entryDate: string;
  alreadyPosted: boolean;
}

interface NormalLine {
  accountId: number;
  debitMinor: bigint;
  creditMinor: bigint;
  partyId: string | null;
  division: string | null;
  memo: string | null;
}

function normalise(lines: PostLine[]): NormalLine[] {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new ValidationError('A journal entry needs at least two lines');
  }

  const out: NormalLine[] = [];
  lines.forEach((line, i) => {
    const debitMinor = line.debit == null || line.debit === '' ? 0n : toMinor(line.debit);
    const creditMinor = line.credit == null || line.credit === '' ? 0n : toMinor(line.credit);

    if (debitMinor < 0n || creditMinor < 0n) {
      throw new ValidationError(`Line ${i + 1}: amounts cannot be negative. Swap debit and credit instead.`);
    }
    if (debitMinor === 0n && creditMinor === 0n) {
      throw new ValidationError(`Line ${i + 1}: needs a debit or a credit`);
    }
    if (debitMinor > 0n && creditMinor > 0n) {
      throw new ValidationError(`Line ${i + 1}: a line is either a debit or a credit, never both`);
    }
    if (!Number.isFinite(Number(line.accountId))) {
      throw new ValidationError(`Line ${i + 1}: an account is required`);
    }

    out.push({
      accountId: Number(line.accountId),
      debitMinor,
      creditMinor,
      partyId: line.partyId == null ? null : String(line.partyId),
      division: line.division ?? null,
      memo: line.memo ?? null,
    });
  });

  return out;
}

/** BR-25, in exact minor units. No tolerance — a ledger balances or it does not. */
function assertBalanced(lines: NormalLine[]): void {
  let debit = 0n;
  let credit = 0n;
  for (const l of lines) {
    debit += l.debitMinor;
    credit += l.creditMinor;
  }
  if (debit !== credit) {
    const diff = abs(debit - credit);
    throw new ValidationError(
      `Entry is out of balance by ${toDecimal(diff)}. Debits total ${toDecimal(debit)}, credits total ${toDecimal(credit)} (BR-25).`,
      { debit: toDecimal(debit), credit: toDecimal(credit), difference: toDecimal(diff) }
    );
  }
  if (debit === 0n) {
    throw new ValidationError('An entry of zero has nothing to post');
  }
}

export async function postJournalEntry(db: Db, req: PostRequest): Promise<PostedEntry> {
  const lines = normalise(req.lines);
  assertBalanced(lines);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.entryDate)) {
    throw new ValidationError(`Entry date must be YYYY-MM-DD, got "${req.entryDate}"`);
  }

  return db.transaction(async (tx) => {
    // Idempotency first, inside the transaction (BR-26). A retried request
    // returns the original entry rather than posting a second one.
    const existing = await tx.query<{ id: number; entry_no: string; entry_date: string | Date }>(
      'SELECT id, entry_no, entry_date FROM journal_entries WHERE posting_key = $1',
      [req.postingKey]
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      return {
        id: Number(row.id),
        entryNo: row.entry_no,
        entryDate: row.entry_date instanceof Date ? row.entry_date.toISOString().slice(0, 10) : String(row.entry_date),
        alreadyPosted: true,
      };
    }

    const fiscalYearId = await requireOpenFiscalYear(tx, req.entryDate);

    const year = Number(req.entryDate.slice(0, 4));
    const series = req.series ?? (req.isManual ? 'JV' : 'JE');
    const entryNo = await nextDocumentNumber(tx, series, year);

    const entry = await tx.query<{ id: number }>(
      `INSERT INTO journal_entries
         (entry_no, entry_date, narration, source_type, source_id,
          posting_key, is_manual, fiscal_year_id, posted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        entryNo,
        req.entryDate,
        req.narration ?? null,
        req.sourceType,
        String(req.sourceId),
        req.postingKey,
        req.isManual ?? false,
        fiscalYearId,
        String(req.postedBy),
      ]
    );
    const entryId = Number(entry.rows[0]!.id);

    for (const line of lines) {
      await tx.query(
        `INSERT INTO journal_lines
           (entry_id, entry_date, account_id, debit, credit, party_id, division, memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          entryId,
          req.entryDate,
          line.accountId,
          toDecimal(line.debitMinor),
          toDecimal(line.creditMinor),
          line.partyId,
          line.division,
          line.memo,
        ]
      );
    }

    return { id: entryId, entryNo, entryDate: req.entryDate, alreadyPosted: false };
  });
}

/**
 * Reverses an entry by posting its mirror image. The original is never edited
 * or deleted — that is the whole point of an append-only ledger (BR-19).
 */
export async function reverseJournalEntry(
  db: Db,
  args: { entryId: number; postedBy: string | number; reversalDate?: string; narration?: string }
): Promise<PostedEntry> {
  return db.transaction(async (tx) => {
    const original = await tx.query<{
      id: number;
      entry_no: string;
      entry_date: string | Date;
      source_type: string;
      source_id: string;
      is_manual: boolean;
      posting_key: string;
    }>(
      `SELECT id, entry_no, entry_date, source_type, source_id, is_manual, posting_key
         FROM journal_entries WHERE id = $1`,
      [args.entryId]
    );
    const entry = original.rows[0];
    if (!entry) throw new ValidationError('Journal entry not found');

    // An entry can be reversed at most once (unique index je_reversal_once_idx).
    const already = await tx.query<{ id: number; entry_no: string; entry_date: string | Date }>(
      'SELECT id, entry_no, entry_date FROM journal_entries WHERE is_reversal_of = $1',
      [args.entryId]
    );
    if (already.rows[0]) {
      const row = already.rows[0];
      return {
        id: Number(row.id),
        entryNo: row.entry_no,
        entryDate: row.entry_date instanceof Date ? row.entry_date.toISOString().slice(0, 10) : String(row.entry_date),
        alreadyPosted: true,
      };
    }

    const originalDate =
      entry.entry_date instanceof Date ? entry.entry_date.toISOString().slice(0, 10) : String(entry.entry_date).slice(0, 10);
    const reversalDate = args.reversalDate ?? originalDate;

    // BR-28: if the original year is closed, the reversal must be dated into an
    // open one. requireOpenFiscalYear raises a LockedError that says so.
    const fiscalYearId = await requireOpenFiscalYear(tx, reversalDate);

    const lines = await tx.query<{
      account_id: number;
      debit: string;
      credit: string;
      party_id: string | null;
      division: string | null;
      memo: string | null;
    }>(
      `SELECT account_id, debit, credit, party_id, division, memo
         FROM journal_lines WHERE entry_id = $1 ORDER BY id`,
      [args.entryId]
    );
    if (lines.rows.length === 0) throw new ConflictError('That entry has no lines to reverse');

    const year = Number(reversalDate.slice(0, 4));
    const entryNo = await nextDocumentNumber(tx, 'REV', year);

    const revEntry = await tx.query<{ id: number }>(
      `INSERT INTO journal_entries
         (entry_no, entry_date, narration, source_type, source_id,
          posting_key, is_manual, fiscal_year_id, posted_by, is_reversal_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        entryNo,
        reversalDate,
        args.narration ?? `Reversal of ${entry.entry_no}`,
        entry.source_type,
        entry.source_id,
        `reversal:${entry.posting_key}`,
        entry.is_manual,
        fiscalYearId,
        String(args.postedBy),
        args.entryId,
      ]
    );
    const revId = Number(revEntry.rows[0]!.id);

    for (const line of lines.rows) {
      // Debit and credit swapped: that is the reversal.
      await tx.query(
        `INSERT INTO journal_lines
           (entry_id, entry_date, account_id, debit, credit, party_id, division, memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [revId, reversalDate, line.account_id, line.credit, line.debit, line.party_id, line.division, line.memo]
      );
    }

    return { id: revId, entryNo, entryDate: reversalDate, alreadyPosted: false };
  });
}
