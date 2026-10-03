export type ProfilePreferences = { targetTitles: string[]; workModes: string[] };
export type ProfileIdentity = { fullName: string; email: string; country: string };

const stringList = (value: unknown, max: number) => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].slice(0, max) : [];
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** profile.preferences is the source of truth the dashboard edits. */
export function readPreferences(profile: Record<string, unknown>): ProfilePreferences {
  const preferences = record(profile.preferences);
  return { targetTitles: stringList(preferences.targetTitles, 30), workModes: stringList(preferences.workModes, 10) };
}

/** True when the user has saved target titles at all, including an explicit empty list; legacy fallbacks apply only when absent. */
export function hasTargetTitlesPreference(profile: Record<string, unknown>) {
  const preferences = record(profile.preferences);
  return Object.prototype.hasOwnProperty.call(preferences, 'targetTitles') && Array.isArray(preferences.targetTitles);
}

export function readIdentity(profile: Record<string, unknown>): ProfileIdentity {
  const identity = record(profile.identity);
  return { fullName: text(identity.fullName), email: text(identity.email), country: text(identity.country) };
}

/**
 * Identity exactly as the resume generator receives it: the untrimmed name and email, truncated like the renderer input.
 * Country, locale and job preferences are never printed, so they are not part of it.
 */
export type PrintedIdentity = { fullName: string; email: string };
export function printedResumeIdentity(profile: Record<string, unknown>): PrintedIdentity {
  const identity = record(profile.identity);
  return { fullName: typeof identity.fullName === 'string' ? identity.fullName.slice(0, 200) : '', email: typeof identity.email === 'string' ? identity.email.slice(0, 320) : '' };
}

export const profileCompletionChecks = ['fullName', 'email', 'country', 'targetTitles', 'workModes', 'approvedFact'] as const;
export type ProfileCompletionCheck = (typeof profileCompletionChecks)[number];

export function profileCompletion(profile: Record<string, unknown>, facts: Array<{ approvalStatus: string }>) {
  const identity = readIdentity(profile); const preferences = readPreferences(profile);
  const approvedFactCount = facts.filter((fact) => fact.approvalStatus === 'USER_APPROVED').length;
  const pendingFactCount = facts.filter((fact) => fact.approvalStatus === 'SUGGESTED').length;
  const done: Record<ProfileCompletionCheck, boolean> = {
    fullName: Boolean(identity.fullName), email: Boolean(identity.email), country: Boolean(identity.country),
    targetTitles: preferences.targetTitles.length > 0, workModes: preferences.workModes.length > 0, approvedFact: approvedFactCount > 0,
  };
  const completed = profileCompletionChecks.filter((check) => done[check]).length;
  return { percent: Math.round(completed / profileCompletionChecks.length * 100), completed, total: profileCompletionChecks.length, missing: profileCompletionChecks.filter((check) => !done[check]), approvedFactCount, pendingFactCount };
}

/** Accepts BCP 47-ish tags such as "es", "es-ES", "en-GB"; anything else falls back. */
export function normalizeLocaleTag(value: unknown, fallback = 'en-GB'): string {
  if (typeof value !== 'string') return fallback;
  const match = /^([a-z]{2})(?:[-_]([a-z]{2}))?$/i.exec(value.trim());
  if (!match) return fallback;
  return match[2] ? `${match[1]!.toLowerCase()}-${match[2].toUpperCase()}` : match[1]!.toLowerCase();
}

export function documentLanguage(requested: unknown, profileLocale: string | null | undefined): 'es' | 'en' {
  const tag = normalizeLocaleTag(requested, '') || normalizeLocaleTag(profileLocale, 'en');
  return tag.startsWith('es') ? 'es' : 'en';
}

/** Safe ASCII download name such as "my-resume-r3.pdf". */
export function documentFileName(name: string, revision: number) {
  const slug = name.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'document';
  return `${slug}-r${revision}.pdf`;
}
