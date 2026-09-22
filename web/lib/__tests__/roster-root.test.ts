import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { buildRoster } from '../roster';
import { buildTree, fromHex, phoneHash, rosterLeaf, toHex, verifyProof, getProof } from '../merkle';
import { addressToBytes } from '../chain/base58';

const CAMPAIGN = addressToBytes('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

function leafFor(i: number): string {
  const salt = Buffer.alloc(16, i);
  return toHex(rosterLeaf(CAMPAIGN, phoneHash(salt, `+62812000${String(i).padStart(5, '0')}`), 1_000_000 + i));
}

describe('roster merkle root determinism', () => {
  const rows = Array.from({ length: 37 }, (_, i) => ({ id: `e${i}`, leaf: leafFor(i) }));

  it('fixed leaf vector gives a fixed root', () => {
    const a = buildRoster(rows, 100).root;
    const b = buildRoster(rows, 100).root;
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('root does not depend on input order', () => {
    const shuffled = rows.slice().sort(() => (randomBytes(1)[0]! & 1 ? 1 : -1));
    const reversed = rows.slice().reverse();
    const root = buildTree(rows.map((r) => fromHex(r.leaf, 32))).root;
    expect(toHex(buildTree(shuffled.map((r) => fromHex(r.leaf, 32))).root)).toBe(toHex(root));
    expect(toHex(buildTree(reversed.map((r) => fromHex(r.leaf, 32))).root)).toBe(toHex(root));
  });

  it('funding cap admits the earliest enrolments and waitlists the rest, deterministically', () => {
    const r = buildRoster(rows, 10);
    expect(r.units).toBe(10);
    expect(r.admitted).toEqual(rows.slice(0, 10).map((x) => x.id));
    expect(r.waitlisted).toEqual(rows.slice(10).map((x) => x.id));
    expect(r.root).toBe(buildRoster(rows.slice(0, 10), 10).root);
    expect(r.root).not.toBe(buildRoster(rows, 11).root);
  });

  it('every admitted leaf has a proof that folds to the root', () => {
    const tree = buildTree(rows.map((r) => fromHex(r.leaf, 32)));
    for (const r of rows) {
      const leaf = fromHex(r.leaf, 32);
      expect(verifyProof(leaf, getProof(tree, leaf)!, tree.root)).toBe(true);
    }
  });

  it('stored tree rows match the tree', () => {
    const r = buildRoster(rows, 100);
    const top = Math.max(...r.rows.map((x) => x.level));
    expect(r.rows.filter((x) => x.level === top)).toEqual([{ level: top, idx: 0, hash: r.root }]);
    expect(r.rows.filter((x) => x.level === 0)).toHaveLength(37);
  });

  it('refuses an empty roster', () => {
    expect(() => buildRoster(rows, 0)).toThrow();
  });
});