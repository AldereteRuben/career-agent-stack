/** Inert opt-in automation coordinator. Importing this module never starts work or invokes an AI provider. */
import { createHash, randomUUID } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';
import { drizzle, type NodePgClient } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { AI_LIMITS, AI_SCHEMA_VERSION, aiSourceSnapshotSchema, aiSnapshotDataCategories, canonicalAiReuseKey, printedStatement, type AiSourceSnapshot } from '@career/domain';
import { profileLockKey, type Executor } from '../workspace-data.js';
import { CODEX_DEFAULT_MODEL } from './codex.js';
import { AI_PROMPT_VERSION, buildAiPrompt, hashAiInputContent } from './prompts.js';
import { AI_WORKER_CONFIG_VERSION } from './worker.js';
import { AiQueueError, lockAiQueue, type AiPgClient, type AiPgPool, type AiQueue } from './queue.js';
import { checkCurrentAiSnapshot, loadAiSourceRecords } from './source-reader.js';
import { AiSourceError, buildAiSourceSnapshot } from './source-snapshot.js';

const noticeVersion = 'career-sharing-v1';
const uuid = z.string().uuid();
const ids = z.array(uuid).min(1).max(200).refine(value => new Set(value).size === value.length);
const factIds = z.array(uuid).max(500).refine(value => new Set(value).size === value.length);
export const aiAutomationPreviewSchema = z.object({ sourceRunId: uuid, searchIds: ids, selectedFactIds: factIds,
  locale: z.enum(['es', 'en']), maximumDailyStarts: z.number().int().min(1).max(AI_LIMITS.automaticStartsPerUtcDay) }).strict();
export const aiAutomationActivateSchema = z.object({ previewId: uuid, idempotencyKey: uuid }).strict();
export const aiAutomationPauseSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
type Selection = z.infer<typeof aiAutomationPreviewSchema>;
type Search = { id: string; revision: number; role: string | null; company: string | null; location: string | null; enabled: boolean };
type Connection = { id: string; revision: number; account_fingerprint: string; masked_identity: string | null };
type Policy = { id: string; workspace_id: string; connection_id: string; consent_id: string; revision: number; active: boolean; paused: boolean;
  search_ids: string[]; selected_fact_ids: string[]; selection_snapshot: AiSourceSnapshot; locale: 'es' | 'en'; maximum_daily_starts: number;
  activated_at: Date; connection_revision: number; consent_revision: number; account_fingerprint: string; masked_identity: string | null };
type Preview = { id: string; workspaceId: string; input: Selection; connection: Connection; snapshot: AiSourceSnapshot; searches: Search[];
  createdAt: number; idempotencyKey?: string; result?: AiAutomationPolicyView; task?: Promise<AiAutomationPolicyView> };
export type AiAutomationPolicyView = { id: string; revision: number; active: boolean; paused: boolean; searchIds: string[]; selectedFactIds: string[];
  locale: 'es' | 'en'; maximumDailyStarts: number; activatedAt: string; maskedIdentity: string | null; queued: number; ready: number };
export type AiAutomationErrorCode = 'AI_UNAVAILABLE' | 'INVALID_INPUT' | 'AI_NOT_CONNECTED' | 'AI_MANUAL_ANALYSIS_REQUIRED' | 'AI_SEARCH_CHANGED'
  | 'AI_SOURCE_CHANGED' | 'AI_PREVIEW_EXPIRED' | 'AI_TOO_MANY_PREVIEWS' | 'AI_IDEMPOTENCY_CONFLICT' | 'AI_POLICY_CHANGED' | 'AI_POLICY_NOT_FOUND';
export class AiAutomationError extends Error {
  constructor(readonly code: AiAutomationErrorCode) { super(code); this.name = 'AiAutomationError'; }
}
export type AiAutomationOptions = { pool: AiPgPool; queue: AiQueue; enabled?: boolean | (() => boolean); cancelRun?: (id: string) => unknown;
  now?: () => Date; onEvent?: (event: 'AUTOMATION_UNAVAILABLE' | 'AUTOMATION_PAUSED') => void };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const executor = (client: AiPgClient): Executor => drizzle(client as unknown as NodePgClient);
