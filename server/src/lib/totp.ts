/**
 * RFC 6238 TOTP / RFC 4648 base32, implemented on node:crypto.
 *
 * Written out rather than pulled from a package because it is ~60 lines of
 * well-specified arithmetic, and an authentication dependency is a supply-chain
 * liability for a system that holds a company's financial records.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export interface TotpOptions {
  digits?: number;
  periodSeconds?: number;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
}

export function generateTotp(secretBase32: string, atMs: number = Date.now(), opts: TotpOptions = {}): string {
  const digits = opts.digits ?? 6;
  const period = opts.periodSeconds ?? 30;
  const algorithm = opts.algorithm ?? 'sha1';

  const counter = Math.floor(atMs / 1000 / period);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac(algorithm, base32Decode(secretBase32)).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Verifies a code, allowing `window` steps either side for clock drift.
 * Comparison is constant-time.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: TotpOptions & { window?: number; atMs?: number } = {}
): boolean {
  const window = opts.window ?? 1;
  const period = opts.periodSeconds ?? 30;
  const atMs = opts.atMs ?? Date.now();
  const candidate = code.replace(/\s+/g, '');
  if (!/^\d{6,8}$/.test(candidate)) return false;

  for (let step = -window; step <= window; step++) {
    const expected = generateTotp(secretBase32, atMs + step * period * 1000, opts);
    if (expected.length === candidate.length) {
      const a = Buffer.from(expected);
      const b = Buffer.from(candidate);
      if (timingSafeEqual(a, b)) return true;
    }
  }
  return false;
}

export function otpauthUri(params: { secret: string; account: string; issuer: string; digits?: number; period?: number }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const q = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(params.digits ?? 6),
    period: String(params.period ?? 30),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/** Ten single-use recovery codes, stored hashed. */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = base32Encode(randomBytes(10)).slice(0, 10);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}
