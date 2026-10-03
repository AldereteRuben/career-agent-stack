'use client';

import { ApplicationPreparationAction } from '@/components/application-preparation';
import { useLocale } from '@/lib/i18n';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Icon, Notice, Tag } from '@/components/ui';
import { api, errorMessage, formatDate } from '@/lib/api';
import { copy, labelFor } from '@/lib/labels';

type Match = { titleAlignment: number | null; matchedTargetTitle: string | null; matchedSkills: string[]; missingSkills: string[]; approvedFactCount: number; targetTitles: string[]; profileRevision: number; notes: string[] };
type Job = { discoveredAt: string | null; seenAt: string | null; id: string; title: string; company: string; location: string | null; canonicalUrl: string | null; fitScore: number | null; evidenceCoverage: number | null; eligibility: string; reasons: string[]; shortlistDecision: string; availability: string; createdAt: string; provisional?: boolean; match?: Match | null };
type Snapshot = { id: string; title: string; descriptionText: string | null; fetchedAt: string };
type JobApplication = { id: string; state: string; recruitmentStage?: string; updatedAt?: string };
type Detail = { searchSources?: Array<{ provider: string; url: string; postedAt: string | null; lastSeenAt: string }>; job: Job; snapshots: Snapshot[]; sources: Array<{ provider: string; region: string; tenant: string; sourcePostedAt: string | null; lastSeenAt: string; jobUrl: string; applyUrl: string | null }>; applications: JobApplication[] };

