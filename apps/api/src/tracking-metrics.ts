const dayMs = 86_400_000;
const noResponseDays = 14;
const confirmedEventTypes = new Set([
  'MANUAL_APPLICATION_RECORDED',
  'APPLICATION_STATE_CHANGED',
  'ASSIST_SUBMISSION_CONFIRMED',
  'ASSIST_USER_RECONCILED',
]);
const stageEventTypes = new Set(['RECRUITMENT_STAGE_CHANGED', 'RECRUITMENT_STAGE_CORRECTED']);
const interviewStages = new Set(['INTERVIEW', 'FINAL_INTERVIEW', 'OFFER']);

export const trackingPeriods = ['30d', '90d', 'all'] as const;
export type TrackingPeriod = (typeof trackingPeriods)[number];

export function parseTrackingPeriod(value: unknown): TrackingPeriod | null {
  return value === undefined || value === null || value === '' || value === '90d'
    ? '90d'
    : trackingPeriods.includes(value as TrackingPeriod) ? value as TrackingPeriod : null;
}

export function trackingMetricsStart(period: TrackingPeriod, now: Date): Date | null {
  return period === 'all' ? null : new Date(now.getTime() - (period === '30d' ? 30 : 90) * dayMs);
}

type Application = { id: string; state: string; recruitmentStage: string };
type ApplicationEvent = { applicationId: string; eventType: string; newState: string | null; createdAt: Date | string };

function reachedInterview(events: ApplicationEvent[], currentStage: string) {
  const stageEvents = events.filter((event) => stageEventTypes.has(event.eventType))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  if (!stageEvents.length) return interviewStages.has(currentStage);
  let reached = false;
  for (const event of stageEvents) {
    if (!event.newState) continue;
    if (event.eventType === 'RECRUITMENT_STAGE_CORRECTED') reached = interviewStages.has(event.newState);
    else if (interviewStages.has(event.newState)) reached = true;
  }
  return reached;
}

export function calculateTrackingMetrics(input: {
  period: TrackingPeriod;
  now: Date;
  applications: Application[];
  events: ApplicationEvent[];
}) {
  const earliestConfirmation = new Map<string, Date>();
  for (const event of input.events) {
    if (!confirmedEventTypes.has(event.eventType) || event.newState !== 'CONFIRMED') continue;
    const at = new Date(event.createdAt);
    const prior = earliestConfirmation.get(event.applicationId);
    if (!prior || at < prior) earliestConfirmation.set(event.applicationId, at);
  }

  const start = trackingMetricsStart(input.period, input.now);
  const applicationById = new Map(input.applications.map((application) => [application.id, application]));
  const cohort = [...earliestConfirmation]
    .filter(([id, at]) => {
      const application = applicationById.get(id);
      return application && application.state !== 'CANCELLED' && at <= input.now && (!start || at >= start);
    })
    .map(([id, confirmedAt]) => ({ application: applicationById.get(id)!, confirmedAt }));

  const eventsByApplication = new Map<string, ApplicationEvent[]>();
  for (const event of input.events) {
    const list = eventsByApplication.get(event.applicationId) ?? [];
    list.push(event);
    eventsByApplication.set(event.applicationId, list);
  }
  const interviewed = cohort.filter(({ application }) => reachedInterview(eventsByApplication.get(application.id) ?? [], application.recruitmentStage)).length;
  const noResponse = cohort.filter(({ application }) => application.recruitmentStage === 'NO_RESPONSE');
  const noResponseYet = noResponse.filter(({ confirmedAt }) => input.now.getTime() - confirmedAt.getTime() < noResponseDays * dayMs).length;

  return {
    period: input.period,
    periodStart: start?.toISOString() ?? null,
    confirmed: cohort.length,
    interviewed,
    interviewConversionPercent: cohort.length ? Math.round((interviewed / cohort.length) * 100) : null,
    noResponseYet,
    noResponseAfter14Days: noResponse.length - noResponseYet,
    noResponseThresholdDays: noResponseDays,
  };
}
