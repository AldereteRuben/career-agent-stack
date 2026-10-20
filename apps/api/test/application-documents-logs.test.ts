import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { logRequestFailure } from '../src/request-error-logging.js';

test('document request errors log only stable codes and correctly scoped IDs', () => {
  const entries: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const app = { log: { error: (fields: Record<string, unknown>, message: string) => entries.push({ fields, message }) } } as unknown as FastifyInstance;
  const applicationId = '11111111-1111-4111-8111-111111111111';
  const documentId = '22222222-2222-4222-8222-222222222222';
  const revisionId = '33333333-3333-4333-8333-333333333333';
  const cases = [
    { route: '/api/v1/applications/:id/resume/revisions/:revisionId/approve', params: { id: applicationId, revisionId }, expected: { applicationId, documentId: undefined, revisionId } },
    { route: '/api/v1/applications/:id/cover-letter/revisions/:revisionId/file', params: { id: applicationId, revisionId }, expected: { applicationId, documentId: undefined, revisionId } },
    { route: '/api/v1/applications/:applicationId/documents/:documentId/document-reword/accept', params: { applicationId, documentId }, expected: { applicationId, documentId, revisionId: undefined } },
    { route: '/api/v1/documents/:id/file', params: { id: documentId }, expected: { applicationId: undefined, documentId, revisionId: undefined } },
  ];
  const error = Object.assign(new Error('SENTINEL_PRIVATE_ERROR_TEXT'), { code: '23505', detail: 'SENTINEL_DATABASE_DETAIL' });
  for (const item of cases) {
    logRequestFailure(app, error, { routeOptions: { url: item.route }, params: item.params } as unknown as FastifyRequest);
  }
  assert.equal(entries.length, cases.length);
  for (const [index, entry] of entries.entries()) {
    assert.deepEqual(entry.fields, { code: '23505', ...cases[index]!.expected });
    assert.equal(entry.message, 'Application document request failed');
    assert.ok(!JSON.stringify(entry).includes('SENTINEL'));
  }
});

test('unrecognized error codes are normalized and malformed IDs are omitted', () => {
  const entries: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const app = { log: { error: (fields: Record<string, unknown>, message: string) => entries.push({ fields, message }) } } as unknown as FastifyInstance;
  logRequestFailure(app, Object.assign(new Error('SENTINEL'), { code: 'SQL text with private content' }), {
    routeOptions: { url: '/api/v1/applications/:id/cover-letter' }, params: { id: 'not-a-uuid' },
  } as unknown as FastifyRequest);
  assert.deepEqual(entries, [{ fields: { code: 'INTERNAL_ERROR', applicationId: undefined, documentId: undefined, revisionId: undefined }, message: 'Application document request failed' }]);
  assert.ok(!JSON.stringify(entries).includes('SENTINEL'));
});
