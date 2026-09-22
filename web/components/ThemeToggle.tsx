'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

type Theme = 'system' | 'light' | 'dark';
const ORDER: Theme[] = ['system', 'light', 'dark'];

/** Inline script for <head>: applies a stored choice before paint to avoid a flash. */
export const themeInitScript = `try{var t=localStorage.getItem('nh-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export function ThemeToggle() {
  const t = useTranslations('nav');
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    try {
      const s = localStorage.getItem('nh-theme');
      if (s === 'light' || s === 'dark') setTheme(s);
    } catch {}
  }, []);

  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? 'system';
    setTheme(next);
    const root = document.documentElement;
    if (next === 'system') delete root.dataset.theme;
    else root.dataset.theme = next;
    try {
      if (next === 'system') localStorage.removeItem('nh-theme');
      else localStorage.setItem('nh-theme', next);
    } catch {}
  };

  const label = theme === 'light' ? t('themeLight') : theme === 'dark' ? t('themeDark') : t('themeSystem');

  return (
    <button
      type="button"
      onClick={cycle}
      className="grid size-9 place-items-center rounded-md text-muted transition-colors hover:text-ink"
      aria-label={`${t('theme')}: ${label}`}
      title={`${t('theme')}: ${label}`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="8" cy="8" r="6" />
        {theme === 'system' && <path d="M8 2v12" />}
        {theme === 'dark' && <path d="M8 2a6 6 0 0 0 0 12z" fill="currentColor" />}
      </svg>
    </button>
  );
}
