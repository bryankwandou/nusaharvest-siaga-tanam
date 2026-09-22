'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SolanaCluster } from '@/types/api';
import { explorerUrl, isZeroHex } from '../format';

export function HashRow({ label, value, kind = 'hash', cluster }: { label: string; value: string | null; kind?: 'hash' | 'address'; cluster?: SolanaCluster }) {
  const t = useTranslations('proof.onchain');
  const [copied, setCopied] = useState(false);
  const empty = !value || (kind === 'hash' && isZeroHex(value));

  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="grid gap-1 border-t border-line py-3 first:border-t-0 sm:grid-cols-[160px_1fr_auto] sm:items-center sm:gap-4">
      <dt className={`text-sm text-muted ${kind === 'hash' ? 'font-mono' : ''}`}>{label}</dt>
      <dd className={`hashtext ${empty ? 'text-faint' : 'text-ink'}`}>
        {empty ? t('notSet') : kind === 'address' && cluster ? (
          <a href={explorerUrl('address', value!, cluster)} target="_blank" rel="noreferrer" className="hover:underline" title={t('explorer')}>
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
      {!empty && (
        <dd>
          <button type="button" onClick={copy} className="text-xs text-muted hover:text-ink" aria-live="polite">
            {copied ? t('copied') : t('copy')}
          </button>
        </dd>
      )}
    </div>
  );
}
