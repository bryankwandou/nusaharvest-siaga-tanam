// Builds the public campaign JSON (web/types/api.ts CampaignSummary / CampaignDetail)
// from Postgres plus a live read of the Campaign account. No personal data is selected here.

import type {
  CampaignDetail,
  CampaignStatusName,
  CampaignSummary,
  OnchainCampaign,
  RainfallProgress,
  TokenAmount,
  TimelineEvent,
} from '@/types/api';
import { query, one } from '@/lib/db';
import { env } from '@/lib/env';
import { fetchCampaignAccount, tokenBalance, vaultPda, windowEndTsFor } from '@/lib/roster';
import { isZeroHash } from '@/lib/chain/decode';
import { latestSettledDay } from '@/lib/climate';

export interface CampaignRow {
  id: string;
  code: string;
  pubkey: string | null;
  campaign_id: string;
  mode: 'escrow' | 'pledge';
  grid_cells: number[];
  regency: string;
  province: string;
  historical_replay: boolean;
  commodity: string;
  freeze_ts: Date;
  window_start: string;
  window_end: string;
  thr_full_mm10: number;
  thr_half_mm10: number;
  amount_full_idr: number;
  amount_half_idr: number;
  units_max: number;
  terms_doc_url: string | null;
  terms_hash: string | null;
  status: string;
  created_tx: string | null;
  sponsor_name: string;
}

export const CAMPAIGN_COLUMNS = `c.id, c.code, c.pubkey, c.campaign_id::text as campaign_id, c.mode, c.grid_cells, c.regency, c.province,
  c.historical_replay, c.commodity, c.freeze_ts, to_char(c.window_start,'YYYY-MM-DD') as window_start,
  to_char(c.window_end,'YYYY-MM-DD') as window_end, c.thr_full_mm10, c.thr_half_mm10, c.amount_full_idr,
  c.amount_half_idr, c.units_max, c.terms_doc_url, c.terms_hash, c.status, c.created_tx, s.legal_name as sponsor_name`;

export async function findCampaignByCode(code: string): Promise<CampaignRow | null> {
  return one<CampaignRow>(
    `select ${CAMPAIGN_COLUMNS} from campaigns c join sponsors s on s.id = c.sponsor_id
      where upper(c.code) = upper($1) and c.status <> 'draft'`,
    [code],
  );
}

const statusName = (s: string): CampaignStatusName => s.toUpperCase() as CampaignStatusName;
const tokenAmount = (raw: bigint): TokenAmount => ({ raw: raw.toString(), decimals: env.mintDecimals(), mint: env.usdcMint(), symbol: env.mintSymbol() });

export function toSummary(r: CampaignRow, extra: { unitsLocked: number | null; lockedAmount: TokenAmount | null; outcome: CampaignSummary['outcome']; status?: CampaignStatusName }): CampaignSummary {
  return {
    code: r.code,
    pubkey: r.pubkey,
    cluster: env.cluster(),
    mode: r.mode,
    historicalReplay: r.historical_replay,
    status: extra.status ?? statusName(r.status),
    outcome: extra.outcome,
    sponsorName: r.sponsor_name,
    commodity: r.commodity,
    area: { regency: r.regency, province: r.province, gridCells: r.grid_cells.map(Number) },
    unitsLocked: extra.unitsLocked,
    unitsMax: r.units_max,
    amountFullIdr: r.amount_full_idr,
    amountHalfIdr: r.amount_half_idr,
    lockedAmount: extra.lockedAmount,
    freezeTs: Math.floor(new Date(r.freeze_ts).getTime() / 1000),
    windowStartDate: r.window_start,
    windowEndDate: r.window_end,
    windowEndTs: windowEndTsFor(r.window_end),
  };
}

