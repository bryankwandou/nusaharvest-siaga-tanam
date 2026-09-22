import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { CheckForm } from '@/components/CheckForm';
import { PageHeader } from '@/components/ui';

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ code?: string | string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'meta.check' });
  return { title: t('title'), description: t('description') };
}

export default async function CheckPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { code } = await searchParams;
  const t = await getTranslations('check');
  const initial = typeof code === 'string' ? code.slice(0, 32) : '';
  return (
    <>
      <PageHeader title={t('title')} lede={t('lede')} />
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <CheckForm initialCode={initial} />
      </div>
    </>
  );
}
