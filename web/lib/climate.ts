// Climate index pipeline, rule version 1. Ported from scripts/climate/backtest-calibrated.mjs.
//
// This file is intentionally self-contained (only node:crypto, no relative imports, only
// erasable TypeScript syntax) so scripts/climate/*.mjs can import it directly with Node 22.18+/24
// type stripping, and the auditor runs the exact same code the settlement worker runs.
//
// Units: all rainfall arithmetic is done in integer hundredths of a millimetre (mm100) to keep
// totals exact and reproducible across languages. On-chain values are mm x 10 (mm10), obtained
// by floor division of mm100 by 10.

import { createHash } from 'node:crypto';

export const CLIMATE_SCRIPT_VERSION = 'nh-climate/1.0.0';
export const BASELINE_START_YEAR = 1991;
export const BASELINE_END_YEAR = 2020;
export const BACKTEST_YEARS = 25;
export const DATA_LAG_DAYS = 7;
export const REVIEW_DIVERGENCE_BP = 2500; // 25 percent
export const GRID_RES_DEG = 0.1;

export type SourceId = 'open-meteo-archive' | 'nasa-power';
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface DailyValue {
  day: string; // YYYY-MM-DD
  rain_mm100: number | null; // null = missing in source
}

export interface SourceSeries {
  source: SourceId;
  grid_cell: number;
  url: string;
  daily: DailyValue[];
  raw_sha256: string; // sha256 of the normalized response body (timing fields removed, keys sorted)
}

// ---------------------------------------------------------------------------
// Grid cells: 0.1 degree global grid, u32 id = row * 3600 + col
//   row = floor((lat + 90) * 10), col = floor((lon + 180) * 10). Centre = lower edge + 0.05.
// ---------------------------------------------------------------------------

export function gridCellFor(lat: number, lon: number): number {
  if (!(lat >= -90 && lat < 90) || !(lon >= -180 && lon < 180)) throw new RangeError('lat/lon out of range');
  // Work in integer tenth-degree units with a tiny epsilon to avoid float edges like 0.3*10 = 2.9999.
  const row = Math.floor((lat + 90) * 10 + 1e-9);
  const col = Math.floor((lon + 180) * 10 + 1e-9);
  return row * 3600 + col;
}

export function gridCellCenter(cell: number): { lat: number; lon: number } {
  if (!Number.isInteger(cell) || cell < 0 || cell >= 1800 * 3600) throw new RangeError('invalid grid cell');
  const row = Math.floor(cell / 3600);
  const col = cell % 3600;
  return { lat: Math.round(((row + 0.5) / 10 - 90) * 100) / 100, lon: Math.round(((col + 0.5) / 10 - 180) * 100) / 100 };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export function parseDay(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`bad date ${day}`);
  const t = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
  if (formatDay(t) !== day) throw new Error(`invalid calendar date ${day}`);
  return t;
}
export function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
export function addDays(day: string, n: number): string {
  return formatDay(parseDay(day) + n * DAY_MS);
}
export function daysInclusive(start: string, end: string): string[] {
  const s = parseDay(start);
  const e = parseDay(end);
  if (e < s) throw new Error('end before start');
  const out: string[] = [];
  for (let t = s; t <= e; t += DAY_MS) out.push(formatDay(t));
  return out;
}
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * Map a campaign window (window_start, window_end dates of the live season) onto season year Y.
 * The season year is the calendar year of window_start. Windows may cross a year boundary.
 * Feb 29 maps to Feb 28 in non-leap years.
 */
