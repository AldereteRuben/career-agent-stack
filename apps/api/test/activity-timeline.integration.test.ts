import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';

const root = new URL('../../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_TIMELINE_TEST_ADMIN_URL ?? process.env.CAREER_PREPARATION_TEST_ADMIN_URL ?? process.env.CAREER_DISCOVERY_TEST_ADMIN_URL;

describe('activity timeline with a disposable database', { skip: !adminUrl, concurrency: false }, () => {
  const dbName = `career_timeline_${randomBytes(6).toString('hex')}`;
  let admin: InstanceType<typeof Client>; let client: InstanceType<typeof Client>;
  let timeline: typeof import('../src/activity-timeline.js'); let reviewState: typeof import('../src/review-state.js');
  let closePool: (() => Promise<void>) | undefined;
  let workspace: string; let otherWorkspace: string;
  const ids: Record<string, string> = {};
  const originalDatabase = process.env.DATABASE_URL;
  // 2026-10-17 at 23:30 UTC is already 2026-10-18 in Madrid.
  const now = new Date('2026-10-17T23:30:00Z');

  before(async () => {
    const url = new URL(adminUrl!);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'test database must be local');
    assert.ok(['postgres', 'template1'].includes(url.pathname.slice(1)), 'maintenance database required');
    admin = new Client({ connectionString: url.toString() }); await admin.connect();
    await admin.query(`create database "${dbName}"`); url.pathname = `/${dbName}`;
    // Set before the first import of @career/db, which reads DATABASE_URL once.
    process.env.DATABASE_URL = url.toString();
    client = new Client({ connectionString: url.toString() }); await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((entry) => entry.endsWith('.sql')).sort()) await client.query(await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8'));
    timeline = await import('../src/activity-timeline.js'); reviewState = await import('../src/review-state.js');
    closePool = trackPgPoolCleanup((await import('@career/db')).pool);
  });
  after(async () => {
    await closePool?.(); await client?.end();
    if (admin) { await admin.query(`drop database if exists "${dbName}" with (force)`); await admin.end(); }
    if (originalDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabase;
  });

  const insertJob = async (key: string, owner: string, decision = 'UNREVIEWED', savedAt: string | null = null) => {
    ids[key] = randomUUID();
    await client.query("insert into jobs(id,workspace_id,company,title,availability,shortlist_decision,saved_at,created_at) values($1,$2,'Fictional Labs',$3,'OPEN',$4,$5,'2026-09-15T10:00:00Z')", [ids[key], owner, `Role ${key}`, decision, savedAt]);
  };
  const insertFoundJob = async (key: string, owner: string, createdAt: string, discoveredAt: string | null) => {
    ids[key] = randomUUID();
    await client.query("insert into jobs(id,workspace_id,company,title,availability,shortlist_decision,discovered_at,created_at) values($1,$2,'Fictional Labs',$3,'OPEN','UNREVIEWED',$4,$5)", [ids[key], owner, `Role ${key}`, discoveredAt, createdAt]);
  };
  const insertApplication = async (key: string, owner: string, fields: { createdAt: string; state?: string; stage?: string; followUp?: string | null; nextStep?: string | null; interviewAt?: string | null; interviewZone?: string | null }) => {
    ids[key] = randomUUID();
    await client.query(`insert into applications(id,workspace_id,company,role,state,recruitment_stage,follow_up_date,next_step,interview_at,interview_timezone,created_at,updated_at)
      values($1,$2,'Fictional Labs',$3,$4,$5,$6,$7,$8,$9,$10,$10)`, [ids[key], owner, `Application ${key}`, fields.state ?? 'DRAFT', fields.stage ?? 'NO_RESPONSE', fields.followUp ?? null, fields.nextStep ?? null, fields.interviewAt ?? null, fields.interviewZone ?? null, fields.createdAt]);
  };
  const insertEvent = (key: string, owner: string, eventType: string, prior: string | null, next: string | null, createdAt: string) =>
    client.query('insert into application_events(workspace_id,application_id,event_type,prior_state,new_state,aggregate_version,created_at) values($1,$2,$3,$4,$5,1,$6) returning id', [owner, ids[key], eventType, prior, next, createdAt]).then((result: { rows: Array<{ id: string }> }) => result.rows[0]!.id);
  const insertPlan = async (key: string, owner: string, applicationKey: string, createdAt: string) => {
    ids[key] = randomUUID();
    await client.query('insert into interview_preparation_plans(id,workspace_id,application_id,language,created_at,updated_at) values($1,$2,$3,\'en\',$4,$4)', [ids[key], owner, ids[applicationKey], createdAt]);
    return ids[key]!;
  };
  const insertSession = async (key: string, owner: string, planId: string, status: 'IN_PROGRESS' | 'COMPLETED', createdAt: string) => {
    ids[key] = randomUUID();
    await client.query('insert into interview_preparation_sessions(id,workspace_id,plan_id,status,ended_at,created_at) values($1,$2,$3,$4,$5,$6)', [ids[key], owner, planId, status, status === 'COMPLETED' ? createdAt : null, createdAt]);
    return ids[key]!;
  };

  beforeEach(async () => {
    // Plans restrict application deletion, so clear the preparation fixtures before resetting workspaces.
    await client.query('delete from interview_preparation_plans');
    await client.query('delete from workspaces'); workspace = randomUUID(); otherWorkspace = randomUUID();
    await client.query('insert into workspaces(id) values($1),($2)', [workspace, otherWorkspace]);
    await insertJob('saved', workspace, 'SHORTLISTED', '2026-10-03T10:00:00Z');
    await insertJob('savedBeforeDates', workspace, 'SHORTLISTED');
    await insertJob('foreignSaved', otherWorkspace, 'SHORTLISTED', '2026-10-03T10:00:00Z');
    await insertFoundJob('autoFound', workspace, '2026-10-05T22:30:00Z', '2026-10-05T22:30:00Z');
    await insertFoundJob('manualFound', workspace, '2026-10-06T12:00:00Z', null);
    await insertFoundJob('foreignFound', otherWorkspace, '2026-10-06T12:00:00Z', '2026-10-06T12:00:00Z');
    // 22:30 UTC on 5 October is 00:30 on 6 October in Madrid.
    await insertApplication('main', workspace, { createdAt: '2026-10-05T22:30:00Z', followUp: '2026-10-10', nextStep: 'Email the recruiter', interviewAt: '2026-10-20T23:30:00Z', interviewZone: 'America/New_York' });
    await insertApplication('planReady', workspace, { createdAt: '2026-09-02T09:00:00Z', interviewAt: '2026-10-21T10:00:00Z' });
    await insertApplication('mockInProgress', workspace, { createdAt: '2026-09-03T09:00:00Z', interviewAt: '2026-10-22T10:00:00Z' });
    await insertApplication('mockCompleted', workspace, { createdAt: '2026-09-04T09:00:00Z', interviewAt: '2026-10-23T10:00:00Z' });
    await insertApplication('today', workspace, { createdAt: '2026-09-01T09:00:00Z', followUp: '2026-10-18' });
    await insertApplication('old', workspace, { createdAt: '2026-07-01T09:00:00Z', followUp: '2026-08-01' });
    await insertApplication('cancelled', workspace, { createdAt: '2026-07-01T09:00:00Z', state: 'CANCELLED', followUp: '2026-10-02' });
    await insertApplication('rejected', workspace, { createdAt: '2026-07-01T09:00:00Z', stage: 'REJECTED', followUp: '2026-10-04' });
    await insertApplication('foreign', otherWorkspace, { createdAt: '2026-10-05T10:00:00Z', followUp: '2026-10-01', interviewAt: '2026-10-21T10:00:00Z', interviewZone: 'UTC' });
    const oldPlan = await insertPlan('oldPlan', workspace, 'planReady', '2026-09-10T09:00:00Z');
    await insertPlan('planReadyPlan', workspace, 'planReady', '2026-09-20T09:00:00Z');
    await insertSession('oldPlanSession', workspace, oldPlan, 'COMPLETED', '2026-09-11T09:00:00Z');
    const inProgressPlan = await insertPlan('inProgressPlan', workspace, 'mockInProgress', '2026-09-12T09:00:00Z');
    const inProgressSession = await insertSession('inProgressSession', workspace, inProgressPlan, 'IN_PROGRESS', '2026-09-13T09:00:00Z');
    const completedPlan = await insertPlan('completedPlan', workspace, 'mockCompleted', '2026-09-14T09:00:00Z');
    await insertSession('olderInProgressSession', workspace, completedPlan, 'IN_PROGRESS', '2026-09-15T09:00:00Z');
    await insertSession('completedSession', workspace, completedPlan, 'COMPLETED', '2026-09-16T09:00:00Z');
    const foreignPlan = await insertPlan('foreignPlan', otherWorkspace, 'foreign', '2026-09-17T09:00:00Z');
    await insertSession('foreignSession', otherWorkspace, foreignPlan, 'COMPLETED', '2026-09-18T09:00:00Z');
    await client.query('insert into interview_preparation_items(workspace_id,plan_id,kind,origin,position,content) values($1,$2,\'EXERCISE\',\'USER_NOTE\',0,$3)', [workspace, inProgressPlan, 'PRIVATE_PLAN_CONTENT_MARKER']);
    await client.query('insert into interview_preparation_turns(workspace_id,session_id,position,question,answer,feedback) values($1,$2,0,$3,$4,$5)', [workspace, inProgressSession, 'PRIVATE_QUESTION_MARKER', 'PRIVATE_ANSWER_MARKER', { note: 'PRIVATE_FEEDBACK_MARKER' }]);
    ids.submitted = await insertEvent('main', workspace, 'APPLICATION_STATE_CHANGED', 'READY', 'CONFIRMED', '2026-10-07T08:00:00Z');
    ids.stage = await insertEvent('main', workspace, 'RECRUITMENT_STAGE_CHANGED', 'NO_RESPONSE', 'INTERVIEW', '2026-10-08T08:00:00Z');
    ids.emailStage = await insertEvent('main', workspace, 'EMAIL_IMPORTED', 'INTERVIEW', 'OFFER', '2026-10-08T09:00:00Z');
    await insertEvent('main', workspace, 'EMAIL_IMPORTED', 'OFFER', 'OFFER', '2026-10-08T09:30:00Z');
    ids.correction = await insertEvent('main', workspace, 'RECRUITMENT_STAGE_CORRECTED', 'INTERVIEW', 'RECRUITER_CONTACT', '2026-10-09T08:00:00Z');
    await insertEvent('main', workspace, 'PREPARATION_CREATED', 'DRAFT', 'REVIEW_REQUIRED', '2026-10-07T09:00:00Z');
    await insertEvent('main', workspace, 'FOLLOW_UP_UPDATED', null, null, '2026-10-07T10:00:00Z');
    await insertEvent('main', workspace, 'NOTE', null, null, '2026-10-07T11:00:00Z');
    await insertEvent('foreign', otherWorkspace, 'RECRUITMENT_STAGE_CHANGED', 'NO_RESPONSE', 'OFFER', '2026-10-08T08:00:00Z');
  });

  const october = (timeZone: string, types = [...(['JOB_FOUND', 'JOB_SAVED', 'APPLICATION_CREATED', 'APPLICATION_STATUS_CHANGED', 'STAGE_CHANGED', 'INTERVIEW', 'FOLLOW_UP'] as const)]) =>
    timeline.loadTimeline(workspace, { from: '2026-10-01', to: '2026-10-31', timeZone, types, now });

  test('reports only stored, dated records of the workspace on the viewer\'s calendar days', async () => {
    const result = await october('Europe/Madrid');
    assert.equal(result.today, '2026-10-18');
    assert.equal(result.truncated, false);
    assert.deepEqual(result.items.map((item) => [item.type, item.day, item.application?.id ?? item.job?.id]), [
      ['JOB_SAVED', '2026-10-03', ids.saved],
      ['JOB_FOUND', '2026-10-06', ids.autoFound],
      ['APPLICATION_CREATED', '2026-10-06', ids.main],
      ['JOB_FOUND', '2026-10-06', ids.manualFound],
      ['APPLICATION_STATUS_CHANGED', '2026-10-07', ids.main],
      ['STAGE_CHANGED', '2026-10-08', ids.main],
      ['STAGE_CHANGED', '2026-10-08', ids.main],
      ['STAGE_CHANGED', '2026-10-09', ids.main],
      ['FOLLOW_UP', '2026-10-10', ids.main],
      ['FOLLOW_UP', '2026-10-18', ids.today],
      ['INTERVIEW', '2026-10-21', ids.main],
      ['INTERVIEW', '2026-10-21', ids.planReady],
      ['INTERVIEW', '2026-10-22', ids.mockInProgress],
      ['INTERVIEW', '2026-10-23', ids.mockCompleted],
    ]);
    const byId = new Map(result.items.map((item) => [item.id, item]));
    assert.deepEqual(byId.get(`APPLICATION_STATUS_CHANGED:${ids.submitted}`), { id: `APPLICATION_STATUS_CHANGED:${ids.submitted}`, type: 'APPLICATION_STATUS_CHANGED', day: '2026-10-07', at: '2026-10-07T08:00:00.000Z', application: { id: ids.main, role: 'Application main', company: 'Fictional Labs' }, priorState: 'READY', newState: 'CONFIRMED' });
    assert.equal(byId.get(`STAGE_CHANGED:${ids.stage}`)?.correction, false);
    assert.equal(byId.get(`STAGE_CHANGED:${ids.correction}`)?.correction, true);
    assert.equal(byId.get(`STAGE_CHANGED:${ids.emailStage}`)?.correction, false);
    assert.equal(byId.get(`INTERVIEW:${ids.main}`)?.interviewTimeZone, 'America/New_York');
    assert.equal(byId.get(`INTERVIEW:${ids.main}`)?.at, '2026-10-20T23:30:00.000Z');
    assert.deepEqual([byId.get(`INTERVIEW:${ids.main}`)?.interviewPreparationStatus, byId.get(`INTERVIEW:${ids.planReady}`)?.interviewPreparationStatus, byId.get(`INTERVIEW:${ids.mockInProgress}`)?.interviewPreparationStatus, byId.get(`INTERVIEW:${ids.mockCompleted}`)?.interviewPreparationStatus], ['NO_PLAN', 'PLAN_READY', 'MOCK_IN_PROGRESS', 'MOCK_COMPLETED']);
    assert.deepEqual([byId.get(`FOLLOW_UP:${ids.main}`)?.followUpStatus, byId.get(`FOLLOW_UP:${ids.main}`)?.nextStep, byId.get(`FOLLOW_UP:${ids.today}`)?.followUpStatus, byId.get(`FOLLOW_UP:${ids.today}`)?.at], ['overdue', 'Email the recruiter', 'due-today', null]);
    // Overdue follow-ups of open applications, whatever month is shown; closed applications are not pending.
    assert.deepEqual(result.overdue.items.map((item) => [item.application?.id, item.day]), [[ids.old, '2026-08-01'], [ids.main, '2026-10-10']]);
    assert.equal(result.overdue.total, 2);
    const serialized = JSON.stringify(result);
    for (const foreign of [ids.foreign, ids.foreignSaved, ids.foreignFound, ids.savedBeforeDates]) assert.ok(!serialized.includes(foreign!), 'no foreign or undated records');
    for (const privateValue of ['PRIVATE_PLAN_CONTENT_MARKER', 'PRIVATE_QUESTION_MARKER', 'PRIVATE_ANSWER_MARKER', 'PRIVATE_FEEDBACK_MARKER']) assert.ok(!serialized.includes(privateValue), 'timeline excludes interview preparation content');
  });

  test('found jobs use their stored creation day and identify automatic discovery', async () => {
    const result = await october('Europe/Madrid', ['JOB_FOUND']);
    assert.deepEqual(result.items.map((item) => [item.job?.id, item.day, item.automatic]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [
      [ids.autoFound, '2026-10-06', true], [ids.manualFound, '2026-10-06', false],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  });

  test('time zones move timed records between days but never move a follow-up date', async () => {
    const result = await october('UTC');
    assert.equal(result.today, '2026-10-17');
    const days = Object.fromEntries(result.items.map((item) => [item.id, item.day]));
    assert.equal(days[`APPLICATION_CREATED:${ids.main}`], '2026-10-05');
    assert.equal(days[`INTERVIEW:${ids.main}`], '2026-10-20');
    assert.equal(days[`FOLLOW_UP:${ids.main}`], '2026-10-10');
    // The 18th has not started in UTC yet, so that follow-up is still upcoming.
    assert.equal(result.items.find((item) => item.id === `FOLLOW_UP:${ids.today}`)?.followUpStatus, 'upcoming');
    // A creation at 22:30 UTC on 30 September is 1 October in Madrid, so it enters the Madrid month only.
    await insertApplication('edge', workspace, { createdAt: '2026-09-30T22:30:00Z' });
    assert.ok((await october('Europe/Madrid')).items.some((item) => item.id === `APPLICATION_CREATED:${ids.edge}`));
    assert.ok(!(await october('UTC')).items.some((item) => item.id === `APPLICATION_CREATED:${ids.edge}`));
  });

  test('type filters return only the requested records, and overdue follow-ups only with follow-ups', async () => {
    const interviews = await october('Europe/Madrid', ['INTERVIEW']);
    assert.equal(interviews.items.length, 4);
    assert.ok(interviews.items.every((item) => item.type === 'INTERVIEW'));
    assert.deepEqual(interviews.overdue, { total: 0, items: [] });
    const followUps = await october('Europe/Madrid', ['FOLLOW_UP']);
    assert.ok(followUps.items.every((item) => item.type === 'FOLLOW_UP'));
    assert.equal(followUps.overdue.total, 2);
  });

  test('saving dates the save once, keeps it while saved, clears it when unsaved, and never dates duplicates', async () => {
    await insertJob('original', workspace); await insertJob('duplicate', workspace);
    await client.query("insert into job_identity_members(workspace_id,job_id,identity_key,evidence) values($1,$2,'fixture-identity','{}'),($1,$3,'fixture-identity','{}')", [workspace, ids.original, ids.duplicate]);
    const savedAt = async (key: string) => (await client.query('select shortlist_decision,saved_at from jobs where id=$1', [ids[key]])).rows[0] as { shortlist_decision: string; saved_at: Date | null };
    await reviewState.decideJob(workspace, ids.original!, 'SHORTLISTED');
    const first = await savedAt('original');
    assert.equal(first.shortlist_decision, 'SHORTLISTED'); assert.ok(first.saved_at);
    assert.deepEqual(await savedAt('duplicate'), { shortlist_decision: 'SHORTLISTED', saved_at: null });
    await reviewState.decideJob(workspace, ids.duplicate!, 'SHORTLISTED');
    assert.equal((await savedAt('original')).saved_at?.getTime(), first.saved_at!.getTime(), 'saving again keeps the first date');
    assert.equal((await savedAt('duplicate')).saved_at, null);
    // A job saved before dates were recorded stays undated instead of being dated today.
    await reviewState.decideJob(workspace, ids.savedBeforeDates!, 'SHORTLISTED');
    assert.equal((await savedAt('savedBeforeDates')).saved_at, null);
    await reviewState.decideJob(workspace, ids.original!, 'SKIPPED');
    assert.deepEqual([(await savedAt('original')).saved_at, (await savedAt('duplicate')).saved_at], [null, null]);
  });

  test('the route validates input and serves the requesting workspace only', async () => {
    const app = Fastify(); timeline.registerActivityTimelineRoutes(app, (request) => String(request.headers['x-workspace']));
    try {
      const get = (query: string, owner = workspace) => app.inject({ method: 'GET', url: `/api/v1/timeline?${query}`, headers: { 'x-workspace': owner } });
      for (const bad of ['from=2026-10-01', 'from=2026-10-31&to=2026-10-01', 'from=2026-01-01&to=2026-12-31', 'from=2026-10-01&to=2026-10-31&tz=Not/AZone', 'from=2026-10-01&to=2026-10-31&types=NOT_A_TYPE', 'from=2026-10-01&to=2026-10-31&types=']) {
        const response = await get(bad); assert.equal(response.statusCode, 400, bad); assert.deepEqual(response.json(), { error: 'INVALID_INPUT' });
      }
      const found = await get('from=2026-10-01&to=2026-10-31&tz=Europe%2FMadrid&types=JOB_FOUND');
      assert.deepEqual(found.json().items.map((item: { job: { id: string }; automatic: boolean }) => [item.job.id, item.automatic]).sort((a: [string, boolean], b: [string, boolean]) => a[0].localeCompare(b[0])), [[ids.autoFound!, true], [ids.manualFound!, false]].sort((a, b) => a[0].localeCompare(b[0])));
      const mine = await get('from=2026-10-01&to=2026-10-31&tz=Europe%2FMadrid&types=INTERVIEW,STAGE_CHANGED');
      assert.equal(mine.statusCode, 200);
      assert.deepEqual(mine.json().items.map((item: { id: string; type: string; application: { id: string } }) => [item.id, item.type, item.application.id]), [
        [`STAGE_CHANGED:${ids.stage}`, 'STAGE_CHANGED', ids.main],
        [`STAGE_CHANGED:${ids.emailStage}`, 'STAGE_CHANGED', ids.main],
        [`STAGE_CHANGED:${ids.correction}`, 'STAGE_CHANGED', ids.main],
        [`INTERVIEW:${ids.main}`, 'INTERVIEW', ids.main],
        [`INTERVIEW:${ids.planReady}`, 'INTERVIEW', ids.planReady],
        [`INTERVIEW:${ids.mockInProgress}`, 'INTERVIEW', ids.mockInProgress],
        [`INTERVIEW:${ids.mockCompleted}`, 'INTERVIEW', ids.mockCompleted],
      ]);
      const prepStateBefore = await client.query(`select 'plan' as kind, id, created_at::text as created_at, updated_at::text as updated_at, null::text as status from interview_preparation_plans where workspace_id=$1
        union all select 'session', id, created_at::text, null::text, status from interview_preparation_sessions where workspace_id=$1 order by kind,id`, [workspace]);
      const response = await get('from=2026-10-01&to=2026-10-31&tz=Europe%2FMadrid&types=INTERVIEW');
      const prepStateAfter = await client.query(`select 'plan' as kind, id, created_at::text as created_at, updated_at::text as updated_at, null::text as status from interview_preparation_plans where workspace_id=$1
        union all select 'session', id, created_at::text, null::text, status from interview_preparation_sessions where workspace_id=$1 order by kind,id`, [workspace]);
      assert.deepEqual(prepStateAfter.rows, prepStateBefore.rows, 'GET timeline does not create or change preparation data');
      assert.deepEqual(response.json().items.map((item: { application: { id: string }; interviewPreparationStatus: string }) => [item.application.id, item.interviewPreparationStatus]).sort((a: [string, string], b: [string, string]) => a[0].localeCompare(b[0])), [
        [ids.main!, 'NO_PLAN'], [ids.planReady!, 'PLAN_READY'], [ids.mockInProgress!, 'MOCK_IN_PROGRESS'], [ids.mockCompleted!, 'MOCK_COMPLETED'],
      ].sort((a, b) => a[0].localeCompare(b[0])));
      const responseText = JSON.stringify(response.json());
      for (const privateValue of ['PRIVATE_PLAN_CONTENT_MARKER', 'PRIVATE_QUESTION_MARKER', 'PRIVATE_ANSWER_MARKER', 'PRIVATE_FEEDBACK_MARKER']) assert.ok(!responseText.includes(privateValue));
      assert.ok(!responseText.includes(ids.foreignPlan!) && !responseText.includes(ids.foreignSession!), 'foreign workspace preparation is not exposed');
      const theirs = await get('from=2026-10-01&to=2026-10-31&tz=UTC', otherWorkspace);
      const theirIds = new Set(theirs.json().items.map((item: { application?: { id: string }; job?: { id: string } }) => item.application?.id ?? item.job?.id));
      assert.deepEqual([...theirIds].sort(), [ids.foreign, ids.foreignSaved, ids.foreignFound].sort());
    } finally { await app.close(); }
  });
});