export async function listSummaries(): Promise<CampaignSummary[]> {
  const rows = await query<CampaignRow & { units_locked: number | null; outcome: string | null }>(
    `select ${CAMPAIGN_COLUMNS},
       (select units from roster_locks l where l.campaign_id = c.id order by created_at desc limit 1) as units_locked,
       (select outcome from settlements st where st.campaign_id = c.id and st.tx_sig is not null) as outcome
     from campaigns c join sponsors s on s.id = c.sponsor_id
     where c.status <> 'draft' and c.pubkey is not null
     order by c.freeze_ts desc limit 200`,
  );
  // The list is DB-backed for speed; the detail endpoint reads the chain for authoritative values.
  return rows.map((r) =>
    toSummary(r, { unitsLocked: r.units_locked, lockedAmount: null, outcome: (r.outcome as CampaignSummary['outcome']) ?? null }),
  );
}

async function rainfall(r: CampaignRow): Promise<RainfallProgress | null> {
  const rows = await query<{ day: string; grid_cell: number; rain_mm100: number | null; fetched_at: Date }>(
    `select to_char(day,'YYYY-MM-DD') as day, grid_cell, rain_mm100, fetched_at from climate_snapshots
      where source = 'open-meteo-archive' and grid_cell = any($1::int[]) and day between $2 and $3 order by day`,
    [r.grid_cells, r.window_start, r.window_end],
  );
  if (!rows.length) return null;
  const byDay = new Map<string, number[]>();
  let updated = 0;
  for (const x of rows) {
    if (x.rain_mm100 === null) continue;
    (byDay.get(x.day) ?? byDay.set(x.day, []).get(x.day)!).push(Number(x.rain_mm100));
    updated = Math.max(updated, new Date(x.fetched_at).getTime());
  }
  const cells = r.grid_cells.length;
  let cum = 0;
  const points: RainfallProgress['points'] = [];
  for (const [day, vals] of [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (vals.length !== cells) break; // stop at the first day not complete for every cell
    cum += vals.reduce((a, b) => a + b, 0);
    points.push({ day, cumulativeMm10: Math.floor(Math.floor(cum / cells) / 10) });
  }
  return {
    source: 'open-meteo-archive',
    sourceUrl: 'https://open-meteo.com/en/docs/historical-weather-api',
    updatedAt: new Date(updated).toISOString(),
    latestDay: latestSettledDay(),
    points,
    medianMm10: null,
  };
}

export async function buildDetail(r: CampaignRow): Promise<CampaignDetail> {
  let onchain: OnchainCampaign | null = null;
  let lockedAmount: TokenAmount | null = null;
  let status: CampaignStatusName | undefined;
  let outcome: CampaignSummary['outcome'] = null;
  if (r.pubkey) {
    try {
      const c = await fetchCampaignAccount(r.pubkey);
      if (c) {
        status = c.statusName;
        const settledStates = ['SETTLED', 'DISPUTED', 'SETTLED_FINAL', 'RELEASED', 'RECEIPTED'];
        outcome = settledStates.includes(c.statusName) ? c.outcome : null;
        onchain = {
          sponsor: c.sponsor,
          operator: c.operator,
          auditor: c.auditor,
          disburser: c.disburser,
          mint: c.mint,
          ruleVersion: c.ruleVersion,
          units: c.units,
          settledTs: c.settledTs > 0n ? Number(c.settledTs) : null,
          amountFull: tokenAmount(c.amountFull),
          amountHalf: tokenAmount(c.amountHalf),
          thrFullMm10: c.thrFull,
          thrHalfMm10: c.thrHalf,
          observedMm10: settledStates.includes(c.statusName) ? c.observed : null,
          termsHash: c.termsHash,
          rosterRoot: c.rosterRoot,
          dataHash: c.dataHash,
          receiptsRoot: c.receiptsRoot,
        };
        if (!c.pledge && (c.statusName === 'OPEN' || c.statusName === 'SETTLED' || c.statusName === 'DISPUTED' || c.statusName === 'SETTLED_FINAL')) {
          lockedAmount = tokenAmount(await tokenBalance(await vaultPda(r.pubkey)).catch(() => 0n));
        }
      }
    } catch (e) {
      console.error(`[campaign ${r.code}] chain read failed: ${(e as Error).message}`);
    }
  }

  const lock = await one<{ root: string; units: number; tx_sig: string | null; created_at: Date }>(
    'select root, units, tx_sig, created_at from roster_locks where campaign_id = $1 order by created_at desc limit 1',
    [r.id],
  );
  const st = await one<{
    observed_mm10: number | null; secondary_mm10: number | null; divergence_bp: number | null; outcome: string | null;
    data_hash: string | null; data_json_url: string | null; tx_sig: string | null; settled_ts: Date | null; review: boolean; review_note: string | null;
  }>('select observed_mm10, secondary_mm10, divergence_bp, outcome, data_hash, data_json_url, tx_sig, settled_ts, review, review_note from settlements where campaign_id = $1', [r.id]);
  const events = await query<{ status: string; tx_sig: string | null; note: string | null; at: Date }>(
    'select status, tx_sig, note, at from campaign_events where campaign_id = $1 order by at',
    [r.id],
  );
  const rp = await one<{ root: string; tx_sig: string | null; posted_at: Date; paid_count: number; failed_count: number; total_paid_idr: string; manual_disbursement: boolean }>(
    'select root, tx_sig, posted_at, paid_count, failed_count, total_paid_idr::text, manual_disbursement from receipt_posts where campaign_id = $1',
    [r.id],
  );

  const disputeOpen = events.find((e) => e.status === 'disputed');
  const disputeResolved = events.find((e) => e.status === 'settled_final');
  const order: CampaignStatusName[] = ['OPEN', 'SETTLED', 'DISPUTED', 'SETTLED_FINAL', 'RELEASED', 'RECEIPTED', 'REFUNDED'];
  const timeline: TimelineEvent[] = order.map((s) => {
    const e = events.find((x) => x.status.toUpperCase() === s);
    return { status: s, at: e ? new Date(e.at).toISOString() : null, txSignature: e?.tx_sig ?? null };
  });

  const totalPaid = rp ? Number(rp.total_paid_idr) : 0;
  const unitsForOutcome = lock?.units ?? 0;
  const perUnit = outcome === 'FULL' ? r.amount_full_idr : outcome === 'HALF' ? r.amount_half_idr : 0;

  return {
    ...toSummary(r, { unitsLocked: onchain ? (onchain.units || null) : (lock?.units ?? null), lockedAmount, outcome, status }),
    termsHash: r.terms_hash,
    termsDocUrl: r.terms_doc_url,
    programId: process.env.NH_PROGRAM_ID ?? null,
    onchain,
    roster: lock && (!onchain || !isZeroHash(onchain.rosterRoot))
      ? { root: lock.root, units: lock.units, txSignature: lock.tx_sig, lockedAt: new Date(lock.created_at).toISOString() }
      : null,
    settlement: st && st.observed_mm10 !== null && st.outcome && st.data_hash && st.settled_ts
      ? {
          observedMm10: st.observed_mm10,
          secondaryMm10: st.secondary_mm10,
          divergenceBp: st.divergence_bp,
          thrFullMm10: r.thr_full_mm10,
          thrHalfMm10: r.thr_half_mm10,
          outcome: st.outcome as 'FULL' | 'HALF' | 'NONE',
          dataHash: st.data_hash,
          dataJsonUrl: st.data_json_url,
          txSignature: st.tx_sig,
          settledAt: new Date(st.settled_ts).toISOString(),
          review: st.review,
          reviewNote: st.review_note,
        }
      : null,
    dispute: disputeOpen
      ? {
          openedAt: new Date(disputeOpen.at).toISOString(),
          txSignature: disputeOpen.tx_sig,
          resolvedAt: disputeResolved ? new Date(disputeResolved.at).toISOString() : null,
          resolutionTxSignature: disputeResolved?.tx_sig ?? null,
          note: disputeOpen.note,
        }
      : null,
    receipts: rp
      ? {
          root: rp.root,
          txSignature: rp.tx_sig,
          postedAt: new Date(rp.posted_at).toISOString(),
          paidCount: rp.paid_count,
          failedCount: rp.failed_count,
          totalPaidIdr: totalPaid,
          returnedToSponsorIdr: perUnit > 0 ? Math.max(0, perUnit * unitsForOutcome - totalPaid) : null,
          manualDisbursement: rp.manual_disbursement,
        }
      : null,
    rainfall: await rainfall(r),
    timeline,
    createdTxSignature: r.created_tx,
  };
}
