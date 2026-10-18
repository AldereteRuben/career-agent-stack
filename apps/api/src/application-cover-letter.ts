import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { open, lstat, mkdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { applications, applicationDocuments, applicationDocumentRevisions, db, jobSnapshots, profileFacts, profileVersions } from '@career/db';
import { applicationDocumentHashes, approveApplicationDocumentRevision, buildApplicationCoverLetter, createApplicationDocumentRevision, latestApplicationDocumentOffer, saveApplicationDocumentSentenceEdit, type ApplicationDocumentLanguage, type ApplicationDocumentRevision, type ApplicationDocumentRevisionClaim } from '@career/domain';
import { renderApplicationCoverLetter, type ResumePaperSize } from './document-renderer.js';
import { lockKey, profileLockKey } from './workspace-data.js';
import { lockJobIdentity } from './job-identity.js';
import { z } from 'zod';

/** Exposes the evidence-based, no-AI cover-letter builder for one saved application. */
export function registerApplicationCoverLetterRoutes(
  app: FastifyInstance,
  workspace: (request: FastifyRequest) => string,
  options: { database?: typeof db; storageRoot?: string; render?: typeof renderApplicationCoverLetter } = {},
) {
  const database = options.database ?? db;
  app.get('/api/v1/applications/:id/cover-letter/draft', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    const query = z.object({ language: z.enum(['es', 'en']).default('es') }).strict().safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'INVALID_INPUT' });

    const workspaceId = workspace(request);
    const application = (await database.select().from(applications)
      .where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, params.data.id))).limit(1))[0];
    if (!application) return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
    if (!application.jobId) return reply.code(409).send({ error: 'APPLICATION_HAS_NO_OFFER' });

    const snapshot = (await database.select().from(jobSnapshots)
      .where(and(eq(jobSnapshots.workspaceId, workspaceId), eq(jobSnapshots.jobId, application.jobId)))
      .orderBy(desc(jobSnapshots.fetchedAt), desc(jobSnapshots.id)).limit(1))[0];
    if (!snapshot) return reply.code(409).send({ error: 'APPLICATION_HAS_NO_OFFER' });

    const profile = (await database.select().from(profileVersions).where(eq(profileVersions.workspaceId, workspaceId)).orderBy(desc(profileVersions.revision)).limit(1))[0];
    const facts = profile ? await database.select().from(profileFacts)
      .where(and(eq(profileFacts.workspaceId, workspaceId), eq(profileFacts.profileVersionId, profile.id), eq(profileFacts.approvalStatus, 'USER_APPROVED'))) : [];
    const language: ApplicationDocumentLanguage = query.data.language;
    const draft = buildApplicationCoverLetter({
      language,
      offer: {
        workspaceId,
        company: application.company,
        role: application.role,
        location: application.location,
        snapshot: { id: snapshot.id, title: snapshot.title, descriptionText: snapshot.descriptionText },
      },
      facts: facts.map((fact) => ({
        id: fact.id,
        workspaceId: fact.workspaceId,
        kind: fact.kind,
        text: fact.statement,
        tags: fact.tags,
        approval: fact.approvalStatus,
      })),
    });
    return reply.code(200).send({ applicationId: application.id, ...draft });
  });

  app.post('/api/v1/applications/:id/cover-letter/revisions', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    const body = z.object({
      language: z.enum(['es', 'en']),
      paperSize: z.enum(['A4', 'LETTER']).default('A4'),
      parentRevisionId: z.uuid().optional(),
      sentences: z.array(z.object({ sentenceId: z.string().min(1).max(80), text: z.string().trim().min(1).max(4000), sourceFactIds: z.array(z.uuid()).max(50) }).strict()).max(50).optional(),
      confirmUnsupportedIds: z.array(z.string().min(1).max(80)).max(50).default([]),
    }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    if (!options.storageRoot) return reply.code(503).send({ error: 'DOCUMENT_STORAGE_UNAVAILABLE' });

    const workspaceId = workspace(request);
    const application = (await database.select().from(applications)
      .where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, params.data.id))).limit(1))[0];
    if (!application) return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
    if (!application.jobId) return reply.code(409).send({ error: 'APPLICATION_HAS_NO_OFFER' });
    const snapshot = (await database.select().from(jobSnapshots)
      .where(and(eq(jobSnapshots.workspaceId, workspaceId), eq(jobSnapshots.jobId, application.jobId)))
      .orderBy(desc(jobSnapshots.fetchedAt), desc(jobSnapshots.id)).limit(1))[0];
    if (!snapshot) return reply.code(409).send({ error: 'APPLICATION_HAS_NO_OFFER' });
    const profile = (await database.select().from(profileVersions).where(eq(profileVersions.workspaceId, workspaceId)).orderBy(desc(profileVersions.revision)).limit(1))[0];
    const factRows = profile ? await database.select().from(profileFacts)
      .where(and(eq(profileFacts.workspaceId, workspaceId), eq(profileFacts.profileVersionId, profile.id), eq(profileFacts.approvalStatus, 'USER_APPROVED'))) : [];
    const facts = factRows.map((fact) => ({ id: fact.id, workspaceId: fact.workspaceId, approval: fact.approvalStatus, text: fact.statement, tags: fact.tags }));
    const offer = {
      workspaceId,
      company: application.company,
      role: application.role,
      location: application.location,
      snapshot: { id: snapshot.id, title: snapshot.title, descriptionText: snapshot.descriptionText },
    };
    const language: ApplicationDocumentLanguage = body.data.language;
    const built = buildApplicationCoverLetter({ language, offer, facts: facts.map((fact) => ({ ...fact, kind: factRows.find((row) => row.id === fact.id)?.kind ?? '' })) });
    let previous: (typeof applicationDocumentRevisions.$inferSelect) | undefined;
    let document = (await database.select().from(applicationDocuments).where(and(
      eq(applicationDocuments.workspaceId, workspaceId), eq(applicationDocuments.applicationId, application.id),
      eq(applicationDocuments.kind, 'COVER_LETTER'), eq(applicationDocuments.language, language),
    )).limit(1))[0];
    if (document) {
      const rows = await database.select().from(applicationDocumentRevisions).where(and(eq(applicationDocumentRevisions.workspaceId, workspaceId), eq(applicationDocumentRevisions.documentId, document.id))).orderBy(desc(applicationDocumentRevisions.revision)).limit(1);
      previous = rows[0];
    }
    if (body.data.parentRevisionId && previous?.id !== body.data.parentRevisionId) return reply.code(409).send({ error: 'APPLICATION_DOCUMENT_REVISION_CHANGED' });

    const sourceClaims = previous
      ? previous.claims as unknown as ApplicationDocumentRevisionClaim[]
      : built.sentences.map((sentence) => ({ ...sentence, language }));
    const submitted = body.data.sentences;
    const sentences: ApplicationDocumentRevisionClaim[] = [];
    if (submitted) {
      const sourceById = new Map(sourceClaims.map((sentence) => [sentence.sentenceId, sentence]));
      if (new Set(submitted.map((sentence) => sentence.sentenceId)).size !== submitted.length
        || submitted.some((sentence) => !sourceById.has(sentence.sentenceId))) return reply.code(400).send({ error: 'INVALID_SENTENCE_SELECTION' });
      for (const item of submitted) {
        const original = sourceById.get(item.sentenceId)!;
        const result = saveApplicationDocumentSentenceEdit({
          original,
          text: item.text,
          sourceFactIds: item.sourceFactIds,
          confirmUnsupported: body.data.confirmUnsupportedIds.includes(item.sentenceId),
          workspaceId,
          facts: facts.map((fact) => ({ ...fact, kind: factRows.find((row) => row.id === fact.id)?.kind ?? '' })),
          offer,
        });
        if (!result.ok) return reply.code(409).send({ error: 'APPLICATION_DOCUMENT_CLAIM_REJECTED', issue: result.issue });
        sentences.push({ ...result.sentence, language });
      }
    } else {
      sentences.push(...sourceClaims);
    }
    const unsupportedIds = sentences.filter((sentence) => sentence.origin === 'USER_UNSUPPORTED').map((sentence) => sentence.sentenceId);
    if (unsupportedIds.some((id) => !body.data.confirmUnsupportedIds.includes(id))) return reply.code(409).send({ error: 'UNSUPPORTED_CLAIMS_REQUIRE_CONFIRMATION', sentenceIds: unsupportedIds });

    const root = resolve(options.storageRoot);
    const documentId = document?.id ?? randomUUID();
    const revisionId = randomUUID();
    const relativeDirectory = `${workspaceId}/application-documents/${documentId}`;
    const textStoragePath = `${relativeDirectory}/${revisionId}.txt`;
    const pdfStoragePath = `${relativeDirectory}/${revisionId}.pdf`;
    const textPath = resolve(root, textStoragePath);
    const pdfPath = resolve(root, pdfStoragePath);
    for (const path of [textPath, pdfPath]) {
      const rel = relative(root, path);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return reply.code(500).send({ error: 'DOCUMENT_PATH_INVALID' });
    }
    const text = sentences.map((sentence) => sentence.text).join('\n');
    const textSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    const render = options.render ?? renderApplicationCoverLetter;
    let pdfSha256: string;
    try {
      await mkdir(dirname(textPath), { recursive: true, mode: 0o700 });
      await writeFile(textPath, text, { flag: 'wx', mode: 0o600 });
      const rendered = await render({ path: pdfPath, locale: language, paperSize: body.data.paperSize as ResumePaperSize, sentences });
      pdfSha256 = rendered.sha256;
    } catch {
      await Promise.all([unlink(textPath).catch(() => undefined), unlink(pdfPath).catch(() => undefined)]);
      return reply.code(503).send({ error: 'APPLICATION_DOCUMENT_RENDER_FAILED' });
    }

    try {
      const created = await createApplicationDocumentRevision({
        id: revisionId, workspaceId, documentId, language, claims: sentences, facts, offer,
        paperSize: body.data.paperSize, textSha256, pdfSha256,
        previousRevision: previous ? rowToRevision(previous, language) : null,
      });
      if (!created.ok) {
        await Promise.all([unlink(textPath).catch(() => undefined), unlink(pdfPath).catch(() => undefined)]);
        return reply.code(409).send({ error: 'APPLICATION_DOCUMENT_INVALID', detail: created });
      }
      await database.transaction(async (tx) => {
        await lockJobIdentity(tx, workspaceId);
        await lockKey(tx, profileLockKey(workspaceId));
        await lockKey(tx, `application-document:${workspaceId}:${application.id}:COVER_LETTER:${language}`);
        const latestApplication = (await tx.select().from(applications).where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, application.id))).limit(1))[0];
        if (!latestApplication?.jobId) throw new Error('APPLICATION_HAS_NO_OFFER');
        const latestSnapshot = (await tx.select().from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, workspaceId), eq(jobSnapshots.jobId, latestApplication.jobId))).orderBy(desc(jobSnapshots.fetchedAt), desc(jobSnapshots.id)).limit(1))[0];
        if (!latestSnapshot) throw new Error('APPLICATION_HAS_NO_OFFER');
        const latestProfile = (await tx.select().from(profileVersions).where(eq(profileVersions.workspaceId, workspaceId)).orderBy(desc(profileVersions.revision)).limit(1))[0];
        const latestFacts = latestProfile ? await tx.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), eq(profileFacts.profileVersionId, latestProfile.id), eq(profileFacts.approvalStatus, 'USER_APPROVED'))) : [];
        const latestOffer = latestApplicationDocumentOffer({ workspaceId, company: latestApplication.company, role: latestApplication.role, location: latestApplication.location, snapshots: [{ id: latestSnapshot.id, title: latestSnapshot.title, descriptionText: latestSnapshot.descriptionText, fetchedAt: latestSnapshot.fetchedAt.toISOString() }] });
        const latestHashes = await applicationDocumentHashes({ workspaceId, claims: sentences, facts: latestFacts.map((fact) => ({ id: fact.id, workspaceId, approval: fact.approvalStatus, text: fact.statement, tags: fact.tags })), offer: latestOffer });
        if (!latestHashes.ok || latestHashes.contentHash !== created.revision.contentHash || latestHashes.factsHash !== created.revision.factsHash || latestHashes.offerHash !== created.revision.offerHash) throw new Error('APPLICATION_DOCUMENT_SOURCE_CHANGED');
        const currentDocument = (await tx.select().from(applicationDocuments).where(and(eq(applicationDocuments.workspaceId, workspaceId), eq(applicationDocuments.applicationId, application.id), eq(applicationDocuments.kind, 'COVER_LETTER'), eq(applicationDocuments.language, language))).limit(1).for('update'))[0];
        if ((document?.id ?? null) !== (currentDocument?.id ?? null)) throw new Error('APPLICATION_DOCUMENT_REVISION_CHANGED');
        const currentPrevious = currentDocument ? (await tx.select().from(applicationDocumentRevisions).where(and(eq(applicationDocumentRevisions.workspaceId, workspaceId), eq(applicationDocumentRevisions.documentId, currentDocument.id))).orderBy(desc(applicationDocumentRevisions.revision)).limit(1).for('update'))[0] : undefined;
        if ((previous?.id ?? null) !== (currentPrevious?.id ?? null)) throw new Error('APPLICATION_DOCUMENT_REVISION_CHANGED');
        if (!currentDocument) {
          const inserted = await tx.insert(applicationDocuments).values({ id: documentId, workspaceId, applicationId: application.id, kind: 'COVER_LETTER', language }).returning();
          document = inserted[0];
        }
        await tx.insert(applicationDocumentRevisions).values({
          id: revisionId, workspaceId, documentId, revision: created.revision.revision, parentRevision: created.revision.parentRevision,
          claims: sentences as unknown as Array<Record<string, unknown>>, contentHash: created.revision.contentHash,
          offerSnapshotId: created.revision.offerSnapshotId, offerHash: created.revision.offerHash, factsHash: created.revision.factsHash,
          paperSize: created.revision.paperSize, textStoragePath, textSha256, pdfStoragePath, pdfSha256,
          confirmedUnsupportedIds: [], approvedAt: null, approvedBy: null,
        });
      });
      return reply.code(201).send({ documentId, revision: created.revision, text, sizeBytes: (await stat(pdfPath)).size });
    } catch (error) {
      await Promise.all([unlink(textPath).catch(() => undefined), unlink(pdfPath).catch(() => undefined)]);
      if (error instanceof Error && error.message === 'APPLICATION_DOCUMENT_REVISION_CHANGED') return reply.code(409).send({ error: error.message });
      if (error instanceof Error && error.message === 'APPLICATION_DOCUMENT_SOURCE_CHANGED') return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get('/api/v1/applications/:id/cover-letter', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    const query = z.object({ language: z.enum(['es', 'en']) }).strict().safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const application = (await database.select().from(applications).where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, params.data.id))).limit(1))[0];
    if (!application) return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
    const document = (await database.select().from(applicationDocuments).where(and(eq(applicationDocuments.workspaceId, workspaceId), eq(applicationDocuments.applicationId, application.id), eq(applicationDocuments.kind, 'COVER_LETTER'), eq(applicationDocuments.language, query.data.language))).limit(1))[0];
    if (!document) return reply.code(404).send({ error: 'APPLICATION_DOCUMENT_NOT_FOUND' });
    const revisions = await database.select().from(applicationDocumentRevisions).where(and(eq(applicationDocumentRevisions.workspaceId, workspaceId), eq(applicationDocumentRevisions.documentId, document.id))).orderBy(desc(applicationDocumentRevisions.revision));
    const root = options.storageRoot;
    if (!root) return reply.code(503).send({ error: 'DOCUMENT_STORAGE_UNAVAILABLE' });
    try {
      const rows = await Promise.all(revisions.map(async (revision) => ({
        id: revision.id,
        revision: revision.revision,
        parentRevision: revision.parentRevision,
        language: document.language,
        claims: revision.claims,
        contentHash: revision.contentHash,
        factsHash: revision.factsHash,
        offerHash: revision.offerHash,
        textSha256: revision.textSha256,
        pdfSha256: revision.pdfSha256,
        approvedAt: revision.approvedAt,
        confirmedUnsupportedIds: revision.confirmedUnsupportedIds,
        text: (await readVerifiedApplicationFile(root, revision.textStoragePath, revision.textSha256, 'TEXT')).toString('utf8'),
      })));
      return reply.send({ applicationId: application.id, documentId: document.id, language: document.language, revisions: rows });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'APPLICATION_DOCUMENT_FILE_UNAVAILABLE' });
    }
  });

  app.get('/api/v1/applications/:id/cover-letter/revisions/:revisionId/file', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = z.object({ id: z.uuid(), revisionId: z.uuid() }).strict().safeParse(request.params);
    const query = z.object({ format: z.enum(['text', 'pdf']), language: z.enum(['es', 'en']) }).strict().safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const application = (await database.select().from(applications).where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, params.data.id))).limit(1))[0];
    if (!application) return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
    const [document] = await database.select().from(applicationDocuments).where(and(eq(applicationDocuments.workspaceId, workspaceId), eq(applicationDocuments.applicationId, application.id), eq(applicationDocuments.kind, 'COVER_LETTER'), eq(applicationDocuments.language, query.data.language))).limit(1);
    if (!document) return reply.code(404).send({ error: 'APPLICATION_DOCUMENT_NOT_FOUND' });
    const revision = (await database.select().from(applicationDocumentRevisions).where(and(eq(applicationDocumentRevisions.workspaceId, workspaceId), eq(applicationDocumentRevisions.documentId, document.id), eq(applicationDocumentRevisions.id, params.data.revisionId))).limit(1))[0];
    if (!revision) return reply.code(404).send({ error: 'APPLICATION_DOCUMENT_REVISION_NOT_FOUND' });
    if (!options.storageRoot) return reply.code(503).send({ error: 'DOCUMENT_STORAGE_UNAVAILABLE' });
    try {
      const isPdf = query.data.format === 'pdf';
      const bytes = await readVerifiedApplicationFile(options.storageRoot, isPdf ? revision.pdfStoragePath : revision.textStoragePath, isPdf ? revision.pdfSha256 : revision.textSha256, isPdf ? 'PDF' : 'TEXT');
      reply.type(isPdf ? 'application/pdf' : 'text/plain; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="cover-letter-${revision.revision}.${isPdf ? 'pdf' : 'txt'}"`);
      return reply.send(bytes);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'APPLICATION_DOCUMENT_FILE_UNAVAILABLE' });
    }
  });

  app.post('/api/v1/applications/:id/cover-letter/revisions/:revisionId/approve', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = z.object({ id: z.uuid(), revisionId: z.uuid() }).strict().safeParse(request.params);
    const body = z.object({
      language: z.enum(['es', 'en']),
      expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
      expectedFactsHash: z.string().regex(/^[a-f0-9]{64}$/u),
      expectedOfferHash: z.string().regex(/^[a-f0-9]{64}$/u),
      expectedTextSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      expectedPdfSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      confirmedUnsupportedIds: z.array(z.string().min(1).max(80)).max(50),
    }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    if (!options.storageRoot) return reply.code(503).send({ error: 'DOCUMENT_STORAGE_UNAVAILABLE' });
    const workspaceId = workspace(request);
    const result = await database.transaction(async (tx) => {
      await lockJobIdentity(tx, workspaceId);
      await lockKey(tx, profileLockKey(workspaceId));
      const appRow = (await tx.select().from(applications).where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, params.data.id))).limit(1).for('update'))[0];
      if (!appRow) return { status: 404 as const, error: 'APPLICATION_NOT_FOUND' };
      const document = (await tx.select().from(applicationDocuments).where(and(eq(applicationDocuments.workspaceId, workspaceId), eq(applicationDocuments.applicationId, appRow.id), eq(applicationDocuments.kind, 'COVER_LETTER'), eq(applicationDocuments.language, body.data.language))).limit(1).for('update'))[0];
      if (!document) return { status: 404 as const, error: 'APPLICATION_DOCUMENT_NOT_FOUND' };
      await lockKey(tx, `application-document:${workspaceId}:${appRow.id}:COVER_LETTER:${document.language}`);
      const row = (await tx.select().from(applicationDocumentRevisions).where(and(eq(applicationDocumentRevisions.workspaceId, workspaceId), eq(applicationDocumentRevisions.documentId, document.id), eq(applicationDocumentRevisions.id, params.data.revisionId))).limit(1).for('update'))[0];
      if (!row) return { status: 404 as const, error: 'APPLICATION_DOCUMENT_REVISION_NOT_FOUND' };
      const newest = (await tx.select().from(applicationDocumentRevisions).where(and(eq(applicationDocumentRevisions.workspaceId, workspaceId), eq(applicationDocumentRevisions.documentId, document.id))).orderBy(desc(applicationDocumentRevisions.revision)).limit(1))[0];
      if (!appRow.jobId) return { status: 409 as const, error: 'APPLICATION_HAS_NO_OFFER' };
      const snapshot = (await tx.select().from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, workspaceId), eq(jobSnapshots.jobId, appRow.jobId))).orderBy(desc(jobSnapshots.fetchedAt), desc(jobSnapshots.id)).limit(1))[0];
      if (!snapshot) return { status: 409 as const, error: 'APPLICATION_HAS_NO_OFFER' };
      const profile = (await tx.select().from(profileVersions).where(eq(profileVersions.workspaceId, workspaceId)).orderBy(desc(profileVersions.revision)).limit(1))[0];
      const facts = profile ? await tx.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), eq(profileFacts.profileVersionId, profile.id), eq(profileFacts.approvalStatus, 'USER_APPROVED'))) : [];
      const offer = latestApplicationDocumentOffer({ workspaceId, company: appRow.company, role: appRow.role, location: appRow.location, snapshots: [{ id: snapshot.id, title: snapshot.title, descriptionText: snapshot.descriptionText, fetchedAt: snapshot.fetchedAt.toISOString() }] });
      let textBytes: Buffer;
      let pdfBytes: Buffer;
      try {
        [textBytes, pdfBytes] = await Promise.all([
          readVerifiedApplicationFile(options.storageRoot!, row.textStoragePath, row.textSha256, 'TEXT'),
          readVerifiedApplicationFile(options.storageRoot!, row.pdfStoragePath, row.pdfSha256, 'PDF'),
        ]);
      } catch (error) {
        return { status: 409 as const, error: error instanceof Error ? error.message : 'APPLICATION_DOCUMENT_FILE_UNAVAILABLE' };
      }
      void textBytes;
      void pdfBytes;
      const now = new Date().toISOString();
      const approved = await approveApplicationDocumentRevision({
        revision: rowToRevision(row, document.language as ApplicationDocumentLanguage), newestRevisionId: newest?.id ?? '',
        facts: facts.map((fact) => ({ id: fact.id, workspaceId, approval: fact.approvalStatus, text: fact.statement, tags: fact.tags })), offer,
        expectedContentHash: body.data.expectedContentHash, expectedFactsHash: body.data.expectedFactsHash,
        expectedOfferHash: body.data.expectedOfferHash, expectedTextSha256: body.data.expectedTextSha256,
        expectedPdfSha256: body.data.expectedPdfSha256, storedTextSha256: row.textSha256, storedPdfSha256: row.pdfSha256,
        confirmedUnsupportedIds: body.data.confirmedUnsupportedIds, approvedAt: now, approvedBy: 'USER',
      });
      if (!approved.ok) return { status: 409 as const, error: approved.code, detail: approved };
      const updated = await tx.update(applicationDocumentRevisions).set({ approvedAt: new Date(approved.revision.approvedAt!), approvedBy: approved.revision.approvedBy, confirmedUnsupportedIds: approved.revision.confirmedUnsupportedIds }).where(and(eq(applicationDocumentRevisions.workspaceId, workspaceId), eq(applicationDocumentRevisions.id, row.id), isNull(applicationDocumentRevisions.approvedAt))).returning();
      if (!updated.length) return { status: 409 as const, error: 'APPLICATION_DOCUMENT_REVISION_CHANGED' };
      return { status: 200 as const, revision: approved.revision };
    });
    if (result.status !== 200) return reply.code(result.status).send(result);
    return reply.send(result);
  });
}

