'use client';

import { useLocale } from '@/lib/i18n';
import Link from 'next/link';
import { useLocalRefresh } from '@/lib/local-refresh';
import { DiscoveryPanel } from '@/components/discovery-panel';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, formatDate } from '@/lib/api';
import { copy, labelFor } from '@/lib/labels';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { ButtonLink, Card, Empty, Icon, Notice, Tag } from '@/components/ui';

type Summary = {
  boards: Array<{ id: string; companyName: string; enabled: boolean; lastSuccessfulRefreshAt: string | null }>;
  recentJobs: Array<{ searchSources?: Array<{ provider: string; url: string }>; id: string; title: string; company: string; location: string | null; fitScore: number | null; eligibility: string; provisional?: boolean }>;
  recentApplications: Array<{ id: string; role: string; company: string; state: string; updatedAt: string }>;
  pendingFacts: number;
  unansweredItems: number;
  applicationCounts: Record<string, number>;
  approvedSourceCount: number;
  boardCount: number;
  savedSearchCount: number; activeSearchCount: number;
  /** Totals computed by the API; the recent lists above are capped at 6 and are not totals. */
  totalJobs: number;
  activeApplications: number;
  profileCompletion: { percent: number; completed: number; total: number; missing: ProfileCheck[]; approvedFactCount: number; pendingFactCount: number };
};

