'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Notice } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';

type Progress = { savedSearchCount: number; totalJobs: number; activeApplications: number };

export default function StartPage() {
  const { locale } = useLocale(); const c = copy(locale);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try { setProgress(await api<Progress>('/summary')); } catch (cause) { setError(errorMessage(cause)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const step = !progress?.savedSearchCount ? 0 : !progress.activeApplications ? 1 : 2;
  const titles = [c('Busca empleo', 'Find jobs'), c('Prepara tu solicitud', 'Prepare your application'), c('Revisa y envía', 'Review and submit')];
  return <WorkspaceGate><AppShell>
    <PageHeader eyebrow={c('PRIMEROS PASOS', 'GETTING STARTED')} title={c('Empieza por el trabajo que buscas', 'Start with the job you want')} description={c('La app busca ofertas por ti. Cuando una te interese, te ayudará a preparar el CV y te guiará hasta el envío.', 'The app finds jobs for you. When one interests you, it helps prepare your resume and guides you through applying.')}/>
    <div className="onboarding-layout">
      <ol className="onboarding-progress" aria-label={c('Tu recorrido', 'Your journey')}>
        {titles.map((title, index) => <li key={title} aria-current={progress && index === step ? 'step' : undefined}><span className="step-badge" aria-hidden="true">{index + 1}</span><span>{title}</span></li>)}
      </ol>
      {error ? <Notice tone="error" actions={<Button variant="secondary" onClick={() => void load()}>{c('Reintentar', 'Try again')}</Button>}>{error}</Notice> : !progress ? <Notice>{c('Preparando tu guía…', 'Preparing your guide…')}</Notice> : <Card className="form-card onboarding-card">
        <h2>{step === 0 ? c('¿Qué trabajo buscas?', 'What job are you looking for?') : step === 1 ? c('Elige una oferta que te interese', 'Choose a job that interests you') : c('Continúa con tus solicitudes', 'Continue with your applications')}</h2>
        <p>{step === 0 ? c('Indica un puesto o una empresa. Guardaremos las ofertas que coincidan y repetiremos la búsqueda automáticamente. Puedes empezar sin completar tu perfil.', 'Enter a role or company. We save matching jobs and repeat your search automatically. You can start before completing your profile.') : step === 1 ? progress.totalJobs ? c('Abre una oferta y pulsa Preparar mi solicitud. Te pediremos los datos que falten y elegiremos experiencia confirmada para crear un CV que puedas revisar.', 'Open a job and choose Prepare my application. We ask for any missing details and select confirmed experience to create a resume for you to review.') : c('Tu búsqueda está guardada. Consulta su estado; si no hay coincidencias, prueba un puesto más amplio o ajusta la ubicación.', 'Your search is saved. Check its status; if there are no matches, try a broader role or adjust the location.') : c('Revisa el CV y los datos antes de enviar. La app te indica si puede ayudarte con el formulario o si debes continuar en la página de la empresa.', 'Review your resume and details before submitting. The app explains whether it can help with the form or you need to continue on the employer’s website.')}</p>
        <Link className="button button-primary" href={step === 2 ? '/applications?view=review' : '/searches'}>{step === 0 ? c('Crear mi primera búsqueda', 'Create my first search') : step === 1 ? c('Ver mis búsquedas y ofertas', 'View my searches and jobs') : c('Revisar mis solicitudes', 'Review my applications')}</Link>
        {step === 2 && <p><Link href="/applications">{c('Ver el seguimiento de mis solicitudes', 'Track my applications')}</Link></p>}
      </Card>}
      <details className="card form-card"><summary>{c('¿Qué hace la app automáticamente?', 'What does the app do automatically?')}</summary>
        <p>{c('Busca y guarda ofertas mientras la app esté funcionando en tu equipo. Puedes cerrar la pestaña; si apagas o suspendes el equipo, continuará cuando vuelva a estar disponible.', 'It finds and saves jobs while the app is running on your computer. You can close the tab; if the computer is off or asleep, checks resume when it is available again.')}</p>
        <p>{c('Puedes activar la preparación de CV en cada búsqueda. Usa solo tu experiencia confirmada. Cada envío requiere tu revisión y autorización; la búsqueda nunca postula por sí sola.', 'You can enable resume preparation for each search. It only uses your confirmed experience. Each submission needs your review and authorization; searching never applies on its own.')}</p>
      </details>
      <p className="muted-label">{c('Tu perfil se completa una vez y se reutiliza. Seguir empresas y guardar respuestas son opciones adicionales.', 'Complete your profile once and reuse it. Following companies and saving answers are additional options.')} <Link href="/profile/setup">{c('Configurar mi perfil paso a paso', 'Set up my profile step by step')}</Link></p>
      <Link href="/">{c('Volver a Inicio', 'Back to Home')}</Link>
    </div>
  </AppShell></WorkspaceGate>;
}
