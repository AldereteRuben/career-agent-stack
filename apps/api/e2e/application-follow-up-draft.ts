import assert from 'node:assert/strict';
import type { Scenario } from './scenarios.js';
import { hasHorizontalOverflow, setLocale } from './ui.js';

export const applicationFollowUpDraftScenario: Scenario = {
  name: 'application-follow-up-draft',
  async run({ page, api, db, uiUrl, marker, note }) {
    const application = await api.post<{ id: string }>('/applications', {
      company: `Follow-up Co ${marker}`, role: `QA follow-up ${marker}`, state: 'DRAFT', notes: '',
    });
    await setLocale(page, 'en');
    await page.goto(new URL(`/applications?id=${application.id}`, uiUrl).toString());
    await page.locator('.application-detail-follow-up > summary').click();
    const editor = page.locator('.application-follow-up-draft');
    await editor.getByRole('heading', { name: 'Follow-up email draft' }).waitFor();
    await editor.getByRole('button', { name: 'Start from a template' }).click();
    const subject = editor.getByLabel('Subject'); const body = editor.getByLabel('Message');
    assert.match(await subject.inputValue(), new RegExp(`QA follow-up ${marker}`));
    assert.match(await subject.inputValue(), new RegExp(`Follow-up Co ${marker}`));
    assert.match(await body.inputValue(), /Hello,/);

    await editor.getByLabel('Email language').selectOption('es');
    page.once('dialog', (dialog) => void dialog.accept());
    await editor.getByRole('button', { name: 'Start from a template' }).click();
    assert.match(await subject.inputValue(), /Seguimiento de mi candidatura/);
    assert.match(await body.inputValue(), /Hola,/);
    const [created] = await Promise.all([
      page.waitForResponse((response) => response.url().includes(`/applications/${application.id}/follow-up-draft`) && response.request().method() === 'POST'),
      editor.getByRole('button', { name: 'Save draft' }).click(),
    ]);
    assert.equal(created.status(), 201, 'the first save creates the workspace draft');

    await body.fill(`${await body.inputValue()}\n\n${marker} edited`);
    const [updated] = await Promise.all([
      page.waitForResponse((response) => response.url().includes(`/applications/${application.id}/follow-up-draft`) && response.request().method() === 'PUT'),
      editor.getByRole('button', { name: 'Save changes' }).click(),
    ]);
    assert.equal(updated.status(), 200, 'later saves update the same draft');
    const stored = await api.get<{ draft: { language: string; subject: string; body: string } }>(`/applications/${application.id}/follow-up-draft`);
    assert.equal(stored.draft.language, 'es'); assert.match(stored.draft.body, new RegExp(marker));

    const clipboardRequests: string[] = [];
    page.on('request', (request) => { if (request.url().includes(`/applications/${application.id}/follow-up-draft`)) clipboardRequests.push(request.method()); });
    await page.evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function(value) { window.__followUpClipboard = value; return Promise.resolve(); } } });");
    await editor.getByRole('button', { name: 'Copy email' }).click();
    await editor.getByRole('status').filter({ hasText: 'Email copied. Nothing was sent.' }).waitFor();
    assert.equal(await page.evaluate('window.__followUpClipboard'), `Asunto: ${stored.draft.subject}\n\n${stored.draft.body}`);
    assert.deepEqual(clipboardRequests, [], 'copy does not call the server');

    const beforeCopyState = (await db.query('SELECT state, version FROM applications WHERE id=$1', [application.id])).rows[0];
    const beforeCopyEvents = (await db.query('SELECT count(*)::int AS n FROM application_events WHERE application_id=$1', [application.id])).rows[0]?.n;
    await editor.getByRole('button', { name: 'Copy email' }).click();
    const afterCopyState = (await db.query('SELECT state, version FROM applications WHERE id=$1', [application.id])).rows[0];
    const afterCopyEvents = (await db.query('SELECT count(*)::int AS n FROM application_events WHERE application_id=$1', [application.id])).rows[0]?.n;
    assert.deepEqual(afterCopyState, beforeCopyState, 'copy does not mutate application state or version');
    assert.equal(afterCopyEvents, beforeCopyEvents, 'copy does not add a timeline event');
    assert.equal(await editor.getByRole('button', { name: /^(Send|Enviar)$/i }).count(), 0, 'the editor has no send action');

    await editor.getByText('View and select the complete email').click();
    await editor.getByRole('button', { name: 'Select all' }).click();
    const selectedAll = await editor.getByLabel('Complete email for manual copying').evaluate((node) => {
      const input = node as HTMLTextAreaElement;
      return input.selectionStart === 0 && input.selectionEnd === input.value.length;
    });
    assert.equal(selectedAll, true, 'manual copy selects the complete subject and body');

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await hasHorizontalOverflow(page), false, 'the editor fits a 390 px viewport');
    await page.setViewportSize({ width: 1440, height: 1000 });
    note('Follow-up templates, edit/save, clipboard-only copy, manual select-all and 390 px layout verified against the isolated API.');
  },
};
