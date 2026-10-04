import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AiUsageSnapshot } from '@career/domain';
import { inspectCodexAccount, type CodexAccountObservation } from './ai/codex-account.js';
import { CodexLoginError, createCodexLoginManager } from './ai/codex-login.js';
import { AiConnectionStoreError } from './ai/connection-store.js';

export type AiStoredConnection = {
  id: string; authorized: boolean; sessionState: CodexAccountObservation['status'];
  version: string | null; maskedIdentity: string | null; plan: string | null; usage: AiUsageSnapshot | null;
};
/** Implementations must revoke dependent permissions/runs when the observed account changes. */
export type AiConnectionRepository = {
  read: (workspaceId: string) => Promise<AiStoredConnection | null>;
  inspect: (workspaceId: string, observation: CodexAccountObservation) => Promise<void>;
  authorize: (workspaceId: string, observation: CodexAccountObservation) => Promise<void>;
  disconnect: (workspaceId: string, id: string) => Promise<boolean>;
};
export type AiConnectionRouteOptions = {
  enabled: boolean; identitySalt: string; repository: AiConnectionRepository;
  inspect?: typeof inspectCodexAccount;
  loginManager?: ReturnType<typeof createCodexLoginManager>;
  now?: () => number;
};
const idSchema = z.object({ id: z.uuid() }).strict();
const authorizeSchema = z.object({ observationId: z.uuid() }).strict();

