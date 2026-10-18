/**
 * "Delete all my data" (ADR 020, point 2). Rows go in one transaction, in an explicit order that respects the
 * foreign keys that do not cascade; files go afterwards, tracked by a deletion_jobs row so a failure is retried on
 * the next start. The workspace row stays, back to its defaults, with a higher session generation so every
 * existing session stops working.
 */
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number | null };
type PoolClient = { query(text: string, values?: unknown[]): Promise<QueryResult>; escapeIdentifier(value: string): string; release(): void };
/** The parts of a pg Pool this module uses (the API has no direct dependency on pg). */
export type Pool = { connect(): Promise<PoolClient>; query(text: string, values?: unknown[]): Promise<QueryResult> };

/**
 * Every table that holds a workspace's rows, children before parents. ai_runs reference each other, consents with
 * RESTRICT, and searches and policies without cascading; applications reference jobs and documents; document
 * versions reference profile versions and job snapshots. A table added to the schema must be added here, or to
 * CLEARED_CACHES or KEPT_TABLES: the proof test fails otherwise.
 */
export const DELETION_ORDER = [
  'ai_account_leases', 'ai_artifacts', 'llm_usage', 'ai_usage_snapshots', 'ai_document_reword_proposals', 'ai_runs', 'ai_run_tombstones', 'ai_daily_budgets',
  'ai_automation_policies', 'ai_consents', 'ai_connections',
  'assisted_attempts', 'application_events', 'application_document_revisions', 'application_documents', 'applications', 'document_versions', 'answer_versions', 'profile_facts', 'profile_versions',
  'search_run_results', 'search_run_sources', 'search_runs', 'saved_job_search_matches', 'search_job_reviews', 'job_match_feedback', 'job_filter_overrides', 'job_filter_preferences', 'saved_job_searches', 'search_preparation_budget',
  'job_report_batch_items', 'job_report_batches',
  'job_search_sources', 'job_identity_members', 'job_occurrences', 'job_snapshots', 'job_availability_events', 'jobs', 'search_profiles',
  'source_policy_reviews', 'boards', 'deletion_jobs',
] as const;

/** Tables without a workspace: public job feeds and query results, cleared completely. */
export const CLEARED_CACHES = ['search_query_cache', 'job_search_provider_cache'] as const;

/** Tables that keep rows, and why. */
export const KEPT_TABLES = {
  workspaces: 'the workspace row itself, back to its defaults with a higher session generation',
  search_provider_budget: 'provider, day and request count only: no personal data, and resetting it would exceed provider limits',
} as const;

export type DeletionResult = { jobId: string; generation: number };

/**
 * Deletes every row of the workspace and the search caches, resets the workspace row, and records a deletion job
 * whose files are still pending. Returns the job and the new session generation. The caller must have stopped all
 * background work first. The only rows left for the workspace are the workspace itself, this job (id, workspace id,
 * status, timestamps), and the empty profile revision every new installation starts with.
 */
export async function deleteWorkspaceRows(pool: Pool, workspaceId: string): Promise<DeletionResult> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('begin');
    const locked = await client.query('select id from workspaces where id = $1 for update', [workspaceId]);
    if (!locked.rowCount) throw new Error('WORKSPACE_NOT_FOUND');
    const { rows: [job] } = await client.query(`insert into deletion_jobs (workspace_id, status) values ($1, 'FILES_PENDING') returning id`, [workspaceId]);
    for (const table of DELETION_ORDER) {
      const name = client.escapeIdentifier(table);
      if (table === 'deletion_jobs') await client.query(`delete from ${name} where workspace_id = $1 and id <> $2`, [workspaceId, String(job!.id)]);
      // A released lease keeps no workspace; in a one-workspace installation it can only be this one's.
      else if (table === 'ai_account_leases') await client.query(`delete from ${name} where workspace_id = $1 or workspace_id is null`, [workspaceId]);
      else await client.query(`delete from ${name} where workspace_id = $1`, [workspaceId]);
    }
    for (const table of CLEARED_CACHES) await client.query(`delete from ${client.escapeIdentifier(table)}`);
    const { rows: [reset] } = await client.query(
      `update workspaces set name = default, timezone = default, discovery_enabled = default, created_at = default, updated_at = default,
         session_generation = session_generation + 1 where id = $1 returning session_generation`, [workspaceId]);
    await client.query(`insert into profile_versions (workspace_id, revision, profile) values ($1, 1, '{}'::jsonb)`, [workspaceId]);
    await client.query('commit');
    return { jobId: String(job!.id), generation: Number(reset!.session_generation) };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