async function readVerifiedApplicationFile(root: string, storagePath: string, expectedHash: string, kind: 'TEXT' | 'PDF') {
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, storagePath);
  const rel = relative(resolvedRoot, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('APPLICATION_DOCUMENT_PATH_INVALID');
  const visible = await lstat(path);
  if (!visible.isFile() || visible.isSymbolicLink()) throw new Error('APPLICATION_DOCUMENT_FILE_UNAVAILABLE');
  const actualRoot = await realpath(resolvedRoot);
  const actualPath = await realpath(path);
  const actualRel = relative(actualRoot, actualPath);
  if (isAbsolute(actualRel) || actualRel === '..' || actualRel.startsWith(`..${sep}`)) throw new Error('APPLICATION_DOCUMENT_PATH_INVALID');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    const maxBytes = kind === 'PDF' ? 20_000_000 : 40_000;
    if (!opened.isFile() || opened.dev !== visible.dev || opened.ino !== visible.ino || opened.size > maxBytes) throw new Error('APPLICATION_DOCUMENT_FILE_UNAVAILABLE');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('APPLICATION_DOCUMENT_FILE_CHANGED');
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('APPLICATION_DOCUMENT_HASH_MISMATCH');
    return bytes;
  } finally { await handle.close(); }
}

function rowToRevision(row: typeof applicationDocumentRevisions.$inferSelect, language: ApplicationDocumentLanguage): ApplicationDocumentRevision {
  return {
    id: row.id, workspaceId: row.workspaceId, documentId: row.documentId, revision: row.revision, parentRevision: row.parentRevision,
    language, claims: row.claims as unknown as ApplicationDocumentRevisionClaim[], contentHash: row.contentHash,
    offerSnapshotId: row.offerSnapshotId, offerHash: row.offerHash, factsHash: row.factsHash, paperSize: row.paperSize as 'A4' | 'LETTER',
    textSha256: row.textSha256, pdfSha256: row.pdfSha256, confirmedUnsupportedIds: row.confirmedUnsupportedIds,
    approvedAt: row.approvedAt?.toISOString() ?? null, approvedBy: row.approvedBy,
  };
}
