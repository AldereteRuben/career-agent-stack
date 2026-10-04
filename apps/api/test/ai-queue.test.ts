import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { createAiQueue, type EnqueueAiRunInput, type StoreAiArtifactInput } from '../src/ai/queue.js';
import { buildAiSourceSnapshot } from '../src/ai/source-snapshot.js';
import { hashAiInputContent } from '../src/ai/prompts.js';

const root = new URL('../../../', import.meta.url);
const { Client, Pool } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_V090_QUEUE_TEST_ADMIN_URL;
const fingerprint = 'a'.repeat(64);
const key = () => randomBytes(32).toString('hex');
const output: StoreAiArtifactInput = { schemaVersion:1,promptVersion:'career-assistant-v1',locale:'en',sources:{},output:{schemaVersion:1,operation:'SEARCH_DRAFT',locale:'en',criteria:{role:'QA',company:null,location:null,workMode:'remote'},unsupportedConstraints:[],clarifications:[]} };

test('persistent queue against a disposable PostgreSQL database', { skip: !adminUrl }, async (t) => {
  const maintenance = new URL(adminUrl!);
  assert.ok(['127.0.0.1','localhost','::1'].includes(maintenance.hostname));
  assert.equal(maintenance.pathname,'/postgres');
  const name = `career_aiq_${randomBytes(5).toString('hex')}`;
  const admin = new Client({connectionString:maintenance.toString()});
  // pg is resolved through the existing DB package; no app connection/configuration is read.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client:any; let pool:any;
  try {
    await admin.connect(); await admin.query(`CREATE DATABASE "${name}"`);
    maintenance.pathname=`/${name}`; client=new Client({connectionString:maintenance.toString()}); await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations',root))).filter(f=>/^\d{4}_.*\.sql$/.test(f)).sort()) {
      for (const statement of (await readFile(new URL(`packages/db/migrations/${file}`,root),'utf8')).split('--> statement-breakpoint').filter(part=>part.trim())) await client.query(statement);
    }
    pool=new Pool({connectionString:maintenance.toString(),max:8}); const queue=createAiQueue(pool);
    const reset=()=>client.query('TRUNCATE workspaces CASCADE');
    const state=async(id:string)=>(await client.query('SELECT * FROM ai_runs WHERE id=$1',[id])).rows[0];
    const fixture=async(options:{automatic?:boolean;accountKey?:string;remembered?:boolean;maximum?:number}={})=>{
      const workspaceId=randomUUID(),connectionId=randomUUID(),consentId=randomUUID(),searchId=randomUUID(),policyId=randomUUID(),searchRunId=randomUUID();
      await client.query('INSERT INTO workspaces(id) VALUES($1)',[workspaceId]);
      await client.query(`INSERT INTO ai_connections(id,workspace_id,provider,account_fingerprint,state) VALUES($1,$2,'codex',$3,'CONNECTED')`,[connectionId,workspaceId,fingerprint]);
      await client.query(`INSERT INTO ai_consents(id,workspace_id,connection_id,provider,account_fingerprint,connection_revision,revision,operation,data_categories,search_ids,notice_version,remembered) VALUES($1,$2,$3,'codex',$4,1,1,$5,$6,$7,'notice-v1',$8)`,[consentId,workspaceId,connectionId,fingerprint,options.automatic?'JOB_ANALYSIS':'SEARCH_DRAFT',JSON.stringify([options.automatic?'JOB_POSTING':'SEARCH_REQUEST']),options.automatic?JSON.stringify([searchId]):null,options.remembered ?? true]);
      if(options.automatic){
        await client.query("INSERT INTO saved_job_searches(id,workspace_id,matcher_version,role) VALUES($1,$2,2,'QA')",[searchId,workspaceId]);
        const criteria={role:'QA',company:null,location:null,workMode:'any',includeRelated:false,matcherVersion:2,providerIds:['remotive','arbeitnow']};
        await client.query(`INSERT INTO search_runs(id,workspace_id,search_id,revision,criteria,status,finished_at) VALUES($1,$2,$3,1,$4,'SUCCEEDED',now())`,[searchRunId,workspaceId,searchId,JSON.stringify(criteria)]);
        await client.query(`INSERT INTO ai_automation_policies(id,workspace_id,connection_id,consent_id,search_ids,active,paused,maximum_daily_starts,activated_at) VALUES($1,$2,$3,$4,$5,true,false,$6,'2000-01-01')`,[policyId,workspaceId,connectionId,consentId,JSON.stringify([searchId]),options.maximum ?? 10]);
      }
      const accountKey=options.accountKey ?? key(); const passId=randomUUID();
      const make=async(overrides:Partial<EnqueueAiRunInput>={}):Promise<EnqueueAiRunInput>=>{
        let snapshot=buildAiSourceSnapshot(workspaceId,{operation:'SEARCH_DRAFT',locale:'en',searchRequest:'Remote QA jobs'},{});
        if(options.automatic){
          const jobId=randomUUID(); await client.query(`INSERT INTO jobs(id,workspace_id,title,company,availability) VALUES($1,$2,'QA','Synthetic','OPEN')`,[jobId,workspaceId]);
          await client.query('INSERT INTO saved_job_search_matches(workspace_id,search_id,job_id) VALUES($1,$2,$3)',[workspaceId,searchId,jobId]);
          await client.query(`INSERT INTO search_run_results(workspace_id,search_id,run_id,job_id,score,location_status) VALUES($1,$2,$3,$4,1,'known')`,[workspaceId,searchId,searchRunId,jobId]);
          snapshot=buildAiSourceSnapshot(workspaceId,{operation:'JOB_ANALYSIS',locale:'en',jobId},{job:{id:jobId,workspaceId,title:'QA',company:'Synthetic',location:null},jobSnapshot:{id:randomUUID(),workspaceId,jobId,title:'QA',descriptionText:'Synthetic QA opening'}});
          await client.query("UPDATE ai_automation_policies SET selection_snapshot=$2,locale='en' WHERE id=$1 AND selection_snapshot IS NULL",[policyId,JSON.stringify(snapshot)]);
        }
        return {workspaceId,connectionId,consentId,connectionRevision:1,consentRevision:1,provider:'codex',accountFingerprint:fingerprint,operation:snapshot.operation,origin:options.automatic?'AUTOMATIC':'MANUAL',idempotencyKey:randomUUID(),contentIdentity:key(),accountLockKey:accountKey,snapshot,snapshotHash:snapshot.snapshotHash,inputVersions:{},...(options.automatic?{searchId,automationPolicyId:policyId,automationPolicyRevision:1,reservationPassId:passId}:{}),...overrides};
      };
      return {workspaceId,connectionId,consentId,searchId,policyId,make};
    };
    await t.test('idempotency, conflicts, forged snapshots and one-off grants',async()=>{
      await reset(); const f=await fixture({remembered:false}); const input=await f.make();
      const run=await queue.enqueue(input); assert.equal((await queue.enqueue(input)).id,run.id);
      await assert.rejects(queue.enqueue({...input,contentIdentity:key()}),{code:'IDEMPOTENCY_CONFLICT'});
      await assert.rejects(queue.enqueue(await f.make()),{code:'CONSENT_INVALID'});
      const changed={...input.snapshot,searchRequest:{text:'Changed',contentHash:key()}}; await assert.rejects(queue.enqueue({...input,snapshot:changed}),{code:'INVALID_INPUT'});
      assert.notEqual(hashAiInputContent(changed),input.snapshotHash);
      assert.equal(await queue.cancel(randomUUID(),run.id),false);
    });
    await t.test('healthy workers survive restart; expired worker and stale tokens are fenced',async()=>{
      await reset(); const f=await fixture(); const input=await f.make(); const run=await queue.enqueue(input); const now=new Date();
      const claimed=await queue.claimNext({workerId:'one',now,leaseMs:5000}); assert.equal(claimed?.id,run.id);
      assert.equal(await queue.recoverAfterRestart(now),0);
      assert.equal(await queue.finish(run.id,randomUUID(),{status:'FAILED'},now),false);
      assert.equal(await queue.recoverAfterRestart(new Date(now.getTime()+5001)),1);
      assert.equal((await state(run.id)).status,'INTERRUPTED');
      assert.equal(await queue.heartbeat(run.id,claimed!.leaseToken!,30000,new Date(now.getTime()+5002)),false);
      assert.equal((await client.query('SELECT availability,model FROM llm_usage WHERE ai_run_id=$1',[run.id])).rows[0].availability,'UNAVAILABLE');
    });
    await t.test('shared account concurrency, manual priority and three waiting manual slots',async()=>{
      await reset(); const shared=key(); const a=await fixture({accountKey:shared}),b=await fixture({accountKey:shared});
      const first=await queue.enqueue(await a.make()); await queue.enqueue(await b.make());
      const claims=await Promise.all([queue.claimNext({workerId:'a'}),queue.claimNext({workerId:'b'})]); assert.equal(claims.filter(Boolean).length,1);
      await queue.finish(claims.find(Boolean)!.id,claims.find(Boolean)!.leaseToken!,{status:'FAILED'});
      await reset(); const f=await fixture(); await queue.enqueue(await f.make()); const running=await queue.claimNext({workerId:'a'}); assert.ok(running);
      for(let i=0;i<3;i++)await queue.enqueue(await f.make());
      await assert.rejects(queue.enqueue(await f.make()),{code:'MANUAL_QUEUE_FULL'});
      assert.ok(first.id);
    });
    await t.test('finalize atomically creates artifact, terminal run and unknown usage',async()=>{
      await reset(); const f=await fixture(); const run=await queue.enqueue(await f.make()); const claimed=await queue.claimNext({workerId:'a'});
      let checked=false;
      const result=await queue.finalize(run.id,claimed!.leaseToken!,{artifact:output,verifySources:async(tx,live)=>{checked=true; assert.equal(live.leaseToken,claimed!.leaseToken); assert.equal((await tx.query('SELECT status FROM ai_runs WHERE id=$1',[run.id])).rows[0]!.status,'RUNNING'); return true;}});
      assert.ok(result); assert.ok(checked); assert.equal((await state(run.id)).status,'SUCCEEDED');
      const usage=(await client.query('SELECT availability,model,input_tokens,cost_usd FROM llm_usage WHERE ai_run_id=$1',[run.id])).rows[0];
      assert.deepEqual(usage,{availability:'UNAVAILABLE',model:null,input_tokens:null,cost_usd:null});
      assert.equal((await client.query('SELECT state,revision FROM ai_artifacts WHERE run_id=$1',[run.id])).rows[0].revision,1);
      assert.equal(await queue.finalize(run.id,claimed!.leaseToken!,{artifact:output,verifySources:async()=>true}),null);
    });
    await t.test('rollback, changed sources and cancellation cannot persist output',async()=>{
      await reset(); const f=await fixture(); let run=await queue.enqueue(await f.make()); let claimed=await queue.claimNext({workerId:'a'});
      await assert.rejects(queue.finalize(run.id,claimed!.leaseToken!,{artifact:output,verifySources:async()=>{throw new Error('sensitive source');}}),{code:'STORAGE_UNAVAILABLE'});
      assert.equal((await state(run.id)).status,'RUNNING'); assert.equal((await client.query('SELECT count(*)::int n FROM ai_artifacts')).rows[0].n,0);
      assert.equal(await queue.finalize(run.id,claimed!.leaseToken!,{artifact:output,verifySources:async()=>false}),null);
      assert.equal((await state(run.id)).error.code,'SOURCE_CHANGED');
      run=await queue.enqueue(await f.make()); claimed=await queue.claimNext({workerId:'a'}); await queue.cancel(f.workspaceId,run.id);
      assert.equal(await queue.finalize(run.id,claimed!.leaseToken!,{artifact:output,verifySources:async()=>true}),null);
      assert.equal(await queue.finish(run.id,claimed!.leaseToken!,{status:'FAILED'}),true); assert.equal((await state(run.id)).status,'CANCELLED');
      assert.equal((await client.query('SELECT count(*)::int n FROM ai_artifacts')).rows[0].n,0);
    });
    await t.test('permission changes cancel pending runs and release reservations once',async()=>{
      await reset(); const f=await fixture(); const a=await queue.enqueue(await f.make()),b=await queue.enqueue(await f.make()); const claimed=await queue.claimNext({workerId:'a'});
      assert.equal(await queue.revokeConsent(f.workspaceId,f.consentId),2);
      assert.equal(await queue.heartbeat(claimed!.id,claimed!.leaseToken!),false);
      assert.equal((await state(b.id)).status,'CANCELLED'); await queue.cancel(f.workspaceId,b.id);
      assert.equal((await client.query('SELECT manual_reserved FROM ai_daily_budgets WHERE workspace_id=$1',[f.workspaceId])).rows[0].manual_reserved,0);
      await queue.finish(a.id,claimed!.leaseToken!,{status:'FAILED'});
      await reset(); const g=await fixture(); const c=await queue.enqueue(await g.make()); await queue.revokeConnection(g.workspaceId,g.connectionId); assert.equal((await state(c.id)).status,'CANCELLED');
    });
    await t.test('new consent audit revisions leave prior unrevoked permission valid',async()=>{
      await reset(); const f=await fixture(); const run=await queue.enqueue(await f.make());
      await client.query(`INSERT INTO ai_consents(workspace_id,connection_id,provider,account_fingerprint,connection_revision,revision,operation,data_categories,notice_version) VALUES($1,$2,'codex',$3,1,2,'SEARCH_DRAFT','["SEARCH_REQUEST"]','notice-v1')`,[f.workspaceId,f.connectionId,fingerprint]);
      assert.equal((await queue.claimNext({workerId:'a'}))?.id,run.id);
    });
    await t.test('manual runs cannot reuse an automatic search-scoped grant',async()=>{
      await reset();const f=await fixture();await client.query('UPDATE ai_consents SET search_ids=$2 WHERE id=$1',[f.consentId,JSON.stringify([randomUUID()])]);
      await assert.rejects(queue.enqueue(await f.make()),{code:'CONSENT_INVALID'});
    });
    await t.test('answer publication holds the same scope lock as saved answer edits',async()=>{
      await reset();const f=await fixture(),questionId=randomUUID();
      await client.query(`INSERT INTO answer_versions(id,workspace_id,semantic_key,jurisdiction,question_scope,question_text,strategy,revision) VALUES($1,$2,'experience','ES','fixture','Describe your relevant work experience','DRAFT_FOR_REVIEW',1)`,[questionId,f.workspaceId]);
      await client.query(`UPDATE ai_consents SET operation='ANSWER_DRAFT',data_categories='["APPLICATION_QUESTION","APPROVED_FACTS"]' WHERE id=$1`,[f.consentId]);
      const snapshot=buildAiSourceSnapshot(f.workspaceId,{operation:'ANSWER_DRAFT',locale:'en',questionId,selectedFactIds:[]},{question:{id:questionId,workspaceId:f.workspaceId,questionText:'Describe your relevant work experience',jurisdiction:'ES',questionScope:'fixture'}});
      const run=await queue.enqueue(await f.make({operation:'ANSWER_DRAFT',snapshot,snapshotHash:snapshot.snapshotHash})),claimed=await queue.claimNext({workerId:'a'});
      const contender=await pool.connect();
      try{
        const finalized=await queue.finalize(run.id,claimed!.leaseToken!,{artifact:{...output,output:{schemaVersion:1,operation:'ANSWER_DRAFT',locale:'en',questionId,result:{status:'NEEDS_USER_INPUT',reason:'MISSING_FACT',explanation:'Add experience first'}}},verifySources:async()=>{
          const result=await contender.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[`answer:${f.workspaceId}:experience:ES:fixture`]);
          assert.equal(result.rows[0].acquired,false,'a new answer revision cannot commit during final source verification');
          return true;
        }});
        assert.ok(finalized);
      }finally{await contender.query('SELECT pg_advisory_unlock_all()');contender.release();}
    });
    await t.test('automatic scope, current published criteria, archived duplicates and paused policies',async()=>{
      await reset(); const f=await fixture({automatic:true}); const input=await f.make(); await queue.enqueue(input);
      await client.query('UPDATE saved_job_searches SET role=$2 WHERE id=$1',[f.searchId,'Different role']); assert.equal(await queue.claimNext({workerId:'a'}),null);
      await client.query("UPDATE saved_job_searches SET role='QA' WHERE id=$1",[f.searchId]);
      const next=await f.make(); const run=await queue.enqueue(next); const claimed=await queue.claimNext({workerId:'a'}); assert.equal(claimed?.id,run.id);
      await queue.pauseAutomation(f.workspaceId,f.policyId,1); assert.equal(await queue.heartbeat(run.id,claimed!.leaseToken!),false);
      await assert.rejects(queue.enqueue(await f.make()),{code:'CONSENT_INVALID'});
      await reset(); const g=await fixture({automatic:true}); const duplicate=await g.make(); const sibling=randomUUID();
      await client.query(`INSERT INTO jobs(id,workspace_id,title,company,availability,shortlist_decision) VALUES($1,$2,'QA','Synthetic','OPEN','ARCHIVED')`,[sibling,g.workspaceId]);
      for(const id of [duplicate.snapshot.job!.jobId,sibling])await client.query(`INSERT INTO job_identity_members(workspace_id,job_id,identity_key,evidence) VALUES($1,$2,$3,'{}')`,[g.workspaceId,id,'f'.repeat(64)]);
      await assert.rejects(queue.enqueue(duplicate),{code:'CONSENT_INVALID'});
    });
    await t.test('automatic runs cannot expand selected evidence, change language or use a tampered policy snapshot',async()=>{
      await reset();const f=await fixture({automatic:true});const original=await f.make();
      const differentLocale={...original.snapshot,locale:'es' as const};differentLocale.snapshotHash=hashAiInputContent(differentLocale);
      await assert.rejects(queue.enqueue({...original,snapshot:differentLocale,snapshotHash:differentLocale.snapshotHash}),{code:'CONSENT_INVALID'});
      const expanded={...original.snapshot,profileRevision:1,facts:[{factId:randomUUID(),approvalStatus:'USER_APPROVED' as const,kind:'skill',text:'Additional selected text',contentHash:key()}]};expanded.snapshotHash=hashAiInputContent(expanded);
      await client.query(`UPDATE ai_consents SET data_categories='["JOB_POSTING","APPROVED_FACTS"]' WHERE id=$1`,[f.consentId]);
      await assert.rejects(queue.enqueue({...original,snapshot:expanded,snapshotHash:expanded.snapshotHash}),{code:'CONSENT_INVALID'});
      await client.query(`UPDATE ai_automation_policies SET selection_snapshot=jsonb_set(selection_snapshot,'{snapshotHash}',to_jsonb($2::text)) WHERE id=$1`,[f.policyId,'0'.repeat(64)]);
      await assert.rejects(queue.enqueue(original),{code:'CONSENT_INVALID'});
    });
    await t.test('UTC rollover keeps prior reservations, counts actual start day and skips capped workspaces',async()=>{
      await reset(); const f=await fixture({automatic:true,maximum:1}); const old=new Date('2026-10-01T23:59:59Z'),now=new Date('2026-10-02T00:00:01Z');
      const input=await f.make({now:old}); const run=await queue.enqueue(input);
      await assert.rejects(queue.enqueue(await f.make({now})),{code:'DAILY_LIMIT'});
      const claimed=await queue.claimNext({workerId:'a',now}); assert.equal(claimed?.id,run.id);
      const days=(await client.query('SELECT control_day::text,automatic_reserved,automatic_started FROM ai_daily_budgets WHERE workspace_id=$1 ORDER BY control_day',[f.workspaceId])).rows;
      assert.deepEqual(days,[{control_day:'2026-10-01',automatic_reserved:0,automatic_started:0},{control_day:'2026-10-02',automatic_reserved:0,automatic_started:1}]);
      await queue.finish(run.id,claimed!.leaseToken!,{status:'FAILED'},now);
      await assert.rejects(queue.enqueue(await f.make({now:old})),{code:'CLOCK_INVALID'});
      await reset(); const a=await fixture({automatic:true,maximum:1}),b=await fixture({automatic:true});
      await queue.enqueue(await a.make()); const second=await queue.enqueue(await b.make());
      await client.query('UPDATE ai_daily_budgets SET automatic_started=1 WHERE workspace_id=$1',[a.workspaceId]);
      assert.equal((await queue.claimNext({workerId:'a'}))?.id,second.id);
    });
    await t.test('per-pass cap counts terminal reservations and automatic priority yields to manual',async()=>{
      await reset(); const f=await fixture({automatic:true});
      for(let i=0;i<5;i++){const run=await queue.enqueue(await f.make()); await queue.cancel(f.workspaceId,run.id);}
      await assert.rejects(queue.enqueue(await f.make()),{code:'PASS_LIMIT'});
      await reset(); const a=await fixture({automatic:true}),b=await fixture(); await queue.enqueue(await a.make()); const manual=await queue.enqueue(await b.make());
      assert.equal((await queue.claimNext({workerId:'a'}))?.id,manual.id);
    });
  } finally {
    await pool?.end().catch(()=>{}); await client?.end().catch(()=>{});
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(()=>{}); await admin.end();
  }
});
