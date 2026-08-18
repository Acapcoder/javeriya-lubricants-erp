/**
 * Recording oil coming in (features F1–F5).
 *
 * ONE service for every intake, because operationally they are one event —
 * drums arrived and we owe someone for them. What differs is only *where the
 * drums came from*:
 *
 *   DRIVER_COLLECTION   one of our drivers, or an independent one, brought them
 *   DIRECT_AGREEMENT    collected under a standing contract with a company
 *   WALK_IN             a supplier delivered to the yard directly
 *
 * and *how they were paid for*: cash, bank, an in-house driver's advance, or
 * on credit. Both are fields on one document, not separate document types.
 *
 * Every purchase does three things atomically:
 *   1. raises stock                        (BR-01, BR-03)
 *   2. posts the money                     (BR-25)
 *   3. records any government weight fee   (BR-20)
 */
import type { Db } from '../../db/client.ts';
import { ValidationError } from '../../lib/errors.ts';
import { abs, toDecimal, toMinor } from '../../lib/money.ts';
import { qtyToDecimal, qtyToMinor, recordMovement } from '../inventory/stock.service.ts';
import { assertRoomFor } from '../inventory/tank.service.ts';
import { postJournalEntry } from '../finance/posting.service.ts';
import { requireOpenFiscalYear } from '../finance/fiscalYear.service.ts';
import { nextDocumentNumber } from '../finance/sequence.service.ts';

export type OilType = 'UCO' | 'UEO';
export type PurchaseSource = 'DRIVER_COLLECTION' | 'DIRECT_AGREEMENT' | 'WALK_IN';

export interface WeightFeeInput {
  feePaid: boolean;
  feeAmount?: string | number;
  slipNumber?: string | null;
  attachmentId?: number | null;
  refundEligible?: boolean;
  notes?: string | null;
}

export interface CreatePurchaseInput {
  division: OilType;
  purchaseDate: string;
  source: PurchaseSource;
  partyId?: string | number | null;
  agreementId?: string | number | null;
  driverId?: string | number | null;
  collectionArea?: string | null;
  vehicleNumber?: string | null;
  /** Which tank the load went into. Checked for room before anything is written. */
  tankId?: number | null;
  drums: string | number;
  ratePerDrum: string | number;
  /** Settlement. Anything not covered by these becomes a payable. */
  cashPaid?: string | number;
  onlinePaid?: string | number;
  advanceUsed?: string | number;
  cashAccountId?: number;
  bankAccountId?: number;
  weightFee?: WeightFeeInput | null;
  referenceNo?: string | null;
  notes?: string | null;
  /** Records a day with no intake at all, keeping the daily record complete (BR-22). */
  isNoPurchase?: boolean;
  createdBy: string | number;
  /** Idempotency; generated if absent. */
  postingKey?: string;
}

export interface PurchaseResult {
  id: number;
  docNo: string;
  totalAmount: string;
  balanceDue: string;
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID';
  stockAfter: string | null;
  tankAfter: string | null;
  journalEntryId: number | null;
}

const ITEM_FOR_DIVISION: Record<OilType, string> = { UCO: 'UCO', UEO: 'UEO' };
const INVENTORY_ACCOUNT: Record<OilType, string> = { UCO: '1200', UEO: '1210' };

async function accountId(db: Db, code: string): Promise<number> {
  const res = await db.query<{ id: number }>('SELECT id FROM accounts WHERE code = $1', [code]);
  if (!res.rows[0]) throw new ValidationError(`Chart of accounts is missing account ${code}`);
  return Number(res.rows[0].id);
}

