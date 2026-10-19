import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (path) => readFile(join(root, path), 'utf8');
const [rootPackageText, apiPackageText, workflow, tasks] = await Promise.all([
  read('package.json'),
  read('apps/api/package.json'),
  read('.github/workflows/ci.yml'),
  read('openspec/changes/application-ready-candidacy/tasks.md'),
]);
const rootPackage = JSON.parse(rootPackageText);
const apiPackage = JSON.parse(apiPackageText);
const scripts = rootPackage.scripts;

test('every test script cited in the change tasks is declared and run by CI', () => {
  const namedScripts = new Set([...tasks.matchAll(/\bpnpm run (test:[a-z0-9-]+)/g)].map((match) => match[1]));
  for (const name of namedScripts) {
    assert.ok(scripts[name], `${name} is named in tasks.md but missing from package.json`);
    assert.match(workflow, new RegExp(`(?:run: pnpm run |suite: )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`), `${name} is not invoked by CI`);
  }
});

test('planned document test families are covered by scripts that CI runs', () => {
  const coverage = [
    { taskPath: 'packages/domain/test/application-documents*.test.ts', script: 'test:unit', input: '../../packages/domain/test/*.test.ts' },
    { taskPath: 'apps/api/test/application-documents-routes.test.ts', script: 'test:application-documents', input: 'test/application-documents*.test.ts' },
    { taskPath: 'apps/api/test/ai-application-documents.test.ts', script: 'test:ai', input: 'test/ai-*.test.ts' },
    { taskPath: 'scripts/test/application-documents-migration.test.mjs', script: 'test:integration', input: 'scripts/test/application-documents-migration.test.mjs' },
    { taskPath: 'scripts/test/ci-wiring.test.mjs', script: 'test:integration', input: 'scripts/test/ci-wiring.test.mjs' },
  ];
  for (const { taskPath, script, input } of coverage) {
    assert.ok(tasks.includes(taskPath), `${taskPath} is missing from tasks.md`);
    assert.ok(scripts[script]?.includes(input), `${script} does not cover ${taskPath}`);
    assert.match(workflow, new RegExp(`(?:run: pnpm run |suite: )${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`), `${script} is not invoked by CI`);
  }

  const e2ePath = 'apps/api/e2e/application-documents.ts';
  assert.ok(tasks.includes(e2ePath), `${e2ePath} is missing from tasks.md`);
  assert.ok(scripts['test:e2e'] && workflow.includes('suite: test:e2e'), 'the application-document browser scenario has no CI E2E runner');
  if (apiPackage.scripts.e2e && tasks.includes(e2ePath)) {
    assert.ok(apiPackage.scripts.e2e.includes('e2e/workflow.ts'), 'the E2E entry point changed; verify scenario discovery');
  }
});

test('the application documents migration proof is enabled in CI integration tests', () => {
  const integration = workflow.match(/run: pnpm run test:integration[\s\S]{0,700}/)?.[0];
  assert.ok(integration, 'test:integration is not run by CI');
  assert.match(integration, /CAREER_APPLICATION_DOCUMENTS_TEST_ADMIN_URL:/, 'migration proof would silently skip in CI');
});

test('company research database tests are enabled in CI', () => {
  const quality = workflow.split(/^ {2}platform-build:/m)[0];
  const step = quality.match(/- name: Verify company research notes with a disposable database[\s\S]{0,260}/)?.[0];
  assert.ok(step, 'company research persistence test is not run by CI');
  assert.match(step, /run: pnpm run test:company-research/, 'CI invokes the wrong company research test');
  assert.match(step, /CAREER_COMPANY_RESEARCH_TEST_ADMIN_URL:/, 'company research test would silently skip without a database admin URL');
});

test('cooperative API shutdown integration runs on Windows CI', () => {
  const root = workflow.split(/^ {2}platform-build:/m)[1] ?? '';
  assert.ok(scripts['test:cooperative-stop']?.includes('scripts/test/cooperative-stop.integration.test.mjs'), 'cooperative shutdown test script is missing');
  assert.match(root, /name: Verify cooperative API shutdown on Windows[\s\S]{0,100}run: pnpm run test:cooperative-stop/, 'real-process shutdown tests are not wired into platform CI');
});

test('document API tests run in the database job after Chromium and Poppler are installed', () => {
  const quality = workflow.split(/^ {2}platform-build:/m)[0];
  assert.match(quality, /services:\s+postgres:/, 'quality job has no disposable PostgreSQL service');
  const chromium = quality.indexOf('Install Chromium for synthetic browser tests');
  const poppler = quality.indexOf('Install PDF text inspection');
  const documents = quality.indexOf('run: pnpm run test:application-documents');
  assert.ok(chromium >= 0 && poppler >= 0 && documents >= 0, 'a required test setup step is missing');
  assert.ok(chromium < documents && poppler < documents, 'document tests must run after Chromium and Poppler installation');
  assert.match(quality.slice(documents, documents + 300), /CAREER_APPLICATION_DOCUMENTS_TEST_ADMIN_URL:/, 'document test step has no database admin URL');
  assert.match(quality.slice(documents, documents + 300), /CAREER_V090_PDF_TEST:\s*'true'/, 'real PDF tests are not explicitly enabled');
});

test('bootstrap reads existing environment files through the verified private-file handle', async () => {
  const bootstrap = await read('scripts/bootstrap.mjs');
  assert.match(bootstrap, /import\s*\{[^}]*readPrivateFile[^}]*\}\s*from '\.\/lib\/private-files\.mjs'/);
  assert.match(bootstrap, /readPrivateFile\(pendingEnvPath\)/);
  assert.match(bootstrap, /readPrivateFile\(envPath\)/);
  assert.doesNotMatch(bootstrap, /readFile\((?:pendingEnvPath|envPath),\s*['"]utf8['"]\)/);
});
