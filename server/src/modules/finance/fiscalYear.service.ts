/**
 * Fiscal year resolution and locking (feature B2).
 *
 * BR-24 / BR-28: a locked year accepts no writes at all, including reversals.
 * Corrections to a closed year post to the open year as dated adjustments.
 */
import type { Db } from '../../db/client.ts';
import { LockedError, NotFoundError, ValidationError } from '../../lib/errors.ts';

export interface FiscalYear {
  id: number;
  label: string;
  startsOn: string;
  endsOn: string;
  isLocked: boolean;
}

interface Row {
  id: number;
  label: string;
  starts_on: string | Date;
  ends_on: string | Date;
  is_locked: boolean;
}

function toIsoDate(v: string | Date): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

function map(r: Row): FiscalYear {
  return {
    id: Number(r.id),
    label: r.label,
    startsOn: toIsoDate(r.starts_on),
    endsOn: toIsoDate(r.ends_on),
    isLocked: r.is_locked,
  };
}

export async function listFiscalYears(db: Db): Promise<FiscalYear[]> {
  const res = await db.query<Row>(
    'SELECT id, label, starts_on, ends_on, is_locked FROM fiscal_years ORDER BY starts_on DESC'
  );
  return res.rows.map(map);
}

export async function findFiscalYearFor(db: Db, date: string): Promise<FiscalYear | null> {
  const res = await db.query<Row>(
    `SELECT id, label, starts_on, ends_on, is_locked
       FROM fiscal_years WHERE $1::date BETWEEN starts_on AND ends_on`,
    [date]
  );
  const row = res.rows[0];
  return row ? map(row) : null;
}

/**
 * Resolves the fiscal year a posting belongs to, refusing if it is missing or
 * locked. Distinct error types on purpose: a missing year is a setup problem
 * (422), a locked year is a policy refusal (423).
 */
export async function requireOpenFiscalYear(db: Db, date: string): Promise<number> {
  const year = await findFiscalYearFor(db, date);
  if (!year) {
    throw new ValidationError(`No financial year covers ${date}. Create one before posting to that date.`, { date });
  }
  if (year.isLocked) {
    throw new LockedError(
      `The ${year.label} financial year is closed. Post a dated adjustment in the open year instead (BR-24).`,
      { date, fiscalYear: year.label }
    );
  }
  return year.id;
}

export async function setFiscalYearLock(
  db: Db,
  args: { id: number; locked: boolean; userId: string }
): Promise<FiscalYear> {
  const res = await db.query<Row>(
    `UPDATE fiscal_years
        SET is_locked = $2,
            locked_at = CASE WHEN $2 THEN now() ELSE NULL END,
            locked_by = CASE WHEN $2 THEN $3::bigint ELSE NULL END
      WHERE id = $1
      RETURNING id, label, starts_on, ends_on, is_locked`,
    [args.id, args.locked, args.userId]
  );
  const row = res.rows[0];
  if (!row) throw new NotFoundError('Financial year not found');
  return map(row);
}

export async function createFiscalYear(
  db: Db,
  args: { label: string; startsOn: string; endsOn: string }
): Promise<FiscalYear> {
  if (args.endsOn <= args.startsOn) {
    throw new ValidationError('The year must end after it starts');
  }

  // Overlapping years would make a posting date resolve to two of them.
  const overlap = await db.query<{ label: string }>(
    `SELECT label FROM fiscal_years
      WHERE daterange(starts_on, ends_on, '[]') && daterange($1::date, $2::date, '[]')`,
    [args.startsOn, args.endsOn]
  );
  if (overlap.rows[0]) {
    throw new ValidationError(`That range overlaps the ${overlap.rows[0].label} financial year.`);
  }

  const res = await db.query<Row>(
    `INSERT INTO fiscal_years (label, starts_on, ends_on)
     VALUES ($1, $2, $3) RETURNING id, label, starts_on, ends_on, is_locked`,
    [args.label, args.startsOn, args.endsOn]
  );
  return map(res.rows[0]!);
}
