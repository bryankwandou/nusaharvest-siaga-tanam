import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { loadCampaign } from '@/app/_lib/api';
import { explorerUrl, formatDate, formatIdr, formatInt, formatToken, isZeroHex } from '@/components/format';
import { Reveal } from '@/components/motion';
import { HashRow } from '@/components/proof/HashRow';
import { Rainfall } from '@/components/proof/Rainfall';
import { Reproduce } from '@/components/proof/Reproduce';
import { Timeline } from '@/components/proof/Timeline';
import { EmptyState, Notice, Stat, StatusBadge, buttonSecondary } from '@/components/ui';
import type { CampaignDetail } from '@/types/api';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: string; code: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, code } = await params;
  const t = await getTranslations({ locale, namespace: 'meta.proof' });
  return { title: `${decodeURIComponent(code)} | ${t('title')}`, description: t('description') };
}

function Section({ title, lede, children }: { title: string; lede?: string; children: React.ReactNode }) {
  return (
    <Reveal as="section" className="border-t border-line py-10">
      <div className="grid gap-6 lg:grid-cols-[240px_1fr] lg:gap-10">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          {lede && <p className="mt-2 text-sm text-muted">{lede}</p>}
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </Reveal>
  );
}

export default async function ProofPage({ params }: Props) {
  const { locale, code: rawCode } = await params;
  setRequestLocale(locale);
  const code = decodeURIComponent(rawCode);
  const t = await getTranslations('proof');
  const tRoot = await getTranslations();
  const result = await loadCampaign(code);

  if (result.kind !== 'ok') {
    const nf = result.kind === 'notFound';
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
        <EmptyState
          title={nf ? t('notFound.title') : t('unavailable.title')}
          body={nf ? t('notFound.body') : t('unavailable.body')}
          action={<Link href="/campaigns" className={buttonSecondary}>{t('notFound.action')}</Link>}
        />
      </div>
    );
  }

  const c: CampaignDetail = result.data;
  const oc = c.onchain;
  const pledge = c.mode === 'pledge';
  const lockedValue = pledge ? null : formatToken(c.lockedAmount, locale);
  const pledgeTotal = pledge && c.unitsMax ? formatIdr(c.unitsMax * c.amountFullIdr, locale) : null;
  const units = c.unitsLocked ?? c.roster?.units ?? oc?.units ?? null;
  const cells = Array.isArray(c.area?.gridCells) ? c.area.gridCells.length : 0;

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <div className="pb-10 pt-10 sm:pt-14">
        <Link href="/campaigns" className="text-sm text-muted hover:text-ink">&larr; {t('back')}</Link>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <span className="font-mono text-sm text-muted">{c.code}</span>
          <StatusBadge status={c.status} label={tRoot(`status.${c.status}.name`)} />
          <span className="text-xs text-faint">{c.cluster}</span>
        </div>
        <h1 className="mt-3 text-3xl font-semibold sm:text-4xl">{[c.area?.regency, c.area?.province].filter(Boolean).join(', ')}</h1>
        <p className="mt-2 text-muted">{t('sponsoredBy', { sponsor: c.sponsorName })} · {c.commodity}</p>

        <div className="mt-6 grid gap-3 md:grid-cols-2">
          {c.historicalReplay && <Notice tone="warn" title={t('labels.replay')}>{t('labels.replayDetail')}</Notice>}
          {pledge && <Notice tone="warn" title={t('labels.pledge')}>{t('labels.pledgeDetail')}</Notice>}
          {c.settlement?.review && <Notice tone="warn" title={t('labels.review')}>{c.settlement.reviewNote ?? t('labels.reviewDetail')}</Notice>}
          {c.receipts?.manualDisbursement && <Notice tone="info" title={t('labels.manual')}>{t('labels.manualDetail')}</Notice>}
        </div>
      </div>

      <Reveal>
        <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-panel border border-line bg-line min-[420px]:grid-cols-2 lg:grid-cols-4">
          <Stat label={pledge ? t('summary.lockedPledge') : t('summary.locked')} value={pledge ? pledgeTotal ?? '-' : lockedValue ?? '-'} sub={pledge ? t('labels.pledge') : undefined} />
          <Stat label={units !== null ? t('summary.recipients') : t('summary.recipientsPending')} value={formatInt(units, locale) ?? '-'} sub={c.unitsMax ? `${tRoot('common.of')} ${formatInt(c.unitsMax, locale)}` : undefined} />
          <Stat label={t('summary.amountFull')} value={formatIdr(c.amountFullIdr, locale) ?? '-'} sub={`${t('summary.amountHalf')}: ${formatIdr(c.amountHalfIdr, locale) ?? '-'}`} />
          <Stat label={t('summary.freeze')} value={formatDate(c.freezeTs, locale) ?? '-'} sub={`${t('summary.window')}: ${formatDate(c.windowStartDate, locale) ?? '-'} - ${formatDate(c.windowEndDate, locale) ?? '-'}`} />
        </dl>
        <p className="mt-3 text-xs text-faint">
          {t('summary.mode')}: {pledge ? t('summary.modePledge') : t('summary.modeEscrow')} · {t('summary.gridCells', { count: cells })}
        </p>
      </Reveal>

      <div className="mt-10">
        <Section title={t('timeline.title')} lede={t('timeline.lede')}>
          <Timeline status={c.status} events={c.timeline ?? []} cluster={c.cluster} />
        </Section>

        <Section title={t('rainfall.title')}>
          <Rainfall c={c} />
        </Section>

        <Section title={t('onchain.title')} lede={oc ? t('onchain.lede', { version: oc.ruleVersion }) : undefined}>
          {c.pubkey && (
            <a href={explorerUrl('address', c.pubkey, c.cluster)} target="_blank" rel="noreferrer" className="mb-4 inline-flex text-sm text-accent underline-offset-2 hover:underline">
              {t('onchain.explorer')} &rarr;
            </a>
          )}
          <dl>
            <HashRow label={t('onchain.account')} value={c.pubkey} kind="address" cluster={c.cluster} />
            {c.programId && <HashRow label={t('onchain.programId')} value={c.programId} kind="address" cluster={c.cluster} />}
            {oc ? (
              <>
                <HashRow label={t('onchain.rosterRoot')} value={oc.rosterRoot} />
                <HashRow label={t('onchain.dataHash')} value={oc.dataHash} />
                <HashRow label={t('onchain.receiptsRoot')} value={oc.receiptsRoot} />
                <HashRow label={t('onchain.termsHash')} value={oc.termsHash} />
                <HashRow label={t('onchain.sponsor')} value={oc.sponsor} kind="address" cluster={c.cluster} />
                <HashRow label={t('onchain.operator')} value={oc.operator} kind="address" cluster={c.cluster} />
                <HashRow label={t('onchain.auditor')} value={oc.auditor} kind="address" cluster={c.cluster} />
                <HashRow label={t('onchain.disburser')} value={oc.disburser} kind="address" cluster={c.cluster} />
                <HashRow label={t('onchain.mint')} value={oc.mint} kind="address" cluster={c.cluster} />
              </>
            ) : (
              <p className="border-t border-line pt-3 text-sm text-muted">{t('onchain.empty')}</p>
            )}
          </dl>
          <div className="mt-8">
            <Reproduce
              url={c.settlement?.dataJsonUrl ?? null}
              expected={oc && !isZeroHex(oc.dataHash) ? oc.dataHash : null}
            />
          </div>
        </Section>

        <Section title={t('receipts.title')}>
          {c.receipts ? (
            <>
              <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-panel border border-line bg-line min-[420px]:grid-cols-2">
                <Stat label={t('receipts.paid')} value={formatInt(c.receipts.paidCount, locale) ?? '-'} />
                <Stat label={t('receipts.failed')} value={formatInt(c.receipts.failedCount, locale) ?? '-'} />
                <Stat label={t('receipts.total')} value={formatIdr(c.receipts.totalPaidIdr, locale) ?? '-'} />
                <Stat label={t('receipts.returned')} value={formatIdr(c.receipts.returnedToSponsorIdr, locale) ?? '-'} />
              </dl>
              {formatDate(c.receipts.postedAt, locale) && <p className="mt-3 text-xs text-faint">{t('receipts.posted', { date: formatDate(c.receipts.postedAt, locale)! })}</p>}
            </>
          ) : (
            <p className="text-sm text-muted">{t('receipts.empty')}</p>
          )}
        </Section>

        <Section title={t('check.title')}>
          <p className="text-sm text-muted">{t('check.body')}</p>
          <Link href={{ pathname: '/check', query: { code: c.code } }} className={`${buttonSecondary} mt-4`}>{t('check.action')}</Link>
        </Section>
      </div>
    </div>
  );
}
