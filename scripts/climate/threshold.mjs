#!/usr/bin/env node
// Climatology, p10/p20 thresholds and 25-year backtest for one grid cell and onset window.
//
//   node scripts/climate/threshold.mjs --lat -7.7078 --lon 110.6101 --window 10-01:12-31
//   node scripts/climate/threshold.mjs --cell 2962106 --window 10-01:12-31 [--amount-full 300000 --amount-half 150000 --units 100]
//   node scripts/climate/threshold.mjs --reproduce      # re-run the four research sites and compare with
//                                                       # research/data/backtest-calibrated.json; exit 1 on any mismatch
//
// Primary source only (Open-Meteo archive), as in web/lib/climate.ts quote(). Baseline 1991-2020.
import { args, climate, getSeries, writeJson, die, OUT, REPO, SITES } from './_common.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const a = args();
const SRC = 'open-meteo-archive';

function parseWindow(w, seasonYear) {
  const m = /^(\d{2}-\d{2}):(\d{2}-\d{2})$/.exec(w ?? '');
  if (!m) die('--window must look like MM-DD:MM-DD, e.g. 10-01:12-31');
  const start = `${seasonYear}-${m[1]}`;
  const end = `${m[2] < m[1] ? seasonYear + 1 : seasonYear}-${m[2]}`;
  climate.parseDay(start);
  climate.parseDay(end);
  return { start, end };
}

/**
 * Core computation. `rule` 'v1' is the settlement rule (floor to mm10, observed <= thr_half);
 * the legacy research rule (unrounded total strictly below unrounded p20) is reported alongside.
 */
function analyse(daily, windowStart, windowEnd, latestDay, amounts) {
  const thr = climate.computeThresholds([daily], windowStart, windowEnd);
  const bt = climate.backtest([daily], windowStart, windowEnd, thr, amounts, latestDay);
  const base = climate
    .seasonTotals([daily], windowStart, windowEnd, climate.BASELINE_START_YEAR, climate.BASELINE_END_YEAR)
    .filter((t) => t.total_mm100 !== null)
    .map((t) => t.total_mm100);
  const p20raw = climate.percentile(base, 0.2); // mm100, unrounded
  const legacyHits = bt.years
    .filter((y) => y.total_mm10 !== null)
    .map((y) => ({ year: y.season_year, total_mm100: climate.windowTotalMm100(daily, ...Object.values(climate.seasonWindow(windowStart, windowEnd, y.season_year))) }))
    .filter((y) => y.total_mm100 < p20raw)
    .map((y) => ({ year: y.year, mm: Math.round(y.total_mm100 / 100), total_mm100: y.total_mm100 }));
  return {
    thresholds: thr,
    p10_mm: Math.round(climate.percentile(base, 0.1) / 100),
    p20_mm: Math.round(p20raw / 100),
    median_mm: Math.round(climate.percentile(base, 0.5) / 100),
    backtest: bt,
    v1_hits: bt.years.filter((y) => y.outcome === 'FULL' || y.outcome === 'HALF').map((y) => y.season_year),
    p10_hits: bt.years.filter((y) => y.outcome === 'FULL').map((y) => y.season_year),
    legacy_hits: legacyHits,
  };
}

