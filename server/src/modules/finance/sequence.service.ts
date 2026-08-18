/**
 * Document numbering (feature E1).
 *
 * Gap-free, per series per year. The counter row is locked FOR UPDATE, so two
 * concurrent posts can never take the same number — which counting existing
 * rows cannot guarantee, and which soft deletes break outright.
 *
 * Must be called inside the same transaction as the document insert, so a
 * rolled-back document releases its number instead of burning it.
 */
import type { Db } from '../../db/client.ts';

export async function nextDocumentNumber(
  tx: Db,
  series: string,
  year: number,
  width = 6
): Promise<string> {
  await tx.query(
    `INSERT INTO document_sequences (series, year, next_value)
     VALUES ($1, $2, 1) ON CONFLICT (series, year) DO NOTHING`,
    [series, year]
  );

  const res = await tx.query<{ next_value: number }>(
    `UPDATE document_sequences
        SET next_value = next_value + 1
      WHERE series = $1 AND year = $2
      RETURNING next_value - 1 AS next_value`,
    [series, year]
  );

  const n = Number(res.rows[0]!.next_value);
  return `${series}-${year}-${String(n).padStart(width, '0')}`;
}
