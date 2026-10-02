import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  answerSchema, applicationUpdateSchema, classifyRecruitmentStageChange, computeJobMatch, containsTerm, documentFileName, documentLanguage, extractKnownSkills,
  factCoversRequirement, hasTargetTitlesPreference, isActiveApplication, locationCompatibility, normalizeLocaleTag, profileCompletion, readPreferences, resumeLabels, resumeSectionName, titleAlignment,
  type CandidateEvidence, type MatchingContext,
} from '../src/index.js';

const fact = (text: string, tags: string[] = [], approval: CandidateEvidence['approval'] = 'USER_APPROVED'): CandidateEvidence => ({ id: text, text, tags, approval });
const context = (overrides: Partial<MatchingContext> = {}): MatchingContext => ({ evidence: [], targetTitles: [], workModes: [], country: null, authorizationKnown: false, profileRevision: 1, ...overrides });

describe('whole-term skill matching', () => {
  it('does not treat substrings as matches', () => {
    assert.equal(containsTerm('Senior JavaScript engineer', 'java'), false);
    assert.equal(containsTerm('Digital marketing and GitHub Actions', 'git'), false);
    assert.equal(containsTerm('We use Java.', 'java'), true);
    assert.equal(containsTerm('Experience with Git, Docker', 'git'), true);
    assert.equal(containsTerm('Backend in Node.js and TypeScript', 'node.js'), true);
    assert.equal(containsTerm('Backend in Node.js', 'js'), false);
    assert.equal(containsTerm('Strong CI/CD culture', 'ci/cd'), true);
  });

  it('extracts only skills that appear as whole terms', () => {
    const skills = extractKnownSkills('JavaScript role in a digital agency. GitHub preferred.').map((req) => req.text);
    assert.deepEqual(skills, ['javascript']);
    assert.deepEqual(extractKnownSkills('Java and Git required').map((req) => req.text).sort(), ['git', 'java']);
  });

  it('checks fact coverage by tag or alias without substring false positives', () => {
    const java = { text: 'java', hard: false, skillTags: ['java'] };
    const node = { text: 'node.js', hard: false, skillTags: ['node.js'] };
    assert.equal(factCoversRequirement(fact('Built JavaScript dashboards'), java), false);
    assert.equal(factCoversRequirement(fact('Built services', ['JavaScript']), java), false);
    assert.equal(factCoversRequirement(fact('Maintained a Java test suite'), java), true);
    assert.equal(factCoversRequirement(fact('APIs written in NodeJS'), node), true);
    assert.equal(factCoversRequirement(fact('APIs', ['Node.js']), node), true);
  });
});

describe('title alignment from profile preferences', () => {
  it('scores whole phrases and word overlap, never substrings', () => {
    assert.deepEqual(titleAlignment('QA Engineer', []), { alignment: -1, matchedTargetTitle: null });
    assert.equal(titleAlignment('Senior QA Engineer', ['QA Engineer']).alignment, 1);
    assert.equal(titleAlignment('Senior QA Automation Engineer', ['QA Engineer']).alignment, 1);
    assert.equal(titleAlignment('JavaScript Developer', ['Java Developer']).alignment, 0.5);
    assert.equal(titleAlignment('Digital Marketing Lead', ['Git']).alignment, 0);
    assert.equal(titleAlignment('Ingeniera de QA', ['Ingeniera QA']).matchedTargetTitle, 'Ingeniera QA');
  });

  it('reads target titles from profile.preferences', () => {
    assert.deepEqual(readPreferences({ preferences: { targetTitles: [' QA Engineer ', '', 'QA Engineer', 3], workModes: ['remote'] } }), { targetTitles: ['QA Engineer'], workModes: ['remote'] });
    assert.deepEqual(readPreferences({}), { targetTitles: [], workModes: [] });
  });
});

describe('job match recalculation', () => {
  const job = { title: 'Senior QA Automation Engineer', location: 'Remote - Spain', description: 'Playwright, TypeScript and Git. JavaScript is a plus.' };

  it('changes when approved facts and preferences change', () => {
    const empty = computeJobMatch(job, context());
    assert.equal(empty.fitScore, 0);
    assert.equal(empty.provisional, true);
    assert.ok(empty.match.notes.includes('NO_TARGET_TITLES'));
    assert.ok(empty.match.notes.includes('NO_APPROVED_FACTS'));

    const withFacts = computeJobMatch(job, context({ evidence: [fact('Playwright suites in TypeScript', ['git'])], targetTitles: ['QA Engineer'] }));
    assert.deepEqual(withFacts.match.matchedSkills.sort(), ['git', 'playwright', 'typescript']);
    assert.deepEqual(withFacts.match.missingSkills, ['javascript']);
    assert.equal(withFacts.match.titleAlignment, 1);
    assert.ok((withFacts.fitScore ?? 0) > (empty.fitScore ?? 0));
  });

  it('ignores suggested and rejected facts', () => {
    const result = computeJobMatch(job, context({ evidence: [fact('Playwright', [], 'SUGGESTED'), fact('TypeScript', [], 'REJECTED')] }));
    assert.deepEqual(result.match.matchedSkills, []);
    assert.equal(result.match.approvedFactCount, 0);
  });

  it('never infers work authorization and keeps location positive-only', () => {
    const result = computeJobMatch(job, context({ workModes: ['Remote'], country: 'ES' }));
    assert.ok(result.reasons.includes('AUTHORIZATION_UNANSWERED'));
    assert.ok(!result.reasons.includes('LOCATION_UNCLEAR'));
    assert.deepEqual(locationCompatibility('Madrid, Spain', { country: 'ES' }), { known: true, compatible: true });
    assert.deepEqual(locationCompatibility('Berlin', { country: 'ES' }), { known: true, compatible: null });
    assert.deepEqual(locationCompatibility(null, { country: 'ES' }), { known: false, compatible: null });
  });
});

