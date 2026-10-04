import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { documentVersions, profileFacts, profileVersions, jobSnapshots } from '@career/db';
import { approveDerivedClaims, derivedClaimsBasisSchema, derivedClaimsCurrentness, documentClaimsContract, printedContentCurrent, printedResumeIdentity, printedStatement, type DerivedClaimsState } from '@career/domain';
import { latestFacts, latestProfile, type Executor } from './workspace-data.js';
import { loadAiSourceRecords } from './ai/source-reader.js';
import { AiSourceError, buildAiSourceSnapshot } from './ai/source-snapshot.js';

type Fact = typeof profileFacts.$inferSelect;
type Document = typeof documentVersions.$inferSelect;

// Profile saves copy facts with their original creation timestamp and content.
// Match only unchanged copies, never approximate text or a newly edited entry.
const copyKey = (fact: Fact) => JSON.stringify([fact.createdAt.toISOString(), fact.kind, fact.statement, fact.tags, fact.source, fact.details ?? null]);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textHash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Derived sentences retain their own exact wording; approval is tied to the PDF and evidence, not literal fact equality. */
export async function derivedDocumentState(executor: Executor, workspaceId: string, document: Document) {
  const parsed = derivedClaimsBasisSchema.safeParse(document.claimsBasis);
  if (!parsed.success || document.claimsContractVersion !== 1 || parsed.data.language !== document.language) return null;
  const basis = parsed.data;
  if (basis.claims.length !== document.claims.length || basis.claims.some((claim,index) => claim.textHash !== textHash(claim.text)
    || claim.text !== document.claims[index]?.text || JSON.stringify(claim.sourceFactIds) !== JSON.stringify(document.claims[index]?.sourceFactIds))) return null;
  const profile = await latestProfile(executor, workspaceId);
  const current = (await latestFacts(executor, workspaceId, profile?.id)).filter(fact=>fact.approvalStatus==='USER_APPROVED');
  const ids = [...new Set(basis.claims.flatMap(claim=>claim.sourceFactIds))];
  const historical = ids.length ? await executor.select().from(profileFacts).where(and(eq(profileFacts.workspaceId,workspaceId),inArray(profileFacts.id,ids))) : [];
  const originals = new Map(historical.map(fact=>[fact.id,fact]));
  const byId = new Map(current.map(fact=>[fact.id,fact]));
  const resolved = new Map(ids.map(id=>{
    const original=originals.get(id);
    const copies=original ? current.filter(fact=>copyKey(fact)===copyKey(original)) : [];
    return [id,byId.get(id) ?? (copies.length===1 ? copies[0] : undefined)] as const;
  }));
  let targetJobHash: string | null = null;
  if (basis.targetJob) {
    const request = { operation:'JOB_ANALYSIS' as const,locale:basis.language,jobId:basis.targetJob.jobId,selectedFactIds:[] };
    const records=await loadAiSourceRecords(executor,workspaceId,request);
    if (records.job && records.jobSnapshot) {
      try { targetJobHash=buildAiSourceSnapshot(workspaceId,request,records).job!.contentHash; }
      catch(error) { if (!(error instanceof AiSourceError)) throw error; }
    }
  }
  const state: DerivedClaimsState = {workspaceId,identityFingerprint:profile?hash(printedResumeIdentity(profile.profile)):null,pdfHash:document.sha256,targetJobHash,
    currentFact:id=>{const fact=resolved.get(id);return fact?{factId:id,workspaceId:fact.workspaceId,approvalStatus:fact.approvalStatus,contentHash:hash([fact.kind,printedStatement(fact,basis.language).trim()])}:undefined;}};
  const currentness=derivedClaimsCurrentness(basis,state);
  return {basis,state,currentness,reusableFactIds:[...new Set([...resolved.values()].flatMap(fact=>fact?[fact.id]:[]))],missingFactCount:[...resolved.values()].filter(fact=>!fact).length};
}

/** Call with the profile lock held; returns a replacement basis only after exact PDF/text acknowledgement. */
export async function approveDerivedDocument(executor: Executor, workspaceId: string, document: Document, body: {expectedPdfHash?:unknown;expectedClaimTextHashes?:unknown}) {
  const context=await derivedDocumentState(executor,workspaceId,document);
  if (!context || context.currentness.status==='STALE' || (context.basis.targetJob && context.state.targetJobHash!==context.basis.targetJob.contentHash)) return {error:'PROFILE_CHANGED_REGENERATE_DOCUMENT'} as const;
  if (typeof body.expectedPdfHash!=='string' || !Array.isArray(body.expectedClaimTextHashes) || !body.expectedClaimTextHashes.every(value=>typeof value==='string')) return {error:'DOCUMENT_REVIEW_CHANGED'} as const;
  const result=approveDerivedClaims(context.basis,{expectedClaimTextHashes:body.expectedClaimTextHashes as string[],pdfHash:body.expectedPdfHash,approvedAt:new Date().toISOString(),state:context.state});
  return result.ok ? {basis:result.basis} : {error:result.reason==='STALE'?'PROFILE_CHANGED_REGENERATE_DOCUMENT':'DOCUMENT_REVIEW_CHANGED'} as const;
}

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
  const [current, sources, snapshots, bases] = [
    await latestFacts(executor, workspaceId, profile?.id),
    sourceIds.length ? await executor.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), inArray(profileFacts.id, sourceIds))) : [],
    snapshotIds.length ? await executor.select({ id: jobSnapshots.id, jobId: jobSnapshots.jobId }).from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, workspaceId), inArray(jobSnapshots.id, snapshotIds))) : [],
    basisIds.length ? await executor.select({ id: profileVersions.id, profile: profileVersions.profile }).from(profileVersions).where(and(eq(profileVersions.workspaceId, workspaceId), inArray(profileVersions.id, basisIds))) : [],
  ] as const;
  const snapshotJobs = new Map(snapshots.map((row) => [row.id, row.jobId]));
  const approved = current.filter((fact) => fact.approvalStatus === 'USER_APPROVED');
  const approvedById = new Map(approved.map((fact) => [fact.id, fact]));
  const copies = new Map(approved.map((fact) => [copyKey(fact), fact]));
  const originals = new Map(sources.map((fact) => [fact.id, fact]));
  const basisIdentity = new Map(bases.map((row) => [row.id, printedResumeIdentity(row.profile)]));
  const currentIdentity = profile ? printedResumeIdentity(profile.profile) : null;
  const currentFact = (id: string) => approvedById.get(id) ?? (originals.has(id) ? copies.get(copyKey(originals.get(id)!)) : undefined);
  const readiness = async (doc: Document) => {
    if (documentClaimsContract(doc)!=='legacy') {
      const context=await derivedDocumentState(executor,workspaceId,doc);
      const targetCurrent=Boolean(context && (!context.basis.targetJob || context.state.targetJobHash===context.basis.targetJob.contentHash));
      const current=context?.currentness.status==='CURRENT';
      return {...doc,reviewReady:doc.approvalStatus==='PENDING_REVIEW' && Boolean(context && context.currentness.status!=='STALE' && targetCurrent),
        assistReady:doc.approvalStatus==='USER_APPROVED' && current,jobId:context?.basis.targetJob?.jobId ?? null,
        reusableFactIds:context?.reusableFactIds ?? [],missingFactCount:context?.missingFactCount ?? doc.claims.length,
        derivedStatus:context?.currentness.status ?? 'STALE'};
    }
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
  };
  const results=[];
  for (const document of documents) results.push(await readiness(document));
  return results;
}
