export type Requirement = { text: string; hard: boolean; skillTags?: string[] };
export type CandidateEvidence = { id: string; text: string; tags: string[]; approval: 'USER_APPROVED' | 'SUGGESTED' | 'REJECTED' };
export type EligibilityResult = { state: 'PASS' | 'FAIL' | 'NEEDS_REVIEW'; reasons: string[] };

const skillAliases: Array<[string, string[]]> = [
  ['java', ['java']], ['kotlin', ['kotlin']], ['python', ['python']], ['typescript', ['typescript']], ['javascript', ['javascript']],
  ['sql', ['sql', 'postgresql', 'mysql']], ['rest-assured', ['rest assured', 'rest-assured']], ['api-testing', ['api testing', 'api test']],
  ['playwright', ['playwright']], ['cypress', ['cypress']], ['selenium', ['selenium']], ['jenkins', ['jenkins']],
  ['ci-cd', ['ci/cd', 'continuous integration', 'continuous delivery']], ['docker', ['docker']], ['kubernetes', ['kubernetes']],
  ['aws', ['aws', 'amazon web services']], ['azure', ['azure']], ['gcp', ['gcp', 'google cloud']], ['git', ['git']],
  ['agile', ['agile', 'scrum']], ['linux', ['linux']], ['graphql', ['graphql']], ['react', ['react']], ['node.js', ['node.js', 'nodejs']],
];
const aliasesBySkill = new Map(skillAliases.map(([skill, aliases]) => [normalize(skill), [skill, ...aliases].map(normalize)]));

export function normalize(text: string) { return text.toLocaleLowerCase('en').normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}+#.]+/gu, ' ').replace(/\.(?=\s|$)/gu, '').trim(); }

const termPatterns = new Map<string, RegExp>();
/** Whole-term match on normalized text: "java" does not match "javascript", "git" does not match "digital" or "github". */
export function containsTerm(text: string, term: string): boolean {
  const needle = normalize(term);
  if (!needle) return false;
  let pattern = termPatterns.get(needle);
  if (!pattern) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
    pattern = new RegExp(`(?<![\\p{L}\\p{N}+#])(?<![\\p{L}\\p{N}]\\.)${escaped}(?![\\p{L}\\p{N}+#])(?!\\.[\\p{L}\\p{N}])`, 'u');
    if (termPatterns.size > 2_000) termPatterns.clear();
    termPatterns.set(needle, pattern);
  }
  return pattern.test(normalize(text));
}

export function extractKnownSkills(description: string | null): Requirement[] {
  if (!description) return [];
  const text = normalize(description);
  return skillAliases.filter(([, aliases]) => aliases.some((alias) => containsTerm(text, alias))).map(([skill]) => ({ text: skill, hard: false, skillTags: [skill] }));
}

function requirementTerms(req: Requirement) {
  const terms = new Set<string>();
  for (const tag of [...(req.skillTags ?? []), req.text]) {
    const key = normalize(tag);
    if (!key) continue;
    for (const alias of aliasesBySkill.get(key) ?? [key]) terms.add(alias);
  }
  return [...terms];
}

/** True when an approved fact supports the requirement by tag or by a whole-term mention in its statement. */
export function factCoversRequirement(fact: CandidateEvidence, req: Requirement) {
  const terms = requirementTerms(req);
  const tags = fact.tags.map(normalize);
  return terms.some((term) => tags.includes(term) || containsTerm(fact.text, term));
}

const approvedOnly = (evidence: CandidateEvidence[]) => evidence.filter((fact) => fact.approval === 'USER_APPROVED');

export function evaluateEligibility(input: { requirements: Requirement[]; evidence: CandidateEvidence[]; locationKnown: boolean; locationCompatible: boolean | null; authorizationKnown?: boolean }): EligibilityResult {
  const reasons: string[] = [];
  if (input.locationCompatible === false) reasons.push('LOCATION_INCOMPATIBLE');
  else if (!input.locationKnown || input.locationCompatible === null) reasons.push('LOCATION_UNCLEAR');
  if (input.authorizationKnown === false) reasons.push('AUTHORIZATION_UNANSWERED');
  const approved = approvedOnly(input.evidence);
  for (const req of input.requirements.filter((item) => item.hard)) {
    if (!approved.some((fact) => factCoversRequirement(fact, req))) reasons.push('REQUIRED_EVIDENCE_MISSING');
  }
  if (reasons.includes('LOCATION_INCOMPATIBLE')) return { state: 'FAIL', reasons: [...new Set(reasons)] };
  return reasons.length ? { state: 'NEEDS_REVIEW', reasons: [...new Set(reasons)] } : { state: 'PASS', reasons: [] };
}

