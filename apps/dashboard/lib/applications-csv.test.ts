import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationsCsv, csvCell, defaultCsvSeparator, type CsvApplication } from './applications-csv';

const row = (fields: Partial<CsvApplication> = {}): CsvApplication => ({ role: 'Engineer', company: 'Fictional Co', location: 'Madrid', canonicalUrl: 'https://example.test/jobs/1', state: 'DRAFT', recruitmentStage: 'NO_CONTACT', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z', ...fields });
const lines = (csv: string) => csv.slice(1).split('\r\n');

test('neutralizes cells a spreadsheet would run as a formula', () => {
  for (const value of ['=HYPERLINK("https://evil.test","x")', '@SUM(A1:A9)', '+1+1', '-2+3', '\tcmd', '\rcmd', '  =1+1']) assert.ok(csvCell(value).replace(/^"/, '').startsWith("'"), value);
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('a-b = c'), 'a-b = c');
});

test('neutralizes a formula behind spaces and a tab', () => {
  assert.equal(csvCell('  	=1+1'), "'  	=1+1");
  assert.equal(csvCell(' 	cmd'), "' 	cmd");
  assert.equal(csvCell('a	=1'), 'a	=1');
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
  const es = applicationsCsv([row()], 'es', { separator: ';' }); const en = applicationsCsv([row()], 'en');
  assert.equal(es.charCodeAt(0), 0xFEFF);
  assert.ok(es.endsWith('\r\n'));
  assert.equal(lines(es)[0], 'Puesto;Empresa;Ubicación;Enlace;Estado;Etapa;Creada;Última actualización;Próximo paso;Fecha del próximo paso;Entrevista');
  assert.equal(lines(en)[0], 'Role,Company,Location,Link,Status,Stage,Created,Last updated,Next step,Next step date,Interview');
  assert.match(lines(es)[1]!, /^Engineer;Fictional Co;Madrid;https:\/\/example\.test\/jobs\/1;/);
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

test('the default separator follows the regional format, not the language of the interface', () => {
  for (const [region, separator] of [['es-ES', ';'], ['es-AR', ';'], ['de-DE', ';'], ['es-MX', ','], ['en-US', ','], ['en-GB', ',']] as const) assert.equal(defaultCsvSeparator(region), separator, region);
  assert.equal(defaultCsvSeparator('not a locale'), ',');
});

test('either separator can be chosen and only the one in use is quoted', () => {
  const spanish = lines(applicationsCsv([row({ location: 'Madrid; España', company: 'Ñandú, S.L.' })], 'es', { separator: ';' }))[1]!;
  assert.ok(spanish.includes(';"Madrid; España";') && spanish.includes('Ñandú, S.L.;'), 'only the separator in use is quoted');
  assert.equal(lines(applicationsCsv([row()], 'es', { separator: ',' }))[0]!.split(',').length, 11);
  assert.equal(lines(applicationsCsv([row()], 'en', { separator: ';' }))[0]!.split(';').length, 11);
  assert.equal(lines(applicationsCsv([row({ location: 'Madrid, España' })], 'en'))[1]!.includes('"Madrid, España"'), true);
});

test('created and last updated are local dates a spreadsheet can read, in the zone given', () => {
  const rows = [row({ createdAt: '2026-10-01T23:30:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z' })];
  const madrid = lines(applicationsCsv(rows, 'en', { timeZone: 'Europe/Madrid' }))[1]!;
  assert.ok(madrid.includes(',2026-10-02 01:30,2026-10-02 12:00,'), madrid);
  const mexico = lines(applicationsCsv(rows, 'en', { timeZone: 'America/Mexico_City' }))[1]!;
  assert.ok(mexico.includes(',2026-10-01 17:30,2026-10-02 04:00,'), mexico);
  assert.ok(lines(applicationsCsv([row({ createdAt: null })], 'en', { timeZone: 'Europe/Madrid' }))[1]!.includes(',,2026-10-02 12:00,'), 'a missing date stays empty');
});

test('an empty list still gives a header row', () => {
  assert.equal(lines(applicationsCsv([], 'en')).length, 3 - 1);
});
