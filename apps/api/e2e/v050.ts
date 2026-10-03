import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Scenario } from './scenarios.js';
import { eventually, goTo, hasHorizontalOverflow, setLocale } from './ui.js';

type Profile = { revision: number; profile: Record<string, unknown> };
export const v050Scenarios: Scenario[] = [{
  name: 'v050-first-resume-guide-and-conflict-recovery',
  async run({ page, api, marker, artifacts, allowConsole }) {
    allowConsole(/409|500|Failed to load resource|Internal Server Error|Conflict/i);
    await goTo(page, '/start'); await setLocale(page, 'es');
    const name = page.getByLabel('Nombre', { exact: true }); const email = page.getByLabel('Correo', { exact: true });
    await name.fill(`Guide ${marker}`); await email.fill('guide@example.com');
    await page.reload(); await name.waitFor();
    assert.equal(await name.inputValue(), `Guide ${marker}`);
    assert.equal(await email.inputValue(), 'guide@example.com');
    // Another tab has updated the profile. Preserve the user's draft and merge unrelated data on retry.
    const previous = await api.get<Profile>('/profile');
    await api.put('/profile', { expectedRevision: previous.revision, profile: { ...previous.profile, identity: { fullName: 'Other tab', email: 'other@example.com' }, preferences: { country: 'ES' } } });
    await page.getByRole('button', { name: 'Guardar y continuar', exact: true }).click();
    await page.locator('.notice[role=alert]').first().waitFor();
    assert.equal(await name.inputValue(), `Guide ${marker}`);
    await page.getByRole('button', { name: 'Guardar y continuar', exact: true }).click();
    await page.getByRole('heading', { name: 'Cuéntanos una experiencia' }).waitFor();
    assert.equal(await page.locator('.focus-heading:focus').count(), 1);
    assert.deepEqual((await api.get<Profile>('/profile')).profile.preferences, { country: 'ES' });
    await page.getByRole('link', { name: 'Añadir mi primera experiencia' }).click();
    await page.waitForURL(/\/profile#experience$/);
    const fact = await api.post<{ id: string }>('/profile/facts', { kind: 'achievement', statement: `Guide achievement ${marker}`, tags: [] });
    await goTo(page, '/start');
    await page.getByRole('link', { name: 'Revisar mi experiencia' }).waitFor();
    await api.post(`/profile/facts/${fact.id}/approve`);
    await page.reload(); await page.getByRole('heading', { name: 'Ya puedes preparar tu PDF' }).waitFor();
    for (const locale of ['es', 'en'] as const) {
      await setLocale(page, locale); await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => document.querySelector('#app-sidebar')?.hasAttribute('inert'));
      assert.equal(await hasHorizontalOverflow(page), false);
      await page.screenshot({ animations: 'disabled', path: join(artifacts, `v050-guide-mobile-${locale}.png`) });
    }
    const doc = await api.post<{ id: string }>('/documents', { name: `Guide ${marker}`, factIds: [fact.id], locale: 'en' });
    await api.post(`/documents/${doc.id}/approve`, { confirmReviewed: true });
    await page.reload(); await page.getByRole('heading', { name: 'Your first resume is ready' }).waitFor();
    await page.getByRole('link', { name: 'View my resumes', exact: true }).click();
    await page.locator('#resume-history:visible').waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 }); await setLocale(page, 'es');
  },
}, {
  name: 'v050-settings-real-verified-backup',
  async run({ page, api, artifacts }) {
    await goTo(page, '/settings'); await setLocale(page, 'es');
    await page.getByRole('button', { name: 'Crear copia de seguridad', exact: true }).click();
    await goTo(page, '/'); await goTo(page, '/settings');
    const job = await eventually(() => api.get<{ state: string; id: string }>('/backups/current'), (job) => job.state !== 'running', 'Backup completes', 90_000);
    assert.equal(job.state, 'ready', 'Real isolated database and PDF backup succeeds');
    await page.getByRole('link', { name: 'Descargar copia', exact: true }).waitFor();
    const bytes = await api.bytes(`/api/v1/backups/${job.id}/archive`);
    const checksum = (await api.bytes(`/api/v1/backups/${job.id}/checksum`)).toString();
    assert.ok(checksum.includes(createHash('sha256').update(bytes).digest('hex')));
    const key = await api.bytes(`/api/v1/backups/${job.id}/key`);
    assert.ok(key.length > 32);
    for (const locale of ['es', 'en'] as const) {
      await setLocale(page, locale); await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => document.querySelector('#app-sidebar')?.hasAttribute('inert'));
      assert.equal(await hasHorizontalOverflow(page), false);
      await page.screenshot({ animations: 'disabled', path: join(artifacts, `v050-backup-mobile-${locale}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 }); await setLocale(page, 'es');
  },
}];
