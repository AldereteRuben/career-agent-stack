import { randomUUID } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';
import { drizzle, type NodePgClient } from 'drizzle-orm/node-postgres';
import { AI_SCHEMA_VERSION, validateAiOutput, type AiError } from '@career/domain';
import { answerLockKey, profileLockKey } from '../workspace-data.js';
import { CODEX_DEFAULT_MODEL, CODEX_MODELS, CodexExecutionError, executeCodex, type CodexExecutionResult } from './codex.js';
import { AI_PROMPT_VERSION, hashAiInputContent } from './prompts.js';
import { checkCurrentAiSnapshot } from './source-reader.js';
import type { AiCurrentSources } from './source-snapshot.js';
import type { AiPgClient, AiPgPool, AiQueue, AiQueueRun } from './queue.js';

export const AI_WORKER_CONFIG_VERSION = 'codex-0.160.0-v1' as const;
export type AiWorkerEvent = 'STORAGE_UNAVAILABLE' | 'SOURCE_UNAVAILABLE' | 'EXECUTION_FAILED';
export type AiWorkerOptions = {
  pool: AiPgPool; queue: AiQueue; identitySalt: string;
  /** Explicit release/runtime gate. Merely installing/signing into Codex must not start work. */
  enabled?: boolean | (() => boolean);
  workerId?: string; pollMs?: number; leaseMs?: number; heartbeatMs?: number;
  /** Stable codes only; no run data, provider errors or raw database exceptions. */
  onEvent?: (event: AiWorkerEvent) => void;
};
export type AiWorkerDependencies = {
  execute: typeof executeCodex;
  checkSources: (client: AiPgClient, run: AiQueueRun) => Promise<AiCurrentSources>;
  platform: NodeJS.Platform;
  now: () => Date;
  schedule: (callback: () => void, milliseconds: number) => unknown;
  clearSchedule: (handle: unknown) => void;
};
type StopReason = 'SHUTDOWN' | 'CANCEL_REQUESTED' | 'CONSENT_REVOKED' | 'FENCED' | 'STORAGE_UNAVAILABLE';
type ActiveWork = { controller: AbortController; run: AiQueueRun | null; reason: StopReason | null; dispatched: AiError['dispatched'] };

/** The queue owns the caller's SQL transaction; this adapter never starts a nested transaction. */
async function currentSources(client: AiPgClient, run: AiQueueRun): Promise<AiCurrentSources> {
  return checkCurrentAiSnapshot(drizzle(client as unknown as NodePgClient), run.workspaceId, run.snapshot);
}
function usageOf(result: Pick<CodexExecutionResult, 'model' | 'usage'>) {
  const { inputTokens, outputTokens } = result.usage;
  return { availability: inputTokens === null && outputTokens === null ? 'UNAVAILABLE' as const : 'KNOWN' as const,
    model: result.model, inputTokens, outputTokens, costUsd: null };
}
function stopError(work: ActiveWork): AiError {
  return { code: work.reason === 'CONSENT_REVOKED' ? 'CONSENT_REVOKED' : work.reason === 'STORAGE_UNAVAILABLE' || work.reason === 'FENCED' ? 'INTERNAL' : 'CANCELLED', dispatched: work.dispatched };
}
function validVersions(run: AiQueueRun): boolean {
  return run.provider === 'codex' && (run.model === null || CODEX_MODELS.includes(run.model as typeof CODEX_DEFAULT_MODEL))
    && run.inputVersions.schemaVersion === AI_SCHEMA_VERSION && run.inputVersions.promptVersion === AI_PROMPT_VERSION
    && run.inputVersions.configVersion === AI_WORKER_CONFIG_VERSION
    && run.inputVersions.connectionRevision === run.connectionRevision && run.inputVersions.consentRevision === run.consentRevision;
}

/**
 * One local coordinator; database claims/leases also fence other processes. No automatic enqueue or uncertain retries.
 * start() is idempotent. runOnce() is useful for explicit drains and deterministic tests and never overlaps itself.
 */
