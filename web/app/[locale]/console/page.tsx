import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { ConsoleForm } from '@/components/ConsoleForm';
import { PageHeader } from '@/components/ui';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'meta.console' });
  return { title: t('title'), description: t('description') };
}

export default async function ConsolePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('console');
  return (
    <>
      <PageHeader title={t('title')} lede={t('lede')} />
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <ConsoleForm />
      </div>
    </>
  );
}
