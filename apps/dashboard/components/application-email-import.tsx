'use client';

import { useState, type FormEvent } from 'react';
import { Button, Notice, TextareaField } from '@/components/ui';
import { useLocale } from '@/lib/i18n';
import { api, errorMessage } from '@/lib/api';
import { copy, labelFor } from '@/lib/labels';
import type { RecruitmentStage } from '@career/domain';

type Preview = { token: string; source: 'PASTED_TEXT' | 'EML'; messageDate: string | null; currentStage: RecruitmentStage; detectedStage: RecruitmentStage | null; proposedStage: RecruitmentStage | null; evidence: string; offerProtected: boolean; stageAlreadyReached: boolean; stageRegressionBlocked: boolean };

const fileToBase64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
};

export function ApplicationEmailImport({ applicationId, onImported }: { applicationId: string; onImported: () => void }) {
  const { locale } = useLocale(); const c = copy(locale);
  const [source, setSource] = useState<'PASTED_TEXT' | 'EML'>('PASTED_TEXT');
  const [text, setText] = useState(''); const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null); const [applyStage, setApplyStage] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const resetPreview = () => { setPreview(null); setApplyStage(false); setError(''); setMessage(''); };

  const review = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); resetPreview();
    try {
      if (source === 'EML') {
        if (!file || !file.name.toLowerCase().endsWith('.eml') || file.size > 1_000_000) throw new Error(c('Elige un archivo .eml de hasta 1 MB.', 'Choose an .eml file no larger than 1 MB.'));
        const result = await api<Preview>(`/applications/${applicationId}/email-import/preview`, { method: 'POST', body: JSON.stringify({ source, emlBase64: await fileToBase64(file) }) });
        setPreview(result);
      } else {
        const result = await api<Preview>(`/applications/${applicationId}/email-import/preview`, { method: 'POST', body: JSON.stringify({ source, text }) });
        setPreview(result); setText('');
      }
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/applications/${applicationId}/email-import/confirm`, { method: 'POST', body: JSON.stringify({ token: preview.token, applyStage }) });
      setPreview(null); setFile(null); setApplyStage(false);
      setMessage(c('Mensaje guardado en el historial. El contenido del email no se conserva.', 'Message added to the history. The email content is not retained.'));
      onImported();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };

  return <details className="application-email-import">
    <summary>{c('Importar un email', 'Import an email')}</summary>
    <p>{c('Pega el texto o elige un archivo .eml. No se conecta al buzón ni se abren enlaces o imágenes.', 'Paste message text or choose an .eml file. No mailbox is connected and no links or images are opened.')}</p>
    <form onSubmit={(event) => void review(event)}>
      <fieldset disabled={busy || Boolean(preview)}>
        <legend>{c('Origen del mensaje', 'Message source')}</legend>
        <label><input type="radio" name={`email-source-${applicationId}`} checked={source === 'PASTED_TEXT'} onChange={() => { setSource('PASTED_TEXT'); setFile(null); resetPreview(); }}/> {c('Pegar texto', 'Paste text')}</label>
        <label><input type="radio" name={`email-source-${applicationId}`} checked={source === 'EML'} onChange={() => { setSource('EML'); setText(''); resetPreview(); }}/> {c('Archivo .eml', '.eml file')}</label>
      </fieldset>
      {source === 'PASTED_TEXT'
        ? <TextareaField label={c('Texto del mensaje', 'Message text')} rows={6} maxLength={100_000} value={text} onChange={(event) => { setText(event.target.value); resetPreview(); }} placeholder={c('Pega aquí el contenido del email…', 'Paste the email text here…')}/>
        : <label className="field"><span>{c('Archivo .eml (máximo 1 MB)', '.eml file (up to 1 MB)')}</span><input type="file" accept=".eml,message/rfc822" onChange={(event) => { setFile(event.target.files?.[0] ?? null); resetPreview(); }}/></label>}
      {!preview && <Button type="submit" variant="secondary" disabled={busy || (source === 'PASTED_TEXT' ? !text.trim() : !file)}>{busy ? c('Revisando…', 'Reviewing…') : c('Revisar mensaje', 'Review message')}</Button>}
    </form>
    {error && <Notice tone="warning" role="alert">{error}</Notice>}
    {message && <Notice tone="success" role="status">{message}</Notice>}
    {preview && <section aria-labelledby={`email-preview-${applicationId}`}>
      <h4 id={`email-preview-${applicationId}`}>{c('Revisa la evidencia', 'Review the evidence')}</h4>
      {preview.messageDate && <p>{c('Fecha del mensaje: ', 'Message date: ')}{new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'es-ES', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(preview.messageDate))}</p>}
      <blockquote>{preview.evidence || c('El mensaje no contiene una frase reconocida para sugerir una etapa.', 'No recognized phrase was found to suggest a stage.')}</blockquote>
      {preview.offerProtected && <Notice tone="info">{c('La etapa actual es Oferta. Este mensaje no puede hacerla retroceder.', 'The current stage is Offer. This message cannot move it backwards.')}</Notice>}
      {preview.stageRegressionBlocked && !preview.offerProtected && <Notice tone="info">{c(`La etapa actual (${labelFor.recruitmentStage(preview.currentStage, locale)}) ya va después de la etapa detectada (${labelFor.recruitmentStage(preview.detectedStage, locale)}). No se cambiará.`, `The current stage (${labelFor.recruitmentStage(preview.currentStage, 'en')}) is later than the detected stage (${labelFor.recruitmentStage(preview.detectedStage, 'en')}). It will not change.`)}</Notice>}
      {preview.stageAlreadyReached && <p>{c('El mensaje coincide con la etapa actual; no hace falta cambiarla.', 'The message matches the current stage; no change is needed.')}</p>}
      {preview.proposedStage && <label><input type="checkbox" checked={applyStage} disabled={busy} onChange={(event) => setApplyStage(event.target.checked)}/> {c('Aplicar la etapa sugerida: ', 'Apply suggested stage: ')}<strong>{labelFor.recruitmentStage(preview.proposedStage, locale)}</strong></label>}
      {!preview.proposedStage && !preview.offerProtected && !preview.stageRegressionBlocked && !preview.stageAlreadyReached && <p>{c('No se propone ningún cambio de etapa. Puedes guardar el mensaje como un evento del historial.', 'No stage change is suggested. You can save the message as a history event.')}</p>}
      <div className="button-row">
        <Button variant="secondary" disabled={busy} onClick={() => void confirm()}>{busy ? c('Guardando…', 'Saving…') : applyStage ? c('Guardar y cambiar etapa', 'Save and change stage') : c('Guardar sin cambiar etapa', 'Save without changing stage')}</Button>
        <Button variant="quiet" disabled={busy} onClick={() => resetPreview()}>{c('Descartar revisión', 'Discard review')}</Button>
      </div>
      <p className="muted-label">{c('El cambio solo se aplica si marcas la casilla y lo confirmas. Se guarda una referencia opaca del mensaje; no se almacena el cuerpo ni los adjuntos.', 'The stage changes only if you check the box and confirm. Only an opaque message reference is saved; the body and attachments are not stored.')}</p>
    </section>}
  </details>;
}
