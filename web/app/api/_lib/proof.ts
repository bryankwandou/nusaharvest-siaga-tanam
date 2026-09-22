// Registration lookup shared by /api/proof/roster and /api/proof/receipt.
// Input: campaign code + phone + proof code. The phone is used only to compute the HMAC
// lookup value in memory; it is never stored, returned or logged.

import type { RosterProofResponse } from '@/types/api';
import { timingSafeEqual } from 'node:crypto';
import { one } from '@/lib/db';
import { env } from '@/lib/env';
import { normalizePhoneE164, normalizeProofCode, phoneLookupHmac } from '@/lib/crypto';
import { loadProof } from '@/lib/roster';

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function lookupProof(input: { code: string; phone: string; proofCode: string }): Promise<RosterProofResponse> {
  const empty: RosterProofResponse = {
    found: false, cluster: env.cluster(), campaignPubkey: null, saltHex: null, plotCell: null, leaf: null, proof: [], root: null, lockedAt: null, receipt: null,
  };
  const phone = normalizePhoneE164(input.phone);
  const proofCode = normalizeProofCode(input.proofCode);
  const c = await one<{ id: string; pubkey: string | null }>(
    `select id, pubkey from campaigns where upper(code) = upper($1) and status <> 'draft'`, [input.code]);
  if (!c) return empty;
  const base = { ...empty, campaignPubkey: c.pubkey };
  if (!phone || !proofCode) return base;

  const e = await one<{ id: string; salt: Buffer; grid_cell: number; leaf: string; proof_code: string; locked_at: Date | null }>(
    `select id, salt, grid_cell, leaf, proof_code, locked_at from enrollments
      where campaign_id = $1 and phone_lookup_hmac = $2 and status in ('valid','waitlist')`,
    [c.id, phoneLookupHmac(phone)],
  );
  // Same response whether the phone or the code is wrong: no enumeration oracle.
  if (!e || !eq(e.proof_code, proofCode)) return base;

  const roster = await loadProof(c.id, 'roster', e.leaf);
  let receipt: RosterProofResponse['receipt'] = null;
  const pay = await one<{ amount_idr: number; paid_at: Date; gateway_ref_hash: string; receipt_leaf: string; manual: boolean | null }>(
    `select p.amount_idr, p.paid_at, p.gateway_ref_hash, p.receipt_leaf, rp.manual_disbursement as manual
       from payouts p left join receipt_posts rp on rp.campaign_id = p.campaign_id
      where p.enrollment_id = $1 and p.status = 'paid' and p.receipt_leaf is not null`,
    [e.id],
  );
  if (pay) {
    const rp = await loadProof(c.id, 'receipts', pay.receipt_leaf);
    if (rp) {
      receipt = {
        leaf: pay.receipt_leaf,
        proof: rp.proof,
        root: rp.root,
        amountIdr: pay.amount_idr,
        paidTs: Math.floor(new Date(pay.paid_at).getTime() / 1000),
        gatewayRefHash: pay.gateway_ref_hash,
        manualDisbursement: pay.manual ?? false,
      };
    }
  }
  return {
    ...base,
    found: roster !== null,
    saltHex: Buffer.from(e.salt).toString('hex'),
    plotCell: e.grid_cell,
    leaf: e.leaf,
    proof: roster?.proof ?? [],
    root: roster?.root ?? null,
    lockedAt: e.locked_at ? new Date(e.locked_at).toISOString() : null,
    receipt,
  };
}