export default function JobDetailPage() {
  const { locale } = useLocale(); const c = copy(locale);
  const { id } = useParams<{ id: string }>(); const router = useRouter();
  const searchParams = useSearchParams(); const returnTo = searchParams.get('returnTo') ?? '';
  const backHref = returnTo === '/jobs' || returnTo.startsWith('/jobs?') ? returnTo : '/jobs';
  const [data, setData] = useState<Detail | null>(null); const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState<string | null>(null);
  const reviewContinuation = useRef<HTMLAnchorElement>(null); const focusAfterReview = useRef(false);
  const load = useCallback(async () => {
    try { setData(await api<Detail>(`/jobs/${id}`)); setLoadState('ready'); }
    catch (err) { setError(errorMessage(err)); setLoadState((current) => current === 'ready' ? 'ready' : 'error'); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const job = data?.job; const snapshot = data?.snapshots[0]; const source = data?.sources[0];
  const existing = data?.applications.find((application) => application.state !== 'CANCELLED') ?? data?.applications[0];

  useEffect(() => {
    if (job?.seenAt && focusAfterReview.current) { focusAfterReview.current = false; reviewContinuation.current?.focus({ preventScroll: true }); }
  }, [job?.seenAt]);
  const markReviewed = async (trigger: HTMLButtonElement) => {
    if (!job || busy) return;
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
      router.push(`/applications?id=${created.id}`);
    } catch (err) { setError(errorMessage(err)); setBusy(null); }
  };
  const updateShortlist = async () => {
    if (!job) return; setBusy('shortlist'); setError(''); setMessage('');
    try { await api(`/jobs/${job.id}/shortlist`, { method: 'POST', body: JSON.stringify({ decision: job.shortlistDecision === 'SHORTLISTED' ? 'UNREVIEWED' : 'SHORTLISTED' }) }); await load(); setMessage(job.shortlistDecision === 'SHORTLISTED' ? c('Quitada de favoritas.', 'Removed from favorites.') : c('Añadida a favoritas.', 'Added to favorites.')); }
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

  return <WorkspaceGate><AppShell>
    <Link href={backHref} className="back-link">← {c('Volver a ofertas', 'Back to jobs')}</Link>
    {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    {loadState === 'loading' && <Notice>{c('Cargando oferta…', 'Loading job…')}</Notice>}
    {loadState === 'error' && !job && <Notice tone="warning" actions={<Button variant="quiet" onClick={() => { setError(''); setLoadState('loading'); void load(); }}>{c('Reintentar', 'Try again')}</Button>}>{c('No pudimos cargar esta oferta.', 'We could not load this job.')}</Notice>}
    {job && <><PageHeader eyebrow={job.company.toUpperCase()} title={job.title} description={`${job.location ?? c('Ubicación por confirmar', 'Location to be confirmed')} · ${c('Añadida el', 'Added on')} ${formatDate(job.createdAt)}`} action={<div className="detail-actions">
        <Button variant="secondary" disabled={busy !== null || job.shortlistDecision === 'ARCHIVED'} aria-pressed={job.shortlistDecision === 'SHORTLISTED'} onClick={() => void updateShortlist()}>{busy === 'shortlist' ? c('Guardando…', 'Saving…') : job.shortlistDecision === 'SHORTLISTED' ? `✓ ${c('Favorita', 'Favorite')}` : c('Añadir a favoritas', 'Add to favorites')}</Button>
        <Link className={`button ${existing ? 'button-secondary' : 'button-primary'}`} href={`/documents?jobId=${job.id}${existing ? `&applicationId=${existing.id}` : ''}`}><Icon name="file" size={15}/> {c('Preparar CV para esta oferta', 'Prepare a resume for this job')}</Link>
        {existing ? <Link className="button button-primary" href={`/applications?id=${existing.id}`}>{c('Abrir tu solicitud', 'Open your application')} <Icon name="arrow" size={15}/></Link>
          : <Button variant="secondary" onClick={() => void makeApplication()} disabled={busy !== null}>{busy === 'application' ? c('Creando…', 'Creating…') : c('Empezar seguimiento', 'Start tracking')} <Icon name="arrow" size={15}/></Button>}
        <Button variant="quiet" disabled={busy !== null} onClick={() => void archive()}>{job.shortlistDecision === 'ARCHIVED' ? c('Restaurar oferta', 'Restore job') : c('Archivar oferta', 'Archive job')}</Button>
      </div>}/>
      {job.discoveredAt && !job.seenAt && <Notice actions={<Button variant="secondary" disabled={busy !== null} onClick={(event) => void markReviewed(event.currentTarget)}>{busy === 'seen' ? c('Guardando…', 'Saving…') : c('Marcar como revisada', 'Mark as reviewed')}</Button>}>{c('Oferta nueva encontrada en tus búsquedas o empresas. Revisarla no envía ninguna solicitud.', 'New job found through your searches or companies. Reviewing it does not submit an application.')}</Notice>}
      {job.discoveredAt && job.seenAt && <Notice tone="success" actions={<Link ref={reviewContinuation} href={backHref} className="button button-secondary">{c('Volver a la lista de ofertas', 'Back to the job list')}</Link>}>{job.shortlistDecision === 'ARCHIVED' ? c('Oferta revisada. Sigue guardada en Archivadas.', 'Job reviewed. It is still saved under Archived.') : c('Oferta revisada. Sigue guardada en Activas.', 'Job reviewed. It is still saved under Active.')}</Notice>}
      {existing && <Notice>{c('Ya sigues esta oferta', 'You are already tracking this job')}: {labelFor.applicationState(existing.state, locale)}{existing.recruitmentStage ? ` · ${labelFor.recruitmentStage(existing.recruitmentStage, locale)}` : ''}.</Notice>}
      {Boolean(data.searchSources?.length) && <Notice>{c('Fuente de la oferta: ', 'Job source: ')}{data.searchSources?.map((item, index) => <span key={item.url}>{index ? ' · ' : ''}<a href={item.url} target="_blank" rel="noopener noreferrer">{item.provider === 'remotive' ? 'Remotive' : 'Arbeitnow'}</a></span>)}{data.searchSources?.some((item) => item.provider === 'remotive') && <> {c('Remotive publica su catálogo gratuito con 24 horas de retraso.', 'Remotive publishes its free feed with a 24-hour delay.')}</>}</Notice>}
      <ApplicationPreparationAction jobId={job.id}/>
      <div className="detail-layout"><div className="detail-main">
        <Card className="detail-score"><div><span className="eyebrow"><span className="eyebrow-mark"/> {c('LECTURA BASADA EN EVIDENCIA', 'EVIDENCE-BASED READING')}</span><h2>{job.fitScore === null ? c('Sin datos suficientes para puntuar', 'Not enough information to score') : `${job.fitScore} / 100`}</h2><p>{c('El encaje mide cuánto cubren tus datos que confirmaste; no predice una contratación ni es una puntuación ATS.', 'The match measures how well your confirmed profile details cover the job. It does not predict hiring or represent an ATS score.')}</p></div><div className="score-ring" style={{ ['--score' as string]: `${job.fitScore ?? 0}%` }}><div><strong>{job.fitScore ?? '—'}</strong><small>{c('encaje', 'match')}</small></div></div></Card>
        <Card className="detail-description"><div className="panel-heading"><div><div className="eyebrow"><span className="eyebrow-mark"/> {c('CÓMO SE CALCULA', 'HOW IT IS CALCULATED')}</div><h2>{c('Por qué este encaje', 'Why this match')}</h2></div>{job.provisional && <Tag tone="amber">{c('PROVISIONAL', 'PROVISIONAL')}</Tag>}</div>
          <p>{c('Comparamos la oferta con tus datos que confirmaste y los puestos que buscas. No es la probabilidad de que te contraten.', 'We compare the job with your confirmed profile details and the roles you are looking for. It is not the probability of being hired.')}</p>
          {job.match ? <div className="form-stack">
            <div><strong>{c('Habilidades con evidencia', 'Skills backed by your evidence')}</strong><div className="tag-row">{job.match.matchedSkills.length ? job.match.matchedSkills.map((skill) => <Tag key={skill} tone="green">✓ {skill}</Tag>) : <small>{c('Ninguna todavía.', 'None yet.')}</small>}</div></div>
            <div><strong>{c('Habilidades sin evidencia aprobada', 'Skills without approved evidence')}</strong><div className="tag-row">{job.match.missingSkills.length ? job.match.missingSkills.map((skill) => <Tag key={skill} tone="amber">{skill}</Tag>) : <small>{c('No falta ninguna de las que reconocimos.', 'None of the skills we recognised are missing.')}</small>}</div>{job.match.missingSkills.length > 0 && <small>{c('Si tienes esa experiencia, añádela como dato en tu perfil y apruébala.', 'If you have that experience, add it as a detail in your profile and approve it.')} <Link href={`/profile?jobId=${job.id}`}>{c('Ir a mi perfil', 'Go to my profile')}</Link></small>}</div>
            <div><strong>{c('Título del puesto', 'Job title')}</strong><p>{job.match.matchedTargetTitle ? c(`Coincide con «${job.match.matchedTargetTitle}», uno de los puestos que buscas.`, `Matches “${job.match.matchedTargetTitle}”, one of the roles you are looking for.`) : job.match.targetTitles.length ? c('No coincide con los puestos que buscas.', 'Does not match the roles you are looking for.') : c('Sin comparar: aún no indicaste qué puestos buscas.', 'Not compared: you have not said which roles you are looking for.')}</p></div>
            <small>{c(`Basado en ${job.match.approvedFactCount} datos que confirmaste de la revisión ${job.match.profileRevision} de tu perfil.`, `Based on ${job.match.approvedFactCount} confirmed profile details from revision ${job.match.profileRevision} of your profile.`)}</small>
          </div> : <Notice>{c('Esta oferta se valoró antes de que existiera el detalle del encaje. Se actualizará en la próxima revisión.', 'This job was assessed before match details were available. They will appear after the next update.')}</Notice>}
          {[...(job.match?.notes ?? []), ...job.reasons].length > 0 && <ul>{[...new Set([...(job.match?.notes ?? []), ...job.reasons])].map((code) => <li key={code}>{labelFor.matchCode(code, locale)}</li>)}</ul>}
        </Card>
        <Card className="detail-description"><div className="panel-heading"><div><div className="eyebrow"><span className="eyebrow-mark"/> {c('EL PUESTO', 'THE JOB')}</div><h2>{c('Descripción guardada', 'Saved description')}</h2></div>{source && <Tag tone="blue">{source.provider.toUpperCase()}</Tag>}</div>{snapshot?.descriptionText ? <div className="description-text">{snapshot.descriptionText}</div> : <div className="notice notice-warning">{c('Esta fuente no incluyó descripción. No suponemos requisitos que no aparecen en los datos.', 'This source did not include a description. We do not assume requirements that are not in the data.')}</div>}</Card>
      </div><aside className="detail-aside"><Card className="detail-facts"><h3>{c('Lo que sabemos', 'What we know')}</h3><dl>
        <div><dt>{c('Empresa', 'Company')}</dt><dd>{job.company}</dd></div>
        <div><dt>{c('Ubicación', 'Location')}</dt><dd>{job.location ?? c('Por confirmar', 'To be confirmed')}</dd></div>
        <div><dt>{c('Disponibilidad', 'Availability')}</dt><dd>{labelFor.availability(job.availability, locale)}</dd></div>
        <div><dt>{c('Elegibilidad', 'Eligibility')}</dt><dd><Tag tone={job.eligibility === 'PASS' ? 'green' : job.eligibility === 'FAIL' ? 'red' : 'amber'}>{labelFor.eligibility(job.eligibility, locale)}</Tag></dd></div>
        <div><dt>{c('Cobertura de evidencia', 'Evidence coverage')}</dt><dd>{job.evidenceCoverage ?? 0}%</dd></div>
        {source && <><div><dt>{c('Fuente', 'Source')}</dt><dd>{source.provider} · {labelFor.region(source.region, locale)}</dd></div><div><dt>{c('Vista por última vez', 'Last seen')}</dt><dd>{formatDate(source.lastSeenAt)}</dd></div><div><dt>{c('Publicada por la fuente', 'Posted by the source')}</dt><dd>{formatDate(source.sourcePostedAt)}</dd></div></>}
      </dl></Card><Card className="source-card"><div className="card-icon mint"><Icon name="shield" size={17}/></div><h3>{c('Ir a la oferta original', 'Go to the original post')}</h3><p>{c('El enlace solo se abre cuando tú lo eliges. Career Stack no carga páginas de empleo al guardar una URL.', 'The link only opens when you choose to. Career Stack does not load job pages when you save a URL.')}</p>{(source?.applyUrl ?? job.canonicalUrl) && <a className="button button-secondary" target="_blank" rel="noopener noreferrer" href={source?.applyUrl ?? job.canonicalUrl ?? undefined}>{c('Abrir enlace oficial', 'Open official link')} <Icon name="arrow" size={14}/></a>}</Card></aside></div>
    </>}
  </AppShell></WorkspaceGate>;
}
