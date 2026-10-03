'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Field, Notice, SelectField, Tag, TextareaField } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';

type Attempt = { id: string; status: string; digest: string; expiresAt: string; plan: { url: string; documentId: string; documentName: string; documentSha256: string; fields: { name: string; email: string; phone: string; org: string } }; result: { reason?: string; filled?: string[]; receipt?: string; submissionPermit?: { state: string } }; createdAt: string };
type Data = { supported: boolean; url: string | null; identity: { fullName: string; email: string }; application: { state: string; documentId: string | null; jobId: string | null }; documents: Array<{ id: string; name: string; revision: number; assistReady: boolean }>; attempts: Attempt[] };
const activeStates = ['PREPARED', 'STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF', 'UNKNOWN'];

export function AssistedApplication({ applicationId, onChanged }: { applicationId: string; onChanged: () => void }) {
  const { locale } = useLocale(); const c = copy(locale);
  const [data, setData] = useState<Data | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [documentId, setDocumentId] = useState(''); const [phone, setPhone] = useState(''); const [organization, setOrganization] = useState('');
  const [consent, setConsent] = useState(false); const [submitConsent, setSubmitConsent] = useState(false); const [reviewed, setReviewed] = useState(false); const [attested, setAttested] = useState(false);
  const [outcome, setOutcome] = useState('UNKNOWN'); const [reason, setReason] = useState('');
  const pending = useRef(false); const alive = useRef(true);
  const load = useCallback(async (signal?: AbortSignal) => {
    try { const next = await api<Data>(`/applications/${applicationId}/assist`, signal ? { signal } : {}); if (alive.current) setData(next); }
    catch (err) { if (alive.current && !signal?.aborted) setError(errorMessage(err)); }
  }, [applicationId]);
  const attempt = data?.attempts.find((item) => activeStates.includes(item.status));
  const attemptId = attempt?.id;
  useEffect(() => { setConsent(false); setSubmitConsent(false); setReviewed(false); setAttested(false); setReason(''); }, [attemptId]);
  useEffect(() => {
    alive.current = true; const controller = new AbortController(); void load(controller.signal);
    return () => { alive.current = false; controller.abort(); };
  }, [load]);
  useEffect(() => {
    if (!attemptId) return;
    const controller = new AbortController();
    const timer = setInterval(() => { if (!pending.current) void load(controller.signal); }, 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [attemptId, attempt?.status, load]);

  const explain = (err: unknown) => {
    if (!(err instanceof ApiError)) return errorMessage(err);
    const messages: Record<string, [string, string]> = {
      ASSIST_ACTIVE_ATTEMPT: ['Resuelve o cancela el intento abierto antes de preparar otro.', 'Resolve or cancel the open attempt before preparing another.'],
      DOCUMENT_JOB_MISMATCH: ['Este CV corresponde a otra oferta. Prepara una versión para esta solicitud.', 'This resume is for another job. Prepare a version for this application.'],
      APPLICATION_RESUME_CLOSED: ['Esta solicitud ya se envió o está cerrada.', 'This application has been submitted or closed.'],
      ASSIST_PROFILE_REQUIRED: ['Guarda tu nombre y un correo válido en tu perfil.', 'Save your name and a valid email in your profile.'],
      ASSIST_DOCUMENT_REQUIRED: ['Genera y aprueba un CV con tu perfil actual.', 'Generate and approve a resume from your current profile.'],
      ASSIST_DOCUMENT_STALE: ['El CV ya no coincide con tus datos aprobados. Genera y revisa otra versión.', 'The resume no longer matches your confirmed profile details. Generate and review a new version.'],
      ASSIST_INPUTS_CHANGED: ['Los datos cambiaron. Cierra este intento y prepara una autorización nueva.', 'The data changed. Close this attempt and prepare fresh authorization.'],
      ASSIST_CONSENT_EXPIRED: ['La autorización caducó. Cancela este intento y prepara otro.', 'The authorization expired. Cancel this attempt and prepare another.'],
      ASSIST_CONSENT_ALREADY_USED: ['Esta autorización ya se usó. Actualiza el estado; no repitas el envío.', 'This authorization was already used. Refresh the status; do not repeat submission.'],
      ASSIST_SUBMISSION_ALREADY_AUTHORIZED: ['La autorización de envío ya se utilizó. Comprueba el resultado; no vuelvas a intentarlo.', 'Submission authorization was already used. Check the outcome; do not retry.'],
      ASSIST_PAGE_CHANGED: ['La página cambió desde la revisión. No enviaremos nada; prepara una revisión nueva.', 'The page changed after review. Nothing will be submitted; prepare a fresh review.'],
      ASSIST_FORM_NOT_RECOGNIZED: ['No reconocimos con seguridad este formulario. Puedes continuar manualmente.', 'We could not safely recognize this form. You can continue manually.'],
      ASSIST_CAPTCHA_REQUIRED: ['Este formulario requiere resolver un CAPTCHA manualmente.', 'This form requires manual CAPTCHA handling.'],
      ASSIST_AUTH_REQUIRED: ['El sitio requiere autenticación o un código manual.', 'The site requires authentication or a code.'],
      ASSIST_LEGAL_REVIEW_REQUIRED: ['Revisa y acepta manualmente las declaraciones legales del formulario.', 'Review and accept the form’s legal statements manually.'],
      ASSIST_REQUIRED_FIELD_UNSUPPORTED: ['El formulario tiene una pregunta obligatoria que debes responder manualmente.', 'The form has a required question you must answer manually.'],
      ASSIST_UPLOAD_UNSUPPORTED: ['No reconocimos el campo para adjuntar el CV. Continúa manualmente.', 'We could not recognize the resume upload field. Continue manually.'],
      ASSIST_SUBMIT_UNSUPPORTED: ['No reconocimos con seguridad el botón de envío. Continúa manualmente.', 'We could not safely identify the submit button. Continue manually.'],
      ASSIST_OPTIONAL_FIELD_REVIEW_REQUIRED: ['El formulario contiene respuestas adicionales que no están incluidas en esta autorización; continúa manualmente.', 'The form contains additional answers outside this authorization; continue manually.'],
      ASSIST_RECEIPT_PREEXISTS: ['La página ya muestra un recibo antes del envío. Comprueba el estado antes de continuar.', 'The page already shows a receipt before submission. Check the outcome before continuing.'],
      ASSIST_BROWSER_BUSY: ['Hay otra ventana asistida abierta. Resuelve ese intento primero.', 'Another assisted window is open. Resolve that attempt first.'],
      ASSIST_BROWSER_START_FAILED: ['No pudimos preparar el navegador. Comprueba que Chromium esté instalado y que la app tenga acceso al escritorio.', 'We could not prepare the browser. Check that Chromium is installed and the app can access your desktop.'],
      ASSIST_BROWSER_LOST: ['Se perdió la ventana. Comprueba el resultado antes de iniciar otro intento.', 'The window was lost. Check the outcome before starting another attempt.'],
      ASSIST_APPLICATION_CLOSED: ['Esta solicitud está cerrada o ya consta como enviada.', 'This application is closed or already recorded as submitted.'],
      ASSIST_INVALID_STATE: ['El estado cambió. Actualízalo antes de continuar.', 'The state changed. Refresh it before continuing.'],
    };
    const text = messages[err.code]; return text ? c(text[0], text[1]) : c('No se pudo completar la acción. Actualiza el estado antes de reintentar.', 'The action could not be completed. Refresh the state before retrying.');
  };
  const act = async (path: string, body: object) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError('');
    try {
      if (path.endsWith('/assist/prepare')) await api('/applications/with-resume', { method: 'POST', body: JSON.stringify({ applicationId, documentId: (body as { documentId: string }).documentId }) });
      await api(path, { method: 'POST', body: JSON.stringify(body) }); setConsent(false); setSubmitConsent(false); setReviewed(false); setAttested(false); }
    catch (err) { if (alive.current) setError(explain(err)); }
    finally { if (alive.current) { await load(); onChanged(); setBusy(false); } pending.current = false; }
  };
  const stateLabel: Record<string, string> = {
    PREPARED: c('Datos listos para revisar', 'Data ready for review'), STARTING: c('Preparando navegador', 'Preparing browser'), REVIEW: c('Revisa la ventana', 'Review the window'), HANDOFF_REQUIRED: c('Formulario requiere revisión manual', 'Form requires manual review'), HANDED_OFF: c('Tienes el control', 'You are in control'), UNKNOWN: c('Resultado por comprobar', 'Outcome needs checking'), CONFIRMED: c('Envío confirmado por el usuario', 'Submission confirmed by the user'), NOT_SUBMITTED: c('Sin enviar, según tu revisión', 'Not submitted, according to your review'), CANCELLED: c('Cancelado', 'Cancelled'), INVALIDATED: c('Autorización invalidada', 'Authorization invalidated'), FAILED: c('No se pudo iniciar', 'Could not start'),
  };
  const availableDocuments = data?.documents.filter((doc) => doc.assistReady) ?? [];
  const selectedDocument = availableDocuments.some((doc) => doc.id === documentId) ? documentId : availableDocuments.find((doc) => doc.id === data?.application.documentId)?.id ?? availableDocuments[0]?.id ?? '';
  const hasOutdatedDocuments = data?.documents.some((doc) => !doc.assistReady);
  return <section className="assist-panel" aria-labelledby={`assist-title-${applicationId}`} aria-busy={busy}>
    <div className="panel-heading"><div><div className="eyebrow">{c('SOLICITUD ASISTIDA · LEVER', 'ASSISTED APPLICATION · LEVER')}</div><h3 id={`assist-title-${applicationId}`}>{c('Prepara el formulario, conserva el control', 'Prepare the form, stay in control')}</h3></div><Button variant="quiet" disabled={busy} onClick={() => { setError(''); void load(); }}>{c('Actualizar', 'Refresh')}</Button></div>
    {error && <Notice tone="error">{error}</Notice>}
    {!data ? <p>{c('Cargando opciones…', 'Loading options…')}</p> : !data.supported ? <p>{c('Por ahora asistimos formularios alojados en Lever. Para esta oferta, abre el enlace original y continúa manualmente.', 'For now we assist forms hosted by Lever. For this job, open the original link and continue manually.')}</p> : <>
      <p>{c('Autocompletamos los datos de contacto. Tras revisar el formulario, puedes autorizar por separado que adjuntemos el CV aprobado y enviemos esta solicitud. Los formularios con preguntas obligatorias, declaraciones legales, CAPTCHA o autenticación requieren intervención manual.', 'We fill your contact details. After reviewing the form, you can separately authorize us to attach the approved resume and submit this application. Forms with required questions, legal statements, CAPTCHA or authentication need manual help.')}</p>
      <Notice tone="warning">{c('El envío automático es experimental y solo se ofrece cuando reconocemos el formulario y no contiene CAPTCHA, preguntas obligatorias ni respuestas adicionales que la app no admita. Si no se cumplen estas condiciones, puedes continuar manualmente.', 'Automatic submission is experimental and is offered only when we recognize the form and it has no CAPTCHA, required questions, or additional answers the app cannot handle. If these conditions are not met, you can continue manually.')}</Notice>
      <ol className="assist-steps" aria-label={c('Pasos de la solicitud', 'Application steps')}><li>{c('Revisar datos', 'Review data')}</li><li>{c('Revisar navegador', 'Review browser')}</li><li>{c('Enviar tú y registrar', 'Submit yourself and record')}</li></ol>
      {!attempt && data.application.state !== 'CONFIRMED' && data.application.state !== 'CANCELLED' && <div className="form-stack">
        {!data.identity.fullName || !data.identity.email ? <Notice><Link href={`/profile?applicationId=${applicationId}${data?.application.jobId ? `&jobId=${data.application.jobId}` : ''}`}>{c('Completa tu nombre y correo en el perfil para empezar.', 'Complete your name and email in your profile to begin.')}</Link></Notice> : !availableDocuments.length ? <Notice><Link href={`/documents?applicationId=${applicationId}${data?.application.jobId ? `&jobId=${data.application.jobId}` : ''}`}>{hasOutdatedDocuments ? c('Tu perfil cambió. En Mis CV, usa una versión como base, genera y aprueba el CV actualizado para continuar.', 'Your profile changed. In My resumes, use a version as a starting point, generate and approve an updated resume to continue.') : c('Prepara y aprueba un CV antes de empezar.', 'Prepare and approve a resume before you begin.')}</Link></Notice> : <>
          {hasOutdatedDocuments && <p>{c('Los CV anteriores a tus últimos cambios no se pueden elegir. Puedes actualizarlos en Mis CV.', 'Resumes from before your latest changes cannot be selected. You can update them in My resumes.')} <Link href={`/documents?applicationId=${applicationId}${data?.application.jobId ? `&jobId=${data.application.jobId}` : ''}`}>{c('Actualizar un CV', 'Update a resume')}</Link></p>}
          <SelectField label={c('CV aprobado para esta solicitud', 'Approved resume for this application')} value={selectedDocument} onChange={(e) => setDocumentId(e.target.value)} disabled={busy}>{availableDocuments.map((doc) => <option key={doc.id} value={doc.id}>{doc.name} · v{doc.revision}</option>)}</SelectField>
          <div className="form-grid"><Field label={c('Teléfono (opcional)', 'Phone (optional)')} value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={80} disabled={busy}/><Field label={c('Empresa actual (opcional)', 'Current company (optional)')} value={organization} onChange={(e) => setOrganization(e.target.value)} maxLength={200} disabled={busy}/></div>
          <Button disabled={busy || !selectedDocument} onClick={() => void act(`/applications/${applicationId}/assist/prepare`, { documentId: selectedDocument, phone, organization })}>{c('Revisar datos y destino', 'Review data and destination')}</Button>
        </>}
      </div>}
      {attempt && <div className="form-stack">
        <Tag tone={attempt.status === 'UNKNOWN' ? 'amber' : 'blue'}>{stateLabel[attempt.status]}</Tag>
        <dl className="assist-summary"><dt>{c('Destino', 'Destination')}</dt><dd>{attempt.plan.url}</dd><dt>{c('Nombre y correo', 'Name and email')}</dt><dd>{attempt.plan.fields.name}<br/>{attempt.plan.fields.email}</dd>{attempt.plan.fields.phone && <><dt>{c('Teléfono', 'Phone')}</dt><dd>{attempt.plan.fields.phone}</dd></>}{attempt.plan.fields.org && <><dt>{c('Empresa actual', 'Current company')}</dt><dd>{attempt.plan.fields.org}</dd></>}<dt>{c('CV elegido', 'Selected resume')}</dt><dd>{attempt.plan.documentName}</dd><dt>{c('Huella SHA-256 del CV', 'Resume SHA-256 hash')}</dt><dd><code style={{ overflowWrap: 'anywhere' }}>{attempt.plan.documentSha256}</code></dd></dl>
        {attempt.status === 'PREPARED' && <>
          <p>{c('Autorización de un solo uso. Caduca a las', 'One-use authorization. Expires at')} {new Date(attempt.expiresAt).toLocaleTimeString(locale)}.</p>
          <label className="checkbox-row"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={busy}/><span>{c('He revisado el destino y los datos. Autorizo abrir esta página de Lever y rellenar estos campos; el sitio recibirá mi conexión. No autorizo subir archivos ni enviar la solicitud automáticamente.', 'I reviewed the destination and data. I authorize opening this Lever page and filling these fields; the site will receive my connection. I do not authorize automatic file uploads or application submission.')}</span></label>
          <Button disabled={busy || !consent || Date.parse(attempt.expiresAt) < Date.now()} onClick={() => void act(`/assisted-attempts/${attempt.id}/start`, { consent: true, expectedDigest: attempt.digest })}>{busy ? c('Abriendo navegador…', 'Opening browser…') : c('Abrir y autocompletar', 'Open and autofill')}</Button>
        </>}
        {attempt.status === 'STARTING' && <Notice>{c('El navegador se está preparando. No abras otro intento.', 'The browser is being prepared. Do not open another attempt.')}</Notice>}
        {['REVIEW', 'HANDOFF_REQUIRED'].includes(attempt.status) && <>
          <Notice tone={attempt.status === 'HANDOFF_REQUIRED' ? 'warning' : 'info'}>{attempt.status === 'HANDOFF_REQUIRED' ? c('La estructura del formulario cambió o requiere intervención. No rellenamos campos; puedes tomar el control y continuar manualmente.', 'The form changed or requires intervention. No fields were filled; you can take control and continue manually.') : c('Revisa los datos en la ventana que se abrió. La conexión está pausada hasta que autorices el envío o tomes el control.', 'Review the data in the window that opened. Its connection is paused until you authorize submission or take control.')}</Notice>
          <a className="button button-secondary" href={`/api/v1/documents/${attempt.plan.documentId}/file`}>{c('Descargar CV para adjuntarlo', 'Download resume to attach')}</a>
          {attempt.status === 'REVIEW' && <>
            <label className="checkbox-row"><input type="checkbox" checked={submitConsent} onChange={(e) => setSubmitConsent(e.target.checked)} disabled={busy}/><span>{c('He revisado el formulario, los datos y el CV aprobado. Autorizo una sola vez que la app adjunte este CV y envíe esta solicitud a la dirección mostrada. La empresa recibirá mi conexión y estos datos.', 'I reviewed the form, data and approved resume. I authorize the app once to attach this resume and submit this application to the displayed address. The employer will receive my connection and these details.')}</span></label>
            <Button disabled={busy || !submitConsent} onClick={() => void act(`/assisted-attempts/${attempt.id}/submit`, { consent: true, expectedDigest: attempt.digest })}>{busy ? c('Adjuntando y enviando…', 'Attaching and submitting…') : c('Adjuntar CV y enviar solicitud', 'Attach resume and submit application')}</Button>
          </>}
          <label className="checkbox-row"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} disabled={busy}/><span>{c('Revisé la ventana y el CV. Quiero tomar el control y habilitar la conexión para adjuntar, completar y enviar yo. La web puede guardar datos antes del envío final.', 'I reviewed the window and resume. I want to take control and enable its connection to attach, complete and submit myself. The site may save data before final submission.')}</span></label>
          <Button disabled={busy || !reviewed} onClick={() => void act(`/assisted-attempts/${attempt.id}/handoff`, { confirmReviewed: true })}>{c('Tomar el control de la ventana', 'Take control of the window')}</Button>
        </>}
        {attempt.status === 'HANDED_OFF' && <Notice>{c('Continúa en la misma ventana de Lever. Adjunta el CV, revisa todo y envía tú. Después registra el resultado aquí.', 'Continue in the same Lever window. Attach your resume, review everything and submit yourself. Then record the outcome here.')}</Notice>}
        {attempt.status === 'UNKNOWN' && <Notice tone="warning">{c('No sabemos si se envió. Revisa la página o tu correo antes de repetir. Otro intento permanecerá bloqueado hasta que aclares el resultado.', 'We do not know whether it was submitted. Check the page or your email before repeating. Another attempt stays blocked until you clarify the outcome.')}</Notice>}
        {['REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF', 'UNKNOWN'].includes(attempt.status) && <fieldset className="assist-resolution" disabled={busy}><legend>{c('Registrar lo que comprobaste', 'Record what you checked')}</legend>
          <SelectField label={c('Resultado', 'Outcome')} value={outcome} onChange={(e) => { setOutcome(e.target.value); setAttested(false); }}><option value="UNKNOWN">{c('No estoy seguro', 'I am not sure')}</option><option value="CONFIRMED">{c('Sí, la envié y vi confirmación', 'Yes, I submitted and saw confirmation')}</option><option value="NOT_SUBMITTED">{c('Comprobé que no se envió', 'I checked it was not submitted')}</option></SelectField>
          <TextareaField label={c('Qué comprobaste', 'What you checked')} value={reason} onChange={(e) => { setReason(e.target.value); setAttested(false); }} rows={2} maxLength={2000} placeholder={c('Ejemplo: vi el mensaje de confirmación de la empresa.', 'Example: I saw the employer’s confirmation message.')}/>
          <label className="checkbox-row"><input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)}/><span>{c('Confirmo mi declaración. Se cerrará la ventana; la app no verifica el resultado con la empresa.', 'I confirm my statement. The window will close; the app does not verify the result with the employer.')}</span></label>
          <Button disabled={!attested || !reason.trim() || busy} onClick={() => void act(`/assisted-attempts/${attempt.id}/resolve`, { outcome, reason: reason.trim(), confirmReviewed: true })}>{c('Guardar resultado y cerrar ventana', 'Save outcome and close window')}</Button>
        </fieldset>}
        {attempt.status !== 'UNKNOWN' && <Button variant="quiet" disabled={busy || attempt.status === 'STARTING'} onClick={() => void act(`/assisted-attempts/${attempt.id}/cancel`, {})}>{attempt.status === 'PREPARED' ? c('Cancelar preparación', 'Cancel preparation') : c('Cerrar ventana y comprobar después', 'Close window and check later')}</Button>}
      </div>}
      {!attempt && data.attempts[0] && <Notice tone={data.attempts[0].status === 'CONFIRMED' ? 'success' : 'info'}>{c('Último intento', 'Last attempt')}: {data.attempts[0].result.reason === 'ASSIST_VISIBLE_RECEIPT' ? c('Confirmación visible en la página', 'Visible confirmation on the page') : stateLabel[data.attempts[0].status] ?? data.attempts[0].status}.{data.attempts[0].result.receipt && <><br/>{c('Confirmación visible', 'Visible confirmation')}: {data.attempts[0].result.receipt}</>}</Notice>}
    </>}
  </section>;
}
