'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ApplicationJourney } from '@/components/application-journey';
import { ProfileEntryForm, type EntryInput, type ProfileEntry } from '@/components/profile-entry-form';
import { useLocale } from '@/lib/i18n';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Empty, Field, Notice, SelectField, Tag, TextareaField } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { copy, countryName, countryOptions, humanizeKey, labelFor, normalizeWorkMode, workModes as workModeLabels } from '@/lib/labels';

type Fact = ProfileEntry & { approvalStatus: string };
type Answer = { id: string; semanticKey: string; questionText?: string | null; jurisdiction: string; questionScope: string; value: unknown; approvalStatus: string; strategy: string; revision?: number };
type Profile = { revision: number; locale?: string; profile: { identity?: { fullName?: string; email?: string; country?: string }; preferences?: { targetTitles?: string[]; workModes?: string[] } }; facts: Fact[]; answers: Answer[] };
type ProfileForm = { name: string; email: string; country: string; titles: string; modes: string[] };

const emptyForm: ProfileForm = { name: '', email: '', country: '', titles: '', modes: [] };
const formFromProfile = (profile: Profile): ProfileForm => {
  const identity = profile.profile.identity ?? {}; const preferences = profile.profile.preferences ?? {};
  return { name: identity.fullName ?? '', email: identity.email ?? '', country: (identity.country ?? '').toUpperCase(), titles: (preferences.targetTitles ?? []).join(', '), modes: [...new Set((preferences.workModes ?? []).map(normalizeWorkMode).filter(Boolean))] };
};
const splitList = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean);
/** Server rejections that mean this page is looking at an older profile revision; the fix is reloading, not retyping. */
const revisionConflictCodes = new Set(['PROFILE_REVISION_CONFLICT', 'FACT_NOT_IN_CURRENT_REVISION', 'ANSWER_REVISION_STALE']);
/** Same-origin link clicks that would leave this page through client-side navigation. */
const leavingLink = (event: MouseEvent): HTMLAnchorElement | null => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return null;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) return null;
  return anchor;
};
const answerText = (value: unknown) => typeof value === 'string' ? value : value === null || value === undefined ? '' : JSON.stringify(value);

function CountryOptions({ current }: { current: string }) {
  const { locale } = useLocale(); const c = copy(locale);
  const options = useMemo(() => countryOptions(locale, current), [locale, current]);
  return <><optgroup label={c('Frecuentes', 'Common')}>{options.common.map((option) => <option key={`common-${option.code}`} value={option.code}>{option.name}</option>)}</optgroup>
    <optgroup label={c('Todos los países', 'All countries')}>{options.all.map((option) => <option key={option.code} value={option.code}>{option.name}</option>)}</optgroup></>;
}