type ProfileCheck = 'fullName' | 'email' | 'country' | 'targetTitles' | 'workModes' | 'approvedFact';
type InboxJob = { id: string; title: string; company: string; location: string | null; searchScore?: number | null; searchReasons?: string[]; sources?: Array<{ provider: string; url: string }> };
type SearchInbox = { total: number; items: InboxJob[] };
type HomeSearch = { id: string; enabled: boolean; nextRunAt: string | null; lastRunStatus: string | null; latestRun?: { status: string; finishedAt: string | null; error: string | null; sources: Array<{ status: string; error: string | null }> } | null };
type HomeDocument = { id: string; approvalStatus: string; reviewRequired?: boolean };

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
const dateTime = (value: string, locale: string) => new Intl.DateTimeFormat(locale === 'es' ? 'es-ES' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export default function HomePage() {
  const { t, locale } = useLocale();
  const c = copy(locale);
  const [summary, setSummary] = useState<Summary | null>(null); const [error, setError] = useState('');
  const load = useCallback(async () => { try { setSummary(await api<Summary>('/summary')); setError(''); } catch (err) { setError(errorMessage(err)); } }, []);
  const [inbox, setInbox] = useState<SearchInbox | null>(null); const [searches, setSearches] = useState<HomeSearch[]>([]); const [pendingResumes, setPendingResumes] = useState(0); const [inboxError, setInboxError] = useState('');
  const loadInbox = useCallback(async () => {
    const [results, searchList, documents] = await Promise.allSettled([
      api<SearchInbox>('/job-searches/results?view=new&sort=relevance&offset=0&limit=3'),
      api<{ searches: HomeSearch[] }>('/job-searches'),
      api<HomeDocument[]>('/documents'),
    ]);
    if (results.status === 'fulfilled') setInbox(results.value);
    if (searchList.status === 'fulfilled') setSearches(searchList.value.searches);
    if (documents.status === 'fulfilled') setPendingResumes(documents.value.filter((document) => document.reviewRequired ?? document.approvalStatus === 'PENDING_REVIEW').length);
    const failed = [results, searchList, documents].some((result) => result.status === 'rejected');
    setInboxError(failed ? errorMessage((results.status === 'rejected' && results.reason) || (searchList.status === 'rejected' && searchList.reason) || (documents.status === 'rejected' && documents.reason)) : '');
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadInbox(); }, [loadInbox]);
  const refreshHome = useCallback(async () => { await Promise.all([load(), loadInbox()]); }, [load, loadInbox]);
  useLocalRefresh(refreshHome);

  const counts = summary?.applicationCounts ?? {};
  const totalApplications = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const needsReview = counts.REVIEW_REQUIRED ?? 0;
  const completion = summary?.profileCompletion;
  const missing = new Set(completion?.missing ?? []);
  const loading = !summary && !error;

  // Start with discovery; profile details are needed when preparing an application.
  const steps: NextStep[] = [];
  if (summary && completion) {
    const identityMissing = profileChecks.filter((check) => ['fullName', 'email'].includes(check.key) && missing.has(check.key));
    const preferencesMissing = profileChecks.filter((check) => ['targetTitles', 'workModes'].includes(check.key) && missing.has(check.key));
    const list = (checks: typeof profileChecks) => checks.map((check) => c(check.es, check.en).toLowerCase()).join(', ');
    if (identityMissing.length) steps.push({ key: 'identity', href: '/profile', icon: 'user', title: c('Completa tus datos básicos', 'Complete your basic details'), detail: c(`Falta: ${list(identityMissing)}.`, `Missing: ${list(identityMissing)}.`) });
    if (preferencesMissing.length) steps.push({ key: 'preferences', href: '/profile', icon: 'search', title: c('Indica qué buscas', 'Say what you are looking for'), detail: c(`Falta: ${list(preferencesMissing)}. Así podemos valorar el encaje de cada oferta.`, `Missing: ${list(preferencesMissing)}. This is how job fit is assessed.`) });
    if (missing.has('approvedFact')) steps.push(summary.pendingFacts > 0
      ? { key: 'first-fact', href: '/profile#saved-experience-heading', icon: 'check', title: c('Confirma tu primera experiencia', 'Confirm your first experience'), detail: summary.pendingFacts === 1 ? c('Tienes 1 dato por confirmar esperando tu revisión.', 'You have 1 detail to confirm waiting for review.') : c(`Tienes ${summary.pendingFacts} datos por confirmar esperando tu revisión.`, `You have ${summary.pendingFacts} details to confirm waiting for review.`) }
      : { key: 'first-fact', href: '/profile#experience', icon: 'plus', title: c('Añade tu primera experiencia o logro', 'Add your first experience or achievement'), detail: c('Un logro o experiencia que puedas respaldar. Nada se usa hasta que lo apruebes.', 'An achievement or experience you can stand behind. Nothing is used until you approve it.') });
    else if (summary.pendingFacts > 0) steps.push({ key: 'facts', href: '/profile#saved-experience-heading', icon: 'user', title: summary.pendingFacts === 1 ? c('Revisa 1 dato por confirmar', 'Review 1 detail to confirm') : c(`Revisa ${summary.pendingFacts} datos por confirmar`, `Review ${summary.pendingFacts} details to confirm`), detail: c('Nada se usa en tus documentos hasta que lo apruebes.', 'Nothing is used in your documents until you approve it.') });
    if (summary.unansweredItems > 0) steps.push({ key: 'answers', href: '/profile', icon: 'file', title: summary.unansweredItems === 1 ? c('Responde 1 pregunta pendiente', 'Answer 1 open question') : c(`Responde ${summary.unansweredItems} preguntas pendientes`, `Answer ${summary.unansweredItems} open questions`), detail: c('Son datos que solo tú puedes confirmar.', 'Only you can confirm these details.') });
    if (needsReview > 0) steps.push({ key: 'applications', href: '/applications', icon: 'briefcase', title: needsReview === 1 ? c('1 solicitud necesita revisión', '1 application needs review') : c(`${needsReview} solicitudes necesitan revisión`, `${needsReview} applications need review`), detail: c('Confirma su estado para mantener el seguimiento al día.', 'Confirm their status to keep your tracker accurate.') });
    if (summary.savedSearchCount === 0) steps.unshift({ key: 'first-job', href: '/searches', icon: 'search', title: c('Encuentra ofertas automáticamente', 'Find jobs automatically'), detail: c('Indica un puesto o una empresa. Guardaremos las coincidencias y repetiremos tu búsqueda con la frecuencia que elijas.', 'Enter a role or company. We will save matches and repeat your search at your chosen interval.') });
    if (summary.savedSearchCount > 0 && summary.totalJobs === 0) steps.unshift({ key: 'adjust-search', href: '/searches', icon: 'search', title: summary.activeSearchCount === 0 ? c('Reanuda una búsqueda para encontrar ofertas', 'Resume a search to find jobs') : c('Revisa tu búsqueda para encontrar coincidencias', 'Review your search to find matches'), detail: c('Todavía no hay ofertas guardadas. Revisa el estado de la consulta y prueba palabras más amplias si no hay coincidencias.', 'There are no saved jobs yet. Check the search status and try broader keywords if there are no matches.') });
    if (summary.savedSearchCount > 0 && summary.totalJobs > 0 && summary.activeApplications === 0) steps.unshift({ key: 'choose-job', href: '/searches', icon: 'search', title: c('Elige una oferta para preparar tu solicitud', 'Choose a job to prepare your application'), detail: c('Abre una oferta que te interese. Te pediremos solo los datos que falten para preparar tu CV.', 'Open a job that interests you. We will only ask for the details needed to prepare your resume.') });
    if (summary.approvedSourceCount === 0) steps.push(summary.boardCount
      ? { key: 'review-sources', href: '/boards', icon: 'building', title: c('Confirma la página de una empresa', 'Confirm a company careers page'), detail: c('Tienes fuentes añadidas, pero ninguna aprobada para buscar ofertas.', 'You have sources added, but none approved for job discovery yet.') }
      : { key: 'add-source', href: '/boards', icon: 'building', title: c('Opcional: sigue las ofertas de una empresa', 'Optional: follow a company’s jobs'), detail: c('Para recibir ofertas de empresas concretas. Puedes hacerlo más adelante.', 'To pull in jobs from specific companies. You can do this later.') });
  }

  const primaryStep = steps.find((step) => !['add-source', 'review-sources', 'answers', 'preferences'].includes(step.key));

  const inProgress = searches.some((search) => {
    const status = search.latestRun?.status ?? search.lastRunStatus ?? '';
    return ['QUEUED', 'RUNNING'].includes(status) || (status === 'PARTIAL' && search.latestRun?.finishedAt === null);
  });
  const inboxCount = inbox?.total ?? 0;
  const sourceError = searches.some((search) => ['FAILED'].includes(search.latestRun?.status ?? search.lastRunStatus ?? '') || (search.latestRun?.status === 'PARTIAL' && Boolean(search.latestRun.finishedAt)) || search.latestRun?.sources.some((source) => ['FAILED', 'ERROR'].includes(source.status.toUpperCase())));
  const nextSearchAt = searches.filter((search) => search.enabled && search.nextRunAt).map((search) => search.nextRunAt!).sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  const pausedSearches = searches.filter((search) => !search.enabled).length;
  const inboxReady = Boolean(inbox || searches.length || inboxError);
  const dailyAction = pendingResumes > 0
    ? { href: '/documents?view=saved', title: pendingResumes === 1 ? c('Revisa 1 CV preparado', 'Review 1 prepared resume') : c(`Revisa ${pendingResumes} CV preparados`, `Review ${pendingResumes} prepared resumes`), detail: c('Lee el CV y aprueba la versión que quieras conservar.', 'Read the resume and approve the version you want to keep.'), button: c('Revisar CV', 'Review resumes') }
    : inbox && inbox.total > 0
      ? { href: '/searches?search=all&view=new', title: inbox.total === 1 ? c('Tienes 1 oferta nueva', 'You have 1 new job') : c(`Tienes ${inbox.total} ofertas nuevas`, `You have ${inbox.total} new jobs`), detail: c('Revisa las novedades; tu búsqueda y los enlaces a las fuentes se conservan.', 'Review new arrivals; your search context and source links are preserved.'), button: c('Revisar ofertas nuevas', 'Review new jobs') }
      : inProgress
        ? { href: '/searches?search=all&view=new', title: c('Tus fuentes siguen buscando', 'Your sources are still searching'), detail: c('Las ofertas aparecerán aquí cuando lleguen. No indicamos cero resultados mientras la consulta sigue en curso.', 'New jobs will appear here as sources respond. We do not show an empty result while a search is still running.'), button: c('Ver progreso', 'View progress') }
        : sourceError
          ? { href: '/searches?search=all&view=all', title: c('Una fuente no respondió', 'A job source did not respond'), detail: c('Conservamos las ofertas anteriores. Revisa los errores y la cobertura de cada búsqueda.', 'Previous jobs are preserved. Check each search for source errors and coverage.'), button: c('Revisar búsquedas', 'Review searches') }
          : searches.length > 0 && pausedSearches === searches.length
            ? { href: '/searches?search=all&view=all', title: c('Tus búsquedas están en pausa', 'Your searches are paused'), detail: c(`${pausedSearches} búsqueda${pausedSearches === 1 ? '' : 's'} pausada${pausedSearches === 1 ? '' : 's'}. Puedes reanudarlas desde sus tarjetas.`, `${pausedSearches} paused search${pausedSearches === 1 ? '' : 'es'}. You can resume them from their cards.`), button: c('Ver búsquedas', 'Open searches') }
            : searches.length > 0 && inbox?.total === 0
              ? { href: '/searches?search=all&view=all', title: c('Estás al día', 'You are up to date'), detail: nextSearchAt ? c(`Próxima consulta: ${dateTime(nextSearchAt, locale)}.`, `Next search: ${dateTime(nextSearchAt, locale)}.`) : c('No hay novedades pendientes en tus búsquedas.', 'There are no unread arrivals in your searches.'), button: c('Ver todas las ofertas', 'View all jobs') }
              : primaryStep
                ? { href: primaryStep.href, title: primaryStep.title, detail: primaryStep.detail, button: primaryStep.href === '/searches' ? c('Buscar ofertas', 'Find jobs') : primaryStep.href.startsWith('/profile') ? c('Completar perfil', 'Complete profile') : c('Continuar', 'Continue') }
                : { href: '/searches', title: c('Tu búsqueda, hoy', 'Your search today'), detail: c('Guarda una búsqueda para empezar a recibir ofertas.', 'Save a search to start receiving jobs.'), button: c('Crear búsqueda', 'Create a search') };
  const returnToInbox = '/searches?search=all&view=new&sort=relevance&offset=0';

  const metrics = [
    { key: 'jobs', label: c('Ofertas guardadas', 'Saved jobs'), value: summary?.totalJobs, href: '/jobs' },
    { key: 'active', label: c('Solicitudes activas', 'Active applications'), value: summary?.activeApplications, href: '/applications' },
    { key: 'facts', label: c('Datos confirmados', 'Confirmed profile details'), value: completion?.approvedFactCount, href: '/profile' },
    { key: 'searches', label: c('Búsquedas activas', 'Active searches'), value: summary?.activeSearchCount, href: '/searches' },
  ];

  return <WorkspaceGate><AppShell>
    <PageHeader
      action={<ButtonLink href="/start" variant="secondary">{c('Guía para empezar', 'Getting started')}</ButtonLink>}
      eyebrow={t('Resumen')}
      title={c('Tu búsqueda, hoy', 'Your search today')}
      description={c('Encuentra ofertas, prepara candidaturas con tus datos confirmados y sigue cada postulación.', 'Find jobs, prepare applications from your confirmed details, and track each application.')}
    />
    {error && <Notice tone="error">{error}</Notice>}

    {(summary || inboxReady) && <Card className="getting-started">
      <div className="eyebrow">{c('TU BANDEJA DE HOY', 'TODAY’S JOB INBOX')}</div>
      <h2>{dailyAction.title}</h2>
      <p>{dailyAction.detail}</p>
      <ButtonLink href={dailyAction.href}>{dailyAction.button} <Icon name="arrow" size={18}/></ButtonLink>
      <div role="status" aria-live="polite" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', marginTop: 18 }}>
        <span><strong>{inbox?.total ?? '—'}</strong> {c('ofertas nuevas por revisar', 'new jobs to review')}</span>
        <span><strong>{pendingResumes}</strong> {c('CV pendientes de revisión', 'resumes waiting for review')}</span>
      </div>
      {inboxError && <p className="muted-label">{c('No pudimos actualizar todos los datos de la bandeja. Puedes abrir tus búsquedas para comprobar el estado.', 'We could not update all inbox details. Open your searches to check their status.')}</p>}
      {inbox?.items.length ? <ul className="row-list" aria-label={c('Ofertas nuevas', 'New jobs')} style={{ marginTop: 18 }}>
        {inbox.items.slice(0, 3).map((job) => <li key={job.id}><Link href={`/jobs/${job.id}?returnTo=${encodeURIComponent(returnToInbox)}`} className="list-row">
          <span className="company-monogram" aria-hidden="true">{job.company.slice(0, 1)}</span>
          <span className="row-main"><strong>{job.title}</strong><span>{job.company} · {job.location ?? t('Location to be confirmed')}</span></span>
          <Icon name="arrow" size={18}/>
        </Link>{job.sources?.[0] && <small>{c('Fuente: ', 'Source: ')}<a href={job.sources[0].url} target="_blank" rel="noopener noreferrer">{job.sources[0].provider}</a></small>}</li>)}
      </ul> : inbox && inbox.total === 0 && searches.length > 0 && <p className="muted-label">{inProgress ? c('Las consultas siguen en curso; todavía no mostramos un estado vacío.', 'Searches are still running, so we are not showing an empty state.') : sourceError ? c('Conservamos las ofertas anteriores mientras revisas el estado de las fuentes.', 'Previous jobs are preserved while you check source status.') : searches.every((search) => !search.enabled) ? c('Las consultas automáticas están pausadas. Puedes reanudarlas desde una tarjeta de búsqueda.', 'Automatic searches are paused. You can resume one from its search card.') : c('Estás al día. Mostramos la próxima consulta en tu lista de búsquedas.', 'You are up to date. Your next scheduled check appears on the search list.')}</p>}
      <p className="muted-label">{c('Puedes buscar empleo sin completar tu perfil. Tus datos confirmados se necesitan para preparar candidaturas.', 'You can search for jobs before completing your profile. Confirmed details are needed to prepare applications.')}</p>
      {inboxCount > 3 && <Link href="/searches?search=all&view=new" className="text-link">{c(`Ver las ${inboxCount} ofertas nuevas`, `See all ${inboxCount} new jobs`)} <Icon name="arrow" size={16}/></Link>}
      {pendingResumes > 0 && inbox && inbox.total > 0 && <Link href="/searches?search=all&view=new" className="text-link" style={{ display: 'block', marginTop: 10 }}>{c('También hay ofertas nuevas por revisar', 'There are also new jobs to review')} <Icon name="arrow" size={16}/></Link>}
    </Card>}
    <section className="search-guide" aria-labelledby="search-guide-heading">
      <h2 id="search-guide-heading">{c('Cómo usar Career Stack', 'How to use Career Stack')}</h2>
      <ol className="journey-grid">
        {[
          { href: '/searches', title: c('Busca empleo', 'Find jobs'), detail: c('Indica un puesto o empresa. La app guardará ofertas y repetirá la búsqueda por ti.', 'Enter a role or company. The app saves jobs and repeats the search for you.') },
          { href: '/searches', title: c('Prepara tu solicitud', 'Prepare your application'), detail: c('Abre una oferta que te interese. Completa lo que falte y deja que la app prepare un CV.', 'Open a job that interests you. Add any missing details and let the app prepare a resume.') },
          { href: '/applications?view=review', title: c('Revisa y envía', 'Review and submit'), detail: c('Revisa el CV y autoriza el envío cuando esté disponible, o continúa en la página de la empresa.', 'Review the resume and authorize submission where supported, or continue on the employer’s website.') },
        ].map((step, index) => <li key={step.title}><Link href={step.href}><span className="step-badge" aria-hidden="true">{index + 1}</span><strong>{step.title}</strong><span>{step.detail}</span></Link></li>)}
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

    <DiscoveryPanel compact/>
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
          {job.fitScore !== null && <span className="row-score">{job.provisional ? c('Encaje por valorar', 'Fit not yet assessed') : c(`Encaje ${job.fitScore}`, `Fit ${job.fitScore}`)}</span>}
          <Tag tone={job.eligibility === 'PASS' ? 'green' : job.eligibility === 'FAIL' ? 'red' : 'amber'}>{labelFor.eligibility(job.eligibility, locale)}</Tag>
        </Link>{job.searchSources?.map((source) => <small key={source.url}>{c('Fuente: ', 'Source: ')}<a href={source.url} target="_blank" rel="noopener noreferrer">{source.provider === 'remotive' ? 'Remotive' : 'Arbeitnow'}</a></small>)}</li>)}</ul>
          : !loading && <Empty title={t('Tu lista aún está en blanco')} detail={c('Guarda una búsqueda para encontrar ofertas de las fuentes integradas.', 'Save a search to find jobs from the integrated sources.')} action={<Link href="/searches" className="text-link">{c('Ir a buscar empleo', 'Find jobs')} <Icon name="arrow" size={16}/></Link>}/>}
        {summary && summary.totalJobs > summary.recentJobs.length && <p className="panel-foot">{c(`Mostrando ${summary.recentJobs.length} de ${summary.totalJobs} ofertas guardadas`, `Showing ${summary.recentJobs.length} of ${summary.totalJobs} saved jobs`)}</p>}
      </Card>
    </div>
    </details>
  </AppShell></WorkspaceGate>;
}
