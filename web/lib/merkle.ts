// Roster and receipt merkle trees, rule version 1 (spec 02 section 2.4).
//
//   phone_hash   = sha256( salt_16 || e164_phone_utf8 )
//   leaf         = sha256( "NH1" || campaign_pubkey_32 || phone_hash_32 || plot_cell_u32_le )
//   node         = sha256( min(a,b) || max(a,b) )
//   receipt_leaf = sha256( "NHR1" || leaf_32 || amount_u64_le || gateway_ref_hash_32 || paid_ts_i64_le )
//
// Tree construction (decisions not fixed by the spec, recorded in docs/ARCHITECTURE.md):
//   - Leaves are sorted lexicographically by bytes and must be unique.
//   - Levels are built pairwise left to right. An odd last node is promoted unchanged to the next level.
//   - A proof is the ordered list of sibling hashes from leaf to root; promoted levels contribute nothing.
//   - Verification folds with the sorted-pair rule, so no position bits are needed.
//
// The hashing core is parameterised so the same code runs on the server (node:crypto, sync)
// and in the browser (see merkle-verify.ts, WebCrypto, async).

import { createHash } from 'node:crypto';

export type Bytes = Uint8Array;

export function sha256(...parts: Bytes[]): Bytes {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export function compareBytes(a: Bytes, b: Bytes): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export function equalBytes(a: Bytes, b: Bytes): boolean {
  return a.length === b.length && compareBytes(a, b) === 0;
}

export function toHex(b: Bytes): string {
  return Buffer.from(b).toString('hex');
}

export function fromHex(h: string, expectedLen?: number): Bytes {
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error('invalid hex');
  const out = new Uint8Array(Buffer.from(h, 'hex'));
  if (expectedLen !== undefined && out.length !== expectedLen) throw new Error(`expected ${expectedLen} bytes`);
  return out;
}

const NH1 = new TextEncoder().encode('NH1');
const NHR1 = new TextEncoder().encode('NHR1');

function u32le(n: number): Bytes {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new RangeError('u32 out of range');
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function u64le(n: bigint): Bytes {
  if (n < 0n || n >= 1n << 64n) throw new RangeError('u64 out of range');
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}
function i64le(n: bigint): Bytes {
  if (n < -(1n << 63n) || n >= 1n << 63n) throw new RangeError('i64 out of range');
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, n, true);
  return b;
}
function need(b: Bytes, len: number, name: string): Bytes {
  if (b.length !== len) throw new Error(`${name} must be ${len} bytes`);
  return b;
}

// ---------------------------------------------------------------------------
// Preimage builders (shared with the browser verifier)
// ---------------------------------------------------------------------------

export function phoneHashPreimage(salt16: Bytes, e164: string): Bytes {
  need(salt16, 16, 'salt');
  if (!/^\+[1-9][0-9]{6,14}$/.test(e164)) throw new Error('phone must be E.164, for example +6281234567890');
  const phone = new TextEncoder().encode(e164);
  const out = new Uint8Array(16 + phone.length);
  out.set(salt16, 0);
  out.set(phone, 16);
  return out;
}

export function leafPreimage(campaignPubkey32: Bytes, phoneHash32: Bytes, plotCell: number): Bytes {
  need(campaignPubkey32, 32, 'campaign pubkey');
  need(phoneHash32, 32, 'phone hash');
  const out = new Uint8Array(3 + 32 + 32 + 4);
  out.set(NH1, 0);
  out.set(campaignPubkey32, 3);
  out.set(phoneHash32, 35);
  out.set(u32le(plotCell), 67);
  return out;
}

export function receiptLeafPreimage(leaf32: Bytes, amount: bigint, gatewayRefHash32: Bytes, paidTs: bigint): Bytes {
  need(leaf32, 32, 'leaf');
  need(gatewayRefHash32, 32, 'gateway ref hash');
  const out = new Uint8Array(4 + 32 + 8 + 32 + 8);
  out.set(NHR1, 0);
  out.set(leaf32, 4);
  out.set(u64le(amount), 36);
  out.set(gatewayRefHash32, 44);
  out.set(i64le(paidTs), 76);
  return out;
}

export function nodePreimage(a: Bytes, b: Bytes): Bytes {
  need(a, 32, 'node');
  need(b, 32, 'node');
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const out = new Uint8Array(64);
  out.set(lo, 0);
  out.set(hi, 32);
  return out;
}

// ---------------------------------------------------------------------------
// Hash functions
// ---------------------------------------------------------------------------

export const phoneHash = (salt16: Bytes, e164: string): Bytes => sha256(phoneHashPreimage(salt16, e164));
export const rosterLeaf = (campaignPubkey32: Bytes, phoneHash32: Bytes, plotCell: number): Bytes =>
  sha256(leafPreimage(campaignPubkey32, phoneHash32, plotCell));
export const receiptLeaf = (leaf32: Bytes, amount: bigint, gatewayRefHash32: Bytes, paidTs: bigint): Bytes =>
  sha256(receiptLeafPreimage(leaf32, amount, gatewayRefHash32, paidTs));
export const hashNode = (a: Bytes, b: Bytes): Bytes => sha256(nodePreimage(a, b));
export const gatewayRefHash = (ref: string): Bytes => sha256(new TextEncoder().encode(ref));

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export interface MerkleTree {
  /** levels[0] = sorted leaves, levels[levels.length - 1] = [root] */
  levels: Bytes[][];
  root: Bytes;
}

export function buildTree(leaves: readonly Bytes[]): MerkleTree {
  if (leaves.length === 0) throw new Error('cannot build a merkle tree with no leaves');
  const sorted = leaves.map((l) => need(l, 32, 'leaf')).slice().sort(compareBytes);
  for (let i = 1; i < sorted.length; i++) {
    if (compareBytes(sorted[i - 1] as Bytes, sorted[i] as Bytes) === 0) throw new Error('duplicate leaf');
  }
  const levels: Bytes[][] = [sorted];
  let cur = sorted;
  while (cur.length > 1) {
    const next: Bytes[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i] as Bytes;
      const b = cur[i + 1];
      next.push(b === undefined ? a : hashNode(a, b));
    }
    levels.push(next);
    cur = next;
  }
  return { levels, root: cur[0] as Bytes };
}

