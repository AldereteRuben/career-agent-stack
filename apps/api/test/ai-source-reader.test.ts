import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getTableName, sql, type SQL, type SQLWrapper, type Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Executor } from '../src/workspace-data.js';
import { AiSourceReadError, checkCurrentAiSnapshot, createCurrentAiSnapshot, loadAiSourceRecords } from '../src/ai/source-reader.js';
import { buildAiSourceSnapshot, type AiSourceRequest } from '../src/ai/source-snapshot.js';

const uuid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspace = uuid(1); const profileId = uuid(2); const factId = uuid(3); const jobId = uuid(4); const questionId = uuid(5);
type Row = Record<string, unknown>;
function fixture() {
  const rows: Record<string, Row[]> = {
    profile_versions: [{ id: profileId, workspaceId: workspace, revision: 1, profile: { identity: { fullName: 'Private person', email: 'private@example.invalid' } } }],
    profile_facts: [{ id: factId, workspaceId: workspace, profileVersionId: profileId, kind: 'experience', statement: 'Helped customers each day.', details: null, tags: [], source: 'USER_ENTERED', approvalStatus: 'USER_APPROVED', createdAt: new Date('2026-01-01') }],
    jobs: [{ id: jobId, workspaceId: workspace, title: 'Support role', company: 'Example', location: 'Madrid' }],
    job_snapshots: [{ id: uuid(6), workspaceId: workspace, jobId, title: 'Support role', descriptionText: 'Help customers every day.', fetchedAt: new Date('2026-02-01') }],
    answer_versions: [{ id: questionId, workspaceId: workspace, semanticKey: 'untrusted', jurisdiction: 'ES', questionScope: 'application', questionText: 'Describe your relevant work experience.', value: 'PRIVATE BANK ANSWER', revision: 1, createdAt: new Date('2026-01-01') }],
  };
  const dialect = new PgDialect();
  const queries: Array<{ table: string; where: string; params: unknown[]; order: string[]; distinct: boolean }> = [];
  const locks: string[] = []; const transactionOptions: unknown[] = [];
  let fail = false;
  const select = (fields?: Record<string, unknown>, distinct = false) => {
    let table = ''; let where = ''; let params: unknown[] = []; let order: string[] = [];
    const builder = {
      from(value: Table) { table = getTableName(value); return builder; },
      where(value: SQL) { const query = dialect.sqlToQuery(value); where = query.sql; params = query.params; return builder; },
      orderBy(...values: SQLWrapper[]) { order = values.map((value) => dialect.sqlToQuery(sql`${value}`).sql); return builder; },
      limit() { return builder; },
      then(resolve: (value: Row[]) => unknown, reject: (error: Error) => unknown) {
        queries.push({ table, where, params, order, distinct });
        if (fail) return Promise.reject(new Error('secret SQL and credentials')).then(resolve, reject);
        const result = (rows[table] ?? []).map((row) => fields ? Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]])) : row);
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return builder;
  };
  const executor = {
    select, selectDistinctOn: () => select(undefined, true),
    execute: async (value: SQL) => { const query = dialect.sqlToQuery(value); locks.push(...query.params.map(String)); return []; },
  } as unknown as Executor;
  const database = {
    transaction: async (callback: (tx: Executor) => Promise<unknown>, options: unknown) => { transactionOptions.push(options); return callback(executor); },
  } as unknown as Parameters<typeof createCurrentAiSnapshot>[0];
  return { rows, queries, locks, transactionOptions, executor, database, fail: () => { fail = true; } };
}
const request: AiSourceRequest = { operation: 'JOB_ANALYSIS', locale: 'en', jobId, selectedFactIds: [factId] };

test('source loading scopes every query and orders saved posting ties by id', async () => {
  const fake = fixture(); const loaded = await loadAiSourceRecords(fake.executor, workspace, request);
  assert.equal(loaded.facts?.length, 1); assert.equal(loaded.job?.id, jobId);
  for (const query of fake.queries) { assert.ok(query.where.includes('workspace_id')); assert.ok(query.params.includes(workspace)); }
  const posting = fake.queries.find((query) => query.table === 'job_snapshots')!;
  assert.ok(posting.params.includes(jobId));
  assert.deepEqual(posting.order, ['"job_snapshots"."fetched_at" desc', '"job_snapshots"."id" desc']);
  assert.ok(!fake.queries.some((query) => query.table === 'answer_versions'));
});

