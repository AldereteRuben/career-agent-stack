import type { Locale } from './locale';
import { copy, labelFor } from './labels';

/** Mirrors the API's timeline types, in the order the filters list them. */
export const timelineTypes = ['JOB_FOUND', 'JOB_SAVED', 'APPLICATION_CREATED', 'APPLICATION_STATUS_CHANGED', 'STAGE_CHANGED', 'INTERVIEW', 'FOLLOW_UP'] as const;
export type TimelineType = (typeof timelineTypes)[number];
export type FollowUpStatus = 'overdue' | 'due-today' | 'upcoming';
export type TimelineItem = {
  id: string; type: TimelineType; day: string; at: string | null;
  job?: { id: string; title: string; company: string }; automatic?: boolean;
  application?: { id: string; role: string; company: string };
  priorState?: string | null; newState?: string | null; correction?: boolean;
  interviewTimeZone?: string | null; nextStep?: string | null; followUpStatus?: FollowUpStatus;
};
export type Timeline = { from: string; to: string; timeZone: string; today: string; types: TimelineType[]; items: TimelineItem[]; truncated: boolean; overdue: { total: number; items: TimelineItem[] } };

const pad = (value: number) => String(value).padStart(2, '0');
export const monthKey = (year: number, monthIndex: number) => `${year}-${pad(monthIndex + 1)}`;

/** First and last calendar day of a month as `YYYY-MM-DD`, independent of any time zone. */
export function monthRange(year: number, monthIndex: number): { from: string; to: string } {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/** A `YYYY-MM` query value as a year and month index, or null when it is malformed. */
export function parseMonth(value: string | null | undefined): { year: number; monthIndex: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const year = Number(match[1]); const month = Number(match[2]);
  return year >= 2000 && year <= 2100 && month >= 1 && month <= 12 ? { year, monthIndex: month - 1 } : null;
}

/** Items in day order, keeping the server's order within each day. */
export function groupByDay(items: TimelineItem[]): Array<{ day: string; items: TimelineItem[] }> {
  const groups: Array<{ day: string; items: TimelineItem[] }> = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last?.day === item.day) last.items.push(item); else groups.push({ day: item.day, items: [item] });
  }
  return groups;
}

/** `types` query value; an empty selection is never sent because the API rejects it. */
export const typesParam = (selected: readonly TimelineType[]) => timelineTypes.filter((type) => selected.includes(type)).join(',');

const localeTag = (locale: Locale) => locale === 'en' ? 'en-GB' : 'es-ES';
const capitalize = (value: string, locale: Locale) => value.charAt(0).toLocaleUpperCase(localeTag(locale)) + value.slice(1);

/** A calendar date without shifting it through any time zone. */
export const formatDay = (day: string, locale: Locale, style: 'full' | 'medium' = 'full') =>
  capitalize(new Intl.DateTimeFormat(localeTag(locale), { dateStyle: style, timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`)), locale);

export const formatMonth = (year: number, monthIndex: number, locale: Locale) =>
  capitalize(new Intl.DateTimeFormat(localeTag(locale), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, monthIndex, 1))), locale);

/** Time in the viewer's zone; an interview set in another zone also shows its own local time. */
export function formatItemTime(item: TimelineItem, viewerZone: string, locale: Locale): string {
  const c = copy(locale);
  if (!item.at) return c('Todo el día', 'All day');
  const time = (timeZone: string) => new Intl.DateTimeFormat(localeTag(locale), { timeStyle: 'short', timeZone }).format(new Date(item.at!));
  const shown = time(viewerZone);
  const own = item.type === 'INTERVIEW' && item.interviewTimeZone && item.interviewTimeZone !== viewerZone ? item.interviewTimeZone : null;
  if (!own) return shown;
  try { return `${shown} (${time(own)} ${c('en', 'in')} ${own})`; } catch { return shown; }
}

export function typeLabel(type: TimelineType, locale: Locale): string {
  const c = copy(locale);
  switch (type) {
    case 'JOB_FOUND': return c('Ofertas encontradas', 'Jobs found');
    case 'JOB_SAVED': return c('Ofertas guardadas', 'Saved jobs');
    case 'APPLICATION_CREATED': return c('Solicitudes creadas', 'Applications created');
    case 'APPLICATION_STATUS_CHANGED': return c('Cambios de estado', 'Status changes');
    case 'STAGE_CHANGED': return c('Cambios de etapa', 'Stage changes');
    case 'INTERVIEW': return c('Entrevistas', 'Interviews');
    case 'FOLLOW_UP': return c('Recordatorios', 'Follow-ups');
  }
}

export const followUpLabel = (status: FollowUpStatus, locale: Locale) => {
  const c = copy(locale);
  return status === 'overdue' ? c('Vencido', 'Overdue') : status === 'due-today' ? c('Vence hoy', 'Due today') : c('Pendiente', 'Upcoming');
};

/** What happened, in one line, from the record's own fields. */
export function describeItem(item: TimelineItem, locale: Locale): { label: string; title: string; detail: string; href: string } {
  const c = copy(locale);
  const application = item.application;
  const href = item.job ? `/jobs/${item.job.id}` : `/applications?id=${application?.id ?? ''}`;
  const title = item.job?.title ?? application?.role ?? '';
  const company = item.job?.company ?? application?.company ?? '';
  const change = (from: string, to: string) => `${from} → ${to}`;
  switch (item.type) {
    case 'JOB_FOUND': return { label: item.automatic ? c('Oferta encontrada', 'Job found') : c('Oferta añadida por ti', 'Job you added'), title, detail: company, href };
    case 'JOB_SAVED': return { label: c('Oferta guardada', 'Job saved'), title, detail: company, href };
    case 'APPLICATION_CREATED': return { label: c('Solicitud creada', 'Application created'), title, detail: company, href };
    case 'APPLICATION_STATUS_CHANGED': return { label: c('Estado', 'Status'), title, detail: `${company} · ${change(labelFor.applicationState(item.priorState, locale), labelFor.applicationState(item.newState, locale))}`, href };
    case 'STAGE_CHANGED': return { label: item.correction ? c('Etapa corregida', 'Stage corrected') : c('Etapa', 'Stage'), title, detail: `${company} · ${change(labelFor.recruitmentStage(item.priorState, locale), labelFor.recruitmentStage(item.newState, locale))}`, href };
    case 'INTERVIEW': return { label: c('Entrevista', 'Interview'), title, detail: company, href };
    case 'FOLLOW_UP': return { label: c('Recordatorio', 'Follow-up'), title, detail: item.nextStep ? `${company} · ${item.nextStep}` : company, href };
  }
}
