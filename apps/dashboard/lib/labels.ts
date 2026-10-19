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
  REVIEW_REQUIRED: { es: 'Por revisar', en: 'Needs review' },
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

export function applicationStage(stage: string | undefined, state: string, locale: Locale) {
  if (stage === 'NO_RESPONSE' && state !== 'CONFIRMED') return pick(locale, { es: 'Aún sin contacto', en: 'No contact yet' });
  return label(recruitmentStages, stage, locale);
}

export const applicationEvents: LabelMap = {
  PREPARATION_CREATED: { es: 'Preparación de la solicitud revisada', en: 'Application preparation checked' },
  APPLICATION_RESUME_SELECTED: { es: 'CV elegido para la solicitud', en: 'Application resume selected' },
  ASSIST_SUBMISSION_AUTHORIZED: { es: 'Envío autorizado', en: 'Submission authorized' },
  ASSIST_SUBMISSION_CONFIRMED: { es: 'Envío confirmado', en: 'Submission confirmed' },
  ASSIST_SUBMISSION_UNKNOWN: { es: 'Resultado del envío por comprobar', en: 'Submission outcome needs checking' },
  ASSIST_BROWSER_LOST: { es: 'Ventana cerrada: resultado por comprobar', en: 'Window closed: outcome needs checking' },
  ASSIST_PREPARED: { es: 'Solicitud preparada', en: 'Assisted application prepared' },
  ASSIST_CONSENT_GRANTED: { es: 'Autocompletado autorizado', en: 'Autofill authorized' },
  ASSIST_REVIEW_REQUIRED: { es: 'Navegador listo para revisión', en: 'Browser ready for review' },
  ASSIST_MANUAL_HANDOFF: { es: 'Control manual del navegador', en: 'Manual browser handoff' },
  ASSIST_USER_RECONCILED: { es: 'Resultado declarado por ti', en: 'Outcome reported by you' },

  APPLICATION_CREATED: { es: 'Solicitud creada', en: 'Application created' },
  EMAIL_IMPORTED: { es: 'Mensaje sobre la solicitud importado', en: 'Application email imported' },
  MANUAL_APPLICATION_RECORDED: { es: 'Solicitud registrada como enviada', en: 'Application recorded as sent' },
  APPLICATION_STATE_CHANGED: { es: 'Estado actualizado', en: 'Status updated' },
  FOLLOW_UP_UPDATED: { es: 'Próximo paso actualizado', en: 'Next step updated' },
  INTERVIEW_UPDATED: { es: 'Entrevista actualizada', en: 'Interview updated' },
  RECRUITMENT_STAGE_CHANGED: { es: 'Etapa actualizada', en: 'Stage updated' },
  RECRUITMENT_STAGE_CORRECTED: { es: 'Etapa corregida', en: 'Stage corrected' },
  USER_NOTE: { es: 'Nota', en: 'Note' },
};

export const factKinds: LabelMap = {
  summary: { es: 'Resumen profesional', en: 'Professional summary' },
  achievement: { es: 'Logro', en: 'Achievement' },
  skill_evidence: { es: 'Experiencia técnica', en: 'Technical experience' },
  experience: { es: 'Experiencia laboral', en: 'Work experience' },
  current_employment: { es: 'Empleo actual', en: 'Current job' },
  education: { es: 'Formación', en: 'Education' },
  certification: { es: 'Certificación', en: 'Certification' },
  project: { es: 'Proyecto', en: 'Project' },
  language: { es: 'Idioma', en: 'Language' },
};
export const selectableFactKinds = ['summary', 'achievement', 'skill_evidence', 'experience', 'education', 'certification', 'language', 'project'] as const;