const policyView = (row: Policy & { queued?: number; ready?: number }): AiAutomationPolicyView => ({ id: row.id, revision: row.revision,
  active: row.active, paused: row.paused, searchIds: row.search_ids, selectedFactIds: row.selected_fact_ids, locale: row.locale,
  maximumDailyStarts: row.maximum_daily_starts, activatedAt: row.activated_at.toISOString(), maskedIdentity: row.masked_identity ?? null,
  queued: Number(row.queued ?? 0), ready: Number(row.ready ?? 0) });

async function transaction<T>(pool: AiPgPool, work: (client: AiPgClient) => Promise<T>, mutate = false): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); if (mutate) await lockAiQueue(client); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
async function lockProfile(client: AiPgClient, workspaceId: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`job-identity:${workspaceId}`]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [profileLockKey(workspaceId)]);
}
async function activeConnection(client: AiPgClient, workspaceId: string): Promise<Connection> {
  const row = (await client.query(`SELECT id,revision,account_fingerprint,masked_identity FROM ai_connections
    WHERE workspace_id=$1 AND provider='codex' AND active AND state='CONNECTED'`, [workspaceId])).rows[0] as Connection | undefined;
  if (!row) throw new AiAutomationError('AI_NOT_CONNECTED'); return row;
}
async function selectedSearches(client: AiPgClient, workspaceId: string, selected: string[]): Promise<Search[]> {
  const rows = (await client.query(`SELECT id,revision,role,company,location,enabled FROM saved_job_searches
    WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND matcher_version=2 AND enabled ORDER BY created_at,id`, [workspaceId, selected])).rows as Search[];
  if (rows.length !== selected.length) throw new AiAutomationError('AI_SEARCH_CHANGED'); return rows;
}
async function manualJob(client: AiPgClient, workspaceId: string, sourceRunId: string): Promise<string> {
  const row = (await client.query(`SELECT snapshot FROM ai_runs WHERE workspace_id=$1 AND id=$2 AND status='SUCCEEDED'
    AND operation='JOB_ANALYSIS' AND origin='MANUAL' AND EXISTS(SELECT 1 FROM ai_artifacts a WHERE a.workspace_id=$1 AND a.run_id=ai_runs.id)`, [workspaceId, sourceRunId])).rows[0];
  const snapshot = aiSourceSnapshotSchema.safeParse(row?.snapshot);
  if (!snapshot.success || snapshot.data.workspaceId !== workspaceId || !snapshot.data.job) throw new AiAutomationError('AI_MANUAL_ANALYSIS_REQUIRED');
  return snapshot.data.job.jobId;
}
async function newSnapshot(client: AiPgClient, workspaceId: string, jobId: string, selectedFactIds: string[], locale: 'es' | 'en') {
  const request = { operation: 'JOB_ANALYSIS' as const, jobId, selectedFactIds, locale };
  return buildAiSourceSnapshot(workspaceId, request, await loadAiSourceRecords(executor(client), workspaceId, request));
}
/** Caller holds the queue lock: cancellation and reservation release are one durable mutation. */
async function cancelPolicyRuns(client: AiPgClient, workspaceId: string, policyId: string, now: Date): Promise<string[]> {
  const rows = (await client.query(`UPDATE ai_runs SET status=CASE WHEN status='QUEUED' THEN 'CANCELLED' ELSE 'CANCEL_REQUESTED' END,
    completed_at=CASE WHEN status='QUEUED' THEN $3 ELSE completed_at END,error=jsonb_build_object('code','CONSENT_REVOKED','dispatched',CASE WHEN status='QUEUED' THEN 'NO' ELSE 'UNKNOWN' END)
    WHERE workspace_id=$1 AND automation_policy_id=$2 AND status IN ('QUEUED','RUNNING') RETURNING id,status,reserved_day`, [workspaceId, policyId, now])).rows;
  for (const row of rows) if (row.status === 'CANCELLED') await client.query(`UPDATE ai_daily_budgets SET automatic_reserved=greatest(0,automatic_reserved-1),updated_at=$3 WHERE workspace_id=$1 AND control_day=$2`, [workspaceId, row.reserved_day, now]);
  return rows.map(row => row.id as string);
}

