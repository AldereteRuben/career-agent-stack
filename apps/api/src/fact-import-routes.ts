import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db, profileFacts } from '@career/db';
import { factBatchApprovalSchema, factImportSchema, findDuplicateFacts, importUndoSchema } from '@career/domain';
import { latestFacts, latestProfile, lockKey, profileLockKey, rescoreWorkspaceJobs } from './workspace-data.js';

/**
 * Resume import, task T1 of ADR 018: stores a batch of resume entries as unconfirmed suggestions in one transaction,
 * grouped by the client-generated importId. Suggestions do not affect matching or resumes until the person confirms
 * them, so nothing is rescored here. The raw resume text never reaches this route; only the resulting entries do.
 */
type Options = { rescore?: (workspaceId: string) => Promise<unknown> };

export function registerFactImportRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, { rescore = (workspaceId: string) => rescoreWorkspaceJobs(db, workspaceId) }: Options = {}) {
  app.post('/api/v1/profile/facts/import', async (request, reply) => {
    const parsed = factImportSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT', detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
    const workspaceId = workspace(request);
    const { importId, facts } = parsed.data;
    const result = await db.transaction(async (tx) => {
      // Serialized with profile saves and approvals, so the batch lands on the current revision as a whole.
      await lockKey(tx, profileLockKey(workspaceId));
      const version = await latestProfile(tx, workspaceId);
      if (!version) return 'PROFILE_NOT_CONFIGURED' as const;
      const current = await latestFacts(tx, workspaceId, version.id);
      // A retried request (lost response) returns the stored import instead of creating it twice.
      const earlier = (await tx.select({ id: profileFacts.id }).from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), eq(profileFacts.importId, importId))).limit(1))[0];
      if (earlier) return { created: false, facts: current.filter((fact) => fact.importId === importId).reverse(), existing: current.filter((fact) => fact.importId !== importId) };
      const inserted = await tx.insert(profileFacts).values(facts.map((fact) => ({
        workspaceId, profileVersionId: version.id, importId, kind: fact.kind, statement: fact.statement, details: fact.details, tags: fact.tags,
        source: 'IMPORTED_SUGGESTION', approvalStatus: 'SUGGESTED' as const,
      }))).returning();
      return { created: true, facts: inserted, existing: current };
    });
    if (result === 'PROFILE_NOT_CONFIGURED') return reply.code(409).send({ error: result });
    const duplicates = findDuplicateFacts(result.facts, result.existing);
    return reply.code(result.created ? 201 : 200).send({ importId, facts: result.facts.map((fact, index) => ({ ...fact, duplicateOf: duplicates[index] })) });
  });

  /**
   * Task T2: approves a list of suggestions at once, after the review screen's explicit confirmation. All or nothing:
   * every id must be a suggestion (or already approved) on the current revision of this workspace. Archived entries are
   * refused, because restoring one is a separate, deliberate action. Jobs are rescored once, not once per entry.
   */
  app.post('/api/v1/profile/facts/approve', async (request, reply) => {
    const parsed = factBatchApprovalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT', detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
    const workspaceId = workspace(request);
    const { factIds } = parsed.data;
    const result = await db.transaction(async (tx) => {
      await lockKey(tx, profileLockKey(workspaceId));
      const rows = await tx.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), inArray(profileFacts.id, factIds)));
      if (rows.length !== factIds.length) return 'NOT_FOUND' as const;
      const latest = await latestProfile(tx, workspaceId);
      if (rows.some((row) => row.profileVersionId !== latest?.id)) return 'FACT_NOT_IN_CURRENT_REVISION' as const;
      if (rows.some((row) => row.approvalStatus === 'REJECTED')) return 'FACT_ARCHIVED' as const;
      const pending = rows.filter((row) => row.approvalStatus === 'SUGGESTED').map((row) => row.id);
      const approved = pending.length
        ? await tx.update(profileFacts).set({ approvalStatus: 'USER_APPROVED', approvedAt: new Date() }).where(and(eq(profileFacts.workspaceId, workspaceId), inArray(profileFacts.id, pending))).returning()
        : [];
      const byId = new Map([...rows, ...approved].map((row) => [row.id, row]));
      return { changed: approved.length, facts: factIds.map((id) => byId.get(id)!) };
    });
    if (result === 'NOT_FOUND') return reply.code(404).send({ error: 'NOT_FOUND' });
    if (result === 'FACT_NOT_IN_CURRENT_REVISION') return reply.code(409).send({ error: 'FACT_NOT_IN_CURRENT_REVISION' });
    if (result === 'FACT_ARCHIVED') return reply.code(409).send({ error: 'FACT_ARCHIVED' });
    // Rescoring is derived data; a failure must not undo the approvals the person just confirmed.
    if (result.changed) {
      try { await rescore(workspaceId); } catch (error) { request.log.error({ err: error, workspaceId }, 'Job rescoring failed'); }
    }
    return { approved: result.changed, facts: result.facts };
  });

  /** Facts of one import on the current revision. Older revisions are history and never change. */
  const importFacts = async (executor: Parameters<typeof latestProfile>[0], workspaceId: string, importId: string) => {
    const version = await latestProfile(executor, workspaceId);
    return version ? executor.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), eq(profileFacts.profileVersionId, version.id), eq(profileFacts.importId, importId))) : [];
  };
  const summary = (facts: Array<{ approvalStatus: string }>) => ({
    pending: facts.filter((fact) => fact.approvalStatus === 'SUGGESTED').length,
    confirmed: facts.filter((fact) => fact.approvalStatus === 'USER_APPROVED').length,
    archived: facts.filter((fact) => fact.approvalStatus === 'REJECTED').length,
  });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** Task T10: what undoing an import would do, for the confirmation message. */
  app.get('/api/v1/profile/imports/:importId', async (request, reply) => {
    const { importId } = request.params as { importId: string };
    if (!uuid.test(importId)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const facts = await importFacts(db, workspace(request), importId);
    if (!facts.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { importId, ...summary(facts) };
  });

  /**
   * Task T10: reverts a whole import. Unconfirmed suggestions are discarded and confirmed entries are archived, the
   * same actions the profile offers one by one; nothing is deleted, so generated PDFs keep their record and archived
   * entries can be restored. The request repeats the counts the person confirmed; if they no longer match, nothing
   * changes. Jobs are rescored once, and only when confirmed entries were archived.
   */
  app.post('/api/v1/profile/imports/:importId/undo', async (request, reply) => {
    const { importId } = request.params as { importId: string };
    if (!uuid.test(importId)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const parsed = importUndoSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT', detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
    const workspaceId = workspace(request);
    const result = await db.transaction(async (tx) => {
      await lockKey(tx, profileLockKey(workspaceId));
      const facts = await importFacts(tx, workspaceId, importId);
      if (!facts.length) return 'NOT_FOUND' as const;
      const counts = summary(facts);
      if (counts.pending !== parsed.data.expectedPending || counts.confirmed !== parsed.data.expectedConfirmed) return { changed: counts } as const;
      const ids = facts.filter((fact) => fact.approvalStatus !== 'REJECTED').map((fact) => fact.id);
      if (ids.length) await tx.update(profileFacts).set({ approvalStatus: 'REJECTED', approvedAt: null }).where(and(eq(profileFacts.workspaceId, workspaceId), inArray(profileFacts.id, ids)));
      return { discarded: counts.pending, archived: counts.confirmed };
    });
    if (result === 'NOT_FOUND') return reply.code(404).send({ error: 'NOT_FOUND' });
    if ('changed' in result) return reply.code(409).send({ error: 'IMPORT_CHANGED', ...result.changed });
    if (result.archived) {
      try { await rescore(workspaceId); } catch (error) { request.log.error({ err: error, workspaceId }, 'Job rescoring failed'); }
    }
    return { importId, ...result };
  });
}
