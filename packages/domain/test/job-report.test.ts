// Job evaluation reports and batches (issues #109 and #110). Fictional profiles and jobs only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildJobReport, jobReportBatchTransition, jobReportVerdicts, sortJobReportBatchItems, JOB_REPORT_BATCH_LIMITS,
  type JobReportBatchItemState, type JobReportVerdict,
} from '../src/job-report.js';
import { AI_LIMITS } from '../src/ai-budget.js';
import type { CandidateEvidence, MatchingContext } from '../src/matching.js';

const fact = (id: string, text: string, approval: CandidateEvidence['approval'] = 'USER_APPROVED', tags: string[] = []): CandidateEvidence => ({ id, text, tags, approval });
const tester: MatchingContext = {
  evidence: [
    fact('f-playwright', 'Built a Playwright suite for a fictional checkout used by Example Shop.'),
    fact('f-typescript', 'Wrote TypeScript test helpers for Example Shop.'),
    fact('f-api', 'Automated API testing with REST Assured for Fictional Bank.'),
    fact('f-java-suggested', 'Java backend work at Fictional Bank.', 'SUGGESTED'),
    fact('f-docker-rejected', 'Docker at Example Shop.', 'REJECTED'),
  ],
  targetTitles: ['QA Engineer'], workModes: ['remote'], country: 'ES', authorizationKnown: false, profileRevision: 4,
};
const strongJob = {
  title: 'Senior QA Engineer', location: 'Remote - Spain',
  description: 'About us: Example Shop builds fictional stores.\nRequirements: Playwright and TypeScript are required.\n- Experience with API testing using REST Assured.\nNice to have: Docker.\nSalary: 45.000 € - 55.000 € gross per year.',
};

test('there are exactly three conclusions', () => {
  assert.deepEqual([...jobReportVerdicts], ['GOOD_OPTION', 'REVIEW', 'PROBABLY_NOT_A_FIT']);
});

test('a well supported job is a good option, with the posting sentence and the approved fact as evidence', () => {
  const report = buildJobReport(strongJob, tester);
  assert.equal(report.verdict, 'GOOD_OPTION', 'An unconfirmed nice-to-have does not hold back a job whose required skills are confirmed');
  assert.deepEqual(report.unconfirmed.map((item) => [item.skill, item.level]), [['docker', 'PREFERRED']], 'Docker is only backed by a rejected fact, so it stays unconfirmed');
  const withoutDocker = buildJobReport({ ...strongJob, description: strongJob.description.replace('\nNice to have: Docker.', '') }, tester);
  assert.equal(withoutDocker.verdict, 'GOOD_OPTION');
  assert.deepEqual(withoutDocker.reasons, ['MOST_REQUIREMENTS_SUPPORTED', 'TITLE_MATCHES_TARGET']);
  const playwright = withoutDocker.supported.find((item) => item.skill === 'playwright');
  assert.equal(playwright?.level, 'REQUIRED');
  assert.equal(playwright?.jobExcerpt, 'Requirements: Playwright and TypeScript are required.');
  assert.deepEqual(playwright?.facts.map((item) => item.factId), ['f-playwright']);
  assert.equal(withoutDocker.title.matchedTargetTitle, 'QA Engineer');
  assert.deepEqual(withoutDocker.checks, [
    { kind: 'SALARY', status: 'STATED', value: 'Salary: 45.000 € - 55.000 € gross per year.' },
    { kind: 'WORK_MODE', status: 'MATCHES_PREFERENCE', value: 'Remote - Spain' },
    { kind: 'LOCATION', status: 'MATCHES_PREFERENCE', value: 'Remote - Spain' },
  ]);
  assert.deepEqual(withoutDocker.unknowns, ['WORK_AUTHORIZATION_UNANSWERED']);
  assert.deepEqual(withoutDocker.basis, { profileRevision: 4, approvedFactCount: 3 });
});

test('only approved facts are evidence: suggested and rejected ones never support a requirement', () => {
  const report = buildJobReport({ title: 'QA Engineer', location: 'Remote - Spain', description: 'You will use Java and Docker every day.' }, tester);
  assert.deepEqual(report.supported, []);
  assert.deepEqual(report.unconfirmed.map((item) => item.skill), ['java', 'docker']);
  assert.ok(report.unconfirmed.every((item) => item.facts.length === 0));
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /f-java-suggested|f-docker-rejected/);
});

