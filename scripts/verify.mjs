#!/usr/bin/env node
// Independent reproducer for a NusaHarvest settlement. Anyone can run it; it needs Node >= 22.18
// and network access to the two public data sources. It never reads the operator's cache.
//
//   node scripts/verify.mjs --data-hash <hex> --campaign campaign.json [--published settlement.json] [--outcome FULL|HALF|NONE]
//   node scripts/verify.mjs --data-hash <hex> --published settlement.json        (parameters read from the published document)
//
// campaign.json holds the on-chain parameters: { code, pubkey, grid_cells[], window_start, window_end,
// thr_full_mm10, thr_half_mm10, script_commit }. --published may be a local path or an https URL.
//
// What it checks:
//   1. If a published document is given: sha256(its exact bytes) == data_hash, and it is in canonical form.
//   2. It re-fetches every grid cell from Open-Meteo and NASA POWER, rebuilds the canonical document with the
//      same code the operator runs, and checks the recomputed data_hash equals the published one.
//   3. It checks the outcome (FULL/HALF/NONE) follows from observed rainfall and the campaign thresholds.
// On a mismatch it prints the first differing days so the disagreement can be located.
//
// Exit codes: 0 verified, 1 mismatch, 2 could not verify (too early, fetch failed, bad input).
import { args, climate, settlement, getSeries, die } from './climate/_common.mjs';
import { readFileSync } from 'node:fs';

const a = args();
const dataHash = String(a['data-hash'] ?? die('need --data-hash <hex>', 2)).toLowerCase();
if (!/^[0-9a-f]{64}$/.test(dataHash)) die('--data-hash must be 64 hex characters', 2);

let published = null;
if (a.published) {
  published = /^https:\/\//.test(a.published)
    ? await (await fetch(a.published)).text()
    : readFileSync(a.published, 'utf8');
}

let ok = true;
const fail = (msg) => { ok = false; console.log(`  FAIL  ${msg}`); };
const pass = (msg) => console.log(`  ok    ${msg}`);

let params;
let publishedDoc = null;
if (published !== null) {
  console.log('1. Published document');
  const chk = settlement.checkPublishedDocument(published, dataHash);
  chk.hash_ok ? pass(`sha256(document) = ${chk.actual_hash}`) : fail(`sha256(document) = ${chk.actual_hash}, expected ${dataHash}`);
  chk.canonical_ok ? pass('document is canonical JSON') : fail('document is not in canonical form (re-serialisation changes bytes)');
  publishedDoc = JSON.parse(published);
}
if (a.campaign) {
  params = JSON.parse(readFileSync(a.campaign, 'utf8'));
  if (publishedDoc) {
    const c = publishedDoc.campaign;
    for (const k of ['code', 'pubkey', 'window_start', 'window_end', 'thr_full_mm10', 'thr_half_mm10']) {
      if (JSON.stringify(c[k]) !== JSON.stringify(params[k])) fail(`published campaign.${k} = ${JSON.stringify(c[k])} but parameters say ${JSON.stringify(params[k])}`);
    }
    if (JSON.stringify(c.grid_cells) !== JSON.stringify(params.grid_cells)) fail('published grid_cells differ from parameters');
  }
} else if (publishedDoc) {
  params = { ...publishedDoc.campaign, script_commit: publishedDoc.script.commit };
  console.log('  note  campaign parameters taken from the published document; compare them with the on-chain Campaign account');
} else {
  die('need --campaign and/or --published', 2);
}
const commit = params.script_commit ?? publishedDoc?.script?.commit ?? die('script_commit missing from parameters', 2);
if (publishedDoc && publishedDoc.script.version !== climate.CLIMATE_SCRIPT_VERSION) {
  console.log(`  warn  document was produced by ${publishedDoc.script.version}; this checkout is ${climate.CLIMATE_SCRIPT_VERSION}. Check out commit ${commit}.`);
}

