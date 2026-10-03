import { and, eq, inArray } from 'drizzle-orm';
import { documentVersions, profileFacts, profileVersions, jobSnapshots } from '@career/db';
import { printedContentCurrent, printedResumeIdentity } from '@career/domain';
import { latestFacts, latestProfile, type Executor } from './workspace-data.js';

type Fact = typeof profileFacts.$inferSelect;
type Document = typeof documentVersions.$inferSelect;

// Profile saves copy facts with their original creation timestamp and content.
// Match only unchanged copies, never approximate text or a newly edited entry.
const copyKey = (fact: Fact) => JSON.stringify([fact.createdAt.toISOString(), fact.kind, fact.statement, fact.tags, fact.source, fact.details ?? null]);

/**
 * Readiness of stored PDFs against the current profile. A PDF stays approvable and usable while everything it prints is
 * unchanged: the printed name and email of the revision it was generated from, and every claim's source fact (the same
 * row, or an exact copy carried into a newer revision, still approved). Saving only preferences therefore keeps it ready.
 * Approval, application linking and assisted preparation all rely on this single check.
 */
export async function documentReadiness(executor: Executor, workspaceId: string, documents: Document[]) {
  const profile = await latestProfile(executor, workspaceId);
  const sourceIds = [...new Set(documents.flatMap((doc) => doc.claims.flatMap((claim) => claim.sourceFactIds)))];
  const snapshotIds = documents.flatMap((doc) => doc.jobSnapshotId ? [doc.jobSnapshotId] : []);
  const basisIds = [...new Set(documents.flatMap((doc) => doc.profileRevisionId && doc.profileRevisionId !== profile?.id ? [doc.profileRevisionId] : []))];
  const [current, sources, snapshots, bases] = await Promise.all([
    latestFacts(executor, workspaceId, profile?.id),
    sourceIds.length ? executor.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), inArray(profileFacts.id, sourceIds))) : Promise.resolve([]),
    snapshotIds.length ? executor.select({ id: jobSnapshots.id, jobId: jobSnapshots.jobId }).from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, workspaceId), inArray(jobSnapshots.id, snapshotIds))) : Promise.resolve([]),
    basisIds.length ? executor.select({ id: profileVersions.id, profile: profileVersions.profile }).from(profileVersions).where(and(eq(profileVersions.workspaceId, workspaceId), inArray(profileVersions.id, basisIds))) : Promise.resolve([]),
  ]);
  const snapshotJobs = new Map(snapshots.map((row) => [row.id, row.jobId]));
  const approved = current.filter((fact) => fact.approvalStatus === 'USER_APPROVED');
  const approvedById = new Map(approved.map((fact) => [fact.id, fact]));
  const copies = new Map(approved.map((fact) => [copyKey(fact), fact]));
  const originals = new Map(sources.map((fact) => [fact.id, fact]));
  const basisIdentity = new Map(bases.map((row) => [row.id, printedResumeIdentity(row.profile)]));
  const currentIdentity = profile ? printedResumeIdentity(profile.profile) : null;
  const currentFact = (id: string) => approvedById.get(id) ?? (originals.has(id) ? copies.get(copyKey(originals.get(id)!)) : undefined);
  return documents.map((doc) => {
    const ids = [...new Set(doc.claims.flatMap((claim) => claim.sourceFactIds))];
    const resolved = ids.map((id) => currentFact(id)?.id);
    const reusableFactIds = [...new Set(resolved.filter((id): id is string => Boolean(id)))];
    const sameRevision = Boolean(profile) && doc.profileRevisionId === profile!.id;
    const currentContent = Boolean(profile) && printedContentCurrent({
      claims: doc.claims, language: doc.language === 'es' || doc.language === 'en' ? doc.language : null, sameRevision,
      basisIdentity: doc.profileRevisionId ? basisIdentity.get(doc.profileRevisionId) ?? null : null, currentIdentity,
      currentSource: (id) => { const fact = currentFact(id); return fact ? { fact, direct: fact.id === id } : undefined; },
    });
    const assistReady = doc.approvalStatus === 'USER_APPROVED' && currentContent;
    const reviewReady = doc.approvalStatus === 'PENDING_REVIEW' && currentContent;
    return { ...doc, reviewReady, jobId: doc.jobSnapshotId ? snapshotJobs.get(doc.jobSnapshotId) ?? null : null, reusableFactIds, missingFactCount: resolved.filter((id) => !id).length, assistReady };
  });
}
