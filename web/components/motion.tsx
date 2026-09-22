'use client';

import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

const ease = [0.22, 1, 0.36, 1] as const;

/** Fades and lifts content into place once, when it scrolls into view. Static under reduced motion. */
export function Reveal({ children, delay = 0, className, as = 'div' }: { children: ReactNode; delay?: number; className?: string; as?: 'div' | 'section' | 'li' }) {
  const reduce = useReducedMotion();
  const Tag = motion[as];
  if (reduce) return <Tag className={className}>{children}</Tag>;
  return (
    <Tag
      className={className}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.5, ease, delay }}
    >
      {children}
    </Tag>
  );
}

/** Horizontal bar that grows to `pct` percent of its track. */
export function GrowBar({ pct, className }: { pct: number; className?: string }) {
  const reduce = useReducedMotion();
  const width = `${Math.max(0, Math.min(100, pct))}%`;
  if (reduce) return <div className={className} style={{ width }} />;
  return (
    <motion.div
      className={className}
      initial={{ width: 0 }}
      whileInView={{ width }}
      viewport={{ once: true }}
      transition={{ duration: 0.8, ease }}
    />
  );
}