test('search requests perform no source queries and unpersonalized analyses do not read a profile', async () => {
  const fake = fixture();
  assert.deepEqual(await loadAiSourceRecords(fake.executor, workspace, { operation: 'SEARCH_DRAFT', locale: 'es', searchRequest: 'Atención al cliente' }), {});
  assert.equal(fake.queries.length, 0);
  await loadAiSourceRecords(fake.executor, workspace, { ...request, selectedFactIds: [] });
  assert.deepEqual(fake.queries.map((query) => query.table).sort(), ['job_snapshots', 'jobs']);
});

test('only selected approved facts enter loaded records and answer values never leave the reader', async () => {
  const fake = fixture();
  fake.rows.profile_facts!.push({ ...fake.rows.profile_facts![0], id: uuid(80) }, { ...fake.rows.profile_facts![0], id: uuid(81), approvalStatus: 'SUGGESTED' });
  const loaded = await loadAiSourceRecords(fake.executor, workspace, { operation: 'ANSWER_DRAFT', locale: 'en', questionId, selectedFactIds: [factId] });
  assert.deepEqual(loaded.facts!.map((fact) => fact.id), [factId]);
  assert.deepEqual(Object.keys(loaded.question!).sort(), ['id', 'jurisdiction', 'questionScope', 'questionText', 'workspaceId']);
  assert.ok(!JSON.stringify(loaded).includes('PRIVATE BANK ANSWER'));
  assert.equal(fake.queries.find((query) => query.table === 'answer_versions')!.distinct, true);
  const stale = await loadAiSourceRecords(fake.executor, workspace, { operation: 'ANSWER_DRAFT', locale: 'en', questionId: uuid(82), selectedFactIds: [] });
  assert.equal(stale.question, null);
});

test('creating a snapshot uses a short consistent transaction and the shared profile lock', async () => {
  const fake = fixture(); const snapshot = await createCurrentAiSnapshot(fake.database, workspace, request);
  assert.equal(snapshot.operation, 'JOB_ANALYSIS');
  assert.deepEqual(fake.transactionOptions, [{ isolationLevel: 'repeatable read', accessMode: 'read write' }]);
  assert.deepEqual(fake.locks, [`profile:${workspace}`]);
  assert.equal((await checkCurrentAiSnapshot(fake.executor, workspace, snapshot)).ok, true);
  assert.equal(fake.transactionOptions.length, 1, 'currentness does not start a nested transaction');
});

test('currentness requests historical facts only for missing reference IDs, still workspace scoped', async () => {
  const fake = fixture(); const loaded = await loadAiSourceRecords(fake.executor, workspace, request);
  const snapshot = buildAiSourceSnapshot(workspace, request, loaded);
  fake.rows.profile_facts = [{ ...fake.rows.profile_facts![0], id: uuid(90), profileVersionId: uuid(91) }];
  fake.rows.profile_versions = [{ ...fake.rows.profile_versions![0], id: uuid(91), revision: 2 }];
  await loadAiSourceRecords(fake.executor, workspace, snapshot);
  const historical = fake.queries.filter((query) => query.table === 'profile_facts' && query.params.includes(factId));
  assert.equal(historical.length, 1); assert.ok(historical[0]!.params.includes(workspace));
});

test('foreign snapshots fail before reads and database errors are content-free', async () => {
  const fake = fixture(); const loaded = await loadAiSourceRecords(fake.executor, workspace, request);
  const snapshot = buildAiSourceSnapshot(workspace, request, loaded); const count = fake.queries.length;
  assert.equal((await checkCurrentAiSnapshot(fake.executor, uuid(99), snapshot)).ok, false);
  assert.equal(fake.queries.length, count);
  fake.fail();
  await assert.rejects(loadAiSourceRecords(fake.executor, workspace, request), (error: unknown) => error instanceof AiSourceReadError && error.message === 'AI_SOURCE_UNAVAILABLE');
});
