'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { Button } from '@/components/ui';
import { copy } from '@/lib/labels';
import styles from './application-cover-letter.module.css';

type Claim = { sentenceId: string; text: string; kind: 'OFFER_REFERENCE' | 'BOILERPLATE' | 'CANDIDATE_CLAIM'; origin: 'BUILDER' | 'CODEX' | 'USER_EDITED' | 'USER_UNSUPPORTED'; sourceFactIds: string[] };
type Fact = { id: string; statement: string };
type Preview = {
  revisionId: string;
  revision: number;
  provider: string;
  model: string;
  operation: 'DOCUMENT_REWORD';
  locale: 'es' | 'en';
  categories: string[];
  payloadSha256: string;
  messages: Array<{ role: string; content: string }>;
  sentences: Array<{ sentenceId: string; text: string; kind: 'CANDIDATE_CLAIM'; citedFacts: Array<{ factId: string; text: string }> }>;
};
type Proposal = { sentenceId: string; text: string; sourceFactIds: string[] };
type RunResult = { runId: string; status: 'SUCCEEDED'; baseRevisionId: string; proposals: Proposal[] };

type Props = {
  applicationId: string;
  documentId: string;
  revisionId: string;
  kind: 'resume' | 'cover-letter';
  language: 'es' | 'en';
  claims: Claim[];
  facts: Fact[];
  disabled?: boolean;
  onActiveChange: (active: boolean) => void;
  onAccepted: () => Promise<void>;
  onSaveEdited: (claims: Claim[]) => Promise<boolean>;
};

