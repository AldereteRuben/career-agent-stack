'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Empty, Notice, Tag } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import styles from './application-preparation.module.css';
import type { Locale } from '@/lib/locale';

type Preparation = {
  status: 'PREPARED' | 'NEEDS_REVIEW' | 'BLOCKED'; jobId: string; company: string; title: string;
  applicationId: string | null; documentId: string | null; profileRevisionId: string | null; snapshotId: string | null;
  selectedFacts: Array<{ id: string; statement: string; reason: string }>;
  answerSuggestions: Array<{ answerId: string; semanticKey: string; question: string; value: unknown; provenance: string }>;
  gaps: string[]; reason?: string;
};
const preparationError = (err: unknown, locale: Locale) => err instanceof ApiError && ['JOB_CLOSED', 'USER_SELECTED_DOCUMENT_PRESERVED', 'APPLICATION_CLOSED_OR_UNCERTAIN'].includes(err.code) ? reasonText(err.code, locale) : errorMessage(err);
const gapText = (value: string, locale: Locale) => ({
  PROFILE_REQUIRED: locale === 'es' ? 'Añade tu perfil.' : 'Add your profile.',
  FULL_NAME_REQUIRED: locale === 'es' ? 'Falta tu nombre.' : 'Your name is missing.',
  EMAIL_REQUIRED: locale === 'es' ? 'Falta tu correo.' : 'Your email is missing.',
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

function Queue() {
  const { locale } = useLocale(); const c = (es: string, en: string) => locale === 'es' ? es : en;
  const [items, setItems] = useState<Preparation[]>([]); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState('');
  const load = useCallback(async () => { try { setItems(await api<Preparation[]>('/preparations')); setError(''); } catch (err) { setError(preparationError(err, locale)); } finally { setLoading(false); } }, [locale]);
  useEffect(() => { void load(); }, [load]);
  const retry = async (jobId: string) => { setBusy(jobId); setError(''); try { await api<Preparation>('/preparations', { method: 'POST', body: JSON.stringify({ jobId, locale }) }); await load(); } catch (err) { setError(preparationError(err, locale)); } finally { setBusy(null); } };
  return <AppShell><PageHeader eyebrow={c('LISTAS PARA REVISAR', 'READY FOR REVIEW')} title={c('Candidaturas preparadas', 'Prepared applications')} description={c('Revisa qué datos aprobados se usaron, por qué se eligieron y qué falta completar.', 'Review which approved details were used, why they were selected, and what still needs attention.')} />
    {error && <Notice tone="error">{error}<Button variant="secondary" onClick={() => void load()}>{c('Volver a intentar', 'Try again')}</Button></Notice>}
    {loading ? <p role="status">{c('Cargando…', 'Loading…')}</p> : items.length === 0 ? <Empty title={c('Aún no hay candidaturas preparadas', 'No prepared applications yet')} detail={c('Puedes preparar un borrador desde una oferta guardada.', 'You can prepare a draft from any saved job.')} action={<Link className="button button-secondary" href="/jobs">{c('Ver ofertas guardadas', 'View saved jobs')}</Link>} /> : <div className={styles.queue}>{items.map((item) => <Card key={item.applicationId ?? item.jobId} className={styles.card}>
      <div className={styles.head}><div><span className="eyebrow">{item.company}</span><h2>{item.title}</h2></div><Tag tone={item.status === 'PREPARED' ? 'green' : item.status === 'BLOCKED' ? 'red' : 'amber'}>{item.status === 'PREPARED' ? c('Preparada', 'Prepared') : item.status === 'BLOCKED' ? c('Bloqueada', 'Blocked') : c('Revisión necesaria', 'Needs review')}</Tag></div>
      {item.reason && <Notice tone="warning">{reasonText(item.reason, locale)}</Notice>}
      {item.gaps.length > 0 && <div><h3>{c('Pendiente', 'Needs attention')}</h3><ul>{item.gaps.map((gap) => <li key={gap}>{gapText(gap, locale)}</li>)}</ul><Link href={`/profile?jobId=${item.jobId}`}>{c('Completar mi perfil', 'Complete my profile')}</Link></div>}
      {item.selectedFacts.length > 0 && <div><h3>{c('Experiencia incluida', 'Included experience')}</h3><ul>{item.selectedFacts.map((fact) => <li key={fact.id}><strong>{fact.statement}</strong><small className={styles.reason}>{factReason(fact.reason, locale)}</small></li>)}</ul></div>}
      {item.answerSuggestions.length > 0 && <div><h3>{c('Respuestas aprobadas sugeridas', 'Approved answer suggestions')}</h3><ul>{item.answerSuggestions.map((answer) => <li key={answer.answerId}><strong>{answer.question}: </strong>{typeof answer.value === 'string' ? answer.value : JSON.stringify(answer.value)}<small className={styles.reason}>{answerProvenance(answer.provenance, locale)}</small></li>)}</ul></div>}
      <div className={styles.actions}>{item.documentId && item.applicationId && <Link className="button button-primary" href={`/documents?applicationId=${item.applicationId}&jobId=${item.jobId}&view=review&document=${item.documentId}&from=saved`}>{c('Revisar documento', 'Review document')}</Link>}{item.applicationId && <Link className="button button-secondary" href={`/applications?id=${item.applicationId}`}>{c('Abrir solicitud', 'Open application')}</Link>}{item.status !== 'BLOCKED' && <Button variant="quiet" onClick={() => void retry(item.jobId)} disabled={busy === item.jobId}>{busy === item.jobId ? c('Reintentando…', 'Retrying…') : c('Volver a preparar', 'Prepare again')}</Button>}</div>
    </Card>)}</div>}
  </AppShell>;
}

export default function ApplicationPreparationPage() { return <WorkspaceGate><Queue/></WorkspaceGate>; }

export function ApplicationPreparationAction({ jobId }: { jobId: string }) {
  const { locale } = useLocale(); const c = (es: string, en: string) => locale === 'es' ? es : en;
  const [result, setResult] = useState<Preparation | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const prepare = async () => { setBusy(true); setError(''); try { setResult(await api<Preparation>('/preparations', { method: 'POST', body: JSON.stringify({ jobId, locale }) })); } catch (err) { setError(preparationError(err, locale)); } finally { setBusy(false); } };
  return <div className="preparation-action">
    <Button variant="secondary" onClick={() => void prepare()} disabled={busy}>{busy ? c('Preparando…', 'Preparing…') : c('Preparar candidatura', 'Prepare application')}</Button>
    {error && <Notice tone="error">{error}</Notice>}
    {result && <Card><p><Tag tone={result.status === 'PREPARED' ? 'green' : result.status === 'BLOCKED' ? 'red' : 'amber'}>{result.status === 'PREPARED' ? c('Preparada', 'Prepared') : result.status === 'BLOCKED' ? c('Bloqueada', 'Blocked') : c('Revisión necesaria', 'Needs review')}</Tag></p>
      {result.gaps.length > 0 && <><ul>{result.gaps.map((gap) => <li key={gap}>{gapText(gap, locale)}</li>)}</ul><Link href={`/profile?jobId=${jobId}`}>{c('Completar mi perfil', 'Complete my profile')}</Link></>}{result.reason && <p>{reasonText(result.reason, locale)}</p>}
      {result.selectedFacts.map((fact) => <p key={fact.id}><strong>{fact.statement}</strong><small className={styles.reason}>{factReason(fact.reason, locale)}</small></p>)}
      <div className={styles.actions}>{result.documentId && result.applicationId && <Link className="button button-primary" href={`/documents?applicationId=${result.applicationId}&jobId=${result.jobId}&view=review&document=${result.documentId}&from=saved`}>{c('Revisar documento', 'Review document')}</Link>}{result.applicationId && <Link className="button button-secondary" href={`/applications?id=${result.applicationId}`}>{c('Abrir solicitud', 'Open application')}</Link>}</div>
    </Card>}
  </div>;
}