export const factApprovals: LabelMap = {
  SUGGESTED: { es: 'Por confirmar', en: 'Needs confirmation' },
  USER_APPROVED: { es: 'Aprobado por ti', en: 'Approved by you' },
  REJECTED: { es: 'Descartado', en: 'Discarded' },
};
export const answerApprovals: LabelMap = {
  UNANSWERED: { es: 'Pendiente de aprobar', en: 'Waiting for approval' },
  USER_APPROVED: { es: 'Aprobada por ti', en: 'Approved by you' },
};
export const documentApprovals: LabelMap = {
  PENDING_REVIEW: { es: 'Por revisar', en: 'Needs review' },
  USER_APPROVED: { es: 'Aprobado por ti', en: 'Approved by you' },
  REJECTED: { es: 'Descartado', en: 'Discarded' },
  SUPERSEDED: { es: 'Sustituido', en: 'Replaced' },
};
export const applicationDocumentMessages: LabelMap = {
  APPLICATION_HAS_NO_OFFER: {
    es: 'Esta solicitud no tiene una oferta guardada. Guarda primero una oferta para preparar un CV y una carta específicos; mientras tanto, no se creará ningún documento.',
    en: 'This application has no saved job. Save a job first to prepare a tailored resume and cover letter; no document will be created yet.',
  },
};
export const applicationDocumentCurrentnessReasons: LabelMap = {
  FACTS_CHANGED: { es: 'Cambió la información de tu perfil.', en: 'Your profile information changed.' },
  OFFER_CHANGED: { es: 'Cambió la oferta guardada.', en: 'The saved job changed.' },
  FACT_NOT_APPROVED: { es: 'Una fuente citada ya no está aprobada.', en: 'A cited source is no longer approved.' },
  LANGUAGE_MISMATCH: { es: 'Una frase no coincide con el idioma elegido.', en: 'A sentence does not match the selected language.' },
  INVALID_CLAIM: { es: 'Una afirmación ya no coincide con sus fuentes.', en: 'A claim no longer matches its sources.' },
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
export const jobAvailabilityReasons: LabelMap = {
  ABSENT_FROM_SOURCES: { es: 'No apareció en varias lecturas completas de sus fuentes.', en: 'It was missing from several complete source reads.' },
  SEEN_AGAIN: { es: 'Una fuente volvió a publicar la oferta.', en: 'A source listed the job again.' },
  CLOSED_BY_USER: { es: 'La cerraste tú.', en: 'You closed it.' },
  REOPENED_BY_USER: { es: 'La reabriste tú.', en: 'You reopened it.' },
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
  NO_JOB_DESCRIPTION: { es: 'La oferta no tiene descripción, así que no hay requisitos que comparar.', en: 'The job has no description, so there are no requirements to compare.' },
  NO_KNOWN_SKILLS_IN_DESCRIPTION: { es: 'No reconocimos habilidades concretas en la descripción.', en: 'We did not recognise specific skills in the description.' },
  PROVISIONAL_LOW_EVIDENCE: { es: 'Resultado provisional: hay poca información para comparar.', en: 'Provisional result: there is little information to compare.' },
};

/** Job evaluation report (#109). Conclusions are words, never a number that could read as a hiring probability. */
export const jobReportVerdictLabels: LabelMap = {
  GOOD_OPTION: { es: 'Buena opción', en: 'Good option' },
  REVIEW: { es: 'Conviene revisar', en: 'Worth reviewing' },
  PROBABLY_NOT_A_FIT: { es: 'Probablemente no encaja', en: 'Probably not a fit' },
};
export const jobReportReasonLabels: LabelMap = {
  MOST_REQUIREMENTS_SUPPORTED: { es: 'Tu experiencia confirmada respalda la mayoría de lo que pide la oferta.', en: 'Your confirmed experience supports most of what the job asks for.' },
  TITLE_MATCHES_TARGET: { es: 'El puesto coincide con uno de los que buscas.', en: 'The role matches one you are looking for.' },
  NOT_ENOUGH_INFORMATION: { es: 'No hay datos suficientes para concluir: faltan requisitos claros en la oferta o datos confirmados en tu perfil.', en: 'There is not enough information to conclude: the job lacks clear requirements or your profile lacks confirmed details.' },
  SOME_REQUIREMENTS_UNCONFIRMED: { es: 'Parte de lo que pide la oferta todavía no está confirmado en tu perfil.', en: 'Part of what the job asks for is not confirmed in your profile yet.' },
  REQUIRED_SKILL_UNCONFIRMED: { es: 'La oferta exige algo que todavía no tienes confirmado.', en: 'The job requires something you have not confirmed yet.' },
  TITLE_NOT_COMPARED: { es: 'No comparamos el puesto porque aún no indicaste qué puestos buscas.', en: 'The role was not compared because you have not said which roles you are looking for.' },
  TITLE_NOT_TARGETED: { es: 'El puesto no coincide con los que buscas.', en: 'The role does not match the ones you are looking for.' },
  FEW_REQUIREMENTS_SUPPORTED: { es: 'Casi nada de lo que pide la oferta está respaldado por tu experiencia confirmada.', en: 'Almost nothing the job asks for is backed by your confirmed experience.' },
  LOCATION_TO_CONFIRM: { es: 'Confirma desde dónde se puede trabajar antes de presentar la solicitud.', en: 'Confirm where the job can be done from before applying.' },
  LOCATION_INCOMPATIBLE: { es: 'La ubicación no es compatible con la tuya.', en: 'The location is not compatible with yours.' },
  WORK_MODE_DIFFERS: { es: 'La modalidad de trabajo no coincide con la que prefieres.', en: 'The work mode differs from the one you prefer.' },
};
export const jobReportUnknownLabels: LabelMap = {
  NO_JOB_DESCRIPTION: { es: 'La oferta no tiene descripción guardada.', en: 'The job has no saved description.' },
  NO_CLEAR_REQUIREMENTS: { es: 'No encontramos requisitos concretos en la descripción.', en: 'We found no specific requirements in the description.' },
  NO_APPROVED_FACTS: { es: 'Aún no has confirmado datos de experiencia en tu perfil.', en: 'You have not confirmed any experience details in your profile yet.' },
  NO_TARGET_TITLES: { es: 'No indicaste qué puestos buscas.', en: 'You have not said which roles you are looking for.' },
  LOCATION_NOT_STATED: { es: 'La oferta no indica la ubicación.', en: 'The job does not state a location.' },
  LOCATION_UNCLEAR: { es: 'No está claro si puedes trabajar desde tu país.', en: 'It is unclear whether you can work from your country.' },
  SALARY_NOT_STATED: { es: 'La oferta no menciona el salario.', en: 'The job does not mention pay.' },
  WORK_MODE_NOT_STATED: { es: 'La oferta no indica si es remota, híbrida o presencial.', en: 'The job does not say whether it is remote, hybrid or on-site.' },
  WORK_AUTHORIZATION_UNANSWERED: { es: 'No sabemos si tienes permiso de trabajo donde está el puesto; nunca lo suponemos.', en: 'We do not know whether you can legally work where the job is; we never assume it.' },
};
export const jobReportCheckLabels: LabelMap = {
  SALARY: { es: 'Salario', en: 'Pay' },
  WORK_MODE: { es: 'Modalidad', en: 'Work mode' },
  LOCATION: { es: 'Ubicación', en: 'Location' },
};
export const jobReportCheckStatusLabels: LabelMap = {
  STATED: { es: 'Indicado en la oferta', en: 'Stated in the job' },
  NOT_STATED: { es: 'No lo indica', en: 'Not stated' },
  MATCHES_PREFERENCE: { es: 'Coincide con tus preferencias', en: 'Matches your preferences' },
  DIFFERS_FROM_PREFERENCE: { es: 'No coincide con tus preferencias', en: 'Differs from your preferences' },
  TO_CONFIRM: { es: 'Por confirmar', en: 'To confirm' },
};
export const jobReportLevelLabels: LabelMap = {
  REQUIRED: { es: 'Obligatorio', en: 'Required' },
  PREFERRED: { es: 'Deseable', en: 'Nice to have' },
  UNSPECIFIED: { es: 'Sin indicar', en: 'Not specified' },
};
export const jobReportBatchStateLabels: LabelMap = {
  RUNNING: { es: 'Evaluando', en: 'Evaluating' },
  PAUSED: { es: 'En pausa', en: 'Paused' },
  CANCELLED: { es: 'Cancelada', en: 'Cancelled' },
  COMPLETED: { es: 'Terminada', en: 'Finished' },
};
export const jobReportItemErrorLabels: LabelMap = {
  JOB_NOT_FOUND: { es: 'La oferta ya no existe en tu espacio de trabajo.', en: 'The job no longer exists in your workspace.' },
  JOB_ARCHIVED: { es: 'Omitida: la oferta está archivada.', en: 'Skipped: the job is archived.' },
  REPORT_FAILED: { es: 'No pudimos evaluar esta oferta. Ábrela para ver su informe.', en: 'We could not evaluate this job. Open it to see its report.' },
  CANCELLED: { es: 'Sin evaluar: cancelaste la evaluación.', en: 'Not evaluated: you cancelled the evaluation.' },
};

export const labelFor = {
  applicationState: (value: string | null | undefined, locale: Locale) => label(applicationStates, value, locale, { es: 'Inicio', en: 'Start' }),
  recruitmentStage: (value: string | null | undefined, locale: Locale) => label(recruitmentStages, value, locale, { es: 'Inicio', en: 'Start' }),
  applicationEvent: (value: string, locale: Locale) => label(applicationEvents, value, locale),
  factKind: (value: string, locale: Locale) => label(factKinds, value, locale),
  factApproval: (value: string, locale: Locale) => label(factApprovals, value, locale),
  answerApproval: (value: string, locale: Locale) => label(answerApprovals, value, locale),
  documentApproval: (value: string, locale: Locale) => label(documentApprovals, value, locale),
  applicationDocumentMessage: (value: string, locale: Locale) => label(applicationDocumentMessages, value, locale),
  applicationDocumentCurrentnessReason: (value: string, locale: Locale) => label(applicationDocumentCurrentnessReasons, value, locale),
  eligibility: (value: string, locale: Locale) => label(eligibilityStates, value, locale),
  availability: (value: string, locale: Locale) => label(jobAvailability, value, locale),
  availabilityReason: (value: string, locale: Locale) => label(jobAvailabilityReasons, value, locale),
  shortlist: (value: string, locale: Locale) => label(shortlistDecisions, value, locale),
  workMode: (value: string, locale: Locale) => label(workModes, normalizeWorkMode(value), locale),
  region: (value: string, locale: Locale) => label(providerRegions, value, locale),
  /** Eligibility reasons and match notes share one namespace of codes. */
  matchCode: (value: string, locale: Locale) => label({ ...matchReasons, ...matchNotes }, value, locale),
  reportVerdict: (value: string, locale: Locale) => label(jobReportVerdictLabels, value, locale),
  reportReason: (value: string, locale: Locale) => label(jobReportReasonLabels, value, locale),
  reportUnknown: (value: string, locale: Locale) => label(jobReportUnknownLabels, value, locale),
  reportCheck: (value: string, locale: Locale) => label(jobReportCheckLabels, value, locale),
  reportCheckStatus: (value: string, locale: Locale) => label(jobReportCheckStatusLabels, value, locale),
  reportLevel: (value: string, locale: Locale) => label(jobReportLevelLabels, value, locale),
  reportBatchState: (value: string, locale: Locale) => label(jobReportBatchStateLabels, value, locale),
  reportItemError: (value: string, locale: Locale) => label(jobReportItemErrorLabels, value, locale),
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
