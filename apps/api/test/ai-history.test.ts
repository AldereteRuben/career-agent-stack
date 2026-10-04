import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import Fastify from 'fastify';
import { createAiHistoryService, createAiHistoryMaintenance, AiHistoryError, type AiHistoryService } from '../src/ai/history.js';
import { registerAiHistoryRoutes } from '../src/ai-history-routes.js';
import { createAiQueue, type EnqueueAiRunInput } from '../src/ai/queue.js';
import { buildAiSourceSnapshot } from '../src/ai/source-snapshot.js';

const root=new URL('../../../',import.meta.url);
const {Client,Pool}=createRequire(new URL('packages/db/package.json',root))('pg');
const adminUrl=process.env.CAREER_V090_HISTORY_TEST_ADMIN_URL;

test('history maintenance is inert on construction and serializes explicit passes',async()=>{
  let calls=0,finish!:()=>void;
  const service={pruneOnce:async()=>{calls++;await new Promise<void>(resolve=>{finish=resolve;});}} as unknown as AiHistoryService;
  const maintenance=createAiHistoryMaintenance(service);assert.equal(calls,0);
  const first=maintenance.runOnce();await setImmediate();await maintenance.runOnce();assert.equal(calls,1);finish();await first;await maintenance.stop();
});

test('history routes scope previews and redact internal failures',async()=>{
  const app=Fastify(),ws=randomUUID();let observed='';
  const service={preview:async(id:string)=>{observed=id;return {previewId:randomUUID()};},clear:async()=>{throw new AiHistoryError('AI_PREVIEW_EXPIRED');},close:async()=>{}} as unknown as AiHistoryService;
  registerAiHistoryRoutes(app,()=>ws,service);
  try{const preview=await app.inject('/api/v1/ai/history/clear-preview');assert.equal(preview.statusCode,200);assert.equal(observed,ws);assert.equal(preview.headers['cache-control'],'no-store');
    assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/history/clear',payload:{previewId:randomUUID()}})).statusCode,409);
    service.clear=async()=>{throw new Error('private source text');};const failed=await app.inject({method:'POST',url:'/api/v1/ai/history/clear',payload:{}});assert.equal(failed.statusCode,503);assert.deepEqual(failed.json(),{error:'AI_UNAVAILABLE'});
  }finally{await app.close();}
});

