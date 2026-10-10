'use client';

import Link from 'next/link';
import { useLocalRefresh } from '@/lib/local-refresh';
import { useRouter } from 'next/navigation';
import { withSearchOrigin } from '@/lib/search-origin';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApplicationSections } from './application-sections';
import { PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Empty, Notice, Tag } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import styles from './application-preparation.module.css';
import { gapContinuation, queueActions } from './application-continuation';
import type { Locale } from '@/lib/locale';

type Preparation = {
  status: 'PREPARED' | 'NEEDS_REVIEW' | 'BLOCKED'; jobId: string; company: string; title: string;
  applicationId: string | null; documentId: string | null; profileRevisionId: string | null; snapshotId: string | null;
  selectedFacts: Array<{ id: string; statement: string; reason: string }>;
  answerSuggestions: Array<{ answerId: string; semanticKey: string; question: string; value: unknown; provenance: string }>;
  gaps: string[]; reason?: string; queueState?: string; needsAttention?: boolean; canPrepare?: boolean;
};
const preparationError = (err: unknown, locale: Locale) => err instanceof ApiError && ['JOB_CLOSED', 'USER_SELECTED_DOCUMENT_PRESERVED', 'APPLICATION_CLOSED_OR_UNCERTAIN'].includes(err.code) ? reasonText(err.code, locale) : errorMessage(err);
const gapText = (value: string, locale: Locale) => ({
  PROFILE_REQUIRED: locale === 'es' ? 'Añade tu perfil.' : 'Add your profile.',
  FULL_NAME_REQUIRED: locale === 'es' ? 'Falta tu nombre.' : 'Your name is missing.',
  EMAIL_REQUIRED: locale === 'es' ? 'Falta tu correo.' : 'Your email is missing.',
  PREPARATION_OUTDATED: locale === 'es' ? 'Tus datos cambiaron. Vuelve a preparar esta candidatura para actualizar los pendientes.' : 'Your details changed. Prepare this application again to update what is missing.',
  JOB_TEXT_UNAVAILABLE: locale === 'es' ? 'No hay texto del anuncio guardado.' : 'No saved job description is available.',
  RELEVANT_APPROVED_EVIDENCE_REQUIRED: locale === 'es' ? 'Añade y confirma experiencia relacionada con el puesto.' : 'Add and confirm experience related to this role.',
}[value] ?? (locale === 'es' ? 'Completa este dato en tu perfil para continuar.' : 'Complete this detail in your profile to continue.'));
const reasonText = (value: string, locale: Locale) => ({
  JOB_CLOSED: locale === 'es' ? 'La oferta está cerrada.' : 'The job is closed.',
  USER_SELECTED_DOCUMENT_PRESERVED: locale === 'es' ? 'Tu documento elegido se ha conservado.' : 'Your selected document was preserved.',
  APPLICATION_CLOSED_OR_UNCERTAIN: locale === 'es' ? 'La solicitud está cerrada o su estado es incierto.' : 'The application is closed or its status is uncertain.',
}[value] ?? (locale === 'es' ? 'Requiere revisión adicional.' : 'Additional review is required.'));

const factReason = (reason: string, locale: Locale) => reason.replace(/^(Coincide con el anuncio|Matches job wording):/, locale === 'es' ? 'Coincide con el anuncio:' : 'Matches job wording:');
const answerProvenance = (value: string, locale: Locale) => value.replace(/Respuesta aprobada|Approved stored answer/g, locale === 'es' ? 'Respuesta aprobada' : 'Approved stored answer').replace(/revisión|revision/g, locale === 'es' ? 'revisión' : 'revision');