// Read current published results, not old criteria. Another search cannot turn an old canonical offer into a new task.
const candidatesSql = `WITH selected AS MATERIALIZED (
  SELECT s.* FROM saved_job_searches s WHERE s.workspace_id=$1 AND s.id=ANY($2::uuid[]) AND s.enabled AND s.matcher_version=2
), latest AS MATERIALIZED (
  SELECT s.id AS search_id,x.id AS run_id FROM selected s JOIN LATERAL (
    SELECT r.id FROM search_runs r WHERE r.workspace_id=s.workspace_id AND r.search_id=s.id
    AND r.criteria @> jsonb_build_object('role',s.role,'company',s.company,'location',s.location,'workMode',s.work_mode,'includeRelated',s.include_related,'matcherVersion',s.matcher_version)
    AND r.criteria->'providerIds'=s.provider_ids AND (r.status='SUCCEEDED' OR EXISTS(SELECT 1 FROM search_run_results rr WHERE rr.run_id=r.id))
    ORDER BY r.created_at DESC,r.id DESC LIMIT 1
  ) x ON true
), matches AS MATERIALIZED (
  SELECT j.id AS job_id,l.search_id,rr.score,rr.posted_at,m.matched_at,coalesce(im.identity_key,j.id::text) AS identity
  FROM latest l JOIN search_run_results rr ON rr.workspace_id=$1 AND rr.run_id=l.run_id AND rr.search_id=l.search_id
  JOIN jobs j ON j.workspace_id=rr.workspace_id AND j.id=rr.job_id
  JOIN saved_job_search_matches m ON m.workspace_id=j.workspace_id AND m.search_id=l.search_id AND m.job_id=j.id
  LEFT JOIN job_identity_members im ON im.workspace_id=j.workspace_id AND im.job_id=j.id
  WHERE j.availability='OPEN' AND j.shortlist_decision NOT IN ('ARCHIVED','SKIPPED') AND m.matched_at>$3
    AND EXISTS(SELECT 1 FROM job_snapshots snap WHERE snap.workspace_id=j.workspace_id AND snap.job_id=j.id AND length(trim(snap.description_text))>0)
    AND NOT EXISTS(SELECT 1 FROM job_identity_members other JOIN jobs old ON old.workspace_id=other.workspace_id AND old.id=other.job_id
      WHERE other.workspace_id=j.workspace_id AND other.identity_key=im.identity_key AND (old.availability<>'OPEN' OR old.shortlist_decision IN ('ARCHIVED','SKIPPED')))
    AND NOT EXISTS(SELECT 1 FROM saved_job_search_matches old LEFT JOIN job_identity_members oi ON oi.workspace_id=old.workspace_id AND oi.job_id=old.job_id
      WHERE old.workspace_id=j.workspace_id AND (old.job_id=j.id OR oi.identity_key=im.identity_key) AND old.matched_at<=$3)
    AND NOT EXISTS(SELECT 1 FROM ai_runs ar LEFT JOIN job_identity_members ai ON ai.workspace_id=ar.workspace_id AND ai.job_id::text=ar.snapshot->'job'->>'jobId'
      WHERE ar.workspace_id=j.workspace_id AND ar.operation='JOB_ANALYSIS' AND (ar.snapshot->'job'->>'jobId'=j.id::text OR ai.identity_key=im.identity_key))
    AND NOT EXISTS(SELECT 1 FROM ai_run_tombstones deleted LEFT JOIN job_identity_members di ON di.workspace_id=deleted.workspace_id AND di.job_id=deleted.job_id
      WHERE deleted.workspace_id=j.workspace_id AND (deleted.job_id=j.id OR deleted.canonical_identity=im.identity_key OR di.identity_key=im.identity_key))
), unique_jobs AS (
  SELECT DISTINCT ON(identity) * FROM matches ORDER BY identity,score DESC,posted_at DESC NULLS LAST,matched_at,search_id,job_id
) SELECT * FROM unique_jobs ORDER BY score DESC,posted_at DESC NULLS LAST,identity LIMIT 100`;

