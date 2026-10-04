import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AI_LIMITS, aiErrorSchema, aiOperationDataCategories, aiSnapshotDataCategories, aiSourceSnapshotSchema, canAutoRetryAiRun, validateAiOutput,
  type AiError, type AiOperation, type AiRunOrigin, type AiSourceSnapshot,
} from '@career/domain';
import { hashAiInputContent } from './prompts.js';

export type AiQueueErrorCode = 'INVALID_INPUT' | 'STORAGE_UNAVAILABLE' | 'CONSENT_INVALID' | 'IDEMPOTENCY_CONFLICT' | 'EQUIVALENT_ACTIVE' | 'QUEUE_FULL' | 'MANUAL_QUEUE_FULL' | 'PASS_LIMIT' | 'DAILY_LIMIT' | 'CLOCK_INVALID' | 'INVALID_OUTPUT' | 'RETRY_INVALID';
export class AiQueueError extends Error { constructor(readonly code: AiQueueErrorCode) { super(code); this.name = 'AiQueueError'; } }
export type EnqueueAiRunInput = {
  workspaceId: string; connectionId: string; consentId: string; connectionRevision: number; consentRevision: number;
  provider: 'codex' | 'claude-code'; model?: string; accountFingerprint: string; operation: AiOperation; origin: AiRunOrigin;
  idempotencyKey: string; contentIdentity: string;
  /** Derived by the server from the official account/context, never accepted from a browser. */
  accountLockKey: string; snapshot: AiSourceSnapshot; snapshotHash: string; inputVersions: Record<string, unknown>;
  searchId?: string; automationPolicyId?: string; automationPolicyRevision?: number; reservationPassId?: string; now?: Date; retryOf?: string;
};
export type AiQueueRun = {
  id: string; workspaceId: string; connectionId: string; consentId: string; connectionRevision: number; consentRevision: number;
  provider: 'codex' | 'claude-code'; accountFingerprint: string; model: string | null; operation: AiOperation; origin: AiRunOrigin;
  status: string; snapshot: AiSourceSnapshot; snapshotHash: string; inputVersions: Record<string, unknown>;
  searchId: string | null; automationPolicyId: string | null; leaseToken?: string;
};
export type ClaimAiRunInput = { workerId: string; leaseMs?: number; now?: Date };
export type StoreAiArtifactInput = { schemaVersion: number; promptVersion: string; locale: 'es' | 'en'; output: Record<string, unknown>; sources: Record<string, unknown> };
export type AiRunUsage = { availability: 'KNOWN' | 'STALE' | 'UNAVAILABLE'; model?: string | null; inputTokens?: number | null; outputTokens?: number | null; costUsd?: string | null };
export type FinalizeAiRunInput = { artifact: StoreAiArtifactInput; usage?: AiRunUsage; verifySources: (client: AiPgClient, run: AiQueueRun) => Promise<boolean> };
export type AiQueue = ReturnType<typeof createAiQueue>;
// Rows are selected only by the fixed SQL below; raw database details never escape as errors.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type QueryResult = { rows: Row[]; rowCount: number | null };
export type AiPgClient = { query: (sql: string, values?: unknown[]) => Promise<QueryResult>; release: () => void };
export type AiPgPool = { connect: () => Promise<AiPgClient> };

