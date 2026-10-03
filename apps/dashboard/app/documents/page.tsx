'use client';

import { useSessionDraft, stringDraft } from '@/lib/session-draft';
import { localizedError, useLocale } from '@/lib/i18n';
import Link from 'next/link';
import { ApplicationJourney } from '@/components/application-journey';
import { PdfPreview } from '@/components/pdf-preview';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AppShell, PageHeader, WorkspaceGate } from '@/components/shell';
import { Button, Card, Empty, Field, Icon, Notice, SelectField, Tag } from '@/components/ui';
import { api, ApiError, errorMessage, formatDate } from '@/lib/api';
import { copy, labelFor } from '@/lib/labels';

type Fact = { id: string; kind: string; statement: string; tags: string[]; approvalStatus: string };
type Profile = { facts: Fact[]; profile: { identity?: { fullName?: string; email?: string } } };
type Document = { jobId: string | null; reusableFactIds: string[]; missingFactCount: number; assistReady: boolean; id: string; name: string; revision: number; sha256: string; mediaType: string; approvalStatus: string; createdAt: string; jobSnapshotId: string | null; claims: Array<{ text: string; sourceFactIds: string[] }> };
type Job = { id: string; title: string; company: string };
type Preview = { id: string; url: string | null; state: 'loading' | 'ready' | 'error'; error?: string };

const fileUrl = (id: string) => `/api/v1/documents/${id}/file`;

