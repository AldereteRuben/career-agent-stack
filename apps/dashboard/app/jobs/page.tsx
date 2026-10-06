'use client';

import { useDisclosureFocus } from '@/lib/disclosure-focus';

import { useSessionDraft, stringDraft } from '@/lib/session-draft';
import { useLocale } from '@/lib/i18n';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Empty, Field, Icon, Notice, SelectField, Tag, TextareaField } from '@/components/ui';
import { api, ApiError, errorMessage, formatDate } from '@/lib/api';
import { labelFor } from '@/lib/labels';
import styles from './jobs.module.css';

type Job = { searchSources?: Array<{ provider: string; url: string }>; discoveredAt: string | null; seenAt: string | null; id: string; company: string; title: string; location: string | null; canonicalUrl: string | null; fitScore: number | null; evidenceCoverage: number | null; eligibility: string; reasons: string[]; shortlistDecision: string; availability: string; createdAt: string; provisional?: boolean; match?: { matchedSkills: string[]; missingSkills: string[] } | null };
type JobPage = { items: Job[]; total: number };
const pageFingerprint = (result: JobPage) => JSON.stringify(result);
/** Each list scope reads as its own destination: saved jobs and archived jobs are not just filters of the found list. */
const scopeCopy = (scope: string, c: (es: string, en: string) => string) => scope === 'favorites' ? {
  eyebrow: c('GUARDADAS', 'SAVED JOBS'), title: c('Guardadas', 'Saved jobs'),
  description: c('Las ofertas que guardaste para decidir con calma. Abre una y elige Preparar mi solicitud cuando quieras postular.', 'Jobs you saved to decide on calmly. Open one and choose Prepare my application when you want to apply.'),
  count: (n: number) => n === 1 ? c('oferta guardada', 'saved job') : c('ofertas guardadas', 'saved jobs'),
} : scope === 'archived' ? {
  eyebrow: c('ARCHIVADAS', 'ARCHIVED'), title: c('Ofertas archivadas', 'Archived jobs'),
  description: c('Ofertas que apartaste. No aparecen en las demás listas y puedes restaurarlas desde sus detalles.', 'Jobs you set aside. They do not appear in the other lists, and you can restore them from their details.'),
  count: (n: number) => n === 1 ? c('oferta archivada', 'archived job') : c('ofertas archivadas', 'archived jobs'),
} : scope === 'new' ? {
  eyebrow: c('NUEVAS', 'NEW'), title: c('Nuevas por revisar', 'New to review'),
  description: c('Ofertas recién encontradas por tu búsqueda automática que todavía no has revisado.', 'Jobs your automatic search found recently that you have not reviewed yet.'),
  count: (n: number) => n === 1 ? c('oferta nueva', 'new job') : c('ofertas nuevas', 'new jobs'),
} : {
  eyebrow: c('DESCUBRIR CON CRITERIO', 'DISCOVER WITH INTENTION'), title: c('Ofertas encontradas', 'Found jobs'),
  description: c('Todo lo que encontró tu búsqueda automática, más las ofertas que añadiste tú, salvo las archivadas. Guarda las que te interesen para tenerlas en Guardadas.', 'Everything your automatic search found, plus jobs you added yourself, except archived ones. Save the ones you like to keep them under Saved jobs.'),
  count: (n: number) => n === 1 ? c('oferta encontrada', 'job found') : c('ofertas encontradas', 'jobs found'),
};
function JobsView() {
  const { t, locale } = useLocale(); const c = (es: string, en: string) => locale === 'es' ? es : en;
  const router = useRouter(); const params = useSearchParams();
  const urlQuery = params.get('q') ?? ''; const scope = params.get('scope') ?? 'active'; const availability = params.get('availability') ?? ''; const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const paramsString = params.toString();
  const jobHref = (id: string) => `/jobs/${id}?returnTo=${encodeURIComponent(`/jobs${params.size ? `?${params}` : ''}`)}`;
  const [total, setTotal] = useState(0);
  const navigate = (patch: Record<string, string>) => { const next = new URLSearchParams(params.toString()); for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); } router.push(`/jobs${next.size ? `?${next}` : ''}`, { scroll: false }); };
  const draft = useSessionDraft('job-import', { company: '', title: '', location: '', url: '', description: '' }, (value): value is { company: string; title: string; location: string; url: string; description: string } => stringDraft(value) && ['company', 'title', 'location', 'url', 'description'].every((key) => typeof value[key] === 'string'));
  const { company, title, location, url, description } = draft.value;
  const setCompany = (company: string) => draft.update((d) => ({ ...d, company })); const setTitle = (title: string) => draft.update((d) => ({ ...d, title })); const setLocation = (location: string) => draft.update((d) => ({ ...d, location })); const setUrl = (url: string) => draft.update((d) => ({ ...d, url })); const setDescription = (description: string) => draft.update((d) => ({ ...d, description }));
  const hasDraft = Object.values(draft.value).some(Boolean);
  const [jobs, setJobs] = useState<Job[]>([]); const [query, setQuery] = useState(''); const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading'); const [searchedQuery, setSearchedQuery] = useState(''); const searchRequest = useRef(0); const [open, setOpen] = useState(false);
  const formHeading = useDisclosureFocus(open); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [duplicateId, setDuplicateId] = useState('');
  const [hasUpdates, setHasUpdates] = useState(false); const [updatesError, setUpdatesError] = useState<unknown>(null); const [pollRevision, setPollRevision] = useState(0);
  const baseline = useRef(''); const focusResults = useRef(false); const resultsHeading = useRef<HTMLHeadingElement>(null);
  const listQuery = new URLSearchParams({ q: urlQuery, scope, availability, page: String(page), paged: 'true' }).toString();
  const load = useCallback(async () => {
    const ticket = ++searchRequest.current; setLoadState('loading'); setError(''); setUpdatesError(null); setHasUpdates(false); baseline.current = '';
    try {
      const result = await api<JobPage>(`/jobs?${listQuery}`);
      if (ticket !== searchRequest.current) return;
      const lastPage = Math.max(1, Math.ceil(result.total / 24));
      if (page > lastPage) {
        const next = new URLSearchParams(paramsString);
        if (lastPage === 1) next.delete('page'); else next.set('page', String(lastPage));
        router.replace(`/jobs${next.size ? `?${next}` : ''}`, { scroll: false });
        return;
      }
      baseline.current = pageFingerprint(result); setJobs(result.items); setTotal(result.total); setSearchedQuery(urlQuery); setLoadState('ready');
    } catch (err) { if (ticket === searchRequest.current) { setError(errorMessage(err)); setLoadState('error'); } }
  }, [listQuery, page, paramsString, router, urlQuery]);
  const reload = useRef(load);
  useEffect(() => { reload.current = load; setQuery(urlQuery); void load(); return () => { ++searchRequest.current; }; }, [load, urlQuery]);
  // Discover updates without replacing the list under the reader's pointer or keyboard focus.
  useEffect(() => {
    if (scope !== 'new' || loadState !== 'ready') return;
    let disposed = false; let pending = false;
    const check = async () => {
      if (pending || document.hidden || !baseline.current) return;
      pending = true;
      try {
        const result = await api<JobPage>(`/jobs?${listQuery}`);
        if (!disposed) { setHasUpdates(pageFingerprint(result) !== baseline.current); setUpdatesError(null); }
      } catch (err) { if (!disposed) setUpdatesError(err); }
      finally { pending = false; }
    };
    const timer = window.setInterval(() => void check(), 15_000);
    const visible = () => void check(); document.addEventListener('visibilitychange', visible); window.addEventListener('focus', visible);
    void check();
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); };
  }, [scope, loadState, listQuery, pollRevision]);
  useEffect(() => {
    if (loadState === 'ready' && focusResults.current) { focusResults.current = false; resultsHeading.current?.focus({ preventScroll: true }); }
  }, [loadState]);
  const search = (event: FormEvent) => { event.preventDefault(); if (query === urlQuery && page === 1) void load(); else navigate({ q: query, page: '' }); };
  const importJob = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); setMessage(''); setDuplicateId(''); try { await api<Job>('/jobs/import', { method: 'POST', body: JSON.stringify({ company, title, location: location || null, jobUrl: url, description: description || null }) }); setMessage(c('Oferta añadida. Abre sus detalles para preparar tu solicitud.', 'Job added. Open its details to prepare your application.')); setCompany(''); setTitle(''); setLocation(''); setUrl(''); setDescription(''); setOpen(false); setQuery(''); if (!urlQuery && scope === 'active' && !availability && page === 1) await load(); else navigate({ q: '', scope: 'active', availability: '', page: '' }); } catch (err) { setError(errorMessage(err)); if (err instanceof ApiError && err.code === 'JOB_ALREADY_EXISTS' && err.detail) setDuplicateId(err.detail); } finally { setBusy(false); } };
  const shortlist = async (job: Job) => { setBusy(true); try { await api(`/jobs/${job.id}/shortlist`, { method: 'POST', body: JSON.stringify({ decision: job.shortlistDecision === 'SHORTLISTED' ? 'UNREVIEWED' : 'SHORTLISTED' }) }); await reload.current(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } };
  const copy = scopeCopy(scope, c);
  // Until the list is ready the total is a placeholder 0, which must not read as "no jobs".
  const countText = loadState === 'ready' ? `${total} ${copy.count(total)}` : loadState === 'loading' ? c('Cargando…', 'Loading…') : c('No se pudo cargar', 'Could not load');
  const unfiltered = !searchedQuery && !availability && page === 1;
  const addManually = <Button variant="quiet" onClick={() => setOpen(true)}>{c('Añadir una oferta a mano', 'Add a job manually')}</Button>;
  return <WorkspaceGate><AppShell>
    <PageHeader eyebrow={copy.eyebrow} title={copy.title} description={copy.description} action={<div className={styles.headerActions}><Link className="button button-secondary" href="/searches">{c('Buscar empleo', 'Find jobs')}</Link><Button variant="quiet" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="plus" size={16}/>{t(open ? 'Cerrar formulario' : 'Añadir oferta')}</Button></div>}/>
    {error && <Notice tone="error">{error}{duplicateId && <> <Link href={`/jobs/${duplicateId}`}>{t('Ver la oferta guardada')}</Link></>}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    {hasDraft && <Notice tone={draft.storageFailed ? 'warning' : 'info'} actions={<><Button variant="quiet" disabled={busy} onClick={() => setOpen(true)}>{locale === 'es' ? 'Continuar borrador' : 'Continue draft'}</Button><Button variant="quiet" disabled={busy} onClick={() => { if (window.confirm(locale === 'es' ? '¿Descartar el borrador de esta oferta?' : 'Discard this job draft?')) draft.update({ company: '', title: '', location: '', url: '', description: '' }); }}>{locale === 'es' ? 'Descartar borrador' : 'Discard draft'}</Button></>}>{draft.storageFailed ? (locale === 'es' ? 'No se pudo conservar el borrador. Guarda o descarta el texto antes de salir.' : 'The draft could not be preserved. Save or discard it before leaving.') : (locale === 'es' ? 'Borrador conservado en esta pestaña hasta que cierres sesión. Todavía no se ha añadido la oferta.' : 'Draft kept in this tab until you sign out. The job has not been added yet.')}</Notice>}
    {open && <Card className="import-card"><div className="form-heading"><div><span className="step-badge">{t("＋")}</span><div><h2 ref={formHeading} tabIndex={-1}>{t("Guardar oferta a mano")}</h2><p>{t("Pega el enlace y completa los datos de la oferta.")}</p></div></div></div><form onSubmit={importJob} className="form-grid"><fieldset className="draft-fields" disabled={busy || !draft.ready}><Field label={t("Empresa")} value={company} onChange={(e) => setCompany(e.target.value)} required/><Field label={t("Puesto")} value={title} onChange={(e) => setTitle(e.target.value)} required/><Field label={t("Ubicación")} value={location} onChange={(e) => setLocation(e.target.value)} placeholder={t("Si aparece en el anuncio")}/><Field label={t("URL oficial de la oferta")} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("https://...")} required hint={t("Las URL de LinkedIn se guardan solo como texto y no se abren.")}/><div className="field-span"><TextareaField label={t("Descripción (opcional)")} value={description} onChange={(e) => setDescription(e.target.value)} rows={5} placeholder={t("Pega aquí el texto del anuncio para explicar el encaje.")} hint={t("El enlace no importa la descripción. Pégala aquí para comparar los requisitos con tu perfil.")}/></div><div className="form-submit"><Button type="submit" disabled={busy || !draft.ready}>{t(busy ? 'Guardando…' : 'Guardar oferta')}</Button></div></fieldset></form></Card>}
    <Card className="jobs-toolbar"><form onSubmit={search} className="search-form"><span className="search-icon"><Icon name="search"/></span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={locale === 'es' ? 'Buscar por puesto o empresa…' : 'Search by role or company…'} aria-label={t("Buscar ofertas")}/><Button variant="secondary" type="submit">{t("Buscar")}</Button></form><div className="job-filters"><SelectField label={locale === 'es' ? 'Mostrar ofertas' : 'Show jobs'} value={scope} onChange={(event) => navigate({ scope: event.target.value, page: '' })}><option value="new">{locale === 'es' ? 'Nuevas por revisar' : 'New to review'}</option><option value="active">{c('Todas las encontradas', 'All found jobs')}</option><option value="favorites">{locale === 'es' ? 'Guardadas' : 'Saved'}</option><option value="archived">{locale === 'es' ? 'Archivadas' : 'Archived'}</option></SelectField><SelectField label={locale === 'es' ? 'Disponibilidad' : 'Availability'} value={availability} onChange={(event) => navigate({ availability: event.target.value, page: '' })}><option value="">{locale === 'es' ? 'Cualquiera' : 'Any'}</option>{['OPEN', 'POSSIBLY_CLOSED', 'CLOSED', 'UNKNOWN'].map((value) => <option key={value} value={value}>{labelFor.availability(value, locale)}</option>)}</SelectField></div><div className="coverage-line"><span className="coverage-dot"/>{countText} <span>{t("·")}</span> {scope === 'favorites' ? c('Elegidas por ti', 'Chosen by you') : c('De tus búsquedas y empresas', 'From your searches and companies')}</div></Card>
    <h2 ref={resultsHeading} tabIndex={-1} className="sr-only">{`${copy.title}: ${countText}`}</h2>
    {scope === 'new' && Boolean(updatesError) && <Notice tone="warning" actions={<Button variant="quiet" onClick={() => setPollRevision((value) => value + 1)}>{locale === 'es' ? 'Reintentar' : 'Try again'}</Button>}>{locale === 'es' ? 'No pudimos comprobar si hay novedades. Tus resultados siguen disponibles.' : 'Could not check for updates. Your results are still available.'} {errorMessage(updatesError)}</Notice>}
    {scope === 'new' && hasUpdates && <Notice actions={<Button variant="secondary" onClick={() => { focusResults.current = true; void load(); }}>{locale === 'es' ? 'Actualizar resultados' : 'Update results'}</Button>}>{locale === 'es' ? 'Hay cambios en tus ofertas por revisar. Actualiza cuando quieras; conservaremos tus filtros.' : 'Your jobs to review have changed. Update when ready; your filters will be kept.'}</Notice>}
    {scope === 'new' && <Notice>{locale === 'es' ? 'Ofertas encontradas en tus búsquedas y empresas, ordenadas por encaje. Abre una oferta y márcala como revisada cuando termines. Todas seguirán disponibles en Todas las encontradas.' : 'Jobs found by your searches and companies, ranked by fit. Open a job and mark it as reviewed when finished. All remain available under All found jobs.'} <Link href="/searches">{locale === 'es' ? 'Configurar búsqueda automática' : 'Manage automatic search'}</Link></Notice>}
    {loadState === 'loading' ? <Notice>{locale === 'es' ? 'Cargando ofertas…' : 'Loading jobs…'}</Notice> : loadState === 'error' ? <Button variant="secondary" onClick={() => void load()}>{locale === 'es' ? 'Reintentar' : 'Try again'}</Button> : jobs.length ? <div className="jobs-grid">{jobs.map((job) => <Card className="job-card" key={job.id}><div className="job-card-top"><div className="company-monogram large">{job.company.slice(0, 1)}</div><button className={`bookmark ${job.shortlistDecision === 'SHORTLISTED' ? 'bookmark-active' : ''}`} disabled={busy || job.shortlistDecision === 'ARCHIVED'} onClick={() => void shortlist(job)} aria-pressed={job.shortlistDecision === 'SHORTLISTED'} aria-label={job.shortlistDecision === 'SHORTLISTED' ? (locale === 'es' ? 'Quitar de guardadas' : 'Unsave job') : (locale === 'es' ? 'Guardar oferta' : 'Save job')}>{t("⌑")}</button></div><div className="job-card-company">{job.company} {job.discoveredAt && !job.seenAt && job.shortlistDecision === 'UNREVIEWED' && <Tag tone="blue">{locale === 'es' ? 'NUEVA' : 'NEW'}</Tag>}</div><h2><Link href={jobHref(job.id)}>{job.title}</Link></h2><p className="job-location">{t("⌖")} {job.location ?? t('Ubicación por confirmar')}</p>{Boolean(job.searchSources?.length) && <p className="muted-label">{locale === 'es' ? 'Fuente: ' : 'Source: '}{job.searchSources?.map((source, index) => <span key={source.url}>{index > 0 ? ' · ' : ''}<a href={source.url} target="_blank" rel="noopener noreferrer">{source.provider === 'remotive' ? 'Remotive' : source.provider === 'himalayas' ? 'Himalayas' : 'Arbeitnow'}</a></span>)}</p>}<div className="job-card-metrics"><div><span>{t("ENCAJE BASADO EN EVIDENCIA")}</span><strong>{job.fitScore === null || job.provisional ? '—' : `${job.fitScore}`}{job.fitScore !== null && !job.provisional && <small>{t("/100")}</small>}</strong><small>{job.evidenceCoverage ?? 0}{t("% de cobertura")}</small>{job.match && job.match.matchedSkills.length + job.match.missingSkills.length > 0 && <small>{t('{matched} de {total} habilidades con evidencia', { matched: job.match.matchedSkills.length, total: job.match.matchedSkills.length + job.match.missingSkills.length })}</small>}{job.provisional && <small>{locale === 'es' ? 'Faltan datos para valorar' : 'More information needed'}</small>}</div><Tag tone={job.eligibility === 'PASS' ? 'green' : job.eligibility === 'FAIL' ? 'red' : 'amber'}>{labelFor.eligibility(job.eligibility, locale)}</Tag></div><div className="job-card-foot"><span>{t("Añadida el")} {formatDate(job.createdAt)}</span><Link href={jobHref(job.id)} className="card-link">{t("Ver detalles")} <Icon name="arrow" size={14}/></Link></div></Card>)}</div> : scope === 'favorites' && unfiltered ? <Card className="jobs-empty"><Empty title={c('Todavía no has guardado ofertas', 'You have not saved any jobs yet')} detail={c('Tu búsqueda automática encuentra ofertas por ti. Cuando una te interese, elige Guardar oferta y aparecerá aquí.', 'Your automatic search finds jobs for you. When one interests you, choose Save job and it appears here.')} action={<div className={styles.emptyActions}><Link href="/searches" className="button button-primary">{c('Buscar empleo', 'Find jobs')}</Link><Link href="/jobs" className="button button-quiet">{c('Ver ofertas encontradas', 'See found jobs')}</Link></div>}/></Card>
      : scope === 'archived' && unfiltered ? <Card className="jobs-empty"><Empty title={c('No hay ofertas archivadas', 'No archived jobs')} detail={c('Las ofertas que archives aparecerán aquí y podrás restaurarlas cuando quieras.', 'Jobs you archive appear here, and you can restore them whenever you like.')} action={<Link href="/jobs" className="button button-secondary">{c('Ver ofertas encontradas', 'See found jobs')}</Link>}/></Card>
      : scope === 'new' && unfiltered ? <Card className="jobs-empty"><Empty title={locale === 'es' ? 'No tienes ofertas nuevas por revisar' : 'No new jobs to review'} detail={locale === 'es' ? 'Las próximas coincidencias de tus búsquedas y empresas aparecerán aquí. Las que ya revisaste siguen en Todas las encontradas.' : 'The next matches from your searches and companies will appear here. Jobs you already reviewed remain under All found jobs.'} action={<Link href="/searches" className="button button-secondary">{locale === 'es' ? 'Ver búsqueda automática' : 'View automatic search'}</Link>}/></Card> : searchedQuery || scope !== 'active' || availability || page > 1 ? <Card className="jobs-empty"><Empty title={locale === 'es' ? 'No hay ofertas que coincidan' : 'No matching jobs'} detail={locale === 'es' ? 'Prueba con otro puesto o borra la búsqueda para ver todas tus ofertas.' : 'Try another role or clear the search to see all your jobs.'} action={<Button variant="secondary" onClick={() => { setQuery(''); navigate({ q: '', scope: 'active', availability: '', page: '' }); }}>{locale === 'es' ? 'Ver todas las ofertas' : 'Show all jobs'}</Button>}/></Card> : <Card className="jobs-empty"><Empty title={t("Aún no hay ofertas")} detail={c('Crea o ajusta tu búsqueda automática y las coincidencias aparecerán aquí para que prepares tu solicitud. Si ya tienes el enlace de una oferta, también puedes añadirla a mano.', 'Create or adjust your automatic search and matches will appear here so you can prepare your application. If you already have a link to a job, you can also add it manually.')} action={<div className={styles.emptyActions}><Link href="/searches" className="button button-primary">{c('Buscar empleo', 'Find jobs')}</Link>{addManually}</div>}/></Card>}
    {loadState === 'ready' && (total > 24 || page > 1) && <nav className="pagination" aria-label={locale === 'es' ? 'Páginas de ofertas' : 'Job pages'}><Button variant="secondary" disabled={page <= 1} onClick={() => navigate({ page: String(page - 1) })}>{locale === 'es' ? 'Página anterior' : 'Previous page'}</Button><span aria-live="polite">{locale === 'es' ? `Página ${page} de ${Math.max(1, Math.ceil(total / 24))}` : `Page ${page} of ${Math.max(1, Math.ceil(total / 24))}`}</span><Button variant="secondary" disabled={page * 24 >= total} onClick={() => navigate({ page: String(page + 1) })}>{locale === 'es' ? 'Página siguiente' : 'Next page'}</Button></nav>}
    <div className="callout-row"><Icon name="shield" size={17}/><span><strong>{(locale === 'es' ? 'Tú decides cuándo aplicar.' : 'You decide when to apply.')}</strong> {locale === 'es' ? 'Buscar ofertas no envía solicitudes. Autoriza cada envío por separado desde Mis solicitudes.' : 'Finding jobs does not submit applications. Authorize each submission separately from My applications.'}</span><Link href="/boards">{t("Seguir empresas")} <Icon name="arrow" size={14}/></Link></div>
  </AppShell></WorkspaceGate>;
}

export default function JobsPage() { return <Suspense><JobsView/></Suspense>; }
