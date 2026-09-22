// GET  /api/campaigns  -- public list (CampaignListResponse)
// POST /api/campaigns  -- sponsor saves a draft; returns the terms hash and, for ESCROW,
//                         the unsigned CreateCampaign transaction to sign in the wallet.
//                         PLEDGE: NusaHarvest signs CreateCampaign itself (spec 2.2 D).

import { randomBytes } from 'node:crypto';
import type { CampaignListResponse, CreateCampaignResponse } from '@/types/api';
import { fail, json, parseJson, requireSponsor } from '@/lib/auth';
import { query, one } from '@/lib/db';
import { env } from '@/lib/env';
import { encryptText } from '@/lib/crypto';
import { canonicalJson, canonicalSha256, CLIMATE_SCRIPT_VERSION } from '@/lib/climate';
import { createCampaignInstruction } from '@/lib/chain/encode';
import { associatedTokenAddress, campaignPda, sendAsOperator, unsignedTransaction, vaultPda, windowEndTsFor } from '@/lib/roster';
import { CreateCampaignBody } from '../_lib/schemas';
import { computeQuote } from '../_lib/quote';
import { listSummaries } from '../_lib/campaign-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(): Promise<Response> {
  try {
    return json({ campaigns: await listSummaries() } satisfies CampaignListResponse);
  } catch (e) {
    console.error(`[campaigns] list failed: ${(e as Error).message}`);
    return fail(500, 'internal', 'could not load campaigns');
  }
}

const WIB = 7 * 3600;
const startOfDayWib = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, dd) / 1000 - WIB;
};

async function allocateCode(regency: string, windowStart: string): Promise<string> {
  const letters = regency.toUpperCase().replace(/^(KABUPATEN|KAB\.?|KOTA)\s+/, '').replace(/[^A-Z]/g, '');
  const stem = `NH-${(letters.slice(0, 1) + letters.slice(1).replace(/[AEIOU]/g, '')).slice(0, 3).padEnd(3, 'X')}${windowStart.slice(2, 4)}`;
  for (let i = 1; i <= 50; i++) {
    const code = i === 1 ? stem : `${stem}-${i}`;
    if (!(await one('select 1 from campaigns where upper(code) = $1', [code]))) return code;
  }
  throw new Error('could not allocate a campaign code');
}

