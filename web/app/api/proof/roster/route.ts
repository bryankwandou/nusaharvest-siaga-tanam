// POST /api/proof/roster -- {code, phone, proofCode} -> RosterProofResponse.
// The browser verifies the proof against roster_root read from RPC, not against `root` here.

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
  return json(await lookupProof(p.data));
}