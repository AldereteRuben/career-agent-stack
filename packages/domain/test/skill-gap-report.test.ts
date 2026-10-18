import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSkillGapReport } from '../src/skill-gap-report.js';
import type { MatchingContext } from '../src/matching.js';

const context: MatchingContext = {
  evidence: [
    { id: 'approved-ts', text: 'Built TypeScript services', tags: ['typescript'], approval: 'USER_APPROVED' },
    { id: 'suggested-docker', text: 'Used Docker in a project', tags: ['docker'], approval: 'SUGGESTED' },
    { id: 'rejected-playwright', text: 'Used Playwright', tags: ['playwright'], approval: 'REJECTED' },
  ],
  targetTitles: [], workModes: [], country: null, authorizationKnown: false, profileRevision: 3,
};

test('skill gap report counts unique listings and separates required, preferred and profile evidence', () => {
  const report = buildSkillGapReport([
    { id: 'first', company: 'Example', title: 'QA Engineer', canonicalUrl: 'https://example.test/jobs/1?utm_source=alpha', location: null, description: 'Requirements: Playwright and TypeScript are required.\nNice to have: Docker.' },
    { id: 'duplicate', company: 'Example', title: 'QA Engineer', canonicalUrl: 'https://example.test/jobs/1?utm_source=beta#apply', location: null, description: 'Requirements: Playwright and TypeScript are required.\nNice to have: Docker.\nKubernetes is required.' },
    { id: 'second', company: 'Other', title: 'Test Engineer', canonicalUrl: 'https://example.test/jobs/2', location: null, description: 'Requirements: Playwright is required.\nPreferred: Docker.' },
  ], context);

  assert.equal(report.savedJobCount, 2);
  assert.equal(report.analyzedJobCount, 2);
  assert.equal(report.jobsWithoutDescription, 0);
  assert.equal(report.jobsWithoutRequirements, 0);
  assert.deepEqual(report.groups.map(({ skill, profileEvidence, requiredJobCount, preferredJobCount }) => ({ skill, profileEvidence, requiredJobCount, preferredJobCount })), [
    { skill: 'docker', profileEvidence: 'PENDING_REVIEW', requiredJobCount: 0, preferredJobCount: 2 },
    { skill: 'playwright', profileEvidence: 'NOT_IN_APPROVED_PROFILE', requiredJobCount: 2, preferredJobCount: 0 },
    { skill: 'kubernetes', profileEvidence: 'NOT_IN_APPROVED_PROFILE', requiredJobCount: 1, preferredJobCount: 0 },
  ]);
  assert.ok(report.groups.every((group) => !group.skill.includes('typescript')));
});

test('skill gap report uses job IDs when a listing has no canonical URL and counts missing descriptions separately', () => {
  const report = buildSkillGapReport([
    { id: 'a', company: 'Example', title: 'QA Engineer', canonicalUrl: null, location: null, description: null },
    { id: 'b', company: 'Example', title: 'QA Engineer', canonicalUrl: null, location: null, description: 'Requirements: Java is required.' },
  ], { ...context, evidence: [] });

  assert.equal(report.savedJobCount, 2);
  assert.equal(report.analyzedJobCount, 1);
  assert.equal(report.jobsWithoutDescription, 1);
  assert.equal(report.jobsWithoutRequirements, 0);
  assert.equal(report.groups[0]?.skill, 'java');
  assert.equal(report.groups[0]?.requiredJobCount, 1);
});
