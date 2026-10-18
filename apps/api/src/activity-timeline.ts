import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, eq, gte, inArray, isNotNull, lt, lte, ne, notInArray, sql } from 'drizzle-orm';
import { applications, applicationEvents, db, jobs } from '@career/db';
import { applicationFollowUpStatus, terminalRecruitmentStages } from '@career/domain';
import { compareTimelineItems, localToday, overdueFollowUpLimit, parseTimelineRange, parseTimelineTypes, resolveTimeZone, timelineBounds, timelineItemLimit, type Timeline, type TimelineItem, type TimelineType } from './activity-days.js';

/** Application events that change the application state. Preparation runs and free-form notes are not milestones. */
const statusEvents = ['APPLICATION_STATE_CHANGED', 'ASSIST_SUBMISSION_CONFIRMED', 'ASSIST_SUBMISSION_UNKNOWN', 'ASSIST_USER_RECONCILED'];
const stageEvents = ['RECRUITMENT_STAGE_CHANGED', 'RECRUITMENT_STAGE_CORRECTED', 'EMAIL_IMPORTED'];
const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();
/** Follow-ups only matter while the application is still open; closed ones are not pending. */
const openApplication = () => and(ne(applications.state, 'CANCELLED'), notInArray(applications.recruitmentStage, [...terminalRecruitmentStages]));
const followUpItem = (row: { id: string; role: string; company: string; followUpDate: string | null; nextStep: string | null }, today: string): TimelineItem => {
  const status = applicationFollowUpStatus(row.followUpDate, today, false);
  return { id: `FOLLOW_UP:${row.id}`, type: 'FOLLOW_UP', day: row.followUpDate!, at: null, application: { id: row.id, role: row.role, company: row.company }, nextStep: row.nextStep, ...(status === 'none' ? {} : { followUpStatus: status }) };
};

