import type { ProfileEntry } from '@/components/profile-entry-form';

export type ApprovedImprovementFact = ProfileEntry & { approvalStatus: string };
export type ImprovementText = { text: string; evidence: string[] };

export function formatImprovementCopy(text: string, evidence: string[], evidenceLabel: string) {
  return `${text}\n\n${evidenceLabel}:\n${evidence.map((item) => `• ${item}`).join('\n')}`;
}

/** Builds copyable profile material only from facts the person has approved. */
export function buildProfileImprovement(facts: ApprovedImprovementFact[], locale: 'es' | 'en') {
  const approved = facts.filter((fact) => fact.approvalStatus === 'USER_APPROVED');
  const experiences = approved.filter((fact) => fact.kind === 'experience');
  const structuredExperiences = experiences.filter((fact) => fact.details?.type === 'employment' && fact.details.title.trim());
  const summaries = approved.filter((fact) => fact.kind === 'summary' && fact.statement.trim());

  const headlineVariants: ImprovementText[] = structuredExperiences.map((fact) => {
      const role = fact.details!.title.trim();
      const skills = [...new Set(fact.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 2);
      return { text: [role, ...skills].join(' · '), evidence: [fact.statement] };
    });

  const aboutDraft: ImprovementText[] = summaries.length
    ? [{ text: summaries.map((fact) => fact.statement.trim()).join('\n\n'), evidence: summaries.map((fact) => fact.statement) }]
    : structuredExperiences.length
      ? [{
        text: structuredExperiences
          .map((fact) => locale === 'es'
            ? `Experiencia en ${fact.details!.title.trim()}${fact.details!.organization.trim() ? ` en ${fact.details!.organization.trim()}` : ''}.`
            : `Experience in ${fact.details!.title.trim()}${fact.details!.organization.trim() ? ` at ${fact.details!.organization.trim()}` : ''}.`)
          .join(' '),
        evidence: structuredExperiences.map((fact) => fact.statement),
      }]
      : [];

  const experienceBullets = experiences
    .filter((fact) => fact.statement.trim())
    .map((fact) => ({ text: fact.statement.trim(), evidence: [fact.statement] }));

  return { headlineVariants, aboutDraft, experienceBullets };
}
