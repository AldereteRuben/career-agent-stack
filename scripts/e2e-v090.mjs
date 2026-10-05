#!/usr/bin/env node
/* global document, innerWidth */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('../apps/api/package.json', import.meta.url)));
const { chromium } = require('playwright');
assert.equal(process.env.V090_ISOLATED, '1', 'Use the isolated runner');
assert.ok(process.env.V090_TOKEN, 'Use the isolated sign-in token');
const checkedUrl = (value) => {
  const url = new URL(value); assert.equal(url.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname)); assert.ok(url.port && !['3000', '3001'].includes(url.port)); return url;
};
const ui = checkedUrl(process.env.V090_UI_URL); const apiUrl = checkedUrl(process.env.V090_API_URL);
assert.notEqual(ui.port, apiUrl.port);
const artifacts = process.env.V090_ARTIFACTS ?? resolve('output/playwright/v090');
const ids = { application: randomUUID(), document: randomUUID(), job: randomUUID(), fact: randomUUID(), question: randomUUID(), search: randomUUID(), observation: randomUUID(), connection: randomUUID() };
const now = new Date().toISOString(); const future = () => new Date(Date.now() + 300_000).toISOString();
const fact = { id: ids.fact, kind: 'experience', statement: 'Built a fictional booking website with accessible forms.', tags: ['design'], approvalStatus: 'USER_APPROVED' };
const question = { id: ids.question, semanticKey: 'describe_your_relevant_work_experience', questionText: 'Describe your relevant work experience', jurisdiction: 'ES', questionScope: 'job_application', value: null, approvalStatus: 'UNANSWERED', strategy: 'ASK_USER', revision: 1 };
const profile = { revision: 1, locale: 'en', profile: { identity: { fullName: 'Alex Example', email: 'alex@example.test', country: 'ES' }, preferences: { targetTitles: ['Designer'], workModes: ['remote'] } }, facts: [fact], answers: [question] };
const job = { id: ids.job, title: 'Fictional Product Designer', company: 'Example Studio', location: 'Remote', canonicalUrl: 'https://example.test/job', fitScore: null, evidenceCoverage: null, eligibility: 'NEEDS_REVIEW', reasons: [], shortlistDecision: 'UNREVIEWED', availability: 'OPEN', createdAt: now, discoveredAt: null, seenAt: now };
const posting = 'Design accessible booking forms. Experience with usability research is preferred.';
const sourcesFor = request => ({ ...(request.searchRequest ? { searchRequest: request.searchRequest } : {}), ...(request.jobId ? { job: posting } : {}), facts: request.selectedFactIds?.includes(ids.fact) ? [{ factId: ids.fact, kind: fact.kind, text: fact.statement }] : [], ...(request.questionId ? { question: question.questionText } : {}) });
const outputFor = request => {
  const common = { operation: request.operation, locale: request.locale };
  if (request.operation === 'SEARCH_DRAFT') return { ...common, criteria: { role: 'Product Designer', company: null, location: 'Spain', workMode: 'remote' }, unsupportedConstraints: [{ requestQuote: 'four days a week', explanation: 'Check the work schedule in each posting.' }], clarifications: [] };
  if (request.operation === 'JOB_ANALYSIS') return { ...common, summary: [{ text: 'Designing accessible booking forms.', citations: [{ quote: 'Design accessible booking forms.' }] }], requirements: [], personalMatches: [], gaps: [], warnings: [] };
  if (request.operation === 'RESUME_DRAFT') return { ...common, proposals: [{ proposalKey: 'first', section: 'EXPERIENCE', text: 'Built accessible booking forms for a fictional website.', changeExplanation: 'Makes the supplied experience easier to read.', sourceFactIds: [ids.fact], warnings: [] }], warnings: [] };
  return { ...common, result: { status: 'DRAFT', text: 'I built a fictional booking website with accessible forms.', evidence: [{ factId: ids.fact }] } };
};
const state = { connectionFailure: false, automationFailure: false, documentApproval: 'PENDING_REVIEW', showSearches: false, connected: false, observed: false, previewError: null, mode: 'success', startLost: false, startExpired: false, previews: new Map(), runs: [], artifacts: new Map(), starts: [], consentRevokes: 0, paused: 0, historyFailures: 0, equivalentActive: false, answerSaveFailure: false, permissionReads: 0, automationReads: 0, savedAnswers: [], resumeSaves: [], questionSaves: [], searchSaves: [], automationPreviews: [], policies: [], historyPreviews: 0, historyClears: 0 };
const observation = () => ({ id: ids.observation, sessionState: 'SIGNED_IN', version: '0.test', maskedIdentity: 'a***@example.test', plan: null, usage: null });
const connectionState = () => ({ enabled: true, connection: state.connected ? { ...observation(), id: ids.connection, authorized: true } : null, observation: state.observed ? observation() : null });
const response = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-GB' });
let page = await context.newPage(); page.setDefaultTimeout(15_000);
const failures = []; const unmatched = [];
context.on('page', item => item.on('pageerror', error => failures.push(error.message)));
page.on('pageerror', error => failures.push(error.message));
const goto = path => page.goto(new URL(path, ui).toString(), { waitUntil: 'domcontentloaded' });
const visible = async locator => { await locator.waitFor({ state: 'visible' }); return locator; };
const click = async name => (await visible(page.getByRole('button', { name, exact: true }))).click();
const locale = async value => { if (!(await page.locator('html').getAttribute('lang')).startsWith(value)) await click(value === 'es' ? 'Español' : 'English'); };
const overflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, 'No horizontal page overflow');
const screenshot = async name => {
  await page.evaluate(() => document.scrollingElement?.scrollTo(0, 0));
  await page.screenshot({ path: join(artifacts, name), fullPage: true, animations: 'disabled' });
};
try {
  await mkdir(artifacts, { recursive: true });
  await goto('/login');
  await page.getByLabel(/^(Código de acceso|Sign-in code)$/).fill(process.env.V090_TOKEN);
  await page.getByRole('button', { name: /^(Entrar|Sign in|Iniciar sesión|Continue|Continuar|Open my workspace)$/ }).click();
  await page.waitForURL(url => !url.pathname.startsWith('/login'));
  await context.route('**/api/v1/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname.replace('/api/v1', ''); const method = request.method();
    if (path === '/session') return route.continue();
    if (path === '/capabilities') return response(route, { available: ['ai-processing'], unavailable: [] });
    if (path === '/summary') return response(route, { boards: [], recentJobs: [], recentApplications: [], pendingFacts: 0, unansweredItems: 0, applicationCounts: {}, savedSearchCount: 0, activeSearchCount: 0, totalJobs: 0, activeApplications: 0, profileCompletion: { percent: 100, completed: 6, total: 6, missing: [], approvedFactCount: 1, pendingFactCount: 0 } });
    if (path === '/profile') {
      if (method === 'PUT') { profile.profile = request.postDataJSON().profile; profile.revision++; ids.fact = randomUUID(); fact.id = ids.fact; }
      return response(route, profile);
    }
    const application = { id: ids.application, documentId: ids.document, documentApprovalStatus: state.documentApproval, jobId: ids.job, company: job.company, role: job.title, location: job.location, canonicalUrl: job.canonicalUrl, state: 'REVIEW_REQUIRED', recruitmentStage: 'NOT_CONTACTED', shortlistDecision: 'UNREVIEWED', notes: '', updatedAt: now, version: 1 };
    if (path === '/applications') return response(route, { items: [application], total: 1, offset: 0, limit: 25 });
    if (path === `/applications/${ids.application}`) return response(route, application);
    if (path === `/applications/${ids.application}/events` || path === '/preparations') return response(route, []);
    if (path === `/applications/${ids.application}/assist`) return response(route, { supported: false, url: job.canonicalUrl, identity: { fullName: 'Alex Example', email: 'alex@example.test' }, application, documents: [], attempts: [] });
    if (path === '/documents') return response(route, []);
    if (path === '/jobs') return response(route, [job]);
    if (path === `/jobs/${ids.job}`) return response(route, { job, snapshots: [{ id: randomUUID(), title: job.title, descriptionText: posting, fetchedAt: now }], sources: [], applications: [] });
    if (path === '/job-searches' && method === 'GET') return response(route, { searches: state.showSearches ? [ids.search, ids.question].map(id => ({ id, role: 'QA', company: null, location: 'Spain', workMode: 'remote', frequencyHours: 24, enabled: true, autoPrepare: false, language: 'en', revision: 1, matcherVersion: 2, providerIds: ['remotive'], includeRelated: false, lastRunAt: now, nextRunAt: new Date(Date.now() + 86400000).toISOString(), lastRunStatus: 'SUCCEEDED', lastResultCount: 1, lastNewCount: 1, lastError: null, latestRun: { id: 'run', status: 'SUCCEEDED', finishedAt: now, error: null, sources: [{ provider: 'remotive', status: 'FRESH', coverage: 'COMPLETE', fetchedAt: now, error: null }] } })) : [], coverage: {} });
    if (path.startsWith('/job-searches') && method === 'GET') return response(route, { items: state.showSearches ? [{ ...job, aiSummaryStates: { en: 'SAVED', es: 'RUNNING' }, matchedAt: now, sources: [] }] : [], total: state.showSearches ? 1 : 0 });
    if (path === '/job-searches' && method === 'POST') { state.searchSaves.push(request.postDataJSON()); return response(route, { error: 'TEST_SAVE_NOT_ALLOWED' }, 409); }
    if (path === '/answers' && method === 'POST') { state.questionSaves.push(request.postDataJSON()); return response(route, { id: randomUUID() }, 201); }
    if (path.endsWith('/approve') && path.startsWith('/answers/')) return response(route, { ok: true });
    if (path === '/settings' || path === '/privacy' || path === '/discovery') return response(route, {});
    if (path === '/backups/current') return response(route, { state: 'idle' });
    if (path === '/ai/connections') return state.connectionFailure ? response(route, {error: 'AI_UNAVAILABLE'}, 503) : response(route, connectionState());
    if (path === '/ai/connections/codex/inspect') { state.observed = true; return response(route, connectionState()); }
    if (path === '/ai/connections/codex/authorize') { assert.equal(request.postDataJSON().observationId, ids.observation); state.connected = true; return response(route, connectionState()); }
    if (path === `/ai/connections/${ids.connection}/disconnect`) { state.connected = false; state.observed = false; return response(route, connectionState()); }
    if (path === '/ai/consents') { state.permissionReads++; return response(route, { consents: state.consentRevokes ? [] : [{ id: 'consent', operation: 'SEARCH_DRAFT', dataCategories: ['SEARCH_REQUEST'], searchIds: [], remembered: true, grantedAt: now }] }); }
    if (path === '/ai/consents/consent/revoke') { state.consentRevokes++; state.policies.forEach(policy => { policy.paused = true; }); return response(route, { ok: true }); }
    if (path === '/ai/history/clear-preview') { state.historyPreviews++; return response(route, { previewId: 'history-preview', expiresAt: future(), removable: { runs: 2, artifacts: 1, usageRecords: 0 }, preserved: { activeRuns: 1, referencedArtifacts: 2, retainedDependencies: 3 }, retentionDays: 30 }); }
    if (path === '/ai/history/clear') { assert.deepEqual(request.postDataJSON(), { previewId: 'history-preview' }); state.historyClears++; return response(route, { deleted: { runs: 2, artifacts: 1, usageRecords: 0 }, retentionDays: 30 }); }
    if (path === '/ai/runs/preview') {
      if (state.previewError) { const code = state.previewError; state.previewError = null; return response(route, { error: code }, 409); }
      const value = request.postDataJSON(); const previewId = randomUUID(); state.previews.set(previewId, value);
      return response(route, { previewId, operation: value.operation, locale: value.locale, expiresAt: future(), categories: value.operation === 'SEARCH_DRAFT' ? ['SEARCH_REQUEST'] : ['JOB_POSTING', 'APPROVED_FACTS'], sources: sourcesFor(value), rememberedPermission: false, connection: { maskedIdentity: 'a***@example.test' } });
    }
    if (path === '/ai/runs' && method === 'POST') {
      const body = request.postDataJSON(); state.starts.push(body);
      if (state.startExpired) { state.startExpired = false; state.previews.delete(body.previewId); return response(route, { error: 'AI_PREVIEW_EXPIRED' }, 409); }
      if (state.equivalentActive) { state.equivalentActive = false; return response(route, { error: 'AI_EQUIVALENT_ACTIVE' }, 409); }
      let run = state.runs.find(item => item.key === body.idempotencyKey);
      if (!run) { const source = state.previews.get(body.previewId); assert.ok(source); const id = randomUUID(); const artifactId = randomUUID(); run = { id, state: state.mode === 'success' ? 'SUCCEEDED' : state.mode === 'failure' ? 'FAILED' : 'RUNNING', origin: 'MANUAL', artifactId, key: body.idempotencyKey, request: source, selectedFactIds: source.selectedFactIds ?? [], error: state.mode === 'failure' ? { code: 'PROVIDER_ERROR', dispatched: 'YES' } : undefined }; state.runs.unshift(run); state.artifacts.set(artifactId, { id: artifactId, revision: 1, state: 'PENDING_REVIEW', operation: source.operation, output: outputFor(source), sources: sourcesFor(source) }); }
      if (state.startLost) { state.startLost = false; return route.abort('connectionreset'); }
      return response(route, run, 202);
    }
    if (path === '/ai/runs' && method === 'GET' && state.historyFailures > 0) { state.historyFailures--; return response(route, { error: 'AI_UNAVAILABLE' }, 503); }
    if (path === '/ai/runs' && method === 'GET') return response(route, { runs: state.runs.filter(run => run.request.operation === url.searchParams.get('operation') && run.request.locale === url.searchParams.get('locale') && (!url.searchParams.has('jobId') || run.request.jobId === url.searchParams.get('jobId')) && (!url.searchParams.has('questionId') || run.request.questionId === url.searchParams.get('questionId'))) });
    const runId = path.match(/^\/ai\/runs\/([^/]+)(\/cancel)?$/);
    if (runId) { const run = state.runs.find(item => item.id === runId[1]); assert.ok(run); if (runId[2]) run.state = 'CANCELLED'; return response(route, run); }
    const artifact = path.match(/^\/ai\/artifacts\/([^/]+)(\/(answer|resume))?$/);
    if (artifact) {
      if (artifact[3] === 'answer') { if (state.answerSaveFailure) { state.answerSaveFailure = false; return response(route, { error: 'AI_UNAVAILABLE' }, 503); } state.savedAnswers.push(request.postDataJSON()); question.id = randomUUID(); question.revision++; question.value = request.postDataJSON().text; question.approvalStatus = 'UNANSWERED'; return response(route, question, 201); }
      if (artifact[3] === 'resume') { state.resumeSaves.push(request.postDataJSON()); return response(route, { error: 'AI_SOURCE_CHANGED' }, 409); }
      return response(route, state.artifacts.get(artifact[1]));
    }
    if (path === '/ai/automation' && method === 'GET') { if (state.automationFailure) return response(route, {error: 'AI_UNAVAILABLE'}, 503); state.automationReads++; return response(route, { enabled: true, policies: state.policies, searches: [{ id: ids.search, role: 'Product Designer', company: '', location: 'Spain', enabled: true }], facts: [{ factId: ids.fact, kind: fact.kind, text: fact.statement }], limits: { maximumDailyStarts: 10, maximumPerPass: 5 } }); }
    if (path === '/ai/automation/preview') { const body = request.postDataJSON(); state.automationPreviews.push(body); return response(route, { previewId: 'automation-preview', expiresAt: future(), searches: [{ id: ids.search, role: 'Product Designer', company: '', location: 'Spain', enabled: true }], sources: { facts: [] }, categories: ['JOB_POSTING'], locale: body.locale, maximumDailyStarts: body.maximumDailyStarts, connection: { maskedIdentity: 'a***@example.test' }, newOffersOnly: true }); }
    if (path === '/ai/automation' && method === 'POST') { state.policies = [{ id: 'policy', revision: 1, active: true, paused: false, searchIds: [ids.search], selectedFactIds: [], locale: 'en', maximumDailyStarts: 1, activatedAt: now, maskedIdentity: 'a***@example.test', queued: 0, ready: 0 }]; return response(route, state.policies[0], 201); }
    if (path === '/ai/automation/policy/pause') { state.paused++; state.policies[0].paused = true; return response(route, state.policies[0]); }
    unmatched.push(`${method} ${path}`); return response(route, { error: 'UNMOCKED_E2E_REQUEST' }, 501);
  });

  await goto('/settings'); await locale('en');
  await click('Check Codex'); await click('Use this account');
  await visible(page.getByRole('button', { name: 'Disconnect from Career Stack', exact: true }));
  assert.equal(state.starts.length, 0, 'Connection must not start work');
  await screenshot('connection-en.png');
  console.log('✓ Explicit account inspection and connection; no task starts');

  await goto('/searches');
  await page.getByRole('button', { name: 'Describe with Codex', exact: true }).click();
  await page.getByRole('textbox', { name: 'What job would you like to find?', exact: true }).fill('Product Designer in Spain, remote, four days a week');
  await goto('/settings'); await goto('/searches');
  await visible(page.getByRole('textbox', { name: 'What job would you like to find?', exact: true }));
  assert.equal(await page.getByRole('textbox', { name: 'What job would you like to find?', exact: true }).inputValue(), 'Product Designer in Spain, remote, four days a week');
  console.log('✓ Natural-language search and disclosure survive Settings navigation');
  state.previewError = 'AI_NOT_CONNECTED';
  await click('Prepare filters with Codex');
  await click('Check the connection here'); await visible(page.getByRole('button', { name: 'Disconnect from Career Stack', exact: true }));
  assert.match(await page.getByRole('textbox', { name: 'What job would you like to find?', exact: true }).inputValue(), /four days/);
  await click('Review my task’s data again');
  await page.getByText('See exactly what will be shared', { exact: true }).click();
  assert.equal(state.starts.length, 0); await visible(page.locator('p').filter({ hasText: /^Product Designer in Spain, remote, four days a week$/ }));
  state.startExpired = true; await click('Allow this task');
  await visible(page.getByRole('button', { name: 'Refresh the data', exact: true }));
  assert.equal(state.runs.length, 0, 'Expired server preview does not start another task');
  await click('Refresh the data');
  state.startLost = true; await click('Allow this task'); await click('Retry this task');
  await visible(page.getByRole('heading', { name: 'Your suggested search', exact: true }));
  assert.equal(state.starts.at(-2).idempotencyKey, state.starts.at(-1).idempotencyKey, 'Lost response retry uses same key');
  assert.equal(await page.getByRole('button', { name: 'Review and edit the search', exact: true }).isEnabled(), false);
  await page.getByRole('checkbox', { name: /I understand those conditions/ }).check(); await click('Review and edit the search');
  assert.equal(state.searchSaves.length, 0, 'Review does not create or run a search');
  await visible(page.getByText('Remember to check these conditions in each posting; they are not used as filters:', { exact: true }));
  await screenshot('search-review-en.png');
  console.log('✓ Search exact consent, inline connection, idempotent retry and unsupported-constraint review');

  await goto(`/jobs/${ids.job}`); await click('Summarize and explain with Codex');
  await click('Allow this task'); await visible(page.getByRole('heading', { name: 'The job, at a glance', exact: true }));
  await page.getByText('See the supporting information', { exact: true }).click(); await visible(page.getByText('Design accessible booking forms.', { exact: true }));
  const automation = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Summarize new jobs automatically · optional' }) }).last();
  await automation.locator('summary').first().click();
  await visible(automation.getByRole('button', { name: 'Review before enabling', exact: true }));
  assert.equal(await automation.getByRole('checkbox', { checked: true }).count(), 0, 'No searches or profile facts preselected');
  assert.equal(await automation.getByRole('button', { name: 'Review before enabling', exact: true }).isEnabled(), false);
  await automation.getByRole('checkbox', { name: 'Product Designer · Spain', exact: true }).check();
  await automation.getByRole('button', { name: 'Review before enabling', exact: true }).click();
  assert.equal(state.policies.length, 0); assert.deepEqual(state.automationPreviews[0].selectedFactIds, []);
  await automation.getByRole('button', { name: 'Allow automatic summaries', exact: true }).click();
  await automation.getByRole('button', { name: 'Pause summaries', exact: true }).click(); assert.equal(state.paused, 1);
  await screenshot('job-analysis-en.png');
  console.log('✓ Job analysis evidence, opt-in automatic setup, exact scope preview and pause (all mocked)');

  state.mode = 'waiting'; await click('Summarize and explain with Codex'); await click('Allow this task');
  const startsBeforeReopen = state.starts.length;
  await page.close(); page = await context.newPage(); page.setDefaultTimeout(15_000);
  await goto(`/jobs/${ids.job}`); await click('View assistance progress'); await visible(page.getByRole('button', { name: 'Cancel task', exact: true }));
  assert.equal(state.starts.length, startsBeforeReopen, 'Reopening only polls the same run');
  await click('Cancel task'); await visible(page.getByText('Task cancelled. No new suggestion has been added.', { exact: true }));
  state.mode = 'failure'; await click('Summarize and explain with Codex'); await click('Allow this task');
  await visible(page.getByText('Codex could not complete the task. You can try again when you are ready.', { exact: true }));
  await visible(page.getByRole('heading', { name: 'The job, at a glance', exact: true }));
  const failedStarts = state.starts.length;
  await goto('/settings'); await goto(`/jobs/${ids.job}`); await click('See what happened to the task');
  await visible(page.getByText('The task may have used quota even though there is no result.', { exact: true }));
  state.runs[0].state = 'INTERRUPTED';
  state.historyFailures = 1;
  await goto('/settings'); await goto(`/jobs/${ids.job}`);
  await click('Retry loading history'); await click('See what happened to the task');
  await visible(page.getByText('The task was interrupted. It will not repeat on its own and may have used quota. You can prepare another when you are ready.', { exact: true }));
  assert.equal(state.starts.length, failedStarts, 'History recovery never starts inference');
  await click('Summarize and explain with Codex');
  const activeRace = { ...state.runs[0], id: randomUUID(), state: 'RUNNING', artifactId: undefined, error: undefined };
  state.runs.unshift(activeRace); state.equivalentActive = true;
  await click('Allow this task'); await visible(page.getByRole('button', { name: 'Cancel task', exact: true }));
  await click('Cancel task'); assert.equal(activeRace.state, 'CANCELLED');
  state.mode = 'success'; console.log('✓ Failed/interrupted tasks, initial history failure and active-task race recover without duplicate inference');


  await goto(`/documents?jobId=${ids.job}`); await locale('en');
  const factCheckbox = page.locator('.fact-pick input'); if (!(await factCheckbox.isChecked())) await factCheckbox.check();
  await click('Improve wording for this job'); await click('Allow this task'); await click('Review my resume suggestions');
  const resumeText = page.getByRole('textbox', { name: 'Text that will appear in the resume', exact: true });
  await resumeText.fill('Reviewed fictional experience wording.'); assert.equal(state.resumeSaves.length, 0);
  await click('Generate and review the PDF');
  assert.equal(state.resumeSaves[0].selections[0].text, 'Reviewed fictional experience wording.');
  assert.equal(await resumeText.inputValue(), 'Reviewed fictional experience wording.', 'Failed PDF save preserves edits');
  await screenshot('resume-review-en.png');
  await goto(`/jobs/${ids.job}`); await goto(`/documents?jobId=${ids.job}`);
  await click('View the saved suggestion'); await click('Review my resume suggestions');
  await page.waitForFunction(() => document.querySelector('section[aria-label="Review resume wording"] textarea')?.disabled === false);
  assert.equal(await page.getByRole('textbox', { name: 'Text that will appear in the resume', exact: true }).inputValue(), 'Reviewed fictional experience wording.', 'Review edits recover after navigation');
  assert.equal(await page.getByRole('button', { name: 'Generate and review', exact: true }).count(), 0, 'Ordinary generation is hidden during AI review');
  await page.getByRole('combobox', { name: 'PDF language', exact: true }).selectOption('es');
  assert.equal(await page.getByRole('button', { name: 'Generate and review the PDF', exact: true }).isEnabled(), false, 'Changed language blocks stale review');
  await page.getByRole('combobox', { name: 'PDF language', exact: true }).selectOption('en');
  assert.equal(await page.getByRole('button', { name: 'Generate and review the PDF', exact: true }).isEnabled(), true);
  await page.getByRole('checkbox', { name: 'Use suggestion 1', exact: true }).uncheck();
  const savedResumeCount = state.resumeSaves.length;
  await click('Continue with my original wording'); await visible(page.getByRole('button', { name: 'Generate and review', exact: true }));
  assert.equal(state.resumeSaves.length, savedResumeCount, 'Choosing originals does not submit AI proposals');
  console.log('✓ Resume edits survive errors/navigation; changed context blocks stale review; all-original wording returns to ordinary generation');

  await goto('/profile'); await page.getByText('Saved answers · optional', { exact: true }).click();
  const answerRow = page.locator('.answer-row').filter({ hasText: question.questionText });
  assert.equal(await answerRow.getByRole('button', { name: 'Approve answer', exact: true }).isEnabled(), false);
  await answerRow.getByText('Draft an answer from my experience', { exact: true }).click();
  assert.equal(await answerRow.getByRole('checkbox', { checked: true }).count(), 0);
  await answerRow.getByRole('checkbox', { name: /Built a fictional/ }).check();
  await answerRow.getByRole('button', { name: 'Draft with Codex', exact: true }).click(); await click('Allow this task'); await click('Review and edit my answer');
  await page.getByRole('textbox', { name: 'Answer to save', exact: true }).fill('My reviewed fictional answer.'); assert.equal(state.savedAnswers.length, 0);
  await click('Review and edit my answer');
  assert.equal(await page.getByRole('textbox', { name: 'Answer to save', exact: true }).inputValue(), 'My reviewed fictional answer.');
  state.answerSaveFailure = true; await click('Save answer for review');
  await visible(answerRow.locator('[role="alert"]'));
  await click('Review and edit my answer');
  assert.equal(await page.getByRole('textbox', { name: 'Answer to save', exact: true }).inputValue(), 'My reviewed fictional answer.', 'Repeated review after failed save preserves manual text');
  await click('Save answer for review'); assert.equal(state.savedAnswers[0].text, 'My reviewed fictional answer.'); assert.equal(question.approvalStatus, 'UNANSWERED');
  await visible(answerRow.getByRole('button', { name: 'Approve answer', exact: true }));
  await page.getByRole('textbox', { name: 'What is the application asking?', exact: true }).fill('Do you have permission to work in Spain?');
  await page.getByRole('combobox', { name: 'Country it applies to', exact: true }).selectOption('ES');
  await click('Save question for later'); assert.equal(state.questionSaves[0].value, null);
  console.log('✓ Experience answer selection, editable review, save still unapproved and empty question saving');
  await answerRow.getByText('Draft an answer from my experience', { exact: true }).click();
  await answerRow.getByRole('checkbox', { name: /Built a fictional/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Alex Revised');
  await click('Save my details');
  await visible(answerRow.getByText('Your profile changed. Choose the experience you want to share again. Any answer you are editing is preserved.', { exact: true }));
  assert.equal(await answerRow.getByRole('checkbox', { checked: true }).count(), 0);
  await answerRow.getByRole('checkbox', { name: /Built a fictional/ }).check();
  await answerRow.getByRole('button', { name: 'Draft with Codex', exact: true }).click();
  await visible(page.getByRole('button', { name: 'Allow this task', exact: true }));
  assert.deepEqual([...state.previews.values()].at(-1).selectedFactIds, [ids.fact]);
  console.log('✓ Profile revision clears invisible fact selections and allows a new explicit selection');
  question.reviewExpired = true; question.approvalStatus = 'USER_APPROVED';
  await goto('/profile'); await page.getByText('Saved answers · optional', { exact: true }).click();
  await visible(page.getByText('Needs updating', { exact: true }));
  assert.equal(await page.getByRole('button', { name: 'Approve answer', exact: true }).count(), 0);
  assert.equal(await page.getByText('Draft an answer from my experience', { exact: true }).count(), 0);
  question.reviewExpired = false;
  console.log('✓ Expired answers require editing instead of appearing reusable');



  await locale('es'); await page.setViewportSize({ width: 390, height: 844 }); await overflow();
  await screenshot('profile-mobile-es.png');
  await goto(`/jobs/${ids.job}`); await locale('en'); await click('See what happened to the task'); await overflow();
  await screenshot('job-mobile-en.png');
  await goto('/settings'); await locale('es'); await visible(page.getByRole('button', { name: 'Desconectar de Career Stack', exact: true })); await overflow();
  await screenshot('settings-mobile-es.png');
  for (const language of ['es', 'en']) {
    await locale(language);
    for (const width of [360, 768, 1096, 1440, 720]) {
      await page.setViewportSize({ width, height: width === 720 ? 450 : 900 });
      await overflow();
      const check = page.getByRole('button', { name: language === 'es' ? 'Actualizar conexión' : 'Refresh connection', exact: true });
      await check.focus(); await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.tagName === 'BUTTON'), true, 'Keyboard can reach the next account action');
      const box = await page.locator(':focus').boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, 'Focused action fits the viewport');
    }
    await screenshot(`settings-200-percent-equivalent-${language}.png`);
  }
  console.log('✓ 360/768/1096/1440 CSS-pixel widths in ES/EN and 720×450 equivalent to 200% at 1440×900; keyboard focus visible. No screen-reader or real-user claim.');
  state.policies[0].paused = false;
  await goto('/settings'); await locale('en');
  await page.getByText('Saved AI permissions', { exact: true }).click();
  await page.getByText('Summarize new jobs automatically · optional', { exact: true }).click();
  await visible(page.getByRole('button', { name: 'Pause summaries', exact: true }));
  const autoReads = state.automationReads;
  await click('Withdraw permission');
  await visible(page.getByText('Paused', { exact: true }));
  assert.ok(state.automationReads > autoReads, 'Revoking permission refreshes automatic help');
  state.policies[0].paused = false; state.consentRevokes = 0;
  await goto('/settings');
  await page.getByText('Saved AI permissions', { exact: true }).click();
  await visible(page.getByRole('button', { name: 'Withdraw permission', exact: true }));
  await page.getByText('Summarize new jobs automatically · optional', { exact: true }).click();
  const permissionRefresh = page.waitForResponse(res => new URL(res.url()).pathname === '/api/v1/ai/consents');
  await click('Pause summaries'); await permissionRefresh;
  console.log('✓ Permission revocation and automation pause refresh sibling panels');
  await locale('es');
  await click('Desconectar de Career Stack'); assert.equal(state.connected, false);
  await page.getByText('Historial local de ayuda con IA', { exact: true }).click();
  assert.equal(state.historyPreviews, 0, 'Opening history is not a delete request');
  await click('Revisar qué se puede borrar'); await visible(page.getByRole('heading', { name: 'Esto se puede borrar', exact: true }));
  assert.equal(state.historyClears, 0, 'Preview does not delete history');
  await click('Borrar este historial local');
  await visible(page.getByText('Historial borrado: 2 tareas, 1 propuestas y 0 registros de consumo.', { exact: true }));
  assert.equal(state.historyClears, 1, 'Only explicit deletion submits the reviewed preview');
  console.log('✓ Local history cleanup preview and explicit confirm work while disconnected (mock only)');

  // v0.9.2: contextual assistance, one form, inline connection and compact results.
  state.showSearches = true; state.connected = true; state.observed = true;
  await page.close(); page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => failures.push(error.message));
  await goto('/searches'); await locale('en');
  await visible(page.getByRole('link', { name: 'View saved summary', exact: true }));
  const scopes = page.getByRole('group', { name: 'Your searches', exact: true });
  assert.notEqual(await scopes.getByRole('button').nth(1).innerText(), await scopes.getByRole('button').nth(2).innerText(), 'Duplicate search labels are distinguishable');
  assert.equal(await page.getByRole('link', { name: 'Understand a job with Codex', exact: true }).count(), 0, 'No arbitrary first-job shortcut');
  await page.setViewportSize({ width: 390, height: 844 }); await overflow();
  await page.waitForFunction(() => document.querySelector('#app-sidebar').getBoundingClientRect().right <= 1);
  const bounds = await page.locator('#search-results').evaluate(el => ({ width: el.getBoundingClientRect().width, right: el.getBoundingClientRect().right, viewport: innerWidth }));
  assert.ok(bounds.right <= bounds.viewport, `Results must fit the viewport, not be clipped: ${JSON.stringify(bounds)}`);
  assert.deepEqual(await page.locator('#search-results > *').evaluateAll(nodes => nodes.filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => el.className)), [], 'Every results panel fits without hidden clipping');
  assert.ok(await page.locator('#search-result-list').evaluate(el => el.getBoundingClientRect().top < 1050), 'Jobs remain close to the first mobile screen');
  await screenshot('v092-results-mobile.png');
  const startsBefore = state.starts.length;
  await page.getByRole('link', { name: 'View saved summary', exact: true }).click();
  await visible(page.locator('#job-ai-assistance'));
  await page.waitForFunction(() => document.activeElement?.id === 'job-ai-assistance');
  await page.waitForFunction(() => { const y = document.getElementById('job-ai-assistance')?.getBoundingClientRect().top; return y !== undefined && y >= 0 && y < 200; });
  assert.equal(state.starts.length, startsBefore, 'Opening a summary never starts inference');
  await goto('/searches');
  await page.getByText(/Codex help and automatic summaries · Connected/, { exact: true }).click();
  await page.getByText('Enable automatic summaries', { exact: true }).click();
  await page.getByRole('link', { name: `${job.title} · ${job.company}`, exact: true }).click();
  await visible(page.getByText(/Step 1: request and read this summary/));
  assert.equal(state.starts.length, startsBefore, 'Opening automatic setup does not authorize a task');
  await goto('/searches'); await click('New search'); await click('Describe with Codex');
  const requestBox = page.getByRole('textbox', { name: 'What job would you like to find?', exact: true });
  await requestBox.fill('QA in Spain');
  assert.equal(await page.getByLabel('Role or keywords', { exact: true }).count(), 0, 'Only the AI form is visible');
  await click('Choose filters'); assert.equal(await requestBox.count(), 0);
  await click('Describe with Codex'); assert.equal(await requestBox.inputValue(), 'QA in Spain', 'Mode switches preserve the request');
  state.connected = false; state.observed = false;
  await goto('/settings'); await goto('/searches');
  await click('Connect Codex here'); await click('Check Codex'); await click('Use this account');
  await visible(page.getByText('Account ready. Continue with your request below; you will review the data before sharing it.', { exact: true }));
  assert.equal(await requestBox.inputValue(), 'QA in Spain'); assert.equal(new URL(page.url()).pathname, '/searches');
  assert.equal(state.starts.length, startsBefore, 'Inline connection does not consume quota');
  await locale('es'); await visible(page.getByRole('button', { name: 'Elegir filtros', exact: true })); await overflow();
  await screenshot('v092-inline-connection-es.png');
  await goto(`/applications?id=${ids.application}`);
  const resume = page.locator('.application-resume');
  await visible(resume.getByRole('link', { name: 'Revisar CV pendiente', exact: true }));
  assert.ok((await resume.getByRole('link', { name: 'Descargar CV elegido', exact: true }).getAttribute('class')).includes('button-quiet'));
  await overflow(); await screenshot('v092-pending-cv-es.png');
  state.documentApproval = 'USER_APPROVED'; await page.reload(); await locale('en');
  await visible(resume.getByText('You reviewed this resume. Download it to continue on the employer’s page.', { exact: true }));
  assert.equal(await resume.getByRole('link', { name: 'Download selected resume', exact: true }).getAttribute('class'), 'button ');
  state.connectionFailure = true; await goto('/searches');
  await visible(page.getByRole('button', { name: 'Retry connection', exact: true }));
  assert.equal(await page.getByText('Account ready. Continue with your request below; you will review the data before sharing it.', { exact: true }).count(), 0, 'A failed refresh does not claim a ready account');
  state.connectionFailure = false; await click('Retry connection');
  await visible(page.getByText('Account ready. Continue with your request below; you will review the data before sharing it.', { exact: true }));
  state.automationFailure = true; await page.close(); page = await context.newPage();
  await goto('/searches'); await locale('en');
  await page.getByText(/Codex help and automatic summaries · Connected/, { exact: true }).click();
  await visible(page.getByText('Could not check automatic summaries. Manual help is still available on each job.', { exact: true }));
  await visible(page.getByRole('link', { name: 'View saved summary', exact: true }));
  state.automationFailure = false; await click('Retry summary status');
  assert.equal(state.starts.length, startsBefore, 'Status recovery never starts inference');
  console.log('✓ v0.9.2 single search entry, duplicate labels, mobile density, exact-job anchor, automatic setup and inline connection');
  assert.deepEqual(unmatched, [], 'Every non-session API must be intercepted'); assert.deepEqual(failures, [], 'No browser errors');
  console.log('✓ ES/EN and 390px mobile layouts; no unexpected API calls or browser errors');
} catch (error) {
  await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Unmatched mock requests:', unmatched); throw error;
} finally { await context.close(); await browser.close(); }
