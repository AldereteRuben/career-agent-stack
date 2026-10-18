import { findDuplicateFacts, resumeProposalStatement, type ResumeIssue, type ResumeProposal } from '@career/domain';
import type { ResumePdfErrorCode } from './resume-pdf-text';
import { copy } from './labels';
import type { Locale } from './locale';

/**
 * Review logic for the resume import screen (ADR 018, task T5). The preview works on proposals held only in browser
 * memory; once saved, the review works from the stored suggestions, so it survives a reload without keeping a draft.
 */
export type ImportedFact = { id: string; kind: string; statement: string; tags: string[]; importId?: string | null; approvalStatus: string; details?: unknown };
export type PreviewItem = { proposal: ResumeProposal; statement: string | null; duplicateOf: string | null };
export type ReviewRow<T extends ImportedFact = ImportedFact> = { fact: T; duplicateOf: T | null; needsDates: boolean };

/** Proposals with the statement the profile would store and the existing entry each one repeats, if any. */
export function previewItems(proposals: readonly ResumeProposal[], existing: readonly ImportedFact[]): PreviewItem[] {
  const statements = proposals.map(resumeProposalStatement);
  const active = existing.filter((fact) => fact.approvalStatus !== 'REJECTED');
  const comparable = proposals.map((proposal, index) => ({ id: proposal.key, kind: proposal.kind, statement: statements[index] ?? '' }));
  const duplicates = findDuplicateFacts(comparable, active);
  return proposals.map((proposal, index) => ({ proposal, statement: statements[index] ?? null, duplicateOf: statements[index] ? duplicates[index] ?? null : null }));
}

/** Everything valid is selected for saving except repeats of an entry already in the profile or earlier in this import. */
export const initialSelection = (items: readonly PreviewItem[]) => new Set(items.filter((item) => item.statement && !item.duplicateOf).map((item) => item.proposal.key));

/** Imports that still have entries waiting for confirmation, newest first by the order the profile lists them. */
export function pendingImports(facts: readonly ImportedFact[]): Array<{ importId: string; pending: number }> {
  const counts = new Map<string, number>();
  for (const fact of facts) if (fact.importId && fact.approvalStatus === 'SUGGESTED') counts.set(fact.importId, (counts.get(fact.importId) ?? 0) + 1);
  return [...counts].map(([importId, pending]) => ({ importId, pending }));
}

/**
 * The entries of one import with the profile entry each repeats. Only active entries outside the import, and earlier
 * entries of the same import, count as originals, so the first copy is never flagged against a later one.
 */
export function reviewRows<T extends ImportedFact>(facts: readonly T[], importId: string): Array<ReviewRow<T>> {
  const own = facts.filter((fact) => fact.importId === importId);
  const others = facts.filter((fact) => fact.importId !== importId && fact.approvalStatus !== 'REJECTED');
  const duplicates = findDuplicateFacts(own.map((fact) => fact.approvalStatus === 'REJECTED' ? { ...fact, statement: `\u0000${fact.id}` } : fact), others);
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  return own.map((fact, index) => ({
    fact, duplicateOf: byId.get(duplicates[index] ?? '') ?? null,
    needsDates: (fact.kind === 'experience' || fact.kind === 'education') && !fact.details,
  }));
}

/** Suggestions ticked by default in the review: pending entries that do not repeat another entry. */
export const reviewSelection = (rows: readonly ReviewRow<ImportedFact>[]) => new Set(rows.filter((row) => row.fact.approvalStatus === 'SUGGESTED' && !row.duplicateOf).map((row) => row.fact.id));

/**
 * The ticks after a reload: entries seen before keep the person's choice; new entries (a correction is a new entry) get
 * the default. Only pending entries can stay ticked.
 */
export type ReviewSelectionMemory = Map<string, { key: string; selected: boolean }>;

export function reconcileReviewSelection(rows: readonly ReviewRow<ImportedFact>[], current: ReadonlySet<string>, previous: ReadonlyMap<string, { key: string; selected: boolean }>): { selected: Set<string>; memory: ReviewSelectionMemory } {
  const defaults = reviewSelection(rows);
  const previousByKey = new Map([...previous.values()].map((entry) => [entry.key, entry]));
  const occurrences = new Map<string, number>();
  const selected = new Set<string>();
  const memory: ReviewSelectionMemory = new Map();
  for (const row of rows) {
    const fact = row.fact;
    const baseKey = JSON.stringify([fact.kind, fact.importId ?? null, fact.statement, [...fact.tags].sort(), fact.details ?? null]);
    const occurrence = occurrences.get(baseKey) ?? 0;
    occurrences.set(baseKey, occurrence + 1);
    const key = `${baseKey}:${occurrence}`;
    const prior = previous.get(fact.id) ?? previousByKey.get(key);
    const isSelected = fact.approvalStatus === 'SUGGESTED' && (prior ? (previous.has(fact.id) ? current.has(fact.id) : prior.selected) : defaults.has(fact.id));
    if (isSelected) selected.add(fact.id);
    memory.set(fact.id, { key, selected: isSelected });
  }
  return { selected, memory };
}

export function extractionError(code: ResumePdfErrorCode | 'unknown', locale: Locale): string {
  const c = copy(locale);
  const messages: Record<ResumePdfErrorCode | 'unknown', string> = {
    'too-large': c('El PDF supera los 5 MB. Elige un archivo más pequeño o pega el texto.', 'The PDF is larger than 5 MB. Choose a smaller file or paste the text.'),
    'invalid-pdf': c('Este archivo no es un PDF válido. Elige otro archivo o pega el texto.', 'This file is not a valid PDF. Choose another file or paste the text.'),
    'password-protected': c('El PDF está protegido con contraseña. Quita la protección o pega el texto.', 'The PDF is password protected. Remove the password or paste the text.'),
    'pdfjs-unavailable': c('No se pudo abrir el lector de PDF. Recarga la página o pega el texto.', 'The PDF reader could not start. Reload the page or paste the text.'),
    'too-long': c('El PDF tiene más de 50.000 caracteres. Pega solo las secciones que quieras importar.', 'The PDF has more than 50,000 characters. Paste only the sections you want to import.'),
    timeout: c('Leer el PDF tardó más de 30 segundos. Prueba de nuevo o pega el texto.', 'Reading the PDF took more than 30 seconds. Try again or paste the text.'),
    cancelled: c('Lectura cancelada. No se guardó nada.', 'Reading cancelled. Nothing was saved.'),
    scanned: c('Este PDF parece escaneado: casi no tiene texto que leer. La app no reconoce imágenes; pega el texto si lo tienes.', 'This PDF looks scanned: it has almost no text to read. The app does not read images; paste the text if you have it.'),
    unknown: c('No se pudo leer el PDF. Pega el texto en su lugar.', 'The PDF could not be read. Paste the text instead.'),
  };
  return messages[code];
}

export function issueLabel(issue: ResumeIssue, locale: Locale): string {
  const c = copy(locale);
  return {
    MISSING_DATES: c('Faltan las fechas', 'Dates missing'),
    AMBIGUOUS_DATES: c('Fechas por completar', 'Dates to complete'),
    MISSING_ORGANIZATION: c('Revisa puesto y empresa', 'Check role and employer'),
    SPLIT: c('Dividido por su longitud', 'Split because of its length'),
  }[issue];
}
