'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Link, usePathname } from '@/i18n/navigation';
import { ThemeToggle } from './ThemeToggle';

const NAV = [
  { href: '/campaigns', key: 'campaigns' },
  { href: '/check', key: 'check' },
  { href: '/console', key: 'console' },
] as const;

export function SiteHeader() {
  const t = useTranslations('nav');
  const locale = useLocale();
  const pathname = usePathname();
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const other = locale === 'en' ? 'id' : 'en';

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur supports-[backdrop-filter]:bg-bg/70">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:rounded-md focus:bg-raised focus:px-3 focus:py-2">
        {t('skipToContent')}
      </a>
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span aria-hidden className="grid size-6 place-items-center rounded-md bg-accent text-[11px] font-bold text-accent-ink">NH</span>
          <span>NusaHarvest</span>
        </Link>

        <nav aria-label={t('home')} className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={isActive(n.href) ? 'page' : undefined}
              className="relative rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:text-ink aria-[current=page]:text-ink"
            >
              {t(n.key)}
              {isActive(n.href) && (
                <motion.span layoutId={reduce ? undefined : 'nav-underline'} className="absolute inset-x-3 -bottom-[15px] h-px bg-ink" />
              )}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-1">
          <Link
            href={pathname}
            locale={other}
            className="rounded-md px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted transition-colors hover:text-ink"
            aria-label={`${t('language')}: ${other === 'en' ? t('languageEnglish') : t('languageIndonesian')}`}
          >
            {other}
          </Link>
          <ThemeToggle />
          <button
            type="button"
            className="grid size-9 place-items-center rounded-md text-muted hover:text-ink md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? t('closeMenu') : t('openMenu')}
            onClick={() => setOpen((v) => !v)}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
              {open ? <path d="M4 4l10 10M14 4L4 14" /> : <path d="M2 5h14M2 9h14M2 13h14" />}
            </svg>
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.nav
            id="mobile-nav"
            key="mobile-nav"
            className="overflow-hidden border-t border-line md:hidden"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <ul className="px-4 py-2">
              {NAV.map((n) => (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    aria-current={isActive(n.href) ? 'page' : undefined}
                    className="block rounded-md py-2.5 text-[15px] text-muted aria-[current=page]:text-ink"
                  >
                    {t(n.key)}
                  </Link>
                </li>
              ))}
            </ul>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  );
}
