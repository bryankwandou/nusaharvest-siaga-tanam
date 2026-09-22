// Roster lock (spec 2.4), settlement / release crank (spec 2.5, 2.6) and the on-chain
// submission helpers they share. Pure decision functions ("gates") come first so the
// boundary rules are unit-testable without Postgres or RPC.

import {
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
} from '@solana/kit';
import { addressToBytes, base58Decode } from './chain/base58';
import { decodeCampaign, type Campaign } from './chain/decode';
import { DISPUTE_SECS, OPERATOR_TIMEOUT_SECS, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from './chain/layout';
import { lockRosterInstruction, releaseInstruction, settleInstruction, type InstructionLike } from './chain/encode';
import { buildTree, fromHex, levelsFromRows, proofFromLevels, toHex, treeRows } from './merkle';
import { DATA_LAG_DAYS } from './climate';
import { env } from './env';
import { query, tx, type Queryable } from './db';

// ---------------------------------------------------------------------------
// Time conventions
// ---------------------------------------------------------------------------

const WIB_OFFSET_SECS = 7 * 3600;

/** On-chain window_end_ts for a window_end date: end of that day in WIB (UTC+7). */
export function windowEndTsFor(windowEnd: string): number {
  const [y, m, d] = windowEnd.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d + 1) / 1000 - WIB_OFFSET_SECS;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export type RosterGate =
  | { action: 'lock' }
  | { action: 'skip'; reason: 'frozen' | 'wrong_status' | 'no_enrollments' };

/** LockRoster is allowed only while status is OPEN and now < freeze_ts (program rule, spec 3.2 tag 1). */
export function rosterGate(p: { nowSecs: number; freezeTs: number; chainStatus: string; validCount: number }): RosterGate {
  if (p.chainStatus !== 'OPEN') return { action: 'skip', reason: 'wrong_status' };
  if (p.nowSecs >= p.freezeTs) return { action: 'skip', reason: 'frozen' };
  if (p.validCount === 0) return { action: 'skip', reason: 'no_enrollments' };
  return { action: 'lock' };
}

export type SettleGate =
  | { action: 'settle' }
  | { action: 'release' }
  | { action: 'refund' }
  | { action: 'wait'; reason: 'before_window_end' | 'data_lag' | 'dispute_window' | 'disputed_needs_cosign' | 'review_pending' | 'no_roster' | 'final' };

/**
 * What the settlement crank should do for one campaign, given on-chain state.
 *   - Settle needs now >= window_end_ts (program) and the data lag (spec 2.5: 7 days).
 *   - Release after SETTLED needs now >= settled_ts + 48 h; SETTLED_FINAL releases at once.
 *   - An OPEN campaign the operator never settled refunds at window_end_ts + 30 days.
 *   - DISPUTED needs the operator + auditor co-signed Settle; the crank never does that alone.
 */
export function settleGate(p: {
  nowSecs: number;
  windowEndTs: number;
  chainStatus: string;
  settledTs: number;
  units: number;
  reviewPending: boolean;
}): SettleGate {
  switch (p.chainStatus) {
    case 'OPEN':
      if (p.nowSecs >= p.windowEndTs + OPERATOR_TIMEOUT_SECS) return { action: 'refund' };
      if (p.nowSecs < p.windowEndTs) return { action: 'wait', reason: 'before_window_end' };
      if (p.nowSecs < p.windowEndTs + DATA_LAG_DAYS * 86_400) return { action: 'wait', reason: 'data_lag' };
      if (p.units === 0) return { action: 'wait', reason: 'no_roster' };
      if (p.reviewPending) return { action: 'wait', reason: 'review_pending' };
      return { action: 'settle' };
    case 'SETTLED':
      return p.nowSecs >= p.settledTs + DISPUTE_SECS ? { action: 'release' } : { action: 'wait', reason: 'dispute_window' };
    case 'DISPUTED':
      return { action: 'wait', reason: 'disputed_needs_cosign' };
    case 'SETTLED_FINAL':
      return { action: 'release' };
    default:
      return { action: 'wait', reason: 'final' };
  }
}

/** ESCROW funding cap: how many leaves the vault can pay at amount_full. PLEDGE is capped by units_max only. */
export function fundedCapacity(p: { pledge: boolean; vaultBalance: bigint; amountFull: bigint; unitsMax: number }): number {
  if (p.pledge || p.amountFull === 0n) return p.unitsMax;
  const n = p.vaultBalance / p.amountFull;
  return Number(n < BigInt(p.unitsMax) ? n : BigInt(p.unitsMax));
}

// ---------------------------------------------------------------------------
// Chain access
// ---------------------------------------------------------------------------

export const rpc = () => createSolanaRpc(env.rpcUrl());

export async function fetchCampaignAccount(pubkey: string): Promise<Campaign | null> {
  const r = await rpc().getAccountInfo(address(pubkey), { encoding: 'base64', commitment: 'confirmed' }).send();
  if (!r.value) return null;
  return decodeCampaign(new Uint8Array(Buffer.from(r.value.data[0], 'base64')));
}

export async function tokenBalance(tokenAccount: string): Promise<bigint> {
  const r = await rpc().getTokenAccountBalance(address(tokenAccount), { commitment: 'confirmed' }).send();
  return BigInt(r.value.amount);
}

export async function campaignPda(sponsor: string, campaignId: bigint): Promise<string> {
  const id = new Uint8Array(8);
  new DataView(id.buffer).setBigUint64(0, campaignId, true);
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(env.programId()),
    seeds: [new TextEncoder().encode('camp'), addressToBytes(sponsor), id],
  });
  return pda;
}

