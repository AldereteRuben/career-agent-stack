import type { JobReport, JobReportRequirement } from './job-report.js';
import type { InterviewItemKind, InterviewItemOrigin } from './interview-preparation.js';

/**
 * The no-AI preparation plan (ADR 024, #200). Deterministic and side-effect free: it turns the job report (what the posting
 * asks for and which approved facts back it) and the current stage into plan items from fixed templates. It never writes a
 * claim about the person, never approves anything, and never says a question will come up in a real interview.
 */
export type InterviewPlanLanguage = 'es' | 'en';
export type InterviewRequirementSupport = 'SUPPORTED' | 'UNKNOWN';
export type InterviewEvidenceKey = { kind: 'JOB_SNAPSHOT' | 'RESUME_VERSION' | 'APPROVED_FACT'; sourceId: string };

export type InterviewPlanItemDraft = {
  kind: InterviewItemKind;
  origin: InterviewItemOrigin;
  content: string;
  /** Only for requirements: whether approved facts back it. Unsupported ones are shown as unknown, never guessed. */
  support: InterviewRequirementSupport | null;
  /** Approved facts that back a requirement. Each one is also stored as evidence of the plan. */
  factIds: string[];
  /** The evidence this item rests on, so the plan can show where it came from. */
  evidence: InterviewEvidenceKey | null;
};

export type InterviewPlanInput = {
  language: InterviewPlanLanguage;
  /** The recruitment stage the application is in, or null when unknown. */
  stage: string | null;
  /** The job evaluation of the saved offer, or null when the application has no saved offer. */
  report: JobReport | null;
  jobSnapshotId: string | null;
};

export const INTERVIEW_PLAN_LIMITS = Object.freeze({ maxItems: 300, maxContent: 2_000 });

const levelRank = (requirement: JobReportRequirement) => requirement.level === 'REQUIRED' ? 0 : requirement.level === 'PREFERRED' ? 2 : 1;

const copy = {
  es: {
    supportedExercise: (skill: string) => `Ejercicio de práctica: prepara un ejemplo concreto de ${skill} con tu experiencia aprobada (situación, qué hiciste y resultado).`,
    unknownStudy: (skill: string, level: JobReportRequirement['level']) => `Para estudiar${level === 'REQUIRED' ? ' (la oferta lo pide)' : level === 'PREFERRED' ? ' (la oferta lo valora)' : ''}: repasa ${skill}. No hay experiencia aprobada que lo respalde; prepárate para decir con honestidad que no lo has usado, o añade la experiencia a tu perfil si es real.`,
    noRequirements: 'No se reconocieron requisitos en la oferta guardada. Añade tus propias notas y preguntas, o guarda la descripción completa de la oferta.',
    noOffer: 'Esta candidatura no tiene una oferta guardada. Añade tus propias notas y preguntas para preparar la entrevista.',
    noFacts: 'Aún no tienes datos del perfil aprobados, así que ningún requisito aparece respaldado. Aprueba tu experiencia en el perfil para ver ejemplos propios.',
    stages: {
      RECRUITER_CONTACT: ['Ejercicio de práctica: prepara una presentación de un minuto sobre ti y por qué te interesa este puesto.', 'Ejercicio de práctica: ten claras tus condiciones y disponibilidad para la primera conversación.'],
      ASSESSMENT: ['Ejercicio de práctica: repasa los temas de la prueba que te hayan indicado y reserva un tiempo sin interrupciones para hacerla.', 'Ejercicio de práctica: prepara cómo explicarías en voz alta tu razonamiento en un ejercicio técnico.'],
      INTERVIEW: ['Ejercicio de práctica: cuenta con claridad tu trayectoria en dos minutos, enlazándola con lo que pide la oferta.', 'Ejercicio de práctica: prepara una situación difícil de tu experiencia aprobada y qué aprendiste.'],
      FINAL_INTERVIEW: ['Ejercicio de práctica: prepara por qué este puesto y esta empresa, con razones concretas que hayas investigado tú.', 'Ejercicio de práctica: ensaya cómo explicarías el impacto que tendrías en los primeros meses.'],
      OFFER: ['Ejercicio de práctica: anota lo que quieres confirmar de la oferta (condiciones, funciones, plazos) antes de responder.', 'Ejercicio de práctica: decide con antelación qué puntos querrías negociar y cuáles no.'],
    } as Record<string, string[]>,
    questions: ['Pregunta para hacer: ¿cómo es un buen primer año en este puesto?', 'Pregunta para hacer: ¿cómo es el equipo con el que trabajaría y cómo se organiza el trabajo?', 'Pregunta para hacer: ¿cuáles son los siguientes pasos del proceso y sus plazos?'],
  },
  en: {
    supportedExercise: (skill: string) => `Practice exercise: prepare one concrete example of ${skill} from your approved experience (the situation, what you did and the result).`,
    unknownStudy: (skill: string, level: JobReportRequirement['level']) => `To study${level === 'REQUIRED' ? ' (the posting asks for it)' : level === 'PREFERRED' ? ' (the posting values it)' : ''}: review ${skill}. No approved experience backs it; be ready to say honestly that you have not used it, or add the experience to your profile if it is true.`,
    noRequirements: 'No requirements were recognised in the saved posting. Add your own notes and questions, or save the full job description.',
    noOffer: 'This application has no saved job. Add your own notes and questions to prepare for the interview.',
    noFacts: 'You have no approved profile details yet, so no requirement shows as backed. Approve your experience in the profile to see examples of your own.',
    stages: {
      RECRUITER_CONTACT: ['Practice exercise: prepare a one-minute introduction of yourself and why this role interests you.', 'Practice exercise: be clear about your conditions and availability for the first conversation.'],
      ASSESSMENT: ['Practice exercise: review the topics of the assessment you were told about and set aside uninterrupted time to do it.', 'Practice exercise: prepare how you would explain your reasoning out loud in a technical exercise.'],
      INTERVIEW: ['Practice exercise: tell your background clearly in two minutes, linking it to what the posting asks for.', 'Practice exercise: prepare one difficult situation from your approved experience and what you learned.'],
      FINAL_INTERVIEW: ['Practice exercise: prepare why this role and this company, with concrete reasons you researched yourself.', 'Practice exercise: rehearse how you would explain the impact you would have in the first months.'],
      OFFER: ['Practice exercise: write down what you want to confirm about the offer (terms, duties, deadlines) before answering.', 'Practice exercise: decide in advance which points you would want to negotiate and which you would not.'],
    } as Record<string, string[]>,
    questions: ['Question to ask: what does a good first year in this role look like?', 'Question to ask: what is the team I would work with like, and how is the work organised?', 'Question to ask: what are the next steps in the process and their timing?'],
  },
} as const;

