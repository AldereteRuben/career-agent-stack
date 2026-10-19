import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { applications, applicationDocuments, applicationDocumentRevisions, db, jobSnapshots, profileFacts, profileVersions } from '@career/db';
import {
  applicationDocumentCurrentness,
  applicationDocumentHashes,
  approveApplicationDocumentRevision,
  buildApplicationCoverLetter,
  buildApplicationResumeDraft,
  createApplicationDocumentRevision,
  latestApplicationDocumentOffer,
  printedResumeIdentity,
  saveApplicationDocumentSentenceEdit,
  type ApplicationDocumentLanguage,
  type ApplicationDocumentOffer,
  type ApplicationDocumentRevision,
  type ApplicationDocumentRevisionClaim,
} from '@career/domain';
import { renderApplicationResume, type ResumePaperSize } from './document-renderer.js';
import { applicationDocumentDownloadFileName } from './application-document-download.js';
import { lockKey, profileLockKey } from './workspace-data.js';
import { lockJobIdentity } from './job-identity.js';
import { z } from 'zod';

type RouteOptions = {
  database?: typeof db;
  storageRoot?: string;
  render?: typeof renderApplicationResume;
};

/** Provides the local resume builder and revision API; no external service is contacted. */
export function registerApplicationResumeRoutes(
  app: FastifyInstance,
  workspace: (request: FastifyRequest) => string,
  options: RouteOptions = {},
) {
  const database = options.database ?? db;
  const paramsSchema = z.object({ id: z.uuid() }).strict();
  const languageSchema = z.enum(['es', 'en']);

  app.get('/api/v1/applications/:id/document-drafts', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = paramsSchema.safeParse(request.params);
    const query = z.object({ language: languageSchema.default('es') }).strict().safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const context = await loadContext(database, workspace(request), params.data.id);
    if ('status' in context) return reply.code(context.status).send({ error: context.error });
    const language = query.data.language;
    const buildInput = { language, offer: context.offer, facts: context.facts };
    return reply.send({
      applicationId: context.application.id,
      language,
      resume: buildApplicationResumeDraft(buildInput),
      coverLetter: buildApplicationCoverLetter(buildInput),
    });
  });

  app.get('/api/v1/applications/:id/resume/draft', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = paramsSchema.safeParse(request.params);
    const query = z.object({ language: languageSchema.default('es') }).strict().safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const context = await loadContext(database, workspace(request), params.data.id);
    if ('status' in context) return reply.code(context.status).send({ error: context.error });
    return reply.send({ applicationId: context.application.id, ...buildApplicationResumeDraft({ language: query.data.language, offer: context.offer, facts: context.facts }) });
  });

  app.post('/api/v1/applications/:id/resume/revisions', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = paramsSchema.safeParse(request.params);
    const body = z.object({
      language: languageSchema,
      paperSize: z.enum(['A4', 'LETTER']).default('A4'),
      parentRevisionId: z.uuid().optional(),
      sentences: z.array(z.object({ sentenceId: z.string().min(1).max(80), text: z.string().trim().min(1).max(4000), sourceFactIds: z.array(z.uuid()).max(50) }).strict()).min(1).max(50).optional(),
      confirmUnsupportedIds: z.array(z.string().min(1).max(80)).max(50).default([]),
    }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    if (!options.storageRoot) return reply.code(503).send({ error: 'DOCUMENT_STORAGE_UNAVAILABLE' });

    const workspaceId = workspace(request);
    const context = await loadContext(database, workspaceId, params.data.id);
    if ('status' in context) return reply.code(context.status).send({ error: context.error });
    const language: ApplicationDocumentLanguage = body.data.language;
    const built = buildApplicationResumeDraft({ language, offer: context.offer, facts: context.facts });
    let document = (await database.select().from(applicationDocuments).where(and(
      eq(applicationDocuments.workspaceId, workspaceId), eq(applicationDocuments.applicationId, context.application.id),
      eq(applicationDocuments.kind, 'RESUME'), eq(applicationDocuments.language, language),
    )).limit(1))[0];
    let previous: typeof applicationDocumentRevisions.$inferSelect | undefined;
    if (document) {
      previous = (await database.select().from(applicationDocumentRevisions).where(and(
        eq(applicationDocumentRevisions.workspaceId, workspaceId), eq(applicationDocumentRevisions.documentId, document.id),
      )).orderBy(desc(applicationDocumentRevisions.revision)).limit(1))[0];
    }
    if ((previous && body.data.parentRevisionId !== previous.id) || (!previous && body.data.parentRevisionId)) {
      return reply.code(409).send({ error: 'APPLICATION_DOCUMENT_REVISION_CHANGED' });
    }

    // Keep the latest builder baseline available so removed sentences can be restored in a later revision.
    const sourceById = new Map(built.sentences.map((sentence) => [sentence.sentenceId, { ...sentence, language }]));
    for (const sentence of (previous?.claims as unknown as ApplicationDocumentRevisionClaim[] | undefined) ?? []) sourceById.set(sentence.sentenceId, sentence);
    const sourceClaims = [...sourceById.values()];
    const sentences: ApplicationDocumentRevisionClaim[] = [];
    if (body.data.sentences) {
      if (new Set(body.data.sentences.map((sentence) => sentence.sentenceId)).size !== body.data.sentences.length
        || body.data.sentences.some((sentence) => !sourceById.has(sentence.sentenceId))) {
        return reply.code(400).send({ error: 'INVALID_SENTENCE_SELECTION' });
      }
      for (const item of body.data.sentences) {
        const result = saveApplicationDocumentSentenceEdit({
          original: sourceById.get(item.sentenceId)!, text: item.text, sourceFactIds: item.sourceFactIds,
          confirmUnsupported: body.data.confirmUnsupportedIds.includes(item.sentenceId), workspaceId,
          facts: context.facts, offer: context.offer,
        });
        if (!result.ok) return reply.code(422).send({ error: 'UNSUPPORTED_CONTENT', sentenceId: item.sentenceId, issue: result.issue });
        sentences.push({ ...result.sentence, language });
      }
    } else {
      sentences.push(...sourceClaims);
    }
    const unsupportedIds = sentences.filter((sentence) => sentence.origin === 'USER_UNSUPPORTED').map((sentence) => sentence.sentenceId);
    if (unsupportedIds.some((id) => !body.data.confirmUnsupportedIds.includes(id))) {
      return reply.code(409).send({ error: 'UNSUPPORTED_CLAIMS_REQUIRE_CONFIRMATION', sentenceIds: unsupportedIds });
    }

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
    if (Buffer.byteLength(text, 'utf8') > 40_000) return reply.code(413).send({ error: 'APPLICATION_DOCUMENT_SIZE_LIMIT' });
    const textSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    let pdfSha256: string;
    let pdfSizeBytes: number;
    const printedIdentity = printedResumeIdentity(context.profile?.profile ?? {});
    try {
      await ensureSafeDirectory(root, dirname(textPath));
      await writeFile(textPath, text, { flag: 'wx', mode: 0o600 });
      const render = options.render ?? renderApplicationResume;
      const rendered = await render({
        path: pdfPath, fullName: printedIdentity.fullName, email: printedIdentity.email, role: context.application.role,
        locale: language, paperSize: body.data.paperSize as ResumePaperSize, sentences,
      });
      pdfSizeBytes = rendered.size;
      const pdf = await readVerifiedApplicationFile(root, pdfPath, rendered.sha256, 'PDF');
      pdfSha256 = createHash('sha256').update(pdf).digest('hex');
      if (pdfSha256 !== rendered.sha256) throw new Error('APPLICATION_DOCUMENT_HASH_MISMATCH');
    } catch {
      await Promise.all([unlink(textPath).catch(() => undefined), unlink(pdfPath).catch(() => undefined)]);
      return reply.code(503).send({ error: 'APPLICATION_DOCUMENT_RENDER_FAILED' });
    }

    const created = await createApplicationDocumentRevision({
      id: revisionId, workspaceId, documentId, language, claims: sentences, facts: context.facts, offer: context.offer,
      paperSize: body.data.paperSize, textSha256, pdfSha256,
      previousRevision: previous ? rowToRevision(previous, language) : null,
    });
    if (!created.ok) {
      await Promise.all([unlink(textPath).catch(() => undefined), unlink(pdfPath).catch(() => undefined)]);
      return reply.code(409).send({ error: 'APPLICATION_DOCUMENT_INVALID', detail: created });
    }
    let transactionFailed = false;
    let transactionError: unknown;
    try {
      await database.transaction(async (tx) => {
        await lockJobIdentity(tx, workspaceId);
        await lockKey(tx, profileLockKey(workspaceId));
        await lockKey(tx, `application-document:${workspaceId}:${context.application.id}:RESUME:${language}`);
        const latestApplication = (await tx.select().from(applications).where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, context.application.id))).limit(1))[0];
        if (!latestApplication?.jobId) throw new Error('APPLICATION_HAS_NO_OFFER');
        const latestSnapshot = (await tx.select().from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, workspaceId), eq(jobSnapshots.jobId, latestApplication.jobId))).orderBy(desc(jobSnapshots.fetchedAt), desc(jobSnapshots.id)).limit(1))[0];
        if (!latestSnapshot) throw new Error('APPLICATION_HAS_NO_OFFER');
        const latestProfile = (await tx.select().from(profileVersions).where(eq(profileVersions.workspaceId, workspaceId)).orderBy(desc(profileVersions.revision)).limit(1))[0];
        const latestPrintedIdentity = printedResumeIdentity(latestProfile?.profile ?? {});
        if (latestPrintedIdentity.fullName !== printedIdentity.fullName || latestPrintedIdentity.email !== printedIdentity.email) throw new Error('APPLICATION_DOCUMENT_SOURCE_CHANGED');
        const latestFacts = latestProfile ? await tx.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), eq(profileFacts.profileVersionId, latestProfile.id), eq(profileFacts.approvalStatus, 'USER_APPROVED'))) : [];
        const latestOffer = latestApplicationDocumentOffer({ workspaceId, company: latestApplication.company, role: latestApplication.role, location: latestApplication.location, snapshots: [{ id: latestSnapshot.id, title: latestSnapshot.title, descriptionText: latestSnapshot.descriptionText, fetchedAt: latestSnapshot.fetchedAt.toISOString() }] });
        const latestHashes = await applicationDocumentHashes({ workspaceId, claims: sentences, facts: latestFacts.map((fact) => ({ id: fact.id, workspaceId, approval: fact.approvalStatus, text: fact.statement, tags: fact.tags })), offer: latestOffer });
        if (!latestHashes.ok || latestHashes.contentHash !== created.revision.contentHash || latestHashes.factsHash !== created.revision.factsHash || latestHashes.offerHash !== created.revision.offerHash) throw new Error('APPLICATION_DOCUMENT_SOURCE_CHANGED');
        const currentDocument = (await tx.select().from(applicationDocuments).where(and(eq(applicationDocuments.workspaceId, workspaceId), eq(applicationDocuments.applicationId, context.application.id), eq(applicationDocuments.kind, 'RESUME'), eq(applicationDocuments.language, language))).limit(1).for('update'))[0];
        if ((document?.id ?? null) !== (currentDocument?.id ?? null)) throw new Error('APPLICATION_DOCUMENT_REVISION_CHANGED');
        const currentPrevious = currentDocument ? (await tx.select().from(applicationDocumentRevisions).where(and(eq(applicationDocumentRevisions.workspaceId, workspaceId), eq(applicationDocumentRevisions.documentId, currentDocument.id))).orderBy(desc(applicationDocumentRevisions.revision)).limit(1).for('update'))[0] : undefined;
        if ((previous?.id ?? null) !== (currentPrevious?.id ?? null)) throw new Error('APPLICATION_DOCUMENT_REVISION_CHANGED');
        if (!currentDocument) document = (await tx.insert(applicationDocuments).values({ id: documentId, workspaceId, applicationId: context.application.id, kind: 'RESUME', language }).returning())[0];
        await tx.insert(applicationDocumentRevisions).values({
          id: revisionId, workspaceId, documentId, revision: created.revision.revision, parentRevision: created.revision.parentRevision,
          claims: sentences as unknown as Array<Record<string, unknown>>, contentHash: created.revision.contentHash,
          offerSnapshotId: created.revision.offerSnapshotId, offerHash: created.revision.offerHash, factsHash: created.revision.factsHash,
          paperSize: body.data.paperSize, textStoragePath, textSha256, pdfStoragePath, pdfSha256, confirmedUnsupportedIds: [], approvedAt: null, approvedBy: null,
        });
      });
    } catch (error) {
      transactionFailed = true;
      transactionError = error;
    }
    if (transactionFailed) {
      let revisionPersisted: boolean | undefined;
      try {
        revisionPersisted = (await database.select({ id: applicationDocumentRevisions.id }).from(applicationDocumentRevisions).where(and(
          eq(applicationDocumentRevisions.workspaceId, workspaceId), eq(applicationDocumentRevisions.id, revisionId),
        )).limit(1)).length > 0;
      } catch {
        // The commit outcome is unknown. Keep both files so a committed revision cannot be left broken.
        return reply.code(503).send({ error: 'APPLICATION_DOCUMENT_SAVE_UNCERTAIN' });
      }
      if (!revisionPersisted) {
        await Promise.all([unlink(textPath).catch(() => undefined), unlink(pdfPath).catch(() => undefined)]);
        if (transactionError instanceof Error && ['APPLICATION_DOCUMENT_REVISION_CHANGED', 'APPLICATION_DOCUMENT_SOURCE_CHANGED', 'APPLICATION_HAS_NO_OFFER'].includes(transactionError.message)) {
          return reply.code(409).send({ error: transactionError.message });
        }
        throw transactionError;
      }
    }
    return reply.code(201).send({ documentId, revision: created.revision, text, unconfirmedRequirements: built.unconfirmedRequirements, sizeBytes: pdfSizeBytes });
  });

  app.get('/api/v1/applications/:id/resume', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = paramsSchema.safeParse(request.params);
    const query = z.object({ language: languageSchema }).strict().safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const application = (await database.select().from(applications).where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, params.data.id))).limit(1))[0];
    if (!application) return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
    const document = (await database.select().from(applicationDocuments).where(and(eq(applicationDocuments.workspaceId, workspaceId), eq(applicationDocuments.applicationId, application.id), eq(applicationDocuments.kind, 'RESUME'), eq(applicationDocuments.language, query.data.language))).limit(1))[0];
    if (!document) return reply.code(404).send({ error: 'APPLICATION_DOCUMENT_NOT_FOUND' });
    const revisions = await database.select().from(applicationDocumentRevisions).where(and(eq(applicationDocumentRevisions.workspaceId, workspaceId), eq(applicationDocumentRevisions.documentId, document.id))).orderBy(desc(applicationDocumentRevisions.revision));
    if (!options.storageRoot) return reply.code(503).send({ error: 'DOCUMENT_STORAGE_UNAVAILABLE' });
    try {
      const profile = (await database.select().from(profileVersions).where(eq(profileVersions.workspaceId, workspaceId)).orderBy(desc(profileVersions.revision)).limit(1))[0];
      const facts = profile ? await database.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), eq(profileFacts.profileVersionId, profile.id))) : [];
      const snapshot = application.jobId ? (await database.select().from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, workspaceId), eq(jobSnapshots.jobId, application.jobId))).orderBy(desc(jobSnapshots.fetchedAt), desc(jobSnapshots.id)).limit(1))[0] : undefined;
      const offer = latestApplicationDocumentOffer({ workspaceId, company: application.company, role: application.role, location: application.location, snapshots: snapshot ? [{ id: snapshot.id, title: snapshot.title, descriptionText: snapshot.descriptionText, fetchedAt: snapshot.fetchedAt.toISOString() }] : [] });
      const factSnapshots = facts.map((fact) => ({ id: fact.id, workspaceId, approval: fact.approvalStatus, text: fact.statement, tags: fact.tags }));
      const rows = await Promise.all(revisions.map(async (revision) => ({
        id: revision.id, revision: revision.revision, parentRevision: revision.parentRevision, language: document.language,
        claims: revision.claims, contentHash: revision.contentHash, factsHash: revision.factsHash, offerHash: revision.offerHash,
        textSha256: revision.textSha256, pdfSha256: revision.pdfSha256, approvedAt: revision.approvedAt,
        confirmedUnsupportedIds: revision.confirmedUnsupportedIds,
        currentness: await applicationDocumentCurrentness({ revision: rowToRevision(revision, document.language as ApplicationDocumentLanguage), facts: factSnapshots, offer }),
        text: (await readVerifiedApplicationFile(options.storageRoot!, revision.textStoragePath, revision.textSha256, 'TEXT')).toString('utf8'),
      })));
      return reply.send({ applicationId: application.id, documentId: document.id, language: document.language, revisions: rows });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'APPLICATION_DOCUMENT_FILE_UNAVAILABLE' });
    }
  });

  app.get('/api/v1/applications/:id/resume/revisions/:revisionId/file', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = z.object({ id: z.uuid(), revisionId: z.uuid() }).strict().safeParse(request.params);
    const query = z.object({ format: z.enum(['text', 'pdf']), language: languageSchema }).strict().safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const application = (await database.select().from(applications).where(and(
      eq(applications.workspaceId, workspaceId), eq(applications.id, params.data.id),
    )).limit(1))[0];
    if (!application) return reply.code(404).send({ error: 'APPLICATION_NOT_FOUND' });
    const document = (await database.select().from(applicationDocuments).where(and(
      eq(applicationDocuments.workspaceId, workspaceId), eq(applicationDocuments.applicationId, application.id),
      eq(applicationDocuments.kind, 'RESUME'), eq(applicationDocuments.language, query.data.language),
    )).limit(1))[0];
    if (!document) return reply.code(404).send({ error: 'APPLICATION_DOCUMENT_NOT_FOUND' });
    const revision = (await database.select().from(applicationDocumentRevisions).where(and(
      eq(applicationDocumentRevisions.workspaceId, workspaceId), eq(applicationDocumentRevisions.documentId, document.id),
      eq(applicationDocumentRevisions.id, params.data.revisionId),
    )).limit(1))[0];
    if (!revision) return reply.code(404).send({ error: 'APPLICATION_DOCUMENT_REVISION_NOT_FOUND' });
    if (!options.storageRoot) return reply.code(503).send({ error: 'DOCUMENT_STORAGE_UNAVAILABLE' });
    try {
      const isPdf = query.data.format === 'pdf';
      const bytes = await readVerifiedApplicationFile(options.storageRoot, isPdf ? revision.pdfStoragePath : revision.textStoragePath, isPdf ? revision.pdfSha256 : revision.textSha256, isPdf ? 'PDF' : 'TEXT');
      reply.type(isPdf ? 'application/pdf' : 'text/plain; charset=utf-8');
      reply.header('X-Content-SHA256', isPdf ? revision.pdfSha256 : revision.textSha256);
      reply.header('Content-Disposition', `attachment; filename="${applicationDocumentDownloadFileName({
        applicationId: application.id, company: application.company, role: application.role, kind: 'RESUME',
        language: document.language as ApplicationDocumentLanguage, revision: revision.revision, format: query.data.format,
      })}"`);
      return reply.send(bytes);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'APPLICATION_DOCUMENT_FILE_UNAVAILABLE' });
    }
  });

  app.post('/api/v1/applications/:id/resume/revisions/:revisionId/approve', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = z.object({ id: z.uuid(), revisionId: z.uuid() }).strict().safeParse(request.params);
    const body = z.object({
      language: languageSchema,
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
      await lockKey(tx, `application-document:${workspaceId}:${params.data.id}:RESUME:${body.data.language}`);
      const application = (await tx.select().from(applications).where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, params.data.id))).limit(1).for('update'))[0];
      if (!application) return { status: 404 as const, error: 'APPLICATION_NOT_FOUND' };
      const document = (await tx.select().from(applicationDocuments).where(and(
        eq(applicationDocuments.workspaceId, workspaceId), eq(applicationDocuments.applicationId, application.id),
        eq(applicationDocuments.kind, 'RESUME'), eq(applicationDocuments.language, body.data.language),
      )).limit(1).for('update'))[0];
      if (!document) return { status: 404 as const, error: 'APPLICATION_DOCUMENT_NOT_FOUND' };
      const revision = (await tx.select().from(applicationDocumentRevisions).where(and(
        eq(applicationDocumentRevisions.workspaceId, workspaceId), eq(applicationDocumentRevisions.documentId, document.id),
        eq(applicationDocumentRevisions.id, params.data.revisionId),
      )).limit(1).for('update'))[0];
      if (!revision) return { status: 404 as const, error: 'APPLICATION_DOCUMENT_REVISION_NOT_FOUND' };
      const newest = (await tx.select().from(applicationDocumentRevisions).where(and(eq(applicationDocumentRevisions.workspaceId, workspaceId), eq(applicationDocumentRevisions.documentId, document.id))).orderBy(desc(applicationDocumentRevisions.revision)).limit(1))[0];
      if (!application.jobId) return { status: 409 as const, error: 'APPLICATION_HAS_NO_OFFER' };
      const snapshot = (await tx.select().from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, workspaceId), eq(jobSnapshots.jobId, application.jobId))).orderBy(desc(jobSnapshots.fetchedAt), desc(jobSnapshots.id)).limit(1))[0];
      if (!snapshot) return { status: 409 as const, error: 'APPLICATION_HAS_NO_OFFER' };
      const profile = (await tx.select().from(profileVersions).where(eq(profileVersions.workspaceId, workspaceId)).orderBy(desc(profileVersions.revision)).limit(1))[0];
      const facts = profile ? await tx.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), eq(profileFacts.profileVersionId, profile.id))) : [];
      const offer = latestApplicationDocumentOffer({ workspaceId, company: application.company, role: application.role, location: application.location, snapshots: [{ id: snapshot.id, title: snapshot.title, descriptionText: snapshot.descriptionText, fetchedAt: snapshot.fetchedAt.toISOString() }] });
      try {
        await Promise.all([
          readVerifiedApplicationFile(options.storageRoot!, revision.textStoragePath, revision.textSha256, 'TEXT'),
          readVerifiedApplicationFile(options.storageRoot!, revision.pdfStoragePath, revision.pdfSha256, 'PDF'),
        ]);
      } catch {
        return { status: 409 as const, error: 'APPROVAL_STALE', detail: { code: 'APPROVAL_STALE', reason: 'PREVIEW_DIGEST_MISMATCH' } };
      }
      const approved = await approveApplicationDocumentRevision({
        revision: rowToRevision(revision, document.language as ApplicationDocumentLanguage), newestRevisionId: newest?.id ?? '',
        facts: facts.map((fact) => ({ id: fact.id, workspaceId, approval: fact.approvalStatus, text: fact.statement, tags: fact.tags })), offer,
        expectedContentHash: body.data.expectedContentHash, expectedFactsHash: body.data.expectedFactsHash,
        expectedOfferHash: body.data.expectedOfferHash, expectedTextSha256: body.data.expectedTextSha256,
        expectedPdfSha256: body.data.expectedPdfSha256, storedTextSha256: revision.textSha256, storedPdfSha256: revision.pdfSha256,
        confirmedUnsupportedIds: body.data.confirmedUnsupportedIds, approvedAt: new Date().toISOString(), approvedBy: 'USER',
      });
      if (!approved.ok) {
        const stale = approved.code === 'NOT_NEWEST' || approved.code === 'FACT_NOT_APPROVED';
        const resultCode = stale ? 'APPROVAL_STALE' : approved.code;
        return { status: 409 as const, error: resultCode, detail: stale ? { ...approved, code: resultCode } : approved };
      }
      const updated = await tx.update(applicationDocumentRevisions).set({
        approvedAt: new Date(approved.revision.approvedAt!), approvedBy: approved.revision.approvedBy,
        confirmedUnsupportedIds: approved.revision.confirmedUnsupportedIds,
      }).where(and(eq(applicationDocumentRevisions.workspaceId, workspaceId), eq(applicationDocumentRevisions.id, revision.id), isNull(applicationDocumentRevisions.approvedAt))).returning();
      if (!updated.length) return { status: 409 as const, error: 'APPLICATION_DOCUMENT_REVISION_CHANGED' };
      return { status: 200 as const, revision: approved.revision };
    });
    if (result.status !== 200) return reply.code(result.status).send(result);
    return reply.send(result);
  });
}

