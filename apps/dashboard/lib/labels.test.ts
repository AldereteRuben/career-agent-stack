import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { jobReportBatchItemErrors, jobReportBatchStates, jobReportCheckKinds, jobReportCheckStatuses, jobReportReasons, jobReportRequirementLevels, jobReportUnknowns, jobReportVerdicts } from '@career/domain';
import { applicationDocumentCurrentnessReasons, applicationDocumentMessages, applicationEvents, applicationPacketReasons, factKinds, humanizeKey, jobReportBatchStateLabels, jobReportCheckLabels, jobReportCheckStatusLabels, jobReportItemErrorLabels, jobReportLevelLabels, jobReportReasonLabels, jobReportUnknownLabels, jobReportVerdictLabels, selectableFactKinds } from './labels';

const dashboard = join(dirname(fileURLToPath(import.meta.url)), '..');

// The app writes sentence case ("Solicitud creada"). `text-transform: capitalize` would turn every word into a capital
// ("Solicitud Creada"), including text the user or a form wrote ("Are You Authorized To Work In Spain?").
test('no style capitalizes every word', () => {
  const css = readFileSync(join(dashboard, 'app/globals.css'), 'utf8');
  assert.equal(css.match(/text-transform:\s*capitalize/g)?.length ?? 0, 0, 'remove text-transform: capitalize; write the capital letter in the text instead');
});

const repository = join(dashboard, '../..');

function textFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (['node_modules', '.next', 'public', 'dist', 'e2e', 'test'].includes(name)) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return textFiles(path);
    return /\.(tsx?|mjs)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

// Spanish says "solicitud" (never "candidatura"), "solicitar" (never "aplicar" or "postular") and "por revisar" for a
// review state. "aplicar tus cambios" in Searches is about saving edits, not about jobs, so it stays.
test('Spanish text keeps one wording for applications and review states', () => {
  const always = [/candidatur/i, /\bpostul/i, /pendientes? de revisi[oó]n/i, /revisi[oó]n pendiente/i];
  // The scripts "apply" database migrations, which has nothing to do with job applications.
  const inApps = [...always, /\baplicar\b(?! tus cambios)/i, /\baplicando\b/i];
  const found: string[] = [];
  for (const [root, banned] of [['apps/dashboard', inApps], ['apps/api/src', inApps], ['scripts', always]] as const) {
    for (const file of textFiles(join(repository, root))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        for (const pattern of banned) if (pattern.test(line)) found.push(`${file.slice(repository.length + 1)}:${index + 1} ${pattern}`);
      });
    }
  }
  assert.deepEqual(found, [], 'use "solicitud", "solicitar" / "presentar la solicitud" and "por revisar" in Spanish text');
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

test('applications without a saved offer explain the next step in both languages', () => {
  const message = applicationDocumentMessages.APPLICATION_HAS_NO_OFFER;
  assert.match(message.es, /oferta guardada/u);
  assert.match(message.en, /saved job/u);
  assert.match(message.es, /no se creará ningún documento/u);
  assert.match(message.en, /no document will be created/u);
});

test('document freshness reasons are localized', () => {
  for (const reason of ['FACTS_CHANGED', 'OFFER_CHANGED', 'FACT_NOT_APPROVED', 'LANGUAGE_MISMATCH', 'INVALID_CLAIM']) {
    assert.ok(applicationDocumentCurrentnessReasons[reason]?.es);
    assert.ok(applicationDocumentCurrentnessReasons[reason]?.en);
  }
});

test('application packet refusal reasons are localized', () => {
  for (const reason of ['LEGACY_RESUME_NOT_CONVERTED', 'APPLICATION_DOCUMENT_NEEDS_REVIEW', 'APPLICATION_DOCUMENT_SUPERSEDED']) {
    assert.ok(applicationPacketReasons[reason]?.es);
    assert.ok(applicationPacketReasons[reason]?.en);
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
