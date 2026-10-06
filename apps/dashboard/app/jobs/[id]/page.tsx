'use client';

import { ApplicationPreparationAction } from '@/components/application-preparation';
import { AiDraftAction, useAiAvailable } from '@/components/ai/draft-action';
import { AiAutomationPanel } from '@/components/ai/automation';
import { useLocale } from '@/lib/i18n';
import Link from 'next/link';
import { searchOrigin, withSearchOrigin } from '@/lib/search-origin';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell, PageHeader, WorkspaceGate, DetailTitle } from '@/components/shell';
import { Button, Card, Icon, Notice, Tag } from '@/components/ui';
import { api, errorMessage, formatDate } from '@/lib/api';
import { copy, applicationStage, labelFor } from '@/lib/labels';
import styles from '../jobs.module.css';

type Match = { titleAlignment: number | null; matchedTargetTitle: string | null; matchedSkills: string[]; missingSkills: string[]; approvedFactCount: number; targetTitles: string[]; profileRevision: number; notes: string[] };
type Job = { discoveredAt: string | null; seenAt: string | null; id: string; title: string; company: string; location: string | null; canonicalUrl: string | null; fitScore: number | null; evidenceCoverage: number | null; eligibility: string; reasons: string[]; shortlistDecision: string; availability: string; createdAt: string; provisional?: boolean; match?: Match | null };
type Snapshot = { id: string; title: string; descriptionText: string | null; fetchedAt: string };
type JobApplication = { id: string; state: string; recruitmentStage?: string; updatedAt?: string };
type Detail = { searchSources?: Array<{ provider: string; url: string; postedAt: string | null; lastSeenAt: string }>; job: Job; snapshots: Snapshot[]; sources: Array<{ provider: string; region: string; tenant: string; sourcePostedAt: string | null; lastSeenAt: string; jobUrl: string; applyUrl: string | null }>; applications: JobApplication[] };

