/**
 * Storage tanks.
 *
 * A tank's contents are derived from stock_movements, exactly like every other
 * balance in this system. There is no stored "current level" that could drift
 * away from the movements behind it.
 *
 * The one thing tanks add that item-level stock cannot answer: whether there is
 * physically room for an incoming load.
 */
import type { Db } from '../../db/client.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.ts';
import { qtyToDecimal, qtyToMinor } from './stock.service.ts';

export interface Tank {
  id: number;
  code: string;
  name: string;
  itemId: number;
  itemCode: string;
  itemName: string;
  capacity: string;
  deadStock: string;
  location: string | null;
  status: string;
  notes: string | null;
  /** Derived from the movement ledger. */
  contents: string;
  available: string;
  usablePercent: number;
}

interface Row {
  id: number;
  code: string;
  name: string;
  item_id: number;
  item_code: string;
  item_name: string;
  capacity_drums: string;
  dead_stock: string;
  location: string | null;
  status: string;
  notes: string | null;
  contents: string;
}

function map(r: Row): Tank {
  const capacity = qtyToMinor(r.capacity_drums);
  const contents = qtyToMinor(r.contents ?? '0');
  const available = capacity - contents;

  return {
    id: Number(r.id),
    code: r.code,
    name: r.name,
    itemId: Number(r.item_id),
    itemCode: r.item_code,
    itemName: r.item_name,
    capacity: qtyToDecimal(capacity),
    deadStock: r.dead_stock,
    location: r.location,
    status: r.status,
    notes: r.notes,
    contents: qtyToDecimal(contents),
    available: qtyToDecimal(available < 0n ? 0n : available),
    usablePercent: capacity === 0n ? 0 : Math.round((Number(contents) / Number(capacity)) * 100),
  };
}

const SELECT = `
  SELECT t.id, t.code, t.name, t.item_id, i.code AS item_code, i.name AS item_name,
         t.capacity_drums, t.dead_stock, t.location, t.status, t.notes,
         COALESCE((
           SELECT SUM(sm.direction * sm.quantity)
             FROM stock_movements sm WHERE sm.tank_id = t.id
         ), 0) AS contents
    FROM tanks t JOIN inventory_items i ON i.id = t.item_id
   WHERE t.deleted_at IS NULL`;

export async function listTanks(db: Db, itemId?: number): Promise<Tank[]> {
  const res = await db.query<Row>(`${SELECT} AND ($1::smallint IS NULL OR t.item_id = $1) ORDER BY t.code`, [
    itemId ?? null,
  ]);
  return res.rows.map(map);
}

export async function getTank(db: Db, id: number): Promise<Tank> {
  const res = await db.query<Row>(`${SELECT} AND t.id = $1`, [id]);
  if (!res.rows[0]) throw new NotFoundError('Tank not found');
  return map(res.rows[0]);
}

export interface TankInput {
  code: string;
  name: string;
  itemId: number;
  capacity: string | number;
  deadStock?: string | number;
  location?: string | null;
  status?: string;
  notes?: string | null;
}

