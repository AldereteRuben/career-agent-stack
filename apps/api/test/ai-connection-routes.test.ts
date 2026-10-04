import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import Fastify from 'fastify';
import { normalizeAiUsage } from '@career/domain';
import { registerAiConnectionRoutes, type AiConnectionRepository, type AiStoredConnection } from '../src/ai-connection-routes.js';
import type { CodexAccountObservation } from '../src/ai/codex-account.js';
import { CodexLoginError, type CodexLoginView } from '../src/ai/codex-login.js';

const WORKSPACE_A = 'a96a8df8-7e75-4a59-8101-5c4c219a87aa';
const WORKSPACE_B = 'b2b30e7c-cf56-4ad9-b26e-e47ade2e45bb';
const ORIGIN = 'http://career.test';
const BASE = '/api/v1/ai';
const START = Date.parse('2026-10-04T12:00:00.000Z');
const PRIVATE_ERROR = 'fixture-provider-secret-token=never-return-this';
type PublicObservation = Omit<AiStoredConnection, 'authorized'>;
type PublicState = { enabled: boolean; connection: AiStoredConnection | null; observation: PublicObservation | null };

function account(now: number, fingerprint = 'a'.repeat(64)): CodexAccountObservation {
  return {
    status: 'SIGNED_IN', version: '0.160.0', billing: 'CHATGPT_PLAN', accountFingerprint: fingerprint,
    maskedIdentity: 'f***@example.test', plan: 'plus',
    usage: normalizeAiUsage({ provider: 'codex', source: 'PROVIDER_REPORTED', observedAt: new Date(now).toISOString(), windows: [{ windowId: 'primary', usedPercent: 35 }], costUsd: null }, now),
  };
}

function fixture(t: TestContext, { enabled = true }: { enabled?: boolean } = {}) {
  const app = Fastify({ logger: false });
  let clock = START;
  let current = account(clock);
  const stored = new Map<string, { connection: AiStoredConnection; fingerprint: string | null }>();
  const attempts = new Map<string, { workspaceId: string; view: CodexLoginView }>();
  const calls = { read: [] as string[], inspect: [] as string[], authorize: [] as string[], disconnect: [] as string[], provider: [] as boolean[], login: [] as string[], close: 0 };
  let providerError: Error | null = null;
  let readError: Error | null = null;
  let loginError: Error | null = null;
  let providerWait: (() => Promise<void>) | null = null;
  let authorizeWait: (() => Promise<void>) | null = null;
  const save = (workspaceId: string, observed: CodexAccountObservation, authorized: boolean) => {
    const previous = stored.get(workspaceId);
    stored.set(workspaceId, {
      fingerprint: observed.accountFingerprint,
      connection: {
        id: previous?.connection.id ?? randomUUID(), authorized,
        sessionState: observed.status, version: observed.version, maskedIdentity: observed.maskedIdentity, plan: observed.plan, usage: observed.usage,
      },
    });
  };
  const repository: AiConnectionRepository = {
    async read(workspaceId) { calls.read.push(workspaceId); if (readError) throw readError; return stored.get(workspaceId)?.connection ?? null; },
    async inspect(workspaceId, observed) {
      calls.inspect.push(workspaceId);
      const previous = stored.get(workspaceId);
      save(workspaceId, observed, observed.status === 'SIGNED_IN' && previous?.fingerprint === observed.accountFingerprint && previous.connection.authorized);
    },
    async authorize(workspaceId, observed) { calls.authorize.push(workspaceId); if (authorizeWait) await authorizeWait(); save(workspaceId, observed, true); },
    async disconnect(workspaceId, id) {
      calls.disconnect.push(workspaceId);
      const previous = stored.get(workspaceId);
      if (previous?.connection.id !== id) return false;
      previous.connection.authorized = false;
      return true;
    },
  };
  const getAttempt = (workspaceId: string, id: string) => {
    const attempt = attempts.get(id);
    if (!attempt || attempt.workspaceId !== workspaceId) throw new CodexLoginError('LOGIN_NOT_FOUND');
    return attempt;
  };
  const loginManager = {
    async start(workspaceId: string): Promise<CodexLoginView> {
      calls.login.push(workspaceId);
      if (loginError) throw loginError;
      const view: CodexLoginView = { id: randomUUID(), state: 'WAITING', url: 'https://auth.openai.com/authorize?state=synthetic', expiresAt: new Date(clock + 300_000).toISOString() };
      attempts.set(view.id, { workspaceId, view });
      return { ...view };
    },
    read(workspaceId: string, id: string): CodexLoginView { return { ...getAttempt(workspaceId, id).view }; },
    async cancel(workspaceId: string, id: string): Promise<CodexLoginView> {
      const attempt = getAttempt(workspaceId, id);
      attempt.view = { id, state: 'CANCELLED', expiresAt: attempt.view.expiresAt };
      return { ...attempt.view };
    },
    async close() { calls.close += 1; attempts.clear(); },
  };
  // This fixture models the session/origin boundary applied by server.ts before route registration.
  app.addHook('preHandler', async (request, reply) => {
    if (!request.headers['x-workspace']) return reply.code(401).send({ error: 'SESSION_REQUIRED' });
    if (request.method !== 'GET' && request.headers.origin !== ORIGIN) return reply.code(403).send({ error: 'ORIGIN_FORBIDDEN' });
  });
  registerAiConnectionRoutes(app, request => String(request.headers['x-workspace']), {
    enabled, identitySalt: 'synthetic-identity-salt-longer-than-thirty-two', repository, now: () => clock, loginManager,
    inspect: async (_salt, _signal, _dependencies, readUsage = false) => {
      calls.provider.push(readUsage);
      if (providerWait) await providerWait();
      if (providerError) throw providerError;
      const observed = structuredClone(current);
      if (readUsage) observed.usage.observedAt = new Date(clock).toISOString();
      else observed.usage = normalizeAiUsage({ provider: 'codex', source: 'NONE', observedAt: null, windows: [] }, clock);
      return observed;
    },
  });
  t.after(async () => { await app.close(); });
  const request = (method: 'GET' | 'POST', path: string, payload?: object, workspaceId = WORKSPACE_A) => app.inject({ method, url: `${BASE}${path}`, headers: { 'x-workspace': workspaceId, origin: ORIGIN }, ...(payload ? { payload } : {}) });
  return {
    app, request, calls, stored, attempts,
    seed(workspaceId = WORKSPACE_A, authorized = true) { save(workspaceId, current, authorized); return stored.get(workspaceId)!.connection.id; },
    advance(ms: number) { clock += ms; },
    changeAccount(observation: CodexAccountObservation) { current = observation; },
    providerFail(error: Error) { providerError = error; },
    readFail(error: Error) { readError = error; },
    loginFail(error: Error) { loginError = error; },
    waitForProvider(wait: () => Promise<void>) { providerWait = wait; },
    waitForAuthorization(wait: () => Promise<void>) { authorizeWait = wait; },
  };
}