export function scoreFit(input: { requirements: Requirement[]; evidence: CandidateEvidence[]; titleAlignment: number; experienceAlignment: number; domainAlignment: number }) {
  const approved = approvedOnly(input.evidence);
  const required = input.requirements.filter((item) => item.hard);
  const preferred = input.requirements.filter((item) => !item.hard);
  const covered = (req: Requirement) => approved.some((fact) => factCoversRequirement(fact, req));
  const evaluable: Array<[number, number]> = [];
  if (required.length) evaluable.push([40, required.filter(covered).length / required.length]);
  if (input.experienceAlignment >= 0) evaluable.push([25, clamp(input.experienceAlignment)]);
  if (input.titleAlignment >= 0) evaluable.push([15, clamp(input.titleAlignment)]);
  if (preferred.length) evaluable.push([10, preferred.filter(covered).length / preferred.length]);
  if (input.domainAlignment >= 0) evaluable.push([10, clamp(input.domainAlignment)]);
  const weight = evaluable.reduce((n, [w]) => n + w, 0);
  const score = weight ? evaluable.reduce((n, [w, v]) => n + w * v, 0) / weight : null;
  return { fitScore: score === null ? null : Math.round(score * 100), evidenceCoverage: Math.round(weight / 100 * 100), provisional: weight < 50 };
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));

const titleStopWords = new Set(['and', 'of', 'the', 'for', 'in', 'a', 'an', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'en', 'para', '/', '-']);
const titleTokens = (text: string) => normalize(text).split(' ').filter((token) => token && !titleStopWords.has(token));

/** 1 when a target title appears as a whole phrase; otherwise the best share of a target's words present as whole words. -1 when no targets are set. */
export function titleAlignment(jobTitle: string, targetTitles: string[]): { alignment: number; matchedTargetTitle: string | null } {
  const targets = targetTitles.map((title) => title.trim()).filter(Boolean);
  if (!targets.length) return { alignment: -1, matchedTargetTitle: null };
  const jobTokens = new Set(titleTokens(jobTitle));
  let best = 0; let matched: string | null = null;
  for (const target of targets) {
    let value = containsTerm(jobTitle, target) ? 1 : 0;
    if (value < 1) {
      const tokens = titleTokens(target);
      value = tokens.length ? tokens.filter((token) => jobTokens.has(token)).length / tokens.length : 0;
    }
    if (value > best) { best = value; matched = target; }
  }
  return { alignment: Math.round(best * 100) / 100, matchedTargetTitle: best > 0 ? matched : null };
}

const countryNames: Record<string, string[]> = {
  es: ['spain', 'españa', 'espana'], gb: ['united kingdom', 'uk', 'england', 'scotland', 'wales'], uk: ['united kingdom', 'uk', 'england'], us: ['united states', 'usa', 'us', 'u.s', 'u.s.a'],
  de: ['germany', 'deutschland', 'alemania'], fr: ['france', 'francia'], pt: ['portugal'], it: ['italy', 'italia'], nl: ['netherlands', 'países bajos', 'paises bajos'], ie: ['ireland', 'irlanda'], mx: ['mexico', 'méxico'], ar: ['argentina'],
  ca: ['canada', 'canadá'], br: ['brazil', 'brasil'], in: ['india'], pl: ['poland', 'polonia'],
};
const remoteTerms = ['remote', 'remoto', 'teletrabajo', 'work from home', 'wfh'];
const worldwideTerms = ['worldwide', 'anywhere', 'global', 'globally', 'any country', 'international', 'todo el mundo', 'cualquier país', 'cualquier pais'];
const restrictionTerms = ['only', 'based in', 'based', 'within', 'resident', 'residents', 'eligible', 'located in', 'must be located', 'solo', 'sólo', 'residentes', 'únicamente', 'unicamente', 'timezone', 'time zone', 'est', 'pst', 'cet'];

