import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@career/db';
import type { ResumeDraftOutput } from '@career/domain';
import { aiResumeSelectionSchema, buildAiResumeClaims, registerAiDocumentRoutes } from '../src/ai-document-routes.js';
import { approveDerivedDocument, documentReadiness } from '../src/document-reuse.js';
import { buildAiSourceSnapshot, type AiSourceRecords } from '../src/ai/source-snapshot.js';
import { latestReusableAnswers } from '../src/ai/answer-current.js';
import { renderResume } from '../src/document-renderer.js';

const root=new URL('../../../',import.meta.url),hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const {Client,Pool}=createRequire(new URL('packages/db/package.json',root))('pg');
function fixture(){
  const workspaceId=randomUUID(),profileId=randomUUID(),factId=randomUUID(),jobId=randomUUID(),otherId=randomUUID();
  const fact={id:factId,workspaceId,profileVersionId:profileId,kind:'experience',statement:'Built tests',details:{type:'employment' as const,title:'QA engineer',organization:'Synthetic',startMonth:'2020-01',current:true,locale:'en' as const,description:'Built tests'},tags:[],source:'USER_ENTERED',approvalStatus:'USER_APPROVED',createdAt:new Date('2020-01-01')};
  const other={...fact,id:otherId,kind:'skill',statement:'TypeScript',details:null};
  const records:AiSourceRecords={profile:{id:profileId,workspaceId,revision:1,profile:{identity:{fullName:'Synthetic Person',email:'synthetic@example.test'}}},facts:[fact,other],job:{id:jobId,workspaceId,title:'QA',company:'Synthetic',location:null},jobSnapshot:{id:randomUUID(),workspaceId,jobId,title:'QA',descriptionText:'Build automated tests'}};
  const snapshot=buildAiSourceSnapshot(workspaceId,{operation:'RESUME_DRAFT',locale:'en',jobId,selectedFactIds:[factId,otherId]},records);
  const output:ResumeDraftOutput={schemaVersion:1,operation:'RESUME_DRAFT',locale:'en',proposals:[{proposalKey:'experience-1',section:'Experience',text:'Built reliable tests',sourceFactIds:[factId],changeExplanation:'Clear wording',warnings:[]}],warnings:[]};
  const body=aiResumeSelectionSchema.parse({expectedRevision:1,name:'Synthetic CV',selections:[{proposalKey:'experience-1',text:'Built reliable tests'}]});
  return {workspaceId,profileId,factId,otherId,jobId,records,snapshot,output,body};
}

test('AI resume composition keeps omitted job dates and unselected original evidence locally',()=>{
  const f=fixture(),basis=buildAiResumeClaims(randomUUID(),f.snapshot,f.output,f.body,f.records);
  assert.equal(basis.approval,null);assert.equal(basis.claims.length,3);
  assert.equal(basis.claims[0]!.text,'QA engineer · Synthetic\n01/2020 - Present');assert.equal(basis.claims[0]!.origin,'MANUAL');
  assert.equal(basis.claims[1]!.section,'experience');assert.equal(basis.claims[1]!.text,'Built reliable tests');assert.equal(basis.claims[1]!.origin,'AI');
  assert.equal(basis.claims[2]!.text,'TypeScript');assert.equal(basis.claims[2]!.origin,'MANUAL');
  assert.ok(basis.claims.every(claim=>claim.textHash===hash(claim.text)));
});
test('reviewed edits get their own hash/provenance and explicit exclusions retain required dates',()=>{
  const f=fixture();f.body.selections[0]!.text='Personally edited wording';f.body.includeOriginalFactIds=[];
  const basis=buildAiResumeClaims(randomUUID(),f.snapshot,f.output,f.body,f.records);
  assert.equal(basis.claims.length,2);assert.equal(basis.claims[1]!.origin,'AI_EDITED');
  assert.deepEqual(basis.claims[1]!.sourceFactIds,[f.factId]);
});
test('duplicate/unknown proposals, foreign originals and changed evidence fail closed',()=>{
  const f=fixture();
  for(const body of [{...f.body,selections:[...f.body.selections,...f.body.selections]},{...f.body,selections:[{proposalKey:'unknown',text:'Text'}]},{...f.body,includeOriginalFactIds:[randomUUID()]}])assert.throws(()=>buildAiResumeClaims(randomUUID(),f.snapshot,f.output,body,f.records),{code:'AI_INVALID_SELECTION'});
  f.records.facts![0]!.statement='Changed'; f.records.facts![0]!.details!.description='Changed';
  assert.throws(()=>buildAiResumeClaims(randomUUID(),f.snapshot,f.output,f.body,f.records),{code:'AI_SOURCE_CHANGED'});
});
test('date headings already present are not duplicated and renderer limits are checked before render',()=>{
  const f=fixture();f.body.selections[0]!.text=f.snapshot.facts[0]!.text;
  assert.equal(buildAiResumeClaims(randomUUID(),f.snapshot,f.output,f.body,f.records).claims.length,2);
  const many={...f.output,proposals:Array.from({length:50},(_,index)=>({...f.output.proposals[0]!,proposalKey:`proposal-${index}`}))};
  assert.throws(()=>buildAiResumeClaims(randomUUID(),f.snapshot,many,{...f.body,selections:many.proposals.map(p=>({proposalKey:p.proposalKey,text:p.text}))},f.records),{code:'AI_DOCUMENT_LIMIT'});
});

