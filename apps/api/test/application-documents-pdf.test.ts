import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderApplicationDocumentText, type ApplicationDocumentSentence } from '@career/domain';
import { closePdfRenderer, renderApplicationCoverLetter, renderApplicationResume, renderResume, type ResumePaperSize } from '../src/document-renderer.js';

const enabled = process.env.CAREER_V090_PDF_TEST === 'true';

function normalizedPdfText(path: string) {
  return execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' }).replace(/\s+/gu, ' ').trim();
}

function assertPageSize(path: string, paperSize: ResumePaperSize) {
  const pageSize = execFileSync('pdfinfo', [path], { encoding: 'utf8' }).match(/Page size:\s*([\d.]+) x ([\d.]+) pts/u);
  assert.ok(pageSize, 'pdfinfo reports a page size');
  const expected: [number, number] = paperSize === 'LETTER' ? [612, 792] : [595.28, 841.89];
  assert.ok(Math.abs(Number(pageSize[1]) - expected[0]) < 1, `${paperSize} PDF has the expected width`);
  assert.ok(Math.abs(Number(pageSize[2]) - expected[1]) < 1, `${paperSize} PDF has the expected height`);
}

test('application resume and cover-letter PDFs preserve reviewed wording, accents and paper size', { skip: !enabled }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'career-application-documents-pdf-'));
  t.after(async () => { await closePdfRenderer(); await rm(directory, { recursive: true, force: true }); });

  const cases: Array<{ locale: 'es' | 'en'; paperSize: ResumePaperSize }> = [
    { locale: 'es', paperSize: 'A4' },
    { locale: 'en', paperSize: 'LETTER' },
  ];
  for (const { locale, paperSize } of cases) {
    const languageText = locale === 'es'
      ? ['Diseñé soluciones accesibles para Málaga.', 'Coordiné pruebas de calidad con el equipo.']
      : ['I designed accessible solutions for Málaga.', 'I coordinated quality tests with the team.'];
    const sentences: ApplicationDocumentSentence[] = languageText.map((text, index) => ({
      sentenceId: `sentence-${index + 1}`,
      text,
      kind: 'CANDIDATE_CLAIM',
      origin: 'USER_EDITED',
      sourceFactIds: [`fact-${index + 1}`],
      language: locale,
    }));
    const coverPath = join(directory, `cover-${locale}-${paperSize}.pdf`);
    const cover = await renderApplicationCoverLetter({ path: coverPath, locale, paperSize, sentences });
    const coverText = normalizedPdfText(coverPath);
    const expectedCoverText = renderApplicationDocumentText(sentences).replace(/\s+/gu, ' ').trim();
    assert.ok(cover.size > 1_000);
    assert.match(cover.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(coverText, expectedCoverText, `${locale} cover letter matches the saved sentence text`);
    assertPageSize(coverPath, paperSize);

    const resumePath = join(directory, `resume-${locale}-${paperSize}.pdf`);
    const resume = await renderResume({
      path: resumePath,
      fullName: locale === 'es' ? 'Rubén Álvarez' : 'Ruben Alvarez',
      role: locale === 'es' ? 'Ingeniero de calidad' : 'Quality engineer',
      locale,
      paperSize,
      facts: languageText.map((statement, index) => ({ kind: index === 0 ? 'experience' : 'achievement', statement, tags: [] })),
    });
    const resumeText = normalizedPdfText(resumePath);
    assert.ok(resume.size > 1_000);
    assert.match(resume.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(resumeText.includes(locale === 'es' ? 'Rubén Álvarez' : 'Ruben Alvarez'));
    assert.ok(resumeText.includes(locale === 'es' ? 'Ingeniero de calidad' : 'Quality engineer'));
    assert.ok(resumeText.includes(locale === 'es' ? 'EXPERIENCIA' : 'EXPERIENCE'), `${locale} resume uses the localized experience heading`);
    for (const statement of languageText) assert.ok(resumeText.includes(statement), `${locale} resume preserves “${statement}”`);
    assertPageSize(resumePath, paperSize);

    const applicationResumeSentences: ApplicationDocumentSentence[] = [
      {
        sentenceId: 'offer-reference',
        text: locale === 'es' ? 'Candidatura para Ingeniero de calidad en Ficticia.' : 'Application for Quality engineer at Fictional Co.',
        kind: 'OFFER_REFERENCE',
        origin: 'BUILDER',
        sourceFactIds: [],
        language: locale,
      },
      ...sentences,
    ];
    const applicationResumePath = join(directory, `application-resume-${locale}-${paperSize}.pdf`);
    const applicationResume = await renderApplicationResume({
      path: applicationResumePath,
      fullName: locale === 'es' ? 'Rubén Álvarez' : 'Ruben Alvarez',
      role: locale === 'es' ? 'Ingeniero de calidad' : 'Quality engineer',
      locale,
      paperSize,
      sentences: applicationResumeSentences,
    });
    const applicationResumeText = normalizedPdfText(applicationResumePath);
    assert.ok(applicationResume.size > 1_000);
    assert.match(applicationResume.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(applicationResumeText.includes(locale === 'es' ? 'Rubén Álvarez' : 'Ruben Alvarez'));
    assert.ok(applicationResumeText.includes(locale === 'es' ? 'Ingeniero de calidad' : 'Quality engineer'));
    const expectedStoredClaims = renderApplicationDocumentText(applicationResumeSentences).replace(/\s+/gu, ' ').trim();
    assert.ok(applicationResumeText.includes(expectedStoredClaims), `${locale} application resume preserves the exact stored claim order and wording`);
    assertPageSize(applicationResumePath, paperSize);
  }
});

test('renders share one browser without mixing documents and start a new one after it closes', { skip: !enabled }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'career-application-documents-shared-'));
  t.after(async () => { await closePdfRenderer(); await rm(directory, { recursive: true, force: true }); });
  const letter = (index: number): ApplicationDocumentSentence[] => [{ sentenceId: 'only', text: `Fictional cover letter number ${index}.`, kind: 'CANDIDATE_CLAIM', origin: 'USER_EDITED', sourceFactIds: ['fact-1'], language: 'en' }];
  const render = (index: number) => renderApplicationCoverLetter({ path: join(directory, `letter-${index}.pdf`), locale: 'en', sentences: letter(index) });

  const parallel = await Promise.all([1, 2, 3, 4].map(render));
  assert.equal(new Set(parallel.map((result) => result.sha256)).size, 4, 'parallel renders produce four distinct documents');
  for (const index of [1, 2, 3, 4]) assert.equal(normalizedPdfText(join(directory, `letter-${index}.pdf`)), `Fictional cover letter number ${index}.`, `letter ${index} holds only its own text`);

  await closePdfRenderer();
  const afterClose = await render(5);
  assert.ok(afterClose.size > 1_000, 'a render after closing launches a new browser');
  assert.equal(normalizedPdfText(join(directory, 'letter-5.pdf')), 'Fictional cover letter number 5.');

  // Chromium dies between renders (killed, out of memory): two renders that start together both get a working browser.
  execFileSync('pkill', ['-KILL', '-P', String(process.pid)]);
  const afterCrash = await Promise.all([6, 7].map(render));
  assert.equal(afterCrash.length, 2, 'both renders after a crash succeed');
  for (const index of [6, 7]) assert.equal(normalizedPdfText(join(directory, `letter-${index}.pdf`)), `Fictional cover letter number ${index}.`);

});
