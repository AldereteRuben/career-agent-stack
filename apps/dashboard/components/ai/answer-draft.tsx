'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Notice, TextareaField } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { localizedError, useLocale } from '@/lib/i18n';
import { copy, labelFor } from '@/lib/labels';
import { AiDraftAction } from './draft-action';
import type { AiArtifact } from './result-view';
import styles from './draft-action.module.css';

const experienceQuestions = new Set([
  'describe your relevant work experience', 'describe your customer service experience', 'describe a project you worked on',
  'describe tu experiencia laboral relevante', 'describe tu experiencia en atención al cliente', 'describe un proyecto en el que hayas trabajado',
]);
export const canDraftExperienceAnswer = (question: string) => experienceQuestions.has(question.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('und').replace(/\.$/, ''));

export function AiAnswerDraft({ questionId, facts, visible, disabled, onSaved, onManual, onDirtyChange }: {
  questionId: string; facts: Array<{ id: string; kind: string; statement: string }>; visible: boolean; disabled: boolean;
  onSaved: () => Promise<void>; onManual: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const { locale } = useLocale(); const c = copy(locale); const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]); const [review, setReview] = useState<AiArtifact | null>(null);
  const [text, setText] = useState(''); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const busy = useRef(false); const reviewHeading = useRef<HTMLHeadingElement>(null);
  const dirtyCallback = useRef(onDirtyChange); dirtyCallback.current = onDirtyChange;
  const factIds = JSON.stringify(facts.map(fact => fact.id).sort());
  const availableSelected = selected.filter(id => facts.some(fact => fact.id === id));
  const [selectionChanged, setSelectionChanged] = useState(false);
  useEffect(() => {
    const available = new Set<string>(JSON.parse(factIds));
    if (selected.some(id => !available.has(id))) {
      setSelected(values => values.filter(id => available.has(id)));
      setSelectionChanged(true);
    }
  }, [factIds, selected]);
  useEffect(() => { dirtyCallback.current(review !== null); return () => dirtyCallback.current(false); }, [review]);
  const choose = (artifact: AiArtifact) => {
    if (busy.current || disabled) return;
    if (artifact.output.operation !== 'ANSWER_DRAFT') return;
    if (review?.id === artifact.id) { reviewHeading.current?.focus(); return; }
    if (review && !window.confirm(c('Tienes una respuesta en revisión. ¿Reemplazarla por esta sugerencia?', 'You have an answer under review. Replace it with this suggestion?'))) return;
    if (artifact.output.result.status === 'NEEDS_USER_INPUT') { onManual(); return; }
    setReview(artifact); setText(artifact.output.result.text); setError('');
    window.setTimeout(() => reviewHeading.current?.focus(), 0);
  };
  const save = async () => {
    if (!review || !text.trim() || busy.current) return; busy.current = true; setSaving(true); setError('');
    try {
      await api(`/ai/artifacts/${encodeURIComponent(review.id)}/answer`, { method: 'POST', body: JSON.stringify({ expectedRevision: review.revision, text: text.trim() }) });
      await onSaved(); setReview(null);
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code : 'NETWORK_UNAVAILABLE';
      setError(['AI_SOURCE_CHANGED', 'AI_REVIEW_CHANGED', 'AI_ARTIFACT_NOT_AVAILABLE'].includes(code) ? c('La pregunta o los datos cambiaron. Conservamos tu texto; revisa la información antes de preparar otra sugerencia.', 'The question or supporting details changed. Your text is preserved; review the information before preparing another suggestion.') : code === 'AI_ANSWER_NEEDS_USER_INPUT' ? c('Esta pregunta necesita tu respuesta personal. Escríbela en el formulario.', 'This question needs your personal answer. Write it in the form.') : localizedError(code, locale));
    } finally { busy.current = false; setSaving(false); }
  };
  return <details className={styles.preview} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{c('Preparar una respuesta con mi experiencia', 'Draft an answer from my experience')}</summary>
    <div className={styles.section}>
      <p>{c('Elige los datos confirmados que quieras usar. Primero verás exactamente qué se compartirá con OpenAI.', 'Choose the confirmed details you want to use. First you will see exactly what will be shared with OpenAI.')}</p>
      {selectionChanged && <Notice>{c('Tu perfil cambió. Vuelve a elegir la experiencia que quieres compartir. Conservamos cualquier respuesta que estés editando.', 'Your profile changed. Choose the experience you want to share again. Any answer you are editing is preserved.')}</Notice>}
      <fieldset className={styles.section} disabled={disabled || saving || review !== null}><legend>{c('Experiencia que quieres incluir', 'Experience to include')}</legend>
        {facts.map(fact => <label className={styles.check} key={fact.id}><input type="checkbox" checked={selected.includes(fact.id)} onChange={event => setSelected(values => event.target.checked ? [...values, fact.id] : values.filter(id => id !== fact.id))}/><span><small>{labelFor.factKind(fact.kind, locale)}</small>{fact.statement}</span></label>)}
        {!facts.length && <p>{c('Añade y confirma primero algún dato de tu experiencia.', 'First add and confirm some details about your experience.')}</p>}
      </fieldset>
      {availableSelected.length > 0 && <AiDraftAction request={{ operation: 'ANSWER_DRAFT', locale, questionId, selectedFactIds: availableSelected }} label={c('Preparar borrador con Codex', 'Draft with Codex')} visible={visible && open} onReview={choose}/>}
      {review && <section className={styles.panel}><h3 ref={reviewHeading} tabIndex={-1}>{c('Revisa tu respuesta', 'Review your answer')}</h3>
        <TextareaField label={c('Respuesta que guardarás', 'Answer to save')} value={text} maxLength={4000} rows={6} disabled={disabled || saving} onChange={event => setText(event.target.value)}/>
        <p className={styles.hint}>{c('Al guardarla quedará pendiente de tu aprobación. No se envía a ninguna empresa.', 'Saving leaves it pending your approval. It is not sent to any employer.')}</p>
        {error && <Notice tone="error">{error}</Notice>}
        <div className={styles.actions}><Button type="button" disabled={disabled || saving || !text.trim()} onClick={() => void save()}>{saving ? c('Guardando…', 'Saving…') : c('Guardar respuesta para revisar', 'Save answer for review')}</Button><Button type="button" variant="secondary" disabled={saving} onClick={() => setReview(null)}>{c('Cerrar sin guardar', 'Close without saving')}</Button></div>
      </section>}
    </div>
  </details>;
}
