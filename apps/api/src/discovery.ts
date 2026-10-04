import { lockJobIdentity, findJobIdentity, bindJobIdentity } from './job-identity.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@career/db/schema';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { boards, db, jobs, jobOccurrences, jobSnapshots, pool, workspaces } from '@career/db';
import { readBoardWithReport, SourceHttpError } from './sources.js';
import { applyMatch, loadMatchingContext, occurrencesForBoard } from './workspace-data.js';
import { isNewJob } from './review-state.js';

export const INTERVAL_MS = 6 * 60 * 60 * 1000;
const jitter = () => Math.floor(Math.random() * 5 * 60 * 1000);
export class DiscoveryError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const approved = (now: Date) => and(eq(boards.enabled, true), eq(boards.associationStatus, 'VERIFIED'), eq(boards.permissionStatus, 'APPROVED_FOR_SCOPE'), or(isNull(boards.reviewDueAt), gt(boards.reviewDueAt, now)));
export function nextAttempt(now: number, failures: number, retryAfter = 0): Date {
  return new Date(Math.max(now + Math.min(48 * 60 * 60 * 1000, INTERVAL_MS * 2 ** Math.min(Math.max(0, failures - 1), 3)), retryAfter));
}
/** Manual requests and the worker serialize per workspace, including cross-board deduplication.
 * Re-read cooldown and permission only after taking the lock. */
