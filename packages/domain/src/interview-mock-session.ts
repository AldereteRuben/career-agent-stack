import { containsTerm, extractKnownSkills, factCoversRequirement, normalize, type CandidateEvidence } from './matching.js';

/**
 * Text mock sessions for interview preparation (ADR 024, #202). The checks here are deterministic and side-effect free. They
 * read what the person wrote and say what they can observe; they cannot judge whether an answer is right, so correctness is
 * left to the person (or to an assistant they choose to ask) and is never praised from this module. Missing evidence and an
 * incorrect answer are different statuses. Nothing here invents a story or changes an approved fact.
 */
export const interviewRubricCriteria = ['CORRECTNESS', 'SPECIFICITY', 'EVIDENCE', 'STRUCTURE', 'TRADE_OFFS'] as const;
export type InterviewRubricCriterion = (typeof interviewRubricCriteria)[number];
/** MISSING_EVIDENCE: the answer gives too little to judge it. INCORRECT: it was judged wrong. They are never merged. */
export const interviewRubricStatuses = ['MET', 'PARTIAL', 'MISSING_EVIDENCE', 'INCORRECT', 'NOT_ASSESSED'] as const;
export type InterviewRubricStatus = (typeof interviewRubricStatuses)[number];
export const interviewAssessmentSources = ['CHECK', 'SELF', 'ASSISTANT'] as const;
export type InterviewAssessmentSource = (typeof interviewAssessmentSources)[number];
export const interviewProbeKinds = ['EVIDENCE', 'SPECIFICITY', 'STRUCTURE'] as const;
export type InterviewProbeKind = (typeof interviewProbeKinds)[number];
export const interviewTurnKinds = ['QUESTION', 'PROBE'] as const;
export type InterviewTurnKind = (typeof interviewTurnKinds)[number];
export type InterviewMockLanguage = 'es' | 'en';

export type InterviewCriterionAssessment = { criterion: InterviewRubricCriterion; status: InterviewRubricStatus; source: InterviewAssessmentSource; note: string | null };
export type InterviewTurnFeedback = { assessments: InterviewCriterionAssessment[]; probe: InterviewProbeKind | null };

export const INTERVIEW_MOCK_LIMITS = Object.freeze({ answerLength: 5_000, learningItems: 10, learningItemLength: 300, minWordsForSpecificity: 25 });

const cues = {
  action: ['i did', 'i built', 'i led', 'i wrote', 'i implemented', 'i decided', 'i designed', 'i fixed', 'my role', 'we built', 'hice', 'construi', 'implemente', 'decidi', 'lidere', 'escribi', 'disene', 'resolvi', 'mi papel', 'construimos'],
  situation: ['when', 'situation', 'context', 'at my', 'in my previous', 'the project', 'the team', 'cuando', 'situacion', 'contexto', 'en mi', 'el proyecto', 'el equipo'],
  result: ['result', 'as a result', 'outcome', 'reduced', 'increased', 'improved', 'resulted', 'achieved', 'resultado', 'logre', 'reduje', 'aumente', 'mejore', 'consegui', 'como resultado'],
  tradeOffs: ['because', 'instead', 'however', 'trade-off', 'trade off', 'alternative', 'although', 'rather than', 'otherwise', 'porque', 'en lugar de', 'sin embargo', 'alternativa', 'aunque', 'compromiso', 'a cambio'],
};
const hasAny = (text: string, terms: string[]) => terms.some((term) => containsTerm(text, term));
const wordCount = (text: string) => normalize(text).split(/\s+/u).filter(Boolean).length;

