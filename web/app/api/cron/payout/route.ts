// POST /api/cron/payout -- batch disbursement (spec 2.6). Not implemented: the BI-licensed
// disbursement provider has not been chosen, and this endpoint must not pretend to pay anyone.

import { fail, requireCron } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.res;
  return fail(501, 'not_implemented', 'payout worker awaits the disbursement gateway contract');
}