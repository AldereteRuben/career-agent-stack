import type { Locale } from './locale';

/** A bilingual string. Every label in this file must provide both languages. */
export type Bilingual = { es: string; en: string };
type LabelMap = Record<string, Bilingual>;

export const pick = (locale: Locale, text: Bilingual) => locale === 'en' ? text.en : text.es;
/** Inline copy helper: `copy(locale)('Texto', 'Text')`. */
export const copy = (locale: Locale) => (es: string, en: string) => locale === 'en' ? en : es;

const humanize = (value: string) => value.toLowerCase().replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());
function label(map: LabelMap, value: string | null | undefined, locale: Locale, fallback?: Bilingual) {
  if (!value) return fallback ? pick(locale, fallback) : '';
  const entry = map[value] ?? map[value.toUpperCase()] ?? map[value.toLowerCase()];
  return entry ? pick(locale, entry) : humanize(value);
}

export const applicationStates: LabelMap = {
  DRAFT: { es: 'Borrador', en: 'Draft' },
  PREPARING: { es: 'Preparando', en: 'Preparing' },
  REVIEW_REQUIRED: { es: 'Revisión pendiente', en: 'Needs review' },
  READY: { es: 'Lista para enviar', en: 'Ready to submit' },
  IN_PROGRESS: { es: 'Envío en curso', en: 'Submission in progress' },
  UNKNOWN: { es: 'Resultado incierto', en: 'Outcome unclear' },
  CONFIRMED: { es: 'Enviada (declarada por ti)', en: 'Applied (self-reported)' },
  CANCELLED: { es: 'Cancelada', en: 'Cancelled' },
};
/** States a user can choose by hand in v0.1 (the API rejects READY, IN_PROGRESS and UNKNOWN). */
export const selectableApplicationStates = ['DRAFT', 'PREPARING', 'REVIEW_REQUIRED', 'CONFIRMED', 'CANCELLED'] as const;

export const recruitmentStages: LabelMap = {
  NO_RESPONSE: { es: 'Sin respuesta', en: 'No response yet' },
  RECRUITER_CONTACT: { es: 'Contacto con selección', en: 'Recruiter contact' },
  ASSESSMENT: { es: 'Prueba técnica', en: 'Assessment' },
  INTERVIEW: { es: 'Entrevista', en: 'Interview' },
  FINAL_INTERVIEW: { es: 'Entrevista final', en: 'Final interview' },
  OFFER: { es: 'Oferta', en: 'Offer' },
  REJECTED: { es: 'No seleccionada', en: 'Not selected' },
  WITHDRAWN: { es: 'Retirada por ti', en: 'Withdrawn by you' },
  HIRED: { es: 'Contratada', en: 'Hired' },
};
export const recruitmentStageOrder = Object.keys(recruitmentStages);

export const applicationEvents: LabelMap = {
  APPLICATION_CREATED: { es: 'Candidatura creada', en: 'Application created' },
  MANUAL_APPLICATION_RECORDED: { es: 'Candidatura registrada como enviada', en: 'Application recorded as sent' },
  APPLICATION_STATE_CHANGED: { es: 'Estado actualizado', en: 'Status updated' },
  RECRUITMENT_STAGE_CHANGED: { es: 'Etapa actualizada', en: 'Stage updated' },
  RECRUITMENT_STAGE_CORRECTED: { es: 'Etapa corregida', en: 'Stage corrected' },
  USER_NOTE: { es: 'Nota', en: 'Note' },
};

export const factKinds: LabelMap = {
  achievement: { es: 'Logro', en: 'Achievement' },
  skill_evidence: { es: 'Experiencia técnica', en: 'Technical experience' },
  experience: { es: 'Experiencia laboral', en: 'Work experience' },
  current_employment: { es: 'Empleo actual', en: 'Current job' },
  education: { es: 'Formación', en: 'Education' },
  certification: { es: 'Certificación', en: 'Certification' },
  project: { es: 'Proyecto', en: 'Project' },
  language: { es: 'Idioma', en: 'Language' },
};
export const selectableFactKinds = ['achievement', 'skill_evidence', 'experience', 'education', 'project'] as const;

