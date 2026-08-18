/**
 * Exact money arithmetic — the foundation every ledger figure rests on.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, MoneyError, sum, toDecimal, toMinor } from '../src/lib/money.ts';

describe('money — parsing', () => {
  test('parses decimal strings exactly', () => {
    assert.equal(toMinor('1234.56'), 123456n);
    assert.equal(toMinor('1234.5'), 123450n);
    assert.equal(toMinor('1234'), 123400n);
    assert.equal(toMinor('0.01'), 1n);
    assert.equal(toMinor('-12.30'), -1230n);
    assert.equal(toMinor('0'), 0n);
  });

  test('tolerates thousands separators and whitespace', () => {
    assert.equal(toMinor(' 1,234.56 '), 123456n);
  });

  test('refuses more than two decimal places rather than rounding silently', () => {
    assert.throws(() => toMinor('1.005'), MoneyError);
    assert.throws(() => toMinor('0.999'), MoneyError);
  });

  test('refuses nonsense', () => {
    for (const bad of ['', '   ', 'abc', '1.2.3', '$5', 'NaN']) {
      assert.throws(() => toMinor(bad), MoneyError, `should have rejected ${JSON.stringify(bad)}`);
    }
  });

  test('round-trips through decimal form', () => {
    for (const v of ['0.00', '1234.56', '-98.70', '1000000.01']) {
      assert.equal(toDecimal(toMinor(v)), v);
    }
  });

  test('renders minor units with both decimal places', () => {
    assert.equal(toDecimal(5n), '0.05');
    assert.equal(toDecimal(50n), '0.50');
    assert.equal(toDecimal(-5n), '-0.05');
    assert.equal(toDecimal(0n), '0.00');
  });
});

describe('money — the float bug this module exists to prevent', () => {
  test('0.1 + 0.2 sums to exactly 0.30', () => {
    // As JS numbers this is 0.30000000000000004.
    assert.equal(toDecimal(sum(['0.10', '0.20'])), '0.30');
  });

  test('a thousand additions of 0.01 sum to exactly 10.00', () => {
    const values = Array.from({ length: 1000 }, () => '0.01');
    assert.equal(toDecimal(sum(values)), '10.00');

    // The naive float version does not.
    const asFloat = values.reduce((a, b) => a + Number(b), 0);
    assert.notEqual(asFloat, 10, 'float arithmetic drifts — which is the point');
  });

  test('large amounts stay exact where JS numbers would not', () => {
    assert.equal(toDecimal(sum(['99999999.99', '0.01'])), '100000000.00');
  });
});

describe('money — allocation (§4.1 rule 8)', () => {
  test('parts always sum exactly to the whole', () => {
    const parts = allocate(toMinor('100.00'), [1n, 1n, 1n]);
    assert.equal(parts.reduce((a, b) => a + b, 0n), toMinor('100.00'));
    assert.deepEqual(parts.map(toDecimal), ['33.33', '33.33', '33.34']);
  });

  test('the remainder goes to the last weighted row, never lost', () => {
    const parts = allocate(toMinor('10.00'), [3n, 3n, 3n]);
    assert.equal(parts.reduce((a, b) => a + b, 0n), toMinor('10.00'));
  });

  test('weights of zero receive nothing', () => {
    const parts = allocate(toMinor('50.00'), [1n, 0n, 1n]);
    assert.equal(toDecimal(parts[1]!), '0.00');
    assert.equal(parts.reduce((a, b) => a + b, 0n), toMinor('50.00'));
  });

  test('with no weights at all it splits evenly and still sums exactly', () => {
    const parts = allocate(toMinor('100.00'), [0n, 0n, 0n]);
    assert.equal(parts.reduce((a, b) => a + b, 0n), toMinor('100.00'));
  });

  test('allocating a value-weighted split matches a hand-worked example', () => {
    // 1,000.00 processing cost split by relative sales value 40 / 380.
    const parts = allocate(toMinor('1000.00'), [toMinor('40.00'), toMinor('380.00')]);
    assert.deepEqual(parts.map(toDecimal), ['95.23', '904.77']);
    assert.equal(parts.reduce((a, b) => a + b, 0n), toMinor('1000.00'));
  });
});
