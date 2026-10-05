'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AiError, AiLocale, AiOperation, AiRunState } from '@career/domain';
import { Button, Notice, Tag } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { localizedError, useLocale, type Locale } from '@/lib/i18n';
import { copy, labelFor } from '@/lib/labels';
import { AiResultView, type AiArtifact, type AiPreviewSources } from './result-view';
import { AiConnectionPanel } from './connection';
import styles from './draft-action.module.css';

export type AiDraftRequest =
  | { operation: 'SEARCH_DRAFT'; locale: AiLocale; searchRequest: string }
  | { operation: 'JOB_ANALYSIS'; locale: AiLocale; jobId: string; selectedFactIds?: string[] }
  | { operation: 'RESUME_DRAFT'; locale: AiLocale; jobId: string; selectedFactIds: string[] }
  | { operation: 'ANSWER_DRAFT'; locale: AiLocale; questionId: string; selectedFactIds?: string[]; jobId?: string };
export type AiRunPreview = {
  previewId: string; operation: AiOperation; locale: AiLocale; expiresAt: string; categories: string[];
  sources: AiPreviewSources; rememberedPermission: boolean; connection: { maskedIdentity: string | null };
};
type Run = { id: string; state: AiRunState; error?: AiError; artifactId?: string; origin?: 'MANUAL' | 'AUTOMATIC' };
type RecoveredRun = Run & { selectedFactIds?: string[] };
type StoredPreview = { value: AiRunPreview; requestKey: string };
type RunRequest = { previewId: string; idempotencyKey: string; rememberPermission: boolean };
type Work = 'preview' | 'start' | 'cancel' | null;
const ACTIVE_STATES = new Set<AiRunState>(['QUEUED', 'RUNNING', 'CANCEL_REQUESTED']);

