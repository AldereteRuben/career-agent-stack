import { z } from 'zod';

export const assistedStates = ['PREPARED', 'STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF', 'UNKNOWN', 'CONFIRMED', 'NOT_SUBMITTED', 'CANCELLED', 'INVALIDATED', 'FAILED'] as const;
export type AssistedState = typeof assistedStates[number];
export const activeAssistedStates: AssistedState[] = ['PREPARED', 'STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF', 'UNKNOWN'];
export const assistedPrepareSchema = z.object({ documentId: z.string().uuid(), phone: z.string().trim().max(80).default(''), organization: z.string().trim().max(200).default('') }).strict();
export const assistedConsentSchema = z.object({ consent: z.literal(true), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const assistedHandoffSchema = z.object({ confirmReviewed: z.literal(true) }).strict();
export const assistedResolutionSchema = z.object({ outcome: z.enum(['CONFIRMED', 'NOT_SUBMITTED', 'UNKNOWN']), confirmReviewed: z.literal(true), reason: z.string().trim().min(1).max(2000) }).strict();
export type AssistedFields = { name: string; email: string; phone: string; org: string };
/**
 * What one consent covers: destination, application version, the displayed fields and the exact PDF. Plans stored before
 * 0.5.3 also carried the profile revision id; new plans omit it so a preference-only save does not void consent, while any
 * change to the printed identity or facts still fails validation through the fields and the document readiness check.
 */
export type AssistedPlan = { adapter: 'lever-hosted-v1'; url: string; profileRevisionId?: string; documentId: string; documentSha256: string; documentName: string; applicationVersion: number; fields: AssistedFields };

/** Only canonical hosted Lever applications. Never accept redirects, arbitrary URLs or employer API keys. */
export function leverApplicationUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || !['jobs.lever.co', 'jobs.eu.lever.co'].includes(url.hostname) || url.port || url.username || url.password) return null;
    const match = /^\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,199})\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/apply)?\/?$/i.exec(url.pathname);
    if (!match) return null;
    return `${url.origin}/${match[1]}/${match[2]}/apply`;
  } catch { return null; }
}
