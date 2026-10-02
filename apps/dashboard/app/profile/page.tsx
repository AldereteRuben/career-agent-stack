'use client';

import { useLocale } from '@/lib/i18n';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Empty, Field, Notice, SelectField, Tag, TextareaField } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { copy, countryName, countryOptions, humanizeKey, labelFor, normalizeWorkMode, selectableFactKinds, workModes as workModeLabels } from '@/lib/labels';

type Fact = { id: string; kind: string; statement: string; tags: string[]; approvalStatus: string };
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

export default function ProfilePage() {
  const { locale } = useLocale(); const c = copy(locale);
  const [data, setData] = useState<Profile | null>(null); const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState<string | null>(null); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const [form, setFormState] = useState<ProfileForm>(emptyForm); const formRef = useRef<ProfileForm>(emptyForm); const [dirty, setDirty] = useState(false); const dirtyRef = useRef(false);
  const [conflict, setConflict] = useState(false);
  const [fact, setFact] = useState(''); const [factTags, setFactTags] = useState(''); const [factKind, setFactKind] = useState('achievement');
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
  const hasDrafts = dirty || Boolean(fact.trim() || factTags.trim() || question.trim() || answerValue.trim());
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
    await run('profile', () => api('/profile', { method: 'PUT', body: JSON.stringify({ expectedRevision: base.revision, locale: profileLocale, profile: { ...base.profile, identity: { ...(base.profile.identity ?? {}), fullName: snapshot.name.trim(), email: snapshot.email.trim(), country: snapshot.country }, preferences: { ...(base.profile.preferences ?? {}), targetTitles: splitList(snapshot.titles), workModes: snapshot.modes } } }) }), c('Perfil guardado como nueva revisión.', 'Profile saved as a new revision.'), { savedSnapshot: snapshot });
  };
  const addFact = async (event: FormEvent) => {
    event.preventDefault();
    const ok = await run('fact', () => api('/profile/facts', { method: 'POST', body: JSON.stringify({ kind: factKind, statement: fact.trim(), tags: splitList(factTags), source: 'USER_ENTERED', approvalStatus: 'SUGGESTED' }) }), c('Hecho añadido. Apruébalo cuando lo hayas revisado.', 'Fact added. Approve it once you have checked it.'));
    if (ok) { setFact(''); setFactTags(''); }
  };
  const addAnswer = async (event: FormEvent) => {
    event.preventDefault();
    if (!semanticKey) { setError(c('Escribe la pregunta con letras o números.', 'Write the question using letters or numbers.')); return; }
    const ok = await run('answer', () => api('/answers', { method: 'POST', body: JSON.stringify({ semanticKey, questionText: question.trim().slice(0, 500), jurisdiction, questionScope: 'job_application', value: answerValue.trim(), strategy: 'ASK_USER', approvalStatus: 'UNANSWERED' }) }), c('Respuesta guardada. Apruébala cuando hayas comprobado que es correcta.', 'Answer saved. Approve it once you have checked it is correct.'));
    if (ok) { setQuestion(''); setAnswerValue(''); }
  };
  const reviewFact = (id: string, action: 'approve' | 'reject') => void run(`fact:${id}`, () => api(`/profile/facts/${id}/${action}`, { method: 'POST' }), action === 'approve' ? c('Hecho aprobado por ti.', 'Fact approved by you.') : c('Hecho descartado.', 'Fact discarded.'));
  const reviewAnswer = (id: string) => void run(`answer:${id}`, () => api(`/answers/${id}/approve`, { method: 'POST' }), c('Respuesta aprobada por ti.', 'Answer approved by you.'));
  const toggleMode = (mode: string) => { const modes = formRef.current.modes; updateForm({ modes: modes.includes(mode) ? modes.filter((value) => value !== mode) : [...modes, mode] }); };
  /** Fetches the latest revision without touching unsaved profile edits, so a conflicting save can simply be repeated. */
  const reloadLatest = async () => {
    setBusy('reload'); setError(''); setMessage('');
    try { await load(); } finally { setBusy(null); }
  };

  const pendingFacts = data?.facts.filter((f) => f.approvalStatus === 'SUGGESTED').length ?? 0;
  const knownModes = Object.keys(workModeLabels); const extraModes = form.modes.filter((mode) => !knownModes.includes(mode));
  const saving = (key: string) => busy === key;
  const locked = busy !== null || loadState !== 'ready';

  return <WorkspaceGate><AppShell>
    <PageHeader eyebrow={c('LA BASE DE TODO', 'THE FOUNDATION')} title={c('Tu perfil, con evidencia.', 'Your profile, backed by evidence.')} description={c('Guarda lo que sabes, revisa cada afirmación y conserva la historia de tus cambios.', 'Save what you know, review every statement, and keep the history of your changes.')}/>
    {error && <Notice tone="error">{error}{conflict && <> <Button variant="quiet" disabled={busy !== null} onClick={() => void reloadLatest()}>{busy === 'reload' ? c('Recargando…', 'Reloading…') : dirty ? c('Recargar la última versión (conserva tus cambios)', 'Reload latest version (keeps your edits)') : c('Recargar la última versión', 'Reload latest version')}</Button></>}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    {loadState === 'loading' && <Notice>{c('Cargando tu perfil…', 'Loading your profile…')}</Notice>}
    {loadState === 'error' && <Notice tone="warning">{c('No pudimos cargar tu perfil.', 'We could not load your profile.')} <Button variant="quiet" onClick={() => { setError(''); setLoadState('loading'); void load({ replaceForm: true }); }}>{c('Reintentar', 'Try again')}</Button></Notice>}
    <div className="profile-layout"><div className="profile-main">
      <Card className="form-card"><div className="form-heading"><div><span className="step-badge">01</span><div><h2>{c('Datos y preferencias', 'Personal details and preferences')}</h2><p>{c('Solo para organizar este espacio y preparar borradores.', 'Only used to organise this workspace and prepare drafts.')}</p></div></div><Tag tone={dirty ? 'amber' : 'blue'}>{dirty ? c('CAMBIOS SIN GUARDAR', 'UNSAVED CHANGES') : `${c('REVISIÓN', 'REVISION')} ${data?.revision ?? '—'}`}</Tag></div>
        <form onSubmit={(event) => void saveProfile(event)} className="form-grid" aria-busy={saving('profile')}>
          <Field disabled={locked} label={c('Nombre', 'Name')} autoComplete="name" value={form.name} onChange={(e) => updateForm({ name: e.target.value })} placeholder={c('Cómo quieres que aparezca', 'How your name should appear')}/>
          <Field disabled={locked} label={c('Correo', 'Email')} type="email" autoComplete="email" value={form.email} onChange={(e) => updateForm({ email: e.target.value })} placeholder={c('nombre@ejemplo.com', 'name@example.com')}/>
          <SelectField disabled={locked} label={c('País donde quieres trabajar', 'Country you want to work in')} value={form.country} onChange={(e) => updateForm({ country: e.target.value })}>
            <option value="">{c('Sin indicar', 'Not set')}</option>
            <CountryOptions current={form.country}/>
          </SelectField>
          <Field disabled={locked} label={c('Puestos que buscas', 'Roles you are looking for')} value={form.titles} onChange={(e) => updateForm({ titles: e.target.value })} placeholder="SDET, QA Automation Engineer" hint={c('Separa los puestos con comas.', 'Separate roles with commas.')}/>
          <div className="field" role="group" aria-labelledby="work-mode-label">
            <span id="work-mode-label">{c('Modalidad de trabajo', 'Work arrangement')}</span>
            <div className="tag-row">
              {knownModes.map((mode) => { const active = form.modes.includes(mode); return <Button key={mode} type="button" disabled={locked} variant={active ? 'primary' : 'secondary'} aria-pressed={active} onClick={() => toggleMode(mode)}>{active ? '✓ ' : ''}{labelFor.workMode(mode, locale)}</Button>; })}
              {extraModes.map((mode) => <Button key={mode} type="button" disabled={locked} variant="quiet" aria-pressed onClick={() => toggleMode(mode)} title={c('Quitar', 'Remove')}>{mode} ✕</Button>)}
            </div>
            <small>{c('Elige todas las que te sirvan. Son preferencias, no una garantía de elegibilidad.', 'Choose all that work for you. These are preferences, not a guarantee of eligibility.')}</small>
          </div>
          <div className="form-submit">
            <Button type="submit" disabled={locked || !dirty}>{saving('profile') ? c('Guardando…', 'Saving…') : c('Guardar nueva revisión', 'Save new revision')}</Button>
            {dirty && <Button type="button" variant="quiet" disabled={locked} onClick={() => { if (data) setForm(formFromProfile(data)); markDirty(false); }}>{c('Deshacer cambios', 'Undo changes')}</Button>}
          </div>
        </form>
      </Card>

      <Card className="form-card"><div className="form-heading"><div><span className="step-badge">02</span><div><h2>{c('Hechos de carrera', 'Career facts')}</h2><p>{c('Los hechos no se usan en documentos hasta que los apruebes.', 'Facts are not used in documents until you approve them.')}</p></div></div><Tag tone="amber">{pendingFacts} {c('PENDIENTES', 'PENDING')}</Tag></div>
        <form onSubmit={(event) => void addFact(event)} className="form-stack" aria-busy={saving('fact')}>
          <div className="form-grid">
            <SelectField disabled={locked} label={c('Tipo de hecho', 'Type of fact')} value={factKind} onChange={(e) => setFactKind(e.target.value)}>{selectableFactKinds.map((kind) => <option key={kind} value={kind}>{labelFor.factKind(kind, locale)}</option>)}</SelectField>
            <Field disabled={locked} label={c('Etiquetas', 'Tags')} value={factTags} onChange={(e) => setFactTags(e.target.value)} placeholder="java, api-testing" hint={c('Opcional, separadas por comas.', 'Optional, separated by commas.')}/>
          </div>
          <TextareaField disabled={locked} label={c('Afirmación concreta', 'Specific statement')} value={fact} onChange={(e) => setFact(e.target.value)} placeholder={c('Qué hiciste, con qué herramientas y en qué contexto…', 'What you did, with which tools, and in what context…')} required rows={4} maxLength={4000}/>
          <div className="form-submit"><Button type="submit" disabled={locked || !fact.trim()}>{saving('fact') ? c('Guardando…', 'Saving…') : c('Añadir para revisar', 'Add for review')}</Button></div>
        </form>
        <div className="fact-list">{data?.facts.length ? data.facts.map((item) => <div className="fact-row" key={item.id}>
          <div className="fact-marker">{item.approvalStatus === 'USER_APPROVED' ? '✓' : '·'}</div>
          <div className="fact-content"><div className="fact-meta"><span>{labelFor.factKind(item.kind, locale)}</span><Tag tone={item.approvalStatus === 'USER_APPROVED' ? 'green' : item.approvalStatus === 'REJECTED' ? 'red' : 'amber'}>{labelFor.factApproval(item.approvalStatus, locale).toUpperCase()}</Tag></div><p>{item.statement}</p>{item.tags.length > 0 && <div className="tag-row">{item.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</div>}</div>
          {item.approvalStatus === 'SUGGESTED' && <div className="fact-actions"><Button variant="quiet" disabled={locked} onClick={() => reviewFact(item.id, 'reject')}>{c('Descartar', 'Discard')}</Button><Button variant="secondary" disabled={locked} onClick={() => reviewFact(item.id, 'approve')}>{saving(`fact:${item.id}`) ? c('Guardando…', 'Saving…') : c('Aprobar', 'Approve')}</Button></div>}
        </div>) : loadState === 'ready' && <Empty title={c('Aún no hay hechos', 'No career facts yet')} detail={c('Empieza con un logro o una habilidad que puedas describir con claridad.', 'Start with an achievement or skill you can describe clearly.')}/>}</div>
      </Card>

      <Card className="form-card"><div className="form-heading"><div><span className="step-badge">03</span><div><h2>{c('Respuestas que dependen de ti', 'Answers only you can give')}</h2><p>{c('No inferimos permisos de trabajo, expectativas salariales ni datos sensibles.', 'We never infer work authorization, salary expectations, or sensitive data.')}</p></div></div></div>
        <form onSubmit={(event) => void addAnswer(event)} className="form-stack" aria-busy={saving('answer')}>
          <div className="form-grid">
            <Field disabled={locked} label={c('¿Qué te pregunta la solicitud?', 'What is the application asking?')} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={c('Ejemplo: ¿Tienes permiso para trabajar en este país?', 'Example: Are you authorized to work in this country?')} required maxLength={500}/>
            <SelectField disabled={locked} label={c('País al que se refiere', 'Country it applies to')} value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} required>
              <option value="">{c('Elige un país…', 'Choose a country…')}</option>
              <CountryOptions current={jurisdiction}/>
            </SelectField>
            <TextareaField disabled={locked} label={c('Tu respuesta', 'Your answer')} value={answerValue} onChange={(e) => setAnswerValue(e.target.value)} placeholder={c('Escribe solo lo que quieras guardar', 'Write only what you want to save')} required rows={3}/>
          </div>
          <div className="notice notice-warning">{c('La respuesta empieza como borrador. Si ya existe una para la misma pregunta y país, se guarda como nueva versión.', 'Your answer starts as a draft. If one already exists for the same question and country, this is saved as a new version.')}</div>
          <div className="form-submit"><Button type="submit" disabled={locked || !question.trim() || !jurisdiction || !answerValue.trim()}>{saving('answer') ? c('Guardando…', 'Saving…') : c('Guardar para revisar', 'Save for review')}</Button></div>
        </form>
        <div className="answer-list">{data?.answers.map((answer) => <div className="answer-row" key={answer.id}>
          <div><strong>{answer.questionText?.trim() || humanizeKey(answer.semanticKey)}</strong><p>{countryName(answer.jurisdiction, locale)}{answer.revision && answer.revision > 1 ? ` · ${c('versión', 'version')} ${answer.revision}` : ''} · {answerText(answer.value) || c('Sin respuesta', 'No answer')}</p></div>
          {answer.approvalStatus === 'USER_APPROVED' ? <Tag tone="green">{labelFor.answerApproval(answer.approvalStatus, locale).toUpperCase()}</Tag> : <Button variant="secondary" disabled={locked} onClick={() => reviewAnswer(answer.id)}>{saving(`answer:${answer.id}`) ? c('Guardando…', 'Saving…') : c('Aprobar respuesta', 'Approve answer')}</Button>}
        </div>)}</div>
      </Card>
    </div><aside className="profile-aside">
      <Card className="aside-card"><span className="aside-number">01</span><h3>{c('Lo que apruebas, cuenta.', 'What you approve is what counts.')}</h3><p>{c('Los documentos solo usan hechos aprobados en la revisión actual de tu perfil.', 'Documents only use facts approved in the current revision of your profile.')}</p></Card>
      <Card className="aside-card aside-privacy"><div className="card-icon mint"><span>⌑</span></div><h3>{c('Privado por defecto', 'Private by default')}</h3><p>{c('El perfil vive en esta instalación local. No se comparte con empresas.', 'Your profile lives in this local installation. It is not shared with employers.')}</p><small>{c('El envío de candidaturas no está disponible en v0.1.', 'Submitting applications is not available in v0.1.')}</small></Card>
    </aside></div>
  </AppShell></WorkspaceGate>;
}
