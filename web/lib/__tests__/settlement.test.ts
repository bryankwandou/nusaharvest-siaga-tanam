// Settlement behaviour on real recorded responses: data-lag refusal, divergence abort, missing-day
// refusal, response-hash stability and a pinned data_hash for a real window.
// Recorded bodies come from `node scripts/climate/fetch.mjs` (research-out/climate/cache, sha256-checked).
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '../climate';
import {
  SettlementRefused,
  checkPublishedDocument,
  earliestSettleTs,
  normalizedBodySha256,
  settleCampaign,
  settleFromSeries,
  seriesFromBody,
  sourceUrl,
  windowEndTs,
  type CampaignParams,
} from '../settlement';

const CACHE = fileURLToPath(new URL('../../../research-out/climate/cache/', import.meta.url));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function recorded(source: 'open-meteo-archive' | 'nasa-power', url: string): string {
  const key = sha(url).slice(0, 32);
  const body = `${CACHE}${source}/${key}.json`;
  if (!existsSync(body)) throw new Error(`recorded response missing for ${url}; run scripts/climate/fetch.mjs first`);
  const text = readFileSync(body, 'utf8');
  const m = JSON.parse(readFileSync(`${CACHE}${source}/${key}.meta.json`, 'utf8')) as { url: string; body_sha256: string };
  if (m.url !== url || sha(text) !== m.body_sha256) throw new Error(`recorded response for ${url} fails its sha256 check`);
  return text;
}

/** Serves recorded real responses by URL and counts calls. */
function replay(): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const source = url.includes('open-meteo') ? 'open-meteo-archive' : 'nasa-power';
    const text = recorded(source, url);
    return { ok: true, status: 200, text: async () => text };
  }) as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}

const KLATEN_CELL = 2962106;
// Thresholds here are campaign parameters, not claims about Klaten; the outcome logic is what is under test.
const q4: CampaignParams = {
  code: 'KLT-2025-Q4',
  pubkey: 'UNREGISTERED',
  grid_cells: [KLATEN_CELL],
  window_start: '2025-10-01',
  window_end: '2025-12-31',
  thr_full_mm10: 4200,
  thr_half_mm10: 5510,
};
const oct: CampaignParams = { ...q4, code: 'KLT-2025-10', window_end: '2025-10-31' };
const COMMIT = '0000000000000000000000000000000000000000';

function series(c: CampaignParams) {
  const mk = (source: 'open-meteo-archive' | 'nasa-power') => {
    const url = sourceUrl(source, KLATEN_CELL, c.window_start, c.window_end);
    return seriesFromBody(source, KLATEN_CELL, url, recorded(source, url), c.window_start, c.window_end).series;
  };
  return { primary: [mk('open-meteo-archive')], secondary: [mk('nasa-power')] };
}

describe('data lag', () => {
  it('window_end_ts is the end of window_end in WIB', () => {
    expect(windowEndTs('2025-12-31')).toBe(Date.UTC(2025, 11, 31, 17, 0, 0) / 1000);
    expect(earliestSettleTs(windowEndTs('2025-12-31'))).toBe(Date.UTC(2026, 0, 7, 17, 0, 0) / 1000);
  });

  it('refuses one second before window_end_ts + 7 days, accepts at the boundary', () => {
    const { primary, secondary } = series(q4);
    const edge = earliestSettleTs(windowEndTs(q4.window_end)) * 1000;
    expect(() => settleFromSeries(q4, primary, secondary, { now: new Date(edge - 1000), scriptCommit: COMMIT })).toThrow(/before window_end_ts/);
    try {
      settleFromSeries(q4, primary, secondary, { now: new Date(edge - 1000), scriptCommit: COMMIT });
    } catch (e) {
      expect((e as SettlementRefused).code).toBe('TOO_EARLY');
    }
    expect(settleFromSeries(q4, primary, secondary, { now: new Date(edge), scriptCommit: COMMIT }).outcome).toBe('NONE');
  });

  it('respects an explicit on-chain window_end_ts', () => {
    const { primary, secondary } = series(q4);
    const ts = windowEndTs(q4.window_end) + 3600;
    const now = new Date(earliestSettleTs(windowEndTs(q4.window_end)) * 1000);
    expect(() => settleFromSeries({ ...q4, window_end_ts: ts }, primary, secondary, { now, scriptCommit: COMMIT })).toThrow(SettlementRefused);
  });

  it('settleCampaign makes no network call when too early', async () => {
    const f = replay();
    await expect(settleCampaign(q4, { fetchImpl: f, now: new Date('2026-01-05T00:00:00Z'), scriptCommit: COMMIT })).rejects.toMatchObject({ code: 'TOO_EARLY' });
    expect(f.calls).toEqual([]);
  });
});

describe('divergence abort (real Klaten October 2025: Open-Meteo 243.80 mm vs NASA POWER 324.98 mm)', () => {
  it('refuses to settle and carries the review document', () => {
    const { primary, secondary } = series(oct);
    let err: SettlementRefused | undefined;
    try {
      settleFromSeries(oct, primary, secondary, { now: new Date('2026-09-20T00:00:00Z'), scriptCommit: COMMIT });
    } catch (e) {
      err = e as SettlementRefused;
    }
    expect(err).toBeInstanceOf(SettlementRefused);
    expect(err?.code).toBe('DIVERGENCE');
    expect(err?.result?.divergence_bp).toBe(3329);
    expect(err?.result?.review).toBe(true);
    expect(err?.result?.observed_mm10).toBe(2438);
    expect(err?.result?.secondary_mm10).toBe(3249);
  });

  it('allowReview returns the document for human review instead of throwing', () => {
    const { primary, secondary } = series(oct);
    const r = settleFromSeries(oct, primary, secondary, { now: new Date('2026-09-20T00:00:00Z'), scriptCommit: COMMIT, allowReview: true });
    expect(r.review).toBe(true);
    expect(r.review_reasons.join()).toMatch(/3329 bp/);
  });

  it('settleCampaign end to end also aborts', async () => {
    await expect(settleCampaign(oct, { fetchImpl: replay(), now: new Date('2026-09-20T00:00:00Z'), scriptCommit: COMMIT })).rejects.toMatchObject({ code: 'DIVERGENCE' });
  });
});