test('preferred skills are told apart from required ones and a missing required skill keeps the job in review', () => {
  const report = buildJobReport({ title: 'QA Engineer', location: 'Remote - Spain', description: 'Playwright and TypeScript experience. Kubernetes is mandatory.\nCypress is a plus.' }, tester);
  assert.equal(report.unconfirmed.find((item) => item.skill === 'kubernetes')?.level, 'REQUIRED');
  assert.equal(report.unconfirmed.find((item) => item.skill === 'cypress')?.level, 'PREFERRED');
  assert.equal(report.supported.find((item) => item.skill === 'playwright')?.level, 'UNSPECIFIED');
  assert.equal(report.verdict, 'REVIEW');
  assert.ok(report.reasons.includes('REQUIRED_SKILL_UNCONFIRMED'));
});

test('requirements headings apply to each listed skill, including skills without inline wording', () => {
  const report = buildJobReport({ title: 'QA Engineer', location: 'Remote - Spain', description: 'Requirements:\nPlaywright\nTypeScript\nJava' }, tester);
  assert.equal(report.unconfirmed.find((item) => item.skill === 'java')?.level, 'REQUIRED');
  assert.equal(report.verdict, 'REVIEW');
  assert.ok(report.reasons.includes('REQUIRED_SKILL_UNCONFIRMED'));
});

test('normalizing a displayed excerpt does not erase its required classification', () => {
  const report = buildJobReport({
    title: 'QA Engineer', location: 'Remote - Spain', description: 'Requirements:\nPlaywright\nTypeScript\nJava  development',
  }, tester);
  assert.equal(report.unconfirmed.find((item) => item.skill === 'java')?.level, 'REQUIRED');
  assert.equal(report.verdict, 'REVIEW');
  assert.ok(report.reasons.includes('REQUIRED_SKILL_UNCONFIRMED'));
});

test('a job without clear requirements stays in review and says what is unknown', () => {
  const report = buildJobReport({ title: 'QA Engineer', location: null, description: 'Join our friendly team and help customers every day.' }, tester);
  assert.equal(report.verdict, 'REVIEW');
  assert.deepEqual(report.reasons, ['NOT_ENOUGH_INFORMATION']);
  assert.deepEqual(report.supported, []); assert.deepEqual(report.unconfirmed, []);
  assert.deepEqual(report.unknowns, ['NO_CLEAR_REQUIREMENTS', 'LOCATION_NOT_STATED', 'SALARY_NOT_STATED', 'WORK_MODE_NOT_STATED', 'WORK_AUTHORIZATION_UNANSWERED']);
});

test('a job without a description, and a profile without facts or targets, never become a conclusion against the person', () => {
  const empty: MatchingContext = { evidence: [], targetTitles: [], workModes: [], country: null, authorizationKnown: false, profileRevision: 1 };
  const report = buildJobReport({ title: 'Platform Engineer', location: 'Madrid', description: null }, empty);
  assert.equal(report.verdict, 'REVIEW');
  assert.deepEqual(report.unknowns, ['NO_JOB_DESCRIPTION', 'NO_APPROVED_FACTS', 'NO_TARGET_TITLES', 'LOCATION_UNCLEAR', 'SALARY_NOT_STATED', 'WORK_MODE_NOT_STATED', 'WORK_AUTHORIZATION_UNANSWERED']);
  assert.equal(report.title.compared, false);
  assert.deepEqual(buildJobReport({ title: 'Platform Engineer', location: null, description: '   ' }, tester).unknowns[0], 'NO_JOB_DESCRIPTION');
});

test('a different role whose requirements you have not confirmed is probably not a fit', () => {
  const report = buildJobReport({ title: 'Data Scientist', location: 'Remote - Spain', description: 'Python, SQL and AWS are required. Kubernetes is a plus.' }, tester);
  assert.equal(report.verdict, 'PROBABLY_NOT_A_FIT');
  assert.deepEqual(report.reasons, ['TITLE_NOT_TARGETED', 'FEW_REQUIREMENTS_SUPPORTED']);
  assert.equal(report.unconfirmed.length, 4);
});

