// Settlement crank (spec 2.5 / 2.6): Settle after window_end_ts + data lag, Release after the
// 48 h dispute window (or immediately after SETTLED_FINAL), Refund after the 30-day operator timeout.

import { query, one } from '@/lib/db';
import { env } from '@/lib/env';
import { buildSettlement, fetchSeries, type FetchLike, type SourceSeries } from '@/lib/climate';
import {
  associatedTokenAddress,
  fetchCampaignAccount,
  releaseInstruction,
  sendAsOperator,
  settleGate,
  settleInstruction,
  vaultPda,
} from '@/lib/roster';
import { DISPUTE_SECS } from '@/lib/chain/layout';
import { formatIdr, notifyEnrollment } from '@/lib/wa';

interface Row {
  id: string; code: string; pubkey: string; grid_cells: number[]; window_start: string; window_end: string;
  thr_full_mm10: number; thr_half_mm10: number; amount_full_idr: number; amount_half_idr: number;
}

export interface SettleReport { code: string; action: string; reason?: string; tx_sig?: string; outcome?: string }

async function event(campaignId: string, status: string, sig: string | null, note?: string) {
  await query('insert into campaign_events (campaign_id, status, tx_sig, note) values ($1,$2,$3,$4)', [campaignId, status, sig, note ?? null]);
}

async function settle(c: Row, nowSecs: number): Promise<SettleReport> {
  const fetchImpl = fetch as unknown as FetchLike;
  const primary: SourceSeries[] = [];
  const secondary: SourceSeries[] = [];
  for (const cell of c.grid_cells) {
    primary.push(await fetchSeries('open-meteo-archive', cell, c.window_start, c.window_end, fetchImpl));
    secondary.push(await fetchSeries('nasa-power', cell, c.window_start, c.window_end, fetchImpl));
  }
  const s = buildSettlement({
    campaign: { code: c.code, pubkey: c.pubkey, grid_cells: c.grid_cells, window_start: c.window_start, window_end: c.window_end, thr_full_mm10: c.thr_full_mm10, thr_half_mm10: c.thr_half_mm10 },
    primary, secondary, script_commit: env.scriptCommit(),
  });
  const url = `${env.publicBaseUrl()}/api/campaigns/${c.code}/data.json`;
  const prior = await one<{ review_cleared_at: Date | null; data_hash: string | null }>('select review_cleared_at, data_hash from settlements where campaign_id = $1', [c.id]);
  await query(
    `insert into settlements (campaign_id, observed_mm10, secondary_mm10, divergence_bp, outcome, data_json, data_json_url, data_hash, script_commit, review, review_note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (campaign_id) do update set observed_mm10 = excluded.observed_mm10, secondary_mm10 = excluded.secondary_mm10,
       divergence_bp = excluded.divergence_bp, outcome = excluded.outcome, data_json = excluded.data_json, data_json_url = excluded.data_json_url,
       data_hash = excluded.data_hash, script_commit = excluded.script_commit, review = excluded.review,
       review_note = coalesce(settlements.review_note, excluded.review_note)`,
    [c.id, s.observed_mm10, s.secondary_mm10, s.divergence_bp, s.outcome, s.json, url, s.data_hash, env.scriptCommit(), s.review, s.review_reasons.join('; ') || null],
  );
  // REVIEW (spec 2.5 H/I): a human clears it via settlements.review_cleared_at for this exact data_hash.
  const cleared = prior?.review_cleared_at && prior.data_hash === s.data_hash;
  if (s.review && !cleared) return { code: c.code, action: 'review', reason: s.review_reasons.join('; ') };
  if (s.observed_mm10 === null || !s.outcome) return { code: c.code, action: 'review', reason: 'primary series incomplete' };

  const sig = await sendAsOperator((operator) => settleInstruction(env.programId(), { operator, campaign: c.pubkey }, { observed: s.observed_mm10!, dataHash: s.data_hash }));
  await query(`update settlements set tx_sig = $2, settled_ts = now() where campaign_id = $1`, [c.id, sig]);
  await query(`update campaigns set status = 'settled' where id = $1`, [c.id]);
  await event(c.id, 'settled', sig);

  // Spec 2.5 N: notify every locked recipient.
  const releaseDate = new Date((nowSecs + DISPUTE_SECS) * 1000).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
  const thr = s.outcome === 'FULL' ? c.thr_full_mm10 : c.thr_half_mm10;
  const amount = s.outcome === 'FULL' ? c.amount_full_idr : c.amount_half_idr;
  const recipients = await query<{ id: string; campaign_id: string; phone_enc: Buffer; phone_lookup_hmac: string }>(
    `select id, campaign_id, phone_enc, phone_lookup_hmac from enrollments where campaign_id = $1 and status = 'valid' and locked_at is not null and pii_erased_at is null`,
    [c.id],
  );
  for (const r of recipients) {
    if (s.outcome === 'NONE') {
      await notifyEnrollment(r, 'nh_result_none', { observed: (s.observed_mm10 / 10).toFixed(1), threshold: (c.thr_half_mm10 / 10).toFixed(1) });
    } else {
      await notifyEnrollment(r, 'nh_result_trigger', { observed: (s.observed_mm10 / 10).toFixed(1), threshold: (thr / 10).toFixed(1), amount: formatIdr(amount), date: releaseDate });
    }
  }
  return { code: c.code, action: 'settled', tx_sig: sig, outcome: s.outcome };
}

