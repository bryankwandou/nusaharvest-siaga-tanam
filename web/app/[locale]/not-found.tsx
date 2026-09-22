import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { EmptyState, buttonSecondary } from '@/components/ui';

export default function NotFound() {
  const t = useTranslations('proof.notFound');
  return (
    <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
      <EmptyState title={t('title')} body={t('body')} action={<Link href="/campaigns" className={buttonSecondary}>{t('action')}</Link>} />
    </div>
  );
}