const copy = {
  es: {
    correctness: 'Sin un asistente, la app no puede juzgar si la respuesta es correcta. Valórala tú o compárala con una fuente fiable.',
    tooShort: 'La respuesta es demasiado corta para valorarla.', specific: 'Incluye un detalle concreto.', vague: 'Faltan un número, una herramienta o un resultado concretos.',
    noSkills: 'No nombras herramientas ni habilidades que comprobar.', backed: 'Lo que mencionas tiene respaldo en tus hechos aprobados.',
    unbacked: (skills: string) => `Mencionas ${skills}, pero ningún hecho aprobado de este plan lo respalda.`,
    structureMet: 'Se distingue una secuencia clara.', structurePartial: 'Se distingue solo una parte de la secuencia situación, acción y resultado.', structureMissing: 'No se distingue una secuencia de situación, acción y resultado.',
    tradeMet: 'Explicas razones o alternativas.', tradeNone: 'No menciona alternativas ni razones. Solo importa si la pregunta trata de una decisión.',
    probe: {
      EVIDENCE: '¿Qué experiencia aprobada de tu perfil respalda lo que acabas de decir? Si no la tienes, ¿cómo lo explicarías con honestidad?',
      SPECIFICITY: '¿Puedes dar un ejemplo más concreto, con una herramienta, un número o un resultado?',
      STRUCTURE: 'Cuéntalo en orden: ¿cuál era la situación, qué hiciste tú y qué resultó?',
    },
    learning: {
      EVIDENCE: (skills: string) => `Repasa ${skills}: lo mencionaste y ningún hecho aprobado lo respalda. Añade la experiencia a tu perfil si es real, o di con honestidad que lo has estudiado.`,
      SPECIFICITY: 'Añade un detalle concreto (un número, una herramienta o un resultado) a este tipo de respuesta.',
      STRUCTURE: 'Practica el orden: situación, qué hiciste tú y resultado.',
    },
  },
  en: {
    correctness: 'Without an assistant the app cannot judge whether the answer is right. Rate it yourself or compare it with a reliable source.',
    tooShort: 'The answer is too short to judge.', specific: 'It includes a concrete detail.', vague: 'It lacks a concrete number, tool or result.',
    noSkills: 'It names no tools or skills to check.', backed: 'What you mention is backed by your approved facts.',
    unbacked: (skills: string) => `You mention ${skills}, but no approved fact in this plan backs it.`,
    structureMet: 'A clear sequence is visible.', structurePartial: 'Only part of the situation, action and result sequence is visible.', structureMissing: 'No sequence of situation, action and result is visible.',
    tradeMet: 'You explain reasons or alternatives.', tradeNone: 'It mentions no alternatives or reasons. This only matters if the question is about a decision.',
    probe: {
      EVIDENCE: 'Which approved experience in your profile backs what you just said? If you do not have it, how would you explain that honestly?',
      SPECIFICITY: 'Can you give a more concrete example, with a tool, a number or an outcome?',
      STRUCTURE: 'Tell it in order: what was the situation, what did you do, and what came of it?',
    },
    learning: {
      EVIDENCE: (skills: string) => `Review ${skills}: you mentioned it and no approved fact backs it. Add the experience to your profile if it is true, or say honestly that you have studied it.`,
      SPECIFICITY: 'Add a concrete detail (a number, a tool or an outcome) to this kind of answer.',
      STRUCTURE: 'Practice the order: situation, what you did, and the result.',
    },
  },
} as const;

/** The question a probe asks. It follows the weakest observable point of the answer and never suggests what to claim. */
export const interviewProbeText = (kind: InterviewProbeKind, language: InterviewMockLanguage) => copy[language].probe[kind];

export type InterviewAnswerCheck = { feedback: InterviewTurnFeedback; learningItems: string[] };

