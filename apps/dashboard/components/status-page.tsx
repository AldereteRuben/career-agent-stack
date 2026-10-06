'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useDocumentTitle } from '@/lib/i18n';
import { Card } from './ui';

/** Message page for "not found" and unexpected errors. Moves focus to the heading so screen readers announce the change. */
export function StatusPage({ eyebrow, title, detail, children }: { eyebrow: string; title: string; detail: string; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useDocumentTitle([title]);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  return <Card className="status-page">
    <div className="eyebrow">{eyebrow}</div>
    <h1 ref={heading} tabIndex={-1}>{title}</h1>
    <p>{detail}</p>
    <div className="status-actions">{children}</div>
  </Card>;
}