async function reproduce() {
  const refPath = resolve(REPO, '..', 'research', 'data', 'backtest-calibrated.json');
  if (!existsSync(refPath)) die(`reference not found: ${refPath}`);
  const ref = JSON.parse(readFileSync(refPath, 'utf8'));
  // Same request as the original research script: exact site coordinates, 1991-01-01..2025-12-31.
  const START = '1991-01-01', END = '2025-12-31';
  const report = { reference: refPath, generated_at: new Date().toISOString(), sites: [], mismatches: [] };
  for (const [id, site] of Object.entries(SITES)) {
    const f = await getSeries(SRC, climate.gridCellFor(site.lat, site.lon), START, END, { exact: site });
    const r = analyse(f.series.daily, '2025-10-01', '2025-12-31', END, { amount_full_idr: 0, amount_half_idr: 0, units_max: 0 });
    const refSite = ref.results.find((x) => x.site === site.name);
    const refHits = refSite.drought_hits_2001_2025;
    const row = {
      site: site.name,
      url: f.series.url,
      body_sha256: f.body_sha256,
      p20_mm: r.p20_mm,
      p20_ref: refSite.p20_mm,
      median_mm: r.median_mm,
      median_ref: refSite.median_mm,
      hits_legacy: r.legacy_hits.length,
      hits_v1_rule: r.v1_hits.length,
      hits_ref: refSite.hit_count,
      hit_years: r.legacy_hits,
      hit_years_ref: refHits,
      v1_thr_full_mm10: r.thresholds.thr_full_mm10,
      v1_thr_half_mm10: r.thresholds.thr_half_mm10,
      v1_full_years: r.p10_hits,
      v1_half_or_full_years: r.v1_hits,
    };
    const chk = (field, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) report.mismatches.push({ site: site.name, field, got, want }); };
    chk('p20_mm', r.p20_mm, refSite.p20_mm);
    chk('median_mm', r.median_mm, refSite.median_mm);
    chk('hit_count', r.legacy_hits.length, refSite.hit_count);
    chk('hit_years', r.legacy_hits.map((h) => h.year), refHits.map((h) => h.year));
    // The reference summed floats; we sum exact integers. A displayed mm may differ only when the exact
    // total sits on a .50 boundary and float error pushed the reference below it.
    for (const h of r.legacy_hits) {
      const rh = refHits.find((x) => x.year === h.year);
      if (!rh) continue;
      if (Math.abs(h.total_mm100 - rh.mm * 100) > 50) chk(`hit_mm_${h.year}`, h.mm, rh.mm);
      else if (h.mm !== rh.mm) {
        (report.notes ??= []).push(
          `${site.name} ${h.year}: exact total ${(h.total_mm100 / 100).toFixed(2)} mm rounds to ${h.mm}; reference shows ${rh.mm} because its float sum ` +
            `landed just below .50. Not a data difference.`,
        );
      }
    }
    chk('hit_count_v1_rule', r.v1_hits.length, refSite.hit_count);
    chk('p20_mm_vs_task_expectation', r.p20_mm, site.expect.p20_mm);
    report.sites.push(row);
    console.log(
      `${site.name.padEnd(9)} p20 ${String(r.p20_mm).padStart(4)} mm (ref ${refSite.p20_mm})  median ${r.median_mm} (ref ${refSite.median_mm})  ` +
        `hits ${r.legacy_hits.length} legacy / ${r.v1_hits.length} v1 rule (ref ${refSite.hit_count})  years ${r.legacy_hits.map((h) => `${h.year}:${h.mm}`).join(' ')}`,
    );
  }
  writeJson(join(OUT, 'climate', 'reproduce-backtest-calibrated.json'), report);
  for (const n of report.notes ?? []) console.log(`note: ${n}`);
  if (report.mismatches.length) {
    console.error(`MISMATCH (${report.mismatches.length}):`);
    for (const m of report.mismatches) console.error(`  ${m.site} ${m.field}: got ${JSON.stringify(m.got)} want ${JSON.stringify(m.want)}`);
    process.exit(1);
  }
  console.log(`All four sites reproduce research/data/backtest-calibrated.json (p20, median, hit count, hit years)${report.notes ? '; see notes above' : ''}.`);
}

async function single() {
  const exact = a.exact ? { lat: Number(a.lat), lon: Number(a.lon) } : null;
  const cell = a.cell !== undefined ? Number(a.cell) : a.lat !== undefined ? climate.gridCellFor(Number(a.lat), Number(a.lon)) : die('need --cell or --lat/--lon');
  const latest = climate.latestSettledDay(new Date());
  const probe = parseWindow(a.window, 2000);
  const f = await getSeries(SRC, cell, `${climate.BASELINE_START_YEAR}-01-01`, latest, { exact });
  const amounts = { amount_full_idr: Number(a['amount-full'] ?? 0), amount_half_idr: Number(a['amount-half'] ?? 0), units_max: Number(a.units ?? 0) };
  const r = analyse(f.series.daily, probe.start, probe.end, latest, amounts);
  const out = {
    grid_cell: cell,
    center: climate.gridCellCenter(cell),
    window: a.window,
    source: { url: f.series.url, body_sha256: f.body_sha256, normalized_sha256: f.series.raw_sha256, attribution: f.meta.attribution },
    latest_day: latest,
    ...r,
  };
  const path = join(OUT, 'climate', 'thresholds', `${cell}_${a.window.replace(':', '_')}.json`);
  writeJson(path, out);
  console.log(`cell ${cell} window ${a.window}: p10 ${r.p10_mm} mm  p20 ${r.p20_mm} mm  median ${r.median_mm} mm`);
  console.log(`thr_full_mm10 ${r.thresholds.thr_full_mm10}  thr_half_mm10 ${r.thresholds.thr_half_mm10}`);
  const bt = r.backtest;
  console.log(`backtest ${bt.years[0].season_year}-${bt.years.at(-1).season_year}: FULL ${bt.full_count}  HALF ${bt.half_count}  NONE ${bt.none_count}  missing ${bt.missing_count}`);
  for (const y of bt.years) console.log(`  ${y.season_year}  ${y.total_mm10 === null ? '   n/a' : (y.total_mm10 / 10).toFixed(1).padStart(7)} mm  ${y.outcome ?? 'MISSING'}`);
  console.log(`written: ${path}`);
}

if (a.reproduce) await reproduce();
else await single();
