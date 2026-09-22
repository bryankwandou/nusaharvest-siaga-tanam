// WhatsApp registration bot (spec 02 section 2.3) and the WhatsApp Cloud API transport.
//
// Layout:
//   1. signature check for Meta webhooks (X-Hub-Signature-256)
//   2. message templates (spec 4.3 plus the bot prompts), Indonesian and English
//   3. transports: 'meta' (Graph API) and 'local' (logs, dev only; refused in production)
//   4. payout account name inquiry (payment gateway)
//   5. the conversation engine, written against a RegistrationStore so every branch is testable
//   6. the Postgres RegistrationStore used in production
//
// PII rule: no raw phone number, name, account number or coordinate is ever logged or
// stored in plaintext. Sessions are keyed by phone_lookup_hmac and the draft holds ciphertext.

import { createHmac } from 'node:crypto';
import {
  decryptText,
  encryptText,
  hmacHex,
  normalizePhoneE164,
  newProofCode,
  parseKey32,
  phoneLookupHmac,
  randomSalt16,
  safeEqualHex,
} from './crypto';
import { gridCellFor } from './climate';
import { phoneHash, rosterLeaf, toHex } from './merkle';
import { addressToBytes } from './chain/base58';
import { env } from './env';
import { query, one, tx, type Queryable } from './db';

// ---------------------------------------------------------------------------
// 1. Signature
// ---------------------------------------------------------------------------

/** Verify Meta's `X-Hub-Signature-256: sha256=<hex>` over the exact raw body. */
export function verifyMetaSignature(appSecret: string | undefined, rawBody: string, header: string | null): boolean {
  if (!appSecret || !header) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m?.[1]) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  return safeEqualHex(expected, m[1].toLowerCase());
}

// ---------------------------------------------------------------------------
// 2. Templates
// ---------------------------------------------------------------------------

export type Lang = 'id' | 'en';
export type TemplateName =
  | 'nh_welcome'
  | 'nh_registered'
  | 'nh_result_trigger'
  | 'nh_result_none'
  | 'nh_paid'
  | 'nh_failed'
  | 'nh_unknown_code'
  | 'nh_closed'
  | 'nh_full'
  | 'nh_duplicate'
  | 'nh_duplicate_other'
  | 'nh_ask_location'
  | 'nh_outside_area'
  | 'nh_ask_channel'
  | 'nh_ask_account'
  | 'nh_account_invalid'
  | 'nh_confirm_name'
  | 'nh_declined'
  | 'nh_optout'
  | 'nh_waitlist'
  | 'nh_help';

type Vars = Record<string, string>;
const T: Record<TemplateName, Record<Lang, string>> = {
  nh_welcome: {
    id: 'Halo. Ini program Siaga Tanam dari {sponsor}. Kalau hujan di wilayahmu jauh di bawah normal pada {window}, kamu dapat Rp{amount} otomatis. Tidak ada biaya dan tidak perlu mengurus klaim. Lanjut?',
    en: 'Hello. This is the Siaga Tanam programme from {sponsor}. If rain in your area is far below normal during {window}, you receive Rp{amount} automatically. There is no fee and nothing to file. Continue?',
  },
  nh_registered: {
    id: 'Kamu terdaftar. Kode bukti: {code}. Simpan pesan ini.',
    en: 'You are registered. Proof code: {code}. Keep this message.',
  },
  nh_result_trigger: {
    id: 'Hujan di wilayahmu {observed} mm, di bawah batas {threshold} mm. Rp{amount} akan dikirim setelah {date}.',
    en: 'Rain in your area was {observed} mm, below the {threshold} mm limit. Rp{amount} will be sent after {date}.',
  },
  nh_result_none: {
    id: 'Hujan di wilayahmu {observed} mm, masih di atas batas {threshold} mm. Program ini tidak mencairkan dana musim ini.',
    en: 'Rain in your area was {observed} mm, above the {threshold} mm limit. This programme does not pay out this season.',
  },
  nh_paid: {
    id: 'Rp{amount} sudah masuk ke {channel} kamu. Bukti: {url}',
    en: 'Rp{amount} has arrived in your {channel}. Proof: {url}',
  },
  nh_failed: {
    id: 'Pengiriman gagal karena {reason}. Balas UBAH dalam 14 hari untuk ganti akun.',
    en: 'Sending failed because {reason}. Reply UBAH within 14 days to change the account.',
  },
  nh_unknown_code: {
    id: 'Kode program {code} tidak dikenal. Periksa lagi kode di poster atau QR, lalu kirim DAFTAR <kode>.',
    en: 'Programme code {code} is not recognised. Check the code on the poster or QR, then send DAFTAR <code>.',
  },
  nh_closed: {
    id: 'Pendaftaran program ini sudah tutup.{others}',
    en: 'Registration for this programme is closed.{others}',
  },
  nh_full: {
    id: 'Kuota program ini sudah penuh. Pendaftaran program ini sudah tutup.{others}',
    en: 'This programme is full. Registration is closed.{others}',
  },
  nh_duplicate: {
    id: 'Nomor ini sudah terdaftar di program ini. Kode bukti kamu: {code}.',
    en: 'This number is already registered in this programme. Your proof code: {code}.',
  },
  nh_duplicate_other: {
    id: 'Pendaftaran tidak bisa diproses: {what} sudah dipakai pendaftar lain di program ini.',
    en: 'Registration cannot be completed: {what} is already used by another registrant in this programme.',
  },
  nh_ask_location: {
    id: 'Kirim lokasi sawah kamu. Tekan tombol di bawah, atau lampiran > Lokasi.',
    en: 'Send the location of your field. Tap the button below, or attach > Location.',
  },
  nh_outside_area: {
    id: 'Lokasi di luar wilayah program.',
    en: 'This location is outside the programme area.',
  },
  nh_ask_channel: {
    id: 'Pilih penerima uang: DANA, GoPay, OVO, ShopeePay, atau Bank.',
    en: 'Choose where to receive the money: DANA, GoPay, OVO, ShopeePay or Bank.',
  },
  nh_ask_account: {
    id: 'Kirim nomor {channel} kamu.{hint}',
    en: 'Send your {channel} number.{hint}',
  },
  nh_account_invalid: {
    id: 'Nomor akun tidak bisa diperiksa. Periksa lagi lalu kirim ulang, atau balas UBAH untuk pilih penerima lain.',
    en: 'The account could not be verified. Check it and send again, or reply UBAH to choose another channel.',
  },
  nh_confirm_name: {
    id: 'Akun atas nama {name}. Benar?',
    en: 'The account is registered to {name}. Correct?',
  },
  nh_declined: {
    id: 'Baik, pendaftaran dibatalkan. Kirim DAFTAR {code} kapan saja sebelum pendaftaran tutup.',
    en: 'Okay, registration cancelled. Send DAFTAR {code} any time before registration closes.',
  },
  nh_optout: {
    id: 'Kamu tidak akan menerima pesan lagi dari NusaHarvest. Kirim DAFTAR <kode> untuk mulai lagi.',
    en: 'You will not receive further messages from NusaHarvest. Send DAFTAR <code> to start again.',
  },
  nh_waitlist: {
    id: 'Dana program ini hanya cukup untuk pendaftar sebelumnya. Kamu masuk daftar tunggu dan akan dikabari jika ada tempat.',
    en: 'This programme is funded only for earlier registrants. You are on the waiting list and will be told if a place opens.',
  },
  nh_help: {
    id: 'Untuk mendaftar, kirim DAFTAR <kode program>, contoh: DAFTAR NH-KLT26. Balas STOP untuk berhenti.',
    en: 'To register, send DAFTAR <programme code>, for example: DAFTAR NH-KLT26. Reply STOP to stop.',
  },
};