describe('profile completion', () => {
  it('reports real completion from the latest profile and facts', () => {
    assert.deepEqual(profileCompletion({}, []), { percent: 0, completed: 0, total: 6, missing: ['fullName', 'email', 'country', 'targetTitles', 'workModes', 'approvedFact'], approvedFactCount: 0, pendingFactCount: 0 });
    const partial = profileCompletion({ identity: { fullName: 'Ada', email: ' ', country: 'ES' }, preferences: { targetTitles: ['QA Engineer'] } }, [{ approvalStatus: 'SUGGESTED' }, { approvalStatus: 'USER_APPROVED' }]);
    assert.equal(partial.percent, 67);
    assert.deepEqual(partial.missing, ['email', 'workModes']);
    assert.equal(partial.pendingFactCount, 1);
  });
});

describe('recruitment stage corrections', () => {
  it('requires an explicit correction to move back', () => {
    assert.equal(classifyRecruitmentStageChange('ASSESSMENT', 'INTERVIEW'), 'ADVANCE');
    assert.equal(classifyRecruitmentStageChange('INTERVIEW', 'INTERVIEW'), 'UNCHANGED');
    assert.equal(classifyRecruitmentStageChange('REJECTED', 'INTERVIEW'), 'REJECTED_REGRESSION');
    assert.equal(classifyRecruitmentStageChange('REJECTED', 'INTERVIEW', true), 'CORRECTION');
  });

  it('accepts correction metadata and question text in contracts', () => {
    assert.equal(applicationUpdateSchema.safeParse({ recruitmentStage: 'INTERVIEW', correction: true, reason: 'Marked rejected by mistake', expectedVersion: 3 }).success, true);
    assert.equal(applicationUpdateSchema.safeParse({ correction: 'yes' }).success, false);
    const answer = answerSchema.parse({ semanticKey: 'notice_period', jurisdiction: 'ES', questionScope: 'job_application', value: '30 days', strategy: 'ASK_USER' });
    assert.equal(answer.questionText, null);
    assert.equal(answerSchema.safeParse({ semanticKey: 'k', jurisdiction: 'ES', questionScope: 's', value: null, strategy: 'ASK_USER', questionText: 'x'.repeat(501) }).success, false);
  });
});

describe('document defaults', () => {
  it('localizes language, labels and file names', () => {
    assert.equal(documentLanguage(undefined, 'es-ES'), 'es');
    assert.equal(documentLanguage('en', 'es-ES'), 'en');
    assert.equal(documentLanguage('xx-invalid', 'en-GB'), 'en');
    assert.equal(normalizeLocaleTag('es_es'), 'es-ES');
    assert.equal(documentFileName('Currículum QA / Señor', 3), 'curriculum-qa-senor-r3.pdf');
    assert.equal(documentFileName('???', 1), 'document-r1.pdf');
    assert.equal(resumeSectionName('achievement', 'es'), 'Logros');
    assert.equal(resumeSectionName('volunteer_work', 'en'), 'Volunteer work');
  });

  it('does not claim the draft was reviewed', () => {
    for (const language of ['en', 'es'] as const) {
      const labels = resumeLabels(language);
      assert.doesNotMatch(labels.footer, /user-reviewed|revisado por ti/i);
      assert.notEqual(labels.defaultRole, 'Career evidence');
    }
  });
});

describe('post-review follow-up', () => {
  it('counts only non-cancelled applications outside terminal recruitment stages as active', () => {
    assert.equal(isActiveApplication({ state: 'DRAFT', recruitmentStage: 'NO_RESPONSE' }), true);
    assert.equal(isActiveApplication({ state: 'CONFIRMED', recruitmentStage: 'INTERVIEW' }), true);
    assert.equal(isActiveApplication({ state: 'CANCELLED', recruitmentStage: 'NO_RESPONSE' }), false);
    for (const stage of ['REJECTED', 'WITHDRAWN', 'HIRED'] as const) assert.equal(isActiveApplication({ state: 'CONFIRMED', recruitmentStage: stage }), false);
  });

  it('treats an explicit empty targetTitles list as a real preference', () => {
    assert.equal(hasTargetTitlesPreference({ preferences: { targetTitles: [] } }), true);
    assert.equal(hasTargetTitlesPreference({ preferences: { workModes: ['remote'] } }), false);
    assert.equal(hasTargetTitlesPreference({}), false);
  });

  it('keeps restricted remote roles unknown and accepts only own-country or unrestricted worldwide remote', () => {
    const es = { country: 'ES', workModes: ['Remote'] };
    assert.equal(locationCompatibility('Remote US only', es).compatible, null);
    assert.equal(locationCompatibility('Remote (United States)', es).compatible, null);
    assert.equal(locationCompatibility('Remote', es).compatible, null);
    assert.equal(locationCompatibility('Remote - Worldwide', es).compatible, true);
    assert.equal(locationCompatibility('Remote, anywhere (US residents only)', es).compatible, null);
    assert.equal(locationCompatibility('Remote - Spain', es).compatible, true);
    assert.equal(locationCompatibility('Remote: Spain or United States only', es).compatible, null);
    assert.equal(locationCompatibility('Remote - Worldwide', { country: 'ES', workModes: ['On-site'] }).compatible, null);
    assert.equal(locationCompatibility('Madrid, Spain', { country: 'España' }).compatible, true);
  });
});