async function loadContext(database: typeof db, workspaceId: string, applicationId: string) {
  const application = (await database.select().from(applications).where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, applicationId))).limit(1))[0];
  if (!application) return { status: 404 as const, error: 'APPLICATION_NOT_FOUND' };
  if (!application.jobId) return { status: 409 as const, error: 'APPLICATION_HAS_NO_OFFER' };
  const snapshot = (await database.select().from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, workspaceId), eq(jobSnapshots.jobId, application.jobId))).orderBy(desc(jobSnapshots.fetchedAt), desc(jobSnapshots.id)).limit(1))[0];
  if (!snapshot) return { status: 409 as const, error: 'APPLICATION_HAS_NO_OFFER' };
  const profile = (await database.select().from(profileVersions).where(eq(profileVersions.workspaceId, workspaceId)).orderBy(desc(profileVersions.revision)).limit(1))[0];
  const rows = profile ? await database.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), eq(profileFacts.profileVersionId, profile.id), eq(profileFacts.approvalStatus, 'USER_APPROVED'))) : [];
  const facts = rows.map((fact) => ({ id: fact.id, workspaceId, kind: fact.kind, text: fact.statement, tags: fact.tags, approval: fact.approvalStatus }));
  const offer: ApplicationDocumentOffer = {
    workspaceId, company: application.company, role: application.role, location: application.location,
    snapshot: { id: snapshot.id, title: snapshot.title, descriptionText: snapshot.descriptionText },
  };
  return { application, snapshot, profile, facts, offer };
}

