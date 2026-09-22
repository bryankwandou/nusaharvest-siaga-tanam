'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { sha256HexOfBytes } from '@/lib/merkle-verify';
import { buttonSecondary } from '../ui';

type State = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; computed: string; match: boolean } | { kind: 'failed' };

export function Reproduce({ url, expected }: { url: string | null; expected: string | null }) {
  const t = useTranslations('proof.reproduce');
  const [state, setState] = useState<State>({ kind: 'idle' });

  const run = async () => {
    if (!url || !expected) return;
    setState({ kind: 'running' });
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const bytes = new Uint8Array(await res.arrayBuffer());
      const computed = await sha256HexOfBytes(bytes);
      setState({ kind: 'done', computed, match: computed.toLowerCase() === expected.toLowerCase() });
    } catch {
      setState({ kind: 'failed' });
    }
  };

  return (
    <div className="rounded-panel border border-line bg-raised p-5 sm:p-6">
      <h3 className="font-semibold">{t('title')}</h3>
      <p className="mt-2 text-sm text-muted">{t('body')}</p>
      {!url || !expected ? (
        <p className="mt-4 text-sm text-faint">{t('unavailable')}</p>
      ) : (
        <button type="button" className={`${buttonSecondary} mt-4`} onClick={run} disabled={state.kind === 'running'}>
          {state.kind === 'running' ? t('running') : t('action')}
        </button>
      )}
      <AnimatePresence mode="wait">
        {state.kind === 'done' && (
          <motion.div key="done" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-4 space-y-2 text-sm" role="status">
            <p className={state.match ? 'font-medium text-live' : 'font-medium text-stop'}>{state.match ? t('match') : t('mismatch')}</p>
            <p className="text-muted">{t('computed')}: <span className="hashtext">{state.computed}</span></p>
            <p className="text-muted">{t('onchain')}: <span className="hashtext">{expected}</span></p>
          </motion.div>
        )}
        {state.kind === 'failed' && (
          <motion.p key="failed" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-4 text-sm text-stop" role="status">
            {t('failed')}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
