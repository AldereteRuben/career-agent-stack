import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CandidateEvidence } from '../src/matching.js';
import {
  applyInterviewSelfAssessment, assessInterviewAnswer, interviewProbeText, interviewTurnVerdict, nextInterviewPracticeItem, INTERVIEW_MOCK_LIMITS,
  type InterviewRubricCriterion,
} from '../src/interview-mock-session.js';

const facts: CandidateEvidence[] = [
  { id: 'fact-ts', text: 'Built TypeScript services for a fictional shop', tags: ['typescript'], approval: 'USER_APPROVED' },
  { id: 'fact-docker', text: 'Used Docker once', tags: ['docker'], approval: 'SUGGESTED' },
];
const strong = 'When our team shipped a checkout service, I built the TypeScript API and decided to cache prices instead of calling the database, because latency mattered. As a result, page time fell from 900 ms to 300 ms for 2000 users.';
const assess = (answer: string, language: 'es' | 'en' = 'en') => assessInterviewAnswer({ language, answer, facts });
const status = (check: ReturnType<typeof assess>, criterion: InterviewRubricCriterion) => check.feedback.assessments.find((item) => item.criterion === criterion)!.status;

test('a detailed answer backed by approved facts meets what can be observed, and correctness is never judged by the check', () => {
  const check = assess(strong);
  for (const criterion of ['SPECIFICITY', 'EVIDENCE', 'STRUCTURE', 'TRADE_OFFS'] as const) assert.equal(status(check, criterion), 'MET', criterion);
  assert.equal(status(check, 'CORRECTNESS'), 'NOT_ASSESSED');
  assert.equal(check.feedback.assessments.find((item) => item.criterion === 'CORRECTNESS')!.source, 'CHECK');
  assert.equal(check.feedback.probe, null);
  assert.deepEqual(check.learningItems, []);
  assert.equal(interviewTurnVerdict(check.feedback), 'NOT_ASSESSED', 'nothing is praised as correct without a rating of correctness');
});

test('a claim no approved fact backs is missing evidence and is probed first, without suggesting what to claim', () => {
  const check = assess(`${strong} I also used Playwright and Docker every day to test it, as a result releases were calmer and my role was to decide.`);
  assert.equal(status(check, 'EVIDENCE'), 'MISSING_EVIDENCE', 'Playwright has no approved fact, and a suggested Docker fact does not count');
  assert.match(check.feedback.assessments.find((item) => item.criterion === 'EVIDENCE')!.note!, /playwright/);
  assert.equal(check.feedback.probe, 'EVIDENCE');
  assert.match(check.learningItems[0]!, /Add the experience to your profile if it is true, or say honestly/);
  assert.match(interviewProbeText('EVIDENCE', 'en'), /how would you explain that honestly/);
});

test('a short answer lacks specificity, and a vague long one is only partly specific', () => {
  const short = assess('I tested things and it was fine.');
  assert.equal(status(short, 'SPECIFICITY'), 'MISSING_EVIDENCE');
  assert.equal(short.feedback.probe, 'SPECIFICITY');
  const vague = assess('We looked after quality in the team for a long time and we tried to keep everything tidy and organised across many releases and many different kinds of work every single week without much trouble overall.');
  assert.ok(vague.feedback.assessments.length === 5 && INTERVIEW_MOCK_LIMITS.minWordsForSpecificity < 40);
  assert.equal(status(vague, 'SPECIFICITY'), 'PARTIAL');
  assert.equal(status(vague, 'EVIDENCE'), 'NOT_ASSESSED', 'no skill is named, so nothing is invented');
});

test('structure follows situation, action and result cues; trade-offs are only noted when present', () => {
  assert.equal(status(assess(strong), 'STRUCTURE'), 'MET');
  assert.equal(status(assess('I built it and I decided the plan for the team, and we kept going with it for a good while after that point in time, nothing else to add here really.'), 'STRUCTURE'), 'MET');
  assert.equal(status(assess('Testing is important for software quality and every team should do plenty of it throughout the whole delivery of each product they build and maintain over many years.'), 'STRUCTURE'), 'MISSING_EVIDENCE');
  assert.equal(status(assess(strong), 'TRADE_OFFS'), 'MET');
  assert.equal(status(assess('Testing is important for software quality and every team should do plenty of it throughout the whole delivery of each product they build and maintain over many years.'), 'TRADE_OFFS'), 'NOT_ASSESSED');
});

test('Spanish answers get Spanish notes and cues', () => {
  const check = assess('Cuando mi equipo lanzó el servicio de pagos, yo construí la API con TypeScript y decidí usar caché en lugar de consultar siempre la base de datos, porque la latencia importaba. Como resultado, el tiempo bajó de 900 a 300 ms para 2000 usuarios.', 'es');
  for (const criterion of ['SPECIFICITY', 'EVIDENCE', 'STRUCTURE', 'TRADE_OFFS'] as const) assert.equal(status(check, criterion), 'MET', criterion);
  assert.match(check.feedback.assessments[0]!.note!, /no puede juzgar/);
  assert.match(interviewProbeText('STRUCTURE', 'es'), /situación/);
});

test('missing evidence and an incorrect answer are different, and the person rating overrides only that criterion', () => {
  const check = assess('I tested things and it was fine.');
  const rated = applyInterviewSelfAssessment(check.feedback, { CORRECTNESS: 'INCORRECT' });
  assert.equal(rated.assessments.find((item) => item.criterion === 'CORRECTNESS')!.status, 'INCORRECT');
  assert.equal(rated.assessments.find((item) => item.criterion === 'CORRECTNESS')!.source, 'SELF');
  assert.equal(rated.assessments.find((item) => item.criterion === 'SPECIFICITY')!.status, 'MISSING_EVIDENCE');
  assert.equal(rated.assessments.find((item) => item.criterion === 'SPECIFICITY')!.source, 'CHECK');
  assert.equal(interviewTurnVerdict(rated), 'NEEDS_WORK', 'an incorrect answer is never praised');
  const good = applyInterviewSelfAssessment(assess(strong).feedback, { CORRECTNESS: 'MET' });
  assert.equal(interviewTurnVerdict(good), 'GOOD_SO_FAR');
  assert.equal(interviewTurnVerdict(applyInterviewSelfAssessment(good, { STRUCTURE: 'PARTIAL' })), 'NOT_ASSESSED', 'open points keep it from reading as good');
  assert.equal(interviewTurnVerdict(null), 'NOT_ASSESSED');
});

test('the next question is the next unasked practice exercise in plan order', () => {
  const items = [
    { id: 'c', kind: 'EXERCISE', position: 5 }, { id: 'n', kind: 'NOTE', position: 0 }, { id: 'a', kind: 'EXERCISE', position: 1 },
    { id: 'q', kind: 'QUESTION', position: 2 }, { id: 'b', kind: 'EXERCISE', position: 3 },
  ];
  assert.equal(nextInterviewPracticeItem(items, new Set())!.id, 'a');
  assert.equal(nextInterviewPracticeItem(items, new Set(['a']))!.id, 'b');
  assert.equal(nextInterviewPracticeItem(items, new Set(['a', 'b', 'c'])), null);
  assert.equal(nextInterviewPracticeItem([{ id: 'x', kind: 'NOTE', position: 0 }], new Set()), null, 'notes and questions to ask are not practice questions');
});
