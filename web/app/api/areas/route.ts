// GET /api/areas -- regencies available in the sponsor console (AreasResponse).

import type { AreasResponse } from '@/types/api';
import { dbNotConfigured, json } from '@/lib/auth';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const nc = dbNotConfigured();
  if (nc) return nc;
  const rows = await query<{ regency: string; province: string }>('select regency, province from regions order by province, regency');
  return json({ areas: rows } satisfies AreasResponse, 200, { 'cache-control': 'public, max-age=3600' });
}