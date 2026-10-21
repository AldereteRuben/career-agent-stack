import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@career/db';
import type { AiSourceSnapshot } from '@career/domain';
import { createAiDocumentRewordCancellation } from '../src/ai-application-document-routes.js';
import { registerAiInterviewPreparationRoutes } from '../src/ai-interview-preparation-routes.js';
import { interviewPreparationPlanLockKey, registerInterviewPreparationRoutes } from '../src/interview-preparation-routes.js';
import { createAiQueue } from '../src/ai/queue.js';
import { CodexExecutionError, type CodexDependencies, type CodexExecutionResult } from '../src/ai/codex.js';
import { lockKey, profileLockKey } from '../src/workspace-data.js';

const root = new URL('../../../', import.meta.url);
const { Client, Pool } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_V090_ROUTES_TEST_ADMIN_URL;

test('interview preparation suggestions: exact preview, one-off confirmation, nothing saved until accepted', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname));
  assert.equal(maintenance.pathname, '/postgres');
  const databaseName = `career_ai_prep_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() });
  const app = Fastify({ logger: false });
  const cancellation = createAiDocumentRewordCancellation();
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
    pool = new Pool({ connectionString: maintenance.toString(), max: 8 });
    closePool = trackPgPoolCleanup(pool);
    const database = drizzle(pool, { schema });
    const queue = createAiQueue(pool);

    const owner = randomUUID(); const other = randomUUID();
    const [profileVersion, job, snapshot, resume, fact, unrelatedFact, application, connection, foreignApplication] =
      Array.from({ length: 9 }, () => randomUUID()) as [string, string, string, string, string, string, string, string, string];
    const fingerprint = 'a'.repeat(64);
    await client.query('INSERT INTO workspaces(id) VALUES($1),($2)', [owner, other]);
    await client.query("INSERT INTO profile_versions(id,workspace_id,revision,profile) VALUES($1,$2,1,'{}')", [profileVersion, owner]);
    await client.query(`INSERT INTO profile_facts(id,workspace_id,profile_version_id,kind,statement,tags,approval_status) VALUES($1,$3,$4,'skill','Built TypeScript services for a fictional shop','["typescript"]','USER_APPROVED'),($2,$3,$4,'skill','Ran Kubernetes clusters for a fictional bank','["kubernetes"]','USER_APPROVED')`, [fact, unrelatedFact, owner, profileVersion]);
    await client.query("INSERT INTO jobs(id,workspace_id,company,title) VALUES($1,$2,'Synthetic Co','QA Engineer')", [job, owner]);
    await client.query("INSERT INTO job_snapshots(id,workspace_id,job_id,title,description_text,snapshot_hash) VALUES($1,$2,$3,'QA Engineer','Requirements: TypeScript and Playwright.',$4)", [snapshot, owner, job, 'b'.repeat(64)]);
    await client.query(`INSERT INTO document_versions(id,workspace_id,name,revision,media_type,storage_path,sha256,profile_revision_id,claims) VALUES($1,$2,'Resume',1,'application/pdf',$3,$4,$5,$6::jsonb)`, [resume, owner, `${owner}/resume.pdf`, 'd'.repeat(64), profileVersion, JSON.stringify([{ text: 'Submitted resume line about testing', sourceFactIds: [], approvalStatus: 'USER_APPROVED' }])]);
    await client.query("INSERT INTO applications(id,workspace_id,company,role,job_id,document_id,recruitment_stage) VALUES($1,$2,'Synthetic Co','QA Engineer',$3,$4,'INTERVIEW'),($5,$6,'Foreign Co','QA',NULL,NULL,'INTERVIEW')", [application, owner, job, resume, foreignApplication, other]);

    const workspace = (request: { headers: Record<string, unknown> }) => request.headers['x-fixture-workspace'] === other ? other : owner;
    const providerCalls: AiSourceSnapshot[] = [];
    let providerMode: 'ok' | 'invalid' = 'ok';
    let providerFailure: CodexExecutionError | null = null;
    let beforeDispatch: (() => Promise<void>) | undefined;
    let dispatchWait: Promise<void> | undefined;
    let onDispatch: (() => void) | undefined;
    const execute = (async (input: AiSourceSnapshot, _fingerprint: string, _salt: string, _signal?: AbortSignal, _model?: string,
      dependencies?: Partial<CodexDependencies>) => {
      await beforeDispatch?.();
      beforeDispatch = undefined;
      if (providerFailure) { const failure = providerFailure; providerFailure = null; throw failure; }
      const dispatch = async () => { providerCalls.push(input); onDispatch?.(); await dispatchWait; };
      if (dependencies?.dispatchGuard) await dependencies.dispatchGuard(dispatch);
      else await dispatch();
      const source = input.interviewPrep!;
      const kind = { PRACTICE_QUESTIONS: 'PRACTICE_QUESTION', CODING_HINTS: 'CODING_HINT', RECRUITER_QUESTIONS: 'RECRUITER_QUESTION', STUDY_ITEMS: 'STUDY_ITEM' }[source.request];
      const suggestions = [1, 2, 3].map((index) => ({
        key: `s${index}`, kind, text: `Synthetic ${source.request} number ${index}`, hints: kind === 'CODING_HINT' ? ['A nudge', 'A bigger hint'] : [],
        sourceFactIds: index === 1 && source.facts[0] ? [source.facts[0].factId] : [],
      }));
      const output = providerMode === 'invalid' ? { operation: 'INTERVIEW_PREP', approved: true } : { schemaVersion: 1, operation: 'INTERVIEW_PREP', locale: input.locale, request: source.request, suggestions, warnings: [] };
      return { output, inputContentHash: 'e'.repeat(64), model: 'gpt-5.5', cliVersion: '0.163.0', usage: { inputTokens: 10, outputTokens: 20 }, account: {} } as unknown as CodexExecutionResult;
    }) as never;
    registerInterviewPreparationRoutes(app, workspace, database);
    registerAiInterviewPreparationRoutes(app, workspace, { enabled: true, database, identitySalt: 'fixture-salt', queue, cancellation, execute });
    const headers = { 'x-fixture-workspace': owner }; const foreignHeaders = { 'x-fixture-workspace': other };

    const built = await app.inject({ method: 'POST', url: `/api/v1/applications/${application}/interview-preparation/build`, headers, payload: { language: 'en' } });
    assert.equal(built.statusCode, 201, built.body);
    const plan = built.json().plan as { id: string; items: Array<{ id: string; origin: string }>; evidence: Array<{ kind: string; sourceId: string }> };
    assert.ok(plan.evidence.some((row) => row.kind === 'APPROVED_FACT' && row.sourceId === fact), 'the plan cites the TypeScript fact');
    assert.ok(!plan.evidence.some((row) => row.sourceId === unrelatedFact), 'the unrelated fact is not part of the plan');
    const noteResponse = await app.inject({ method: 'POST', url: `/api/v1/interview-preparation/${plan.id}/items`, headers, payload: { kind: 'NOTE', content: 'PRIVATE NOTE about my salary expectations' } });
    const noteId = noteResponse.json().item.id as string;
    const generatedId = plan.items[0]!.id;

    const url = (path = '') => `/api/v1/interview-preparation/${plan.id}/assistant${path}`;
    const preview = (payload: unknown, h = headers, id = plan.id) => app.inject({ method: 'POST', url: `/api/v1/interview-preparation/${id}/assistant/preview`, headers: h, payload: payload as object });
    const run = (payload: unknown, h = headers) => app.inject({ method: 'POST', url: url(), headers: h, payload: payload as object });
    const accept = (payload: unknown, h = headers) => app.inject({ method: 'POST', url: url('/accept'), headers: h, payload: payload as object });
    const count = async (table: string, where = '') => Number((await client.query(`SELECT count(*)::int AS n FROM ${table} ${where}`)).rows[0].n);
    const planItems = () => count('interview_preparation_items', `WHERE plan_id='${plan.id}'`);
    const baseItems = await planItems();

    // The preview shows exactly what would be sent, and sends nothing.
    assert.equal((await preview({ request: 'PRACTICE_QUESTIONS' }, headers, randomUUID())).statusCode, 404);
    assert.equal((await preview({ request: 'PRACTICE_QUESTIONS' }, foreignHeaders)).statusCode, 404, 'another workspace cannot preview');
    assert.equal((await preview({ request: 'LIVE_HELP' })).statusCode, 400, 'only the four requests exist');
    assert.equal((await preview({ request: 'PRACTICE_QUESTIONS', extra: 1 })).statusCode, 400);
    assert.equal((await preview({ request: 'PRACTICE_QUESTIONS', factIds: [unrelatedFact] })).json().error, 'INVALID_SELECTION', 'a fact outside the plan cannot be sent');
    assert.equal((await preview({ request: 'PRACTICE_QUESTIONS', noteIds: [generatedId] })).json().error, 'INVALID_SELECTION', 'generated items are never sent back');
    assert.equal((await preview({ request: 'PRACTICE_QUESTIONS', noteIds: [randomUUID()] })).json().error, 'INVALID_SELECTION');
    const basic = await preview({ request: 'PRACTICE_QUESTIONS' });
    assert.equal(basic.statusCode, 200, basic.body);
    const shown = basic.json();
    assert.deepEqual([...shown.categories].sort(), ['APPROVED_FACTS', 'INTERVIEW_STAGE', 'JOB_POSTING']);
    const text = JSON.stringify(shown.messages);
    assert.ok(text.includes('Synthetic Co') && text.includes('Built TypeScript services'), 'the offer and the cited fact are sent');
    for (const secret of ['PRIVATE NOTE', 'Ran Kubernetes', 'Submitted resume line']) assert.ok(!text.includes(secret), `${secret} is not sent unless the person includes it`);
    assert.match(shown.payloadSha256, /^[a-f0-9]{64}$/);
    assert.equal((await preview({ request: 'PRACTICE_QUESTIONS' })).json().payloadSha256, shown.payloadSha256, 'the same selection gives the same payload');
    const noFacts = (await preview({ request: 'PRACTICE_QUESTIONS', factIds: [] })).json();
    assert.ok(!noFacts.categories.includes('APPROVED_FACTS') && !JSON.stringify(noFacts.messages).includes('Built TypeScript services'), 'the person can leave facts out');
    const full = (await preview({ request: 'STUDY_ITEMS', noteIds: [noteId], includeResume: true })).json();
    assert.deepEqual([...full.categories].sort(), ['APPROVED_FACTS', 'INTERVIEW_STAGE', 'JOB_POSTING', 'SUBMITTED_RESUME', 'USER_NOTES']);
    assert.ok(JSON.stringify(full.messages).includes('PRIVATE NOTE') && JSON.stringify(full.messages).includes('Submitted resume line'), 'chosen notes and the resume are shown and sent');
    assert.notEqual(full.payloadSha256, shown.payloadSha256);
    assert.equal(providerCalls.length, 0, 'previewing contacts no assistant');
    assert.equal(await count('ai_runs'), 0);

    // Running needs the person, this one request, and an unchanged payload.
    const ok = { request: 'PRACTICE_QUESTIONS', payloadSha256: shown.payloadSha256, confirmed: true };
    assert.equal((await run({ ...ok, origin: 'AUTOMATIC' })).statusCode, 403, 'nothing automatic can stand in for the person');
    assert.deepEqual((await run({ ...ok, confirmed: false })).json(), { declined: true });
    assert.equal((await run({ ...ok, remembered: true })).statusCode, 400, 'there is no remembered permission for this');
    assert.equal((await run({ ...ok, payloadSha256: 'f'.repeat(64) })).json().error, 'AI_NOT_CONNECTED', 'an account must be connected first');
    await client.query("INSERT INTO ai_connections(id,workspace_id,provider,account_fingerprint,revision,state,active) VALUES($1,$2,'codex',$3,1,'CONNECTED',true)", [connection, owner, fingerprint]);
    assert.equal((await run({ ...ok, payloadSha256: 'f'.repeat(64) })).json().error, 'PAYLOAD_CHANGED', 'a payload the person did not see is refused');
    assert.equal((await run(ok, foreignHeaders)).statusCode, 404);
    assert.equal(providerCalls.length, 0);

    const first = await run(ok);
    assert.equal(first.statusCode, 200, first.body);
    const result = first.json();
    assert.equal(result.label, 'GENERATED_PRACTICE_MATERIAL'); assert.equal(result.suggestions.length, 3); assert.equal(result.request, 'PRACTICE_QUESTIONS');
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0]!.interviewPrep!.facts.length, 1); assert.equal(providerCalls[0]!.interviewPrep!.notes.length, 0);
    assert.equal(await planItems(), baseItems, 'nothing is saved to the plan until the person accepts it');
    const runRow = (await client.query("SELECT status, operation FROM ai_runs WHERE id=$1", [result.runId])).rows[0];
    assert.deepEqual(runRow, { status: 'SUCCEEDED', operation: 'INTERVIEW_PREP' });
    const consent = (await client.query("SELECT remembered, operation, data_categories FROM ai_consents WHERE operation='INTERVIEW_PREP'")).rows;
    assert.deepEqual(consent.map((row: { remembered: boolean }) => row.remembered), [false], 'consent is for this request only');
    assert.deepEqual([...consent[0].data_categories].sort(), ['APPROVED_FACTS', 'INTERVIEW_STAGE', 'JOB_POSTING']);
    assert.equal(await count('ai_account_leases'), 0, 'the account is released');
    const second = await run(ok);
    assert.equal(second.statusCode, 200);
    assert.equal(await count('ai_consents', "WHERE operation='INTERVIEW_PREP' AND remembered=false"), 2, 'a later request needs its own consent');

    providerFailure = new CodexExecutionError('NOT_CONNECTED', 'NO');
    assert.equal((await run(ok)).statusCode, 503);
    const knownNotDispatched = (await client.query("SELECT error FROM ai_runs ORDER BY created_at DESC LIMIT 1")).rows[0].error;
    assert.equal(knownNotDispatched.dispatched, 'NO', 'the audit preserves a provider failure known to happen before dispatch');
    assert.equal(knownNotDispatched.code, 'NOT_CONNECTED');

    // A provider answer that breaks the contract is not saved or shown.
    providerMode = 'invalid';
    const bad = await run(ok);
    assert.equal(bad.statusCode, 503);
    assert.equal((await client.query("SELECT status FROM ai_runs ORDER BY created_at DESC LIMIT 1")).rows[0].status, 'FAILED');
    providerMode = 'ok';
    assert.equal(await planItems(), baseItems);

    // Accepting saves only the chosen suggestions, exactly as generated.
    const [one, two, three] = result.suggestions as Array<{ key: string; kind: string; text: string; hints: string[]; sourceFactIds: string[] }>;
    assert.equal((await accept({ runId: result.runId, suggestions: [] })).statusCode, 400);
    assert.equal((await accept({ runId: result.runId, suggestions: [one, one] })).statusCode, 400, 'the same suggestion cannot be chosen twice at once');
    assert.equal((await accept({ runId: result.runId, suggestions: [one] }, foreignHeaders)).statusCode, 404);
    assert.equal((await accept({ runId: randomUUID(), suggestions: [one] })).json().error, 'AI_PROPOSAL_EXPIRED');
    assert.equal((await accept({ runId: result.runId, suggestions: [{ ...one, text: 'Something I wrote that the assistant never said' }] })).statusCode, 422, 'edited or invented text is refused');
    assert.equal((await accept({ runId: result.runId, suggestions: [{ ...one, sourceFactIds: [unrelatedFact] }] })).statusCode, 422, 'a swapped source fact is refused');
    assert.equal((await accept({ runId: result.runId, suggestions: [{ ...one, key: 'invented' }] })).json().error, 'SUGGESTION_ALREADY_USED');
    assert.equal(await planItems(), baseItems, 'refused requests save nothing');
    const accepted = await accept({ runId: result.runId, suggestions: [one, three] });
    assert.equal(accepted.statusCode, 201, accepted.body);
    const items = accepted.json().items as Array<{ origin: string; kind: string; content: string; factIds: string[]; evidenceId: string | null; position: number }>;
    assert.deepEqual(items.map((item) => [item.origin, item.kind, item.content]), [['ASSISTANT', 'EXERCISE', one!.text], ['ASSISTANT', 'EXERCISE', three!.text]]);
    assert.deepEqual(items[0]!.factIds, [fact]); assert.ok(items[0]!.evidenceId && items[1]!.evidenceId, 'each item points at evidence of the plan');
    assert.equal(items[1]!.position, items[0]!.position + 1);
    assert.equal(await planItems(), baseItems + 2, 'only the chosen suggestions were saved, the other one was not');
    assert.equal((await accept({ runId: result.runId, suggestions: [one] })).json().error, 'SUGGESTION_ALREADY_USED', 'a suggestion is accepted once');
    const edited = await app.inject({ method: 'PATCH', url: `/api/v1/interview-preparation/items/${(await client.query("SELECT id FROM interview_preparation_items WHERE origin='ASSISTANT' LIMIT 1")).rows[0].id}`, headers, payload: { content: 'My version' } });
    assert.equal(edited.json().error, 'ITEM_NOT_EDITABLE', 'generated practice material keeps its provenance');
    assert.equal((await accept({ runId: second.json().runId, suggestions: [two] })).statusCode, 201, 'another run can still be accepted');

    // Other kinds map to the right items; coding hints are kept in order.
    const codingPreview = (await preview({ request: 'CODING_HINTS' })).json();
    const coding = (await run({ request: 'CODING_HINTS', payloadSha256: codingPreview.payloadSha256, confirmed: true })).json();
    const code = coding.suggestions[0];
    assert.deepEqual(code.hints, ['A nudge', 'A bigger hint']);
    const codeItem = (await accept({ runId: coding.runId, suggestions: [code] })).json().items[0];
    assert.deepEqual([codeItem.kind, codeItem.hints], ['EXERCISE', ['A nudge', 'A bigger hint']]);
    const recruiterPreview = (await preview({ request: 'RECRUITER_QUESTIONS', includeResume: true, noteIds: [noteId] })).json();
    const recruiter = (await run({ request: 'RECRUITER_QUESTIONS', includeResume: true, noteIds: [noteId], payloadSha256: recruiterPreview.payloadSha256, confirmed: true })).json();
    assert.equal(providerCalls.at(-1)!.interviewPrep!.resume!.text, 'Submitted resume line about testing');
    assert.equal((await accept({ runId: recruiter.runId, suggestions: [recruiter.suggestions[0]] })).json().items[0].kind, 'QUESTION');
    const studyPreview = (await preview({ request: 'STUDY_ITEMS' })).json();
    const study = (await run({ request: 'STUDY_ITEMS', payloadSha256: studyPreview.payloadSha256, confirmed: true })).json();

    // Stale evidence must be reviewed first: it is never sent and never turned into items.
    await client.query("UPDATE profile_facts SET statement='Built TypeScript services, edited later' WHERE id=$1", [fact]);
    assert.equal((await preview({ request: 'PRACTICE_QUESTIONS' })).json().error, 'PLAN_EVIDENCE_STALE');
    assert.equal((await run(ok)).json().error, 'PLAN_EVIDENCE_STALE');
    assert.equal((await accept({ runId: study.runId, suggestions: [study.suggestions[0]] })).json().error, 'PLAN_EVIDENCE_STALE', 'a run made before the change cannot be saved after it');
    await client.query("UPDATE profile_facts SET statement='Built TypeScript services for a fictional shop' WHERE id=$1", [fact]);

    // A revocation that wins the race after preview but before dispatch must be observed under the same profile lock.
    const revocationPreview = (await preview({ request: 'PRACTICE_QUESTIONS' })).json();
    const callsBeforeRevocation = providerCalls.length;
    beforeDispatch = () => database.transaction(async (tx) => {
      await lockKey(tx, profileLockKey(owner));
      await tx.update(schema.profileFacts).set({ approvalStatus: 'REJECTED' }).where(eq(schema.profileFacts.id, fact));
    });
    const revoked = await run({ request: 'PRACTICE_QUESTIONS', payloadSha256: revocationPreview.payloadSha256, confirmed: true });
    assert.equal(revoked.json().error, 'PLAN_EVIDENCE_STALE');
    assert.equal(providerCalls.length, callsBeforeRevocation, 'revoked evidence never reaches the provider');
    await database.transaction(async (tx) => {
      await lockKey(tx, profileLockKey(owner));
      await tx.update(schema.profileFacts).set({ approvalStatus: 'USER_APPROVED' }).where(eq(schema.profileFacts.id, fact));
    });

    // An application edit that wins after preview must be reflected by the guarded payload hash.
    const editPreview = (await preview({ request: 'PRACTICE_QUESTIONS' })).json();
    const callsBeforeEdit = providerCalls.length;
    beforeDispatch = () => database.transaction(async (tx) => {
      await tx.update(schema.applications).set({ role: 'Updated synthetic role' }).where(eq(schema.applications.id, application));
    });
    const editedFirst = await run({ request: 'PRACTICE_QUESTIONS', payloadSha256: editPreview.payloadSha256, confirmed: true });
    assert.equal(editedFirst.json().error, 'PAYLOAD_CHANGED');
    assert.equal(providerCalls.length, callsBeforeEdit, 'changed application details never reach the provider under the old preview');
    await database.transaction(async (tx) => {
      await tx.update(schema.applications).set({ role: 'QA Engineer' }).where(eq(schema.applications.id, application));
    });

    // If dispatch wins, revocation cannot commit until the complete prompt has been flushed and the guard releases.
    const dispatchPreview = (await preview({ request: 'PRACTICE_QUESTIONS' })).json();
    let enteredDispatch!: () => void;
    const dispatchEntered = new Promise<void>((resolve) => { enteredDispatch = resolve; });
    let releaseDispatch!: () => void;
    dispatchWait = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    onDispatch = enteredDispatch;
    const inFlight = run({ request: 'PRACTICE_QUESTIONS', payloadSha256: dispatchPreview.payloadSha256, confirmed: true });
    await dispatchEntered;
    const mutationStarted = new Promise<void>((resolve) => { enteredDispatch = resolve; });
    const revocation = database.transaction(async (tx) => {
      enteredDispatch();
      await lockKey(tx, profileLockKey(owner));
      await tx.update(schema.profileFacts).set({ approvalStatus: 'REJECTED' }).where(eq(schema.profileFacts.id, fact));
    });
    await mutationStarted;
    const lockCheck = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired', [profileLockKey(owner)]);
    assert.equal(lockCheck.rows[0].acquired, false, 'the dispatch guard holds the profile lock while input is flushed');
    releaseDispatch();
    assert.equal((await inFlight).statusCode, 200);
    await revocation;
    dispatchWait = undefined;
    onDispatch = undefined;
    await database.transaction(async (tx) => {
      await lockKey(tx, profileLockKey(owner));
      await tx.update(schema.profileFacts).set({ approvalStatus: 'USER_APPROVED' }).where(eq(schema.profileFacts.id, fact));
    });

    // An application edit that starts after the guarded read cannot update its fields before the prompt handoff.
    const appEditPreview = (await preview({ request: 'PRACTICE_QUESTIONS' })).json();
    let enteredAppDispatch!: () => void;
    const appDispatchEntered = new Promise<void>((resolve) => { enteredAppDispatch = resolve; });
    let releaseAppDispatch!: () => void;
    dispatchWait = new Promise<void>((resolve) => { releaseAppDispatch = resolve; });
    onDispatch = enteredAppDispatch;
    const appDispatch = run({ request: 'PRACTICE_QUESTIONS', payloadSha256: appEditPreview.payloadSha256, confirmed: true });
    await appDispatchEntered;
    await assert.rejects(client.query('SELECT id FROM applications WHERE id=$1 FOR UPDATE NOWAIT', [application]), { code: '55P03' });
    releaseAppDispatch();
    assert.equal((await appDispatch).statusCode, 200);
    dispatchWait = undefined;
    onDispatch = undefined;

    // A plan has a bounded size, and a plan without an offer has nothing to prepare from.
    const total = await planItems();
    await client.query("INSERT INTO interview_preparation_items(workspace_id,plan_id,kind,origin,position,content) SELECT $1,$2,'NOTE','USER_NOTE',20000+g,'filler' FROM generate_series(1,$3::int) g", [owner, plan.id, 300 - total]);
    assert.equal((await accept({ runId: study.runId, suggestions: [study.suggestions[0]] })).json().error, 'PLAN_FULL');
    const bare = (await app.inject({ method: 'POST', url: `/api/v1/applications/${foreignApplication}/interview-preparation/build`, headers: foreignHeaders, payload: { language: 'en' } })).json().plan;
    assert.equal((await preview({ request: 'PRACTICE_QUESTIONS' }, foreignHeaders, bare.id)).json().error, 'PLAN_HAS_NO_OFFER');
    assert.equal((await preview({ request: 'PRACTICE_QUESTIONS', includeResume: true }, headers)).statusCode, 200);

    // Plan deletion waits for an in-flight dispatch to finish sending the exact, still-current snapshot.
    const deletePreview = (await preview({ request: 'PRACTICE_QUESTIONS' })).json();
    let dispatchForDelete!: () => void;
    const deleteDispatchEntered = new Promise<void>((resolve) => { dispatchForDelete = resolve; });
    let releaseDeleteDispatch!: () => void;
    dispatchWait = new Promise<void>((resolve) => { releaseDeleteDispatch = resolve; });
    onDispatch = dispatchForDelete;
    const dispatching = run({ request: 'PRACTICE_QUESTIONS', payloadSha256: deletePreview.payloadSha256, confirmed: true });
    await deleteDispatchEntered;
    const deleting = app.inject({ method: 'DELETE', url: `/api/v1/interview-preparation/${plan.id}`, headers });
    const planLockCheck = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired', [interviewPreparationPlanLockKey(owner, plan.id)]);
    assert.equal(planLockCheck.rows[0].acquired, false, 'the dispatch guard holds the plan lock until input is flushed');
    releaseDeleteDispatch();
    assert.equal((await dispatching).statusCode, 200);
    assert.equal((await deleting).statusCode, 200);
    dispatchWait = undefined;
    onDispatch = undefined;
    // Deleting the plan removes what the assistant added to it, and the stored hashes are not the content.
    assert.equal(await planItems(), 0);
    const stored = JSON.stringify((await client.query('SELECT * FROM ai_document_reword_proposals')).rows);
    assert.ok(!stored.includes('Synthetic PRACTICE_QUESTIONS'), 'only hashes of suggestions are stored with the run');
    assert.ok(!JSON.stringify((await client.query('SELECT snapshot FROM ai_runs')).rows).includes('PRIVATE NOTE'), 'the run keeps no copy of what was sent');
  } finally {
    await app.close();
    await cancellation.close();
    await closePool?.();
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});