export function render(name: TemplateName, lang: Lang, vars: Vars = {}): string {
  return T[name][lang].replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

export const formatIdr = (n: number): string => n.toLocaleString('id-ID');

/** "SUTRISNO" -> "S*****O". Only the masked form is ever stored or shown. */
export function maskName(name: string): string {
  const words = name.trim().toUpperCase().split(/\s+/).filter(Boolean);
  return words
    .map((w) => (w.length <= 2 ? `${w[0]}*` : `${w[0]}${'*'.repeat(w.length - 2)}${w[w.length - 1]}`))
    .join(' ');
}

// ---------------------------------------------------------------------------
// 3. Transport
// ---------------------------------------------------------------------------

export type Button = { id: string; title: string };
export interface OutMessage {
  template: TemplateName;
  text: string;
  buttons?: Button[]; // <= 3, rendered as reply buttons
  list?: { button: string; rows: Button[] }; // rendered as an interactive list
  requestLocation?: boolean;
}

export interface Transport {
  readonly name: 'meta' | 'local';
  send(toE164: string, msg: OutMessage): Promise<{ id: string | null }>;
}

export const localTransport: Transport = {
  name: 'local',
  async send(toE164, msg) {
    // Recipient is logged as its lookup HMAC prefix, never the number.
    let who = 'unknown';
    try {
      who = phoneLookupHmac(toE164).slice(0, 12);
    } catch {
      /* PII_HMAC_KEY missing in a bare dev shell */
    }
    const extras = [
      msg.buttons ? `buttons=[${msg.buttons.map((b) => b.title).join('|')}]` : '',
      msg.list ? `list=[${msg.list.rows.map((b) => b.title).join('|')}]` : '',
      msg.requestLocation ? 'request_location' : '',
    ].filter(Boolean);
    console.info(`[wa:local] -> ${who} ${msg.template}: ${msg.text} ${extras.join(' ')}`.trim());
    return { id: null };
  },
};

export const metaTransport: Transport = {
  name: 'meta',
  async send(toE164, msg) {
    const to = toE164.replace(/^\+/, '');
    let payload: Record<string, unknown>;
    if (msg.requestLocation) {
      payload = { type: 'interactive', interactive: { type: 'location_request_message', body: { text: msg.text }, action: { name: 'send_location' } } };
    } else if (msg.buttons?.length) {
      payload = {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: msg.text },
          action: { buttons: msg.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
        },
      };
    } else if (msg.list) {
      payload = {
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: msg.text },
          action: { button: msg.list.button, sections: [{ title: msg.list.button, rows: msg.list.rows.map((r) => ({ id: r.id, title: r.title.slice(0, 24) })) }] },
        },
      };
    } else {
      payload = { type: 'text', text: { body: msg.text, preview_url: false } };
    }
    const res = await fetch(`https://graph.facebook.com/${env.waGraphVersion()}/${env.waPhoneNumberId()}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.waToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`whatsapp send failed with HTTP ${res.status}`); // body not logged: may echo the number
    const id = (JSON.parse(text) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? null;
    return { id };
  },
};

export const defaultTransport = (): Transport => (env.waTransport() === 'local' ? localTransport : metaTransport);

// ---------------------------------------------------------------------------
// 4. Payout account name inquiry
// ---------------------------------------------------------------------------

export const CHANNELS = ['dana', 'gopay', 'ovo', 'shopeepay', 'bank'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<Channel, string> = { dana: 'DANA', gopay: 'GoPay', ovo: 'OVO', shopeepay: 'ShopeePay', bank: 'Bank' };

export interface NameInquiry {
  /** Returns the registered holder name, or null when the account does not exist. Throws on gateway outage. */
  (channel: Channel, account: string): Promise<{ name: string; verified: boolean } | null>;
}

/**
 * Normalise what the farmer typed into an account identifier.
 * e-wallets: E.164 phone. bank: "<BANKCODE> <digits>", e.g. "BRI 0123456789".
 */
export function normalizeAccount(channel: Channel, input: string): string | null {
  if (channel === 'bank') {
    const m = /^([A-Za-z]{2,10})\s*[-:]?\s*([0-9][0-9\s-]{5,24})$/.exec(input.trim());
    if (!m?.[1] || !m[2]) return null;
    return `${m[1].toUpperCase()}:${m[2].replace(/[\s-]/g, '')}`;
  }
  return normalizePhoneE164(input);
}

/**
 * Live inquiry against the configured disbursement gateway. The request is signed with
 * HMAC(PAYOUT_GATEWAY_SECRET, body). The gateway contract (POST {base}/account-inquiry
 * -> {found, holder_name}) is the adapter boundary for the chosen BI-licensed provider.
 */
export const gatewayNameInquiry: NameInquiry = async (channel, account) => {
  if (env.gatewayMode() === 'local') {
    // Dev only (refused in production by env.gatewayMode). Name is not verified.
    return { name: 'BELUM DIVERIFIKASI', verified: false };
  }
  const body = JSON.stringify({ channel, account });
  const res = await fetch(`${env.gatewayBaseUrl()}/account-inquiry`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.gatewayKey(),
      'x-signature': hmacHex(env.gatewaySecret(), body),
    },
    body,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`gateway inquiry failed with HTTP ${res.status}`);
  const r = (await res.json()) as { found?: boolean; holder_name?: string };
  if (!r.found || !r.holder_name) return null;
  return { name: r.holder_name, verified: true };
};

// ---------------------------------------------------------------------------
// 5. Conversation engine
// ---------------------------------------------------------------------------

export type SessionState =
  | 'idle'
  | 'awaiting_consent'
  | 'awaiting_location'
  | 'awaiting_channel'
  | 'awaiting_account'
  | 'awaiting_name_confirm'
  | 'done';

export interface Draft {
  lat_enc?: string; // base64 ciphertext
  lon_enc?: string;
  grid_cell?: number;
  plot_hmac?: string;
  channel?: Channel;
  account_enc?: string;
  account_hmac?: string;
  name_masked?: string;
  name_verified?: boolean;
}

export interface Session {
  phoneHmac: string;
  campaignId: string | null;
  state: SessionState;
  draft: Draft;
  lang: Lang;
  optedOut: boolean;
}

export interface CampaignInfo {
  id: string;
  code: string;
  pubkey: string | null;
  sponsorName: string;
  status: string;
  gridCells: number[];
  freezeTs: Date;
  windowStart: string;
  windowEnd: string;
  amountFullIdr: number;
  unitsMax: number;
  regionName: string | null;
}

export interface NewEnrollment {
  campaignId: string;
  phoneEnc: Buffer;
  phoneHmac: string;
  channel: Channel;
  accountEnc: Buffer;
  accountHmac: string;
  nameMasked: string;
  nameVerified: boolean;
  latEnc: Buffer;
  lonEnc: Buffer;
  plotHmac: string;
  gridCell: number;
  salt: Buffer;
  proofCode: string;
  leaf: string;
  status: 'valid' | 'waitlist';
  assistedBy: string | null;
}

export interface RegistrationStore {
  claimInbound(waMessageId: string): Promise<boolean>;
  getSession(phoneHmac: string): Promise<Session | null>;
  saveSession(s: Session): Promise<void>;
  findCampaign(code: string): Promise<CampaignInfo | null>;
  getCampaign(id: string): Promise<CampaignInfo | null>;
  otherOpenCampaigns(near: CampaignInfo, now: Date): Promise<{ code: string; region: string | null }[]>;
  countEnrolled(campaignId: string): Promise<number>;
  isExcludedCell(cell: number): Promise<boolean>;
  existingProofCode(campaignId: string, phoneHmac: string): Promise<string | null>;
  accountTaken(campaignId: string, accountHmac: string): Promise<boolean>;
  plotTaken(campaignId: string, plotHmacs: string[]): Promise<boolean>;
  insertEnrollment(e: NewEnrollment): Promise<'ok' | 'duplicate_phone' | 'duplicate_account'>;
  logMessage(entry: { phoneHmac: string; campaignId: string | null; direction: 'in' | 'out'; template: string; waMessageId: string | null; transport: string; error?: string }): Promise<void>;
}

export interface InboundMessage {
  id: string;
  from: string; // wa_id digits as delivered by Meta
  type: 'text' | 'interactive' | 'location' | 'other';
  text?: string;
  replyId?: string;
  location?: { latitude: number; longitude: number };
}

export interface EngineDeps {
  store: RegistrationStore;
  transport: Transport;
  inquireName: NameInquiry;
  now: () => Date;
  keys?: { enc?: Buffer; hmac?: Buffer }; // tests pass keys; production reads env via crypto.ts
}

/** Outcome label per handled message, used by tests and the webhook's response body. */
export type Outcome =
  | 'duplicate_delivery'
  | 'bad_sender'
  | 'opted_out'
  | 'ignored_opted_out'
  | 'help'
  | 'unknown_campaign'
  | 'closed'
  | 'full'
  | 'duplicate_phone'
  | 'welcome'
  | 'declined'
  | 'ask_location'
  | 'outside_area'
  | 'ask_channel'
  | 'ask_account'
  | 'account_invalid'
  | 'confirm_name'
  | 'duplicate_account'
  | 'duplicate_plot'
  | 'registered'
  | 'waitlisted'
  | 'reprompt';

const SESSION_TTL_MS = 24 * 3600 * 1000;
const OPTOUT_WORDS = new Set(['STOP', 'BERHENTI', 'UNSUBSCRIBE', 'BATAL LANGGANAN']);
const YES = new Set(['LANJUT', 'YA', 'YES', 'OK', 'BENAR', 'CONTINUE']);
const NO = new Set(['TIDAK', 'NO', 'BATAL', 'CANCEL']);

/** Plot cell for the <20 m duplicate rule: 0.0002 degrees (~22 m at the equator). */
export const PLOT_STEP = 0.0002;
export function plotKeys(lat: number, lon: number, hmacKey?: Buffer): { own: string; neighbourhood: string[] } {
  const r = Math.floor(lat / PLOT_STEP);
  const c = Math.floor(lon / PLOT_STEP);
  const k = (a: number, b: number) => hmacHex(hmacKey ?? parseKey32(env.piiHmacKey(), 'PII_HMAC_KEY'), `nh:plot:v1:${a}:${b}`);
  const neighbourhood: string[] = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) neighbourhood.push(k(r + dr, c + dc));
  return { own: k(r, c), neighbourhood };
}

function windowLabel(c: CampaignInfo, lang: Lang): string {
  const f = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(lang === 'id' ? 'id-ID' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${f(c.windowStart)} - ${f(c.windowEnd)}`;
}