type JourneyContext = { jobId: string; applicationId?: string | null; returnTo?: string };
/** Links inside the preparation journey keep the job, its application and the listing the person came from. */
const journeyHref = (path: string, { jobId, applicationId, returnTo }: JourneyContext, hash = '') => {
  const params = new URLSearchParams({ jobId }); if (applicationId) params.set('applicationId', applicationId);
  return withSearchOrigin(`${path}?${params}${hash}`, returnTo);
};
/** One primary continuation for missing details; choosing resume content by hand stays available behind a disclosure. */
function GapActions({ gaps, ...context }: JourneyContext & { gaps: string[] }) {
  const { locale } = useLocale(); const c = (es: string, en: string) => locale === 'es' ? es : en;
  const next = gapContinuation(gaps);
  const manual = next !== 'job-text' && (gaps.includes('RELEVANT_APPROVED_EVIDENCE_REQUIRED') || gaps.includes('JOB_TEXT_UNAVAILABLE'));
  if (!next) return null;
  return <div className={styles.next}>
    {next === 'identity' ? <><p>{c('Te pediremos solo lo que falta y volverás a preparar esta solicitud.', 'We only ask for what is missing, then you return to preparing this application.')}</p><Link className="button button-primary" href={journeyHref('/profile/setup', context)}>{c('Completar lo que falta', 'Complete what is missing')}</Link></>
      : next === 'experience' ? <><p>{c('Añade o confirma una experiencia relacionada; después podrás preparar el CV desde la misma página.', 'Add or confirm related experience; you can then prepare the resume from the same page.')}</p><Link className="button button-primary" href={journeyHref('/profile', context, '#experience')}>{c('Añadir experiencia para esta oferta', 'Add experience for this job')}</Link></>
      : <><p>{c('La oferta no incluye una descripción para elegir experiencia automáticamente. Puedes elegir el contenido del CV y continuar.', 'The job has no description to select experience automatically. You can choose your resume content and continue.')}</p><Link className="button button-primary" href={journeyHref('/documents', context)}>{c('Elegir contenido del CV', 'Choose resume content')}</Link></>}
    {manual && <details className={styles.alternative}><summary>{c('Prefiero elegir el contenido del CV', 'I prefer to choose my resume content')}</summary><p>{c('Elige tú qué experiencia confirmada incluir.', 'Choose which confirmed experience to include yourself.')}</p><Link className="button button-secondary" href={journeyHref('/documents', context)}>{c('Elegir contenido del CV', 'Choose resume content')}</Link></details>}
  </div>;
}
const queueLabels: Record<string, [string, string]> = {
  NEEDS_PREPARATION: ['Datos listos para preparar', 'Ready to prepare'], NEEDS_DETAILS: ['Faltan datos', 'Details needed'], REVIEW_DOCUMENT: ['CV por revisar', 'Resume to review'],
  READY: ['CV aprobado', 'Resume approved'], STALE_DOCUMENT: ['CV necesita actualización', 'Resume needs updating'],
  SUBMITTED: ['Enviada', 'Submitted'], CLOSED: ['Finalizada', 'Closed'], UNCERTAIN: ['Comprobar envío', 'Check submission'],
  IN_PROGRESS: ['Envío en curso', 'Submission in progress'], JOB_CLOSED: ['Oferta cerrada', 'Job closed'],
};

/** Renders the queue card actions decided by queueActions, keeping at most one primary. */
function QueueActions({ item, busy, onRetry }: { item: Preparation; busy: string | null; onRetry: (jobId: string) => void }) {
  const { locale } = useLocale(); const c = (es: string, en: string) => locale === 'es' ? es : en;
  const reviewHref = `/documents?applicationId=${item.applicationId}&jobId=${item.jobId}&view=review&document=${item.documentId}&from=saved`;
  const applicationHref = `/applications?id=${item.applicationId}`;
  const links = { continue: [applicationHref, c('Continuar con la solicitud', 'Continue application')], approved: [reviewHref, c('Ver CV aprobado', 'View approved resume')], review: [reviewHref, c('Revisar documento', 'Review document')], update: [reviewHref, c('Actualizar o elegir CV', 'Update or choose resume')], check: [applicationHref, c('Comprobar el envío', 'Check the submission')], open: [applicationHref, c('Abrir solicitud', 'Open application')] } as const;
  return <div className={styles.actions}>
    {queueActions(item).map(({ kind, primary }) => <Link key={kind} className={`button ${primary ? 'button-primary' : 'button-secondary'}`} href={links[kind][0]}>{links[kind][1]}</Link>)}
    {item.canPrepare && <Button variant="quiet" onClick={() => onRetry(item.jobId)} disabled={busy !== null}>{busy === item.jobId ? c('Reintentando…', 'Retrying…') : c('Volver a preparar', 'Prepare again')}</Button>}
  </div>;
}

