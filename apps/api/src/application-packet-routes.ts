import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { zip, type Zippable } from 'fflate';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, applications, applicationDocumentRevisions, applicationDocuments, documentVersions } from '@career/db';

export const APPLICATION_PACKET_LIMIT = 30_000_000;
const APPLICATION_PACKET_FILE_LIMIT = 20;
const idParams = z.object({ id: z.string().uuid() });
const packetRequest = z.object({
  fileIds: z.array(z.string().regex(/^(resume|revision):[0-9a-f-]{36}$/i)).min(1).max(APPLICATION_PACKET_FILE_LIMIT),
}).strict().refine(({ fileIds }) => new Set(fileIds).size === fileIds.length, 'fileIds must be unique');

type PacketKind = 'RESUME' | 'COVER_LETTER';
type PacketCandidate = {
  id: string;
  fileName: string;
  kind: PacketKind;
  language: string;
  revision: number | null;
  storagePath: string;
  sha256: string;
};

export class ApplicationPacketError extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
    this.name = 'ApplicationPacketError';
  }
}

function safeNamePart(value: string) {
  // ZIP names must not carry path/control characters from user-entered company or role titles.
  const clean = value.normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48)
    .replace(/^[. -]+|[. -]+$/g, '');
  const safe = clean || 'solicitud';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe) ? `_${safe}` : safe;
}

export function packetFileName(company: string, role: string, kind: PacketKind, language: string, revision: number | null = null) {
  const label = kind === 'RESUME' ? (language === 'es' ? 'CV' : 'Resume') : (language === 'es' ? 'Carta' : 'Cover-Letter');
  const version = revision === null ? '' : `-${revision}`;
  return `${safeNamePart(company)}-${safeNamePart(role)}-${label}${version}-${safeNamePart(language)}.pdf`;
}

async function packetCandidates(workspaceId: string, applicationId: string): Promise<PacketCandidate[] | null> {
  const application = (await db.select({
    id: applications.id, company: applications.company, role: applications.role, documentId: applications.documentId,
  }).from(applications).where(and(eq(applications.id, applicationId), eq(applications.workspaceId, workspaceId))).limit(1))[0];
  if (!application) return null;

  const candidates: PacketCandidate[] = [];
  if (application.documentId) {
    const resume = (await db.select({
      id: documentVersions.id, language: documentVersions.language, storagePath: documentVersions.storagePath, sha256: documentVersions.sha256,
    }).from(documentVersions).where(and(
      eq(documentVersions.id, application.documentId),
      eq(documentVersions.workspaceId, workspaceId),
      eq(documentVersions.approvalStatus, 'USER_APPROVED'),
    )).limit(1))[0];
    if (resume) candidates.push({
      id: `resume:${resume.id}`,
      fileName: packetFileName(application.company, application.role, 'RESUME', resume.language ?? 'es'),
      kind: 'RESUME',
      language: resume.language ?? 'es',
      revision: null,
      storagePath: resume.storagePath,
      sha256: resume.sha256,
    });
  }

  const revisionRows = await db.select({
    documentId: applicationDocuments.id,
    kind: applicationDocuments.kind,
    language: applicationDocuments.language,
    revisionId: applicationDocumentRevisions.id,
    revision: applicationDocumentRevisions.revision,
    approvedAt: applicationDocumentRevisions.approvedAt,
    storagePath: applicationDocumentRevisions.pdfStoragePath,
    sha256: applicationDocumentRevisions.pdfSha256,
  }).from(applicationDocuments)
    .innerJoin(applicationDocumentRevisions, and(
      eq(applicationDocumentRevisions.workspaceId, applicationDocuments.workspaceId),
      eq(applicationDocumentRevisions.documentId, applicationDocuments.id),
    ))
    .where(and(eq(applicationDocuments.workspaceId, workspaceId), eq(applicationDocuments.applicationId, applicationId)))
    .orderBy(desc(applicationDocumentRevisions.revision));

  const latestByDocument = new Map<string, typeof revisionRows[number]>();
  for (const row of revisionRows) if (!latestByDocument.has(row.documentId)) latestByDocument.set(row.documentId, row);
  for (const row of latestByDocument.values()) {
    if (!row.approvedAt) continue;
    const kind = row.kind as PacketKind;
    candidates.push({
      id: `revision:${row.revisionId}`,
      fileName: packetFileName(application.company, application.role, kind, row.language, row.revision),
      kind,
      language: row.language,
      revision: row.revision,
      storagePath: row.storagePath,
      sha256: row.sha256,
    });
  }
  return candidates.sort((left, right) => left.kind.localeCompare(right.kind) || left.language.localeCompare(right.language));
}

