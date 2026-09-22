import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // A lockfile exists in a parent folder; pin the workspace root to this app.
  turbopack: { root: import.meta.dirname },
};

export default withNextIntl(nextConfig);
