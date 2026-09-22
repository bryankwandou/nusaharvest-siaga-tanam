// Browser-side verification of roster and receipt inclusion (spec 02 section 2.7).
// Uses WebCrypto only; runs in the browser and in Node 20+. The root must be read by the
// caller directly from the Campaign account over RPC, never taken from the API response.

const enc = new TextEncoder();

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return new Uint8Array(buf);
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] as number).toString(16).padStart(2, '0');
  return s;
}

function cmp(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function phoneHashAsync(salt16: Uint8Array, e164: string): Promise<Uint8Array> {
  if (salt16.length !== 16) throw new Error('salt must be 16 bytes');
  return sha256(concat(salt16, enc.encode(e164)));
}

export async function rosterLeafAsync(campaignPubkey32: Uint8Array, phoneHash32: Uint8Array, plotCell: number): Promise<Uint8Array> {
  const cell = new Uint8Array(4);
  new DataView(cell.buffer).setUint32(0, plotCell, true);
  return sha256(concat(enc.encode('NH1'), campaignPubkey32, phoneHash32, cell));
}

export async function receiptLeafAsync(leaf32: Uint8Array, amount: bigint, gatewayRefHash32: Uint8Array, paidTs: bigint): Promise<Uint8Array> {
  const a = new Uint8Array(8);
  new DataView(a.buffer).setBigUint64(0, amount, true);
  const t = new Uint8Array(8);
  new DataView(t.buffer).setBigInt64(0, paidTs, true);
  return sha256(concat(enc.encode('NHR1'), leaf32, a, gatewayRefHash32, t));
}

export async function verifyProofAsync(leaf: Uint8Array, proof: readonly Uint8Array[], root: Uint8Array): Promise<boolean> {
  let acc = leaf;
  for (const sib of proof) acc = cmp(acc, sib) <= 0 ? await sha256(concat(acc, sib)) : await sha256(concat(sib, acc));
  return cmp(acc, root) === 0 && acc.length === root.length;
}

/** sha256 hex of downloaded canonical JSON bytes, for the Reproduce button. */
export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  return bytesToHex(await sha256(bytes));
}