/** Stages with their own practice set; every other stage (no response, closed outcomes) uses the interview set. */
const stageKey = (stage: string | null) => stage && stage in copy.en.stages ? stage : 'INTERVIEW';

const draft = (item: Omit<InterviewPlanItemDraft, 'support' | 'factIds' | 'evidence'> & Partial<Pick<InterviewPlanItemDraft, 'support' | 'factIds' | 'evidence'>>): InterviewPlanItemDraft =>
  ({ support: null, factIds: [], evidence: null, ...item });

/**
 * Plan items in reading order: what the posting asks for, a prioritised study list (what the posting requires and nothing backs
 * comes first), examples to prepare from approved experience, practice for the current stage, and questions to ask.
 */
export function buildInterviewPreparationItems(input: InterviewPlanInput): InterviewPlanItemDraft[] {
  const text = copy[input.language];
  const snapshot: InterviewEvidenceKey | null = input.jobSnapshotId ? { kind: 'JOB_SNAPSHOT', sourceId: input.jobSnapshotId } : null;
  const items: InterviewPlanItemDraft[] = [];
  const report = input.report;
  const requirements = report ? [...report.supported, ...report.unconfirmed] : [];

  for (const requirement of requirements.slice().sort((a, b) => levelRank(a) - levelRank(b))) {
    const factIds = requirement.facts.map((fact) => fact.factId);
    items.push(draft({ kind: 'REQUIREMENT', origin: 'JOB_SNAPSHOT', content: requirement.skill, support: factIds.length ? 'SUPPORTED' : 'UNKNOWN', factIds, evidence: snapshot }));
  }
  if (!report) items.push(draft({ kind: 'NOTE', origin: 'FIXED_TEMPLATE', content: text.noOffer }));
  else if (!requirements.length) items.push(draft({ kind: 'NOTE', origin: 'FIXED_TEMPLATE', content: text.noRequirements }));
  else if (report.unknowns.includes('NO_APPROVED_FACTS')) items.push(draft({ kind: 'NOTE', origin: 'FIXED_TEMPLATE', content: text.noFacts }));

  for (const requirement of requirements.filter((candidate) => !candidate.facts.length).sort((a, b) => levelRank(a) - levelRank(b))) {
    items.push(draft({ kind: 'STUDY', origin: 'FIXED_TEMPLATE', content: text.unknownStudy(requirement.skill, requirement.level), evidence: snapshot }));
  }
  for (const requirement of requirements.filter((candidate) => candidate.facts.length)) {
    const first = requirement.facts[0]!;
    items.push(draft({ kind: 'EXERCISE', origin: 'FIXED_TEMPLATE', content: text.supportedExercise(requirement.skill), factIds: requirement.facts.map((fact) => fact.factId), evidence: { kind: 'APPROVED_FACT', sourceId: first.factId } }));
  }
  for (const exercise of text.stages[stageKey(input.stage)]!) items.push(draft({ kind: 'EXERCISE', origin: 'FIXED_TEMPLATE', content: exercise }));
  for (const question of text.questions) items.push(draft({ kind: 'QUESTION', origin: 'FIXED_TEMPLATE', content: question }));
  return items.slice(0, INTERVIEW_PLAN_LIMITS.maxItems);
}

/** The approved facts a plan cites, in first-use order, so each can be stored as evidence with its hash. */
export function interviewPlanFactIds(items: readonly InterviewPlanItemDraft[]): string[] {
  return [...new Set(items.flatMap((item) => item.factIds))];
}
