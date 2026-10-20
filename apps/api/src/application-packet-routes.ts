import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Zip, ZipPassThrough } from 'fflate';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { applicationDocumentCurrentness, latestApplicationDocumentOffer, type ApplicationDocumentLanguage, type ApplicationDocumentRevision } from '@career/domain';
import { db, applications, applicationDocumentRevisions, applicationDocuments, documentVersions, jobSnapshots, profileFacts, profileVersions } from '@career/db';
import { lockJobIdentity } from './job-identity.js';
import { lockKey, profileLockKey } from './workspace-data.js';

export const APPLICATION_PACKET_LIMIT = 30_000_000;
export const APPLICATION_PACKET_CONCURRENT_DOWNLOAD_LIMIT = 1;
const APPLICATION_PACKET_FILE_LIMIT = 20;
let activeApplicationPacketDownloads = 0;
const idParams = z.object({ id: z.string().uuid() });
const packetRequest = z.object({
  fileIds: z.array(z.string().regex(/^revision:[0-9a-f-]{36}$/i)).min(1).max(APPLICATION_PACKET_FILE_LIMIT),
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
  textStoragePath?: string;
  textSha256?: string;
  selectable: boolean;
  reason?: 'LEGACY_RESUME_NOT_CONVERTED' | 'APPLICATION_DOCUMENT_NEEDS_REVIEW' | 'APPLICATION_DOCUMENT_SUPERSEDED';
  newerPendingRevision: boolean;
};

export class ApplicationPacketError extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
    this.name = 'ApplicationPacketError';
  }
}

/** Keep memory use bounded while PDF contents and the resulting ZIP coexist in memory. */
export function tryAcquireApplicationPacketDownload(): (() => void) | null {
  if (activeApplicationPacketDownloads >= APPLICATION_PACKET_CONCURRENT_DOWNLOAD_LIMIT) return null;
  activeApplicationPacketDownloads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeApplicationPacketDownloads -= 1;
  };
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