export function seasonWindow(windowStart: string, windowEnd: string, seasonYear: number): { start: string; end: string } {
  const s0 = parseDay(windowStart);
  const e0 = parseDay(windowEnd);
  if (e0 < s0) throw new Error('window_end before window_start');
  if (e0 - s0 > 366 * DAY_MS) throw new Error('window longer than one year');
  const yearShift = +windowEnd.slice(0, 4) - +windowStart.slice(0, 4);
  const md = (d: string, y: number) => {
    let m = d.slice(5);
    if (m === '02-29' && !isLeap(y)) m = '02-28';
    return `${String(y).padStart(4, '0')}-${m}`;
  };
  return { start: md(windowStart, seasonYear), end: md(windowEnd, seasonYear + yearShift) };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export function openMeteoUrl(cell: number, start: string, end: string): string {
  const { lat, lon } = gridCellCenter(cell);
  return (
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}` +
    `&start_date=${start}&end_date=${end}&daily=precipitation_sum&timezone=Asia%2FJakarta`
  );
}

export function nasaPowerUrl(cell: number, start: string, end: string): string {
  const { lat, lon } = gridCellCenter(cell);
  return (
    `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR&community=AG` +
    `&longitude=${lon.toFixed(2)}&latitude=${lat.toFixed(2)}&start=${start.replace(/-/g, '')}&end=${end.replace(/-/g, '')}` +
    `&format=JSON&time-standard=LST`
  );
}

export const toMm100 = (mm: number): number => Math.round(mm * 100);

export function parseOpenMeteo(body: string, start: string, end: string): DailyValue[] {
  const j = JSON.parse(body) as { daily?: { time?: unknown; precipitation_sum?: unknown } };
  const time = j.daily?.time;
  const vals = j.daily?.precipitation_sum;
  if (!Array.isArray(time) || !Array.isArray(vals) || time.length !== vals.length) throw new Error('unexpected Open-Meteo response shape');
  const byDay = new Map<string, number | null>();
  time.forEach((t, i) => {
    const v = vals[i];
    byDay.set(String(t), typeof v === 'number' && Number.isFinite(v) && v >= 0 ? toMm100(v) : null);
  });
  return daysInclusive(start, end).map((day) => ({ day, rain_mm100: byDay.get(day) ?? null }));
}

export function parseNasaPower(body: string, start: string, end: string): DailyValue[] {
  const j = JSON.parse(body) as { header?: { fill_value?: number }; properties?: { parameter?: { PRECTOTCORR?: Record<string, unknown> } } };
  const series = j.properties?.parameter?.PRECTOTCORR;
  if (!series || typeof series !== 'object') throw new Error('unexpected NASA POWER response shape');
  const fill = j.header?.fill_value ?? -999;
  return daysInclusive(start, end).map((day) => {
    const v = series[day.replace(/-/g, '')];
    return { day, rain_mm100: typeof v === 'number' && Number.isFinite(v) && v !== fill && v >= 0 ? toMm100(v) : null };
  });
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function getText(fetchImpl: FetchLike, url: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(url);
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return text;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Response hashing: timing fields (Open-Meteo generationtime_ms, NASA POWER times) are stripped and keys
// sorted before hashing, so the hash is reproducible by a third party. settlement.ts re-exports these.
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

export async function fetchSeries(source: SourceId, cell: number, start: string, end: string, fetchImpl: FetchLike): Promise<SourceSeries> {
  const url = source === 'open-meteo-archive' ? openMeteoUrl(cell, start, end) : nasaPowerUrl(cell, start, end);
  const body = await getText(fetchImpl, url);
  const daily = source === 'open-meteo-archive' ? parseOpenMeteo(body, start, end) : parseNasaPower(body, start, end);
  return { source, grid_cell: cell, url, daily, raw_sha256: normalizedBodySha256(source, body) };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Sum of rain_mm100 for [start, end]; null if any day is missing. */
export function windowTotalMm100(daily: readonly DailyValue[], start: string, end: string): number | null {
  const map = new Map(daily.map((d) => [d.day, d.rain_mm100] as const));
  let sum = 0;
  for (const day of daysInclusive(start, end)) {
    const v = map.get(day);
    if (v === undefined || v === null) return null;
    sum += v;
  }
  return sum;
}

/**
 * Area total across grid cells: floor(sum over cells of cell totals / number of cells).
 * Returns null if any cell is missing any day.
 */
export function areaTotalMm100(seriesPerCell: readonly (readonly DailyValue[])[], start: string, end: string): number | null {
  if (seriesPerCell.length === 0) throw new Error('no grid cells');
  let sum = 0;
  for (const s of seriesPerCell) {
    const t = windowTotalMm100(s, start, end);
    if (t === null) return null;
    sum += t;
  }
  return Math.floor(sum / seriesPerCell.length);
}

export const mm100ToMm10 = (mm100: number): number => Math.floor(mm100 / 10);

/** Linear-interpolation percentile (Hyndman-Fan type 7), same as the reference script. p in [0,1]. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('percentile of empty set');
  if (!(p >= 0 && p <= 1)) throw new RangeError('p must be in [0,1]');
  const s = values.slice().sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (i - lo);
}

export type OutcomeName = 'NONE' | 'HALF' | 'FULL';
export function outcomeFor(observedMm10: number, thrFullMm10: number, thrHalfMm10: number): OutcomeName {
  if (observedMm10 <= thrFullMm10) return 'FULL';
  if (observedMm10 <= thrHalfMm10) return 'HALF';
  return 'NONE';
}

export interface SeasonTotal {
  season_year: number;
  start: string;
  end: string;
  total_mm100: number | null;
}

export function seasonTotals(
  seriesPerCell: readonly (readonly DailyValue[])[],
  windowStart: string,
  windowEnd: string,
  fromYear: number,
  toYear: number,
): SeasonTotal[] {
  const out: SeasonTotal[] = [];
  for (let y = fromYear; y <= toYear; y++) {
    const w = seasonWindow(windowStart, windowEnd, y);
    out.push({ season_year: y, start: w.start, end: w.end, total_mm100: areaTotalMm100(seriesPerCell, w.start, w.end) });
  }
  return out;
}

export interface Thresholds {
  baseline_years: number[];
  baseline_missing_years: number[];
  p10_mm100: number;
  p20_mm100: number;
  median_mm100: number;
  thr_full_mm10: number;
  thr_half_mm10: number;
}

/** thr_full = floor(P10 / 10), thr_half = floor(P20 / 10) over complete 1991-2020 seasons. */
export function computeThresholds(seriesPerCell: readonly (readonly DailyValue[])[], windowStart: string, windowEnd: string): Thresholds {
  const totals = seasonTotals(seriesPerCell, windowStart, windowEnd, BASELINE_START_YEAR, BASELINE_END_YEAR);
  const complete = totals.filter((t): t is SeasonTotal & { total_mm100: number } => t.total_mm100 !== null);
  if (complete.length < 25) throw new Error(`baseline has only ${complete.length} complete seasons, need at least 25`);
  const vals = complete.map((t) => t.total_mm100);
  const p10 = percentile(vals, 0.1);
  const p20 = percentile(vals, 0.2);
  return {
    baseline_years: complete.map((t) => t.season_year),
    baseline_missing_years: totals.filter((t) => t.total_mm100 === null).map((t) => t.season_year),
    p10_mm100: Math.floor(p10),
    p20_mm100: Math.floor(p20),
    median_mm100: Math.floor(percentile(vals, 0.5)),
    thr_full_mm10: Math.floor(p10 / 10),
    thr_half_mm10: Math.floor(p20 / 10),
  };
}

export interface BacktestRow {
  season_year: number;
  total_mm10: number | null;
  outcome: OutcomeName | null;
  cost_per_unit_idr: number;
}
export interface Backtest {
  years: BacktestRow[];
  full_count: number;
  half_count: number;
  none_count: number;
  missing_count: number;
  total_cost_per_unit_idr: number;
  total_cost_units_max_idr: number;
}

/** Last BACKTEST_YEARS complete seasons ending on or before latestDay. */
export function backtest(
  seriesPerCell: readonly (readonly DailyValue[])[],
  windowStart: string,
  windowEnd: string,
  thr: { thr_full_mm10: number; thr_half_mm10: number },
  amounts: { amount_full_idr: number; amount_half_idr: number; units_max: number },
  latestDay: string,
): Backtest {
  let lastYear = +latestDay.slice(0, 4);
  while (parseDay(seasonWindow(windowStart, windowEnd, lastYear).end) > parseDay(latestDay)) lastYear--;
  const totals = seasonTotals(seriesPerCell, windowStart, windowEnd, lastYear - BACKTEST_YEARS + 1, lastYear);
  const years: BacktestRow[] = totals.map((t) => {
    if (t.total_mm100 === null) return { season_year: t.season_year, total_mm10: null, outcome: null, cost_per_unit_idr: 0 };
    const mm10 = mm100ToMm10(t.total_mm100);
    const outcome = outcomeFor(mm10, thr.thr_full_mm10, thr.thr_half_mm10);
    const cost = outcome === 'FULL' ? amounts.amount_full_idr : outcome === 'HALF' ? amounts.amount_half_idr : 0;
    return { season_year: t.season_year, total_mm10: mm10, outcome, cost_per_unit_idr: cost };
  });
  const perUnit = years.reduce((n, r) => n + r.cost_per_unit_idr, 0);
  return {
    years,
    full_count: years.filter((r) => r.outcome === 'FULL').length,
    half_count: years.filter((r) => r.outcome === 'HALF').length,
    none_count: years.filter((r) => r.outcome === 'NONE').length,
    missing_count: years.filter((r) => r.outcome === null).length,
    total_cost_per_unit_idr: perUnit,
    total_cost_units_max_idr: perUnit * amounts.units_max,
  };
}

// ---------------------------------------------------------------------------
// Source divergence
// ---------------------------------------------------------------------------

/** |primary - secondary| / primary in basis points (floor). Primary 0 and secondary > 0 counts as infinite. */
export function divergenceBp(primaryMm100: number, secondaryMm100: number): number {
  if (primaryMm100 === secondaryMm100) return 0;
  if (primaryMm100 === 0) return Number.MAX_SAFE_INTEGER;
  return Math.floor((Math.abs(primaryMm100 - secondaryMm100) * 10_000) / primaryMm100);
}
export const needsReview = (primaryMm100: number, secondaryMm100: number): boolean =>
  divergenceBp(primaryMm100, secondaryMm100) > REVIEW_DIVERGENCE_BP;

// ---------------------------------------------------------------------------
// Canonical JSON: object keys sorted by code unit, no whitespace, UTF-8, integers only.
// ---------------------------------------------------------------------------

export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [k: string]: CanonicalValue };

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new Error(`canonical JSON allows only safe integers, got ${value}`);
      return Object.is(value, -0) ? '0' : String(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error('canonical JSON allows only plain objects');
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = obj[k];
        if (v === undefined) throw new Error(`undefined value at key ${k}`);
        parts.push(`${JSON.stringify(k)}:${canonicalJson(v)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`canonical JSON cannot encode ${typeof value}`);
  }
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export const canonicalSha256 = (value: unknown): string => sha256Hex(canonicalBytes(value));

// ---------------------------------------------------------------------------
// Settlement document
// ---------------------------------------------------------------------------

export interface SettlementInput {
  campaign: {
    code: string;
    pubkey: string;
    grid_cells: number[];
    window_start: string;
    window_end: string;
    thr_full_mm10: number;
    thr_half_mm10: number;
  };
  primary: SourceSeries[]; // one per grid cell, same order as grid_cells
  secondary: SourceSeries[];
  script_commit: string;
}

export interface SettlementResult {
  document: CanonicalValue;
  json: string;
  data_hash: string;
  observed_mm10: number | null;
  secondary_mm10: number | null;
  divergence_bp: number | null;
  outcome: OutcomeName | null;
  review: boolean;
  review_reasons: string[];
}

function seriesDoc(s: SourceSeries, start: string, end: string): CanonicalValue {
  const inWindow = s.daily.filter((d) => d.day >= start && d.day <= end);
  return {
    source: s.source,
    grid_cell: s.grid_cell,
    url: s.url,
    raw_sha256: s.raw_sha256,
    daily: inWindow.map((d) => ({ day: d.day, rain_mm100: d.rain_mm100 })),
  };
}

export function buildSettlement(input: SettlementInput): SettlementResult {
  const { campaign } = input;
  const cells = campaign.grid_cells;
  const order = (list: SourceSeries[], name: string) =>
    cells.map((c) => {
      const s = list.find((x) => x.grid_cell === c);
      if (!s) throw new Error(`${name} series missing for grid cell ${c}`);
      return s;
    });
  const primary = order(input.primary, 'primary');
  const secondary = order(input.secondary, 'secondary');
  const start = campaign.window_start;
  const end = campaign.window_end;

  const pTotal = areaTotalMm100(primary.map((s) => s.daily), start, end);
  const sTotal = areaTotalMm100(secondary.map((s) => s.daily), start, end);
  const reasons: string[] = [];
  if (pTotal === null) reasons.push('primary source has missing days in window');
  if (sTotal === null) reasons.push('secondary source has missing days in window');
  let div: number | null = null;
  if (pTotal !== null && sTotal !== null) {
    div = divergenceBp(pTotal, sTotal);
    if (div > REVIEW_DIVERGENCE_BP) reasons.push(`sources differ by more than 25 percent (${div} bp)`);
  }
  const observed = pTotal === null ? null : mm100ToMm10(pTotal);
  const outcome = observed === null ? null : outcomeFor(observed, campaign.thr_full_mm10, campaign.thr_half_mm10);

  const document: CanonicalValue = {
    schema: 'nusaharvest.settlement.v1',
    rule_version: 1,
    script: { version: CLIMATE_SCRIPT_VERSION, commit: input.script_commit },
    campaign: {
      code: campaign.code,
      pubkey: campaign.pubkey,
      grid_cells: cells,
      window_start: start,
      window_end: end,
      thr_full_mm10: campaign.thr_full_mm10,
      thr_half_mm10: campaign.thr_half_mm10,
    },
    method: {
      unit: 'rain_mm100 = round(source_mm * 100)',
      area_total: 'floor(sum of per-cell window totals / number of cells)',
      observed: 'floor(primary area total mm100 / 10) = mm x 10',
      review_rule: 'review if |primary - secondary| * 10000 / primary > 2500',
      outcome_rule: 'observed <= thr_full -> FULL; observed <= thr_half -> HALF; else NONE',
    },
    primary: { source: 'open-meteo-archive', total_mm100: pTotal, series: primary.map((s) => seriesDoc(s, start, end)) },
    secondary: { source: 'nasa-power', total_mm100: sTotal, series: secondary.map((s) => seriesDoc(s, start, end)) },
    result: {
      observed_mm10: observed,
      secondary_mm10: sTotal === null ? null : mm100ToMm10(sTotal),
      divergence_bp: div,
      outcome,
      review: reasons.length > 0,
    },
  };
  const json = canonicalJson(document);
  return {
    document,
    json,
    data_hash: sha256Hex(json),
    observed_mm10: observed,
    secondary_mm10: sTotal === null ? null : mm100ToMm10(sTotal),
    divergence_bp: div,
    outcome,
    review: reasons.length > 0,
    review_reasons: reasons,
  };
}

/** Latest day for which both sources are expected to be final. */
export function latestSettledDay(now: Date = new Date()): string {
  return formatDay(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DATA_LAG_DAYS * DAY_MS);
}

/** Fetch primary series 1991-01-01..latest for each cell, compute thresholds and 25-year backtest. */
export async function quote(
  params: {
    grid_cells: number[];
    window_start: string;
    window_end: string;
    amount_full_idr: number;
    amount_half_idr: number;
    units_max: number;
  },
  fetchImpl: FetchLike,
  now: Date = new Date(),
): Promise<{ thresholds: Thresholds; backtest: Backtest; sources: { url: string; raw_sha256: string }[]; latest_day: string }> {
  const latest = latestSettledDay(now);
  const series: SourceSeries[] = [];
  for (const cell of params.grid_cells) series.push(await fetchSeries('open-meteo-archive', cell, `${BASELINE_START_YEAR}-01-01`, latest, fetchImpl));
  const daily = series.map((s) => s.daily);
  const thresholds = computeThresholds(daily, params.window_start, params.window_end);
  const bt = backtest(daily, params.window_start, params.window_end, thresholds, params, latest);
  return { thresholds, backtest: bt, sources: series.map((s) => ({ url: s.url, raw_sha256: s.raw_sha256 })), latest_day: latest };
}
