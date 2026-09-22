// GET /api/campaigns/:code -- public proof page data (CampaignDetail).

import { dbNotConfigured, fail, json, limitPublic } from '@/lib/auth';
import { buildDetail, findCampaignByCode } from '../../_lib/campaign-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  const nc = dbNotConfigured();
  if (nc) return nc;
  const limited = await limitPublic(req, 'campaign', 120, 60);
  if (limited) return limited;
  const { code } = await ctx.params;
  if (!/^[A-Za-z0-9-]{3,32}$/.test(code)) return fail(404, 'not_found', 'campaign not found');
  const row = await findCampaignByCode(code);
  if (!row) return fail(404, 'not_found', 'campaign not found');
  return json(await buildDetail(row), 200, { 'cache-control': 'public, max-age=15' });
}