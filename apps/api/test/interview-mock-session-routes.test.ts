import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@career/db';
import { registerInterviewMockSessionRoutes } from '../src/interview-mock-session-routes.js';
import { registerInterviewPreparationRoutes } from '../src/interview-preparation-routes.js';

const root = new URL('../../../', import.meta.url);
const { Client, Pool } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_INTERVIEW_PREPARATION_TEST_ADMIN_URL;

const strong = 'When our team shipped a checkout service, I built the TypeScript API and decided to cache prices instead of calling the database, because latency mattered. As a result, page time fell from 900 ms to 300 ms for 2000 users.';
const weak = 'I tested things and it was fine.';
const unbacked = `${strong} I also used Playwright every day to test it, as a result releases were calmer and my role was to decide.`;

type Turn = { id: string; position: number; kind: string; itemId: string | null; question: string; answer: string | null; skipped: boolean; verdict: string | null; learningItems: string[];
  feedback: { probe: string | null; assessments: Array<{ criterion: string; status: string; source: string }> } | null };

test('a text mock session asks one question at a time, checks what it can observe, probes a weak answer once and never judges correctness', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'fixture must use loopback');
  assert.equal(maintenance.pathname, '/postgres', 'fixture URL must connect only through the maintenance database');
  const databaseName = `career_mock_session_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() });
  const app = Fastify({ logger: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;
  let pool: InstanceType<typeof Pool> | undefined;
  let closePool: (() => Promise<void>) | undefined;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    maintenance.pathname = `/${databaseName}`;
    client = new Client({ connectionString: maintenance.toString() });
    await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((entry) => /^\d{4}_.*\.sql$/.test(entry)).sort()) {
      for (const statement of (await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8')).split('--> statement-breakpoint').filter((part) => part.trim())) await client.query(statement);
    }
    pool = new Pool({ connectionString: maintenance.toString(), max: 5 });
    closePool = trackPgPoolCleanup(pool);
    const database = drizzle(pool, { schema });

    const owner = randomUUID(); const other = randomUUID();
    const [profileVersion, job, snapshot, fact, application, foreignApplication] = Array.from({ length: 6 }, () => randomUUID());
    await client.query('INSERT INTO workspaces(id) VALUES($1),($2)', [owner, other]);
    await client.query("INSERT INTO profile_versions(id,workspace_id,revision,profile) VALUES($1,$2,1,'{}')", [profileVersion, owner]);
    await client.query(`INSERT INTO profile_facts(id,workspace_id,profile_version_id,kind,statement,tags,approval_status) VALUES($1,$2,$3,'skill','Built TypeScript services for a fictional shop','["typescript"]','USER_APPROVED')`, [fact, owner, profileVersion]);
    await client.query("INSERT INTO jobs(id,workspace_id,company,title) VALUES($1,$2,'Synthetic Co','QA Engineer')", [job, owner]);
    await client.query("INSERT INTO job_snapshots(id,workspace_id,job_id,title,description_text,snapshot_hash) VALUES($1,$2,$3,'QA Engineer','Requirements: TypeScript and Playwright.',$4)", [snapshot, owner, job, 'b'.repeat(64)]);
    await client.query("INSERT INTO applications(id,workspace_id,company,role,job_id,recruitment_stage) VALUES($1,$2,'Synthetic Co','QA Engineer',$3,'INTERVIEW'),($4,$5,'Foreign Co','QA',NULL,'INTERVIEW')", [application, owner, job, foreignApplication, other]);

    const workspace = (request: { headers: Record<string, unknown> }) => request.headers['x-fixture-workspace'] === other ? other : owner;
    registerInterviewPreparationRoutes(app, workspace, database);
    registerInterviewMockSessionRoutes(app, workspace, database);
    const headers = { 'x-fixture-workspace': owner }; const foreignHeaders = { 'x-fixture-workspace': other };
    const post = (url: string, payload?: unknown, h = headers) => app.inject({ method: 'POST', url, headers: h, payload: payload as object });
    const patch = (url: string, payload: unknown, h = headers) => app.inject({ method: 'PATCH', url, headers: h, payload: payload as object });

    const plan = (await post(`/api/v1/applications/${application}/interview-preparation/build`, { language: 'en' })).json().plan as { id: string; items: Array<{ id: string; kind: string; position: number; content: string }> };
    const exercises = plan.items.filter((item) => item.kind === 'EXERCISE').sort((a, b) => a.position - b.position);
    assert.ok(exercises.length >= 3, 'the plan has practice exercises to ask');
    const sessionsUrl = `/api/v1/interview-preparation/${plan.id}/sessions`;
    const sessionUrl = (id: string, path = '') => `/api/v1/interview-preparation/sessions/${id}${path}`;
    const factsBefore = JSON.stringify((await client.query('SELECT id, statement, approval_status, tags FROM profile_facts ORDER BY id')).rows);

    // Starting: one question, the first practice exercise of the plan.
    assert.equal((await post(`/api/v1/interview-preparation/${randomUUID()}/sessions`)).statusCode, 404);
    assert.equal((await post(sessionsUrl, undefined, foreignHeaders)).statusCode, 404, 'another workspace cannot start a session');
    assert.equal((await post('/api/v1/interview-preparation/not-a-uuid/sessions')).statusCode, 400);
    const started = await post(sessionsUrl);
    assert.equal(started.statusCode, 201, started.body);
    const session = started.json().session as { id: string; status: string; turns: Turn[] };
    assert.equal(session.status, 'IN_PROGRESS'); assert.equal(session.turns.length, 1, 'only one question is asked');
    const first = session.turns[0]!;
    assert.deepEqual([first.position, first.kind, first.itemId, first.question, first.answer], [0, 'QUESTION', exercises[0]!.id, exercises[0]!.content, null]);
    const answer = (id: string, turnId: string, text: unknown, h = headers) => post(sessionUrl(id, '/answer'), { turnId, answer: text }, h);

    // Answer validation and ownership.
    assert.equal((await answer(session.id, first.id, '   ')).statusCode, 400, 'an empty answer is not an answer');
    assert.equal((await answer(session.id, first.id, 'x'.repeat(5001))).statusCode, 400);
    assert.equal((await post(sessionUrl(session.id, '/answer'), { turnId: first.id, answer: 'hi', extra: true })).statusCode, 400);
    assert.equal((await answer(session.id, randomUUID(), weak)).json().error, 'TURN_NOT_CURRENT');
    assert.equal((await answer(session.id, first.id, weak, foreignHeaders)).statusCode, 404, 'another workspace cannot answer');
    assert.equal((await answer(randomUUID(), first.id, weak)).statusCode, 404);

    // A weak answer is observed, followed up once, and never called correct.
    const weakReply = await answer(session.id, first.id, weak);
    assert.equal(weakReply.statusCode, 200, weakReply.body);
    const weakBody = weakReply.json() as { turn: Turn; next: Turn; done: boolean };
    assert.equal(weakBody.turn.answer, weak); assert.equal(weakBody.turn.verdict, 'NEEDS_WORK'); assert.equal(weakBody.done, false);
    const criteria = Object.fromEntries(weakBody.turn.feedback!.assessments.map((row) => [row.criterion, row]));
    assert.deepEqual([criteria.CORRECTNESS!.status, criteria.CORRECTNESS!.source], ['NOT_ASSESSED', 'CHECK'], 'the check never judges correctness');
    assert.equal(criteria.SPECIFICITY!.status, 'MISSING_EVIDENCE'); assert.equal(weakBody.turn.feedback!.probe, 'SPECIFICITY');
    assert.ok(weakBody.turn.learningItems.length > 0, 'learning items come from what was observed');
    assert.deepEqual([weakBody.next.kind, weakBody.next.position, weakBody.next.itemId], ['PROBE', 1, first.itemId], 'the follow-up stays on the same item');
    assert.equal((await answer(session.id, first.id, strong)).json().error, 'TURN_NOT_CURRENT', 'only the latest question can be answered, so an earlier answer is never replaced');

    // The answer to a follow-up never starts another; the session moves to the next exercise.
    const probeReply = (await answer(session.id, weakBody.next.id, weak)).json() as { turn: Turn; next: Turn; done: boolean };
    assert.equal(probeReply.turn.feedback!.probe, 'SPECIFICITY', 'it is still weak');
    assert.deepEqual([probeReply.next.kind, probeReply.next.itemId, probeReply.next.question], ['QUESTION', exercises[1]!.id, exercises[1]!.content], 'no second follow-up, the next exercise is asked');

    // A claim no approved fact backs is missing evidence, not an incorrect answer.
    const claimReply = (await answer(session.id, probeReply.next.id, unbacked)).json() as { turn: Turn; next: Turn };
    const claim = Object.fromEntries(claimReply.turn.feedback!.assessments.map((row) => [row.criterion, row.status]));
    assert.equal(claim.EVIDENCE, 'MISSING_EVIDENCE'); assert.notEqual(claim.CORRECTNESS, 'INCORRECT');
    assert.equal(claimReply.turn.feedback!.probe, 'EVIDENCE'); assert.equal(claimReply.next.kind, 'PROBE');
    assert.match(claimReply.turn.learningItems[0]!, /playwright/);

    // Skipping keeps the question from being asked again and still moves on.
    const skipped = (await post(sessionUrl(session.id, '/skip'), { turnId: claimReply.next.id })).json() as { turn: Turn; next: Turn | null; done: boolean };
    assert.deepEqual([skipped.turn.skipped, skipped.turn.answer, skipped.turn.verdict], [true, '', null]);
    assert.equal(skipped.next!.itemId, exercises[2]!.id);
    assert.equal((await post(sessionUrl(session.id, '/skip'), { turnId: claimReply.next.id })).json().error, 'TURN_NOT_CURRENT');

    // A strong, backed answer meets what can be observed, and still is not called correct on its own.
    const strongReply = (await answer(session.id, skipped.next!.id, strong)).json() as { turn: Turn; next: Turn | null; done: boolean };
    const good = Object.fromEntries(strongReply.turn.feedback!.assessments.map((row) => [row.criterion, row.status]));
    assert.deepEqual([good.SPECIFICITY, good.EVIDENCE, good.STRUCTURE, good.TRADE_OFFS, good.CORRECTNESS], ['MET', 'MET', 'MET', 'MET', 'NOT_ASSESSED']);
    assert.equal(strongReply.turn.verdict, 'NOT_ASSESSED'); assert.equal(strongReply.turn.feedback!.probe, null); assert.deepEqual(strongReply.turn.learningItems, []);
    // Everything asked is recorded in order; the rest of the exercises are asked one at a time until none is left.
    let next = strongReply.next; let asked = 3;
    while (next) { const reply = (await answer(session.id, next.id, strong)).json() as { next: Turn | null; done: boolean }; asked += 1; next = reply.next; if (!next) assert.equal(reply.done, true); }
    assert.equal(asked, exercises.length, 'every exercise is asked exactly once');
    const lastTurn = (await client.query('SELECT id FROM interview_preparation_turns WHERE session_id=$1 ORDER BY position DESC LIMIT 1', [session.id])).rows[0].id as string;
    assert.equal((await answer(session.id, lastTurn, strong)).json().error, 'ALREADY_ANSWERED', 'an answered question cannot be answered twice');
    const questionItems = (await client.query("SELECT item_id FROM interview_preparation_turns WHERE session_id=$1 AND kind='QUESTION' ORDER BY position", [session.id])).rows.map((row: { item_id: string }) => row.item_id);
    assert.deepEqual(questionItems, exercises.map((item) => item.id), 'in plan order, none repeated');

    // The person reviews: rates a criterion, edits the learning items, discards feedback. Skipped turns have nothing to review.
    const review = (turnId: string, payload: unknown, h = headers) => patch(`/api/v1/interview-preparation/sessions/turns/${turnId}`, payload, h);
    const rated = (await review(weakBody.turn.id, { selfAssessment: { CORRECTNESS: 'INCORRECT' }, learningItems: ['Practice with numbers', 'Practice with numbers', 'Read about caching'] })).json().turn as Turn;
    assert.deepEqual(rated.feedback!.assessments.find((row) => row.criterion === 'CORRECTNESS'), { criterion: 'CORRECTNESS', status: 'INCORRECT', source: 'SELF', note: null });
    assert.equal(rated.feedback!.assessments.find((row) => row.criterion === 'SPECIFICITY')!.source, 'CHECK', 'only the rated criterion changes');
    assert.equal(rated.verdict, 'NEEDS_WORK'); assert.deepEqual(rated.learningItems, ['Practice with numbers', 'Read about caching'], 'duplicates are dropped');
    const trusted = (await review(strongReply.turn.id, { selfAssessment: { CORRECTNESS: 'MET' } })).json().turn as Turn;
    assert.equal(trusted.verdict, 'GOOD_SO_FAR', 'good only when the person rated it correct and nothing is open');
    const discarded = (await review(weakBody.turn.id, { discardFeedback: true })).json().turn as Turn;
    assert.deepEqual([discarded.feedback, discarded.verdict], [null, 'NOT_ASSESSED']);
    assert.equal((await review(weakBody.turn.id, { selfAssessment: { CORRECTNESS: 'MET' } })).json().error, 'FEEDBACK_DISCARDED');
    assert.equal((await review(skipped.turn.id, { learningItems: ['x'] })).json().error, 'TURN_NOT_ANSWERED');
    assert.equal((await review(weakBody.turn.id, {})).statusCode, 400, 'there must be something to change');
    assert.equal((await review(weakBody.turn.id, { selfAssessment: { TASTE: 'MET' } })).statusCode, 400, 'only rubric criteria');
    assert.equal((await review(weakBody.turn.id, { selfAssessment: { CORRECTNESS: 'GREAT' } })).statusCode, 400, 'only rubric statuses');
    assert.equal((await review(weakBody.turn.id, { learningItems: Array.from({ length: 11 }, (_, index) => `item ${index}`) })).statusCode, 400);
    assert.equal((await review(weakBody.turn.id, { learningItems: ['x'] }, foreignHeaders)).statusCode, 404, 'another workspace cannot review');
    assert.equal((await review(weakBody.turn.id, { answer: 'a different answer' })).statusCode, 400, 'the answer itself cannot be rewritten');

    // Completing drops a question that was asked but never answered, and closes the session.
    const second = (await post(sessionsUrl)).json().session as { id: string; turns: Turn[] };
    assert.equal(second.turns[0]!.itemId, exercises[0]!.id, 'a new session starts from the beginning');
    await answer(second.id, second.turns[0]!.id, strong);
    const completed = (await post(sessionUrl(second.id, '/complete'))).json().session as { status: string; endedAt: string | null; turns: Turn[] };
    assert.deepEqual([completed.status, Boolean(completed.endedAt), completed.turns.length], ['COMPLETED', true, 1], 'the open question is dropped');
    assert.equal((await post(sessionUrl(second.id, '/complete'))).json().session.status, 'COMPLETED', 'completing twice is harmless');
    assert.equal((await answer(second.id, second.turns[0]!.id, strong)).json().error, 'SESSION_COMPLETED');
    assert.equal((await post(sessionUrl(second.id, '/skip'), { turnId: second.turns[0]!.id })).json().error, 'SESSION_COMPLETED');
    assert.equal((await post(sessionUrl(second.id, '/complete'), undefined, foreignHeaders)).statusCode, 404);
    assert.equal((await review(second.turns[0]!.id, { learningItems: ['Still editable after completing'] })).statusCode, 200, 'feedback can be reviewed after the session');
    assert.equal((await app.inject({ url: sessionUrl(second.id), headers })).json().session.turns.length, 1);
    assert.equal((await app.inject({ url: sessionUrl(second.id), headers: foreignHeaders })).statusCode, 404);
    const opened = (await app.inject({ url: `/api/v1/interview-preparation/${plan.id}`, headers })).json().plan;
    assert.equal(opened.sessions.length, 2); assert.ok(opened.sessions.every((row: { turns: Turn[] }) => row.turns.every((turn) => 'verdict' in turn && 'skipped' in turn)));

    // Preparation only: no approved fact changed and no assistant was used or asked.
    assert.equal(JSON.stringify((await client.query('SELECT id, statement, approval_status, tags FROM profile_facts ORDER BY id')).rows), factsBefore, 'practice changes no approved fact');
    assert.equal(Number((await client.query('SELECT count(*)::int AS n FROM ai_runs')).rows[0].n), 0, 'the no-assistant path never uses an assistant');

    // A plan without practice exercises has nothing to ask; deleting a session removes its turns.
    await client.query("DELETE FROM interview_preparation_items WHERE plan_id=$1 AND kind='EXERCISE'", [plan.id]);
    assert.equal((await post(sessionsUrl)).json().error, 'NO_PRACTICE_ITEMS');
    assert.equal((await app.inject({ method: 'DELETE', url: sessionUrl(session.id), headers })).statusCode, 200);
    assert.equal(Number((await client.query('SELECT count(*)::int AS n FROM interview_preparation_turns WHERE session_id=$1', [session.id])).rows[0].n), 0);
    assert.equal(Number((await client.query('SELECT count(*)::int AS n FROM interview_preparation_turns WHERE session_id=$1', [second.id])).rows[0].n), 1);
    void foreignApplication;
  } finally {
    await app.close();
    await closePool?.();
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});
