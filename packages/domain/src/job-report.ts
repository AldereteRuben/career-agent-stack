/**
 * Job evaluation report (issues #109 and #110). Deterministic and side-effect free: it reads one job and the person's
 * approved facts and preferences, and explains in words whether the job looks worth applying to. It never invents
 * experience, never uses suggested or rejected facts and never gives a number that could read as a hiring probability.
 * Assistant help is separate and needs its own consent; this report always works without it.
 */
import { containsTerm, extractKnownSkills, factCoversRequirement, locationCompatibility, normalize, requirementTerms, titleAlignment, type CandidateEvidence, type MatchingContext } from './matching.js';

export const JOB_REPORT_VERSION = 1 as const;

/** Exactly three conclusions, most favourable first. */
export const jobReportVerdicts = ['GOOD_OPTION', 'REVIEW', 'PROBABLY_NOT_A_FIT'] as const;
export type JobReportVerdict = (typeof jobReportVerdicts)[number];
export const jobReportVerdictRank = (verdict: JobReportVerdict) => jobReportVerdicts.indexOf(verdict);

/** Why the conclusion was reached. */
export const jobReportReasons = [
  'MOST_REQUIREMENTS_SUPPORTED', 'TITLE_MATCHES_TARGET', 'NOT_ENOUGH_INFORMATION', 'SOME_REQUIREMENTS_UNCONFIRMED', 'REQUIRED_SKILL_UNCONFIRMED',
  'TITLE_NOT_COMPARED', 'TITLE_NOT_TARGETED', 'FEW_REQUIREMENTS_SUPPORTED', 'LOCATION_TO_CONFIRM', 'LOCATION_INCOMPATIBLE', 'WORK_MODE_DIFFERS',
] as const;
export type JobReportReason = (typeof jobReportReasons)[number];

/** What the report could not know. Listed explicitly instead of being guessed. */
export const jobReportUnknowns = [
  'NO_JOB_DESCRIPTION', 'NO_CLEAR_REQUIREMENTS', 'NO_APPROVED_FACTS', 'NO_TARGET_TITLES', 'LOCATION_NOT_STATED', 'LOCATION_UNCLEAR',
  'SALARY_NOT_STATED', 'WORK_MODE_NOT_STATED', 'WORK_AUTHORIZATION_UNANSWERED',
] as const;
export type JobReportUnknown = (typeof jobReportUnknowns)[number];

export const jobReportCheckKinds = ['SALARY', 'WORK_MODE', 'LOCATION'] as const;
export const jobReportCheckStatuses = ['STATED', 'NOT_STATED', 'MATCHES_PREFERENCE', 'DIFFERS_FROM_PREFERENCE', 'TO_CONFIRM'] as const;
export type JobReportCheck = { kind: (typeof jobReportCheckKinds)[number]; status: (typeof jobReportCheckStatuses)[number]; value: string | null };

export const jobReportRequirementLevels = ['REQUIRED', 'PREFERRED', 'UNSPECIFIED'] as const;
export type JobReportRequirement = {
  skill: string;
  level: (typeof jobReportRequirementLevels)[number];
  /** The sentence of the posting that mentions it, so the person can check it. */
  jobExcerpt: string | null;
  /** Approved facts that mention it. Empty for requirements not confirmed yet. */
  facts: Array<{ factId: string; text: string }>;
};

export type JobReport = {
  version: typeof JOB_REPORT_VERSION;
  verdict: JobReportVerdict;
  reasons: JobReportReason[];
  /** 1. What the job asks for and the confirmed experience that supports it. */
  supported: JobReportRequirement[];
  /** 2. What the job asks for that is not confirmed yet. */
  unconfirmed: JobReportRequirement[];
  /** 3. Details worth checking before applying. */
  checks: JobReportCheck[];
  unknowns: JobReportUnknown[];
  title: { matchedTargetTitle: string | null; compared: boolean };
  basis: { profileRevision: number; approvedFactCount: number };
};

const EXCERPT_LENGTH = 240;
const FACT_LENGTH = 280;
const FACTS_PER_REQUIREMENT = 3;

