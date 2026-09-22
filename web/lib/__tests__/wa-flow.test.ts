// Conversation engine (spec 2.3) against an in-memory RegistrationStore. Test-only store:
// production uses pgStore.

import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  handleInbound,
  type CampaignInfo,
  type EngineDeps,
  type InboundMessage,
  type NewEnrollment,
  type OutMessage,
  type RegistrationStore,
  type Session,
  type Transport,
} from '../wa';
import { gridCellFor } from '../climate';
import { phoneLookupHmac } from '../crypto';

const keys = { enc: randomBytes(32), hmac: randomBytes(32) };
const FIELD = { latitude: -7.7123, longitude: 110.6044 };
const CELL = gridCellFor(FIELD.latitude, FIELD.longitude);
const NOW = new Date('2026-09-20T03:00:00Z');

function campaign(over: Partial<CampaignInfo> = {}): CampaignInfo {
  return {
    id: 'c-1',
    code: 'NH-KLT26',
    pubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    sponsorName: 'Yayasan Uji',
    status: 'open',
    gridCells: [CELL],
    freezeTs: new Date('2026-10-01T00:00:00Z'),
    windowStart: '2026-10-01',
    windowEnd: '2026-12-31',
    amountFullIdr: 300_000,
    unitsMax: 100,
    regionName: 'Klaten',
    ...over,
  };
}

class MemStore implements RegistrationStore {
  inbound = new Set<string>();
  sessions = new Map<string, Session>();
  campaigns = new Map<string, CampaignInfo>();
  excluded = new Set<number>();
  enrollments: NewEnrollment[] = [];
  log: { direction: string; template: string }[] = [];
  async claimInbound(id: string) { if (this.inbound.has(id)) return false; this.inbound.add(id); return true; }
  async getSession(h: string) { return this.sessions.get(h) ?? null; }
  async saveSession(s: Session) { this.sessions.set(s.phoneHmac, structuredClone(s)); }
  async findCampaign(code: string) { return [...this.campaigns.values()].find((c) => c.code.toUpperCase() === code.toUpperCase()) ?? null; }
  async getCampaign(id: string) { return this.campaigns.get(id) ?? null; }
  async otherOpenCampaigns(near: CampaignInfo, now: Date) {
    return [...this.campaigns.values()].filter((c) => c.id !== near.id && c.status === 'open' && c.freezeTs > now).map((c) => ({ code: c.code, region: c.regionName }));
  }
  async countEnrolled(id: string) { return this.enrollments.filter((e) => e.campaignId === id && e.status === 'valid').length; }
  async isExcludedCell(cell: number) { return this.excluded.has(cell); }
  async existingProofCode(id: string, h: string) { return this.enrollments.find((e) => e.campaignId === id && e.phoneHmac === h)?.proofCode ?? null; }
  async accountTaken(id: string, h: string) { return this.enrollments.some((e) => e.campaignId === id && e.accountHmac === h); }
  async plotTaken(id: string, hs: string[]) { return this.enrollments.some((e) => e.campaignId === id && hs.includes(e.plotHmac)); }
  async insertEnrollment(e: NewEnrollment) {
    if (this.enrollments.some((x) => x.campaignId === e.campaignId && x.phoneHmac === e.phoneHmac)) return 'duplicate_phone' as const;
    this.enrollments.push(e);
    return 'ok' as const;
  }
  async logMessage(m: { direction: 'in' | 'out'; template: string }) { this.log.push({ direction: m.direction, template: m.template }); }
}

let store: MemStore;
let sent: { to: string; msg: OutMessage }[];
let n = 0;
const transport: Transport = { name: 'local', async send(to, msg) { sent.push({ to, msg }); return { id: null }; } };
const deps = (over: Partial<EngineDeps> = {}): EngineDeps => ({
  store,
  transport,
  inquireName: async () => ({ name: 'Sutrisno', verified: true }),
  now: () => NOW,
  keys,
  ...over,
});
const text = (from: string, t: string): InboundMessage => ({ id: `m${++n}`, from, type: 'text', text: t });
const button = (from: string, id: string): InboundMessage => ({ id: `m${++n}`, from, type: 'interactive', replyId: id, text: id });
const location = (from: string, loc = FIELD): InboundMessage => ({ id: `m${++n}`, from, type: 'location', location: loc });
const last = () => sent[sent.length - 1]!.msg;

