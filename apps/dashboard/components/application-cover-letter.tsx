'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { Button, Card } from '@/components/ui';
import { labelFor } from '@/lib/labels';
import styles from './application-cover-letter.module.css';

type Sentence = { sentenceId: string; text: string; kind: 'OFFER_REFERENCE' | 'BOILERPLATE' | 'CANDIDATE_CLAIM'; origin: 'BUILDER' | 'CODEX' | 'USER_EDITED' | 'USER_UNSUPPORTED'; sourceFactIds: string[]; language?: 'es' | 'en' };
type Revision = { id: string; revision: number; claims: Sentence[]; contentHash: string; factsHash: string; offerHash: string; textSha256: string; pdfSha256: string; approvedAt: string | null; confirmedUnsupportedIds: string[]; currentness?: { status: 'CURRENT' | 'NEEDS_REVIEW'; reasons: string[] }; text?: string };
type Draft = { applicationId: string; language: 'es' | 'en'; sentences: Sentence[]; unconfirmedRequirements: Array<{ text: string }>; profileNotice: string | null };
type Saved = { applicationId: string; documentId: string; language: 'es' | 'en'; revisions: Revision[] };
type Stored = { documentId: string; revision: Revision; text: string };
type ProfileFacts = { facts: Array<{ id: string; statement: string; approvalStatus: string }> };

type DocumentKind = 'resume' | 'cover-letter';

function documentFileUrl(applicationId: string, kind: DocumentKind, revisionId: string, language: 'es' | 'en', format: 'pdf' | 'text') {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (!uuid.test(applicationId) || !uuid.test(revisionId)) return null;
  const url = new URL(`/api/v1/applications/${encodeURIComponent(applicationId)}/${kind}/revisions/${encodeURIComponent(revisionId)}/file`, 'https://career-stack.invalid');
  url.searchParams.set('language', language);
  url.searchParams.set('format', format);
  return `${url.pathname}${url.search}`;
}

