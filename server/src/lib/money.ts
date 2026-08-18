/**
 * Exact money arithmetic.
 *
 * Money NEVER touches a JS number in this system. `0.1 + 0.2 !== 0.3`, and a
 * ledger that balances only to within a tolerance does not balance. Amounts are
 * carried as strings at the edges (that is how both database drivers return
 * `numeric`) and as bigint minor units — cents — for arithmetic.
 *
 * IMPLEMENTATION.md §2: all monetary columns are numeric(14,2).
 */

export const SCALE = 2;
const SCALE_FACTOR = 100n;

export class MoneyError extends Error {}

/**
 * Parses a decimal amount into minor units, exactly.
 *
 * Accepts "1234.56", "1234.5", "1234", "-12.30", " 1,234.56 ". Rejects anything
 * with more than two decimal places rather than rounding it silently — a
 * rounded amount the user did not ask for is a data-entry bug, not a
 * convenience.
 */
export function toMinor(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value;

  const raw = typeof value === 'number' ? numberToDecimalString(value) : String(value);
  const text = raw.trim().replace(/,/g, '');
  if (text === '') throw new MoneyError('amount is empty');

  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m) throw new MoneyError(`not a valid amount: ${raw}`);

  const sign = m[1] === '-' ? -1n : 1n;
  const whole = m[2] ?? '';
  const frac = m[3] ?? '';
  if (whole === '' && frac === '') throw new MoneyError(`not a valid amount: ${raw}`);
  if (frac.length > SCALE) {
    throw new MoneyError(`amount has more than ${SCALE} decimal places: ${raw}`);
  }

  const padded = frac.padEnd(SCALE, '0');
  return sign * (BigInt(whole === '' ? '0' : whole) * SCALE_FACTOR + BigInt(padded === '' ? '0' : padded));
}

/** Renders minor units back to a fixed-scale decimal string, e.g. "1234.56". */
export function toDecimal(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / SCALE_FACTOR;
  const frac = abs % SCALE_FACTOR;
  return `${negative ? '-' : ''}${whole}.${frac.toString().padStart(SCALE, '0')}`;
}

/**
 * A JS number is only safe here if it is already an exact 2-decimal value.
 * Anything else means the caller did float arithmetic upstream, which is what
 * this module exists to prevent.
 */
function numberToDecimalString(n: number): string {
  if (!Number.isFinite(n)) throw new MoneyError(`amount is not finite: ${n}`);
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER / 100) {
    throw new MoneyError(`amount is too large to be exact: ${n}`);
  }
  return n.toFixed(SCALE);
}

export function sum(values: Array<string | number | bigint>): bigint {
  let total = 0n;
  for (const v of values) total += toMinor(v);
  return total;
}

export function isZero(minor: bigint): boolean {
  return minor === 0n;
}

export function abs(minor: bigint): bigint {
  return minor < 0n ? -minor : minor;
}

/**
 * Splits an amount across `weights`, to the cent, with the remainder given to
 * the last non-zero-weight row so the parts always sum exactly to the whole
 * (IMPLEMENTATION.md §4.1 rule 8).
 *
 * Used for treatment cost allocation and payment application.
 */
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  if (weights.length === 0) return [];

  const weightTotal = weights.reduce((a, b) => a + b, 0n);
  if (weightTotal === 0n) {
    // No basis to weight by: split evenly, remainder to the last row.
    const each = total / BigInt(weights.length);
    const out = weights.map(() => each);
    out[out.length - 1] = total - each * BigInt(weights.length - 1);
    return out;
  }

  const out: bigint[] = [];
  let allocated = 0n;
  let lastIndex = -1;

  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]!;
    if (w === 0n) {
      out.push(0n);
      continue;
    }
    const share = (total * w) / weightTotal; // truncates toward zero
    out.push(share);
    allocated += share;
    lastIndex = i;
  }

  if (lastIndex >= 0) out[lastIndex] = out[lastIndex]! + (total - allocated);
  return out;
}
