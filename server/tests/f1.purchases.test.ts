/**
 * F1 — recording oil coming in.
 * Done when: a purchase raises stock, raises inventory value, and creates the
 * payable — all in one transaction.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createUser, type Harness } from './helpers.ts';
import { createPurchase } from '../src/modules/purchases/purchase.service.ts';
import { toDecimal, toMinor } from '../src/lib/money.ts';
import { qtyToDecimal, qtyToMinor } from '../src/modules/inventory/stock.service.ts';

let h: Harness;
let userId: string;
let supplierId: string;
let inHouseDriverId: string;
let outsourcedDriverId: string;

const YEAR = new Date().getUTCFullYear();
const DATE = `${YEAR}-06-10`;

async function accountBalance(code: string): Promise<string> {
  const r = await h.db.query<{ debit: string; credit: string }>(
    `SELECT COALESCE(SUM(jl.debit),0) AS debit, COALESCE(SUM(jl.credit),0) AS credit
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = $1`,
    [code]
  );
  return toDecimal(toMinor(r.rows[0]!.debit) - toMinor(r.rows[0]!.credit));
}

async function stockOf(code: string): Promise<{ qty: string; value: string; avg: string }> {
  const r = await h.db.query<{ quantity: string; value: string; avg_unit_cost: string }>(
    `SELECT sb.quantity, sb.value, sb.avg_unit_cost FROM stock_balances sb
       JOIN inventory_items i ON i.id = sb.item_id WHERE i.code = $1`,
    [code]
  );
  return { qty: r.rows[0]!.quantity, value: r.rows[0]!.value, avg: r.rows[0]!.avg_unit_cost };
}

before(async () => {
  h = await createHarness();
  userId = await createUser(h.db, { name: 'Acc', email: 'acc-f1@orcms.local', roles: ['ACCOUNTANT'] });

  const s = await h.db.query<{ id: string }>(
    `INSERT INTO parties (code, type, name) VALUES ('SUP-0001','SUPPLIER','Al Noor Restaurant') RETURNING id`
  );
  supplierId = s.rows[0]!.id;

  const d1 = await h.db.query<{ id: string }>(
    `INSERT INTO drivers (code, name, driver_type) VALUES ('DRV-0001','Imran','IN_HOUSE') RETURNING id`
  );
  inHouseDriverId = d1.rows[0]!.id;

  const d2 = await h.db.query<{ id: string }>(
    `INSERT INTO drivers (code, name, driver_type) VALUES ('ODR-0001','Bilal Transport','OUTSOURCED') RETURNING id`
  );
  outsourcedDriverId = d2.rows[0]!.id;
});

after(async () => {
  await h.close();
});

describe('F1 — a purchase moves stock and money together', () => {
  test('cash purchase raises stock, inventory value and reduces cash', async () => {
    const before = await stockOf('UCO');

    const result = await createPurchase(h.db, {
      division: 'UCO',
      purchaseDate: DATE,
      source: 'WALK_IN',
      partyId: supplierId,
      drums: '10',
      ratePerDrum: '1500.00',
      cashPaid: '15000.00',
      createdBy: userId,
    });

    assert.match(result.docNo, new RegExp(`^PUR-UCO-${YEAR}-\\d{6}$`));
    assert.equal(result.totalAmount, '15000.00');
    assert.equal(result.balanceDue, '0.00');
    assert.equal(result.paymentStatus, 'PAID');

    const after = await stockOf('UCO');
    // Quantities carry 3 decimals; money carries 2. Kept apart deliberately.
    assert.equal(
      qtyToDecimal(qtyToMinor(after.qty) - qtyToMinor(before.qty)),
      '10.000',
      'stock must rise by the drums received (BR-03)'
    );
    assert.equal(after.value, '15000.00');
    assert.equal(await accountBalance('1200'), '15000.00', 'inventory account must match stock value');
    assert.equal(await accountBalance('1010'), '-15000.00', 'cash must fall');
  });

  test('credit purchase creates the payable instead of moving cash', async () => {
    const cashBefore = await accountBalance('1010');

    const result = await createPurchase(h.db, {
      division: 'UCO', purchaseDate: DATE, source: 'WALK_IN', partyId: supplierId,
      drums: '5', ratePerDrum: '1000.00', createdBy: userId,
    });

    assert.equal(result.balanceDue, '5000.00');
    assert.equal(result.paymentStatus, 'UNPAID');
    assert.equal(await accountBalance('1010'), cashBefore, 'cash must not move on a credit purchase');
    assert.equal(await accountBalance('2100'), '-5000.00', 'the payable must be raised');
  });

  test('part-paid purchase splits correctly', async () => {
    const result = await createPurchase(h.db, {
      division: 'UEO', purchaseDate: DATE, source: 'WALK_IN', partyId: supplierId,
      drums: '4', ratePerDrum: '2000.00', cashPaid: '5000.00', onlinePaid: '1000.00',
      createdBy: userId,
    });
    assert.equal(result.totalAmount, '8000.00');
    assert.equal(result.balanceDue, '2000.00');
    assert.equal(result.paymentStatus, 'PARTIAL');
  });

  test('weighted average cost is correct across mixed rates', async () => {
    // Fresh item to reason about in isolation: UEO already has 4 @ 2000.
    const before = await stockOf('UEO');
    await createPurchase(h.db, {
      division: 'UEO', purchaseDate: DATE, source: 'WALK_IN', partyId: supplierId,
      drums: '4', ratePerDrum: '3000.00', cashPaid: '12000.00', createdBy: userId,
    });
    const after = await stockOf('UEO');

    // (4 × 2000 + 4 × 3000) / 8 = 2500
    assert.equal(after.qty, '8.000');
    assert.equal(after.value, '20000.00');
    assert.equal(after.avg, '2500.0000');
    assert.notEqual(before.avg, after.avg);
  });

  test('payment cannot exceed the purchase total', async () => {
    await assert.rejects(
      () =>
        createPurchase(h.db, {
          division: 'UCO', purchaseDate: DATE, source: 'WALK_IN', partyId: supplierId,
          drums: '1', ratePerDrum: '100.00', cashPaid: '500.00', createdBy: userId,
        }),
      /cannot exceed/
    );
  });

  test('a future-dated purchase is refused', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await assert.rejects(
      () =>
        createPurchase(h.db, {
          division: 'UCO', purchaseDate: tomorrow, source: 'WALK_IN', partyId: supplierId,
          drums: '1', ratePerDrum: '100.00', createdBy: userId,
        }),
      /future/
    );
  });
});

describe('F1 — driver types behave differently, as they do in the yard', () => {
  test('an in-house driver can settle a purchase from their advance', async () => {
    // Issue an advance through the real posting engine. Note the transaction:
    // inserting the two lines as separate statements would leave the first one
    // unbalanced on its own, and BR-25 would correctly reject it.
    const { postJournalEntry } = await import('../src/modules/finance/posting.service.ts');
    const accIds = await h.db.query<{ id: number; code: string }>(
      `SELECT id, code FROM accounts WHERE code IN ('1250','1010')`
    );
    const byCode = Object.fromEntries(accIds.rows.map((r) => [r.code, Number(r.id)]));

    await postJournalEntry(h.db, {
      entryDate: DATE,
      narration: 'Advance issued to Imran',
      sourceType: 'DriverAdvance',
      sourceId: 1,
      postingKey: 'seed:adv',
      postedBy: userId,
      lines: [
        { accountId: byCode['1250']!, debit: '50000.00' },
        { accountId: byCode['1010']!, credit: '50000.00' },
      ],
    });
    await h.db.query('UPDATE drivers SET advance_balance = $2 WHERE id = $1', [inHouseDriverId, '50000.00']);

    const result = await createPurchase(h.db, {
      division: 'UCO', purchaseDate: DATE, source: 'DRIVER_COLLECTION',
      driverId: inHouseDriverId, collectionArea: 'Gulberg',
      drums: '6', ratePerDrum: '1200.00', advanceUsed: '7200.00', createdBy: userId,
    });

    assert.equal(result.paymentStatus, 'PAID');

    const drv = await h.db.query<{ advance_balance: string }>(
      'SELECT advance_balance FROM drivers WHERE id = $1',
      [inHouseDriverId]
    );
    assert.equal(drv.rows[0]!.advance_balance, '42800.00', 'the advance must be drawn down');
  });

  test('an outsourced driver cannot use an advance — they are paid per delivery', async () => {
    await assert.rejects(
      () =>
        createPurchase(h.db, {
          division: 'UCO', purchaseDate: DATE, source: 'DRIVER_COLLECTION',
          driverId: outsourcedDriverId, drums: '3', ratePerDrum: '1000.00',
          advanceUsed: '3000.00', createdBy: userId,
        }),
      /outsourced driver/i
    );
  });

  test('an advance larger than the driver holds is refused', async () => {
    await assert.rejects(
      () =>
        createPurchase(h.db, {
          division: 'UCO', purchaseDate: DATE, source: 'DRIVER_COLLECTION',
          driverId: inHouseDriverId, drums: '100', ratePerDrum: '10000.00',
          advanceUsed: '1000000.00', createdBy: userId,
        }),
      /less than/
    );
  });

  test('an outsourced driver delivering on credit raises a normal payable', async () => {
    const result = await createPurchase(h.db, {
      division: 'UEO', purchaseDate: DATE, source: 'DRIVER_COLLECTION',
      driverId: outsourcedDriverId, partyId: supplierId,
      drums: '2', ratePerDrum: '1500.00', createdBy: userId,
    });
    assert.equal(result.balanceDue, '3000.00');
  });

  test('a driver collection requires a driver', async () => {
    await assert.rejects(
      () =>
        createPurchase(h.db, {
          division: 'UCO', purchaseDate: DATE, source: 'DRIVER_COLLECTION',
          drums: '1', ratePerDrum: '100.00', createdBy: userId,
        }),
      /driver/
    );
  });
});

describe('F1 — government weight fee', () => {
  test('a refundable fee becomes a receivable, not an expense (BR-20)', async () => {
    const before = await accountBalance('1300');

    await createPurchase(h.db, {
      division: 'UCO', purchaseDate: DATE, source: 'WALK_IN', partyId: supplierId,
      drums: '2', ratePerDrum: '1000.00', cashPaid: '2000.00',
      weightFee: { feePaid: true, feeAmount: '350.00', slipNumber: 'WS-1001', refundEligible: true },
      createdBy: userId,
    });

    const after = await accountBalance('1300');
    assert.equal(
      toDecimal(toMinor(after) - toMinor(before)),
      '350.00',
      'a refundable fee is money the government owes us'
    );
  });

  test('a non-refundable fee is expensed instead', async () => {
    const before = await accountBalance('6900');
    await createPurchase(h.db, {
      division: 'UCO', purchaseDate: DATE, source: 'WALK_IN', partyId: supplierId,
      drums: '2', ratePerDrum: '1000.00', cashPaid: '2000.00',
      weightFee: { feePaid: true, feeAmount: '200.00', slipNumber: 'WS-1002', refundEligible: false },
      createdBy: userId,
    });
    const after = await accountBalance('6900');
    assert.equal(toDecimal(toMinor(after) - toMinor(before)), '200.00');
  });

  test('a slip number is mandatory when a fee is paid', async () => {
    await assert.rejects(
      () =>
        createPurchase(h.db, {
          division: 'UCO', purchaseDate: DATE, source: 'WALK_IN', partyId: supplierId,
          drums: '1', ratePerDrum: '100.00', cashPaid: '100.00',
          weightFee: { feePaid: true, feeAmount: '50.00', slipNumber: '' },
          createdBy: userId,
        }),
      /slip number/i
    );
  });
});

describe('F1 — completeness and integrity', () => {
  test('BR-22: a no-intake day is recorded with zero values', async () => {
    const result = await createPurchase(h.db, {
      division: 'UCO', purchaseDate: `${YEAR}-06-11`, source: 'WALK_IN',
      drums: 0, ratePerDrum: 0, isNoPurchase: true, createdBy: userId,
    });
    assert.equal(result.totalAmount, '0.00');
    assert.equal(result.stockAfter, null, 'a no-intake day must not move stock');
    assert.equal(result.journalEntryId, null, 'and must not post money');
  });

  test('every purchase leaves the ledger balanced', async () => {
    const r = await h.db.query<{ debit: string; credit: string }>(
      'SELECT COALESCE(SUM(debit),0) AS debit, COALESCE(SUM(credit),0) AS credit FROM journal_lines'
    );
    assert.equal(r.rows[0]!.debit, r.rows[0]!.credit, 'the whole ledger must balance (BR-25)');
  });

  test('stock value ties to the inventory control accounts (§4.11)', async () => {
    for (const [item, account] of [['UCO', '1200'], ['UEO', '1210']] as const) {
      const stock = await stockOf(item);
      assert.equal(
        stock.value,
        await accountBalance(account),
        `${item} stock value must equal account ${account}`
      );
    }
  });

  test('a failed purchase leaves neither stock nor money behind', async () => {
    const stockBefore = await stockOf('UCO');
    const cashBefore = await accountBalance('1010');

    await assert.rejects(() =>
      createPurchase(h.db, {
        division: 'UCO', purchaseDate: DATE, source: 'WALK_IN', partyId: supplierId,
        drums: '5', ratePerDrum: '1000.00', cashPaid: '99999.00', createdBy: userId,
      })
    );

    assert.deepEqual(await stockOf('UCO'), stockBefore, 'stock must be untouched');
    assert.equal(await accountBalance('1010'), cashBefore, 'cash must be untouched');
  });
});
