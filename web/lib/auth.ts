// Request guards shared by the route handlers: JSON responses, zod body parsing,
// signed cron requests, sponsor sessions and the public rate limiter.

import { createHmac } from 'node:crypto';
import type { z } from 'zod';
import { hmacHex, safeEqualHex, verifyCronRequest } from './crypto';
import { env } from './env';
import { one, type Queryable, db } from './db';

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** Matches web/types/api.ts ApiError: `error` is a stable machine code, `message` is for humans. */
export interface ApiError {
  error: string;
  message?: string;
  issues?: { path: string; message: string }[];
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export const fail = (status: number, code: string, message: string, extra: Pick<ApiError, 'issues'> = {}): Response =>
  json({ error: code, message, ...extra } satisfies ApiError, status);

/** Parse raw text as JSON and validate with zod. Returns the data or a 400 Response. */
export function parseJson<S extends z.ZodType>(schema: S, raw: string): { ok: true; data: z.infer<S> } | { ok: false; res: Response } {
  let value: unknown;
  try {
    value = raw.length ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, res: fail(400, 'bad_json', 'request body is not valid JSON') };
  }
  const r = schema.safeParse(value);
  if (!r.success) {
    return {
      ok: false,
      res: fail(400, 'invalid_body', 'request body failed validation', {
        issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      }),
    };
  }
  return { ok: true, data: r.data };
}

// ---------------------------------------------------------------------------
// Cron: x-nh-timestamp + x-nh-signature = HMAC(CRON_SECRET, `${ts}.${body}`)
// ---------------------------------------------------------------------------

export async function requireCron(req: Request): Promise<{ ok: true; raw: string } | { ok: false; res: Response }> {
  const raw = await req.text();
  const v = verifyCronRequest(process.env.CRON_SECRET, req.headers.get('x-nh-timestamp'), req.headers.get('x-nh-signature'), raw);
  if (!v.ok) return { ok: false, res: fail(401, 'unauthorized', v.reason) };
  return { ok: true, raw };
}

// ---------------------------------------------------------------------------
// Sponsor session: `nh_sponsor` cookie or `Authorization: Bearer`, value
// base64url(JSON {sid, exp}) + "." + hex HMAC(SESSION_SECRET). Issued by the
// sponsor onboarding flow via issueSponsorToken().
// ---------------------------------------------------------------------------

const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

export function issueSponsorToken(sponsorId: string, ttlSecs = 8 * 3600, secret = env.sessionSecret(), now = Date.now()): string {
  const payload = b64u(JSON.stringify({ sid: sponsorId, exp: Math.floor(now / 1000) + ttlSecs }));
  return `${payload}.${hmacHex(secret, `nh:session:v1:${payload}`)}`;
}

export function verifySponsorToken(token: string, secret: string, now = Date.now()): string | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  if (!safeEqualHex(hmacHex(secret, `nh:session:v1:${payload}`), sig)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sid?: unknown; exp?: unknown };
    if (typeof p.sid !== 'string' || typeof p.exp !== 'number' || p.exp * 1000 < now) return null;
    return p.sid;
  } catch {
    return null;
  }
}

export async function requireSponsor(req: Request): Promise<{ ok: true; sponsorId: string } | { ok: false; res: Response }> {
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const cookie = req.headers.get('cookie')?.match(/(?:^|;\s*)nh_sponsor=([^;]+)/)?.[1];
  const token = bearer ?? cookie;
  if (!token) return { ok: false, res: fail(401, 'unauthorized', 'sponsor session required') };
  const sid = verifySponsorToken(decodeURIComponent(token), env.sessionSecret());
  if (!sid) return { ok: false, res: fail(401, 'unauthorized', 'invalid or expired sponsor session') };
  const row = await one<{ id: string }>('select id from sponsors where id = $1', [sid]);
  if (!row) return { ok: false, res: fail(401, 'unauthorized', 'sponsor not found') };
  return { ok: true, sponsorId: row.id };
}

// ---------------------------------------------------------------------------
// Rate limit: fixed window counter in Postgres (works across serverless instances).
// The client key is HMACed so raw IPs are not stored.
// ---------------------------------------------------------------------------

export function clientKey(req: Request): string {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
  return createHmac('sha256', process.env.PII_HMAC_KEY ?? 'nh-ratelimit').update(`nh:ip:v1:${ip}`).digest('hex').slice(0, 32);
}

export async function rateLimit(
  bucket: string,
  limit: number,
  windowSecs: number,
  q: Queryable = db(),
  now = Date.now(),
): Promise<{ ok: boolean; remaining: number; resetSecs: number }> {
  const start = Math.floor(now / 1000 / windowSecs) * windowSecs;
  const r = await q.query<{ count: number }>(
    `insert into rate_limits (bucket, window_start, count) values ($1, to_timestamp($2), 1)
     on conflict (bucket, window_start) do update set count = rate_limits.count + 1
     returning count`,
    [bucket, start],
  );
  const count = Number(r.rows[0]?.count ?? limit + 1);
  return { ok: count <= limit, remaining: Math.max(0, limit - count), resetSecs: start + windowSecs - Math.floor(now / 1000) };
}

export async function limitPublic(req: Request, route: string, limit = 30, windowSecs = 60): Promise<Response | null> {
  const r = await rateLimit(`${route}:${clientKey(req)}`, limit, windowSecs);
  if (r.ok) return null;
  return json({ error: 'rate_limited', message: 'too many requests, try again later' } satisfies ApiError, 429, {
    'retry-after': String(r.resetSecs),
  });
}

/** 503 when this deployment has no database, so callers get an honest "not connected" instead of a generic 500. */
export const dbNotConfigured = (): Response | null =>
  process.env.DATABASE_URL ? null : fail(503, 'not_configured', 'the campaign database is not connected on this deployment');
