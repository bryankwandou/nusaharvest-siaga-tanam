#!/usr/bin/env node
// Settle one campaign off-chain: fetch both sources for the window, build the canonical JSON snapshot,
// compute data_hash and print the outcome. Same code path as the cron endpoint (web/lib/settlement.ts).
//
//   node scripts/climate/settle.mjs --campaign path/to/campaign.json [--now 2026-01-20T00:00:00Z] [--commit <sha>] [--no-cache] [--out <dir>]
//
// campaign.json: { code, pubkey, grid_cells[], window_start, window_end, thr_full_mm10, thr_half_mm10, window_end_ts? }
//
// Exit codes: 0 settled, 2 refused (too early / missing data / fetch failure), 3 sources diverge (REVIEW).
// Output: research-out/settlements/<code>.json (canonical document, byte-exact, the file that gets published)
//         research-out/settlements/<code>.manifest.json (hash, outcome, fetch hashes, attribution)
import { args, climate, settlement, getSeries, writeJson, die, gitCommit, OUT } from './_common.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const a = args();
if (!a.campaign) die('need --campaign <file.json>');
const campaign = JSON.parse(readFileSync(a.campaign, 'utf8'));
const now = a.now ? new Date(a.now) : new Date();
if (Number.isNaN(now.getTime())) die('bad --now');
const commit = a.commit ?? gitCommit();
if (!/^[0-9a-f]{40}$/.test(commit) && !a['allow-uncommitted']) {
  die(
    `script commit is "${commit}". A settlement must name a clean git commit so a third party can check out the same code. ` +
      'Commit web/lib and scripts first, or pass --commit <sha>; --allow-uncommitted is for dry runs only.',
    2,
  );
}
const endTs = campaign.window_end_ts ?? settlement.windowEndTs(campaign.window_end);

console.log(`campaign ${campaign.code}  cells ${campaign.grid_cells.join(',')}  window ${campaign.window_start}..${campaign.window_end}`);
console.log(`thresholds  full <= ${campaign.thr_full_mm10} mm10  half <= ${campaign.thr_half_mm10} mm10  commit ${commit}`);

const dir = a.out ? String(a.out) : join(OUT, 'settlements');
mkdirSync(dir, { recursive: true });

function emit(result, fetched, status) {
  const docPath = join(dir, `${campaign.code}${status === 'SETTLED' ? '' : '.review'}.json`);
  writeFileSync(docPath, result.json); // byte-exact canonical JSON, no trailing newline
  writeJson(join(dir, `${campaign.code}${status === 'SETTLED' ? '' : '.review'}.manifest.json`), {
    status,
    data_hash: result.data_hash,
    outcome: result.outcome,
    observed_mm10: result.observed_mm10,
    secondary_mm10: result.secondary_mm10,
    divergence_bp: result.divergence_bp,
    review_reasons: result.review_reasons,
    script_commit: commit,
    settled_at: now.toISOString(),
    fetches: fetched.map((f) => ({ source: f.series.source, grid_cell: f.series.grid_cell, url: f.series.url, body_sha256: f.body_sha256, normalized_sha256: f.series.raw_sha256 })),
    attribution: settlement.SOURCE_ATTRIBUTION,
    document: docPath,
  });
  return docPath;
}

try {
  // Lag check happens before any network call.
  settlement.assertSettleable(endTs, now);
  const fetched = [];
  for (const source of settlement.SOURCES) {
    for (const cell of campaign.grid_cells) {
      fetched.push(await getSeries(source, cell, campaign.window_start, campaign.window_end, { useCache: !a['no-cache'], allowMissing: true }));
    }
  }
  const pick = (s) => fetched.filter((f) => f.series.source === s).map((f) => f.series);
  let result;
  try {
    result = settlement.settleFromSeries(campaign, pick('open-meteo-archive'), pick('nasa-power'), { now, scriptCommit: commit });
  } catch (e) {
    if (e instanceof settlement.SettlementRefused && e.result) {
      const p = emit(e.result, fetched, 'REVIEW');
      console.error(`REFUSED (${e.code}): ${e.message}`);
      console.error(`review snapshot (NOT for on-chain settle): ${p}`);
      console.error(`  data_hash ${e.result.data_hash}  primary ${e.result.observed_mm10} mm10  secondary ${e.result.secondary_mm10} mm10  divergence ${e.result.divergence_bp} bp`);
      process.exit(e.code === 'DIVERGENCE' ? 3 : 2);
    }
    throw e;
  }
  const p = emit(result, fetched, 'SETTLED');
  console.log(`observed    ${result.observed_mm10} mm10 (${(result.observed_mm10 / 10).toFixed(1)} mm) open-meteo-archive`);
  console.log(`secondary   ${result.secondary_mm10} mm10 (${(result.secondary_mm10 / 10).toFixed(1)} mm) nasa-power, divergence ${result.divergence_bp} bp (limit ${climate.REVIEW_DIVERGENCE_BP})`);
  console.log(`data_hash   ${result.data_hash}`);
  console.log(`document    ${p}`);
  console.log(`OUTCOME     ${result.outcome}`);
} catch (e) {
  if (e instanceof settlement.SettlementRefused) {
    console.error(`REFUSED (${e.code}): ${e.message}`);
    process.exit(2);
  }
  throw e;
}