export function ApplicationDocumentReword({ applicationId, documentId, revisionId, kind, language, claims, facts, disabled = false, onActiveChange, onAccepted, onSaveEdited }: Props) {
  const { locale } = useLocale();
  const c = copy(locale);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [message, setMessage] = useState('');
  const base = `/applications/${applicationId}/documents/${documentId}/document-reword`;
  const hasEdits = result?.proposals.some((proposal) => edits[proposal.sentenceId] !== proposal.text) ?? false;

  const showError = (reason: unknown) => {
    setError(errorMessage(reason));
    setErrorCode(reason instanceof ApiError ? reason.code : '');
  };
  const prepare = async () => {
    if (busy || disabled) return;
    setBusy(true); setError(''); setErrorCode(''); setMessage(''); setPreview(null); setResult(null); setEdits({}); setConfirmed(false);
    onActiveChange(true);
    try {
      setPreview(await api<Preview>(`${base}/preview`, { method: 'POST', body: JSON.stringify({ revisionId }) }));
    } catch (reason) { onActiveChange(false); showError(reason); }
    finally { setBusy(false); }
  };
  const run = async () => {
    if (!preview || !confirmed || busy || disabled) return;
    setBusy(true); setError(''); setErrorCode(''); setMessage('');
    try {
      const next = await api<RunResult>(base, { method: 'POST', body: JSON.stringify({ revisionId, payloadSha256: preview.payloadSha256, confirmed: true, origin: 'MANUAL' }) });
      setResult(next);
      setEdits(Object.fromEntries(next.proposals.map((proposal) => [proposal.sentenceId, proposal.text])));
    } catch (reason) { showError(reason); }
    finally { setBusy(false); }
  };
  const accept = async () => {
    if (!result || hasEdits || busy || disabled) return;
    setBusy(true); setError(''); setErrorCode(''); setMessage('');
    try {
      await api(`${base}/accept`, { method: 'POST', body: JSON.stringify({ runId: result.runId, revisionId, proposals: result.proposals }) });
      onActiveChange(false);
      await onAccepted();
      setPreview(null); setResult(null); setEdits({}); setConfirmed(false);
    } catch (reason) { showError(reason); }
    finally { setBusy(false); }
  };
  const saveEdited = async () => {
    if (!result || !hasEdits || busy || disabled) return;
    const nextClaims = claims.map((claim) => {
      const proposal = result.proposals.find((item) => item.sentenceId === claim.sentenceId);
      if (!proposal) return claim;
      const text = edits[proposal.sentenceId] ?? proposal.text;
      return { ...claim, text, sourceFactIds: proposal.sourceFactIds, origin: text === proposal.text ? 'CODEX' as const : 'USER_EDITED' as const };
    });
    setBusy(true); setError(''); setErrorCode(''); setMessage('');
    try {
      const saved = await onSaveEdited(nextClaims);
      if (!saved) {
        setMessage(c('La edición no se guardó. Descarta la propuesta para volver al editor y revisar el motivo.', 'The edit was not saved. Discard the proposal to return to the editor and review the reason.'));
        return;
      }
      onActiveChange(false);
      setPreview(null); setResult(null); setEdits({}); setConfirmed(false);
    } finally { setBusy(false); }
  };
  const discard = () => {
    if (busy) return;
    setPreview(null); setResult(null); setEdits({}); setConfirmed(false); setError(''); setErrorCode(''); setMessage('');
    onActiveChange(false);
  };

  return <section className={styles.assistant} aria-labelledby={`${kind}-codex-heading`} lang={language}>
    <h4 id={`${kind}-codex-heading`}>{c('Ayuda de Codex para esta versión', 'Codex help for this version')}</h4>
    <p>{c('Codex solo recibirá la frase que revises, sus hechos citados y el contexto de la oferta. No cambia el documento hasta que aceptes o guardes una edición.', 'Codex only receives the sentence you review, its cited facts, and the job context. The document does not change until you accept or save an edit.')}</p>
    {!preview && !result && <Button type="button" variant="secondary" disabled={disabled || busy || !claims.some((claim) => claim.kind === 'CANDIDATE_CLAIM' && claim.sourceFactIds.length > 0)} onClick={() => void prepare()}>{busy ? c('Preparando vista previa…', 'Preparing preview…') : c('Revisar qué se enviaría a Codex', 'Preview what would be sent to Codex')}</Button>}

    {preview && !result && <div className={styles.assistantPanel}>
      <p>{c(`Versión ${preview.revision} · proveedor ${preview.provider} · modelo ${preview.model}`, `Revision ${preview.revision} · provider ${preview.provider} · model ${preview.model}`)}</p>
      <p>{c('Se enviarán estas frases y sus fuentes. Comprueba el texto exacto antes de continuar.', 'These sentences and sources will be sent. Check the exact content before continuing.')}</p>
      <ol className={styles.assistantSentences}>{preview.sentences.map((sentence) => <li key={sentence.sentenceId}>
        <p>{sentence.text}</p>
        <ul>{sentence.citedFacts.map((fact) => <li key={fact.factId}>{facts.find((item) => item.id === fact.factId)?.statement ?? fact.text}</li>)}</ul>
      </li>)}</ol>
      <details className={styles.promptPreview} open>
        <summary>{c('Ver el mensaje completo enviado a Codex', 'View the complete message sent to Codex')}</summary>
        {preview.messages.map((item, index) => <section key={`${item.role}-${index}`}><h5>{item.role}</h5><pre>{item.content}</pre></section>)}
      </details>
      <p className={styles.hint}>{c(`Datos incluidos: ${preview.categories.join(', ')}. Huella de esta vista previa: ${preview.payloadSha256}.`, `Included data: ${preview.categories.join(', ')}. Preview fingerprint: ${preview.payloadSha256}.`)}</p>
      <label className={styles.confirm}><input type="checkbox" checked={confirmed} disabled={busy || disabled} onChange={(event) => setConfirmed(event.target.checked)}/>{c('He revisado esta vista previa y autorizo enviar este borrador a mi cuenta de Codex una sola vez.', 'I reviewed this preview and authorize sending this draft to my Codex account once.')}</label>
      <div className={styles.actions}>
        <Button type="button" disabled={!confirmed || busy || disabled} onClick={() => void run()}>{busy ? c('Consultando Codex…', 'Asking Codex…') : c('Pedir propuesta', 'Ask for a proposal')}</Button>
        <Button type="button" variant="quiet" disabled={busy} onClick={discard}>{c('Descartar', 'Discard')}</Button>
      </div>
    </div>}

    {result && <div className={styles.assistantPanel}>
      <p role="status">{c('Codex devolvió una propuesta. No se ha guardado todavía.', 'Codex returned a proposal. It has not been saved.')}</p>
      <ol className={styles.assistantSentences}>{result.proposals.map((proposal) => {
        const original = claims.find((claim) => claim.sentenceId === proposal.sentenceId);
        return <li key={proposal.sentenceId}>
          <p className={styles.hint}>{c('Original', 'Original')}: {original?.text ?? ''}</p>
          <label htmlFor={`${kind}-codex-${proposal.sentenceId}`}>{c('Propuesta de Codex', 'Codex proposal')}</label>
          <textarea id={`${kind}-codex-${proposal.sentenceId}`} rows={3} maxLength={4000} value={edits[proposal.sentenceId] ?? proposal.text} disabled={busy || disabled} onChange={(event) => setEdits((current) => ({ ...current, [proposal.sentenceId]: event.target.value }))}/>
          <span className="tag tag-blue">{edits[proposal.sentenceId] === proposal.text ? 'CODEX' : 'USER_EDITED'}</span>
          <details><summary>{c('Hechos que respaldan la propuesta', 'Facts supporting this proposal')}</summary><ul>{proposal.sourceFactIds.map((id) => <li key={id}>{facts.find((fact) => fact.id === id)?.statement ?? c('Esta fuente ya no está disponible.', 'This source is no longer available.')}</li>)}</ul></details>
        </li>;
      })}</ol>
      <div className={styles.actions}>
        <Button type="button" disabled={busy || disabled || hasEdits || !result.proposals.length} onClick={() => void accept()}>{busy ? c('Guardando…', 'Saving…') : c('Aceptar propuesta sin cambios', 'Accept proposal unchanged')}</Button>
        {hasEdits && <Button type="button" variant="secondary" disabled={busy || disabled} onClick={() => void saveEdited()}>{busy ? c('Guardando edición…', 'Saving edit…') : c('Guardar mis cambios', 'Save my edits')}</Button>}
        <Button type="button" variant="quiet" disabled={busy} onClick={discard}>{c('Descartar propuesta', 'Discard proposal')}</Button>
      </div>
    </div>}

    {error && <div role="alert" className={styles.error}>{error}{errorCode === 'AI_NOT_CONNECTED' && <p><Link href="/settings">{c('Conectar Codex en Ajustes', 'Connect Codex in Settings')}</Link></p>}</div>}
    {message && <p role="status" className={styles.success}>{message}</p>}
    {busy && <p role="status" className="sr-only">{c('La operación sigue en curso.', 'The operation is still running.')}</p>}
  </section>;
}
