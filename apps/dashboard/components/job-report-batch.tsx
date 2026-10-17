'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { JOB_REPORT_BATCH_LIMITS } from '@career/domain';
import { Button, Card, Notice, Tag } from '@/components/ui';
import { verdictTone } from '@/components/job-report';
import { useLocale } from '@/lib/i18n';
import { api, ApiError, errorMessage } from '@/lib/api';
import { copy, labelFor } from '@/lib/labels';
import styles from '@/app/jobs/jobs.module.css';

type BatchItem = { jobId: string; company: string | null; title: string | null; status: string; verdict: string | null; errorCode: string | null; supportedCount: number | null; requirementCount: number | null };
export type JobReportBatch = { id: string; status: string; total: number; counts: { pending: number; done: number; failed: number; skipped: number }; items: BatchItem[] };

/** Pause between passes so a long batch stays well below the API rate limit and the page stays responsive. */
const PASS_DELAY_MS = 400;

/**
 * Evaluates several saved jobs in one action (#110): shows how many will be evaluated and asks first, runs in
 * passes of five while this page is open, can pause, continue or cancel without losing evaluated jobs, and lists
 * every job afterwards with the most favourable conclusions first.
 */
export function JobReportBatchPanel({ selectedIds, pageIds, onSelect, jobHref }: { selectedIds: string[]; pageIds: string[]; onSelect: (ids: string[]) => void; jobHref: (id: string) => string }) {
  const { locale } = useLocale(); const c = copy(locale);
  const [batch, setBatch] = useState<JobReportBatch | null>(null); const [loaded, setLoaded] = useState(false);
  const [confirming, setConfirming] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const confirmHeading = useRef<HTMLHeadingElement>(null); const resultsHeading = useRef<HTMLHeadingElement>(null);
  // Responses to a pass started before a pause or cancel must not overwrite the newer state.
  const actionVersion = useRef(0); const runningBatchId = useRef<string | null>(null); const batchRef = useRef<JobReportBatch | null>(null); const mounted = useRef(true);
  const commitBatch = useCallback((next: JobReportBatch | null) => { batchRef.current = next; setBatch(next); }, []);
  const tooMany = selectedIds.length > JOB_REPORT_BATCH_LIMITS.maxJobs;
  const active = batch?.status === 'RUNNING' || batch?.status === 'PAUSED';

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; actionVersion.current += 1; }; }, []);
  useEffect(() => {
    api<{ batch: JobReportBatch | null }>('/job-report-batches/current').then((result) => { if (mounted.current) { commitBatch(result.batch); setLoaded(true); } })
      .catch((err) => { if (mounted.current) { setError(errorMessage(err)); setLoaded(true); } });
  }, [commitBatch]);
  useEffect(() => { if (confirming) confirmHeading.current?.focus(); }, [confirming]);

  const runPasses = useCallback(async (id: string) => {
    if (runningBatchId.current) return;
    runningBatchId.current = id;
    try {
      while (mounted.current) {
        if (document.hidden) { await new Promise((resolve) => setTimeout(resolve, 1_000)); continue; }
        const version = actionVersion.current;
        const next = await api<JobReportBatch>(`/job-report-batches/${id}/advance`, { method: 'POST', body: '{}' });
        if (!mounted.current) break;
        // A pause, continue or cancel happened meanwhile: ask again so the loop follows the newest state.
        if (version !== actionVersion.current) {
          if (batchRef.current?.id !== id) break;
          continue;
        }
        commitBatch(next);
        if (next.status !== 'RUNNING') { if (next.status === 'COMPLETED') resultsHeading.current?.focus(); break; }
        await new Promise((resolve) => setTimeout(resolve, PASS_DELAY_MS));
      }
    } catch (err) { if (mounted.current) setError(errorMessage(err)); }
    finally {
      runningBatchId.current = null;
      const latest = batchRef.current;
      if (mounted.current && latest?.status === 'RUNNING' && latest.id !== id) void runPasses(latest.id);
    }
  }, [commitBatch]);
  useEffect(() => { if (batch?.status === 'RUNNING') void runPasses(batch.id); }, [batch?.id, batch?.status, runPasses]);

  const start = async () => {
    actionVersion.current += 1; setBusy(true); setError('');
    try {
      const created = await api<JobReportBatch>('/job-report-batches', { method: 'POST', body: JSON.stringify({ jobIds: selectedIds, idempotencyKey: crypto.randomUUID() }) });
      commitBatch(created); setConfirming(false); onSelect([]);
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.code === 'JOB_REPORT_BATCH_ACTIVE' && err.detail) commitBatch(await api<JobReportBatch>(`/job-report-batches/${err.detail}`).catch(() => null));
      setConfirming(false);
    } finally { setBusy(false); }
  };
  const change = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!batch) return;
    if (action === 'cancel' && !window.confirm(c('¿Cancelar la evaluación? Las ofertas ya evaluadas se conservan.', 'Cancel the evaluation? Jobs already evaluated are kept.'))) return;
    actionVersion.current += 1; setBusy(true); setError('');
    try { commitBatch(await api<JobReportBatch>(`/job-report-batches/${batch.id}/${action}`, { method: 'POST', body: '{}' })); }
    catch (err) { setError(errorMessage(err)); if (err instanceof ApiError && err.status === 409) commitBatch(await api<JobReportBatch>(`/job-report-batches/${batch.id}`).catch(() => batch)); }
    finally { setBusy(false); }
  };

  const evaluated = batch ? batch.counts.done + batch.counts.failed + batch.counts.skipped : 0;
  const finished = batch && !active;
  return <Card className={styles.batch} aria-labelledby="job-report-batch-heading" data-testid="job-report-batch">
    <div><div className="eyebrow"><span className="eyebrow-mark"/> {c('EVALUAR VARIAS', 'EVALUATE SEVERAL')}</div><h2 id="job-report-batch-heading">{c('Evaluar ofertas guardadas', 'Evaluate saved jobs')}</h2></div>
    <p>{c(`Elige ofertas guardadas y prepara el informe de cada una en una sola acción. Se calcula en tu equipo con tus datos confirmados; no se comparte nada con Codex. Hasta ${JOB_REPORT_BATCH_LIMITS.maxJobs} ofertas, de ${JOB_REPORT_BATCH_LIMITS.perPass} en ${JOB_REPORT_BATCH_LIMITS.perPass}, mientras esta página esté abierta.`, `Choose saved jobs and prepare each one's report in one action. It is calculated on your computer with your confirmed details; nothing is shared with Codex. Up to ${JOB_REPORT_BATCH_LIMITS.maxJobs} jobs, ${JOB_REPORT_BATCH_LIMITS.perPass} at a time, while this page is open.`)}</p>
    {error && <Notice tone="error">{error}</Notice>}
    {!active && loaded && !confirming && <div className={styles.batchActions}>
      <Button disabled={busy || !selectedIds.length || tooMany} onClick={() => setConfirming(true)}>{!selectedIds.length ? c('Evaluar ofertas seleccionadas', 'Evaluate selected jobs') : selectedIds.length === 1 ? c('Evaluar 1 oferta seleccionada', 'Evaluate 1 selected job') : c(`Evaluar ${selectedIds.length} ofertas seleccionadas`, `Evaluate ${selectedIds.length} selected jobs`)}</Button>
      {pageIds.length > 0 && <Button variant="quiet" disabled={busy} onClick={() => onSelect([...new Set([...selectedIds, ...pageIds])])}>{c('Seleccionar todas las de esta página', 'Select all on this page')}</Button>}
      {selectedIds.length > 0 && <Button variant="quiet" disabled={busy} onClick={() => onSelect([])}>{c('Quitar la selección', 'Clear selection')}</Button>}
    </div>}
    {!active && loaded && !selectedIds.length && !confirming && <p className="muted-label">{c('Marca la casilla «Evaluar» de las ofertas que quieras comparar.', 'Tick the “Evaluate” box on the jobs you want to compare.')}</p>}
    {tooMany && <Notice tone="warning">{c(`Puedes evaluar hasta ${JOB_REPORT_BATCH_LIMITS.maxJobs} ofertas a la vez. Quita algunas de la selección.`, `You can evaluate up to ${JOB_REPORT_BATCH_LIMITS.maxJobs} jobs at a time. Remove some from the selection.`)}</Notice>}
    {confirming && <div className={styles.batchActions} role="group" aria-labelledby="job-report-batch-confirm">
      <h3 id="job-report-batch-confirm" ref={confirmHeading} tabIndex={-1} className="focus-heading">{selectedIds.length === 1 ? c('Se evaluará 1 oferta. ¿Empezamos?', '1 job will be evaluated. Start?') : c(`Se evaluarán ${selectedIds.length} ofertas. ¿Empezamos?`, `${selectedIds.length} jobs will be evaluated. Start?`)}</h3>
      <Button disabled={busy} onClick={() => void start()}>{busy ? c('Empezando…', 'Starting…') : c('Sí, evaluar', 'Yes, evaluate')}</Button>
      <Button variant="quiet" disabled={busy} onClick={() => setConfirming(false)}>{c('No, volver', 'No, go back')}</Button>
    </div>}
    {batch && <>
      <div aria-live="polite" role="status">
        <p><Tag tone={batch.status === 'COMPLETED' ? 'green' : batch.status === 'CANCELLED' ? 'neutral' : batch.status === 'PAUSED' ? 'amber' : 'blue'}>{labelFor.reportBatchState(batch.status, locale)}</Tag> {c(`${evaluated} de ${batch.total} revisadas`, `${evaluated} of ${batch.total} reviewed`)}{batch.counts.failed ? c(` · ${batch.counts.failed} con error`, ` · ${batch.counts.failed} failed`) : ''}{batch.counts.skipped ? c(` · ${batch.counts.skipped} omitidas`, ` · ${batch.counts.skipped} skipped`) : ''}</p>
      </div>
      <progress className={styles.batchProgress} max={batch.total} value={evaluated} aria-label={c('Progreso de la evaluación', 'Evaluation progress')}/>
      {active && <div className={styles.batchActions}>
        {batch.status === 'RUNNING' ? <Button variant="secondary" disabled={busy} onClick={() => void change('pause')}>{c('Pausar', 'Pause')}</Button> : <Button disabled={busy} onClick={() => void change('resume')}>{c('Continuar', 'Continue')}</Button>}
        <Button variant="quiet" disabled={busy} onClick={() => void change('cancel')}>{c('Cancelar evaluación', 'Cancel evaluation')}</Button>
      </div>}
      {batch.status === 'PAUSED' && <Notice>{c('Evaluación en pausa. Lo ya evaluado se conserva; continúa cuando quieras.', 'Evaluation paused. What was evaluated is kept; continue whenever you like.')}</Notice>}
      <h3 ref={resultsHeading} tabIndex={-1} className="focus-heading">{finished ? c('Resultados, de más a menos favorable', 'Results, most favourable first') : c('Resultados hasta ahora', 'Results so far')}</h3>
      <ul className={styles.batchResults} aria-label={c('Ofertas evaluadas', 'Evaluated jobs')}>{batch.items.map((item) => <li key={item.jobId} data-batch-item={item.jobId} data-status={item.status}>
        <span>{item.title ? <Link href={jobHref(item.jobId)}>{item.title}</Link> : c('Oferta no disponible', 'Job not available')}{item.company ? ` · ${item.company}` : ''}</span>
        {item.status === 'DONE' && item.verdict ? <Tag tone={verdictTone(item.verdict)}>{labelFor.reportVerdict(item.verdict, locale)}</Tag> : item.status === 'PENDING' ? <Tag>{c('Pendiente', 'Waiting')}</Tag> : <Tag tone={item.status === 'FAILED' ? 'red' : 'neutral'}>{item.status === 'FAILED' ? c('Error', 'Failed') : c('Omitida', 'Skipped')}</Tag>}
        {item.status === 'DONE' && item.requirementCount !== null ? <small>{item.requirementCount ? c(`${item.supportedCount} de ${item.requirementCount} requisitos reconocidos respaldados por tus datos confirmados`, `${item.supportedCount} of ${item.requirementCount} recognised requirements backed by your confirmed details`) : c('Sin requisitos concretos que comparar', 'No specific requirements to compare')}</small> : item.errorCode ? <small>{labelFor.reportItemError(item.errorCode, locale)}</small> : null}
      </li>)}</ul>
    </>}
  </Card>;
}