function failureCode(failure: unknown): string {
  return failure instanceof ApiError ? failure.code : failure instanceof TypeError ? 'NETWORK_UNAVAILABLE' : 'UNKNOWN';
}
function draftError(code: string, locale: Locale): string {
  const c = copy(locale);
  const messages: Record<string, string> = {
    NOT_CONNECTED: c('Conecta tu cuenta de Codex en Ajustes para usar esta ayuda.', 'Connect your Codex account in Settings to use this help.'),
    AI_NOT_CONNECTED: c('Conecta tu cuenta de Codex en Ajustes para usar esta ayuda.', 'Connect your Codex account in Settings to use this help.'),
    AI_UNAVAILABLE: c('La ayuda con IA no está disponible ahora. Puedes seguir usando la app y revisar la conexión en Ajustes.', 'AI assistance is unavailable right now. You can keep using the app and check the connection in Settings.'),
    AI_DISABLED: c('La ayuda con IA no está activa en esta instalación.', 'AI assistance is not active on this installation.'),
    ACCOUNT_CHANGED: c('La cuenta de Codex cambió. Vuelve a conectarla en Ajustes antes de continuar.', 'The Codex account changed. Reconnect it in Settings before continuing.'),
    AI_ACCOUNT_CHANGED: c('La cuenta de Codex cambió. Vuelve a conectarla en Ajustes antes de continuar.', 'The Codex account changed. Reconnect it in Settings before continuing.'),
    CONSENT_MISSING: c('Revisa los datos y autoriza esta tarea antes de empezar.', 'Review the data and allow this task before starting.'),
    CONSENT_REVOKED: c('Retiraste el permiso para esta ayuda. Revisa los datos antes de autorizar otra tarea.', 'You withdrew permission for this help. Review the data before allowing another task.'),
    BUDGET_EXHAUSTED: c('Hay varias tareas pendientes o se alcanzó el límite de la app. Espera a que terminen antes de empezar otra.', 'There are several pending tasks or the app limit was reached. Wait for them to finish before starting another.'),
    PROVIDER_LIMIT_REACHED: c('Tu cuenta de Codex alcanzó un límite. Consulta el consumo en Ajustes y espera a que se restablezca.', 'Your Codex account reached a limit. Check usage in Settings and wait for it to reset.'),
    INPUT_TOO_LARGE: c('Hay demasiado texto para una sola tarea. Elige menos datos y vuelve a revisar lo que compartirás.', 'There is too much text for one task. Select fewer details and review what you will share again.'),
    SOURCE_CHANGED: c('Los datos cambiaron desde que los revisaste. Comprueba la versión actual antes de generar otra sugerencia.', 'The details changed since you reviewed them. Check the current version before generating another suggestion.'),
    AI_PREVIEW_EXPIRED: c('La revisión de datos caducó. Actualízala antes de empezar.', 'The data preview expired. Refresh it before starting.'),
    AI_PREVIEW_NOT_FOUND: c('Esta revisión de datos ya no está disponible. Actualízala antes de empezar.', 'This data preview is no longer available. Refresh it before starting.'),
    AI_INVALID_REQUEST: c('Revisa qué quieres preparar. Añade una petición o elige los datos necesarios.', 'Check what you want to prepare. Add a request or select the required details.'),
    AI_SOURCE_MISSING: c('Falta uno de los datos elegidos o ya no está confirmado. Revísalo antes de continuar.', 'One selected detail is missing or no longer confirmed. Review it before continuing.'),
    AI_SOURCE_INVALID: c('No se pueden usar algunos de los datos elegidos. Revísalos antes de continuar.', 'Some selected details cannot be used. Review them before continuing.'),
    AI_SOURCE_CHANGED: c('Los datos cambiaron. Actualiza la vista de lo que compartirás antes de continuar.', 'The details changed. Refresh the preview of what you will share before continuing.'),
    AI_SOURCE_TOO_LARGE: c('Hay demasiado texto para una tarea. Elige menos datos y vuelve a intentarlo.', 'There is too much text for one task. Select fewer details and try again.'),
    AI_CONSENT_INVALID: c('La conexión o el permiso cambió. Revisa la cuenta en Ajustes y actualiza los datos de esta tarea.', 'The connection or permission changed. Check your account in Settings and refresh this task’s data.'),
    AI_EQUIVALENT_ACTIVE: c('Ya hay una tarea en curso con estos datos. Espera a que termine antes de pedir otra sugerencia.', 'A task with these details is already in progress. Wait for it to finish before requesting another suggestion.'),
    AI_QUEUE_FULL: c('Hay varias tareas pendientes. Espera a que terminen antes de añadir otra.', 'Several tasks are waiting. Let them finish before adding another.'),
    AI_MANUAL_QUEUE_FULL: c('Ya tienes varias tareas en espera. Espera a que termine alguna.', 'You already have several tasks waiting. Wait for one to finish.'),
    AI_IDEMPOTENCY_CONFLICT: c('Esta tarea ya se solicitó con otros datos. Consulta el resultado antes de preparar otra.', 'This task was already requested with different details. Check the result before preparing another.'),
    AI_TOO_MANY_PREVIEWS: c('Has revisado muchas tareas seguidas. Espera unos minutos antes de preparar otra.', 'You have previewed many tasks in a short time. Wait a few minutes before preparing another.'),
    AI_RUN_NOT_FOUND: c('Esta tarea ya no está disponible. No se iniciará otra automáticamente.', 'This task is no longer available. Another task will not start automatically.'),
    TIMEOUT: c('Codex tardó más de lo esperado. No hay una nueva sugerencia disponible.', 'Codex took longer than expected. No new suggestion is available.'),
    INVALID_OUTPUT: c('La respuesta no pasó las comprobaciones de la app. No se ha usado su contenido.', 'The response did not pass the app’s checks. Its content has not been used.'),
    PROVIDER_ERROR: c('Codex no pudo completar la tarea. Puedes intentarlo de nuevo cuando quieras.', 'Codex could not complete the task. You can try again when you are ready.'),
    UNSUPPORTED_VERSION: c('La configuración de Codex necesita una revisión. Consulta la conexión en Ajustes.', 'Your Codex setup needs checking. Review the connection in Settings.'),
    AI_RESULT_UNAVAILABLE: c('La tarea terminó, pero no pudimos abrir su resultado. Consulta el resultado otra vez; no generaremos otra tarea.', 'The task finished, but we could not open its result. Check the result again; this will not generate another task.'),
  };
  return messages[code] ?? localizedError(code, locale);
}
const needsSettings = (code: string | null | undefined) => !!code && ['NOT_CONNECTED', 'AI_NOT_CONNECTED', 'AI_UNAVAILABLE', 'AI_DISABLED', 'ACCOUNT_CHANGED', 'AI_ACCOUNT_CHANGED', 'AI_CONSENT_INVALID', 'UNSUPPORTED_VERSION', 'PROVIDER_LIMIT_REACHED'].includes(code);

