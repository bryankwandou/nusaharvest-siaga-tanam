import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

export function SiteFooter() {
  const t = useTranslations('footer');
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[2fr_1fr_1fr]">
        <div className="max-w-sm space-y-3">
          <p className="font-semibold">NusaHarvest Siaga Tanam</p>
          <p className="text-sm text-muted">{t('tagline')}</p>
          <p className="text-sm text-muted">{t('notInsurance')}</p>
        </div>
        <div>
          <p className="mb-3 text-xs font-medium uppercase tracking-wider text-faint">{t('sections.product')}</p>
          <ul className="space-y-2 text-sm">
            <li><Link className="text-muted hover:text-ink" href="/campaigns">{t('links.campaigns')}</Link></li>
            <li><Link className="text-muted hover:text-ink" href="/console">{t('links.console')}</Link></li>
          </ul>
        </div>
        <div>
          <p className="mb-3 text-xs font-medium uppercase tracking-wider text-faint">{t('sections.verify')}</p>
          <ul className="space-y-2 text-sm">
            <li><Link className="text-muted hover:text-ink" href="/check">{t('links.check')}</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-line">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-faint sm:px-6">{t('rights')}</p>
      </div>
    </footer>
  );
}
