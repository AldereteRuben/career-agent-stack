import './config.js';
import { db, applications, applicationEvents, boards, jobs, profileFacts, profileVersions, workspaces } from '@career/db';
import { eq } from 'drizzle-orm';

const workspace = (await db.select().from(workspaces).limit(1))[0] ?? (await db.insert(workspaces).values({ name: 'Demo career workspace', timezone: 'Europe/Madrid' }).returning())[0]!;
const profile = (await db.select().from(profileVersions).where(eq(profileVersions.workspaceId, workspace.id)).limit(1))[0] ?? (await db.insert(profileVersions).values({
  workspaceId: workspace.id,
  revision: 1,
  profile: {
    locale: 'en-GB',
    identity: { fullName: 'Alex Example', email: 'alex@example.test', country: 'ES' },
    preferences: { targetTitles: ['QA Automation Engineer', 'SDET'], workModes: ['remote', 'hybrid'] },
  },
}).returning())[0]!;
const existing = await db.select().from(profileFacts).where(eq(profileFacts.workspaceId, workspace.id)).limit(1);
if (!existing.length) await db.insert(profileFacts).values([
  { workspaceId: workspace.id, profileVersionId: profile.id, kind: 'skill_evidence', statement: 'Built API tests using Java and REST Assured.', tags: ['java', 'rest-assured', 'api-testing'], approvalStatus: 'USER_APPROVED', source: 'USER_ENTERED', approvedAt: new Date() },
  { workspaceId: workspace.id, profileVersionId: profile.id, kind: 'achievement', statement: 'Integrated the API test suite into Jenkins pipelines.', tags: ['jenkins', 'ci-cd'], approvalStatus: 'USER_APPROVED', source: 'USER_ENTERED', approvedAt: new Date() },
]);
const board = (await db.select().from(boards).where(eq(boards.workspaceId, workspace.id)).limit(1))[0];
if (!board) await db.insert(boards).values({ workspaceId: workspace.id, provider: 'greenhouse', tenant: 'example-board-token', region: 'global', companyName: 'Example Employer', companyDomain: 'careers.example.test', careersUrl: 'https://careers.example.test/jobs', associationStatus: 'UNVERIFIED', permissionStatus: 'UNKNOWN', enabled: false });
const job = (await db.select().from(jobs).where(eq(jobs.workspaceId, workspace.id)).limit(1))[0] ?? (await db.insert(jobs).values({ workspaceId: workspace.id, company: 'Example Employer', title: 'QA Automation Engineer', location: 'Remote — Europe', canonicalUrl: 'https://careers.example.test/jobs/qa-automation-engineer', availability: 'OPEN', shortlistDecision: 'UNREVIEWED', eligibility: 'NEEDS_REVIEW', reasons: ['DEMO_RECORD', 'LOCATION_REVIEW_REQUIRED'], fitScore: 68, evidenceCoverage: 65 }).returning())[0]!;
const app = (await db.select().from(applications).where(eq(applications.workspaceId, workspace.id)).limit(1))[0];
if (!app) {
  const created = (await db.insert(applications).values({ workspaceId: workspace.id, jobId: job.id, company: job.company, role: job.title, location: job.location, canonicalUrl: job.canonicalUrl, state: 'DRAFT', notes: 'Fictional demo record. No application was sent.' }).returning())[0]!;
  await db.insert(applicationEvents).values({ workspaceId: workspace.id, applicationId: created.id, eventType: 'APPLICATION_CREATED', reason: 'Fictional demo record', priorState: null, newState: 'DRAFT', aggregateVersion: created.version });
}
console.log('Synthetic demo data created; the demo board remains disabled and unverified.');
await db.$client.end();
