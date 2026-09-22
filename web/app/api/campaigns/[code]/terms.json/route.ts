// GET /api/campaigns/:code/terms.json -- canonical terms document; sha256 of the body = terms_hash.

import { fail } from '@/lib/auth';
import { one } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  const { code } = await ctx.params;
  if (!/^[A-Za-z0-9-]{3,32}$/.test(code)) return fail(404, 'not_found', 'campaign not found');
  const r = await one<{ terms_doc: string | null; terms_hash: string | null }>(
    `select terms_doc, terms_hash from campaigns where upper(code) = upper($1) and status <> 'draft'`,
    [code],
  );
  if (!r?.terms_doc) return fail(404, 'not_found', 'terms not found');
  return new Response(r.terms_doc, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-nh-terms-hash': r.terms_hash ?? '', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' },
  });
}