/** Connection management performs no inference. Loading Settings never reads the native account automatically. */
export function registerAiConnectionRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, options: AiConnectionRouteOptions) {
  // Keep provider/database error details out of HTTP responses. This hook applies only to these AI routes.
  const guarded = app;
  guarded.addHook('onRoute', route => {
    if (!route.url.startsWith('/api/v1/ai/connections') && !route.url.startsWith('/api/v1/ai/login-attempts')) return;
    route.errorHandler = (error, _request, reply) => {
      if (error instanceof AiConnectionStoreError) return reply.code(409).send({ error: error.code });
      if (error.statusCode === 429) return reply.code(429).send({ error: 'RATE_LIMIT_EXCEEDED' });
      if (error.statusCode === 400 || error.statusCode === 413) return reply.code(error.statusCode).send({ error: 'INVALID_INPUT' });
      return reply.code(503).send({ error: 'AI_UNAVAILABLE' });
    };
  });
  const observations = new Map<string, { id: string; value: CodexAccountObservation; at: number }>();
  const inspections = new Map<string, Promise<void>>();
  const generations = new Map<string, number>();
  const mutations = new Map<string, Promise<unknown>>();
  const generation = (id: string) => generations.get(id) ?? 0;
  const invalidate = (id: string) => { generations.set(id, generation(id) + 1); observations.delete(id); };
  const mutate = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
    const prior = mutations.get(id) ?? Promise.resolve();
    const task = prior.catch(() => undefined).then(action);
    mutations.set(id, task);
    try { return await task; } finally { if (mutations.get(id) === task) mutations.delete(id); }
  };
  const repository = options.repository;
  const now = options.now ?? Date.now;
  const inspect = options.inspect ?? inspectCodexAccount;
  const login = options.loginManager ?? createCodexLoginManager();
  const state = async (workspaceId: string) => {
    const observation = observations.get(workspaceId);
    const visible = observation && now() - observation.at < 300_000 ? observation : null;
    return {
      enabled: options.enabled,
      connection: await repository.read(workspaceId),
      observation: visible ? {
        id: visible.id, sessionState: visible.value.status, version: visible.value.version,
        maskedIdentity: visible.value.maskedIdentity, plan: visible.value.plan, usage: visible.value.usage,
      } : null,
    };
  };
  const refresh = async (workspaceId: string) => {
    const current = inspections.get(workspaceId);
    if (current) return current;
    const revision = generation(workspaceId);
    const task = (async () => {
      const prior = observations.get(workspaceId);
      const lastUsage = prior?.value.usage.observedAt ? Date.parse(prior.value.usage.observedAt) : -Infinity;
      const observation = await inspect(options.identitySalt, undefined, {}, now() - lastUsage >= 60_000);
      if (now() - lastUsage < 60_000 && prior?.value.accountFingerprint === observation.accountFingerprint) observation.usage = prior.value.usage;
      await mutate(workspaceId, async () => {
        if (generation(workspaceId) !== revision) return;
        await repository.inspect(workspaceId, observation);
        if (generation(workspaceId) === revision) observations.set(workspaceId, { id: randomUUID(), value: observation, at: now() });
      });
    })();
    inspections.set(workspaceId, task);
    try { await task; } finally { inspections.delete(workspaceId); }
  };
  app.get('/api/v1/ai/connections', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return state(workspace(request));
  });
  app.post('/api/v1/ai/connections/codex/inspect', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.enabled) return reply.code(503).send({ error: 'AI_UNAVAILABLE' });
    const id = workspace(request); const prior = observations.get(id);
    // Inspection includes the official quota read. Keep its refresh rate bounded across repeated clicks.
    if (!prior || now() - prior.at >= 60_000) await refresh(id);
    return state(id);
  });
  app.post('/api/v1/ai/connections/codex/authorize', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.enabled) return reply.code(503).send({ error: 'AI_UNAVAILABLE' });
    const body = authorizeSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const id = workspace(request); const previous = observations.get(id); const revision = generation(id);
    if (!previous || previous.id !== body.data.observationId || now() - previous.at >= 300_000 || previous.value.status !== 'SIGNED_IN') return reply.code(409).send({ error: 'AI_CHECK_ACCOUNT' });
    // Never authorize only from a stale UI card or a fingerprint supplied by the browser.
    await refresh(id);
    const fresh = observations.get(id);
    if (!fresh || generation(id) !== revision) return reply.code(409).send({ error: 'AI_CHECK_ACCOUNT' });
    if (fresh.value.status !== 'SIGNED_IN' || !fresh.value.accountFingerprint || fresh.value.accountFingerprint !== previous.value.accountFingerprint) return reply.code(409).send({ error: 'AI_ACCOUNT_CHANGED' });
    await mutate(id, async () => {
      if (generation(id) !== revision) throw new AiConnectionStoreError('AI_CHECK_ACCOUNT');
      await repository.authorize(id, fresh.value);
    });
    return state(id);
  });
  app.post('/api/v1/ai/connections/:id/disconnect', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = idSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const id = workspace(request);
    invalidate(id);
    if (!(await mutate(id, () => repository.disconnect(id, params.data.id)))) return reply.code(404).send({ error: 'AI_CONNECTION_NOT_FOUND' });
    return state(id);
  });
  app.post('/api/v1/ai/connections/codex/login', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.enabled) return reply.code(503).send({ error: 'AI_UNAVAILABLE' });
    const id = workspace(request);
    invalidate(id);
    try {
      await mutate(id, async () => { const connection = await repository.read(id); if (connection?.authorized) await repository.disconnect(id, connection.id); });
      return await login.start(id);
    }
    catch (error) { return reply.code(error instanceof CodexLoginError && error.code === 'LOGIN_BUSY' ? 409 : 503).send({ error: error instanceof CodexLoginError ? error.code : 'LOGIN_UNAVAILABLE' }); }
  });
  app.get('/api/v1/ai/login-attempts/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = idSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    try { return login.read(workspace(request), params.data.id); }
    catch { return reply.code(404).send({ error: 'LOGIN_NOT_FOUND' }); }
  });
  app.post('/api/v1/ai/login-attempts/:id/cancel', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = idSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    try { return await login.cancel(workspace(request), params.data.id); }
    catch { return reply.code(404).send({ error: 'LOGIN_NOT_FOUND' }); }
  });
  app.addHook('onClose', async () => { await login.close(); await Promise.allSettled(inspections.values()); await Promise.allSettled(mutations.values()); observations.clear(); generations.clear(); });
}
