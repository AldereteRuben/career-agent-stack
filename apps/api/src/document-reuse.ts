import { and, eq, inArray } from 'drizzle-orm';
import { documentVersions, profileFacts } from '@career/db';
import { latestFacts, latestProfile, type Executor } from './workspace-data.js';

type Fact = typeof profileFacts.$inferSelect;
type Document = typeof documentVersions.$inferSelect;

// Profile saves copy facts with their original creation timestamp and content.
// Match only unchanged copies, never approximate text or a newly edited entry.
const copyKey = (fact: Fact) => JSON.stringify([fact.createdAt.toISOString(), fact.kind, fact.statement, fact.tags, fact.source]);

export async function documentReadiness(executor: Executor, workspaceId: string, documents: Document[]) {
  const profile = await latestProfile(executor, workspaceId);
  const sourceIds = [...new Set(documents.flatMap((doc) => doc.claims.flatMap((claim) => claim.sourceFactIds)))];
  const [current, sources] = await Promise.all([
    latestFacts(executor, workspaceId, profile?.id),
    sourceIds.length ? executor.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), inArray(profileFacts.id, sourceIds))) : Promise.resolve([]),
  ]);
  const approved = current.filter((fact) => fact.approvalStatus === 'USER_APPROVED');
  const approvedIds = new Set(approved.map((fact) => fact.id));
  const copies = new Map(approved.map((fact) => [copyKey(fact), fact.id]));
  const originals = new Map(sources.map((fact) => [fact.id, fact]));
  return documents.map((doc) => {
    const ids = [...new Set(doc.claims.flatMap((claim) => claim.sourceFactIds))];
    const resolved = ids.map((id) => approvedIds.has(id) ? id : originals.has(id) ? copies.get(copyKey(originals.get(id)!)) : undefined);
    const reusableFactIds = [...new Set(resolved.filter((id): id is string => Boolean(id)))];
    const assistReady = doc.approvalStatus === 'USER_APPROVED' && doc.profileRevisionId === profile?.id && doc.claims.length > 0 && doc.claims.every((claim) => claim.sourceFactIds.length > 0 && claim.sourceFactIds.every((id) => approvedIds.has(id)));
    return { ...doc, reusableFactIds, missingFactCount: resolved.filter((id) => !id).length, assistReady };
  });
}