export async function refreshBoard(id: string, boardId: string, automatic = false, readSource = readBoardWithReport) {
  const connection = await pool.connect();
  const executor = drizzle(connection, { schema });
  let locked = false;
  const lockId = `discovery:${id}`;
  try {
    locked = (await connection.query<{ acquired: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired', [lockId])).rows[0]?.acquired ?? false;
    if (!locked) throw new DiscoveryError('BOARD_REFRESH_ALREADY_RUNNING', 409);
    const board = (await executor.select().from(boards).where(and(eq(boards.id, boardId), eq(boards.workspaceId, id))).limit(1))[0];
    if (!board) throw new DiscoveryError('NOT_FOUND', 404);
    const now = new Date();
    if (!board.enabled || board.associationStatus !== 'VERIFIED' || board.permissionStatus !== 'APPROVED_FOR_SCOPE' || (board.reviewDueAt && board.reviewDueAt <= now)) throw new DiscoveryError('BOARD_NOT_APPROVED_FOR_DISCOVERY', 403);
    if (automatic && !(await executor.select().from(workspaces).where(and(eq(workspaces.id, id), eq(workspaces.discoveryEnabled, true))).limit(1)).length) return null;
    const due = Math.max(board.nextRunAt?.getTime() ?? 0, (board.lastSuccessfulRefreshAt?.getTime() ?? 0) + (board.lastSuccessfulRefreshAt ? INTERVAL_MS : 0));
    if (due > now.getTime()) throw new DiscoveryError('BOARD_REFRESH_COOLDOWN', 429);
    // Reserve the interval before networking: a crash cannot immediately repeat the same remote request.
    await executor.update(boards).set({ lastRunAt: now, lastRunStatus: 'RUNNING', lastError: null, nextRunAt: new Date(now.getTime() + INTERVAL_MS) }).where(eq(boards.id, boardId));
    try {
      const sourceReport = await readSource(board);
      const discovered = sourceReport.jobs;
      const result = await executor.transaction(async (tx) => {
        await lockJobIdentity(tx,id);
        // Context and existing identities are loaded once per refresh instead of once per discovered job.
        const context = await loadMatchingContext(tx, id);
        const existingByExternalId = await occurrencesForBoard(tx, id, board);
        const candidates = await tx.select().from(jobs).where(and(eq(jobs.workspaceId, id), sql`lower(${jobs.company}) = lower(${board.companyName})`));
        const candidateByKey = new Map<string, { id: string }>(candidates.map((job) => [`${job.title}\n${job.canonicalUrl}`, job]));
        const knownJobIds = [...new Set([...existingByExternalId.values()].map((occurrence) => occurrence.jobId))];
        const latestHashes = knownJobIds.length ? await tx.selectDistinctOn([jobSnapshots.jobId], { jobId: jobSnapshots.jobId, snapshotHash: jobSnapshots.snapshotHash }).from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, id), inArray(jobSnapshots.jobId, knownJobIds))).orderBy(jobSnapshots.jobId, desc(jobSnapshots.fetchedAt)) : [];
        const hashByJob = new Map(latestHashes.map((row) => [row.jobId, row.snapshotHash]));
        const now = new Date();
        let added = 0; let updated = 0;
        for (const item of discovered) {
          if (!item.externalId || !item.title || !item.jobUrl) continue;
          const existing = existingByExternalId.get(item.externalId);
          let jobId = existing?.jobId ?? await findJobIdentity(tx,id,item.jobUrl) ?? candidateByKey.get(`${item.title}\n${item.jobUrl}`)?.id;
          const snapshotHash = createHash('sha256').update(`${item.title}\n${item.description ?? ''}`).digest('hex');
          const scored = applyMatch({ discoveredAt: null, seenAt: null, id: jobId ?? '', workspaceId: id, company: board.companyName, title: item.title, location: item.location, canonicalUrl: item.jobUrl, availability: 'OPEN', shortlistDecision: 'UNREVIEWED', fitScore: null, evidenceCoverage: null, eligibility: 'NEEDS_REVIEW', reasons: [], createdAt: now, updatedAt: now }, item.description, context);
          const scores = { fitScore: scored.fitScore, evidenceCoverage: scored.evidenceCoverage, eligibility: scored.eligibility, reasons: scored.reasons };
          if (!jobId) {
            jobId = (await tx.insert(jobs).values({ workspaceId: id, discoveredAt: now, company: board.companyName, title: item.title, location: item.location, canonicalUrl: item.jobUrl, availability: 'OPEN', ...scores }).returning({ id: jobs.id }))[0]!.id; added++;
            candidateByKey.set(`${item.title}\n${item.jobUrl}`, { id: jobId });
          } else {
            await tx.update(jobs).set({ title: item.title, location: item.location, availability: 'OPEN', ...scores, updatedAt: now }).where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, id))); updated++;
          }
          await bindJobIdentity(tx,id,jobId,item.jobUrl);
          let occurrenceId = existing?.id;
          if (existing) {
            await tx.update(jobOccurrences).set({ lastSeenAt: now, sourceUpdatedAt: item.updatedAt ? new Date(item.updatedAt) : null, lastSuccessfulRefreshAt: now, sourcePayload: item.raw, jobUrl: item.jobUrl, applyUrl: item.applyUrl }).where(eq(jobOccurrences.id, existing.id));
          } else {
            occurrenceId = (await tx.insert(jobOccurrences).values({ workspaceId: id, jobId, provider: board.provider, region: board.region, tenant: board.tenant, externalJobId: item.externalId, jobUrl: item.jobUrl, applyUrl: item.applyUrl, sourcePostedAt: item.postedAt ? new Date(item.postedAt) : null, sourceUpdatedAt: item.updatedAt ? new Date(item.updatedAt) : null, lastSuccessfulRefreshAt: now, sourcePayload: item.raw }).returning({ id: jobOccurrences.id }))[0]!.id;
          }
          // Store a new snapshot only when the posting text changed, so documents keep pointing at what was actually read.
          if (hashByJob.get(jobId) !== snapshotHash) {
            await tx.insert(jobSnapshots).values({ workspaceId: id, jobId, occurrenceId: occurrenceId ?? null, title: item.title, descriptionText: item.description, snapshotHash });
            hashByJob.set(jobId, snapshotHash);
          }
        }
        await tx.update(boards).set({ lastSuccessfulRefreshAt: now, lastRunStatus: sourceReport.skipped ? 'PARTIAL' : 'COMPLETE', lastNewCount: added, failureCount: 0, lastError: null, nextRunAt: new Date(now.getTime() + INTERVAL_MS + jitter()), updatedAt: now }).where(and(eq(boards.id, boardId), eq(boards.workspaceId, id)));
        return { added, updated, total: added + updated, coverage: sourceReport.skipped ? 'PARTIAL' : 'COMPLETE', skipped: sourceReport.skipped, fetchedAt: now.toISOString() };
      });
      return result;
    } catch (error) {
      const code = error instanceof Error && /^SOURCE_[A-Z0-9_]+$/.test(error.message) ? error.message : 'SOURCE_READ_FAILED';
      await executor.update(boards).set({ lastRunStatus: 'FAILED', lastNewCount: 0, lastError: code, failureCount: board.failureCount + 1, nextRunAt: nextAttempt(Date.now(), board.failureCount + 1, error instanceof SourceHttpError ? error.retryAfter : 0) }).where(eq(boards.id, boardId));
      throw new DiscoveryError('BOARD_REFRESH_FAILED', 502);
    }
  } finally {
    let destroy = false;
    try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockId]); }
    catch { destroy = true; } // A broken connection must never return to the pool with a session lock.
    connection.release(destroy);
  }
}

