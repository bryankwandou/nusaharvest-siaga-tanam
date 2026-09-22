/**
 * Response contract between the web UI and the route handlers under web/app/api.
 *
 * Rules the UI assumes:
 *  - Every field that is not yet known on chain is `null`, never a placeholder value.
 *  - Timestamps are ISO-8601 strings in UTC. Unix seconds are sent as numbers with a `Ts` suffix.
 *  - Token amounts are base units as decimal strings plus the mint decimals; rupiah amounts
 *    are integers.
 *  - Rainfall is millimetres times 10 (mm10), matching the on-chain i32 fields.
 *  - Hashes and merkle roots are lowercase hex, 64 characters, no 0x prefix. An all-zero hash
 *    means "not set yet" and the UI renders it as not set.
 */

import type { CampaignStatusName, OutcomeName } from '@/lib/chain/layout';

export type { CampaignStatusName, OutcomeName };

export type CampaignMode = 'escrow' | 'pledge';
export type SolanaCluster = 'mainnet-beta' | 'devnet' | 'testnet';

export interface ApiError {
  error: string;
  message?: string;
}

/** Token amount in base units, with enough information to format it. */
export interface TokenAmount {
  /** Base units as a decimal string (u64 does not fit in a JS number). */
  raw: string;
  decimals: number;
  /** Mint address, base58. */
  mint: string;
  /** Short symbol for display, for example "USDC". */
  symbol: string;
}

export interface CampaignArea {
  /** Kabupaten / regency name as printed on the page. */
  regency: string;
  province: string;
  /** 0.1 degree grid cell ids used by the climate pipeline. */
  gridCells: number[];
}

export interface CampaignSummary {
  /** Public short code, for example "NH-KLT26". Used as the route parameter. */
  code: string;
  /** Campaign account address, base58. Null before the create transaction confirms. */
  pubkey: string | null;
  cluster: SolanaCluster;
  mode: CampaignMode;
  /** True only for an archived-season rerun on devnet. The UI shows a permanent label. */
  historicalReplay: boolean;
  status: CampaignStatusName;
  outcome: OutcomeName | null;
  sponsorName: string;
  commodity: string;
  area: CampaignArea;
  /** Recipients in the most recent locked roster. Null before the first LockRoster. */
  unitsLocked: number | null;
  unitsMax: number | null;
  amountFullIdr: number;
  amountHalfIdr: number;
  /** Vault balance read from chain. Null for pledge mode and before the vault exists. */
  lockedAmount: TokenAmount | null;
  freezeTs: number;
  windowStartDate: string;
  windowEndDate: string;
  windowEndTs: number;
}

export interface OnchainCampaign {
  sponsor: string;
  operator: string;
  auditor: string;
  disburser: string;
  mint: string;
  ruleVersion: number;
  units: number;
  settledTs: number | null;
  amountFull: TokenAmount;
  amountHalf: TokenAmount;
  thrFullMm10: number;
  thrHalfMm10: number;
  /** Zero until Settle has run; `settlement` is the authority on whether it is meaningful. */
  observedMm10: number | null;
  termsHash: string;
  rosterRoot: string;
  dataHash: string;
  receiptsRoot: string;
}

export interface RosterLock {
  root: string;
  units: number;
  txSignature: string | null;
  lockedAt: string;
}

export interface Settlement {
  observedMm10: number;
  secondaryMm10: number | null;
  divergenceBp: number | null;
  thrFullMm10: number;
  thrHalfMm10: number;
  outcome: OutcomeName;
  dataHash: string;
  /** Fixed URL of the canonical JSON, for the recompute check in the browser. */
  dataJsonUrl: string | null;
  txSignature: string | null;
  settledAt: string;
  review: boolean;
  reviewNote: string | null;
}

export interface DisputeRecord {
  openedAt: string;
  txSignature: string | null;
  resolvedAt: string | null;
  resolutionTxSignature: string | null;
  note: string | null;
}

