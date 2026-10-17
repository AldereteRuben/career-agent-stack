import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseResume } from '@career/domain';
import { extractionError, initialSelection, issueLabel, pendingImports, previewItems, reconcileReviewSelection, reviewRows, reviewSelection, type ImportedFact } from './resume-import';

// Fictional resume and entries only.
const resume = `Experience
Support Engineer — Fictional Systems Ltd
Jan 2022 – Present
- Resolved customer issues.

Skills
Python, SQL`;

const fact = (id: string, statement: string, extra: Partial<ImportedFact> = {}): ImportedFact => ({ id, kind: 'achievement', statement, tags: [], importId: null, approvalStatus: 'USER_APPROVED', ...extra });

test('the preview flags repeats of active profile entries and leaves them unselected', () => {
  const { proposals } = parseResume(resume);
  const fresh = previewItems(proposals, []);
  assert.deepEqual([...initialSelection(fresh)], proposals.map((proposal) => proposal.key), 'Every valid proposal starts selected');
  const existing = [fact('old', fresh[1]!.statement!.toUpperCase(), { kind: 'skill_evidence' }), fact('gone', fresh[0]!.statement!, { kind: 'experience', approvalStatus: 'REJECTED' })];
  const items = previewItems(proposals, existing);
  assert.deepEqual(items.map((item) => item.duplicateOf), [null, 'old'], 'Archived entries are not originals');
  assert.deepEqual([...initialSelection(items)], [proposals[0]!.key]);
});

test('pending imports are counted from stored suggestions only', () => {
  const facts = [fact('a', 'One', { importId: 'i1', approvalStatus: 'SUGGESTED' }), fact('b', 'Two', { importId: 'i1', approvalStatus: 'USER_APPROVED' }), fact('c', 'Three', { importId: 'i2', approvalStatus: 'REJECTED' }), fact('d', 'Four', { approvalStatus: 'SUGGESTED' })];
  assert.deepEqual(pendingImports(facts), [{ importId: 'i1', pending: 1 }]);
});

test('review rows flag duplicates and plain jobs that still need dates', () => {
  const facts = [
    fact('manual', 'Led a fictional migration.'),
    fact('dup', 'led a  fictional migration.', { importId: 'i1', approvalStatus: 'SUGGESTED' }),
    fact('job', 'Shop assistant at Fictional Store', { kind: 'experience', importId: 'i1', approvalStatus: 'SUGGESTED' }),
    fact('dated', 'Engineer · Fictional Co', { kind: 'experience', importId: 'i1', approvalStatus: 'SUGGESTED', details: { type: 'employment' } }),
    fact('again', 'Shop assistant at Fictional Store', { kind: 'experience', importId: 'i1', approvalStatus: 'SUGGESTED' }),
    fact('removed', 'Removed entry', { importId: 'i1', approvalStatus: 'REJECTED' }),
  ];
  const rows = reviewRows(facts, 'i1');
  assert.deepEqual(rows.map((row) => [row.fact.id, row.duplicateOf?.id ?? null, row.needsDates]), [
    ['dup', 'manual', false], ['job', null, true], ['dated', null, false], ['again', 'job', true], ['removed', null, false],
  ]);
  assert.deepEqual([...reviewSelection(rows)], ['job', 'dated'], 'Duplicates and inactive entries are not preselected');
});

test('every extraction error and issue has Spanish and English copy', () => {
  for (const code of ['too-large', 'invalid-pdf', 'password-protected', 'pdfjs-unavailable', 'too-long', 'timeout', 'cancelled', 'scanned', 'unknown'] as const) {
    assert.notEqual(extractionError(code, 'es'), extractionError(code, 'en'), code);
  }
  for (const issue of ['MISSING_DATES', 'AMBIGUOUS_DATES', 'MISSING_ORGANIZATION', 'SPLIT'] as const) assert.notEqual(issueLabel(issue, 'es'), issueLabel(issue, 'en'));
});

test('ticks survive a reload: an unticked entry stays unticked after another entry is discarded', () => {
  const rows = (ids: string[], rejected: string[] = []) => reviewRows(ids.map((id) => fact(id, `Entry ${id}`, { importId: 'i1', approvalStatus: rejected.includes(id) ? 'REJECTED' : 'SUGGESTED' })), 'i1');
  const first = rows(['x', 'y', 'z']);
  const initial = reconcileReviewSelection(first, new Set(), new Map());
  const afterUserChoice = reconcileReviewSelection(first, new Set(['y', 'z']), initial.memory);
  const afterDiscard = reconcileReviewSelection(rows(['x', 'y', 'z'], ['z']), afterUserChoice.selected, afterUserChoice.memory);
  assert.deepEqual([...afterDiscard.selected], ['y'], 'x stays unticked and the discarded z is no longer selectable');
  const afterNewEntry = reconcileReviewSelection(rows(['x', 'y', 'w']), afterDiscard.selected, afterDiscard.memory);
  assert.deepEqual([...afterNewEntry.selected], ['y', 'w'], 'A new entry, such as a correction, gets the default');
  assert.equal(first.length, 3);
});

test('selection survives new fact IDs when correcting a different imported entry', () => {
  const oldRows = reviewRows([
    fact('old-a', 'Entry A', { importId: 'i1', approvalStatus: 'SUGGESTED' }),
    fact('old-b', 'Entry B', { importId: 'i1', approvalStatus: 'SUGGESTED' }),
  ], 'i1');
  const initialized = reconcileReviewSelection(oldRows, new Set(['old-b']), new Map());
  const userChoice = reconcileReviewSelection(oldRows, new Set(['old-b']), initialized.memory);
  const revisedRows = reviewRows([
    fact('new-a', 'Entry A', { importId: 'i1', approvalStatus: 'SUGGESTED' }),
    fact('new-b', 'Corrected Entry B', { importId: 'i1', approvalStatus: 'SUGGESTED' }),
  ], 'i1');
  const revised = reconcileReviewSelection(revisedRows, userChoice.selected, userChoice.memory);
  assert.deepEqual([...revised.selected], ['new-b'], 'The unchanged unticked entry stays unticked; the corrected entry gets its default');
});
