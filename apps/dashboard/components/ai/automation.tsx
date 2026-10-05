'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button, Field, Notice, Tag } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { localizedError, useLocale } from '@/lib/i18n';
import { copy, labelFor } from '@/lib/labels';
import styles from './draft-action.module.css';

type Search = { id: string; role: string; company: string; location: string; enabled: boolean };
type Fact = { factId: string; kind: string; text: string };
type Policy = { id: string; revision: number; active: boolean; paused: boolean; searchIds: string[]; selectedFactIds: string[]; locale: string; maximumDailyStarts: number; activatedAt: string; maskedIdentity: string | null; queued: number; ready: number };
type Overview = { enabled: boolean; policies: Policy[]; searches: Search[]; facts: Fact[]; limits: { maximumDailyStarts: number; maximumPerPass: number } };
type Preview = { previewId: string; expiresAt: string; searches: Search[]; sources: { facts: Fact[] }; categories: string[]; locale: string; maximumDailyStarts: number; connection: { maskedIdentity: string | null }; newOffersOnly: true };
const searchLabel = (search: Search) => [search.role, search.company, search.location].filter(Boolean).join(' · ');

/** Optional setup only. Reading or opening this panel never schedules a provider task. */
export function AiAutomationPanel({ sourceRunId, connectionRevision = 0, onChanged }: { sourceRunId?: string; connectionRevision?: number; onChanged?: () => void }) {
  const { locale } = useLocale(); const c = copy(locale); const id = useId();
  const [open, setOpen] = useState(false); const [overview, setOverview] = useState<Overview | null>(null);
  const [searchIds, setSearchIds] = useState<string[]>([]); const [factIds, setFactIds] = useState<string[]>([]);
  const [maximum, setMaximum] = useState('1'); const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false);
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [reload, setReload] = useState(0);
  const mutation = useRef(false); const activation = useRef<{ previewId: string; idempotencyKey: string } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setLoading(true);
    void api<Overview>(`/ai/automation?locale=${locale}`, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setOverview(value); setError(''); }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof ApiError ? failure.code : 'NETWORK_UNAVAILABLE'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, locale, reload, connectionRevision]);
  useEffect(() => { if (!uncertain) { setPreview(null); activation.current = null; } }, [locale, sourceRunId, uncertain]);
  const errors: Record<string, string> = {
    AI_UNAVAILABLE: c('Esta ayuda no está disponible ahora. Puedes consultar tus ofertas normalmente.', 'This help is unavailable now. You can browse your jobs as usual.'),
    AI_NOT_CONNECTED: c('Conecta Codex en Ajustes antes de activar esta ayuda.', 'Connect Codex in Settings before enabling this help.'),
    AI_MANUAL_ANALYSIS_REQUIRED: c('Primero pide y revisa el resumen de una oferta. Después podrás elegir si quieres esta ayuda automática.', 'First request and review a job summary. Then you can decide whether to use this automatic help.'),
    AI_SEARCH_CHANGED: c('Una búsqueda cambió. Actualiza la lista y revisa tu selección.', 'A search changed. Refresh the list and review your selection.'),
    AI_SOURCE_CHANGED: c('Tus datos cambiaron. Actualiza la lista y revisa qué compartirás.', 'Your details changed. Refresh the list and review what you will share.'),
    AI_PREVIEW_EXPIRED: c('La revisión de datos caducó. Revisa los datos de nuevo antes de activar.', 'The data preview expired. Review the details again before enabling.'),
    AI_POLICY_CHANGED: c('La configuración cambió. Actualiza la lista antes de continuar.', 'The settings changed. Refresh the list before continuing.'),
    AI_POLICY_NOT_FOUND: c('Esta configuración ya no está disponible. Actualiza la lista.', 'These settings are no longer available. Refresh the list.'),
    AI_IDEMPOTENCY_CONFLICT: c('La activación ya se procesó con otros datos. Actualiza la lista antes de continuar.', 'Activation was already processed with different details. Refresh the list before continuing.'),
  };
  const act = async (action: () => Promise<void>) => {
    if (mutation.current) return; mutation.current = true; setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (failure) { setError(failure instanceof ApiError ? failure.code : 'NETWORK_UNAVAILABLE'); }
    finally { mutation.current = false; setBusy(false); }
  };
  const prepare = () => act(async () => {
    const value = await api<Preview>('/ai/automation/preview', { method: 'POST', body: JSON.stringify({ sourceRunId, searchIds, selectedFactIds: factIds, locale, maximumDailyStarts: Number(maximum) }) });
    setPreview(value); activation.current = { previewId: value.previewId, idempotencyKey: crypto.randomUUID() }; setUncertain(false);
  });
  const activate = () => act(async () => {
    if (!activation.current) return;
    try {
      await api<Policy>('/ai/automation', { method: 'POST', body: JSON.stringify(activation.current) });
      setUncertain(false); setPreview(null); activation.current = null; setSearchIds([]); setFactIds([]); setReload(value => value + 1);
      onChanged?.();
      setMessage(c('Ayuda automática activada para las búsquedas elegidas. Los resultados aparecerán al abrir cada oferta nueva.', 'Automatic help enabled for the selected searches. Results will appear when you open each new job.'));
    } catch (failure) { setUncertain(!(failure instanceof ApiError) || failure.status >= 500 || failure.status === 408); throw failure; }
  });
  const pause = (policy: Policy) => act(async () => {
    await api(`/ai/automation/${encodeURIComponent(policy.id)}/pause`, { method: 'POST', body: JSON.stringify({ expectedRevision: policy.revision }) });
    setReload(value => value + 1); setMessage(c('Ayuda automática pausada. Las tareas que ya empezaron pueden consumir cuota.', 'Automatic help paused. Tasks that already started may use quota.'));
    onChanged?.();
  });
  const changeSelection = (values: string[], value: string, checked: boolean) => checked ? [...values, value] : values.filter(item => item !== value);
  const locked = busy || loading || uncertain;
  return <details className={styles.preview} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{c('Resumir ofertas nuevas automáticamente · opcional', 'Summarize new jobs automatically · optional')}</summary>
    <div className={styles.section}>
      <p>{c('Puedes pedir a Codex que resuma las ofertas nuevas de las búsquedas que elijas. Cada resumen puede consumir cuota de tu plan.', 'You can ask Codex to summarize new jobs from the searches you choose. Each summary may use your plan’s quota.')}</p>
      {loading && <p role="status">{c('Cargando configuración…', 'Loading settings…')}</p>}
      {error && <Notice tone="error" actions={<Button type="button" variant="secondary" disabled={busy} onClick={() => setReload(value => value + 1)}>{c('Actualizar lista', 'Refresh list')}</Button>}>{errors[error] ?? localizedError(error, locale)}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      {overview?.policies.map(policy => <section className={styles.resultItem} key={policy.id} aria-label={c('Configuración de resúmenes automáticos', 'Automatic summary settings')}>
        <div className={styles.heading}><strong>{c('Resúmenes automáticos', 'Automatic summaries')}</strong><Tag tone={policy.active && !policy.paused ? 'green' : 'amber'}>{policy.active && !policy.paused ? c('Activos', 'Active') : c('Pausados', 'Paused')}</Tag></div>
        <ul className={styles.list}>{policy.searchIds.map(searchId => <li key={searchId}>{searchLabel(overview.searches.find(search => search.id === searchId) ?? { id: searchId, role: c('Búsqueda ya no disponible', 'Search no longer available'), company: '', location: '', enabled: false })}</li>)}</ul>
        <p className={styles.hint}>{c(`Hasta ${policy.maximumDailyStarts} tareas al día · ${policy.queued} pendientes · ${policy.ready} listas`, `Up to ${policy.maximumDailyStarts} tasks a day · ${policy.queued} waiting · ${policy.ready} ready`)}</p>
        {policy.maskedIdentity && <p className={styles.hint}>{c('Cuenta:', 'Account:')} {policy.maskedIdentity}</p>}
        <p className={styles.hint}>{policy.selectedFactIds.length ? c(`${policy.selectedFactIds.length} datos de perfil seleccionados`, `${policy.selectedFactIds.length} profile details selected`) : c('Solo el texto de las ofertas', 'Job posting text only')}</p>
        {policy.active && !policy.paused && <div className={styles.actions}><Button type="button" variant="secondary" disabled={busy} onClick={() => void pause(policy)}>{c('Pausar resúmenes', 'Pause summaries')}</Button></div>}
      </section>)}
      {overview && !overview.enabled && <Notice>{c('La ayuda automática no está disponible en esta instalación. Puedes pausar cualquier permiso guardado.', 'Automatic help is unavailable on this installation. You can pause any saved permission.')}</Notice>}
      {overview?.enabled && !sourceRunId && <p className={styles.hint}>{c('Para activarla o volver a activarla, abre una oferta y pide un resumen con Codex. La opción aparecerá debajo del resultado.', 'To enable or re-enable this help, open a job and request a summary with Codex. The option will appear below the result.')}</p>}
      {overview?.enabled && sourceRunId && !preview && <>
        <fieldset className={styles.section} disabled={locked}><legend>{c('Elige las búsquedas', 'Choose searches')}</legend>
          {overview.searches.map(search => <label className={styles.check} key={search.id}><input type="checkbox" checked={searchIds.includes(search.id)} onChange={event => setSearchIds(changeSelection(searchIds, search.id, event.target.checked))}/><span>{searchLabel(search)}{!search.enabled && <small>{c('Búsqueda pausada', 'Search paused')}</small>}</span></label>)}
          {!overview.searches.length && <p>{c('Primero guarda una búsqueda en Buscar empleo.', 'First save a search in Find jobs.')}</p>}
        </fieldset>
        {overview.facts.length > 0 && <fieldset className={styles.section} disabled={locked}><legend>{c('Comparar también con mi experiencia · opcional', 'Also compare with my experience · optional')}</legend><p className={styles.hint}>{c('Sin seleccionar nada se comparte solo la oferta. Los datos que elijas se compartirán en cada resumen.', 'If you select nothing, only the job posting is shared. Any details you choose will be shared for each summary.')}</p>{overview.facts.map(fact => <label className={styles.check} key={fact.factId}><input type="checkbox" checked={factIds.includes(fact.factId)} onChange={event => setFactIds(changeSelection(factIds, fact.factId, event.target.checked))}/><span><small>{labelFor.factKind(fact.kind, locale)}</small>{fact.text}</span></label>)}</fieldset>}
        <Field id={`${id}-maximum`} label={c('Máximo de resúmenes al día', 'Maximum summaries per day')} type="number" min={1} max={overview.limits.maximumDailyStarts} step={1} value={maximum} disabled={locked} onChange={event => setMaximum(event.target.value)}/>
        <div className={styles.actions}><Button type="button" disabled={locked || !searchIds.length || !Number.isInteger(Number(maximum)) || Number(maximum) < 1 || Number(maximum) > overview.limits.maximumDailyStarts} onClick={() => void prepare()}>{c('Revisar antes de activar', 'Review before enabling')}</Button></div>
      </>}
      {preview && <section className={styles.panel} aria-label={c('Datos para la ayuda automática', 'Data for automatic help')}>
        <h3>{c('Comprueba qué compartirás', 'Check what you will share')}</h3>
        <p>{c('Se enviará a OpenAI el texto de cada oferta nueva de estas búsquedas y los datos de perfil seleccionados. Esta autorización continúa hasta que la pauses o desconectes la cuenta.', 'The text of each new job from these searches and the selected profile details will be sent to OpenAI. This permission continues until you pause it or disconnect your account.')}</p>
        <ul className={styles.list}>{preview.searches.map(search => <li key={search.id}>{searchLabel(search)}</li>)}</ul>
        <p>{c(`Límite: ${preview.maximumDailyStarts} tareas al día.`, `Limit: ${preview.maximumDailyStarts} tasks per day.`)}</p>
        {preview.connection.maskedIdentity && <p>{c('Cuenta:', 'Account:')} {preview.connection.maskedIdentity}</p>}
        <details className={styles.evidence}><summary>{c('Ver los datos del perfil que se compartirán', 'See the profile details that will be shared')}</summary>{preview.sources.facts.length ? <ul className={styles.facts}>{preview.sources.facts.map(fact => <li key={fact.factId}><p className={styles.source}>{fact.text}</p></li>)}</ul> : <p>{c('Ningún dato de perfil. Solo el texto de la oferta.', 'No profile details. Only the job posting text.')}</p>}</details>
        <p className={styles.hint}>{c('Solo se resumirán las ofertas encontradas después de activar esta opción. Funciona mientras el servicio local está encendido. No envía candidaturas ni modifica tu perfil.', 'Only jobs found after enabling this option will be summarized. It works while the local service is running. It does not submit applications or change your profile.')}</p>
        {uncertain && <Notice tone="warning">{c('No pudimos confirmar la activación. Reintentar comprobará la misma solicitud.', 'We could not confirm activation. Retrying will check the same request.')}</Notice>}
        <div className={styles.actions}><Button type="button" disabled={busy} onClick={() => void activate()}>{busy ? c('Activando…', 'Enabling…') : uncertain ? c('Comprobar la activación', 'Check activation') : c('Permitir resúmenes automáticos', 'Allow automatic summaries')}</Button><Button type="button" variant="secondary" disabled={busy || uncertain} onClick={() => { setPreview(null); activation.current = null; }}>{c('Cambiar selección', 'Change selection')}</Button></div>
      </section>}
    </div>
  </details>;
}
