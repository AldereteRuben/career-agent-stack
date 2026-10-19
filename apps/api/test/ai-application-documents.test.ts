import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@career/db';
import { buildAiPrompt, hashAiPromptMessages } from '../src/ai/prompts.js';
import { CODEX_DEFAULT_MODEL, executeCodex, type CodexExecutionResult } from '../src/ai/codex.js';
import { createAiDocumentRewordCancellation, registerAiApplicationDocumentRoutes } from '../src/ai-application-document-routes.js';
import { createAiQueue } from '../src/ai/queue.js';
import { createAiWorker } from '../src/ai/worker.js';
import { createAiHistoryService } from '../src/ai/history.js';
import { createRequestGate, releaseOnResponse } from '../src/request-gate.js';
import { registerAiRunRoutes } from '../src/ai-run-routes.js';
import { registerApplicationResumeRoutes } from '../src/application-resume-routes.js';

const root = new URL('../../../', import.meta.url);
const { Client, Pool } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_V090_ROUTES_TEST_ADMIN_URL;
const digest = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');

test('document reword previews exact content, requires one-off confirmation, runs synchronously, and accepts only hashed proposals', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl!);
  assert.ok(['127.0.0.1','localhost','::1'].includes(maintenance.hostname));
  assert.equal(maintenance.pathname,'/postgres');
  const databaseName=`career_ai_docs_${randomBytes(5).toString('hex')}`;
  const admin=new Client({connectionString:maintenance.toString()}); const app=Fastify({logger:false});const requestGate=createRequestGate();
  app.addHook('onRequest',async(request,reply)=>{if(!requestGate.enter(request))return reply.code(503).send({error:'DELETION_IN_PROGRESS'});});
  releaseOnResponse(app,requestGate);
  app.post('/test/workspace/delete-all',async(request,reply)=>{
    const result=await requestGate.close(25,request);
    if(result==='timeout'){requestGate.open(request);return reply.code(503).send({error:'DELETION_BUSY'});}
    if(result==='busy')return reply.code(409).send({error:'DELETION_IN_PROGRESS'});
    requestGate.open(request);return reply.send({deleted:true});
  });
  const filesRoot=await mkdtemp(join(tmpdir(),'career-ai-document-reword-'));
  const cancellation=createAiDocumentRewordCancellation();
  let pool:InstanceType<typeof Pool>|undefined;let closePool:(()=>Promise<void>)|undefined;let client:InstanceType<typeof Client>|undefined;
  try{
    await admin.connect();await admin.query(`CREATE DATABASE "${databaseName}"`);
    maintenance.pathname=`/${databaseName}`;client=new Client({connectionString:maintenance.toString()});await client.connect();
    for(const file of (await readdir(new URL('packages/db/migrations',root))).filter(file=>/^\d{4}_.*\.sql$/u.test(file)).sort()){
      for(const statement of (await readFile(new URL(`packages/db/migrations/${file}`,root),'utf8')).split('--> statement-breakpoint').filter(text=>text.trim()))await client.query(statement);
    }
    pool=new Pool({connectionString:maintenance.toString(),max:8});closePool=trackPgPoolCleanup(pool);const database=drizzle(pool,{schema});const queue=createAiQueue(pool);
    const workspaceId=randomUUID(),applicationId=randomUUID(),jobId=randomUUID(),connectionId=randomUUID(),profileVersionId=randomUUID(),factId=randomUUID(),secondFactId=randomUUID(),unselectedFactId=randomUUID(),privateFactId=randomUUID();
    const fingerprint='a'.repeat(64);const providerCalls:Array<{snapshot:unknown;payloadSha256:string}>=[];let holdNext:{entered:()=>void;promise:Promise<void>;aborted?:()=>void}|undefined;let holdRender:{entered:()=>void;promise:Promise<void>}|undefined;let invalidOutput=false;let currentTime=new Date();const controlDay=currentTime.toISOString().slice(0,10);
    await client.query('INSERT INTO workspaces(id) VALUES($1)',[workspaceId]);
    await client.query("INSERT INTO jobs(id,workspace_id,company,title,availability) VALUES($1,$2,'Synthetic Systems','Support Engineer','OPEN')",[jobId,workspaceId]);
    await client.query("INSERT INTO applications(id,workspace_id,job_id,company,role,location) VALUES($1,$2,$3,'Synthetic Systems','Support Engineer','Madrid')",[applicationId,workspaceId,jobId]);
    await client.query("INSERT INTO job_snapshots(workspace_id,job_id,title,description_text,snapshot_hash) VALUES($1,$2,'Support Engineer','Help customers solve product issues.','synthetic-offer-hash')",[workspaceId,jobId]);
    await client.query("INSERT INTO profile_versions(id,workspace_id,revision,profile) VALUES($1,$2,1,$3)",[profileVersionId,workspaceId,{identity:{fullName:'Synthetic Candidate',email:'candidate@example.test'}}]);
    await client.query("INSERT INTO profile_facts(id,workspace_id,profile_version_id,kind,statement,approval_status) VALUES($1,$2,$3,'experience','I helped customers solve product issues using Python.','USER_APPROVED')",[factId,workspaceId,profileVersionId]);
    await client.query("INSERT INTO profile_facts(id,workspace_id,profile_version_id,kind,statement,approval_status) VALUES($1,$2,$3,'experience','I resolved billing questions using SQL.','USER_APPROVED'),($4,$2,$3,'experience','I built an internal reporting dashboard for an open source community.','USER_APPROVED'),($5,$2,$3,'experience','Private unapproved Kubernetes credential.','REJECTED')",[secondFactId,workspaceId,profileVersionId,unselectedFactId,privateFactId]);
    await client.query("INSERT INTO ai_connections(id,workspace_id,provider,account_fingerprint,revision,state,active) VALUES($1,$2,'codex',$3,1,'CONNECTED',true)",[connectionId,workspaceId,fingerprint]);
    await client.query("INSERT INTO ai_consents(workspace_id,connection_id,provider,account_fingerprint,connection_revision,revision,operation,data_categories,search_ids,notice_version,remembered) VALUES($1,$2,'codex',$3,1,1,'DOCUMENT_REWORD',$4::jsonb,NULL,'v1',true)",[workspaceId,connectionId,fingerprint,JSON.stringify(['APPROVED_FACTS','JOB_POSTING'])]);
    const workspace=()=>workspaceId;
    registerApplicationResumeRoutes(app,workspace,{database,storageRoot:filesRoot,render:async({path,sentences})=>{const pdf=Buffer.from(`%PDF-1.7\n${sentences.map(sentence=>sentence.text).join('\n')}\n`);await writeFile(path,pdf,{flag:'wx',mode:0o600});return{absolutePath:path,sha256:digest(pdf),size:pdf.byteLength};}});
    registerAiRunRoutes(app,workspace,{enabled:true,database,queue,cancelRun:id=>cancellation.cancelRun(id)});
    const execute:typeof executeCodex=async(input,accountFingerprint,_salt,signal):Promise<CodexExecutionResult>=>{
      const prompt=buildAiPrompt(input,{workspaceId,operation:'DOCUMENT_REWORD',locale:input.locale});
      providerCalls.push({snapshot:input,payloadSha256:hashAiPromptMessages(prompt.messages)});
      const held=holdNext;holdNext=undefined;
      if(held){held.entered();await new Promise<void>((resolve,reject)=>{if(signal?.aborted){held.aborted?.();reject(new Error('cancelled'));return;}signal?.addEventListener('abort',()=>{held.aborted?.();reject(new Error('cancelled'));},{once:true});held.promise.then(resolve,reject);});}
      const doc=input.documentReword!;
      const output={schemaVersion:1,operation:'DOCUMENT_REWORD',locale:input.locale,proposals:doc.sentences.map(sentence=>({sentenceId:sentence.sentenceId,text:sentence.text,sourceFactIds:sentence.citedFacts.map(fact=>fact.factId)}))};
      if(invalidOutput)output.proposals[0]!.sourceFactIds=['foreign-fact-id'];
      return {output,inputContentHash:prompt.inputContentHash,model:CODEX_DEFAULT_MODEL,cliVersion:'0.163.0',usage:{inputTokens:42,cachedInputTokens:0,outputTokens:12},account:{status:'SIGNED_IN',version:'0.163.0',billing:'CHATGPT_PLAN',accountFingerprint,maskedIdentity:'s***@example.test',plan:'plus',usage:{}}} as unknown as CodexExecutionResult;
    };
    const renderResume=async({path,sentences}:{path:string;sentences:readonly {text:string}[]})=>{
      const held=holdRender;holdRender=undefined;if(held){held.entered();await held.promise;}
      const pdf=Buffer.from(`%PDF-1.7\n${sentences.map(sentence=>sentence.text).join('\n')}\n`);await writeFile(path,pdf,{flag:'wx',mode:0o600});
      return{absolutePath:path,sha256:digest(pdf),size:pdf.byteLength};
    };
    registerAiApplicationDocumentRoutes(app,workspace,{enabled:true,database,storageRoot:filesRoot,identitySalt:'f'.repeat(32),queue,cancellation,execute,renderResume,now:()=>currentTime});
    const headers={};
    const created=await app.inject({method:'POST',url:`/api/v1/applications/${applicationId}/resume/revisions`,headers,payload:{language:'en'}});
    assert.equal(created.statusCode,201,created.body);const documentId=created.json().documentId as string;let revisionId=created.json().revision.id as string;
    const claims=created.json().revision.claims as Array<{sentenceId:string;text:string;sourceFactIds:string[]}>;
    assert.ok(claims.length>=3,'fixture has multiple independently sourced candidate claims');
    const unsupportedClaim=claims.find(claim=>claim.sourceFactIds.includes(factId))!;
    const unselectedClaim=claims.find(claim=>claim.sourceFactIds.includes(unselectedFactId))!;
    const edited=await app.inject({method:'POST',url:`/api/v1/applications/${applicationId}/resume/revisions`,payload:{language:'en',parentRevisionId:revisionId,
      sentences:claims.filter(claim=>claim.sentenceId!==unselectedClaim.sentenceId).map(claim=>({sentenceId:claim.sentenceId,text:claim.sentenceId===unsupportedClaim.sentenceId?`${claim.text} and I am certified in Kubernetes`:claim.text,sourceFactIds:claim.sourceFactIds})),confirmUnsupportedIds:[unsupportedClaim.sentenceId]}});
    assert.equal(edited.statusCode,201,edited.body);revisionId=edited.json().revision.id as string;
    const previewUrl=`/api/v1/applications/${applicationId}/documents/${documentId}/document-reword/preview`;
    const runUrl=`/api/v1/applications/${applicationId}/documents/${documentId}/document-reword`;
    const acceptUrl=`/api/v1/applications/${applicationId}/documents/${documentId}/document-reword/accept`;
    const preview=await app.inject({method:'POST',url:previewUrl,payload:{revisionId}});
    assert.equal(preview.statusCode,200,preview.body);assert.deepEqual(preview.json().categories,['APPROVED_FACTS','JOB_POSTING']);
    assert.equal(preview.json().messages[1].content.includes('Synthetic Candidate'),false,'printed identity is never sent to Codex');
    assert.equal(preview.json().messages[1].content.includes('I resolved billing questions using SQL.'),true);
    assert.equal(preview.json().messages[1].content.includes('I built an internal reporting dashboard for an open source community.'),false,'approved but uncited profile facts are not sent');
    assert.equal(preview.json().messages[1].content.includes('Kubernetes'),false,'USER_UNSUPPORTED sentences are excluded from preview');
    assert.equal(preview.json().messages[1].content.includes('Private unapproved Kubernetes credential.'),false,'unapproved profile facts are excluded');
    const beforeCounts=await client.query('SELECT (SELECT count(*)::int FROM ai_runs WHERE workspace_id=$1) AS runs,(SELECT count(*)::int FROM ai_consents WHERE workspace_id=$1 AND operation=$2) AS consents',[workspaceId,'DOCUMENT_REWORD']);
    const declined=await app.inject({method:'POST',url:runUrl,payload:{revisionId,payloadSha256:preview.json().payloadSha256,confirmed:false}});
    assert.equal(declined.json().declined,true);assert.equal(providerCalls.length,0);
    assert.equal((await app.inject({method:'POST',url:runUrl,payload:{revisionId,payloadSha256:preview.json().payloadSha256,confirmed:true,origin:'AUTOMATIC'}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:runUrl,payload:{revisionId,payloadSha256:'0'.repeat(64),confirmed:true}})).json().error,'PAYLOAD_CHANGED');
    const afterRefusals=await client.query('SELECT (SELECT count(*)::int FROM ai_runs WHERE workspace_id=$1) AS runs,(SELECT count(*)::int FROM ai_consents WHERE workspace_id=$1 AND operation=$2) AS consents',[workspaceId,'DOCUMENT_REWORD']);
    assert.deepEqual(afterRefusals.rows[0],beforeCounts.rows[0],'declining, automatic origin and changed payload create no consent or run');
    const completed=await app.inject({method:'POST',url:runUrl,payload:{revisionId,payloadSha256:preview.json().payloadSha256,confirmed:true}});
    assert.equal(completed.statusCode,200,completed.body);assert.equal(providerCalls.length,1);
    assert.equal(providerCalls[0]!.payloadSha256,preview.json().payloadSha256,'provider messages hash to the preview hash');
    const runId=completed.json().runId as string;
    const runRow=(await client.query('SELECT * FROM ai_runs WHERE workspace_id=$1 AND id=$2',[workspaceId,runId])).rows[0]!;
    assert.equal(runRow.status,'SUCCEEDED');assert.equal((runRow.snapshot as Record<string,unknown>).baseRevisionId,revisionId);
    const storedSnapshot=JSON.stringify(runRow.snapshot);for(const secret of ['I helped customers','Python','product issues'])assert.equal(storedSnapshot.includes(secret),false);
    const consent=(await client.query('SELECT * FROM ai_consents WHERE workspace_id=$1 AND id=$2',[workspaceId,runRow.consent_id])).rows[0]!;
    assert.equal(consent.remembered,false);assert.equal(consent.revision,2,'remembered consent does not authorize a run; confirmation creates the next one-off revision');assert.deepEqual(consent.data_categories,['APPROVED_FACTS','JOB_POSTING']);
    assert.equal(runRow.snapshot_hash,preview.json().payloadSha256);assert.equal((runRow.snapshot as Record<string,unknown>).payloadSha256,preview.json().payloadSha256);
    assert.deepEqual((runRow.snapshot as {citedFactIds:string[]}).citedFactIds,[secondFactId]);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM ai_document_reword_proposals WHERE workspace_id=$1 AND run_id=$2',[workspaceId,runId])).rows[0]!.count,completed.json().proposals.length);
    assert.equal((await client.query('SELECT status FROM llm_usage WHERE workspace_id=$1 AND ai_run_id=$2',[workspaceId,runId])).rows[0]!.status,'SUCCEEDED');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM ai_account_leases WHERE run_id=$1',[runId])).rows[0]!.count,0,'successful completion releases the account lease');
    const aiTables=await client.query("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='workspace_id' AND (table_name LIKE 'ai\\_%' ESCAPE '\\' OR table_name='llm_usage') GROUP BY table_name");
    for(const row of aiTables.rows){
      const tableName=String(row.table_name).replaceAll('"','""');
      const persisted=String((await client.query(`SELECT coalesce(string_agg(to_jsonb(t)::text,E'\\n'),'') AS content FROM "${tableName}" t WHERE workspace_id=$1`,[workspaceId])).rows[0]!.content);
      for(const privateText of ['I helped customers','Python','product issues','I resolved billing questions','SQL','I built an internal reporting dashboard','open source community','Synthetic Candidate','candidate@example.test','Kubernetes'])assert.equal(persisted.includes(privateText),false,`${tableName} never stores source, identity, unsupported or proposal text`);
    }
    const proposals=completed.json().proposals;
    const mismatch=await app.inject({method:'POST',url:acceptUrl,payload:{runId,revisionId,proposals:[{...proposals[0],text:`${proposals[0].text} 12 years`}]}});
    assert.equal(mismatch.statusCode,422);assert.equal(mismatch.json().error,'PROPOSAL_MISMATCH');
    const citationMismatch=await app.inject({method:'POST',url:acceptUrl,payload:{runId,revisionId,proposals:[{...proposals[0],sourceFactIds:[randomUUID()]}]}});
    assert.equal(citationMismatch.statusCode,422);assert.equal(citationMismatch.json().error,'PROPOSAL_MISMATCH');
    const unknownSentence=await app.inject({method:'POST',url:acceptUrl,payload:{runId,revisionId,proposals:[{...proposals[0],sentenceId:'never-proposed'}]}});
    assert.equal(unknownSentence.statusCode,422);assert.equal(unknownSentence.json().error,'PROPOSAL_MISMATCH');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM application_document_revisions WHERE workspace_id=$1 AND document_id=$2',[workspaceId,documentId])).rows[0]!.count,2,'invalid accept payloads create no revision');
    const accepts=await Promise.all([app.inject({method:'POST',url:acceptUrl,payload:{runId,revisionId,proposals}}),app.inject({method:'POST',url:acceptUrl,payload:{runId,revisionId,proposals}})]);
    assert.deepEqual(accepts.map(response=>response.statusCode).sort(),[201,409],'concurrent accepts have exactly one winner');
    const accepted=accepts.find(response=>response.statusCode===201)!;assert.ok(accepted.json().revision.id!==revisionId);
    const acceptedClaim=accepted.json().revision.claims.find((claim:{origin:string})=>claim.origin==='CODEX');assert.ok(acceptedClaim);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM application_document_revisions WHERE workspace_id=$1 AND document_id=$2',[workspaceId,documentId])).rows[0]!.count,3);
    assert.equal((await readdir(join(filesRoot,workspaceId,'application-documents',documentId))).length,6,'the losing concurrent accept removes its rendered files');
    const replay=await app.inject({method:'POST',url:acceptUrl,payload:{runId,revisionId,proposals}});
    assert.equal(replay.statusCode,409,'the same assistant run cannot be accepted twice');

    const newRevisionId=accepted.json().revision.id as string;
    const nextPreview=await app.inject({method:'POST',url:previewUrl,payload:{revisionId:newRevisionId}});
    assert.equal(nextPreview.statusCode,200,nextPreview.body);
    let markEntered!:()=>void;let release!:()=>void;const entered=new Promise<void>(resolve=>{markEntered=resolve;});const held=new Promise<void>(resolve=>{release=resolve;});holdNext={entered:markEntered,promise:held};
    const inFlights=[app.inject({method:'POST',url:runUrl,payload:{revisionId:newRevisionId,payloadSha256:nextPreview.json().payloadSha256,confirmed:true}}),
      app.inject({method:'POST',url:runUrl,payload:{revisionId:newRevisionId,payloadSha256:nextPreview.json().payloadSha256,confirmed:true}})];
    await entered;
    const busyResult=await Promise.race(inFlights);assert.equal(busyResult.statusCode,409);assert.equal(busyResult.json().error,'AI_BUSY');
    const active=(await client.query("SELECT id,lease_token,consent_id FROM ai_runs WHERE workspace_id=$1 AND operation='DOCUMENT_REWORD' AND status='RUNNING' ORDER BY created_at DESC LIMIT 1",[workspaceId])).rows[0]!;
    const deletionBlocked=await app.inject({method:'POST',url:'/test/workspace/delete-all'});
    assert.equal(deletionBlocked.statusCode,503);assert.deepEqual(deletionBlocked.json(),{error:'DELETION_BUSY'},'workspace deletion waits for the active document request');
    assert.equal(await queue.heartbeatDocumentRun(String(active.id),String(active.lease_token),180_000,currentTime),true);
    const activeLease=new Date(currentTime.getTime()+180_000);
    assert.equal(new Date((await client.query('SELECT lease_until FROM ai_runs WHERE id=$1',[active.id])).rows[0]!.lease_until as string|Date).getTime(),activeLease.getTime());
    assert.equal(new Date((await client.query('SELECT lease_until FROM ai_account_leases WHERE run_id=$1',[active.id])).rows[0]!.lease_until as string|Date).getTime(),activeLease.getTime());
    assert.equal(await queue.heartbeatDocumentRun(String(active.id),randomUUID(),180_000,currentTime),false,'a stale lease token cannot extend either lease');
    currentTime=new Date(currentTime.getTime()+60_000);
    assert.equal(await queue.heartbeatDocumentRun(String(active.id),String(active.lease_token),180_000,currentTime),true,'the route renews the leases after the original lease window advances');
    const renewedLease=currentTime.getTime()+180_000;
    assert.equal(new Date((await client.query('SELECT lease_until FROM ai_runs WHERE id=$1',[active.id])).rows[0]!.lease_until as string|Date).getTime(),renewedLease);
    assert.equal(new Date((await client.query('SELECT lease_until FROM ai_account_leases WHERE run_id=$1',[active.id])).rows[0]!.lease_until as string|Date).getTime(),renewedLease);
    const stillBusy=await app.inject({method:'POST',url:runUrl,payload:{revisionId:newRevisionId,payloadSha256:nextPreview.json().payloadSha256,confirmed:true}});
    assert.equal(stillBusy.statusCode,409);assert.equal(stillBusy.json().error,'AI_BUSY','a live account lease continues to exclude duplicate runs');
    assert.equal(await queue.recoverAfterRestart(),0,'validity recovery leaves the route-owned run alone');
    assert.equal((await client.query('SELECT status FROM ai_runs WHERE id=$1',[active.id])).rows[0]!.status,'RUNNING');
    const providerCallsBeforeWorker=providerCalls.length;
    const worker=createAiWorker({pool,queue,identitySalt:'f'.repeat(32),enabled:true},{platform:'darwin',execute});
    await Promise.all([worker.runOnce(),queue.recoverAfterRestart()]);
    await worker.stop();
    assert.equal(providerCalls.length,providerCallsBeforeWorker,'the real queue worker never executes a synchronous document run');
    assert.equal((await client.query('SELECT status FROM ai_runs WHERE id=$1',[active.id])).rows[0]!.status,'RUNNING');
    const cancelled=await app.inject({method:'POST',url:`/api/v1/ai/runs/${active.id}/cancel`});
    assert.equal(cancelled.statusCode,200);release();
    const inFlightResponses=await Promise.all(inFlights);const cancelledResponse=inFlightResponses.find(response=>response.json().error==='AI_CANCELLED');
    assert.ok(cancelledResponse);assert.equal(cancelledResponse.statusCode,409);
    assert.deepEqual((await app.inject({method:'POST',url:'/test/workspace/delete-all'})).json(),{deleted:true},'deletion proceeds after the request and run finish');
    assert.equal((await client.query('SELECT status FROM ai_runs WHERE id=$1',[active.id])).rows[0]!.status,'CANCELLED');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM ai_document_reword_proposals WHERE run_id=$1',[active.id])).rows[0]!.count,0);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM ai_account_leases WHERE run_id=$1',[active.id])).rows[0]!.count,0,'cancellation releases the account lease');
    assert.equal((await client.query('SELECT manual_reserved FROM ai_daily_budgets WHERE workspace_id=$1',[workspaceId])).rowCount,0,'document runs do not reserve a daily manual budget');
    assert.equal((await client.query('SELECT reserved_day::text AS reserved_day FROM ai_runs WHERE id=$1',[runId])).rows[0]!.reserved_day,controlDay);

    let consentEntered!:()=>void;let releaseConsent!:()=>void;const consentStarted=new Promise<void>(resolve=>{consentEntered=resolve;});const consentHold=new Promise<void>(resolve=>{releaseConsent=resolve;});holdNext={entered:consentEntered,promise:consentHold};
    const consentRequest=app.inject({method:'POST',url:runUrl,payload:{revisionId:newRevisionId,payloadSha256:nextPreview.json().payloadSha256,confirmed:true}});
    await consentStarted;
    const consentRun=(await client.query("SELECT id,consent_id FROM ai_runs WHERE workspace_id=$1 AND operation='DOCUMENT_REWORD' AND status='RUNNING' ORDER BY created_at DESC LIMIT 1",[workspaceId])).rows[0]!;
    assert.equal(await queue.revokeConsent(workspaceId,String(consentRun.consent_id)),1);
    cancellation.cancelRun(String(consentRun.id));releaseConsent();
    const revokedConsentResponse=await consentRequest;
    assert.equal(revokedConsentResponse.statusCode,409);assert.equal(revokedConsentResponse.json().error,'AI_CANCELLED');
    assert.equal((await client.query('SELECT status FROM ai_runs WHERE id=$1',[consentRun.id])).rows[0]!.status,'CANCELLED');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM ai_document_reword_proposals WHERE run_id=$1',[consentRun.id])).rows[0]!.count,0);

    await client.query('INSERT INTO ai_account_leases(account_lock_key,run_id,workspace_id,lease_token,lease_owner,lease_until) VALUES($1,$2,$3,$4,\'stale-test\',$5)',
      [fingerprint,runId,workspaceId,randomUUID(),new Date(currentTime.getTime()-1_000)]);
    invalidOutput=true;
    const rejected=await app.inject({method:'POST',url:runUrl,payload:{revisionId:newRevisionId,payloadSha256:nextPreview.json().payloadSha256,confirmed:true}});
    assert.equal(rejected.statusCode,503);assert.equal(rejected.json().error,'AI_UNAVAILABLE','fact-adding provider output is rejected');
    const rejectedRun=(await client.query("SELECT id FROM ai_runs WHERE workspace_id=$1 AND operation='DOCUMENT_REWORD' AND status='FAILED' ORDER BY created_at DESC LIMIT 1",[workspaceId])).rows[0]!;
    assert.equal((await client.query('SELECT count(*)::int AS count FROM ai_account_leases WHERE account_lock_key=$1',[fingerprint])).rows[0]!.count,0,'expired account lease is removed before the upsert');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM ai_document_reword_proposals WHERE workspace_id=$1 AND run_id=$2',[workspaceId,rejectedRun.id])).rows[0]!.count,0);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM ai_account_leases WHERE run_id=$1',[rejectedRun.id])).rows[0]!.count,0,'invalid provider output releases the account lease');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM application_document_revisions WHERE workspace_id=$1 AND document_id=$2',[workspaceId,documentId])).rows[0]!.count,3,'invalid provider output creates no document revision');

    invalidOutput=false;
    const crashPreview=await app.inject({method:'POST',url:previewUrl,payload:{revisionId:newRevisionId}});
    let crashEntered!:()=>void;let releaseCrash!:()=>void;const crashStarted=new Promise<void>(resolve=>{crashEntered=resolve;});const crashHold=new Promise<void>(resolve=>{releaseCrash=resolve;});holdNext={entered:crashEntered,promise:crashHold};
    const crashRequest=app.inject({method:'POST',url:runUrl,payload:{revisionId:newRevisionId,payloadSha256:crashPreview.json().payloadSha256,confirmed:true}});
    await crashStarted;
    const crashRun=(await client.query("SELECT id,lease_token,lease_until FROM ai_runs WHERE workspace_id=$1 AND operation='DOCUMENT_REWORD' AND status='RUNNING' ORDER BY created_at DESC LIMIT 1",[workspaceId])).rows[0]!;
    const priorLease=new Date(crashRun.lease_until as string|Date).getTime();
    assert.equal(await queue.heartbeatDocumentRun(String(crashRun.id),String(crashRun.lease_token),180_000,currentTime),true);
    assert.equal(new Date((await client.query('SELECT lease_until FROM ai_runs WHERE id=$1',[crashRun.id])).rows[0]!.lease_until as string|Date).getTime(),currentTime.getTime()+180_000);
    currentTime=new Date(currentTime.getTime()+181_000);
    assert.equal(await queue.recoverAfterRestart(currentTime),1,'an expired route-owned lease is recoverable after a process crash');
    assert.equal((await client.query('SELECT status FROM ai_runs WHERE id=$1',[crashRun.id])).rows[0]!.status,'INTERRUPTED');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM ai_account_leases WHERE run_id=$1',[crashRun.id])).rows[0]!.count,0);
    releaseCrash();const crashResponse=await crashRequest;
    assert.equal(crashResponse.statusCode,409);assert.equal(crashResponse.json().error,'AI_PROPOSAL_EXPIRED','a late route result cannot overwrite an interrupted run');
    assert.equal((await client.query('SELECT status FROM ai_runs WHERE id=$1',[crashRun.id])).rows[0]!.status,'INTERRUPTED');
    assert.ok(priorLease<currentTime.getTime());

    const identityPreview=await app.inject({method:'POST',url:previewUrl,payload:{revisionId:newRevisionId}});
    const identityRun=await app.inject({method:'POST',url:runUrl,payload:{revisionId:newRevisionId,payloadSha256:identityPreview.json().payloadSha256,confirmed:true}});
    assert.equal(identityRun.statusCode,200,identityRun.body);
    const consentRevisions=await client.query("SELECT revision,remembered FROM ai_consents WHERE workspace_id=$1 AND connection_id=$2 AND operation='DOCUMENT_REWORD' ORDER BY revision",[workspaceId,connectionId]);
    assert.deepEqual(consentRevisions.rows.map((row:{revision:number;remembered:boolean})=>[row.revision,row.remembered]),[[1,true],[2,false],[3,false],[4,false],[5,false],[6,false],[7,false]]);
    let renderEntered!:()=>void;let releaseRender!:()=>void;const renderStarted=new Promise<void>(resolve=>{renderEntered=resolve;});const renderHold=new Promise<void>(resolve=>{releaseRender=resolve;});holdRender={entered:renderEntered,promise:renderHold};
    const identityAccept=app.inject({method:'POST',url:acceptUrl,payload:{runId:identityRun.json().runId,revisionId:newRevisionId,proposals:identityRun.json().proposals}});
    await renderStarted;
    await client.query("UPDATE profile_versions SET profile=jsonb_set(profile,'{identity,fullName}','\"Changed Candidate\"'::jsonb) WHERE workspace_id=$1 AND id=$2",[workspaceId,profileVersionId]);
    releaseRender();
    const staleIdentity=await identityAccept;
    assert.equal(staleIdentity.statusCode,409);assert.equal(staleIdentity.json().error,'APPLICATION_DOCUMENT_SOURCE_CHANGED','identity edits during rendering cannot commit a stale PDF');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM application_document_revisions WHERE workspace_id=$1 AND document_id=$2',[workspaceId,documentId])).rows[0]!.count,3);
    assert.equal((await readdir(join(filesRoot,workspaceId,'application-documents',documentId))).length,6,'a rejected stale-identity accept removes its rendered files');

    const disconnectPreview=await app.inject({method:'POST',url:previewUrl,payload:{revisionId:newRevisionId}});
    let disconnectEntered!:()=>void;let releaseDisconnect!:()=>void;let providerAbort!:()=>void;const disconnectStarted=new Promise<void>(resolve=>{disconnectEntered=resolve;});const disconnectHold=new Promise<void>(resolve=>{releaseDisconnect=resolve;});const providerAbortSeen=new Promise<void>(resolve=>{providerAbort=resolve;});holdNext={entered:disconnectEntered,promise:disconnectHold,aborted:providerAbort};
    await app.listen({host:'127.0.0.1',port:0});
    const address=app.server.address() as {port:number};const abortController=new AbortController();
    const disconnectRequest=fetch(`http://127.0.0.1:${address.port}${runUrl}`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({revisionId:newRevisionId,payloadSha256:disconnectPreview.json().payloadSha256,confirmed:true}),signal:abortController.signal}).catch(()=>undefined);
    await disconnectStarted;
    const disconnectRun=(await client.query("SELECT id FROM ai_runs WHERE workspace_id=$1 AND operation='DOCUMENT_REWORD' AND status='RUNNING' ORDER BY created_at DESC LIMIT 1",[workspaceId])).rows[0]!;
    abortController.abort();
    const didAbort=await Promise.race([providerAbortSeen.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),1_000))]);
    assert.equal(didAbort,true,'the provider signal is aborted after the HTTP client disconnects');
    releaseDisconnect();await disconnectRequest;
    let disconnectStatus='RUNNING';for(let attempt=0;attempt<40&&disconnectStatus==='RUNNING';attempt++){
      await new Promise(resolve=>setTimeout(resolve,25));disconnectStatus=String((await client.query('SELECT status FROM ai_runs WHERE id=$1',[disconnectRun.id])).rows[0]!.status);
    }
    assert.equal(disconnectStatus,'FAILED','client disconnect aborts the provider and fails the run');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM ai_account_leases WHERE run_id=$1',[disconnectRun.id])).rows[0]!.count,0);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM ai_document_reword_proposals WHERE run_id=$1',[disconnectRun.id])).rows[0]!.count,0);

    const connectionPreview=await app.inject({method:'POST',url:previewUrl,payload:{revisionId:newRevisionId}});
    let connectionEntered!:()=>void;let releaseConnection!:()=>void;const connectionStarted=new Promise<void>(resolve=>{connectionEntered=resolve;});const connectionHold=new Promise<void>(resolve=>{releaseConnection=resolve;});holdNext={entered:connectionEntered,promise:connectionHold};
    const connectionRequest=app.inject({method:'POST',url:runUrl,payload:{revisionId:newRevisionId,payloadSha256:connectionPreview.json().payloadSha256,confirmed:true}});
    await connectionStarted;
    const connectionRun=(await client.query("SELECT id FROM ai_runs WHERE workspace_id=$1 AND operation='DOCUMENT_REWORD' AND status='RUNNING' ORDER BY created_at DESC LIMIT 1",[workspaceId])).rows[0]!;
    assert.equal(await queue.revokeConnection(workspaceId,connectionId),1);
    cancellation.cancelConnection(workspaceId,connectionId);releaseConnection();
    const revokedConnectionResponse=await connectionRequest;
    assert.equal(revokedConnectionResponse.statusCode,409);assert.equal(revokedConnectionResponse.json().error,'AI_CANCELLED');
    assert.equal((await client.query('SELECT status FROM ai_runs WHERE id=$1',[connectionRun.id])).rows[0]!.status,'CANCELLED');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM ai_document_reword_proposals WHERE run_id=$1',[connectionRun.id])).rows[0]!.count,0);

    const history=createAiHistoryService({pool,now:()=>currentTime});
    await client.query('UPDATE ai_runs SET completed_at=$2 WHERE workspace_id=$1 AND id=$3',[workspaceId,new Date(currentTime.getTime()-31*86_400_000),identityRun.json().runId]);
    const pruned=await history.pruneOnce();assert.equal(pruned.deleted.runs,1,'retention removes expired document reword history');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM ai_document_reword_proposals WHERE workspace_id=$1 AND run_id=$2',[workspaceId,identityRun.json().runId])).rows[0]!.count,0,'proposal hashes cascade with retained run deletion');
    const expiredAccept=await app.inject({method:'POST',url:acceptUrl,payload:{runId:identityRun.json().runId,revisionId:newRevisionId,proposals:identityRun.json().proposals}});
    assert.equal(expiredAccept.statusCode,409);assert.equal(expiredAccept.json().error,'AI_PROPOSAL_EXPIRED');
    await history.close();
  }finally{
    await cancellation.close();await app.close();await closePool?.();await client?.end().catch(()=>{});
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(()=>{});await admin.end().catch(()=>{});await rm(filesRoot,{recursive:true,force:true});
  }
});