const shorten = (value: string, max: number) => {
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
/** Lines and sentences of a posting; bullets count as their own sentence. */
const sentences = (description: string) => description.split(/\n+|(?<=[.!?;])\s+/u).map((part) => part.replace(/^[\s•*·-]+/u, '').trim()).filter(Boolean);
const firstMatchingSentence = (parts: string[], accept: (sentence: string) => boolean) => parts.find(accept) ?? null;
const firstSentence = (parts: string[], accept: (sentence: string) => boolean) => {
  const found = firstMatchingSentence(parts, accept);
  return found ? shorten(found, EXCERPT_LENGTH) : null;
};

const preferredMarkers = ['nice to have', 'nice-to-have', 'preferred', 'a plus', 'bonus', 'plus', 'desirable', 'deseable', 'valorable', 'se valora', 'valoraremos', 'opcional', 'optional'];
const requiredMarkers = ['required', 'requirement', 'requirements', 'must', 'mandatory', 'essential', 'requisito', 'requisitos', 'imprescindible', 'obligatorio', 'necesario', 'necesaria'];
function requirementLevel(excerpt: string | null, parts: string[]): JobReportRequirement['level'] {
  if (!excerpt) return 'UNSPECIFIED';
  if (preferredMarkers.some((marker) => containsTerm(excerpt, marker))) return 'PREFERRED';
  if (requiredMarkers.some((marker) => containsTerm(excerpt, marker))) return 'REQUIRED';
  const index = parts.indexOf(excerpt);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previous = parts[cursor]!.trim();
    const heading = previous.replace(/:$/u, '').toLocaleLowerCase();
    if (!/^[\p{L}\p{N}\s&/’'-]{2,64}$/u.test(heading)) continue;
    if (/^(?:nice to have|preferred(?: qualifications?)?|desired(?: qualifications?)?|deseable(?:s)?|valorables?)$/u.test(heading)) return 'PREFERRED';
    if (/^(?:requirements?|minimum requirements?|required qualifications?|qualifications?|must[- ]have|requisitos?|requisitos mínimos|requisitos imprescindibles|requisitos obligatorios|imprescindibles)$/u.test(heading)) return 'REQUIRED';
    // A different colon heading ends the previous section's classification.
    if (previous.endsWith(':')) return 'UNSPECIFIED';
  }
  return 'UNSPECIFIED';
}

/** Mentions of pay. ES/EN heuristic: a word about salary or an amount with a currency. */
const salaryPattern = /(salar|sueldo|compensation|retribu|remunera|\bpay\b|\bpaid\b|[€$£]\s?\d|\d\s?(?:k|mil)?\s?(?:[€$£]|(?:eur|euros?|usd|gbp)\b))/iu;
const workModeTerms: Record<'remote' | 'hybrid' | 'onsite', string[]> = {
  remote: ['remote', 'remoto', 'remota', 'teletrabajo', 'work from home', 'wfh'],
  hybrid: ['hybrid', 'híbrido', 'hibrido', 'híbrida', 'hibrida'],
  onsite: ['on-site', 'onsite', 'on site', 'in office', 'in-office', 'office based', 'presencial', 'en oficina'],
};
const modesIn = (text: string) => (Object.keys(workModeTerms) as Array<keyof typeof workModeTerms>).filter((mode) => workModeTerms[mode].some((term) => containsTerm(text, term)));
const preferredModes = (workModes: string[]) => new Set(workModes.flatMap((mode) => {
  const key = normalize(mode);
  return key in workModeTerms ? [key as keyof typeof workModeTerms] : modesIn(mode);
}));

function workModeCheck(location: string | null, parts: string[], workModes: string[]): JobReportCheck {
  const fromLocation = location ? modesIn(location) : [];
  const excerpt = fromLocation.length ? shorten(location!, EXCERPT_LENGTH) : firstSentence(parts, (sentence) => modesIn(sentence).length > 0);
  const offered = fromLocation.length ? fromLocation : excerpt ? modesIn(excerpt) : [];
  if (!offered.length) return { kind: 'WORK_MODE', status: 'NOT_STATED', value: null };
  const wanted = preferredModes(workModes);
  if (!wanted.size) return { kind: 'WORK_MODE', status: 'STATED', value: excerpt };
  return { kind: 'WORK_MODE', status: offered.some((mode) => wanted.has(mode)) ? 'MATCHES_PREFERENCE' : 'DIFFERS_FROM_PREFERENCE', value: excerpt };
}

/** Builds the report for one job from the current approved facts and preferences. */
export function buildJobReport(job: { title: string; location: string | null; description: string | null }, context: MatchingContext): JobReport {
  const approved: CandidateEvidence[] = context.evidence.filter((fact) => fact.approval === 'USER_APPROVED');
  const description = job.description?.trim() ? job.description : null;
  const parts = description ? sentences(description) : [];
  const requirements: JobReportRequirement[] = extractKnownSkills(description).map((requirement) => {
    const terms = requirementTerms(requirement);
    // Keep the original posting sentence for classification. The display excerpt is normalized and may be shortened,
    // so looking it up in `parts` can lose its heading context or turn a mandatory requirement into UNSPECIFIED.
    const matchedSentence = firstMatchingSentence(parts, (sentence) => terms.some((term) => containsTerm(sentence, term)));
    const jobExcerpt = matchedSentence ? shorten(matchedSentence, EXCERPT_LENGTH) : null;
    const facts = approved.filter((fact) => factCoversRequirement(fact, requirement)).slice(0, FACTS_PER_REQUIREMENT).map((fact) => ({ factId: fact.id, text: shorten(fact.text, FACT_LENGTH) }));
    return { skill: requirement.text, level: requirementLevel(matchedSentence, parts), jobExcerpt, facts };
  });
  const supported = requirements.filter((requirement) => requirement.facts.length);
  const unconfirmed = requirements.filter((requirement) => !requirement.facts.length);

  const title = titleAlignment(job.title, context.targetTitles);
  const titleTargeted = title.alignment < 0 ? null : title.alignment >= 0.5;
  const location = locationCompatibility(job.location, { country: context.country, workModes: context.workModes });
  const salaryExcerpt = firstSentence(parts, (sentence) => salaryPattern.test(sentence));
  const workMode = workModeCheck(job.location, parts, context.workModes);
  const locationCheck: JobReportCheck = !location.known ? { kind: 'LOCATION', status: 'NOT_STATED', value: null }
    : { kind: 'LOCATION', status: location.compatible === true ? 'MATCHES_PREFERENCE' : location.compatible === false ? 'DIFFERS_FROM_PREFERENCE' : 'TO_CONFIRM', value: shorten(job.location!, EXCERPT_LENGTH) };
  const checks: JobReportCheck[] = [{ kind: 'SALARY', status: salaryExcerpt ? 'STATED' : 'NOT_STATED', value: salaryExcerpt }, workMode, locationCheck];

  const unknowns: JobReportUnknown[] = [];
  if (!description) unknowns.push('NO_JOB_DESCRIPTION');
  else if (!requirements.length) unknowns.push('NO_CLEAR_REQUIREMENTS');
  if (!approved.length) unknowns.push('NO_APPROVED_FACTS');
  if (titleTargeted === null) unknowns.push('NO_TARGET_TITLES');
  if (locationCheck.status === 'NOT_STATED') unknowns.push('LOCATION_NOT_STATED');
  else if (locationCheck.status === 'TO_CONFIRM') unknowns.push('LOCATION_UNCLEAR');
  if (!salaryExcerpt) unknowns.push('SALARY_NOT_STATED');
  if (workMode.status === 'NOT_STATED') unknowns.push('WORK_MODE_NOT_STATED');
  // Work authorization is jurisdiction-specific and never inferred.
  if (!context.authorizationKnown) unknowns.push('WORK_AUTHORIZATION_UNANSWERED');

  const { verdict, reasons } = conclude({ requirements: requirements.length, supported: supported.length, requiredUnconfirmed: unconfirmed.some((requirement) => requirement.level === 'REQUIRED'), approvedFacts: approved.length, hasDescription: Boolean(description), titleTargeted, location: locationCheck.status, workMode: workMode.status });
  return { version: JOB_REPORT_VERSION, verdict, reasons, supported, unconfirmed, checks, unknowns, title: { matchedTargetTitle: title.matchedTargetTitle, compared: titleTargeted !== null }, basis: { profileRevision: context.profileRevision, approvedFactCount: approved.length } };
}

type Evidence = {
  requirements: number; supported: number; requiredUnconfirmed: boolean; approvedFacts: number; hasDescription: boolean;
  titleTargeted: boolean | null; location: JobReportCheck['status']; workMode: JobReportCheck['status'];
};

/**
 * Conservative rules. "Good option" needs positive evidence on every axis the report can read: most recognised
 * requirements backed by approved facts, no required skill unconfirmed, a title among the person's targets and no
 * open question about where or how the job is done. "Probably not a fit" needs evidence against it, never a lack of
 * data: a job the report cannot read stays "review".
 */
function conclude(input: Evidence): { verdict: JobReportVerdict; reasons: JobReportReason[] } {
  if (input.location === 'DIFFERS_FROM_PREFERENCE') return { verdict: 'PROBABLY_NOT_A_FIT', reasons: ['LOCATION_INCOMPATIBLE'] };
  if (!input.hasDescription || !input.requirements || !input.approvedFacts) {
    return { verdict: 'REVIEW', reasons: ['NOT_ENOUGH_INFORMATION', ...(input.titleTargeted === false ? ['TITLE_NOT_TARGETED' as const] : [])] };
  }
  const share = input.supported / input.requirements;
  if (input.titleTargeted === false && share <= 1 / 3) return { verdict: 'PROBABLY_NOT_A_FIT', reasons: ['TITLE_NOT_TARGETED', 'FEW_REQUIREMENTS_SUPPORTED'] };
  if (input.requirements >= 3 && input.supported === 0) return { verdict: 'PROBABLY_NOT_A_FIT', reasons: ['FEW_REQUIREMENTS_SUPPORTED'] };
  const reasons: JobReportReason[] = [];
  if (share >= 2 / 3) reasons.push('MOST_REQUIREMENTS_SUPPORTED');
  else reasons.push('SOME_REQUIREMENTS_UNCONFIRMED');
  if (input.requiredUnconfirmed) reasons.push('REQUIRED_SKILL_UNCONFIRMED');
  if (input.titleTargeted === true) reasons.push('TITLE_MATCHES_TARGET');
  else reasons.push(input.titleTargeted === null ? 'TITLE_NOT_COMPARED' : 'TITLE_NOT_TARGETED');
  if (input.location === 'TO_CONFIRM') reasons.push('LOCATION_TO_CONFIRM');
  if (input.workMode === 'DIFFERS_FROM_PREFERENCE') reasons.push('WORK_MODE_DIFFERS');
  const good = share >= 2 / 3 && !input.requiredUnconfirmed && input.titleTargeted === true && input.location === 'MATCHES_PREFERENCE' && input.workMode !== 'DIFFERS_FROM_PREFERENCE';
  return { verdict: good ? 'GOOD_OPTION' : 'REVIEW', reasons };
}

// ---------------------------------------------------------------------------------------------------------------------
// Batches (#110): several saved jobs evaluated in one action, in bounded passes, pausable and cancellable.

export const JOB_REPORT_BATCH_LIMITS = Object.freeze({
  /** Jobs one batch may hold. */
  maxJobs: 50,
  /** Jobs evaluated per pass, the same pass size as automatic analysis (AI_LIMITS.automaticReservationsPerPass). */
  perPass: 5,
});
export const jobReportBatchStates = ['RUNNING', 'PAUSED', 'CANCELLED', 'COMPLETED'] as const;
export type JobReportBatchState = (typeof jobReportBatchStates)[number];
export const jobReportBatchItemStates = ['PENDING', 'DONE', 'FAILED', 'SKIPPED'] as const;
export type JobReportBatchItemState = (typeof jobReportBatchItemStates)[number];
/** Why an item failed or was skipped. */
export const jobReportBatchItemErrors = ['JOB_NOT_FOUND', 'JOB_ARCHIVED', 'REPORT_FAILED', 'CANCELLED'] as const;
export type JobReportBatchItemError = (typeof jobReportBatchItemErrors)[number];
export type JobReportBatchAction = 'pause' | 'resume' | 'cancel';

/** The state an action leads to. Repeating the action that produced the current state changes nothing. */
export function jobReportBatchTransition(state: JobReportBatchState, action: JobReportBatchAction): { ok: true; state: JobReportBatchState; changed: boolean } | { ok: false } {
  const target: JobReportBatchState = action === 'pause' ? 'PAUSED' : action === 'resume' ? 'RUNNING' : 'CANCELLED';
  if (state === target) return { ok: true, state, changed: false };
  if (state === 'COMPLETED' || state === 'CANCELLED') return { ok: false };
  if (action === 'pause' && state !== 'RUNNING') return { ok: false };
  if (action === 'resume' && state !== 'PAUSED') return { ok: false };
  return { ok: true, state: target, changed: true };
}

/**
 * Most favourable conclusions first, then the jobs that could not be evaluated, then those still waiting.
 * Nothing is hidden; ties keep the order the person chose.
 */
export function sortJobReportBatchItems<T extends { status: JobReportBatchItemState; verdict: JobReportVerdict | null; position: number }>(items: T[]): T[] {
  const group = (item: T) => item.status === 'DONE' && item.verdict ? jobReportVerdictRank(item.verdict) : item.status === 'FAILED' ? 3 : item.status === 'SKIPPED' ? 4 : 5;
  return [...items].sort((a, b) => group(a) - group(b) || a.position - b.position);
}