/** Files and folders of the data folder that the documents folder must never contain or sit inside. */
export const CONTROL_ENTRIES = ['run', 'backups', 'logs', 'tmp', 'setup-token'] as const;

/**
 * Why FILES_LOCAL_PATH cannot be used safely next to DATA_LOCAL_PATH, or null. Emptying the documents folder must
 * never delete the launcher's run records or the sign-in token (ADR 020).
 */
export function filesPathProblem(filesRoot: string, dataRoot: string): string | null {
  const files = resolve(filesRoot); const data = resolve(dataRoot);
  if (files === data) return 'FILES_LOCAL_PATH must be a different folder from DATA_LOCAL_PATH.';
  for (const entry of CONTROL_ENTRIES) {
    const control = join(data, entry);
    if (inside(files, control) || inside(control, files)) return `FILES_LOCAL_PATH must not contain or be inside ${control}.`;
  }
  if (inside(data, files)) return 'FILES_LOCAL_PATH must not contain DATA_LOCAL_PATH.';
  return null;
}

/** Removes everything inside a folder, keeping the folder. A symbolic link inside is removed, never followed. */
async function emptyFolder(folder: string) {
  let entries: string[];
  try { entries = await readdir(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const entry of entries) await rm(join(folder, entry), { recursive: true, force: true });
}

/**
 * Deletes the files of a deleted workspace: documents, backups made from Settings, logs and temporary assistant
 * prompts, and writes a new single-use sign-in token. run/ stays: it holds only the launcher's process records,
 * which `pnpm run stop` needs. Returns the new token path. Throws on any failure; the job then stays pending.
 */
export async function deleteWorkspaceFiles(options: { filesRoot: string; dataRoot: string }) {
  const problem = filesPathProblem(options.filesRoot, options.dataRoot);
  if (problem) throw new Error(problem);
  for (const folder of [options.filesRoot, join(options.dataRoot, 'backups'), join(options.dataRoot, 'logs'), join(options.dataRoot, 'tmp')]) {
    try { if ((await lstat(folder)).isSymbolicLink()) throw new Error(`${folder} is a symbolic link; it is not emptied.`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await emptyFolder(folder);
  }
  await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
  const tokenPath = join(options.dataRoot, 'setup-token');
  await rm(tokenPath, { force: true });
  await writeFile(tokenPath, randomBytes(24).toString('base64url'), { mode: 0o600, flag: 'wx' });
  await chmod(tokenPath, 0o600);
  return tokenPath;
}

/** Marks a deletion job's files as done, or records that they failed (the job stays pending and is retried). */
export async function finishDeletionJob(pool: Pool, jobId: string, outcome: 'COMPLETED' | 'FILES_FAILED') {
  await pool.query(`update deletion_jobs set status = $2::varchar, completed_at = case when $2::varchar = 'COMPLETED' then now() else null end where id = $1`, [jobId, outcome]);
}

/** Deletion jobs whose files were not deleted yet: interrupted or failed. The API retries them when it starts. */
export async function pendingDeletionJobs(pool: Pool, workspaceId: string) {
  const { rows } = await pool.query(`select id from deletion_jobs where workspace_id = $1 and status in ('FILES_PENDING', 'FILES_FAILED') order by created_at`, [workspaceId]);
  return rows.map((row) => String(row.id));
}

/** Completes one deletion's file phase and leaves failures pending for the next API start. */
export async function completeDeletionFiles(pool: Pool, jobId: string, options: { filesRoot: string; dataRoot: string }, onFailure?: (error: unknown, jobId: string) => void) {
  try {
    await deleteWorkspaceFiles(options);
    await finishDeletionJob(pool, jobId, 'COMPLETED');
    return true;
  } catch (error) {
    onFailure?.(error, jobId);
    await finishDeletionJob(pool, jobId, 'FILES_FAILED').catch(() => undefined);
    return false;
  }
}

/** The startup path uses the same completion function as an in-request deletion. */
export async function retryPendingDeletionFiles(pool: Pool, workspaceId: string, options: { filesRoot: string; dataRoot: string }, onFailure?: (error: unknown, jobId: string) => void) {
  const results: Array<{ jobId: string; completed: boolean }> = [];
  for (const jobId of await pendingDeletionJobs(pool, workspaceId)) {
    results.push({ jobId, completed: await completeDeletionFiles(pool, jobId, options, onFailure) });
  }
  return results;
}