function termsText(v: { sponsor: string; regency: string; province: string; window: string; full: number; half: number; units: number; pledge: boolean }) {
  const f = (n: number) => n.toLocaleString('id-ID');
  return {
    id: [
      `Program Siaga Tanam oleh ${v.sponsor} untuk petani di ${v.regency}, ${v.province}.`,
      `Jika total hujan wilayah pada ${v.window} berada di bawah persentil 10 periode 1991-2020, setiap penerima terdaftar mendapat Rp${f(v.full)}; di bawah persentil 20, Rp${f(v.half)}.`,
      `Kuota maksimum ${v.units} penerima. Tidak ada biaya bagi petani dan tidak perlu mengajukan apa pun.`,
      'Data hujan diambil dari sumber publik yang tercantum di dokumen ini dan hasilnya dapat dihitung ulang siapa pun.',
      v.pledge ? 'Dana tidak dikunci on-chain; sponsor terikat surat komitmen yang hash-nya tercatat di sini.' : 'Dana dikunci di rekening program on-chain sampai penyelesaian.',
    ].join(' '),
    en: [
      `Siaga Tanam programme by ${v.sponsor} for farmers in ${v.regency}, ${v.province}.`,
      `If area rainfall during ${v.window} is below the 1991-2020 10th percentile, each registered recipient receives Rp${f(v.full)}; below the 20th percentile, Rp${f(v.half)}.`,
      `At most ${v.units} recipients. Farmers pay nothing and file nothing.`,
      'Rainfall comes from the public sources listed in this document and anyone can recompute the result.',
      v.pledge ? 'Funds are not locked on-chain; the sponsor is bound by a commitment letter whose hash is recorded here.' : 'Funds are locked in the on-chain programme vault until settlement.',
    ].join(' '),
  };
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireSponsor(req);
  if (!auth.ok) return auth.res;
  const p = parseJson(CreateCampaignBody, await req.text());
  if (!p.ok) return p.res;
  const b = p.data;

  const nowSecs = Math.floor(Date.now() / 1000);
  const freezeTs = b.freezeTs ?? startOfDayWib(b.windowStartDate);
  const windowEndTs = windowEndTsFor(b.windowEndDate);
  if (!(nowSecs < freezeTs && freezeTs < windowEndTs)) {
    return fail(400, 'bad_schedule', 'need now < freezeTs < end of window');
  }

  let q;
  try {
    q = await computeQuote(b);
  } catch (e) {
    return fail(502, 'climate_source_error', (e as Error).message);
  }
  if (!q) return fail(404, 'unknown_region', 'regency is not in the regions table');
  if (q.thrFullMm10 !== b.thrFullMm10 || q.thrHalfMm10 !== b.thrHalfMm10) {
    return fail(409, 'thresholds_changed', 'thresholds differ from the server computation; request a new quote');
  }

  const dec = env.mintDecimals();
  const toBase = (idr: number) => BigInt(Math.ceil((idr * 10 ** dec) / env.idrPerToken()));
  const amountFull = toBase(b.amountFullIdr);
  const amountHalf = toBase(b.amountHalfIdr);
  const pledge = b.mode === 'pledge';
  const sponsorKey = pledge ? env.operatorPubkey() : (b.sponsorWallet as string);
  const campaignId = BigInt(`0x${randomBytes(6).toString('hex')}`);
  const code = await allocateCode(b.regency, b.windowStartDate);
  const termsDocUrl = `${env.publicBaseUrl()}/api/campaigns/${code}/terms.json`;

  const sponsor = await one<{ legal_name: string }>('select legal_name from sponsors where id = $1', [auth.sponsorId]);
  const terms = {
    schema: 'nusaharvest.terms.v1',
    rule_version: 1,
    code,
    sponsor: sponsor?.legal_name ?? b.sponsorName,
    mode: b.mode,
    area: { regency: b.regency, province: b.province, grid_cells: q.gridCells },
    commodity: b.commodity,
    freeze_ts: freezeTs,
    window: { start: b.windowStartDate, end: b.windowEndDate, end_ts: windowEndTs },
    thresholds: { thr_full_mm10: q.thrFullMm10, thr_half_mm10: q.thrHalfMm10, baseline: '1991-2020', full: 'p10', half: 'p20' },
    amounts: {
      amount_full_idr: b.amountFullIdr,
      amount_half_idr: b.amountHalfIdr,
      amount_full_base: amountFull.toString(),
      amount_half_base: amountHalf.toString(),
      mint: env.usdcMint(),
      units_max: b.unitsMax,
    },
    data_sources: { primary: 'open-meteo-archive (ERA5)', secondary: 'nasa-power', quote_sources: q.sources.map((s) => ({ url: s.url, raw_sha256: s.rawSha256 })) },
    script: { version: CLIMATE_SCRIPT_VERSION, commit: env.scriptCommit() },
    text: termsText({
      sponsor: sponsor?.legal_name ?? b.sponsorName,
      regency: b.regency,
      province: b.province,
      window: `${b.windowStartDate} - ${b.windowEndDate}`,
      full: b.amountFullIdr,
      half: b.amountHalfIdr,
      units: b.unitsMax,
      pledge,
    }),
  };
  const termsDoc = canonicalJson(terms);
  const termsHash = canonicalSha256(terms);

  const campaign = await campaignPda(sponsorKey, campaignId);
  const vault = await vaultPda(campaign);
  const mint = env.usdcMint();
  const sponsorToken = await associatedTokenAddress(sponsorKey, mint);
  const args = {
    campaignId,
    operator: env.operatorPubkey(),
    auditor: env.auditorPubkey(),
    disburser: env.disburserPubkey(),
    freezeTs: BigInt(freezeTs),
    windowEndTs: BigInt(windowEndTs),
    amountFull,
    amountHalf,
    thrFull: q.thrFullMm10,
    thrHalf: q.thrHalfMm10,
    termsHash,
    deposit: pledge ? 0n : amountFull * BigInt(b.unitsMax),
    pledge,
  };

  const row = await one<{ id: string }>(
    `insert into campaigns (sponsor_id, code, pubkey, campaign_id, mode, grid_cells, regency, province, commodity, freeze_ts,
       window_start, window_end, thr_full_mm10, thr_half_mm10, amount_full_idr, amount_half_idr, units_max, terms_doc_url,
       terms_hash, terms_doc, amount_full_base, amount_half_base, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10),$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'draft') returning id`,
    [auth.sponsorId, code, campaign, campaignId.toString(), b.mode, q.gridCells, b.regency, b.province, b.commodity, freezeTs,
      b.windowStartDate, b.windowEndDate, q.thrFullMm10, q.thrHalfMm10, b.amountFullIdr, b.amountHalfIdr, b.unitsMax, termsDocUrl,
      termsHash, termsDoc, amountFull.toString(), amountHalf.toString()],
  );
  await query('update sponsors set wallet = coalesce($2, wallet), contact_email_enc = $3 where id = $1', [
    auth.sponsorId, b.sponsorWallet, encryptText(b.contactEmail),
  ]);

  if (pledge) {
    try {
      const sig = await sendAsOperator((operator) =>
        createCampaignInstruction(env.programId(), { sponsor: operator, campaign, vault, mint, sponsorToken }, args),
      );
      await query(`update campaigns set status = 'open', created_tx = $2 where id = $1`, [row!.id, sig]);
      await query(`insert into campaign_events (campaign_id, status, tx_sig) values ($1, 'open', $2)`, [row!.id, sig]);
      return json({ code, termsHash, termsDocUrl, transactionBase64: null, nextStep: 'Campaign created on chain in PLEDGE mode. Share the WhatsApp registration link.' } satisfies CreateCampaignResponse, 201);
    } catch (e) {
      console.error(`[campaigns] pledge create failed for ${code}: ${(e as Error).message}`);
      return fail(502, 'chain_error', 'draft saved but CreateCampaign failed; retry from the console');
    }
  }

  const built = await unsignedTransaction(sponsorKey, createCampaignInstruction(env.programId(), { sponsor: sponsorKey, campaign, vault, mint, sponsorToken }, args));
  return json({ code, termsHash, termsDocUrl, transactionBase64: built.transaction, nextStep: null } satisfies CreateCampaignResponse, 201);
}