/** Every dated record of one workspace in the viewer's calendar range. All queries are scoped to `workspaceId`. */
export async function loadTimeline(workspaceId: string, options: { from: string; to: string; timeZone: string; types: TimelineType[]; now?: Date }): Promise<Timeline> {
  const { from, to, timeZone, types } = options;
  const today = localToday(options.now ?? new Date(), timeZone);
  const { start, end } = timelineBounds(from, to);
  const wanted = (type: TimelineType) => types.includes(type);
  const localDay = (column: typeof jobs.createdAt | typeof jobs.savedAt | typeof applications.createdAt | typeof applications.interviewAt | typeof applicationEvents.createdAt) => sql<string>`to_char(${column} AT TIME ZONE ${timeZone}, 'YYYY-MM-DD')`;
  const inRange = (column: typeof jobs.createdAt | typeof jobs.savedAt | typeof applications.createdAt | typeof applications.interviewAt | typeof applicationEvents.createdAt) => and(gte(column, start), lt(column, end), sql`${localDay(column)} between ${from} and ${to}`);
  const limit = timelineItemLimit + 1;
  const none = Promise.resolve([] as never[]);
  const application = { id: applications.id, role: applications.role, company: applications.company };
  const eventRows = (eventTypes: string[]) => db.select({ eventId: applicationEvents.id, eventType: applicationEvents.eventType, priorState: applicationEvents.priorState, newState: applicationEvents.newState, at: applicationEvents.createdAt, day: localDay(applicationEvents.createdAt), ...application })
    .from(applicationEvents).innerJoin(applications, and(eq(applications.workspaceId, applicationEvents.workspaceId), eq(applications.id, applicationEvents.applicationId)))
    .where(and(eq(applicationEvents.workspaceId, workspaceId), inArray(applicationEvents.eventType, eventTypes), isNotNull(applicationEvents.newState), sql`${applicationEvents.newState} is distinct from ${applicationEvents.priorState}`, inRange(applicationEvents.createdAt)))
    .orderBy(asc(applicationEvents.createdAt)).limit(limit);

  const [found, saved, created, statuses, stages, interviews, followUps, overdue] = await Promise.all([
    // A job is found when it enters the workspace; the overview calendar counts the same date.
    wanted('JOB_FOUND') ? db.select({ id: jobs.id, title: jobs.title, company: jobs.company, at: jobs.createdAt, day: localDay(jobs.createdAt), automatic: sql<boolean>`${jobs.discoveredAt} is not null` }).from(jobs)
      .where(and(eq(jobs.workspaceId, workspaceId), inRange(jobs.createdAt))).orderBy(asc(jobs.createdAt)).limit(limit) : none,
    wanted('JOB_SAVED') ? db.select({ id: jobs.id, title: jobs.title, company: jobs.company, at: jobs.savedAt, day: localDay(jobs.savedAt) }).from(jobs)
      .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.shortlistDecision, 'SHORTLISTED'), isNotNull(jobs.savedAt), inRange(jobs.savedAt))).orderBy(asc(jobs.savedAt)).limit(limit) : none,
    wanted('APPLICATION_CREATED') ? db.select({ ...application, at: applications.createdAt, day: localDay(applications.createdAt) }).from(applications)
      .where(and(eq(applications.workspaceId, workspaceId), inRange(applications.createdAt))).orderBy(asc(applications.createdAt)).limit(limit) : none,
    wanted('APPLICATION_STATUS_CHANGED') ? eventRows(statusEvents) : none,
    wanted('STAGE_CHANGED') ? eventRows(stageEvents) : none,
    wanted('INTERVIEW') ? db.select({ ...application, at: applications.interviewAt, day: localDay(applications.interviewAt), interviewTimeZone: applications.interviewTimezone }).from(applications)
      .where(and(eq(applications.workspaceId, workspaceId), isNotNull(applications.interviewAt), inRange(applications.interviewAt))).orderBy(asc(applications.interviewAt)).limit(limit) : none,
    wanted('FOLLOW_UP') ? db.select({ ...application, followUpDate: applications.followUpDate, nextStep: applications.nextStep }).from(applications)
      .where(and(eq(applications.workspaceId, workspaceId), openApplication(), isNotNull(applications.followUpDate), gte(applications.followUpDate, from), lte(applications.followUpDate, to))).orderBy(asc(applications.followUpDate), asc(applications.id)).limit(limit) : none,
    // Overdue follow-ups are listed whatever range is shown, so a missed one never hides in an earlier month.
    wanted('FOLLOW_UP') ? db.select({ ...application, followUpDate: applications.followUpDate, nextStep: applications.nextStep, total: sql<number>`(count(*) over ())::int` }).from(applications)
      .where(and(eq(applications.workspaceId, workspaceId), openApplication(), isNotNull(applications.followUpDate), lt(applications.followUpDate, today))).orderBy(asc(applications.followUpDate), asc(applications.id)).limit(overdueFollowUpLimit) : none,
  ]);

  const items: TimelineItem[] = [
    ...found.map((row) => ({ id: `JOB_FOUND:${row.id}`, type: 'JOB_FOUND' as const, day: row.day, at: iso(row.at), job: { id: row.id, title: row.title, company: row.company }, automatic: row.automatic })),
    ...saved.map((row) => ({ id: `JOB_SAVED:${row.id}`, type: 'JOB_SAVED' as const, day: row.day, at: iso(row.at!), job: { id: row.id, title: row.title, company: row.company } })),
    ...created.map((row) => ({ id: `APPLICATION_CREATED:${row.id}`, type: 'APPLICATION_CREATED' as const, day: row.day, at: iso(row.at), application: { id: row.id, role: row.role, company: row.company } })),
    ...statuses.map((row) => ({ id: `APPLICATION_STATUS_CHANGED:${row.eventId}`, type: 'APPLICATION_STATUS_CHANGED' as const, day: row.day, at: iso(row.at), application: { id: row.id, role: row.role, company: row.company }, priorState: row.priorState, newState: row.newState })),
    ...stages.map((row) => ({ id: `STAGE_CHANGED:${row.eventId}`, type: 'STAGE_CHANGED' as const, day: row.day, at: iso(row.at), application: { id: row.id, role: row.role, company: row.company }, priorState: row.priorState, newState: row.newState, correction: row.eventType === 'RECRUITMENT_STAGE_CORRECTED' })),
    ...interviews.map((row) => ({ id: `INTERVIEW:${row.id}`, type: 'INTERVIEW' as const, day: row.day, at: iso(row.at!), application: { id: row.id, role: row.role, company: row.company }, interviewTimeZone: row.interviewTimeZone })),
    ...followUps.map((row) => followUpItem(row, today)),
  ].sort(compareTimelineItems);
  return {
    from, to, timeZone, today, types,
    items: items.slice(0, timelineItemLimit), truncated: items.length > timelineItemLimit,
    overdue: { total: overdue[0]?.total ?? 0, items: overdue.map((row) => followUpItem(row, today)) },
  };
}

/** GET /api/v1/timeline?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Area/City&types=A,B */
export function registerActivityTimelineRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string) {
  app.get('/api/v1/timeline', async (request, reply) => {
    const query = request.query as { from?: unknown; to?: unknown; tz?: unknown; types?: unknown };
    const range = parseTimelineRange(query.from, query.to); const timeZone = resolveTimeZone(query.tz); const types = parseTimelineTypes(query.types);
    if (!range || !timeZone || !types) return reply.code(400).send({ error: 'INVALID_INPUT' });
    return loadTimeline(workspace(request), { ...range, timeZone, types });
  });
}
