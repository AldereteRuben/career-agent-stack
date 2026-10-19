import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { clearInterval, setInterval } from 'node:timers';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  aiConnections, aiRuns, aiDocumentRewordProposals,
  applicationDocuments, applicationDocumentRevisions, applications, jobSnapshots,
  profileFacts, profileVersions, type db,
} from '@career/db';
import {
  AI_SCHEMA_VERSION, aiSourceSnapshotSchema, applicationDocumentCurrentness, createApplicationDocumentRevision, printedResumeIdentity,
  latestApplicationDocumentOffer, validateAiOutput, validateApplicationDocumentAssistantProposal,
  type AiSourceSnapshot, type ApplicationDocumentFact, type ApplicationDocumentLanguage,
  type ApplicationDocumentRevision, type ApplicationDocumentRevisionClaim,
} from '@career/domain';
import { AI_NOTICE_VERSION } from './ai-run-routes.js';
import { buildAiPrompt, hashAiInputContent, hashAiPromptMessages, AI_PROMPT_VERSION } from './ai/prompts.js';
import { CODEX_DEFAULT_MODEL, executeCodex, type CodexExecutionResult } from './ai/codex.js';
import { AiQueueError, type AiQueue, type AiRunUsage } from './ai/queue.js';
import { lockKey, profileLockKey, type Executor } from './workspace-data.js';
import { lockJobIdentity } from './job-identity.js';
import { renderApplicationCoverLetter, renderApplicationResume, type ResumePaperSize } from './document-renderer.js';

type ActiveReword = { workspaceId: string; connectionId: string; controller: AbortController; task?: Promise<unknown> };
export function createAiDocumentRewordCancellation() {
  const active = new Map<string, ActiveReword>();
  return {
    attach(runId: string, item: ActiveReword) { active.set(runId, item); },
    track(runId: string, task: Promise<unknown>) { const item = active.get(runId); if (item) item.task = task; },
    detach(runId: string) { active.delete(runId); },
    cancelRun(runId: string) { const item = active.get(runId); if (item) item.controller.abort(); },
    cancelConnection(workspaceId: string, connectionId: string) {
      for (const item of active.values()) if (item.workspaceId === workspaceId && item.connectionId === connectionId) item.controller.abort();
    },
    async close() {
      for (const item of active.values()) item.controller.abort();
      await Promise.allSettled([...active.values()].flatMap(item => item.task ? [item.task] : []));
      active.clear();
    },
  };
}
export type AiDocumentRewordCancellation = ReturnType<typeof createAiDocumentRewordCancellation>;

type RewordOptions = {
  enabled: boolean; database: typeof db; storageRoot: string; identitySalt: string; queue: AiQueue;
  cancellation: AiDocumentRewordCancellation;
  execute?: typeof executeCodex;
  renderResume?: typeof renderApplicationResume;
  renderCoverLetter?: typeof renderApplicationCoverLetter;
  now?: () => Date;
};
export class AiDocumentRewordError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); this.name = 'AiDocumentRewordError'; }
}
const uuid = z.uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const previewBody = z.object({ revisionId: uuid }).strict();
const runBody = z.object({ revisionId: uuid, payloadSha256: sha256, confirmed: z.boolean(), origin: z.enum(['MANUAL','AUTOMATIC']).default('MANUAL') }).strict();
const acceptBody = z.object({ runId: uuid, revisionId: uuid, proposals: z.array(z.object({ sentenceId: z.string().min(1).max(200), text: z.string().trim().min(1).max(4000), sourceFactIds: z.array(uuid).min(1).max(50) }).strict()).min(1).max(50) }).strict();
const hashText = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const stableJson = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
});
const proposalHash = (proposal: { text: string; sourceFactIds: string[] }) => hashText(stableJson({ text: proposal.text, sourceFactIds: proposal.sourceFactIds }));
function proposalsMatchHashes(proposals: Array<{sentenceId:string;text:string;sourceFactIds:string[]}>, expected: Map<string,string>) {
  const ids=new Set(proposals.map(proposal=>proposal.sentenceId));
  return ids.size===expected.size&&proposals.length===expected.size&&[...expected.keys()].every(id=>ids.has(id))
    &&proposals.every(proposal=>expected.get(proposal.sentenceId)===proposalHash(proposal));
}

