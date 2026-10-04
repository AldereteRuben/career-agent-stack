'use client';

import { useState } from 'react';
import { Button, Notice, TextareaField } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';
import { useSessionDraft, stringDraft } from '@/lib/session-draft';
import { useDisclosureFocus, useErrorFocus } from '@/lib/disclosure-focus';
import type { AiArtifact } from './result-view';
import styles from './draft-action.module.css';

/** Edits are a new PDF proposal. The existing PDF review remains the single approval step. */
export function AiResumeReview({ artifact, name, contextChanged = false, onGenerated, onCancel, onOriginals, onBusyChange }: {
  artifact: AiArtifact; name: string; contextChanged?: boolean; onGenerated: (documentId: string) => void; onCancel: () => void;
  onOriginals: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const { locale } = useLocale(); const c = copy(locale);
  const proposals = artifact.output.operation === 'RESUME_DRAFT' ? artifact.output.proposals : [];
  const initial = { edits: JSON.stringify(Object.fromEntries(proposals.map(item => [item.proposalKey, item.text]))), included: JSON.stringify(proposals.map(item => item.proposalKey)) };
  const draft = useSessionDraft(`ai-resume-review:${artifact.id}`, initial, (value): value is typeof initial => {
    if (!stringDraft(value) || typeof value.edits !== 'string' || typeof value.included !== 'string') return false;
    try {
      const texts: unknown = JSON.parse(value.edits); const keys: unknown = JSON.parse(value.included);
      return stringDraft(texts) && Object.keys(texts).length === proposals.length && proposals.every(item => typeof texts[item.proposalKey] === 'string' && texts[item.proposalKey]!.length <= 4000) && Array.isArray(keys) && new Set(keys).size === keys.length && keys.every(key => typeof key === 'string' && proposals.some(item => item.proposalKey === key));
    } catch { return false; }
  });
  const edits = JSON.parse(draft.value.edits) as Record<string, string>;
  const included = JSON.parse(draft.value.included) as string[];
  const edit = (key: string, text: string) => draft.update(value => ({ ...value, edits: JSON.stringify({ ...JSON.parse(value.edits), [key]: text }) }));
  const toggle = (key: string, checked: boolean) => draft.update(value => { const keys = JSON.parse(value.included) as string[]; return { ...value, included: JSON.stringify(checked ? [...keys, key] : keys.filter(item => item !== key)) }; });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const errorFocus = useErrorFocus(error);
  const heading = useDisclosureFocus(draft.ready);
  const disabled = busy || !draft.ready || contextChanged;
  const selected = proposals.filter(item => included.includes(item.proposalKey));
  const create = async () => {
    if (disabled || !selected.length) return;
    setBusy(true); onBusyChange(true); setError('');
    try {
      const covered = new Set(selected.flatMap(item => item.sourceFactIds));
      const result = await api<{ id: string }>(`/ai/artifacts/${artifact.id}/resume`, { method: 'POST', body: JSON.stringify({
        expectedRevision: artifact.revision, name: name.trim(),
        selections: selected.map(item => ({ proposalKey: item.proposalKey, text: edits[item.proposalKey]?.trim() })),
        includeOriginalFactIds: artifact.sources.facts.filter(fact => !covered.has(fact.factId)).map(fact => fact.factId),
      }) });
      onGenerated(result.id);
    } catch (failure) {
      const messages: Record<string, string> = {
        AI_SOURCE_CHANGED: c('Cambió tu perfil o la oferta. Conservamos tu texto: vuelve al formulario y pide una propuesta con los datos actuales antes de generar el PDF.', 'Your profile or the job changed. Your wording is saved: return to the form and request a suggestion with the current details before generating the PDF.'),
        AI_REVIEW_CHANGED: c('Esta propuesta ya se revisó en otra acción. Consulta tus CV guardados o pide una propuesta nueva.', 'This suggestion was already reviewed in another action. Check your saved resumes or request a new suggestion.'),
        AI_DOCUMENT_LIMIT: c('El CV tiene demasiado contenido. Vuelve al formulario y elige menos datos antes de pedir otra propuesta.', 'The resume has too much content. Return to the form and choose fewer details before requesting another suggestion.'),
        AI_DOCUMENT_UNAVAILABLE: c('No pudimos generar el PDF. Conservamos tus cambios para que puedas reintentar.', 'We could not generate the PDF. Your edits are saved so you can retry.'),
      };
      setError(failure instanceof ApiError && messages[failure.code] ? messages[failure.code]! : errorMessage(failure));
    } finally { setBusy(false); onBusyChange(false); }
  };
  if (!draft.ready) return <section className={styles.panel} aria-label={c('Revisar los textos para el CV', 'Review resume wording')}><p role="status">{c('Recuperando tus cambios…', 'Restoring your edits…')}</p></section>;
  return <section className={styles.panel} aria-label={c('Revisar los textos para el CV', 'Review resume wording')}>
    <h3 ref={heading} tabIndex={-1}>{c('Ajusta el texto y revisa el PDF', 'Adjust the wording and review the PDF')}</h3>
    <p>{c('Comprueba que cada frase describe tu experiencia. Si desmarcas una propuesta, conservaremos sus datos originales.', 'Check that each sentence describes your experience. If you uncheck a suggestion, we will keep its original details.')}</p>
    {contextChanged && <Notice tone="warning">{c('Cambiaste la oferta, el idioma o los datos seleccionados. Vuelve a la selección anterior para usar estas propuestas, o vuelve al formulario para preparar otras. Conservamos tus cambios en esta pestaña.', 'You changed the job, language or selected details. Restore the previous selection to use these suggestions, or return to the form to prepare new ones. Your edits stay in this tab.')}</Notice>}
    {draft.storageFailed && <Notice tone="warning">{c('No pudimos guardar estos cambios en la pestaña. Genera el PDF antes de salir para conservarlos.', 'We could not save these edits in this tab. Generate the PDF before leaving to keep them.')}</Notice>}
    {error && <div ref={errorFocus} tabIndex={-1}><Notice tone="error">{error}</Notice></div>}
    {proposals.map((item, index) => <div className={styles.section} key={item.proposalKey}>
      <label className={styles.check}><input type="checkbox" disabled={disabled} checked={included.includes(item.proposalKey)} onChange={event => toggle(item.proposalKey, event.target.checked)}/><span>{c(`Usar propuesta ${index + 1}`, `Use suggestion ${index + 1}`)}</span></label>
      {included.includes(item.proposalKey) && <TextareaField label={c('Texto que aparecerá en el CV', 'Text that will appear in the resume')} disabled={disabled} rows={4} maxLength={4000} value={edits[item.proposalKey] ?? ''} onChange={event => edit(item.proposalKey, event.target.value)}/>}
      <details><summary>{c('Consultar los datos originales', 'View original details')}</summary>{artifact.sources.facts.filter(fact => item.sourceFactIds.includes(fact.factId)).map(fact => <p className={styles.source} key={fact.factId}>{fact.text}</p>)}</details>
      {edits[item.proposalKey] !== item.text && <Button variant="quiet" disabled={disabled} onClick={() => edit(item.proposalKey, item.text)}>{c('Recuperar la propuesta', 'Restore the suggestion')}</Button>}
    </div>)}
    <p>{c('Generaremos una versión nueva. Podrás aprobarla después de leer el PDF completo.', 'We will generate a new version. You can approve it after reading the complete PDF.')}</p>
    {!selected.length && <p>{c('Conservaremos todos tus textos originales. Continúa al formulario para generar ese PDF.', 'We will keep all your original wording. Continue to the form to generate that PDF.')}</p>}
    <p className={styles.hint}>{c('Tus cambios se conservan en esta pestaña. Cerrar sesión los borra.', 'Your edits stay in this tab. Signing out clears them.')}</p>
    <div className={styles.actions}>{selected.length ? <Button disabled={disabled || !name.trim() || selected.some(item => !edits[item.proposalKey]?.trim())} onClick={() => void create()}>{busy ? c('Preparando el PDF…', 'Preparing the PDF…') : c('Generar y revisar el PDF', 'Generate and review the PDF')}</Button> : <Button disabled={disabled} onClick={onOriginals}>{c('Continuar con mis textos originales', 'Continue with my original wording')}</Button>}<Button variant="quiet" disabled={busy} onClick={() => { if (!draft.storageFailed || window.confirm(c('No pudimos guardar estos cambios. ¿Volver y perderlos?', 'We could not save these edits. Go back and lose them?'))) onCancel(); }}>{c('Volver', 'Back')}</Button></div>
  </section>;
}
