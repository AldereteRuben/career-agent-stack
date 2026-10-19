'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { applyProfileProposals, detectIdentity, hasResumeDates, parseResume, profileProposals, redactResumeContactDetails, resumeProposalFact, splitResumeSections, suggestTargetTitles, type IdentityProposal, type ResumeProposal, type StructuredEntry } from '@career/domain';
import { ProfileEntryForm, type EntryInput, type ProfileEntry } from '@/components/profile-entry-form';
import { Button, Card, Empty, Notice, Tag, TextareaField } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useLocale } from '@/lib/i18n';
import { copy, countryName, labelFor } from '@/lib/labels';
import { extractionError, initialSelection, issueLabel, pendingImports, previewItems, reconcileReviewSelection, reviewRows, reviewSelection, type ImportedFact, type PreviewItem } from '@/lib/resume-import';
import { extractResumePdfText, ResumePdfExtractionError, resumePdfLimits } from '@/lib/resume-pdf-text';
import { AiDraftAction } from '@/components/ai/draft-action';
import type { AiArtifact } from '@/components/ai/result-view';
import styles from './resume-import.module.css';

type Fact = ImportedFact & ProfileEntry;
type Profile = { revision: number; locale?: string; profile: Record<string, unknown>; facts: Fact[] };
type Preview = { importId: string; revision: number; profile: Record<string, unknown>; items: PreviewItem[]; skipped: string[]; truncated: boolean; pagesTruncated: boolean; sectionsFound: number; identity: IdentityProposal[]; titles: string[] };
type UndoSummary = { pending: number; confirmed: number; inactive: number };
const month = (value: string) => value ? `${value.slice(5)}/${value.slice(0, 4)}` : '';

/**
 * Resume import (ADR 018, tasks T5 and T11). The PDF or pasted text is read in this page and turned into proposals in
 * memory; the person chooses which to save, and only those entries reach the API, as unconfirmed suggestions. The text
 * itself is discarded as soon as it is read. The review below works from the stored suggestions of one import.
 */