function rowRevision(row: typeof applicationDocumentRevisions.$inferSelect, language: ApplicationDocumentLanguage): ApplicationDocumentRevision {
  return { id: row.id, workspaceId: row.workspaceId, documentId: row.documentId, revision: row.revision, parentRevision: row.parentRevision,
    language, claims: row.claims as unknown as ApplicationDocumentRevisionClaim[], contentHash: row.contentHash, offerSnapshotId: row.offerSnapshotId,
    offerHash: row.offerHash, factsHash: row.factsHash, paperSize: row.paperSize as 'A4'|'LETTER', textSha256: row.textSha256,
    pdfSha256: row.pdfSha256, confirmedUnsupportedIds: row.confirmedUnsupportedIds, approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy };
}
type RewordState = {
  application: typeof applications.$inferSelect; document: typeof applicationDocuments.$inferSelect;
  revisionRow: typeof applicationDocumentRevisions.$inferSelect; revision: ApplicationDocumentRevision;
  facts: ApplicationDocumentFact[]; offer: NonNullable<Awaited<ReturnType<typeof latestApplicationDocumentOffer>>>; identity: ReturnType<typeof printedResumeIdentity>;
  language: ApplicationDocumentLanguage;
};

async function loadRewordState(executor: Executor, workspaceId: string, applicationId: string, documentId: string, revisionId: string): Promise<RewordState> {
  const application = (await executor.select().from(applications).where(and(eq(applications.workspaceId, workspaceId),eq(applications.id,applicationId))).limit(1))[0];
  if (!application) throw new AiDocumentRewordError('APPLICATION_NOT_FOUND',404);
  const document = (await executor.select().from(applicationDocuments).where(and(eq(applicationDocuments.workspaceId,workspaceId),eq(applicationDocuments.applicationId,applicationId),eq(applicationDocuments.id,documentId))).limit(1))[0];
  if (!document) throw new AiDocumentRewordError('APPLICATION_DOCUMENT_NOT_FOUND',404);
  if (!application.jobId) throw new AiDocumentRewordError('APPLICATION_HAS_NO_OFFER');
  const revisionRow = (await executor.select().from(applicationDocumentRevisions).where(and(eq(applicationDocumentRevisions.workspaceId,workspaceId),eq(applicationDocumentRevisions.documentId,document.id),eq(applicationDocumentRevisions.id,revisionId))).limit(1))[0];
  if (!revisionRow) throw new AiDocumentRewordError('APPLICATION_DOCUMENT_REVISION_NOT_FOUND',404);
  const latest = (await executor.select().from(applicationDocumentRevisions).where(and(eq(applicationDocumentRevisions.workspaceId,workspaceId),eq(applicationDocumentRevisions.documentId,document.id))).orderBy(desc(applicationDocumentRevisions.revision),desc(applicationDocumentRevisions.id)).limit(1))[0];
  if (!latest || latest.id !== revisionRow.id) throw new AiDocumentRewordError('APPLICATION_DOCUMENT_REVISION_CHANGED');
  const snapshots = await executor.select().from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId,workspaceId),eq(jobSnapshots.jobId,application.jobId))).orderBy(desc(jobSnapshots.fetchedAt),desc(jobSnapshots.id)).limit(1);
  const snapshot = snapshots[0];
  if (!snapshot) throw new AiDocumentRewordError('APPLICATION_HAS_NO_OFFER');
  const profile = (await executor.select().from(profileVersions).where(eq(profileVersions.workspaceId,workspaceId)).orderBy(desc(profileVersions.revision)).limit(1))[0];
  const factRows = profile ? await executor.select().from(profileFacts).where(and(eq(profileFacts.workspaceId,workspaceId),eq(profileFacts.profileVersionId,profile.id),eq(profileFacts.approvalStatus,'USER_APPROVED'))) : [];
  const facts: ApplicationDocumentFact[] = factRows.map(fact => ({ id:fact.id,workspaceId,kind:fact.kind,text:fact.statement,tags:fact.tags,approval:fact.approvalStatus }));
  const offer = latestApplicationDocumentOffer({workspaceId,company:application.company,role:application.role,location:application.location,
    snapshots:[{id:snapshot.id,title:snapshot.title,descriptionText:snapshot.descriptionText,fetchedAt:snapshot.fetchedAt.toISOString()}]});
  const language = document.language as ApplicationDocumentLanguage;
  const revision = rowRevision(revisionRow,language);
  const currentness = await applicationDocumentCurrentness({revision,facts:factRows.map(fact=>({id:fact.id,workspaceId,approval:fact.approvalStatus,text:fact.statement,tags:fact.tags})),offer});
  if (currentness.status !== 'CURRENT') throw new AiDocumentRewordError('APPLICATION_DOCUMENT_SOURCE_CHANGED');
  const citedIds = new Set(revision.claims.flatMap(claim=>claim.sourceFactIds));
  if ([...citedIds].some(id=>!facts.some(fact=>fact.id===id))) throw new AiDocumentRewordError('APPLICATION_DOCUMENT_SOURCE_CHANGED');
  return {application,document,revisionRow,revision,facts,offer,identity:printedResumeIdentity(profile?.profile??{}),language};
}

