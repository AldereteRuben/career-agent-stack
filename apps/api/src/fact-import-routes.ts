import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db, profileFacts } from '@career/db';
import { factImportSchema, findDuplicateFacts } from '@career/domain';
import { latestFacts, latestProfile, lockKey, profileLockKey } from './workspace-data.js';

/**
 * Resume import, task T1 of ADR 018: stores a batch of resume entries as unconfirmed suggestions in one transaction,
 * grouped by the client-generated importId. Suggestions do not affect matching or resumes until the person confirms
 * them, so nothing is rescored here. The raw resume text never reaches this route; only the resulting entries do.
 */
export function registerFactImportRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string) {
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
}