describe('missing days', () => {
  it('refuses rather than interpolating when a source reports its fill value', () => {
    const url = sourceUrl('nasa-power', KLATEN_CELL, q4.window_start, q4.window_end);
    // Real body with one day replaced by NASA POWER's own fill value (-999), as the API returns for gaps.
    const body = JSON.parse(recorded('nasa-power', url));
    body.properties.parameter.PRECTOTCORR['20251115'] = body.header.fill_value;
    const sec = seriesFromBody('nasa-power', KLATEN_CELL, url, JSON.stringify(body), q4.window_start, q4.window_end).series;
    const { primary } = series(q4);
    expect(() => settleFromSeries(q4, primary, [sec], { now: new Date('2026-09-20T00:00:00Z'), scriptCommit: COMMIT })).toThrow(/2025-11-15/);
  });
});

describe('reproducible document hash', () => {
  it('response hash ignores per-request timing fields only', () => {
    const url = sourceUrl('open-meteo-archive', KLATEN_CELL, q4.window_start, q4.window_end);
    const body = recorded('open-meteo-archive', url);
    const otherTiming = body.replace(/"generationtime_ms":[0-9.eE-]+/, '"generationtime_ms":123.456');
    expect(otherTiming).not.toBe(body);
    expect(normalizedBodySha256('open-meteo-archive', otherTiming)).toBe(normalizedBodySha256('open-meteo-archive', body));
    const otherValue = body.replace('"precipitation_sum":[', '"precipitation_sum":[99.9,');
    expect(normalizedBodySha256('open-meteo-archive', otherValue)).not.toBe(normalizedBodySha256('open-meteo-archive', body));

    const nurl = sourceUrl('nasa-power', KLATEN_CELL, q4.window_start, q4.window_end);
    const nbody = JSON.parse(recorded('nasa-power', nurl));
    const n2 = { ...nbody, times: { data: 9.99, process: 1.23 } };
    expect(normalizedBodySha256('nasa-power', JSON.stringify(n2))).toBe(normalizedBodySha256('nasa-power', JSON.stringify(nbody)));
  });

  it('Klaten Q4 2025 settles to a pinned data_hash, and the published bytes check out', async () => {
    const out = await settleCampaign(q4, { fetchImpl: replay(), now: new Date('2026-09-20T00:00:00Z'), scriptCommit: COMMIT });
    const r = out.result;
    expect(r.observed_mm10).toBe(7631);
    expect(r.secondary_mm10).toBe(9056);
    expect(r.divergence_bp).toBe(1867);
    expect(r.outcome).toBe('NONE');
    expect(r.data_hash).toBe(sha(r.json));
    expect(r.data_hash).toMatchInlineSnapshot(`"f8ec7a5cce8b7cbf869d7a03b91aecb207373a607457514573a25df374df41bb"`);
    const again = await settleCampaign(q4, { fetchImpl: replay(), now: new Date('2026-12-01T00:00:00Z'), scriptCommit: COMMIT });
    expect(again.result.json).toBe(r.json);
    expect(checkPublishedDocument(r.json, r.data_hash)).toMatchObject({ hash_ok: true, canonical_ok: true });
    expect(checkPublishedDocument(r.json + ' ', r.data_hash).hash_ok).toBe(false);
    expect(checkPublishedDocument(JSON.stringify(JSON.parse(r.json), null, 1), sha(JSON.stringify(JSON.parse(r.json), null, 1))).canonical_ok).toBe(false);
  });
});

describe('climate.fetchSeries response hash', () => {
  it('hashes the normalized body, same as settlement.ts, so timing fields do not change it', async () => {
    const { fetchSeries: fs } = await import('../climate');
    const { normalizedBodySha256: nbs } = await import('../settlement');
    const payload = { latitude: -7.7, longitude: 110.6, daily_units: { precipitation_sum: 'mm' }, daily: { time: ['2025-10-01', '2025-10-02'], precipitation_sum: [1.2, 0] } };
    const a = JSON.stringify({ generationtime_ms: 0.123, ...payload });
    const b = JSON.stringify({ daily: payload.daily, generationtime_ms: 9.87, daily_units: payload.daily_units, longitude: 110.6, latitude: -7.7 });
    const mk = (body: string): FetchLike => (async () => ({ ok: true, status: 200, text: async () => body })) as unknown as FetchLike;
    const sa = await fs('open-meteo-archive', 2962106, '2025-10-01', '2025-10-02', mk(a));
    const sb = await fs('open-meteo-archive', 2962106, '2025-10-01', '2025-10-02', mk(b));
    expect(sa.raw_sha256).toBe(nbs('open-meteo-archive', a));
    expect(sa.raw_sha256).toBe(sb.raw_sha256);
    expect(sa.raw_sha256).not.toBe(sha(a));
  });
});