export const factApprovals: LabelMap = {
  SUGGESTED: { es: 'Pendiente de aprobar', en: 'Waiting for approval' },
  USER_APPROVED: { es: 'Aprobado por ti', en: 'Approved by you' },
  REJECTED: { es: 'Descartado', en: 'Discarded' },
};
export const answerApprovals: LabelMap = {
  UNANSWERED: { es: 'Pendiente de aprobar', en: 'Waiting for approval' },
  USER_APPROVED: { es: 'Aprobada por ti', en: 'Approved by you' },
};
export const documentApprovals: LabelMap = {
  PENDING_REVIEW: { es: 'Pendiente de revisión', en: 'Waiting for review' },
  USER_APPROVED: { es: 'Aprobado por ti', en: 'Approved by you' },
  REJECTED: { es: 'Descartado', en: 'Discarded' },
  SUPERSEDED: { es: 'Sustituido', en: 'Replaced' },
};
export const eligibilityStates: LabelMap = {
  PASS: { es: 'Compatible', en: 'Compatible' },
  FAIL: { es: 'No encaja', en: 'Not a fit' },
  NEEDS_REVIEW: { es: 'Por revisar', en: 'Needs review' },
};
export const jobAvailability: LabelMap = {
  OPEN: { es: 'Abierta', en: 'Open' },
  POSSIBLY_CLOSED: { es: 'Puede estar cerrada', en: 'May be closed' },
  CLOSED: { es: 'Cerrada', en: 'Closed' },
  UNKNOWN: { es: 'Sin comprobar', en: 'Not checked' },
};
export const shortlistDecisions: LabelMap = {
  UNREVIEWED: { es: 'Sin revisar', en: 'Not reviewed' },
  SHORTLISTED: { es: 'Guardada', en: 'Saved' },
  SKIPPED: { es: 'Descartada', en: 'Skipped' },
  ARCHIVED: { es: 'Archivada', en: 'Archived' },
};
export const workModes: LabelMap = {
  remote: { es: 'En remoto', en: 'Remote' },
  hybrid: { es: 'Híbrido', en: 'Hybrid' },
  onsite: { es: 'Presencial', en: 'On-site' },
};
const workModeAliases: Record<string, string> = { 'on-site': 'onsite', 'on site': 'onsite', office: 'onsite', presencial: 'onsite', remoto: 'remote', 'en remoto': 'remote', híbrido: 'hybrid', hibrido: 'hybrid' };
export const normalizeWorkMode = (value: string) => { const key = value.trim().toLowerCase(); return workModeAliases[key] ?? key; };

export const providerRegions: LabelMap = { global: { es: 'Global', en: 'Global' }, eu: { es: 'Unión Europea', en: 'European Union' } };

export const matchReasons: LabelMap = {
  LOCATION_INCOMPATIBLE: { es: 'La ubicación no coincide con tu país o modalidad.', en: 'The location does not match your country or work arrangement.' },
  LOCATION_UNCLEAR: { es: 'La ubicación no está clara; compruébala en la oferta.', en: 'The location is unclear; check it in the job post.' },
  AUTHORIZATION_UNANSWERED: { es: 'No sabemos si tienes permiso de trabajo para este puesto; solo tú puedes responderlo.', en: 'We do not know if you are authorized to work for this role; only you can answer that.' },
  REQUIRED_EVIDENCE_MISSING: { es: 'Falta evidencia aprobada para algún requisito obligatorio.', en: 'Approved evidence is missing for a required skill.' },
  MANUAL_IMPORT_REVIEW_REQUIRED: { es: 'Guardada a mano: revisa que los datos coinciden con la oferta.', en: 'Added manually: check that the details match the job post.' },
};
export const matchNotes: LabelMap = {
  NO_TARGET_TITLES: { es: 'Añade los puestos que buscas en tu perfil para comparar el título.', en: 'Add the roles you are looking for in your profile to compare the title.' },
  NO_APPROVED_FACTS: { es: 'Aún no tienes hechos aprobados; el encaje no puede usar tu experiencia.', en: 'You have no approved facts yet, so the match cannot use your experience.' },
  NO_JOB_DESCRIPTION: { es: 'La vacante no tiene descripción, así que no hay requisitos que comparar.', en: 'The job has no description, so there are no requirements to compare.' },
  NO_KNOWN_SKILLS_IN_DESCRIPTION: { es: 'No reconocimos habilidades concretas en la descripción.', en: 'We did not recognise specific skills in the description.' },
  PROVISIONAL_LOW_EVIDENCE: { es: 'Resultado provisional: hay poca información para comparar.', en: 'Provisional result: there is little information to compare.' },
};

