// Campaign account decoder (368 bytes, little-endian, explicit offsets). Browser-safe.

import { bytesToAddress, addressToBytes } from './base58';
import {
  CAMPAIGN_LEN,
  CAMPAIGN_STATUS_NAMES,
  CAMPAIGN_TAG,
  CampaignOffset as O,
  FLAG_OUTCOME_MASK,
  FLAG_OUTCOME_SHIFT,
  FLAG_PLEDGE,
  OUTCOME_NAMES,
  RULE_VERSION,
  type CampaignStatusName,
  type OutcomeName,
} from './layout';

export interface Campaign {
  tag: number;
  bump: number;
  status: number;
  statusName: CampaignStatusName;
  flags: number;
  pledge: boolean;
  outcome: OutcomeName;
  vaultBump: number;
  ruleVersion: number;
  units: number;
  campaignId: bigint;
  sponsor: string;
  operator: string;
  auditor: string;
  disburser: string;
  mint: string;
  freezeTs: bigint;
  windowEndTs: bigint;
  settledTs: bigint;
  amountFull: bigint;
  amountHalf: bigint;
  thrFull: number;
  thrHalf: number;
  observed: number;
  termsHash: string;
  rosterRoot: string;
  dataHash: string;
  receiptsRoot: string;
}

export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] as number).toString(16).padStart(2, '0');
  return s;
}

export class CampaignDecodeError extends Error {}

export function decodeCampaign(data: Uint8Array): Campaign {
  if (data.length !== CAMPAIGN_LEN) throw new CampaignDecodeError(`campaign account must be ${CAMPAIGN_LEN} bytes, got ${data.length}`);
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = v.getUint8(O.tag);
  if (tag !== CAMPAIGN_TAG) throw new CampaignDecodeError(`bad account tag ${tag}`);
  const status = v.getUint8(O.status);
  const statusName = CAMPAIGN_STATUS_NAMES[status];
  if (statusName === undefined) throw new CampaignDecodeError(`unknown status ${status}`);
  const flags = v.getUint8(O.flags);
  const outcomeIdx = (flags & FLAG_OUTCOME_MASK) >> FLAG_OUTCOME_SHIFT;
  const outcome = OUTCOME_NAMES[outcomeIdx];
  if (outcome === undefined) throw new CampaignDecodeError(`unknown outcome bits ${outcomeIdx}`);
  const slice = (off: number) => data.subarray(off, off + 32);
  return {
    tag,
    bump: v.getUint8(O.bump),
    status,
    statusName,
    flags,
    pledge: (flags & FLAG_PLEDGE) !== 0,
    outcome,
    vaultBump: v.getUint8(O.vault_bump),
    ruleVersion: v.getUint8(O.rule_version),
    units: v.getUint32(O.units, true),
    campaignId: v.getBigUint64(O.campaign_id, true),
    sponsor: bytesToAddress(slice(O.sponsor)),
    operator: bytesToAddress(slice(O.operator)),
    auditor: bytesToAddress(slice(O.auditor)),
    disburser: bytesToAddress(slice(O.disburser)),
    mint: bytesToAddress(slice(O.mint)),
    freezeTs: v.getBigInt64(O.freeze_ts, true),
    windowEndTs: v.getBigInt64(O.window_end_ts, true),
    settledTs: v.getBigInt64(O.settled_ts, true),
    amountFull: v.getBigUint64(O.amount_full, true),
    amountHalf: v.getBigUint64(O.amount_half, true),
    thrFull: v.getInt32(O.thr_full, true),
    thrHalf: v.getInt32(O.thr_half, true),
    observed: v.getInt32(O.observed, true),
    termsHash: bytesToHex(slice(O.terms_hash)),
    rosterRoot: bytesToHex(slice(O.roster_root)),
    dataHash: bytesToHex(slice(O.data_hash)),
    receiptsRoot: bytesToHex(slice(O.receipts_root)),
  };
}

function hex32(h: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(h)) throw new Error('expected 32-byte hex');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Inverse of decodeCampaign. Used by tests and by tooling that needs to build
 * an account image for local validators; not used to write chain state.
 */
export function encodeCampaign(c: Omit<Campaign, 'statusName' | 'pledge' | 'outcome' | 'tag' | 'ruleVersion'> & { tag?: number; ruleVersion?: number }): Uint8Array {
  const data = new Uint8Array(CAMPAIGN_LEN);
  const v = new DataView(data.buffer);
  v.setUint8(O.tag, c.tag ?? CAMPAIGN_TAG);
  v.setUint8(O.bump, c.bump);
  v.setUint8(O.status, c.status);
  v.setUint8(O.flags, c.flags);
  v.setUint8(O.vault_bump, c.vaultBump);
  v.setUint8(O.rule_version, c.ruleVersion ?? RULE_VERSION);
  v.setUint32(O.units, c.units, true);
  v.setBigUint64(O.campaign_id, c.campaignId, true);
  data.set(addressToBytes(c.sponsor), O.sponsor);
  data.set(addressToBytes(c.operator), O.operator);
  data.set(addressToBytes(c.auditor), O.auditor);
  data.set(addressToBytes(c.disburser), O.disburser);
  data.set(addressToBytes(c.mint), O.mint);
  v.setBigInt64(O.freeze_ts, c.freezeTs, true);
  v.setBigInt64(O.window_end_ts, c.windowEndTs, true);
  v.setBigInt64(O.settled_ts, c.settledTs, true);
  v.setBigUint64(O.amount_full, c.amountFull, true);
  v.setBigUint64(O.amount_half, c.amountHalf, true);
  v.setInt32(O.thr_full, c.thrFull, true);
  v.setInt32(O.thr_half, c.thrHalf, true);
  v.setInt32(O.observed, c.observed, true);
  data.set(hex32(c.termsHash), O.terms_hash);
  data.set(hex32(c.rosterRoot), O.roster_root);
  data.set(hex32(c.dataHash), O.data_hash);
  data.set(hex32(c.receiptsRoot), O.receipts_root);
  return data;
}

export function isZeroHash(hex: string): boolean {
  return /^0{64}$/.test(hex);
}
