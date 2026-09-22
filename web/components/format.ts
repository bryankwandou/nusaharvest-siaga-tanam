import type { SolanaCluster, TokenAmount } from '@/types/api';

const intlLocale = (locale: string) => (locale === 'id' ? 'id-ID' : 'en-US');

export function formatIdr(value: number | null | undefined, locale: string): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat(intlLocale(locale), { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(value);
}

export function formatInt(value: number | null | undefined, locale: string): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat(intlLocale(locale)).format(value);
}

/** mm x 10 integer to a millimetre string with one decimal. */
export function formatMm10(value: number | null | undefined, locale: string): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat(intlLocale(locale), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value / 10);
}

export function formatToken(amount: TokenAmount | null | undefined, locale: string): string | null {
  if (!amount || !/^\d+$/.test(amount.raw) || !Number.isInteger(amount.decimals) || amount.decimals < 0) return null;
  const raw = BigInt(amount.raw);
  const base = 10n ** BigInt(amount.decimals);
  const whole = raw / base;
  const frac = raw % base;
  const wholeStr = new Intl.NumberFormat(intlLocale(locale)).format(whole);
  const dec = locale === 'id' ? ',' : '.';
  const fracStr = amount.decimals > 0 ? frac.toString().padStart(amount.decimals, '0').replace(/0+$/, '').slice(0, 2) : '';
  return `${wholeStr}${fracStr ? dec + fracStr : ''} ${amount.symbol}`.trim();
}

export function formatDate(value: string | number | null | undefined, locale: string, withTime = false): string | null {
  if (value === null || value === undefined) return null;
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' } : {}),
    timeZone: 'Asia/Jakarta',
  }).format(d);
}

export function isZeroHex(hex: string | null | undefined): boolean {
  return !hex || /^0+$/.test(hex);
}

export function shorten(value: string, head = 6, tail = 6): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function explorerUrl(kind: 'address' | 'tx', value: string, cluster: SolanaCluster): string {
  const q = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://explorer.solana.com/${kind}/${encodeURIComponent(value)}${q}`;
}
