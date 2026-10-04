import { createHash, randomUUID } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';
import { z } from 'zod';
import { profileLockKey } from '../workspace-data.js';
import { lockAiQueue, type AiPgClient, type AiPgPool } from './queue.js';

export const AI_HISTORY_RETENTION_DAYS = 30;
const uuid = z.string().uuid();
export const aiHistoryClearSchema = z.object({ previewId: uuid }).strict();
export class AiHistoryError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'AI_PREVIEW_EXPIRED' | 'AI_TOO_MANY_PREVIEWS') { super(code); this.name = 'AiHistoryError'; }
}
type Run = { id: string; status: string; retry_of: string | null; completed_at: Date | null; created_at: Date;
  artifact_id: string | null; artifact_state: string | null; dismissed_at: Date | null; referenced: boolean };
type Selection = { runs: string[]; artifacts: number; usage: string[]; snapshots: string[];
  preserved: { activeRuns: number; referencedArtifacts: number; retainedDependencies: number } };
type Result = { deleted: { runs: number; artifacts: number; usageRecords: number }; retentionDays: number };
type Preview = { workspaceId: string; createdAt: number; selection: Selection; result?: Result; task?: Promise<Result> };
export type AiHistoryOptions = { pool: AiPgPool; now?: () => Date };
const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);

