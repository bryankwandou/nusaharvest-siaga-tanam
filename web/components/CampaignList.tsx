'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { CAMPAIGN_STATUS_NAMES } from '@/lib/chain/layout';
import type { CampaignStatusName, CampaignSummary } from '@/types/api';
import { formatDate, formatIdr, formatInt, formatToken } from './format';
import { EmptyState, StatusBadge, inputClass } from './ui';

export function CampaignList({ campaigns }: { campaigns: CampaignSummary[] }) {
  const t = useTranslations();
  const locale = useLocale();
  const reduce = useReducedMotion();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<CampaignStatusName | 'ALL'>('ALL');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return campaigns.filter((c) => {
      if (status !== 'ALL' && c.status !== status) return false;
      if (!needle) return true;
      return [c.code, c.sponsorName, c.area?.regency, c.area?.province].some((s) => typeof s === 'string' && s.toLowerCase().includes(needle));
    });
  }, [campaigns, q, status]);

  if (campaigns.length === 0) return <EmptyState title={t('campaigns.empty.title')} body={t('campaigns.empty.body')} />;

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className="mb-1.5 block text-xs text-muted">{t('campaigns.filters.search')}</span>
          <input className={inputClass} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('campaigns.filters.searchPlaceholder')} />
        </label>
        <label className="sm:w-56">
          <span className="mb-1.5 block text-xs text-muted">{t('campaigns.filters.status')}</span>
          <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value as CampaignStatusName | 'ALL')}>
            <option value="ALL">{t('campaigns.filters.all')}</option>
            {CAMPAIGN_STATUS_NAMES.map((s) => (
              <option key={s} value={s}>{t(`status.${s}.name`)}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-4 text-sm text-faint" aria-live="polite">{t('campaigns.count', { count: filtered.length })}</p>

      {filtered.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title={t('campaigns.emptyFiltered.title')}
            body={t('campaigns.emptyFiltered.body')}
            action={<button type="button" className="text-sm underline underline-offset-2" onClick={() => { setQ(''); setStatus('ALL'); }}>{t('campaigns.filters.clear')}</button>}
          />
        </div>
      ) : (
        <ul className="mt-6 grid gap-4 md:grid-cols-2">
          <AnimatePresence initial={!reduce}>
            {filtered.map((c, i) => (
              <motion.li
                key={c.code}
                layout={!reduce}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, delay: reduce ? 0 : Math.min(i, 8) * 0.04 }}
              >
                <Link href={`/campaigns/${encodeURIComponent(c.code)}`} className="group block h-full rounded-panel border border-line bg-raised p-5 transition-[border-color,transform] hover:-translate-y-0.5 hover:border-line-strong">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-sm">{c.code}</span>
                    <StatusBadge status={c.status} label={t(`status.${c.status}.name`)} />
                  </div>
                  <p className="mt-3 font-semibold">{[c.area?.regency, c.area?.province].filter(Boolean).join(', ')}</p>
                  <p className="text-sm text-muted">{c.sponsorName} · {c.commodity}</p>
                  {(c.historicalReplay || c.mode === 'pledge') && (
                    <p className="mt-2 flex flex-wrap gap-2 text-xs">
                      {c.historicalReplay && <span className="rounded border border-warn/40 px-1.5 py-0.5 text-warn">{t('proof.labels.replay')}</span>}
                      {c.mode === 'pledge' && <span className="rounded border border-warn/40 px-1.5 py-0.5 text-warn">{t('proof.labels.pledge')}</span>}
                    </p>
                  )}
                  <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                    <div><dt className="text-xs text-faint">{t('campaigns.card.recipients')}</dt><dd className="numeric">{formatInt(c.unitsLocked, locale) ?? '-'}{c.unitsMax ? <span className="text-faint"> / {formatInt(c.unitsMax, locale)}</span> : null}</dd></div>
                    <div><dt className="text-xs text-faint">{t('campaigns.card.locked')}</dt><dd className="numeric">{c.mode === 'pledge' ? '-' : formatToken(c.lockedAmount, locale) ?? '-'}</dd></div>
                    <div><dt className="text-xs text-faint">{t('campaigns.card.perHousehold')}</dt><dd className="numeric">{formatIdr(c.amountFullIdr, locale) ?? '-'}</dd></div>
                    <div><dt className="text-xs text-faint">{t('campaigns.card.windowEnds')}</dt><dd className="numeric">{formatDate(c.windowEndDate, locale) ?? '-'}</dd></div>
                  </dl>
                  <p className="mt-5 text-sm text-accent">{t('campaigns.card.open')} <span aria-hidden className="inline-block transition-transform group-hover:translate-x-0.5">&rarr;</span></p>
                </Link>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}
