/**
 * The stock ledger (features C2, C3).
 *
 * The second of the two authoritative stores. Like the financial ledger, it is
 * append-only: `stock_movements` is never updated, and `stock_balances` is a
 * cache reconciled against it (§4.11).
 *
 * Concurrency (§4.4.1): every write takes `SELECT … FOR UPDATE` on the item's
 * balance row *before* doing anything else, and multi-item operations lock in
 * ascending item_id order. A weighted average is order-dependent, so two
 * unserialised movements on one item produce a wrong average, not just a
 * wrong-looking one.
 *
 * Must be called inside a transaction — the caller owns the transaction so the
 * stock movement and its journal entry commit together or not at all.
 */
import type { Db } from '../../db/client.ts';
import { ValidationError } from '../../lib/errors.ts';
import { toDecimal, toMinor } from '../../lib/money.ts';

export interface ItemRef {
  id: number;
  code: string;
  name: string;
  isValued: boolean;
  accountId: number | null;
}

export interface MoveIn {
  itemId: number;
  movedOn: string;
  /** Drums. Always positive; `direction` decides the sign. */
  quantity: string | number;
  direction: 1 | -1;
  /** Cost per drum for inbound movements. Outbound is costed at the running average. */
  unitCost?: string | number;
  sourceType: string;
  sourceId: number | string;
  postingKey: string;
  fiscalYearId: number;
  createdBy: string | number;
  notes?: string | null;
  tankId?: number | null;
}

export interface MovementResult {
  movementId: number;
  quantityAfter: string;
  unitCost: string;
  value: string;
  avgUnitCostAfter: string;
}

/** Quantities carry 3 decimals; money carries 2. Kept separate on purpose. */
const QTY_SCALE = 1000n;

function qtyToMinor(v: string | number): bigint {
  const text = typeof v === 'number' ? v.toFixed(3) : String(v).trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m) throw new ValidationError(`Not a valid quantity: ${v}`);
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = m[2] || '0';
  const frac = (m[3] ?? '').slice(0, 3).padEnd(3, '0');
  return sign * (BigInt(whole) * QTY_SCALE + BigInt(frac));
}

function qtyToDecimal(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  return `${neg ? '-' : ''}${abs / QTY_SCALE}.${(abs % QTY_SCALE).toString().padStart(3, '0')}`;
}

export async function getItemByCode(db: Db, code: string): Promise<ItemRef> {
  const res = await db.query<{ id: number; code: string; name: string; is_valued: boolean; account_id: number | null }>(
    'SELECT id, code, name, is_valued, account_id FROM inventory_items WHERE code = $1',
    [code]
  );
  const row = res.rows[0];
  if (!row) throw new ValidationError(`Unknown inventory item: ${code}`);
  return {
    id: Number(row.id),
    code: row.code,
    name: row.name,
    isValued: row.is_valued,
    accountId: row.account_id === null ? null : Number(row.account_id),
  };
}

/**
 * Records one stock movement and updates the balance cache.
 *
 * Inbound: new average = (old_qty * old_avg + in_qty * in_cost) / (old_qty + in_qty)
 * Outbound: costed at the average at the time of the movement; that cost is the
 *           COGS the caller should post.
 */
