// Server-side settlement, rule version 1. Wraps web/lib/climate.ts; no Next.js imports.
// Used by the settlement cron endpoint, scripts/climate/settle.mjs and scripts/verify.mjs,
// so the operator, the auditor and any third party run exactly the same code path.

import {
  DATA_LAG_DAYS,
  REVIEW_DIVERGENCE_BP,
  buildSettlement,
  canonicalJson,
  nasaPowerUrl,
  openMeteoUrl,
  parseDay,
  parseNasaPower,
  parseOpenMeteo,
  sha256Hex,
  type DailyValue,
  type FetchLike,
  type SettlementResult,
  type SourceId,
  type SourceSeries,
} from './climate';

export const SOURCES: readonly SourceId[] = ['open-meteo-archive', 'nasa-power'];

/** Attribution that must accompany any published output (Open-Meteo is CC BY 4.0, non-commercial free tier). */
export const SOURCE_ATTRIBUTION: Record<SourceId, string> = {
  'open-meteo-archive':
    'Weather data by Open-Meteo.com (https://open-meteo.com/), licensed CC BY 4.0. ' +
    'Underlying ERA5/ERA5-Land reanalysis: Copernicus Climate Change Service (C3S), Hersbach et al. (2020).',
  'nasa-power':
    'Data obtained from the NASA Langley Research Center (LaRC) POWER Project funded through the NASA Earth Science/Applied Science Program.',
};

const DAY_S = 86_400;
const WIB_OFFSET_S = 7 * 3600;

// ---------------------------------------------------------------------------
// Response hashing. Both APIs embed per-request timing in the body (Open-Meteo "generationtime_ms",
// NASA POWER "times"), so a sha256 of the literal bytes changes on every call and could never be
// reproduced by a third party. The hash that goes into the settlement document is therefore taken
// over the body with those volatile fields removed, serialised with sorted keys. The literal bytes
// and their plain sha256 are still kept in the local cache for audit.
// ---------------------------------------------------------------------------

export const VOLATILE_TOP_LEVEL_KEYS: Record<SourceId, readonly string[]> = {
  'open-meteo-archive': ['generationtime_ms'],
  'nasa-power': ['times'],
};

/** Deterministic JSON with sorted keys. Numbers use JavaScript's shortest round-trip form. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite number in response');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

export function normalizeBody(source: SourceId, body: string): string {
  const j = JSON.parse(body) as Record<string, unknown>;
  if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new Error(`${source}: response is not a JSON object`);
  for (const k of VOLATILE_TOP_LEVEL_KEYS[source]) delete j[k];
  return stableStringify(j);
}

export const normalizedBodySha256 = (source: SourceId, body: string): string => sha256Hex(normalizeBody(source, body));

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type RefusalCode = 'TOO_EARLY' | 'MISSING_DATA' | 'DIVERGENCE' | 'FETCH_FAILED';

export class SettlementRefused extends Error {
  readonly code: RefusalCode;
  readonly result: SettlementResult | undefined;
  constructor(code: RefusalCode, message: string, result?: SettlementResult) {
    super(message);
    this.name = 'SettlementRefused';
    this.code = code;
    this.result = result;
  }
}

// ---------------------------------------------------------------------------
// Data lag
// ---------------------------------------------------------------------------

/** window_end_ts for a window_end date: the first second after that day ends in WIB (UTC+7). */
export function windowEndTs(windowEnd: string): number {
  return parseDay(windowEnd) / 1000 + DAY_S - WIB_OFFSET_S;
}

export const earliestSettleTs = (windowEndTsSec: number): number => windowEndTsSec + DATA_LAG_DAYS * DAY_S;

/** Throws TOO_EARLY unless now >= window_end_ts + DATA_LAG_DAYS. */
export function assertSettleable(windowEndTsSec: number, now: Date): void {
  const nowS = Math.floor(now.getTime() / 1000);
  const earliest = earliestSettleTs(windowEndTsSec);
  if (nowS < earliest) {
    throw new SettlementRefused(
      'TOO_EARLY',
      `refusing to settle: now ${new Date(nowS * 1000).toISOString()} is before window_end_ts + ${DATA_LAG_DAYS}-day data lag ` +
        `(${new Date(earliest * 1000).toISOString()})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export interface FetchedSeries {
  series: SourceSeries; // raw_sha256 = normalizedBodySha256
  body: string; // literal response bytes
  body_sha256: string; // sha256 of the literal bytes (not reproducible, see above)
}

export interface FetchOptions {
  fetchImpl: FetchLike;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function sourceUrl(source: SourceId, cell: number, start: string, end: string): string {
  return source === 'open-meteo-archive' ? openMeteoUrl(cell, start, end) : nasaPowerUrl(cell, start, end);
}

export function parseSource(source: SourceId, body: string, start: string, end: string): DailyValue[] {
  return source === 'open-meteo-archive' ? parseOpenMeteo(body, start, end) : parseNasaPower(body, start, end);
}

export async function fetchBody(url: string, opts: FetchOptions): Promise<string> {
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await opts.fetchImpl(url);
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}: ${text.slice(0, 200)}`);
      return text;
    } catch (e) {
      last = e;
      if (i < retries - 1) await sleep(1000 * 2 ** i);
    }
  }
  throw new SettlementRefused('FETCH_FAILED', last instanceof Error ? last.message : String(last));
}

