import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Scenario } from './scenarios.js';
import { eventually, hasHorizontalOverflow, setLocale } from './ui.js';

export const applicationsCsvScenario: Scenario = {
  name: 'applications-csv-download-neutralizes-formulas',
  async run({ page, api, uiUrl, marker }) {
    await api.post('/applications', { company: `@SUM(1) ${marker}`, role: `=HYPERLINK("https://evil.test") ${marker}`, location: 'Madrid, España', state: 'DRAFT', notes: `Private note ${marker}` });
    await api.post('/applications', { company: `Plain Co ${marker}`, role: `Ñandú, QA ${marker}`, state: 'DRAFT', notes: '' });
    await api.post('/applications', { company: 'Other Co', role: 'Unrelated role', state: 'DRAFT', notes: '' });

    const download = async (locale: 'es' | 'en', withNotes: boolean, separator?: ',' | ';') => {
      await setLocale(page, locale);
      await page.goto(new URL(`/applications?q=${encodeURIComponent(marker)}`, uiUrl).toString());
      const button = page.getByRole('button', { name: locale === 'es' ? 'Descargar CSV' : 'Download CSV', exact: true });
      await eventually(() => button.isEnabled(), (value) => value, 'the download button is enabled once the list loads');
      const picker = page.getByLabel(locale === 'es' ? 'Separador de columnas' : 'Column separator');
      const regional = await page.evaluate(() => (new Intl.NumberFormat(navigator.language).format(1.1).includes(',') ? ';' : ','));
      await eventually(() => picker.inputValue(), (value) => value === regional, 'the separator follows the regional format of the browser until it is changed');
      if (separator) await picker.selectOption(separator);
      const notes = page.getByLabel(locale === 'es' ? 'Incluir mis notas' : 'Include my notes');
      if (withNotes) await notes.check(); else assert.equal(await notes.isChecked(), false, 'notes are opt-in');
      const [file] = await Promise.all([page.waitForEvent('download'), button.click()]);
      assert.match(file.suggestedFilename(), /\.csv$/);
      const path = await file.path();
      assert.ok(path, 'the download was saved');
      return readFile(path);
    };

    // Excel with a comma decimal mark splits columns on a semicolon; the person can choose it whatever the browser says.
    const semicolon = (await download('es', false, ';')).toString('utf8').slice(1);
    assert.match(semicolon, /^Puesto;Empresa;Ubicación;Enlace;Estado;Etapa;Creada;Última actualización;/);
    assert.ok(semicolon.includes(`Ñandú, QA ${marker};`) && !semicolon.includes(`"Ñandú, QA ${marker}"`), 'with a semicolon a comma needs no quotes');
    assert.match(semicolon.split('\r\n')[1]!, /;\d{4}-\d{2}-\d{2} \d{2}:\d{2};\d{4}-\d{2}-\d{2} \d{2}:\d{2};/, 'created and updated are local dates a spreadsheet can read');

    const es = await download('es', false, ',');
    assert.deepEqual([...es.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 byte-order mark so Excel reads accents');
    const text = es.toString('utf8').slice(1);
    assert.match(text, /^Puesto,Empresa,Ubicación,Enlace,Estado,Etapa,/);
    assert.ok(text.includes(`"'=HYPERLINK(""https://evil.test"") ${marker}"`), 'a role that starts with = is stored as text');
    assert.ok(text.includes(`'@SUM(1) ${marker}`), 'a company that starts with @ is stored as text');
    assert.ok(text.includes(`"Ñandú, QA ${marker}"`) && text.includes('"Madrid, España"'), 'commas are quoted and accents are kept');
    assert.ok(!text.includes('Unrelated role'), 'only the applications matching the search are exported');
    assert.ok(!text.includes('Private note'), 'notes are left out by default');
    assert.equal(text.split('\r\n').filter(Boolean).length, 3, 'a header and the two matching applications');

    const en = (await download('en', true, ',')).toString('utf8');
    assert.match(en, /^.Role,Company,Location,Link,Status,Stage,Created,Last updated,Next step,Next step date,Interview,Notes\r\n/);
    assert.ok(en.includes(`Private note ${marker}`), 'notes are included when the person asks for them');
    await page.getByText(/Archivo preparado|File prepared/).first().waitFor();

    // The export row must fit a phone: no horizontal scroll and every control reachable.
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(new URL(`/applications?q=${encodeURIComponent(marker)}`, uiUrl).toString());
      await page.getByRole('button', { name: 'Download CSV', exact: true }).waitFor();
      assert.equal(await hasHorizontalOverflow(page), false, `the export row overflows at ${width}px`);
      for (const control of [page.getByRole('button', { name: 'Download CSV', exact: true }), page.getByLabel('Column separator'), page.getByLabel('Include my notes')]) {
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width, `a control of the export row fits ${width}px`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  },
};
