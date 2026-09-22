// Instruction encoders for the nusaharvest program (RULE_VERSION 1).
// Byte layout: 1-byte tag, then fixed-size little-endian fields in the order of
// spec 02 section 3.2. No padding. Dependency-free: account metas use the same
// numeric role values as @solana/kit AccountRole (READONLY 0, WRITABLE 1,
// READONLY_SIGNER 2, WRITABLE_SIGNER 3) so the result can be passed to kit directly.

import { addressToBytes } from './base58';
import { IX_DATA_LEN, IxTag, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, type IxTagValue } from './layout';

export const AccountRoleValue = {
  READONLY: 0,
  WRITABLE: 1,
  READONLY_SIGNER: 2,
  WRITABLE_SIGNER: 3,
} as const;
export type AccountRoleNumber = (typeof AccountRoleValue)[keyof typeof AccountRoleValue];

/** Either a bare address or a signer-like object carrying its address (for example a kit KeyPairSigner). */
export type AddressOrSigner = string | { readonly address: string };

export interface AccountMetaLike {
  readonly address: string;
  readonly role: AccountRoleNumber;
  readonly signer?: { readonly address: string };
}

export interface InstructionLike {
  readonly programAddress: string;
  readonly accounts: readonly AccountMetaLike[];
  readonly data: Uint8Array;
}

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

class Writer {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset = 0;
  constructor(len: number) {
    this.bytes = new Uint8Array(len);
    this.view = new DataView(this.bytes.buffer);
  }
  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError(`u8 out of range: ${v}`);
    this.view.setUint8(this.offset, v);
    this.offset += 1;
    return this;
  }
  u32(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) throw new RangeError(`u32 out of range: ${v}`);
    this.view.setUint32(this.offset, v, true);
    this.offset += 4;
    return this;
  }
  i32(v: number): this {
    if (!Number.isInteger(v) || v < -0x8000_0000 || v > 0x7fff_ffff) throw new RangeError(`i32 out of range: ${v}`);
    this.view.setInt32(this.offset, v, true);
    this.offset += 4;
    return this;
  }
  u64(v: bigint): this {
    if (typeof v !== 'bigint' || v < 0n || v > U64_MAX) throw new RangeError(`u64 out of range: ${String(v)}`);
    this.view.setBigUint64(this.offset, v, true);
    this.offset += 8;
    return this;
  }
  i64(v: bigint): this {
    if (typeof v !== 'bigint' || v < I64_MIN || v > I64_MAX) throw new RangeError(`i64 out of range: ${String(v)}`);
    this.view.setBigInt64(this.offset, v, true);
    this.offset += 8;
    return this;
  }
  fixed(b: Uint8Array, len: number): this {
    if (b.length !== len) throw new RangeError(`expected ${len} bytes, got ${b.length}`);
    this.bytes.set(b, this.offset);
    this.offset += len;
    return this;
  }
  finish(): Uint8Array {
    if (this.offset !== this.bytes.length) throw new Error(`encoder wrote ${this.offset} of ${this.bytes.length} bytes`);
    return this.bytes;
  }
}

function writer(tag: IxTagValue): Writer {
  return new Writer(IX_DATA_LEN[tag]).u8(tag);
}

export function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error('expected 32-byte hex string');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytes32(v: Uint8Array | string): Uint8Array {
  return typeof v === 'string' ? hexToBytes32(v) : v;
}

// ---------------------------------------------------------------------------
// Data encoders (pure bytes)
// ---------------------------------------------------------------------------

export interface CreateCampaignArgs {
  campaignId: bigint;
  operator: string;
  auditor: string;
  disburser: string;
  freezeTs: bigint;
  windowEndTs: bigint;
  amountFull: bigint;
  amountHalf: bigint;
  thrFull: number;
  thrHalf: number;
  termsHash: Uint8Array | string;
  deposit: bigint;
  pledge: boolean;
}

export function encodeCreateCampaignData(a: CreateCampaignArgs): Uint8Array {
  return writer(IxTag.CreateCampaign)
    .u64(a.campaignId)
    .fixed(addressToBytes(a.operator), 32)
    .fixed(addressToBytes(a.auditor), 32)
    .fixed(addressToBytes(a.disburser), 32)
    .i64(a.freezeTs)
    .i64(a.windowEndTs)
    .u64(a.amountFull)
    .u64(a.amountHalf)
    .i32(a.thrFull)
    .i32(a.thrHalf)
    .fixed(bytes32(a.termsHash), 32)
    .u64(a.deposit)
    .u8(a.pledge ? 1 : 0)
    .finish();
}

export interface LockRosterArgs {
  units: number;
  rosterRoot: Uint8Array | string;
}
export function encodeLockRosterData(a: LockRosterArgs): Uint8Array {
  return writer(IxTag.LockRoster).u32(a.units).fixed(bytes32(a.rosterRoot), 32).finish();
}