async function packetCandidates(database: typeof db, workspaceId: string, applicationId: string): Promise<PacketCandidate[] | null> {
  const application = (await database.select({
    id: applications.id, company: applications.company, role: applications.role, location: applications.location, jobId: applications.jobId, documentId: applications.documentId,
  }).from(applications).where(and(eq(applications.id, applicationId), eq(applications.workspaceId, workspaceId))).limit(1))[0];
  if (!application) return null;

  const candidates: PacketCandidate[] = [];
  if (application.documentId) {
    const resume = (await database.select({
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
      selectable: false,
      reason: 'LEGACY_RESUME_NOT_CONVERTED',
      newerPendingRevision: false,
    });
  }

  const revisionRows = await database.select({
    documentId: applicationDocuments.id,
    kind: applicationDocuments.kind,
    language: applicationDocuments.language,
    revision: applicationDocumentRevisions,
  }).from(applicationDocuments)
    .innerJoin(applicationDocumentRevisions, and(
      eq(applicationDocumentRevisions.workspaceId, applicationDocuments.workspaceId),
      eq(applicationDocumentRevisions.documentId, applicationDocuments.id),
    ))
    .where(and(eq(applicationDocuments.workspaceId, workspaceId), eq(applicationDocuments.applicationId, applicationId)))
    .orderBy(desc(applicationDocumentRevisions.revision));

  const snapshot = application.jobId ? (await database.select().from(jobSnapshots).where(and(
    eq(jobSnapshots.workspaceId, workspaceId), eq(jobSnapshots.jobId, application.jobId),
  )).orderBy(desc(jobSnapshots.fetchedAt), desc(jobSnapshots.id)).limit(1))[0] : undefined;
  const profile = (await database.select().from(profileVersions).where(eq(profileVersions.workspaceId, workspaceId)).orderBy(desc(profileVersions.revision)).limit(1))[0];
  const facts = profile ? await database.select().from(profileFacts).where(and(
    eq(profileFacts.workspaceId, workspaceId), eq(profileFacts.profileVersionId, profile.id),
  )) : [];
  const offer = latestApplicationDocumentOffer({ workspaceId, company: application.company, role: application.role, location: application.location,
    snapshots: snapshot ? [{ id: snapshot.id, title: snapshot.title, descriptionText: snapshot.descriptionText, fetchedAt: snapshot.fetchedAt.toISOString() }] : [] });
  const factSnapshots = facts.map((fact) => ({ id: fact.id, workspaceId, approval: fact.approvalStatus, text: fact.statement, tags: fact.tags }));
  const byDocument = new Map<string, typeof revisionRows>();
  for (const row of revisionRows) byDocument.set(row.documentId, [...(byDocument.get(row.documentId) ?? []), row]);
  for (const rows of byDocument.values()) {
    const approved = rows.filter(({ revision }) => revision.approvedAt !== null);
    const newestApproved = approved[0];
    if (!newestApproved) continue;
    const revision = newestApproved.revision;
    const superseded = approved.some(({ revision: item }) => item.revision > revision.revision);
    const newerPendingRevision = rows.some(({ revision: item }) => item.approvedAt === null && item.revision > revision.revision);
    const currentness = application.jobId && snapshot ? await applicationDocumentCurrentness({
      revision: packetRowToRevision(revision, newestApproved.language as ApplicationDocumentLanguage), facts: factSnapshots, offer,
    }) : { status: 'NEEDS_REVIEW' as const };
    const selectable = !superseded && currentness.status === 'CURRENT';
    const kind = newestApproved.kind as PacketKind;
    candidates.push({
      id: `revision:${revision.id}`,
      fileName: packetFileName(application.company, application.role, kind, newestApproved.language, revision.revision),
      kind,
      language: newestApproved.language,
      revision: revision.revision,
      storagePath: revision.pdfStoragePath,
      sha256: revision.pdfSha256,
      textStoragePath: revision.textStoragePath,
      textSha256: revision.textSha256,
      selectable,
      ...(!selectable ? { reason: superseded ? 'APPLICATION_DOCUMENT_SUPERSEDED' as const : 'APPLICATION_DOCUMENT_NEEDS_REVIEW' as const } : {}),
      newerPendingRevision,
    });
  }
  return candidates.sort((left, right) => left.kind.localeCompare(right.kind) || left.language.localeCompare(right.language));
}

function packetRowToRevision(row: typeof applicationDocumentRevisions.$inferSelect, language: ApplicationDocumentLanguage): ApplicationDocumentRevision {
  return {
    id: row.id, workspaceId: row.workspaceId, documentId: row.documentId, revision: row.revision, parentRevision: row.parentRevision,
    language, claims: row.claims as ApplicationDocumentRevision['claims'], contentHash: row.contentHash, offerSnapshotId: row.offerSnapshotId,
    offerHash: row.offerHash, factsHash: row.factsHash, paperSize: row.paperSize as 'A4' | 'LETTER', textSha256: row.textSha256,
    pdfSha256: row.pdfSha256, confirmedUnsupportedIds: row.confirmedUnsupportedIds, approvedAt: row.approvedAt?.toISOString() ?? null, approvedBy: row.approvedBy,
  };
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

async function* zipChunks(files: Array<{ fileName: string; bytes: Buffer }>) {
  const output: Buffer[] = [];
  let complete = false;
  let failure: Error | null = null;
  let wake: (() => void) | undefined;
  const notify = () => { wake?.(); wake = undefined; };
  const archive = new Zip((error, chunk, final) => {
    if (error) failure = error;
    else if (chunk.byteLength) output.push(Buffer.from(chunk));
    if (final) complete = true;
    notify();
  });
  const nextOutput = async () => {
    while (!output.length && !complete && !failure) await new Promise<void>((resolveOutput) => { wake = resolveOutput; });
    if (failure) throw failure;
    return output.shift();
  };
  try {
    for (const file of files) {
      const entry = new ZipPassThrough(file.fileName);
      archive.add(entry);
      if (!file.bytes.byteLength) entry.push(new Uint8Array(0), true);
      for (let offset = 0; offset < file.bytes.byteLength; offset += 64 * 1024) {
        const end = Math.min(offset + 64 * 1024, file.bytes.byteLength);
        entry.push(file.bytes.subarray(offset, end), end === file.bytes.byteLength);
        const first = await nextOutput();
        if (first) yield first;
        while (output.length) yield output.shift()!;
      }
    }
    archive.end();
    while (!complete || output.length) {
      const chunk = await nextOutput();
      if (chunk) yield chunk;
    }
  } finally {
    archive.terminate();
  }
}

export async function buildApplicationMaterialsZip(
  filesRoot: string,
  files: Array<{ id: string; fileName: string; kind: PacketKind; language: string; revision: number; pdfStoragePath: string; pdfSha256: string; textStoragePath: string; textSha256: string }>,
) {
  const outputNames = files.flatMap(({ fileName }) => [fileName, fileName.replace(/\.pdf$/iu, '.txt')]);
  const names = [...outputNames, 'manifest.json'];
  if (new Set(names).size !== names.length) throw new ApplicationPacketError(409, 'MATERIAL_PACKET_FILENAME_CONFLICT');
  const verified: Array<{ fileName: string; bytes: Buffer }> = [];
  let totalBytes = 0;
  for (const file of files) {
    const pdf = await readVerifiedPdf(filesRoot, file.pdfStoragePath, file.pdfSha256, APPLICATION_PACKET_LIMIT - totalBytes);
    totalBytes += pdf.byteLength;
    verified.push({ fileName: file.fileName, bytes: pdf });
    const text = await readVerifiedPdf(filesRoot, file.textStoragePath, file.textSha256, APPLICATION_PACKET_LIMIT - totalBytes);
    totalBytes += text.byteLength;
    verified.push({ fileName: file.fileName.replace(/\.pdf$/iu, '.txt'), bytes: text });
  }
  const manifest = Buffer.from(JSON.stringify({
    version: 1,
    documents: files.map((file, index) => ({
      id: file.id, kind: file.kind, language: file.language, revision: file.revision,
      files: [
        { name: outputNames[index * 2], sha256: file.pdfSha256 },
        { name: outputNames[index * 2 + 1], sha256: file.textSha256 },
      ],
    })),
  }, null, 2), 'utf8');
  if (totalBytes + manifest.byteLength > APPLICATION_PACKET_LIMIT) throw new ApplicationPacketError(413, 'MATERIAL_PACKET_TOO_LARGE');
  verified.push({ fileName: 'manifest.json', bytes: manifest });
  return Readable.from(zipChunks(verified));
}

/**
 * Lists only the approved resume selected for this application and the current approved revisions of its
 * application-specific documents. The POST route repeats this query before reading any file.
 */
export function registerApplicationPacketRoutes(
  app: FastifyInstance,
  workspace: (request: FastifyRequest) => string,
  options: { filesRoot: string; database?: typeof db },
) {
  const database = options.database ?? db;
  app.get('/api/v1/applications/:id/materials', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'NOT_FOUND' });
    const candidates = await packetCandidates(database, workspace(request), params.data.id);
    if (!candidates) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { files: candidates.map((candidate) => ({
      id: candidate.id,
      fileName: candidate.fileName,
      kind: candidate.kind,
      language: candidate.language,
      revision: candidate.revision,
      selectable: candidate.selectable,
      reason: candidate.reason,
      newerPendingRevision: candidate.newerPendingRevision,
    })) };
  });

  app.post('/api/v1/applications/:id/materials.zip', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'NOT_FOUND' });
    const body = packetRequest.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const releaseDownload = tryAcquireApplicationPacketDownload();
    if (!releaseDownload) return reply.header('Retry-After', '2').code(503).send({ error: 'MATERIAL_PACKET_BUSY' });

    let responseOwnsDownload = false;
    try {
      const packet = await database.transaction(async (tx) => {
        const workspaceId = workspace(request);
        await lockJobIdentity(tx, workspaceId);
        await lockKey(tx, profileLockKey(workspaceId));
        const application = (await tx.select().from(applications).where(and(
          eq(applications.workspaceId, workspaceId), eq(applications.id, params.data.id),
        )).limit(1).for('update'))[0];
        if (!application) return { status: 404 as const };
        const documents = await tx.select().from(applicationDocuments).where(and(
          eq(applicationDocuments.workspaceId, workspaceId), eq(applicationDocuments.applicationId, application.id),
        )).orderBy(applicationDocuments.kind, applicationDocuments.language).for('update');
        for (const document of documents) await lockKey(tx, `application-document:${workspaceId}:${application.id}:${document.kind}:${document.language}`);
        const candidates = await packetCandidates(tx as unknown as typeof db, workspaceId, application.id);
        if (!candidates) return { status: 404 as const };
        const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        const selected = body.data.fileIds.map((id) => byId.get(id));
        if (selected.some((candidate) => !candidate?.selectable || !candidate.textStoragePath || !candidate.textSha256 || candidate.revision === null)) return { status: 409 as const };
        const archive = await buildApplicationMaterialsZip(options.filesRoot, (selected as PacketCandidate[]).map((candidate) => ({
          id: candidate.id.slice('revision:'.length), fileName: candidate.fileName, kind: candidate.kind, language: candidate.language,
          revision: candidate.revision!, pdfStoragePath: candidate.storagePath, pdfSha256: candidate.sha256,
          textStoragePath: candidate.textStoragePath!, textSha256: candidate.textSha256!,
        })));
        return { status: 200 as const, archive };
      });
      if (packet.status !== 200) return reply.code(packet.status).send({ error: packet.status === 404 ? 'NOT_FOUND' : 'MATERIAL_NOT_AVAILABLE' });
      reply
        .type('application/zip')
        .header('Content-Disposition', `attachment; filename="application-materials.zip"; filename*=UTF-8''${encodeURIComponent('application-materials.zip')}`);
      reply.raw.once('finish', releaseDownload);
      reply.raw.once('close', releaseDownload);
      const response = reply.send(packet.archive);
      responseOwnsDownload = true;
      return response;
    } catch (error) {
      if (error instanceof ApplicationPacketError) return reply.code(error.statusCode).send({ error: error.code });
      return reply.code(500).send({ error: 'MATERIAL_PACKET_FAILED' });
    } finally {
      if (!responseOwnsDownload) {
        reply.raw.off('finish', releaseDownload);
        reply.raw.off('close', releaseDownload);
        releaseDownload();
      }
    }
  });
}