export function seriesFromBody(source: SourceId, cell: number, url: string, body: string, start: string, end: string): FetchedSeries {
  return {
    series: { source, grid_cell: cell, url, daily: parseSource(source, body, start, end), raw_sha256: normalizedBodySha256(source, body) },
    body,
    body_sha256: sha256Hex(body),
  };
}

export async function fetchSourceSeries(source: SourceId, cell: number, start: string, end: string, opts: FetchOptions): Promise<FetchedSeries> {
  const url = sourceUrl(source, cell, start, end);
  return seriesFromBody(source, cell, url, await fetchBody(url, opts), start, end);
}

/** Days with no value, per series. Empty when complete. */
export function missingDays(series: readonly SourceSeries[]): { source: SourceId; grid_cell: number; days: string[] }[] {
  return series
    .map((s) => ({ source: s.source, grid_cell: s.grid_cell, days: s.daily.filter((d) => d.rain_mm100 === null).map((d) => d.day) }))
    .filter((m) => m.days.length > 0);
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export interface CampaignParams {
  code: string;
  pubkey: string;
  grid_cells: number[];
  window_start: string;
  window_end: string;
  thr_full_mm10: number;
  thr_half_mm10: number;
  /** On-chain window_end_ts in seconds. Defaults to windowEndTs(window_end). */
  window_end_ts?: number;
}

export interface SettleOptions {
  now: Date;
  scriptCommit: string;
  /** Build and return the document even when the sources diverge (verification, human review). */
  allowReview?: boolean;
}

function checkCampaign(c: CampaignParams): void {
  parseDay(c.window_start);
  parseDay(c.window_end);
  if (c.window_end < c.window_start) throw new Error('window_end before window_start');
  if (c.grid_cells.length === 0) throw new Error('campaign has no grid cells');
  if (!Number.isSafeInteger(c.thr_full_mm10) || !Number.isSafeInteger(c.thr_half_mm10) || c.thr_full_mm10 > c.thr_half_mm10) {
    throw new Error('thresholds must be integers with thr_full_mm10 <= thr_half_mm10');
  }
}

/** Pure: lag check, completeness check, build document, divergence check. */
export function settleFromSeries(
  campaign: CampaignParams,
  primary: SourceSeries[],
  secondary: SourceSeries[],
  opts: SettleOptions,
): SettlementResult {
  checkCampaign(campaign);
  assertSettleable(campaign.window_end_ts ?? windowEndTs(campaign.window_end), opts.now);
  const result = buildSettlement({
    campaign: {
      code: campaign.code,
      pubkey: campaign.pubkey,
      grid_cells: campaign.grid_cells,
      window_start: campaign.window_start,
      window_end: campaign.window_end,
      thr_full_mm10: campaign.thr_full_mm10,
      thr_half_mm10: campaign.thr_half_mm10,
    },
    primary,
    secondary,
    script_commit: opts.scriptCommit,
  });
  if (opts.allowReview) return result;
  const window = (s: SourceSeries) => ({ ...s, daily: s.daily.filter((d) => d.day >= campaign.window_start && d.day <= campaign.window_end) });
  const missing = missingDays([...primary, ...secondary].map(window));
  if (missing.length > 0) {
    throw new SettlementRefused(
      'MISSING_DATA',
      `missing days, not interpolating: ${missing.map((m) => `${m.source}/cell ${m.grid_cell}: ${m.days.join(',')}`).join('; ')}`,
      result,
    );
  }
  if (result.divergence_bp !== null && result.divergence_bp > REVIEW_DIVERGENCE_BP) {
    throw new SettlementRefused(
      'DIVERGENCE',
      `sources diverge by ${result.divergence_bp} bp (> ${REVIEW_DIVERGENCE_BP} bp): primary ${result.observed_mm10} mm10, ` +
        `secondary ${result.secondary_mm10} mm10. Not settling automatically; needs operator and auditor review.`,
      result,
    );
  }
  if (result.review) throw new SettlementRefused('MISSING_DATA', result.review_reasons.join('; '), result);
  return result;
}

export interface SettleOutput {
  result: SettlementResult;
  fetched: FetchedSeries[];
  attribution: Record<SourceId, string>;
}

/** The function the cron endpoint calls. Refuses before fetching anything if the data lag has not passed. */
export async function settleCampaign(campaign: CampaignParams, opts: SettleOptions & FetchOptions): Promise<SettleOutput> {
  checkCampaign(campaign);
  assertSettleable(campaign.window_end_ts ?? windowEndTs(campaign.window_end), opts.now);
  const fetched: FetchedSeries[] = [];
  for (const source of SOURCES) {
    for (const cell of campaign.grid_cells) {
      fetched.push(await fetchSourceSeries(source, cell, campaign.window_start, campaign.window_end, opts));
    }
  }
  const pick = (src: SourceId) => fetched.filter((f) => f.series.source === src).map((f) => f.series);
  const result = settleFromSeries(campaign, pick('open-meteo-archive'), pick('nasa-power'), opts);
  return { result, fetched, attribution: SOURCE_ATTRIBUTION };
}

/** Re-derive the data_hash of a published canonical document from its own contents. */
export function checkPublishedDocument(json: string, dataHash: string): { hash_ok: boolean; canonical_ok: boolean; actual_hash: string } {
  const actual = sha256Hex(json);
  let canonical = false;
  try {
    canonical = canonicalJson(JSON.parse(json)) === json;
  } catch {
    canonical = false;
  }
  return { hash_ok: actual === dataHash.toLowerCase(), canonical_ok: canonical, actual_hash: actual };
}
