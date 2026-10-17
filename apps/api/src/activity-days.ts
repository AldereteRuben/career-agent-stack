/** Largest number of rows `/activity` returns per group; the response also carries the full total. */
export const activityDetailLimit = 50;

const ianaName = /^[A-Za-z0-9_+\-/]{1,64}$/;

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