export interface SettleArgs {
  observed: number;
  dataHash: Uint8Array | string;
}
export function encodeSettleData(a: SettleArgs): Uint8Array {
  return writer(IxTag.Settle).i32(a.observed).fixed(bytes32(a.dataHash), 32).finish();
}

export function encodeDisputeData(): Uint8Array {
  return writer(IxTag.Dispute).finish();
}

export function encodeReleaseData(): Uint8Array {
  return writer(IxTag.Release).finish();
}

export interface PostReceiptsArgs {
  receiptsRoot: Uint8Array | string;
}
export function encodePostReceiptsData(a: PostReceiptsArgs): Uint8Array {
  return writer(IxTag.PostReceipts).fixed(bytes32(a.receiptsRoot), 32).finish();
}

// ---------------------------------------------------------------------------
// Instruction builders (data + ordered account metas)
// ---------------------------------------------------------------------------

function meta(a: AddressOrSigner, role: AccountRoleNumber): AccountMetaLike {
  if (typeof a === 'string') return { address: a, role };
  const signerRole = role === AccountRoleValue.READONLY_SIGNER || role === AccountRoleValue.WRITABLE_SIGNER;
  return signerRole ? { address: a.address, role, signer: a } : { address: a.address, role };
}

export interface CreateCampaignAccounts {
  sponsor: AddressOrSigner;
  campaign: string;
  vault: string;
  mint: string;
  sponsorToken: string;
  tokenProgram?: string;
}
export function createCampaignInstruction(
  programAddress: string,
  accts: CreateCampaignAccounts,
  args: CreateCampaignArgs,
): InstructionLike {
  return {
    programAddress,
    accounts: [
      meta(accts.sponsor, AccountRoleValue.WRITABLE_SIGNER),
      meta(accts.campaign, AccountRoleValue.WRITABLE),
      meta(accts.vault, AccountRoleValue.WRITABLE),
      meta(accts.mint, AccountRoleValue.READONLY),
      meta(accts.sponsorToken, AccountRoleValue.WRITABLE),
      meta(SYSTEM_PROGRAM_ID, AccountRoleValue.READONLY),
      meta(accts.tokenProgram ?? TOKEN_PROGRAM_ID, AccountRoleValue.READONLY),
    ],
    data: encodeCreateCampaignData(args),
  };
}

export function lockRosterInstruction(
  programAddress: string,
  accts: { operator: AddressOrSigner; campaign: string; vault: string },
  args: LockRosterArgs,
): InstructionLike {
  return {
    programAddress,
    accounts: [
      meta(accts.operator, AccountRoleValue.READONLY_SIGNER),
      meta(accts.campaign, AccountRoleValue.WRITABLE),
      meta(accts.vault, AccountRoleValue.READONLY),
    ],
    data: encodeLockRosterData(args),
  };
}

export function settleInstruction(
  programAddress: string,
  accts: { operator: AddressOrSigner; campaign: string; auditor?: AddressOrSigner },
  args: SettleArgs,
): InstructionLike {
  const accounts = [
    meta(accts.operator, AccountRoleValue.READONLY_SIGNER),
    meta(accts.campaign, AccountRoleValue.WRITABLE),
  ];
  if (accts.auditor !== undefined) accounts.push(meta(accts.auditor, AccountRoleValue.READONLY_SIGNER));
  return { programAddress, accounts, data: encodeSettleData(args) };
}

export function disputeInstruction(
  programAddress: string,
  accts: { auditor: AddressOrSigner; campaign: string },
): InstructionLike {
  return {
    programAddress,
    accounts: [meta(accts.auditor, AccountRoleValue.READONLY_SIGNER), meta(accts.campaign, AccountRoleValue.WRITABLE)],
    data: encodeDisputeData(),
  };
}

export function releaseInstruction(
  programAddress: string,
  accts: {
    campaign: string;
    vault: string;
    disburserToken: string;
    sponsorToken: string;
    sponsor: string;
    tokenProgram?: string;
  },
): InstructionLike {
  return {
    programAddress,
    accounts: [
      meta(accts.campaign, AccountRoleValue.WRITABLE),
      meta(accts.vault, AccountRoleValue.WRITABLE),
      meta(accts.disburserToken, AccountRoleValue.WRITABLE),
      meta(accts.sponsorToken, AccountRoleValue.WRITABLE),
      meta(accts.sponsor, AccountRoleValue.WRITABLE),
      meta(accts.tokenProgram ?? TOKEN_PROGRAM_ID, AccountRoleValue.READONLY),
    ],
    data: encodeReleaseData(),
  };
}

export function postReceiptsInstruction(
  programAddress: string,
  accts: { operator: AddressOrSigner; campaign: string },
  args: PostReceiptsArgs,
): InstructionLike {
  return {
    programAddress,
    accounts: [meta(accts.operator, AccountRoleValue.READONLY_SIGNER), meta(accts.campaign, AccountRoleValue.WRITABLE)],
    data: encodePostReceiptsData(args),
  };
}