function buildDocumentSnapshot(workspaceId: string, state: RewordState): AiSourceSnapshot {
  const facts = new Map(state.facts.map(fact=>[fact.id,fact]));
  const sentences = state.revision.claims.filter(claim=>claim.kind==='CANDIDATE_CLAIM' && claim.origin!=='USER_UNSUPPORTED' && claim.sourceFactIds.length>0)
    .map(claim=>({sentenceId:claim.sentenceId,text:claim.text,kind:'CANDIDATE_CLAIM' as const,
      citedFacts:claim.sourceFactIds.map(factId=>({factId,text:facts.get(factId)!.text}))}));
  if (!sentences.length) throw new AiDocumentRewordError('NO_REWRITABLE_SENTENCES');
  const base = {
    schemaVersion:AI_SCHEMA_VERSION,snapshotId:state.revision.id,workspaceId,operation:'DOCUMENT_REWORD' as const,locale:state.language,
    snapshotHash:'0'.repeat(64),searchRequest:null,job:null,question:null,facts:[],profileRevision:null,identityFingerprint:null,
    documentReword:{documentId:state.document.id,revisionId:state.revision.id,revision:state.revision.revision,kind:state.document.kind as 'RESUME'|'COVER_LETTER',
      offer:{company:state.offer.company,role:state.offer.role,location:state.offer.location,title:state.offer.snapshot!.title,
        description:state.offer.snapshot!.descriptionText??''},sentences},
  };
  const parsed=aiSourceSnapshotSchema.parse(base);
  parsed.snapshotHash=hashAiInputContent(parsed);
  return parsed;
}

