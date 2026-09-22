// POST /api/cron/settle -- signed cron. Settle / Release / Refund per settleGate (spec 2.5, 2.6).

import { json, requireCron } from '@/lib/auth';
import { runSettlement } from '../../_lib/settle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.res;
  return json({ results: await runSettlement() });
}