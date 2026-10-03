import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, after, describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { AssistedBrowser } from '../src/assisted-browser.js';
import type { AssistedPlan } from '@career/domain';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const requireDb = createRequire(join(root, 'packages/db/package.json'));
const adminUrl = process.env.CAREER_ASSIST_TEST_ADMIN_URL;
class FakeBrowser extends AssistedBrowser {
  active = new Map<string, () => Promise<void>>(); starts = 0; handoffs = 0;
  override busy() { return this.active.size > 0; }
  override has(id: string) { return this.active.has(id); }
  override async start(id: string, _plan: AssistedPlan, onLost: () => Promise<void>) { this.starts++; this.active.set(id, onLost); return { filled: ['name','email'], manual: ['resume','submit'] }; }
  override async handoff(id: string) { if (!this.has(id)) throw new Error('ASSIST_BROWSER_LOST'); this.handoffs++; }
  override async close(id: string) { this.active.delete(id); }
  override async closeAll() { this.active.clear(); }
}

describe('assisted routes with fictional data and a disposable database', { skip: !adminUrl && 'set CAREER_ASSIST_TEST_ADMIN_URL', concurrency: false }, () => {
  type Client = { connect(): Promise<void>; end(): Promise<void>; query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
  const { Client: PgClient } = requireDb('pg') as { Client: new (options: { connectionString: string }) => Client };
  const name = `career_assist_${randomBytes(6).toString('hex')}`;
  let admin: Client; let sql: Client; let directory: string; let app: FastifyInstance; let browser: FakeBrowser;
  let runtime: { stopAll(): Promise<void> };
  let pool: { end(): Promise<void> }; let register: typeof import('../src/assisted-routes.js').registerAssistedRoutes;
  let workspace = ''; const envBefore = { ...process.env };
  before(async () => {
    const url = new URL(adminUrl!);
    assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
    assert.ok(['postgres','template1'].includes(url.pathname.slice(1)), 'use maintenance DB only');
    admin = new PgClient({ connectionString: url.toString() }); await admin.connect();
    await admin.query(`create database "${name}"`);
    url.pathname = `/${name}`; directory = await mkdtemp(join(tmpdir(), 'career-assist-'));
    process.env.DATABASE_URL = url.toString(); process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('hex'); process.env.APP_SESSION_SECRET = randomBytes(32).toString('hex');
    process.env.DATA_LOCAL_PATH = directory; process.env.FILES_LOCAL_PATH = directory; process.env.NODE_ENV = 'test';
    sql = new PgClient({ connectionString: url.toString() }); await sql.connect();
    for (const file of (await readdir(join(root,'packages/db/migrations'))).filter(n=>n.endsWith('.sql')).sort()) await sql.query(await readFile(join(root,'packages/db/migrations',file),'utf8'));
    register = (await import('../src/assisted-routes.js')).registerAssistedRoutes;
    pool = (await import('@career/db')).pool;
    browser = new FakeBrowser(); app = Fastify(); runtime = await register(app, () => workspace, browser);
  });
  after(async () => {
    await app?.close(); await pool?.end(); await sql?.end();
    if (admin) { await admin.query(`drop database if exists "${name}" with (force)`); await admin.end(); }
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
  });
  async function fixture() {
    workspace = randomUUID(); const profile = randomUUID(); const fact = randomUUID(); const doc = randomUUID(); const application = randomUUID(); const bytes = Buffer.from('%PDF-fictional');
    await sql.query('insert into workspaces(id,name) values($1,$2)',[workspace,'Fictional']);
    await sql.query('insert into profile_versions(id,workspace_id,revision,profile) values($1,$2,1,$3)',[profile,workspace,JSON.stringify({identity:{fullName:'Fictional Candidate',email:'candidate@example.test',country:'ES'}})]);
    await sql.query("insert into profile_facts(id,workspace_id,profile_version_id,kind,statement,approval_status) values($1,$2,$3,'experience','Fictional experience','USER_APPROVED')",[fact,workspace,profile]);
    await writeFile(join(directory,`${doc}.pdf`),bytes);
    await sql.query("insert into document_versions(id,workspace_id,name,revision,profile_revision_id,media_type,storage_path,sha256,claims,approval_status) values($1,$2,'Fictional CV',1,$3,'application/pdf',$4,$5,$6,'USER_APPROVED')",[doc,workspace,profile,`${doc}.pdf`,createHash('sha256').update(bytes).digest('hex'),JSON.stringify([{text:'Fictional experience',sourceFactIds:[fact],approvalStatus:'USER_REVIEWED'}])]);
    await sql.query("insert into applications(id,workspace_id,company,role,canonical_url) values($1,$2,'Example','Engineer',$3)",[application,workspace,'https://jobs.lever.co/example/11111111-1111-4111-8111-111111111111']);
    return {application,doc,profile,fact};
  }
  const post = (url: string, payload: object) => app.inject({method:'POST',url:`/api/v1${url}`,payload});
  async function prepare(application: string, doc: string) { const res = await post(`/applications/${application}/assist/prepare`,{documentId:doc}); assert.equal(res.statusCode,200,res.body); return res.json(); }
  async function start(attempt: {id:string;digest:string}) { return post(`/assisted-attempts/${attempt.id}/start`,{consent:true,expectedDigest:attempt.digest}); }
  const resolveAttempt = (id: string, outcome: string) => post(`/assisted-attempts/${id}/resolve`,{outcome,confirmReviewed:true,reason:'Checked fictional fixture'});

  test('prepare is local and duplicate attempts are refused', async () => {
    const f=await fixture(); const count=browser.starts; const a=await prepare(f.application,f.doc); assert.equal(a.status,'PREPARED'); assert.equal(browser.starts,count);
    const duplicate=await post(`/applications/${f.application}/assist/prepare`,{documentId:f.doc}); assert.equal(duplicate.json().error,'ASSIST_ACTIVE_ATTEMPT');
    await post(`/assisted-attempts/${a.id}/cancel`,{});
  });
  test('explicit matching consent only; one-use start and handoff require separate confirmations', async () => {
    const f=await fixture(); const a=await prepare(f.application,f.doc);
    assert.equal((await post(`/assisted-attempts/${a.id}/start`,{consent:false,expectedDigest:a.digest})).statusCode,400);
    assert.equal((await post(`/assisted-attempts/${a.id}/start`,{consent:true,expectedDigest:'0'.repeat(64)})).json().error,'ASSIST_INPUTS_CHANGED');
    assert.equal((await start(a)).json().status,'REVIEW'); assert.equal((await start(a)).statusCode,409);
    assert.equal((await post(`/assisted-attempts/${a.id}/handoff`,{})).statusCode,400);
    assert.equal((await post(`/assisted-attempts/${a.id}/handoff`,{confirmReviewed:true})).json().status,'HANDED_OFF');
    assert.equal((await sql.query('select state from applications where id=$1',[f.application])).rows[0]!.state,'IN_PROGRESS');
    assert.equal((await resolveAttempt(a.id,'CONFIRMED')).json().status,'CONFIRMED'); assert.equal(browser.has(a.id),false);
    assert.equal((await post(`/applications/${f.application}/assist/prepare`,{documentId:f.doc})).json().error,'ASSIST_APPLICATION_CLOSED');
  });
  test('expired grants never open a browser and may be replaced', async () => {
    const f=await fixture(); const a=await prepare(f.application,f.doc); const count=browser.starts;
    await sql.query("update assisted_attempts set expires_at=now()-interval '1 minute' where id=$1",[a.id]);
    assert.equal((await start(a)).json().error,'ASSIST_CONSENT_EXPIRED'); assert.equal(browser.starts,count);
    const next=await prepare(f.application,f.doc); assert.notEqual(next.id,a.id); await post(`/assisted-attempts/${next.id}/cancel`,{});
  });
  test('changed application, revoked facts and damaged PDFs invalidate prepared input', async () => {
    const f=await fixture(); const a=await prepare(f.application,f.doc);
    await sql.query('update applications set version=version+1 where id=$1',[f.application]); assert.equal((await start(a)).json().error,'ASSIST_INPUTS_CHANGED');
    await post(`/assisted-attempts/${a.id}/cancel`,{});
    const b=await prepare(f.application,f.doc); await sql.query("update profile_facts set approval_status='REJECTED' where id=$1",[f.fact]); assert.equal((await start(b)).json().error,'ASSIST_DOCUMENT_STALE');
    await sql.query("update profile_facts set approval_status='USER_APPROVED' where id=$1",[f.fact]); await writeFile(join(directory,`${f.doc}.pdf`),'damaged'); assert.equal((await start(b)).json().error,'ASSIST_DOCUMENT_STALE');
    await post(`/assisted-attempts/${b.id}/cancel`,{});
  });
  test('unknown result blocks retries until explicit reconciliation', async () => {
    const f=await fixture(); const a=await prepare(f.application,f.doc); assert.equal((await start(a)).statusCode,200);
    await post(`/assisted-attempts/${a.id}/handoff`,{confirmReviewed:true});
    assert.equal((await post(`/assisted-attempts/${a.id}/cancel`,{})).json().status,'UNKNOWN');
    assert.equal((await post(`/applications/${f.application}/assist/prepare`,{documentId:f.doc})).json().error,'ASSIST_ACTIVE_ATTEMPT');
    assert.equal((await resolveAttempt(a.id,'UNKNOWN')).json().status,'UNKNOWN');
    assert.equal((await resolveAttempt(a.id,'NOT_SUBMITTED')).json().status,'NOT_SUBMITTED');
    const b=await prepare(f.application,f.doc); await post(`/assisted-attempts/${b.id}/cancel`,{});
  });
  test('browser loss is durable and stale profile prevents handoff', async () => {
    const f=await fixture(); const a=await prepare(f.application,f.doc); await start(a);
    await sql.query("update profile_versions set profile='{}'::jsonb where id=$1",[f.profile]);
    assert.equal((await post(`/assisted-attempts/${a.id}/handoff`,{confirmReviewed:true})).json().error,'ASSIST_PROFILE_REQUIRED');
    await browser.active.get(a.id)!(); assert.equal((await sql.query('select status from assisted_attempts where id=$1',[a.id])).rows[0]!.status,'UNKNOWN');
    await resolveAttempt(a.id,'NOT_SUBMITTED');
  });
  test('workspace isolation hides attempts; restart invalidates pending grants', async () => {
    const f=await fixture(); const a=await prepare(f.application,f.doc); const saved=workspace; workspace=randomUUID(); assert.equal((await start(a)).statusCode,404); workspace=saved;
    const restarted=Fastify(); await register(restarted,()=>workspace,new FakeBrowser()); await restarted.close();
    assert.equal((await start(a)).json().error,'ASSIST_CONSENT_ALREADY_USED');
    assert.equal((await sql.query('select status from assisted_attempts where id=$1',[a.id])).rows[0]!.status,'INVALIDATED');
  });
  test('ending the local session closes browser and invalidates unused permissions', async () => {
    const f=await fixture(); const a=await prepare(f.application,f.doc); await start(a);
    await runtime.stopAll(); assert.equal(browser.has(a.id),false);
    assert.equal((await sql.query('select status from assisted_attempts where id=$1',[a.id])).rows[0]!.status,'UNKNOWN');
    assert.equal((await sql.query('select state from applications where id=$1',[f.application])).rows[0]!.state,'UNKNOWN');
    const other=await fixture(); const unused=await prepare(other.application,other.doc); await runtime.stopAll();
    assert.equal((await sql.query('select status from assisted_attempts where id=$1',[unused.id])).rows[0]!.status,'INVALIDATED');
  });

});
