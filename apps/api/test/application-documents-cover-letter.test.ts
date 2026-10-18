import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { applications, applicationDocuments, applicationDocumentRevisions, jobSnapshots, profileFacts, profileVersions } from '@career/db';
import { registerApplicationCoverLetterRoutes } from '../src/application-cover-letter.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const applicationId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333';
const profileId = '77777777-7777-4777-8777-777777777777';

function fakeDatabase() {
  const rows = new Map<object, unknown[]>([
    [applications, [{ id: applicationId, workspaceId, jobId, company: 'Example', role: 'QA Engineer', location: 'Remote' }]],
    [jobSnapshots, [{ id: '44444444-4444-4444-8444-444444444444', workspaceId, jobId, title: 'QA Engineer', descriptionText: 'Required: Python.', fetchedAt: new Date('2026-10-18T10:00:00Z') }]],
    [profileVersions, [{ id: profileId, workspaceId, revision: 1 }]],
    [profileFacts, [
      { id: '55555555-5555-4555-8555-555555555555', workspaceId, profileVersionId: profileId, kind: 'skill_evidence', statement: 'I use Python for test automation.', tags: ['python'], approvalStatus: 'USER_APPROVED' },
      { id: '66666666-6666-4666-8666-666666666666', workspaceId, profileVersionId: profileId, kind: 'skill_evidence', statement: 'I have expert Kubernetes experience.', tags: ['kubernetes'], approvalStatus: 'SUGGESTED' },
    ]],
  ]);
  const database = {
    select() {
      let table: object;
      let limit: number | undefined;
      const query = {
        from(value: object) { table = value; return query; },
        where() { return query; },
        orderBy() { return query; },
        for() { return query; },
        limit(value: number) { limit = value; return query; },
        then(resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
          const result = rows.get(table!) ?? [];
          return Promise.resolve(limit === undefined ? result : result.slice(0, limit)).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return { database: database as never, rows };
}

test('cover-letter draft uses the saved offer and approved facts only, with localized output', async () => {
  const app = Fastify();
  registerApplicationCoverLetterRoutes(app, () => workspaceId, { database: fakeDatabase().database });
  const response = await app.inject({ method: 'GET', url: `/api/v1/applications/${applicationId}/cover-letter/draft?language=en` });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.applicationId, applicationId);
  assert.equal(body.language, 'en');
  assert.ok(body.sentences.some((sentence: { text: string }) => sentence.text.includes('Python')));
  assert.ok(!body.sentences.some((sentence: { text: string }) => sentence.text.includes('Kubernetes')));
  assert.equal(response.headers['cache-control'], 'no-store');
  await app.close();
});

test('cover-letter draft rejects applications without a saved offer', async () => {
  const app = Fastify();
  const noJobDatabase = {
    select() {
      const query = {
        from() { return query; },
        where() { return query; },
        limit() { return Promise.resolve([{ id: applicationId, workspaceId, jobId: null, company: 'Example', role: 'QA Engineer', location: null }]); },
      };
      return query;
    },
  } as never;
  registerApplicationCoverLetterRoutes(app, () => workspaceId, { database: noJobDatabase });
  const response = await app.inject({ method: 'GET', url: `/api/v1/applications/${applicationId}/cover-letter/draft` });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'APPLICATION_HAS_NO_OFFER');
  await app.close();
});

test('saving a cover-letter draft stores one pending PDF and matching text revision', async () => {
  const app = Fastify();
  const fixture = fakeDatabase();
  const database = {
    ...fixture.database,
    async transaction(work: (tx: unknown) => Promise<unknown>) {
      const tx = {
        execute: async () => undefined,
        select: fixture.database.select,
        insert(table: object) {
          let value: Record<string, unknown>;
          const insert = {
            values(next: Record<string, unknown>) { value = next; return insert; },
            onConflictDoNothing() { return insert; },
            async returning() {
              const stored = { ...value! };
              const rows = fixture.rows.get(table) ?? [];
              fixture.rows.set(table, [...rows, stored]);
              return [stored];
            },
            then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
              const stored = { ...value! };
              fixture.rows.set(table, [...(fixture.rows.get(table) ?? []), stored]);
              return Promise.resolve(stored).then(resolve, reject);
            },
          };
          return insert;
        },
      };
      return work(tx);
    },
  } as never;
  const root = await mkdtemp(join(tmpdir(), 'cover-letter-route-'));
  registerApplicationCoverLetterRoutes(app, () => workspaceId, {
    database,
    storageRoot: root,
    render: async ({ path }) => {
      const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1_100)]);
      await writeFile(path, pdf, { flag: 'wx', mode: 0o600 });
      return { absolutePath: path, sha256: createHash('sha256').update(pdf).digest('hex'), size: pdf.byteLength };
    },
  });
  try {
    const response = await app.inject({ method: 'POST', url: `/api/v1/applications/${applicationId}/cover-letter/revisions`, payload: { language: 'en' } });
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json();
    assert.equal(body.revision.approvedAt, null);
    assert.equal(body.revision.revision, 1);
    assert.ok(fixture.rows.get(applicationDocuments)?.length === 1);
    const [revision] = fixture.rows.get(applicationDocumentRevisions) as Array<{ textStoragePath: string; pdfStoragePath: string; textSha256: string; pdfSha256: string }>;
    assert.ok(revision);
    const text = await readFile(join(root, revision.textStoragePath), 'utf8');
    const pdf = await readFile(join(root, revision.pdfStoragePath));
    assert.equal(text, body.text);
    assert.equal(createHash('sha256').update(text).digest('hex'), revision.textSha256);
    assert.equal(createHash('sha256').update(pdf).digest('hex'), revision.pdfSha256);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