export async function vaultPda(campaign: string): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(env.programId()),
    seeds: [new TextEncoder().encode('vault'), addressToBytes(campaign)],
  });
  return pda;
}

export async function associatedTokenAddress(owner: string, mint: string): Promise<string> {
  const [ata] = await getProgramDerivedAddress({
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM_ID),
    seeds: [addressToBytes(owner), addressToBytes(TOKEN_PROGRAM_ID), addressToBytes(mint)],
  });
  return ata;
}

const toKitIx = (ix: InstructionLike): Instruction =>
  ({
    programAddress: address(ix.programAddress),
    accounts: ix.accounts.map((a) => ({ address: address(a.address), role: a.role })),
    data: ix.data,
  }) as unknown as Instruction;

/** Operator key: NH_OPERATOR_SECRET = base58 of the 64-byte ed25519 secret key. Never logged. */
async function operatorSigner() {
  const signer = await createKeyPairSignerFromBytes(base58Decode(process.env.NH_OPERATOR_SECRET ?? ''));
  if (signer.address !== env.operatorPubkey()) throw new Error('NH_OPERATOR_SECRET does not match NH_OPERATOR_PUBKEY');
  return signer;
}

/** Sign with the operator key and send. Returns the transaction signature. */
export async function sendAsOperator(build: (operator: { address: string }) => InstructionLike): Promise<string> {
  const signer = await operatorSigner();
  const client = rpc();
  const { value: blockhash } = await client.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstruction(toKitIx(build(signer)), m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  await client.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  return getSignatureFromTransaction(signed);
}

/** Build an unsigned v0 transaction with `feePayer` as payer, base64 wire format, for a wallet to sign. */
export async function unsignedTransaction(feePayer: string, ix: InstructionLike): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: string }> {
  const { value: blockhash } = await rpc().getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstruction(toKitIx(ix), m),
  );
  const compiled = compileTransaction(msg);
  return {
    transaction: getBase64EncodedWireTransaction(compiled),
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight.toString(),
  };
}

// ---------------------------------------------------------------------------
// Roster build + lock
// ---------------------------------------------------------------------------

export interface RosterBuild {
  units: number;
  root: string;
  admitted: string[]; // enrollment ids in the tree
  waitlisted: string[]; // enrollment ids moved to waitlist for lack of funding
}

/**
 * Deterministic roster: the first `capacity` valid enrolments by (created_at, id) are admitted,
 * the rest are waitlisted, and the admitted leaves are sorted inside buildTree.
 */
export function buildRoster(rows: readonly { id: string; leaf: string }[], capacity: number): RosterBuild & { rows: ReturnType<typeof treeRows> } {
  const admittedRows = rows.slice(0, Math.max(0, capacity));
  if (!admittedRows.length) throw new Error('no admitted enrolments');
  const tree = buildTree(admittedRows.map((r) => fromHex(r.leaf, 32)));
  return {
    units: admittedRows.length,
    root: toHex(tree.root),
    admitted: admittedRows.map((r) => r.id),
    waitlisted: rows.slice(admittedRows.length).map((r) => r.id),
    rows: treeRows(tree),
  };
}

