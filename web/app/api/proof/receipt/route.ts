// POST /api/proof/receipt -- {code, phone, proofCode} -> {found, cluster, campaignPubkey, receipt}.

import { json, limitPublic, parseJson } from '@/lib/auth';
import { ProofBody } from '../../_lib/schemas';
import { lookupProof } from '../../_lib/proof';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const limited = await limitPublic(req, 'proof', 10, 60);
  if (limited) return limited;
  const p = parseJson(ProofBody, await req.text());
  if (!p.ok) return p.res;
  const r = await lookupProof(p.data);
  return json({ found: r.receipt !== null, cluster: r.cluster, campaignPubkey: r.campaignPubkey, receipt: r.receipt });
}