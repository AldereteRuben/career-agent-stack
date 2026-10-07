import assert from 'node:assert/strict';
import type { Scenario } from './scenarios.js';
import { eventually, goTo, setLocale } from './ui.js';

type ProfileResponse = { revision: number; locale: string; profile: Record<string, unknown> };

// Issue #75: PUT /profile used to store any JSON, so a wrong-shaped profile left the dashboard looking empty.
// The scenario restores the profile it found, so later scenarios see the same data.
export const profileContractScenarios: Scenario[] = [{
  name: 'profile-rejects-wrong-shape-and-keeps-older-keys',
  async run({ page, context, api, uiUrl, marker }) {
    const original = await api.get<ProfileResponse>('/profile');
    const put = async (data: unknown) => {
      const response = await context.request.fetch(`${uiUrl}/api/v1/profile`, { method: 'PUT', maxRetries: 0, headers: { Origin: uiUrl, 'Content-Type': 'application/json' }, data: JSON.stringify(data) });
      return { status: response.status(), body: await response.json().catch(() => null) as { error?: string; revision?: number } | null };
    };
    try {
      // The shape from the issue: identity fields at the top level.
      const wrong = await put({ expectedRevision: original.revision, profile: { fullName: `Ana ${marker}`, email: 'ana@example.test' } });
      assert.equal(wrong.status, 400, 'A wrong-shaped profile must be rejected');
      assert.equal(wrong.body?.error, 'INVALID_PROFILE');
      assert.equal((await api.get<ProfileResponse>('/profile')).revision, original.revision, 'A rejected profile must not create a revision');
      assert.equal((await put({ expectedRevision: original.revision, profile: { identity: { fullName: 42 } } })).status, 400, 'Wrong field types must be rejected');

      // A stored key the dashboard does not know (the demo seed writes `locale`) must not block later saves.
      const legacy = await put({ expectedRevision: original.revision, profile: { locale: 'en-GB', identity: { fullName: `Ana ${marker}`, email: 'ana@example.test', country: 'ES' } } });
      assert.equal(legacy.status, 201, `A profile with an older extra key must be saved (${JSON.stringify(legacy.body)})`);

      // The dashboard keeps saving through the canonical shape and shows what was stored.
      await setLocale(page, 'es');
      await goTo(page, '/profile');
      const name = page.getByLabel('Nombre', { exact: true });
      // The form renders before the profile loads; wait for the stored name.
      await eventually(() => name.inputValue(), (value) => value === `Ana ${marker}`, 'The dashboard shows the saved name');
      await name.fill(`Ana Corrected ${marker}`);
      const saved = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/v1/profile');
      await page.getByRole('button', { name: 'Guardar mis datos', exact: true }).click();
      assert.equal((await saved).status(), 201, 'The dashboard save must still be accepted');
      const after = await api.get<ProfileResponse>('/profile');
      assert.equal((after.profile.identity as { fullName?: string }).fullName, `Ana Corrected ${marker}`);
      assert.equal(after.profile.locale, 'en-GB', 'Keys the dashboard does not edit are sent back and kept');
    } finally {
      const latest = await api.get<ProfileResponse>('/profile');
      await api.put('/profile', { expectedRevision: latest.revision, locale: original.locale, profile: original.profile });
    }
  },
}];