export interface Receipts {
  root: string;
  txSignature: string | null;
  postedAt: string;
  paidCount: number;
  failedCount: number;
  totalPaidIdr: number;
  returnedToSponsorIdr: number | null;
  /** True when an operator uploaded transfer evidence instead of a payment gateway. */
  manualDisbursement: boolean;
}

/** One point of the cumulative rainfall chart on the proof page. */
export interface RainfallPoint {
  day: string;
  cumulativeMm10: number;
}

export interface RainfallProgress {
  source: string;
  sourceUrl: string | null;
  updatedAt: string;
  /** Last day both sources are considered final. */
  latestDay: string;
  points: RainfallPoint[];
  medianMm10: number | null;
}

export interface TimelineEvent {
  status: CampaignStatusName;
  /** Null for a step that has not happened yet. */
  at: string | null;
  txSignature: string | null;
}

export interface CampaignDetail extends CampaignSummary {
  termsHash: string | null;
  termsDocUrl: string | null;
  programId: string | null;
  onchain: OnchainCampaign | null;
  roster: RosterLock | null;
  settlement: Settlement | null;
  dispute: DisputeRecord | null;
  receipts: Receipts | null;
  rainfall: RainfallProgress | null;
  timeline: TimelineEvent[];
  createdTxSignature: string | null;
}

export interface CampaignListResponse {
  campaigns: CampaignSummary[];
}

/** GET /api/campaigns/:code */
export type CampaignDetailResponse = CampaignDetail;

/** POST /api/proof/roster */
export interface RosterProofRequest {
  code: string;
  /** E.164 phone number, for example "+6281234567890". */
  phone: string;
  /** Proof code handed out at enrolment, for example "7KQ2-M9XA". */
  proofCode: string;
}

export interface RosterProofResponse {
  found: boolean;
  cluster: SolanaCluster;
  /** Campaign account address, so the browser can read the root from RPC itself. */
  campaignPubkey: string | null;
  /** 16-byte salt, hex, so the browser recomputes the leaf instead of trusting the API. */
  saltHex: string | null;
  plotCell: number | null;
  leaf: string | null;
  proof: string[];
  root: string | null;
  lockedAt: string | null;
  receipt: {
    leaf: string;
    proof: string[];
    root: string;
    amountIdr: number;
    /** Unix seconds, matches the receipt leaf formula. */
    paidTs: number;
    gatewayRefHash: string;
    manualDisbursement: boolean;
  } | null;
}

/** POST /api/campaigns/quote */
export interface QuoteRequest {
  regency: string;
  province: string;
  commodity: string;
  windowStartDate: string;
  windowEndDate: string;
  amountFullIdr: number;
  amountHalfIdr: number;
  unitsMax: number;
}

export interface BacktestYear {
  seasonYear: number;
  totalMm10: number | null;
  outcome: OutcomeName | null;
  costPerUnitIdr: number;
}

export interface QuoteResponse {
  gridCells: number[];
  thrFullMm10: number;
  thrHalfMm10: number;
  medianMm10: number;
  baselineYears: number[];
  latestDay: string;
  sources: { url: string; rawSha256: string }[];
  backtest: {
    years: BacktestYear[];
    fullCount: number;
    halfCount: number;
    noneCount: number;
    missingCount: number;
    totalCostPerUnitIdr: number;
    totalCostUnitsMaxIdr: number;
  };
}

/** POST /api/campaigns — saves the draft and returns the unsigned transaction. */
export interface CreateCampaignRequest extends QuoteRequest {
  sponsorName: string;
  mode: CampaignMode;
  sponsorWallet: string | null;
  contactEmail: string;
}

export interface CreateCampaignResponse {
  code: string;
  termsHash: string;
  termsDocUrl: string | null;
  /** Base64 unsigned transaction for escrow mode with a connected wallet, otherwise null. */
  transactionBase64: string | null;
  /** Human-readable next step when no signature is needed. */
  nextStep: string | null;
}

/** Areas the sponsor console offers. */
export interface AreaOption {
  regency: string;
  province: string;
}

export interface AreasResponse {
  areas: AreaOption[];
}
