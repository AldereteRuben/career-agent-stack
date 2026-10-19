import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Scenario } from './scenarios.js';
import { eventually, hasHorizontalOverflow, setLocale } from './ui.js';

type Profile = { revision: number; profile: Record<string, unknown> };
type Revision = {
  id: string; revision: number; approvedAt: string | null; confirmedUnsupportedIds: string[];
  claims: Array<{ sentenceId: string; text: string; origin: string; sourceFactIds: string[] }>;
};
type Saved = { documentId: string; revisions: Revision[] };
type PacketFile = { id: string; fileName: string; selectable: boolean; revision: number | null; newerPendingRevision: boolean };

async function tabTo(page: import('playwright').Page, target: import('playwright').Locator, fromStart = false) {
  if (fromStart) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let index = 0; index < 100; index += 1) {
    if (await target.evaluate((node) => node === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  assert.equal(await target.evaluate((node) => node === document.activeElement).catch(() => false), true, 'Keyboard tab order reaches the requested control');
}

async function assertKeyboardFocus(page: import('playwright').Page, target: import('playwright').Locator, fromStart = false) {
  await tabTo(page, target, fromStart);
  const visible = await target.evaluate((node) => {
    const element = node as HTMLElement;
    const style = getComputedStyle(element);
    return element.matches(':focus-visible') && style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2;
  });
  assert.equal(visible, true, 'Keyboard focus is visible with a 2px or wider outline');
}

export const applicationDocumentsScenario: Scenario = {
  name: 'application-documents-lifecycle-and-deletion',
  async run({ page, api, db, filesDir, uiUrl, marker, note }) {
    const profile = await api.get<Profile>('/profile');
    await api.put('/profile', { expectedRevision: profile.revision, profile: { ...profile.profile, identity: { fullName: 'Fictional Candidate', email: 'candidate@example.test', country: 'ES' } } });
    const fact = await api.post<{ id: string }>('/profile/facts', { kind: 'experience', statement: `I used Python to resolve customer issues for a fictional support team ${marker}.`, tags: ['Python', 'customer support'] });
    await api.post(`/profile/facts/${fact.id}/approve`, {});
    const job = await api.post<{ id: string }>('/jobs/import', { company: `Document Fixture ${marker}`, title: `Support Engineer ${marker}`, jobUrl: `https://example.com/${marker}/application-documents` });
    const application = await api.post<{ id: string }>('/applications', { company: `Document Fixture ${marker}`, role: `Support Engineer ${marker}`, jobId: job.id, state: 'DRAFT' });
    const workspace = (await db.query<{ id: string }>('select id from workspaces limit 1')).rows[0]!.id;

    const panel = page.locator('.application-resume').filter({ has: page.getByRole('heading', { name: /^(CV adaptado a esta oferta|Resume tailored to this job)$/u }) });
    await setLocale(page, 'es');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(new URL(`/applications?id=${application.id}`, uiUrl).toString());
    await panel.getByRole('heading', { name: 'CV adaptado a esta oferta', exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Guardar nueva versión', exact: true }).waitFor();
    const candidateClaim = panel.locator('fieldset').filter({ hasText: 'Afirmación basada en tu perfil' }).locator('textarea').first();
    await candidateClaim.waitFor();

    // Edit and save by keyboard, with the global :focus-visible indicator checked.
    await assertKeyboardFocus(page, candidateClaim, true);
    await page.keyboard.press('End');
    await page.keyboard.type(' using Python');
    const save = panel.getByRole('button', { name: 'Guardar nueva versión', exact: true });
    await assertKeyboardFocus(page, save);
    await page.keyboard.press('Enter');
    await panel.getByText('Versión guardada. Revisa el PDF antes de aprobarla.', { exact: true }).waitFor();
    let history = await api.get<Saved>(`/applications/${application.id}/resume?language=es`);
    assert.equal(history.revisions.length, 1);

    // A profile change makes the saved draft stale and the approval control must be blocked.
    const addedFact = await api.post<{ id: string }>('/profile/facts', { kind: 'achievement', statement: `A separate reviewed project ${marker}.`, tags: ['e2e'] });
    await api.post(`/profile/facts/${addedFact.id}/approve`, {});
    await page.reload();
    await panel.getByText('El contenido o sus fuentes cambiaron; crea una nueva versión para revisar los cambios.', { exact: true }).waitFor();
    const staleApprove = panel.getByRole('button', { name: 'Aprobar esta versión', exact: true });
    assert.equal(await staleApprove.isDisabled(), true, 'A stale document cannot be approved');
    await setLocale(page, 'en');
    await page.getByRole('heading', { level: 1, name: 'Applications', exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await hasHorizontalOverflow(page), false, 'The stale state fits a 390 px viewport in English');
    await setLocale(page, 'es');
    await page.setViewportSize({ width: 1440, height: 1000 });

    // An unsupported skill is refused first. A separate, keyboard-operated confirmation allows it to be saved as USER_UNSUPPORTED.
    await page.reload();
    const claimWithSkill = panel.locator('fieldset').filter({ hasText: 'Afirmación basada en tu perfil' }).locator('textarea').first();
    await assertKeyboardFocus(page, claimWithSkill, true);
    await page.keyboard.press('End');
    await page.keyboard.type(' I am certified in Kubernetes.');
    await assertKeyboardFocus(page, save);
    await page.keyboard.press('Enter');
    const refusal = panel.getByRole('alert');
    await refusal.getByText(/Kubernetes/).waitFor();
    assert.equal((await api.get<Saved>(`/applications/${application.id}/resume?language=es`)).revisions.length, 1, 'The unsupported skill is refused without creating a revision');
    const unsupportedConfirm = panel.getByLabel('Confirmo que revisé esta afirmación aunque no esté respaldada por hechos aprobados.');
    await assertKeyboardFocus(page, unsupportedConfirm, true);
    await page.keyboard.press('Space');
    await assertKeyboardFocus(page, save);
    await page.keyboard.press('Enter');
    await panel.getByText('Versión guardada. Revisa el PDF antes de aprobarla.', { exact: true }).waitFor();
    history = await api.get<Saved>(`/applications/${application.id}/resume?language=es`);
    assert.equal(history.revisions.length, 2);
    const unsupportedRevision = history.revisions[0]!;
    assert.ok(unsupportedRevision.confirmedUnsupportedIds.length > 0);
    assert.ok(unsupportedRevision.claims.some((claim) => claim.origin === 'USER_UNSUPPORTED' && /Kubernetes/u.test(claim.text)));
    const approveUnsupported = panel.getByRole('button', { name: 'Aprobar esta versión', exact: true });
    assert.equal(await approveUnsupported.isDisabled(), true, 'A version containing an unsupported claim needs a separate approval confirmation');
    const approveConfirm = panel.getByLabel('Confirmo que revisé las afirmaciones marcadas como no respaldadas.');
    await assertKeyboardFocus(page, approveConfirm, true);
    await page.keyboard.press('Space');
    await assertKeyboardFocus(page, approveUnsupported);
    await page.keyboard.press('Enter');
    await eventually(() => api.get<Saved>(`/applications/${application.id}/resume?language=es`), (value) => Boolean(value.revisions[0]?.approvedAt), 'The explicitly confirmed unsupported revision is approved');

    // Remove the unsupported skill in a newer pending revision. The approved file remains downloadable with an explicit warning.
    await page.reload();
    const nextClaim = panel.locator('fieldset').filter({ hasText: 'Afirmación basada en tu perfil' }).locator('textarea').first();
    await assertKeyboardFocus(page, nextClaim, true);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(`I used Python to resolve customer issues for a fictional support team ${marker}.`);
    await assertKeyboardFocus(page, save);
    await page.keyboard.press('Enter');
    await panel.getByText('Versión guardada. Revisa el PDF antes de aprobarla.', { exact: true }).waitFor();
    let packet = await api.get<{ files: PacketFile[] }>(`/applications/${application.id}/materials`);
    const approvedBeforeNewer = packet.files.find((file) => file.revision === unsupportedRevision.revision);
    assert.ok(approvedBeforeNewer?.selectable && approvedBeforeNewer.newerPendingRevision, 'A newer pending edit does not silently replace the approved download');
    const materials = page.locator('.application-materials');
    await materials.getByText(/edición más reciente pendiente de aprobación/u).waitFor();
    await setLocale(page, 'en');
    await materials.getByText(/newer edit is awaiting approval/u).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await hasHorizontalOverflow(page), false, 'The application documents and packet UI fit a 390 px viewport in English');
    await setLocale(page, 'es');
    await page.setViewportSize({ width: 1440, height: 1000 });

    // This newer revision contains only supported evidence and can be approved using the keyboard.
    const approveLatest = panel.getByRole('button', { name: 'Aprobar esta versión', exact: true });
    await assertKeyboardFocus(page, approveLatest, true);
    await page.keyboard.press('Enter');
    await eventually(() => api.get<Saved>(`/applications/${application.id}/resume?language=es`), (value) => Boolean(value.revisions[0]?.approvedAt), 'The current supported revision is approved');
    history = await api.get<Saved>(`/applications/${application.id}/resume?language=es`);
    const currentApproved = history.revisions[0]!;
    assert.ok(currentApproved.id !== unsupportedRevision.id);

    packet = await api.get<{ files: PacketFile[] }>(`/applications/${application.id}/materials`);
    assert.equal(packet.files.some((file) => file.id === `revision:${unsupportedRevision.id}`), false, 'The superseded approved revision is no longer offered for selection');
    const currentFile = packet.files.find((file) => file.id === `revision:${currentApproved.id}`);
    assert.ok(currentFile?.selectable, 'The latest approved revision is selectable');
    const oldDownload = await page.evaluate(async ({ applicationId, oldId }) => {
      const response = await fetch(`/api/v1/applications/${applicationId}/materials.zip`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds: [`revision:${oldId}`] }) });
      return { status: response.status, body: await response.json() as { error?: string } };
    }, { applicationId: application.id, oldId: unsupportedRevision.id });
    assert.equal(oldDownload.status, 409);
    assert.equal(oldDownload.body.error, 'MATERIAL_NOT_AVAILABLE');

    const currentCheckbox = materials.getByLabel(currentFile.fileName, { exact: true });
    await assertKeyboardFocus(page, currentCheckbox, true);
    await page.keyboard.press('Space');
    await materials.getByRole('status').filter({ hasText: '1 archivos seleccionados' }).waitFor();
    const downloadButton = materials.getByRole('button', { name: 'Descargar seleccionados', exact: true });
    await assertKeyboardFocus(page, downloadButton);
    const [download, zipResponse] = await Promise.all([
      page.waitForEvent('download'),
      page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/v1/applications/${application.id}/materials.zip`)),
      page.keyboard.press('Enter'),
    ]).then(([file, response]) => [file, response] as const);
    assert.equal(download.suggestedFilename(), 'application-materials.zip');
    assert.equal(zipResponse.status(), 200);
    assert.match(zipResponse.headers()['content-type'] ?? '', /application\/zip/u);
    assert.equal((await zipResponse.body()).subarray(0, 2).toString('ascii'), 'PK', 'The selected materials download is a ZIP archive');
    await materials.getByRole('status').filter({ hasText: 'Descarga del paquete ZIP iniciada.' }).waitFor();

    // Repeat editing and approval in English so both document-language flows are exercised.
    await panel.getByLabel('Idioma del documento', { exact: true }).selectOption('en');
    await panel.getByRole('heading', { name: 'Resume tailored to this job', exact: true }).waitFor();
    const englishClaim = panel.locator('fieldset').filter({ hasText: 'Profile-based claim' }).locator('textarea').first();
    await assertKeyboardFocus(page, englishClaim, true);
    await page.keyboard.press('End');
    await page.keyboard.type(' using Python');
    const saveEnglish = panel.getByRole('button', { name: 'Save new version', exact: true });
    await assertKeyboardFocus(page, saveEnglish);
    await page.keyboard.press('Enter');
    await panel.getByText('Version saved. Review the PDF before approving it.', { exact: true }).waitFor();
    const approveEnglish = panel.getByRole('button', { name: 'Approve this version', exact: true });
    await assertKeyboardFocus(page, approveEnglish, true);
    await page.keyboard.press('Enter');
    await eventually(() => api.get<Saved>(`/applications/${application.id}/resume?language=en`), (value) => Boolean(value.revisions[0]?.approvedAt), 'The English revision is approved');
    await setLocale(page, 'en');
    await page.reload();
    await materials.getByRole('heading', { name: 'Application materials packet', exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await hasHorizontalOverflow(page), false, 'The English document and packet flow fits a 390 px viewport');

    // Deletion is the final action in this shard; verify both workspace rows and the isolated document files are gone.
    const storedFiles = (await db.query<{ text_storage_path: string; pdf_storage_path: string }>(
      'select text_storage_path, pdf_storage_path from application_document_revisions where workspace_id=$1 and document_id in (select id from application_documents where application_id=$2)', [workspace, application.id],
    )).rows.flatMap((row) => [row.text_storage_path, row.pdf_storage_path]).map((relativePath) => resolve(filesDir, relativePath));
    for (const path of storedFiles) assert.ok(path.startsWith(`${resolve(filesDir)}${sep}`), 'Stored paths remain inside the disposable files directory');
    await setLocale(page, 'es');
    await page.goto(new URL('/settings', uiUrl).toString());
    await page.getByText('Borrar todos mis datos', { exact: true }).first().click();
    const phrase = page.getByLabel(/Para confirmar, escribe BORRAR TODOS MIS DATOS/u);
    const remove = page.getByRole('button', { name: 'Borrar todos mis datos', exact: true });
    await phrase.fill('BORRAR TODOS MIS DATOS');
    const deletion = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/workspace/delete-all'));
    await remove.click();
    assert.equal((await deletion).status(), 200);
    await page.getByText('Se borraron todos tus datos de esta instalación', { exact: false }).waitFor();
    assert.equal(Number((await db.query('select count(*)::int as n from application_documents where workspace_id=$1', [workspace])).rows[0]!.n), 0);
    assert.equal(Number((await db.query('select count(*)::int as n from application_document_revisions where workspace_id=$1', [workspace])).rows[0]!.n), 0);
    for (const path of storedFiles) assert.equal(await access(path).then(() => true, () => false), false, 'Workspace deletion removes generated text and PDF files');
    note('The bilingual application-document lifecycle is keyboard-tested at visible focus, stale and unsupported claims are blocked pending explicit confirmation, packet selection rejects superseded revisions, ZIP download is verified, and workspace deletion removes rows and generated files in the disposable stack.');
  },
};
