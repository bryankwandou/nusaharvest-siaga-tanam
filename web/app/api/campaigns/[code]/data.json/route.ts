// GET /api/campaigns/:code/data.json -- the exact canonical settlement JSON whose sha256 is
// data_hash on chain. Served byte-for-byte as stored so anyone can recompute the hash.

import { fail } from '@/lib/auth';
import { one } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  const { code } = await ctx.params;
  if (!/^[A-Za-z0-9-]{3,32}$/.test(code)) return fail(404, 'not_found', 'campaign not found');
  const r = await one<{ data_json: string | null; data_hash: string | null }>(
    `select s.data_json, s.data_hash from settlements s join campaigns c on c.id = s.campaign_id
      where upper(c.code) = upper($1) and c.status <> 'draft'`,
    [code],
  );
  if (!r?.data_json) return fail(404, 'not_settled', 'no settlement data for this campaign yet');
  return new Response(r.data_json, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-nh-data-hash': r.data_hash ?? '',
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });
}