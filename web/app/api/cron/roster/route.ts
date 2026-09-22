// POST /api/cron/roster -- signed cron (x-nh-timestamp, x-nh-signature). Spec 2.4.
// Schedule: every 6 h before freeze_ts, plus once at freeze_ts - 1 h. Body: {} or {"code": "NH-..."}.
// Also promotes ESCROW drafts to 'open' once their CreateCampaign account exists on chain.

import { z } from 'zod';
import { json, parseJson, requireCron } from '@/lib/auth';
import { query } from '@/lib/db';
import { fetchCampaignAccount, lockCampaignRoster, rpc, type LockResult } from '@/lib/roster';
import { notifyEnrollment } from '@/lib/wa';
import { address } from '@solana/kit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const Body = z.object({ code: z.string().min(3).max(32).optional() }).strict();

async function promoteDrafts(): Promise<string[]> {
  const drafts = await query<{ id: string; code: string; pubkey: string }>(`select id, code, pubkey from campaigns where status = 'draft' and pubkey is not null`);
  const opened: string[] = [];
  for (const d of drafts) {
    const acct = await fetchCampaignAccount(d.pubkey).catch(() => null);
    if (!acct) continue;
    const sigs = await rpc().getSignaturesForAddress(address(d.pubkey), { limit: 1000 }).send().catch(() => []);
    const first = sigs.length ? String(sigs[sigs.length - 1]!.signature) : null;
    await query(`update campaigns set status = 'open', created_tx = coalesce(created_tx, $2) where id = $1`, [d.id, first]);
    await query(`insert into campaign_events (campaign_id, status, tx_sig) values ($1, 'open', $2)`, [d.id, first]);
    opened.push(d.code);
  }
  return opened;
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.res;
  const p = parseJson(Body, auth.raw);
  if (!p.ok) return p.res;

  const opened = await promoteDrafts();
  const campaigns = await query<{ id: string; code: string; pubkey: string; units_max: number }>(
    `select id, code, pubkey, units_max from campaigns
      where status = 'open' and pubkey is not null and ($1::text is null or upper(code) = upper($1))`,
    [p.data.code ?? null],
  );
  const results: LockResult[] = [];
  for (const c of campaigns) {
    try {
      const r = await lockCampaignRoster(c);
      if (r.waitlistedIds?.length) {
        const rows = await query<{ id: string; campaign_id: string; phone_enc: Buffer; phone_lookup_hmac: string }>(
          'select id, campaign_id, phone_enc, phone_lookup_hmac from enrollments where id = any($1::uuid[])', [r.waitlistedIds]);
        for (const e of rows) await notifyEnrollment(e, 'nh_waitlist', {});
      }
      const { waitlistedIds: _omit, ...pub } = r;
      results.push(pub);
    } catch (e) {
      console.error(`[roster ${c.code}] ${(e as Error).message}`);
      results.push({ code: c.code, action: 'skipped', reason: `error: ${(e as Error).message}` });
    }
  }
  return json({ opened, results });
}