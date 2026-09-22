// On-chain constants, RULE_VERSION = 1. Source: docs/02-FLOW-DAN-SKEMA-FINAL.md section 3.
// If program/LAYOUT.md disagrees with anything here, program/LAYOUT.md wins and this file must be updated.

export const RULE_VERSION = 1;
export const CAMPAIGN_LEN = 368;
export const CAMPAIGN_TAG = 1;
export const DISPUTE_SECS = 172_800;
export const OPERATOR_TIMEOUT_SECS = 2_592_000;

export const IxTag = {
  CreateCampaign: 0,
  LockRoster: 1,
  Settle: 2,
  Dispute: 3,
  Release: 4,
  PostReceipts: 5,
} as const;
export type IxTagValue = (typeof IxTag)[keyof typeof IxTag];

/** Exact instruction data length including the 1-byte tag. */
export const IX_DATA_LEN: Record<IxTagValue, number> = {
  0: 1 + 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 4 + 4 + 32 + 8 + 1, // 186
  1: 1 + 4 + 32, // 37
  2: 1 + 4 + 32, // 37
  3: 1,
  4: 1,
  5: 1 + 32, // 33
};

export const CampaignStatus = {
  OPEN: 0,
  SETTLED: 1,
  DISPUTED: 2,
  SETTLED_FINAL: 3,
  RELEASED: 4,
  RECEIPTED: 5,
  REFUNDED: 6,
} as const;
export type CampaignStatusValue = (typeof CampaignStatus)[keyof typeof CampaignStatus];
export const CAMPAIGN_STATUS_NAMES = [
  'OPEN',
  'SETTLED',
  'DISPUTED',
  'SETTLED_FINAL',
  'RELEASED',
  'RECEIPTED',
  'REFUNDED',
] as const;
export type CampaignStatusName = (typeof CAMPAIGN_STATUS_NAMES)[number];

export const Outcome = { NONE: 0, HALF: 1, FULL: 2 } as const;
export type OutcomeName = 'NONE' | 'HALF' | 'FULL';
export const OUTCOME_NAMES: readonly OutcomeName[] = ['NONE', 'HALF', 'FULL'];

export const FLAG_PLEDGE = 0b0000_0001;
export const FLAG_OUTCOME_SHIFT = 1;
export const FLAG_OUTCOME_MASK = 0b0000_0110;

export const ProgramError = {
  InvalidTag: 1,
  InvalidData: 2,
  MissingSigner: 3,
  BadPda: 4,
  BadOwner: 5,
  BadMint: 6,
  WrongStatus: 7,
  TooEarly: 8,
  TooLate: 9,
  Underfunded: 10,
  Overflow: 11,
  BadParams: 12,
} as const;

/** Field offsets of the Campaign account (spec table 3.1). */
export const CampaignOffset = {
  tag: 0,
  bump: 1,
  status: 2,
  flags: 3,
  vault_bump: 4,
  rule_version: 5,
  reserved: 6,
  units: 8,
  reserved2: 12,
  campaign_id: 16,
  sponsor: 24,
  operator: 56,
  auditor: 88,
  disburser: 120,
  mint: 152,
  freeze_ts: 184,
  window_end_ts: 192,
  settled_ts: 200,
  amount_full: 208,
  amount_half: 216,
  thr_full: 224,
  thr_half: 228,
  observed: 232,
  reserved3: 236,
  terms_hash: 240,
  roster_root: 272,
  data_hash: 304,
  receipts_root: 336,
} as const;

/** Same rule as the program: observed <= thr_full -> FULL, <= thr_half -> HALF, else NONE. */
export function outcomeFor(observedMm10: number, thrFullMm10: number, thrHalfMm10: number): OutcomeName {
  if (observedMm10 <= thrFullMm10) return 'FULL';
  if (observedMm10 <= thrHalfMm10) return 'HALF';
  return 'NONE';
}

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
