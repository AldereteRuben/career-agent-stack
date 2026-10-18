import { buildJobReport } from './job-report.js';
import { factCoversRequirement, normalize, type MatchingContext } from './matching.js';

export type SkillGapJob = {
  id: string;
  company: string;
  title: string;
  canonicalUrl: string | null;
  location: string | null;
  description: string | null;
};

export type SkillGapReport = {
  savedJobCount: number;
  analyzedJobCount: number;
  jobsWithoutDescription: number;
  jobsWithoutRequirements: number;
  groups: Array<{
    skill: string;
    profileEvidence: 'PENDING_REVIEW' | 'NOT_IN_APPROVED_PROFILE';
    requiredJobCount: number;
    preferredJobCount: number;
    unspecifiedJobCount: number;
    jobs: Array<{ id: string; company: string; title: string; level: 'REQUIRED' | 'PREFERRED' | 'UNSPECIFIED'; excerpt: string | null }>;
  }>;
};

function uniqueJobs(jobs: SkillGapJob[]) {
  const indexByIdentity = new Map<string, number>();
  const unique: SkillGapJob[] = [];
  for (const job of jobs) {
    let identity = `id:${job.id}`;
    if (job.canonicalUrl) {
      try {
        const url = new URL(job.canonicalUrl);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          url.hash = '';
          for (const key of [...url.searchParams.keys()]) if (/^utm_/iu.test(key) || ['fbclid', 'gclid', 'gh_src'].includes(key.toLowerCase())) url.searchParams.delete(key);
          url.searchParams.sort();
          identity = `url:${url.toString()}`;
        }
      } catch { /* Keep the record identity when the stored URL is malformed. */ }
    }
    const priorIndex = indexByIdentity.get(identity);
    if (priorIndex === undefined) {
      indexByIdentity.set(identity, unique.length);
      unique.push(job);
      continue;
    }
    const prior = unique[priorIndex]!;
    if ((job.description?.trim().length ?? 0) > (prior.description?.trim().length ?? 0)) unique[priorIndex] = { ...prior, description: job.description };
  }
  return unique;
}

/** Aggregates only requirements without approved evidence across unique saved jobs. */
export function buildSkillGapReport(jobs: SkillGapJob[], context: MatchingContext): SkillGapReport {
  const unique = uniqueJobs(jobs);
  const groups = new Map<string, SkillGapReport['groups'][number]>();
  let jobsWithoutRequirements = 0;
  let jobsWithoutDescription = 0;

  for (const job of unique) {
    if (!job.description?.trim()) jobsWithoutDescription += 1;
    const report = buildJobReport(job, context);
    if (report.unknowns.includes('NO_CLEAR_REQUIREMENTS')) jobsWithoutRequirements += 1;
    for (const requirement of report.unconfirmed) {
      const key = normalize(requirement.skill);
      if (!key) continue;
      let group = groups.get(key);
      if (!group) {
        const pending = context.evidence.some((fact) => fact.approval === 'SUGGESTED' && factCoversRequirement(fact, { text: requirement.skill, hard: false, skillTags: [requirement.skill] }));
        group = { skill: requirement.skill, profileEvidence: pending ? 'PENDING_REVIEW' : 'NOT_IN_APPROVED_PROFILE', requiredJobCount: 0, preferredJobCount: 0, unspecifiedJobCount: 0, jobs: [] };
        groups.set(key, group);
      }
      if (requirement.level === 'REQUIRED') group.requiredJobCount += 1;
      else if (requirement.level === 'PREFERRED') group.preferredJobCount += 1;
      else group.unspecifiedJobCount += 1;
      group.jobs.push({ id: job.id, company: job.company, title: job.title, level: requirement.level, excerpt: requirement.jobExcerpt });
    }
  }

  const sortedGroups = [...groups.values()].sort((a, b) => {
    const countA = a.requiredJobCount + a.preferredJobCount + a.unspecifiedJobCount;
    const countB = b.requiredJobCount + b.preferredJobCount + b.unspecifiedJobCount;
    return countB - countA || a.skill.localeCompare(b.skill, 'en');
  });
  return { savedJobCount: unique.length, analyzedJobCount: unique.length - jobsWithoutDescription - jobsWithoutRequirements, jobsWithoutDescription, jobsWithoutRequirements, groups: sortedGroups };
}
