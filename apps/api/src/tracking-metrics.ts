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

type Application = { id: string; state: string; recruitmentStage: string; role?: string; sourceProviders?: string[] };
type ApplicationEvent = { applicationId: string; eventType: string; priorState?: string | null; newState: string | null; createdAt: Date | string };

const minimumBreakdownSampleSize = 5;

function breakdown(
  cohort: Array<{ application: Application; confirmedAt: Date }>,
  interviewedIds: Set<string>,
  getGroup: (application: Application) => { key: string; label: string },
) {
  const groups = new Map<string, { key: string; label: string; confirmed: number; interviewed: number }>();
  for (const { application } of cohort) {
    const { key, label } = getGroup(application);
    const group = groups.get(key) ?? { key, label, confirmed: 0, interviewed: 0 };
    // The label for a normalized title stays deterministic when casing differs between applications.
    if (label.localeCompare(group.label) < 0) group.label = label;
    group.confirmed += 1;
    if (interviewedIds.has(application.id)) group.interviewed += 1;
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.confirmed - a.confirmed || a.key.localeCompare(b.key))
    .map((group) => ({
      ...group,
      interviewConversionPercent: group.confirmed >= minimumBreakdownSampleSize
        ? Math.round((group.interviewed / group.confirmed) * 100)
        : null,
      smallSample: group.confirmed < minimumBreakdownSampleSize,
    }));
}

function sourceGroup(application: Application) {
  const providers = [...new Set(application.sourceProviders ?? [])].sort();
  if (providers.length === 1) return { key: providers[0]!, label: providers[0]! };
  if (providers.length > 1) return { key: 'multiple', label: 'multiple' };
  return { key: 'unidentified', label: 'unidentified' };
}

function roleGroup(application: Application) {
  const label = (application.role ?? '').trim().replace(/\s+/g, ' ') || 'unidentified';
  return { key: label.toLocaleLowerCase('en-US'), label };
}

function reachedInterview(events: ApplicationEvent[], currentStage: string) {
  const stageEvents = events.filter((event) => stageEventTypes.has(event.eventType))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  if (!stageEvents.length) return interviewStages.has(currentStage);
  const stageHistory: string[] = [];
  for (const event of stageEvents) {
    if (!event.newState) continue;
    if (event.eventType === 'RECRUITMENT_STAGE_CORRECTED') {
      const correctedIndex = event.priorState
        ? stageHistory.lastIndexOf(event.priorState)
        : stageHistory.length - 1;
      if (correctedIndex >= 0) stageHistory.splice(correctedIndex, 1);
    }
    stageHistory.push(event.newState);
  }
  return stageHistory.some((stage) => interviewStages.has(stage));
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
      return application && application.state === 'CONFIRMED' && at <= input.now && (!start || at >= start);
    })
    .map(([id, confirmedAt]) => ({ application: applicationById.get(id)!, confirmedAt }));

  const eventsByApplication = new Map<string, ApplicationEvent[]>();
  for (const event of input.events) {
    const list = eventsByApplication.get(event.applicationId) ?? [];
    list.push(event);
    eventsByApplication.set(event.applicationId, list);
  }
  const interviewedIds = new Set(cohort
    .filter(({ application }) => reachedInterview(eventsByApplication.get(application.id) ?? [], application.recruitmentStage))
    .map(({ application }) => application.id));
  const interviewed = interviewedIds.size;
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
    breakdowns: {
      source: breakdown(cohort, interviewedIds, sourceGroup),
      role: breakdown(cohort, interviewedIds, roleGroup),
      // `location` is free text, not a validated country. Keep all rows unidentified instead of guessing.
      country: breakdown(cohort, interviewedIds, () => ({ key: 'unidentified', label: 'unidentified' })),
    },
  };
}