async function ensureSafeDirectory(root: string, directory: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await realpath(root);
  const rootInfo = await lstat(realRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('DOCUMENT_PATH_INVALID');
  const relativeDirectory = relative(resolve(root), resolve(directory));
  if (isAbsolute(relativeDirectory) || relativeDirectory === '..' || relativeDirectory.startsWith(`..${sep}`)) throw new Error('DOCUMENT_PATH_INVALID');
  let current = realRoot;
  for (const part of relativeDirectory.split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const directoryInfo = await lstat(current);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('DOCUMENT_PATH_INVALID');
    const realDirectory = await realpath(current);
    const rel = relative(realRoot, realDirectory);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('DOCUMENT_PATH_INVALID');
  }
}

async function readVerifiedApplicationFile(root: string, path: string, expectedHash: string, kind: 'TEXT' | 'PDF') {
  const resolvedRoot = resolve(root);
  const absolutePath = resolve(resolvedRoot, path);
  const rel = relative(resolvedRoot, absolutePath);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('APPLICATION_DOCUMENT_PATH_INVALID');
  const visible = await lstat(absolutePath);
  if (!visible.isFile() || visible.isSymbolicLink()) throw new Error('APPLICATION_DOCUMENT_FILE_UNAVAILABLE');
  const actualRoot = await realpath(resolvedRoot);
  const actualPath = await realpath(absolutePath);
  const actualRel = relative(actualRoot, actualPath);
  if (isAbsolute(actualRel) || actualRel === '..' || actualRel.startsWith(`..${sep}`)) throw new Error('APPLICATION_DOCUMENT_PATH_INVALID');
  const handle = await open(absolutePath, 'r');
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
