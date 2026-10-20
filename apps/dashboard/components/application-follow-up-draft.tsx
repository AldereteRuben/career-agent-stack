'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { buildApplicationFollowUpTemplate } from '@career/domain';
import { Button, Card, Field, Notice, SelectField, Tag, TextareaField } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';
import { followUpEmailText } from '@/lib/application-follow-up-draft';
import styles from './application-follow-up-draft.module.css';

type Draft = { id: string; applicationId: string; language: 'es' | 'en'; subject: string; body: string; createdAt: string; updatedAt: string };
type DraftResponse = { draft: Draft | null };

export function ApplicationFollowUpDraft({ applicationId, company, role }: { applicationId: string; company: string; role: string }) {
  const { locale } = useLocale(); const c = copy(locale);
  const [language, setLanguage] = useState<'es' | 'en'>(locale === 'en' ? 'en' : 'es');
  const [subject, setSubject] = useState(''); const [body, setBody] = useState('');
  const [saved, setSaved] = useState<Draft | null>(null); const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const requestId = useRef(0); const manualCopy = useRef<HTMLTextAreaElement>(null);
  const canCopy = Boolean(subject.trim() && body.trim());
  const combined = followUpEmailText(language, subject, body);

  const load = useCallback(async () => {
    const ticket = ++requestId.current; setLoading(true); setError('');
    try {
      const response = await api<DraftResponse>(`/applications/${applicationId}/follow-up-draft`);
      if (ticket !== requestId.current) return;
      const next = response.draft;
      setSaved(next); setLanguage(next?.language ?? (locale === 'en' ? 'en' : 'es'));
      setSubject(next?.subject ?? ''); setBody(next?.body ?? '');
    } catch (reason) { if (ticket === requestId.current) setError(errorMessage(reason)); }
    finally { if (ticket === requestId.current) setLoading(false); }
  }, [applicationId, locale]);

  useEffect(() => { void load(); return () => { requestId.current++; }; }, [load]);

  const startTemplate = () => {
    if ((subject.trim() || body.trim()) && !window.confirm(c('¿Reemplazar el texto actual con la plantilla?', 'Replace the current text with the template?'))) return;
    const template = buildApplicationFollowUpTemplate({ language, company, role });
    setSubject(template.subject); setBody(template.body); setError(''); setMessage(c('Plantilla lista para revisar y editar.', 'Template ready for you to review and edit.'));
  };

  const save = async () => {
    if (!canCopy || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await api<{ draft: Draft }>(`/applications/${applicationId}/follow-up-draft`, {
        method: saved ? 'PUT' : 'POST', body: JSON.stringify({ language, subject, body }),
      });
      setSaved(response.draft); setSubject(response.draft.subject); setBody(response.draft.body);
      setMessage(c('Borrador guardado en esta solicitud.', 'Draft saved on this application.'));
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!saved || busy || !window.confirm(c('¿Eliminar este borrador de seguimiento?', 'Delete this follow-up draft?'))) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/applications/${applicationId}/follow-up-draft`, { method: 'DELETE' });
      setSaved(null); setSubject(''); setBody(''); setMessage(c('Borrador eliminado.', 'Draft deleted.'));
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };

  const selectAll = () => {
    manualCopy.current?.focus(); manualCopy.current?.select();
    setMessage(c('Texto completo seleccionado. Cópialo con el teclado.', 'Full email selected. Copy it with your keyboard.'));
  };

  const copyEmail = async () => {
    if (!canCopy || busy) return;
    setError(''); setMessage('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
      await navigator.clipboard.writeText(combined);
      setMessage(c('Correo copiado. No se ha enviado.', 'Email copied. Nothing was sent.'));
    } catch {
      manualCopy.current?.focus(); manualCopy.current?.select();
      setMessage(c('No se pudo copiar automáticamente. El texto completo está seleccionado; cópialo con el teclado.', 'Automatic copy was unavailable. The full email is selected; copy it with your keyboard.'));
    }
  };

  return <Card className={`${styles.card} application-follow-up-draft`} aria-busy={loading || busy}>
    <div className={styles.heading}>
      <div><h3>{c('Borrador de correo de seguimiento', 'Follow-up email draft')}</h3><p>{c('Revísalo y edítalo antes de copiar. La app no envía correos.', 'Review and edit it before copying. The app does not send email.')}</p></div>
      {saved && <Tag tone="green">{c('Guardado', 'Saved')}</Tag>}
    </div>
    {loading ? <p role="status">{c('Cargando borrador…', 'Loading draft…')}</p> : <>
      {error && <Notice tone="error" actions={<Button variant="quiet" onClick={() => void load()}>{c('Reintentar', 'Retry')}</Button>}>{error}</Notice>}
      <div className={styles.languageRow}>
        <SelectField className={styles.languageSelect} label={c('Idioma del correo', 'Email language')} id={`follow-up-language-${applicationId}`} value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value as 'es' | 'en')}>
          <option value="es">Español</option><option value="en">English</option>
        </SelectField>
        <Button type="button" variant="quiet" disabled={busy} onClick={startTemplate}>{c('Empezar con una plantilla', 'Start from a template')}</Button>
      </div>
      <Field className={styles.field} label={c('Asunto', 'Subject')} id={`follow-up-subject-${applicationId}`} value={subject} maxLength={500} disabled={busy} onChange={(event) => setSubject(event.target.value)}/>
      <TextareaField className={styles.field} label={c('Mensaje', 'Message')} id={`follow-up-body-${applicationId}`} rows={7} maxLength={10_000} value={body} disabled={busy} onChange={(event) => setBody(event.target.value)}/>
      <div className={styles.actions}>
        <Button type="button" variant="secondary" disabled={busy || !canCopy} onClick={() => void save()}>{busy ? c('Guardando…', 'Saving…') : saved ? c('Guardar cambios', 'Save changes') : c('Guardar borrador', 'Save draft')}</Button>
        <Button type="button" variant="quiet" disabled={!canCopy || busy} onClick={() => void copyEmail()}>{c('Copiar correo', 'Copy email')}</Button>
        {saved && <Button type="button" variant="quiet" disabled={busy} onClick={() => void remove()}>{c('Eliminar borrador', 'Delete draft')}</Button>}
      </div>
      {canCopy && <details className={styles.manualCopy}>
        <summary>{c('Ver y seleccionar el correo completo', 'View and select the complete email')}</summary>
        <div className="field"><label className="sr-only" htmlFor={`follow-up-complete-${applicationId}`}>{c('Correo completo para copiar manualmente', 'Complete email for manual copying')}</label>
          <textarea className="field-control" ref={manualCopy} id={`follow-up-complete-${applicationId}`} rows={7} readOnly value={combined}/>
        </div>
        <Button type="button" variant="quiet" onClick={selectAll}>{c('Seleccionar todo', 'Select all')}</Button>
      </details>}
      {message && <Notice tone="success">{message}</Notice>}
    </>}
  </Card>;
}