test('GET reads local state without inspecting the native account and disables caching', async t => {
  const f = fixture(t);
  const response = await f.request('GET', '/connections');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json(), { enabled: true, connection: null, observation: null });
  assert.deepEqual(f.calls.provider, []);
  assert.deepEqual(f.calls.login, []);
  assert.deepEqual(f.calls.read, [WORKSPACE_A]);
});

test('explicit inspection returns only public metadata and honest usage values', async t => {
  const f = fixture(t);
  const response = await f.request('POST', '/connections/codex/inspect');
  assert.equal(response.statusCode, 200);
  const state = response.json<PublicState>();
  assert.equal(state.connection?.authorized, false);
  assert.equal(state.observation?.sessionState, 'SIGNED_IN');
  assert.equal(state.observation?.maskedIdentity, 'f***@example.test');
  assert.equal(state.observation?.usage?.windows[0]?.usedPercent, 35);
  assert.equal(state.observation?.usage?.costUsd, null);
  assert.equal(state.observation?.usage?.tokens.input, null);
  assert.ok(state.observation?.id);
  assert.ok(!response.body.includes('accountFingerprint'));
  assert.ok(!response.body.includes('billing'));
  assert.ok(!response.body.includes('a'.repeat(64)));
  assert.deepEqual(f.calls.provider, [true]);
  assert.deepEqual(f.calls.authorize, []);
});

test('repeated inspection clicks reuse the 60-second quota cache, then refresh at the boundary', async t => {
  const f = fixture(t);
  const first = (await f.request('POST', '/connections/codex/inspect')).json<PublicState>();
  f.advance(59_999);
  const cached = (await f.request('POST', '/connections/codex/inspect')).json<PublicState>();
  assert.equal(cached.observation?.id, first.observation?.id);
  assert.deepEqual(f.calls.provider, [true]);
  f.advance(1);
  const refreshed = (await f.request('POST', '/connections/codex/inspect')).json<PublicState>();
  assert.notEqual(refreshed.observation?.id, first.observation?.id);
  assert.deepEqual(f.calls.provider, [true, true]);
});