/** What can be observed in one answer, against the approved facts of the plan. */
export function assessInterviewAnswer(input: { language: InterviewMockLanguage; answer: string; facts: readonly CandidateEvidence[] }): InterviewAnswerCheck {
  const text = copy[input.language];
  const answer = input.answer.trim();
  const words = wordCount(answer);
  const skills = extractKnownSkills(answer);
  const approved = input.facts.filter((fact) => fact.approval === 'USER_APPROVED');
  const unbacked = skills.filter((skill) => !approved.some((fact) => factCoversRequirement(fact, skill)));

  const concrete = /\d/u.test(answer) || skills.length > 0;
  const specificity: InterviewCriterionAssessment = words < INTERVIEW_MOCK_LIMITS.minWordsForSpecificity
    ? { criterion: 'SPECIFICITY', status: 'MISSING_EVIDENCE', source: 'CHECK', note: text.tooShort }
    : concrete ? { criterion: 'SPECIFICITY', status: 'MET', source: 'CHECK', note: text.specific } : { criterion: 'SPECIFICITY', status: 'PARTIAL', source: 'CHECK', note: text.vague };
  const evidence: InterviewCriterionAssessment = !skills.length
    ? { criterion: 'EVIDENCE', status: 'NOT_ASSESSED', source: 'CHECK', note: text.noSkills }
    : unbacked.length ? { criterion: 'EVIDENCE', status: 'MISSING_EVIDENCE', source: 'CHECK', note: text.unbacked(unbacked.map((skill) => skill.text).join(', ')) }
      : { criterion: 'EVIDENCE', status: 'MET', source: 'CHECK', note: text.backed };
  const normalized = normalize(answer);
  const found = [hasAny(normalized, cues.situation), hasAny(normalized, cues.action), hasAny(normalized, cues.result)].filter(Boolean).length;
  const structure: InterviewCriterionAssessment = found >= 2 ? { criterion: 'STRUCTURE', status: 'MET', source: 'CHECK', note: text.structureMet }
    : found === 1 ? { criterion: 'STRUCTURE', status: 'PARTIAL', source: 'CHECK', note: text.structurePartial } : { criterion: 'STRUCTURE', status: 'MISSING_EVIDENCE', source: 'CHECK', note: text.structureMissing };
  const tradeOffs: InterviewCriterionAssessment = hasAny(normalized, cues.tradeOffs)
    ? { criterion: 'TRADE_OFFS', status: 'MET', source: 'CHECK', note: text.tradeMet } : { criterion: 'TRADE_OFFS', status: 'NOT_ASSESSED', source: 'CHECK', note: text.tradeNone };
  const correctness: InterviewCriterionAssessment = { criterion: 'CORRECTNESS', status: 'NOT_ASSESSED', source: 'CHECK', note: text.correctness };

  const assessments = [correctness, specificity, evidence, structure, tradeOffs];
  // Honesty about what is claimed comes first; a probe asks for more, never to pad an answer.
  const probe: InterviewProbeKind | null = evidence.status === 'MISSING_EVIDENCE' ? 'EVIDENCE' : specificity.status === 'MISSING_EVIDENCE' ? 'SPECIFICITY' : structure.status === 'MISSING_EVIDENCE' ? 'STRUCTURE' : null;
  const learningItems: string[] = [];
  if (evidence.status === 'MISSING_EVIDENCE') learningItems.push(text.learning.EVIDENCE(unbacked.map((skill) => skill.text).join(', ')));
  if (specificity.status !== 'MET') learningItems.push(text.learning.SPECIFICITY);
  if (structure.status !== 'MET') learningItems.push(text.learning.STRUCTURE);
  return { feedback: { assessments, probe }, learningItems: learningItems.map((item) => item.slice(0, INTERVIEW_MOCK_LIMITS.learningItemLength)) };
}

/** The person's own rating replaces the check's for that criterion; the rest stay as observed. */
export function applyInterviewSelfAssessment(feedback: InterviewTurnFeedback, self: Partial<Record<InterviewRubricCriterion, InterviewRubricStatus>>): InterviewTurnFeedback {
  return {
    ...feedback,
    assessments: feedback.assessments.map((assessment) => {
      const status = self[assessment.criterion];
      return status ? { criterion: assessment.criterion, status, source: 'SELF' as const, note: assessment.source === 'SELF' ? assessment.note : null } : assessment;
    }),
  };
}

/** NEEDS_WORK as soon as anything is incorrect or lacks evidence; GOOD_SO_FAR only when correctness was rated met and nothing is open. */
export type InterviewTurnVerdict = 'NEEDS_WORK' | 'GOOD_SO_FAR' | 'NOT_ASSESSED';
export function interviewTurnVerdict(feedback: InterviewTurnFeedback | null | undefined): InterviewTurnVerdict {
  if (!feedback) return 'NOT_ASSESSED';
  const statuses = feedback.assessments.map((assessment) => assessment.status);
  if (statuses.some((status) => status === 'INCORRECT' || status === 'MISSING_EVIDENCE')) return 'NEEDS_WORK';
  const correctness = feedback.assessments.find((assessment) => assessment.criterion === 'CORRECTNESS');
  return correctness?.status === 'MET' && !statuses.includes('PARTIAL') ? 'GOOD_SO_FAR' : 'NOT_ASSESSED';
}

/** The next practice item of the plan that has not been asked in this session, in plan order. */
export function nextInterviewPracticeItem<T extends { id: string; kind: string; position: number }>(items: readonly T[], askedItemIds: ReadonlySet<string>): T | null {
  return items.filter((item) => item.kind === 'EXERCISE' && !askedItemIds.has(item.id)).sort((a, b) => a.position - b.position)[0] ?? null;
}
