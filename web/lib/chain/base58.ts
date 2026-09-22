// Base58 (Bitcoin alphabet) used by Solana addresses. Dependency-free so the
// encoder can be unit tested and used in the browser without @solana/kit.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET.charAt(i)] = i;

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET.charAt(digits[i] as number);
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text.charAt(zeros) === '1') zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    const value = INDEX[text.charAt(i)];
    if (value === undefined) throw new Error('invalid base58 character');
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i] as number;
  return out;
}

/** Decode a Solana address and require exactly 32 bytes. */
export function addressToBytes(address: string): Uint8Array {
  const b = base58Decode(address);
  if (b.length !== 32) throw new Error(`address must decode to 32 bytes, got ${b.length}`);
  return b;
}

export function bytesToAddress(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error('address bytes must be 32 long');
  return base58Encode(bytes);
}
