import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import Fastify from 'fastify';
import { AiAutomationError, createAiAutomationScanner, createAiAutomationService, type AiAutomationService } from '../src/ai/automation.js';
import { registerAiAutomationRoutes } from '../src/ai-automation-routes.js';
import { createAiQueue } from '../src/ai/queue.js';
import { buildAiSourceSnapshot } from '../src/ai/source-snapshot.js';
import { createAiHistoryService } from '../src/ai/history.js';

const root=new URL('../../../',import.meta.url);
const {Client,Pool}=createRequire(new URL('packages/db/package.json',root))('pg');
const adminUrl=process.env.CAREER_V090_AUTOMATION_TEST_ADMIN_URL;

test('automation and scanner are inert by default; scanner serializes work',async()=>{
  let calls=0;
  const service=createAiAutomationService({pool:{connect:async()=>{calls++;throw new Error('must not connect');}},queue:{} as ReturnType<typeof createAiQueue>});
  assert.deepEqual(await service.scanOnce(),{enqueued:0});
  await assert.rejects(service.preview(randomUUID(),{}),{code:'AI_UNAVAILABLE'});
  const disabled=createAiAutomationScanner(service);disabled.start();assert.deepEqual(await disabled.runOnce(),{enqueued:0});await disabled.stop();assert.equal(calls,0);
  let finish!:()=>void;
  const fake={scanOnce:async()=>{calls++;await new Promise<void>(resolve=>{finish=resolve;});return {enqueued:1};}} as AiAutomationService;
  const scanner=createAiAutomationScanner(fake,{enabled:true});const first=scanner.runOnce();await setImmediate();
  assert.deepEqual(await scanner.runOnce(),{enqueued:0});assert.equal(calls,1);finish();assert.deepEqual(await first,{enqueued:1});await scanner.stop();
});

test('automation routes validate pause scope and suppress internal exceptions',async()=>{
  const ws=randomUUID();let observed='';const app=Fastify();
  const service={list:async(workspace:string)=>{observed=workspace;return {policies:[]};},preview:async()=>{throw new Error('PRIVATE DATABASE DETAILS');},
    activate:async()=>{throw new AiAutomationError('AI_PREVIEW_EXPIRED');},pause:async()=>{throw new AiAutomationError('AI_POLICY_CHANGED');},close:async()=>{}} as unknown as AiAutomationService;
  registerAiAutomationRoutes(app,()=>ws,service);
  try{
    const listed=await app.inject({method:'GET',url:'/api/v1/ai/automation?locale=en'});assert.equal(listed.statusCode,200);assert.equal(observed,ws);assert.equal(listed.headers['cache-control'],'no-store');
    assert.equal((await app.inject({method:'GET',url:'/api/v1/ai/automation?locale=bad'})).statusCode,400);
    const failed=await app.inject({method:'POST',url:'/api/v1/ai/automation/preview',payload:{}});assert.equal(failed.statusCode,503);assert.deepEqual(failed.json(),{error:'AI_UNAVAILABLE'});
    assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/automation',payload:{}})).statusCode,409);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/ai/automation/not-an-id/pause',payload:{expectedRevision:1}})).statusCode,400);
  }finally{await app.close();}
});