/** One board per tick bounds network concurrency and spreads catch-up across companies. No backlog replay. */
export async function runDiscoveryTick(readSource = readBoardWithReport) {
  const now = new Date();
  const candidates = await db.select({ boardId: boards.id, workspaceId: boards.workspaceId }).from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(and(eq(workspaces.discoveryEnabled, true), approved(now), or(isNull(boards.nextRunAt), sql`${boards.nextRunAt} <= ${now}`), or(isNull(boards.lastSuccessfulRefreshAt), sql`${boards.lastSuccessfulRefreshAt} <= ${new Date(now.getTime() - INTERVAL_MS)}`)))
    .orderBy(sql`${boards.nextRunAt} asc nulls first`, boards.id).limit(1);
  const candidate = candidates[0];
  if (!candidate) return;
  try { await refreshBoard(candidate.workspaceId, candidate.boardId, true, readSource); }
  catch (error) {
    if (error instanceof DiscoveryError && ['BOARD_REFRESH_ALREADY_RUNNING', 'BOARD_REFRESH_COOLDOWN', 'BOARD_NOT_APPROVED_FOR_DISCOVERY', 'BOARD_REFRESH_FAILED', 'NOT_FOUND'].includes(error.message)) return;
    throw error;
  }
}
export function startDiscoveryWorker(onError: (error: unknown) => void, readSource = readBoardWithReport) {
  let stopped = false; let timer: ReturnType<typeof setTimeout>; let current: Promise<void> = Promise.resolve();
  const tick = () => {
    current = runDiscoveryTick(readSource).catch(onError).finally(() => { if (!stopped) { timer = setTimeout(tick, 5_000); timer.unref(); } });
  };
  timer = setTimeout(tick, 1_000); timer.unref();
  return async () => { stopped = true; clearTimeout(timer); await current; };
}
export function registerDiscoveryRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string) {
  app.get('/api/v1/discovery', async (request) => {
    const id = workspace(request); const now = new Date();
    const [settings, rows, unread] = await Promise.all([
      db.select({ enabled: workspaces.discoveryEnabled }).from(workspaces).where(eq(workspaces.id, id)),
      db.select().from(boards).where(eq(boards.workspaceId, id)).orderBy(boards.companyName),
      db.select({ count: sql<number>`count(*)::int` }).from(jobs).where(and(eq(jobs.workspaceId, id), sql`${jobs.discoveredAt} is not null`, isNewJob(id))),
    ]);
    const enabled = settings[0]?.enabled ?? false;
    return { enabled, intervalHours: 6, unreadCount: unread[0]?.count ?? 0, boards: rows.map((board) => {
      const eligible = board.enabled && board.permissionStatus === 'APPROVED_FOR_SCOPE' && board.associationStatus === 'VERIFIED' && (!board.reviewDueAt || board.reviewDueAt > now);
      const next = Math.max(board.nextRunAt?.getTime() ?? 0, board.lastSuccessfulRefreshAt ? board.lastSuccessfulRefreshAt.getTime() + INTERVAL_MS : 0);
      return { id: board.id, companyName: board.companyName, eligible, lastRunAt: board.lastRunAt, lastRunStatus: board.lastRunStatus === 'RUNNING' && board.lastRunAt && now.getTime() - board.lastRunAt.getTime() > 300_000 ? 'INTERRUPTED' : board.lastRunStatus, lastNewCount: board.lastNewCount, lastError: board.lastError, nextRunAt: enabled && eligible ? new Date(Math.max(next, now.getTime())).toISOString() : null };
    }) };
  });
  app.put('/api/v1/discovery', async (request, reply) => {
    const body = request.body as { enabled?: unknown } | null;
    if (typeof body?.enabled !== 'boolean') return reply.code(400).send({ error: 'INVALID_INPUT' });
    const id = workspace(request);
    if (body.enabled && !(await db.select({ id: boards.id }).from(boards).where(and(eq(boards.workspaceId, id), approved(new Date()))).limit(1)).length) return reply.code(409).send({ error: 'DISCOVERY_NEEDS_COMPANY' });
    await db.update(workspaces).set({ discoveryEnabled: body.enabled, updatedAt: new Date() }).where(eq(workspaces.id, id));
    return { enabled: body.enabled };
  });
}