export const labelFor = {
  applicationState: (value: string | null | undefined, locale: Locale) => label(applicationStates, value, locale, { es: 'Inicio', en: 'Start' }),
  recruitmentStage: (value: string | null | undefined, locale: Locale) => label(recruitmentStages, value, locale, { es: 'Inicio', en: 'Start' }),
  applicationEvent: (value: string, locale: Locale) => label(applicationEvents, value, locale),
  factKind: (value: string, locale: Locale) => label(factKinds, value, locale),
  factApproval: (value: string, locale: Locale) => label(factApprovals, value, locale),
  answerApproval: (value: string, locale: Locale) => label(answerApprovals, value, locale),
  documentApproval: (value: string, locale: Locale) => label(documentApprovals, value, locale),
  eligibility: (value: string, locale: Locale) => label(eligibilityStates, value, locale),
  availability: (value: string, locale: Locale) => label(jobAvailability, value, locale),
  shortlist: (value: string, locale: Locale) => label(shortlistDecisions, value, locale),
  workMode: (value: string, locale: Locale) => label(workModes, normalizeWorkMode(value), locale),
  region: (value: string, locale: Locale) => label(providerRegions, value, locale),
  /** Eligibility reasons and match notes share one namespace of codes. */
  matchCode: (value: string, locale: Locale) => label({ ...matchReasons, ...matchNotes }, value, locale),
};

/** Countries offered first in pickers. */
export const commonCountries = ['ES', 'PT', 'FR', 'DE', 'IT', 'NL', 'IE', 'GB', 'US', 'CA', 'MX', 'AR', 'CO', 'CL', 'BR'] as const;
/** Pseudo-regions, deprecated codes and territories that are not useful as a work country. */
const excludedRegions = new Set(['AC', 'AN', 'BU', 'CP', 'CQ', 'CS', 'DD', 'DG', 'DY', 'EA', 'EU', 'EZ', 'FX', 'HV', 'IC', 'NH', 'NT', 'QO', 'RH', 'SU', 'TA', 'TP', 'UK', 'UN', 'VD', 'XA', 'XB', 'YD', 'YU', 'ZR', 'ZZ']);
let regionCodes: string[] | null = null;
/** Every ISO 3166-1 alpha-2 code the browser can name, derived from Intl so the list never goes stale. */
export function allCountryCodes() {
  if (regionCodes) return regionCodes;
  const codes: string[] = [];
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (excludedRegions.has(code)) continue;
      const name = names.of(code); if (name && name !== code) codes.push(code);
    }
  } catch { codes.push(...commonCountries); }
  regionCodes = codes; return codes;
}

export function countryName(code: string, locale: Locale) {
  if (!/^[A-Z]{2}$/.test(code)) return code;
  try { return new Intl.DisplayNames([locale === 'en' ? 'en' : 'es'], { type: 'region' }).of(code) ?? code; } catch { return code; }
}
type CountryOption = { code: string; name: string };
/** Frequent countries plus the full sorted list. An existing value outside the list stays selectable so it is never silently dropped. */
export function countryOptions(locale: Locale, current?: string | null): { common: CountryOption[]; all: CountryOption[] } {
  const toOption = (code: string) => ({ code, name: countryName(code, locale) });
  const codes = new Set(allCountryCodes()); if (current) codes.add(current);
  const sort = (list: CountryOption[]) => list.sort((a, b) => a.name.localeCompare(b.name, locale));
  return { common: sort(commonCountries.map(toOption)), all: sort([...codes].map(toOption)) };
}

/** Turns a slugged semantic key back into a readable question when no original wording was stored. */
export const humanizeKey = (key: string) => humanize(key.replaceAll('.', ' '));

export function timeUntil(target: Date) {
  const minutes = Math.max(1, Math.ceil((target.getTime() - Date.now()) / 60_000));
  const hours = Math.floor(minutes / 60); const rest = minutes % 60;
  return hours ? `${hours} h${rest ? ` ${rest} min` : ''}` : `${minutes} min`;
}