export function ApplicationDocumentEditor({ applicationId, kind, hideNoOfferMessage = false }: { applicationId: string; kind: DocumentKind; hideNoOfferMessage?: boolean }) {
  const { locale } = useLocale();
  const [language, setLanguage] = useState<'es' | 'en'>(locale === 'es' ? 'es' : 'en');
  const copy = (es: string, en: string) => language === 'es' ? es : en;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [baseRevisionId, setBaseRevisionId] = useState<string | undefined>();
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [confirmIds, setConfirmIds] = useState<string[]>([]);
  const [unsupportedSentenceId, setUnsupportedSentenceId] = useState<string | null>(null);
  const [approveUnsupported, setApproveUnsupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [stored, setStored] = useState<Stored | null>(null);
  const [noOffer, setNoOffer] = useState(false);
  const [stale, setStale] = useState(false);
  const [facts, setFacts] = useState<ProfileFacts['facts']>([]);
  const basePath = `/applications/${applicationId}/${kind}`;
  const title = kind === 'resume' ? copy('CV adaptado a esta oferta', 'Resume tailored to this job') : copy('Carta de presentación', 'Cover letter');

  const load = useCallback(async () => {
    setLoading(true); setError(''); setMessage(''); setStored(null); setConfirmIds([]); setApproveUnsupported(false); setUnsupportedSentenceId(null);
    setNoOffer(false);
    setStale(false);
    try {
      const [nextDraft, history, profile] = await Promise.all([
        api<Draft>(`${basePath}/draft?language=${language}`),
        api<Saved>(basePath + `?language=${language}`).catch((reason: unknown) => {
          if (reason instanceof ApiError && reason.status === 404) return null;
          throw reason;
        }),
        api<ProfileFacts>('/profile'),
      ]);
      const latest = history?.revisions[0] ?? null;
      setDraft(nextDraft); setSaved(history);
      setFacts(profile.facts.filter((fact) => fact.approvalStatus === 'USER_APPROVED'));
      setBaseRevisionId(latest?.id);
      setSentences(latest?.claims ?? nextDraft.sentences);
      setStored(latest && history ? { documentId: history.documentId, revision: latest, text: latest.text ?? '' } : null);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'APPLICATION_HAS_NO_OFFER') setNoOffer(true);
      setError(errorMessage(reason));
    } finally { setLoading(false); }
  }, [basePath, language]);

  useEffect(() => { void load(); }, [load]);

  const changed = useMemo(() => {
    if (!sentences.length || !draft) return false;
    const baseline = saved?.revisions[0]?.claims;
    if (!baseline) return true;
    if (stale || saved?.revisions[0]?.currentness?.status === 'NEEDS_REVIEW') return true;
    return JSON.stringify(sentences) !== JSON.stringify(baseline);
  }, [draft, saved, sentences, stale]);

  const save = async () => {
    if (!draft || busy || !sentences.length) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(`/api/v1${basePath}/revisions`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language,
          paperSize: 'A4',
          parentRevisionId: baseRevisionId,
          sentences: sentences.map(({ sentenceId, text, sourceFactIds }) => ({ sentenceId, text, sourceFactIds })),
          confirmUnsupportedIds: confirmIds,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string; sentenceId?: string; issue?: { item?: unknown; sentenceId?: string } };
        if (typeof payload.issue?.item === 'string') {
          const refusedSentenceId = payload.sentenceId ?? payload.issue.sentenceId;
          setUnsupportedSentenceId(sentences.find((sentence) => sentence.sentenceId === refusedSentenceId)?.sentenceId ?? null);
          setError(copy(`No se guardó: la frase añade «${payload.issue.item}», que no aparece en la evidencia ni en la oferta. Corrige la frase o confirma expresamente que no está respaldada.`, `Not saved: the sentence adds “${payload.issue.item}”, which does not appear in the evidence or the job post. Edit the sentence or explicitly confirm it is unsupported.`));
          return;
        }
        throw new ApiError(errorMessage(new ApiError('', response.status, payload.error ?? 'UNKNOWN')), response.status, payload.error ?? 'UNKNOWN');
      }
      await response.json() as Stored;
      await load();
      setMessage(copy('Versión guardada. Revisa el PDF antes de aprobarla.', 'Version saved. Review the PDF before approving it.'));
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };

  if (noOffer && hideNoOfferMessage) return null;
  if (noOffer) return <Card className={`${styles.card} application-resume`}>
    <h3>{copy('Documentos para esta solicitud', 'Documents for this application')}</h3>
    <p>{labelFor.applicationDocumentMessage('APPLICATION_HAS_NO_OFFER', locale)}</p>
    <Link className="button button-quiet" href="/jobs">{copy('Ver ofertas guardadas', 'View saved jobs')}</Link>
  </Card>;

  const approve = async () => {
    if (!stored || busy || stored.revision.approvedAt) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`${basePath}/revisions/${stored.revision.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          language,
          expectedContentHash: stored.revision.contentHash,
          expectedFactsHash: stored.revision.factsHash,
          expectedOfferHash: stored.revision.offerHash,
          expectedTextSha256: stored.revision.textSha256,
          expectedPdfSha256: stored.revision.pdfSha256,
          confirmedUnsupportedIds: stored.revision.confirmedUnsupportedIds,
        }),
      });
      setMessage(copy('Versión aprobada. Ya puedes descargarla.', 'Version approved. You can download it now.'));
      await load();
    } catch (reason) { if (reason instanceof ApiError && reason.code === 'APPROVAL_STALE') setStale(true); setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };

  const updateSentence = (sentenceId: string, text: string) => {
    setUnsupportedSentenceId(null);
    setConfirmIds((current) => current.filter((id) => id !== sentenceId));
    setSentences((current) => current.map((sentence) => sentence.sentenceId === sentenceId ? { ...sentence, text, origin: 'USER_EDITED' } : sentence));
  };
  const updateCitations = (sentenceId: string, factId: string, checked: boolean) => {
    setSentences((current) => current.map((sentence) => sentence.sentenceId === sentenceId ? {
      ...sentence,
      origin: 'USER_EDITED',
      sourceFactIds: checked ? [...new Set([...sentence.sourceFactIds, factId])] : sentence.sourceFactIds.filter((id) => id !== factId),
    } : sentence));
  };
  const restore = () => { if (draft) { setSentences(draft.sentences); setConfirmIds([]); } };

  const pdfUrl = stored ? documentFileUrl(applicationId, kind, stored.revision.id, language, 'pdf') : null;
  const textUrl = stored ? documentFileUrl(applicationId, kind, stored.revision.id, language, 'text') : null;

  return <Card className={`${styles.card} application-resume`}>
    <div className={styles.heading}><h3>{title}</h3><label>{copy('Idioma del documento', 'Document language')} <select value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value as 'es' | 'en')}><option value="es">Español</option><option value="en">English</option></select></label></div>
    <p>{copy('Borrador local basado en la oferta guardada y tus hechos aprobados. Nada se envía a la empresa.', 'A local draft based on the saved offer and your approved facts. Nothing is sent to the employer.')}</p>
    {loading ? <p role="status">{copy('Preparando el borrador…', 'Preparing draft…')}</p> : error && !draft ? <p role="alert" className={styles.error}>{error} <Button variant="quiet" onClick={() => void load()}>{copy('Reintentar', 'Retry')}</Button></p> : null}
    {draft?.profileNotice && <p className={styles.notice} role="status">{draft.profileNotice}</p>}
    {draft && !loading && <>
      {draft.unconfirmedRequirements.length > 0 && <div className={styles.notice}><strong>{copy('Requisitos sin evidencia aprobada', 'Requirements without approved evidence')}</strong><ul>{draft.unconfirmedRequirements.map((item) => <li key={item.text}>{item.text}</li>)}</ul></div>}
      <div className={styles.sentences}>
        {sentences.map((sentence) => <fieldset key={sentence.sentenceId} className={styles.sentence}>
          <legend>{sentence.kind === 'CANDIDATE_CLAIM' ? copy('Afirmación basada en tu perfil', 'Profile-based claim') : sentence.kind === 'OFFER_REFERENCE' ? copy('Referencia a la oferta', 'Offer reference') : copy('Saludo o cierre', 'Greeting or closing')}</legend>
          <label className="sr-only" htmlFor={`${kind}-${sentence.sentenceId}`}>{copy('Texto de la frase', 'Sentence text')}</label>
          <textarea id={`${kind}-${sentence.sentenceId}`} rows={3} maxLength={4000} value={sentence.text} disabled={busy} onChange={(event) => updateSentence(sentence.sentenceId, event.target.value)}/>
          {sentence.kind === 'CANDIDATE_CLAIM' && <details><summary>{copy('Evidencia que respalda esta frase', 'Evidence supporting this sentence')}</summary><ul>{sentence.sourceFactIds.map((id) => <li key={id}>{facts.find((fact) => fact.id === id)?.statement ?? copy('La evidencia ya no está disponible en el perfil actual.', 'This evidence is no longer available in the current profile.')}</li>)}</ul><fieldset><legend>{copy('Vincular hechos aprobados', 'Link approved facts')}</legend>{facts.map((fact) => <label key={fact.id} className={styles.confirm}><input type="checkbox" checked={sentence.sourceFactIds.includes(fact.id)} disabled={busy} onChange={(event) => updateCitations(sentence.sentenceId, fact.id, event.target.checked)}/>{fact.statement}</label>)}</fieldset></details>}
          <span className="tag tag-blue">{sentence.origin === 'USER_EDITED' ? 'USER_EDITED' : sentence.origin === 'USER_UNSUPPORTED' ? 'USER_UNSUPPORTED' : sentence.origin}</span>
          {sentence.kind === 'CANDIDATE_CLAIM' && (sentence.sourceFactIds.length === 0 || unsupportedSentenceId === sentence.sentenceId) && <label className={styles.confirm}><input type="checkbox" checked={confirmIds.includes(sentence.sentenceId)} disabled={busy} onChange={(event) => setConfirmIds((current) => event.target.checked ? [...current, sentence.sentenceId] : current.filter((id) => id !== sentence.sentenceId))}/>{copy('Confirmo que revisé esta afirmación aunque no esté respaldada por hechos aprobados.', 'I confirm I reviewed this claim even though approved facts do not support it.')}</label>}
          <Button type="button" variant="quiet" disabled={busy} onClick={() => setSentences((current) => current.filter((item) => item.sentenceId !== sentence.sentenceId))}>{copy('Quitar frase', 'Remove sentence')}</Button>
        </fieldset>)}
      </div>
      <div className={styles.actions}>
        <Button variant="secondary" disabled={busy || !sentences.length || !changed} onClick={() => void save()}>{busy ? copy('Guardando…', 'Saving…') : copy('Guardar nueva versión', 'Save new version')}</Button>
        <Button variant="quiet" disabled={busy} onClick={restore}>{copy('Restaurar borrador base', 'Restore base draft')}</Button>
      </div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {message && <p role="status" className={styles.success}>{message}</p>}
      {stored && <section aria-label={copy(`Revisión de ${title}`, `${title} review`)} className={styles.preview}>
        <h4>{copy(`Revisión ${stored.revision.revision}`, `Revision ${stored.revision.revision}`)}</h4>
        <p>{stored.revision.approvedAt ? copy('Aprobada', 'Approved') : copy('Pendiente de aprobación', 'Awaiting approval')}</p>
        <p role="status">{stale || stored.revision.currentness?.status === 'NEEDS_REVIEW' ? copy('El contenido o sus fuentes cambiaron; crea una nueva versión para revisar los cambios.', 'The content or its sources changed; create a new revision to review the changes.') : stored.revision.currentness?.status === 'CURRENT' ? copy('Las fuentes y la oferta coinciden con esta versión.', 'The sources and job still match this revision.') : copy('La vigencia se volverá a comprobar al aprobar. Si un hash ya no coincide, la aprobación se rechazará.', 'Freshness will be checked again on approval. If any hash no longer matches, approval will be refused.')}</p>
        {(stale || stored.revision.currentness?.status === 'NEEDS_REVIEW') && <ul>{(stored.revision.currentness?.reasons ?? []).map((reason) => <li key={reason}>{labelFor.applicationDocumentCurrentnessReason(reason, locale)}</li>)}</ul>}
        <dl className={styles.hashes}>{[[copy('Contenido', 'Content'), stored.revision.contentHash], [copy('Perfil', 'Profile'), stored.revision.factsHash], [copy('Oferta', 'Job'), stored.revision.offerHash], [copy('Texto', 'Text'), stored.revision.textSha256], ['PDF', stored.revision.pdfSha256]].map(([label, hash]) => <div key={label}><dt>{label}</dt><dd><code>{hash}</code></dd></div>)}</dl>
        <p>{copy('Estos hashes muestran qué fuentes y archivos se comprobarán al aprobar. Si algo cambia, la aprobación se bloquea.', 'These hashes show which sources and files will be checked on approval. If anything changes, approval is blocked.')}</p>
        {pdfUrl && <iframe title={copy(`Vista previa de ${title} en PDF`, `${title} PDF preview`)} src={pdfUrl} />}
        {textUrl && <a className="button button-quiet" href={textUrl}>{copy('Descargar texto', 'Download text')}</a>}
        {!stored.revision.approvedAt && stored.revision.confirmedUnsupportedIds.length > 0 && <label className={styles.confirm}><input type="checkbox" checked={approveUnsupported} disabled={busy} onChange={(event) => setApproveUnsupported(event.target.checked)}/>{copy('Confirmo que revisé las afirmaciones marcadas como no respaldadas.', 'I confirm that I reviewed the claims marked as unsupported.')}</label>}
        {!stored.revision.approvedAt && <Button disabled={busy || confirmIds.length > 0 || stale || stored.revision.currentness?.status === 'NEEDS_REVIEW' || (stored.revision.confirmedUnsupportedIds.length > 0 && !approveUnsupported)} onClick={() => void approve()}>{copy('Aprobar esta versión', 'Approve this version')}</Button>}
      </section>}
    </>}
  </Card>;
}

export function ApplicationCoverLetter({ applicationId, hideNoOfferMessage }: { applicationId: string; hideNoOfferMessage?: boolean }) {
  return <ApplicationDocumentEditor applicationId={applicationId} kind="cover-letter" hideNoOfferMessage={hideNoOfferMessage}/>;
}

export function ApplicationResumeDocument({ applicationId }: { applicationId: string }) {
  return <ApplicationDocumentEditor applicationId={applicationId} kind="resume"/>;
}
