import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Reveal } from '@/components/motion';
import { buttonPrimary, buttonSecondary } from '@/components/ui';

const FIXED = ['funds', 'roster', 'threshold'] as const;
const STEPS = ['create', 'enrol', 'lock', 'measure', 'release'] as const;
const VERIFY = ['amount', 'roster', 'data', 'receipts'] as const;
const LIMITS = ['area', 'pledge', 'coverage', 'payment'] as const;

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('home');

  return (
    <>
      <section className="relative overflow-hidden border-b border-line">
        <div aria-hidden className="rule-grid pointer-events-none absolute inset-0 opacity-40 [mask-image:linear-gradient(to_bottom,black,transparent)]" />
        <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-16 sm:px-6 sm:pb-28 sm:pt-24">
          <Reveal>
            <p className="text-sm font-medium text-accent">{t('hero.eyebrow')}</p>
          </Reveal>
          <Reveal delay={0.05}>
            <h1 className="mt-4 max-w-3xl text-[2.1rem] font-semibold leading-[1.1] sm:text-5xl md:text-6xl">{t('hero.title')}</h1>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="mt-6 max-w-2xl text-lg text-muted">{t('hero.lede')}</p>
          </Reveal>
          <Reveal delay={0.15}>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/campaigns" className={buttonPrimary}>{t('hero.primaryCta')}</Link>
              <Link href="/check" className={buttonSecondary}>{t('hero.secondaryCta')}</Link>
            </div>
            <p className="mt-6 max-w-xl text-sm text-faint">{t('hero.note')}</p>
          </Reveal>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <Reveal><h2 className="text-2xl font-semibold sm:text-3xl">{t('fixed.title')}</h2></Reveal>
        <div className="mt-10 grid gap-px overflow-hidden rounded-panel border border-line bg-line md:grid-cols-3">
          {FIXED.map((k, i) => (
            <Reveal key={k} delay={i * 0.06} className="bg-raised p-6">
              <p className="font-mono text-xs text-faint">0{i + 1}</p>
              <h3 className="mt-3 text-lg font-semibold">{t(`fixed.items.${k}.title`)}</h3>
              <p className="mt-2 text-sm text-muted">{t(`fixed.items.${k}.body`)}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-sunken">
        <div className="mx-auto grid max-w-6xl gap-12 px-4 py-20 sm:px-6 md:grid-cols-[1fr_2fr]">
          <Reveal>
            <h2 className="text-2xl font-semibold sm:text-3xl">{t('steps.title')}</h2>
            <p className="mt-3 text-muted">{t('steps.lede')}</p>
          </Reveal>
          <ol className="space-y-8">
            {STEPS.map((k, i) => (
              <Reveal as="li" key={k} delay={i * 0.04} className="grid grid-cols-[2rem_1fr] gap-3">
                <span className="numeric pt-0.5 font-mono text-sm text-accent">{i + 1}</span>
                <div>
                  <h3 className="font-semibold">{t(`steps.items.${k}.title`)}</h3>
                  <p className="mt-1.5 text-sm text-muted">{t(`steps.items.${k}.body`)}</p>
                </div>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <Reveal>
          <h2 className="text-2xl font-semibold sm:text-3xl">{t('verify.title')}</h2>
          <p className="mt-3 max-w-2xl text-muted">{t('verify.lede')}</p>
        </Reveal>
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {VERIFY.map((k, i) => (
            <Reveal key={k} delay={i * 0.05} className="rounded-panel border border-line bg-raised p-6 transition-colors hover:border-line-strong">
              <h3 className={`font-semibold ${k === 'amount' ? '' : 'font-mono text-[15px]'}`}>{t(`verify.items.${k}.title`)}</h3>
              <p className="mt-2 text-sm text-muted">{t(`verify.items.${k}.body`)}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-8 sm:px-6">
        <div className="grid gap-10 border-t border-line pt-16 md:grid-cols-[1fr_2fr]">
          <Reveal>
            <h2 className="text-2xl font-semibold">{t('limits.title')}</h2>
            <p className="mt-3 text-muted">{t('limits.lede')}</p>
          </Reveal>
          <ul className="space-y-5">
            {LIMITS.map((k, i) => (
              <Reveal as="li" key={k} delay={i * 0.04} className="border-l-2 border-line-strong pl-4 text-sm text-muted">
                {t(`limits.items.${k}`)}
              </Reveal>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pt-16 sm:px-6">
        <Reveal className="rounded-panel bg-ink px-6 py-12 text-bg sm:px-12">
          <h2 className="text-2xl font-semibold">{t('cta.title')}</h2>
          <p className="mt-3 max-w-xl opacity-75">{t('cta.body')}</p>
          <Link href="/campaigns" className="mt-6 inline-flex h-10 items-center rounded-md bg-bg px-4 text-sm font-medium text-ink transition-transform active:scale-[0.98]">
            {t('cta.action')}
          </Link>
        </Reveal>
      </section>
    </>
  );
}
