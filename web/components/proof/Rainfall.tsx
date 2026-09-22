import { getLocale, getTranslations } from 'next-intl/server';
import type { CampaignDetail } from '@/types/api';
import { formatDate, formatMm10 } from '../format';
import { GrowBar } from '../motion';

/**
 * Observed rainfall against thr_full and thr_half on one horizontal scale.
 * Threshold values prefer the on-chain account, then the settlement record.
 */
export async function Rainfall({ c }: { c: CampaignDetail }) {
  const t = await getTranslations('proof.rainfall');
  const tOut = await getTranslations('outcome');
  const locale = await getLocale();

  const thrFull = c.onchain?.thrFullMm10 ?? c.settlement?.thrFullMm10 ?? null;
  const thrHalf = c.onchain?.thrHalfMm10 ?? c.settlement?.thrHalfMm10 ?? null;
  const observed = c.settlement?.observedMm10 ?? null;
  const cumulative = c.rainfall?.points?.length ? c.rainfall.points[c.rainfall.points.length - 1]?.cumulativeMm10 ?? null : null;
  const median = c.rainfall?.medianMm10 ?? null;
  const shown = observed ?? cumulative;
  const outcome = c.settlement?.outcome ?? null;

  if (thrFull === null || thrHalf === null) {
    return <p className="text-sm text-muted">{t('empty')}</p>;
  }

  const max = Math.max(thrHalf, shown ?? 0, median ?? 0, 1) * 1.25;
  const pct = (v: number) => (v / max) * 100;

  return (
    <div>
      <div className="grid gap-px overflow-hidden rounded-panel border border-line bg-line sm:grid-cols-3">
        <div className="bg-raised p-4">
          <p className="text-xs text-muted">{observed !== null ? t('observed') : t('observedPending')}</p>
          <p className="numeric mt-1 text-2xl font-semibold">
            {observed !== null ? `${formatMm10(observed, locale)} ${t('unit')}` : <span className="text-faint">-</span>}
          </p>
          <p className="mt-1 text-xs font-medium text-accent">{outcome ? tOut(outcome) : tOut('pending')}</p>
        </div>
        <div className="bg-raised p-4">
          <p className="text-xs text-muted">{t('thrFull')}</p>
          <p className="numeric mt-1 text-2xl font-semibold">{formatMm10(thrFull, locale)} {t('unit')}</p>
          <p className="mt-1 font-mono text-[11px] text-faint">thr_full = {thrFull}</p>
        </div>
        <div className="bg-raised p-4">
          <p className="text-xs text-muted">{t('thrHalf')}</p>
          <p className="numeric mt-1 text-2xl font-semibold">{formatMm10(thrHalf, locale)} {t('unit')}</p>
          <p className="mt-1 font-mono text-[11px] text-faint">thr_half = {thrHalf}</p>
        </div>
      </div>

      <div className="mt-6" role="img" aria-label={`${t('observed')}: ${shown !== null ? formatMm10(shown, locale) : '-'} ${t('unit')}; ${t('thrFull')} ${formatMm10(thrFull, locale)}; ${t('thrHalf')} ${formatMm10(thrHalf, locale)}`}>
        <div className="relative h-10 rounded-md bg-sunken">
          <div className="absolute inset-y-0 left-0 rounded-l-md bg-accent/12" style={{ width: `${pct(thrFull)}%` }} />
          <div className="absolute inset-y-0 bg-accent/6" style={{ left: `${pct(thrFull)}%`, width: `${pct(thrHalf) - pct(thrFull)}%` }} />
          {shown !== null && <div className="absolute inset-y-3 left-0" style={{ width: `${pct(shown)}%` }}><GrowBar pct={100} className="h-4 rounded-sm bg-ink" /></div>}
          <Marker at={pct(thrFull)} label="thr_full" />
          <Marker at={pct(thrHalf)} label="thr_half" />
          {median !== null && <Marker at={pct(median)} label={t('median')} dashed />}
        </div>
      </div>

      <div className="mt-8 space-y-1 text-sm text-muted">
        {outcome === 'FULL' && <p>{t('outcomeFull')}</p>}
        {outcome === 'HALF' && <p>{t('outcomeHalf')}</p>}
        {outcome === 'NONE' && <p>{t('outcomeNone')}</p>}
        {!c.settlement && <p>{t('empty')}</p>}
        {c.settlement?.secondaryMm10 != null && (
          <p>{t('secondary')}: <span className="numeric">{formatMm10(c.settlement.secondaryMm10, locale)} {t('unit')}</span>
            {c.settlement.divergenceBp != null && <> · {t('divergence')}: <span className="numeric">{(c.settlement.divergenceBp / 100).toFixed(1)}%</span></>}
          </p>
        )}
        {c.rainfall && (
          <p className="text-xs text-faint">
            {t('source')}: {c.rainfall.sourceUrl ? <a className="underline underline-offset-2" href={c.rainfall.sourceUrl} target="_blank" rel="noreferrer">{c.rainfall.source}</a> : c.rainfall.source}
            {formatDate(c.rainfall.updatedAt, locale) && <> · {t('updated', { date: formatDate(c.rainfall.updatedAt, locale)! })}</>}
          </p>
        )}
      </div>
    </div>
  );
}

function Marker({ at, label, dashed }: { at: number; label: string; dashed?: boolean }) {
  return (
    <div className="absolute inset-y-0" style={{ left: `${at}%` }}>
      <div className={`h-full w-px ${dashed ? 'border-l border-dashed border-faint' : 'bg-accent'}`} />
      <span className="absolute left-0 top-full mt-1 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] text-faint">{label}</span>
    </div>
  );
}