export async function createPurchase(db: Db, input: CreatePurchaseInput): Promise<PurchaseResult> {
  /* ------------------------------------------------------------ validation */

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.purchaseDate)) {
    throw new ValidationError('Purchase date must be YYYY-MM-DD');
  }
  if (input.purchaseDate > new Date().toISOString().slice(0, 10)) {
    throw new ValidationError('A purchase cannot be dated in the future');
  }

  // BR-22: a "no purchase" day is a real record with zero values.
  if (input.isNoPurchase) {
    return createNoPurchaseDay(db, input);
  }

  const drums = toMinor(input.drums);          // reused scale: 2dp is enough for drums entered here
  const rate = toMinor(input.ratePerDrum);
  if (drums <= 0n) throw new ValidationError('Enter the number of drums received');
  if (rate < 0n) throw new ValidationError('Rate cannot be negative');

  // total = drums × rate, computed exactly in minor units
  const totalMinor = (drums * rate) / 100n;

  const cash = input.cashPaid ? toMinor(input.cashPaid) : 0n;
  const online = input.onlinePaid ? toMinor(input.onlinePaid) : 0n;
  const advance = input.advanceUsed ? toMinor(input.advanceUsed) : 0n;
  const settled = cash + online + advance;

  if (settled > totalMinor) {
    throw new ValidationError(
      `Paid ${toDecimal(settled)} against a total of ${toDecimal(totalMinor)}. Payment cannot exceed the purchase value.`,
      { total: toDecimal(totalMinor), paid: toDecimal(settled) }
    );
  }
  const balance = totalMinor - settled;

  if (input.source === 'DRIVER_COLLECTION' && !input.driverId) {
    throw new ValidationError('Choose the driver who collected this oil');
  }
  if (input.source === 'DIRECT_AGREEMENT' && !input.agreementId) {
    throw new ValidationError('Choose the agreement this purchase falls under');
  }
  if (!input.partyId && input.source !== 'DRIVER_COLLECTION') {
    throw new ValidationError('Choose the supplier');
  }

  // An advance can only be drawn against an in-house driver who actually holds one.
  if (advance > 0n) {
    if (!input.driverId) throw new ValidationError('An advance can only be settled against a driver');
    const drv = await db.query<{ driver_type: string; advance_balance: string; name: string }>(
      'SELECT driver_type, advance_balance, name FROM drivers WHERE id = $1',
      [input.driverId]
    );
    const driver = drv.rows[0];
    if (!driver) throw new ValidationError('Driver not found');
    if (driver.driver_type !== 'IN_HOUSE') {
      throw new ValidationError(
        `${driver.name} is an outsourced driver. Outsourced drivers are paid for each delivery and never hold an advance.`
      );
    }
    if (toMinor(driver.advance_balance) < advance) {
      throw new ValidationError(
        `${driver.name} holds ${driver.advance_balance} in advances, which is less than the ${toDecimal(advance)} being settled.`,
        { held: driver.advance_balance, requested: toDecimal(advance) }
      );
    }
  }

  const fee = input.weightFee;
  const feeAmount = fee?.feePaid && fee.feeAmount ? toMinor(fee.feeAmount) : 0n;
  if (fee?.feePaid) {
    if (feeAmount <= 0n) throw new ValidationError('Enter the weight fee amount');
    if (!fee.slipNumber?.trim()) throw new ValidationError('A slip number is required when a weight fee is paid');
  }

  /* --------------------------------------------------------------- posting */

  return db.transaction(async (tx) => {
    const fiscalYearId = await requireOpenFiscalYear(tx, input.purchaseDate);
    const year = Number(input.purchaseDate.slice(0, 4));
    const docNo = await nextDocumentNumber(tx, `PUR-${input.division}`, year);

    const paymentStatus = balance === 0n ? 'PAID' : settled > 0n ? 'PARTIAL' : 'UNPAID';

    const inserted = await tx.query<{ id: number }>(
      `INSERT INTO purchases
         (doc_no, division, purchase_date, source, party_id, agreement_id, driver_id,
          collection_area, vehicle_number, tank_id, drums, rate_per_drum, total_amount,
          cash_paid, online_paid, advance_used, balance_due, payment_status,
          reference_no, notes, fiscal_year_id, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$22)
       RETURNING id`,
      [
        docNo, input.division, input.purchaseDate, input.source,
        input.partyId ?? null, input.agreementId ?? null, input.driverId ?? null,
        input.collectionArea ?? null, input.vehicleNumber ?? null, input.tankId ?? null,
        toDecimal(drums), toDecimal(rate), toDecimal(totalMinor),
        toDecimal(cash), toDecimal(online), toDecimal(advance), toDecimal(balance),
        paymentStatus, input.referenceNo ?? null, input.notes ?? null,
        fiscalYearId, String(input.createdBy),
      ]
    );
    const purchaseId = Number(inserted.rows[0]!.id);
    const key = input.postingKey ?? `Purchase:${purchaseId}`;

    /* ------------------------------------------------------------- stock */

    const itemRes = await tx.query<{ id: number }>('SELECT id FROM inventory_items WHERE code = $1', [
      ITEM_FOR_DIVISION[input.division],
    ]);
    const itemId = Number(itemRes.rows[0]!.id);

    // Refuse a load there is physically nowhere to put, before any of it is
    // written. The check runs inside the transaction, so two deliveries cannot
    // both be told there is room for the same space.
    let tankAfter: string | null = null;
    if (input.tankId) {
      const tank = await assertRoomFor(tx, { tankId: input.tankId, itemId, quantity: toDecimal(drums) });
      // Tank contents are a quantity (3 decimals), not money (2). Convert the
      // drum figure across scales rather than mixing the two parsers.
      tankAfter = qtyToDecimal(qtyToMinor(tank.contents) + qtyToMinor(toDecimal(drums)));
    }

    const movement = await recordMovement(tx, {
      itemId,
      movedOn: input.purchaseDate,
      direction: 1,
      quantity: toDecimal(drums),
      unitCost: toDecimal(rate),
      sourceType: 'Purchase',
      sourceId: purchaseId,
      postingKey: `${key}:stock`,
      tankId: input.tankId ?? null,
      fiscalYearId,
      createdBy: input.createdBy,
      notes: `${docNo} — ${input.division} intake`,
    });

    /* ----------------------------------------------------------- journal */

    const invAcc = await accountId(tx, INVENTORY_ACCOUNT[input.division]);
    const cashAcc = input.cashAccountId ?? (await accountId(tx, '1010'));
    const bankAcc = input.bankAccountId ?? (await accountId(tx, '1020'));
    const apAcc = await accountId(tx, '2100');
    const advAcc = await accountId(tx, '1250');

    const lines = [{ accountId: invAcc, debit: toDecimal(totalMinor), division: input.division, memo: `${docNo} intake` }];
    if (cash > 0n) lines.push({ accountId: cashAcc, credit: toDecimal(cash) } as never);
    if (online > 0n) lines.push({ accountId: bankAcc, credit: toDecimal(online) } as never);
    if (advance > 0n) lines.push({ accountId: advAcc, credit: toDecimal(advance) } as never);
    if (balance > 0n) {
      lines.push({
        accountId: apAcc,
        credit: toDecimal(balance),
        partyId: input.partyId ?? null,
      } as never);
    }

    const entry = await postJournalEntry(tx, {
      entryDate: input.purchaseDate,
      narration: `${docNo} — purchase of ${toDecimal(drums)} drums ${input.division}`,
      sourceType: 'Purchase',
      sourceId: purchaseId,
      postingKey: key,
      postedBy: input.createdBy,
      series: 'JE',
      lines,
    });

    // Settling from an advance reduces what the driver owes us.
    if (advance > 0n && input.driverId) {
      await tx.query('UPDATE drivers SET advance_balance = advance_balance - $2 WHERE id = $1', [
        input.driverId,
        toDecimal(advance),
      ]);
    }

    /* --------------------------------------------------------- weight fee */

    if (fee?.feePaid) {
      await tx.query(
        `INSERT INTO weight_fees
           (purchase_id, fee_paid, fee_amount, slip_number, attachment_id, refund_eligible, refund_status, notes)
         VALUES ($1, true, $2, $3, $4, $5, $6, $7)`,
        [
          purchaseId,
          toDecimal(feeAmount),
          fee.slipNumber,
          fee.attachmentId ?? null,
          fee.refundEligible ?? true,
          fee.refundEligible === false ? 'NOT_ELIGIBLE' : 'PENDING',
          fee.notes ?? null,
        ]
      );

      // Refundable fees are a receivable from the government; non-refundable
      // ones are an expense. Same cash out, very different balance sheet.
      const feeTarget = fee.refundEligible === false ? await accountId(tx, '6900') : await accountId(tx, '1300');
      await postJournalEntry(tx, {
        entryDate: input.purchaseDate,
        narration: `${docNo} — government weight fee, slip ${fee.slipNumber}`,
        sourceType: 'WeightFee',
        sourceId: purchaseId,
        postingKey: `${key}:fee`,
        postedBy: input.createdBy,
        series: 'JE',
        lines: [
          { accountId: feeTarget, debit: toDecimal(feeAmount) },
          { accountId: cashAcc, credit: toDecimal(feeAmount) },
        ],
      });
    }

    return {
      id: purchaseId,
      docNo,
      totalAmount: toDecimal(totalMinor),
      balanceDue: toDecimal(balance),
      paymentStatus,
      stockAfter: movement.quantityAfter,
      tankAfter,
      journalEntryId: entry.id,
    };
  });
}

