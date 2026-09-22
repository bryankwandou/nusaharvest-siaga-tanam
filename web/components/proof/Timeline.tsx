'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import type { CampaignStatusName, SolanaCluster, TimelineEvent } from '@/types/api';
import { explorerUrl, formatDate } from '../format';

const MAIN: CampaignStatusName[] = ['OPEN', 'SETTLED', 'DISPUTED', 'SETTLED_FINAL', 'RELEASED', 'RECEIPTED'];

export function Timeline({ status, events, cluster }: { status: CampaignStatusName; events: TimelineEvent[]; cluster: SolanaCluster }) {
  const t = useTranslations();
  const locale = useLocale();
  const reduce = useReducedMotion();
  const steps: CampaignStatusName[] = status === 'REFUNDED' ? ['OPEN', 'REFUNDED'] : MAIN;
  const byStatus = new Map<CampaignStatusName, TimelineEvent>();
  for (const e of Array.isArray(events) ? events : []) if (e && typeof e.status === 'string') byStatus.set(e.status, e);

  return (
    <ol className="relative">
      {steps.map((s, i) => {
        const ev = byStatus.get(s);
        const current = s === status;
        const done = current || s === 'OPEN' || Boolean(ev?.at);
        const date = formatDate(ev?.at ?? null, locale, true);
        return (
          <motion.li
            key={s}
            className="relative flex gap-4 pb-7 last:pb-0"
            initial={reduce ? false : { opacity: 0, x: -6 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.35, delay: reduce ? 0 : i * 0.06 }}
          >
            {i < steps.length - 1 && (
              <span aria-hidden className={`absolute left-[7px] top-5 h-[calc(100%-12px)] w-px ${done ? 'bg-accent/50' : 'bg-line'}`} />
            )}
            <span
              aria-hidden
              className={`relative mt-1 grid size-[15px] shrink-0 place-items-center rounded-full border ${
                current ? 'border-accent bg-accent' : done ? 'border-accent bg-accent-soft' : 'border-line-strong bg-raised'
              }`}
            >
              {current && !reduce && (
                <motion.span
                  className="absolute inset-0 rounded-full border border-accent"
                  animate={{ scale: [1, 1.9], opacity: [0.6, 0] }}
                  transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
                />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <p className={`font-medium ${done ? 'text-ink' : 'text-faint'}`}>{t(`status.${s}.name`)}</p>
                <code className="text-[11px] text-faint">{s}</code>
                {current && <span className="text-xs font-medium text-accent">{t('proof.timeline.current')}</span>}
              </div>
              <p className={`mt-1 text-sm ${done ? 'text-muted' : 'text-faint'}`}>{t(`status.${s}.body`)}</p>
              <p className="mt-1 text-xs text-faint">
                {done ? (date ?? (s === 'OPEN' ? '' : t('common.dateUnknown'))) : t('proof.timeline.pending')}
                {ev?.txSignature && (
                  <>
                    {date ? ' · ' : ''}
                    <a className="underline decoration-line-strong underline-offset-2 hover:text-ink" href={explorerUrl('tx', ev.txSignature, cluster)} target="_blank" rel="noreferrer">
                      {t('proof.timeline.viewTx')}
                    </a>
                  </>
                )}
              </p>
            </div>
          </motion.li>
        );
      })}
    </ol>
  );
}
