'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { addressToBytes } from '@/lib/chain/base58';
import { bytesToHex, hexToBytes, phoneHashAsync, receiptLeafAsync, rosterLeafAsync, verifyProofAsync } from '@/lib/merkle-verify';
import type { RosterProofResponse } from '@/types/api';
import { formatDate, formatIdr, isZeroHex } from './format';
import { fetchCampaignAccount } from './rpc';
import { buttonPrimary, buttonSecondary, inputClass } from './ui';

type Result =
  | { kind: 'match'; leaf: string; root: string; lockedAt: string | null; receipt: { ok: boolean; amountIdr: number; paidTs: number } | null }
  | { kind: 'noMatch' }
  | { kind: 'invalid'; root: string | null }
  | { kind: 'error'; message: 'notFound' | 'rateLimited' | 'failed' };

const E164 = /^\+[1-9]\d{7,14}$/;

export function CheckForm({ initialCode }: { initialCode: string }) {
  const t = useTranslations('check');
  const locale = useLocale();
  const reduce = useReducedMotion();
  const [code, setCode] = useState(initialCode);
  const [phone, setPhone] = useState('');
  const [proofCode, setProofCode] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const normPhone = phone.replace(/[\s-]/g, '');
    const next: Record<string, string> = {};
    if (!code.trim()) next.code = t('errors.required');
    if (!normPhone) next.phone = t('errors.required');
    else if (!E164.test(normPhone)) next.phone = t('errors.phoneFormat');
    if (!proofCode.trim()) next.proofCode = t('errors.required');
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/proof/roster', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim().toUpperCase(), phone: normPhone, proofCode: proofCode.trim().toUpperCase() }),
      });
      if (res.status === 404) return setResult({ kind: 'error', message: 'notFound' });
      if (res.status === 429) return setResult({ kind: 'error', message: 'rateLimited' });
      if (!res.ok) return setResult({ kind: 'error', message: 'failed' });
      const body = (await res.json()) as Partial<RosterProofResponse>;
      if (!body.found || !body.campaignPubkey || !body.saltHex || typeof body.plotCell !== 'number' || !Array.isArray(body.proof)) {
        return setResult({ kind: 'noMatch' });
      }

      // Root comes from the chain, never from the API response.
      const account = await fetchCampaignAccount(body.campaignPubkey, body.cluster ?? 'mainnet-beta');
      if (!account || isZeroHex(account.rosterRoot)) return setResult({ kind: 'invalid', root: null });

      const phoneHash = await phoneHashAsync(hexToBytes(body.saltHex), normPhone);
      const leaf = await rosterLeafAsync(addressToBytes(body.campaignPubkey), phoneHash, body.plotCell);
      const ok = await verifyProofAsync(leaf, body.proof.map(hexToBytes), hexToBytes(account.rosterRoot));
      if (!ok) return setResult({ kind: 'invalid', root: account.rosterRoot });

      let receipt: { ok: boolean; amountIdr: number; paidTs: number } | null = null;
      const r = body.receipt;
      if (r && !isZeroHex(account.receiptsRoot)) {
        const rl = await receiptLeafAsync(leaf, BigInt(r.amountIdr), hexToBytes(r.gatewayRefHash), BigInt(r.paidTs));
        const rok = await verifyProofAsync(rl, r.proof.map(hexToBytes), hexToBytes(account.receiptsRoot));
        receipt = { ok: rok, amountIdr: r.amountIdr, paidTs: r.paidTs };
      }
      setResult({ kind: 'match', leaf: bytesToHex(leaf), root: account.rosterRoot, lockedAt: body.lockedAt ?? null, receipt });
    } catch {
      setResult({ kind: 'error', message: 'failed' });
    } finally {
      setBusy(false);
    }
  };

  const field = (id: 'code' | 'phone' | 'proofCode', value: string, set: (v: string) => void, extra: { hint?: string; inputMode?: 'tel' | 'text'; autoComplete?: string }) => (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{t(`fields.${id}`)}</label>
      <input
        id={id}
        className={`${inputClass} ${id !== 'phone' ? 'font-mono uppercase' : ''}`}
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={t(`fields.${id}Placeholder`)}
        inputMode={extra.inputMode}
        autoComplete={extra.autoComplete ?? 'off'}
        aria-invalid={Boolean(errors[id])}
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className={`mt-1 text-xs ${errors[id] ? 'text-stop' : 'text-faint'}`}>{errors[id] ?? extra.hint ?? ''}</p>
    </div>
  );

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_1fr]">
      <form onSubmit={submit} className="space-y-4 rounded-panel border border-line bg-raised p-5 sm:p-6" noValidate>
        {field('code', code, setCode, {})}
        {field('phone', phone, setPhone, { hint: t('fields.phoneHint'), inputMode: 'tel', autoComplete: 'tel' })}
        {field('proofCode', proofCode, setProofCode, { hint: t('fields.proofCodeHint') })}
        <div className="flex gap-3 pt-2">
          <button type="submit" className={buttonPrimary} disabled={busy}>{busy ? t('actions.checking') : t('actions.submit')}</button>
          {result && <button type="button" className={buttonSecondary} onClick={() => { setResult(null); setPhone(''); setProofCode(''); }}>{t('actions.again')}</button>}
        </div>
      </form>

      <div aria-live="polite">
        <AnimatePresence mode="wait">
          {result && (
            <motion.div
              key={result.kind}
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className={`rounded-panel border p-5 sm:p-6 ${result.kind === 'match' ? 'border-live/50' : result.kind === 'invalid' ? 'border-stop/50' : 'border-line'}`}
            >
              {result.kind === 'match' && (
                <>
                  <p className="font-semibold text-live">{t('result.matchTitle')}</p>
                  <p className="mt-2 text-sm text-muted">{t('result.matchBody', { date: formatDate(result.lockedAt, locale) ?? '-' })}</p>
                  <dl className="mt-4 space-y-2 text-sm">
                    <div><dt className="text-xs text-faint">{t('result.leaf')}</dt><dd className="hashtext">{result.leaf}</dd></div>
                    <div><dt className="text-xs text-faint">{t('result.root')}</dt><dd className="hashtext">{result.root}</dd></div>
                  </dl>
                  <div className="mt-5 border-t border-line pt-4 text-sm">
                    <p className="font-medium">{t('result.receiptTitle')}</p>
                    <p className="mt-1 text-muted">
                      {result.receipt?.ok
                        ? t('result.receiptBody', { amount: formatIdr(result.receipt.amountIdr, locale) ?? '-', date: formatDate(result.receipt.paidTs, locale) ?? '-' })
                        : t('result.receiptPending')}
                    </p>
                  </div>
                </>
              )}
              {result.kind === 'noMatch' && (
                <>
                  <p className="font-semibold">{t('result.noMatchTitle')}</p>
                  <p className="mt-2 text-sm text-muted">{t('result.noMatchBody')}</p>
                </>
              )}
              {result.kind === 'invalid' && (
                <>
                  <p className="font-semibold text-stop">{t('result.invalidTitle')}</p>
                  <p className="mt-2 text-sm text-muted">{t('result.invalidBody')}</p>
                </>
              )}
              {result.kind === 'error' && <p className="text-sm text-stop">{t(`errors.${result.message}`)}</p>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