test('automatic analysis policies use only an isolated synthetic database',{skip:!adminUrl},async t=>{
  const maintenance=new URL(adminUrl!);assert.ok(['127.0.0.1','localhost','::1'].includes(maintenance.hostname));assert.equal(maintenance.pathname,'/postgres');
  const name=`career_aia_${randomBytes(6).toString('hex')}`;const admin=new Client({connectionString:maintenance.toString()});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client:any;let pool:any;let created=false;
  try{
    await admin.connect();await admin.query(`CREATE DATABASE "${name}"`);created=true;maintenance.pathname=`/${name}`;
    client=new Client({connectionString:maintenance.toString()});await client.connect();
    for(const file of (await readdir(new URL('packages/db/migrations',root))).filter(file=>/^\d{4}_.*\.sql$/.test(file)).sort()){
      for(const statement of (await readFile(new URL(`packages/db/migrations/${file}`,root),'utf8')).split('--> statement-breakpoint').filter(part=>part.trim()))await client.query(statement);
    }
    pool=new Pool({connectionString:maintenance.toString(),max:5});
    const fixture=async()=>{
      const workspaceId=randomUUID(),connectionId=randomUUID(),consentId=randomUUID(),manualRunId=randomUUID(),profileId=randomUUID(),factId=randomUUID();
      const fingerprint=randomBytes(32).toString('hex');const queue=createAiQueue(pool);let current=new Date('2026-10-04T12:00:00.000Z');
      const searches=[randomUUID(),randomUUID()],runs=[randomUUID(),randomUUID()];const cancelled:string[]=[];const events:string[]=[];
      const service=createAiAutomationService({pool,queue,enabled:true,now:()=>new Date(current),cancelRun:id=>cancelled.push(id),onEvent:event=>events.push(event)});
      await client.query(`INSERT INTO workspaces(id) VALUES($1)`,[workspaceId]);
      await client.query(`INSERT INTO ai_connections(id,workspace_id,provider,account_fingerprint,state,masked_identity,selected_model) VALUES($1,$2,'codex',$3,'CONNECTED','f***@example.test','gpt-6.1-sol')`,[connectionId,workspaceId,fingerprint]);
      await client.query(`INSERT INTO ai_consents(id,workspace_id,connection_id,provider,account_fingerprint,connection_revision,revision,operation,data_categories,notice_version) VALUES($1,$2,$3,'codex',$4,1,1,'JOB_ANALYSIS','["JOB_POSTING"]','fixture')`,[consentId,workspaceId,connectionId,fingerprint]);
      await client.query(`INSERT INTO profile_versions(id,workspace_id,revision,profile) VALUES($1,$2,1,'{}')`,[profileId,workspaceId]);
      await client.query(`INSERT INTO profile_facts(id,workspace_id,profile_version_id,kind,statement,approval_status,created_at) VALUES($1,$2,$3,'achievement','Built automated regression checks.','USER_APPROVED','2026-01-01')`,[factId,workspaceId,profileId]);
      for(let index=0;index<searches.length;index++){
        await client.query(`INSERT INTO saved_job_searches(id,workspace_id,role,matcher_version) VALUES($1,$2,'QA',2)`,[searches[index],workspaceId]);
        await client.query(`INSERT INTO search_runs(id,workspace_id,search_id,revision,status,criteria,finished_at) VALUES($1,$2,$3,1,'SUCCEEDED',$4::jsonb,now())`,[runs[index],workspaceId,searches[index],JSON.stringify({role:'QA',company:null,location:null,workMode:'any',includeRelated:false,matcherVersion:2,providerIds:['remotive','arbeitnow']})]);
      }
      const addJob=async(options:{searchIndexes?:number[];at?:Date;availability?:string;decision?:string;identity?:string;score?:number}={})=>{
        const id=randomUUID(),snapshotId=randomUUID();const identity=options.identity??randomBytes(32).toString('hex');
        const at=options.at??new Date(current.getTime()+1_000);const title='QA engineer';const description='Test software and write automated checks for our product.';
        await client.query(`INSERT INTO jobs(id,workspace_id,company,title,availability,shortlist_decision,created_at) VALUES($1,$2,'Synthetic Example',$3,$4,$5,$6)`,[id,workspaceId,title,options.availability??'OPEN',options.decision??'UNREVIEWED',at]);
        await client.query(`INSERT INTO job_snapshots(id,workspace_id,job_id,title,description_text,snapshot_hash) VALUES($1,$2,$3,$4,$5,$6)`,[snapshotId,workspaceId,id,title,description,'c'.repeat(64)]);
        await client.query(`INSERT INTO job_identity_members(workspace_id,job_id,identity_key,evidence) VALUES($1,$2,$3,'{}')`,[workspaceId,id,identity]);
        for(const index of options.searchIndexes??[0]){
          await client.query(`INSERT INTO saved_job_search_matches(workspace_id,search_id,job_id,matched_at) VALUES($1,$2,$3,$4)`,[workspaceId,searches[index],id,at]);
          await client.query(`INSERT INTO search_run_results(workspace_id,run_id,search_id,job_id,score,location_status) VALUES($1,$2,$3,$4,$5,'known')`,[workspaceId,runs[index],searches[index],id,options.score??50]);
        }
        return {id,identity,snapshot:buildAiSourceSnapshot(workspaceId,{operation:'JOB_ANALYSIS',jobId:id,selectedFactIds:[],locale:'en'},{job:{id,workspaceId,title,company:'Synthetic Example',location:null},jobSnapshot:{id:snapshotId,workspaceId,jobId:id,title,descriptionText:description}})};
      };
      const manual=await addJob({at:new Date(current.getTime()-86_400_000)});
      await client.query(`INSERT INTO ai_runs(id,workspace_id,connection_id,consent_id,provider,connection_revision,consent_revision,account_fingerprint,operation,origin,status,idempotency_key,content_identity,account_lock_key,snapshot,snapshot_hash,input_versions)
        VALUES($1,$2,$3,$4,'codex',1,1,$5,'JOB_ANALYSIS','MANUAL','SUCCEEDED','fixture',$6,$5,$7::jsonb,$8,'{}')`,[manualRunId,workspaceId,connectionId,consentId,fingerprint,'d'.repeat(64),JSON.stringify(manual.snapshot),manual.snapshot.snapshotHash]);
      await client.query(`INSERT INTO ai_artifacts(workspace_id,run_id,schema_version,prompt_version,locale,output,sources) VALUES($1,$2,1,'fixture','en','{}','{}')`,[workspaceId,manualRunId]);
      const preview=(patch:Partial<Parameters<typeof service.preview>[1] & {maximumDailyStarts:number;selectedFactIds:string[]}>={})=>service.preview(workspaceId,{sourceRunId:manualRunId,searchIds:searches,selectedFactIds:[],locale:'en',maximumDailyStarts:10,...patch});
      const activate=async(patch:Record<string,unknown>={})=>{const p=await service.preview(workspaceId,{sourceRunId:manualRunId,searchIds:searches,selectedFactIds:[],locale:'en',maximumDailyStarts:10,...patch});return service.activate(workspaceId,{previewId:p.previewId,idempotencyKey:randomUUID()});};
      return {workspaceId,connectionId,consentId,manualRunId,profileId,factId,queue,service,searches,runs,cancelled,events,preview,activate,addJob,setNow:(date:Date)=>{current=date;},getNow:()=>current};
    };

    await t.test('preview requires own completed manual analysis, explicit enabled searches and approved selection',async()=>{
      const f=await fixture(),other=await fixture();
      const base={sourceRunId:f.manualRunId,searchIds:f.searches,selectedFactIds:[],locale:'en',maximumDailyStarts:10};
      for(const patch of [{sourceRunId:other.manualRunId},{sourceRunId:randomUUID()}])await assert.rejects(f.service.preview(f.workspaceId,{...base,...patch}),{code:'AI_MANUAL_ANALYSIS_REQUIRED'});
      for(const patch of [{searchIds:[]},{maximumDailyStarts:11},{selectedFactIds:[f.factId,f.factId]}])await assert.rejects(f.service.preview(f.workspaceId,{...base,...patch}),{code:'INVALID_INPUT'});
      await assert.rejects(f.service.preview(f.workspaceId,{...base,selectedFactIds:[other.factId]}));
      await client.query(`UPDATE saved_job_searches SET enabled=false WHERE id=$1`,[f.searches[1]]);
      await assert.rejects(f.preview(),{code:'AI_SEARCH_CHANGED'});
      const list=await f.service.list(f.workspaceId,'en');assert.equal(list.policies.length,0);assert.deepEqual(list.facts.map(fact=>fact.factId),[f.factId]);
      await f.service.close();await other.service.close();
    });
    await t.test('activation is exact, idempotent and safe against account/source changes',async()=>{
      const f=await fixture();const p=await f.preview();const key=randomUUID();
      const [a,b]=await Promise.all([f.service.activate(f.workspaceId,{previewId:p.previewId,idempotencyKey:key}),f.service.activate(f.workspaceId,{previewId:p.previewId,idempotencyKey:key})]);assert.equal(a.id,b.id);
      assert.deepEqual(a.selectedFactIds,[]);assert.equal((await f.service.list(f.workspaceId)).policies.filter(policy=>policy.active).length,1);
      await assert.rejects(f.service.activate(f.workspaceId,{previewId:p.previewId,idempotencyKey:randomUUID()}),{code:'AI_IDEMPOTENCY_CONFLICT'});
      const changed=await f.preview();await client.query(`UPDATE ai_connections SET revision=2 WHERE id=$1`,[f.connectionId]);
      await assert.rejects(f.service.activate(f.workspaceId,{previewId:changed.previewId,idempotencyKey:randomUUID()}),{code:'AI_NOT_CONNECTED'});
      await f.service.close();
    });
    await t.test('only future open canonical matches are reserved, in deterministic relevance order',async()=>{
      const f=await fixture();await f.activate();
      await f.addJob({at:new Date(f.getNow().getTime()-1_000)});await f.addJob({availability:'CLOSED'});await f.addJob({decision:'ARCHIVED'});await f.addJob({decision:'SKIPPED'});
      const high=await f.addJob({searchIndexes:[0,1],score:90});await f.addJob({identity:high.identity,searchIndexes:[1],score:80});const low=await f.addJob({score:30});
      const hidden=await f.addJob({score:99});await f.addJob({identity:hidden.identity,searchIndexes:[1],decision:'SKIPPED'});
      const closedAlias=await f.addJob({score:98});await f.addJob({identity:closedAlias.identity,searchIndexes:[1],availability:'CLOSED'});
      assert.deepEqual(await f.service.scanOnce(),{enqueued:2});assert.deepEqual(await f.service.scanOnce(),{enqueued:0});
      const rows=(await client.query(`SELECT snapshot,search_id FROM ai_runs WHERE workspace_id=$1 AND origin='AUTOMATIC' ORDER BY reserved_at,id`,[f.workspaceId])).rows;
      assert.deepEqual(rows.map((row:{snapshot:{job:{jobId:string}}})=>row.snapshot.job.jobId),[high.id,low.id]);
      assert.ok(rows.every((row:{snapshot:{facts:unknown[]}})=>row.snapshot.facts.length===0));await f.service.close();
    });
    await t.test('clearing completed history does not requeue canonical aliases or reset started usage',async()=>{
      const f=await fixture();await f.activate();const seen=await f.addJob({score:100});assert.equal((await f.service.scanOnce()).enqueued,1);
      let run=await f.queue.claimNext({workerId:'synthetic-history',now:f.getNow()});
      // Prior subtests leave independent workspaces queued; the shared queue correctly serves those first.
      for(let attempt=0;run && run.workspaceId!==f.workspaceId && attempt<20;attempt++){
        await f.queue.finish(run.id,run.leaseToken!,{status:'INTERRUPTED'},f.getNow());run=await f.queue.claimNext({workerId:'synthetic-history',now:f.getNow()});
      }
      assert.ok(run);assert.equal(run.workspaceId,f.workspaceId);
      await f.queue.finish(run.id,run.leaseToken!,{status:'FAILED'},f.getNow());
      const history=createAiHistoryService({pool,now:f.getNow});const preview=await history.preview(f.workspaceId);await history.clear(f.workspaceId,{previewId:preview.previewId});
      await f.addJob({identity:seen.identity,score:99});
      const changedIdentity='e'.repeat(64);await client.query('UPDATE job_identity_members SET identity_key=$2 WHERE workspace_id=$1 AND job_id=$3',[f.workspaceId,changedIdentity,seen.id]);
      await f.addJob({identity:changedIdentity,score:98});const fresh=await f.addJob({score:50});assert.equal((await f.service.scanOnce()).enqueued,1);
      const runs=(await client.query(`SELECT snapshot->'job'->>'jobId' AS job_id FROM ai_runs WHERE workspace_id=$1 AND origin='AUTOMATIC'`,[f.workspaceId])).rows;assert.deepEqual(runs.map((row:{job_id:string})=>row.job_id),[fresh.id]);
      assert.equal((await client.query(`SELECT automatic_started FROM ai_daily_budgets WHERE workspace_id=$1 AND control_day='2026-10-04'`,[f.workspaceId])).rows[0].automatic_started,1);
      await history.close();await f.service.close();
    });
    await t.test('five per pass, ten daily, with lower selected cap enforced by the persistent queue',async()=>{
      const f=await fixture();await f.activate();for(let i=0;i<12;i++)await f.addJob({score:100-i});
      assert.deepEqual(await f.service.scanOnce(),{enqueued:5});assert.deepEqual(await f.service.scanOnce(),{enqueued:5});assert.deepEqual(await f.service.scanOnce(),{enqueued:0});
      const lower=await fixture();await lower.activate({maximumDailyStarts:2});for(let i=0;i<4;i++)await lower.addJob();assert.deepEqual(await lower.service.scanOnce(),{enqueued:2});
      await f.service.close();await lower.service.close();
    });
    await t.test('paused or changed searches cannot schedule stale published matches',async()=>{
      const f=await fixture();await f.activate();await f.addJob();
      await client.query(`UPDATE saved_job_searches SET enabled=false WHERE id=$1`,[f.searches[0]]);assert.deepEqual(await f.service.scanOnce(),{enqueued:0});
      await client.query(`UPDATE saved_job_searches SET enabled=true,role='Designer',revision=2 WHERE id=$1`,[f.searches[0]]);assert.deepEqual(await f.service.scanOnce(),{enqueued:0});await f.service.close();
    });
    await t.test('pause atomically cancels pending work and rejects stale revisions; reactivation excludes backlog',async()=>{
      const f=await fixture();const policy=await f.activate();await f.addJob();assert.equal((await f.service.scanOnce()).enqueued,1);
      await assert.rejects(f.service.pause(f.workspaceId,policy.id,99),{code:'AI_POLICY_CHANGED'});
      const paused=await f.service.pause(f.workspaceId,policy.id,1);assert.equal(paused.paused,true);assert.equal(paused.revision,2);assert.equal(f.cancelled.length,1);
      assert.equal((await client.query(`SELECT status FROM ai_runs WHERE id=$1`,[f.cancelled[0]])).rows[0].status,'CANCELLED');
      f.setNow(new Date(f.getNow().getTime()+60_000));await f.activate();assert.equal((await f.service.scanOnce()).enqueued,0);await f.addJob();assert.equal((await f.service.scanOnce()).enqueued,1);await f.service.close();
    });
    await t.test('exact fact copies across preference revisions remain selected; edited facts pause without dispatch',async()=>{
      const f=await fixture();await f.activate({selectedFactIds:[f.factId]});
      const nextProfile=randomUUID(),copyId=randomUUID();await client.query(`INSERT INTO profile_versions(id,workspace_id,revision,profile) VALUES($1,$2,2,'{}')`,[nextProfile,f.workspaceId]);
      await client.query(`INSERT INTO profile_facts(id,workspace_id,profile_version_id,kind,statement,tags,source,approval_status,created_at) SELECT $1,workspace_id,$2,kind,statement,tags,source,approval_status,created_at FROM profile_facts WHERE id=$3`,[copyId,nextProfile,f.factId]);
      await f.addJob();assert.equal((await f.service.scanOnce()).enqueued,1);
      const row=(await client.query(`SELECT snapshot FROM ai_runs WHERE workspace_id=$1 AND origin='AUTOMATIC'`,[f.workspaceId])).rows[0];assert.deepEqual(row.snapshot.facts.map((fact:{factId:string})=>fact.factId),[copyId]);
      await client.query(`UPDATE profile_facts SET statement='Changed selected evidence.' WHERE id=$1`,[copyId]);await f.addJob();assert.equal((await f.service.scanOnce()).enqueued,0);
      const policy=(await f.service.list(f.workspaceId)).policies[0]!;assert.equal(policy.paused,true);assert.ok(f.events.includes('AUTOMATION_PAUSED'));await f.service.close();
    });
    await t.test('changed preview evidence and expired previews cannot activate',async()=>{
      const f=await fixture();const selected=await f.preview({selectedFactIds:[f.factId]});await client.query(`UPDATE profile_facts SET statement='Edited after preview.' WHERE id=$1`,[f.factId]);
      await assert.rejects(f.service.activate(f.workspaceId,{previewId:selected.previewId,idempotencyKey:randomUUID()}),{code:'AI_SOURCE_CHANGED'});
      const p=await f.preview();f.setNow(new Date(f.getNow().getTime()+300_000));await assert.rejects(f.service.activate(f.workspaceId,{previewId:p.previewId,idempotencyKey:randomUUID()}),{code:'AI_PREVIEW_EXPIRED'});await f.service.close();
    });
    await t.test('search edits invalidate exact previews and cross-workspace activation is opaque',async()=>{
      const f=await fixture();const p=await f.preview();
      await assert.rejects(f.service.activate(randomUUID(),{previewId:p.previewId,idempotencyKey:randomUUID()}),{code:'AI_PREVIEW_EXPIRED'});
      await client.query(`UPDATE saved_job_searches SET role='Support',revision=revision+1 WHERE id=$1`,[f.searches[0]]);
      await assert.rejects(f.service.activate(f.workspaceId,{previewId:p.previewId,idempotencyKey:randomUUID()}),{code:'AI_SEARCH_CHANGED'});await f.service.close();
    });
    await t.test('old activation retries report current inactive state after a replacement policy',async()=>{
      const f=await fixture();const p=await f.preview();const request={previewId:p.previewId,idempotencyKey:randomUUID()};
      const first=await f.service.activate(f.workspaceId,request);const second=await f.activate();assert.notEqual(first.id,second.id);
      const retry=await f.service.activate(f.workspaceId,request);assert.equal(retry.active,false);assert.equal(retry.paused,true);await f.service.close();
    });
    await t.test('an oversized public posting does not pause remaining automatic searches',async()=>{
      const f=await fixture();await f.activate();const invalid=await f.addJob({score:100});const valid=await f.addJob({score:50});
      await client.query(`UPDATE job_snapshots SET description_text=$2 WHERE job_id=$1`,[invalid.id,'Synthetic public text. '.repeat(10_000)]);
      assert.equal((await f.service.scanOnce()).enqueued,1);
      assert.equal((await f.service.list(f.workspaceId)).policies[0]!.paused,false);
      assert.equal((await client.query(`SELECT snapshot->'job'->>'jobId' AS job_id FROM ai_runs WHERE workspace_id=$1 AND origin='AUTOMATIC'`,[f.workspaceId])).rows[0].job_id,valid.id);await f.service.close();
    });
  }finally{
    await pool?.end().catch(()=>undefined);await client?.end().catch(()=>undefined);
    if(created)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();
  }
});