function ProfileView() {
  const { locale } = useLocale(); const c = copy(locale);
  const params = useSearchParams(); const jobId = params.get('jobId'); const applicationId = params.get('applicationId');
  const journeyParams = new URLSearchParams(); if (jobId) journeyParams.set('jobId', jobId); if (applicationId) journeyParams.set('applicationId', applicationId);
  const resumeHref = `/documents${journeyParams.size ? `?${journeyParams}` : ''}`;
  const [data, setData] = useState<Profile | null>(null); const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState<string | null>(null); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const [form, setFormState] = useState<ProfileForm>(emptyForm); const formRef = useRef<ProfileForm>(emptyForm); const [dirty, setDirty] = useState(false); const dirtyRef = useRef(false);
  const [conflict, setConflict] = useState(false);
  const reviewList = useRef<HTMLDivElement>(null);
  const editHeading = useRef<HTMLHeadingElement>(null);
  const [editing, setEditing] = useState<(Fact & { revision: number }) | null>(null);
  useEffect(() => { if (editing && editHeading.current) { editHeading.current.focus({ preventScroll: true }); editHeading.current.scrollIntoView({ block: 'start', behavior: 'instant' }); } }, [editing]);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [entryDirty, setEntryDirty] = useState(false);
  const [question, setQuestion] = useState(''); const [jurisdiction, setJurisdiction] = useState(''); const [answerValue, setAnswerValue] = useState('');
  const semanticKey = question.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 96);

  const markDirty = (next: boolean) => { dirtyRef.current = next; setDirty(next); };
  // formRef mirrors the latest typed form synchronously so async reloads can tell whether the user kept typing.
  const setForm = (next: ProfileForm) => { formRef.current = next; setFormState(next); };
  const updateForm = (patch: Partial<ProfileForm>) => { setForm({ ...formRef.current, ...patch }); markDirty(true); };

  /**
   * Reloads the profile, facts and answers. Profile fields are only overwritten when the user has no unsaved edits,
   * on the initial load, or after a successful save whose submitted snapshot is still exactly what is in the form.
   */
  const load = useCallback(async (options: { replaceForm?: boolean; savedSnapshot?: ProfileForm } = {}) => {
    try {
      const profile = await api<Profile>('/profile');
      setData(profile); setLoadState('ready'); setConflict(false);
      const savedUnchanged = options.savedSnapshot !== undefined && formRef.current === options.savedSnapshot;
      if (options.replaceForm || savedUnchanged || !dirtyRef.current) { const next = formFromProfile(profile); formRef.current = next; setFormState(next); dirtyRef.current = false; setDirty(false); }
    } catch (err) { setLoadState((current) => current === 'ready' ? 'ready' : 'error'); setError(errorMessage(err)); }
  }, []);
  useEffect(() => { void load({ replaceForm: true }); }, [load]);
  const leaveConfirmation = c('Tienes cambios sin guardar en tu perfil. ¿Salir y descartarlos?', 'You have unsaved changes on your profile. Leave and discard them?');
  const hasDrafts = dirty || editing !== null || entryDirty || Boolean(question.trim() || answerValue.trim());
  useEffect(() => {
    if (!hasDrafts) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    // Client-side navigation (sidebar links) never fires beforeunload, so confirm those clicks before they reach next/link.
    const guardLinks = (event: MouseEvent) => {
      if (!leavingLink(event)) return;
      if (window.confirm(leaveConfirmation)) return;
      event.preventDefault(); event.stopPropagation();
    };
    window.addEventListener('beforeunload', warn); document.addEventListener('click', guardLinks, true);
    return () => { window.removeEventListener('beforeunload', warn); document.removeEventListener('click', guardLinks, true); };
  }, [hasDrafts, leaveConfirmation]);

  /** Runs one mutation. Resolves true only on success so callers never clear drafts after a failure. */
  const run = async (key: string, action: () => Promise<unknown>, success: string, reload: { savedSnapshot?: ProfileForm } = {}) => {
    // Never write before the current profile is known: a failed load must not let an empty form overwrite saved data.
    if (loadState !== 'ready') { setError(c('Espera a que cargue tu perfil antes de guardar.', 'Wait for your profile to load before saving.')); return false; }
    setBusy(key); setError(''); setMessage(''); setConflict(false);
    try { await action(); setMessage(success); await load(reload); return true; }
    catch (err) { setError(errorMessage(err)); setConflict(err instanceof ApiError && revisionConflictCodes.has(err.code)); return false; }
    finally { setBusy(null); }
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (!data) return;
    const snapshot = formRef.current; const base = data;
    // Keep the profile's region (en-GB, es-MX…) when it already matches the interface language.
    const profileLocale = base.locale?.toLowerCase().startsWith(locale) ? base.locale : locale;
    await run('profile', () => api('/profile', { method: 'PUT', body: JSON.stringify({ expectedRevision: base.revision, locale: profileLocale, profile: { ...base.profile, identity: { ...(base.profile.identity ?? {}), fullName: snapshot.name.trim(), email: snapshot.email.trim(), country: snapshot.country }, preferences: { ...(base.profile.preferences ?? {}), targetTitles: splitList(snapshot.titles), workModes: snapshot.modes } } }) }), c('Tus datos se han guardado.', 'Your details have been saved.'), { savedSnapshot: snapshot });
  };
  const addFact = async (input: EntryInput) => {
    const ok = await run('fact', () => api('/profile/facts', { method: 'POST', body: JSON.stringify({ ...input, source: 'USER_ENTERED', approvalStatus: 'SUGGESTED' }) }), c('Dato guardado. Revísalo en la lista y pulsa Confirmar si es correcto.', 'Detail saved. Review it in the list and select Confirm if it is accurate.'));
    if (ok) reviewList.current?.focus();
    return ok;
  };
  const addAnswer = async (event: FormEvent) => {
    event.preventDefault();
    if (!semanticKey) { setError(c('Escribe la pregunta con letras o números.', 'Write the question using letters or numbers.')); return; }
    const ok = await run('answer', () => api('/answers', { method: 'POST', body: JSON.stringify({ semanticKey, questionText: question.trim().slice(0, 500), jurisdiction, questionScope: 'job_application', value: answerValue.trim(), strategy: 'ASK_USER', approvalStatus: 'UNANSWERED' }) }), c('Respuesta guardada. Apruébala cuando hayas comprobado que es correcta.', 'Answer saved. Approve it once you have checked it is correct.'));
    if (ok) { setQuestion(''); setAnswerValue(''); }
  };
  const reviewFact = (id: string, action: 'approve' | 'reject') => void run(`fact:${id}`, () => api(`/profile/facts/${id}/${action}`, { method: 'POST' }), action === 'approve' ? c('Dato confirmado. Ya puedes usarlo en tu CV.', 'Detail confirmed. You can now use it in your resume.') : c('Dato descartado.', 'Detail discarded.'));
  const saveFactEdit = async (input: EntryInput) => {
    if (!editing) return false;
    const draft = editing;
    const ok = await run(`edit:${draft.id}`, () => api(`/profile/facts/${draft.id}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: draft.revision, fact: { ...input, source: 'USER_ENTERED', approvalStatus: 'SUGGESTED' } }) }), c('Corrección guardada. Revisa el texto y confírmalo para usarlo en nuevos CV. Los PDF anteriores se conservan.', 'Correction saved. Review and confirm it for use in new resumes. Earlier PDFs are preserved.'));
    if (ok) { setEditing(null); reviewList.current?.focus(); }
    return ok;
  };
  const archiveFact = async (id: string) => {
    const ok = await run(`fact:${id}`, () => api(`/profile/facts/${id}/reject`, { method: 'POST' }), c('Texto archivado. Ya no se incluirá en nuevos CV; los PDF anteriores se conservan.', 'Entry archived. It will no longer be included in new resumes; earlier PDFs are preserved.'));
    if (ok) setArchiving(null);
  };
  const reviewAnswer = (id: string) => void run(`answer:${id}`, () => api(`/answers/${id}/approve`, { method: 'POST' }), c('Respuesta aprobada por ti.', 'Answer approved by you.'));
  const toggleMode = (mode: string) => { const modes = formRef.current.modes; updateForm({ modes: modes.includes(mode) ? modes.filter((value) => value !== mode) : [...modes, mode] }); };
  /** Fetches the latest revision without touching unsaved profile edits, so a conflicting save can simply be repeated. */
  const reloadLatest = async () => {
    setBusy('reload'); setError(''); setMessage('');
    try { await load(); } finally { setBusy(null); }
  };

  const pendingFacts = data?.facts.filter((f) => f.approvalStatus === 'SUGGESTED').length ?? 0;
  const approvedFacts = data?.facts.filter((item) => item.approvalStatus === 'USER_APPROVED').length ?? 0;
  const canPrepareCv = Boolean(data?.profile.identity?.fullName?.trim() && data?.profile.identity?.email?.trim() && approvedFacts);
  const knownModes = Object.keys(workModeLabels); const extraModes = form.modes.filter((mode) => !knownModes.includes(mode));
  const saving = (key: string) => busy === key;
  const locked = busy !== null || loadState !== 'ready';

  return <WorkspaceGate><AppShell>
    <PageHeader eyebrow={c('PREPARA TU INFORMACIÓN', 'PREPARE YOUR DETAILS')} title={c('Mi perfil', 'My profile')} description={c('Empieza por tu nombre y correo. Después añade una experiencia que quieras incluir en tu CV.', 'Start with your name and email. Then add an experience you want to include in your resume.')}/>
    <ApplicationJourney jobId={jobId} applicationId={applicationId} stage="profile"/>
    {loadState === 'ready' && <nav className="profile-shortcuts" aria-label={c('Secciones de tu perfil', 'Profile sections')}>
      <a href="#profile-details">{c('Mis datos', 'My details')}</a><a href="#experience">{c('Añadir experiencia o estudios', 'Add experience or education')}</a><a href="#saved-experience-heading">{c('Revisar lo guardado', 'Review saved details')}{pendingFacts > 0 ? ` (${pendingFacts} ${c('por confirmar', 'to confirm')})` : ''}</a>
      {canPrepareCv && <Link className="button button-primary" href={resumeHref}>{c('Continuar con mi CV', 'Continue to my resume')}</Link>}
    </nav>}
    {error && <Notice tone="error">{error}{conflict && <> <Button variant="quiet" disabled={busy !== null} onClick={() => void reloadLatest()}>{busy === 'reload' ? c('Recargando…', 'Reloading…') : dirty ? c('Recargar la última versión (conserva tus cambios)', 'Reload latest version (keeps your edits)') : c('Recargar la última versión', 'Reload latest version')}</Button></>}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    {loadState === 'loading' && <Notice>{c('Cargando tu perfil…', 'Loading your profile…')}</Notice>}
    {loadState === 'error' && <Notice tone="warning">{c('No pudimos cargar tu perfil.', 'We could not load your profile.')} <Button variant="quiet" onClick={() => { setError(''); setLoadState('loading'); void load({ replaceForm: true }); }}>{c('Reintentar', 'Try again')}</Button></Notice>}
    <div className="profile-layout"><div className="profile-main">
      <Card className="form-card"><div className="form-heading"><div><span className="step-badge">01</span><div><h2 id="profile-details" tabIndex={-1}>{c('Tus datos para el CV', 'Your resume details')}</h2><p>{c('El nombre y el correo aparecerán en los nuevos CV que generes.', 'Your name and email will appear on new resumes you generate.')}</p></div></div><Tag tone={dirty ? 'amber' : 'neutral'}>{dirty ? c('Cambios sin guardar', 'Unsaved changes') : c('Sin cambios pendientes', 'No unsaved changes')}</Tag></div>
        <form onSubmit={(event) => void saveProfile(event)} className="form-stack" aria-busy={saving('profile')}>
          <fieldset className="profile-fieldset"><legend>{c('Datos para tu CV', 'Details for your resume')}</legend><div className="form-grid">
          <Field disabled={locked || editing !== null} label={c('Nombre', 'Name')} autoComplete="name" value={form.name} onChange={(e) => updateForm({ name: e.target.value })} placeholder={c('Cómo quieres que aparezca', 'How your name should appear')}/>
          <Field disabled={locked || editing !== null} label={c('Correo', 'Email')} type="email" autoComplete="email" value={form.email} onChange={(e) => updateForm({ email: e.target.value })} placeholder={c('nombre@ejemplo.com', 'name@example.com')}/>
          </div></fieldset>
          <details className="profile-preferences"><summary>{c('Preferencias de empleo · opcional', 'Job preferences · optional')}</summary><fieldset className="profile-fieldset"><legend>{c('Qué empleo buscas', 'What work you are looking for')}</legend><p>{c('Estas preferencias ayudan a comparar ofertas con tu perfil. No se imprimen en tu CV.', 'These preferences help compare jobs with your profile. They are not printed on your resume.')}</p><div className="form-grid">
          <SelectField disabled={locked || editing !== null} label={c('País de trabajo', 'Work country')} hint={c('Opcional para preparar tu CV.', 'Optional for preparing your resume.')} value={form.country} onChange={(e) => updateForm({ country: e.target.value })}>
            <option value="">{c('Sin indicar', 'Not set')}</option>
            <CountryOptions current={form.country}/>
          </SelectField>
          <Field disabled={locked || editing !== null} label={c('Puestos que buscas', 'Roles you are looking for')} value={form.titles} onChange={(e) => updateForm({ titles: e.target.value })} placeholder={c('Por ejemplo: diseño, atención al cliente…', 'For example: design, customer support…')} hint={c('Separa los puestos con comas.', 'Separate roles with commas.')}/>
          <div className="field field-span work-mode-field" role="group" aria-labelledby="work-mode-label">
            <span id="work-mode-label">{c('Modalidad de trabajo', 'Work arrangement')}</span>
            <div className="tag-row">
              {knownModes.map((mode) => { const active = form.modes.includes(mode); return <Button key={mode} type="button" disabled={locked} variant={active ? 'primary' : 'secondary'} aria-pressed={active} onClick={() => toggleMode(mode)}>{active ? '✓ ' : ''}{labelFor.workMode(mode, locale)}</Button>; })}
              {extraModes.map((mode) => <Button key={mode} type="button" disabled={locked} variant="quiet" aria-pressed onClick={() => toggleMode(mode)} title={c('Quitar', 'Remove')}>{mode} ✕</Button>)}
            </div>
            <small>{c('Elige todas las que te sirvan. Puedes seleccionar más de una opción.', 'Choose all that work for you. You can select more than one option.')}</small>
          </div>
          </div></fieldset></details>
          <div className="form-submit">
            <Button type="submit" disabled={locked || editing !== null || !dirty}>{saving('profile') ? c('Guardando…', 'Saving…') : c('Guardar mis datos', 'Save my details')}</Button>
            {dirty && <Button type="button" variant="quiet" disabled={locked} onClick={() => { if (data) setForm(formFromProfile(data)); markDirty(false); }}>{c('Deshacer cambios', 'Undo changes')}</Button>}
          </div>
        </form>
      </Card>

      <Card className="form-card"><div id="experience" tabIndex={-1} className="form-heading"><div><span className="step-badge">02</span><div><h2>{c('Qué quieres contar en tu CV', 'What you want on your resume')}</h2><p>{c('Añade un empleo, un logro o un estudio cada vez. El texto que escribas se usará tal cual en tu CV.', 'Add one job, achievement, or qualification at a time. Your resume will use the text exactly as you write it.')}</p></div></div>{pendingFacts > 0 && <Tag tone="amber">{pendingFacts} {c('por confirmar', 'to confirm')}</Tag>}</div>
        {!editing && <ProfileEntryForm busy={locked} onSave={addFact} onDirtyChange={setEntryDirty}/>}
        {editing && <div className="fact-edit"><h3 ref={editHeading} tabIndex={-1}>{c('Editar dato del CV', 'Edit resume detail')}</h3>
          {data?.revision !== editing.revision && <Notice tone="warning">{c('El perfil cambió mientras editabas. Conserva tu corrección y vuelve a abrir la entrada actual antes de guardar.', 'Your profile changed while editing. Keep your correction and reopen the current entry before saving.')}</Notice>}
          <ProfileEntryForm key={editing.id} initial={editing} busy={locked} blocked={data?.revision !== editing.revision} onSave={saveFactEdit} onCancel={() => { if (window.confirm(c('¿Descartar esta corrección?', 'Discard this correction?'))) { setEditing(null); reviewList.current?.focus(); } }}/>
        </div>}
        <div className="fact-list" ref={reviewList} tabIndex={-1} aria-labelledby="saved-experience-heading"><h3 id="saved-experience-heading" tabIndex={-1}>{c('Lo que has guardado', 'What you have saved')}</h3><p className="muted-label">{c('Solo los textos confirmados estarán disponibles al preparar tu CV.', 'Only confirmed entries will be available when preparing your resume.')}</p>{data?.facts.length ? data.facts.map((item) => <div className="fact-row" key={item.id}>
          <div className="fact-marker">{item.approvalStatus === 'USER_APPROVED' ? '✓' : '·'}</div>
          <div className="fact-content"><div className="fact-meta"><span>{labelFor.factKind(item.kind, locale)}</span><Tag tone={item.approvalStatus === 'USER_APPROVED' ? 'green' : item.approvalStatus === 'REJECTED' ? 'red' : 'amber'}>{item.approvalStatus === 'REJECTED' ? c('ARCHIVADO', 'ARCHIVED') : labelFor.factApproval(item.approvalStatus, locale).toUpperCase()}</Tag></div><p style={{ whiteSpace: 'pre-wrap' }}>{item.statement}</p>{item.tags.length > 0 && <div className="tag-row">{item.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</div>}</div>
          <div className="fact-actions" role="group" aria-label={`${labelFor.factKind(item.kind, locale)}: ${item.statement}`}><Button variant="quiet" disabled={locked || editing !== null} onClick={() => { if (entryDirty && !window.confirm(c('Hay una entrada sin guardar. ¿Descartarla para editar esta?', 'There is an unsaved entry. Discard it to edit this one?'))) return; setEntryDirty(false); setEditing({ ...item, revision: data.revision }); setArchiving(null); }}>{c('Editar', 'Edit')}</Button>{item.approvalStatus === 'USER_APPROVED' && <Button variant="quiet" disabled={locked || editing !== null} onClick={() => setArchiving(item.id)}>{c('Archivar', 'Archive')}</Button>}
          {item.approvalStatus === 'REJECTED' && <Button variant="secondary" disabled={locked || editing !== null} onClick={() => reviewFact(item.id, 'approve')}>{c('Restaurar y confirmar', 'Restore and confirm')}</Button>}</div>
          {archiving === item.id && <div className="fact-edit"><p>{c('¿Archivar este texto? Se conservará aquí y en los PDF anteriores, pero no estará disponible para nuevos CV.', 'Archive this entry? It will remain here and in earlier PDFs, but will not be available for new resumes.')}</p><Button variant="secondary" disabled={locked} onClick={() => void archiveFact(item.id)}>{c('Confirmar archivo', 'Confirm archive')}</Button> <Button variant="quiet" disabled={locked} onClick={() => setArchiving(null)}>{c('Cancelar', 'Cancel')}</Button></div>}
          {item.approvalStatus === 'SUGGESTED' && <div className="fact-actions" role="group" aria-label={`${labelFor.factKind(item.kind, locale)}: ${item.statement}`}><Button variant="quiet" disabled={locked} onClick={() => reviewFact(item.id, 'reject')}>{c('Descartar', 'Discard')}</Button><Button variant="secondary" disabled={locked} onClick={() => reviewFact(item.id, 'approve')}>{saving(`fact:${item.id}`) ? c('Guardando…', 'Saving…') : c('Confirmar', 'Confirm')}</Button></div>}
        </div>) : loadState === 'ready' && <Empty title={c('Aún no hay datos de tu experiencia', 'No profile details yet')} detail={c('Empieza con un logro o una habilidad que puedas describir con claridad.', 'Start with an achievement or skill you can describe clearly.')}/>}</div>
      </Card>

      <details className="optional-section"><summary>{c('Respuestas guardadas · opcional', 'Saved answers · optional')}</summary><p>{c('Guarda respuestas que quieras consultar al solicitar un empleo. Puedes dejar esta sección para después. No se rellenan automáticamente.', 'Save answers to refer to when applying. You can do this later. They are not filled in automatically.')}</p><Card className="form-card"><div className="form-heading"><div><span className="step-badge">03</span><div><h2>{c('Respuestas que dependen de ti', 'Answers only you can give')}</h2><p>{c('No inferimos permisos de trabajo, expectativas salariales ni datos sensibles.', 'We never infer work authorization, salary expectations, or sensitive data.')}</p></div></div></div>
        <form onSubmit={(event) => void addAnswer(event)} className="form-stack" aria-busy={saving('answer')}>
          <div className="form-grid">
            <Field disabled={locked || editing !== null} label={c('¿Qué te pregunta la solicitud?', 'What is the application asking?')} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={c('Ejemplo: ¿Tienes permiso para trabajar en este país?', 'Example: Are you authorized to work in this country?')} required maxLength={500}/>
            <SelectField disabled={locked || editing !== null} label={c('País al que se refiere', 'Country it applies to')} value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} required>
              <option value="">{c('Elige un país…', 'Choose a country…')}</option>
              <CountryOptions current={jurisdiction}/>
            </SelectField>
            <TextareaField disabled={locked || editing !== null} label={c('Tu respuesta', 'Your answer')} value={answerValue} onChange={(e) => setAnswerValue(e.target.value)} placeholder={c('Escribe solo lo que quieras guardar', 'Write only what you want to save')} required rows={3}/>
          </div>
          <div className="notice notice-warning">{c('La respuesta empieza como borrador. Si ya existe una para la misma pregunta y país, se guarda como nueva versión.', 'Your answer starts as a draft. If one already exists for the same question and country, this is saved as a new version.')}</div>
          <div className="form-submit"><Button type="submit" disabled={locked || !question.trim() || !jurisdiction || !answerValue.trim()}>{saving('answer') ? c('Guardando…', 'Saving…') : c('Guardar para revisar', 'Save for review')}</Button></div>
        </form>
        <div className="answer-list">{data?.answers.map((answer) => <div className="answer-row" key={answer.id}>
          <div><strong>{answer.questionText?.trim() || humanizeKey(answer.semanticKey)}</strong><p>{countryName(answer.jurisdiction, locale)}{answer.revision && answer.revision > 1 ? ` · ${c('versión', 'version')} ${answer.revision}` : ''} · {answerText(answer.value) || c('Sin respuesta', 'No answer')}</p></div>
          {answer.approvalStatus === 'USER_APPROVED' ? <Tag tone="green">{labelFor.answerApproval(answer.approvalStatus, locale).toUpperCase()}</Tag> : <Button variant="secondary" disabled={locked} onClick={() => reviewAnswer(answer.id)}>{saving(`answer:${answer.id}`) ? c('Guardando…', 'Saving…') : c('Aprobar respuesta', 'Approve answer')}</Button>}
        </div>)}</div>
      </Card></details>
    </div><aside className="profile-aside">
      <Card className="aside-card"><h3>{c('Tu progreso', 'Your progress')}</h3><details><summary>{c('Pasos para preparar tu CV', 'Steps to prepare your resume')}</summary><ol className="profile-checklist"><li>{c('Guarda tu nombre y correo.', 'Save your name and email.')}</li><li>{c('Añade al menos una experiencia y confirma que es correcta.', 'Add at least one experience and confirm it is accurate.')}</li><li>{c('Ve a Mis CV para elegir el contenido y generar el PDF.', 'Go to My resumes to choose the content and generate your PDF.')}</li></ol></details>
        <p>{c(`${approvedFacts} textos listos para usar · ${pendingFacts} por confirmar`, `${approvedFacts} ${approvedFacts === 1 ? 'entry' : 'entries'} ready to use · ${pendingFacts} to confirm`)}</p>
        {loadState === 'ready' && (canPrepareCv ? <Link href={resumeHref} className="button button-secondary">{c('Preparar mi CV', 'Prepare my resume')}</Link> : <p className="muted-label">{c('Para continuar: guarda tu nombre y correo y confirma una experiencia.', 'To continue: save your name and email and confirm one experience.')}</p>)}
      </Card>
      <Card className="aside-card aside-privacy"><div className="card-icon mint"><span>⌑</span></div><h3>{c('Privado por defecto', 'Private by default')}</h3><p>{c('Tu perfil se guarda en este equipo. Tú autorizas el uso de tus datos de contacto al preparar un formulario.', 'Your profile is saved on this device. You authorize using your contact details when preparing a form.')}</p><small>{c('Tú revisas y envías cada solicitud desde la página de la empresa.', 'You review and submit each application on the employer website.')}</small></Card>
    </aside></div>
  </AppShell></WorkspaceGate>;
}

export default function ProfilePage() { return <Suspense><ProfileView/></Suspense>; }