/** Short queue mutations share a lock order; model execution never holds this lock or a transaction. */
export const AI_QUEUE_LOCK = 'career-ai-queue-v1';
export async function lockAiQueue(client: Pick<AiPgClient, 'query'>): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [AI_QUEUE_LOCK]);
}
async function tx<T>(pool: AiPgPool, work: (client: AiPgClient) => Promise<T>): Promise<T> {
  let client: AiPgClient | undefined;
  try {
    client = await pool.connect(); await client.query('BEGIN'); await lockAiQueue(client);
    const result = await work(client); await client.query('COMMIT'); return result;
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => undefined);
    if (error instanceof AiQueueError) throw error;
    throw new AiQueueError('STORAGE_UNAVAILABLE');
  } finally { client?.release(); }
}
const uuid = z.string().uuid(); const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const usageSchema = z.object({ availability: z.enum(['KNOWN', 'STALE', 'UNAVAILABLE']), model: z.string().min(1).max(160).nullable().optional(), inputTokens: z.number().int().nonnegative().nullable().optional(), outputTokens: z.number().int().nonnegative().nullable().optional(), costUsd: z.string().regex(/^\d+(?:\.\d+)?$/u).nullable().optional() }).strict();
const enqueueSchema = z.object({
  workspaceId: uuid, connectionId: uuid, consentId: uuid, connectionRevision: z.number().int().positive(), consentRevision: z.number().int().positive(),
  provider: z.enum(['codex', 'claude-code']), model: z.string().min(1).max(160).optional(), accountFingerprint: hash, operation: z.enum(['SEARCH_DRAFT', 'JOB_ANALYSIS', 'RESUME_DRAFT', 'ANSWER_DRAFT']), origin: z.enum(['MANUAL', 'AUTOMATIC']),
  idempotencyKey: z.string().min(1).max(200), contentIdentity: hash, accountLockKey: hash, snapshot: aiSourceSnapshotSchema, snapshotHash: hash, inputVersions: z.record(z.string(), z.unknown()),
  searchId: uuid.optional(), automationPolicyId: uuid.optional(), automationPolicyRevision: z.number().int().positive().optional(), reservationPassId: uuid.optional(), now: z.date().optional(), retryOf: uuid.optional(),
}).strict();
function day(now: Date): string { if (!Number.isFinite(now.getTime())) throw new AiQueueError('INVALID_INPUT'); return now.toISOString().slice(0, 10); }
function leaseDuration(value = 30_000): number { if (!Number.isFinite(value) || value < 5_000 || value > 120_000) throw new AiQueueError('INVALID_INPUT'); return Math.floor(value); }
function runRecord(row: Row): AiQueueRun {
  return { id: row.id, workspaceId: row.workspace_id, connectionId: row.connection_id, consentId: row.consent_id, connectionRevision: row.connection_revision, consentRevision: row.consent_revision, provider: row.provider, accountFingerprint: row.account_fingerprint, model: row.model ?? null, operation: row.operation, origin: row.origin, status: row.status, snapshot: row.snapshot, snapshotHash: row.snapshot_hash, inputVersions: row.input_versions, searchId: row.search_id ?? null, automationPolicyId: row.automation_policy_id ?? null, ...(row.lease_token ? { leaseToken: row.lease_token } : {}) };
}

