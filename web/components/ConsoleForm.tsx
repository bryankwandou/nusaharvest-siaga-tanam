'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import type { CampaignMode, CreateCampaignRequest, CreateCampaignResponse, QuoteRequest, QuoteResponse } from '@/types/api';
import { formatIdr, formatMm10 } from './format';
import { buttonPrimary, buttonSecondary, inputClass } from './ui';

type Form = {
  sponsorName: string;
  contactEmail: string;
  mode: CampaignMode;
  sponsorWallet: string;
  province: string;
  regency: string;
  commodity: 'riceRainfed' | 'maizeDryland';
  windowStartDate: string;
  windowEndDate: string;
  amountFullIdr: string;
  amountHalfIdr: string;
  unitsMax: string;
};

const EMPTY: Form = {
  sponsorName: '', contactEmail: '', mode: 'escrow', sponsorWallet: '', province: '', regency: '',
  commodity: 'riceRainfed', windowStartDate: '', windowEndDate: '', amountFullIdr: '', amountHalfIdr: '', unitsMax: '',
};

const COMMODITY_ID = { riceRainfed: 'rice_rainfed_early', maizeDryland: 'maize_dryland' } as const;

export function ConsoleForm() {
  const t = useTranslations('console');
  const locale = useLocale();
  const reduce = useReducedMotion();
  const [f, setF] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Form | 'form', string>>>({});
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateCampaignResponse | null>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setF((p) => ({ ...p, [k]: v }));
    if (k !== 'sponsorName' && k !== 'contactEmail' && k !== 'sponsorWallet' && k !== 'mode') setQuote(null);
  };

  const quoteReq = (): QuoteRequest => ({
    regency: f.regency.trim(), province: f.province.trim(), commodity: COMMODITY_ID[f.commodity],
    windowStartDate: f.windowStartDate, windowEndDate: f.windowEndDate,
    amountFullIdr: Number(f.amountFullIdr), amountHalfIdr: Number(f.amountHalfIdr), unitsMax: Number(f.unitsMax),
  });

  const validateQuote = () => {
    const e: typeof errors = {};
    for (const k of ['province', 'regency', 'windowStartDate', 'windowEndDate', 'amountFullIdr', 'amountHalfIdr', 'unitsMax'] as const) if (!f[k].trim()) e[k] = t('errors.required');
    if (f.windowStartDate && f.windowEndDate && f.windowEndDate <= f.windowStartDate) e.windowEndDate = t('errors.windowOrder');
    const full = Number(f.amountFullIdr), half = Number(f.amountHalfIdr), units = Number(f.unitsMax);
    if (f.amountFullIdr && !(full > 0)) e.amountFullIdr = t('errors.amountPositive');
    if (f.amountHalfIdr && !(half > 0)) e.amountHalfIdr = t('errors.amountPositive');
    if (full > 0 && half > full) e.amountHalfIdr = t('errors.amountOrder');
    if (f.unitsMax && !(Number.isInteger(units) && units > 0)) e.unitsMax = t('errors.unitsPositive');
    return e;
  };

  const getQuote = async () => {
    const e = validateQuote();
    setErrors(e);
    if (Object.keys(e).length) return;
    setQuoting(true);
    setQuote(null);
    try {
      const res = await fetch('/api/campaigns/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(quoteReq()) });
      if (!res.ok) throw new Error();
      const body = (await res.json()) as QuoteResponse;
      if (typeof body?.thrFullMm10 !== 'number' || !Array.isArray(body?.backtest?.years)) throw new Error();
      setQuote(body);
    } catch {
      setErrors({ form: t('errors.quoteFailed') });
    } finally {
      setQuoting(false);
    }
  };

  const create = async (ev: FormEvent) => {
    ev.preventDefault();
    const e = validateQuote();
    if (!f.sponsorName.trim()) e.sponsorName = t('errors.required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.contactEmail)) e.contactEmail = f.contactEmail ? t('errors.email') : t('errors.required');
    if (f.mode === 'escrow' && !f.sponsorWallet.trim()) e.sponsorWallet = t('errors.walletRequired');
    setErrors(e);
    if (Object.keys(e).length || !quote) return;
    setCreating(true);
    try {
      const payload: CreateCampaignRequest = {
        ...quoteReq(), sponsorName: f.sponsorName.trim(), contactEmail: f.contactEmail.trim(), mode: f.mode,
        sponsorWallet: f.mode === 'escrow' ? f.sponsorWallet.trim() : null,
      };
      const res = await fetch('/api/campaigns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error();
      const body = (await res.json()) as CreateCampaignResponse;
      if (typeof body?.code !== 'string') throw new Error();
      setCreated(body);
    } catch {
      setErrors({ form: t('errors.createFailed') });
    } finally {
      setCreating(false);
    }
  };

  const input = (k: keyof Form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, hint?: string) => (
    <div>
      <label htmlFor={k} className="mb-1.5 block text-sm font-medium">{label}</label>
      <input id={k} className={inputClass} value={f[k]} onChange={(e) => set(k, e.target.value as never)} aria-invalid={Boolean(errors[k])} aria-describedby={`${k}-hint`} {...props} />
      <p id={`${k}-hint`} className={`mt-1 min-h-4 text-xs ${errors[k] ? 'text-stop' : 'text-faint'}`}>{errors[k] ?? hint ?? ''}</p>
    </div>
  );

  if (created) {
    return (
      <motion.div initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-panel border border-live/50 bg-raised p-6">
        <p className="font-semibold text-live">{t('result.title')}</p>
        <dl className="mt-4 space-y-3 text-sm">
          <div><dt className="text-xs text-faint">{t('result.code')}</dt><dd className="font-mono">{created.code}</dd></div>
          <div><dt className="text-xs text-faint">{t('result.termsHash')}</dt><dd className="hashtext">{created.termsHash}</dd></div>
          {created.transactionBase64 && <div><dd className="text-muted">{t('result.signNow')}</dd></div>}
          {created.nextStep && <div><dt className="text-xs text-faint">{t('result.nextStep')}</dt><dd className="text-muted">{created.nextStep}</dd></div>}
        </dl>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href={`/campaigns/${encodeURIComponent(created.code)}`} className={buttonPrimary}>{t('result.openRecord')}</Link>
          <button type="button" className={buttonSecondary} onClick={() => { setCreated(null); setQuote(null); setF(EMPTY); }}>{t('actions.reset')}</button>
        </div>
      </motion.div>
    );
  }

  return (
    <form onSubmit={create} noValidate className="grid gap-10 lg:grid-cols-[1fr_1fr]">
      <div className="space-y-10">
        <Group title={t('sections.coverage')} n={1}>
          <div className="grid gap-x-4 sm:grid-cols-2">
            {input('province', t('fields.province'), { autoComplete: 'address-level1' })}
            {input('regency', t('fields.regency'), { autoComplete: 'address-level2' })}
          </div>
          <div>
            <label htmlFor="commodity" className="mb-1.5 block text-sm font-medium">{t('fields.commodity')}</label>
            <select id="commodity" className={inputClass} value={f.commodity} onChange={(e) => set('commodity', e.target.value as Form['commodity'])}>
              <option value="riceRainfed">{t('fields.commodityOptions.riceRainfed')}</option>
              <option value="maizeDryland">{t('fields.commodityOptions.maizeDryland')}</option>
            </select>
          </div>
          <div className="mt-4 grid gap-x-4 sm:grid-cols-2">
            {input('windowStartDate', t('fields.windowStart'), { type: 'date' })}
            {input('windowEndDate', t('fields.windowEnd'), { type: 'date' })}
          </div>
          <p className="text-xs text-faint">{t('fields.windowHint')}</p>
        </Group>

        <Group title={t('sections.amounts')} n={2}>
          <div className="grid gap-x-4 sm:grid-cols-2">
            {input('amountFullIdr', t('fields.amountFull'), { inputMode: 'numeric', type: 'number', min: 1, step: 1000 })}
            {input('amountHalfIdr', t('fields.amountHalf'), { inputMode: 'numeric', type: 'number', min: 1, step: 1000 })}
          </div>
          {input('unitsMax', t('fields.unitsMax'), { inputMode: 'numeric', type: 'number', min: 1, step: 1 }, t('fields.amountHint'))}
          <button type="button" className={buttonSecondary} onClick={getQuote} disabled={quoting}>
            {quoting ? t('quote.pending') : quote ? t('actions.recompute') : t('actions.getQuote')}
          </button>
        </Group>

        <Group title={t('sections.sponsor')} n={3}>
          {input('sponsorName', t('fields.sponsorName'), { autoComplete: 'organization' }, t('fields.sponsorNameHint'))}
          {input('contactEmail', t('fields.contactEmail'), { type: 'email', autoComplete: 'email' }, t('fields.contactEmailHint'))}
          <fieldset>
            <legend className="mb-2 text-sm font-medium">{t('fields.mode')}</legend>
            <div className="grid gap-2">
              {(['escrow', 'pledge'] as const).map((m) => (
                <label key={m} className={`cursor-pointer rounded-card border p-3 transition-colors ${f.mode === m ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong'}`}>
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <input type="radio" name="mode" value={m} checked={f.mode === m} onChange={() => set('mode', m)} className="accent-[var(--accent)]" />
                    {m === 'escrow' ? t('fields.modeEscrow') : t('fields.modePledge')}
                  </span>
                  <span className="mt-1 block pl-6 text-xs text-muted">{m === 'escrow' ? t('fields.modeEscrowHint') : t('fields.modePledgeHint')}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {f.mode === 'escrow' && input('sponsorWallet', t('fields.wallet'), { className: `${inputClass} font-mono text-sm`, spellCheck: false, autoComplete: 'off' }, t('fields.walletHint'))}
        </Group>
      </div>

      <div className="lg:sticky lg:top-20 lg:self-start">
        <div className="rounded-panel border border-line bg-raised p-5 sm:p-6">
          <h2 className="font-semibold">{t('sections.quote')}</h2>
          <AnimatePresence mode="wait">
            {quote ? (
              <motion.div key="q" initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <QuoteView q={quote} locale={locale} />
              </motion.div>
            ) : (
              <motion.p key="e" initial={false} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-3 text-sm text-muted">
                {quoting ? t('quote.pending') : t('quote.empty')}
              </motion.p>
            )}
          </AnimatePresence>
          {errors.form && <p className="mt-4 text-sm text-stop" role="alert">{errors.form}</p>}
          <div className="mt-6 border-t border-line pt-5">
            <button type="submit" className={`${buttonPrimary} w-full`} disabled={!quote || creating}>
              {creating ? t('actions.creating') : t('actions.create')}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}

function Group({ title, n, children }: { title: string; n: number; children: ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-4 flex items-center gap-3 text-lg font-semibold">
        <span className="grid size-6 place-items-center rounded-full border border-line-strong font-mono text-xs text-muted">{n}</span>
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function QuoteView({ q, locale }: { q: QuoteResponse; locale: string }) {
  const t = useTranslations('console.quote');
  const tOut = useTranslations('outcome');
  const years = q.backtest.years;
  const max = Math.max(1, ...years.map((y) => y.totalMm10 ?? 0), q.thrHalfMm10);
  const mm = (v: number) => `${formatMm10(v, locale)} mm`;
  return (
    <div className="mt-4 space-y-5 text-sm">
      <dl className="grid grid-cols-2 gap-3">
        <div><dt className="text-xs text-faint">{t('thrFull')}</dt><dd className="numeric font-semibold">{mm(q.thrFullMm10)}</dd></div>
        <div><dt className="text-xs text-faint">{t('thrHalf')}</dt><dd className="numeric font-semibold">{mm(q.thrHalfMm10)}</dd></div>
        <div><dt className="text-xs text-faint">{t('median')}</dt><dd className="numeric">{mm(q.medianMm10)}</dd></div>
        <div><dt className="text-xs text-faint">{t('latestDay')}</dt><dd className="numeric">{q.latestDay}</dd></div>
      </dl>
      <div>
        <p className="font-medium">{t('backtestTitle')}</p>
        <p className="mt-1 text-xs text-muted">{t('backtestLede')}</p>
        <div className="mt-3 flex h-28 items-end gap-[2px]" role="img" aria-label={t('backtestTitle')}>
          {years.map((y) => (
            <div key={y.seasonYear} className="group relative flex h-full flex-1 items-end" title={`${y.seasonYear}: ${y.totalMm10 === null ? t('missing') : mm(y.totalMm10)} · ${y.outcome ? tOut(y.outcome) : t('missing')}`}>
              <div
                className={`w-full rounded-t-[2px] ${y.outcome === 'FULL' ? 'bg-stop' : y.outcome === 'HALF' ? 'bg-warn' : y.outcome === 'NONE' ? 'bg-line-strong' : 'bg-transparent border border-dashed border-line'}`}
                style={{ height: `${y.totalMm10 === null ? 100 : Math.max(2, (y.totalMm10 / max) * 100)}%` }}
              />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-faint">
          <span>{years[0]?.seasonYear}</span><span>{years[years.length - 1]?.seasonYear}</span>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div><dt className="text-xs text-faint">{t('full')}</dt><dd className="numeric text-stop">{q.backtest.fullCount}</dd></div>
        <div><dt className="text-xs text-faint">{t('half')}</dt><dd className="numeric text-warn">{q.backtest.halfCount}</dd></div>
        <div><dt className="text-xs text-faint">{t('none')}</dt><dd className="numeric">{q.backtest.noneCount}</dd></div>
        <div><dt className="text-xs text-faint">{t('missing')}</dt><dd className="numeric">{q.backtest.missingCount}</dd></div>
      </dl>
      <dl className="space-y-2">
        <div className="flex justify-between gap-3"><dt className="text-muted">{t('costPerUnit')}</dt><dd className="numeric">{formatIdr(q.backtest.totalCostPerUnitIdr, locale)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted">{t('costMax')}</dt><dd className="numeric font-semibold">{formatIdr(q.backtest.totalCostUnitsMaxIdr, locale)}</dd></div>
      </dl>
      {q.sources.length > 0 && (
        <div>
          <p className="text-xs text-faint">{t('sources')}</p>
          <ul className="mt-1 space-y-1">
            {q.sources.map((s) => (
              <li key={s.url} className="hashtext text-faint"><a href={s.url} target="_blank" rel="noreferrer" className="hover:text-ink">{s.rawSha256}</a></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