function indexOfLeaf(level0: readonly Bytes[], leaf: Bytes): number {
  let lo = 0;
  let hi = level0.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = compareBytes(level0[mid] as Bytes, leaf);
    if (c === 0) return mid;
    if (c < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Returns sibling hashes from the leaf level upward, or null if the leaf is not in the tree. */
export function proofFromLevels(levels: readonly (readonly Bytes[])[], leaf: Bytes): Bytes[] | null {
  const level0 = levels[0];
  if (level0 === undefined) return null;
  let idx = indexOfLeaf(level0, leaf);
  if (idx < 0) return null;
  const proof: Bytes[] = [];
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l] as readonly Bytes[];
    const sib = idx % 2 === 0 ? level[idx + 1] : level[idx - 1];
    if (sib !== undefined) proof.push(sib);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function getProof(tree: MerkleTree, leaf: Bytes): Bytes[] | null {
  return proofFromLevels(tree.levels, leaf);
}

export function verifyProof(leaf: Bytes, proof: readonly Bytes[], root: Bytes): boolean {
  let acc = leaf;
  for (const sib of proof) acc = hashNode(acc, sib);
  return equalBytes(acc, root);
}

/** Flatten a tree into rows for the merkle_nodes table. */
export function treeRows(tree: MerkleTree): { level: number; idx: number; hash: string }[] {
  const rows: { level: number; idx: number; hash: string }[] = [];
  tree.levels.forEach((level, l) => level.forEach((h, i) => rows.push({ level: l, idx: i, hash: toHex(h) })));
  return rows;
}

/** Rebuild levels from stored merkle_nodes rows (inverse of treeRows). */
export function levelsFromRows(rows: readonly { level: number; idx: number; hash: string }[]): Bytes[][] {
  const levels: Bytes[][] = [];
  for (const r of rows) {
    const lvl = (levels[r.level] ??= []);
    lvl[r.idx] = fromHex(r.hash, 32);
  }
  for (const [l, lvl] of levels.entries()) {
    if (lvl === undefined) throw new Error(`missing merkle level ${l}`);
    for (let i = 0; i < lvl.length; i++) if (lvl[i] === undefined) throw new Error(`missing node ${l}/${i}`);
  }
  return levels;
}
