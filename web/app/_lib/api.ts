import { headers } from 'next/headers';
import type { CampaignDetail, CampaignListResponse, CampaignSummary } from '@/types/api';

export type Loaded<T> = { kind: 'ok'; data: T } | { kind: 'notFound' } | { kind: 'error' };

async function baseUrl(): Promise<string> {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env) return env.replace(/\/$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

async function getJson<T>(path: string): Promise<Loaded<T>> {
  try {
    const res = await fetch(`${await baseUrl()}${path}`, { cache: 'no-store', headers: { accept: 'application/json' } });
    if (res.status === 404) return { kind: 'notFound' };
    if (!res.ok) return { kind: 'error' };
    return { kind: 'ok', data: (await res.json()) as T };
  } catch {
    return { kind: 'error' };
  }
}

function isSummary(v: unknown): v is CampaignSummary {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.code === 'string' && typeof o.status === 'string';
}

export async function loadCampaigns(): Promise<Loaded<CampaignSummary[]>> {
  const r = await getJson<CampaignListResponse>('/api/campaigns');
  if (r.kind !== 'ok') return r;
  const list = Array.isArray(r.data?.campaigns) ? r.data.campaigns.filter(isSummary) : [];
  return { kind: 'ok', data: list };
}

export async function loadCampaign(code: string): Promise<Loaded<CampaignDetail>> {
  const r = await getJson<CampaignDetail>(`/api/campaigns/${encodeURIComponent(code)}`);
  if (r.kind !== 'ok') return r;
  if (!isSummary(r.data)) return { kind: 'error' };
  return r;
}