export async function createTank(db: Db, input: TankInput, userId: string): Promise<Tank> {
  const capacity = qtyToMinor(input.capacity);
  const dead = qtyToMinor(input.deadStock ?? 0);
  if (capacity <= 0n) throw new ValidationError('Capacity must be more than zero');
  if (dead >= capacity) throw new ValidationError('Unusable bottom stock cannot be as large as the tank');

  try {
    const res = await db.query<{ id: number }>(
      `INSERT INTO tanks (code, name, item_id, capacity_drums, dead_stock, location, status, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
      [
        input.code.trim(), input.name.trim(), input.itemId,
        qtyToDecimal(capacity), qtyToDecimal(dead),
        input.location ?? null, input.status ?? 'ACTIVE', input.notes ?? null, userId,
      ]
    );
    return getTank(db, Number(res.rows[0]!.id));
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new ConflictError(`Tank code ${input.code} is already in use`);
    }
    throw err;
  }
}

export async function updateTank(
  db: Db,
  id: number,
  input: Partial<TankInput>,
  userId: string
): Promise<Tank> {
  const current = await getTank(db, id);

  // Shrinking a tank below what is already in it would make the books describe
  // something physically impossible.
  if (input.capacity !== undefined) {
    const newCapacity = qtyToMinor(input.capacity);
    if (newCapacity < qtyToMinor(current.contents)) {
      throw new ValidationError(
        `${current.name} currently holds ${current.contents} drums, so its capacity cannot be set below that.`,
        { contents: current.contents, requested: qtyToDecimal(newCapacity) }
      );
    }
  }

  // A tank cannot change what it holds while it holds something.
  if (input.itemId !== undefined && input.itemId !== current.itemId && qtyToMinor(current.contents) !== 0n) {
    throw new ValidationError(
      `${current.name} is not empty. Empty it before changing what it stores, or the two materials would be mixed in the books.`
    );
  }

  await db.query(
    `UPDATE tanks
        SET code = COALESCE($2, code), name = COALESCE($3, name),
            item_id = COALESCE($4, item_id), capacity_drums = COALESCE($5, capacity_drums),
            dead_stock = COALESCE($6, dead_stock), location = COALESCE($7, location),
            status = COALESCE($8, status), notes = COALESCE($9, notes),
            updated_by = $10, updated_at = now(), version = version + 1
      WHERE id = $1`,
    [
      id,
      input.code ?? null, input.name ?? null, input.itemId ?? null,
      input.capacity === undefined ? null : qtyToDecimal(qtyToMinor(input.capacity)),
      input.deadStock === undefined ? null : qtyToDecimal(qtyToMinor(input.deadStock)),
      input.location ?? null, input.status ?? null, input.notes ?? null, userId,
    ]
  );
  return getTank(db, id);
}

/**
 * Checks a tank can take a load, and explains itself when it cannot.
 *
 * Called before a purchase is accepted. Returns the tank so the caller does not
 * have to fetch it twice.
 */
export async function assertRoomFor(
  db: Db,
  args: { tankId: number; itemId: number; quantity: string | number }
): Promise<Tank> {
  const tank = await getTank(db, args.tankId);

  if (tank.status !== 'ACTIVE') {
    throw new ValidationError(`${tank.name} is marked ${tank.status.toLowerCase()} and cannot take a delivery.`);
  }
  if (tank.itemId !== args.itemId) {
    throw new ValidationError(
      `${tank.name} stores ${tank.itemName}. This load is a different material, so it needs another tank.`
    );
  }

  const wanted = qtyToMinor(args.quantity);
  const available = qtyToMinor(tank.available);
  if (wanted > available) {
    throw new ValidationError(
      `${tank.name} has room for ${tank.available} drums, and this load is ${qtyToDecimal(wanted)}. Split it across tanks or free up space first.`,
      { tank: tank.name, available: tank.available, requested: qtyToDecimal(wanted) }
    );
  }
  return tank;
}

/** Checks a tank actually holds what is being taken out. */
export async function assertHolds(
  db: Db,
  args: { tankId: number; itemId: number; quantity: string | number }
): Promise<Tank> {
  const tank = await getTank(db, args.tankId);
  if (tank.itemId !== args.itemId) {
    throw new ValidationError(`${tank.name} does not store ${args.itemId === tank.itemId ? '' : 'this material'}.`);
  }

  const wanted = qtyToMinor(args.quantity);
  if (wanted > qtyToMinor(tank.contents)) {
    throw new ValidationError(
      `${tank.name} holds ${tank.contents} drums, which is less than the ${qtyToDecimal(wanted)} being taken out.`,
      { tank: tank.name, contents: tank.contents, requested: qtyToDecimal(wanted) }
    );
  }
  return tank;
}

/** Recent movements in and out of one tank. */
export async function tankMovements(db: Db, tankId: number, limit = 50) {
  const res = await db.query(
    `SELECT sm.id, sm.moved_on AS "movedOn", sm.direction, sm.quantity,
            sm.balance_after AS "itemBalanceAfter", sm.source_type AS "sourceType",
            sm.source_id AS "sourceId", sm.notes, u.name AS "byName"
       FROM stock_movements sm JOIN users u ON u.id = sm.created_by
      WHERE sm.tank_id = $1
      ORDER BY sm.moved_on DESC, sm.id DESC LIMIT $2`,
    [tankId, limit]
  );
  return res.rows;
}

/**
 * Records a physical dip and the difference against the books.
 *
 * Deliberately does not move stock. A reading is evidence; correcting the books
 * is a separate, permissioned decision that posts a stock adjustment so it
 * lands in the ledger like everything else.
 */
export async function recordReading(
  db: Db,
  args: { tankId: number; readOn: string; measured: string | number; notes?: string | null; userId: string }
) {
  const tank = await getTank(db, args.tankId);
  const measured = qtyToMinor(args.measured);
  const book = qtyToMinor(tank.contents);

  const res = await db.query<{ id: string }>(
    `INSERT INTO tank_readings (tank_id, read_on, measured, book_quantity, difference, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      args.tankId, args.readOn, qtyToDecimal(measured), qtyToDecimal(book),
      qtyToDecimal(measured - book), args.notes ?? null, args.userId,
    ]
  );

  return {
    id: res.rows[0]!.id,
    tank: tank.name,
    measured: qtyToDecimal(measured),
    book: qtyToDecimal(book),
    difference: qtyToDecimal(measured - book),
  };
}

export async function tankReadings(db: Db, tankId: number, limit = 20) {
  const res = await db.query(
    `SELECT id, read_on AS "readOn", measured, book_quantity AS "book",
            difference, notes, adjusted
       FROM tank_readings WHERE tank_id = $1 ORDER BY read_on DESC, id DESC LIMIT $2`,
    [tankId, limit]
  );
  return res.rows;
}