export function createAiWorker(options: AiWorkerOptions, dependencies: Partial<AiWorkerDependencies> = {}) {
  const pollMs = options.pollMs ?? 2_000;
  const leaseMs = options.leaseMs ?? 30_000;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000
    || !Number.isSafeInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 120_000
    || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 100 || heartbeatMs > leaseMs / 3
    || options.identitySalt.length < 32) throw new Error('AI_WORKER_INVALID_CONFIG');
  const workerId = options.workerId ?? randomUUID();
  const now = dependencies.now ?? (() => new Date());
  const execute = dependencies.execute ?? executeCodex;
  const checkSources = dependencies.checkSources ?? currentSources;
  const schedule = dependencies.schedule ?? ((callback: () => void, milliseconds: number) => {
    const timer = setTimeout(callback, milliseconds); timer.unref(); return timer;
  });
  const clearSchedule = dependencies.clearSchedule ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const enabled = () => (dependencies.platform ?? process.platform) === 'darwin'
    && (typeof options.enabled === 'function' ? options.enabled() : options.enabled === true);
  const notify = (event: AiWorkerEvent) => { try { options.onEvent?.(event); } catch { /* Diagnostics never own a task. */ } };
  let started = false;
  let pollTimer: unknown = null;
  let pending: Promise<boolean> | null = null;
  let active: ActiveWork | null = null;

  function abort(work: ActiveWork, reason: StopReason) {
    work.reason ??= reason;
    work.controller.abort();
  }

  async function sourceBeforeDispatch(run: AiQueueRun): Promise<AiCurrentSources> {
    const client = await options.pool.connect();
    try {
      // Read after the source locks are acquired, including when a mutation was already holding them.
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (run.snapshot.job) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`job-identity:${run.workspaceId}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [profileLockKey(run.workspaceId)]);
      if (run.snapshot.question) {
        const answer = (await client.query('SELECT semantic_key,jurisdiction,question_scope FROM answer_versions WHERE workspace_id=$1 AND id=$2', [run.workspaceId, run.snapshot.question.questionId])).rows[0];
        if (answer) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [answerLockKey(run.workspaceId, { semanticKey: answer.semantic_key, jurisdiction: answer.jurisdiction, questionScope: answer.question_scope })]);
      }
      const state = await checkSources(client, run);
      await client.query('COMMIT');
      return state;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async function perform(work: ActiveWork): Promise<boolean> {
    let heartbeatTimer: unknown = null;
    let heartbeatPending: Promise<void> | null = null;
    let heartbeatsStopped = false;
    let observedUsage: ReturnType<typeof usageOf> | null = null;
    const stopHeartbeats = async () => {
      heartbeatsStopped = true;
      if (heartbeatTimer !== null) clearSchedule(heartbeatTimer);
      heartbeatTimer = null;
      await heartbeatPending;
    };
    const heartbeat = async () => {
      const run = work.run;
      if (heartbeatsStopped || work.controller.signal.aborted || !run?.leaseToken) return;
      if (!enabled()) { abort(work, 'SHUTDOWN'); return; }
      try {
        if (!await options.queue.heartbeat(run.id, run.leaseToken, leaseMs, now())) abort(work, 'FENCED');
      } catch { notify('STORAGE_UNAVAILABLE'); abort(work, 'STORAGE_UNAVAILABLE'); }
    };
    const heartbeatTick = () => {
      heartbeatTimer = null;
      heartbeatPending = heartbeat().finally(() => {
        heartbeatPending = null;
        if (!heartbeatsStopped && !work.controller.signal.aborted) heartbeatTimer = schedule(heartbeatTick, heartbeatMs);
      });
    };
    const finish = async (status: 'FAILED' | 'INTERRUPTED', error: AiError) => {
      const run = work.run;
      if (!run?.leaseToken) return;
      try { await options.queue.finish(run.id, run.leaseToken, { status, error, ...(observedUsage ? { usage: observedUsage } : {}) }, now()); }
      catch { notify('STORAGE_UNAVAILABLE'); /* Lease expiry will interrupt it; never retry the model. */ }
    };
    const revokeAppConnection = async () => {
      const run = work.run;
      if (!run) return;
      try { await options.queue.revokeConnection(run.workspaceId, run.connectionId); }
      catch { notify('STORAGE_UNAVAILABLE'); }
    };
    try {
      work.run = await options.queue.claimNext({ workerId, leaseMs, now: now() });
      const run = work.run;
      if (!run) return false;
      if (!run.leaseToken) { notify('STORAGE_UNAVAILABLE'); return true; }
      if (work.controller.signal.aborted || !enabled()) {
        abort(work, 'SHUTDOWN'); await finish('INTERRUPTED', stopError(work)); return true;
      }
      if (!validVersions(run)) {
        await finish('FAILED', { code: 'UNSUPPORTED_VERSION', dispatched: 'NO' }); return true;
      }
      // Check persisted cancellation/consent immediately, then renew while source reads and account/model work await.
      await heartbeat();
      if (work.controller.signal.aborted) { await finish('INTERRUPTED', stopError(work)); return true; }
      heartbeatTimer = schedule(heartbeatTick, heartbeatMs);
      let current: AiCurrentSources;
      try { current = await sourceBeforeDispatch(run); }
      catch {
        if (work.controller.signal.aborted) await finish('INTERRUPTED', stopError(work));
        else { notify('SOURCE_UNAVAILABLE'); await finish('FAILED', { code: 'INTERNAL', dispatched: 'NO' }); }
        return true;
      }
      if (!current.ok || run.snapshotHash !== run.snapshot.snapshotHash || run.snapshotHash !== hashAiInputContent(run.snapshot)) {
        await finish('FAILED', { code: 'SOURCE_CHANGED', dispatched: 'NO' }); return true;
      }
      if (work.controller.signal.aborted) { await finish('INTERRUPTED', stopError(work)); return true; }
      // Every transaction above has committed/released before any account-backed model request is possible.
      work.dispatched = 'UNKNOWN';
      const observed = await execute(run.snapshot, run.accountFingerprint, options.identitySalt, work.controller.signal,
        (run.model ?? CODEX_DEFAULT_MODEL) as typeof CODEX_DEFAULT_MODEL);
      observedUsage = usageOf(observed);
      work.dispatched = 'YES';
      await stopHeartbeats();
      if (work.controller.signal.aborted) { await finish('INTERRUPTED', stopError(work)); return true; }
      // Defense in depth for injected/provider adapters: never persist a result for another operation/source scope.
      const checked = validateAiOutput(observed.output, run.snapshot, { workspaceId: run.workspaceId, operation: run.operation, locale: run.snapshot.locale });
      if (!checked.ok || observed.inputContentHash !== run.snapshotHash || observed.account.accountFingerprint !== run.accountFingerprint) {
        if (observed.account.accountFingerprint !== run.accountFingerprint) await revokeAppConnection();
        await finish('FAILED', { code: observed.account.accountFingerprint !== run.accountFingerprint ? 'ACCOUNT_CHANGED' : 'INVALID_OUTPUT', dispatched: 'YES' }); return true;
      }
      const sources: Record<string, unknown> = { snapshot: run.snapshot, resolvedFacts: current.resolvedFacts, inputVersions: run.inputVersions };
      const finalized = await options.queue.finalize(run.id, run.leaseToken, {
        artifact: { schemaVersion: AI_SCHEMA_VERSION, promptVersion: AI_PROMPT_VERSION, locale: run.snapshot.locale,
          output: checked.output, sources },
        usage: usageOf(observed),
        verifySources: async (client, liveRun) => {
          if (work.controller.signal.aborted || !enabled() || liveRun.id !== run.id || liveRun.workspaceId !== run.workspaceId
            || liveRun.snapshotHash !== run.snapshotHash || liveRun.leaseToken !== run.leaseToken) return false;
          const latest = await checkSources(client, liveRun);
          if (!latest.ok || work.controller.signal.aborted) return false;
          sources.resolvedFacts = latest.resolvedFacts;
          return true;
        },
      }, now());
      // A null result is fenced/revoked/cancelled or stale. Never bypass that decision with a separate artifact write.
      if (!finalized) await finish('INTERRUPTED', { code: 'INTERNAL', dispatched: 'YES' });
      return true;
    } catch (error) {
      await stopHeartbeats();
      if (!work.run) { notify('STORAGE_UNAVAILABLE'); return false; }
      if (error instanceof CodexExecutionError && error.usage) observedUsage = usageOf({ usage: error.usage, model: (work.run.model ?? CODEX_DEFAULT_MODEL) as typeof CODEX_DEFAULT_MODEL });
      if (work.controller.signal.aborted) await finish('INTERRUPTED', stopError(work));
      else if (error instanceof CodexExecutionError) {
        if (error.invalidateConnection || error.code === 'ACCOUNT_CHANGED') await revokeAppConnection();
        await finish('FAILED', { code: error.code, dispatched: error.dispatched });
      }
      else { notify('EXECUTION_FAILED'); await finish('INTERRUPTED', { code: 'INTERNAL', dispatched: work.dispatched }); }
      return true;
    } finally { await stopHeartbeats(); }
  }

  function schedulePoll() {
    if (!started || pollTimer !== null) return;
    pollTimer = schedule(() => { pollTimer = null; void runOnce().finally(schedulePoll); }, pollMs);
  }
  function runOnce(): Promise<boolean> {
    if (pending || !enabled()) return Promise.resolve(false);
    const work: ActiveWork = { controller: new AbortController(), run: null, reason: null, dispatched: 'NO' };
    active = work;
    pending = perform(work).finally(() => { if (active === work) active = null; pending = null; });
    return pending;
  }
  return {
    start() { if (started || !enabled()) return; started = true; void runOnce().finally(schedulePoll); },
    async stop() {
      started = false;
      if (pollTimer !== null) clearSchedule(pollTimer);
      pollTimer = null;
      if (active) abort(active, 'SHUTDOWN');
      await pending;
    },
    runOnce,
    isRunning: () => started || active !== null,
    /** Persist queue.cancel first; this shortcut reaches only this process's current run. */
    cancelRun(runId: string): boolean {
      if (active?.run?.id !== runId) return false;
      abort(active, 'CANCEL_REQUESTED'); return true;
    },
    /** Persist revocation first. Heartbeats protect runs owned by other worker processes. */
    cancelConnection(workspaceId: string, connectionId: string): boolean {
      if (active?.run?.workspaceId !== workspaceId || active.run.connectionId !== connectionId) return false;
      abort(active, 'CONSENT_REVOKED'); return true;
    },
  };
}
