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
