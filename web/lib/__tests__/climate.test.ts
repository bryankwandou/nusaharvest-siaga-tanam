// Golden vectors for canonical JSON / hashing, and the threshold math against the four research sites.
// The site tests read real Open-Meteo responses recorded by `node scripts/climate/threshold.mjs --reproduce`
// under research-out/climate/cache (each body is checked against its recorded sha256 before use).
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  backtest,
  canonicalJson,
  canonicalSha256,
  computeThresholds,
  divergenceBp,
  gridCellCenter,
  gridCellFor,
  outcomeFor as climateOutcomeFor,
  parseOpenMeteo,
  percentile,
  seasonTotals,
} from '../climate';
import { outcomeFor as chainOutcomeFor } from '../chain/layout';

const CACHE = fileURLToPath(new URL('../../../research-out/climate/cache/', import.meta.url));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function recorded(source: 'open-meteo-archive' | 'nasa-power', url: string): string {
  const key = sha(url).slice(0, 32);
  const body = `${CACHE}${source}/${key}.json`;
  const meta = `${CACHE}${source}/${key}.meta.json`;
  if (!existsSync(body)) throw new Error(`recorded response missing for ${url}; run the scripts in scripts/climate first`);
  const text = readFileSync(body, 'utf8');
  const m = JSON.parse(readFileSync(meta, 'utf8')) as { url: string; body_sha256: string };
  if (m.url !== url || sha(text) !== m.body_sha256) throw new Error(`recorded response for ${url} fails its sha256 check`);
  return text;
}

describe('canonical JSON golden vectors', () => {
  it('sorts keys, strips whitespace, normalises -0, escapes like JSON.stringify', () => {
    const v = { k: 'Rp300.000', b: [3, null, true, -12], a: { z: 'é\n\u0001', y: -0 }, '': 1 };
    const s = canonicalJson(v);
    // U+00E9 stays a raw (2-byte UTF-8) character; control characters are escaped.
    expect(s).toBe('{"":1,"a":{"y":0,"z":"é\\n\\u0001"},"b":[3,null,true,-12],"k":"Rp300.000"}');
    // Hash computed independently with .NET SHA256 over the UTF-8 bytes of the literal above.
    expect(canonicalSha256(v)).toBe('552e251b63353564d832179e3cf199fba7ba1982eb9c13e0d8c2260f48026f05');
    expect(canonicalSha256({})).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  });

  it('is independent of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('rejects anything that is not exactly representable', () => {
    expect(() => canonicalJson({ x: 1.5 })).toThrow();
    expect(() => canonicalJson({ x: 2 ** 53 })).toThrow();
    expect(() => canonicalJson({ x: undefined })).toThrow();
    expect(() => canonicalJson({ x: new Date(0) })).toThrow();
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });
});

describe('grid and rule primitives', () => {
  it('maps coordinates to 0.1 degree cells and back', () => {
    expect(gridCellFor(-7.7078, 110.6101)).toBe(2962106);
    expect(gridCellCenter(2962106)).toEqual({ lat: -7.75, lon: 110.65 });
    expect(gridCellFor(-10.17, 123.61)).toBe(2875836);
  });

  it('outcome rule in climate.ts is identical to chain/layout.ts', () => {
    for (const [o, f, h] of [[0, 5, 9], [5, 5, 9], [6, 5, 9], [9, 5, 9], [10, 5, 9], [5, 5, 5], [6, 5, 5], [1000, 0, 0]] as const) {
      expect(climateOutcomeFor(o, f, h)).toBe(chainOutcomeFor(o, f, h));
    }
    expect(chainOutcomeFor(5510, 4200, 5510)).toBe('HALF');
    expect(chainOutcomeFor(4200, 4200, 5510)).toBe('FULL');
    expect(chainOutcomeFor(5511, 4200, 5510)).toBe('NONE');
  });

  it('percentile is Hyndman-Fan type 7', () => {
    expect(percentile([1, 2, 3, 4], 0.2)).toBeCloseTo(1.6, 12);
    expect(percentile([10], 0.2)).toBe(10);
  });

  it('divergence in basis points, floor, primary as denominator', () => {
    expect(divergenceBp(10000, 12500)).toBe(2500);
    expect(divergenceBp(10000, 12501)).toBe(2501);
    expect(divergenceBp(24380, 32498)).toBe(3329);
    expect(divergenceBp(0, 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(divergenceBp(0, 0)).toBe(0);
  });
});

// Reference: ../research/data/backtest-calibrated.json (Oct 1 - Dec 31 onset window, 1991-2020 baseline, 2001-2025 backtest).
const SITES = [
  { name: 'Klaten', lat: -7.7078, lon: 110.6101, p20: 551, median: 796, hits: [2006, 2009, 2018, 2019, 2023] },
  { name: 'Grobogan', lat: -7.09, lon: 110.92, p20: 559, median: 645, hits: [2002, 2004, 2006, 2009, 2019, 2023] },
  { name: 'Demak', lat: -6.89, lon: 110.64, p20: 581, median: 716, hits: [2002, 2004, 2006, 2009, 2019, 2023] },
  { name: 'Kupang', lat: -10.17, lon: 123.61, p20: 196, median: 312, hits: [2004, 2015, 2019, 2023] },
];

describe('threshold math reproduces the calibrated research backtest (real ERA5 data)', () => {
  for (const s of SITES) {
    it(`${s.name}: p20 ${s.p20} mm, ${s.hits.length} hits`, () => {
      const url =
        `https://archive-api.open-meteo.com/v1/archive?latitude=${s.lat}&longitude=${s.lon}` +
        `&start_date=1991-01-01&end_date=2025-12-31&daily=precipitation_sum&timezone=Asia%2FJakarta`;
      const daily = parseOpenMeteo(recorded('open-meteo-archive', url), '1991-01-01', '2025-12-31');
      expect(daily.filter((d) => d.rain_mm100 === null)).toEqual([]);

      const thr = computeThresholds([daily], '2025-10-01', '2025-12-31');
      expect(thr.baseline_years).toHaveLength(30);
      const base = seasonTotals([daily], '2025-10-01', '2025-12-31', 1991, 2020).map((t) => t.total_mm100 as number);
      expect(Math.round(percentile(base, 0.2) / 100)).toBe(s.p20);
      expect(Math.round(percentile(base, 0.5) / 100)).toBe(s.median);
      expect(thr.thr_half_mm10).toBe(Math.floor(percentile(base, 0.2) / 10));

      const bt = backtest([daily], '2025-10-01', '2025-12-31', thr, { amount_full_idr: 0, amount_half_idr: 0, units_max: 0 }, '2025-12-31');
      expect(bt.years[0]?.season_year).toBe(2001);
      expect(bt.years.at(-1)?.season_year).toBe(2025);
      expect(bt.missing_count).toBe(0);
      const fired = bt.years.filter((y) => y.outcome !== 'NONE').map((y) => y.season_year);
      expect(fired).toEqual(s.hits);
      expect(bt.full_count + bt.half_count).toBe(s.hits.length);
    });
  }
});
