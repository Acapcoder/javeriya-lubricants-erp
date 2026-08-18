/**
 * B4 — the posting engine.
 * Done when: an unbalanced entry is rejected by the database; a retried post
 * creates one entry.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createUser, type Harness } from './helpers.ts';
import { postJournalEntry, reverseJournalEntry } from '../src/modules/finance/posting.service.ts';
import { ValidationError, LockedError } from '../src/lib/errors.ts';
import { toDecimal, toMinor } from '../src/lib/money.ts';

let h: Harness;
let userId: string;
const acc: Record<string, number> = {};

/** The seeded financial year is the current calendar year. */
const YEAR = new Date().getUTCFullYear();
const DATE = `${YEAR}-06-15`;

before(async () => {
  h = await createHarness();
  userId = await createUser(h.db, { name: 'Poster', email: 'poster@orcms.local', roles: ['ACCOUNTANT'] });

  // Look accounts up by code — hardcoded ids break the moment the chart changes.
  const res = await h.db.query<{ id: number; code: string }>('SELECT id, code FROM accounts');
  for (const r of res.rows) acc[r.code] = Number(r.id);
});

after(async () => {
  await h.close();
});

describe('B4 — posting', () => {
  test('posts a balanced entry and returns a generated number', async () => {
    const posted = await postJournalEntry(h.db, {
      entryDate: DATE,
      narration: 'Cash sale',
      sourceType: 'Test',
      sourceId: 1,
      postingKey: 'test:balanced:1',
      postedBy: userId,
      lines: [
        { accountId: acc['1010']!, debit: '100.00' },
        { accountId: acc['4100']!, credit: '100.00', division: 'UCO' },
      ],
    });

    assert.ok(posted.id > 0);
    assert.match(posted.entryNo, new RegExp(`^JE-${YEAR}-\\d{6}$`));
    assert.equal(posted.alreadyPosted, false);

    const lines = await h.db.query<{ debit: string; credit: string }>(
      'SELECT debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY id',
      [posted.id]
    );
    assert.equal(lines.rows.length, 2);
    assert.equal(lines.rows[0]!.debit, '100.00');
    assert.equal(lines.rows[1]!.credit, '100.00');
  });

  test('numbers are sequential and gap-free within a series', async () => {
    const a = await postJournalEntry(h.db, {
      entryDate: DATE, narration: 'One', sourceType: 'Test', sourceId: 2,
      postingKey: 'test:seq:a', postedBy: userId,
      lines: [{ accountId: acc['1010']!, debit: '5.00' }, { accountId: acc['4100']!, credit: '5.00' }],
    });
    const b = await postJournalEntry(h.db, {
      entryDate: DATE, narration: 'Two', sourceType: 'Test', sourceId: 3,
      postingKey: 'test:seq:b', postedBy: userId,
      lines: [{ accountId: acc['1010']!, debit: '5.00' }, { accountId: acc['4100']!, credit: '5.00' }],
    });

    const na = Number(a.entryNo.split('-')[2]);
    const nb = Number(b.entryNo.split('-')[2]);
    assert.equal(nb, na + 1, 'numbering must not skip or repeat');
  });

  test('BR-25: an unbalanced entry is refused with the exact difference', async () => {
    await assert.rejects(
      () =>
        postJournalEntry(h.db, {
          entryDate: DATE, narration: 'Wrong', sourceType: 'Test', sourceId: 4,
          postingKey: 'test:unbalanced', postedBy: userId,
          lines: [{ accountId: acc['1010']!, debit: '100.00' }, { accountId: acc['4100']!, credit: '99.00' }],
        }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /out of balance by 1\.00/);
        return true;
      }
    );

    const check = await h.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM journal_entries WHERE posting_key = 'test:unbalanced'`
    );
    assert.equal(Number(check.rows[0]!.n), 0, 'nothing may survive a rejected post');
  });

  test('balance is checked in exact minor units, not floats', async () => {
    // 0.1 + 0.2 as floats is 0.30000000000000004; this entry balances exactly.
    const posted = await postJournalEntry(h.db, {
      entryDate: DATE, narration: 'Float trap', sourceType: 'Test', sourceId: 5,
      postingKey: 'test:floats', postedBy: userId,
      lines: [
        { accountId: acc['1010']!, debit: '0.10' },
        { accountId: acc['1011']!, debit: '0.20' },
        { accountId: acc['4100']!, credit: '0.30' },
      ],
    });
    assert.ok(posted.id > 0);
  });

  test('a one-cent imbalance on a large amount is caught — no tolerance', async () => {
    await assert.rejects(
      () =>
        postJournalEntry(h.db, {
          entryDate: DATE, narration: 'One cent', sourceType: 'Test', sourceId: 6,
          postingKey: 'test:onecent', postedBy: userId,
          lines: [{ accountId: acc['1010']!, debit: '1000000.01' }, { accountId: acc['4100']!, credit: '1000000.00' }],
        }),
      ValidationError
    );
  });

  test('BR-26: the same posting key twice yields one entry', async () => {
    const key = 'test:idempotent';
    const first = await postJournalEntry(h.db, {
      entryDate: DATE, narration: 'Once', sourceType: 'Test', sourceId: 7,
      postingKey: key, postedBy: userId,
      lines: [{ accountId: acc['1010']!, debit: '42.00' }, { accountId: acc['4100']!, credit: '42.00' }],
    });
    const second = await postJournalEntry(h.db, {
      entryDate: DATE, narration: 'Once', sourceType: 'Test', sourceId: 7,
      postingKey: key, postedBy: userId,
      lines: [{ accountId: acc['1010']!, debit: '42.00' }, { accountId: acc['4100']!, credit: '42.00' }],
    });

    assert.equal(second.id, first.id);
    assert.equal(second.alreadyPosted, true);

    const count = await h.db.query<{ n: string }>(
      'SELECT count(*) AS n FROM journal_entries WHERE posting_key = $1',
      [key]
    );
    assert.equal(Number(count.rows[0]!.n), 1);
  });

  test('rejects malformed lines before touching the database', async () => {
    const base = { entryDate: DATE, narration: 'Bad', sourceType: 'Test', sourceId: 8, postedBy: userId };

    await assert.rejects(
      () =>
        postJournalEntry(h.db, {
          ...base, postingKey: 'test:one-line',
          lines: [{ accountId: acc['1010']!, debit: '5.00' }],
        }),
      /at least two lines/
    );
    await assert.rejects(
      () =>
        postJournalEntry(h.db, {
          ...base, postingKey: 'test:both-sides',
          lines: [{ accountId: acc['1010']!, debit: '5.00', credit: '5.00' }, { accountId: acc['4100']!, credit: '5.00' }],
        }),
      /either a debit or a credit/
    );
    await assert.rejects(
      () =>
        postJournalEntry(h.db, {
          ...base, postingKey: 'test:negative',
          lines: [{ accountId: acc['1010']!, debit: '-5.00' }, { accountId: acc['4100']!, credit: '-5.00' }],
        }),
      /cannot be negative/
    );
  });

  test('rejects a date with no financial year', async () => {
    await assert.rejects(
      () =>
        postJournalEntry(h.db, {
          entryDate: '1999-01-01', narration: 'Ancient', sourceType: 'Test', sourceId: 9,
          postingKey: 'test:no-year', postedBy: userId,
          lines: [{ accountId: acc['1010']!, debit: '1.00' }, { accountId: acc['4100']!, credit: '1.00' }],
        }),
      /No financial year covers/
    );
  });
});

describe('B4 — reversal', () => {
  test('a reversal mirrors the original and leaves it untouched (BR-19)', async () => {
    const original = await postJournalEntry(h.db, {
      entryDate: DATE, narration: 'To be reversed', sourceType: 'Test', sourceId: 20,
      postingKey: 'test:reverse:src', postedBy: userId,
      lines: [{ accountId: acc['1010']!, debit: '250.00' }, { accountId: acc['4100']!, credit: '250.00' }],
    });

    const reversal = await reverseJournalEntry(h.db, { entryId: original.id, postedBy: userId });
    assert.notEqual(reversal.id, original.id);

    const originalLines = await h.db.query<{ debit: string; credit: string }>(
      'SELECT debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY id',
      [original.id]
    );
    const reversalLines = await h.db.query<{ debit: string; credit: string }>(
      'SELECT debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY id',
      [reversal.id]
    );

    assert.equal(originalLines.rows[0]!.debit, '250.00', 'the original must be untouched');
    assert.equal(reversalLines.rows[0]!.credit, '250.00', 'debit and credit swap in the reversal');
    assert.equal(reversalLines.rows[1]!.debit, '250.00');

    // Net effect on the cash account is exactly zero.
    const net = await h.db.query<{ debit: string; credit: string }>(
      `SELECT COALESCE(SUM(debit),0) AS debit, COALESCE(SUM(credit),0) AS credit
         FROM journal_lines WHERE entry_id IN ($1, $2) AND account_id = $3`,
      [original.id, reversal.id, acc['1010']]
    );
    assert.equal(toDecimal(toMinor(net.rows[0]!.debit) - toMinor(net.rows[0]!.credit)), '0.00');
  });

  test('reversing twice returns the same reversal, never a second one', async () => {
    const original = await postJournalEntry(h.db, {
      entryDate: DATE, narration: 'Reverse once', sourceType: 'Test', sourceId: 21,
      postingKey: 'test:reverse:once', postedBy: userId,
      lines: [{ accountId: acc['1010']!, debit: '10.00' }, { accountId: acc['4100']!, credit: '10.00' }],
    });

    const a = await reverseJournalEntry(h.db, { entryId: original.id, postedBy: userId });
    const b = await reverseJournalEntry(h.db, { entryId: original.id, postedBy: userId });
    assert.equal(b.id, a.id);
    assert.equal(b.alreadyPosted, true);
  });
});

describe('B4 — locked financial years (BR-24, BR-28)', () => {
  test('a locked year refuses new postings, and says what to do instead', async () => {
    await h.db.query('UPDATE fiscal_years SET is_locked = true');
    try {
      await assert.rejects(
        () =>
          postJournalEntry(h.db, {
            entryDate: DATE, narration: 'Too late', sourceType: 'Test', sourceId: 30,
            postingKey: 'test:locked', postedBy: userId,
            lines: [{ accountId: acc['1010']!, debit: '1.00' }, { accountId: acc['4100']!, credit: '1.00' }],
          }),
        (err: unknown) => {
          assert.ok(err instanceof LockedError, 'a closed year is a policy refusal, not a validation failure');
          assert.match((err as Error).message, /closed/);
          assert.match((err as Error).message, /adjustment/);
          return true;
        }
      );
    } finally {
      await h.db.query('UPDATE fiscal_years SET is_locked = false');
    }
  });

  test('a locked year refuses reversals too (BR-28)', async () => {
    const original = await postJournalEntry(h.db, {
      entryDate: DATE, narration: 'Before lock', sourceType: 'Test', sourceId: 31,
      postingKey: 'test:locked:reverse', postedBy: userId,
      lines: [{ accountId: acc['1010']!, debit: '7.00' }, { accountId: acc['4100']!, credit: '7.00' }],
    });

    await h.db.query('UPDATE fiscal_years SET is_locked = true');
    try {
      await assert.rejects(
        () => reverseJournalEntry(h.db, { entryId: original.id, postedBy: userId }),
        LockedError
      );
    } finally {
      await h.db.query('UPDATE fiscal_years SET is_locked = false');
    }
  });
});
