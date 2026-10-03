'use client';

import { useDisclosureFocus } from '@/lib/disclosure-focus';

import { useSessionDraft, stringDraft } from '@/lib/session-draft';
import { ApplicationJourney } from '@/components/application-journey';
import { AssistedApplication } from '@/components/assisted-application';
import { useLocale } from '@/lib/i18n';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Empty, Field, Icon, Notice, SelectField, Tag, TextareaField } from '@/components/ui';
import { api, ApiError, errorMessage, formatDate } from '@/lib/api';
import { copy, labelFor, recruitmentStageOrder, selectableApplicationStates } from '@/lib/labels';
import type { Locale } from '@/lib/locale';

type Application = { documentId: string | null; id: string; jobId: string | null; company: string; role: string; location: string | null; canonicalUrl: string | null; state: string; recruitmentStage: string; shortlistDecision: string; notes: string; updatedAt: string; version?: number };
type AppEvent = { id: string; eventType: string; reason: string | null; createdAt: string; priorState: string | null; newState: string | null };
type Patch = { state?: string; recruitmentStage?: string; confirmationEvidence?: 'USER_ATTESTATION'; correction?: true };

/** Mirrors allowedApplicationTransitions in @career/domain, limited to states a person can set by hand in v0.3. */
const transitions: Record<string, string[]> = {
  DRAFT: ['PREPARING', 'CONFIRMED', 'CANCELLED'], PREPARING: ['REVIEW_REQUIRED', 'CONFIRMED', 'CANCELLED'], REVIEW_REQUIRED: ['PREPARING', 'CONFIRMED', 'CANCELLED'],
  READY: ['REVIEW_REQUIRED', 'CONFIRMED', 'CANCELLED'], IN_PROGRESS: ['CONFIRMED', 'CANCELLED'], UNKNOWN: ['CONFIRMED', 'REVIEW_REQUIRED'], CONFIRMED: ['REVIEW_REQUIRED'], CANCELLED: [],
};
/** Opens the linked resume first (review view, closing to the library); without one, the builder for this application. */
const resumeHref = (application: Application) => {
  const params = new URLSearchParams({ applicationId: application.id }); if (application.jobId) params.set('jobId', application.jobId);
  if (application.documentId) { params.set('view', 'review'); params.set('document', application.documentId); params.set('from', 'saved'); }
  return `/documents?${params}`;
};
const stateTone = (state: string) => state === 'CONFIRMED' ? 'green' : state === 'UNKNOWN' ? 'red' : state === 'CANCELLED' ? 'neutral' : 'blue';

function eventDetail(event: AppEvent, locale: Locale) {
  const c = copy(locale);
  if (event.eventType === 'RECRUITMENT_STAGE_CHANGED' || event.eventType === 'RECRUITMENT_STAGE_CORRECTED') {
    const arrow = `${labelFor.recruitmentStage(event.priorState, locale)} → ${labelFor.recruitmentStage(event.newState, locale)}`;
    return event.reason && /correct/i.test(event.reason) ? `${arrow} · ${c('corrección', 'correction')}` : arrow;
  }
  if (event.eventType === 'APPLICATION_RESUME_SELECTED') return c('CV seleccionado para esta solicitud: ', 'Resume selected for this application: ') + (event.reason ?? '');
  if (event.eventType === 'APPLICATION_STATE_CHANGED') return `${labelFor.applicationState(event.priorState, locale)} → ${labelFor.applicationState(event.newState, locale)}`;
  if (event.eventType.startsWith('ASSIST_') && event.eventType !== 'ASSIST_USER_RECONCILED') return c('Acción registrada para esta solicitud. El envío requiere intervención manual.', 'Action recorded for this application. Submission requires manual interaction.');
  if (event.reason === 'Manual user record') return c('Registro manual', 'Added manually');
  if (event.reason === 'User-attested confirmation') return c('Confirmación declarada por ti', 'Confirmation reported by you');
  return event.reason ?? c('Cambio guardado', 'Change saved');
}