/** Local capability read only; it never inspects a provider account or starts an AI task. */
export function useAiAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ available: string[] }>('/capabilities', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setAvailable(result.available.includes('ai-processing'));
    }).catch(() => { /* Optional assistance stays hidden when capability status cannot be read. */ });
    return () => controller.abort();
  }, []);
  return available;
}

export function AiDraftAction({ request, label, onReview, renderResultActions, visible = true }: { request: AiDraftRequest; label: string; onReview?: (artifact: AiArtifact) => void; renderResultActions?: (artifact: AiArtifact, runId: string) => ReactNode; visible?: boolean }) {
  const { locale } = useLocale();
  const c = copy(locale);
  const regionId = useId();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  const workRef = useRef<Work>(null);
  const generation = useRef(0);
  const startRequest = useRef<RunRequest | null>(null);
  const [open, setOpen] = useState(false);
  const [work, setWork] = useState<Work>(null);
  const [preview, setPreview] = useState<StoredPreview | null>(null);
  const [remember, setRemember] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [runRequestKey, setRunRequestKey] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<{ value: AiArtifact; requestKey: string; runId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [uncertainStart, setUncertainStart] = useState(false);
  const [pollRetry, setPollRetry] = useState(0);
  const [pageVisible, setPageVisible] = useState(true);
  const [clock, setClock] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const historyLoaded = useRef<string | null>(null);
  const requestKey = JSON.stringify(request);
  const running = !!run && ACTIVE_STATES.has(run.state);
  const needsResult = !!run && (running || (run.state === 'SUCCEEDED' && artifact?.runId !== run.id));

  useEffect(() => {
    mounted.current = true;
    const updateVisibility = () => setPageVisible(document.visibilityState === 'visible');
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => { mounted.current = false; generation.current += 1; document.removeEventListener('visibilitychange', updateVisibility); };
  }, []);

  useEffect(() => {
    if (!visible || running || workRef.current || historyLoaded.current === requestKey) return;
    const controller = new AbortController();
    const ticket = generation.current;
    setHistoryLoading(true); setHistoryError(false);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const sourceRequest = JSON.parse(requestKey) as AiDraftRequest;
          const query = new URLSearchParams({ operation: sourceRequest.operation, locale: sourceRequest.locale });
          if ('jobId' in sourceRequest && sourceRequest.jobId) query.set('jobId', sourceRequest.jobId);
          if ('questionId' in sourceRequest) query.set('questionId', sourceRequest.questionId);
          if (sourceRequest.operation === 'SEARCH_DRAFT') {
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(sourceRequest.searchRequest.trim())));
            query.set('searchRequestHash', [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''));
          }
          const response = await api<{ runs: RecoveredRun[] }>(`/ai/runs?${query}`, { signal: controller.signal });
          if (controller.signal.aborted || generation.current !== ticket) return;
          const expectedFacts = 'selectedFactIds' in sourceRequest ? [...(sourceRequest.selectedFactIds ?? [])].sort() : [];
          const sameFacts = (item: RecoveredRun) => JSON.stringify([...(item.selectedFactIds ?? [])].sort()) === JSON.stringify(expectedFacts);
          const relevant = sourceRequest.operation === 'JOB_ANALYSIS' ? response.runs : response.runs.filter(sameFacts);
          const active = relevant.find(item => ACTIVE_STATES.has(item.state));
          const latestResult = relevant.find(item => item.state === 'SUCCEEDED' && item.artifactId);
          if (latestResult) {
            const result = await api<AiArtifact>(`/ai/artifacts/${encodeURIComponent(latestResult.artifactId!)}`, { signal: controller.signal }).catch(() => null);
            if (controller.signal.aborted || generation.current !== ticket) return;
            if (result) setArtifact({ value: result, requestKey, runId: latestResult.id });
          }
          // Set active state after loading the previous result: changing `running` cleans up this effect.
          historyLoaded.current = requestKey;
          setError(value => value === 'AI_EQUIVALENT_ACTIVE' ? null : value);
          if (active) { setRun(active); setRunRequestKey(requestKey); }
          else if (relevant[0]) { setRun(relevant[0]); setRunRequestKey(requestKey); }
        } catch {
          if (!controller.signal.aborted && generation.current === ticket) setHistoryError(true);
        } finally {
          if (!controller.signal.aborted && generation.current === ticket) setHistoryLoading(false);
        }
      })();
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); setHistoryLoading(false); };
  }, [visible, requestKey, running, historyRetry, work]);

  useEffect(() => {
    if (!visible || !open || !preview || run || !pageVisible) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [visible, open, preview, run, pageVisible]);

  const runId = run?.id;
  useEffect(() => {
    if (!visible || !open || !pageVisible || !runId || !needsResult || work) return;
    const controller = new AbortController();
    const ticket = generation.current;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await api<Run>(`/ai/runs/${encodeURIComponent(runId)}`, { signal: controller.signal });
        if (controller.signal.aborted || generation.current !== ticket) return;
        if (next.state === 'SUCCEEDED') {
          if (!next.artifactId) { setRun(next); setPollError('AI_RESULT_UNAVAILABLE'); return; }
          try {
            const result = await api<AiArtifact>(`/ai/artifacts/${encodeURIComponent(next.artifactId)}`, { signal: controller.signal });
            if (controller.signal.aborted || generation.current !== ticket) return;
            setArtifact({ value: result, runId, requestKey: runRequestKey ?? '' });
          } catch (failure) {
            if (!controller.signal.aborted && generation.current === ticket) { setRun(next); setPollError(failureCode(failure) === 'NETWORK_UNAVAILABLE' ? 'NETWORK_UNAVAILABLE' : 'AI_RESULT_UNAVAILABLE'); }
            return;
          }
        }
        setRun(next); setPollError(null);
        if (ACTIVE_STATES.has(next.state)) timer = window.setTimeout(() => void poll(), 2000);
      } catch (failure) {
        if (!controller.signal.aborted && generation.current === ticket) setPollError(failureCode(failure));
      }
    };
    void poll();
    // The task lives on the server. Hiding the component only stops status polling.
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [visible, open, pageVisible, runId, needsResult, work, pollRetry, runRequestKey]);

  const beginWork = (kind: NonNullable<Work>) => {
    if (workRef.current) return null;
    workRef.current = kind; setWork(kind); setError(null);
    return ++generation.current;
  };
  const endWork = (ticket: number) => {
    if (mounted.current && generation.current === ticket) { workRef.current = null; setWork(null); }
  };
  const prepare = async () => {
    setOpen(true);
    if (running || needsResult || uncertainStart || historyLoading) return;
    if (historyError) { setHistoryRetry(value => value + 1); return; }
    const ticket = beginWork('preview');
    if (ticket === null) return;
    try {
      const next = await api<AiRunPreview>('/ai/runs/preview', { method: 'POST', body: JSON.stringify(request) });
      if (!mounted.current || generation.current !== ticket) return;
      setPreview({ value: next, requestKey }); setRemember(false); setRun(null); setPollError(null); setClock(Date.now());
      startRequest.current = null;
      heading.current?.focus({ preventScroll: true });
    } catch (failure) {
      if (mounted.current && generation.current === ticket) setError(failureCode(failure));
    } finally { endWork(ticket); }
  };
  const start = async () => {
    if (!preview || running || needsResult || (!uncertainStart && (preview.requestKey !== requestKey || !Number.isFinite(Date.parse(preview.value.expiresAt)) || Date.parse(preview.value.expiresAt) <= Date.now()))) return;
    const ticket = beginWork('start');
    if (ticket === null) return;
    const payload = startRequest.current ?? { previewId: preview.value.previewId, idempotencyKey: crypto.randomUUID(), rememberPermission: remember };
    startRequest.current = payload;
    try {
      const next = await api<Run>('/ai/runs', { method: 'POST', body: JSON.stringify(payload) });
      if (!mounted.current || generation.current !== ticket) return;
      setRun(next); setRunRequestKey(preview.requestKey); setUncertainStart(false); setPollError(null);
      heading.current?.focus({ preventScroll: true });
    } catch (failure) {
      if (!mounted.current || generation.current !== ticket) return;
      const uncertain = !(failure instanceof ApiError) || failure.status >= 500 || failure.status === 408;
      setUncertainStart(uncertain); setError(failureCode(failure));
      if (failure instanceof ApiError && failure.code === 'AI_EQUIVALENT_ACTIVE') {
        historyLoaded.current = null;
        setHistoryRetry(value => value + 1);
      }
      if (!uncertain) startRequest.current = null;
    } finally { endWork(ticket); }
  };
  const cancel = async () => {
    if (!run || !running || run.state === 'CANCEL_REQUESTED') return;
    const ticket = beginWork('cancel');
    if (ticket === null) return;
    try {
      const next = await api<Run>(`/ai/runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST' });
      if (mounted.current && generation.current === ticket) { setRun(next); setPollError(null); }
    } catch (failure) {
      if (mounted.current && generation.current === ticket) setError(failureCode(failure));
    } finally { endWork(ticket); }
  };

  const previewExpired = !!preview && (!Number.isFinite(Date.parse(preview.value.expiresAt)) || Date.parse(preview.value.expiresAt) <= clock);
  const previewChanged = !!preview && preview.requestKey !== requestKey;
  const categories: Record<string, string> = { SEARCH_REQUEST: c('Lo que buscas', 'Your search request'), JOB_POSTING: c('Texto de la oferta', 'Job posting text'), APPROVED_FACTS: c('Datos confirmados de tu perfil', 'Confirmed profile details'), APPLICATION_QUESTION: c('Pregunta de la solicitud', 'Application question') };
  const progress = run?.state === 'QUEUED' ? c('En espera. La tarea empezará cuando Codex esté disponible.', 'Waiting. The task will start when Codex is available.') : run?.state === 'CANCEL_REQUESTED' ? c('Deteniendo la tarea…', 'Stopping the task…') : run?.state === 'SUCCEEDED' ? c('La sugerencia está lista. Consultando el resultado…', 'The suggestion is ready. Opening the result…') : c('Codex está preparando la sugerencia…', 'Codex is preparing the suggestion…');
  const oldResult = !!artifact && (artifact.requestKey !== requestKey || (!!run && artifact.runId !== run.id));
  const connectionProblem = needsSettings(error) || needsSettings(run?.error?.code);

  return <div className={styles.action} hidden={!visible}>
    <div className={styles.actions}><Button type="button" variant="secondary" aria-expanded={open} aria-controls={regionId} disabled={work !== null || historyLoading} onClick={() => { if ((artifact || run) && !open) setOpen(true); else void prepare(); }}>{historyLoading ? c('Consultando tareas anteriores…', 'Checking earlier tasks…') : work === 'preview' ? c('Preparando los datos…', 'Preparing the data…') : running || needsResult ? c('Ver progreso de la ayuda', 'View assistance progress') : uncertainStart ? c('Revisar la tarea pendiente', 'Check the pending task') : run && ['FAILED', 'INTERRUPTED', 'CANCELLED'].includes(run.state) && !open ? c('Ver qué pasó con la tarea', 'See what happened to the task') : artifact && !open ? c('Ver la sugerencia guardada', 'View the saved suggestion') : label}</Button></div>
    {historyError && <Notice tone="warning" actions={<Button type="button" variant="secondary" disabled={work !== null || historyLoading} onClick={() => setHistoryRetry(value => value + 1)}>{c('Reintentar carga del historial', 'Retry loading history')}</Button>}>{c('No pudimos consultar las tareas anteriores. Reintenta para recuperar su estado antes de iniciar otra.', 'We could not check earlier tasks. Retry to recover their status before starting another.')}</Notice>}
    {open && <section id={regionId} className={styles.panel} aria-labelledby={headingId}>
      <div className={styles.heading}><h3 ref={heading} tabIndex={-1} id={headingId}>{c('Ayuda de Codex', 'Help from Codex')}</h3><Button type="button" variant="quiet" disabled={work !== null} onClick={() => setOpen(false)}>{c('Ocultar', 'Hide')}</Button></div>
      {work === 'preview' && <p role="status">{c('Preparando la vista de los datos que compartirás. Todavía no se envían a Codex.', 'Preparing a preview of the data you will share. It has not been sent to Codex yet.')}</p>}
      {error && <Notice tone="error">{draftError(error, locale)}</Notice>}
      {connectionProblem && <div className={styles.actions}><Button type="button" variant="secondary" aria-expanded={connectionOpen} aria-controls={`${regionId}-connection`} onClick={() => setConnectionOpen(value => !value)}>{connectionOpen ? c('Ocultar la conexión', 'Hide connection') : c('Revisar la conexión aquí', 'Check the connection here')}</Button></div>}
      {connectionOpen && <div id={`${regionId}-connection`} className={styles.section}>
        <AiConnectionPanel visible={visible && open} onConnectionChange={state => {
          if (state.enabled && state.connection?.authorized && state.connection.sessionState === 'SIGNED_IN') setError(null);
        }}/>
        <div className={styles.actions}><Button type="button" variant="secondary" disabled={work !== null || running || needsResult || uncertainStart} onClick={() => { setConnectionOpen(false); void prepare(); }}>{c('Volver a revisar los datos de mi tarea', 'Review my task’s data again')}</Button></div>
      </div>}
      {uncertainStart && <Notice tone="warning"><div className={styles.section}><p>{c('No pudimos confirmar si la tarea empezó. Reintentar consultará la misma solicitud para evitar duplicarla.', 'We could not confirm whether the task started. Retrying uses the same request to avoid a duplicate.')}</p><div className={styles.actions}><Button type="button" disabled={work !== null} onClick={() => void start()}>{work === 'start' ? c('Comprobando…', 'Checking…') : c('Reintentar esta tarea', 'Retry this task')}</Button></div></div></Notice>}
      {preview && !run && !uncertainStart && <>
        <p>{c('Codex usará estos datos para preparar una sugerencia. Tú la revisarás antes de usarla.', 'Codex will use these details to prepare a suggestion. You will review it before using it.')}</p>
        {preview.value.connection.maskedIdentity && <p className={styles.hint}>{c('Cuenta:', 'Account:')} {preview.value.connection.maskedIdentity}</p>}
        <ul className={styles.categories}>{preview.value.categories.map((category, index) => <li key={`${category}-${index}`}><Tag>{categories[category] ?? c('Otros datos de esta tarea', 'Other details for this task')}</Tag></li>)}</ul>
        <details className={styles.preview}><summary>{c('Ver exactamente qué se comparte', 'See exactly what will be shared')}</summary><div className={styles.sourceBody}>
          {preview.value.sources.searchRequest && <div className={styles.section}><h4>{c('Lo que buscas', 'Your search request')}</h4><p className={styles.source}>{preview.value.sources.searchRequest}</p></div>}
          {preview.value.sources.job && <div className={styles.section}><h4>{c('Texto de la oferta', 'Job posting text')}</h4><p className={styles.source}>{preview.value.sources.job}</p></div>}
          {preview.value.sources.question && <div className={styles.section}><h4>{c('Pregunta', 'Question')}</h4><p className={styles.source}>{preview.value.sources.question}</p></div>}
          {preview.value.sources.facts.length > 0 && <div className={styles.section}><h4>{c('Datos confirmados que se usarán', 'Confirmed details that will be used')}</h4><ul className={styles.facts}>{preview.value.sources.facts.map(fact => <li key={fact.factId}><div className={styles.fact}><span className={styles.hint}>{labelFor.factKind(fact.kind, locale)}</span><p className={styles.source}>{fact.text}</p></div></li>)}</ul></div>}
        </div></details>
        <p className={styles.hint}>{c('Al permitir esta tarea, estos datos se envían a OpenAI. Puede consumir cuota de tu plan de Codex.', 'Allowing this task sends these details to OpenAI. It may use your Codex plan’s quota.')}</p>
        {preview.value.rememberedPermission ? <p className={styles.hint}>{c('Ya guardaste permiso para este tipo de ayuda. Esta tarea solo empieza cuando tú lo eliges.', 'You have already saved permission for this type of help. This task only starts when you choose.')}</p> : <label className={styles.check}><input type="checkbox" checked={remember} disabled={work !== null} onChange={event => setRemember(event.target.checked)}/><span>{c('Recordar este permiso para este tipo de ayuda', 'Remember this permission for this type of help')}<small>{c('No activa tareas automáticas. Podrás revisar los datos antes de cada tarea.', 'This does not turn on automatic tasks. You can review the data before each task.')}</small></span></label>}
        {(previewExpired || previewChanged) && <Notice tone="warning">{previewChanged ? c('Cambiaste lo que quieres preparar. Actualiza los datos antes de continuar.', 'You changed what you want to prepare. Refresh the data before continuing.') : c('Esta vista de los datos ha caducado. Actualízala antes de continuar.', 'This data preview has expired. Refresh it before continuing.')}</Notice>}
        <div className={styles.actions}>{previewExpired || previewChanged ? <Button type="button" disabled={work !== null} onClick={() => void prepare()}>{c('Actualizar los datos', 'Refresh the data')}</Button> : <Button type="button" disabled={work !== null} onClick={() => void start()}>{work === 'start' ? c('Iniciando…', 'Starting…') : c('Permitir esta tarea', 'Allow this task')}</Button>}</div>
      </>}
      {needsResult && <div className={styles.progress}><p role="status">{progress}</p><p className={styles.hint}>{c('Puedes seguir usando la app. Ocultar esta sección no cancela la tarea.', 'You can keep using the app. Hiding this section does not cancel the task.')}</p>{running && <><div className={styles.actions}><Button type="button" variant="secondary" disabled={work !== null || run?.state === 'CANCEL_REQUESTED'} onClick={() => void cancel()}>{work === 'cancel' || run?.state === 'CANCEL_REQUESTED' ? c('Cancelando…', 'Cancelling…') : c('Cancelar tarea', 'Cancel task')}</Button></div><p className={styles.hint}>{c('Si Codex ya empezó, cancelar puede consumir cuota igualmente.', 'If Codex has already started, cancelling may still use quota.')}</p></>}</div>}
      {pollError && <Notice tone="warning" actions={<Button type="button" variant="secondary" disabled={work !== null} onClick={() => { setPollError(null); setPollRetry(value => value + 1); }}>{c('Consultar el estado otra vez', 'Check the status again')}</Button>}>{draftError(pollError, locale)}</Notice>}
      {run?.state === 'FAILED' && <Notice tone="error"><div className={styles.section}><p>{draftError(run.error?.code ?? 'PROVIDER_ERROR', locale)}</p>{run.error?.dispatched !== 'NO' && <p className={styles.hint}>{c('La tarea puede haber consumido cuota aunque no haya un resultado.', 'The task may have used quota even though there is no result.')}</p>}</div></Notice>}
      {run?.state === 'INTERRUPTED' && <Notice tone="warning">{c('La tarea se interrumpió. No se repetirá sola y puede haber consumido cuota. Puedes preparar otra cuando quieras.', 'The task was interrupted. It will not repeat on its own and may have used quota. You can prepare another when you are ready.')}</Notice>}
      {run?.state === 'CANCELLED' && <Notice>{c('Tarea cancelada. No se ha añadido una nueva sugerencia.', 'Task cancelled. No new suggestion has been added.')}</Notice>}
      {artifact && <>{oldResult && <p className={styles.hint}>{c('Se conserva la sugerencia anterior. Sus datos pueden ser distintos de los que acabas de elegir.', 'The previous suggestion is preserved. Its source details may differ from your current selection.')}</p>}{!oldResult && run?.origin === 'AUTOMATIC' && <p className={styles.hint}>{c('Resumen preparado automáticamente para una búsqueda que autorizaste. Puedes consultar sus datos de origen debajo.', 'Summary prepared automatically for a search you authorized. You can check its supporting details below.')}</p>}<AiResultView artifact={artifact.value} {...(!oldResult && onReview ? { onReview } : {})}/>{!oldResult && run?.origin === 'MANUAL' && artifact.value.state !== 'STALE' && renderResultActions?.(artifact.value, artifact.runId)}</>}
    </section>}
  </div>;
}