export function ApplicationQueue() {
  const { locale } = useLocale(); const c = (es: string, en: string) => locale === 'es' ? es : en;
  const [showAll, setShowAll] = useState(false);
  const [items, setItems] = useState<Preparation[]>([]); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState(''); const [actionError, setActionError] = useState('');
  const load = useCallback(async () => { try { setItems(await api<Preparation[]>('/preparations')); setError(''); } catch (err) { setError(preparationError(err, locale)); } finally { setLoading(false); } }, [locale]);
  useEffect(() => { void load(); }, [load]);
  useLocalRefresh(load, { paused: loading || busy !== null });
  const retry = async (jobId: string) => { setBusy(jobId); setActionError(''); try { await api<Preparation>('/preparations', { method: 'POST', body: JSON.stringify({ jobId, locale }) }); await load(); } catch (err) { setActionError(preparationError(err, locale)); } finally { setBusy(null); } };
  const pending = items.filter((item) => item.needsAttention); const visible = showAll ? items : pending;
  return <><PageHeader eyebrow={c('POR REVISAR', 'TO REVIEW')} title={c('Mis solicitudes', 'My applications')} description={c('Revisa qué datos aprobados se usaron, por qué se eligieron y qué falta completar.', 'Review which approved details were used, why they were selected, and what still needs attention.')} />
    <ApplicationSections active="review" reviewCount={loading || error ? undefined : pending.length}/>
    <div className={styles.actions}><Button variant="quiet" disabled={loading || busy !== null} onClick={() => void load()}>{c('Actualizar lista', 'Refresh list')}</Button><Button variant="quiet" aria-pressed={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? c('Solo pendientes', 'Only pending') : c('Ver también finalizadas', 'Include completed')}</Button></div>
    {actionError && <Notice tone="error">{actionError}</Notice>}
    {error && <Notice tone="error">{error}<Button variant="secondary" onClick={() => void load()}>{c('Volver a intentar', 'Try again')}</Button></Notice>}
    {loading ? <p role="status">{c('Cargando…', 'Loading…')}</p> : error && visible.length === 0 ? null : visible.length === 0 ? <Empty headingLevel="h2" title={c('No hay solicitudes pendientes de revisión', 'No applications waiting for review')} detail={c('Abre una oferta que te interese y pulsa Preparar mi solicitud. Aquí aparecerán los CV preparados y los datos que falten.', 'Open a job that interests you and choose Prepare my application. Prepared resumes and missing details appear here.')} action={<Link className="button button-secondary" href="/searches">{c('Buscar ofertas', 'Find jobs')}</Link>} /> : <div className={styles.queue}>{visible.map((item) => <Card key={item.applicationId ?? item.jobId} className={styles.card}>
      <div className={styles.head}><span className="eyebrow">{item.company}</span><h2>{item.title}</h2><Tag tone={item.queueState === 'READY' || item.queueState === 'SUBMITTED' ? 'green' : item.needsAttention ? 'amber' : 'neutral'}>{queueLabels[item.queueState ?? 'NEEDS_DETAILS']?.[locale === 'es' ? 0 : 1]}</Tag></div>
      {item.queueState === 'UNCERTAIN' && <Notice tone="warning">{c('Abre la solicitud y comprueba el envío antes de intentar otra vez.', 'Open the application and check the submission before trying again.')}</Notice>}
      {item.reason && <Notice tone="warning">{reasonText(item.reason, locale)}</Notice>}
      {item.gaps.length > 0 && <div><h3>{c('Pendiente', 'Needs attention')}</h3><ul>{item.gaps.map((gap) => <li key={gap}>{gapText(gap, locale)}</li>)}</ul><GapActions gaps={item.gaps} jobId={item.jobId} applicationId={item.applicationId}/></div>}
      {item.selectedFacts.length > 0 && <details><summary>{c('Ver experiencia utilizada', 'Show included experience')}</summary><div><h3>{c('Experiencia incluida', 'Included experience')}</h3><ul>{item.selectedFacts.map((fact) => <li key={fact.id}><strong>{fact.statement}</strong><small className={styles.reason}>{factReason(fact.reason, locale)}</small></li>)}</ul></div></details>}
      {item.answerSuggestions.length > 0 && <div><h3>{c('Respuestas aprobadas sugeridas', 'Approved answer suggestions')}</h3><ul>{item.answerSuggestions.map((answer) => <li key={answer.answerId}><strong>{answer.question}: </strong>{typeof answer.value === 'string' ? answer.value : JSON.stringify(answer.value)}<small className={styles.reason}>{answerProvenance(answer.provenance, locale)}</small></li>)}</ul></div>}
      <QueueActions item={item} busy={busy} onRetry={(jobId) => void retry(jobId)}/>
    </Card>)}</div>}
  </>;
}

export default function ApplicationPreparationPage() { return <WorkspaceGate><ApplicationQueue/></WorkspaceGate>; }

