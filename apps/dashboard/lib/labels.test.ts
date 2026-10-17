import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { jobReportBatchItemErrors, jobReportBatchStates, jobReportCheckKinds, jobReportCheckStatuses, jobReportReasons, jobReportRequirementLevels, jobReportUnknowns, jobReportVerdicts } from '../../../packages/domain/src/job-report';
import { applicationEvents, factKinds, humanizeKey, jobReportBatchStateLabels, jobReportCheckLabels, jobReportCheckStatusLabels, jobReportItemErrorLabels, jobReportLevelLabels, jobReportReasonLabels, jobReportUnknownLabels, jobReportVerdictLabels, selectableFactKinds } from './labels';

const dashboard = join(dirname(fileURLToPath(import.meta.url)), '..');

// The app writes sentence case ("Candidatura creada"). `text-transform: capitalize` would turn every word into a capital
// ("Candidatura Creada"), including text the user or a form wrote ("Are You Authorized To Work In Spain?").
test('no style capitalizes every word', () => {
  const css = readFileSync(join(dashboard, 'app/globals.css'), 'utf8');
  assert.equal(css.match(/text-transform:\s*capitalize/g)?.length ?? 0, 0, 'remove text-transform: capitalize; write the capital letter in the text instead');
});

test('application history and fact kind labels start with a capital letter in both languages', () => {
  for (const [name, map] of Object.entries({ applicationEvents, factKinds })) {
    for (const [code, text] of Object.entries(map)) {
      for (const language of ['es', 'en'] as const) {
        assert.match(text[language], /^\p{Lu}/u, `${name}.${code} (${language}) must start with a capital letter: "${text[language]}"`);
      }
    }
  }
});

test('certifications and languages can be added with labels in both languages', () => {
  for (const kind of ['certification', 'language'] as const) {
    assert.ok((selectableFactKinds as readonly string[]).includes(kind));
    assert.ok(factKinds[kind].es);
    assert.ok(factKinds[kind].en);
  }
});

test('a saved answer without question text is named with only its first letter capitalized', () => {
  assert.equal(humanizeKey('notice.period'), 'Notice period');
  assert.equal(humanizeKey('work.authorization_status'), 'Work authorization status');
});

test('every job report code has a label in both languages, and the conclusions never read as a number', () => {
  const pairs = [[jobReportVerdicts, jobReportVerdictLabels], [jobReportReasons, jobReportReasonLabels], [jobReportUnknowns, jobReportUnknownLabels], [jobReportCheckKinds, jobReportCheckLabels], [jobReportCheckStatuses, jobReportCheckStatusLabels], [jobReportRequirementLevels, jobReportLevelLabels], [jobReportBatchStates, jobReportBatchStateLabels], [jobReportBatchItemErrors, jobReportItemErrorLabels]] as const;
  for (const [codes, map] of pairs) {
    assert.deepEqual(Object.keys(map).sort(), [...codes].sort());
    for (const code of codes) for (const language of ['es', 'en'] as const) assert.match(map[code]![language], /^\p{Lu}/u, `${code} (${language})`);
  }
  for (const text of Object.values(jobReportVerdictLabels)) assert.doesNotMatch(`${text.es} ${text.en}`, /\d|%/);
});
