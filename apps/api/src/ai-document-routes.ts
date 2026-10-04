import { createHash, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { aiArtifacts, aiRuns, documentVersions, type db } from '@career/db';
import { aiSourceSnapshotSchema, claimsFromResumeProposals, derivedClaimsBasisSchema, documentFileName, entryStatement, legacyEmployment, printedResumeIdentity, validateAiOutput, type AiSourceSnapshot, type DerivedClaim, type ResumeDraftOutput } from '@career/domain';
import { documentReadiness } from './document-reuse.js';
import { renderResume } from './document-renderer.js';
import { lockKey, profileLockKey, type Executor } from './workspace-data.js';
import { lockJobIdentity } from './job-identity.js';
import { checkAiSourceCurrent, type AiSourceRecords } from './ai/source-snapshot.js';
import { checkCurrentAiSnapshot, loadAiSourceRecords } from './ai/source-reader.js';

export const aiResumeSelectionSchema=z.object({expectedRevision:z.number().int().positive(),name:z.string().trim().min(1).max(200),
  selections:z.array(z.object({proposalKey:z.string().min(1).max(160),text:z.string().trim().min(1).max(4000)}).strict()).min(1).max(50),
  includeOriginalFactIds:z.array(z.uuid()).max(50).optional(),
}).strict();
type Selection=z.infer<typeof aiResumeSelectionSchema>;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export class AiDocumentError extends Error {constructor(readonly code:string){super(code);this.name='AiDocumentError';}}
const view=<T extends {id:string;name:string;revision:number;approvalStatus:string}>(row:T)=>({...row,reviewRequired:row.approvalStatus==='PENDING_REVIEW',fileName:documentFileName(row.name,row.revision),downloadUrl:`/api/v1/documents/${row.id}/file`});

/** Local composition: preserve selected evidence and structured dates independently of proposed wording. */
export function buildAiResumeClaims(artifactId:string,snapshot:AiSourceSnapshot,output:ResumeDraftOutput,selection:Selection,records:AiSourceRecords){
  const current=checkAiSourceCurrent(snapshot,snapshot.workspaceId,records);
  if(!current.ok || !records.profile || !snapshot.identityFingerprint)throw new AiDocumentError('AI_SOURCE_CHANGED');
  const currentFacts=new Map((records.facts??[]).map(fact=>[fact.id,fact]));
  const resolved=new Map(current.resolvedFacts.map(pair=>[pair.sourceFactId,currentFacts.get(pair.currentFactId)]));
  const evidence=new Map(snapshot.facts.map(fact=>[fact.factId,fact]));
  const proposals=new Map(output.proposals.map(proposal=>[proposal.proposalKey,proposal]));
  const result=claimsFromResumeProposals({artifactId,workspaceId:snapshot.workspaceId,language:snapshot.locale,output,snapshot,
    selections:selection.selections.map(item=>({proposalKey:item.proposalKey,claimId:randomUUID(),finalText:item.text,finalTextHash:hash(item.text),proposedTextHash:hash(proposals.get(item.proposalKey)?.text??'')})),
    currentFact:id=>{const fact=resolved.get(id),source=evidence.get(id);return fact&&source?{factId:id,workspaceId:fact.workspaceId,approvalStatus:fact.approvalStatus,contentHash:source.contentHash}:undefined;},
  });
  if(!result.ok)throw new AiDocumentError('AI_INVALID_SELECTION');
  const claims:DerivedClaim[]=[];
  const covered=new Set(result.claims.flatMap(claim=>claim.sourceFactIds));
  const keep=selection.includeOriginalFactIds??snapshot.facts.filter(fact=>!covered.has(fact.factId)).map(fact=>fact.factId);
  if(new Set(keep).size!==keep.length || keep.some(id=>!evidence.has(id)))throw new AiDocumentError('AI_INVALID_SELECTION');
  const original=(factId:string,text:string):DerivedClaim=>{const source=evidence.get(factId)!;return {claimId:randomUUID(),section:source.kind,text,textHash:hash(text),sourceFactIds:[factId],sourceFingerprints:[{factId,contentHash:source.contentHash}],language:snapshot.locale,origin:'MANUAL',artifactId:null,proposalKey:null};};
  // Section names come from saved fact kinds, not model labels. Keep each heading next to its rewritten description.
  const printedHeadings=new Set<string>();
  const kinds=new Set(['experience','current_employment','achievement','project','skill_evidence','skill','education','certification','language']);
  for(const claim of result.claims){
    const sourceKind=evidence.get(claim.sourceFactIds[0]!)!.kind;
    claim.section=kinds.has(sourceKind)?sourceKind:'achievement';
    for(const id of claim.sourceFactIds){
      if(keep.includes(id)||printedHeadings.has(id))continue;
      const fact=resolved.get(id)!;const structured=fact.details??legacyEmployment(fact.kind,fact.statement);
      if(!structured)continue;
      const heading=entryStatement({...structured,description:''},snapshot.locale);
      if(!claim.text.includes(heading))claims.push(original(id,heading));
      printedHeadings.add(id);
    }
    claims.push(claim);
  }
  claims.push(...keep.map(id=>original(id,evidence.get(id)!.text)));
  if(claims.length>50 || claims.reduce((sum,claim)=>sum+claim.text.length,0)>40_000)throw new AiDocumentError('AI_DOCUMENT_LIMIT');
  const basis=derivedClaimsBasisSchema.safeParse({claimsContractVersion:1,workspaceId:snapshot.workspaceId,language:snapshot.locale,profileRevision:records.profile.revision,identityFingerprint:snapshot.identityFingerprint,targetJob:snapshot.job?{jobId:snapshot.job.jobId,contentHash:snapshot.job.contentHash}:null,claims,approval:null});
  if(!basis.success)throw new AiDocumentError('AI_DOCUMENT_LIMIT');
  return basis.data;
}

export function registerAiDocumentRoutes(app:FastifyInstance,workspace:(request:FastifyRequest)=>string,options:{database:typeof db;storageRoot:string;render?:typeof renderResume}){
  const database=options.database;
  const existingDocument=async(tx:Executor,workspaceId:string,artifactId:string)=>(await tx.select().from(documentVersions).where(and(eq(documentVersions.workspaceId,workspaceId),sql`${documentVersions.claimsBasis}->'claims' @> ${JSON.stringify([{artifactId}])}::jsonb`)).limit(1))[0];
  app.post('/api/v1/ai/artifacts/:id/resume',{errorHandler:(error,_request,reply)=>reply.code(error instanceof AiDocumentError?409:503).send({error:error instanceof AiDocumentError?error.code:'AI_DOCUMENT_UNAVAILABLE'})},async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    const params=z.object({id:z.uuid()}).strict().safeParse(request.params),body=aiResumeSelectionSchema.safeParse(request.body);
    if(!params.success||!body.success)return reply.code(400).send({error:'INVALID_INPUT'});
    const workspaceId=workspace(request),artifactId=params.data.id,selection=body.data;
    const requestHash=hash(JSON.stringify({name:selection.name,selections:selection.selections,includeOriginalFactIds:selection.includeOriginalFactIds??null}));
    const prepared=await database.transaction(async tx=>{
      await lockJobIdentity(tx,workspaceId);await lockKey(tx,profileLockKey(workspaceId));
      const artifact=(await tx.select().from(aiArtifacts).where(and(eq(aiArtifacts.workspaceId,workspaceId),eq(aiArtifacts.id,artifactId))).limit(1).for('update'))[0];
      if(!artifact)throw new AiDocumentError('AI_ARTIFACT_NOT_FOUND');
      if(artifact.state==='ACCEPTED' && artifact.approvedHash===requestHash){const prior=await existingDocument(tx,workspaceId,artifactId);if(prior)return {prior};}
      if(artifact.state!=='PENDING_REVIEW'||artifact.revision!==selection.expectedRevision)throw new AiDocumentError('AI_REVIEW_CHANGED');
      const run=(await tx.select().from(aiRuns).where(and(eq(aiRuns.workspaceId,workspaceId),eq(aiRuns.id,artifact.runId))).limit(1))[0];
      const parsed=aiSourceSnapshotSchema.safeParse(run?.snapshot);
      if(!parsed.success||run?.status!=='SUCCEEDED'||parsed.data.operation!=='RESUME_DRAFT')throw new AiDocumentError('AI_ARTIFACT_NOT_AVAILABLE');
      const snapshot=parsed.data,validated=validateAiOutput(artifact.output,snapshot,{workspaceId,operation:'RESUME_DRAFT',locale:snapshot.locale});
      if(!validated.ok||validated.output.operation!=='RESUME_DRAFT')throw new AiDocumentError('AI_ARTIFACT_NOT_AVAILABLE');
      const records=await loadAiSourceRecords(tx,workspaceId,snapshot);
      const basis=buildAiResumeClaims(artifactId,snapshot,validated.output,selection,records);
      return {basis,snapshot,profile:records.profile!,posting:records.jobSnapshot!,identity:printedResumeIdentity(records.profile!.profile),role:records.job?.title??''};
    });
    if('prior' in prepared)return reply.code(200).send(view((await documentReadiness(database,workspaceId,[prepared.prior!]))[0]!));
    const docId=randomUUID(),storageRoot=resolve(options.storageRoot),relativePath=`${workspaceId}/${docId}.pdf`,filePath=resolve(storageRoot,relativePath),rel=relative(storageRoot,filePath);
    if(isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`))throw new AiDocumentError('AI_DOCUMENT_UNAVAILABLE');
    const cleanup=()=>unlink(filePath).catch(()=>undefined);
    let persisted=false;
    try{
      const rendered=await (options.render??renderResume)({path:filePath,fullName:prepared.identity.fullName,email:prepared.identity.email,role:prepared.role,locale:prepared.basis.language,facts:prepared.basis.claims.map(claim=>({kind:claim.section,statement:claim.text,tags:[]}))});
      const result=await database.transaction(async tx=>{
        await lockJobIdentity(tx,workspaceId);await lockKey(tx,profileLockKey(workspaceId));
        const artifact=(await tx.select().from(aiArtifacts).where(and(eq(aiArtifacts.workspaceId,workspaceId),eq(aiArtifacts.id,artifactId))).limit(1).for('update'))[0];
        if(artifact?.state==='ACCEPTED'&&artifact.approvedHash===requestHash){const prior=await existingDocument(tx,workspaceId,artifactId);if(prior)return {row:prior,created:false};}
        if(!artifact||artifact.state!=='PENDING_REVIEW'||artifact.revision!==selection.expectedRevision)throw new AiDocumentError('AI_REVIEW_CHANGED');
        if(!(await checkCurrentAiSnapshot(tx,workspaceId,prepared.snapshot)).ok)throw new AiDocumentError('AI_SOURCE_CHANGED');
        await lockKey(tx,`document:${workspaceId}:${selection.name}`);
        const max=(await tx.select({revision:sql<number>`coalesce(max(${documentVersions.revision}),0)::int`}).from(documentVersions).where(and(eq(documentVersions.workspaceId,workspaceId),eq(documentVersions.name,selection.name))))[0]?.revision??0;
        const row=(await tx.insert(documentVersions).values({id:docId,workspaceId,name:selection.name,revision:max+1,language:prepared.basis.language,profileRevisionId:prepared.profile.id,jobSnapshotId:prepared.posting.id,mediaType:'application/pdf',storagePath:relativePath,sha256:rendered.sha256,
          claims:prepared.basis.claims.map(claim=>({text:claim.text,sourceFactIds:claim.sourceFactIds,approvalStatus:'PENDING_REVIEW'})),claimsContractVersion:1,claimsBasis:prepared.basis,approvalStatus:'PENDING_REVIEW'}).returning())[0]!;
        await tx.update(aiArtifacts).set({state:'ACCEPTED',revision:artifact.revision+1,approvedAt:new Date(),approvedHash:requestHash}).where(and(eq(aiArtifacts.workspaceId,workspaceId),eq(aiArtifacts.id,artifactId)));
        return {row,created:true};
      });
      persisted=result.created;
      if(!persisted)await cleanup();
      return reply.code(result.created?201:200).send({...view((await documentReadiness(database,workspaceId,[result.row]))[0]!),...(result.created?{sizeBytes:rendered.size}:{})});
    }catch(error){if(!persisted)await cleanup();throw error;}
  });
}
