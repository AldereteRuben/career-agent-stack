/**
 * How a job's availability follows its sources (ADR 021). Pure: the API counts presence and absence per source
 * after each read, then asks this module what the job's availability should become.
 */
import type { jobAvailability } from './states.js';

export type JobAvailability = (typeof jobAvailability)[number];
export type AvailabilityReason = 'ABSENT_FROM_SOURCES' | 'SEEN_AGAIN' | 'CLOSED_BY_USER' | 'REOPENED_BY_USER';

/** Consecutive complete reads that must miss a job before it can become POSSIBLY_CLOSED. */
export const ABSENCE_READS = 3;
/** Hours that must pass since any source last saw a job before it can become POSSIBLY_CLOSED. */
export const ABSENCE_MIN_HOURS = 48;
/** A complete read listing fewer than this share of the previous complete read is suspicious. */
export const SUSPICIOUS_SHARE = 0.5;

export type AvailabilitySource = {
  /** Whether this source's complete reads can show absence (a board or a whole public feed; not Himalayas). */
  canGiveAbsence: boolean;
  /** Consecutive complete reads of this source that did not list the job. */
  missedCompleteReads: number;
  /** When this source last listed the job in a fresh, successful read. */
  lastSeenAt: Date | null;
};

export type AvailabilityChange = { state: JobAvailability; reason: AvailabilityReason };

/** Whether every source able to show absence has missed the job long enough, and no source saw it recently. */
export function absentFromSources(sources: readonly AvailabilitySource[], now: Date): boolean {
  const capable = sources.filter((source) => source.canGiveAbsence);
  if (!capable.length || !capable.every((source) => source.missedCompleteReads >= ABSENCE_READS)) return false;
  const lastSeen = Math.max(...sources.map((source) => source.lastSeenAt?.getTime() ?? Number.NEGATIVE_INFINITY));
  return now.getTime() - lastSeen >= ABSENCE_MIN_HOURS * 60 * 60 * 1000;
}

/**
 * What a job's availability should become after its sources were updated, or null to keep it. The person's
 * decision wins: a job they closed stays CLOSED. CLOSED is never reached from sources alone.
 */
export function nextAvailability(input: { current: JobAvailability; closedByUser: boolean; sources: readonly AvailabilitySource[]; now: Date }): AvailabilityChange | null {
  const { current, closedByUser, sources, now } = input;
  if (closedByUser) return current === 'CLOSED' ? null : { state: 'CLOSED', reason: 'CLOSED_BY_USER' };
  if (current === 'CLOSED') return null;
  const absent = absentFromSources(sources, now);
  if (absent) return current === 'POSSIBLY_CLOSED' ? null : sources.some((source) => source.canGiveAbsence) ? { state: 'POSSIBLY_CLOSED', reason: 'ABSENT_FROM_SOURCES' } : null;
  // Not absent any more: a source saw the job again (or a manual job got its first source).
  if (current === 'POSSIBLY_CLOSED') return { state: 'OPEN', reason: 'SEEN_AGAIN' };
  if (current === 'UNKNOWN' && sources.some((source) => source.lastSeenAt)) return { state: 'OPEN', reason: 'SEEN_AGAIN' };
  return null;
}

/**
 * Whether a complete read is suspicious and must give no absence evidence: it lists nothing after a complete read
 * that listed something, or fewer than half as many jobs. The first complete read of a source is never suspicious.
 */
export function suspiciousRead(listed: number, previousComplete: number | null): boolean {
  if (previousComplete === null || previousComplete <= 0) return false;
  return listed === 0 || listed < previousComplete * SUSPICIOUS_SHARE;
}
