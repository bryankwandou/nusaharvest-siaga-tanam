// PII encryption (AES-256-GCM), HMAC lookup columns, request signing helpers.
// Server only.
//
// Ciphertext format stored in *_enc bytea columns:
//   version(1) = 0x01 || iv(12) || auth_tag(16) || ciphertext
// Keys come from the environment as base64 of exactly 32 bytes:
//   PII_ENC_KEY   AES-256-GCM key
//   PII_HMAC_KEY  HMAC-SHA256 key for phone_lookup_hmac (must differ from PII_ENC_KEY)

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;

export function parseKey32(b64: string | undefined, name: string): Buffer {
  if (!b64) throw new Error(`${name} is not set`);
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error(`${name} must be base64 of 32 bytes`);
  return key;
}

const encKey = (): Buffer => parseKey32(process.env.PII_ENC_KEY, 'PII_ENC_KEY');
const hmacKey = (): Buffer => parseKey32(process.env.PII_HMAC_KEY, 'PII_HMAC_KEY');

export function encryptBytes(plaintext: Uint8Array, key: Buffer = encKey(), aad?: Uint8Array): Buffer {
  if (key.length !== 32) throw new Error('AES-256-GCM key must be 32 bytes');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  if (aad) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

export function decryptBytes(blob: Uint8Array, key: Buffer = encKey(), aad?: Uint8Array): Buffer {
  const buf = Buffer.from(blob);
  if (buf.length < 1 + IV_LEN + TAG_LEN) throw new Error('ciphertext too short');
  if (buf[0] !== VERSION) throw new Error(`unsupported ciphertext version ${buf[0]}`);
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct = buf.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export const encryptText = (text: string, key?: Buffer): Buffer => encryptBytes(Buffer.from(text, 'utf8'), key);
export const decryptText = (blob: Uint8Array, key?: Buffer): string => decryptBytes(blob, key).toString('utf8');

export function hmacHex(key: Uint8Array | string, message: Uint8Array | string): string {
  return createHmac('sha256', key).update(message).digest('hex');
}

/** Deterministic lookup value for a normalised E.164 phone. Domain-separated so it cannot collide with other lookups. */
export function phoneLookupHmac(e164: string, key: Buffer = hmacKey()): string {
  return hmacHex(key, `nh:phone:v1:${e164}`);
}

export function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/**
 * Normalise an Indonesian or international phone to E.164.
 * Accepts "0812...", "62812...", "+62 812-...", "812..." (assumed Indonesian mobile).
 * Returns null when the result is not a plausible E.164 number.
 */
export function normalizePhoneE164(input: string, defaultCountry = '62'): string | null {
  const trimmed = input.trim();
  const plus = trimmed.startsWith('+');
  let digits = trimmed.replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (plus) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    digits = defaultCountry + digits.slice(1);
  } else if (digits.startsWith('8') && defaultCountry === '62') {
    digits = defaultCountry + digits;
  }
  const e164 = `+${digits}`;
  if (!/^\+[1-9][0-9]{7,14}$/.test(e164)) return null;
  if (e164.startsWith('+62') && !/^\+62[1-9][0-9]{7,12}$/.test(e164)) return null;
  return e164;
}

export const randomSalt16 = (): Buffer => randomBytes(16);

// Crockford base32 without I, L, O, U. 8 symbols = 40 bits, displayed as XXXX-XXXX.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function proofCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < 5) throw new Error('need at least 5 random bytes');
  let bits = 0n;
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(bytes[i] as number);
  let out = '';
  for (let i = 7; i >= 0; i--) out += CROCKFORD.charAt(Number((bits >> BigInt(i * 5)) & 31n));
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export const newProofCode = (): string => proofCodeFromBytes(randomBytes(5));

/** Accepts user-typed codes ("7kq2 m9xa", "7KQ2M9XA", "7KQ2-M9XA") and returns canonical XXXX-XXXX or null. */
export function normalizeProofCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

// ---------------------------------------------------------------------------
// Signed internal requests (cron). Header scheme:
//   x-nh-timestamp: unix seconds
//   x-nh-signature: hex HMAC-SHA256(CRON_SECRET, `${timestamp}.${rawBody}`)
// ---------------------------------------------------------------------------

export const CRON_MAX_SKEW_SECS = 300;

export function signCronRequest(secret: string, timestampSecs: number, rawBody: string): string {
  return hmacHex(secret, `${timestampSecs}.${rawBody}`);
}

export function verifyCronRequest(
  secret: string | undefined,
  timestampHeader: string | null,
  signatureHeader: string | null,
  rawBody: string,
  nowSecs: number = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: string } {
  if (!secret || secret.length < 32) return { ok: false, reason: 'cron secret not configured' };
  if (!timestampHeader || !signatureHeader) return { ok: false, reason: 'missing signature headers' };
  if (!/^[0-9]{9,11}$/.test(timestampHeader)) return { ok: false, reason: 'bad timestamp' };
  const ts = Number(timestampHeader);
  if (Math.abs(nowSecs - ts) > CRON_MAX_SKEW_SECS) return { ok: false, reason: 'stale timestamp' };
  const expected = signCronRequest(secret, ts, rawBody);
  return safeEqualHex(expected, signatureHeader.trim().toLowerCase()) ? { ok: true } : { ok: false, reason: 'bad signature' };
}
