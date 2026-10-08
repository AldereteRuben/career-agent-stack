import { z } from 'zod';
import { entryStatement, type StructuredEntry } from './entries.js';
import { applicationState, boardPermission, factApproval, recruitmentStage, shortlistDecision } from './states.js';

export const boardSchema = z.object({
  id: z.string().uuid().optional(), provider: z.enum(['greenhouse', 'lever', 'ashby']), tenant: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/), region: z.enum(['global', 'eu']), companyName: z.string().min(1).max(200), companyDomain: z.string().min(1).max(253), careersUrl: z.string().url(), associationStatus: z.enum(['VERIFIED', 'UNVERIFIED']), permissionStatus: z.enum(boardPermission), enabled: z.boolean().default(false),
}).strict().refine((board) => board.provider === 'lever' || board.region === 'global', { path: ['region'], message: 'This provider supports the global region only.' });

const employmentMonth = z.string().regex(/^[1-9][0-9]{3}-(0[1-9]|1[0-2])$/);
export const employmentSchema = z.object({
  role: z.string().trim().min(1).max(200), company: z.string().trim().min(1).max(200),
  startMonth: employmentMonth, endMonth: employmentMonth.optional(), current: z.boolean(), locale: z.enum(['es', 'en']),
}).strict().superRefine((job, ctx) => {
  if (!job.current && !job.endMonth) ctx.addIssue({ code: 'custom', path: ['endMonth'], message: 'End month is required.' });
  if (job.current && job.endMonth) ctx.addIssue({ code: 'custom', path: ['endMonth'], message: 'A current job cannot have an end month.' });
  if (job.endMonth && job.endMonth < job.startMonth) ctx.addIssue({ code: 'custom', path: ['endMonth'], message: 'End month cannot precede start month.' });
});

export const educationSchema = z.object({
  qualification: z.string().trim().min(1).max(200), institution: z.string().trim().min(1).max(200),
  startMonth: employmentMonth, endMonth: employmentMonth.optional(), current: z.boolean(), locale: z.enum(['es', 'en']),
}).strict().superRefine((study, ctx) => {
  if (!study.current && !study.endMonth) ctx.addIssue({ code: 'custom', path: ['endMonth'], message: 'End month is required.' });
  if (study.current && study.endMonth) ctx.addIssue({ code: 'custom', path: ['endMonth'], message: 'An ongoing course cannot have an end month.' });
  if (study.endMonth && study.endMonth < study.startMonth) ctx.addIssue({ code: 'custom', path: ['endMonth'], message: 'End month cannot precede start month.' });
});

export const factSchema = z.object({ kind: z.string().min(1).max(64), statement: z.string().trim().max(4000), tags: z.array(z.string().min(1).max(80)).max(40).default([]), source: z.enum(['USER_ENTERED', 'IMPORTED_SUGGESTION']).default('USER_ENTERED'), approvalStatus: z.enum(factApproval).default('SUGGESTED'), employment: employmentSchema.optional(), education: educationSchema.optional() }).strict()
  .refine((fact) => !fact.employment || fact.kind === 'experience', { path: ['employment'], message: 'Employment fields require work experience.' })
  .refine((fact) => !fact.education || fact.kind === 'education', { path: ['education'], message: 'Education fields require education.' })
  .refine((fact) => Boolean(fact.statement || fact.employment || fact.education), { path: ['statement'], message: 'Describe this entry.' })
  .transform((fact) => {
    let details: StructuredEntry | null = null;
    if (fact.employment) { const job = fact.employment; details = { type: 'employment', title: job.role, organization: job.company, startMonth: job.startMonth, ...(job.endMonth ? { endMonth: job.endMonth } : {}), current: job.current, locale: job.locale, description: fact.statement }; }
    if (fact.education) { const study = fact.education; details = { type: 'education', title: study.qualification, organization: study.institution, startMonth: study.startMonth, ...(study.endMonth ? { endMonth: study.endMonth } : {}), current: study.current, locale: study.locale, description: fact.statement }; }
    return { ...fact, details, statement: details ? entryStatement(details) : fact.statement };
  }).refine((fact) => fact.statement.length <= 4000, { path: ['statement'], message: 'The complete entry must fit within 4000 characters.' });