async function release(c: Row, kind: 'release' | 'refund', chain: { sponsor: string; disburser: string; mint: string }): Promise<SettleReport> {
  const vault = await vaultPda(c.pubkey);
  const [disburserToken, sponsorToken] = await Promise.all([
    associatedTokenAddress(chain.disburser, chain.mint),
    associatedTokenAddress(chain.sponsor, chain.mint),
  ]);
  const sig = await sendAsOperator(() => releaseInstruction(env.programId(), { campaign: c.pubkey, vault, disburserToken, sponsorToken, sponsor: chain.sponsor }));
  const status = kind === 'refund' ? 'refunded' : 'released';
  await query(`update campaigns set status = $2, closed_at = case when $2 = 'refunded' then now() else closed_at end where id = $1`, [c.id, status]);
  await event(c.id, status, sig);
  return { code: c.code, action: status, tx_sig: sig };
}

export async function runSettlement(nowSecs = Math.floor(Date.now() / 1000)): Promise<SettleReport[]> {
  const rows = await query<Row>(
    `select id, code, pubkey, grid_cells, to_char(window_start,'YYYY-MM-DD') as window_start, to_char(window_end,'YYYY-MM-DD') as window_end,
            thr_full_mm10, thr_half_mm10, amount_full_idr, amount_half_idr
       from campaigns where pubkey is not null and status in ('open','settled','disputed','settled_final') order by freeze_ts`,
  );
  const out: SettleReport[] = [];
  for (const c of rows) {
    try {
      const chain = await fetchCampaignAccount(c.pubkey);
      if (!chain) { out.push({ code: c.code, action: 'skipped', reason: 'account not found' }); continue; }
      // Mirror on-chain status transitions we did not cause (Dispute, co-signed Settle).
      const dbStatus = chain.statusName.toLowerCase();
      const cur = await one<{ status: string }>('select status from campaigns where id = $1', [c.id]);
      if (cur && cur.status !== dbStatus && ['disputed', 'settled_final', 'released', 'receipted', 'refunded'].includes(dbStatus)) {
        await query('update campaigns set status = $2 where id = $1', [c.id, dbStatus]);
        await event(c.id, dbStatus, null, 'observed on chain');
      }
      const gate = settleGate({
        nowSecs,
        windowEndTs: Number(chain.windowEndTs),
        chainStatus: chain.statusName,
        settledTs: Number(chain.settledTs),
        units: chain.units,
        reviewPending: false, // settle() recomputes and decides review on fresh data
      });
      if (gate.action === 'wait') out.push({ code: c.code, action: 'wait', reason: gate.reason });
      else if (gate.action === 'settle') out.push(await settle(c, nowSecs));
      else out.push(await release(c, gate.action, chain));
    } catch (e) {
      console.error(`[settle ${c.code}] ${(e as Error).message}`);
      out.push({ code: c.code, action: 'error', reason: (e as Error).message });
    }
  }
  return out;
}