async function transaction<T>(pool: AiPgPool, workspaceId: string, work: (client: AiPgClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await lockAiQueue(client);
    // Shared order with finalization/adoption: a new document/answer cannot race the reference check.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`job-identity:${workspaceId}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [profileLockKey(workspaceId)]);
    const result = await work(client); await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

async function selectHistory(client: AiPgClient, workspaceId: string, cutoff: Date | null, previous?: Selection): Promise<Selection> {
  const rows = (await client.query(`SELECT r.id,r.status,r.retry_of,r.completed_at,r.created_at,a.id AS artifact_id,a.state AS artifact_state,a.dismissed_at,
    (a.id IS NOT NULL AND (EXISTS(SELECT 1 FROM document_versions d WHERE d.workspace_id=r.workspace_id
      AND d.claims_basis->'claims' @> jsonb_build_array(jsonb_build_object('artifactId',a.id::text)))
    OR EXISTS(SELECT 1 FROM answer_versions v WHERE v.workspace_id=r.workspace_id AND v.ai_provenance->>'artifactId'=a.id::text))) AS referenced
    FROM ai_runs r LEFT JOIN ai_artifacts a ON a.workspace_id=r.workspace_id AND a.run_id=r.id WHERE r.workspace_id=$1`, [workspaceId])).rows as Run[];
  const previousIds = previous && new Set(previous.runs);
  const candidates = new Set(rows.filter(row => terminal.has(row.status) && !row.referenced && (!previousIds || previousIds.has(row.id))
    && (!cutoff || ((row.completed_at ?? row.created_at) < cutoff
      && (!row.artifact_id || (row.artifact_state === 'DISMISSED' && row.dismissed_at !== null && row.dismissed_at < cutoff))))).map(row => row.id));
  // A retained retry references every ancestor; retain that chain as well, including active/referenced children.
  const byId = new Map(rows.map(row => [row.id, row]));
  const blocked: string[] = rows.filter(row => !candidates.has(row.id)).map(row => row.id);
  const visited = new Set<string>(); let retainedDependencies = 0;
  while (blocked.length) {
    const id = blocked.pop()!; if (visited.has(id)) continue; visited.add(id);
    const parent = byId.get(id)?.retry_of;
    if (parent) { if (candidates.delete(parent)) retainedDependencies++; blocked.push(parent); }
  }
  const runs = [...candidates].sort();
  // Usage can be removed independently of retained artifacts. Never touch rows associated with active work.
  const usage = (await client.query(`SELECT u.id FROM llm_usage u LEFT JOIN ai_runs r ON r.workspace_id=u.workspace_id AND r.id=u.ai_run_id
    WHERE u.workspace_id=$1 AND (r.id IS NULL OR r.status IN ('SUCCEEDED','FAILED','CANCELLED','INTERRUPTED'))
    AND ($2::timestamptz IS NULL OR u.created_at<$2 OR r.id=ANY($3::uuid[]))`, [workspaceId,cutoff,runs])).rows.map(row => row.id as string);
  const snapshots = (await client.query(`SELECT id FROM ai_usage_snapshots WHERE workspace_id=$1 AND ($2::timestamptz IS NULL OR created_at<$2)`, [workspaceId,cutoff])).rows.map(row => row.id as string);
  const allowedUsage = previous && new Set(previous.usage), allowedSnapshots = previous && new Set(previous.snapshots);
  return { runs, artifacts: rows.filter(row => candidates.has(row.id) && row.artifact_id).length,
    usage: allowedUsage ? usage.filter(id => allowedUsage.has(id)) : usage,
    snapshots: allowedSnapshots ? snapshots.filter(id => allowedSnapshots.has(id)) : snapshots,
    preserved: { activeRuns: rows.filter(row => !terminal.has(row.status)).length,
      referencedArtifacts: rows.filter(row => row.referenced).length, retainedDependencies } };
}

async function removeHistory(client: AiPgClient, workspaceId: string, selection: Selection, now: Date): Promise<Result> {
  const rows = (await client.query(`SELECT r.id,r.consent_id,r.idempotency_key,r.reservation_pass_id,
    CASE WHEN r.operation='JOB_ANALYSIS' THEN r.snapshot->'job'->>'jobId' ELSE NULL END AS job_id,im.identity_key
    FROM ai_runs r LEFT JOIN job_identity_members im ON im.workspace_id=r.workspace_id AND im.job_id::text=r.snapshot->'job'->>'jobId'
    WHERE r.workspace_id=$1 AND r.id=ANY($2::uuid[])`, [workspaceId, selection.runs])).rows;
  for (const row of rows) await client.query(`INSERT INTO ai_run_tombstones(workspace_id,run_id,consent_id,idempotency_hash,job_id,canonical_identity,reservation_pass_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,run_id) DO NOTHING`, [workspaceId,row.id,row.consent_id,
    createHash('sha256').update(row.idempotency_key as string).digest('hex'),uuid.safeParse(row.job_id).success ? row.job_id : null,row.job_id ? row.identity_key ?? null : null,row.reservation_pass_id,now]);
  const usage = await client.query('DELETE FROM llm_usage WHERE workspace_id=$1 AND id=ANY($2::uuid[])', [workspaceId,selection.usage]);
  const snapshots = await client.query('DELETE FROM ai_usage_snapshots WHERE workspace_id=$1 AND id=ANY($2::uuid[])', [workspaceId,selection.snapshots]);
  // Cascade removes artifacts only after all references were checked under adoption locks.
  const removed = await client.query('DELETE FROM ai_runs WHERE workspace_id=$1 AND id=ANY($2::uuid[])', [workspaceId,selection.runs]);
  return { deleted: { runs: removed.rowCount ?? 0, artifacts: selection.artifacts,
    usageRecords: (usage.rowCount ?? 0) + (snapshots.rowCount ?? 0) }, retentionDays: AI_HISTORY_RETENTION_DAYS };
}

/** Local retention only: no model, queue dispatch or provider call. Construction is inert. */
export function createAiHistoryService(options: AiHistoryOptions) {
  const now = options.now ?? (() => new Date()); const previews = new Map<string, Preview>();
  const assertWorkspace = (workspaceId: string) => { if (!uuid.safeParse(workspaceId).success) throw new AiHistoryError('INVALID_INPUT'); };
  return {
    async preview(workspaceId: string) {
      assertWorkspace(workspaceId);
      for (const [id,preview] of previews) if (!preview.task && now().getTime()-preview.createdAt>=300_000) previews.delete(id);
      if ([...previews.values()].filter(preview=>preview.workspaceId===workspaceId).length>=20) throw new AiHistoryError('AI_TOO_MANY_PREVIEWS');
      const selection = await transaction(options.pool,workspaceId,client=>selectHistory(client,workspaceId,null));
      const id=randomUUID(),createdAt=now().getTime(); previews.set(id,{workspaceId,createdAt,selection});
      return { previewId:id,expiresAt:new Date(createdAt+300_000).toISOString(),
        removable:{runs:selection.runs.length,artifacts:selection.artifacts,usageRecords:selection.usage.length+selection.snapshots.length},
        preserved:selection.preserved,retentionDays:AI_HISTORY_RETENTION_DAYS };
    },
    async clear(workspaceId: string,input: unknown): Promise<Result> {
      assertWorkspace(workspaceId); const parsed=aiHistoryClearSchema.safeParse(input); if(!parsed.success)throw new AiHistoryError('INVALID_INPUT');
      const preview=previews.get(parsed.data.previewId);
      if(!preview || preview.workspaceId!==workspaceId || now().getTime()-preview.createdAt>=300_000)throw new AiHistoryError('AI_PREVIEW_EXPIRED');
      if(preview.result)return preview.result; if(preview.task)return preview.task;
      preview.task=transaction(options.pool,workspaceId,async client=>removeHistory(client,workspaceId,await selectHistory(client,workspaceId,null,preview.selection),now()));
      try{preview.result=await preview.task;return preview.result;}finally{delete preview.task;}
    },
    async pruneOnce() {
      const client=await options.pool.connect();let workspaces:string[];
      try {workspaces=(await client.query(`SELECT workspace_id FROM ai_runs UNION SELECT workspace_id FROM llm_usage UNION SELECT workspace_id FROM ai_usage_snapshots`)).rows.map(row=>row.workspace_id as string);}
      finally {client.release();}
      const cutoff=new Date(now().getTime()-AI_HISTORY_RETENTION_DAYS*86_400_000);const deleted={runs:0,artifacts:0,usageRecords:0};
      for(const workspaceId of workspaces){const result=await transaction(options.pool,workspaceId,async c=>removeHistory(c,workspaceId,await selectHistory(c,workspaceId,cutoff),now()));
        deleted.runs+=result.deleted.runs;deleted.artifacts+=result.deleted.artifacts;deleted.usageRecords+=result.deleted.usageRecords;}
      return {deleted,retentionDays:AI_HISTORY_RETENTION_DAYS};
    },
    async close(){await Promise.allSettled([...previews.values()].flatMap(preview=>preview.task?[preview.task]:[]));previews.clear();},
  };
}
export type AiHistoryService=ReturnType<typeof createAiHistoryService>;

/** Host explicitly starts local maintenance; it runs independently of an AI grant. */
export function createAiHistoryMaintenance(service: AiHistoryService,options:{pollMs?:number;onError?:()=>void}={}) {
  let active=false,timer:ReturnType<typeof setTimeout>|undefined,inflight:Promise<unknown>|undefined;
  const runOnce=async()=>{if(inflight)return;inflight=service.pruneOnce();try{await inflight;}finally{inflight=undefined;}};
  const tick=async()=>{try{await runOnce();}catch{try{options.onError?.();}catch{/* sanitized diagnostic only */}}
    finally{if(active){timer=setTimeout(()=>{void tick();},Math.max(60_000,options.pollMs??3_600_000));timer.unref();}}};
  return {runOnce,start(){if(active)return;active=true;void tick();},async stop(){active=false;if(timer)clearTimeout(timer);await inflight?.catch(()=>undefined);}};
}
