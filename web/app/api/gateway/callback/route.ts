// POST /api/gateway/callback -- disbursement status from the payment gateway (spec 4.2).
// Not implemented until the provider (and its signature scheme) is chosen; rejects everything.

import { fail } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  return fail(501, 'not_implemented', 'gateway callback awaits the disbursement gateway contract');
}