console.log('2. Re-fetch public data (no cache)');
const fetched = [];
try {
  settlement.assertSettleable(params.window_end_ts ?? settlement.windowEndTs(params.window_end), new Date());
  for (const source of settlement.SOURCES) {
    for (const cell of params.grid_cells) {
      const f = await getSeries(source, cell, params.window_start, params.window_end, { useCache: false, allowMissing: true });
      fetched.push(f);
      console.log(`  got   ${source} cell ${cell}: ${f.series.daily.length} days`);
    }
  }
} catch (e) {
  console.log(`  cannot verify: ${e.message}`);
  process.exit(2);
}
const pick = (s) => fetched.filter((f) => f.series.source === s).map((f) => f.series);
const result = settlement.settleFromSeries(params, pick('open-meteo-archive'), pick('nasa-power'), { now: new Date(), scriptCommit: commit, allowReview: true });
result.data_hash === dataHash ? pass(`recomputed data_hash = ${result.data_hash}`) : fail(`recomputed data_hash = ${result.data_hash}, published ${dataHash}`);

if (result.data_hash !== dataHash && publishedDoc) {
  // Locate the difference.
  for (const side of ['primary', 'secondary']) {
    const theirs = publishedDoc[side];
    const ours = result.document[side];
    if (theirs.total_mm100 !== ours.total_mm100) console.log(`        ${side} total: published ${theirs.total_mm100}, recomputed ${ours.total_mm100} (mm100)`);
    ours.series.forEach((s, i) => {
      const t = theirs.series[i];
      if (!t) return;
      if (t.url !== s.url) console.log(`        ${side} cell ${s.grid_cell} url differs`);
      if (t.raw_sha256 !== s.raw_sha256) console.log(`        ${side} cell ${s.grid_cell} response hash differs: published ${t.raw_sha256.slice(0, 16)}.., now ${s.raw_sha256.slice(0, 16)}..`);
      const diffs = s.daily.filter((d, j) => t.daily[j]?.day !== d.day || t.daily[j]?.rain_mm100 !== d.rain_mm100);
      for (const d of diffs.slice(0, 10)) {
        const td = t.daily.find((x) => x.day === d.day);
        console.log(`        ${side} cell ${s.grid_cell} ${d.day}: published ${td?.rain_mm100 ?? 'absent'}, now ${d.rain_mm100}`);
      }
      if (diffs.length > 10) console.log(`        ... ${diffs.length - 10} more differing days`);
    });
  }
  if (JSON.stringify(publishedDoc.result) === JSON.stringify(result.document.result)) {
    console.log('        note: observed totals and outcome still agree; the difference is in the recorded series or metadata.');
  }
}

console.log('3. Outcome');
const expected = climate.outcomeFor(result.observed_mm10, params.thr_full_mm10, params.thr_half_mm10);
console.log(`  observed ${result.observed_mm10} mm10, thr_full ${params.thr_full_mm10}, thr_half ${params.thr_half_mm10} -> ${expected}`);
if (publishedDoc) {
  publishedDoc.result.outcome === expected ? pass(`published outcome ${publishedDoc.result.outcome}`) : fail(`published outcome ${publishedDoc.result.outcome}, rule gives ${expected}`);
  publishedDoc.result.observed_mm10 === result.observed_mm10 ? pass(`published observed ${publishedDoc.result.observed_mm10} mm10`) : fail(`published observed ${publishedDoc.result.observed_mm10}, recomputed ${result.observed_mm10}`);
}
if (a.outcome) (String(a.outcome).toUpperCase() === expected ? pass(`on-chain outcome ${a.outcome}`) : fail(`on-chain outcome ${a.outcome}, rule gives ${expected}`));
if (a.observed !== undefined) (Number(a.observed) === result.observed_mm10 ? pass(`on-chain observed ${a.observed}`) : fail(`on-chain observed ${a.observed}, recomputed ${result.observed_mm10}`));
if (result.review) console.log(`  note  this document carries review=true (${result.review_reasons.join('; ')}); it must have been settled with operator + auditor sign-off`);

console.log('');
console.log('Data: ' + Object.values(settlement.SOURCE_ATTRIBUTION).join(' | '));
console.log(ok ? 'VERIFIED: data_hash and outcome reproduce from public data.' : 'NOT VERIFIED: see FAIL lines above.');
process.exitCode = ok ? 0 : 1; // not process.exit(): on Windows it can abort in libuv while fetch sockets close
