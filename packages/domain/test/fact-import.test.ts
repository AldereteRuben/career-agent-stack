import assert from 'node:assert/strict';
import { test } from 'node:test';
import { factImportSchema, maxImportedFacts } from '../src/contracts.js';
import { duplicateKey, findDuplicateFacts } from '../src/fact-import.js';

const importId = '0b6c1f9e-2d4a-4c7e-9f1a-3b5d7e9f1a2c';
const entry = (statement: string, kind = 'achievement') => ({ kind, statement });

test('a batch needs an import id and between 1 and 100 valid entries', () => {
  assert.equal(maxImportedFacts, 100);
  assert.equal(factImportSchema.safeParse({ importId, facts: [entry('Led a fictional migration.')] }).success, true);
  assert.equal(factImportSchema.safeParse({ importId, facts: [] }).success, false);
  assert.equal(factImportSchema.safeParse({ importId, facts: Array.from({ length: 101 }, (_, index) => entry(`Entry ${index}`)) }).success, false);
  assert.equal(factImportSchema.safeParse({ importId: 'not-a-uuid', facts: [entry('x')] }).success, false);
  assert.equal(factImportSchema.safeParse({ facts: [entry('x')] }).success, false);
  assert.equal(factImportSchema.safeParse({ importId, facts: [entry('x')], rawText: 'the whole resume' }).success, false, 'The raw resume text is never accepted');
});

test('each entry is validated like a fact entered by hand', () => {
  assert.equal(factImportSchema.safeParse({ importId, facts: [entry('x'.repeat(4001))] }).success, false, 'Entries keep the 4,000-character limit');
  assert.equal(factImportSchema.safeParse({ importId, facts: [{ kind: 'skill', statement: '', unknown: true }] }).success, false);
  const structured = factImportSchema.parse({ importId, facts: [{ kind: 'experience', statement: 'Built fictional tools.', employment: { role: 'Engineer', company: 'Fictional Co', startMonth: '2020-01', current: true, locale: 'en' } }] });
  assert.equal(structured.facts[0]!.details?.type, 'employment');
});

test('duplicates ignore case and spacing but not the kind', () => {
  assert.equal(duplicateKey(entry('  Led   a Migration ')), duplicateKey(entry('led a migration')));
  assert.notEqual(duplicateKey(entry('Python', 'skill')), duplicateKey(entry('Python', 'achievement')));
});

test('imported entries are flagged against the profile first, then against earlier entries of the same import', () => {
  const existing = [{ id: 'e1', kind: 'skill', statement: 'TypeScript' }];
  const imported = [
    { id: 'n1', kind: 'skill', statement: 'typescript' },
    { id: 'n2', kind: 'achievement', statement: 'Shipped a fictional app' },
    { id: 'n3', kind: 'achievement', statement: 'shipped a  fictional app' },
    { id: 'n4', kind: 'achievement', statement: 'Something new' },
  ];
  assert.deepEqual(findDuplicateFacts(imported, existing), ['e1', null, 'n2', null]);
  assert.deepEqual(findDuplicateFacts(imported, []), [null, null, 'n2', null]);
});

test('a batch approval names between 1 and 100 distinct fact ids', async () => {
  const { factBatchApprovalSchema } = await import('../src/contracts.js');
  const id = (n: number) => `0b6c1f9e-2d4a-4c7e-9f1a-${String(n).padStart(12, '0')}`;
  assert.equal(factBatchApprovalSchema.safeParse({ factIds: [id(1), id(2)] }).success, true);
  assert.equal(factBatchApprovalSchema.safeParse({ factIds: [] }).success, false);
  assert.equal(factBatchApprovalSchema.safeParse({ factIds: [id(1), id(1)] }).success, false, 'Duplicate ids are refused');
  assert.equal(factBatchApprovalSchema.safeParse({ factIds: Array.from({ length: 101 }, (_, n) => id(n)) }).success, false);
  assert.equal(factBatchApprovalSchema.safeParse({ factIds: ['not-a-uuid'] }).success, false);
  assert.equal(factBatchApprovalSchema.safeParse({ factIds: [id(1)], all: true }).success, false, 'No implicit "approve everything" option');
});

test('undoing an import repeats the counts the person confirmed', async () => {
  const { importUndoSchema } = await import('../src/contracts.js');
  assert.equal(importUndoSchema.safeParse({ expectedPending: 3, expectedConfirmed: 0 }).success, true);
  assert.equal(importUndoSchema.safeParse({ expectedPending: 3 }).success, false, 'Both counts are required');
  assert.equal(importUndoSchema.safeParse({ expectedPending: -1, expectedConfirmed: 0 }).success, false);
  assert.equal(importUndoSchema.safeParse({ expectedPending: 1.5, expectedConfirmed: 0 }).success, false);
  assert.equal(importUndoSchema.safeParse({ expectedPending: 0, expectedConfirmed: 0, force: true }).success, false, 'No way to skip the check');
});
