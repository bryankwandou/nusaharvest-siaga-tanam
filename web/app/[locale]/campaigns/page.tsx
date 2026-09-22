import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { loadCampaigns } from '@/app/_lib/api';
import { CampaignList } from '@/components/CampaignList';
import { EmptyState, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'meta.campaigns' });
  return { title: t('title'), description: t('description') };
}

export default async function CampaignsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('campaigns');
  const result = await loadCampaigns();

  return (
    <>
      <PageHeader title={t('title')} lede={t('lede')} />
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        {result.kind === 'ok' ? (
          <CampaignList campaigns={result.data} />
        ) : (
          <EmptyState title={t('error.title')} body={t('error.body')} />
        )}
      </div>
    </>
  );
}
