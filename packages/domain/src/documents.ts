import { printedStatement, type PrintableFact } from './entries.js';
import type { PrintedIdentity } from './profile.js';

export type DocumentLanguage = 'es' | 'en';

const sectionNames: Record<string, Record<DocumentLanguage, string>> = {
  achievement: { en: 'Achievements', es: 'Logros' }, experience: { en: 'Work experience', es: 'Experiencia laboral' }, skill_evidence: { en: 'Technical experience', es: 'Experiencia técnica' },
  skill: { en: 'Skills', es: 'Competencias' }, education: { en: 'Education', es: 'Formación' }, project: { en: 'Projects', es: 'Proyectos' }, certification: { en: 'Certifications', es: 'Certificaciones' }, language: { en: 'Languages', es: 'Idiomas' },
};

/** Visible resume copy. Generated drafts are never described as reviewed: review happens after generation, in the app. */
export function resumeLabels(language: DocumentLanguage) {
  return language === 'es'
    ? { defaultName: 'Perfil profesional', defaultRole: 'Experiencia profesional', footer: 'Borrador generado a partir de tus datos aprobados · revísalo antes de enviarlo' }
    : { defaultName: 'Professional profile', defaultRole: 'Professional experience', footer: 'Draft generated from your approved facts · review it before sending' };
}

export function resumeSectionName(kind: string, language: DocumentLanguage) {
  const known = sectionNames[kind]?.[language];
  if (known) return known;
  const words = kind.replaceAll('_', ' ').trim();
  return words ? words.charAt(0).toLocaleUpperCase(language) + words.slice(1) : '';
}

export type PrintedClaim = { text: string; sourceFactIds: string[] };
/** A current, user-approved fact that a PDF claim points to: the same row (direct) or an exact copy carried into a newer profile revision. */
export type CurrentSource = { fact: PrintableFact; direct: boolean };

/**
 * Whether an existing PDF still prints exactly what the current profile would print for the same claims, so it can be
 * approved or reused without regenerating it. Changes to fields the generator never prints (job preferences, country,
 * locale) keep it current. A different printed name or email, an edited, rejected, archived or missing source fact, a
 * claim without evidence or a claim whose printed text differs make it stale.
 */
export function printedContentCurrent(input: {
  claims: PrintedClaim[]; language: DocumentLanguage | null; sameRevision: boolean;
  basisIdentity: PrintedIdentity | null; currentIdentity: PrintedIdentity | null;
  currentSource: (sourceFactId: string) => CurrentSource | undefined;
}): boolean {
  if (!input.claims.length) return false;
  if (!input.sameRevision) {
    if (!input.basisIdentity || !input.currentIdentity) return false;
    if (input.basisIdentity.fullName !== input.currentIdentity.fullName || input.basisIdentity.email !== input.currentIdentity.email) return false;
  }
  const languages: DocumentLanguage[] = input.language ? [input.language] : ['es', 'en'];
  return input.claims.every((claim) => claim.sourceFactIds.length > 0 && claim.sourceFactIds.every((id) => {
    const source = input.currentSource(id);
    if (!source) return false;
    // Unchanged behaviour for the revision the PDF was generated from; carried-over copies must also print the same text.
    if (source.direct && input.sameRevision) return true;
    return claim.sourceFactIds.length === 1 && languages.some((language) => printedStatement(source.fact, language) === claim.text);
  }));
}