export function ApplicationPreparationAction({ jobId, applicationId, returnTo, disabled = false }: { jobId: string; applicationId?: string; returnTo?: string; disabled?: boolean }) {
  const { locale } = useLocale(); const c = (es: string, en: string) => locale === 'es' ? es : en;
  const router = useRouter();
  const feedback = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const [result, setResult] = useState<Preparation | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (result || error) feedback.current?.focus(); }, [result, error]);
  const prepare = async () => {
    if (pending.current) return; pending.current = true;
    setBusy(true); setError('');
    try {
      const prepared = await api<Preparation>('/preparations', { method: 'POST', body: JSON.stringify({ jobId, locale }) });
      setResult(prepared);
      if (prepared.status === 'PREPARED' && prepared.documentId && prepared.applicationId) router.push(withSearchOrigin(`/documents?applicationId=${prepared.applicationId}&jobId=${jobId}&view=review&document=${prepared.documentId}&from=saved`, returnTo));
    } catch (err) { setError(preparationError(err, locale)); } finally { pending.current = false; setBusy(false); }
  };
  return <section className="card preparation-action" aria-labelledby="prepare-application-heading">
    <h2 id="prepare-application-heading" tabIndex={-1}>{c('Prepara tu solicitud', 'Prepare your application')}</h2>
    <p>{c('Elegiremos experiencia confirmada de tu perfil y prepararemos un CV para esta oferta. Si falta algo, te ayudaremos a completarlo. Después podrás revisar el PDF.', 'We select confirmed experience from your profile and prepare a resume for this job. If anything is missing, we help you complete it. Then you can review the PDF.')}</p>
    <div className="detail-actions"><Button variant={result && gapContinuation(result.gaps) ? "secondary" : "primary"} onClick={() => void prepare()} disabled={busy || disabled}>{busy ? c('Preparando…', 'Preparing…') : result && gapContinuation(result.gaps) ? c('Volver a comprobar', 'Check again') : c('Preparar mi solicitud', 'Prepare my application')}</Button></div>{!result && <details className="preparation-alternatives"><summary>{c('Prefiero elegir el contenido del CV', 'I prefer to choose my resume content')}</summary><Link className="button button-secondary" href={withSearchOrigin(`/documents?jobId=${jobId}${applicationId ? `&applicationId=${applicationId}` : ''}`, returnTo)}>{c('Elegir contenido del CV', 'Choose resume content')}</Link></details>}<p className="muted-label">{c('Preparar no envía nada. Tú revisarás y autorizarás cada envío.', 'Preparing does not submit anything. You review and authorize each submission.')}</p>
    {disabled && <p role="status">{c('Guarda o descarta tus cambios antes de preparar la solicitud.', 'Save or discard your changes before preparing the application.')}</p>}
    <div ref={feedback} tabIndex={-1} className="preparation-feedback">{error && <Notice tone="error">{error}</Notice>}
    {result && <Card><p><Tag tone={result.status === 'PREPARED' ? 'green' : result.status === 'BLOCKED' ? 'red' : 'amber'}>{result.status === 'PREPARED' ? c('Preparada', 'Prepared') : result.status === 'BLOCKED' ? c('No se puede preparar todavía', 'Not ready to prepare yet') : c('Completa lo que falta', 'Complete missing details')}</Tag></p>
      {result.gaps.length > 0 && <><ul>{result.gaps.map((gap) => <li key={gap}>{gapText(gap, locale)}</li>)}</ul><GapActions gaps={result.gaps} jobId={jobId} applicationId={result.applicationId ?? applicationId} returnTo={returnTo}/></>}{result.reason && <p>{reasonText(result.reason, locale)}</p>}
      {result.selectedFacts.map((fact) => <p key={fact.id}><strong>{fact.statement}</strong><small className={styles.reason}>{factReason(fact.reason, locale)}</small></p>)}
      <div className={styles.actions}>{result.documentId && result.applicationId && <Link className={`button ${gapContinuation(result.gaps) ? 'button-secondary' : 'button-primary'}`} href={withSearchOrigin(`/documents?applicationId=${result.applicationId}&jobId=${result.jobId}&view=review&document=${result.documentId}&from=saved`, returnTo)}>{c('Revisar documento', 'Review document')}</Link>}{result.applicationId && <Link className="button button-secondary" href={withSearchOrigin(`/applications?id=${result.applicationId}`, returnTo)}>{c('Abrir solicitud', 'Open application')}</Link>}</div>
    </Card>}</div>
  </section>;
}
