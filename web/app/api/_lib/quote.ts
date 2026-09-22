// Quote computation shared by /api/campaigns/quote and /api/campaigns (server recomputes thresholds).

import type { QuoteResponse } from '@/types/api';
import { one } from '@/lib/db';
import { quote, type FetchLike } from '@/lib/climate';

export async function regionCells(regency: string, province: string): Promise<number[] | null> {
  const r = await one<{ grid_cells: number[] }>(
    'select grid_cells from regions where lower(regency) = lower($1) and lower(province) = lower($2)',
    [regency, province],
  );
  return r ? r.grid_cells.map(Number) : null;
}

export async function computeQuote(b: { regency: string; province: string; windowStartDate: string; windowEndDate: string; amountFullIdr: number; amountHalfIdr: number; unitsMax: number }): Promise<QuoteResponse | null> {
  const cells = await regionCells(b.regency, b.province);
  if (!cells) return null;
  const q = await quote(
    { grid_cells: cells, window_start: b.windowStartDate, window_end: b.windowEndDate, amount_full_idr: b.amountFullIdr, amount_half_idr: b.amountHalfIdr, units_max: b.unitsMax },
    fetch as unknown as FetchLike,
  );
  return {
    gridCells: cells,
    thrFullMm10: q.thresholds.thr_full_mm10,
    thrHalfMm10: q.thresholds.thr_half_mm10,
    medianMm10: Math.floor(q.thresholds.median_mm100 / 10),
    baselineYears: q.thresholds.baseline_years,
    latestDay: q.latest_day,
    sources: q.sources.map((s) => ({ url: s.url, rawSha256: s.raw_sha256 })),
    backtest: {
      years: q.backtest.years.map((y) => ({ seasonYear: y.season_year, totalMm10: y.total_mm10, outcome: y.outcome, costPerUnitIdr: y.cost_per_unit_idr })),
      fullCount: q.backtest.full_count,
      halfCount: q.backtest.half_count,
      noneCount: q.backtest.none_count,
      missingCount: q.backtest.missing_count,
      totalCostPerUnitIdr: q.backtest.total_cost_per_unit_idr,
      totalCostUnitsMaxIdr: q.backtest.total_cost_units_max_idr,
    },
  };
}
