import { eq } from 'drizzle-orm';
import { aiArtifacts, aiAutomationPolicies, aiConnections, aiConsents, aiRuns, aiRunTombstones, aiUsageSnapshots, llmUsage, type db } from '@career/db';

function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const result = { ...value }; for (const key of keys) delete (result as Partial<T>)[key]; return result;
}

/** Portable personal content and provenance. Account credentials/context and live task ownership are never exported. */
export async function exportAiData(database: typeof db, workspaceId: string) {
  const [connections, consents, policies, runs, artifacts, usage, limits, deletedRunMarkers] = await Promise.all([
    database.select().from(aiConnections).where(eq(aiConnections.workspaceId, workspaceId)),
    database.select().from(aiConsents).where(eq(aiConsents.workspaceId, workspaceId)),
    database.select().from(aiAutomationPolicies).where(eq(aiAutomationPolicies.workspaceId, workspaceId)),
    database.select().from(aiRuns).where(eq(aiRuns.workspaceId, workspaceId)),
    database.select().from(aiArtifacts).where(eq(aiArtifacts.workspaceId, workspaceId)),
    database.select().from(llmUsage).where(eq(llmUsage.workspaceId, workspaceId)),
    database.select().from(aiUsageSnapshots).where(eq(aiUsageSnapshots.workspaceId, workspaceId)),
    database.select().from(aiRunTombstones).where(eq(aiRunTombstones.workspaceId, workspaceId)),
  ]);
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    connections: connections.map(row => ({ id: row.id, workspaceId, provider: row.provider, active: false, state: 'UNAVAILABLE', revision: row.revision + 1 })),
    consents: consents.map(row => ({ ...without(row, 'accountFingerprint'), revokedAt: row.revokedAt ?? now })),
    policies: policies.map(row => ({ ...row, active: false, paused: true, revision: row.revision + 1 })),
    runs: runs.map(row => ({ ...without(row, 'accountFingerprint', 'accountLockKey', 'leaseToken', 'leaseOwner', 'leaseUntil'),
      status: row.status === 'QUEUED' ? 'CANCELLED' : ['RUNNING', 'CANCEL_REQUESTED'].includes(row.status) ? 'INTERRUPTED' : row.status,
      completedAt: row.completedAt ?? now,
    })),
    artifacts, usage, deletedRunMarkers,
    limits: limits.map(row => ({ ...row, availability: 'UNAVAILABLE', source: 'NONE', windows: [] })),
  };
}