async function registerFully(from: string, account: string, loc = FIELD, d = deps()) {
  expect(await handleInbound(text(from, 'DAFTAR NH-KLT26'), d)).toBe('welcome');
  expect(await handleInbound(button(from, 'LANJUT'), d)).toBe('ask_location');
  expect(await handleInbound(location(from, loc), d)).toBe('ask_channel');
  expect(await handleInbound(button(from, 'DANA'), d)).toBe('ask_account');
  expect(await handleInbound(text(from, account), d)).toBe('confirm_name');
  return handleInbound(button(from, 'YA'), d);
}

beforeEach(() => {
  store = new MemStore();
  store.campaigns.set('c-1', campaign());
  sent = [];
});

describe('happy path', () => {
  it('registers, stores only ciphertext and hashes, and replies with the proof code', async () => {
    expect(await registerFully('6281234567001', '081234567001')).toBe('registered');
    const e = store.enrollments[0]!;
    expect(e.status).toBe('valid');
    expect(e.gridCell).toBe(CELL);
    expect(e.nameMasked).toBe('S******O');
    expect(e.leaf).toMatch(/^[0-9a-f]{64}$/);
    expect(e.phoneHmac).toBe(phoneLookupHmac('+6281234567001', keys.hmac));
    expect(e.phoneEnc.toString('utf8')).not.toContain('81234567001');
    expect(JSON.stringify(e)).not.toContain('81234567001');
    expect(last().template).toBe('nh_registered');
    expect(last().text).toContain(e.proofCode);
    // Session draft is cleared and never held plaintext
    expect(JSON.stringify([...store.sessions.values()])).not.toContain('110.6044');
  });

  it('ignores a redelivered message id', async () => {
    const m = text('6281234567001', 'DAFTAR NH-KLT26');
    expect(await handleInbound(m, deps())).toBe('welcome');
    expect(await handleInbound(m, deps())).toBe('duplicate_delivery');
  });
});

