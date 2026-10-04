import { and, desc, eq } from 'drizzle-orm';
import { aiConnections, aiUsageSnapshots, type db } from '@career/db';
import { normalizeAiUsage, type AiUsageSnapshot } from '@career/domain';
import { lockKey } from '../workspace-data.js';
import type { AiConnectionRepository } from '../ai-connection-routes.js';
import type { CodexAccountObservation } from './codex-account.js';
import { AI_QUEUE_LOCK, type AiQueue } from './queue.js';

export class AiConnectionStoreError extends Error {
  constructor(readonly code: 'AI_CONNECTION_CONFLICT' | 'AI_CHECK_ACCOUNT') { super(code); this.name = 'AiConnectionStoreError'; }
}
const emptyUsage = () => normalizeAiUsage({ provider: 'codex', source: 'NONE', observedAt: null, windows: [], costUsd: null }, Date.now());

export function createAiConnectionRepository(database: typeof db, queue: AiQueue, onRevoked?: (workspaceId: string, connectionId: string) => void): AiConnectionRepository {
  const latest = async (workspaceId: string) => (await database.select().from(aiConnections).where(and(eq(aiConnections.workspaceId, workspaceId), eq(aiConnections.provider, 'codex'))).orderBy(desc(aiConnections.active), desc(aiConnections.updatedAt), desc(aiConnections.id)).limit(1))[0];
  const saveUsage = async (workspaceId: string, connectionId: string, usage: AiUsageSnapshot) => {
    if (!usage.observedAt || usage.availability === 'UNAVAILABLE') return;
    const last = (await database.select().from(aiUsageSnapshots).where(and(eq(aiUsageSnapshots.workspaceId, workspaceId), eq(aiUsageSnapshots.connectionId, connectionId))).orderBy(desc(aiUsageSnapshots.observedAt)).limit(1))[0];
    const observedAt = new Date(usage.observedAt);
    if (last && observedAt <= last.observedAt) return;
    await database.insert(aiUsageSnapshots).values({ workspaceId, connectionId, availability: usage.availability, windows: usage.windows.map(window => ({ ...window })), source: 'PROVIDER_REPORTED', observedAt });
  };
  return {
    async read(workspaceId) {
      const connection = await latest(workspaceId);
      if (!connection) return null;
      const row = (await database.select().from(aiUsageSnapshots).where(and(eq(aiUsageSnapshots.workspaceId, workspaceId), eq(aiUsageSnapshots.connectionId, connection.id))).orderBy(desc(aiUsageSnapshots.observedAt)).limit(1))[0];
      let usage = emptyUsage();
      if (row && row.source === 'PROVIDER_REPORTED' && connection.active) {
        try {
          usage = normalizeAiUsage({ provider: 'codex', source: 'PROVIDER_REPORTED', observedAt: row.observedAt.toISOString(), costUsd: null, windows: row.windows.map(window => ({ windowId: String(window.windowId), usedPercent: typeof window.usedPercent === 'number' ? window.usedPercent : null, resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : null, limitReached: typeof window.limitReached === 'boolean' ? window.limitReached : null })) }, Date.now());
        } catch { /* A future or incompatible snapshot must never become a made-up quota. */ }
      }
      return { id: connection.id, authorized: connection.active, sessionState: connection.state === 'CONNECTED' && connection.active ? 'SIGNED_IN' : connection.state === 'LOGIN_REQUIRED' ? 'SIGNED_OUT' : 'UNAVAILABLE', version: connection.binaryVersion, maskedIdentity: connection.maskedIdentity, plan: null, usage };
    },
    async inspect(workspaceId, observation) {
      const connection = await latest(workspaceId);
      if (!connection?.active) return;
      if (observation.status === 'SIGNED_OUT' || (observation.status === 'SIGNED_IN' && connection.accountFingerprint !== observation.accountFingerprint)) {
        await queue.revokeConnection(workspaceId, connection.id);
        onRevoked?.(workspaceId, connection.id);
        return;
      }
      // A temporary read failure suspends dispatch, without pretending that the person changed accounts.
      await database.update(aiConnections).set({ state: observation.status === 'SIGNED_IN' ? 'CONNECTED' : 'UNAVAILABLE', binaryVersion: observation.version, updatedAt: new Date() }).where(and(eq(aiConnections.workspaceId, workspaceId), eq(aiConnections.id, connection.id), eq(aiConnections.active, true)));
      if (observation.status === 'SIGNED_IN') await saveUsage(workspaceId, connection.id, observation.usage);
    },
    async authorize(workspaceId: string, observation: CodexAccountObservation) {
      if (observation.status !== 'SIGNED_IN' || observation.billing !== 'CHATGPT_PLAN' || !observation.accountFingerprint) throw new AiConnectionStoreError('AI_CHECK_ACCOUNT');
      const fingerprint = observation.accountFingerprint;
      const connectionId = await database.transaction(async tx => {
        await lockKey(tx, AI_QUEUE_LOCK);
        const active = (await tx.select().from(aiConnections).where(and(eq(aiConnections.workspaceId, workspaceId), eq(aiConnections.provider, 'codex'), eq(aiConnections.active, true))).limit(1))[0];
        if (active) {
          if (active.accountFingerprint !== fingerprint) throw new AiConnectionStoreError('AI_CONNECTION_CONFLICT');
          return active.id;
        }
        const result = await tx.insert(aiConnections).values({ workspaceId, provider: 'codex', officialContextRef: null, maskedIdentity: observation.maskedIdentity, accountFingerprint: fingerprint, binaryVersion: observation.version, capabilities: { login: true, structuredOutput: true, usageWindows: true, cancellation: true, isolatedExecution: true }, state: 'CONNECTED', active: true }).returning({ id: aiConnections.id });
        return result[0]!.id;
      });
      await saveUsage(workspaceId, connectionId, observation.usage);
    },
    async disconnect(workspaceId, id) {
      const connection = (await database.select().from(aiConnections).where(and(eq(aiConnections.workspaceId, workspaceId), eq(aiConnections.id, id))).limit(1))[0];
      if (!connection) return false;
      if (connection.active) await queue.revokeConnection(workspaceId, id);
      onRevoked?.(workspaceId, id);
      return true;
    },
  };
}