export function ResumeImport() {
  const { locale } = useLocale(); const c = copy(locale);
  const params = useSearchParams(); const router = useRouter();
  const importId = params.get('importId');
  const [data, setData] = useState<Profile | null>(null); const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState<string | null>(null); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const [pasted, setPasted] = useState(''); const [reading, setReading] = useState(false); const reader = useRef<AbortController | null>(null);
  const [pendingText, setPendingText] = useState<{ text: string; pagesTruncated: boolean } | null>(null);
  const [aiText, setAiText] = useState<string | null>(null);
  const [aiContext, setAiContext] = useState<Omit<Preview, 'importId' | 'revision' | 'profile' | 'items'> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [identityChoice, setIdentityChoice] = useState<Set<string>>(new Set()); const [titleChoice, setTitleChoice] = useState<Set<string>>(new Set());
  const [reviewChoice, setReviewChoice] = useState<Set<string>>(new Set());
  const [confirmingBatch, setConfirmingBatch] = useState(false);
  const [undo, setUndo] = useState<UndoSummary | null>(null);
  const [editing, setEditing] = useState<(Fact & { revision: number }) | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    try { setData(await api<Profile>('/profile')); setLoadState('ready'); }
    catch (cause) { setLoadState((current) => current === 'ready' ? 'ready' : 'error'); setError(errorMessage(cause)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Proposals live only in this page's memory; leaving the page discards them, so warn before that happens.
  useEffect(() => {
    if (!preview && !pendingText && aiText === null) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [preview, pendingText, aiText]);
  useEffect(() => () => reader.current?.abort(), []);
  const stage = preview ? 'preview' : importId ? 'review' : 'choose';
  useEffect(() => { heading.current?.focus(); }, [stage]);

  const rows = useMemo(() => data && importId ? reviewRows(data.facts, importId) : [], [data, importId]);
  const rowKey = rows.map((row) => `${row.fact.id}:${row.fact.approvalStatus}`).join(',');
  // A profile revision may give unchanged facts new IDs; their content key keeps the person's previous tick choice.
  const seen = useRef<{ importId: string | null; rowKey: string; entries: ReturnType<typeof reconcileReviewSelection>['memory'] }>({ importId: null, rowKey: '', entries: new Map() });
  useEffect(() => {
    if (seen.current.importId !== importId) seen.current = { importId, rowKey, entries: new Map() };
    const rowsChanged = seen.current.rowKey !== rowKey;
    const next = reconcileReviewSelection(rows, reviewChoice, seen.current.entries);
    seen.current = { importId, rowKey, entries: next.memory };
    if (next.selected.size !== reviewChoice.size || [...next.selected].some((id) => !reviewChoice.has(id))) setReviewChoice(next.selected);
    if (rowsChanged) setConfirmingBatch(false);
  }, [rowKey, importId, reviewChoice]);

  /** Runs one mutation; resolves true only on success. */
  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key); setError(''); setMessage('');
    try { await action(); setMessage(success); await load(); return true; }
    catch (cause) { setError(errorMessage(cause)); if (cause instanceof ApiError && ['FACT_NOT_IN_CURRENT_REVISION', 'PROFILE_REVISION_CONFLICT', 'IMPORT_CHANGED'].includes(cause.code)) await load(); return false; }
    finally { setBusy(null); }
  };

  /** Builds the proposals from the text, then lets the text go: nothing keeps a reference to it after this returns. */
  const startPreview = (text: string, pagesTruncated: boolean) => {
    if (!data) return;
    const parsed = parseResume(text);
    const jobs: StructuredEntry[] = parsed.proposals.filter((proposal) => proposal.kind === 'experience' && hasResumeDates(proposal))
      .map((proposal) => ({ type: 'employment', title: proposal.title, organization: proposal.organization, startMonth: proposal.startMonth, ...(proposal.current ? {} : { endMonth: proposal.endMonth }), current: proposal.current, description: proposal.description, locale: proposal.locale }));
    const preferences = (data.profile.preferences ?? {}) as { targetTitles?: string[] };
    // Identity is read from the header only, so an address in a skipped section (a referee) is never proposed as yours.
    const proposals = profileProposals(data.profile, detectIdentity(splitResumeSections(text).header.join('\n')), suggestTargetTitles(jobs, preferences.targetTitles ?? []));
    const items = previewItems(parsed.proposals, data.facts);
    setPreview({ importId: crypto.randomUUID(), revision: data.revision, profile: data.profile, items, skipped: parsed.skipped, truncated: parsed.truncated, pagesTruncated, sectionsFound: parsed.sectionsFound, identity: proposals.identity, titles: proposals.targetTitles });
    setSelected(initialSelection(items)); setIdentityChoice(new Set()); setTitleChoice(new Set());
    setPasted(''); if (fileInput.current) fileInput.current.value = '';
  };
  const useAiPreview = (text: string, pagesTruncated: boolean) => {
    if (!data) return;
    const parsed = parseResume(text);
    const jobs: StructuredEntry[] = parsed.proposals.filter((proposal) => proposal.kind === 'experience' && hasResumeDates(proposal))
      .map((proposal) => ({ type: 'employment', title: proposal.title, organization: proposal.organization, startMonth: proposal.startMonth, ...(proposal.current ? {} : { endMonth: proposal.endMonth }), current: proposal.current, description: proposal.description, locale: proposal.locale }));
    const preferences = (data.profile.preferences ?? {}) as { targetTitles?: string[] };
    const proposals = profileProposals(data.profile, detectIdentity(splitResumeSections(text).header.join('\\n')), suggestTargetTitles(jobs, preferences.targetTitles ?? []));
    setAiContext({ skipped: parsed.skipped, truncated: parsed.truncated, pagesTruncated, sectionsFound: parsed.sectionsFound, identity: proposals.identity, titles: proposals.targetTitles });
    setPendingText(null); setPasted(''); if (fileInput.current) fileInput.current.value = '';
    setAiText(redactResumeContactDetails(text).trim());
  };
  const reviewAiImport = (artifact: AiArtifact) => {
    if (!data || artifact.output.operation !== 'RESUME_IMPORT' || !aiContext) return;
    const items: ResumeProposal[] = artifact.output.proposals.map((proposal) => ({
      key: proposal.key, kind: proposal.kind, locale, title: '', organization: '', startMonth: '', endMonth: '', current: false,
      dateText: '', description: proposal.statement, tags: [], excerpt: proposal.sourceQuote,
      issues: proposal.kind === 'experience' || proposal.kind === 'education' ? ['MISSING_DATES'] : [],
    }));
    const nextItems = previewItems(items, data.facts);
    setPreview({ importId: crypto.randomUUID(), revision: data.revision, profile: data.profile, items: nextItems, ...aiContext });
    setSelected(initialSelection(nextItems)); setIdentityChoice(new Set()); setTitleChoice(new Set()); setAiText(null); setAiContext(null);
  };
  const readFile = async (file: File) => {
    setError(''); setMessage(''); setReading(true);
    const controller = new AbortController(); reader.current = controller;
    try { const result = await extractResumePdfText(file, undefined, undefined, controller.signal); setPendingText({ text: result.text, pagesTruncated: result.truncated }); }
    catch (cause) { setError(extractionError(cause instanceof ResumePdfExtractionError ? cause.code : 'unknown', locale)); if (fileInput.current) fileInput.current.value = ''; }
    finally { setReading(false); reader.current = null; }
  };
  const readPasted = (event: FormEvent) => { event.preventDefault(); if (pasted.trim()) setPendingText({ text: pasted, pagesTruncated: false }); };
  const discardPreview = () => { if (window.confirm(c('¿Descartar estas propuestas? No se ha guardado nada.', 'Discard these proposals? Nothing has been saved.'))) { setPreview(null); setAiText(null); setAiContext(null); setPendingText(null); setMessage(c('Propuestas descartadas. No se guardó nada.', 'Proposals discarded. Nothing was saved.')); } };

  const savePreview = async () => {
    if (!preview || !data) return;
    const chosen = preview.items.filter((item) => selected.has(item.proposal.key) && item.statement);
    const identity = Object.fromEntries(preview.identity.filter((proposal) => identityChoice.has(proposal.field)).map((proposal) => [proposal.field, proposal.proposed]));
    const titles = preview.titles.filter((title) => titleChoice.has(title));
    if (!chosen.length && !Object.keys(identity).length && !titles.length) { setError(c('Elige al menos una propuesta para guardar.', 'Choose at least one proposal to save.')); return; }
    setBusy('save'); setError(''); setMessage('');
    let saved = false;
    try {
      // The import id is fixed for this preview, so retrying after a lost response returns the same import.
      if (chosen.length) { await api('/profile/facts/import', { method: 'POST', body: JSON.stringify({ importId: preview.importId, facts: chosen.map((item) => resumeProposalFact(item.proposal)) }) }); saved = true; }
      if (Object.keys(identity).length || titles.length) {
        // Applied to the profile the person compared against; if it changed since, the API refuses instead of overwriting.
        await api('/profile', { method: 'PUT', body: JSON.stringify({ expectedRevision: preview.revision, locale: data.locale, profile: applyProfileProposals(preview.profile, { identity, targetTitles: titles }) }) });
      }
      setPreview(null);
      setMessage(chosen.length ? c(`${chosen.length} ${chosen.length === 1 ? 'entrada guardada' : 'entradas guardadas'} por confirmar. Revísalas abajo; ninguna se usa hasta que la confirmes.`, `${chosen.length} ${chosen.length === 1 ? 'entry' : 'entries'} saved to confirm. Review them below; none is used until you confirm it.`) : c('Tus datos se han actualizado.', 'Your details have been updated.'));
      await load();
      if (chosen.length) router.replace(`/profile/import?importId=${preview.importId}`);
    } catch (cause) {
      setError(saved ? `${c('Las entradas se guardaron, pero no tus datos personales:', 'The entries were saved, but not your personal details:')} ${errorMessage(cause)}` : errorMessage(cause));
      if (saved) { setPreview(null); await load(); router.replace(`/profile/import?importId=${preview.importId}`); }
    } finally { setBusy(null); }
  };

  const toggle = (set: Set<string>, value: string, update: (next: Set<string>) => void) => { const next = new Set(set); if (next.has(value)) next.delete(value); else next.add(value); update(next); };
  const chosenIds = rows.filter((row) => reviewChoice.has(row.fact.id) && row.fact.approvalStatus === 'SUGGESTED').map((row) => row.fact.id);
  const approveSelected = () => void run('batch', () => api('/profile/facts/approve', { method: 'POST', body: JSON.stringify({ factIds: chosenIds }) }),
    c(`${chosenIds.length} ${chosenIds.length === 1 ? 'entrada confirmada' : 'entradas confirmadas'}. Ya se usan en tus CV y en la comparación con ofertas.`, `${chosenIds.length} ${chosenIds.length === 1 ? 'entry' : 'entries'} confirmed. They are now used in your resumes and job matching.`)).then((ok) => { if (ok) setConfirmingBatch(false); });
  const review = (id: string, action: 'approve' | 'reject') => void run(`fact:${id}`, () => api(`/profile/facts/${id}/${action}`, { method: 'POST' }), action === 'approve' ? c('Entrada confirmada.', 'Entry confirmed.') : c('Entrada descartada.', 'Entry discarded.'));
  const saveEdit = async (input: EntryInput) => {
    if (!editing) return false;
    const draft = editing;
    const ok = await run(`edit:${draft.id}`, () => api(`/profile/facts/${draft.id}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: draft.revision, fact: { ...input, source: 'USER_ENTERED', approvalStatus: 'SUGGESTED' } }) }), c('Corrección guardada. Sigue pendiente de confirmar.', 'Correction saved. It still needs your confirmation.'));
    if (ok) setEditing(null);
    return ok;
  };
  const openUndo = () => void (async () => {
    if (!importId) return;
    setBusy('undo'); setError('');
    try { setUndo(await api<UndoSummary>(`/profile/imports/${importId}`)); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(null); }
  })();
  const confirmUndo = () => { if (!importId || !undo) return; const counts = undo; void run('undo', () => api(`/profile/imports/${importId}/undo`, { method: 'POST', body: JSON.stringify({ expectedPending: counts.pending, expectedConfirmed: counts.confirmed }) }), c('Importación deshecha. Nada se ha borrado: lo confirmado queda archivado y puedes restaurarlo desde tu perfil.', 'Import undone. Nothing was deleted: confirmed entries are archived and can be restored from your profile.')).then(() => setUndo(null)); };

  const locked = busy !== null || loadState !== 'ready';
  const pending = data ? pendingImports(data.facts) : [];
  const identityLabel = (field: IdentityProposal['field']) => field === 'fullName' ? c('Nombre', 'Name') : field === 'email' ? c('Correo', 'Email') : c('País de trabajo', 'Work country');
  const identityValue = (proposal: IdentityProposal, value: string) => proposal.field === 'country' && value ? countryName(value, locale) : value;

  return <div className={styles.importFlow}>
    {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    {loadState === 'loading' && <Notice>{c('Cargando tu perfil…', 'Loading your profile…')}</Notice>}
    {loadState === 'error' && <Notice tone="warning" actions={<Button variant="quiet" onClick={() => { setError(''); setLoadState('loading'); void load(); }}>{c('Reintentar', 'Try again')}</Button>}>{c('No pudimos cargar tu perfil.', 'We could not load your profile.')}</Notice>}

    {stage === 'choose' && <Card className="form-card">
      <h2 ref={heading} tabIndex={-1}>{c('Elige tu CV', 'Choose your resume')}</h2>
      <p>{c('Leemos el PDF en este navegador. Puedes continuar con el análisis local, sin compartir el texto, o elegir Codex como ayuda opcional tras revisar el texto con los datos de contacto ocultos. Solo las entradas que elijas se guardan en tu perfil como pendientes de confirmar.', 'We read the PDF in this browser. You can continue with local analysis without sharing the text, or choose optional Codex help after reviewing the text with contact details redacted. Only entries you choose are saved to your profile as suggestions waiting for confirmation.')}</p>
      <div className={styles.fileField}>
        <label htmlFor="resume-file">{c('CV en PDF', 'Resume PDF')}</label>
        <input id="resume-file" ref={fileInput} type="file" accept="application/pdf,.pdf" disabled={locked || reading} aria-describedby="resume-file-hint" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); }}/>
        <small id="resume-file-hint">{c(`Hasta 5 MB. Se leen las primeras ${resumePdfLimits.maxPages} páginas. Los PDF escaneados (imágenes) no se pueden leer.`, `Up to 5 MB. The first ${resumePdfLimits.maxPages} pages are read. Scanned PDFs (images) cannot be read.`)}</small>
      </div>
      {reading && <Notice actions={<Button variant="quiet" onClick={() => reader.current?.abort()}>{c('Cancelar', 'Cancel')}</Button>}>{c('Leyendo el PDF…', 'Reading the PDF…')}</Notice>}
      <details className={styles.paste}><summary>{c('O pega el texto de tu CV', 'Or paste your resume text')}</summary>
        <form onSubmit={readPasted} className="form-stack">
          <TextareaField label={c('Texto del CV', 'Resume text')} value={pasted} onChange={(event) => setPasted(event.target.value)} rows={10} maxLength={resumePdfLimits.maxCharacters} disabled={locked || reading} hint={c('Hasta 50.000 caracteres. Usa títulos como «Experiencia», «Formación» o «Skills» para separar las secciones.', 'Up to 50,000 characters. Use headings such as “Experience”, “Education” or “Habilidades” to separate the sections.')}/>
          <div className="form-submit"><Button type="submit" disabled={locked || reading || !pasted.trim()}>{c('Proponer entradas', 'Propose entries')}</Button></div>
        </form>
      </details>
      {pendingText && <section className={styles.group} aria-labelledby="resume-import-mode">
        <h3 id="resume-import-mode">{c('¿Cómo quieres preparar las propuestas?', 'How would you like to prepare suggestions?')}</h3>
        <p>{c('La opción local no comparte el texto. Codex puede ayudar a organizar entradas difíciles; antes podrás ver el texto con los datos de contacto ocultos y autorizar un único envío.', 'The local option does not share the text. Codex can help organize difficult entries; first you can review the text with contact details hidden and allow one request.')}</p>
        <div className="form-submit"><Button type="button" disabled={locked} onClick={() => { const source = pendingText; if (source) { setPendingText(null); startPreview(source.text, source.pagesTruncated); } }}>{c('Continuar sin IA', 'Continue without AI')}</Button>
          <Button type="button" variant="secondary" disabled={locked} onClick={() => useAiPreview(pendingText.text, pendingText.pagesTruncated)}>{c('Preparar con Codex', 'Prepare with Codex')}</Button>
          <Button type="button" variant="quiet" disabled={locked} onClick={() => { setPendingText(null); setPasted(''); if (fileInput.current) fileInput.current.value = ''; }}>{c('Descartar texto', 'Discard text')}</Button></div>
      </section>}
      {aiText !== null && <AiDraftAction request={{ operation: 'RESUME_IMPORT', locale, resumeText: aiText }} label={c('Preparar propuestas del CV con Codex', 'Prepare resume suggestions with Codex')} onReview={reviewAiImport} initiallyOpen/>}
      {pending.length > 0 && <section aria-labelledby="pending-imports-heading" className={styles.pending}><h3 id="pending-imports-heading">{c('Importaciones por revisar', 'Imports to review')}</h3><ul>{pending.map((item, index) => <li key={item.importId}><Link href={`/profile/import?importId=${item.importId}`}>{c(`Importación ${index + 1}: ${item.pending} por confirmar`, `Import ${index + 1}: ${item.pending} to confirm`)}</Link></li>)}</ul></section>}
    </Card>}

    {stage === 'preview' && preview && <Card className="form-card" aria-busy={busy === 'save'}>
      <h2 ref={heading} tabIndex={-1}>{c('Elige qué guardar', 'Choose what to save')}</h2>
      <p>{c('Marca las propuestas que quieras guardar. Se guardarán como pendientes de confirmar: ninguna se usa en tus CV ni en la comparación con ofertas hasta que la confirmes.', 'Tick the proposals you want to save. They are saved waiting for confirmation: none is used in your resumes or job matching until you confirm it.')}</p>
      {preview.pagesTruncated && <Notice tone="warning">{c(`El PDF tiene más de ${resumePdfLimits.maxPages} páginas; solo se leyeron las primeras.`, `The PDF has more than ${resumePdfLimits.maxPages} pages; only the first ones were read.`)}</Notice>}
      {preview.truncated && <Notice tone="warning">{c('Se encontraron más de 100 entradas; se muestran las 100 primeras. Importa el resto pegando su texto después.', 'More than 100 entries were found; the first 100 are shown. Import the rest by pasting its text afterwards.')}</Notice>}
      {!preview.sectionsFound && <Notice tone="warning">{c('No encontramos secciones como «Experiencia» o «Formación». Pega el texto con esos títulos o añade las entradas a mano en tu perfil.', 'We found no sections such as “Experience” or “Education”. Paste the text with those headings or add entries by hand on your profile.')}</Notice>}
      {preview.skipped.length > 0 && <Notice role={null}>{c('No se importan estas secciones:', 'These sections are not imported:')} {preview.skipped.join(', ')}</Notice>}
      {(preview.identity.length > 0 || preview.titles.length > 0) && <fieldset className={styles.group}><legend>{c('Tus datos (opcional)', 'Your details (optional)')}</legend>
        <p className="muted-label">{c('Solo se cambian si los marcas. El teléfono y la dirección no se importan.', 'They only change if you tick them. Phone number and address are not imported.')}</p>
        {preview.identity.map((proposal) => <label key={proposal.field} className="checkbox-line"><input type="checkbox" checked={identityChoice.has(proposal.field)} onChange={() => toggle(identityChoice, proposal.field, setIdentityChoice)}/><span>{identityLabel(proposal.field)}: <strong>{identityValue(proposal, proposal.proposed)}</strong>{proposal.current && <small>{c('Ahora:', 'Now:')} {identityValue(proposal, proposal.current)}</small>}</span></label>)}
        {preview.titles.map((title) => <label key={title} className="checkbox-line"><input type="checkbox" checked={titleChoice.has(title)} onChange={() => toggle(titleChoice, title, setTitleChoice)}/><span>{c('Añadir a puestos que buscas:', 'Add to roles you are looking for:')} <strong>{title}</strong></span></label>)}
      </fieldset>}
      {preview.items.length > 0 && <fieldset className={styles.group}><legend>{c(`Entradas propuestas (${selected.size} de ${preview.items.length} marcadas)`, `Proposed entries (${selected.size} of ${preview.items.length} ticked)`)}</legend>
        <div className={styles.bulk}><Button type="button" variant="quiet" onClick={() => setSelected(new Set(preview.items.filter((item) => item.statement).map((item) => item.proposal.key)))}>{c('Marcar todas', 'Tick all')}</Button><Button type="button" variant="quiet" onClick={() => setSelected(new Set())}>{c('Desmarcar todas', 'Untick all')}</Button></div>
        <ul className={styles.list}>{preview.items.map(({ proposal, statement, duplicateOf }) => <li key={proposal.key} className={styles.item}>
          <label className={styles.itemLabel}><input type="checkbox" disabled={!statement} checked={selected.has(proposal.key)} onChange={() => toggle(selected, proposal.key, setSelected)}/>
            <span className={styles.itemBody}><span className="fact-meta"><span>{labelFor.factKind(proposal.kind, locale)}</span>{duplicateOf && <Tag tone="amber">{c('Ya está en tu perfil', 'Already in your profile')}</Tag>}{proposal.issues.map((issue) => <Tag key={issue} tone="blue">{issueLabel(issue, locale)}</Tag>)}</span>
              {(proposal.title || proposal.organization) && <strong>{[proposal.title, proposal.organization].filter(Boolean).join(' · ')}</strong>}
              {(proposal.startMonth || proposal.dateText) && <span className={styles.dates}>{hasResumeDates(proposal) ? `${month(proposal.startMonth)} – ${proposal.current ? c('Actualidad', 'Present') : month(proposal.endMonth)}` : proposal.dateText}</span>}
              {proposal.description && <span className={styles.description}>{proposal.description}</span>}
            </span></label>
          <details className={styles.excerpt}><summary>{c('Texto del CV', 'Resume text')}</summary><pre>{proposal.excerpt}</pre></details>
        </li>)}</ul>
      </fieldset>}
      <div className="form-submit"><Button disabled={locked} onClick={() => void savePreview()}>{busy === 'save' ? c('Guardando…', 'Saving…') : c(`Guardar ${selected.size} para revisar`, `Save ${selected.size} for review`)}</Button><Button variant="quiet" disabled={locked} onClick={discardPreview}>{c('Descartar y empezar de nuevo', 'Discard and start again')}</Button></div>
    </Card>}

    {stage === 'review' && importId && <Card className="form-card" aria-busy={busy !== null}>
      <h2 ref={heading} tabIndex={-1}>{c('Revisa lo importado', 'Review the import')}</h2>
      <p>{c('Comprueba cada entrada. Confirma las correctas, corrige las que lo necesiten y descarta el resto. Solo lo confirmado se usa en tus CV y en la comparación con ofertas.', 'Check each entry. Confirm the accurate ones, correct those that need it and discard the rest. Only confirmed entries are used in your resumes and job matching.')}</p>
      {loadState === 'ready' && !rows.length && <Empty title={c('No hay entradas en esta importación', 'This import has no entries')} detail={c('Puede que se deshiciera o que el enlace sea de otro perfil.', 'It may have been undone, or the link belongs to another profile.')} action={<Link className="button button-secondary" href="/profile/import">{c('Importar un CV', 'Import a resume')}</Link>}/>}
      {editing && <div className="fact-edit"><h3>{c('Corregir entrada', 'Correct entry')}</h3>
        {data?.revision !== editing.revision && <Notice tone="warning">{c('El perfil cambió mientras editabas. Vuelve a abrir la entrada antes de guardar.', 'Your profile changed while you were editing. Reopen the entry before saving.')}</Notice>}
        <ProfileEntryForm key={editing.id} initial={editing} busy={locked} blocked={data?.revision !== editing.revision} onSave={saveEdit} onCancel={() => setEditing(null)}/></div>}
      {rows.length > 0 && !editing && <>
        <div className={styles.bulk} role="group" aria-label={c('Confirmar en lote', 'Confirm in bulk')}>
          <Button type="button" variant="quiet" disabled={locked} onClick={() => setReviewChoice(reviewSelection(rows))}>{c('Marcar las pendientes', 'Tick pending entries')}</Button>
          <Button type="button" variant="quiet" disabled={locked} onClick={() => setReviewChoice(new Set())}>{c('Desmarcar todas', 'Untick all')}</Button>
          <Button type="button" disabled={locked || !chosenIds.length} onClick={() => setConfirmingBatch(true)}>{c(`Confirmar marcadas (${chosenIds.length})`, `Confirm ticked (${chosenIds.length})`)}</Button>
        </div>
        {confirmingBatch && <Notice tone="warning" role="alert" actions={<><Button disabled={locked} onClick={approveSelected}>{busy === 'batch' ? c('Confirmando…', 'Confirming…') : c(`Sí, confirmar ${chosenIds.length}`, `Yes, confirm ${chosenIds.length}`)}</Button><Button variant="quiet" disabled={locked} onClick={() => setConfirmingBatch(false)}>{c('Cancelar', 'Cancel')}</Button></>}><p>{c(`¿Confirmar ${chosenIds.length} ${chosenIds.length === 1 ? 'entrada' : 'entradas'}? Confirmas que son correctas; se usarán en tus CV y en la comparación con ofertas.`, `Confirm ${chosenIds.length} ${chosenIds.length === 1 ? 'entry' : 'entries'}? You confirm they are accurate; they will be used in your resumes and job matching.`)}</p>
          <ul>{rows.filter((row) => chosenIds.includes(row.fact.id)).map((row) => <li key={row.fact.id}>{labelFor.factKind(row.fact.kind, locale)}: {row.fact.statement.split('\n')[0]}</li>)}</ul></Notice>}
        <ul className={styles.list}>{rows.map(({ fact, duplicateOf, needsDates }) => {
          const label = `${labelFor.factKind(fact.kind, locale)}: ${fact.statement.split('\n')[0]}`;
          return <li key={fact.id} className={styles.item}>
            <div className={styles.itemLabel}>{fact.approvalStatus === 'SUGGESTED' ? <input type="checkbox" aria-label={c(`Marcar ${label}`, `Tick ${label}`)} checked={reviewChoice.has(fact.id)} disabled={locked} onChange={() => toggle(reviewChoice, fact.id, setReviewChoice)}/> : <span className="fact-marker" aria-hidden="true">{fact.approvalStatus === 'USER_APPROVED' ? '✓' : '·'}</span>}
              <div className={styles.itemBody}><span className="fact-meta"><span>{labelFor.factKind(fact.kind, locale)}</span><Tag tone={fact.approvalStatus === 'USER_APPROVED' ? 'green' : fact.approvalStatus === 'REJECTED' ? 'neutral' : 'amber'}>{fact.approvalStatus === 'REJECTED' ? c('Ya retirada', 'Already removed') : labelFor.factApproval(fact.approvalStatus, locale)}</Tag>{duplicateOf && fact.approvalStatus !== 'REJECTED' && <Tag tone="amber">{c('Posible duplicado', 'Possible duplicate')}</Tag>}</span>
                <span className={styles.description}>{fact.statement}</span>
                {duplicateOf && fact.approvalStatus !== 'REJECTED' && <small className="muted-label">{c('Repite una entrada que ya tienes:', 'Repeats an entry you already have:')} {duplicateOf.statement.split('\n')[0]}</small>}
                {needsDates && fact.approvalStatus === 'SUGGESTED' && <small className="muted-label">{c('Faltan el puesto, la empresa o las fechas en sus campos. Corrígela para completarlos.', 'The role, employer or dates are not in their fields yet. Correct it to complete them.')}</small>}
              </div></div>
            {fact.approvalStatus === 'SUGGESTED' && <div className="fact-actions" role="group" aria-label={label}>
              <Button variant="secondary" disabled={locked} onClick={() => review(fact.id, 'approve')}>{busy === `fact:${fact.id}` ? c('Guardando…', 'Saving…') : c('Confirmar', 'Confirm')}</Button>
              <Button variant="quiet" disabled={locked || !data} onClick={() => data && setEditing({ ...fact, revision: data.revision })}>{needsDates ? c('Completar', 'Complete') : c('Corregir', 'Correct')}</Button>
              <Button variant="quiet" disabled={locked} onClick={() => review(fact.id, 'reject')}>{c('Descartar', 'Discard')}</Button>
            </div>}
          </li>;
        })}</ul>
        <div className={styles.footer}>
          <Link className="button button-secondary" href="/jobs">{c('Ver ofertas y encaje', 'See jobs and match')}</Link>
          <Link className="button button-quiet" href="/profile#saved-experience-heading">{c('Volver a mi perfil', 'Back to my profile')}</Link>
          <Button variant="quiet" disabled={locked} onClick={openUndo}>{c('Deshacer toda la importación', 'Undo the whole import')}</Button>
        </div>
        {undo && <Notice tone="warning" role="alert" actions={<><Button variant="danger" disabled={locked} onClick={confirmUndo}>{busy === 'undo' ? c('Deshaciendo…', 'Undoing…') : c('Deshacer importación', 'Undo import')}</Button><Button variant="quiet" disabled={locked} onClick={() => setUndo(null)}>{c('Cancelar', 'Cancel')}</Button></>}>
          {c(`Se descartarán ${undo.pending} por confirmar y se archivarán ${undo.confirmed} ya confirmadas (dejarán de usarse en nuevos CV; los PDF anteriores se conservan). ${undo.inactive} ya estaban retiradas. No se borra nada.`, `${undo.pending} pending ${undo.pending === 1 ? 'entry' : 'entries'} will be discarded and ${undo.confirmed} confirmed ${undo.confirmed === 1 ? 'entry' : 'entries'} archived (no longer used in new resumes; earlier PDFs are kept). ${undo.inactive} were already removed. Nothing is deleted.`)}
        </Notice>}
      </>}
      {!editing && <p><Link href="/profile/import" onClick={() => router.replace('/profile/import')}>{c('Importar otro CV', 'Import another resume')}</Link></p>}
    </Card>}
  </div>;
}
