import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildJobReport } from '../src/job-report.js';
import { buildInterviewPreparationItems, interviewPlanFactIds, INTERVIEW_PLAN_LIMITS } from '../src/interview-preparation-plan.js';
import type { MatchingContext } from '../src/matching.js';

const context: MatchingContext = {
  evidence: [
    { id: 'fact-ts', text: 'Built TypeScript services for a fictional shop', tags: ['typescript'], approval: 'USER_APPROVED' },
    { id: 'fact-docker-suggested', text: 'Used Docker once', tags: ['docker'], approval: 'SUGGESTED' },
  ],
  targetTitles: [], workModes: [], country: null, authorizationKnown: false, profileRevision: 1,
};
const description = 'Requirements:\nTypeScript\nPlaywright\nNice to have:\nDocker';
const report = buildJobReport({ title: 'QA Engineer', location: null, description }, context);
const build = (overrides: Partial<Parameters<typeof buildInterviewPreparationItems>[0]> = {}) =>
  buildInterviewPreparationItems({ language: 'en', stage: 'INTERVIEW', report, jobSnapshotId: 'snapshot-1', ...overrides });
const kinds = (items: ReturnType<typeof build>, kind: string) => items.filter((item) => item.kind === kind);

test('requirements are listed with their support, and unsupported ones are unknown, never guessed', () => {
  const requirements = kinds(build(), 'REQUIREMENT');
  assert.deepEqual(requirements.map((item) => [item.content, item.support]).sort(), [['docker', 'UNKNOWN'], ['playwright', 'UNKNOWN'], ['typescript', 'SUPPORTED']]);
  assert.deepEqual(requirements.find((item) => item.content === 'typescript')!.factIds, ['fact-ts']);
  assert.deepEqual(requirements.find((item) => item.content === 'playwright')!.factIds, [], 'no approved fact, no claim');
  assert.ok(requirements.every((item) => item.origin === 'JOB_SNAPSHOT' && item.evidence?.kind === 'JOB_SNAPSHOT'));
  assert.ok(!interviewPlanFactIds(build()).includes('fact-docker-suggested'), 'a suggested fact is never cited');
});

test('the study list comes from unsupported requirements, required ones first', () => {
  const study = kinds(build(), 'STUDY');
  assert.equal(study.length, 2);
  assert.match(study[0]!.content, /playwright/, 'a required skill comes before a preferred one');
  assert.match(study[0]!.content, /the posting asks for it/);
  assert.match(study[1]!.content, /docker/);
  assert.match(study[1]!.content, /the posting values it/);
  assert.ok(study.every((item) => item.origin === 'FIXED_TEMPLATE'));
  assert.match(study[0]!.content, /honestly/, 'it never suggests claiming the skill');
});

test('an exercise for a supported requirement points at the approved fact it rests on', () => {
  const exercise = kinds(build(), 'EXERCISE').find((item) => /typescript/.test(item.content))!;
  assert.deepEqual(exercise.evidence, { kind: 'APPROVED_FACT', sourceId: 'fact-ts' });
  assert.deepEqual(exercise.factIds, ['fact-ts']);
  assert.deepEqual(interviewPlanFactIds(build()), ['fact-ts']);
});

test('practice follows the stage, falls back to the interview set, and never claims a question will be asked', () => {
  const stageText = (stage: string | null) => kinds(build({ stage }), 'EXERCISE').filter((item) => item.evidence === null).map((item) => item.content).join('|');
  assert.match(stageText('RECRUITER_CONTACT'), /one-minute introduction/);
  assert.match(stageText('OFFER'), /confirm about the offer/);
  assert.equal(stageText('NO_RESPONSE'), stageText('INTERVIEW'));
  assert.equal(stageText(null), stageText('INTERVIEW'));
  assert.equal(stageText('REJECTED'), stageText('INTERVIEW'));
  for (const item of build()) assert.doesNotMatch(item.content, /will (?:be asked|ask|come up)|they will ask|typical question/i);
  assert.equal(kinds(build(), 'QUESTION').length, 3);
});

test('Spanish and English plans have the same shape', () => {
  const en = build(); const es = build({ language: 'es' });
  assert.deepEqual(es.map((item) => [item.kind, item.origin, item.support]), en.map((item) => [item.kind, item.origin, item.support]));
  assert.match(kinds(es, 'STUDY')[0]!.content, /honestidad/);
  assert.match(kinds(es, 'QUESTION')[0]!.content, /Pregunta para hacer/);
});

test('without a saved offer, or without recognised requirements, the plan says so and still helps', () => {
  const none = build({ report: null, jobSnapshotId: null });
  assert.equal(kinds(none, 'REQUIREMENT').length, 0);
  assert.match(kinds(none, 'NOTE')[0]!.content, /no saved job/);
  assert.ok(kinds(none, 'EXERCISE').length > 0 && kinds(none, 'QUESTION').length > 0);
  const empty = build({ report: buildJobReport({ title: 'QA', location: null, description: 'We are a friendly team.' }, context) });
  assert.match(kinds(empty, 'NOTE')[0]!.content, /No requirements were recognised/);
});

test('without approved facts the plan explains why nothing is backed', () => {
  const noFacts = buildJobReport({ title: 'QA Engineer', location: null, description }, { ...context, evidence: [] });
  const items = build({ report: noFacts });
  assert.ok(kinds(items, 'REQUIREMENT').every((item) => item.support === 'UNKNOWN'));
  assert.match(kinds(items, 'NOTE')[0]!.content, /no approved profile details/);
  assert.deepEqual(interviewPlanFactIds(items), []);
});

test('a plan never exceeds its item limit', () => {
  assert.ok(build().length <= INTERVIEW_PLAN_LIMITS.maxItems);
});
