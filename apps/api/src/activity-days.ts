import { instantToLocalDateTime } from '@career/domain';

/** Largest number of rows `/activity` returns per group; the response also carries the full total. */
export const activityDetailLimit = 50;

// Names start with a letter: bare offsets such as `+05` mean UTC+5 to Intl but UTC-5 to PostgreSQL.
const ianaName = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

/** A valid IANA zone name, `UTC` when absent, or null when the value is unusable. */
export function resolveTimeZone(value: unknown): string | null {
  if (value === undefined || value === '') return 'UTC';
  if (typeof value !== 'string' || !ianaName.test(value)) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return value; } catch { return null; }
}

/** A `YYYY-MM-DD` calendar day, or null when it is malformed or does not exist. */
export function parseActivityDay(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const start = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(start.getTime()) && start.toISOString().slice(0, 10) === value ? value : null;
}

const dayMs = 86_400_000;

/** UTC bounds that always contain the given local day in any time zone (UTC-12 to UTC+14), padded by one day each side. */
export function localDayBounds(day: string): { from: Date; to: Date } {
  const start = new Date(`${day}T00:00:00.000Z`).getTime();
  return { from: new Date(start - dayMs), to: new Date(start + 2 * dayMs) };
}

/** UTC bounds that contain the last twelve calendar months in any time zone. */
export function activityWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1) - dayMs),
    to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) + dayMs),
  };
}

/** Dated records the timeline reports. Each one comes from a stored date; nothing is inferred. */
export const timelineTypes = ['JOB_FOUND', 'JOB_SAVED', 'APPLICATION_CREATED', 'APPLICATION_STATUS_CHANGED', 'STAGE_CHANGED', 'INTERVIEW', 'FOLLOW_UP'] as const;
export type TimelineType = (typeof timelineTypes)[number];
/** Longest range one request may cover: enough for a quarter or a six-week month grid. */
export const timelineMaxDays = 93;
/** Largest number of items per response; `truncated` tells the client when more exist. */
export const timelineItemLimit = 500;
/** Largest number of overdue follow-ups returned; the response also carries the full total. */
export const overdueFollowUpLimit = 50;

export type TimelineItem = {
  /** Stable per source record, so the same record never appears twice. */
  id: string;
  type: TimelineType;
  /** The viewer's calendar day; for follow-ups, the calendar date the person chose. */
  day: string;
  /** The exact instant, or null for date-only follow-ups. */
  at: string | null;
  job?: { id: string; title: string; company: string };
  /** For found jobs: true when an automatic search or company check added it, false when the person added it. */
  automatic?: boolean;
  application?: { id: string; role: string; company: string };
  priorState?: string | null;
  newState?: string | null;
  correction?: boolean;
  /** The zone the interview was scheduled in, which may differ from the viewer's. */
  interviewTimeZone?: string | null;
  nextStep?: string | null;
  followUpStatus?: 'overdue' | 'due-today' | 'upcoming';
};

export type Timeline = { from: string; to: string; timeZone: string; today: string; types: TimelineType[]; items: TimelineItem[]; truncated: boolean; overdue: { total: number; items: TimelineItem[] } };

/** Comma-separated types; absent means every type. Unknown or empty values are rejected rather than ignored. */
export function parseTimelineTypes(value: unknown): TimelineType[] | null {
  if (value === undefined) return [...timelineTypes];
  if (typeof value !== 'string' || value.length > 200) return null;
  const requested = value.split(',').map((item) => item.trim());
  if (!requested.length || requested.some((item) => !(timelineTypes as readonly string[]).includes(item))) return null;
  return timelineTypes.filter((type) => requested.includes(type));
}

/** Inclusive `YYYY-MM-DD` range of at most `timelineMaxDays` days, or null. */
export function parseTimelineRange(fromValue: unknown, toValue: unknown): { from: string; to: string } | null {
  const from = parseActivityDay(fromValue); const to = parseActivityDay(toValue);
  if (!from || !to || to < from) return null;
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs + 1;
  return span <= timelineMaxDays ? { from, to } : null;
}

/** UTC bounds that contain the whole local range in any zone from UTC-12 to UTC+14. */
export function timelineBounds(from: string, to: string): { start: Date; end: Date } {
  return { start: new Date(Date.parse(`${from}T00:00:00Z`) - dayMs), end: new Date(Date.parse(`${to}T00:00:00Z`) + 2 * dayMs) };
}

/** Today's calendar date in the viewer's zone. Follow-ups are due by this date, not by the server's. */
export const localToday = (now: Date, timeZone: string) => instantToLocalDateTime(now, timeZone).slice(0, 10);

/** Earlier days first; within a day, date-only follow-ups lead, then timed records in order. */
export function compareTimelineItems(left: TimelineItem, right: TimelineItem): number {
  if (left.day !== right.day) return left.day < right.day ? -1 : 1;
  if ((left.at === null) !== (right.at === null)) return left.at === null ? -1 : 1;
  if (left.at !== right.at) return (left.at ?? '') < (right.at ?? '') ? -1 : 1;
  return timelineTypes.indexOf(left.type) - timelineTypes.indexOf(right.type) || left.id.localeCompare(right.id);
}
