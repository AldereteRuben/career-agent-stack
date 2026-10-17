'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { countReviewItems, type PreparationReviewItem, type ReviewableResume } from '@/lib/application-review-count';

export function ApplicationSections({ active, reviewCount }: { active: 'review' | 'tracking'; reviewCount?: number | null }) {
  const { locale } = useLocale();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (reviewCount !== undefined) return;
    let disposed = false; let pending = false;
    const load = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const [preparations, documents] = await Promise.all([api<PreparationReviewItem[]>('/preparations'), api<ReviewableResume[]>('/documents')]);
        if (!disposed) setCount(countReviewItems(preparations, documents));
      }
      catch { if (!disposed) setCount(null); }
      finally { pending = false; }
    };
    void load(); const timer = setInterval(() => void load(), 15000);
    document.addEventListener('visibilitychange', load);
    window.addEventListener('focus', load);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', load); window.removeEventListener('focus', load); };
  }, [reviewCount]);
  const shownCount = reviewCount === undefined ? count : reviewCount;
  return <nav className="application-sections" aria-label={locale === 'es' ? 'Secciones de solicitudes' : 'Application sections'}>
    <Link className={`button button-${active === 'review' ? 'primary' : 'secondary'}`} aria-current={active === 'review' ? 'page' : undefined} href="/applications?view=review">{locale === 'es' ? 'Por revisar' : 'To review'}{shownCount !== null ? ` (${shownCount})` : ''}</Link>
    <Link className={`button button-${active === 'tracking' ? 'primary' : 'secondary'}`} aria-current={active === 'tracking' ? 'page' : undefined} href="/applications">{locale === 'es' ? 'Seguimiento' : 'Tracking'}</Link>
  </nav>;
}