function ApplicationsView() {
  const { locale } = useLocale(); const c = copy(locale);
  const router = useRouter(); const pathname = usePathname(); const searchParams = useSearchParams(); const urlId = searchParams.get('id');
  const [rows, setRows] = useState<Application[]>([]); const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [selectedId, setSelectedId] = useState<string | null>(urlId);
  const [events, setEvents] = useState<AppEvent[]>([]); const [eventsState, setEventsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [open, setOpen] = useState(false);
  const formHeading = useDisclosureFocus(open);
  const formDraft = useSessionDraft('application-create', { company: '', role: '', url: '', location: '', applied: '' }, (value): value is { company: string; role: string; url: string; location: string; applied: string } => stringDraft(value) && ['company', 'role', 'url', 'location', 'applied'].every((key) => typeof value[key] === 'string'));
  const { company, role, url, location } = formDraft.value; const alreadyApplied = formDraft.value.applied === 'yes';
  const setCompany = (company: string) => formDraft.update((d) => ({ ...d, company })); const setRole = (role: string) => formDraft.update((d) => ({ ...d, role })); const setUrl = (url: string) => formDraft.update((d) => ({ ...d, url })); const setLocation = (location: string) => formDraft.update((d) => ({ ...d, location })); const setAlreadyApplied = (applied: boolean) => formDraft.update((d) => ({ ...d, applied: applied ? 'yes' : '' }));
  const hasFormDraft = Object.values(formDraft.value).some(Boolean);
  const notes = useSessionDraft<Record<string, string>>('application-notes', {}, stringDraft);
  const note = selectedId ? notes.value[selectedId] ?? '' : '';
  const setNote = (text: string) => { if (selectedId) notes.update((drafts) => ({ ...drafts, [selectedId]: text })); }; const [pendingStage, setPendingStage] = useState<string | null>(null); const [confirmApplied, setConfirmApplied] = useState(false);
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState<string | null>(null);
  const eventsRequest = useRef(0);
  // The selection as of now, not as of the render that started a request: async handlers compare against it after every await.
  const selectedRef = useRef<string | null>(urlId);
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  const loadRows = useCallback(async () => {
    try { const list = await api<Application[]>('/applications'); setRows(list); setLoadState('ready'); return list; }
    catch (err) { setError(errorMessage(err)); setLoadState((current) => current === 'ready' ? 'ready' : 'error'); return null; }
  }, []);
  /** Only the most recent request may write events, so a slow response for a previous selection never shows under the current one. */
  const loadEvents = useCallback(async (id: string) => {
    const ticket = ++eventsRequest.current; setEventsState('loading');
    try { const list = await api<AppEvent[]>(`/applications/${id}/events`); if (ticket === eventsRequest.current) { setEvents(list); setEventsState('ready'); } }
    catch (err) { if (ticket === eventsRequest.current) { setEventsState('error'); setError(errorMessage(err)); } }
  }, []);

  useEffect(() => { void loadRows(); }, [loadRows]);
  // Follow the URL (deep links from job pages, back/forward navigation).
  useEffect(() => { setSelectedId(urlId); }, [urlId]);
  useEffect(() => {
    selectedRef.current = selectedId;
    setEvents([]); setPendingStage(null); setConfirmApplied(false);
    if (selectedId) void loadEvents(selectedId); else { eventsRequest.current++; setEventsState('idle'); }
  }, [selectedId, loadEvents]);

  const select = (id: string | null, keepNotices = false) => {
    selectedRef.current = id; setSelectedId(id); if (!keepNotices) { setMessage(''); setError(''); }
    // Read the live URL: after an await, the searchParams captured by this render may already be outdated.
    const params = new URLSearchParams(window.location.search); if (id) params.set('id', id); else params.delete('id');
    router.replace(`${pathname}${params.size ? `?${params}` : ''}`, { scroll: false });
  };

  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy('create'); setError(''); setMessage('');
    const selectionAtStart = selectedRef.current;
    try {
      const created = await api<Application>('/applications', { method: 'POST', body: JSON.stringify({ company: company.trim(), role: role.trim(), location: location.trim() || null, canonicalUrl: url.trim() || null, state: alreadyApplied ? 'CONFIRMED' : 'DRAFT', ...(alreadyApplied ? { confirmationEvidence: 'USER_ATTESTATION' } : {}), recruitmentStage: 'NO_RESPONSE', notes: '' }) });
      setMessage(alreadyApplied ? c('Solicitud registrada como enviada por ti.', 'Application recorded as sent by you.') : c('Solicitud añadida al seguimiento.', 'Application added to your tracker.'));
      setOpen(false); setCompany(''); setRole(''); setLocation(''); setUrl(''); setAlreadyApplied(false);
      await loadRows();
      // Jump to the new record unless the person picked another one (or navigated) while it was saving.
      if (selectedRef.current === selectionAtStart) select(created.id, true);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(null); }
  };

  const update = async (patch: Patch, success: string) => {
    if (!selected) return false;
    const id = selected.id; setBusy('update'); setError(''); setMessage('');
    try {
      const updated = await api<Application>(`/applications/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      setRows((current) => current.map((row) => row.id === updated.id ? updated : row)); setMessage(success);
      if (selectedRef.current === id) void loadEvents(id);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.code === 'STALE_APPLICATION_VERSION') { await loadRows(); if (selectedRef.current === id) void loadEvents(id); }
      return false;
    } finally { setBusy(null); }
  };

  const chooseStage = (stage: string) => {
    if (!selected || stage === selected.recruitmentStage) return;
    if (recruitmentStageOrder.indexOf(stage) < recruitmentStageOrder.indexOf(selected.recruitmentStage)) { setPendingStage(stage); return; }
    setPendingStage(null); void update({ recruitmentStage: stage }, c('Etapa actualizada.', 'Stage updated.'));
  };
  const confirmCorrection = async () => { if (!pendingStage) return; if (await update({ recruitmentStage: pendingStage, correction: true }, c('Etapa corregida. El historial conserva el cambio.', 'Stage corrected. The history keeps a record of the change.'))) setPendingStage(null); };
  const chooseState = (state: string) => {
    if (!selected || state === selected.state) return;
    if (state === 'CONFIRMED') { setConfirmApplied(true); return; }
    setConfirmApplied(false); void update({ state }, c('Estado actualizado.', 'Status updated.'));
  };
  const confirmSent = async () => { if (await update({ state: 'CONFIRMED', confirmationEvidence: 'USER_ATTESTATION' }, c('Marcada como enviada por ti.', 'Marked as sent by you.'))) setConfirmApplied(false); };

  const addNote = async (event: FormEvent) => {
    event.preventDefault(); if (!selected || !note.trim()) return;
    const id = selected.id; const submitted = note; setBusy('note'); setError(''); setMessage('');
    try {
      await api(`/applications/${id}/events`, { method: 'POST', body: JSON.stringify({ eventType: 'USER_NOTE', note: submitted.trim() }) });
      setMessage(c('Nota añadida al historial.', 'Note added to the history.'));
      // Clear only the saved snapshot for this application, even if the selection changed.
      notes.update((drafts) => { if (drafts[id] !== submitted) return drafts; const next = { ...drafts }; delete next[id]; return next; });
      if (selectedRef.current === id) void loadEvents(id);
    }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(null); }
  };

  const stateChoices = selected ? [selected.state, ...(transitions[selected.state] ?? []).filter((state) => (selectableApplicationStates as readonly string[]).includes(state))] : [];

  return <>
    <PageHeader eyebrow={c('SEGUIMIENTO, SIN PRESIÓN', 'TRACKING, WITHOUT PRESSURE')} title={c('Mis solicitudes', 'My applications')} description={c('Guarda los puestos a los que quieres solicitar, prepara el formulario y anota las respuestas de las empresas. Añadir aquí una solicitud no la envía.', 'Track jobs you want to apply for, prepare the form, and record employer responses. Adding an application here does not submit it.')} action={<Button onClick={() => setOpen(!open)}><Icon name="plus" size={16}/>{open ? c('Cerrar', 'Close') : c('Añadir solicitud', 'Add application')}</Button>}/>
    {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    {hasFormDraft && <Notice tone={formDraft.storageFailed ? 'warning' : 'info'} actions={<><Button variant="quiet" onClick={() => setOpen(true)}>{c('Continuar borrador', 'Continue draft')}</Button><Button variant="quiet" disabled={busy !== null} onClick={() => { if (window.confirm(c('¿Descartar esta solicitud sin guardar?', 'Discard this unsaved application?'))) formDraft.update({ company: '', role: '', url: '', location: '', applied: '' }); }}>{c('Descartar borrador', 'Discard draft')}</Button></>}>{formDraft.storageFailed ? c('No se pudo conservar el borrador. Guarda o descarta la solicitud antes de salir.', 'The draft could not be preserved. Save or discard the application before leaving.') : c('Solicitud sin guardar: el borrador se conserva en esta pestaña hasta que cierres sesión.', 'Unsaved application: the draft is kept in this tab until you sign out.')}</Notice>}
    {open && <Card className="import-card"><div className="form-heading"><div><span className="step-badge">＋</span><div><h2 ref={formHeading} tabIndex={-1}>{c('Registrar una solicitud', 'Add an application')}</h2><p>{c('Solo guardamos lo que tú escribes; nada se envía a la empresa.', 'We only save what you type; nothing is sent to the employer.')}</p></div></div></div>
      <form className="form-grid" onSubmit={(event) => void create(event)} aria-busy={busy === 'create'}>
        <Field label={c('Empresa', 'Company')} disabled={busy === 'create' || !formDraft.ready} value={company} onChange={(e) => setCompany(e.target.value)} required/><Field label={c('Puesto', 'Role')} disabled={busy === 'create' || !formDraft.ready} value={role} onChange={(e) => setRole(e.target.value)} required/>
        <Field label={c('Ubicación', 'Location')} disabled={busy === 'create' || !formDraft.ready} value={location} onChange={(e) => setLocation(e.target.value)}/><Field label={c('Enlace a la oferta', 'Link to the job post')} type="url" disabled={busy === 'create' || !formDraft.ready} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://"/>
        <label className="checkbox-line"><input type="checkbox" disabled={busy === 'create' || !formDraft.ready} checked={alreadyApplied} onChange={(e) => setAlreadyApplied(e.target.checked)}/><span>{c('Ya envié esta solicitud.', 'I have already sent this application.')}<small>{c('Se guarda como una declaración tuya, no como una verificación con la empresa.', 'It is saved as your own statement, not as a check with the employer.')}</small></span></label>
        <div className="form-submit"><Button type="submit" disabled={busy !== null || !formDraft.ready || !company.trim() || !role.trim()}>{busy === 'create' ? c('Guardando…', 'Saving…') : c('Guardar solicitud', 'Save application')}</Button></div>
      </form></Card>}
    {loadState === 'loading' ? <Notice>{c('Cargando solicitudes…', 'Loading applications…')}</Notice>
      : loadState === 'error' && !rows.length ? <Card className="jobs-empty"><Empty title={c('No pudimos cargar tus solicitudes', 'We could not load your applications')} detail={c('Comprueba que el servicio local esté en marcha.', 'Check that the local service is running.')} action={<Button variant="secondary" onClick={() => { setError(''); setLoadState('loading'); void loadRows(); }}>{c('Reintentar', 'Try again')}</Button>}/></Card>
      : rows.length ? <div className="tracker-layout">
        <Card className="tracker-list"><div className="tracker-list-head"><span>{rows.length} {rows.length === 1 ? c('REGISTRO', 'RECORD') : c('REGISTROS', 'RECORDS')}</span><span>{c('ACTUALIZADOS RECIENTEMENTE', 'RECENTLY UPDATED')}</span></div>
          {rows.map((row) => <button className={`tracker-row ${selectedId === row.id ? 'tracker-selected' : ''}`} key={row.id} aria-current={selectedId === row.id ? 'true' : undefined} onClick={() => select(row.id)}><span className={`tracker-avatar state-${row.state.toLowerCase()}`}>{row.company.slice(0, 1)}</span><span className="tracker-main"><strong>{row.role}</strong><small>{row.company}{row.location ? ` · ${row.location}` : ''} · {labelFor.recruitmentStage(row.recruitmentStage, locale)}</small></span><span className="tracker-date">{formatDate(row.updatedAt)}</span><Tag tone={stateTone(row.state)}>{labelFor.applicationState(row.state, locale)}</Tag></button>)}
        </Card>
        <Card className="tracker-detail">{selected ? <>
          <div className="tracker-detail-head"><div><div className="eyebrow"><span className="eyebrow-mark"/> {c('TU HISTORIAL', 'YOUR HISTORY')}</div><h2>{selected.role}</h2><p>{selected.company}{selected.location ? ` · ${selected.location}` : ''}</p>
            <div className="detail-actions">{selected.jobId && <Link className="button button-quiet" href={`/jobs/${selected.jobId}`}>{c('Ver oferta', 'View job')} <Icon name="arrow" size={13}/></Link>}{selected.canonicalUrl && <a className="button button-quiet" href={selected.canonicalUrl} target="_blank" rel="noopener noreferrer">{c('Abrir oferta original', 'Open original post')} <Icon name="arrow" size={13}/></a>}</div>
          </div><Tag tone={stateTone(selected.state)}>{labelFor.applicationState(selected.state, locale)}</Tag></div>
          <ApplicationJourney jobId={selected.jobId} applicationId={selected.id} stage="application"/>
          <div className="application-resume"><h3>{c('CV para esta solicitud', 'Resume for this application')}</h3>{selected.documentId ? <><p>{c('El CV elegido está vinculado a esta solicitud. Descargarlo no lo envía a la empresa.', 'The selected resume is linked to this application. Downloading it does not send it to the employer.')}</p><a className="button button-secondary" href={`/api/v1/documents/${selected.documentId}/file`}>{c('Descargar CV elegido', 'Download selected resume')}</a></> : <p>{c('Todavía no has elegido un CV para esta solicitud.', 'You have not selected a resume for this application yet.')}</p>}<Link className="button button-quiet" href={resumeHref(selected)}>{selected.documentId ? c('Revisar o cambiar CV', 'Review or change resume') : c('Preparar o elegir CV', 'Prepare or choose resume')}</Link></div>
          <div className="tracker-controls">
            <SelectField label={c('Etapa del proceso', 'Hiring stage')} value={pendingStage ?? selected.recruitmentStage} disabled={busy !== null} onChange={(e) => chooseStage(e.target.value)}>{recruitmentStageOrder.map((stage) => <option key={stage} value={stage}>{labelFor.recruitmentStage(stage, locale)}</option>)}</SelectField>
            <SelectField label={c('Estado de la solicitud', 'Application status')} value={confirmApplied ? 'CONFIRMED' : selected.state} disabled={busy !== null || stateChoices.length < 2} onChange={(e) => chooseState(e.target.value)}>{stateChoices.map((state) => <option key={state} value={state}>{labelFor.applicationState(state, locale)}</option>)}</SelectField>
            <div className="notice notice-info tracker-boundary">{c('Tú decides cuándo enviar. Usa el flujo asistido para registrar el resultado de la ventana de Lever.', 'You decide when to submit. Use the assisted flow to record the outcome from the Lever window.')}</div>
          </div>
          {pendingStage && <Notice tone="warning" role="alert" actions={<><Button variant="secondary" disabled={busy !== null} onClick={() => void confirmCorrection()}>{busy === 'update' ? c('Guardando…', 'Saving…') : c('Sí, corregir etapa', 'Yes, correct stage')}</Button><Button variant="quiet" disabled={busy !== null} onClick={() => setPendingStage(null)}>{c('Cancelar', 'Cancel')}</Button></>}>{c(`¿Corregir la etapa de «${labelFor.recruitmentStage(selected.recruitmentStage, locale)}» a «${labelFor.recruitmentStage(pendingStage, locale)}»? Úsalo si te equivocaste; el historial guardará la corrección.`, `Correct the stage from “${labelFor.recruitmentStage(selected.recruitmentStage, 'en')}” to “${labelFor.recruitmentStage(pendingStage, 'en')}”? Use this if you made a mistake; the history keeps the correction.`)}</Notice>}
          {confirmApplied && <Notice tone="warning" role="alert" actions={<><Button variant="secondary" disabled={busy !== null} onClick={() => void confirmSent()}>{busy === 'update' ? c('Guardando…', 'Saving…') : c('Sí, la envié', 'Yes, I sent it')}</Button><Button variant="quiet" disabled={busy !== null} onClick={() => setConfirmApplied(false)}>{c('Cancelar', 'Cancel')}</Button></>}>{c('Confirma que enviaste esta solicitud tú mismo. Se guardará como tu declaración; no lo comprobamos con la empresa.', 'Confirm that you sent this application yourself. It is saved as your statement; we do not check it with the employer.')}</Notice>}
          {selected.state === 'CONFIRMED' && <div className="notice notice-success">{c('Confirmación basada en tu declaración. No se verificó con la empresa.', 'This confirmation is based on your statement. It was not verified with the employer.')}</div>}
          <AssistedApplication key={selected.id} applicationId={selected.id} onChanged={() => { void loadRows(); void loadEvents(selected.id); }}/>
          <form className="note-form" onSubmit={(event) => void addNote(event)}><TextareaField label={c('Añadir nota al historial', 'Add a note to the history')} rows={3} value={note} disabled={busy === 'note' || !notes.ready} onChange={(e) => setNote(e.target.value)} placeholder={c('Próximo paso, preguntas o contexto…', 'Next step, questions, or context…')} maxLength={10000}/><Button type="submit" variant="secondary" disabled={busy !== null || !notes.ready || !note.trim()}>{busy === 'note' ? c('Guardando…', 'Saving…') : c('Añadir nota', 'Add note')}</Button></form>
          {note && <Notice tone={notes.storageFailed ? 'warning' : 'info'} actions={<Button variant="quiet" disabled={busy !== null} onClick={() => { if (window.confirm(c('¿Descartar el borrador de esta nota?', 'Discard this note draft?'))) notes.update((drafts) => { const next = { ...drafts }; delete next[selected!.id]; return next; }); }}>{c('Descartar nota', 'Discard note')}</Button>}>{notes.storageFailed ? c('No se pudo conservar el borrador. Añade la nota o descártala antes de salir.', 'The draft could not be preserved. Add the note or discard it before leaving.') : c('Borrador de esta solicitud conservado en esta pestaña hasta que cierres sesión. Pulsa Añadir nota para guardarlo en el historial.', 'This application draft is kept in this tab until you sign out. Select Add note to save it to the history.')}</Notice>}
          <div className="timeline"><h3>{c('Actividad', 'Activity')}</h3>
            {eventsState === 'loading' && !events.length && <p className="muted-label">{c('Cargando actividad…', 'Loading activity…')}</p>}
            {eventsState === 'error' && <p className="muted-label">{c('No se pudo cargar la actividad.', 'The activity could not be loaded.')} <Button variant="quiet" onClick={() => void loadEvents(selected.id)}>{c('Reintentar', 'Try again')}</Button></p>}
            {events.map((event) => <div className="timeline-item" key={event.id}><span className="timeline-dot"/><div><strong>{labelFor.applicationEvent(event.eventType, locale)}</strong><p>{eventDetail(event, locale)}</p><small>{formatDate(event.createdAt)}</small></div></div>)}
          </div>
        </> : selectedId && loadState === 'ready' ? <Empty title={c('No encontramos esa solicitud', 'We could not find that application')} detail={c('Puede que se haya eliminado o que el enlace sea antiguo. Elige otra de la lista.', 'It may have been removed or the link is outdated. Choose another one from the list.')} action={<Button variant="secondary" onClick={() => select(null)}>{c('Quitar selección', 'Clear selection')}</Button>}/>
          : <Empty title={c('Elige una solicitud', 'Choose an application')} detail={c('Selecciona un registro para ver su actividad y actualizar el siguiente paso.', 'Choose an application to see its activity and update the next step.')}/>}</Card>
      </div>
      : <Card className="jobs-empty"><Empty title={c('Todavía no hay solicitudes', 'No applications yet')} detail={c('Crea un registro al empezar una solicitud o anota una solicitud que ya enviaste.', 'Create a record when you start an application, or log one you already sent.')} action={<Button variant="secondary" onClick={() => setOpen(true)}><Icon name="plus" size={15}/> {c('Crear primer registro', 'Create your first record')}</Button>}/></Card>}
  </>;
}

export default function ApplicationsPage() {
  return <WorkspaceGate><AppShell><Suspense fallback={null}><ApplicationsView/></Suspense></AppShell></WorkspaceGate>;
}
