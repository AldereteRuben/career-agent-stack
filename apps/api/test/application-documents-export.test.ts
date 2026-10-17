import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApplicationDocumentExportError, buildApplicationDocumentExport, EXPORT_ARTIFACT_LIMIT } from '../src/application-document-export.js';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const document = (id = randomUUID()) => ({ id, workspaceId: randomUUID(), applicationId: randomUUID(), kind: 'RESUME', language: 'en', createdAt: new Date(0) });
const revision = (documentId: string, revisionNumber: number, options: { approved?: boolean; pdf: Buffer; text: string }) => ({
  id: randomUUID(), workspaceId: randomUUID(), documentId, revision: revisionNumber, parentRevision: null,
  claims: [{ sentenceId: `sentence-${revisionNumber}`, sourceFactIds: ['fact-1'], origin: 'USER_EDITED' }], contentHash: digest(options.text),
  offerSnapshotId: randomUUID(), offerHash: 'a'.repeat(64), factsHash: 'b'.repeat(64), paperSize: 'A4',
  textStoragePath: `text-${randomUUID()}.txt`, textSha256: digest(options.text),
  pdfStoragePath: `pdf-${randomUUID()}.pdf`, pdfSha256: digest(options.pdf),
  confirmedUnsupportedIds: [], approvedAt: options.approved ? new Date(0) : null, approvedBy: options.approved ? 'user' : null, createdAt: new Date(0),
  text: options.text, pdf: options.pdf,
});

test('JSON export includes rows, proposal hashes and all revision text, but only approved and newest pending PDFs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-application-export-'));
  try {
    const first = document(); const second = document();
    const rows = [
      revision(first.id, 1, { approved: true, text: 'approved resume', pdf: Buffer.from('approved PDF') }),
      revision(first.id, 2, { text: 'older draft', pdf: Buffer.from('older PDF') }),
      revision(first.id, 3, { text: 'newest draft', pdf: Buffer.from('newest PDF') }),
      revision(second.id, 1, { text: 'pending before approval', pdf: Buffer.from('not included') }),
      revision(second.id, 2, { approved: true, text: 'latest approved', pdf: Buffer.from('second approved PDF') }),
    ];
    for (const row of rows) {
      await writeFile(join(root, row.textStoragePath), row.text);
      await writeFile(join(root, row.pdfStoragePath), row.pdf);
    }
    const proposalRows = [{ workspaceId: first.workspaceId, runId: randomUUID(), sentenceId: 'sentence-x', proposalSha256: 'c'.repeat(64) }];
    const result = await buildApplicationDocumentExport({ documents: [first, second], revisions: rows, proposals: proposalRows, filesRoot: root });
    assert.deepEqual(result.documents, [first, second]);
    assert.equal(result.revisions.length, rows.length);
    assert.deepEqual(result.revisions.map((row) => [row.revision, row.text, row.pdfIncluded]), [
      [1, 'approved resume', true], [2, 'older draft', false], [3, 'newest draft', true],
      [1, 'pending before approval', false], [2, 'latest approved', true],
    ]);
    assert.deepEqual(result.proposals, proposalRows, 'Proposal export contains only the stored hash row');
    assert.deepEqual(result.revisions[0]!.claims, rows[0]!.claims, 'Claims, citations and origins are preserved');
    assert.equal(result.revisions[0]!.contentHash, rows[0]!.contentHash);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.revisionId), [rows[0]!.id, rows[2]!.id, rows[4]!.id]);
    assert.equal(result.totalArtifactBytes, Buffer.byteLength('approved PDF') + Buffer.byteLength('newest PDF') + Buffer.byteLength('second approved PDF'));
    assert.equal(result.revisions[1]!.pdfSha256, rows[1]!.pdfSha256, 'Excluded history retains its digest');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('60 pending revision PDFs over the size cap still export only the newest PDF', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-application-export-history-'));
  try {
    const doc = document(); const rows = [] as ReturnType<typeof revision>[];
    const pdf = Buffer.alloc(510_000, 0x61);
    for (let index = 1; index <= 60; index += 1) {
      const row = revision(doc.id, index, { text: `revision ${index}`, pdf });
      rows.push(row);
      await writeFile(join(root, row.textStoragePath), row.text);
      await writeFile(join(root, row.pdfStoragePath), pdf);
    }
    assert.ok(rows.length * pdf.byteLength > EXPORT_ARTIFACT_LIMIT);
    const result = await buildApplicationDocumentExport({ documents: [doc], revisions: rows, proposals: [], filesRoot: root });
    assert.equal(result.revisions.length, 60);
    assert.equal(result.revisions.filter((row) => row.pdfIncluded).length, 1);
    assert.equal(result.revisions.at(-1)!.pdfIncluded, true);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.totalArtifactBytes, pdf.byteLength);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('included PDFs over 30 MB fail with 413 and do not return a partial export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-application-export-limit-'));
  try {
    const doc = document(); const bytes = Buffer.alloc(15_000_001, 0x62);
    const rows = [
      revision(doc.id, 1, { approved: true, text: 'approved one', pdf: bytes }),
      revision(doc.id, 2, { approved: true, text: 'approved two', pdf: bytes }),
    ];
    for (const row of rows) {
      await writeFile(join(root, row.textStoragePath), row.text);
      await writeFile(join(root, row.pdfStoragePath), bytes);
    }
    await assert.rejects(
      buildApplicationDocumentExport({ documents: [doc], revisions: rows, proposals: [], filesRoot: root }),
      (error: unknown) => error instanceof ApplicationDocumentExportError && error.statusCode === 413 && error.code === 'EXPORT_ARTIFACT_LIMIT',
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
