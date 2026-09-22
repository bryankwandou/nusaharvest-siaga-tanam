#!/usr/bin/env node
// Pull daily rainfall for a grid cell from both sources, cache raw bodies with their sha256,
// and fail on any missing day (no interpolation).
//
//   node scripts/climate/fetch.mjs --lat -7.7078 --lon 110.6101 --start 2025-10-01 --end 2025-12-31
//   node scripts/climate/fetch.mjs --cell 7401906 --start 2025-10-01 --end 2025-12-31 [--source open-meteo-archive|nasa-power] [--no-cache]
//
// Writes research-out/climate/fetch/<cell>_<start>_<end>.json (manifest with URLs, hashes, totals, attribution).
import { args, climate, settlement, getSeries, writeJson, die, OUT } from './_common.mjs';
import { join } from 'node:path';

const a = args();
const cell = a.cell !== undefined ? Number(a.cell) : a.lat !== undefined ? climate.gridCellFor(Number(a.lat), Number(a.lon)) : die('need --cell or --lat/--lon');
const start = a.start ?? die('need --start YYYY-MM-DD');
const end = a.end ?? die('need --end YYYY-MM-DD');
climate.parseDay(start);
climate.parseDay(end);
const latest = climate.latestSettledDay(new Date());
if (end > latest) die(`--end ${end} is inside the ${climate.DATA_LAG_DAYS}-day data lag (latest final day is ${latest})`);
const sources = a.source ? [a.source] : settlement.SOURCES;

const manifest = { grid_cell: cell, center: climate.gridCellCenter(cell), start, end, fetched: [], attribution: {} };
let failed = false;
for (const source of sources) {
  try {
    const f = await getSeries(source, cell, start, end, { useCache: !a['no-cache'] });
    const total = climate.windowTotalMm100(f.series.daily, start, end);
    manifest.fetched.push({
      source,
      url: f.series.url,
      cached: f.cached,
      fetched_at: f.meta.fetched_at,
      body_sha256: f.body_sha256,
      normalized_sha256: f.series.raw_sha256,
      days: f.series.daily.length,
      total_mm100: total,
    });
    manifest.attribution[source] = settlement.SOURCE_ATTRIBUTION[source];
    console.log(`${source.padEnd(19)} cell ${cell}  ${f.series.daily.length} days  total ${(total / 100).toFixed(2)} mm  ${f.cached ? 'cache' : 'network'}  sha256 ${f.body_sha256.slice(0, 16)}...`);
  } catch (e) {
    failed = true;
    console.error(`FAIL ${source}: ${e.message}`);
  }
}
const path = join(OUT, 'climate', 'fetch', `${cell}_${start}_${end}.json`);
writeJson(path, manifest);
console.log(`manifest: ${path}`);
for (const s of Object.values(manifest.attribution)) console.log(`attribution: ${s}`);
if (failed) process.exit(2);
