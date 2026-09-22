// POST /api/cron/climate -- signed cron, daily 02:00 WIB (spec 2.5 A-D).
// Stores daily rainfall per grid cell and source, with the sha256 of the raw response.

import { json, requireCron } from '@/lib/auth';
import { query } from '@/lib/db';
import { addDays, fetchSeries, latestSettledDay, type FetchLike, type SourceId } from '@/lib/climate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  const auth = await requireCron(req);
  if (!auth.ok) return auth.res;
  const latest = latestSettledDay();
  const camps = await query<{ grid_cells: number[]; window_start: string; window_end: string }>(
    `select grid_cells, to_char(window_start,'YYYY-MM-DD') as window_start, to_char(window_end,'YYYY-MM-DD') as window_end
       from campaigns where status in ('open','settled','disputed') and pubkey is not null`,
  );
  const ranges = new Map<number, { start: string; end: string }>();
  for (const c of camps) {
    if (c.window_start > latest) continue;
    const end = c.window_end < latest ? c.window_end : latest;
    for (const cell of c.grid_cells.map(Number)) {
      const r = ranges.get(cell);
      ranges.set(cell, { start: r && r.start < c.window_start ? r.start : c.window_start, end: r && r.end > end ? r.end : end });
    }
  }
  const results: { grid_cell: number; source: SourceId; days: number; error?: string }[] = [];
  for (const [cell, r] of ranges) {
    for (const source of ['open-meteo-archive', 'nasa-power'] as const) {
      try {
        const s = await fetchSeries(source, cell, addDays(r.start, 0), r.end, fetch as unknown as FetchLike);
        for (const d of s.daily) {
          await query(
            `insert into climate_snapshots (grid_cell, source, day, rain_mm, rain_mm100, raw_sha256, fetched_at)
             values ($1,$2,$3,$4,$5,$6, now())
             on conflict (grid_cell, source, day) do update set rain_mm = excluded.rain_mm, rain_mm100 = excluded.rain_mm100,
               raw_sha256 = excluded.raw_sha256, fetched_at = now()`,
            [cell, source, d.day, d.rain_mm100 === null ? null : d.rain_mm100 / 100, d.rain_mm100, s.raw_sha256],
          );
        }
        results.push({ grid_cell: cell, source, days: s.daily.length });
      } catch (e) {
        results.push({ grid_cell: cell, source, days: 0, error: (e as Error).message });
      }
    }
  }
  return json({ latest_day: latest, results });
}