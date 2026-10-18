import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderApplicationDocumentText } from '../src/application-documents-text.js';

test('plain-text output preserves claim wording, accents and order', () => {
  const text = renderApplicationDocumentText([
    { sentenceId: 'greeting', text: 'Estimada selección:', kind: 'BOILERPLATE', origin: 'BUILDER', sourceFactIds: [] },
    { sentenceId: 'claim-1', text: 'Diseñé interfaces accesibles para más de 20.000 personas.', kind: 'CANDIDATE_CLAIM', origin: 'BUILDER', sourceFactIds: ['fact-1'] },
    { sentenceId: 'closing', text: 'Atentamente,', kind: 'BOILERPLATE', origin: 'BUILDER', sourceFactIds: [] },
  ]);

  assert.equal(text, 'Estimada selección:\nDiseñé interfaces accesibles para más de 20.000 personas.\nAtentamente,');
});