const adminUrl=process.env.CAREER_V090_DOCUMENT_TEST_ADMIN_URL;
test('AI PDF persistence, readiness, review CAS and render race use an isolated database', {skip:!adminUrl},async(t)=>{
  const maintenance=new URL(adminUrl!);assert.equal(maintenance.pathname,'/postgres');assert.ok(['127.0.0.1','localhost','::1'].includes(maintenance.hostname));
  const databaseName=`career_aidoc_${randomBytes(5).toString('hex')}`,admin=new Client({connectionString:maintenance.toString()}),directory=await mkdtemp(join(tmpdir(),'career-aidoc-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client:any,pool:any;
  let renderFailure:unknown;
  const app=Fastify();let mutation:(()=>Promise<void>)|undefined;let renderCount=0;
  let closePool: (() => Promise<void>) | undefined;
  try{
    await admin.connect();await admin.query(`CREATE DATABASE "${databaseName}"`);maintenance.pathname=`/${databaseName}`;
    client=new Client({connectionString:maintenance.toString()});await client.connect();
    for(const file of(await readdir(new URL('packages/db/migrations',root))).filter(file=>/^\d{4}_.*\.sql$/.test(file)).sort())for(const statement of(await readFile(new URL(`packages/db/migrations/${file}`,root),'utf8')).split('--> statement-breakpoint').filter(part=>part.trim()))await client.query(statement);
    pool=new Pool({connectionString:maintenance.toString()});closePool=trackPgPoolCleanup(pool);const database=drizzle(pool,{schema});let activeWorkspace='';
    registerAiDocumentRoutes(app,()=>activeWorkspace,{database,storageRoot:directory,render:async input=>{
      renderCount++;assert.ok(!input.facts.some(fact=>fact.statement.includes('<script>')));
      if(process.env.CAREER_V090_PDF_TEST==='true'){try{
        const rendered=await renderResume(input);
        const text=execFileSync('pdftotext',[input.path,'-'],{encoding:'utf8'}).replace(/\s+/g,' ');
        for(const fact of input.facts)assert.ok(text.includes(fact.statement.replace(/\s+/g,' ')),`Real PDF preserves each reviewed claim`);
        assert.ok(text.includes(input.fullName));assert.ok(text.includes(input.email??''));assert.ok(text.includes('01/2020 - Present'));
        assert.ok(text.includes('WORK EXPERIENCE')||text.includes('EXPERIENCE'),'stable section label uses the saved source kind');
        await mutation?.();return rendered;
      }catch(error){renderFailure=error;throw error;}}
      const bytes=Buffer.from(`%PDF-1.7\n${input.facts.map(fact=>fact.statement).join('\n')}`);await mkdir(dirname(input.path),{recursive:true});await writeFile(input.path,bytes);
      await mutation?.();return{absolutePath:input.path,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
    }});
    const seed=async()=>{
      const f=fixture();activeWorkspace=f.workspaceId;const connection=randomUUID(),consent=randomUUID(),run=randomUUID(),artifact=randomUUID();
      await client.query('INSERT INTO workspaces(id) VALUES($1)',[f.workspaceId]);
      await client.query('INSERT INTO profile_versions(id,workspace_id,revision,profile) VALUES($1,$2,1,$3)',[f.profileId,f.workspaceId,JSON.stringify(f.records.profile!.profile)]);
      for(const fact of f.records.facts!)await client.query('INSERT INTO profile_facts(id,workspace_id,profile_version_id,kind,statement,details,tags,source,approval_status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[fact.id,f.workspaceId,f.profileId,fact.kind,fact.statement,JSON.stringify(fact.details),'[]',fact.source,fact.approvalStatus,fact.createdAt]);
      await client.query(`INSERT INTO jobs(id,workspace_id,title,company,availability) VALUES($1,$2,'QA','Synthetic','OPEN')`,[f.jobId,f.workspaceId]);
      await client.query(`INSERT INTO job_snapshots(id,workspace_id,job_id,title,description_text,snapshot_hash) VALUES($1,$2,$3,'QA','Build automated tests',$4)`,[f.records.jobSnapshot!.id,f.workspaceId,f.jobId,'a'.repeat(64)]);
      await client.query(`INSERT INTO ai_connections(id,workspace_id,provider,account_fingerprint,state) VALUES($1,$2,'codex',$3,'CONNECTED')`,[connection,f.workspaceId,'a'.repeat(64)]);
      await client.query(`INSERT INTO ai_consents(id,workspace_id,connection_id,provider,account_fingerprint,connection_revision,revision,operation,data_categories,notice_version) VALUES($1,$2,$3,'codex',$4,1,1,'RESUME_DRAFT','["JOB_POSTING","APPROVED_PROFILE_FACTS"]','v1')`,[consent,f.workspaceId,connection,'a'.repeat(64)]);
      await client.query(`INSERT INTO ai_runs(id,workspace_id,connection_id,consent_id,provider,connection_revision,consent_revision,account_fingerprint,operation,origin,status,idempotency_key,content_identity,account_lock_key,snapshot,snapshot_hash,input_versions) VALUES($1,$2,$3,$4,'codex',1,1,$5,'RESUME_DRAFT','MANUAL','SUCCEEDED',$1::uuid::text,'c','a',$6,$7,'{}')`,[run,f.workspaceId,connection,consent,'a'.repeat(64),JSON.stringify(f.snapshot),f.snapshot.snapshotHash]);
      await client.query(`INSERT INTO ai_artifacts(id,workspace_id,run_id,schema_version,prompt_version,locale,output,sources) VALUES($1,$2,$3,1,'v1','en',$4,'{}')`,[artifact,f.workspaceId,run,JSON.stringify(f.output)]);
      return {...f,artifact};
    };
    await t.test('renders once, creates a pending PDF, exact retry reuses it and CAS rejects different edits',async()=>{
      const f=await seed();const response=await app.inject({method:'POST',url:`/api/v1/ai/artifacts/${f.artifact}/resume`,payload:f.body});if(renderFailure)throw renderFailure;assert.equal(response.statusCode,201,response.body);
      const doc=response.json();assert.equal(doc.approvalStatus,'PENDING_REVIEW');assert.equal(doc.claimsContractVersion,1);assert.equal(doc.reviewReady,true);assert.equal(doc.assistReady,false);assert.equal(doc.claimsBasis.approval,null);
      const bytes=await readFile(join(directory,doc.storagePath));assert.equal(createHash('sha256').update(bytes).digest('hex'),doc.sha256);assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
      const count=renderCount;const repeat=await app.inject({method:'POST',url:`/api/v1/ai/artifacts/${f.artifact}/resume`,payload:f.body});assert.equal(repeat.statusCode,200,repeat.body);assert.equal(repeat.json().id,doc.id);assert.equal(renderCount,count);
      const changed=await app.inject({method:'POST',url:`/api/v1/ai/artifacts/${f.artifact}/resume`,payload:{...f.body,name:'Different'}});assert.equal(changed.statusCode,409);
      const row=(await database.select().from(schema.documentVersions))[0]!;
      const missing=await approveDerivedDocument(database,f.workspaceId,row,{});assert.deepEqual(missing,{error:'DOCUMENT_REVIEW_CHANGED'});
      const approval=await approveDerivedDocument(database,f.workspaceId,row,{expectedPdfHash:row.sha256,expectedClaimTextHashes:doc.claimsBasis.claims.map((claim:{textHash:string})=>claim.textHash)});assert.ok('basis'in approval);
      const approved={...row,claimsBasis:'basis'in approval?approval.basis:null,approvalStatus:'USER_APPROVED'};
      assert.equal((await documentReadiness(database,f.workspaceId,[approved]))[0]!.assistReady,true);
      assert.deepEqual(await approveDerivedDocument(database,f.workspaceId,row,{expectedPdfHash:'f'.repeat(64),expectedClaimTextHashes:doc.claimsBasis.claims.map((claim:{textHash:string})=>claim.textHash)}),{error:'DOCUMENT_REVIEW_CHANGED'});
      const nextProfile=randomUUID();
      await client.query('INSERT INTO profile_versions(id,workspace_id,revision,profile) VALUES($1,$2,2,$3)',[nextProfile,f.workspaceId,JSON.stringify({...f.records.profile!.profile,preferences:{targetTitles:['Tester']}})]);
      await client.query(`INSERT INTO profile_facts(workspace_id,profile_version_id,kind,statement,details,tags,source,approval_status,created_at) SELECT workspace_id,$2,kind,statement,details,tags,source,approval_status,created_at FROM profile_facts WHERE workspace_id=$1 AND profile_version_id=$3`,[f.workspaceId,nextProfile,f.profileId]);
      assert.equal((await documentReadiness(database,f.workspaceId,[approved]))[0]!.assistReady,true,'preference saves preserve exact approved copies');
      const legacy={...row,claimsContractVersion:null,claimsBasis:null,claims:f.snapshot.facts.map(fact=>({text:fact.text,sourceFactIds:[fact.factId],approvalStatus:'USER_REVIEWED'})),approvalStatus:'USER_APPROVED'};
      assert.equal((await documentReadiness(database,f.workspaceId,[legacy]))[0]!.assistReady,true,'legacy literal-text PDF contract remains usable');
      await client.query(`INSERT INTO job_snapshots(workspace_id,job_id,title,description_text,snapshot_hash) VALUES($1,$2,'QA','Changed job requirements',$3)`,[f.workspaceId,f.jobId,'c'.repeat(64)]);
      const staleTarget=(await documentReadiness(database,f.workspaceId,[approved]))[0]!;
      assert.equal(staleTarget.assistReady,false);assert.equal('derivedStatus'in staleTarget?staleTarget.derivedStatus:null,'NEEDS_ADAPTATION_REVIEW');
      await client.query(`UPDATE profile_facts SET approval_status='REJECTED' WHERE workspace_id=$1 AND profile_version_id=$2 AND kind='experience'`,[f.workspaceId,nextProfile]);
      await client.query(`UPDATE profile_facts SET approval_status='REJECTED' WHERE id=$1`,[f.factId]);assert.equal((await documentReadiness(database,f.workspaceId,[approved]))[0]!.assistReady,false);
    });
    await t.test('source changed during PDF render rolls back document and removes its file',async()=>{
      const f=await seed();mutation=()=>client.query(`UPDATE profile_facts SET approval_status='REJECTED' WHERE id=$1`,[f.factId]);
      const response=await app.inject({method:'POST',url:`/api/v1/ai/artifacts/${f.artifact}/resume`,payload:f.body});mutation=undefined;
      assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error,'AI_SOURCE_CHANGED');
      assert.equal((await client.query('SELECT count(*)::int n FROM document_versions WHERE workspace_id=$1',[f.workspaceId])).rows[0].n,0);
      assert.deepEqual(await readdir(join(directory,f.workspaceId)),[]);
      assert.equal((await client.query('SELECT state FROM ai_artifacts WHERE id=$1',[f.artifact])).rows[0].state,'PENDING_REVIEW');
    });
    await t.test('cross-workspace artifact access fails without rendering or returning data',async()=>{
      const f=await seed();activeWorkspace=randomUUID();const before=renderCount;
      const response=await app.inject({method:'POST',url:`/api/v1/ai/artifacts/${f.artifact}/resume`,payload:f.body});assert.equal(response.statusCode,409);assert.equal(response.json().error,'AI_ARTIFACT_NOT_FOUND');assert.equal(renderCount,before);
    });
    await t.test('approved AI answers stop being reusable after evidence changes; manual answers stay available',async()=>{
      const f=await seed(),questionId=randomUUID(),answerRun=randomUUID(),artifactId=randomUUID(),answerId=randomUUID(),manualId=randomUUID();
      const question={id:questionId,workspaceId:f.workspaceId,questionText:'Describe your relevant work experience',jurisdiction:'ES',questionScope:'experience'};
      await database.insert(schema.answerVersions).values({id:questionId,workspaceId:f.workspaceId,semanticKey:'experience',questionText:question.questionText,jurisdiction:'ES',questionScope:'experience',strategy:'ASK_USER',revision:1});
      const snapshot=buildAiSourceSnapshot(f.workspaceId,{operation:'ANSWER_DRAFT',locale:'en',questionId,selectedFactIds:[f.factId]},{...f.records,question});
      const priorRun=(await client.query('SELECT * FROM ai_runs WHERE workspace_id=$1 LIMIT 1',[f.workspaceId])).rows[0];
      await client.query(`INSERT INTO ai_runs(id,workspace_id,connection_id,consent_id,provider,connection_revision,consent_revision,account_fingerprint,operation,origin,status,idempotency_key,content_identity,account_lock_key,snapshot,snapshot_hash,input_versions) VALUES($1,$2,$3,$4,'codex',1,1,$5,'ANSWER_DRAFT','MANUAL','SUCCEEDED',$1::uuid::text,'c','a',$6,$7,'{}')`,[answerRun,f.workspaceId,priorRun.connection_id,priorRun.consent_id,'a'.repeat(64),JSON.stringify(snapshot),snapshot.snapshotHash]);
      const text='I built reliable tests.';
      await database.insert(schema.aiArtifacts).values({id:artifactId,workspaceId:f.workspaceId,runId:answerRun,schemaVersion:1,promptVersion:'v1',locale:'en',output:{schemaVersion:1,operation:'ANSWER_DRAFT',locale:'en',questionId,result:{status:'DRAFT',text,evidence:[{factId:f.factId}]}},sources:{},state:'ACCEPTED',approvedHash:hash(text)});
      await database.insert(schema.answerVersions).values({id:answerId,workspaceId:f.workspaceId,semanticKey:'experience',questionText:question.questionText,jurisdiction:'ES',questionScope:'experience',strategy:'DRAFT_FOR_REVIEW',revision:2,value:text,approvalStatus:'USER_APPROVED',aiProvenance:{artifactId,sourceFactIds:[f.factId],sourceSnapshotHash:snapshot.snapshotHash,textHash:hash(text),origin:'AI'}});
      await database.insert(schema.answerVersions).values({id:manualId,workspaceId:f.workspaceId,semanticKey:'manual',questionText:'Manual question',jurisdiction:'ES',questionScope:'manual',strategy:'USER_ANSWER',revision:1,value:'Manual response',approvalStatus:'USER_APPROVED'});
      assert.deepEqual((await latestReusableAnswers(database,f.workspaceId)).map(answer=>answer.id).sort(),[answerId,manualId].sort());
      await client.query(`UPDATE profile_facts SET approval_status='REJECTED' WHERE id=$1`,[f.factId]);
      assert.deepEqual((await latestReusableAnswers(database,f.workspaceId)).map(answer=>answer.id),[manualId]);
      assert.equal((await client.query('SELECT approval_status FROM answer_versions WHERE id=$1',[answerId])).rows[0].approval_status,'USER_APPROVED','audit history remains unchanged');
    });
  }finally{await app.close();await closePool?.();await client?.end();await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);await admin.end();await rm(directory,{recursive:true,force:true});}
});
