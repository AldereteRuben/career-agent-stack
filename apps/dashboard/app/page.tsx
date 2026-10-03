'use client';

import { useLocale } from '@/lib/i18n';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage, formatDate } from '@/lib/api';
import { copy, labelFor } from '@/lib/labels';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { ButtonLink, Card, Empty, Icon, Notice, Tag } from '@/components/ui';

type Summary = {
  boards: Array<{ id: string; companyName: string; enabled: boolean; lastSuccessfulRefreshAt: string | null }>;
  recentJobs: Array<{ id: string; title: string; company: string; location: string | null; fitScore: number | null; eligibility: string; provisional?: boolean }>;
  recentApplications: Array<{ id: string; role: string; company: string; state: string; updatedAt: string }>;
  pendingFacts: number;
  unansweredItems: number;
  applicationCounts: Record<string, number>;
  approvedSourceCount: number;
  boardCount: number;
  /** Totals computed by the API; the recent lists above are capped at 6 and are not totals. */
  totalJobs: number;
  activeApplications: number;
  profileCompletion: { percent: number; completed: number; total: number; missing: ProfileCheck[]; approvedFactCount: number; pendingFactCount: number };
};

type ProfileCheck = 'fullName' | 'email' | 'country' | 'targetTitles' | 'workModes' | 'approvedFact';

/** Order matches the profile checklist in @career/domain. */
const profileChecks: Array<{ key: ProfileCheck; es: string; en: string }> = [
  { key: 'fullName', es: 'Nombre completo', en: 'Full name' },
  { key: 'email', es: 'Correo electrónico', en: 'Email' },
  { key: 'country', es: 'País donde quieres trabajar', en: 'Country you want to work in' },
  { key: 'targetTitles', es: 'Puestos que buscas', en: 'Target job titles' },
  { key: 'workModes', es: 'Modalidad de trabajo', en: 'Work arrangement' },
  { key: 'approvedFact', es: 'Una experiencia o logro confirmado', en: 'One confirmed experience or achievement' },
];

type NextStep = { key: string; href: string; title: string; detail: string; icon: string };

const stateTone = (state: string): 'green' | 'amber' | 'red' | 'blue' | 'neutral' =>
  state === 'CONFIRMED' ? 'green' : state === 'REVIEW_REQUIRED' ? 'amber' : state === 'CANCELLED' ? 'red' : state === 'READY' || state === 'IN_PROGRESS' ? 'blue' : 'neutral';