/** Consent writers must lock the connection before inserting a new consent revision (or acquire AI_QUEUE_LOCK first). */
async function authorization(client: AiPgClient, run: Row): Promise<{ model: string | null; maximum: number } | null> {
  if (run.snapshot?.job) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`job-identity:${run.workspace_id}`]);
  const result = await client.query(`SELECT c.revision AS connection_revision,c.account_fingerprint AS connection_fingerprint,c.provider AS connection_provider,c.selected_model,c.active,c.state,
    a.revision,a.connection_revision AS consent_connection_revision,a.account_fingerprint,a.provider,a.operation,a.data_categories,a.search_ids,a.revoked_at,a.remembered
    FROM ai_connections c JOIN ai_consents a ON a.workspace_id=c.workspace_id AND a.connection_id=c.id
    WHERE c.workspace_id=$1 AND c.id=$2 AND a.id=$3 FOR UPDATE OF c,a`, [run.workspace_id, run.connection_id, run.consent_id]);
  const auth = result.rows[0];
  if (!auth || !auth.active || auth.state !== 'CONNECTED' || auth.revoked_at || auth.revision !== run.consent_revision
    || auth.connection_revision !== run.connection_revision || auth.consent_connection_revision !== run.connection_revision
    || auth.account_fingerprint !== run.account_fingerprint || auth.connection_fingerprint !== run.account_fingerprint
    || auth.provider !== run.provider || auth.connection_provider !== run.provider || auth.operation !== run.operation) return null;
  const snapshot = aiSourceSnapshotSchema.safeParse(run.snapshot);
  if (!snapshot.success) return null;
  const needed = new Set([...aiOperationDataCategories[snapshot.data.operation], ...aiSnapshotDataCategories(snapshot.data)]);
  if (!Array.isArray(auth.data_categories) || [...needed].some((category) => !auth.data_categories.includes(category))) return null;
  if (run.origin === 'MANUAL' && auth.search_ids !== null) return null;
  if (!run.id && !auth.remembered && (await client.query('SELECT 1 FROM ai_runs WHERE workspace_id=$1 AND consent_id=$2 UNION ALL SELECT 1 FROM ai_run_tombstones WHERE workspace_id=$1 AND consent_id=$2 LIMIT 1', [run.workspace_id,run.consent_id])).rowCount) return null;
  if (run.id && auth.selected_model && auth.selected_model !== run.model) return null;
  if (run.origin !== 'AUTOMATIC') return { model: auth.selected_model ?? null, maximum: AI_LIMITS.automaticStartsPerUtcDay };
  if (run.operation !== 'JOB_ANALYSIS' || !run.search_id || !run.automation_policy_id || !run.reservation_pass_id || !Array.isArray(auth.search_ids) || !auth.search_ids.includes(run.search_id)) return null;
  const policy = await client.query(`SELECT p.*,s.enabled FROM ai_automation_policies p JOIN saved_job_searches s ON s.workspace_id=p.workspace_id AND s.id=$4
    WHERE p.workspace_id=$1 AND p.id=$2 AND p.connection_id=$3 FOR UPDATE OF p,s`, [run.workspace_id, run.automation_policy_id, run.connection_id, run.search_id]);
  const current = policy.rows[0];
  if (!current || !current.active || current.paused || !current.enabled || current.consent_id !== run.consent_id || current.revision !== run.automation_policy_revision
    || !Array.isArray(current.search_ids) || !current.search_ids.includes(run.search_id) || current.maximum_daily_starts < 1) return null;
  const selection=aiSourceSnapshotSchema.safeParse(current.selection_snapshot);
  if (!selection.success || !auth.remembered || selection.data.operation!=='JOB_ANALYSIS' || selection.data.workspaceId!==run.workspace_id
    || selection.data.snapshotHash!==hashAiInputContent(selection.data) || selection.data.locale!==current.locale || snapshot.data.locale!==current.locale
    || !Array.isArray(current.selected_fact_ids) || new Set(current.selected_fact_ids).size!==current.selected_fact_ids.length
    || JSON.stringify([...current.selected_fact_ids].sort())!==JSON.stringify(selection.data.facts.map(fact=>fact.factId).sort())) return null;
  // Exact copied facts may have fresh IDs after a profile save; the consented content and multiplicity must not expand.
  const evidence=(source:AiSourceSnapshot)=>source.facts.map(({kind,text,contentHash})=>JSON.stringify([kind,text,contentHash])).sort();
  if (JSON.stringify(evidence(snapshot.data))!==JSON.stringify(evidence(selection.data))) return null;
  const match = await client.query(`SELECT 1 FROM saved_job_search_matches m JOIN jobs j ON j.workspace_id=m.workspace_id AND j.id=m.job_id
    JOIN saved_job_searches s ON s.workspace_id=m.workspace_id AND s.id=m.search_id
    WHERE m.workspace_id=$1 AND m.search_id=$2 AND m.job_id=$3 AND m.matched_at >= $4 AND j.availability='OPEN' AND j.shortlist_decision NOT IN ('ARCHIVED','SKIPPED')
    AND NOT EXISTS(SELECT 1 FROM job_identity_members a JOIN job_identity_members b ON b.workspace_id=a.workspace_id AND b.identity_key=a.identity_key
      JOIN jobs other ON other.workspace_id=b.workspace_id AND other.id=b.job_id WHERE a.workspace_id=j.workspace_id AND a.job_id=j.id AND (other.availability<>'OPEN' OR other.shortlist_decision IN ('ARCHIVED','SKIPPED')))
    AND s.matcher_version=2 AND EXISTS(SELECT 1 FROM search_run_results r WHERE r.workspace_id=m.workspace_id AND r.search_id=m.search_id AND r.job_id=m.job_id AND r.run_id=(
      SELECT x.id FROM search_runs x WHERE x.workspace_id=s.workspace_id AND x.search_id=s.id
      AND x.criteria @> jsonb_build_object('role',s.role,'company',s.company,'location',s.location,'workMode',s.work_mode,'includeRelated',s.include_related,'matcherVersion',s.matcher_version)
      AND x.criteria->'providerIds'=s.provider_ids AND (EXISTS(SELECT 1 FROM search_run_results rr WHERE rr.run_id=x.id) OR x.status='SUCCEEDED')
      ORDER BY x.created_at DESC,x.id DESC LIMIT 1))`, [run.workspace_id, run.search_id, snapshot.data.job?.jobId ?? null,current.activated_at]);
  return match.rowCount ? { model: auth.selected_model ?? null, maximum: Math.min(current.maximum_daily_starts, AI_LIMITS.automaticStartsPerUtcDay) } : null;
}