export function createAiAutomationService(options: AiAutomationOptions) {
  const now = options.now ?? (() => new Date());
  const enabled = () => typeof options.enabled === 'function' ? options.enabled() : options.enabled === true;
  const previews = new Map<string, Preview>();
  const notify = (event: 'AUTOMATION_UNAVAILABLE' | 'AUTOMATION_PAUSED') => { try { options.onEvent?.(event); } catch { /* stable diagnostics only */ } };
  const ensureEnabled = () => { if (!enabled()) throw new AiAutomationError('AI_UNAVAILABLE'); };
  const ensureWorkspace = (workspaceId: string) => { if (!uuid.safeParse(workspaceId).success) throw new AiAutomationError('INVALID_INPUT'); };
  const abortLocal = (ids: string[]) => { for (const id of ids) { try { options.cancelRun?.(id); } catch { notify('AUTOMATION_UNAVAILABLE'); } } };
  const getPolicies = (client: AiPgClient, workspaceId: string) => client.query(`SELECT p.*,c.masked_identity,
    (SELECT count(*)::int FROM ai_runs r WHERE r.workspace_id=p.workspace_id AND r.automation_policy_id=p.id AND r.status IN ('QUEUED','RUNNING','CANCEL_REQUESTED')) AS queued,
    (SELECT count(*)::int FROM ai_runs r JOIN ai_artifacts a ON a.workspace_id=r.workspace_id AND a.run_id=r.id WHERE r.workspace_id=p.workspace_id AND r.automation_policy_id=p.id AND r.status='SUCCEEDED' AND a.state<>'DISMISSED') AS ready
    FROM ai_automation_policies p JOIN ai_connections c ON c.workspace_id=p.workspace_id AND c.id=p.connection_id
    WHERE p.workspace_id=$1 ORDER BY p.updated_at DESC,p.id LIMIT 20`, [workspaceId]);
  const pause = async (workspaceId: string, policyId: string, expectedRevision: number) => {
    ensureWorkspace(workspaceId);
    if (!uuid.safeParse(policyId).success || !Number.isSafeInteger(expectedRevision) || expectedRevision<1) throw new AiAutomationError('INVALID_INPUT');
    const result = await transaction(options.pool, async client => {
      const row = (await client.query(`SELECT p.*,c.masked_identity FROM ai_automation_policies p JOIN ai_connections c ON c.workspace_id=p.workspace_id AND c.id=p.connection_id WHERE p.workspace_id=$1 AND p.id=$2 FOR UPDATE OF p`, [workspaceId, policyId])).rows[0] as Policy | undefined;
      if (!row) throw new AiAutomationError('AI_POLICY_NOT_FOUND');
      if (row.revision !== expectedRevision) throw new AiAutomationError('AI_POLICY_CHANGED');
      if (!row.paused) {
        await client.query(`UPDATE ai_automation_policies SET paused=true,revision=revision+1,updated_at=$3 WHERE workspace_id=$1 AND id=$2`, [workspaceId, policyId, now()]);
        await client.query(`UPDATE ai_consents SET revoked_at=coalesce(revoked_at,$3) WHERE workspace_id=$1 AND id=$2`, [workspaceId,row.consent_id,now()]);
        row.paused=true; row.revision++;
      }
      const cancelled = await cancelPolicyRuns(client,workspaceId,policyId,now());
      return { policy: policyView(row), cancelled };
    }, true);
    for (const [id, preview] of previews) if (preview.workspaceId === workspaceId && !preview.task) previews.delete(id);
    abortLocal(result.cancelled); return result.policy;
  };
  return {
    isEnabled: enabled,
    async list(workspaceId: string, locale: 'es' | 'en' = 'es') {
      ensureWorkspace(workspaceId);
      return transaction(options.pool, async client => {
        const policies=(await getPolicies(client,workspaceId)).rows.map(row => policyView(row as Policy));
        const searches=(await client.query(`SELECT id,revision,role,company,location,enabled FROM saved_job_searches WHERE workspace_id=$1 AND matcher_version=2 ORDER BY created_at,id`,[workspaceId])).rows as Search[];
        const rows=(await client.query(`SELECT f.id,f.kind,f.statement,f.details FROM profile_facts f WHERE f.workspace_id=$1 AND f.approval_status='USER_APPROVED'
          AND f.profile_version_id=(SELECT id FROM profile_versions WHERE workspace_id=$1 ORDER BY revision DESC LIMIT 1) ORDER BY f.created_at,f.id`,[workspaceId])).rows;
        const facts=rows.map(row=>({factId:row.id as string,kind:row.kind as string,text:printedStatement({kind:row.kind,statement:row.statement,details:row.details},locale)}));
        return { enabled:enabled(), policies, searches, facts, limits:{maximumDailyStarts:AI_LIMITS.automaticStartsPerUtcDay,maximumPerPass:AI_LIMITS.automaticReservationsPerPass} };
      });
    },
    async preview(workspaceId: string, input: unknown) {
      ensureEnabled(); ensureWorkspace(workspaceId);
      const parsed=aiAutomationPreviewSchema.safeParse(input); if(!parsed.success) throw new AiAutomationError('INVALID_INPUT');
      for(const [id,preview] of previews) if(now().getTime()-preview.createdAt>=300_000 && !preview.task) previews.delete(id);
      if([...previews.values()].filter(preview=>preview.workspaceId===workspaceId).length>=20) throw new AiAutomationError('AI_TOO_MANY_PREVIEWS');
      const preview=await transaction(options.pool,async client=>{
        await lockProfile(client,workspaceId);
        const connection=await activeConnection(client,workspaceId);
        const searches=await selectedSearches(client,workspaceId,parsed.data.searchIds);
        const jobId=await manualJob(client,workspaceId,parsed.data.sourceRunId);
        const snapshot=await newSnapshot(client,workspaceId,jobId,parsed.data.selectedFactIds,parsed.data.locale);
        buildAiPrompt(snapshot,{workspaceId,operation:'JOB_ANALYSIS',locale:parsed.data.locale});
        return {id:randomUUID(),workspaceId,input:parsed.data,connection,snapshot,searches,createdAt:now().getTime()} satisfies Preview;
      });
      previews.set(preview.id,preview);
      return { previewId:preview.id,expiresAt:new Date(preview.createdAt+300_000).toISOString(),searches:preview.searches,
        sources:{facts:preview.snapshot.facts.map(({factId,kind,text})=>({factId,kind,text}))}, categories:aiSnapshotDataCategories(preview.snapshot),
        locale:preview.input.locale,maximumDailyStarts:preview.input.maximumDailyStarts,connection:{maskedIdentity:preview.connection.masked_identity},newOffersOnly:true };
    },
    async activate(workspaceId: string,input:unknown) {
      ensureEnabled(); ensureWorkspace(workspaceId);
      const parsed=aiAutomationActivateSchema.safeParse(input); if(!parsed.success) throw new AiAutomationError('INVALID_INPUT');
      const preview=previews.get(parsed.data.previewId);
      if(!preview || preview.workspaceId!==workspaceId || now().getTime()-preview.createdAt>=300_000) throw new AiAutomationError('AI_PREVIEW_EXPIRED');
      if(preview.idempotencyKey && preview.idempotencyKey!==parsed.data.idempotencyKey) throw new AiAutomationError('AI_IDEMPOTENCY_CONFLICT');
      if(preview.result) {
        return transaction(options.pool,async client=>{
          const current=(await getPolicies(client,workspaceId)).rows.find(row=>row.id===preview.result!.id);
          if(!current)throw new AiAutomationError('AI_POLICY_NOT_FOUND');
          return policyView(current as Policy);
        });
      }
      if(preview.task) return preview.task;
      preview.idempotencyKey=parsed.data.idempotencyKey;
      preview.task=transaction(options.pool,async client=>{
        await lockProfile(client,workspaceId);
        const connection=await activeConnection(client,workspaceId);
        if(connection.id!==preview.connection.id || connection.revision!==preview.connection.revision || connection.account_fingerprint!==preview.connection.account_fingerprint) throw new AiAutomationError('AI_NOT_CONNECTED');
        const currentSearches=await selectedSearches(client,workspaceId,preview.input.searchIds);
        if(digest(currentSearches)!==digest(preview.searches))throw new AiAutomationError('AI_SEARCH_CHANGED');
        await manualJob(client,workspaceId,preview.input.sourceRunId);
        if(!(await checkCurrentAiSnapshot(executor(client),workspaceId,preview.snapshot)).ok) throw new AiAutomationError('AI_SOURCE_CHANGED');
        const cancelled:string[]=[];
        const previous=(await client.query(`SELECT id,consent_id FROM ai_automation_policies WHERE workspace_id=$1 AND active FOR UPDATE`,[workspaceId])).rows;
        for(const policy of previous){
          await client.query(`UPDATE ai_automation_policies SET active=false,paused=true,revision=revision+1,updated_at=$3 WHERE workspace_id=$1 AND id=$2`,[workspaceId,policy.id,now()]);
          await client.query(`UPDATE ai_consents SET revoked_at=coalesce(revoked_at,$3) WHERE workspace_id=$1 AND id=$2`,[workspaceId,policy.consent_id,now()]);
          cancelled.push(...await cancelPolicyRuns(client,workspaceId,policy.id,now()));
        }
        const consentId=randomUUID(); const activatedAt=now();
        const revision=Number((await client.query(`SELECT coalesce(max(revision),0)+1 AS revision FROM ai_consents WHERE workspace_id=$1 AND connection_id=$2 AND operation='JOB_ANALYSIS'`,[workspaceId,connection.id])).rows[0]!.revision);
        await client.query(`INSERT INTO ai_consents(id,workspace_id,connection_id,provider,account_fingerprint,connection_revision,revision,operation,data_categories,search_ids,notice_version,granted_at,remembered)
          VALUES($1,$2,$3,'codex',$4,$5,$6,'JOB_ANALYSIS',$7::jsonb,$8::jsonb,$9,$10,true)`,[consentId,workspaceId,connection.id,connection.account_fingerprint,connection.revision,revision,JSON.stringify(aiSnapshotDataCategories(preview.snapshot)),JSON.stringify(preview.input.searchIds),noticeVersion,activatedAt]);
        const row=(await client.query(`INSERT INTO ai_automation_policies(id,workspace_id,connection_id,consent_id,search_ids,active,paused,maximum_daily_starts,activated_at,selected_fact_ids,selection_snapshot,locale)
          VALUES($1,$2,$3,$4,$5::jsonb,true,false,$6,$7,$8::jsonb,$9::jsonb,$10) RETURNING *`,[preview.id,workspaceId,connection.id,consentId,JSON.stringify(preview.input.searchIds),preview.input.maximumDailyStarts,activatedAt,JSON.stringify(preview.input.selectedFactIds),JSON.stringify(preview.snapshot),preview.input.locale])).rows[0] as Policy;
        return {policy:policyView({...row,masked_identity:connection.masked_identity}),cancelled};
      },true).then(({policy,cancelled})=>{abortLocal(cancelled);preview.result=policy;return policy;});
      try{return await preview.task;}finally{delete preview.task;}
    },
    pause,
    async scanOnce() {
      if(!enabled()) return {enqueued:0};
      const policies=await transaction(options.pool,async client=>(await client.query(`SELECT p.*,c.revision AS connection_revision,c.account_fingerprint,c.masked_identity,a.revision AS consent_revision
        FROM ai_automation_policies p JOIN ai_connections c ON c.workspace_id=p.workspace_id AND c.id=p.connection_id
        JOIN ai_consents a ON a.workspace_id=p.workspace_id AND a.id=p.consent_id
        WHERE p.active AND NOT p.paused AND c.active AND c.state='CONNECTED' AND a.revoked_at IS NULL ORDER BY p.updated_at,p.id`)).rows as Policy[]);
      let enqueued=0; const passId=randomUUID(); const counts=new Map<string,number>();
      for(const policy of policies){
        if(!enabled()) break;
        const candidates=await transaction(options.pool,async client=>(await client.query(candidatesSql,[policy.workspace_id,policy.search_ids,policy.activated_at])).rows);
        for(const candidate of candidates){
          if(!enabled() || (counts.get(policy.workspace_id)??0)>=AI_LIMITS.automaticReservationsPerPass) break;
          try{
            const snapshot=await transaction(options.pool,async client=>{
              await lockProfile(client,policy.workspace_id);
              const current=await newSnapshot(client,policy.workspace_id,candidate.job_id,[],policy.locale);
              const parsed=aiSourceSnapshotSchema.safeParse(policy.selection_snapshot);
              if(!parsed.success || parsed.data.workspaceId!==policy.workspace_id || parsed.data.operation!=='JOB_ANALYSIS'
                || parsed.data.locale!==policy.locale || parsed.data.snapshotHash!==hashAiInputContent(parsed.data)
                || digest(parsed.data.facts.map(fact=>fact.factId).sort())!==digest([...policy.selected_fact_ids].sort()))throw new AiAutomationError('AI_SOURCE_CHANGED');
              const selected=parsed.data;
              const scope:AiSourceSnapshot={...current,facts:selected.facts,profileRevision:selected.profileRevision};
              scope.snapshotHash=hashAiInputContent(scope);
              const valid=await checkCurrentAiSnapshot(executor(client),policy.workspace_id,scope);
              if(!valid.ok) throw new AiAutomationError('AI_SOURCE_CHANGED');
              return newSnapshot(client,policy.workspace_id,candidate.job_id,valid.resolvedFacts.map(fact=>fact.currentFactId),policy.locale);
            });
            const prompt=buildAiPrompt(snapshot,{workspaceId:policy.workspace_id,operation:'JOB_ANALYSIS',locale:policy.locale});
            const contentIdentity=createHash('sha256').update(canonicalAiReuseKey({workspaceId:policy.workspace_id,operation:'JOB_ANALYSIS',connectionId:policy.connection_id,accountFingerprint:policy.account_fingerprint,locale:policy.locale,
              inputContentHash:prompt.inputContentHash,jobIdentity:snapshot.job!.canonicalIdentity,jobContentHash:snapshot.job!.contentHash,evidenceHashes:snapshot.facts.map(fact=>fact.contentHash),questionHash:null,promptVersion:AI_PROMPT_VERSION,schemaVersion:AI_SCHEMA_VERSION,configVersion:AI_WORKER_CONFIG_VERSION})).digest('hex');
            // Stable canonical scheduling identity never retries an uncertain task or makes a copied source a new task.
            const idempotencyKey=`automatic:${digest([policy.workspace_id,candidate.identity,policy.locale,snapshot.job!.contentHash,snapshot.facts.map(fact=>fact.contentHash).sort(),policy.account_fingerprint,AI_WORKER_CONFIG_VERSION])}`;
            await options.queue.enqueue({workspaceId:policy.workspace_id,connectionId:policy.connection_id,consentId:policy.consent_id,connectionRevision:policy.connection_revision,consentRevision:policy.consent_revision,
              provider:'codex',accountFingerprint:policy.account_fingerprint,operation:'JOB_ANALYSIS',origin:'AUTOMATIC',idempotencyKey,contentIdentity,accountLockKey:policy.account_fingerprint,snapshot,snapshotHash:snapshot.snapshotHash,
              inputVersions:{schemaVersion:AI_SCHEMA_VERSION,promptVersion:AI_PROMPT_VERSION,configVersion:AI_WORKER_CONFIG_VERSION,model:CODEX_DEFAULT_MODEL,connectionRevision:policy.connection_revision,consentRevision:policy.consent_revision},
              searchId:candidate.search_id,automationPolicyId:policy.id,automationPolicyRevision:policy.revision,reservationPassId:passId,now:now()});
            counts.set(policy.workspace_id,(counts.get(policy.workspace_id)??0)+1);enqueued++;
          }catch(error){
            if(error instanceof AiQueueError && ['PASS_LIMIT','DAILY_LIMIT','QUEUE_FULL','MANUAL_QUEUE_FULL'].includes(error.code)) break;
            // A search or offer can become ineligible after the candidate read. That must not pause other searches.
            if(error instanceof AiQueueError && ['IDEMPOTENCY_CONFLICT','EQUIVALENT_ACTIVE','CONSENT_INVALID'].includes(error.code)) continue;
            // A malformed/oversized public posting is skipped; changes to the selected private evidence pause the policy.
            if(error instanceof AiSourceError){notify('AUTOMATION_UNAVAILABLE');continue;}
            if(error instanceof AiAutomationError){
              try{await pause(policy.workspace_id,policy.id,policy.revision);notify('AUTOMATION_PAUSED');}catch{notify('AUTOMATION_UNAVAILABLE');}break;
            }
            notify('AUTOMATION_UNAVAILABLE');break;
          }
        }
      }
      return {enqueued};
    },
    async close(){await Promise.allSettled([...previews.values()].flatMap(preview=>preview.task?[preview.task]:[]));previews.clear();},
  };
}
export type AiAutomationService=ReturnType<typeof createAiAutomationService>;