const reply = (s: string | undefined) => (s ?? '').trim().toUpperCase();

export async function handleInbound(msg: InboundMessage, deps: EngineDeps): Promise<Outcome> {
  const { store, transport } = deps;
  const now = deps.now();

  if (!(await store.claimInbound(msg.id))) return 'duplicate_delivery';

  const phone = normalizePhoneE164(`+${msg.from.replace(/[^0-9]/g, '')}`);
  if (!phone) return 'bad_sender';
  const phoneHmac = phoneLookupHmac(phone, deps.keys?.hmac);
  const enc = (s: string) => encryptText(s, deps.keys?.enc);

  let session: Session =
    (await store.getSession(phoneHmac)) ?? { phoneHmac, campaignId: null, state: 'idle', draft: {}, lang: 'id', optedOut: false };
  const input = reply(msg.replyId ?? msg.text);
  let campaign: CampaignInfo | null = session.campaignId ? await store.getCampaign(session.campaignId) : null;

  const send = async (template: TemplateName, vars: Vars = {}, extra: Omit<OutMessage, 'template' | 'text'> = {}) => {
    const out: OutMessage = { template, text: render(template, session.lang, vars), ...extra };
    let id: string | null = null;
    let error: string | undefined;
    try {
      id = (await transport.send(phone, out)).id;
    } catch (e) {
      error = (e as Error).message;
    }
    await store.logMessage({ phoneHmac, campaignId: campaign?.id ?? null, direction: 'out', template, waMessageId: id, transport: transport.name, error });
  };
  const save = (patch: Partial<Session>) => {
    session = { ...session, ...patch };
    return store.saveSession(session);
  };
  const reset = () => save({ state: 'idle', draft: {}, campaignId: null });
  const othersText = async (c: CampaignInfo) => {
    const list = await store.otherOpenCampaigns(c, now);
    if (!list.length) return '';
    const head = session.lang === 'id' ? '\nProgram lain di wilayah yang sama:' : '\nOther programmes in the same area:';
    return `${head}\n${list.map((o) => `- DAFTAR ${o.code}${o.region ? ` (${o.region})` : ''}`).join('\n')}`;
  };
  const registrationClosed = (c: CampaignInfo) => c.status !== 'open' || !c.pubkey || now.getTime() >= c.freezeTs.getTime();

  await store.logMessage({ phoneHmac, campaignId: campaign?.id ?? null, direction: 'in', template: `in:${msg.type}`, waMessageId: msg.id, transport: transport.name });

  // Language switch
  if (input === 'ENGLISH' || input === 'BAHASA') {
    await save({ lang: input === 'ENGLISH' ? 'en' : 'id' });
    await send('nh_help');
    return 'help';
  }

  // Opt-out (any state). Clears the in-progress draft; completed enrolments stay because the
  // roster may already be anchored on-chain. Erasure of those is the documented PDP path.
  if (OPTOUT_WORDS.has(input)) {
    await save({ optedOut: true, state: 'idle', draft: {}, campaignId: null });
    await send('nh_optout');
    return 'opted_out';
  }

  const daftar = /^DAFTAR\s+([A-Z0-9-]{3,32})$/.exec(input.replace(/\s+/g, ' '));
  if (session.optedOut && !daftar) return 'ignored_opted_out';

  // Start (or restart) registration
  if (daftar?.[1]) {
    const code = daftar[1];
    await save({ optedOut: false });
    const c = await store.findCampaign(code);
    if (!c) {
      await reset();
      await send('nh_unknown_code', { code });
      return 'unknown_campaign';
    }
    campaign = c;
    if (registrationClosed(c)) {
      await reset();
      await send('nh_closed', { others: await othersText(c) });
      return 'closed';
    }
    const existing = await store.existingProofCode(c.id, phoneHmac);
    if (existing) {
      await save({ state: 'done', campaignId: c.id, draft: {} });
      await send('nh_duplicate', { code: existing });
      return 'duplicate_phone';
    }
    if ((await store.countEnrolled(c.id)) >= c.unitsMax) {
      await reset();
      await send('nh_full', { others: await othersText(c) });
      return 'full';
    }
    await save({ state: 'awaiting_consent', campaignId: c.id, draft: {} });
    const yes = session.lang === 'id' ? 'Lanjut' : 'Continue';
    const no = session.lang === 'id' ? 'Tidak' : 'No';
    await send(
      'nh_welcome',
      { sponsor: c.sponsorName, window: windowLabel(c, session.lang), amount: formatIdr(c.amountFullIdr) },
      { buttons: [{ id: 'LANJUT', title: yes }, { id: 'TIDAK', title: no }] },
    );
    return 'welcome';
  }

  if (session.state === 'idle' || session.state === 'done' || !campaign) {
    await send('nh_help');
    return 'help';
  }

  // Every step after consent re-checks the freeze, so a half-finished conversation cannot
  // slip a registration in after freeze_ts.
  if (registrationClosed(campaign)) {
    const c = campaign;
    await reset();
    await send('nh_closed', { others: await othersText(c) });
    return 'closed';
  }

  switch (session.state) {
    case 'awaiting_consent': {
      if (NO.has(input)) {
        const code = campaign.code;
        await reset();
        await send('nh_declined', { code });
        return 'declined';
      }
      if (!YES.has(input)) {
        await send('nh_welcome', { sponsor: campaign.sponsorName, window: windowLabel(campaign, session.lang), amount: formatIdr(campaign.amountFullIdr) }, {
          buttons: [{ id: 'LANJUT', title: session.lang === 'id' ? 'Lanjut' : 'Continue' }, { id: 'TIDAK', title: session.lang === 'id' ? 'Tidak' : 'No' }],
        });
        return 'reprompt';
      }
      await save({ state: 'awaiting_location' });
      await send('nh_ask_location', {}, { requestLocation: true });
      return 'ask_location';
    }

    case 'awaiting_location': {
      const loc = msg.location;
      if (msg.type !== 'location' || !loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)
        || Math.abs(loc.latitude) > 90 || Math.abs(loc.longitude) > 180) {
        await send('nh_ask_location', {}, { requestLocation: true });
        return 'reprompt';
      }
      const cell = gridCellFor(loc.latitude, loc.longitude);
      if (!campaign.gridCells.includes(cell) || (await store.isExcludedCell(cell))) {
        await reset();
        await send('nh_outside_area');
        return 'outside_area';
      }
      const plot = plotKeys(loc.latitude, loc.longitude, deps.keys?.hmac);
      if (await store.plotTaken(campaign.id, plot.neighbourhood)) {
        await reset();
        await send('nh_duplicate_other', { what: session.lang === 'id' ? 'lokasi sawah ini' : 'this field location' });
        return 'duplicate_plot';
      }
      await save({
        state: 'awaiting_channel',
        draft: {
          lat_enc: enc(loc.latitude.toFixed(6)).toString('base64'),
          lon_enc: enc(loc.longitude.toFixed(6)).toString('base64'),
          grid_cell: cell,
          plot_hmac: plot.own,
        },
      });
      await send('nh_ask_channel', {}, {
        list: { button: session.lang === 'id' ? 'Pilih' : 'Choose', rows: CHANNELS.map((c) => ({ id: c.toUpperCase(), title: CHANNEL_LABEL[c] })) },
      });
      return 'ask_channel';
    }

    case 'awaiting_channel': {
      const ch = CHANNELS.find((c) => c.toUpperCase() === input.replace(/\s+/g, ''));
      if (!ch) {
        await send('nh_ask_channel', {}, {
          list: { button: session.lang === 'id' ? 'Pilih' : 'Choose', rows: CHANNELS.map((c) => ({ id: c.toUpperCase(), title: CHANNEL_LABEL[c] })) },
        });
        return 'reprompt';
      }
      await save({ state: 'awaiting_account', draft: { ...session.draft, channel: ch } });
      const hint = ch === 'bank'
        ? session.lang === 'id' ? ' Format: KODEBANK NOMOR, contoh BRI 0123456789.' : ' Format: BANKCODE NUMBER, e.g. BRI 0123456789.'
        : '';
      await send('nh_ask_account', { channel: CHANNEL_LABEL[ch], hint });
      return 'ask_account';
    }

    case 'awaiting_account': {
      const ch = session.draft.channel;
      if (!ch || input === 'UBAH') {
        await save({ state: 'awaiting_channel' });
        await send('nh_ask_channel', {}, {
          list: { button: session.lang === 'id' ? 'Pilih' : 'Choose', rows: CHANNELS.map((c) => ({ id: c.toUpperCase(), title: CHANNEL_LABEL[c] })) },
        });
        return 'ask_channel';
      }
      const account = normalizeAccount(ch, msg.text ?? '');
      if (!account) {
        await send('nh_account_invalid');
        return 'account_invalid';
      }
      let holder: { name: string; verified: boolean } | null;
      try {
        holder = await deps.inquireName(ch, account);
      } catch {
        holder = null;
      }
      if (!holder) {
        await send('nh_account_invalid');
        return 'account_invalid';
      }
      const accountHmac = hmacHex(deps.keys?.hmac ?? parseKey32(env.piiHmacKey(), 'PII_HMAC_KEY'), `nh:account:v1:${ch}:${account}`);
      if (await store.accountTaken(campaign.id, accountHmac)) {
        await reset();
        await send('nh_duplicate_other', { what: session.lang === 'id' ? 'akun penerima ini' : 'this payout account' });
        return 'duplicate_account';
      }
      const masked = maskName(holder.name);
      await save({
        state: 'awaiting_name_confirm',
        draft: { ...session.draft, account_enc: enc(account).toString('base64'), account_hmac: accountHmac, name_masked: masked, name_verified: holder.verified },
      });
      await send('nh_confirm_name', { name: masked }, {
        buttons: [{ id: 'YA', title: session.lang === 'id' ? 'Ya' : 'Yes' }, { id: 'UBAH', title: session.lang === 'id' ? 'Ubah' : 'Change' }],
      });
      return 'confirm_name';
    }

    case 'awaiting_name_confirm': {
      if (input === 'UBAH') {
        await save({ state: 'awaiting_channel', draft: { ...session.draft, channel: undefined, account_enc: undefined, account_hmac: undefined, name_masked: undefined } });
        await send('nh_ask_channel', {}, {
          list: { button: session.lang === 'id' ? 'Pilih' : 'Choose', rows: CHANNELS.map((c) => ({ id: c.toUpperCase(), title: CHANNEL_LABEL[c] })) },
        });
        return 'ask_channel';
      }
      if (!YES.has(input)) {
        await send('nh_confirm_name', { name: session.draft.name_masked ?? '' }, {
          buttons: [{ id: 'YA', title: session.lang === 'id' ? 'Ya' : 'Yes' }, { id: 'UBAH', title: session.lang === 'id' ? 'Ubah' : 'Change' }],
        });
        return 'reprompt';
      }
      const d = session.draft;
      if (!d.channel || !d.account_enc || !d.account_hmac || !d.lat_enc || !d.lon_enc || d.grid_cell === undefined || !d.plot_hmac || !campaign.pubkey) {
        await reset();
        await send('nh_help');
        return 'help';
      }
      // Final duplicate checks (spec 2.3: phone, account, location < 20 m)
      const existing = await store.existingProofCode(campaign.id, phoneHmac);
      if (existing) {
        await save({ state: 'done', draft: {} });
        await send('nh_duplicate', { code: existing });
        return 'duplicate_phone';
      }
      if (await store.accountTaken(campaign.id, d.account_hmac)) {
        await reset();
        await send('nh_duplicate_other', { what: session.lang === 'id' ? 'akun penerima ini' : 'this payout account' });
        return 'duplicate_account';
      }
      const lat = Number(decryptText(Buffer.from(d.lat_enc, 'base64'), deps.keys?.enc));
      const lon = Number(decryptText(Buffer.from(d.lon_enc, 'base64'), deps.keys?.enc));
      if (await store.plotTaken(campaign.id, plotKeys(lat, lon, deps.keys?.hmac).neighbourhood)) {
        await reset();
        await send('nh_duplicate_other', { what: session.lang === 'id' ? 'lokasi sawah ini' : 'this field location' });
        return 'duplicate_plot';
      }

      const salt = randomSalt16();
      const leaf = toHex(rosterLeaf(addressToBytes(campaign.pubkey), phoneHash(salt, phone), d.grid_cell));
      const proofCode = newProofCode();
      // Over-quota registrants are kept on a waitlist; the roster lock also enforces funding (spec 2.4).
      const status: 'valid' | 'waitlist' = (await store.countEnrolled(campaign.id)) >= campaign.unitsMax ? 'waitlist' : 'valid';
      const r = await store.insertEnrollment({
        campaignId: campaign.id,
        phoneEnc: enc(phone),
        phoneHmac,
        channel: d.channel,
        accountEnc: Buffer.from(d.account_enc, 'base64'),
        accountHmac: d.account_hmac,
        nameMasked: d.name_masked ?? '',
        nameVerified: d.name_verified ?? false,
        latEnc: Buffer.from(d.lat_enc, 'base64'),
        lonEnc: Buffer.from(d.lon_enc, 'base64'),
        plotHmac: d.plot_hmac,
        gridCell: d.grid_cell,
        salt,
        proofCode,
        leaf,
        status,
        assistedBy: null,
      });
      if (r === 'duplicate_phone') {
        const code = (await store.existingProofCode(campaign.id, phoneHmac)) ?? '';
        await save({ state: 'done', draft: {} });
        await send('nh_duplicate', { code });
        return 'duplicate_phone';
      }
      if (r === 'duplicate_account') {
        await reset();
        await send('nh_duplicate_other', { what: session.lang === 'id' ? 'akun penerima ini' : 'this payout account' });
        return 'duplicate_account';
      }
      await save({ state: 'done', draft: {} });
      if (status === 'waitlist') {
        await send('nh_waitlist');
        return 'waitlisted';
      }
      await send('nh_registered', { code: proofCode });
      return 'registered';
    }
  }
  await send('nh_help');
  return 'help';
}

