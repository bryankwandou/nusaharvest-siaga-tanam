// Shared helpers for scripts/climate/*.mjs and scripts/verify.mjs.
// Requires Node >= 22.18 (TypeScript type stripping on by default). The web/lib modules are loaded
// directly from source so scripts and the server run byte-identical logic.
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT = join(REPO, 'research-out');
export const CACHE = join(OUT, 'climate', 'cache');

// web/lib uses extensionless relative imports (bundler resolution). Map them to .ts for Node.
registerHooks({
  resolve(specifier, context, next) {
    let r;
    if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(candidate))) r = next(candidate.href, context);
    }
    r ??= next(specifier, context);
    // web/package.json has no "type" field; declare the format so Node does not re-parse as CommonJS.
    return r.url.endsWith('.ts') ? { ...r, format: 'module-typescript' } : r;
  },
});

export const climate = await import(pathToFileURL(join(REPO, 'web', 'lib', 'climate.ts')).href);
export const settlement = await import(pathToFileURL(join(REPO, 'web', 'lib', 'settlement.ts')).href);

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

export function die(msg, code = 1) {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function gitCommit() {
  try {
    const opt = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    const head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], opt).trim();
    const dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'web/lib', 'scripts'], opt).trim();
    return dirty ? `${head}-dirty` : head;
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Open-Meteo rate ledger. Free tier limits: 600 calls/min, 5,000/hour, 10,000/day, non-commercial.
// A request covering more than 14 days counts as ceil(days / 14) calls (fractional call weighting).
// We stay at 90 percent of each limit and pause between heavy calls.
// ---------------------------------------------------------------------------
const LEDGER = join(OUT, 'climate', 'open-meteo-ledger.jsonl');
const LIMITS = [
  { window: 60_000, max: 540, name: 'minute' },
  { window: 3_600_000, max: 4_500, name: 'hour' },
  { window: 86_400_000, max: 9_000, name: 'day' },
];

export function openMeteoWeight(start, end) {
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  return Math.max(1, Math.ceil(days / 14));
}

async function reserveOpenMeteo(weight) {
  const now = Date.now();
  const entries = existsSync(LEDGER)
    ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => now - e.t < 86_400_000)
    : [];
  for (const lim of LIMITS.slice(1)) {
    const used = entries.filter((e) => now - e.t < lim.window).reduce((n, e) => n + e.w, 0);
    if (used + weight > lim.max) {
      throw new Error(`Open-Meteo ${lim.name} budget: ${used} used + ${weight} requested > ${lim.max}. Wait, or reuse the cache.`);
    }
  }
  // A single long-range request can exceed the per-minute figure on its own; space those out by a minute.
  const lastMinute = entries.filter((e) => now - e.t < 60_000).reduce((n, e) => n + e.w, 0);
  if (lastMinute > 0 && lastMinute + weight > LIMITS[0].max) {
    const wait = 61_000 - (now - Math.max(...entries.map((e) => e.t)));
    if (wait > 0) {
      console.error(`  (pausing ${Math.ceil(wait / 1000)} s to respect the Open-Meteo per-minute limit)`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  mkdirSync(dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, JSON.stringify({ t: Date.now(), w: weight }) + '\n');
}

// ---------------------------------------------------------------------------
// Cached fetch: raw bodies stored under research-out/climate/cache/<source>/<sha256(url)>.json with a
// .meta.json holding url, literal sha256, normalized sha256 and fetch time. Cache hits are re-hashed.
// ---------------------------------------------------------------------------
export async function cachedBody(source, url, { useCache = true, start, end } = {}) {
  const key = sha256(url).slice(0, 32);
  const bodyPath = join(CACHE, source, `${key}.json`);
  const metaPath = join(CACHE, source, `${key}.meta.json`);
  if (useCache && existsSync(bodyPath) && existsSync(metaPath)) {
    const body = readFileSync(bodyPath, 'utf8');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (meta.url !== url) throw new Error(`cache key collision for ${url}`);
    if (sha256(body) !== meta.body_sha256) throw new Error(`cache corrupted: ${bodyPath} does not match its recorded sha256`);
    return { body, meta, cached: true };
  }
  if (source === 'open-meteo-archive') await reserveOpenMeteo(openMeteoWeight(start, end));
  const body = await settlement.fetchBody(url, { fetchImpl: fetch });
  const meta = {
    source,
    url,
    fetched_at: new Date().toISOString(),
    bytes: Buffer.byteLength(body),
    body_sha256: sha256(body),
    normalized_sha256: settlement.normalizedBodySha256(source, body),
    attribution: settlement.SOURCE_ATTRIBUTION[source],
  };
  mkdirSync(dirname(bodyPath), { recursive: true });
  writeFileSync(bodyPath, body);
  writeJson(metaPath, meta);
  return { body, meta, cached: false };
}

/** Fetch one source for one grid cell (or an exact point) and fail loudly on any missing day. */
export async function getSeries(source, cell, start, end, { useCache = true, exact = null, allowMissing = false } = {}) {
  const url = exact ? exactUrl(source, exact.lat, exact.lon, start, end) : settlement.sourceUrl(source, cell, start, end);
  const { body, meta, cached } = await cachedBody(source, url, { useCache, start, end });
  const fetched = settlement.seriesFromBody(source, cell, url, body, start, end);
  const missing = settlement.missingDays([fetched.series]);
  if (missing.length && !allowMissing) {
    const d = missing[0].days;
    throw new Error(`${source} cell ${cell}: ${d.length} missing day(s), refusing to interpolate: ${d.slice(0, 10).join(', ')}${d.length > 10 ? ', ...' : ''}`);
  }
  return { ...fetched, meta, cached };
}

/** URL for an exact coordinate, same parameters as the grid-cell URL. Only used to reproduce the original research. */
export function exactUrl(source, lat, lon, start, end) {
  if (source === 'open-meteo-archive') {
    return `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}&daily=precipitation_sum&timezone=Asia%2FJakarta`;
  }
  return `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR&community=AG&longitude=${lon}&latitude=${lat}&start=${start.replace(/-/g, '')}&end=${end.replace(/-/g, '')}&format=JSON&time-standard=LST`;
}

/** The four research sites of research/data/backtest-calibrated.json (same coordinates). */
export const SITES = {
  klaten: { name: 'Klaten', lat: -7.7078, lon: 110.6101, expect: { p20_mm: 551, hits: 5 } },
  grobogan: { name: 'Grobogan', lat: -7.09, lon: 110.92, expect: { p20_mm: 559, hits: 6 } },
  demak: { name: 'Demak', lat: -6.89, lon: 110.64, expect: { p20_mm: 581, hits: 6 } },
  kupang: { name: 'Kupang', lat: -10.17, lon: 123.61, expect: { p20_mm: 196, hits: 4 } },
};