/** BR-22 — a recorded day of no activity, so the daily record has no silent gaps. */
async function createNoPurchaseDay(db: Db, input: CreatePurchaseInput): Promise<PurchaseResult> {
  return db.transaction(async (tx) => {
    const fiscalYearId = await requireOpenFiscalYear(tx, input.purchaseDate);
    const year = Number(input.purchaseDate.slice(0, 4));
    const docNo = await nextDocumentNumber(tx, `PUR-${input.division}`, year);

    const res = await tx.query<{ id: number }>(
      `INSERT INTO purchases
         (doc_no, division, purchase_date, source, drums, rate_per_drum, total_amount,
          balance_due, payment_status, is_no_purchase, notes, fiscal_year_id, created_by, updated_by)
       VALUES ($1,$2,$3,'WALK_IN',0,0,0,0,'PAID',true,$4,$5,$6,$6)
       RETURNING id`,
      [docNo, input.division, input.purchaseDate, input.notes ?? 'No purchases recorded', fiscalYearId, String(input.createdBy)]
    );

    return {
      id: Number(res.rows[0]!.id),
      docNo,
      totalAmount: '0.00',
      balanceDue: '0.00',
      paymentStatus: 'PAID',
      stockAfter: null,
      tankAfter: null,
      journalEntryId: null,
    };
  });
}