/** Extract messages from a Meta webhook payload. Unknown shapes yield []. */
export function parseMetaPayload(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (body as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const ch of changes) {
      const msgs = (ch as { value?: { messages?: unknown[] } })?.value?.messages;
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs as Record<string, any>[]) {
        if (typeof m?.id !== 'string' || typeof m?.from !== 'string') continue;
        if (m.type === 'text') out.push({ id: m.id, from: m.from, type: 'text', text: String(m.text?.body ?? '') });
        else if (m.type === 'interactive') {
          const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
          out.push({ id: m.id, from: m.from, type: 'interactive', replyId: String(r?.id ?? ''), text: String(r?.title ?? '') });
        } else if (m.type === 'button') out.push({ id: m.id, from: m.from, type: 'interactive', replyId: String(m.button?.payload ?? ''), text: String(m.button?.text ?? '') });
        else if (m.type === 'location')
          out.push({ id: m.id, from: m.from, type: 'location', location: { latitude: Number(m.location?.latitude), longitude: Number(m.location?.longitude) } });
        else out.push({ id: m.id, from: m.from, type: 'other' });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 6. Postgres store
// ---------------------------------------------------------------------------

interface CampaignRow {
  id: string;
  code: string;
  pubkey: string | null;
  legal_name: string;
  status: string;
  grid_cells: number[];
  freeze_ts: Date;
  window_start: string;
  window_end: string;
  amount_full_idr: number;
  units_max: number;
  region_name: string | null;
}
const CAMPAIGN_SELECT = `select c.id, c.code, c.pubkey, s.legal_name, c.status, c.grid_cells, c.freeze_ts,
  to_char(c.window_start,'YYYY-MM-DD') as window_start, to_char(c.window_end,'YYYY-MM-DD') as window_end,
  c.amount_full_idr, c.units_max, c.regency as region_name
  from campaigns c join sponsors s on s.id = c.sponsor_id`;
const toInfo = (r: CampaignRow): CampaignInfo => ({
  id: r.id,
  code: r.code,
  pubkey: r.pubkey,
  sponsorName: r.legal_name,
  status: r.status,
  gridCells: r.grid_cells.map(Number),
  freezeTs: new Date(r.freeze_ts),
  windowStart: r.window_start,
  windowEnd: r.window_end,
  amountFullIdr: Number(r.amount_full_idr),
  unitsMax: Number(r.units_max),
  regionName: r.region_name,
});

export const pgStore: RegistrationStore = {
  async claimInbound(id) {
    const r = await query('insert into wa_inbound (wa_message_id) values ($1) on conflict do nothing returning wa_message_id', [id]);
    return r.length === 1;
  },
  async getSession(h) {
    const r = await one<{ campaign_id: string | null; state: SessionState; draft: Draft; lang: Lang; opted_out: boolean; expires_at: Date }>(
      'select campaign_id, state, draft, lang, opted_out, expires_at from wa_sessions where phone_lookup_hmac = $1',
      [h],
    );
    if (!r) return null;
    const expired = new Date(r.expires_at).getTime() < Date.now();
    return { phoneHmac: h, campaignId: expired ? null : r.campaign_id, state: expired ? 'idle' : r.state, draft: expired ? {} : r.draft, lang: r.lang, optedOut: r.opted_out };
  },
  async saveSession(s) {
    await query(
      `insert into wa_sessions (phone_lookup_hmac, campaign_id, state, draft, lang, opted_out, updated_at, expires_at)
       values ($1,$2,$3,$4,$5,$6, now(), now() + ($7 || ' milliseconds')::interval)
       on conflict (phone_lookup_hmac) do update set campaign_id = excluded.campaign_id, state = excluded.state,
         draft = excluded.draft, lang = excluded.lang, opted_out = excluded.opted_out, updated_at = now(), expires_at = excluded.expires_at`,
      [s.phoneHmac, s.campaignId, s.state, JSON.stringify(s.draft), s.lang, s.optedOut, String(SESSION_TTL_MS)],
    );
  },
  async findCampaign(code) {
    const r = await one<CampaignRow>(`${CAMPAIGN_SELECT} where upper(c.code) = upper($1)`, [code]);
    return r ? toInfo(r) : null;
  },
  async getCampaign(id) {
    const r = await one<CampaignRow>(`${CAMPAIGN_SELECT} where c.id = $1`, [id]);
    return r ? toInfo(r) : null;
  },
  async otherOpenCampaigns(near, now) {
    const rows = await query<{ code: string; region_name: string | null }>(
      `select code, regency as region_name from campaigns
        where id <> $1 and status = 'open' and pubkey is not null and freeze_ts > $2
          and (grid_cells && $3::int[] or regency = $4)
        order by freeze_ts limit 5`,
      [near.id, now, near.gridCells, near.regionName],
    );
    return rows.map((r) => ({ code: r.code, region: r.region_name }));
  },
  async countEnrolled(campaignId) {
    const r = await one<{ n: string }>(`select count(*) as n from enrollments where campaign_id = $1 and status = 'valid'`, [campaignId]);
    return Number(r?.n ?? 0);
  },
  async isExcludedCell(cell) {
    return !!(await one('select 1 from excluded_cells where grid_cell = $1', [cell]));
  },
  async existingProofCode(campaignId, h) {
    const r = await one<{ proof_code: string }>(
      `select proof_code from enrollments where campaign_id = $1 and phone_lookup_hmac = $2 and status in ('valid','waitlist')`,
      [campaignId, h],
    );
    return r?.proof_code ?? null;
  },
  async accountTaken(campaignId, h) {
    return !!(await one(`select 1 from enrollments where campaign_id = $1 and payout_account_lookup_hmac = $2 and status in ('valid','waitlist')`, [campaignId, h]));
  },
  async plotTaken(campaignId, hs) {
    return !!(await one(`select 1 from enrollments where campaign_id = $1 and plot_lookup_hmac = any($2::text[]) and status in ('valid','waitlist')`, [campaignId, hs]));
  },
  async insertEnrollment(e) {
    return tx(async (q: Queryable) => {
      // Serialise per campaign so quota and duplicates are checked against committed rows.
      await q.query('select pg_advisory_xact_lock(hashtext($1))', [e.campaignId]);
      const dupPhone = await q.query(
        `select 1 from enrollments where campaign_id = $1 and phone_lookup_hmac = $2`, [e.campaignId, e.phoneHmac]);
      if (dupPhone.rows.length) return 'duplicate_phone' as const;
      const dupAcct = await q.query(
        `select 1 from enrollments where campaign_id = $1 and payout_account_lookup_hmac = $2 and status in ('valid','waitlist')`, [e.campaignId, e.accountHmac]);
      if (dupAcct.rows.length) return 'duplicate_account' as const;
      await q.query(
        `insert into enrollments (campaign_id, phone_enc, phone_lookup_hmac, payout_channel, payout_account_enc, payout_account_lookup_hmac,
           payout_name_masked, payout_name_verified, lat_enc, lon_enc, plot_lookup_hmac, grid_cell, salt, proof_code, leaf, status, assisted_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [e.campaignId, e.phoneEnc, e.phoneHmac, e.channel, e.accountEnc, e.accountHmac, e.nameMasked, e.nameVerified,
          e.latEnc, e.lonEnc, e.plotHmac, e.gridCell, e.salt, e.proofCode, e.leaf, e.status, e.assistedBy],
      );
      return 'ok' as const;
    });
  },
  async logMessage(m) {
    await query(
      `insert into message_log (campaign_id, phone_lookup_hmac, direction, template, wa_message_id, transport, error)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [m.campaignId, m.phoneHmac, m.direction, m.template, m.waMessageId, m.transport, m.error ?? null],
    );
  },
};

/** Send a spec 4.3 notification (result, paid, failed, waitlist) to an enrolment. Used by workers. */
export async function notifyEnrollment(
  enrollment: { id: string; campaign_id: string; phone_enc: Buffer; phone_lookup_hmac: string },
  template: TemplateName,
  vars: Vars,
  transport: Transport = defaultTransport(),
): Promise<void> {
  const s = await one<{ opted_out: boolean; lang: Lang }>('select opted_out, lang from wa_sessions where phone_lookup_hmac = $1', [enrollment.phone_lookup_hmac]);
  if (s?.opted_out) return;
  const phone = decryptText(enrollment.phone_enc);
  let id: string | null = null;
  let error: string | undefined;
  try {
    id = (await transport.send(phone, { template, text: render(template, s?.lang ?? 'id', vars) })).id;
  } catch (e) {
    error = (e as Error).message;
  }
  await query(
    `insert into message_log (enrollment_id, campaign_id, phone_lookup_hmac, direction, template, wa_message_id, transport, error)
     values ($1,$2,$3,'out',$4,$5,$6,$7)`,
    [enrollment.id, enrollment.campaign_id, enrollment.phone_lookup_hmac, template, id, transport.name, error ?? null],
  );
}