async function safeDirectory(root: string, directory: string) {
  await mkdir(root,{recursive:true,mode:0o700}); const realRoot=await realpath(root); const rootInfo=await lstat(realRoot);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw new Error('DOCUMENT_PATH_INVALID');
  const relativeDirectory=relative(resolve(root),resolve(directory));
  if(isAbsolute(relativeDirectory)||relativeDirectory==='..'||relativeDirectory.startsWith(`..${sep}`))throw new Error('DOCUMENT_PATH_INVALID');
  let current=realRoot;
  for(const part of relativeDirectory.split(sep).filter(Boolean)){
    current=join(current,part);try{await mkdir(current,{mode:0o700});}catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='EEXIST'))throw error;}
    const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('DOCUMENT_PATH_INVALID');
    const actual=await realpath(current),rel=relative(realRoot,actual);if(isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`))throw new Error('DOCUMENT_PATH_INVALID');
  }
}

function sourceFacts(state: RewordState) { return state.facts.map(fact=>({id:fact.id,workspaceId:fact.workspaceId,approval:fact.approval,text:fact.text,tags:fact.tags})); }
function sourceOffer(state: RewordState) { return {workspaceId:state.offer.workspaceId,company:state.offer.company,role:state.offer.role,location:state.offer.location,snapshot:state.offer.snapshot!}; }

export function registerAiApplicationDocumentRoutes(app: FastifyInstance, workspace: (request: FastifyRequest)=>string, options: RewordOptions) {
  const database=options.database; const now=options.now??(()=>new Date()); const activeConnections=async(workspaceId:string)=>(await database.select().from(aiConnections)
    .where(and(eq(aiConnections.workspaceId,workspaceId),eq(aiConnections.provider,'codex'),eq(aiConnections.active,true),eq(aiConnections.state,'CONNECTED'))).limit(1))[0];
  app.addHook('onRoute',route=>{
    if(!route.url.startsWith('/api/v1/applications/')||!route.url.includes('/document-reword'))return;
    route.errorHandler=(error,_request,reply)=>{
      if(error instanceof AiDocumentRewordError)return reply.code(error.status).send({error:error.code});
      if(error instanceof AiQueueError)return reply.code(error.code==='AI_BUSY'?409:503).send({error:error.code==='AI_BUSY'?'AI_BUSY':'AI_UNAVAILABLE'});
      if(error.statusCode===400||error.statusCode===413)return reply.code(error.statusCode).send({error:'INVALID_INPUT'});
      return reply.code(503).send({error:'AI_UNAVAILABLE'});
    };
  });

  app.post('/api/v1/applications/:applicationId/documents/:documentId/document-reword/preview',async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    if(!options.enabled)return reply.code(503).send({error:'AI_UNAVAILABLE'});
    const params=z.object({applicationId:uuid,documentId:uuid}).strict().safeParse(request.params),body=previewBody.safeParse(request.body);
    if(!params.success||!body.success)return reply.code(400).send({error:'INVALID_INPUT'});
    const workspaceId=workspace(request),state=await loadRewordState(database,workspaceId,params.data.applicationId,params.data.documentId,body.data.revisionId);
    const snapshot=buildDocumentSnapshot(workspaceId,state),prompt=buildAiPrompt(snapshot,{workspaceId,operation:'DOCUMENT_REWORD',locale:state.language});
    const payloadSha256=hashAiPromptMessages(prompt.messages);
    return {applicationId:params.data.applicationId,documentId:state.document.id,revisionId:state.revision.id,revision:state.revision.revision,
      provider:'codex',model:CODEX_DEFAULT_MODEL,operation:'DOCUMENT_REWORD',locale:state.language,categories:['APPROVED_FACTS','JOB_POSTING'],
      messages:prompt.messages,payloadSha256,sentences:snapshot.documentReword!.sentences.map(sentence=>({sentenceId:sentence.sentenceId,text:sentence.text,kind:sentence.kind,
        citedFacts:sentence.citedFacts.map(fact=>({factId:fact.factId,text:fact.text}))}))};
  });

  app.post('/api/v1/applications/:applicationId/documents/:documentId/document-reword',async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    if(!options.enabled)return reply.code(503).send({error:'AI_UNAVAILABLE'});
    const params=z.object({applicationId:uuid,documentId:uuid}).strict().safeParse(request.params),body=runBody.safeParse(request.body);
    if(!params.success||!body.success)return reply.code(400).send({error:'INVALID_INPUT'});
    if(body.data.origin==='AUTOMATIC')return reply.code(403).send({error:'CONSENT_REQUIRES_PERSON'});
    if(!body.data.confirmed)return {declined:true};
    if(request.raw.aborted)return reply.code(499).send({error:'REQUEST_ABORTED'});
    const workspaceId=workspace(request),state=await loadRewordState(database,workspaceId,params.data.applicationId,params.data.documentId,body.data.revisionId);
    const connection=await activeConnections(workspaceId);
    if(!connection)return reply.code(409).send({error:'AI_NOT_CONNECTED'});
    const snapshot=buildDocumentSnapshot(workspaceId,state),prompt=buildAiPrompt(snapshot,{workspaceId,operation:'DOCUMENT_REWORD',locale:state.language});
    const payloadSha256=hashAiPromptMessages(prompt.messages);
    if(payloadSha256!==body.data.payloadSha256)return reply.code(409).send({error:'PAYLOAD_CHANGED'});
    const citedFactIds=snapshot.documentReword!.sentences.flatMap(sentence=>sentence.citedFacts.map(fact=>fact.factId));
    const run=await options.queue.beginDocumentRun({workspaceId,connectionId:connection.id,connectionRevision:connection.revision,accountFingerprint:connection.accountFingerprint,
      model:CODEX_DEFAULT_MODEL,idempotencyKey:randomUUID(),contentIdentity:hashText(stableJson({payloadSha256,revisionId:state.revision.id})),payloadSha256,
      baseRevisionId:state.revision.id,citedFactIds:[...new Set(citedFactIds)],inputVersions:{documentId:state.document.id,revisionId:state.revision.id,
        revision:state.revision.revision,promptVersion:AI_PROMPT_VERSION,schemaVersion:AI_SCHEMA_VERSION},noticeVersion:AI_NOTICE_VERSION,now:now(),leaseMs:180_000});
    const controller=new AbortController();options.cancellation.attach(run.id,{workspaceId,connectionId:connection.id,controller});
    const abortIfDisconnected=()=>{if(request.raw.aborted||reply.raw.destroyed&&!reply.raw.writableEnded)controller.abort();};
    request.raw.once('aborted',abortIfDisconnected);reply.raw.once('close',abortIfDisconnected);
    // The request may have disconnected while source/connection reads were awaited above.
    abortIfDisconnected();
    const timer=setInterval(()=>{void options.queue.heartbeatDocumentRun(run.id,run.leaseToken,180_000,now()).then(ok=>{if(!ok)controller.abort();},()=>controller.abort());},25_000);timer.unref();
    let finished=false;let observed:CodexExecutionResult|undefined;
    const task=(async()=>{
      try{
        if(controller.signal.aborted)throw new Error('CANCELLED');
        observed=await (options.execute??executeCodex)(snapshot,connection.accountFingerprint,options.identitySalt,controller.signal,CODEX_DEFAULT_MODEL);
        if(controller.signal.aborted)throw new Error('CANCELLED');
        const validated=validateAiOutput(observed.output,snapshot,{workspaceId,operation:'DOCUMENT_REWORD',locale:state.language});
        if(!validated.ok||validated.output.operation!=='DOCUMENT_REWORD')throw new Error('INVALID_OUTPUT');
        const proposals=validated.output.proposals.map(proposal=>{
          const original=state.revision.claims.find(claim=>claim.sentenceId===proposal.sentenceId);
          if(!original)throw new Error('INVALID_OUTPUT');
          const sentence={...original,text:proposal.text,sourceFactIds:proposal.sourceFactIds,origin:'CODEX' as const};
          const checked=validateApplicationDocumentAssistantProposal({sentence,original,workspaceId,facts:state.facts,offer:sourceOffer(state)});
          if(!checked.ok)throw new Error('INVALID_OUTPUT');
          return {sentenceId:proposal.sentenceId,text:proposal.text,sourceFactIds:proposal.sourceFactIds};
        });
        const usage:AiRunUsage={availability:'KNOWN',model:observed.model,inputTokens:observed.usage.inputTokens,outputTokens:observed.usage.outputTokens};
        const status=await options.queue.finishDocumentRun(run.id,run.leaseToken,{status:'SUCCEEDED',proposalHashes:proposals.map(proposal=>({sentenceId:proposal.sentenceId,proposalSha256:proposalHash(proposal)})),usage,now:now()});
        finished=true;
        if(status!=='SUCCEEDED')return reply.code(409).send({error:status==='CANCELLED'?'AI_CANCELLED':'AI_PROPOSAL_EXPIRED'});
        return reply.send({runId:run.id,status,baseRevisionId:state.revision.id,proposals});
      }catch(error){
        const cancelled=controller.signal.aborted||error instanceof Error&&error.message==='CANCELLED';
        const status=await options.queue.finishDocumentRun(run.id,run.leaseToken,{status:'FAILED',error:{code:cancelled?'CANCELLED':'INVALID_OUTPUT',dispatched:observed?'YES':'UNKNOWN'},
          ...(observed?{usage:{availability:'KNOWN',model:observed.model,inputTokens:observed.usage.inputTokens,outputTokens:observed.usage.outputTokens} as AiRunUsage}:{}),now:now()});
        finished=true;
        if(status==='CANCELLED')return reply.code(409).send({error:'AI_CANCELLED'});
        if(status===null)return reply.code(409).send({error:'AI_PROPOSAL_EXPIRED'});
        return reply.code(cancelled?499:503).send({error:cancelled?'REQUEST_ABORTED':'AI_UNAVAILABLE'});
      }finally{
        clearInterval(timer);request.raw.off('aborted',abortIfDisconnected);reply.raw.off('close',abortIfDisconnected);
        if(!finished){await options.queue.finishDocumentRun(run.id,run.leaseToken,{status:'FAILED',error:{code:'INTERNAL',dispatched:observed?'YES':'UNKNOWN'},now:now()}).catch(()=>undefined);}
        options.cancellation.detach(run.id);
      }
    })();
    options.cancellation.track(run.id,task);
    return task;
  });

  app.post('/api/v1/applications/:applicationId/documents/:documentId/document-reword/accept',async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    const params=z.object({applicationId:uuid,documentId:uuid}).strict().safeParse(request.params),body=acceptBody.safeParse(request.body);
    if(!params.success||!body.success)return reply.code(400).send({error:'INVALID_INPUT'});
    if(!options.storageRoot)return reply.code(503).send({error:'DOCUMENT_STORAGE_UNAVAILABLE'});
    const workspaceId=workspace(request),{runId,revisionId}=body.data;
    const run=(await database.select().from(aiRuns).where(and(eq(aiRuns.workspaceId,workspaceId),eq(aiRuns.id,runId))).limit(1))[0];
    if(!run||run.operation!=='DOCUMENT_REWORD'||run.status!=='SUCCEEDED')return reply.code(409).send({error:'AI_PROPOSAL_EXPIRED'});
    const meta=run.snapshot as {payloadSha256?:unknown;baseRevisionId?:unknown;citedFactIds?:unknown};
    if(meta.baseRevisionId!==revisionId)return reply.code(409).send({error:'AI_PROPOSAL_EXPIRED'});
    const rows=await database.select().from(aiDocumentRewordProposals).where(and(eq(aiDocumentRewordProposals.workspaceId,workspaceId),eq(aiDocumentRewordProposals.runId,runId)));
    if(!rows.length)return reply.code(409).send({error:'AI_PROPOSAL_EXPIRED'});
    const expected=new Map(rows.map(row=>[row.sentenceId,row.proposalSha256]));
    if(!proposalsMatchHashes(body.data.proposals,expected))return reply.code(422).send({error:'PROPOSAL_MISMATCH'});
    const initial=await loadRewordState(database,workspaceId,params.data.applicationId,params.data.documentId,revisionId);
    const claims=initial.revision.claims.map(claim=>{
      const proposal=body.data.proposals.find(item=>item.sentenceId===claim.sentenceId);
      if(!proposal)return claim;
      const sentence={...claim,text:proposal.text,sourceFactIds:proposal.sourceFactIds,origin:'CODEX' as const};
      const checked=validateApplicationDocumentAssistantProposal({sentence,original:claim,workspaceId,facts:initial.facts,offer:sourceOffer(initial)});
      if(!checked.ok)throw new AiDocumentRewordError('PROPOSAL_MISMATCH',422);
      return sentence;
    });
    const revisionIdNew=randomUUID(),text=claims.map(claim=>claim.text).join('\n');
    if(Buffer.byteLength(text,'utf8')>40_000)return reply.code(413).send({error:'APPLICATION_DOCUMENT_SIZE_LIMIT'});
    const textSha256=hashText(text),root=resolve(options.storageRoot),directory=`${workspaceId}/application-documents/${initial.document.id}`;
    const relativeDirectory=relative(resolve(options.storageRoot),resolve(root,directory));
    if(isAbsolute(relativeDirectory)||relativeDirectory==='..'||relativeDirectory.startsWith(`..${sep}`))return reply.code(500).send({error:'DOCUMENT_PATH_INVALID'});
    const textStoragePath=`${directory}/${revisionIdNew}.txt`,pdfStoragePath=`${directory}/${revisionIdNew}.pdf`;
    const textPath=resolve(root,textStoragePath),pdfPath=resolve(root,pdfStoragePath);let committed=false;
    try{
      await safeDirectory(root,dirname(textPath));await writeFile(textPath,text,{flag:'wx',mode:0o600});
      const rendered=initial.document.kind==='RESUME'
        ? await (options.renderResume??renderApplicationResume)({path:pdfPath,fullName:initial.identity.fullName,email:initial.identity.email,role:initial.application.role,locale:initial.language,paperSize:initial.revision.paperSize as ResumePaperSize,sentences:claims})
        : await (options.renderCoverLetter??renderApplicationCoverLetter)({path:pdfPath,locale:initial.language,paperSize:initial.revision.paperSize as ResumePaperSize,sentences:claims});
      const bytes=await (await import('node:fs/promises')).readFile(pdfPath);
      const pdfSha256=createHash('sha256').update(bytes).digest('hex');
      if(pdfSha256!==rendered.sha256)throw new Error('PDF_DIGEST_MISMATCH');
      const created=await createApplicationDocumentRevision({id:revisionIdNew,workspaceId,documentId:initial.document.id,language:initial.language,
        claims,facts:sourceFacts(initial),offer:initial.offer,paperSize:initial.revision.paperSize as 'A4'|'LETTER',textSha256,pdfSha256,previousRevision:initial.revision});
      if(!created.ok)throw new AiDocumentRewordError('APPLICATION_DOCUMENT_INVALID');
      await database.transaction(async tx=>{
        await lockKey(tx,'career-ai-queue-v1');await lockJobIdentity(tx,workspaceId);await lockKey(tx,profileLockKey(workspaceId));
        const currentDocument=(await tx.select().from(applicationDocuments).where(and(eq(applicationDocuments.workspaceId,workspaceId),eq(applicationDocuments.applicationId,params.data.applicationId),eq(applicationDocuments.id,params.data.documentId))).limit(1).for('update'))[0];
        if(!currentDocument)throw new AiDocumentRewordError('APPLICATION_DOCUMENT_NOT_FOUND',404);
        const currentRun=(await tx.select().from(aiRuns).where(and(eq(aiRuns.workspaceId,workspaceId),eq(aiRuns.id,runId))).limit(1).for('update'))[0];
        if(!currentRun||currentRun.operation!=='DOCUMENT_REWORD'||currentRun.status!=='SUCCEEDED')throw new AiDocumentRewordError('AI_PROPOSAL_EXPIRED');
        const currentHashes=await tx.select().from(aiDocumentRewordProposals).where(and(eq(aiDocumentRewordProposals.workspaceId,workspaceId),eq(aiDocumentRewordProposals.runId,runId)));
        const currentExpected=new Map(currentHashes.map(row=>[row.sentenceId,row.proposalSha256]));
        if(!proposalsMatchHashes(body.data.proposals,currentExpected))throw new AiDocumentRewordError('PROPOSAL_MISMATCH',422);
        const latest=(await tx.select().from(applicationDocumentRevisions).where(and(eq(applicationDocumentRevisions.workspaceId,workspaceId),eq(applicationDocumentRevisions.documentId,currentDocument.id))).orderBy(desc(applicationDocumentRevisions.revision),desc(applicationDocumentRevisions.id)).limit(1).for('update'))[0];
        if(!latest||latest.id!==revisionId)throw new AiDocumentRewordError('APPLICATION_DOCUMENT_REVISION_CHANGED');
        const current=await loadRewordState(tx,workspaceId,params.data.applicationId,currentDocument.id,revisionId);
        if(stableJson(current.identity)!==stableJson(initial.identity))throw new AiDocumentRewordError('APPLICATION_DOCUMENT_SOURCE_CHANGED');
        const finalClaims=current.revision.claims.map(claim=>{
          const proposal=body.data.proposals.find(item=>item.sentenceId===claim.sentenceId);if(!proposal)return claim;
          const sentence={...claim,text:proposal.text,sourceFactIds:proposal.sourceFactIds,origin:'CODEX' as const};
          const checked=validateApplicationDocumentAssistantProposal({sentence,original:claim,workspaceId,facts:current.facts,offer:sourceOffer(current)});
          if(!checked.ok)throw new AiDocumentRewordError('PROPOSAL_MISMATCH',422);return sentence;
        });
        const final=await createApplicationDocumentRevision({id:revisionIdNew,workspaceId,documentId:current.document.id,language:current.language,claims:finalClaims,
          facts:sourceFacts(current),offer:current.offer,paperSize:current.revision.paperSize as 'A4'|'LETTER',textSha256,pdfSha256,previousRevision:current.revision});
        if(!final.ok||final.revision.contentHash!==created.revision.contentHash)throw new AiDocumentRewordError('APPLICATION_DOCUMENT_SOURCE_CHANGED');
        await tx.insert(applicationDocumentRevisions).values({id:revisionIdNew,workspaceId,documentId:current.document.id,revision:final.revision.revision,
          parentRevision:final.revision.parentRevision,claims:finalClaims as unknown as Array<Record<string,unknown>>,contentHash:final.revision.contentHash,
          offerSnapshotId:final.revision.offerSnapshotId,offerHash:final.revision.offerHash,factsHash:final.revision.factsHash,paperSize:final.revision.paperSize,
          textStoragePath,textSha256,pdfStoragePath,pdfSha256,confirmedUnsupportedIds:[],approvedAt:null,approvedBy:null});
      });
      committed=true;
      return reply.code(201).send({documentId:initial.document.id,revision:created.revision,text});
    }catch(error){
      if(!committed){
        try{committed=(await database.select({id:applicationDocumentRevisions.id}).from(applicationDocumentRevisions).where(and(eq(applicationDocumentRevisions.workspaceId,workspaceId),eq(applicationDocumentRevisions.id,revisionIdNew))).limit(1)).length>0;}
        catch{return reply.code(503).send({error:'APPLICATION_DOCUMENT_SAVE_UNCERTAIN'});}
        if(!committed)await Promise.all([unlink(textPath).catch(()=>undefined),unlink(pdfPath).catch(()=>undefined)]);
      }
      throw error;
    }
  });
}
