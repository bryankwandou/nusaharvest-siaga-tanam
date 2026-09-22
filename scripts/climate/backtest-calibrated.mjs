// Calibrated seasonal-window triggers on real ERA5 data (Open-Meteo historical API).
// Drought: rainfall total over the planting-onset window (1 Oct - 31 Dec) below the 1991-2020 20th percentile.
// Flood check: largest 3-day rainfall around the Feb-Mar 2024 Demak floods, versus that site's 1991-2020 distribution.
import { writeFileSync } from 'node:fs';

const SITES = [
  { id: 'klaten', name: 'Klaten', lat: -7.7078, lon: 110.6101 },
  { id: 'grobogan', name: 'Grobogan', lat: -7.09, lon: 110.92 },
  { id: 'kupang', name: 'Kupang', lat: -10.17, lon: 123.61 },
  { id: 'demak', name: 'Demak', lat: -6.89, lon: 110.64 },
];
const q = (s, p) => { const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };

async function daily(site) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${site.lat}&longitude=${site.lon}&start_date=1991-01-01&end_date=2025-12-31&daily=precipitation_sum&timezone=Asia%2FJakarta`;
  const j = await (await fetch(url)).json();
  return j.daily.time.map((t, i) => ({ t, y: +t.slice(0, 4), m: +t.slice(5, 7), p: j.daily.precipitation_sum[i] ?? 0 }));
}

const out = [];
for (const s of SITES) {
  const d = await daily(s);
  const onset = {};
  d.forEach(r => { if (r.m >= 10) onset[r.y] = (onset[r.y] ?? 0) + r.p; });
  const base = Object.entries(onset).filter(([y]) => +y >= 1991 && +y <= 2020).map(([, v]) => v).sort((a, b) => a - b);
  const p20 = q(base, 0.2), p50 = q(base, 0.5);
  const hits = Object.entries(onset).filter(([y, v]) => +y >= 2001 && +y <= 2025 && v < p20).map(([y, v]) => ({ year: +y, mm: Math.round(v) }));
  // 3-day maxima
  const r3 = d.map((r, i) => i >= 2 ? { t: r.t, y: r.y, v: d[i].p + d[i - 1].p + d[i - 2].p } : null).filter(Boolean);
  const base3 = r3.filter(r => r.y >= 1991 && r.y <= 2020).map(r => r.v).sort((a, b) => a - b);
  const feb_mar_2024 = r3.filter(r => r.t >= '2024-02-01' && r.t <= '2024-03-31').sort((a, b) => b.v - a.v)[0];
  const rankPct = feb_mar_2024 ? (base3.filter(v => v <= feb_mar_2024.v).length / base3.length) * 100 : null;
  out.push({ site: s.name, onset_window: 'Oct 1 - Dec 31', p20_mm: Math.round(p20), median_mm: Math.round(p50), drought_hits_2001_2025: hits, hit_count: hits.length,
    max_3day_rain_feb_mar_2024: feb_mar_2024 ? { date_end: feb_mar_2024.t, mm: Math.round(feb_mar_2024.v), percentile_vs_1991_2020_daily_windows: +rankPct.toFixed(2) } : null });
}
writeFileSync(new URL('./backtest-calibrated.json', import.meta.url), JSON.stringify({ source: 'Open-Meteo Historical Weather API (ERA5 / ERA5-Land)', generated: new Date().toISOString(), results: out }, null, 2));
console.log(JSON.stringify(out, null, 2));