test('history retention and explicit deletion use an isolated synthetic database',{skip:!adminUrl},async t=>{
  const maintenance=new URL(adminUrl!);assert.ok(['127.0.0.1','localhost','::1'].includes(maintenance.hostname));assert.equal(maintenance.pathname,'/postgres');
  const name=`career_aih_${randomBytes(6).toString('hex')}`;const admin=new Client({connectionString:maintenance.toString()});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client:any,pool:any;let created=false;
  let closePool: (() => Promise<void>) | undefined;
  try{
    await admin.connect();await admin.query(`CREATE DATABASE "${name}"`);created=true;maintenance.pathname=`/${name}`;client=new Client({connectionString:maintenance.toString()});await client.connect();
    for(const file of (await readdir(new URL('packages/db/migrations',root))).filter(file=>/^\d{4}_.*\.sql$/.test(file)).sort()){
      for(const statement of (await readFile(new URL(`packages/db/migrations/${file}`,root),'utf8')).split('--> statement-breakpoint').filter(part=>part.trim()))await client.query(statement);
    }
    pool=new Pool({connectionString:maintenance.toString(),max:5});closePool=trackPgPoolCleanup(pool);
    const fixture=async()=>{
      const workspaceId=randomUUID(),connectionId=randomUUID(),consentId=randomUUID(),fingerprint='a'.repeat(64);let current=new Date('2026-10-04T12:00:00Z');
      await client.query('INSERT INTO workspaces(id) VALUES($1)',[workspaceId]);
      await client.query(`INSERT INTO ai_connections(id,workspace_id,provider,account_fingerprint,state) VALUES($1,$2,'codex',$3,'CONNECTED')`,[connectionId,workspaceId,fingerprint]);
      await client.query(`INSERT INTO ai_consents(id,workspace_id,connection_id,provider,account_fingerprint,connection_revision,revision,operation,data_categories,notice_version) VALUES($1,$2,$3,'codex',$4,1,1,'SEARCH_DRAFT','["SEARCH_REQUEST"]','fixture')`,[consentId,workspaceId,connectionId,fingerprint]);
      const service=createAiHistoryService({pool,now:()=>new Date(current)});const queue=createAiQueue(pool);
      const add=async(options:{status?:string;ageDays?:number;state?:string;dismissedDays?:number;retryOf?:string;jobId?:string;identity?:string;origin?:string;passId?:string}={})=>{
        const id=randomUUID(),artifactId=options.state?randomUUID():null,at=new Date(current.getTime()-(options.ageDays??0)*86_400_000);
        if(options.jobId){await client.query(`INSERT INTO jobs(id,workspace_id,title,company,availability) VALUES($1,$2,'QA','Synthetic','OPEN')`,[options.jobId,workspaceId]);
          if(options.identity)await client.query(`INSERT INTO job_identity_members(workspace_id,job_id,identity_key,evidence) VALUES($1,$2,$3,'{}')`,[workspaceId,options.jobId,options.identity]);}
        await client.query(`INSERT INTO ai_runs(id,workspace_id,connection_id,consent_id,provider,connection_revision,consent_revision,account_fingerprint,operation,origin,status,idempotency_key,content_identity,account_lock_key,snapshot,snapshot_hash,input_versions,created_at,completed_at,retry_of,reservation_pass_id)
          VALUES($1,$2,$3,$4,'codex',1,1,$5,$6,$7,$8,$14,$5,$5,$9,$5,'{}',$10,$11,$12,$13)`,[id,workspaceId,connectionId,consentId,fingerprint,options.jobId?'JOB_ANALYSIS':'SEARCH_DRAFT',options.origin??'MANUAL',options.status??'SUCCEEDED',JSON.stringify(options.jobId?{job:{jobId:options.jobId}}:{}),at,options.status==='RUNNING'?null:at,options.retryOf??null,options.passId??null,id]);
        if(artifactId)await client.query(`INSERT INTO ai_artifacts(id,workspace_id,run_id,schema_version,prompt_version,locale,output,sources,state,dismissed_at,created_at) VALUES($1,$2,$3,1,'fixture','en','{}','{}',$4,$5,$6)`,[artifactId,workspaceId,id,options.state,options.dismissedDays===undefined?null:new Date(current.getTime()-options.dismissedDays*86_400_000),at]);
        await client.query(`INSERT INTO llm_usage(workspace_id,ai_run_id,provider,operation,status,availability,created_at) VALUES($1,$2,'codex','fixture','SUCCEEDED','UNAVAILABLE',$3)`,[workspaceId,id,at]);
        return {id,artifactId};
      };
      const document=async(artifactId:string)=>client.query(`INSERT INTO document_versions(workspace_id,name,revision,media_type,storage_path,sha256,claims_contract_version,claims_basis) VALUES($1,$2,1,'application/pdf','synthetic.pdf',$3,1,$4)`,[workspaceId,randomUUID(),'b'.repeat(64),JSON.stringify({claims:[{artifactId}]})]);
      const answer=async(artifactId:string)=>client.query(`INSERT INTO answer_versions(workspace_id,semantic_key,jurisdiction,question_scope,strategy,revision,ai_provenance) VALUES($1,$2,'US','synthetic','MANUAL',1,$3)`,[workspaceId,randomUUID(),JSON.stringify({artifactId})]);
      return {workspaceId,connectionId,consentId,fingerprint,service,queue,add,document,answer,setNow:(date:Date)=>{current=date;},getNow:()=>new Date(current)};
    };
    const exists=async(id:string)=>Boolean((await client.query('SELECT 1 FROM ai_runs WHERE id=$1',[id])).rowCount);
    await t.test('automatic retention uses completion and dismissal dates, keeping pending proposals, linked sources and active runs',async()=>{
      const f=await fixture();const old=await f.add({ageDays:31,status:'FAILED'}),dismissed=await f.add({ageDays:60,state:'DISMISSED',dismissedDays:31});
      const recent=await f.add({ageDays:10}),recentlyDismissed=await f.add({ageDays:60,state:'DISMISSED',dismissedDays:1}),pending=await f.add({ageDays:60,state:'PENDING_REVIEW'});
      const linked=await f.add({ageDays:60,state:'ACCEPTED'});await f.document(linked.artifactId!);const active=await f.add({ageDays:60,status:'RUNNING'});
      await client.query(`INSERT INTO ai_usage_snapshots(workspace_id,connection_id,availability,source,observed_at,created_at) VALUES($1,$2,'UNAVAILABLE','fixture','2026-01-01','2026-01-01')`,[f.workspaceId,f.connectionId]);
      const result=await f.service.pruneOnce();assert.equal(result.deleted.runs,2);assert.equal(result.deleted.artifacts,1);
      assert.equal(await exists(old.id),false);assert.equal(await exists(dismissed.id),false);
      for(const row of [recent,recentlyDismissed,pending,linked,active])assert.equal(await exists(row.id),true);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM ai_usage_snapshots WHERE workspace_id=$1',[f.workspaceId])).rows[0].n,0);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM llm_usage WHERE workspace_id=$1',[f.workspaceId])).rows[0].n,2);await f.service.close();
    });
    await t.test('manual preview preserves both document and answer references, retry ancestors, and live work',async()=>{
      const f=await fixture(),other=await fixture();const remove=await f.add({state:'PENDING_REVIEW'}),document=await f.add({state:'ACCEPTED'}),answer=await f.add({state:'ACCEPTED'});
      await f.document(document.artifactId!);await f.answer(answer.artifactId!);const parent=await f.add({status:'FAILED'});await f.add({status:'RUNNING',retryOf:parent.id});const foreign=await other.add();
      const preview=await f.service.preview(f.workspaceId);assert.equal(preview.removable.runs,1);assert.equal(preview.preserved.activeRuns,1);assert.equal(preview.preserved.referencedArtifacts,2);assert.equal(preview.preserved.retainedDependencies,1);
      await assert.rejects(f.service.clear(other.workspaceId,{previewId:preview.previewId}),{code:'AI_PREVIEW_EXPIRED'});
      const [a,b]=await Promise.all([f.service.clear(f.workspaceId,{previewId:preview.previewId}),f.service.clear(f.workspaceId,{previewId:preview.previewId})]);assert.deepEqual(a,b);assert.equal(a.deleted.runs,1);
      assert.equal(await exists(remove.id),false);for(const row of [document,answer,parent,foreign])assert.equal(await exists(row.id),true);
      await f.service.close();await other.service.close();
    });
    await t.test('clear rechecks references and deletes only reviewed rows; new terminal work is retained',async()=>{
      const f=await fixture();const changed=await f.add({state:'PENDING_REVIEW'}),removable=await f.add();const preview=await f.service.preview(f.workspaceId);
      await f.document(changed.artifactId!);const newer=await f.add();const result=await f.service.clear(f.workspaceId,{previewId:preview.previewId});assert.equal(result.deleted.runs,1);
      assert.equal(await exists(removable.id),false);assert.equal(await exists(changed.id),true);assert.equal(await exists(newer.id),true);await f.service.close();
    });
    await t.test('deleting a complete retry chain succeeds atomically',async()=>{
      const f=await fixture();const parent=await f.add({status:'FAILED'}),child=await f.add({retryOf:parent.id,status:'INTERRUPTED'});const p=await f.service.preview(f.workspaceId);
      assert.equal((await f.service.clear(f.workspaceId,{previewId:p.previewId})).deleted.runs,2);assert.equal(await exists(parent.id),false);assert.equal(await exists(child.id),false);await f.service.close();
    });
    await t.test('deletion markers preserve only IDs, canonical identity and quota controls',async()=>{
      const f=await fixture(),jobId=randomUUID(),passId=randomUUID(),identity='f'.repeat(64);const run=await f.add({jobId,identity,origin:'AUTOMATIC',passId});
      await client.query(`INSERT INTO ai_daily_budgets(workspace_id,control_day,automatic_started) VALUES($1,'2026-10-04',10)`,[f.workspaceId]);
      const p=await f.service.preview(f.workspaceId);await f.service.clear(f.workspaceId,{previewId:p.previewId});
      const marker=(await client.query('SELECT * FROM ai_run_tombstones WHERE workspace_id=$1',[f.workspaceId])).rows[0];
      assert.equal(marker.run_id,run.id);assert.equal(marker.job_id,jobId);assert.equal(marker.canonical_identity,identity);assert.equal(marker.reservation_pass_id,passId);
      assert.deepEqual(Object.keys(marker).sort(),['canonical_identity','consent_id','created_at','idempotency_hash','job_id','reservation_pass_id','run_id','workspace_id']);
      assert.equal((await client.query('SELECT automatic_started FROM ai_daily_budgets WHERE workspace_id=$1',[f.workspaceId])).rows[0].automatic_started,10);await f.service.close();
    });
    await t.test('cleared tasks cannot reuse a one-off consent or a remembered idempotency key',async()=>{
      const f=await fixture();const snapshot=buildAiSourceSnapshot(f.workspaceId,{operation:'SEARCH_DRAFT',locale:'en',searchRequest:'Synthetic remote QA'},{});
      const input:EnqueueAiRunInput={workspaceId:f.workspaceId,connectionId:f.connectionId,consentId:f.consentId,connectionRevision:1,consentRevision:1,provider:'codex',accountFingerprint:f.fingerprint,operation:'SEARCH_DRAFT',origin:'MANUAL',idempotencyKey:randomUUID(),contentIdentity:'c'.repeat(64),accountLockKey:f.fingerprint,snapshot,snapshotHash:snapshot.snapshotHash,inputVersions:{},now:f.getNow()};
      const run=await f.queue.enqueue(input);await f.queue.cancel(f.workspaceId,run.id);const p=await f.service.preview(f.workspaceId);await f.service.clear(f.workspaceId,{previewId:p.previewId});
      await assert.rejects(f.queue.enqueue({...input,idempotencyKey:randomUUID()}),{code:'CONSENT_INVALID'});
      await client.query('UPDATE ai_consents SET remembered=true WHERE id=$1',[f.consentId]);await assert.rejects(f.queue.enqueue(input),{code:'CONSENT_INVALID'});
      await f.service.close();
    });
    await t.test('preview expiry and validation are enforced without provider state',async()=>{
      const f=await fixture();await assert.rejects(f.service.preview('bad'),{code:'INVALID_INPUT'});await assert.rejects(f.service.clear(f.workspaceId,{}),{code:'INVALID_INPUT'});
      const p=await f.service.preview(f.workspaceId);f.setNow(new Date(f.getNow().getTime()+300_000));await assert.rejects(f.service.clear(f.workspaceId,{previewId:p.previewId}),{code:'AI_PREVIEW_EXPIRED'});await f.service.close();
    });
  }finally{await closePool?.();await client?.end();if(created)await admin.query(`DROP DATABASE "${name}"`);await admin.end();}
});
