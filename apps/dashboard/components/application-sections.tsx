'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/i18n';

export function ApplicationSections({ active, reviewCount }: { active: 'review' | 'tracking'; reviewCount?: number }) {
  const { locale } = useLocale();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (reviewCount !== undefined) return;
    let disposed = false; let pending = false;
    const load = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try { const rows = await api<Array<{ needsAttention: boolean }>>('/preparations'); if (!disposed) setCount(rows.filter((item) => item.needsAttention).length); }
      catch { if (!disposed) setCount(null); }
      finally { pending = false; }
    };
    void load(); const timer = setInterval(() => void load(), 15000);
    document.addEventListener('visibilitychange', load);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', load); };
  }, [reviewCount]);
  const shownCount = reviewCount ?? count;
  return <nav className="application-sections" aria-label={locale === 'es' ? 'Secciones de solicitudes' : 'Application sections'}>
    <Link className={`button button-${active === 'review' ? 'primary' : 'secondary'}`} aria-current={active === 'review' ? 'page' : undefined} href="/applications?view=review">{locale === 'es' ? 'Por revisar' : 'To review'}{shownCount !== null ? ` (${shownCount})` : ''}</Link>
    <Link className={`button button-${active === 'tracking' ? 'primary' : 'secondary'}`} aria-current={active === 'tracking' ? 'page' : undefined} href="/applications">{locale === 'es' ? 'Seguimiento' : 'Tracking'}</Link>
  </nav>;
}