test('an unclear location or a different work mode keeps an otherwise strong job in review', () => {
  const description = 'Playwright and TypeScript are required.';
  const unstated = buildJobReport({ title: 'QA Engineer', location: null, description }, tester);
  assert.equal(unstated.checks.find((check) => check.kind === 'LOCATION')?.status, 'NOT_STATED');
  assert.equal(unstated.verdict, 'REVIEW', 'Unknown location cannot support the most favourable conclusion');

  const unclear = buildJobReport({ title: 'QA Engineer', location: 'Remote - US only', description }, tester);
  assert.equal(unclear.verdict, 'REVIEW');
  assert.ok(unclear.reasons.includes('LOCATION_TO_CONFIRM'));
  assert.ok(unclear.unknowns.includes('LOCATION_UNCLEAR'));
  const onsite = buildJobReport({ title: 'QA Engineer', location: 'Madrid, Spain', description: `${description} This is an on-site role in our Madrid office.` }, tester);
  assert.equal(onsite.checks.find((check) => check.kind === 'WORK_MODE')?.status, 'DIFFERS_FROM_PREFERENCE');
  assert.equal(onsite.verdict, 'REVIEW');
  assert.ok(onsite.reasons.includes('WORK_MODE_DIFFERS'));
});

test('the report never carries a number that could read as a hiring probability', () => {
  for (const job of [strongJob, { title: 'Data Scientist', location: null, description: 'Python required.' }]) {
    const report = buildJobReport(job, tester);
    const keys = JSON.stringify(report, (key, value) => { assert.doesNotMatch(key, /score|probab|percent|chance|likel/i); return value; });
    assert.doesNotMatch(keys, /%/);
    assert.ok(!('fitScore' in report));
  }
});

test('Spanish postings are read too', () => {
  const report = buildJobReport({ title: 'Ingeniera QA', location: 'Remoto (España)', description: 'Requisitos: experiencia imprescindible con Playwright.\nSe valora Docker.\nSueldo: 40.000 € brutos.' }, { ...tester, targetTitles: ['Ingeniera QA'] });
  assert.equal(report.supported[0]?.level, 'REQUIRED');
  assert.equal(report.unconfirmed[0]?.level, 'PREFERRED');
  assert.equal(report.checks[0]?.status, 'STATED');
  assert.equal(report.checks[1]?.status, 'MATCHES_PREFERENCE');
});

test('batches use the automatic analysis pass size and a bounded number of jobs', () => {
  assert.equal(JOB_REPORT_BATCH_LIMITS.perPass, AI_LIMITS.automaticReservationsPerPass);
  assert.ok(JOB_REPORT_BATCH_LIMITS.maxJobs <= 50);
});

test('batch transitions: pause, resume and cancel; repeating an action is harmless; finished batches stay finished', () => {
  assert.deepEqual(jobReportBatchTransition('RUNNING', 'pause'), { ok: true, state: 'PAUSED', changed: true });
  assert.deepEqual(jobReportBatchTransition('PAUSED', 'pause'), { ok: true, state: 'PAUSED', changed: false });
  assert.deepEqual(jobReportBatchTransition('PAUSED', 'resume'), { ok: true, state: 'RUNNING', changed: true });
  assert.deepEqual(jobReportBatchTransition('RUNNING', 'resume'), { ok: true, state: 'RUNNING', changed: false });
  assert.deepEqual(jobReportBatchTransition('PAUSED', 'cancel'), { ok: true, state: 'CANCELLED', changed: true });
  assert.deepEqual(jobReportBatchTransition('CANCELLED', 'cancel'), { ok: true, state: 'CANCELLED', changed: false });
  assert.deepEqual(jobReportBatchTransition('CANCELLED', 'resume'), { ok: false });
  assert.deepEqual(jobReportBatchTransition('COMPLETED', 'pause'), { ok: false });
  assert.deepEqual(jobReportBatchTransition('COMPLETED', 'cancel'), { ok: false });
});

test('batch results put the most favourable conclusions first without hiding failed, skipped or waiting jobs', () => {
  const item = (position: number, status: JobReportBatchItemState, verdict: JobReportVerdict | null = null) => ({ position, status, verdict });
  const sorted = sortJobReportBatchItems([item(0, 'SKIPPED'), item(1, 'DONE', 'PROBABLY_NOT_A_FIT'), item(2, 'PENDING'), item(3, 'DONE', 'REVIEW'), item(4, 'FAILED'), item(5, 'DONE', 'GOOD_OPTION'), item(6, 'DONE', 'REVIEW')]);
  assert.deepEqual(sorted.map((entry) => entry.position), [5, 3, 6, 1, 4, 0, 2]);
});