function countryTerms(country: string) {
  const key = normalize(country);
  if (!key) return [];
  if (key.length === 2) return countryNames[key] ?? [];
  return [key, ...(Object.values(countryNames).find((list) => list.map(normalize).includes(key)) ?? [])];
}

/**
 * Never infers incompatibility: returns true only on positive evidence, otherwise null (needs review).
 * Remote roles are compatible only when they name the user's country, or are explicitly worldwide with no restriction;
 * "Remote US only" stays unknown for a user in Spain.
 */
export function locationCompatibility(location: string | null, preferences: { country?: string | null; workModes?: string[] }) {
  const unknown = { known: Boolean(location?.trim()), compatible: null as boolean | null };
  if (!location || !location.trim()) return unknown;
  const own = new Set(countryTerms(preferences.country ?? '').map(normalize));
  const mentionsOwn = [...own].some((term) => containsTerm(location, term));
  const mentionsOther = Object.values(countryNames).flat().map(normalize).some((term) => !own.has(term) && containsTerm(location, term));
  const restricted = restrictionTerms.some((term) => containsTerm(location, term));
  // Naming the user's country is positive unless the posting restricts to somewhere else as well ("Spain or US only" stays conservative).
  if (mentionsOwn && !(restricted && mentionsOther)) return { known: true, compatible: true as boolean | null };
  const wantsRemote = (preferences.workModes ?? []).some((mode) => remoteTerms.some((term) => containsTerm(mode, term)));
  const remote = remoteTerms.some((term) => containsTerm(location, term));
  const worldwide = worldwideTerms.some((term) => containsTerm(location, term));
  if (wantsRemote && remote && worldwide && !restricted && !mentionsOther) return { known: true, compatible: true as boolean | null };
  return unknown;
}

export type MatchingContext = {
  evidence: CandidateEvidence[];
  targetTitles: string[];
  workModes: string[];
  country: string | null;
  authorizationKnown: boolean;
  profileRevision: number;
};

export type JobMatch = {
  fitScore: number | null;
  evidenceCoverage: number;
  provisional: boolean;
  eligibility: EligibilityResult['state'];
  reasons: string[];
  match: { titleAlignment: number | null; matchedTargetTitle: string | null; matchedSkills: string[]; missingSkills: string[]; approvedFactCount: number; targetTitles: string[]; profileRevision: number; notes: string[] };
};

/** Recomputes a job's score and explanation from the current approved facts and preferences. Deterministic and side-effect free. */
export function computeJobMatch(job: { title: string; location: string | null; description: string | null }, context: MatchingContext): JobMatch {
  const approved = approvedOnly(context.evidence);
  const requirements = extractKnownSkills(job.description);
  const title = titleAlignment(job.title, context.targetTitles);
  const location = locationCompatibility(job.location, { country: context.country, workModes: context.workModes });
  const fit = scoreFit({ requirements, evidence: approved, titleAlignment: title.alignment, experienceAlignment: -1, domainAlignment: -1 });
  const eligibility = evaluateEligibility({ requirements: requirements.filter((req) => req.hard), evidence: approved, locationKnown: location.known, locationCompatible: location.compatible, authorizationKnown: context.authorizationKnown });
  const matchedSkills = requirements.filter((req) => approved.some((fact) => factCoversRequirement(fact, req))).map((req) => req.text);
  const missingSkills = requirements.filter((req) => !matchedSkills.includes(req.text)).map((req) => req.text);
  const notes: string[] = [];
  if (!context.targetTitles.length) notes.push('NO_TARGET_TITLES');
  if (!approved.length) notes.push('NO_APPROVED_FACTS');
  if (!job.description) notes.push('NO_JOB_DESCRIPTION');
  else if (!requirements.length) notes.push('NO_KNOWN_SKILLS_IN_DESCRIPTION');
  if (fit.provisional) notes.push('PROVISIONAL_LOW_EVIDENCE');
  return {
    fitScore: fit.fitScore, evidenceCoverage: fit.evidenceCoverage, provisional: fit.provisional, eligibility: eligibility.state, reasons: eligibility.reasons,
    match: { titleAlignment: title.alignment < 0 ? null : title.alignment, matchedTargetTitle: title.matchedTargetTitle, matchedSkills, missingSkills, approvedFactCount: approved.length, targetTitles: context.targetTitles, profileRevision: context.profileRevision, notes },
  };
}
