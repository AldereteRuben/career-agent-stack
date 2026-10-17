import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Scenario } from './scenarios.js';
import { eventually, setLocale } from './ui.js';

export const applicationsCsvScenario: Scenario = {
  name: 'applications-csv-download-neutralizes-formulas',
  async run({ page, api, uiUrl, marker }) {
    await api.post('/applications', { company: `@SUM(1) ${marker}`, role: `=HYPERLINK("https://evil.test") ${marker}`, location: 'Madrid, España', state: 'DRAFT', notes: `Private note ${marker}` });
    await api.post('/applications', { company: `Plain Co ${marker}`, role: `Ñandú, QA ${marker}`, state: 'DRAFT', notes: '' });
    await api.post('/applications', { company: 'Other Co', role: 'Unrelated role', state: 'DRAFT', notes: '' });

    const download = async (locale: 'es' | 'en', withNotes: boolean) => {
      await setLocale(page, locale);
      await page.goto(new URL(`/applications?q=${encodeURIComponent(marker)}`, uiUrl).toString());
      const button = page.getByRole('button', { name: locale === 'es' ? 'Descargar CSV' : 'Download CSV', exact: true });
      await eventually(() => button.isEnabled(), (value) => value, 'the download button is enabled once the list loads');
      const notes = page.getByLabel(locale === 'es' ? 'Incluir mis notas' : 'Include my notes');
      if (withNotes) await notes.check(); else assert.equal(await notes.isChecked(), false, 'notes are opt-in');
      const [file] = await Promise.all([page.waitForEvent('download'), button.click()]);
      assert.match(file.suggestedFilename(), /\.csv$/);
      const path = await file.path();
      assert.ok(path, 'the download was saved');
      return readFile(path);
    };

    const es = await download('es', false);
    assert.deepEqual([...es.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 byte-order mark so Excel reads accents');
    const text = es.toString('utf8').slice(1);
    assert.match(text, /^Puesto,Empresa,Ubicación,Enlace,Estado,Etapa,/);
    assert.ok(text.includes(`"'=HYPERLINK(""https://evil.test"") ${marker}"`), 'a role that starts with = is stored as text');
    assert.ok(text.includes(`'@SUM(1) ${marker}`), 'a company that starts with @ is stored as text');
    assert.ok(text.includes(`"Ñandú, QA ${marker}"`) && text.includes('"Madrid, España"'), 'commas are quoted and accents are kept');
    assert.ok(!text.includes('Unrelated role'), 'only the applications matching the search are exported');
    assert.ok(!text.includes('Private note'), 'notes are left out by default');
    assert.equal(text.split('\r\n').filter(Boolean).length, 3, 'a header and the two matching applications');

    const en = (await download('en', true)).toString('utf8');
    assert.match(en, /^.Role,Company,Location,Link,Status,Stage,Created,Last updated,Next step,Next step date,Interview,Notes\r\n/);
    assert.ok(en.includes(`Private note ${marker}`), 'notes are included when the person asks for them');
    await page.getByText(/Archivo preparado|File prepared/).first().waitFor();
  },
};