async function releaseReservation(client: AiPgClient, run: Row) {
  const column = run.origin === 'AUTOMATIC' ? 'automatic_reserved' : 'manual_reserved';
  await client.query(`UPDATE ai_daily_budgets SET ${column}=greatest(0,${column}-1),updated_at=clock_timestamp() WHERE workspace_id=$1 AND control_day=$2`, [run.workspace_id, run.reserved_day]);
}
async function requestCancellation(client: AiPgClient, run: Row, now: Date, code = 'CONSENT_REVOKED') {
  if (run.status === 'QUEUED') {
    await client.query(`UPDATE ai_runs SET status='CANCELLED',error=$2::jsonb,completed_at=$3 WHERE id=$1`, [run.id, JSON.stringify({ code, dispatched: 'NO' }), now]);
    await releaseReservation(client, run);
  } else if (run.status === 'RUNNING') await client.query(`UPDATE ai_runs SET status='CANCEL_REQUESTED',error=$2::jsonb WHERE id=$1`, [run.id, JSON.stringify({ code, dispatched: 'UNKNOWN' })]);
}
async function expireLeases(client: AiPgClient, now: Date): Promise<number> {
  const expired = await client.query(`SELECT * FROM ai_runs WHERE status IN ('RUNNING','CANCEL_REQUESTED') AND lease_until <= $1 FOR UPDATE`, [now]);
  for (const run of expired.rows) await endRun(client,run,run.status==='CANCEL_REQUESTED'?'CANCELLED':'INTERRUPTED',now,{code:run.status==='CANCEL_REQUESTED'?'CANCELLED':'TIMEOUT',dispatched:'UNKNOWN'});
  await client.query(`DELETE FROM ai_account_leases WHERE lease_until <= $1`, [now]);
  return expired.rowCount ?? 0;
}
async function cancelInvalid(client: AiPgClient, now: Date, workspaceId?: string) {
  const pending = await client.query(`SELECT * FROM ai_runs WHERE status IN ('QUEUED','RUNNING') ${workspaceId ? 'AND workspace_id=$1' : ''} ORDER BY workspace_id,id FOR UPDATE`, workspaceId ? [workspaceId] : []);
  for (const run of pending.rows) if (!(await authorization(client, run))) await requestCancellation(client, run, now);
}
async function startsToday(client: AiPgClient, workspaceId: string, now: Date): Promise<number> {
  const today = day(now);
  const result = await client.query(`SELECT max(control_day)::text AS latest,coalesce(sum(automatic_started) FILTER(WHERE control_day=$2),0)::int AS started FROM ai_daily_budgets WHERE workspace_id=$1`, [workspaceId, today]);
  if (result.rows[0]?.latest && result.rows[0]!.latest > today) throw new AiQueueError('CLOCK_INVALID');
  return Number(result.rows[0]?.started ?? 0);
}
async function writeUsage(client: AiPgClient, run: Row, status: string, usage?: AiRunUsage) {
  const parsed = usageSchema.safeParse(usage ?? { availability: 'UNAVAILABLE' });
  if (!parsed.success) throw new AiQueueError('INVALID_INPUT');
  const value = parsed.data;
  await client.query(`INSERT INTO llm_usage(workspace_id,ai_run_id,availability,provider,model,operation,status,input_tokens,output_tokens,cost_usd)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,ai_run_id) DO NOTHING`,
  [run.workspace_id,run.id,value.availability,run.provider,value.model ?? run.model ?? null,run.operation,status,value.inputTokens ?? null,value.outputTokens ?? null,value.costUsd ?? null]);
}
async function endRun(client: AiPgClient, run: Row, status: string, now: Date, error: AiError | null, usage?: AiRunUsage) {
  await client.query(`UPDATE ai_runs SET status=$2,error=$3::jsonb,completed_at=$4,lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE id=$1`, [run.id,status,JSON.stringify(error),now]);
  await client.query(`DELETE FROM ai_account_leases WHERE account_lock_key=$1 AND run_id=$2 AND lease_token=$3`, [run.account_lock_key,run.id,run.lease_token]);
  await writeUsage(client,run,status,usage);
}
const validLease = (run: Row | undefined, token: string, now: Date) => run && ['RUNNING','CANCEL_REQUESTED'].includes(run.status) && run.lease_token === token && run.lease_until instanceof Date && run.lease_until > now;