/* ------------------------------------------------------------------ query */

export interface PurchaseListFilters {
  division?: OilType;
  source?: PurchaseSource;
  driverId?: number;
  partyId?: number;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function listPurchases(db: Db, f: PurchaseListFilters = {}) {
  const res = await db.query(
    `SELECT p.id, p.doc_no, p.division, p.purchase_date, p.source,
            p.drums, p.rate_per_drum, p.total_amount,
            p.cash_paid, p.online_paid, p.advance_used, p.balance_due, p.payment_status,
            p.is_no_purchase, p.collection_area, p.vehicle_number, p.notes,
            party.name AS party_name,
            d.name AS driver_name, d.driver_type,
            ag.agreement_no,
            wf.fee_amount, wf.slip_number, wf.refund_status
       FROM purchases p
       LEFT JOIN parties party ON party.id = p.party_id
       LEFT JOIN drivers d     ON d.id = p.driver_id
       LEFT JOIN agreements ag ON ag.id = p.agreement_id
       LEFT JOIN weight_fees wf ON wf.purchase_id = p.id
      WHERE p.deleted_at IS NULL
        AND ($1::division_t IS NULL OR p.division = $1)
        AND ($2::text IS NULL OR p.source = $2)
        AND ($3::bigint IS NULL OR p.driver_id = $3)
        AND ($4::bigint IS NULL OR p.party_id = $4)
        AND ($5::date IS NULL OR p.purchase_date >= $5)
        AND ($6::date IS NULL OR p.purchase_date <= $6)
      ORDER BY p.purchase_date DESC, p.id DESC
      LIMIT $7 OFFSET $8`,
    [
      f.division ?? null, f.source ?? null, f.driverId ?? null, f.partyId ?? null,
      f.from ?? null, f.to ?? null, f.limit ?? 50, f.offset ?? 0,
    ]
  );
  return res.rows;
}

export async function purchaseSummary(db: Db, f: PurchaseListFilters = {}) {
  const res = await db.query<{
    division: string; drums: string; total: string; outstanding: string; count: string;
  }>(
    `SELECT p.division,
            COALESCE(SUM(p.drums), 0)        AS drums,
            COALESCE(SUM(p.total_amount), 0) AS total,
            COALESCE(SUM(p.balance_due), 0)  AS outstanding,
            count(*)                          AS count
       FROM purchases p
      WHERE p.deleted_at IS NULL AND p.is_no_purchase = false
        AND ($1::date IS NULL OR p.purchase_date >= $1)
        AND ($2::date IS NULL OR p.purchase_date <= $2)
      GROUP BY p.division`,
    [f.from ?? null, f.to ?? null]
  );
  return res.rows;
}

export { abs };