/**
 * A batch of resume entries to store as suggestions (ADR 018, task T1). Each entry is validated like a fact entered by
 * hand; the API stores every one as an unconfirmed IMPORTED_SUGGESTION, whatever source or status the request claims.
 * The client generates importId once per import, so a retried request cannot create the import twice.
 */
export const maxImportedFacts = 100;
export const factImportSchema = z.object({ importId: z.string().uuid(), facts: z.array(factSchema).min(1).max(maxImportedFacts) }).strict();
export const answerSchema = z.object({ semanticKey: z.string().min(1).max(100), jurisdiction: z.string().length(2), questionScope: z.string().min(1).max(160), value: z.unknown().nullable(), strategy: z.enum(['EXACT_APPROVED', 'DERIVED_RULE', 'DRAFT_FOR_REVIEW', 'ASK_USER', 'LEAVE_OPTIONAL_BLANK']), approvalStatus: z.enum(['UNANSWERED', 'USER_APPROVED']).default('UNANSWERED'), reviewAfter: z.string().datetime().nullable().default(null), questionText: z.string().trim().max(500).nullable().default(null) }).strict();
export const jobImportSchema = z.object({ title: z.string().min(1).max(300), company: z.string().min(1).max(200), location: z.string().max(300).nullable().default(null), description: z.string().max(50000).nullable().default(null), jobUrl: z.string().url(), applyUrl: z.string().url().nullable().default(null), sourcePostedAt: z.string().datetime().nullable().default(null) }).strict();
export const applicationSchema = z.object({ jobId: z.string().uuid().nullable().default(null), company: z.string().min(1).max(200), role: z.string().min(1).max(300), location: z.string().max(300).nullable().default(null), canonicalUrl: z.string().url().nullable().default(null), state: z.enum(applicationState).default('DRAFT'), confirmationEvidence: z.literal('USER_ATTESTATION').optional(), recruitmentStage: z.enum(recruitmentStage).default('NO_RESPONSE'), shortlistDecision: z.enum(shortlistDecision).default('UNREVIEWED'), notes: z.string().max(10000).default('') }).strict();
export const applicationUpdateSchema = z.object({ state: z.enum(applicationState).optional(), recruitmentStage: z.enum(recruitmentStage).optional(), shortlistDecision: z.enum(shortlistDecision).optional(), notes: z.string().max(10000).optional(), confirmationEvidence: z.literal('USER_ATTESTATION').optional(), correction: z.boolean().optional(), reason: z.string().trim().max(2000).optional(), expectedVersion: z.number().int().positive().optional() }).strict();
/**
 * The profile record the dashboard and readers use (`readIdentity`, `readPreferences`). Known fields must have their
 * documented shape, and identity or preference fields at the top level are rejected so a wrong-shaped save fails
 * instead of leaving an apparently empty profile. Other top-level and nested keys are kept: older installs may store
 * extra keys (the demo seed writes `locale`) and the dashboard sends the whole stored profile back on every save.
 */
const profileIdentitySchema = z.looseObject({ fullName: z.string().optional(), email: z.string().optional(), country: z.string().optional() });
const profilePreferencesSchema = z.looseObject({ targetTitles: z.array(z.string()).optional(), workModes: z.array(z.string()).optional() });
const misplacedProfileKeys = { fullName: 'identity', email: 'identity', country: 'identity', targetTitles: 'preferences', workModes: 'preferences' } as const;
export const profileDataSchema = z.looseObject({ identity: profileIdentitySchema.optional(), preferences: profilePreferencesSchema.optional() })
  .superRefine((profile, ctx) => {
    for (const [key, parent] of Object.entries(misplacedProfileKeys)) if (Object.prototype.hasOwnProperty.call(profile, key)) ctx.addIssue({ code: 'custom', path: [key], message: `${key} belongs inside ${parent}.` });
  });
export const profileUpdateSchema = z.object({ profile: profileDataSchema, locale: z.string().max(20).optional(), expectedRevision: z.number().int().positive().optional() });
