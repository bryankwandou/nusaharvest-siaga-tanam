import type { ReactNode } from 'react';
import type { CampaignStatusName } from '@/types/api';

export function PageHeader({ title, lede, children }: { title: string; lede?: string; children?: ReactNode }) {
  return (
    <div className="border-b border-line">
      <div className="mx-auto max-w-6xl px-4 pb-10 pt-12 sm:px-6 sm:pt-16">
        {children}
        <h1 className="text-3xl font-semibold sm:text-4xl">{title}</h1>
        {lede && <p className="mt-3 max-w-2xl text-muted">{lede}</p>}
      </div>
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-panel border border-dashed border-line-strong px-6 py-14 text-center">
      <p className="font-medium">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">{body}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

const TONE: Record<CampaignStatusName, string> = {
  OPEN: 'text-open',
  SETTLED: 'text-live',
  DISPUTED: 'text-warn',
  SETTLED_FINAL: 'text-live',
  RELEASED: 'text-live',
  RECEIPTED: 'text-done',
  REFUNDED: 'text-done',
};

export function StatusBadge({ status, label }: { status: CampaignStatusName; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 py-0.5 text-xs font-medium ${TONE[status]}`}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      <span className="text-ink">{label}</span>
    </span>
  );
}

export function Notice({ tone, title, children }: { tone: 'warn' | 'info'; title: string; children: ReactNode }) {
  return (
    <div className={`rounded-card border px-4 py-3 text-sm ${tone === 'warn' ? 'border-warn/40 bg-warn/5' : 'border-line bg-sunken'}`}>
      <p className={`font-medium ${tone === 'warn' ? 'text-warn' : 'text-ink'}`}>{title}</p>
      <p className="mt-1 text-muted">{children}</p>
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="bg-raised p-4 sm:p-5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="numeric mt-1.5 text-lg font-semibold sm:text-xl">{value}</dd>
      {sub && <dd className="mt-1 text-xs text-faint">{sub}</dd>}
    </div>
  );
}

export const buttonPrimary =
  'inline-flex h-10 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-ink transition-[transform,opacity] hover:opacity-90 active:scale-[0.98] disabled:opacity-50';
export const buttonSecondary =
  'inline-flex h-10 items-center justify-center rounded-md border border-line-strong bg-raised px-4 text-sm font-medium transition-colors hover:bg-sunken active:scale-[0.98] disabled:opacity-50';
export const inputClass =
  'h-10 w-full rounded-md border border-line-strong bg-raised px-3 text-[15px] outline-none transition-colors placeholder:text-faint focus:border-accent aria-[invalid=true]:border-stop';