export default function HomePage() {
  const { t, locale } = useLocale();
  const c = copy(locale);
  const [summary, setSummary] = useState<Summary | null>(null); const [error, setError] = useState('');
  useEffect(() => { api<Summary>('/summary').then(setSummary).catch((err) => setError(errorMessage(err))); }, []);

  const counts = summary?.applicationCounts ?? {};
  const totalApplications = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const needsReview = counts.REVIEW_REQUIRED ?? 0;
  const completion = summary?.profileCompletion;
  const missing = new Set(completion?.missing ?? []);
  const loading = !summary && !error;

  // Profile basics come first: matching and documents depend on them, and they are quicker than source setup.
  const steps: NextStep[] = [];
  if (summary && completion) {
    const identityMissing = profileChecks.filter((check) => ['fullName', 'email'].includes(check.key) && missing.has(check.key));
    const preferencesMissing = profileChecks.filter((check) => ['targetTitles', 'workModes'].includes(check.key) && missing.has(check.key));
    const list = (checks: typeof profileChecks) => checks.map((check) => c(check.es, check.en).toLowerCase()).join(', ');
    if (identityMissing.length) steps.push({ key: 'identity', href: '/profile', icon: 'user', title: c('Completa tus datos básicos', 'Complete your basic details'), detail: c(`Falta: ${list(identityMissing)}.`, `Missing: ${list(identityMissing)}.`) });
    if (preferencesMissing.length) steps.push({ key: 'preferences', href: '/profile', icon: 'search', title: c('Indica qué buscas', 'Say what you are looking for'), detail: c(`Falta: ${list(preferencesMissing)}. Así podemos valorar el encaje de cada oferta.`, `Missing: ${list(preferencesMissing)}. This is how job fit is assessed.`) });
    if (missing.has('approvedFact')) steps.push(summary.pendingFacts > 0
      ? { key: 'first-fact', href: '/profile#experience', icon: 'check', title: c('Confirma tu primera experiencia', 'Confirm your first experience'), detail: summary.pendingFacts === 1 ? c('Tienes 1 dato por confirmar esperando tu revisión.', 'You have 1 detail to confirm waiting for review.') : c(`Tienes ${summary.pendingFacts} datos por confirmar esperando tu revisión.`, `You have ${summary.pendingFacts} details to confirm waiting for review.`) }
      : { key: 'first-fact', href: '/profile#experience', icon: 'plus', title: c('Añade tu primera experiencia o logro', 'Add your first experience or achievement'), detail: c('Un logro o experiencia que puedas respaldar. Nada se usa hasta que lo apruebes.', 'An achievement or experience you can stand behind. Nothing is used until you approve it.') });
    else if (summary.pendingFacts > 0) steps.push({ key: 'facts', href: '/profile#experience', icon: 'user', title: summary.pendingFacts === 1 ? c('Revisa 1 dato por confirmar', 'Review 1 detail to confirm') : c(`Revisa ${summary.pendingFacts} datos por confirmar`, `Review ${summary.pendingFacts} details to confirm`), detail: c('Nada se usa en tus documentos hasta que lo apruebes.', 'Nothing is used in your documents until you approve it.') });
    if (summary.unansweredItems > 0) steps.push({ key: 'answers', href: '/profile', icon: 'file', title: summary.unansweredItems === 1 ? c('Responde 1 pregunta pendiente', 'Answer 1 open question') : c(`Responde ${summary.unansweredItems} preguntas pendientes`, `Answer ${summary.unansweredItems} open questions`), detail: c('Son datos que solo tú puedes confirmar.', 'Only you can confirm these details.') });
    if (needsReview > 0) steps.push({ key: 'applications', href: '/applications', icon: 'briefcase', title: needsReview === 1 ? c('1 solicitud necesita revisión', '1 application needs review') : c(`${needsReview} solicitudes necesitan revisión`, `${needsReview} applications need review`), detail: c('Confirma su estado para mantener el seguimiento al día.', 'Confirm their status to keep your tracker accurate.') });
    if (summary.totalJobs === 0) steps.push({ key: 'first-job', href: '/jobs', icon: 'search', title: c('Guarda tu primera oferta', 'Save your first job'), detail: c('Añade a mano una oferta que ya tengas en mente.', 'Add a job you already have in mind by hand.') });
    if (summary.approvedSourceCount === 0) steps.push(summary.boardCount
      ? { key: 'review-sources', href: '/boards', icon: 'building', title: c('Confirma la página de una empresa', 'Confirm a company careers page'), detail: c('Tienes fuentes añadidas, pero ninguna aprobada para buscar ofertas.', 'You have sources added, but none approved for job discovery yet.') }
      : { key: 'add-source', href: '/boards', icon: 'building', title: c('Opcional: sigue las ofertas de una empresa', 'Optional: follow a company’s jobs'), detail: c('Para recibir ofertas de empresas concretas. Puedes hacerlo más adelante.', 'To pull in jobs from specific companies. You can do this later.') });
  }

  const primaryStep = steps.find((step) => !['add-source', 'review-sources', 'answers'].includes(step.key));

  const metrics = [
    { key: 'jobs', label: c('Ofertas guardadas', 'Saved jobs'), value: summary?.totalJobs, href: '/jobs' },
    { key: 'active', label: c('Solicitudes activas', 'Active applications'), value: summary?.activeApplications, href: '/applications' },
    { key: 'facts', label: c('Datos confirmados', 'Confirmed profile details'), value: completion?.approvedFactCount, href: '/profile' },
    { key: 'sources', label: c('Empresas conectadas', 'Connected companies'), value: summary?.approvedSourceCount, href: '/boards' },
  ];

  return <WorkspaceGate><AppShell>
    <PageHeader
      eyebrow={t('Resumen')}
      title={c('Tu búsqueda, hoy', 'Your search today')}
      description={c('Organiza tu búsqueda de empleo: guarda ofertas, prepara tu CV y lleva el seguimiento de tus solicitudes.', 'Organize your job search: save jobs, prepare your resume, and track your applications.')}
    />
    {error && <Notice tone="error">{error}</Notice>}

    {summary && <Card className="getting-started">
      <div className="eyebrow">{c('TU SIGUIENTE PASO', 'YOUR NEXT STEP')}</div>
      <h2>{primaryStep?.title ?? c('Elige una oferta que te interese', 'Choose a job you are interested in')}</h2>
      <p>{primaryStep?.detail ?? c('Abre una oferta guardada para preparar tu CV o empezar a seguir tu solicitud.', 'Open a saved job to prepare your resume or start tracking your application.')}</p>
      <ButtonLink href={primaryStep?.href ?? '/jobs'}>{primaryStep?.href.startsWith('/profile') ? c('Continuar con mi perfil', 'Continue with my profile') : primaryStep?.href === '/applications' ? c('Revisar mis solicitudes', 'Review my applications') : c('Ir a mis ofertas', 'Go to my saved jobs')} <Icon name="arrow" size={18}/></ButtonLink>
      <p className="muted-label">{c('Puedes guardar ofertas desde el principio. Conectar páginas de empresas y guardar respuestas es opcional.', 'You can save jobs right away. Connecting company careers pages and saving answers are optional.')}</p>
    </Card>}
    <section className="search-guide" aria-labelledby="search-guide-heading">
      <h2 id="search-guide-heading">{c('Cómo usar Career Stack', 'How to use Career Stack')}</h2>
      <ol className="journey-grid">
        {[
          { href: '/profile', title: c('Cuenta tu experiencia', 'Add your experience'), detail: c('Guarda tus datos y los logros que quieres incluir en tu CV.', 'Save your details and the achievements you want on your resume.') },
          { href: '/jobs', title: c('Guarda una oferta', 'Save a job'), detail: c('Copia el enlace y la descripción de un empleo que te interese.', 'Copy the link and description of a job you are interested in.') },
          { href: '/documents', title: c('Prepara tu CV', 'Prepare your resume'), detail: c('Elige qué incluir, genera el PDF y confirma que está correcto.', 'Choose what to include, generate the PDF, and check it is accurate.') },
          { href: '/applications', title: c('Solicita el puesto y anótalo', 'Apply and track it'), detail: c('Envía tú la solicitud a la empresa y registra lo que ocurra. Lever permite completar tus datos con ayuda.', 'Submit the application yourself and track what happens. Lever supports assisted contact entry.') },
        ].map((step, index) => <li key={step.href}><Link href={step.href}><span className="step-badge" aria-hidden="true">{index + 1}</span><strong>{step.title}</strong><span>{step.detail}</span></Link></li>)}
      </ol>
    </section>

    <details className="overview-details" open={Boolean(summary && (summary.totalJobs > 0 || totalApplications > 0))}>
      <summary>{c('Ver mi resumen y otros pendientes', 'View my overview and other tasks')}</summary>
    <section aria-labelledby="metrics-heading" aria-busy={loading}>
      <h2 id="metrics-heading" className="sr-only">{c('Cifras clave', 'Key figures')}</h2>
      <ul className="metric-grid">
        {metrics.map((metric) => <li key={metric.key}><Link href={metric.href} className="metric">
          <span className="metric-label">{metric.label}</span>
          <strong className="metric-value">{metric.value ?? <span className="metric-placeholder" aria-label={c('Cargando', 'Loading')}>·</span>}</strong>
        </Link></li>)}
      </ul>
    </section>

    <div className="home-grid">
      <Card className="home-panel">
        <div className="panel-heading"><h2>{c('Otros pendientes y opciones', 'Other tasks and options')}</h2></div>
        {loading ? <p className="panel-status" role="status">{c('Cargando tu resumen…', 'Loading your overview…')}</p>
          : steps.filter((step) => step.key !== primaryStep?.key).length ? <ol className="step-list">{steps.filter((step) => step.key !== primaryStep?.key).map((step) => <li key={step.key}><Link href={step.href} className="step-item">
            <span className="step-icon" aria-hidden="true"><Icon name={step.icon} size={20}/></span>
            <span className="step-copy"><strong>{step.title}</strong><span>{step.detail}</span></span>
            <Icon name="arrow" size={18}/>
          </Link></li>)}</ol>
          : summary && <div className="step-done"><Icon name="check" size={20}/><p>{c('No hay otros pendientes. Puedes continuar con el siguiente paso.', 'There are no other tasks waiting. You can continue with the next step.')}</p></div>}
      </Card>

      <Card className="home-panel">
        <div className="panel-heading"><h2 id="profile-heading">{c('Tu perfil', 'Your profile')}</h2><Link href="/profile" className="text-link">{t('Revisar perfil')} <Icon name="arrow" size={16}/></Link></div>
        {completion ? <>
          <p className="panel-status">{c(`${completion.completed} de ${completion.total} elementos completos`, `${completion.completed} of ${completion.total} items complete`)}</p>
          <progress max={completion.total} value={completion.completed} aria-labelledby="profile-heading" style={{ width: '100%', height: 8, accentColor: 'var(--blue)' }}/>
          <ul className="row-list">{profileChecks.map((check) => {
            const done = !missing.has(check.key);
            return <li key={check.key} className="list-row" style={{ minHeight: 48, margin: 0, padding: '8px 0', flexWrap: 'nowrap' }}>
              <span className="row-main"><strong style={{ fontWeight: done ? 400 : 600 }}>{c(check.es, check.en)}</strong></span>
              <Tag tone={done ? 'green' : 'amber'}>{done ? c('Completo', 'Done') : c('Pendiente', 'Missing')}</Tag>
            </li>;
          })}</ul>
        </> : !loading && <p className="panel-status">{c('No se pudo cargar el estado del perfil.', 'Could not load your profile status.')}</p>}
      </Card>
    </div>

    <div className="home-grid">
      <Card className="home-panel">
        <div className="panel-heading"><h2>{c('Solicitudes recientes', 'Recent applications')}</h2><Link href="/applications" className="text-link">{t('Abrir seguimiento')} <Icon name="arrow" size={16}/></Link></div>
        {summary?.recentApplications.length ? <ul className="row-list">{summary.recentApplications.slice(0, 5).map((application) => <li key={application.id}><Link href={`/applications?id=${application.id}`} className="list-row">
          <span className="row-main"><strong>{application.role}</strong><span>{application.company} · {formatDate(application.updatedAt)}</span></span>
          <Tag tone={stateTone(application.state)}>{labelFor.applicationState(application.state, locale)}</Tag>
        </Link></li>)}</ul>
          : !loading && <p className="panel-status">{c('Todavía no has registrado solicitudes.', 'You have not tracked any applications yet.')}</p>}
        {totalApplications > 0 && <p className="panel-foot">{totalApplications === 1 ? c('1 solicitud en total', '1 application in total') : c(`${totalApplications} solicitudes en total`, `${totalApplications} applications in total`)}</p>}
      </Card>
      <Card className="home-panel">
        <div className="panel-heading"><h2>{c('Ofertas actualizadas recientemente', 'Recently updated jobs')}</h2><Link href="/jobs" className="text-link">{t('Ver todas')} <Icon name="arrow" size={16}/></Link></div>
        {summary?.recentJobs.length ? <ul className="row-list">{summary.recentJobs.map((job) => <li key={job.id}><Link href={`/jobs/${job.id}`} className="list-row">
          <span className="company-monogram" aria-hidden="true">{job.company.slice(0, 1)}</span>
          <span className="row-main"><strong>{job.title}</strong><span>{job.company} · {job.location ?? t('Location to be confirmed')}</span></span>
          {job.fitScore !== null && <span className="row-score">{job.provisional ? c(`Encaje provisional ${job.fitScore}`, `Provisional fit ${job.fitScore}`) : c(`Encaje ${job.fitScore}`, `Fit ${job.fitScore}`)}</span>}
          <Tag tone={job.eligibility === 'PASS' ? 'green' : job.eligibility === 'FAIL' ? 'red' : 'amber'}>{labelFor.eligibility(job.eligibility, locale)}</Tag>
        </Link></li>)}</ul>
          : !loading && <Empty title={t('Tu lista aún está en blanco')} detail={summary?.boards.length ? t('Refresh an approved source or add a job manually.') : t('Set up a job source or add a job you already have in mind.')} action={<Link href={summary?.boards.length ? '/boards' : '/jobs'} className="text-link">{summary?.boards.length ? t('Revisar fuentes') : t('Añadir primera oferta')} <Icon name="arrow" size={16}/></Link>}/>}
        {summary && summary.totalJobs > summary.recentJobs.length && <p className="panel-foot">{c(`Mostrando ${summary.recentJobs.length} de ${summary.totalJobs} ofertas guardadas`, `Showing ${summary.recentJobs.length} of ${summary.totalJobs} saved jobs`)}</p>}
      </Card>
    </div>
    </details>
  </AppShell></WorkspaceGate>;
}
