import { v071Scenarios } from './v071.js';
import { v070Scenario } from './v070.js';
import { v061Scenario } from './v061.js';
import { v060Scenario } from './v060.js';
import type { PgClient } from './isolation.js';
import { v052Scenario } from './v052.js';
import { v051First, v051Last } from './v051.js';
import { v050Scenarios } from './v050.js';
import { v041Scenarios } from './v041.js';
import { uxReviewScenarios } from './ux-review.js';
import { v040Scenarios } from './v040.js';
import { patchScenarios } from './v031.js';
import { v053Scenarios } from './v053.js';
// Browser scenarios. Each one creates its own fictional records tagged with the run marker, asserts the
// user-visible behaviour and checks the outcome against the isolated API as ground truth.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { any, errorFeedback, eventually, goTo, hasHorizontalOverflow, mainNavigation, routes, setLocale, signIn, type ApiClient } from './ui.js';

type Fact = { id: string; statement: string; approvalStatus: string };
type Profile = { revision: number; profile: Record<string, unknown>; facts: Fact[] };
type DocumentVersion = { id: string; name: string; revision: number; storagePath: string; sha256: string };
type Application = { id: string; role: string; company: string; recruitmentStage: string; state: string; version: number };
type ApplicationEvent = { eventType: string; priorState: string | null; newState: string | null };

export type ScenarioContext = {
  page: Page;
  context: BrowserContext;
  api: ApiClient;
  db: PgClient;
  uiUrl: string;
  marker: string;
  token: () => Promise<string>;
  artifacts: string;
  /** Console errors matching these patterns are expected for the current scenario (e.g. an intercepted 500). */
  allowConsole: (pattern: RegExp) => void;
  /** Non-blocking observation printed in the summary. */
  note: (message: string) => void;
};

export type Scenario = { name: string; run: (ctx: ScenarioContext) => Promise<void> };

const createApprovedFact = async (api: ApiClient, statement: string) => {
  const fact = await api.post<Fact>('/profile/facts', { kind: 'achievement', statement, tags: ['e2e'] });
  await api.post(`/profile/facts/${fact.id}/approve`);
  return fact;
};

const factsWith = async (api: ApiClient, statement: string) => (await api.get<Profile>('/profile')).facts.filter((fact) => fact.statement === statement);

/** The profile form is the form that contains the name field. */
const profileForm = (page: Page) => page.locator('form').filter({ has: page.getByLabel(/^(Nombre|Name|Full name|Nombre completo)$/i) }).first();

