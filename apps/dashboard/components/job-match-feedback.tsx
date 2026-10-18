'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale } from '@/lib/i18n';
import { api, errorMessage } from '@/lib/api';
import { Button, Notice } from '@/components/ui';
import { copy } from '@/lib/labels';

type Rating = 'INTERESTED' | 'NOT_FOR_ME';
type Reason = 'LOCATION' | 'SENIORITY' | 'WORK_MODE' | 'ROLE_TYPE' | 'REQUIREMENT' | 'OTHER';
type Feedback = { rating: Rating; reason: Reason | null };
type Summary = { periodStart: string; periodEnd: string; windowDays: number; total: number; interested: number; notForMe: number; minimumSample: number; patterns: Array<{ reason: Reason; count: number }> };
const reasons: Reason[] = ['LOCATION', 'SENIORITY', 'WORK_MODE', 'ROLE_TYPE', 'REQUIREMENT', 'OTHER'];

export function JobMatchFeedback({ jobId }: { jobId: string }) {
  const { locale } = useLocale(); const c = copy(locale); const english = locale === 'en';
  const activeJobId = useRef(jobId); activeJobId.current = jobId;
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [rating, setRating] = useState<Rating | ''>(''); const [reason, setReason] = useState<Reason | ''>('');
  const [summary, setSummary] = useState<Summary | null>(null); const [busy, setBusy] = useState(false);
  const [loadedJobId, setLoadedJobId] = useState<string | null>(null);
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const isCurrentJobLoaded = loadedJobId === jobId;
  const currentFeedback = isCurrentJobLoaded ? feedback : null;
  const currentRating = isCurrentJobLoaded ? rating : '';
  const currentReason = isCurrentJobLoaded ? reason : '';
  useEffect(() => {
    let active = true;
    setLoadedJobId(null); setFeedback(null); setRating(''); setReason(''); setSummary(null); setBusy(false); setError(''); setMessage('');
    void Promise.all([
      api<Feedback | null>(`/jobs/${jobId}/feedback`), api<Summary>('/job-feedback/summary'),
    ]).then(([current, totals]) => {
      if (!active) return;
      setFeedback(current); setRating(current?.rating ?? ''); setReason(current?.reason ?? ''); setSummary(totals); setLoadedJobId(jobId);
    }).catch((err) => { if (active) setError(errorMessage(err)); });
    return () => { active = false; };
  }, [jobId]);

  const save = async () => {
    if (!currentRating || busy || !isCurrentJobLoaded) return;
    const requestedJobId = jobId;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await api<Feedback>(`/jobs/${requestedJobId}/feedback`, { method: 'PUT', body: JSON.stringify({ rating: currentRating, reason: currentReason || null }) });
      if (activeJobId.current !== requestedJobId) return;
      setFeedback(next); setMessage(english ? 'Your feedback was saved.' : 'Guardamos tu opinión.');
      const totals = await api<Summary>('/job-feedback/summary');
      if (activeJobId.current === requestedJobId) setSummary(totals);
    } catch (err) { if (activeJobId.current === requestedJobId) setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (busy || !currentFeedback || !isCurrentJobLoaded) return;
    const requestedJobId = jobId;
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/jobs/${requestedJobId}/feedback`, { method: 'DELETE' });
      if (activeJobId.current !== requestedJobId) return;
      setFeedback(null); setRating(''); setReason('');
      const totals = await api<Summary>('/job-feedback/summary');
      if (activeJobId.current !== requestedJobId) return;
      setSummary(totals);
      setMessage(english ? 'Your feedback was removed.' : 'Quitamos tu opinión.');
    } catch (err) { if (activeJobId.current === requestedJobId) setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const reasonLabel = (value: Reason) => ({ LOCATION: c('Ubicación', 'Location'), SENIORITY: c('Nivel de experiencia', 'Seniority'), WORK_MODE: c('Modalidad', 'Work mode'), ROLE_TYPE: c('Tipo de puesto', 'Role type'), REQUIREMENT: c('Requisito', 'Requirement'), OTHER: c('Otro motivo', 'Other reason') })[value];
  const date = (value: string) => new Intl.DateTimeFormat(english ? 'en-GB' : 'es-ES', { dateStyle: 'medium' }).format(new Date(value));

  return <section className="job-match-feedback" aria-labelledby={`job-feedback-${jobId}`} aria-busy={!isCurrentJobLoaded}>
    <h2 id={`job-feedback-${jobId}`}>{c('¿Te interesa esta oferta?', 'Is this job relevant to you?')}</h2>
    <p>{c('Tu opinión queda separada del encaje calculado y del estado de tu solicitud. No cambia la puntuación ni tus filtros.', 'Your feedback stays separate from calculated fit and application status. It does not change the score or your filters.')}</p>
    {error && <Notice tone="warning">{error}</Notice>}{message && <Notice tone="info" role="status">{message}</Notice>}
    <fieldset disabled={busy || !isCurrentJobLoaded}>
      <legend>{c('Elige una opción', 'Choose one')}</legend>
      <label><input type="radio" name={`feedback-${jobId}`} value="INTERESTED" checked={currentRating === 'INTERESTED'} onChange={() => setRating('INTERESTED')}/> {c('Me interesa', 'Interested')}</label>
      <label><input type="radio" name={`feedback-${jobId}`} value="NOT_FOR_ME" checked={currentRating === 'NOT_FOR_ME'} onChange={() => setRating('NOT_FOR_ME')}/> {c('No es para mí', 'Not for me')}</label>
    </fieldset>
    <label htmlFor={`feedback-reason-${jobId}`}>{c('Motivo opcional', 'Optional reason')}</label>
    <select id={`feedback-reason-${jobId}`} value={currentReason} disabled={busy || !isCurrentJobLoaded} onChange={(event) => setReason(event.target.value as Reason | '')}>
      <option value="">{c('Sin motivo', 'No reason')}</option>{reasons.map((item) => <option value={item} key={item}>{reasonLabel(item)}</option>)}
    </select>
    <div className="actions"><Button variant="secondary" disabled={busy || !currentRating || !isCurrentJobLoaded} onClick={() => void save()}>{currentFeedback ? c('Actualizar opinión', 'Update feedback') : c('Guardar opinión', 'Save feedback')}</Button>{currentFeedback && <Button variant="quiet" disabled={busy} onClick={() => void remove()}>{c('Eliminar opinión', 'Delete feedback')}</Button>}</div>
    {isCurrentJobLoaded && summary && <div aria-live="polite">
      <h3>{c('Lo que has marcado en los últimos 90 días', 'Your feedback from the last 90 days')}</h3>
      <p>{c(`Respuestas: ${summary.total} · Me interesa: ${summary.interested} · No es para mí: ${summary.notForMe}`, `Responses: ${summary.total} · Interested: ${summary.interested} · Not for me: ${summary.notForMe}`)}</p>
      <p><small>{c(`Periodo: ${date(summary.periodStart)}–${date(summary.periodEnd)}. Las respuestas no cambian el ranking.`, `Period: ${date(summary.periodStart)}–${date(summary.periodEnd)}. Feedback does not change ranking.`)}</small></p>
      {summary.notForMe < summary.minimumSample ? <p>{c(`Aún no mostramos patrones: hacen falta ${summary.minimumSample} respuestas explícitas de “No es para mí”.`, `We do not show patterns yet: ${summary.minimumSample} explicit “Not for me” responses are required.`)}</p> : summary.patterns.length ? <ul>{summary.patterns.map((item) => <li key={item.reason}>{reasonLabel(item.reason)}: {item.count}</li>)}</ul> : <p>{c('No hay un motivo repetido que alcance el mínimo de respuestas.', 'No repeated reason has reached the minimum response count.')}</p>}
      <Link href="/searches">{c('Revisar preferencias de búsqueda', 'Review search preferences')}</Link>
    </div>}
  </section>;
}
