'use client';

import Link from 'next/link';
import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';

export function ApplicationJourney({ jobId, applicationId, stage, title }: { jobId?: string | null; applicationId?: string | null; stage: 'profile' | 'resume' | 'application'; title?: string }) {
  const { locale } = useLocale(); const c = copy(locale);
  if (!jobId && !applicationId) return null;
  const query = new URLSearchParams(); if (jobId) query.set('jobId', jobId); if (applicationId) query.set('applicationId', applicationId);
  const steps = [
    { id: 'profile', name: c('Tu perfil', 'Your profile'), href: `/profile?${query}` },
    { id: 'resume', name: c('Preparar CV', 'Prepare resume'), href: `/documents?${query}` },
    { id: 'application', name: c('Revisar y solicitar', 'Review and apply'), href: applicationId ? `/applications?id=${applicationId}` : null },
  ];
  return <nav className="application-journey" aria-label={c('Pasos para esta solicitud', 'Steps for this application')}>
    <div><strong>{title || c('Preparar tu solicitud', 'Prepare your application')}</strong>{jobId && <Link href={`/jobs/${jobId}`}>{c('Ver oferta', 'View job')}</Link>}</div>
    <ol>{steps.map((step, index) => <li key={step.id} aria-current={stage === step.id ? 'step' : undefined}><span aria-hidden="true">{index + 1}</span>{step.href ? <Link href={step.href}>{step.name}</Link> : <span>{step.name}</span>}</li>)}</ol>
  </nav>;
}