/** Persistent queue with short serialized writes. Source checks and provider work are distinct: no inference in tx. */
export function createAiQueue(pool: AiPgPool) {
  return {
    async enqueue(input: EnqueueAiRunInput): Promise<AiQueueRun> {
      const parsed = enqueueSchema.safeParse(input);
      if (!parsed.success) throw new AiQueueError('INVALID_INPUT');
      if (input.snapshot.workspaceId !== input.workspaceId || input.snapshot.operation !== input.operation || input.snapshotHash !== input.snapshot.snapshotHash || input.snapshotHash !== hashAiInputContent(input.snapshot)) throw new AiQueueError('INVALID_INPUT');
      if (input.origin === 'MANUAL' && (input.automationPolicyId || input.automationPolicyRevision || input.searchId || input.reservationPassId)) throw new AiQueueError('INVALID_INPUT');
      const now = input.now ?? new Date(); const today = day(now);
      return tx(pool, async (client) => {
        await expireLeases(client, now); await cancelInvalid(client, now, input.workspaceId);
        const duplicate = (await client.query(`SELECT * FROM ai_runs WHERE workspace_id=$1 AND idempotency_key=$2`, [input.workspaceId,input.idempotencyKey])).rows[0];
        if (duplicate) {
          const same = duplicate.snapshot_hash === input.snapshotHash && duplicate.operation === input.operation && duplicate.origin === input.origin
            && duplicate.connection_id === input.connectionId && duplicate.consent_id === input.consentId && duplicate.connection_revision === input.connectionRevision && duplicate.consent_revision === input.consentRevision
            && (!input.model || duplicate.model === input.model) && duplicate.content_identity === input.contentIdentity && duplicate.account_lock_key === input.accountLockKey && duplicate.provider === input.provider && duplicate.account_fingerprint === input.accountFingerprint
            && (duplicate.search_id ?? null) === (input.searchId ?? null) && (duplicate.automation_policy_id ?? null) === (input.automationPolicyId ?? null) && (duplicate.automation_policy_revision ?? null) === (input.automationPolicyRevision ?? null);
          if (!same) throw new AiQueueError('IDEMPOTENCY_CONFLICT');
          return runRecord(duplicate);
        }
        if ((await client.query('SELECT 1 FROM ai_run_tombstones WHERE workspace_id=$1 AND idempotency_hash=$2', [input.workspaceId,createHash('sha256').update(input.idempotencyKey).digest('hex')])).rowCount) throw new AiQueueError('CONSENT_INVALID');
        const candidate: Row = { workspace_id:input.workspaceId,connection_id:input.connectionId,consent_id:input.consentId,connection_revision:input.connectionRevision,consent_revision:input.consentRevision,provider:input.provider,account_fingerprint:input.accountFingerprint,operation:input.operation,origin:input.origin,snapshot:parsed.data.snapshot,search_id:input.searchId,automation_policy_id:input.automationPolicyId,automation_policy_revision:input.automationPolicyRevision,reservation_pass_id:input.reservationPassId };
        const auth = await authorization(client,candidate); if (!auth) throw new AiQueueError('CONSENT_INVALID');
        const counts = (await client.query(`SELECT count(*) FILTER(WHERE status='QUEUED')::int AS queued,count(*) FILTER(WHERE status='QUEUED' AND origin='MANUAL')::int AS manual,
          count(*) FILTER(WHERE status='QUEUED' AND origin='AUTOMATIC')::int AS automatic,count(*) FILTER(WHERE content_identity=$2)::int AS equivalent FROM ai_runs WHERE workspace_id=$1 AND status IN ('QUEUED','RUNNING','CANCEL_REQUESTED')`, [input.workspaceId,input.contentIdentity])).rows[0]!;
        if (counts.equivalent) throw new AiQueueError('EQUIVALENT_ACTIVE');
        if (counts.queued >= AI_LIMITS.queuedPerWorkspace) throw new AiQueueError('QUEUE_FULL');
        if (input.origin === 'MANUAL' && counts.manual >= AI_LIMITS.manualQueued) throw new AiQueueError('MANUAL_QUEUE_FULL');
        if (input.origin === 'AUTOMATIC') {
          if (await startsToday(client,input.workspaceId,now) + counts.automatic >= auth.maximum) throw new AiQueueError('DAILY_LIMIT');
          const count = (await client.query(`SELECT (SELECT count(*) FROM ai_runs WHERE workspace_id=$1 AND reservation_pass_id=$2)+(SELECT count(*) FROM ai_run_tombstones WHERE workspace_id=$1 AND reservation_pass_id=$2) AS count`, [input.workspaceId,input.reservationPassId])).rows[0]!.count;
          if (count >= AI_LIMITS.automaticReservationsPerPass) throw new AiQueueError('PASS_LIMIT');
        }
        let priorAttempts = 0;
        if (input.retryOf) {
          const prior = (await client.query(`SELECT * FROM ai_runs WHERE workspace_id=$1 AND id=$2`,[input.workspaceId,input.retryOf])).rows[0];
          if (!prior || prior.operation !== input.operation || prior.origin !== input.origin || prior.snapshot_hash !== input.snapshotHash || !['FAILED','INTERRUPTED','CANCELLED'].includes(prior.status)
            || (input.origin === 'AUTOMATIC' && !canAutoRetryAiRun({state:prior.status,leaseToken:null,error:prior.error},prior.attempt))) throw new AiQueueError('RETRY_INVALID');
          priorAttempts = prior.attempt;
        }
        const row = (await client.query(`INSERT INTO ai_runs(workspace_id,connection_id,consent_id,provider,model,connection_revision,consent_revision,account_fingerprint,operation,origin,idempotency_key,content_identity,account_lock_key,snapshot,snapshot_hash,input_versions,priority,reservation_pass_id,reserved_day,retry_of,search_id,automation_policy_id,automation_policy_revision,attempt)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16::jsonb,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
        [input.workspaceId,input.connectionId,input.consentId,input.provider,input.model ?? auth.model,input.connectionRevision,input.consentRevision,input.accountFingerprint,input.operation,input.origin,input.idempotencyKey,input.contentIdentity,input.accountLockKey,JSON.stringify(parsed.data.snapshot),input.snapshotHash,JSON.stringify(input.inputVersions),input.origin==='MANUAL'?100:0,input.reservationPassId ?? null,today,input.retryOf ?? null,input.searchId ?? null,input.automationPolicyId ?? null,input.automationPolicyRevision ?? null,priorAttempts])).rows[0]!;
        const column = input.origin === 'AUTOMATIC' ? 'automatic_reserved' : 'manual_reserved';
        await client.query(`INSERT INTO ai_daily_budgets(workspace_id,control_day,${column}) VALUES($1,$2,1) ON CONFLICT(workspace_id,control_day) DO UPDATE SET ${column}=ai_daily_budgets.${column}+1,updated_at=clock_timestamp()`, [input.workspaceId,today]);
        return runRecord(row);
      });
    },
    async claimNext(input: ClaimAiRunInput): Promise<AiQueueRun | null> {
      if (!input.workerId || input.workerId.length > 160) throw new AiQueueError('INVALID_INPUT');
      const now = input.now ?? new Date(); day(now); const duration = leaseDuration(input.leaseMs);
      return tx(pool, async (client) => {
        await expireLeases(client,now); await cancelInvalid(client,now);
        const rows = await client.query(`SELECT * FROM ai_runs WHERE status='QUEUED' ORDER BY priority DESC,reserved_at,id FOR UPDATE`);
        for (const run of rows.rows) {
          const auth = await authorization(client,run); if (!auth) continue;
          const busy = await client.query(`SELECT 1 FROM ai_runs WHERE workspace_id=$1 AND status IN ('RUNNING','CANCEL_REQUESTED') UNION ALL SELECT 1 FROM ai_account_leases WHERE account_lock_key=$2 AND lease_until>$3`,[run.workspace_id,run.account_lock_key,now]);
          if (busy.rowCount) continue;
          if (run.origin === 'AUTOMATIC') {
            if (rows.rows.some((other) => other.workspace_id === run.workspace_id && other.origin === 'MANUAL')) continue;
            try { if (await startsToday(client,run.workspace_id,now) >= auth.maximum) continue; } catch (error) { if (error instanceof AiQueueError && error.code === 'CLOCK_INVALID') continue; throw error; }
          }
          const token = randomUUID(); const until = new Date(now.getTime()+duration);
          const claimed = (await client.query(`UPDATE ai_runs SET status='RUNNING',lease_token=$2,lease_owner=$3,lease_until=$4,attempt=attempt+1,started_at=$5 WHERE id=$1 RETURNING *`,[run.id,token,input.workerId,until,now])).rows[0]!;
          await client.query(`INSERT INTO ai_account_leases(account_lock_key,run_id,workspace_id,lease_token,lease_owner,lease_until) VALUES($1,$2,$3,$4,$5,$6)
            ON CONFLICT(account_lock_key) DO UPDATE SET run_id=excluded.run_id,workspace_id=excluded.workspace_id,lease_token=excluded.lease_token,lease_owner=excluded.lease_owner,lease_until=excluded.lease_until`,[run.account_lock_key,run.id,run.workspace_id,token,input.workerId,until]);
          await releaseReservation(client,run);
          if (run.origin === 'AUTOMATIC') await client.query(`INSERT INTO ai_daily_budgets(workspace_id,control_day,automatic_started) VALUES($1,$2,1) ON CONFLICT(workspace_id,control_day) DO UPDATE SET automatic_started=ai_daily_budgets.automatic_started+1,updated_at=clock_timestamp()`,[run.workspace_id,day(now)]);
          return runRecord(claimed);
        }
        return null;
      });
    },
    async heartbeat(runId: string, leaseToken: string, leaseMs = 30_000, now = new Date()): Promise<boolean> {
      const duration = leaseDuration(leaseMs); day(now);
      return tx(pool, async (client) => {
        const run = (await client.query(`SELECT * FROM ai_runs WHERE id=$1 FOR UPDATE`,[runId])).rows[0];
        if (!validLease(run,leaseToken,now) || run!.status !== 'RUNNING') return false;
        if (!(await authorization(client,run!))) { await requestCancellation(client,run!,now); return false; }
        const until = new Date(now.getTime()+duration);
        const account = await client.query(`UPDATE ai_account_leases SET lease_until=$4 WHERE account_lock_key=$1 AND run_id=$2 AND lease_token=$3 AND lease_until>$5 RETURNING run_id`,[run!.account_lock_key,runId,leaseToken,until,now]);
        if (!account.rowCount) return false;
        await client.query(`UPDATE ai_runs SET lease_until=$2 WHERE id=$1`,[runId,until]); return true;
      });
    },
    async finalize(runId: string, leaseToken: string, input: FinalizeAiRunInput, now = new Date()): Promise<{runId:string;artifactId:string} | null> {
      day(now); const began = performance.now();
      const currentTime = () => new Date(now.getTime()+Math.max(0,performance.now()-began));
      if (typeof input.verifySources !== 'function') throw new AiQueueError('INVALID_INPUT');
      return tx(pool, async (client) => {
        const run = (await client.query(`SELECT * FROM ai_runs WHERE id=$1 FOR UPDATE`,[runId])).rows[0];
        if (!validLease(run,leaseToken,currentTime()) || run!.status !== 'RUNNING') return null;
        if (!(await authorization(client,run!))) { await requestCancellation(client,run!,currentTime()); return null; }
        const account = await client.query(`SELECT 1 FROM ai_account_leases WHERE account_lock_key=$1 AND run_id=$2 AND lease_token=$3 AND lease_until>$4 FOR UPDATE`,[run!.account_lock_key,runId,leaseToken,currentTime()]);
        if (!account.rowCount) return null;
        const artifact = input.artifact;
        const output = validateAiOutput(artifact.output,run!.snapshot,{workspaceId:run!.workspace_id,operation:run!.operation,locale:run!.snapshot.locale});
        if (!output.ok || artifact.schemaVersion !== run!.snapshot.schemaVersion || artifact.locale !== run!.snapshot.locale || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(artifact.promptVersion)) throw new AiQueueError('INVALID_OUTPUT');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`profile:${run!.workspace_id}`]);
        if (run!.snapshot.question) {
          const question=(await client.query('SELECT semantic_key,jurisdiction,question_scope FROM answer_versions WHERE workspace_id=$1 AND id=$2',[run!.workspace_id,run!.snapshot.question.questionId])).rows[0];
          if (!question) { await endRun(client,run!,'FAILED',currentTime(),{code:'SOURCE_CHANGED',dispatched:'YES'},input.usage); return null; }
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`answer:${run!.workspace_id}:${question.semantic_key}:${question.jurisdiction}:${question.question_scope}`]);
        }
        if (!(await input.verifySources(client,runRecord(run!)))) { await endRun(client,run!,'FAILED',currentTime(),{code:'SOURCE_CHANGED',dispatched:'YES'},input.usage); return null; }
        if (!validLease(run,leaseToken,currentTime())) return null;
        const inserted = await client.query(`INSERT INTO ai_artifacts(workspace_id,run_id,schema_version,prompt_version,locale,output,sources) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING id`,[run!.workspace_id,runId,artifact.schemaVersion,artifact.promptVersion,artifact.locale,JSON.stringify(output.output),JSON.stringify(artifact.sources)]);
        await endRun(client,run!,'SUCCEEDED',currentTime(),null,input.usage);
        return {runId,artifactId:inserted.rows[0]!.id};
      });
    },
    async finish(runId: string, leaseToken: string, result: {status:'FAILED'|'INTERRUPTED';error?:AiError;usage?:AiRunUsage}, now = new Date()): Promise<boolean> {
      day(now);
      if (!['FAILED','INTERRUPTED'].includes(result.status) || (result.error && !aiErrorSchema.safeParse(result.error).success)) throw new AiQueueError('INVALID_INPUT');
      return tx(pool,async (client) => {
        const run = (await client.query(`SELECT * FROM ai_runs WHERE id=$1 FOR UPDATE`,[runId])).rows[0];
        if (!validLease(run,leaseToken,now)) return false;
        const cancelled = run!.status === 'CANCEL_REQUESTED';
        await endRun(client,run!,cancelled?'CANCELLED':result.status,now,cancelled?{code:'CANCELLED',dispatched:'UNKNOWN'}:result.error ?? {code:'PROVIDER_ERROR',dispatched:'UNKNOWN'},result.usage); return true;
      });
    },
    async cancel(workspaceId: string, runId: string): Promise<boolean> {
      return tx(pool,async (client) => {
        const run = (await client.query(`SELECT * FROM ai_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[workspaceId,runId])).rows[0];
        if (!run || !['QUEUED','RUNNING','CANCEL_REQUESTED','CANCELLED'].includes(run.status)) return false;
        await requestCancellation(client,run,new Date(),'CANCELLED'); return true;
      });
    },
    async revokeConsent(workspaceId: string, consentId: string): Promise<number> {
      return tx(pool,async (client) => {
        await client.query(`UPDATE ai_consents SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=$1 AND id=$2`,[workspaceId,consentId]);
        await client.query(`UPDATE ai_automation_policies SET paused=true,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND consent_id=$2`,[workspaceId,consentId]);
        const runs = await client.query(`SELECT * FROM ai_runs WHERE workspace_id=$1 AND consent_id=$2 AND status IN ('QUEUED','RUNNING') FOR UPDATE`,[workspaceId,consentId]);
        for (const run of runs.rows) await requestCancellation(client,run,new Date()); return runs.rowCount ?? 0;
      });
    },
    async revokeConnection(workspaceId: string, connectionId: string): Promise<number> {
      return tx(pool,async (client) => {
        await client.query(`UPDATE ai_connections SET active=false,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[workspaceId,connectionId]);
        await client.query(`UPDATE ai_consents SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=$1 AND connection_id=$2`,[workspaceId,connectionId]);
        await client.query(`UPDATE ai_automation_policies SET paused=true,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND connection_id=$2`,[workspaceId,connectionId]);
        const runs = await client.query(`SELECT * FROM ai_runs WHERE workspace_id=$1 AND connection_id=$2 AND status IN ('QUEUED','RUNNING') FOR UPDATE`,[workspaceId,connectionId]);
        for (const run of runs.rows) await requestCancellation(client,run,new Date()); return runs.rowCount ?? 0;
      });
    },
    async pauseAutomation(workspaceId: string, policyId: string, expectedRevision?: number): Promise<number> {
      return tx(pool,async (client) => {
        const updated = await client.query(`UPDATE ai_automation_policies SET paused=true,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND ($3::integer IS NULL OR revision=$3) RETURNING id`,[workspaceId,policyId,expectedRevision ?? null]);
        if (!updated.rowCount) return 0;
        const runs = await client.query(`SELECT * FROM ai_runs WHERE workspace_id=$1 AND automation_policy_id=$2 AND status IN ('QUEUED','RUNNING') FOR UPDATE`,[workspaceId,policyId]);
        for (const run of runs.rows) await requestCancellation(client,run,new Date()); return runs.rowCount ?? 0;
      });
    },
    /** A second process restarting must never fence another healthy worker. Only expired leases are recovered. */
    async recoverAfterRestart(now = new Date()): Promise<number> { day(now); return tx(pool,async (client) => { const count = await expireLeases(client,now); await cancelInvalid(client,now); return count; }); },
  };
}