export const scenarios: Scenario[] = [
  {
    name: 'sign-in-and-language-switch',
    async run({ page, uiUrl, token }) {
      await signIn(page, uiUrl, await token());
      await setLocale(page, 'es');
      await mainNavigation(page).locator('a[href="/jobs"]').filter({ hasText: /Ofertas guardadas/i }).waitFor();
      await setLocale(page, 'en');
      await mainNavigation(page).locator('a[href="/jobs"]').filter({ hasText: /Jobs/i }).waitFor();
      await page.waitForFunction(() => document.title === 'Career Stack · Your career space');
      await setLocale(page, 'es');
      await page.waitForFunction(() => document.title === 'Career Stack · Tu espacio de carrera');
      assert.equal(await hasHorizontalOverflow(page), false, 'Overview overflows horizontally at desktop width');
    },
  },
  {
    name: 'es-en-labels-on-every-page',
    async run({ page }) {
      // Interface words that must not leak into the other language. User data is fictional and avoids these words.
      const spanishOnly = /\b(Ofertas|Solicitudes|Mi perfil|Documentos|Fuentes|Privacidad|Guardar|Añadir|Aprobar|Cancelar|Descargar|Borrador|Empresa|Puesto|Ubicación|Resumen|Sin fecha|Aún no|Todavía|Abrir menú|Cerrar menú)\b/;
      const englishOnly = /\b(Jobs|Applications|My profile|Documents|Sources|Privacy|Save|Approve|Cancel|Download|Draft|Company|Location|Overview|No date|Not yet|Open menu|Close menu)\b/;
      const leaks: string[] = [];
      for (const locale of ['en', 'es'] as const) {
        await setLocale(page, locale);
        for (const route of routes) {
          await goTo(page, route);
          await page.waitForLoadState('networkidle').catch(() => undefined);
          const text = await page.evaluate(() => {
            const attributes = [...document.querySelectorAll('[aria-label],[placeholder],[title]')].flatMap((element) => ['aria-label', 'placeholder', 'title'].map((name) => element.getAttribute(name) ?? ''));
            return `${document.body.innerText}\n${attributes.join('\n')}`;
          });
          const lang = (await page.locator('html').getAttribute('lang')) ?? '';
          const title = await page.title();
          if (title !== (locale === 'en' ? 'Career Stack · Your career space' : 'Career Stack · Tu espacio de carrera')) leaks.push(`${route} (${locale}): unexpected tab title`);
          if (!lang.startsWith(locale)) leaks.push(`${route} (${locale}): html lang is "${lang}"`);
          const leaked = text.match(locale === 'en' ? spanishOnly : englishOnly);
          if (leaked) leaks.push(`${route} (${locale}): "${leaked[0]}" in ${locale === 'en' ? 'English' : 'Spanish'} mode`);
        }
      }
      await setLocale(page, 'es');
      assert.deepEqual(leaks, [], `Untranslated interface text:\n${leaks.join('\n')}`);
    },
  },
  {
    name: 'draft-preserved-when-save-fails',
    async run({ page, api, marker, allowConsole }) {
      allowConsole(/Failed to load resource|500|Internal Server Error/i);
      await goTo(page, '/profile');

      // Fact draft: a failed save must keep the text so the user does not lose it.
      await page.getByLabel(any('Qué quieres añadir', 'What would you like to add')).selectOption('achievement');
      const statement = `Draft kept after failure ${marker}`;
      const factField = page.getByLabel(any('Describe tu experiencia o logro', 'Describe your experience or achievement')).first();
      await factField.fill(statement);
      let failedOnce = false;
      await page.route('**/api/v1/profile/facts', async (route) => {
        if (route.request().method() === 'POST' && !failedOnce) { failedOnce = true; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'INTERNAL' }) }); }
        return route.continue();
      });
      await page.getByRole('button', { name: any('Añadir para revisar', 'Add for review') }).click();
      await errorFeedback(page).waitFor();
      assert.ok(failedOnce, 'The intercepted save was not attempted');
      assert.equal(await factField.inputValue(), statement, 'Fact draft text was lost after a failed save');
      assert.equal((await factsWith(api, statement)).length, 0, 'A failed save must not create the fact');
      await page.unroute('**/api/v1/profile/facts');
      await page.getByRole('button', { name: any('Añadir para revisar', 'Add for review') }).click();
      await eventually(() => factsWith(api, statement), (facts) => facts.length === 1, 'Retrying after the failure should save the fact exactly once');
      await page.getByRole('button', { name: any('Revisar después', 'Review later'), exact: true }).click();
      await eventually(() => factField.inputValue(), (value) => value === '', 'Fact field should clear after a successful save');

      // Profile draft: same expectation for the profile form.
      const form = profileForm(page);
      const nameField = form.getByLabel(/^(Nombre|Name|Full name|Nombre completo)$/i).first();
      const draftName = `Alex Example ${marker}`;
      await nameField.fill(draftName);
      await form.getByLabel(/^(Correo|Email)$/i).fill('alex@example.com');
      const revisionBefore = (await api.get<Profile>('/profile')).revision;
      let profileFailed = false;
      await page.route('**/api/v1/profile', async (route) => {
        if (route.request().method() === 'PUT' && !profileFailed) { profileFailed = true; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'INTERNAL' }) }); }
        return route.continue();
      });
      await form.getByRole('button', { name: any('Guardar', 'Save') }).first().click();
      await errorFeedback(page).waitFor();
      assert.ok(profileFailed, 'The intercepted profile save was not attempted');
      assert.equal(await nameField.inputValue(), draftName, 'Profile draft was lost after a failed save');
      assert.equal((await api.get<Profile>('/profile')).revision, revisionBefore, 'A failed save must not create a profile revision');
      await page.unroute('**/api/v1/profile');
      await form.getByRole('button', { name: any('Guardar', 'Save') }).first().click();
      await eventually(async () => (await api.get<Profile>('/profile')).revision, (revision) => revision === revisionBefore + 1, 'Retrying should create exactly one new profile revision');
    },
  },
  {
    name: 'facts-not-duplicated-after-profile-revision',
    async run({ page, api, marker }) {
      const statement = `Reduced flaky tests by 40 percent ${marker}`;
      await createApprovedFact(api, statement);
      await goTo(page, '/profile');
      const form = profileForm(page);
      const revisionBefore = (await api.get<Profile>('/profile')).revision;
      await form.getByLabel(/^(Nombre|Name|Full name|Nombre completo)$/i).first().fill(`Sam Example ${marker}`);
      await form.getByRole('button', { name: any('Guardar', 'Save') }).first().click();
      await eventually(async () => (await api.get<Profile>('/profile')).revision, (revision) => revision > revisionBefore, 'Profile save should create a new revision');
      // A second revision through the API, as another tab or a later edit would do.
      const latest = await api.get<Profile>('/profile');
      await api.put('/profile', { profile: { ...latest.profile, preferences: { targetTitles: ['SDET'], workModes: ['remote'] } } });

      const facts = await factsWith(api, statement);
      assert.equal(facts.length, 1, `Fact listed ${facts.length} times after two profile revisions`);
      assert.equal(facts[0]?.approvalStatus, 'USER_APPROVED', 'Fact approval must survive a profile revision');

      await page.reload();
      await page.getByRole('heading', { level: 1 }).first().waitFor();
      await page.getByText(statement, { exact: true }).first().waitFor();
      assert.equal(await page.getByText(statement, { exact: true }).count(), 1, 'Profile page shows the fact more than once');
      await goTo(page, '/documents');
      await page.getByText(statement, { exact: true }).first().waitFor();
      assert.equal(await page.getByText(statement, { exact: true }).count(), 1, 'Document fact picker shows the fact more than once');
    },
  },
  {
    name: 'same-name-pdf-creates-distinct-versions',
    async run({ page, api, marker, artifacts, note }) {
      const statement = `Built an API regression suite ${marker}`;
      await createApprovedFact(api, statement);
      const name = `Resume ${marker}`;
      const documentsNamed = async () => (await api.get<DocumentVersion[]>('/documents')).filter((document) => document.name === name);
      await goTo(page, '/documents');
      for (const expected of [1, 2]) {
        if (expected === 2) await page.getByRole('button', { name: any('Cambiar contenido del CV', 'Change resume content') }).click();
        await page.getByLabel(any('Nombre de la versión', 'Version name')).first().fill(name);
        const checkbox = page.getByRole('checkbox', { name: new RegExp(statement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first();
        const fallback = page.locator('label').filter({ hasText: statement }).getByRole('checkbox').first();
        const pick = (await checkbox.count()) ? checkbox : fallback;
        if (!(await pick.isChecked())) await pick.check();
        await page.getByRole('button', { name: any('Generar y revisar', 'Generate and review') }).click();
        await eventually(documentsNamed, (rows) => rows.length === expected, `Expected ${expected} document version(s) named "${name}"`, 60_000);
      }
      const versions = await documentsNamed();
      assert.equal(new Set(versions.map((version) => version.id)).size, 2, 'Both generations must be separate records');
      assert.equal(new Set(versions.map((version) => version.storagePath)).size, 2, 'The second PDF overwrote or reused the first file path');
      assert.equal(new Set(versions.map((version) => version.revision)).size, 2, `Same-name versions must have distinct revision numbers (got ${versions.map((version) => version.revision).join(', ')})`);

      await page.reload();
      await page.getByRole('heading', { level: 1 }).first().waitFor();
      await page.getByRole('button', { name: /^(CV guardados|Saved resumes)/ }).click();
      for (const version of versions) await page.locator(`a[href*="/documents/${version.id}/file"]`).first().waitFor();
      const links = await page.locator('a[href*="/documents/"][href$="/file"]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href')));
      for (const version of versions) assert.ok(links.some((href) => href?.includes(version.id)), `No download link for version ${version.revision}`);
      for (const version of versions) {
        const bytes = await api.bytes(`/api/v1/documents/${version.id}/file`);
        assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'Download is not a PDF');
        const path = join(artifacts, `document-r${version.revision}.pdf`);
        await writeFile(path, bytes);
        try { assert.ok(execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' }).includes(statement), 'PDF does not contain the selected approved fact'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') note('pdftotext not installed: PDF text content not checked'); else throw error; }
      }
    },
  },
  {
    name: 'manual-job-and-application-tracking',
    async run({ page, api, marker, artifacts }) {
      const company = `Northwind ${marker}`;
      const title = `QA Automation ${marker}`;
      await goTo(page, '/jobs');
      await page.getByRole('button', { name: any('Añadir oferta', 'Add job', 'Add a job', 'Add role') }).first().click();
      await page.getByLabel(any('Empresa', 'Company')).first().fill(company);
      await page.getByLabel(any('Puesto', 'Role', 'Job title', 'Title')).first().fill(title);
      await page.getByLabel(any('URL oficial', 'Official job URL', 'Job URL', 'URL')).first().fill(`https://example.com/jobs/${marker}`);
      await page.getByRole('button', { name: any('Guardar y calcular', 'Save and score', 'Save and calculate', 'Guardar oferta', 'Save job') }).first().click();
      await page.getByRole('link', { name: title }).first().waitFor();
      const jobs = await api.get<Array<{ id: string; company: string }>>('/jobs');
      assert.equal(jobs.filter((job) => job.company === company).length, 1, 'Manual import should create exactly one job');
      await page.getByRole('link', { name: title }).first().click();
      await page.waitForURL(/\/jobs\/[^/?#]+/);
      await page.getByRole('heading', { name: title }).first().waitFor();
      await page.screenshot({ path: join(artifacts, 'job-detail.png'), fullPage: true });

      await goTo(page, '/applications');
      await page.getByRole('button', { name: any('Añadir solicitud', 'Add application', 'Registrar', 'Record') }).first().click();
      await page.getByLabel(any('Empresa', 'Company')).first().fill(company);
      await page.getByLabel(any('Puesto', 'Role', 'Job title')).first().fill(title);
      await page.getByRole('button', { name: any('Guardar solicitud', 'Save application', 'Guardar', 'Save') }).first().click();
      await page.getByRole('heading', { name: title }).first().waitFor();
      const note = `Prepare technical examples ${marker}`;
      const noteField = page.getByLabel(any('Añadir nota', 'Add a note', 'Add note', 'Nota', 'Note')).first();
      await noteField.fill(note);
      await page.getByRole('button', { name: any('Añadir nota', 'Add note', 'Save note', 'Guardar nota') }).first().click();
      await page.locator('.timeline-item').getByText(note, { exact: true }).waitFor();
      await eventually(() => noteField.inputValue(), (value) => value === '', 'Note field should clear after a successful save');
      await page.screenshot({ path: join(artifacts, 'application-tracker.png'), fullPage: true });
    },
  },
  {
    name: 'application-deep-link-and-stage-correction',
    async run({ page, api, uiUrl, marker }) {
      const company = `Contoso ${marker}`;
      const first = await api.post<Application>('/applications', { company, role: `Test Engineer A ${marker}` });
      const second = await api.post<Application>('/applications', { company, role: `Test Engineer B ${marker}` });

      await page.goto(`${uiUrl}/applications?id=${second.id}`);
      await page.getByRole('heading', { name: second.role }).first().waitFor();
      assert.equal(await page.getByRole('heading', { name: first.role }).count(), 0, '?id should open the requested application, not another one');
      await page.reload();
      await page.getByRole('heading', { name: second.role }).first().waitFor();

      const readSecond = async () => (await api.get<Application[]>('/applications')).find((application) => application.id === second.id)!;
      const stage = page.getByLabel(any('Etapa de selección', 'Recruitment stage', 'Selection stage', 'Etapa', 'Stage')).first();
      await stage.selectOption('INTERVIEW');
      await eventually(async () => (await readSecond()).recruitmentStage, (value) => value === 'INTERVIEW', 'Stage should advance to INTERVIEW');

      // Correct a mistaken selection back to an earlier stage. The UI may ask for confirmation or a reason.
      await stage.selectOption('RECRUITER_CONTACT');
      const reason = page.getByLabel(any('Motivo', 'Reason')).first();
      if (await reason.isVisible().catch(() => false)) await reason.fill(`Selected the wrong stage ${marker}`);
      const confirm = page.getByRole('button', { name: any('Corregir', 'Correct', 'Confirmar', 'Confirm') }).first();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
      await eventually(async () => (await readSecond()).recruitmentStage, (value) => value === 'RECRUITER_CONTACT', 'Stage correction to an earlier stage should be saved', 15_000);
      const events = await api.get<ApplicationEvent[]>(`/applications/${second.id}/events`);
      assert.ok(events.some((event) => event.newState === 'RECRUITER_CONTACT' && event.priorState === 'INTERVIEW'), 'The correction must be recorded in the history');
      assert.equal((await api.get<Application[]>('/applications')).find((application) => application.id === first.id)?.recruitmentStage, 'NO_RESPONSE', 'Correcting one application changed another');
      assert.match(page.url(), new RegExp(`[?&]id=${second.id}`), 'Application context (?id) was lost after updating the stage');

      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#app-sidebar').waitFor({ state: 'hidden' });
      const firstEntry = page.getByText(first.role).first();
      if (await firstEntry.isVisible().catch(() => false)) {
        await firstEntry.click();
        await page.getByRole('heading', { name: first.role }).first().waitFor();
        await page.waitForURL((url) => url.searchParams.get('id') === first.id);
        const detail = page.getByRole('heading', { name: first.role, exact: true });
        await eventually(() => detail.evaluate((node) => node === document.activeElement), Boolean, 'Selected application receives keyboard focus');
        await eventually(() => detail.boundingBox(), (rect) => Boolean(rect && rect.y >= 50 && rect.y < 844), 'Selected application is brought into view on mobile');
        await page.getByRole('button', { name: any('Volver a la lista de solicitudes', 'Back to application list') }).click();
        await eventually(() => page.getByRole('heading', { name: any('Lista de solicitudes', 'Application list') }).evaluate((node) => node === document.activeElement), Boolean, 'Back action focuses the application list');
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    },
  },
  {
    name: 'source-review-and-partial-results',
    async run({ page, api, marker }) {
      const board = await api.post<{ id: string }>('/boards', { provider: 'greenhouse', tenant: marker, region: 'global', companyName: `Source ${marker}`, companyDomain: 'example.com', careersUrl: 'https://example.com/careers', permissionStatus: 'UNKNOWN', associationStatus: 'UNVERIFIED', enabled: false });
      await goTo(page, '/boards');
      const card = page.locator('.board-card').filter({ hasText: `Source ${marker}` });
      const confirm = card.getByRole('button', { name: any('Confirmar empresa', 'Confirm company') });
      await confirm.waitFor();
      assert.equal(await confirm.isDisabled(), true, 'New sources require both confirmations');
      await card.getByRole('checkbox').nth(0).check();
      assert.equal(await confirm.isDisabled(), true, 'One confirmation is insufficient');
      await card.getByRole('checkbox').nth(1).check();
      await confirm.click();
      const search = card.getByRole('button', { name: any('Buscar ofertas nuevas', 'Find new jobs') });
      await search.waitFor();
      // Only the refresh result is mocked: creation, review and disabling use the isolated API.
      // This prevents test fixtures from making outbound requests or importing real jobs.
      const routePattern = `**/api/v1/boards/${board.id}/refresh`;
      await page.route(routePattern, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ added: 0, updated: 0, coverage: 'PARTIAL', skipped: 2 }) }));
      try { await search.click(); await page.getByText(any('No pudimos leer 2 registros', 'We could not read 2 records')).waitFor(); }
      finally { await page.unroute(routePattern); }
      await card.getByRole('button', { name: any('Desactivar', 'Turn off') }).click();
      await card.getByRole('button', { name: any('Confirmar y reactivar', 'Confirm and turn back on') }).waitFor();
      const row = (await api.get<Array<{ id: string; enabled: boolean }>>('/boards')).find((item) => item.id === board.id);
      assert.equal(row?.enabled, false, 'Source remains disabled in the database');
    },
  },
  {
    name: 'export-download-and-error-recovery',
    async run({ page, allowConsole }) {
      await goTo(page, '/settings');
      await page.getByText(/^(Exportar a otra herramienta · avanzado|Export to another tool · advanced)$/).click();
      const downloadButton = page.getByRole('button', { name: any('Descargar mis datos', 'Download my data') });
      allowConsole(/409|Conflict/);
      const failExport = async (route: import('playwright').Route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'DOCUMENT_FILE_UNAVAILABLE' }) });
      await page.route('**/api/v1/export', failExport);
      try {
        await downloadButton.click();
        await errorFeedback(page).waitFor();
        await page.getByText(any('El archivo PDF ya no está disponible', 'The PDF file is no longer available')).waitFor();
        assert.equal(await downloadButton.isEnabled(), true, 'Export can be retried after a failed request');
      } finally { await page.unroute('**/api/v1/export', failExport); }
      const downloaded = page.waitForEvent('download');
      await downloadButton.click();
      const download = await downloaded;
      const path = await download.path();
      assert.ok(path, 'An export must be downloaded');
      const payload = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(payload.format, 'career-agent-stack-export');
      assert.equal(payload.sha256, createHash('sha256').update(JSON.stringify(payload.data)).digest('hex'), 'Export checksum must match its contents');
      assert.ok(payload.data.workspace?.id, 'Export contains the workspace');
      assert.ok(payload.data.boards.every((board: { enabled: boolean; permissionStatus: string }) => !board.enabled && board.permissionStatus === 'UNKNOWN'), 'Exported board permissions are disabled');
      assert.ok(!JSON.stringify(payload).includes('APP_SESSION_SECRET'), 'Export must not contain configuration credentials');
      await eventually(() => downloadButton.isEnabled(), Boolean, 'Export button becomes available again');
    },
  },
  {
    name: 'mobile-drawer-keyboard-and-focus',
    async run({ page, artifacts }) {
      await page.setViewportSize({ width: 390, height: 844 });
      await goTo(page, '/jobs');
      assert.equal(await hasHorizontalOverflow(page), false, 'Jobs page overflows horizontally on mobile');
      const menuButton = page.locator('button[aria-controls="app-sidebar"]');
      // The drawer is the dialog or sidebar that holds the main navigation.
      const focusInDrawer = () => mainNavigation(page).evaluate((nav) => (nav.closest('aside, [role="dialog"]') ?? nav).contains(document.activeElement));

      await menuButton.focus();
      await page.keyboard.press('Enter');
      await eventually(() => menuButton.getAttribute('aria-expanded'), (value) => value === 'true', 'Menu button should report aria-expanded=true when open');
      await mainNavigation(page).waitFor({ state: 'visible' });
      await eventually(() => focusInDrawer(), Boolean, 'Opening the drawer should move focus into it', 3_000);
      for (let index = 0; index < 15; index += 1) {
        await page.keyboard.press('Tab');
        const inside = await focusInDrawer();
        const onToggle = await menuButton.evaluate((button) => button === document.activeElement);
        assert.ok(inside || onToggle, `Tab #${index + 1} moved focus behind the open drawer`);
      }
      await page.keyboard.press('Escape');
      await eventually(() => menuButton.getAttribute('aria-expanded'), (value) => value === 'false', 'Escape should close the drawer');
      assert.ok(await menuButton.evaluate((button) => button === document.activeElement), 'Focus should return to the menu button after closing');

      await page.keyboard.press('Enter');
      await eventually(() => focusInDrawer(), Boolean, 'Reopening should move focus into the drawer', 3_000);
      const target = mainNavigation(page).locator('a[href="/applications"]').first();
      await target.focus();
      await page.keyboard.press('Enter');
      await page.waitForURL((url) => url.pathname === '/applications');
      await eventually(() => menuButton.getAttribute('aria-expanded'), (value) => value === 'false', 'Navigating should close the drawer');
      await page.getByText(any('Cargando solicitudes…', 'Loading applications…'), { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await hasHorizontalOverflow(page), false, 'Applications page overflows horizontally on mobile');
      await page.screenshot({ path: join(artifacts, 'mobile-applications.png'), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
    },
  },
];

scenarios.push({
  name: 'assisted-application-preparation',
  async run({ page, api, marker, artifacts, note }) {
    const profile = await api.get<Profile>('/profile');
    await api.put('/profile', { profile: { ...profile.profile, identity: { fullName: 'Fictional Candidate', email: 'fictional@example.test', country: 'ES' } }, expectedRevision: profile.revision });
    const fact = await createApprovedFact(api, `Fictional assisted application fixture ${marker}`);
    const doc = await api.post<DocumentVersion>('/documents', { name: `Fixture ${marker}`, factIds: [fact.id], locale: 'en' });
    await api.post(`/documents/${doc.id}/approve`, { confirmReviewed: true });
    const application = await api.post<Application>('/applications', { company: 'Fictional', role: `Fixture ${marker}`, canonicalUrl: 'https://jobs.lever.co/example/11111111-1111-4111-8111-111111111111', state: 'DRAFT' });
    await setLocale(page, 'es'); await page.goto(new URL(`/applications?id=${application.id}`, page.url()).toString());
    const panel = page.locator('.assist-panel'); await panel.getByRole('button', { name: 'Revisar datos y destino', exact: true }).waitFor();
    await panel.getByLabel('CV aprobado para esta solicitud', { exact: true }).selectOption(doc.id);
    await panel.getByLabel('Teléfono (opcional)', { exact: true }).fill('+34000000000');
    await panel.getByRole('button', { name: 'Revisar datos y destino', exact: true }).click();
    const open = panel.getByRole('button', { name: 'Abrir y autocompletar', exact: true }); await open.waitFor();
    assert.equal(await open.isDisabled(), true, 'Opening the external page requires explicit consent');
    assert.match(await panel.innerText(), /fictional@example.test/);
    const state = await api.get<{ attempts: Array<{ id: string; status: string; consentedAt: string | null }> }>(`/applications/${application.id}/assist`);
    assert.equal(state.attempts[0]?.status, 'PREPARED'); assert.equal(state.attempts[0]?.consentedAt, null);
    await panel.getByRole('checkbox').check(); assert.equal(await open.isEnabled(), true);
    await panel.getByRole('checkbox').uncheck();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#app-sidebar').waitFor({ state: 'hidden' });
    assert.equal(await hasHorizontalOverflow(page), false, 'Consent view overflows on mobile');
    await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(artifacts, 'assisted-preparation-es-mobile.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await setLocale(page, 'en'); await panel.getByRole('button', { name: 'Open and autofill', exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Open and autofill', exact: true }).isDisabled(), true);
    await panel.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
    await eventually(() => api.get<{ attempts: Array<{ status: string }> }>(`/applications/${application.id}/assist`), value => value.attempts[0]?.status === 'CANCELLED', 'Preparation can be cancelled without opening any browser');
    await panel.getByRole('button', { name: 'Review data and destination', exact: true }).waitFor();
    await page.screenshot({ path: join(artifacts, 'assisted-preparation-en.png'), fullPage: true });
    // UI-only REVIEW fixture: every submission request is intercepted before it reaches the API/browser.
    const fixtureState = await api.get<{ attempts: Array<Record<string, unknown>> }>(`/applications/${application.id}/assist`);
    let reviewAttempt: Record<string, unknown> & { status: string; result: Record<string, unknown> } = { ...fixtureState.attempts[0]!, status: 'REVIEW', result: {} };
    let submissionRequests = 0;
    const assistRoute = `**/api/v1/applications/${application.id}/assist`;
    const submitRoute = `**/api/v1/assisted-attempts/${String(reviewAttempt.id)}/submit`;
    await page.route(assistRoute, (route) => route.fulfill({ json: { ...fixtureState, attempts: [reviewAttempt] } }));
    await page.route(submitRoute, async (route) => {
      submissionRequests++;
      assert.deepEqual(route.request().postDataJSON(), { consent: true, expectedDigest: reviewAttempt.digest });
      reviewAttempt = { ...reviewAttempt, status: 'UNKNOWN', result: { reason: 'ASSIST_SUBMISSION_UNCERTAIN' } };
      await route.fulfill({ json: reviewAttempt });
    });
    try {
      await page.reload();
      for (const locale of ['en', 'es'] as const) {
        await setLocale(page, locale);
        const submit = panel.getByRole('button', { name: locale === 'es' ? 'Adjuntar CV y enviar solicitud' : 'Attach resume and submit application', exact: true });
        await submit.waitFor(); assert.equal(await submit.isDisabled(), true);
        const permission = panel.getByRole('checkbox', { name: locale === 'es' ? /Autorizo una sola vez/ : /I authorize the app once/ });
        await permission.check(); assert.equal(await submit.isEnabled(), true); await permission.uncheck();
        assert.equal(submissionRequests, 0);
        await page.setViewportSize({ width: 320, height: 844 });
        await page.locator('#app-sidebar').waitFor({ state: 'hidden' });
        const overflowing = await page.evaluate(() => Array.from(document.querySelectorAll('main *')).filter((node) => node.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map((node) => ({ tag: node.tagName, class: node.className, text: node.textContent?.slice(0, 60), width: node.getBoundingClientRect().width })).slice(-12));
        assert.equal(await hasHorizontalOverflow(page), false, `Submission review fits ${locale} at 320px: ${JSON.stringify(overflowing)}`);
      }
      await panel.getByRole('checkbox', { name: /Autorizo una sola vez/ }).check();
      await panel.getByRole('button', { name: 'Adjuntar CV y enviar solicitud', exact: true }).click();
      await panel.getByText(/No sabemos si se envió/).waitFor();
      assert.equal(submissionRequests, 1);
      assert.equal(await panel.getByRole('button', { name: 'Adjuntar CV y enviar solicitud', exact: true }).count(), 0);
      await page.screenshot({ path: join(artifacts, 'v070-submit-unknown-es-mobile.png'), fullPage: true });
    } finally { await page.unroute(assistRoute); await page.unroute(submitRoute); }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await setLocale(page, 'es');
    note('Consent preview uses the isolated API; submission consent/UNKNOWN UI uses intercepted fictional responses. No ATS page was opened. Actual browser transmission is tested separately against synthetic forms.');
  },
});

scenarios.push(...patchScenarios);

scenarios.push(...v040Scenarios);

scenarios.push(...uxReviewScenarios);

scenarios.push(...v041Scenarios);

scenarios.splice(1, 0, v050Scenarios[0]!);
scenarios.push(v050Scenarios[1]!);

scenarios.splice(1, 0, v051First);
// v053 leaves current approved PDFs behind; v052's printed-name change then restores the guide state v051Last expects.
scenarios.push(...v053Scenarios);
scenarios.push(v052Scenario);
// The final sign-out scenario must remain last.
scenarios.push(v060Scenario);
scenarios.push(v061Scenario);
scenarios.push(v070Scenario);
scenarios.push(...v071Scenarios);
scenarios.push(v051Last);