async function readVerifiedPdf(root: string, storagePath: string, expectedHash: string, remainingBytes: number) {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, storagePath);
  const relativePath = relative(resolvedRoot, target);
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
    throw new ApplicationPacketError(409, 'MATERIAL_NOT_AVAILABLE');
  }
  let bytes: Buffer;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const [rootPath, filePath, fileInfo] = await Promise.all([realpath(resolvedRoot), realpath(target), lstat(target)]);
    const realRelativePath = relative(rootPath, filePath);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || realRelativePath.startsWith(`..${sep}`) || realRelativePath === '..' || isAbsolute(realRelativePath)) {
      throw new ApplicationPacketError(409, 'MATERIAL_NOT_AVAILABLE');
    }
    if (fileInfo.size > remainingBytes) throw new ApplicationPacketError(413, 'MATERIAL_PACKET_TOO_LARGE');
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || openedInfo.dev !== fileInfo.dev || openedInfo.ino !== fileInfo.ino || openedInfo.size > remainingBytes) {
      if (openedInfo.size > remainingBytes) throw new ApplicationPacketError(413, 'MATERIAL_PACKET_TOO_LARGE');
      throw new ApplicationPacketError(409, 'MATERIAL_NOT_AVAILABLE');
    }
    const chunks: Buffer[] = [];
    let totalRead = 0;
    while (totalRead <= remainingBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, remainingBytes - totalRead + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
      if (totalRead > remainingBytes) throw new ApplicationPacketError(413, 'MATERIAL_PACKET_TOO_LARGE');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    bytes = Buffer.concat(chunks, totalRead);
  } catch (error) {
    if (error instanceof ApplicationPacketError) throw error;
    throw new ApplicationPacketError(409, 'MATERIAL_NOT_AVAILABLE');
  } finally {
    await handle?.close().catch(() => undefined);
  }
  if (bytes.byteLength > remainingBytes) throw new ApplicationPacketError(413, 'MATERIAL_PACKET_TOO_LARGE');
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
    throw new ApplicationPacketError(409, 'MATERIAL_NOT_AVAILABLE');
  }
  return bytes;
}

async function createZip(files: Array<{ fileName: string; bytes: Buffer }>) {
  const entries: Zippable = Object.create(null) as Zippable;
  for (const file of files) entries[file.fileName] = file.bytes;
  return new Promise<Buffer>((resolveZip, rejectZip) => {
    zip(entries, { level: 0 }, (error, output) => {
      if (error || !output) return rejectZip(error ?? new Error('ZIP_CREATION_FAILED'));
      resolveZip(Buffer.from(output));
    });
  });
}

export async function buildApplicationMaterialsZip(
  filesRoot: string,
  files: Array<{ fileName: string; storagePath: string; sha256: string }>,
) {
  const names = files.map(({ fileName }) => fileName);
  if (new Set(names).size !== names.length) throw new ApplicationPacketError(409, 'MATERIAL_PACKET_FILENAME_CONFLICT');
  const verified: Array<{ fileName: string; bytes: Buffer }> = [];
  let totalBytes = 0;
  for (const file of files) {
    const bytes = await readVerifiedPdf(filesRoot, file.storagePath, file.sha256, APPLICATION_PACKET_LIMIT - totalBytes);
    totalBytes += bytes.byteLength;
    verified.push({ fileName: file.fileName, bytes });
  }
  return createZip(verified);
}

/**
 * Lists only the approved resume selected for this application and the current approved revisions of its
 * application-specific documents. The POST route repeats this query before reading any file.
 */
export function registerApplicationPacketRoutes(
  app: FastifyInstance,
  workspace: (request: FastifyRequest) => string,
  options: { filesRoot: string },
) {
  app.get('/api/v1/applications/:id/materials', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'NOT_FOUND' });
    const candidates = await packetCandidates(workspace(request), params.data.id);
    if (!candidates) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { files: candidates.map((candidate) => ({
      id: candidate.id,
      fileName: candidate.fileName,
      kind: candidate.kind,
      language: candidate.language,
      revision: candidate.revision,
    })) };
  });

  app.post('/api/v1/applications/:id/materials.zip', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'NOT_FOUND' });
    const body = packetRequest.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const candidates = await packetCandidates(workspace(request), params.data.id);
    if (!candidates) return reply.code(404).send({ error: 'NOT_FOUND' });
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const selected = body.data.fileIds.map((id) => byId.get(id));
    if (selected.some((candidate) => !candidate)) return reply.code(409).send({ error: 'MATERIAL_NOT_AVAILABLE' });

    try {
      const archive = await buildApplicationMaterialsZip(options.filesRoot, (selected as PacketCandidate[]).map(({ fileName, storagePath, sha256 }) => ({ fileName, storagePath, sha256 })));
      reply
        .type('application/zip')
        .header('Content-Disposition', `attachment; filename="application-materials.zip"; filename*=UTF-8''${encodeURIComponent('application-materials.zip')}`)
        .header('Content-Length', archive.byteLength);
      return reply.send(archive);
    } catch (error) {
      if (error instanceof ApplicationPacketError) return reply.code(error.statusCode).send({ error: error.code });
      return reply.code(500).send({ error: 'MATERIAL_PACKET_FAILED' });
    }
  });
}
