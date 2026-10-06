'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useDocumentTitle } from '@/lib/i18n';
import { Card } from './ui';

function PageTitle({ title }: { title: string }) { useDocumentTitle([title]); return null; }

/**
 * Message page for "not found" and unexpected errors. Moves focus to the heading so screen readers announce the change.
 * It sets the tab title itself unless `ownTitle` is false: inside the app shell the title comes from the breadcrumb, and two
 * places setting it would depend on the order React runs their effects.
 */
export function StatusPage({ eyebrow, title, detail, ownTitle = true, children }: { eyebrow: string; title: string; detail: string; ownTitle?: boolean; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  return <Card className="status-page">
    {ownTitle && <PageTitle title={title}/>}
    <div className="eyebrow">{eyebrow}</div>
    <h1 ref={heading} tabIndex={-1}>{title}</h1>
    <p>{detail}</p>
    <div className="status-actions">{children}</div>
  </Card>;
}