describe('failure branches', () => {
  it('unknown campaign code', async () => {
    expect(await handleInbound(text('6281234567002', 'DAFTAR NH-NOPE99'), deps())).toBe('unknown_campaign');
    expect(last().template).toBe('nh_unknown_code');
    expect(last().text).toContain('NH-NOPE99');
  });

  it('registration after freeze_ts, with other programmes in the area listed', async () => {
    store.campaigns.set('c-2', campaign({ id: 'c-2', code: 'NH-KLT27', freezeTs: new Date('2027-01-01T00:00:00Z') }));
    const late = deps({ now: () => new Date('2026-10-01T00:00:00Z') }); // exactly freeze_ts
    expect(await handleInbound(text('6281234567003', 'DAFTAR NH-KLT26'), late)).toBe('closed');
    expect(last().template).toBe('nh_closed');
    expect(last().text).toContain('DAFTAR NH-KLT27');
  });

  it('freeze_ts passing in the middle of a conversation closes it', async () => {
    const from = '6281234567004';
    expect(await handleInbound(text(from, 'DAFTAR NH-KLT26'), deps())).toBe('welcome');
    expect(await handleInbound(button(from, 'LANJUT'), deps())).toBe('ask_location');
    const late = deps({ now: () => new Date('2026-10-01T00:00:01Z') });
    expect(await handleInbound(location(from), late)).toBe('closed');
    expect(store.enrollments).toHaveLength(0);
  });

  it('quota full', async () => {
    store.campaigns.set('c-1', campaign({ unitsMax: 1 }));
    expect(await registerFully('6281234567005', '081234567005')).toBe('registered');
    expect(await handleInbound(text('6281234567006', 'DAFTAR NH-KLT26'), deps())).toBe('full');
    expect(last().template).toBe('nh_full');
  });

  it('duplicate phone at start and at confirmation', async () => {
    const from = '6281234567007';
    expect(await registerFully(from, '081234567007')).toBe('registered');
    const code = store.enrollments[0]!.proofCode;
    expect(await handleInbound(text(from, 'DAFTAR NH-KLT26'), deps())).toBe('duplicate_phone');
    expect(last().text).toContain(code);
    expect(store.enrollments).toHaveLength(1);
  });

  it('duplicate payout account', async () => {
    expect(await registerFully('6281234567008', '081299990000')).toBe('registered');
    const other = '6281234567009';
    await handleInbound(text(other, 'DAFTAR NH-KLT26'), deps());
    await handleInbound(button(other, 'LANJUT'), deps());
    await handleInbound(location(other, { latitude: -7.7300, longitude: 110.6200 }), deps());
    await handleInbound(button(other, 'DANA'), deps());
    expect(await handleInbound(text(other, '081299990000'), deps())).toBe('duplicate_account');
  });

  it('duplicate plot within 20 m', async () => {
    expect(await registerFully('6281234567010', '081234567010')).toBe('registered');
    const other = '6281234567011';
    await handleInbound(text(other, 'DAFTAR NH-KLT26'), deps());
    await handleInbound(button(other, 'LANJUT'), deps());
    expect(await handleInbound(location(other, { latitude: FIELD.latitude + 0.0001, longitude: FIELD.longitude }), deps())).toBe('duplicate_plot');
  });

  it('invalid village: location outside the campaign cells', async () => {
    const from = '6281234567012';
    await handleInbound(text(from, 'DAFTAR NH-KLT26'), deps());
    await handleInbound(button(from, 'LANJUT'), deps());
    expect(await handleInbound(location(from, { latitude: -6.2, longitude: 106.8 }), deps())).toBe('outside_area');
    expect(last().template).toBe('nh_outside_area');
    expect(store.sessions.get(phoneLookupHmac('+6281234567012', keys.hmac))!.state).toBe('idle');
  });

  it('invalid village: technically irrigated cell is excluded', async () => {
    store.excluded.add(CELL);
    const from = '6281234567013';
    await handleInbound(text(from, 'DAFTAR NH-KLT26'), deps());
    await handleInbound(button(from, 'LANJUT'), deps());
    expect(await handleInbound(location(from), deps())).toBe('outside_area');
  });

  it('a text instead of a location re-prompts', async () => {
    const from = '6281234567014';
    await handleInbound(text(from, 'DAFTAR NH-KLT26'), deps());
    await handleInbound(button(from, 'LANJUT'), deps());
    expect(await handleInbound(text(from, 'desa Sukamaju'), deps())).toBe('reprompt');
    expect(last().requestLocation).toBe(true);
  });

  it('opt-out stops the flow and silences later messages until DAFTAR', async () => {
    const from = '6281234567015';
    await handleInbound(text(from, 'DAFTAR NH-KLT26'), deps());
    expect(await handleInbound(text(from, 'stop'), deps())).toBe('opted_out');
    expect(last().template).toBe('nh_optout');
    const before = sent.length;
    expect(await handleInbound(text(from, 'halo'), deps())).toBe('ignored_opted_out');
    expect(sent.length).toBe(before);
    expect(await handleInbound(text(from, 'DAFTAR NH-KLT26'), deps())).toBe('welcome');
  });

  it('declining consent cancels', async () => {
    const from = '6281234567016';
    await handleInbound(text(from, 'DAFTAR NH-KLT26'), deps());
    expect(await handleInbound(button(from, 'TIDAK'), deps())).toBe('declined');
  });

  it('account the gateway cannot find, and a gateway outage, both ask again', async () => {
    const from = '6281234567017';
    const d = deps({ inquireName: async () => null });
    await handleInbound(text(from, 'DAFTAR NH-KLT26'), d);
    await handleInbound(button(from, 'LANJUT'), d);
    await handleInbound(location(from), d);
    await handleInbound(button(from, 'DANA'), d);
    expect(await handleInbound(text(from, '081234567017'), d)).toBe('account_invalid');
    const down = deps({ inquireName: async () => { throw new Error('503'); } });
    expect(await handleInbound(text({ ...text(from, '') }.from, '081234567017'), down)).toBe('account_invalid');
  });
});
