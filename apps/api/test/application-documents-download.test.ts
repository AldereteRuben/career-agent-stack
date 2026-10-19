import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { applications, applicationDocuments, applicationDocumentRevisions } from '@career/db';
import { registerApplicationCoverLetterRoutes } from '../src/application-cover-letter.js';
import { registerApplicationResumeRoutes } from '../src/application-resume-routes.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const applicationId = '22222222-2222-4222-8222-222222222222';
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function fakeDatabase(rows: Map<object, unknown[]>) {
  return {
    select() {
      let table: object;
      let limit: number | undefined;
      const query = {
        from(value: object) { table = value; return query; },
        where() { return query; },
        limit(value: number) { limit = value; return query; },
        then(resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
          const result = rows.get(table!) ?? [];
          return Promise.resolve(limit === undefined ? result : result.slice(0, limit)).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

test('application document downloads verify bytes and identify application, language and revision', async () => {
  for (const kind of ['RESUME', 'COVER_LETTER'] as const) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const root = await mkdtemp(join(tmpdir(), 'application-document-download-'));
    const directory = join(root, workspaceId, 'application-documents', documentId);
    await mkdir(directory, { recursive: true });
    const text = Buffer.from('Perfil técnico — experiencia demostrable.', 'utf8');
    const pdf = Buffer.from('%PDF-1.7\nsynthetic preview\n', 'utf8');
    const textStoragePath = `${workspaceId}/application-documents/${documentId}/${revisionId}.txt`;
    const pdfStoragePath = `${workspaceId}/application-documents/${documentId}/${revisionId}.pdf`;
    await writeFile(join(directory, `${revisionId}.txt`), text);
    await writeFile(join(directory, `${revisionId}.pdf`), pdf);
    const rows = new Map<object, unknown[]>([
      [applications, [{ id: applicationId, workspaceId, company: 'Café & Co.', role: 'Senior QA / Engineer' }]],
      [applicationDocuments, [{ id: documentId, workspaceId, applicationId, kind, language: 'es' }]],
      [applicationDocumentRevisions, [{
        id: revisionId, workspaceId, documentId, revision: 3, textStoragePath, pdfStoragePath,
        textSha256: digest(text), pdfSha256: digest(pdf),
      }]],
    ]);
    const app = Fastify({ logger: false });
    const database = fakeDatabase(rows) as never;
    const register = kind === 'RESUME' ? registerApplicationResumeRoutes : registerApplicationCoverLetterRoutes;
    register(app, () => workspaceId, { database, storageRoot: root } as never);
    const path = kind === 'RESUME' ? 'resume' : 'cover-letter';
    const name = kind === 'RESUME' ? 'resume' : 'cover-letter';
    try {
      for (const format of ['text', 'pdf'] as const) {
        const expectedBytes = format === 'pdf' ? pdf : text;
        const response = await app.inject({ url: `/api/v1/applications/${applicationId}/${path}/revisions/${revisionId}/file?format=${format}&language=es` });
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.rawPayload, expectedBytes);
        assert.equal(response.headers['x-content-sha256'], digest(expectedBytes));
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.match(response.headers['content-disposition']!, new RegExp(`cafe-co-senior-qa-engineer-${name}-es-r3-${applicationId.slice(0, 8)}\\.${format === 'pdf' ? 'pdf' : 'txt'}`));
        assert.equal(response.headers['content-type'], format === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8');
      }

      await writeFile(join(directory, `${revisionId}.pdf`), Buffer.from('%PDF-1.7\ntampered\n'));
      const tampered = await app.inject({ url: `/api/v1/applications/${applicationId}/${path}/revisions/${revisionId}/file?format=pdf&language=es` });
      assert.equal(tampered.statusCode, 409);
      assert.equal(tampered.json().error, 'APPLICATION_DOCUMENT_HASH_MISMATCH');
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});