test('authorize rechecks the account but reuses fresh quota without treating it as zero', async t => {
  const f = fixture(t);
  const prior = (await f.request('POST', '/connections/codex/inspect')).json<PublicState>();
  const response = await f.request('POST', '/connections/codex/authorize', { observationId: prior.observation!.id });
  assert.equal(response.statusCode, 200, response.body);
  const state = response.json<PublicState>();
  assert.equal(state.connection?.authorized, true);
  assert.equal(state.observation?.usage?.windows[0]?.usedPercent, 35);
  assert.deepEqual(f.calls.provider, [true, false]);
  assert.deepEqual(f.calls.authorize, [WORKSPACE_A]);
});

test('observations belong to their workspace and cannot authorize another workspace', async t => {
  const f = fixture(t);
  const prior = (await f.request('POST', '/connections/codex/inspect')).json<PublicState>();
  assert.deepEqual((await f.request('GET', '/connections', undefined, WORKSPACE_B)).json(), { enabled: true, connection: null, observation: null });
  const response = await f.request('POST', '/connections/codex/authorize', { observationId: prior.observation!.id }, WORKSPACE_B);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json<{ error: string }>().error, 'AI_CHECK_ACCOUNT');
  assert.deepEqual(f.calls.provider, [true]);
  assert.deepEqual(f.calls.authorize, []);
});

test('expired observations disappear and require inspection before authorization', async t => {
  const f = fixture(t);
  const prior = (await f.request('POST', '/connections/codex/inspect')).json<PublicState>();
  f.advance(300_000);
  assert.equal((await f.request('GET', '/connections')).json<PublicState>().observation, null);
  const response = await f.request('POST', '/connections/codex/authorize', { observationId: prior.observation!.id });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json<{ error: string }>().error, 'AI_CHECK_ACCOUNT');
  assert.deepEqual(f.calls.provider, [true]);
  assert.deepEqual(f.calls.authorize, []);
});

test('a changed account is freshly detected and never authorized from the old card', async t => {
  const f = fixture(t);
  f.seed();
  const prior = (await f.request('POST', '/connections/codex/inspect')).json<PublicState>();
  f.changeAccount(account(START, 'b'.repeat(64)));
  const response = await f.request('POST', '/connections/codex/authorize', { observationId: prior.observation!.id });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json<{ error: string }>().error, 'AI_ACCOUNT_CHANGED');
  assert.deepEqual(f.calls.provider, [true, false]);
  assert.deepEqual(f.calls.authorize, []);
  assert.equal(f.stored.get(WORKSPACE_A)?.connection.authorized, false);
  assert.equal((await f.request('GET', '/connections')).json<PublicState>().observation?.usage?.availability, 'UNAVAILABLE');
});

test('signing out between inspection and authorization cannot create a connection', async t => {
  const f = fixture(t);
  const prior = (await f.request('POST', '/connections/codex/inspect')).json<PublicState>();
  f.changeAccount({ ...account(START), status: 'SIGNED_OUT', accountFingerprint: null, maskedIdentity: null });
  const response = await f.request('POST', '/connections/codex/authorize', { observationId: prior.observation!.id });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json<{ error: string }>().error, 'AI_ACCOUNT_CHANGED');
  assert.equal(f.stored.get(WORKSPACE_A)?.connection.authorized, false);
  assert.deepEqual(f.calls.authorize, []);
});

test('the browser cannot provide a fingerprint, extra properties or malformed identifiers', async t => {
  const f = fixture(t);
  for (const body of [{ observationId: 'not-a-uuid' }, { observationId: randomUUID(), accountFingerprint: 'a'.repeat(64) }, {}]) {
    const response = await f.request('POST', '/connections/codex/authorize', body);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json<{ error: string }>().error, 'INVALID_INPUT');
  }
  for (const path of ['/connections/not-a-uuid/disconnect', '/login-attempts/not-a-uuid/cancel']) assert.equal((await f.request('POST', path)).statusCode, 400);
  assert.deepEqual(f.calls.provider, []);
});

