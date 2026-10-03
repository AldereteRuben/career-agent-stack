'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Field, Notice, SelectField, Tag, TextareaField } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';

type Attempt = { id: string; status: string; digest: string; expiresAt: string; plan: { url: string; documentId: string; documentName: string; fields: { name: string; email: string; phone: string; org: string } }; result: { reason?: string; filled?: string[] }; createdAt: string };
type Data = { supported: boolean; url: string | null; identity: { fullName: string; email: string }; application: { state: string }; documents: Array<{ id: string; name: string; revision: number }>; attempts: Attempt[] };
const activeStates = ['PREPARED', 'STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF', 'UNKNOWN'];

export function AssistedApplication({ applicationId, onChanged }: { applicationId: string; onChanged: () => void }) {
  const { locale } = useLocale(); const c = copy(locale);
  const [data, setData] = useState<Data | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [documentId, setDocumentId] = useState(''); const [phone, setPhone] = useState(''); const [organization, setOrganization] = useState('');
  const [consent, setConsent] = useState(false); const [reviewed, setReviewed] = useState(false); const [attested, setAttested] = useState(false);
  const [outcome, setOutcome] = useState('UNKNOWN'); const [reason, setReason] = useState('');
  const pending = useRef(false); const alive = useRef(true);
  const load = useCallback(async (signal?: AbortSignal) => {
    try { const next = await api<Data>(`/applications/${applicationId}/assist`, signal ? { signal } : {}); if (alive.current) setData(next); }
    catch (err) { if (alive.current && !signal?.aborted) setError(errorMessage(err)); }
  }, [applicationId]);
  const attempt = data?.attempts.find((item) => activeStates.includes(item.status));
  const attemptId = attempt?.id;
  useEffect(() => { setConsent(false); setReviewed(false); setAttested(false); setReason(''); }, [attemptId]);
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
      ASSIST_PROFILE_REQUIRED: ['Guarda tu nombre y un correo válido en tu perfil.', 'Save your name and a valid email in your profile.'],
      ASSIST_DOCUMENT_REQUIRED: ['Genera y aprueba un CV con tu perfil actual.', 'Generate and approve a resume from your current profile.'],
      ASSIST_DOCUMENT_STALE: ['El CV ya no coincide con tus datos aprobados. Genera y revisa otra versión.', 'The resume no longer matches your approved facts. Generate and review a new version.'],
      ASSIST_INPUTS_CHANGED: ['Los datos cambiaron. Cierra este intento y prepara una autorización nueva.', 'The data changed. Close this attempt and prepare fresh authorization.'],
      ASSIST_CONSENT_EXPIRED: ['La autorización caducó. Cancela este intento y prepara otro.', 'The authorization expired. Cancel this attempt and prepare another.'],
      ASSIST_CONSENT_ALREADY_USED: ['Esta autorización ya se usó. Actualiza el estado; no repitas el envío.', 'This authorization was already used. Refresh the status; do not repeat submission.'],
      ASSIST_BROWSER_BUSY: ['Hay otra ventana asistida abierta. Resuelve ese intento primero.', 'Another assisted window is open. Resolve that attempt first.'],
      ASSIST_BROWSER_START_FAILED: ['No pudimos preparar el navegador. Comprueba que Chromium esté instalado y que la app tenga acceso al escritorio.', 'We could not prepare the browser. Check that Chromium is installed and the app can access your desktop.'],
      ASSIST_BROWSER_LOST: ['Se perdió la ventana. Comprueba el resultado antes de iniciar otro intento.', 'The window was lost. Check the outcome before starting another attempt.'],
      ASSIST_APPLICATION_CLOSED: ['Esta candidatura está cerrada o ya consta como enviada.', 'This application is closed or already recorded as submitted.'],
      ASSIST_INVALID_STATE: ['El estado cambió. Actualízalo antes de continuar.', 'The state changed. Refresh it before continuing.'],
    };
    const text = messages[err.code]; return text ? c(text[0], text[1]) : c('No se pudo completar la acción. Actualiza el estado antes de reintentar.', 'The action could not be completed. Refresh the state before retrying.');
  };
  const act = async (path: string, body: object) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError('');
    try { await api(path, { method: 'POST', body: JSON.stringify(body) }); setConsent(false); setReviewed(false); setAttested(false); }
    catch (err) { if (alive.current) setError(explain(err)); }
    finally { if (alive.current) { await load(); onChanged(); setBusy(false); } pending.current = false; }
  };
  const stateLabel: Record<string, string> = {
    PREPARED: c('Datos listos para revisar', 'Data ready for review'), STARTING: c('Preparando navegador', 'Preparing browser'), REVIEW: c('Revisa la ventana', 'Review the window'), HANDOFF_REQUIRED: c('Formulario requiere revisión manual', 'Form requires manual review'), HANDED_OFF: c('Tienes el control', 'You are in control'), UNKNOWN: c('Resultado por comprobar', 'Outcome needs checking'), CONFIRMED: c('Envío declarado por ti', 'Submission attested by you'), NOT_SUBMITTED: c('Sin enviar, según tu revisión', 'Not submitted, according to your review'), CANCELLED: c('Cancelado', 'Cancelled'), INVALIDATED: c('Autorización invalidada', 'Authorization invalidated'), FAILED: c('No se pudo iniciar', 'Could not start'),
  };
  const selectedDocument = documentId || data?.documents[0]?.id || '';
  return <section className="assist-panel" aria-labelledby={`assist-title-${applicationId}`} aria-busy={busy}>
    <div className="panel-heading"><div><div className="eyebrow">{c('SOLICITUD ASISTIDA · LEVER', 'ASSISTED APPLICATION · LEVER')}</div><h3 id={`assist-title-${applicationId}`}>{c('Prepara el formulario, conserva el control', 'Prepare the form, stay in control')}</h3></div><Button variant="quiet" disabled={busy} onClick={() => { setError(''); void load(); }}>{c('Actualizar', 'Refresh')}</Button></div>
    {error && <Notice tone="error">{error}</Notice>}
    {!data ? <p>{c('Cargando opciones…', 'Loading options…')}</p> : !data.supported ? <p>{c('Por ahora asistimos formularios alojados en Lever. Para esta oferta, abre el enlace original y continúa manualmente.', 'For now we assist forms hosted by Lever. For this job, open the original link and continue manually.')}</p> : <>
      <p>{c('Autocompletamos nombre, correo y los datos opcionales que indiques. Tú adjuntas el CV, respondes las preguntas, resuelves CAPTCHA y envías desde la misma ventana.', 'We fill your name, email and the optional details you provide. You attach your resume, answer questions, handle CAPTCHA and submit in the same window.')}</p>
      <ol className="assist-steps" aria-label={c('Pasos de la solicitud', 'Application steps')}><li>{c('Revisar datos', 'Review data')}</li><li>{c('Revisar navegador', 'Review browser')}</li><li>{c('Enviar tú y registrar', 'Submit yourself and record')}</li></ol>
      {!attempt && data.application.state !== 'CONFIRMED' && data.application.state !== 'CANCELLED' && <div className="form-stack">
        {!data.identity.fullName || !data.identity.email ? <Notice><Link href="/profile">{c('Completa tu nombre y correo en el perfil para empezar.', 'Complete your name and email in your profile to begin.')}</Link></Notice> : !data.documents.length ? <Notice><Link href="/documents">{c('Prepara y aprueba un CV antes de empezar.', 'Prepare and approve a resume before you begin.')}</Link></Notice> : <>
          <SelectField label={c('CV aprobado que adjuntarás tú', 'Approved resume you will attach')} value={selectedDocument} onChange={(e) => setDocumentId(e.target.value)} disabled={busy}>{data.documents.map((doc) => <option key={doc.id} value={doc.id}>{doc.name} · v{doc.revision}</option>)}</SelectField>
          <div className="form-grid"><Field label={c('Teléfono (opcional)', 'Phone (optional)')} value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={80} disabled={busy}/><Field label={c('Empresa actual (opcional)', 'Current company (optional)')} value={organization} onChange={(e) => setOrganization(e.target.value)} maxLength={200} disabled={busy}/></div>
          <Button disabled={busy} onClick={() => void act(`/applications/${applicationId}/assist/prepare`, { documentId: selectedDocument, phone, organization })}>{c('Revisar datos y destino', 'Review data and destination')}</Button>
        </>}
      </div>}
      {attempt && <div className="form-stack">
        <Tag tone={attempt.status === 'UNKNOWN' ? 'amber' : 'blue'}>{stateLabel[attempt.status]}</Tag>
        <dl className="assist-summary"><dt>{c('Destino', 'Destination')}</dt><dd>{attempt.plan.url}</dd><dt>{c('Nombre y correo', 'Name and email')}</dt><dd>{attempt.plan.fields.name}<br/>{attempt.plan.fields.email}</dd>{attempt.plan.fields.phone && <><dt>{c('Teléfono', 'Phone')}</dt><dd>{attempt.plan.fields.phone}</dd></>}{attempt.plan.fields.org && <><dt>{c('Empresa actual', 'Current company')}</dt><dd>{attempt.plan.fields.org}</dd></>}<dt>{c('CV elegido', 'Selected resume')}</dt><dd>{attempt.plan.documentName}</dd></dl>
        {attempt.status === 'PREPARED' && <>
          <p>{c('Autorización de un solo uso. Caduca a las', 'One-use authorization. Expires at')} {new Date(attempt.expiresAt).toLocaleTimeString(locale)}.</p>
          <label className="checkbox-row"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={busy}/><span>{c('He revisado el destino y los datos. Autorizo abrir esta página de Lever y rellenar estos campos; el sitio recibirá mi conexión. No autorizo subir archivos ni enviar la candidatura automáticamente.', 'I reviewed the destination and data. I authorize opening this Lever page and filling these fields; the site will receive my connection. I do not authorize automatic file uploads or application submission.')}</span></label>
          <Button disabled={busy || !consent || Date.parse(attempt.expiresAt) < Date.now()} onClick={() => void act(`/assisted-attempts/${attempt.id}/start`, { consent: true, expectedDigest: attempt.digest })}>{busy ? c('Abriendo navegador…', 'Opening browser…') : c('Abrir y autocompletar', 'Open and autofill')}</Button>
        </>}
        {attempt.status === 'STARTING' && <Notice>{c('El navegador se está preparando. No abras otro intento.', 'The browser is being prepared. Do not open another attempt.')}</Notice>}
        {['REVIEW', 'HANDOFF_REQUIRED'].includes(attempt.status) && <>
          <Notice tone={attempt.status === 'HANDOFF_REQUIRED' ? 'warning' : 'info'}>{attempt.status === 'HANDOFF_REQUIRED' ? c('La estructura del formulario cambió o requiere intervención. No rellenamos campos; puedes tomar el control y continuar manualmente.', 'The form changed or requires intervention. No fields were filled; you can take control and continue manually.') : c('Revisa los datos en la ventana que se abrió. La conexión de esa ventana está pausada hasta que tomes el control.', 'Review the data in the window that opened. That window’s connection is paused until you take control.')}</Notice>
          <a className="button button-secondary" href={`/api/v1/documents/${attempt.plan.documentId}/file`}>{c('Descargar CV para adjuntarlo', 'Download resume to attach')}</a>
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
      {!attempt && data.attempts[0] && <Notice tone={data.attempts[0].status === 'CONFIRMED' ? 'success' : 'info'}>{c('Último intento', 'Last attempt')}: {stateLabel[data.attempts[0].status] ?? data.attempts[0].status}.</Notice>}
    </>}
  </section>;
}