/** Polling only reserves work; the separately supervised worker owns model execution. Disabled by default. */
export function createAiAutomationScanner(service:AiAutomationService,options:{enabled?:boolean|(()=>boolean);pollMs?:number;onEvent?:(event:'AUTOMATION_UNAVAILABLE')=>void}={}){
  const pollMs=options.pollMs??30_000;if(!Number.isSafeInteger(pollMs)||pollMs<1_000||pollMs>300_000)throw new Error('AI_AUTOMATION_INVALID_CONFIG');
  let started=false;let timer:ReturnType<typeof setTimeout>|null=null;let pending:Promise<{enqueued:number}>|null=null;
  const enabled=()=>typeof options.enabled==='function'?options.enabled():options.enabled===true;
  const runOnce=()=>{if(pending||!enabled())return Promise.resolve({enqueued:0});pending=service.scanOnce().catch(()=>{try{options.onEvent?.('AUTOMATION_UNAVAILABLE');}catch{/* diagnostics only */}return {enqueued:0};}).finally(()=>{pending=null;});return pending;};
  const schedule=()=>{if(!started||timer)return;timer=setTimeout(()=>{timer=null;void runOnce().finally(schedule);},pollMs);timer.unref();};
  return {runOnce,start(){if(started||!enabled())return;started=true;void runOnce().finally(schedule);},async stop(){started=false;if(timer)clearTimeout(timer);timer=null;await pending;}};
}
