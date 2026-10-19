import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { aiConnections, db } from '@career/db';
import { AI_QUEUE_LOCK, type AiQueue } from './queue.js';
import { listOllamaModels, validateOllamaBaseUrl } from './ollama.js';
import { lockKey } from '../workspace-data.js';

const connectSchema = z.object({ model: z.string().min(1).max(160), confirmCloudDisabled: z.literal(true) }).strict();

/** Uses only the administrator-configured loopback endpoint. The client can choose a listed model, never a URL. */
export function registerOllamaConnectionRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, options: {
  enabled: boolean; baseUrl: string; queue: AiQueue; cancelConnection?: (workspaceId: string, connectionId: string) => void;
  fetch?: typeof fetch;
}) {
  let baseUrl: string;
  try { baseUrl = validateOllamaBaseUrl(options.baseUrl); } catch { throw new Error('OLLAMA_URL_INVALID'); }
  const current = async (workspaceId: string) => (await db.select().from(aiConnections).where(and(
    eq(aiConnections.workspaceId, workspaceId), eq(aiConnections.provider, 'ollama'), eq(aiConnections.active, true),
  )).limit(1))[0] ?? null;
  app.get('/api/v1/ai/ollama', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.enabled) return { enabled: false, available: false, models: [], connection: null, privacy: 'NOT_CONFIGURED' };
    let models;
    try { models = await listOllamaModels(baseUrl, options.fetch ? { fetch: options.fetch } : {}); }
    catch { return { enabled: true, available: false, models: [], connection: await connectionView(workspace(request)), privacy: 'NOT_VERIFIABLE' }; }
    return { enabled: true, available: true, models: models.map(({ name, size }) => ({ name, ...(size !== undefined ? { size } : {}) })), connection: await connectionView(workspace(request)), privacy: 'NOT_VERIFIABLE' };
  });
  const connectionView = async (workspaceId: string) => {
    const row = await current(workspaceId);
    return row ? { id: row.id, model: row.selectedModel, connected: row.state === 'CONNECTED', cloudDisabledConfirmed: row.capabilities.cloudDisabledAttested === true, revision: row.revision } : null;
  };
  app.post('/api/v1/ai/ollama/connect', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.enabled) return reply.code(503).send({ error: 'AI_UNAVAILABLE' });
    const parsed = connectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    let models;
    try { models = await listOllamaModels(baseUrl, options.fetch ? { fetch: options.fetch } : {}); }
    catch { return reply.code(503).send({ error: 'OLLAMA_UNAVAILABLE' }); }
    if (!models.some(model => model.name === parsed.data.model)) return reply.code(409).send({ error: 'OLLAMA_MODEL_NOT_INSTALLED' });
    const workspaceId = workspace(request);
    const fingerprint = createHash('sha256').update(`${baseUrl}\0${parsed.data.model}`).digest('hex');
    const before = await current(workspaceId);
    if (before && before.accountFingerprint === fingerprint && before.selectedModel === parsed.data.model
      && before.capabilities.cloudDisabledAttested === true) return { connection: await connectionView(workspaceId), privacy: 'USER_CONFIRMED' };
    // Revoke through the queue before opening the connection transaction: queue revocation owns its
    // own transaction and advisory lock, so nesting it here could deadlock another pool connection.
    if (before) {
      await options.queue.revokeConnection(workspaceId, before.id);
      options.cancelConnection?.(workspaceId, before.id);
    }
    let connectionConflict = false;
    await db.transaction(async tx => {
      await lockKey(tx, AI_QUEUE_LOCK);
      const existing = (await tx.select().from(aiConnections).where(and(
        eq(aiConnections.workspaceId, workspaceId), eq(aiConnections.provider, 'ollama'), eq(aiConnections.active, true),
      )).limit(1))[0];
      if (existing && existing.accountFingerprint === fingerprint && existing.selectedModel === parsed.data.model
        && existing.capabilities.cloudDisabledAttested === true) return existing.id;
      if (existing) {
        // A concurrently-created different connection must not be mutated without first
        // revoking its consents and in-flight tasks through the queue's own transaction.
        connectionConflict = true;
        return existing.id;
      }
      const inserted = await tx.insert(aiConnections).values({ workspaceId, provider: 'ollama', officialContextRef: null,
        maskedIdentity: `Ollama · ${parsed.data.model}`, accountFingerprint: fingerprint, binaryVersion: 'local-api',
        capabilities: { login: false, structuredOutput: true, usageWindows: false, cancellation: true,
          isolatedExecution: false, cloudDisabledAttested: true }, selectedModel: parsed.data.model, state: 'CONNECTED', active: true,
      }).returning({ id: aiConnections.id });
      return inserted[0]!.id;
    });
    if (connectionConflict) return reply.code(409).send({ error: 'OLLAMA_CONNECTION_CHANGED' });
    return { connection: await connectionView(workspaceId), privacy: 'USER_CONFIRMED' };
  });
}
