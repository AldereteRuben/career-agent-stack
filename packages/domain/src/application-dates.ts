type LocalDateTimeParts = { year: number; month: number; day: number; hour: number; minute: number };

function localParts(value: string): LocalDateTimeParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText); const hour = Number(hourText); const minute = Number(minuteText);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day, hour, minute };
}

function zonedParts(value: Date, timeZone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute') };
}

const sameLocal = (left: LocalDateTimeParts, right: LocalDateTimeParts) => left.year === right.year && left.month === right.month && left.day === right.day && left.hour === right.hour && left.minute === right.minute;

export function isValidDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && localParts(`${value}T00:00`) !== null;
}

export function isValidTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; }
  catch { return false; }
}

/** Converts an unambiguous wall-clock value in an IANA zone to UTC; DST gaps and repeats need an explicit user choice. */
export function localDateTimeToInstant(value: string, timeZone: string): string | null {
  const target = localParts(value);
  if (!target || !isValidTimeZone(timeZone)) return null;
  const targetUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  let candidate = targetUtc;
  for (let attempt = 0; attempt < 4; attempt++) {
    const shown = zonedParts(new Date(candidate), timeZone);
    const shownUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
    candidate += targetUtc - shownUtc;
  }
  if (!sameLocal(zonedParts(new Date(candidate), timeZone), target)) return null;
  // A repeated wall-clock time has more than one matching instant. Reject it instead of silently choosing an offset.
  for (let shiftMinutes = -180; shiftMinutes <= 180; shiftMinutes += 15) {
    if (shiftMinutes !== 0 && sameLocal(zonedParts(new Date(candidate + shiftMinutes * 60_000), timeZone), target)) return null;
  }
  return new Date(candidate).toISOString();
}

export function instantToLocalDateTime(value: string | Date, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()) || !isValidTimeZone(timeZone)) return '';
  const parts = zonedParts(date, timeZone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export type FollowUpStatus = 'overdue' | 'due-today' | 'upcoming' | 'none';
export function applicationFollowUpStatus(followUpDate: string | null | undefined, today: string, closed: boolean): FollowUpStatus {
  if (closed || !followUpDate || !isValidDateOnly(followUpDate)) return 'none';
  if (followUpDate < today) return 'overdue';
  return followUpDate === today ? 'due-today' : 'upcoming';
}