test('disabled integration exposes saved permission for revocation but blocks new actions', async t => {
  const f = fixture(t, { enabled: false });
  const id = f.seed();
  const state = (await f.request('GET', '/connections')).json<PublicState>();
  assert.equal(state.enabled, false);
  assert.equal(state.connection?.id, id, 'saved permission must remain visible so the UI can revoke it');
  assert.equal(state.connection?.authorized, true);
  for (const path of ['/connections/codex/inspect', '/connections/codex/authorize', '/connections/codex/login']) assert.equal((await f.request('POST', path, { observationId: randomUUID() })).statusCode, 503);
  const disconnected = await f.request('POST', `/connections/${id}/disconnect`);
  assert.equal(disconnected.statusCode, 200);
  assert.equal(f.stored.get(WORKSPACE_A)?.connection.authorized, false);
  assert.deepEqual(f.calls.provider, []);
  assert.deepEqual(f.calls.login, []);
});

test('disconnect is workspace scoped and clears the reusable observation', async t => {
  const f = fixture(t);
  const id = f.seed();
  const prior = (await f.request('POST', '/connections/codex/inspect')).json<PublicState>();
  assert.equal((await f.request('POST', `/connections/${id}/disconnect`, undefined, WORKSPACE_B)).statusCode, 404);
  assert.equal(f.stored.get(WORKSPACE_A)?.connection.authorized, true);
  const response = await f.request('POST', `/connections/${id}/disconnect`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json<PublicState>().observation, null);
  assert.equal(response.json<PublicState>().connection?.authorized, false);
  assert.equal((await f.request('POST', '/connections/codex/authorize', { observationId: prior.observation!.id })).statusCode, 409);
});

test('login attempts are workspace scoped and login clears the previous observation', async t => {
  const f = fixture(t);
  await f.request('POST', '/connections/codex/inspect');
  const started = await f.request('POST', '/connections/codex/login');
  assert.equal(started.statusCode, 200);
  const attempt = started.json<CodexLoginView>();
  assert.equal(attempt.state, 'WAITING');
  assert.equal((await f.request('GET', '/connections')).json<PublicState>().observation, null);
  assert.equal((await f.request('GET', `/login-attempts/${attempt.id}`, undefined, WORKSPACE_B)).statusCode, 404);
  assert.equal((await f.request('POST', `/login-attempts/${attempt.id}/cancel`, undefined, WORKSPACE_B)).statusCode, 404);
  assert.equal((await f.request('GET', `/login-attempts/${attempt.id}`)).json<CodexLoginView>().state, 'WAITING');
  const cancelled = await f.request('POST', `/login-attempts/${attempt.id}/cancel`);
  assert.equal(cancelled.json<CodexLoginView>().state, 'CANCELLED');
  assert.equal(cancelled.json<CodexLoginView>().url, undefined);
  assert.deepEqual(f.calls.provider, [true]);
  assert.deepEqual(f.calls.login, [WORKSPACE_A]);
});

test('login errors return stable codes instead of raw provider details', async t => {
  const f = fixture(t);
  f.loginFail(new Error(PRIVATE_ERROR));
  let response = await f.request('POST', '/connections/codex/login');
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { error: 'LOGIN_UNAVAILABLE' });
  assert.ok(!response.body.includes(PRIVATE_ERROR));
  f.loginFail(new CodexLoginError('LOGIN_BUSY'));
  response = await f.request('POST', '/connections/codex/login');
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), { error: 'LOGIN_BUSY' });
});

test('unexpected inspection failures never expose raw provider output', async t => {
  const f = fixture(t);
  f.providerFail(new Error(PRIVATE_ERROR));
  const response = await f.request('POST', '/connections/codex/inspect');
  assert.ok(response.statusCode >= 500);
  assert.ok(!response.body.includes(PRIVATE_ERROR), 'the route must not return raw provider exceptions');
  assert.deepEqual(f.calls.authorize, []);
});

test('unexpected repository read failures do not expose local data or SQL details', async t => {
  const f = fixture(t);
  f.readFail(new Error(PRIVATE_ERROR));
  const response = await f.request('GET', '/connections');
  assert.ok(response.statusCode >= 500);
  assert.ok(!response.body.includes(PRIVATE_ERROR), 'local repository errors must be sanitized');
});

test('concurrent inspections share one in-flight provider request', async t => {
  const f = fixture(t);
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.waitForProvider(async () => { entered(); await wait; });
  const first = f.request('POST', '/connections/codex/inspect');
  await enteredPromise;
  const second = f.request('POST', '/connections/codex/inspect');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(a.json<PublicState>().observation?.id, b.json<PublicState>().observation?.id);
  assert.deepEqual(f.calls.provider, [true]);
});

