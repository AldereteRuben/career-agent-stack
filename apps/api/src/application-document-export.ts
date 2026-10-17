import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const EXPORT_ARTIFACT_LIMIT = 30_000_000;

export class ApplicationDocumentExportError extends Error {
  constructor(readonly statusCode: number, readonly code: string, readonly detail?: string) {
    super(code);
    this.name = 'ApplicationDocumentExportError';
  }
}

export type ApplicationDocumentExportInput = {
  documents: Array<Record<string, unknown> & { id: string }>;
  revisions: Array<Record<string, unknown> & {
    id: string; documentId: string; revision: number; approvedAt: Date | string | null;
    textStoragePath: string; textSha256: string; pdfStoragePath: string; pdfSha256: string;
  }>;
  proposals: Array<Record<string, unknown>>;
  filesRoot: string;
  artifactBytesAlreadyIncluded?: number;
};

export type ApplicationDocumentExport = {
  documents: ApplicationDocumentExportInput['documents'];
  revisions: Array<ApplicationDocumentExportInput['revisions'][number] & { text: string; pdfIncluded: boolean }>;
  proposals: ApplicationDocumentExportInput['proposals'];
  artifacts: Array<{ documentId: string; revisionId: string; sha256: string; contentBase64: string }>;
  totalArtifactBytes: number;
};

async function readVerified(root: string, storagePath: string, expectedHash: string, id: string, kind: 'TEXT'): Promise<string>;
async function readVerified(root: string, storagePath: string, expectedHash: string, id: string, kind: 'PDF'): Promise<Buffer>;
async function readVerified(root: string, storagePath: string, expectedHash: string, id: string, kind: 'TEXT' | 'PDF'): Promise<string | Buffer> {
  const filePath = resolve(root, storagePath);
  const rel = relative(root, filePath);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new ApplicationDocumentExportError(500, 'DOCUMENT_PATH_INVALID', id);
  }
  let content: Buffer;
  try { content = await readFile(filePath); }
  catch { throw new ApplicationDocumentExportError(409, 'DOCUMENT_FILE_UNAVAILABLE', id); }
  const digest = createHash('sha256').update(content).digest('hex');
  if (digest !== expectedHash) throw new ApplicationDocumentExportError(409, 'DOCUMENT_HASH_MISMATCH', id);
  if (kind === 'TEXT') return content.toString('utf8');
  return content;
}

/** Builds the application-document export without embedding every historical PDF. */
export async function buildApplicationDocumentExport(input: ApplicationDocumentExportInput): Promise<ApplicationDocumentExport> {
  const root = resolve(input.filesRoot);
  const revisionsByDocument = new Map<string, typeof input.revisions>();
  for (const revision of input.revisions) {
    const rows = revisionsByDocument.get(revision.documentId) ?? [];
    rows.push(revision);
    revisionsByDocument.set(revision.documentId, rows);
  }

  const includedRevisionIds = new Set<string>();
  for (const revisions of revisionsByDocument.values()) {
    for (const revision of revisions) if (revision.approvedAt !== null) includedRevisionIds.add(revision.id);
    const newest = revisions.reduce((latest, revision) => revision.revision > latest.revision ? revision : latest);
    if (newest.approvedAt === null) includedRevisionIds.add(newest.id);
  }

  let totalArtifactBytes = input.artifactBytesAlreadyIncluded ?? 0;
  const artifacts: ApplicationDocumentExport['artifacts'] = [];
  const exportedRevisions: ApplicationDocumentExport['revisions'] = [];
  for (const revision of input.revisions) {
    const text = await readVerified(root, revision.textStoragePath, revision.textSha256, revision.id, 'TEXT');
    const pdfIncluded = includedRevisionIds.has(revision.id);
    exportedRevisions.push({ ...revision, text, pdfIncluded });
    if (!pdfIncluded) continue;
    const content = await readVerified(root, revision.pdfStoragePath, revision.pdfSha256, revision.id, 'PDF') as Buffer;
    totalArtifactBytes += content.byteLength;
    if (totalArtifactBytes > EXPORT_ARTIFACT_LIMIT) {
      throw new ApplicationDocumentExportError(413, 'EXPORT_ARTIFACT_LIMIT', 'Export the PDF files separately, then create a new workspace export.');
    }
    artifacts.push({ documentId: revision.documentId, revisionId: revision.id, sha256: revision.pdfSha256, contentBase64: content.toString('base64') });
  }
  return { documents: input.documents, revisions: exportedRevisions, proposals: input.proposals, artifacts, totalArtifactBytes };
}
