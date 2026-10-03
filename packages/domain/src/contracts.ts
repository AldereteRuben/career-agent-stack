import { z } from 'zod';
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

export const factSchema = z.object({ kind: z.string().min(1).max(64), statement: z.string().trim().min(1).max(4000), tags: z.array(z.string().min(1).max(80)).max(40).default([]), source: z.enum(['USER_ENTERED', 'IMPORTED_SUGGESTION']).default('USER_ENTERED'), approvalStatus: z.enum(factApproval).default('SUGGESTED'), employment: employmentSchema.optional() }).strict()
  .refine((fact) => !fact.employment || fact.kind === 'experience', { path: ['employment'], message: 'Employment fields are only supported for work experience.' })
  .transform((fact) => {
    if (!fact.employment) return fact;
    const job = fact.employment;
    const month = (value: string) => `${value.slice(5)}/${value.slice(0, 4)}`;
    // Save one reviewable snapshot: dates and employer travel with the approved text into exports and PDFs.
    const dates = `${month(job.startMonth)} - ${job.current ? (job.locale === 'es' ? 'Actualidad' : 'Present') : month(job.endMonth!)}`;
    return { ...fact, statement: `${job.role} · ${job.company}\n${dates}\n${fact.statement}` };
  }).refine((fact) => fact.statement.length <= 4000, { path: ['statement'], message: 'Work experience including dates must fit within 4000 characters.' });

export const answerSchema = z.object({ semanticKey: z.string().min(1).max(100), jurisdiction: z.string().length(2), questionScope: z.string().min(1).max(160), value: z.unknown().nullable(), strategy: z.enum(['EXACT_APPROVED', 'DERIVED_RULE', 'DRAFT_FOR_REVIEW', 'ASK_USER', 'LEAVE_OPTIONAL_BLANK']), approvalStatus: z.enum(['UNANSWERED', 'USER_APPROVED']).default('UNANSWERED'), reviewAfter: z.string().datetime().nullable().default(null), questionText: z.string().trim().max(500).nullable().default(null) }).strict();
export const jobImportSchema = z.object({ title: z.string().min(1).max(300), company: z.string().min(1).max(200), location: z.string().max(300).nullable().default(null), description: z.string().max(50000).nullable().default(null), jobUrl: z.string().url(), applyUrl: z.string().url().nullable().default(null), sourcePostedAt: z.string().datetime().nullable().default(null) }).strict();
export const applicationSchema = z.object({ jobId: z.string().uuid().nullable().default(null), company: z.string().min(1).max(200), role: z.string().min(1).max(300), location: z.string().max(300).nullable().default(null), canonicalUrl: z.string().url().nullable().default(null), state: z.enum(applicationState).default('DRAFT'), confirmationEvidence: z.literal('USER_ATTESTATION').optional(), recruitmentStage: z.enum(recruitmentStage).default('NO_RESPONSE'), shortlistDecision: z.enum(shortlistDecision).default('UNREVIEWED'), notes: z.string().max(10000).default('') }).strict();
export const applicationUpdateSchema = z.object({ state: z.enum(applicationState).optional(), recruitmentStage: z.enum(recruitmentStage).optional(), shortlistDecision: z.enum(shortlistDecision).optional(), notes: z.string().max(10000).optional(), confirmationEvidence: z.literal('USER_ATTESTATION').optional(), correction: z.boolean().optional(), reason: z.string().trim().max(2000).optional(), expectedVersion: z.number().int().positive().optional() }).strict();
export const profileUpdateSchema = z.object({ profile: z.record(z.string(), z.unknown()), locale: z.string().max(20).optional(), expectedRevision: z.number().int().positive().optional() });