test('disconnect fences a pending authorization so a late account read cannot reconnect it', async t => {
  const f = fixture(t);
  const id = f.seed();
  const prior = (await f.request('POST', '/connections/codex/inspect')).json<PublicState>();
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.waitForProvider(async () => { entered(); await wait; });
  const authorization = f.request('POST', '/connections/codex/authorize', { observationId: prior.observation!.id });
  await enteredPromise;
  const disconnected = await f.request('POST', `/connections/${id}/disconnect`);
  assert.equal(disconnected.statusCode, 200);
  release();
  const late = await authorization;
  assert.equal(late.statusCode, 409, 'the pending authorization must be rejected after disconnect');
  assert.equal(f.stored.get(WORKSPACE_A)?.connection.authorized, false);
  assert.equal((await f.request('GET', '/connections')).json<PublicState>().observation, null);
  assert.deepEqual(f.calls.authorize, []);
});

test('starting login fences an older pending authorization and observation', async t => {
  const f = fixture(t);
  const prior = (await f.request('POST', '/connections/codex/inspect')).json<PublicState>();
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.waitForProvider(async () => { entered(); await wait; });
  const authorization = f.request('POST', '/connections/codex/authorize', { observationId: prior.observation!.id });
  await enteredPromise;
  assert.equal((await f.request('POST', '/connections/codex/login')).statusCode, 200);
  release();
  assert.equal((await authorization).statusCode, 409);
  assert.equal((await f.request('GET', '/connections')).json<PublicState>().observation, null);
  assert.deepEqual(f.calls.authorize, []);
});

test('disconnect runs after an already committing authorization and leaves the account inactive', async t => {
  const f = fixture(t);
  const id = f.seed(WORKSPACE_A, false);
  const prior = (await f.request('POST', '/connections/codex/inspect')).json<PublicState>();
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.waitForAuthorization(async () => { entered(); await wait; });
  const authorization = f.request('POST', '/connections/codex/authorize', { observationId: prior.observation!.id });
  await enteredPromise;
  const disconnection = f.request('POST', `/connections/${id}/disconnect`);
  // Let the already-ready Fastify instance enqueue the second route while the repository write is blocked.
  await setImmediate();
  assert.deepEqual(f.calls.disconnect, [], 'disconnect must wait for the earlier authorization write');
  release();
  const [authorized, disconnected] = await Promise.all([authorization, disconnection]);
  assert.ok([200, 409].includes(authorized.statusCode));
  assert.equal(disconnected.statusCode, 200);
  assert.equal(f.stored.get(WORKSPACE_A)?.connection.authorized, false);
  const final = (await f.request('GET', '/connections')).json<PublicState>();
  assert.equal(final.connection?.authorized, false);
  assert.equal(final.observation, null);
});

test('disconnect discards a late explicit inspection instead of restoring its authorization card', async t => {
  const f = fixture(t);
  const id = f.seed();
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.waitForProvider(async () => { entered(); await wait; });
  const inspection = f.request('POST', '/connections/codex/inspect');
  await enteredPromise;
  assert.equal((await f.request('POST', `/connections/${id}/disconnect`)).statusCode, 200);
  release();
  const result = await inspection;
  assert.ok([200, 409].includes(result.statusCode));
  const final = (await f.request('GET', '/connections')).json<PublicState>();
  assert.equal(final.observation, null);
  assert.equal(final.connection?.authorized, false);
});

test('session and origin middleware reject requests before account or login work', async t => {
  const f = fixture(t);
  const anonymous = await f.app.inject({ method: 'GET', url: `${BASE}/connections` });
  assert.equal(anonymous.statusCode, 401);
  for (const path of ['/connections/codex/inspect', '/connections/codex/login', '/connections/codex/authorize']) {
    const response = await f.app.inject({ method: 'POST', url: `${BASE}${path}`, headers: { 'x-workspace': WORKSPACE_A, origin: 'https://other.example.test' }, payload: { observationId: randomUUID() } });
    assert.equal(response.statusCode, 403);
  }
  assert.deepEqual(f.calls.provider, []);
  assert.deepEqual(f.calls.login, []);
  assert.deepEqual(f.calls.read, []);
});

test('application close cleans up pending login manager state', async t => {
  const f = fixture(t);
  await f.request('POST', '/connections/codex/login');
  assert.equal(f.attempts.size, 1);
  await f.app.close();
  assert.equal(f.calls.close, 1);
  assert.equal(f.attempts.size, 0);
});
