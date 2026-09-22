import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature } from '../wa';

const SECRET = 'meta-app-secret-for-tests';
const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [] } }] }] });
const sign = (b: string, s = SECRET) => `sha256=${createHmac('sha256', s).update(b, 'utf8').digest('hex')}`;

describe('X-Hub-Signature-256', () => {
  it('accepts a valid signature', () => {
    expect(verifyMetaSignature(SECRET, body, sign(body))).toBe(true);
  });
  it('accepts uppercase hex', () => {
    expect(verifyMetaSignature(SECRET, body, sign(body).toUpperCase().replace('SHA256=', 'sha256='))).toBe(true);
  });
  it('rejects a tampered body', () => {
    expect(verifyMetaSignature(SECRET, body.replace('messages', 'messagez'), sign(body))).toBe(false);
  });
  it('rejects a tampered signature', () => {
    const s = sign(body);
    const flipped = s.slice(0, -1) + (s.endsWith('0') ? '1' : '0');
    expect(verifyMetaSignature(SECRET, body, flipped)).toBe(false);
  });
  it('rejects a signature made with another secret', () => {
    expect(verifyMetaSignature(SECRET, body, sign(body, 'other'))).toBe(false);
  });
  it('rejects unsigned requests and a missing app secret', () => {
    expect(verifyMetaSignature(SECRET, body, null)).toBe(false);
    expect(verifyMetaSignature(SECRET, body, '')).toBe(false);
    expect(verifyMetaSignature(undefined, body, sign(body))).toBe(false);
  });
  it('rejects the wrong scheme prefix and truncated digests', () => {
    expect(verifyMetaSignature(SECRET, body, sign(body).replace('sha256=', 'sha1='))).toBe(false);
    expect(verifyMetaSignature(SECRET, body, sign(body).slice(0, 40))).toBe(false);
  });
});