function DocumentsView() {
  const { locale } = useLocale(); const c = copy(locale);
  const router = useRouter(); const pathname = usePathname(); const searchParams = useSearchParams(); const urlJobId = searchParams.get('jobId') ?? ''; const applicationId = searchParams.get('applicationId') ?? '';
  const draft = useSessionDraft(`resume:${applicationId || urlJobId || 'base'}`, { name: '', named: '', language: '', facts: '' }, (value): value is { name: string; named: string; language: string; facts: string } => {
    if (!stringDraft(value) || !['name', 'named', 'language', 'facts'].every((key) => typeof value[key] === 'string') || !['', 'es', 'en'].includes(value.language!)) return false;
    try { const ids: unknown = JSON.parse(value.facts || '[]'); return Array.isArray(ids) && ids.length <= 50 && ids.every((id) => typeof id === 'string'); } catch { return false; }
  });
  const pdfLocale = draft.value.language === 'en' || draft.value.language === 'es' ? draft.value.language : locale;
  const setPdfLanguage = (language: string) => draft.update((value) => ({ ...value, language }));
  const [approvedNext, setApprovedNext] = useState('');
  const [showHistory, setShowHistory] = useState(searchParams.get('view') === 'saved');
  const previewFromHistory = useRef(false);
  const [identityReady, setIdentityReady] = useState(false);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const builderHeading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const profileParams = new URLSearchParams(); if (urlJobId) profileParams.set('jobId', urlJobId); if (applicationId) profileParams.set('applicationId', applicationId);
  const profileHref = `/profile${profileParams.size ? `?${profileParams}` : ''}`;
  const [facts, setFacts] = useState<Fact[]>([]); const [documents, setDocuments] = useState<Document[]>([]); const [jobs, setJobs] = useState<Job[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [jobId, setJobId] = useState(urlJobId);
  const remembered = JSON.parse(draft.value.facts || '[]') as string[];
  const selected = remembered.filter((id) => facts.some((fact) => fact.id === id));
  const setSelected = (ids: string[]) => draft.update((value) => ({ ...value, facts: JSON.stringify(ids) }));
  const name = draft.value.name; const nameTouched = draft.value.named === 'yes';
  const setName = (name: string) => draft.update((value) => ({ ...value, name, named: 'yes' }));
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null); const [reviewed, setReviewed] = useState(false);
  // Each preview fetch gets a generation number; only the latest may show (or keep) an object URL.
  const previewRequest = useRef(0); const previewAbort = useRef<AbortController | null>(null); const previewUrl = useRef<string | null>(null);

  const job = jobs.find((item) => item.id === jobId) ?? null;
  const defaultName = job ? `${c('CV', 'Resume')} · ${job.title} · ${job.company}` : c('CV · versión base', 'Resume · base version');
  const documentName = nameTouched ? name : defaultName;
  const reviewing = preview ? documents.find((doc) => doc.id === preview.id) ?? null : null;

  const loadRequest = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++loadRequest.current;
    try {
      const [profile, docs, jobRows, application] = await Promise.all([api<Profile>('/profile'), api<Document[]>('/documents'), api<Job[]>('/jobs'), applicationId ? api<{ jobId: string | null }>(`/applications/${applicationId}`) : Promise.resolve(null)]);
      const contextJobId = application?.jobId ?? urlJobId;
      if (contextJobId && !jobRows.some((row) => row.id === contextJobId)) jobRows.push((await api<{ job: Job }>(`/jobs/${contextJobId}`)).job);
      if (ticket !== loadRequest.current) return;
      if (application) setJobId(application.jobId ?? '');
      const approved = profile.facts.filter((f) => f.approvalStatus === 'USER_APPROVED');
      setIdentityReady(Boolean(profile.profile.identity?.fullName?.trim() && profile.profile.identity?.email?.trim()));
      setFacts(approved); setDocuments(docs); setJobs(jobRows); setLoadState('ready');
    } catch (err) { if (ticket === loadRequest.current) { setError(errorMessage(err)); setLoadState((current) => current === 'ready' ? 'ready' : 'error'); } }
  }, [applicationId, urlJobId]);
  useEffect(() => { void load(); return () => { ++loadRequest.current; }; }, [load]);
  useEffect(() => { setJobId(urlJobId); setApprovedNext(''); }, [urlJobId, applicationId]);
  /** Invalidates any in-flight preview fetch and frees the displayed PDF. Returns the new generation number. */
  const resetPreview = useCallback(() => {
    previewAbort.current?.abort(); previewAbort.current = null;
    if (previewUrl.current) { URL.revokeObjectURL(previewUrl.current); previewUrl.current = null; }
    return ++previewRequest.current;
  }, []);
  const closePreview = () => { setShowHistory(previewFromHistory.current); restoreFocus.current = true; resetPreview(); setPreview(null); setReviewed(false); };
  const previewId = preview?.id;
  useEffect(() => {
    if (previewId && !showHistory) {
      previewHeading.current?.focus({ preventScroll: true });
      previewHeading.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    } else if (!previewId && restoreFocus.current) {
      restoreFocus.current = false;
      const target = returnFocus.current?.isConnected ? returnFocus.current : builderHeading.current;
      target?.focus();
    }
  }, [previewId, showHistory]);
  useEffect(() => () => { resetPreview(); }, [resetPreview]);

  const chooseJob = (next: string) => {
    setJobId(next); setApprovedNext('');
    const params = new URLSearchParams(searchParams.toString()); if (next) params.set('jobId', next); else params.delete('jobId');
    router.replace(`${pathname}${params.size ? `?${params}` : ''}`, { scroll: false });
  };
  const toggle = (id: string) => setSelected(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);

  /** Loads the PDF through the authenticated API and shows it inline, so reviewing does not require a separate download. */
  const openPreview = async (id: string) => {
    if (!preview) { previewFromHistory.current = showHistory; if (document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement; }
    setShowHistory(false);
    const ticket = resetPreview(); const controller = new AbortController(); previewAbort.current = controller;
    setReviewed(false); setPreview({ id, url: null, state: 'loading' });
    try {
      const response = await fetch(fileUrl(id), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) { const payload = await response.json().catch(() => ({})) as { error?: string; detail?: string }; throw new ApiError('', response.status, payload.error ?? 'UNKNOWN', payload.detail); }
      const blob = new Blob([await response.arrayBuffer()], { type: 'application/pdf' });
      // A newer preview was opened, or this one was closed, while the file downloaded: never create a URL for it.
      if (ticket !== previewRequest.current) return;
      const url = URL.createObjectURL(blob); previewUrl.current = url; previewAbort.current = null;
      setPreview({ id, url, state: 'ready' });
    } catch (err) {
      if (ticket !== previewRequest.current) return;
      previewAbort.current = null;
      const text = err instanceof ApiError ? localizedError(err.code, locale) : errorMessage(err);
      setPreview({ id, url: null, state: 'error', error: text });
    }
  };

  const generate = async (event: FormEvent) => {
    event.preventDefault(); setBusy('generate'); setError(''); setMessage('');
    try {
      const doc = await api<Document>('/documents', { method: 'POST', body: JSON.stringify({ name: documentName.trim(), factIds: selected, locale: pdfLocale, ...(jobId ? { jobId } : {}) }) });
      setDocuments((current) => [doc, ...current.filter((item) => item.id !== doc.id)]);
      setMessage(c('Versión generada. Léela completa antes de aprobarla.', 'Version generated. Read it in full before approving it.'));
      void openPreview(doc.id);
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && ['FACTS_MUST_BE_APPROVED_IN_CURRENT_PROFILE', 'JOB_NOT_FOUND'].includes(err.code)) { if (err.code === 'JOB_NOT_FOUND') chooseJob(''); await load(); }
    } finally { setBusy(null); }
  };

  const approve = async (doc: Document) => {
    setBusy(`approve:${doc.id}`); setError(''); setMessage('');
    try {
      await api(`/documents/${doc.id}/approve`, { method: 'POST', body: JSON.stringify({ confirmReviewed: true }) });
      setMessage(c('Versión aprobada por ti. Queda vinculada a los datos de tu experiencia que elegiste.', 'Version approved by you. It stays linked to the profile details you chose.'));
      setApprovedNext(doc.id); closePreview(); await load();
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && ['DOCUMENT_ALREADY_REVIEWED', 'PROFILE_CHANGED_REGENERATE_DOCUMENT'].includes(err.code)) await load();
    } finally { setBusy(null); }
  };

  const useResume = async (doc: Document) => {
    if (!jobId && !applicationId) return;
    setBusy(`use:${doc.id}`); setError('');
    try {
      const application = await api<{ id: string }>('/applications/with-resume', { method: 'POST', body: JSON.stringify({ documentId: doc.id, ...(applicationId ? { applicationId } : { jobId }) }) });
      router.push(`/applications?id=${application.id}`);
    } catch (err) { setError(errorMessage(err)); await load(); } finally { setBusy(null); }
  };
  const nextDocument = documents.find((doc) => doc.id === approvedNext && doc.assistReady);

  /** Reuses the facts of an older version (keeping only those still approved) so it can be regenerated after profile changes. */
  const reuse = (doc: Document) => {
    const ids = (doc.reusableFactIds ?? doc.claims.flatMap((claim) => claim.sourceFactIds)).filter((id) => facts.some((fact) => fact.id === id));
    setError(''); setMessage(''); setSelected(ids); setName(doc.name); closePreview(); setShowHistory(false); returnFocus.current = builderHeading.current;
    if (!ids.length) setError(c('Los textos de este CV se editaron o archivaron. Confirma y selecciona los datos actuales para crear una nueva versión.', 'The entries in this resume were edited or archived. Confirm and select your current details to create a new version.'));
    else if (doc.missingFactCount) setError(c('Recuperamos parte de la selección. Algunos textos se editaron o archivaron; revisa y añade los datos actuales antes de generar.', 'Part of the selection was recovered. Some entries were edited or archived; review and add your current details before generating.'));
    else setMessage(c('Selección recuperada. Revisa los datos y genera una nueva versión con tu perfil actual.', 'Selection restored. Review the details and generate a new version with your current profile.'));
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  return <>
    <PageHeader eyebrow={c('MIS CV', 'MY RESUMES')} title={c('Prepara tu CV', 'Prepare your resume')} description={c('Selecciona las experiencias que quieres incluir en tu CV, genera el PDF y revísalo antes de usarlo.', 'Select the experience you want on your resume, generate the PDF, and review it before using it.')}/>
    <ApplicationJourney jobId={jobId} applicationId={applicationId} stage="resume" title={job ? `${job.title} · ${job.company}` : undefined}/>
    {nextDocument && <Card className="next-step-card"><h2>{c('Tu CV está listo', 'Your resume is ready')}</h2><p>{c('Ahora puedes asociarlo a tu solicitud. Tú revisarás y enviarás el formulario desde la página de la empresa.', 'You can now select it for your application. You will review and submit the form on the employer’s website.')}</p>{jobId || applicationId ? <Button disabled={busy !== null} onClick={() => void useResume(nextDocument)}>{c('Continuar con esta solicitud', 'Continue with this application')}</Button> : <Link className="button button-primary" href="/jobs">{c('Elegir una oferta', 'Choose a job')}</Link>}</Card>}
    {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    {loadState === 'loading' && <Notice>{c('Cargando datos de tu experiencia y documentos…', 'Loading profile details and documents…')}</Notice>}
    {loadState === 'error' && <Notice tone="warning">{c('No pudimos cargar tus datos.', 'We could not load your data.')} <Button variant="quiet" onClick={() => { setError(''); setLoadState('loading'); void load(); }}>{c('Reintentar', 'Try again')}</Button></Notice>}
    <div className="document-view-switch" role="group" aria-label={c('Vista de mis CV', 'Resume view')}>
      <Button variant={!showHistory ? 'primary' : 'secondary'} aria-pressed={!showHistory} aria-controls="resume-builder" onClick={() => setShowHistory(false)}>{preview ? c('Revisar CV', 'Review resume') : c('Preparar CV', 'Prepare resume')}</Button>
      <Button variant={showHistory ? 'primary' : 'secondary'} aria-pressed={showHistory} aria-controls="resume-history" onClick={() => setShowHistory(true)}>{c('CV guardados', 'Saved resumes')}{loadState === 'ready' ? ` (${documents.length})` : ''}</Button>
    </div>
    <div className="documents-layout"><div id="resume-builder" className="document-builder" hidden={showHistory}>
      {preview ? <Card className="form-card"><div className="form-heading"><div><span className="step-badge">02</span><div><h2 ref={previewHeading} tabIndex={-1} className="focus-heading">{c('Revisa esta versión', 'Review this version')}</h2><p>{reviewing ? `${reviewing.name} · ${c('Rev.', 'Rev.')} ${reviewing.revision}` : ''}</p></div></div><Tag tone="amber">{reviewing ? labelFor.documentApproval(reviewing.approvalStatus, locale).toUpperCase() : ''}</Tag></div>
        {preview.state === 'loading' && <Notice>{c('Abriendo el PDF…', 'Opening the PDF…')}</Notice>}
        {preview.state === 'error' && <Notice tone="error">{preview.error} <Button variant="quiet" onClick={() => void openPreview(preview.id)}>{c('Reintentar', 'Try again')}</Button></Notice>}
        {preview.state === 'ready' && preview.url && <PdfPreview key={preview.id} url={preview.url}/>}
        <div className="form-stack">
          <a className="button button-secondary" href={fileUrl(preview.id)}>{c('Descargar PDF', 'Download PDF')} <Icon name="download" size={14}/></a>
          {reviewing?.approvalStatus === 'PENDING_REVIEW' && <>
            <label className="checkbox-line"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)}/><span>{c('He leído el documento completo y cada afirmación es correcta.', 'I read the whole document and every statement is accurate.')}<small>{c('Revisa fechas, cifras, títulos y credenciales.', 'Check dates, numbers, titles, and credentials.')}</small></span></label>
            <div className="form-submit"><Button disabled={!reviewed || busy !== null} onClick={() => void approve(reviewing)}>{busy === `approve:${reviewing.id}` ? c('Guardando…', 'Saving…') : c('Aprobar esta versión', 'Approve this version')}</Button><Button variant="quiet" disabled={busy !== null} onClick={closePreview}>{c('Cambiar contenido del CV', 'Change resume content')}</Button></div>
          </>}
          {reviewing && reviewing.approvalStatus !== 'PENDING_REVIEW' && <Button variant="quiet" onClick={closePreview}>{c('Cerrar vista previa', 'Close preview')}</Button>}
        </div>
      </Card> : loadState === 'ready' && (!identityReady || !facts.length) ? <Card className="form-card"><Empty title={c('Primero, prepara tu perfil', 'First, prepare your profile')} detail={!identityReady ? c('Guarda tu nombre y correo. Después añade y confirma al menos una experiencia para incluirla en tu CV.', 'Save your name and email. Then add and confirm at least one experience to include in your resume.') : c('Añade y confirma al menos una experiencia. Después podrás elegir el contenido y generar tu PDF.', 'Add and confirm at least one experience. Then you can choose the content and generate your PDF.')} action={<Link href={profileHref} className="button button-primary">{c('Continuar con mi perfil', 'Continue with my profile')}</Link>}/></Card> : <Card className="form-card"><div className="form-heading"><div><span className="step-badge">01</span><div><h2 ref={builderHeading} tabIndex={-1} className="focus-heading">{c('Preparar una versión', 'Prepare a version')}</h2><p>{c('Usamos los datos que confirmaste, sin añadir ni reescribir logros.', 'We use your profile details as written: nothing is rewritten or added.')}</p></div></div><Tag tone="blue">PDF</Tag></div>
        <form onSubmit={(event) => void generate(event)} className="form-stack" aria-busy={busy === 'generate'}><fieldset className="entry-fields" disabled={busy !== null || !draft.ready || loadState !== 'ready'}>
          <SelectField disabled={Boolean(applicationId)} label={c('¿Para qué oferta?', 'Which job is it for?')} value={jobId} onChange={(e) => chooseJob(e.target.value)}>
            <option value="">{c('Ninguna: versión base', 'None: base version')}</option>
            {jobId && !job && loadState === 'ready' && <option value={jobId}>{c('Oferta no disponible', 'Job not available')}</option>}
            {jobs.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.company}</option>)}
          </SelectField>
          {job && <p className="muted-label">{c('El documento usará el título de esta oferta.', 'The document will use this job title.')} <Link href={`/jobs/${job.id}`}>{c('Ver oferta', 'View job')}</Link></p>}
          <SelectField label={c('Idioma del PDF', 'PDF language')} value={pdfLocale} onChange={(event) => setPdfLanguage(event.target.value as 'es' | 'en')} hint={c('Cambia los títulos y las fechas. Tus descripciones se conservan en el idioma en que las escribiste.', 'Changes headings and dates. Your descriptions stay in the language you wrote them.')}><option value="es">Español</option><option value="en">English</option></SelectField>
          <Field label={c('Nombre de la versión', 'Version name')} value={documentName} onChange={(e) => { setName(e.target.value); }} required maxLength={200} hint={c('Si repites un nombre, se guarda como una versión nueva.', 'If you reuse a name, it is saved as a new version.')}/>
          <details className="technical-detail"><summary>{c('¿Puedo continuar después?', 'Can I continue later?')}</summary><p className="muted-label">{c('Cada oferta conserva su nombre, idioma y selección en esta pestaña. Puedes volver después de editar tu perfil. Cerrar sesión borra esta preparación.', 'Each job keeps its name, language and selection in this tab. You can return after editing your profile. Signing out clears this preparation.')}</p></details><Link href={profileHref}>{c('Añadir o corregir datos del perfil', 'Add or edit profile details')}</Link>
          {draft.storageFailed && <Notice tone="warning">{c('No pudimos conservar esta preparación. Genera el PDF antes de salir para no perder la selección.', 'We could not keep this preparation. Generate the PDF before leaving to keep your selection.')}</Notice>}
          {loadState === 'ready' && remembered.length > selected.length && <Notice tone="warning">{c('Algunos datos de tu selección cambiaron o dejaron de estar confirmados. Revisa y vuelve a elegir el contenido antes de generar.', 'Some selected details changed or are no longer confirmed. Review and reselect your content before generating.')}</Notice>}
          <div className="selection-heading"><div><strong>{c('Datos confirmados', 'Confirmed profile details')}</strong><small>{c('Elige solo lo que quieras incluir (máximo 50).', 'Choose only what you want to include (up to 50).')}</small></div><Tag>{selected.length} / 50 {c('ELEGIDOS', 'SELECTED')}</Tag></div>
          {facts.length > 1 && <div className="detail-actions"><Button type="button" variant="quiet" onClick={() => setSelected(facts.slice(0, 50).map((fact) => fact.id))}>{c('Elegir todos', 'Select all')}</Button>{selected.length > 0 && <Button type="button" variant="quiet" onClick={() => setSelected([])}>{c('Quitar todos', 'Clear all')}</Button>}</div>}
          <div className="fact-pick-list">{facts.length ? facts.map((fact) => <label className={`fact-pick ${selected.includes(fact.id) ? 'fact-pick-active' : ''}`} key={fact.id}><input type="checkbox" disabled={!selected.includes(fact.id) && selected.length >= 50} checked={selected.includes(fact.id)} onChange={() => toggle(fact.id)}/><span className="fact-pick-copy"><strong>{labelFor.factKind(fact.kind, locale)}</strong><span>{fact.statement}</span></span><Icon name="check" size={17}/></label>)
            : loadState === 'ready' && <Empty title={c('Todavía no has confirmado tu experiencia', 'No confirmed profile details')} detail={c('Aprueba datos de tu experiencia en tu perfil antes de usarlos en un documento.', 'Approve profile details in your profile before using them in a document.')} action={<Link className="button button-secondary" href={profileHref}>{c('Ir a mi perfil', 'Go to my profile')}</Link>}/>}</div>
          {!selected.length && facts.length > 0 && <p className="selection-hint" role="status">{c('Elige al menos un dato de la lista para generar tu CV.', 'Select at least one detail above to generate your resume.')}</p>}
          <p id="pdf-review-explanation" className="muted-label">{c('El PDF se genera sin la palabra «borrador» ni marcas de revisión. «Pendiente de revisión» es solo un estado dentro de esta app. Léelo antes de aprobarlo.', 'The PDF is generated without a draft label or review marks. “Waiting for review” is only a status in this app. Read it before approving it.')}</p>
          <Button type="submit" aria-describedby="pdf-review-explanation" disabled={busy !== null || !identityReady || !selected.length || selected.length > 50 || !documentName.trim()}>{busy === 'generate' ? c('Generando PDF…', 'Generating PDF…') : c('Generar y revisar', 'Generate and review')} <Icon name="arrow" size={15}/></Button>
        </fieldset></form>
      </Card>}
      <Card className="renderer-note"><details><summary>{c('Sobre el formato y los PDF anteriores', 'About the layout and earlier PDFs')}</summary><p>{c('Diseño de una columna, nombre y correo destacados, secciones claras y páginas numeradas. Si un PDF anterior incluye la palabra «borrador», elige Usar como base y genera una nueva versión para quitarla. Aprobar o descargar el PDF anterior no cambia su contenido.', 'A single-column layout with prominent name and email, clear sections, and page numbers. If an older PDF includes a draft label, choose Use as starting point and generate a new version to remove it. Approving or downloading the older PDF does not change its contents.')}</p></details></Card>
    </div>
      <aside id="resume-history" className="document-history" hidden={!showHistory}><div className="section-heading compact"><div><div className="eyebrow"><span className="eyebrow-mark"/> {c('CV GUARDADOS', 'SAVED RESUMES')}</div><h2>{c('Tus documentos', 'Your documents')}</h2></div></div>
        {documents.length ? documents.map((doc) => <Card className="document-card" key={doc.id}><div className="document-icon"><Icon name="file" size={19}/></div><div className="document-card-main">
          <div className="document-card-top"><strong>{doc.name}</strong><Tag tone={doc.approvalStatus === 'USER_APPROVED' ? 'green' : doc.approvalStatus === 'PENDING_REVIEW' ? 'amber' : 'neutral'}>{labelFor.documentApproval(doc.approvalStatus, locale).toUpperCase()}</Tag></div>
          {doc.approvalStatus === 'USER_APPROVED' && doc.assistReady === false && <p>{c('Tu perfil cambió. Usa este CV como base y aprueba la nueva versión para preparar una solicitud asistida.', 'Your profile changed. Use this resume as a starting point and approve the new version to prepare an assisted application.')}</p>}
          <p>{c('Rev.', 'Rev.')} {doc.revision} · {formatDate(doc.createdAt)} · {doc.claims.length} {doc.claims.length === 1 ? c('dato', 'detail') : c('datos de tu experiencia', 'profile details')} · {doc.jobSnapshotId ? c('Para una oferta', 'For a job') : c('Base', 'Base')}</p>
          <details className="technical-detail"><summary>{c('Detalles del archivo', 'File details')}</summary><small className="hash-short">SHA-256 · {doc.sha256}</small></details>
          <div className="document-actions">
            <Button variant={doc.approvalStatus === 'PENDING_REVIEW' ? 'secondary' : 'quiet'} disabled={busy !== null} onClick={() => void openPreview(doc.id)}>{doc.approvalStatus === 'PENDING_REVIEW' ? c('Revisar y aprobar', 'Review and approve') : c('Ver', 'View')}</Button>
            <a className="button button-quiet" href={fileUrl(doc.id)}>{c('Descargar', 'Download')} <Icon name="download" size={14}/></a>
            {doc.assistReady && (jobId || applicationId) && (!doc.jobId || doc.jobId === jobId) && <Button disabled={busy !== null} onClick={() => void useResume(doc)}>{c('Usar en esta solicitud', 'Use for this application')}</Button>}
            <Button variant="quiet" disabled={busy !== null} onClick={() => reuse(doc)}>{c('Usar como base', 'Use as starting point')}</Button>
          </div>
        </div></Card>) : loadState === 'ready' && <Card className="jobs-empty"><Empty title={c('Aún no hay documentos', 'No documents yet')} detail={c('Cuando apruebes tus primeros datos de tu experiencia, podrás generar una versión para revisar.', 'Once you approve your first profile details, you can generate a version to review.')}/></Card>}
        <div className="notice notice-info document-boundary">{c('Preparar un CV no lo envía a ninguna empresa. Descárgalo y adjúntalo tú al solicitar el puesto.', 'Creating a resume does not send it to an employer. Download it and attach it yourself when applying.')}</div>
      </aside>
    </div>
  </>;
}

export default function DocumentsPage() {
  return <WorkspaceGate><AppShell><Suspense fallback={null}><DocumentsView/></Suspense></AppShell></WorkspaceGate>;
}
