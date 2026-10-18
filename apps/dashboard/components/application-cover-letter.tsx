'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { Button, Card } from '@/components/ui';
import styles from './application-cover-letter.module.css';

type Sentence = { sentenceId: string; text: string; kind: 'OFFER_REFERENCE' | 'BOILERPLATE' | 'CANDIDATE_CLAIM'; origin: 'BUILDER' | 'CODEX' | 'USER_EDITED' | 'USER_UNSUPPORTED'; sourceFactIds: string[]; language?: 'es' | 'en' };
type Revision = { id: string; revision: number; claims: Sentence[]; contentHash: string; factsHash: string; offerHash: string; textSha256: string; pdfSha256: string; approvedAt: string | null; confirmedUnsupportedIds: string[]; text?: string };
type Draft = { applicationId: string; language: 'es' | 'en'; sentences: Sentence[]; unconfirmedRequirements: Array<{ text: string }>; profileNotice: string | null };
type Saved = { applicationId: string; documentId: string; language: 'es' | 'en'; revisions: Revision[] };
type Stored = { documentId: string; revision: Revision; text: string };

export function ApplicationCoverLetter({ applicationId }: { applicationId: string }) {
  const { locale } = useLocale();
  const language = locale === 'es' ? 'es' : 'en';
  const copy = (es: string, en: string) => language === 'es' ? es : en;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [baseRevisionId, setBaseRevisionId] = useState<string | undefined>();
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [confirmIds, setConfirmIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [stored, setStored] = useState<Stored | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setMessage(''); setStored(null); setConfirmIds([]);
    try {
      const [nextDraft, history] = await Promise.all([
        api<Draft>(`/applications/${applicationId}/cover-letter/draft?language=${language}`),
        api<Saved>(`/applications/${applicationId}/cover-letter?language=${language}`).catch((reason: unknown) => {
          if (reason instanceof ApiError && reason.status === 404) return null;
          throw reason;
        }),
      ]);
      const latest = history?.revisions[0] ?? null;
      setDraft(nextDraft); setSaved(history);
      setBaseRevisionId(latest?.id);
      setSentences(latest?.claims ?? nextDraft.sentences);
      setStored(latest && history ? { documentId: history.documentId, revision: latest, text: latest.text ?? '' } : null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally { setLoading(false); }
  }, [applicationId, language]);

  useEffect(() => { void load(); }, [load]);

  const changed = useMemo(() => {
    if (!sentences.length || !draft) return false;
    const baseline = saved?.revisions[0]?.claims;
    if (!baseline) return true;
    return JSON.stringify(sentences) !== JSON.stringify(baseline);
  }, [draft, saved, sentences]);

  const save = async () => {
    if (!draft || busy || !sentences.length) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await api<Stored>(`/applications/${applicationId}/cover-letter/revisions`, {
        method: 'POST',
        body: JSON.stringify({
          language,
          parentRevisionId: baseRevisionId,
          sentences: sentences.map(({ sentenceId, text, sourceFactIds }) => ({ sentenceId, text, sourceFactIds })),
          confirmUnsupportedIds: confirmIds,
        }),
      });
      await load();
      setMessage(copy('Versión guardada. Revisa el PDF antes de aprobarla.', 'Version saved. Review the PDF before approving it.'));
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };

  const approve = async () => {
    if (!stored || busy || stored.revision.approvedAt) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/applications/${applicationId}/cover-letter/revisions/${stored.revision.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          language,
          expectedContentHash: stored.revision.contentHash,
          expectedFactsHash: stored.revision.factsHash,
          expectedOfferHash: stored.revision.offerHash,
          expectedTextSha256: stored.revision.textSha256,
          expectedPdfSha256: stored.revision.pdfSha256,
          confirmedUnsupportedIds: confirmIds,
        }),
      });
      setMessage(copy('Carta aprobada. Esta es la versión que puedes descargar.', 'Cover letter approved. This is the version you can download.'));
      await load();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };

  const updateSentence = (sentenceId: string, text: string) => {
    setConfirmIds((current) => current.filter((id) => id !== sentenceId));
    setSentences((current) => current.map((sentence) => sentence.sentenceId === sentenceId ? { ...sentence, text, origin: 'USER_EDITED' } : sentence));
  };
  const restore = () => { if (draft) { setSentences(draft.sentences); setConfirmIds([]); } };

  return <Card className={`${styles.card} application-resume`}>
    <div className={styles.heading}><h3>{copy('Carta de presentación', 'Cover letter')}</h3><span className="tag tag-blue">{language.toUpperCase()}</span></div>
    <p>{copy('Borrador local basado en la oferta guardada y tus hechos aprobados. Nada se envía a la empresa.', 'A local draft based on the saved offer and your approved facts. Nothing is sent to the employer.')}</p>
    {loading ? <p role="status">{copy('Preparando el borrador…', 'Preparing draft…')}</p> : error && !draft ? <p role="alert" className={styles.error}>{error} <Button variant="quiet" onClick={() => void load()}>{copy('Reintentar', 'Retry')}</Button></p> : null}
    {draft?.profileNotice && <p className={styles.notice} role="status">{draft.profileNotice}</p>}
    {draft && !loading && <>
      {draft.unconfirmedRequirements.length > 0 && <div className={styles.notice}><strong>{copy('Requisitos sin evidencia aprobada', 'Requirements without approved evidence')}</strong><ul>{draft.unconfirmedRequirements.map((item) => <li key={item.text}>{item.text}</li>)}</ul></div>}
      <div className={styles.sentences}>
        {sentences.map((sentence) => <fieldset key={sentence.sentenceId} className={styles.sentence}>
          <legend>{sentence.kind === 'CANDIDATE_CLAIM' ? copy('Afirmación basada en tu perfil', 'Profile-based claim') : sentence.kind === 'OFFER_REFERENCE' ? copy('Referencia a la oferta', 'Offer reference') : copy('Saludo o cierre', 'Greeting or closing')}</legend>
          <label className="sr-only" htmlFor={`cover-letter-${sentence.sentenceId}`}>{copy('Texto de la frase', 'Sentence text')}</label>
          <textarea id={`cover-letter-${sentence.sentenceId}`} rows={3} maxLength={4000} value={sentence.text} disabled={busy} onChange={(event) => updateSentence(sentence.sentenceId, event.target.value)}/>
          {sentence.kind === 'CANDIDATE_CLAIM' && <label className={styles.confirm}><input type="checkbox" checked={confirmIds.includes(sentence.sentenceId)} disabled={busy} onChange={(event) => setConfirmIds((current) => event.target.checked ? [...current, sentence.sentenceId] : current.filter((id) => id !== sentence.sentenceId))}/>{copy('Confirmo que revisé esta afirmación aunque no esté respaldada por los hechos citados.', 'I confirm I reviewed this claim even if the cited facts do not support it.')}</label>}
          <Button type="button" variant="quiet" disabled={busy} onClick={() => setSentences((current) => current.filter((item) => item.sentenceId !== sentence.sentenceId))}>{copy('Quitar frase', 'Remove sentence')}</Button>
        </fieldset>)}
      </div>
      <div className={styles.actions}>
        <Button variant="secondary" disabled={busy || !sentences.length || !changed} onClick={() => void save()}>{busy ? copy('Guardando…', 'Saving…') : copy('Guardar nueva versión', 'Save new version')}</Button>
        <Button variant="quiet" disabled={busy} onClick={restore}>{copy('Restaurar borrador base', 'Restore base draft')}</Button>
      </div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {message && <p role="status" className={styles.success}>{message}</p>}
      {stored && <section aria-label={copy('Revisión de la carta', 'Cover letter review')} className={styles.preview}>
        <h4>{copy(`Revisión ${stored.revision.revision}`, `Revision ${stored.revision.revision}`)}</h4>
        <p>{stored.revision.approvedAt ? copy('Aprobada', 'Approved') : copy('Pendiente de aprobación', 'Awaiting approval')}</p>
        <iframe title={copy('Vista previa de la carta en PDF', 'Cover letter PDF preview')} src={`/api/v1/applications/${applicationId}/cover-letter/revisions/${stored.revision.id}/file?language=${language}&format=pdf`} />
        <a className="button button-quiet" href={`/api/v1/applications/${applicationId}/cover-letter/revisions/${stored.revision.id}/file?language=${language}&format=text`}>{copy('Descargar texto', 'Download text')}</a>
        {!stored.revision.approvedAt && <Button disabled={busy} onClick={() => void approve()}>{copy('Aprobar esta versión', 'Approve this version')}</Button>}
      </section>}
    </>}
  </Card>;
}