export default function JobDetailPage() {
  const { locale } = useLocale(); const c = copy(locale);
  const { id } = useParams<{ id: string }>(); const router = useRouter();
  const searchParams = useSearchParams(); const returnTo = searchOrigin(searchParams.get('returnTo'));
  const backHref = returnTo === '/jobs' || returnTo.startsWith('/jobs?') || returnTo === '/searches' || returnTo.startsWith('/searches?') ? returnTo : '/jobs';
  const [data, setData] = useState<Detail | null>(null); const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState<string | null>(null);
  const aiAvailable = useAiAvailable();
  const [helpRequested, setHelpRequested] = useState(false);
  const reviewContinuation = useRef<HTMLAnchorElement>(null); const focusAfterReview = useRef(false);
  const loadVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const next = await api<Detail>(`/jobs/${id}`);
      if (version !== loadVersion.current) return;
      setData(next); setLoadState('ready');
    } catch (err) {
      if (version !== loadVersion.current) return;
      setError(errorMessage(err)); setLoadState((current) => current === 'ready' ? 'ready' : 'error');
    }
  }, [id]);
  useEffect(() => {
    setData(null); setError(''); setMessage(''); setLoadState('loading');
    void load();
    return () => { loadVersion.current += 1; };
  }, [load]);
  const job = data?.job.id === id ? data.job : undefined; const snapshot = data?.snapshots[0]; const source = data?.sources[0];
  const existing = data?.applications.find((application) => application.state !== 'CANCELLED') ?? data?.applications[0];
  // Preparation stays the single primary next step until the application has moved past it.
  const canPrepare = !existing || ['DRAFT', 'PREPARING', 'REVIEW_REQUIRED', 'READY'].includes(existing.state);
  const uncertainSubmission = existing?.state === 'UNKNOWN' || existing?.state === 'IN_PROGRESS';
  const fitPending = !job || job.fitScore === null || Boolean(job.provisional);

  useEffect(() => {
    if (job?.seenAt && focusAfterReview.current) { focusAfterReview.current = false; reviewContinuation.current?.focus({ preventScroll: true }); }
  }, [job?.seenAt]);
  const helpFrame = useRef<number | null>(null);
  const focusHelp = useCallback((node: HTMLHeadingElement | null) => {
    if (helpFrame.current !== null) cancelAnimationFrame(helpFrame.current);
    if (!node || window.location.hash !== '#job-ai-assistance') return;
    helpFrame.current = requestAnimationFrame(() => {
      setHelpRequested(true); node.focus({ preventScroll: true }); node.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
  }, []);
  useEffect(() => {
    const followHash = () => focusHelp(document.getElementById('job-ai-assistance') as HTMLHeadingElement | null);
    window.addEventListener('hashchange', followHash);
    return () => { window.removeEventListener('hashchange', followHash); if (helpFrame.current !== null) cancelAnimationFrame(helpFrame.current); };
  }, [focusHelp]);
  const markReviewed = async (trigger: HTMLButtonElement) => {
    if (!job || busy) return;
    // A late initial read must never replace the result of this mutation.
    loadVersion.current += 1;
    setBusy('seen'); setError(''); setMessage('');
    try {
      await api(`/jobs/${job.id}/seen`, { method: 'POST', body: '{}' });
      focusAfterReview.current = document.activeElement === trigger || document.activeElement === document.body;
      setData((current) => current?.job.id === job.id ? { ...current, job: { ...current.job, seenAt: new Date().toISOString() } } : current);
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(null); }
  };

  const makeApplication = async () => {
    if (!job) return; setBusy('application'); setError('');
    try {
      // The API returns the existing row for this job when one exists, so a double click never creates duplicates.
      const created = await api<{ id: string }>('/applications', { method: 'POST', body: JSON.stringify({ jobId: job.id, company: job.company, role: job.title, location: job.location, canonicalUrl: job.canonicalUrl, state: 'DRAFT', notes: '' }) });
      router.push(withSearchOrigin(`/applications?id=${created.id}`, returnTo));
    } catch (err) { setError(errorMessage(err)); setBusy(null); }
  };
  const updateShortlist = async () => {
    if (!job) return; setBusy('shortlist'); setError(''); setMessage('');
    try { await api(`/jobs/${job.id}/shortlist`, { method: 'POST', body: JSON.stringify({ decision: job.shortlistDecision === 'SHORTLISTED' ? 'UNREVIEWED' : 'SHORTLISTED' }) }); await load(); setMessage(job.shortlistDecision === 'SHORTLISTED' ? c('Quitada de guardadas.', 'Removed from saved jobs.') : c('Oferta guardada.', 'Job saved.')); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(null); }
  };

  const archive = async () => {
    if (!job) return;
    const restoring = job.shortlistDecision === 'ARCHIVED';
    if (!restoring && !window.confirm(c('¿Archivar esta oferta? Podrás restaurarla desde Archivadas. Tus solicitudes y CV se conservan.', 'Archive this job? You can restore it from Archived. Your applications and resumes are preserved.'))) return;
    setBusy('archive'); setError('');
    try { await api(`/jobs/${job.id}/shortlist`, { method: 'POST', body: JSON.stringify({ decision: restoring ? 'UNREVIEWED' : 'ARCHIVED' }) }); await load(); setMessage(restoring ? c('Oferta restaurada.', 'Job restored.') : c('Oferta archivada. Puedes encontrarla con el filtro Archivadas.', 'Job archived. Find it with the Archived filter.')); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(null); }
  };

  return <WorkspaceGate><AppShell><DetailTitle name={job?.title}/>
    <Link href={backHref} className="back-link">← {backHref.startsWith('/searches') ? c('Volver a mi búsqueda', 'Back to my search') : c('Volver a ofertas', 'Back to jobs')}</Link>
    {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    {loadState === 'loading' && <Notice>{c('Cargando oferta…', 'Loading job…')}</Notice>}
    {loadState === 'error' && !job && <Notice tone="warning" actions={<Button variant="quiet" onClick={() => { setError(''); setLoadState('loading'); void load(); }}>{c('Reintentar', 'Try again')}</Button>}>{c('No pudimos cargar esta oferta.', 'We could not load this job.')}</Notice>}
    {job && <><div className="job-detail-header"><PageHeader eyebrow={job.company.toUpperCase()} title={job.title} description={`${c('Añadida el', 'Added on')} ${formatDate(job.createdAt)}`} action={<Button variant="secondary" disabled={busy !== null || job.shortlistDecision === 'ARCHIVED'} aria-pressed={job.shortlistDecision === 'SHORTLISTED'} onClick={() => void updateShortlist()}>{busy === 'shortlist' ? c('Guardando…', 'Saving…') : job.shortlistDecision === 'SHORTLISTED' ? c('Quitar de guardadas', 'Unsave job') : c('Guardar oferta', 'Save job')}</Button>}/></div>
      <ul className={styles.summary} aria-label={c('Datos principales de la oferta', 'Key job details')}>
        <li>{c('Empresa', 'Company')}: <strong>{job.company}</strong></li>
        <li>{c('Ubicación', 'Location')}: <strong>{job.location ?? c('Por confirmar', 'To be confirmed')}</strong></li>
        <li>{c('Disponibilidad', 'Availability')}: <Tag tone={job.availability === 'OPEN' ? 'green' : job.availability === 'CLOSED' ? 'red' : 'amber'}>{labelFor.availability(job.availability, locale)}</Tag></li>
        <li>{c('Requisitos para postular', 'Requirements to apply')}: <Tag tone={job.eligibility === 'PASS' ? 'green' : job.eligibility === 'FAIL' ? 'red' : 'amber'}>{labelFor.eligibility(job.eligibility, locale)}</Tag></li>
        {(source?.applyUrl ?? job.canonicalUrl) && <li><a target="_blank" rel="noopener noreferrer" href={source?.applyUrl ?? job.canonicalUrl ?? undefined}>{c('Ver la oferta original', 'View the original post')}<span className="sr-only"> {c('(se abre en una pestaña nueva)', '(opens in a new tab)')}</span></a></li>}
      </ul>
      {job.availability === 'CLOSED' && <Notice tone="warning">{c('Esta oferta figura como cerrada. Comprueba el enlace original antes de preparar una solicitud.', 'This job is listed as closed. Check the original post before preparing an application.')}</Notice>}
      {job.availability === 'POSSIBLY_CLOSED' && <Notice tone="warning">{c('Puede que esta oferta ya esté cerrada. Compruébalo en el enlace original antes de preparar tu solicitud.', 'This job may already be closed. Check the original post before preparing your application.')}</Notice>}
      {job.eligibility === 'FAIL' && <Notice tone="warning">{c('Según los datos de la oferta, puede que no cumplas algún requisito para postular. Revisa la descripción antes de continuar.', 'Based on the job data, you may not meet a requirement to apply. Check the description before continuing.')}</Notice>}
      {job.discoveredAt && !job.seenAt && job.shortlistDecision === 'UNREVIEWED' && <Notice actions={<Button variant="secondary" disabled={busy !== null} onClick={(event) => void markReviewed(event.currentTarget)}>{busy === 'seen' ? c('Guardando…', 'Saving…') : c('Marcar como revisada', 'Mark as reviewed')}</Button>}>{c('Oferta nueva · pendiente de revisar.', 'New job · waiting for your review.')}</Notice>}
      {job.discoveredAt && job.seenAt && <Notice tone="success" actions={<Link ref={reviewContinuation} href={backHref} className="button button-secondary">{c('Volver a la lista de ofertas', 'Back to the job list')}</Link>}>{job.shortlistDecision === 'ARCHIVED' ? c('Oferta revisada. Sigue guardada en Archivadas.', 'Job reviewed. It is still saved under Archived.') : c('Oferta revisada. Puedes volver a encontrarla en Todas las encontradas.', 'Job reviewed. You can find it again under All found jobs.')}</Notice>}
      {existing && <Notice tone={uncertainSubmission ? 'warning' : 'info'} actions={<Link className={`button ${canPrepare ? 'button-secondary' : 'button-primary'}`} href={withSearchOrigin(`/applications?id=${existing.id}`, returnTo)}>{c('Abrir tu solicitud', 'Open your application')} <Icon name="arrow" size={15}/></Link>}>{c('Ya sigues esta oferta', 'You are already tracking this job')}: {labelFor.applicationState(existing.state, locale)}{existing.recruitmentStage ? ` · ${applicationStage(existing.recruitmentStage, existing.state, locale)}` : ''}.{uncertainSubmission && <> {c('Comprueba el envío en tu solicitud antes de volver a intentarlo.', 'Check the submission in your application before trying again.')}</>}</Notice>}
      {Boolean(data?.searchSources?.length) && <div className="job-detail-meta"><p>{c('Publicada en el portal de empleo ', 'Published on the job site ')}{data?.searchSources?.map((item, index) => <span key={item.url}>{index ? ' · ' : ''}<a href={item.url} target="_blank" rel="noopener noreferrer">{item.provider === 'remotive' ? 'Remotive' : item.provider === 'himalayas' ? 'Himalayas' : 'Arbeitnow'}</a></span>)}{data?.searchSources?.some((item) => item.provider === 'remotive') && <> {c('Remotive publica su catálogo gratuito con 24 horas de retraso.', 'Remotive publishes its free feed with a 24-hour delay.')}</>}</p></div>}
      {canPrepare && <ApplicationPreparationAction returnTo={returnTo} jobId={job.id} applicationId={existing?.id}/>}
      <div className="detail-layout"><div className="detail-main">
        {aiAvailable && snapshot?.descriptionText && <Card className="form-card"><h2 id="job-ai-assistance" ref={focusHelp} className="focus-heading" tabIndex={-1}>{c('Entender esta oferta', 'Understand this job')}</h2><p>{c('Pide un resumen y revisa los requisitos con sus fuentes. Si lo pides desde aquí, se comparte solo el texto de la oferta.', 'Get a summary and review requirements with their sources. Requesting one here shares only the job posting text.')}</p>{searchParams.get('aiSetup') === 'automatic' && <Notice>{c('Paso 1: pide y lee este resumen. Paso 2: debajo del resultado podrás elegir las búsquedas y revisar el permiso para resumir ofertas nuevas automáticamente.', 'Step 1: request and read this summary. Step 2: below the result, choose searches and review permission to summarize new jobs automatically.')}</Notice>}<AiDraftAction key={job.id} initiallyOpen={helpRequested} request={{ operation: 'JOB_ANALYSIS', locale, jobId: job.id, selectedFactIds: [] }} label={c('Resumir y explicar con Codex', 'Summarize and explain with Codex')} renderResultActions={(_artifact, runId) => <AiAutomationPanel sourceRunId={runId} initiallyOpen={searchParams.get('aiSetup') === 'automatic'}/>}/></Card>}
        <Card className="detail-description"><div className="panel-heading"><div><div className="eyebrow"><span className="eyebrow-mark"/> {c('EL PUESTO', 'THE JOB')}</div><h2 id="job-description" className="focus-heading" tabIndex={-1}>{c('Descripción guardada', 'Saved description')}</h2></div>{source && <Tag tone="blue">{source.provider.toUpperCase()}</Tag>}</div>{snapshot?.descriptionText ? <div className="description-text">{snapshot.descriptionText}</div> : <div className="notice notice-warning">{c('Esta fuente no incluyó descripción. No suponemos requisitos que no aparecen en los datos.', 'This source did not include a description. We do not assume requirements that are not in the data.')}</div>}</Card>
        <details className={`card ${styles.fit}`}><summary>{c('Encaje con tu perfil (opcional)', 'Fit with your profile (optional)')} <small>{fitPending ? c('Faltan datos para valorarlo', 'Not enough information yet') : `${job.fitScore} / 100`}</small></summary><div className={styles.fitBody}>
          <p>{c('No necesitas revisarlo para preparar tu solicitud. Comparamos la oferta con tus datos que confirmaste y los puestos que buscas. No es la probabilidad de que te contraten.', 'You do not need to review this to prepare your application. We compare the job with your confirmed profile details and the roles you are looking for. It is not the probability of being hired.')}</p>
          <div className="detail-score"><div><span className="eyebrow"><span className="eyebrow-mark"/> {c('LECTURA BASADA EN EVIDENCIA', 'EVIDENCE-BASED READING')}</span><h2>{fitPending ? c('Faltan datos para valorar el encaje', 'More information needed to assess fit') : `${job.fitScore} / 100`}</h2><p>{job.provisional ? c('La información disponible es limitada. Revisa los requisitos de la oferta y confirma experiencia relacionada en tu perfil.', 'Available information is limited. Review the job requirements and confirm related experience in your profile.') : c('El encaje compara tus datos confirmados con la oferta; no predice una contratación.', 'The match compares your confirmed details with the job; it does not predict hiring.')}</p></div><div className="score-ring" aria-hidden="true" style={{ ['--score' as string]: `${job.provisional ? 0 : job.fitScore ?? 0}%` }}><div><strong>{job.provisional ? '—' : job.fitScore ?? '—'}</strong><small>{c('encaje', 'match')}</small></div></div></div>
          <div className="panel-heading"><div><div className="eyebrow"><span className="eyebrow-mark"/> {c('CÓMO SE CALCULA', 'HOW IT IS CALCULATED')}</div><h3>{c('Por qué este encaje', 'Why this match')}</h3></div>{job.provisional && <Tag tone="amber">{c('PROVISIONAL', 'PROVISIONAL')}</Tag>}</div>
          {job.match ? <div className="form-stack">
            <div><strong>{c('Habilidades con evidencia', 'Skills backed by your evidence')}</strong><div className="tag-row">{job.match.matchedSkills.length ? job.match.matchedSkills.map((skill) => <Tag key={skill} tone="green">✓ {skill}</Tag>) : <small>{c('Ninguna todavía.', 'None yet.')}</small>}</div></div>
            <div><strong>{c('Habilidades sin evidencia aprobada', 'Skills without approved evidence')}</strong><div className="tag-row">{job.match.missingSkills.length ? job.match.missingSkills.map((skill) => <Tag key={skill} tone="amber">{skill}</Tag>) : <small>{c('No falta ninguna de las que reconocimos.', 'None of the skills we recognised are missing.')}</small>}</div>{job.match.missingSkills.length > 0 && <small>{c('Si tienes esa experiencia, añádela como dato en tu perfil y apruébala.', 'If you have that experience, add it as a detail in your profile and approve it.')} <Link href={withSearchOrigin(`/profile?jobId=${job.id}${existing ? `&applicationId=${existing.id}` : ''}`, returnTo)}>{c('Ir a mi perfil', 'Go to my profile')}</Link></small>}</div>
            <div><strong>{c('Título del puesto', 'Job title')}</strong><p>{job.match.matchedTargetTitle ? c(`Coincide con «${job.match.matchedTargetTitle}», uno de los puestos que buscas.`, `Matches “${job.match.matchedTargetTitle}”, one of the roles you are looking for.`) : job.match.targetTitles.length ? c('No coincide con los puestos que buscas.', 'Does not match the roles you are looking for.') : c('Sin comparar: aún no indicaste qué puestos buscas.', 'Not compared: you have not said which roles you are looking for.')}</p></div>
            <small>{c(`Basado en ${job.match.approvedFactCount} datos que confirmaste de la revisión ${job.match.profileRevision} de tu perfil.`, `Based on ${job.match.approvedFactCount} confirmed profile details from revision ${job.match.profileRevision} of your profile.`)}</small>
          </div> : <Notice>{c('Esta oferta se valoró antes de que existiera el detalle del encaje. Se actualizará en la próxima revisión.', 'This job was assessed before match details were available. They will appear after the next update.')}</Notice>}
          {[...(job.match?.notes ?? []), ...job.reasons].length > 0 && <ul>{[...new Set([...(job.match?.notes ?? []), ...job.reasons])].map((code) => <li key={code}>{labelFor.matchCode(code, locale)}</li>)}</ul>}
        </div></details>
      </div><aside className="detail-aside"><Card className={styles.later}><h2>{c('Más acciones', 'More actions')}</h2><p>{job.shortlistDecision === 'ARCHIVED' ? c('Esta oferta está archivada. Restáurala para volver a verla en tus listas.', 'This job is archived. Restore it to see it in your lists again.') : c('Puedes archivar la oferta o llevar el seguimiento sin preparar un CV.', 'You can archive the job or track it without preparing a resume.')}</p><div className={styles.laterActions}>
        {!existing && <Button variant="quiet" onClick={() => void makeApplication()} disabled={busy !== null}>{busy === 'application' ? c('Creando…', 'Creating…') : c('Solo anotar seguimiento', 'Only track this job')}</Button>}
        <Button variant="quiet" disabled={busy !== null} onClick={() => void archive()}>{job.shortlistDecision === 'ARCHIVED' ? c('Restaurar oferta', 'Restore job') : c('Archivar oferta', 'Archive job')}</Button>
      </div></Card><details className={`card ${styles.fit}`}><summary>{c('Más datos de la oferta', 'More job details')}</summary><div className={`detail-facts ${styles.fitBody}`}><dl>
        <div><dt>{c('Información disponible para comparar', 'Information available to compare')}</dt><dd>{job.evidenceCoverage ?? 0}%</dd></div>
        {source && <><div><dt>{c('Fuente', 'Source')}</dt><dd>{source.provider} · {labelFor.region(source.region, locale)}</dd></div><div><dt>{c('Vista por última vez', 'Last seen')}</dt><dd>{formatDate(source.lastSeenAt)}</dd></div><div><dt>{c('Publicada por la fuente', 'Posted by the source')}</dt><dd>{formatDate(source.sourcePostedAt)}</dd></div></>}
      </dl></div></details></aside></div>
    </>}
  </AppShell></WorkspaceGate>;
}
