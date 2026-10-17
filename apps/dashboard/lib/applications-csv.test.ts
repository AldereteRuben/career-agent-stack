import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationsCsv, csvCell, type CsvApplication } from './applications-csv';

const row = (fields: Partial<CsvApplication> = {}): CsvApplication => ({ role: 'Engineer', company: 'Fictional Co', location: 'Madrid', canonicalUrl: 'https://example.test/jobs/1', state: 'DRAFT', recruitmentStage: 'NO_CONTACT', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z', ...fields });
const lines = (csv: string) => csv.slice(1).split('\r\n');

test('neutralizes cells a spreadsheet would run as a formula', () => {
  for (const value of ['=HYPERLINK("https://evil.test","x")', '@SUM(A1:A9)', '+1+1', '-2+3', '\tcmd', '\rcmd', '  =1+1']) assert.ok(csvCell(value).replace(/^"/, '').startsWith("'"), value);
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('a-b = c'), 'a-b = c');
});

test('quotes commas, quotes and line breaks and keeps Unicode', () => {
  assert.equal(csvCell('Ñandú, S.L.'), '"Ñandú, S.L."');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line 1\nline 2'), '"line 1\nline 2"');
  assert.equal(csvCell('日本語 🚀'), '日本語 🚀');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
});

test('starts with a byte-order mark, uses CRLF and localizes headers and labels', () => {
  const es = applicationsCsv([row()], 'es'); const en = applicationsCsv([row()], 'en');
  assert.equal(es.charCodeAt(0), 0xFEFF);
  assert.ok(es.endsWith('\r\n'));
  assert.equal(lines(es)[0], 'Puesto,Empresa,Ubicación,Enlace,Estado,Etapa,Creada,Última actualización,Próximo paso,Fecha del próximo paso,Entrevista');
  assert.equal(lines(en)[0], 'Role,Company,Location,Link,Status,Stage,Created,Last updated,Next step,Next step date,Interview');
  assert.match(lines(es)[1]!, /^Engineer,Fictional Co,Madrid,https:\/\/example\.test\/jobs\/1,/);
});

test('notes are left out unless asked for, and then they are a quoted last column', () => {
  const rows = [row({ notes: 'Called "Ana", ask about =visa' })];
  assert.ok(!applicationsCsv(rows, 'en').includes('Ana'));
  const withNotes = lines(applicationsCsv(rows, 'en', { includeNotes: true }));
  assert.ok(withNotes[0]!.endsWith(',Notes'));
  assert.ok(withNotes[1]!.endsWith('"Called ""Ana"", ask about =visa"'));
});

test('malicious role, company and next step cannot become formulas', () => {
  const csv = applicationsCsv([row({ role: '=HYPERLINK("http://evil.test")', company: '@SUM(1)', nextStep: '-cmd|calc' })], 'en');
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.test"")"`));
  assert.ok(csv.includes(",'@SUM(1),"));
  assert.ok(csv.includes(",'-cmd|calc,"));
});

test('writes the interview in its own time zone and falls back to the instant when the zone is unusable', () => {
  assert.ok(lines(applicationsCsv([row({ interviewAt: '2026-11-03T08:30:00.000Z', interviewTimezone: 'Europe/Madrid' })], 'en'))[1]!.includes('2026-11-03 09:30 (Europe/Madrid)'));
  assert.ok(lines(applicationsCsv([row({ interviewAt: '2026-11-03T08:30:00.000Z', interviewTimezone: 'Not/AZone' })], 'en'))[1]!.includes('2026-11-03T08:30:00.000Z'));
});

test('an empty list still gives a header row', () => {
  assert.equal(lines(applicationsCsv([], 'en')).length, 3 - 1);
});
