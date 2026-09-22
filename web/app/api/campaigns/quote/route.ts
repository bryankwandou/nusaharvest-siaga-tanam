// POST /api/campaigns/quote -- thresholds (P10/P20 of 1991-2020) + 25-year backtest for a regency.

import { fail, json, parseJson, rateLimit, requireSponsor } from '@/lib/auth';
import { QuoteBody } from '../../_lib/schemas';
import { computeQuote } from '../../_lib/quote';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const auth = await requireSponsor(req);
  if (!auth.ok) return auth.res;
  const rl = await rateLimit(`quote:${auth.sponsorId}`, 20, 3600);
  if (!rl.ok) return fail(429, 'rate_limited', 'quote limit reached, try again later');
  const p = parseJson(QuoteBody, await req.text());
  if (!p.ok) return p.res;
  try {
    const q = await computeQuote(p.data);
    if (!q) return fail(404, 'unknown_region', 'regency is not in the regions table');
    return json(q);
  } catch (e) {
    return fail(502, 'climate_source_error', (e as Error).message);
  }
}