export async function storeTree(q: Queryable, campaignId: string, tree: 'roster' | 'receipts', rows: { level: number; idx: number; hash: string }[]): Promise<void> {
  await q.query('delete from merkle_nodes where campaign_id = $1 and tree = $2', [campaignId, tree]);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const params: unknown[] = [campaignId, tree];
    const values = chunk.map((r, j) => {
      params.push(r.level, r.idx, r.hash);
      return `($1, $2, $${3 + j * 3}, $${4 + j * 3}, $${5 + j * 3})`;
    });
    await q.query(`insert into merkle_nodes (campaign_id, tree, level, idx, hash) values ${values.join(',')}`, params);
  }
}

export async function loadProof(campaignId: string, tree: 'roster' | 'receipts', leafHex: string): Promise<{ proof: string[]; root: string } | null> {
  const rows = await query<{ level: number; idx: number; hash: string }>(
    'select level, idx, hash from merkle_nodes where campaign_id = $1 and tree = $2 order by level, idx',
    [campaignId, tree],
  );
  if (!rows.length) return null;
  const levels = levelsFromRows(rows);
  const proof = proofFromLevels(levels, fromHex(leafHex, 32));
  if (!proof) return null;
  const top = levels[levels.length - 1]?.[0];
  return top ? { proof: proof.map(toHex), root: toHex(top) } : null;
}

export interface LockResult {
  code: string;
  action: 'locked' | 'unchanged' | 'skipped';
  reason?: string;
  units?: number;
  root?: string;
  tx_sig?: string | null;
  waitlisted?: number;
  waitlistedIds?: string[];
}

export async function lockCampaignRoster(
  c: { id: string; code: string; pubkey: string; units_max: number },
  nowSecs = Math.floor(Date.now() / 1000),
): Promise<LockResult> {
  const chain = await fetchCampaignAccount(c.pubkey);
  if (!chain) return { code: c.code, action: 'skipped', reason: 'campaign account not found on chain' };
  const rows = await query<{ id: string; leaf: string }>(
    `select id, leaf from enrollments where campaign_id = $1 and status in ('valid','waitlist') and pii_erased_at is null
      order by created_at, id`,
    [c.id],
  );
  const gate = rosterGate({ nowSecs, freezeTs: Number(chain.freezeTs), chainStatus: chain.statusName, validCount: rows.length });
  if (gate.action === 'skip') {
    if (gate.reason === 'frozen') await query(`update enrollments set status = 'rejected', reject_reason = 'after_freeze' where campaign_id = $1 and locked_at is null and status = 'valid'`, [c.id]);
    return { code: c.code, action: 'skipped', reason: gate.reason };
  }
  const vault = await vaultPda(c.pubkey);
  const capacity = Math.min(
    c.units_max,
    fundedCapacity({ pledge: chain.pledge, vaultBalance: chain.pledge ? 0n : await tokenBalance(vault), amountFull: chain.amountFull, unitsMax: c.units_max }),
  );
  if (capacity <= 0) return { code: c.code, action: 'skipped', reason: 'vault does not fund a single unit' };
  const built = buildRoster(rows, capacity);
  if (built.root === chain.rosterRoot && built.units === chain.units) {
    return { code: c.code, action: 'unchanged', units: built.units, root: built.root, tx_sig: null };
  }
  const sig = await sendAsOperator((operator) =>
    lockRosterInstruction(env.programId(), { operator, campaign: c.pubkey, vault }, { units: built.units, rosterRoot: built.root }),
  );
  const newlyWaitlisted = await tx(async (q) => {
    await storeTree(q, c.id, 'roster', built.rows);
    await q.query('insert into roster_locks (campaign_id, units, root, tx_sig) values ($1,$2,$3,$4)', [c.id, built.units, built.root, sig]);
    await q.query(`update enrollments set status = 'valid', locked_at = coalesce(locked_at, now()) where id = any($1::uuid[])`, [built.admitted]);
    const w = await q.query<{ id: string }>(
      `update enrollments set status = 'waitlist' where id = any($1::uuid[]) and status = 'valid' returning id`,
      [built.waitlisted],
    );
    return w.rows.map((r) => r.id);
  });
  return { code: c.code, action: 'locked', units: built.units, root: built.root, tx_sig: sig, waitlisted: newlyWaitlisted.length, waitlistedIds: newlyWaitlisted };
}

export { settleInstruction, releaseInstruction };
