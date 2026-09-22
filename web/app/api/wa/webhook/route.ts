// WhatsApp Cloud API webhook (spec 4.2).
//   GET  verification handshake (hub.verify_token)
//   POST inbound messages; every request must carry a valid X-Hub-Signature-256.

import { defaultTransport, gatewayNameInquiry, handleInbound, parseMetaPayload, pgStore, verifyMetaSignature } from '@/lib/wa';
import { fail, json } from '@/lib/auth';
import { safeEqualHex } from '@/lib/crypto';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const mode = u.searchParams.get('hub.mode');
  const token = u.searchParams.get('hub.verify_token') ?? '';
  const challenge = u.searchParams.get('hub.challenge') ?? '';
  const expected = process.env.WA_VERIFY_TOKEN;
  if (!expected) return fail(500, 'not_configured', 'WA_VERIFY_TOKEN is not set');
  const h = (s: string) => createHash('sha256').update(s).digest('hex');
  if (mode !== 'subscribe' || !safeEqualHex(h(token), h(expected)) || !/^[0-9A-Za-z_-]{1,128}$/.test(challenge)) {
    return fail(403, 'forbidden', 'verification failed');
  }
  return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
}

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();
  if (!verifyMetaSignature(process.env.WA_APP_SECRET, raw, req.headers.get('x-hub-signature-256'))) {
    return fail(401, 'bad_signature', 'missing or invalid X-Hub-Signature-256');
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'bad_json', 'request body is not valid JSON');
  }
  const messages = parseMetaPayload(body);
  const transport = defaultTransport();
  const outcomes: string[] = [];
  for (const m of messages) {
    try {
      outcomes.push(await handleInbound(m, { store: pgStore, transport, inquireName: gatewayNameInquiry, now: () => new Date() }));
    } catch (e) {
      // Logged without the payload: it contains the sender's number.
      console.error(`[wa] handler error for message ${m.id.slice(0, 16)}: ${(e as Error).message}`);
      outcomes.push('error');
    }
  }
  // Always 200 once the signature is valid, so Meta does not retry messages we already
  // recorded in wa_inbound; failures are visible in message_log and server logs.
  return json({ received: messages.length, outcomes });
}