export async function recordMovement(tx: Db, move: MoveIn): Promise<MovementResult> {
  const qty = qtyToMinor(move.quantity);
  if (qty <= 0n) throw new ValidationError('Quantity must be greater than zero');

  // Idempotency (BR-26) — a retried request must not move stock twice.
  const existing = await tx.query<{ id: number; balance_after: string; unit_cost: string; value: string }>(
    'SELECT id, balance_after, unit_cost, value FROM stock_movements WHERE posting_key = $1',
    [move.postingKey]
  );
  if (existing.rows[0]) {
    const r = existing.rows[0];
    const bal = await tx.query<{ avg_unit_cost: string }>(
      'SELECT avg_unit_cost FROM stock_balances WHERE item_id = $1',
      [move.itemId]
    );
    return {
      movementId: Number(r.id),
      quantityAfter: r.balance_after,
      unitCost: r.unit_cost,
      value: r.value,
      avgUnitCostAfter: bal.rows[0]?.avg_unit_cost ?? '0.0000',
    };
  }

  // THE lock. Everything after this is serialised per item.
  const locked = await tx.query<{ quantity: string; value: string; avg_unit_cost: string }>(
    'SELECT quantity, value, avg_unit_cost FROM stock_balances WHERE item_id = $1 FOR UPDATE',
    [move.itemId]
  );
  if (!locked.rows[0]) throw new ValidationError(`No stock balance row for item ${move.itemId}`);

  const oldQty = qtyToMinor(locked.rows[0].quantity);
  const oldValue = toMinor(locked.rows[0].value);

  let unitCostMinor: bigint;
  let newQty: bigint;
  let newValue: bigint;

  if (move.direction === 1) {
    // Inbound at the stated cost.
    unitCostMinor = move.unitCost === undefined ? 0n : toMinor(move.unitCost);
    const lineValue = (qty * unitCostMinor) / QTY_SCALE;
    newQty = oldQty + qty;
    newValue = oldValue + lineValue;
  } else {
    // Outbound at the current weighted average.
    const avgMinor = oldQty === 0n ? 0n : (oldValue * QTY_SCALE) / oldQty;
    unitCostMinor = avgMinor;
    newQty = oldQty - qty;
    // Take value proportionally so rounding cannot strand a residue when the
    // last drum leaves.
    const lineValue = newQty === 0n ? oldValue : (qty * avgMinor) / QTY_SCALE;
    newValue = oldValue - lineValue;
    if (newValue < 0n) newValue = 0n;
  }

  const lineValueMinor = move.direction === 1 ? newValue - oldValue : oldValue - newValue;
  const newAvg = newQty === 0n ? 0n : (newValue * QTY_SCALE) / newQty;

  const inserted = await tx.query<{ id: number }>(
    `INSERT INTO stock_movements
       (item_id, moved_on, direction, quantity, unit_cost, value,
        source_type, source_id, posting_key, balance_after, fiscal_year_id, created_by, notes, tank_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      move.itemId,
      move.movedOn,
      move.direction,
      qtyToDecimal(qty),
      toDecimal(unitCostMinor),
      toDecimal(lineValueMinor),
      move.sourceType,
      String(move.sourceId),
      move.postingKey,
      qtyToDecimal(newQty),
      move.fiscalYearId,
      String(move.createdBy),
      move.notes ?? null,
      move.tankId ?? null,
    ]
  );

  await tx.query(
    `UPDATE stock_balances
        SET quantity = $2, value = $3, avg_unit_cost = $4, updated_at = now()
      WHERE item_id = $1`,
    [move.itemId, qtyToDecimal(newQty), toDecimal(newValue), toDecimal(newAvg)]
  );

  return {
    movementId: Number(inserted.rows[0]!.id),
    quantityAfter: qtyToDecimal(newQty),
    unitCost: toDecimal(unitCostMinor),
    value: toDecimal(lineValueMinor),
    avgUnitCostAfter: toDecimal(newAvg),
  };
}

export interface StockBalance {
  itemId: number;
  code: string;
  name: string;
  division: string;
  uom: string;
  quantity: string;
  value: string;
  avgUnitCost: string;
  lowThreshold: string;
  isLow: boolean;
}

export async function listBalances(db: Db): Promise<StockBalance[]> {
  const res = await db.query<{
    item_id: number; code: string; name: string; division: string; uom: string;
    quantity: string; value: string; avg_unit_cost: string; low_threshold: string;
  }>(
    `SELECT sb.item_id, i.code, i.name, i.division, i.uom,
            sb.quantity, sb.value, sb.avg_unit_cost, i.low_threshold
       FROM stock_balances sb JOIN inventory_items i ON i.id = sb.item_id
      ORDER BY i.id`
  );
  return res.rows.map((r) => ({
    itemId: Number(r.item_id),
    code: r.code,
    name: r.name,
    division: r.division,
    uom: r.uom,
    quantity: r.quantity,
    value: r.value,
    avgUnitCost: r.avg_unit_cost,
    lowThreshold: r.low_threshold,
    isLow: qtyToMinor(r.quantity) < qtyToMinor(r.low_threshold),
  }));
}

/** Available quantity for the soft warning on sales (BR-17). */
export async function availableQuantity(db: Db, itemId: number): Promise<string> {
  const res = await db.query<{ quantity: string }>('SELECT quantity FROM stock_balances WHERE item_id = $1', [itemId]);
  return res.rows[0]?.quantity ?? '0.000';
}

export { qtyToDecimal, qtyToMinor };
