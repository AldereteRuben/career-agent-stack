import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractResumePdfText, ResumePdfExtractionError, resumePdfLimits } from './resume-pdf-text';

type PdfJsModule = typeof import('pdfjs-dist');
type FakePdfOptions = { data?: Uint8Array; isEvalSupported?: boolean };

function fakePdfJs(pages: readonly (readonly string[])[], options: {
  getTextContent?: (pageNumber: number) => Promise<{ items: unknown[] }>;
  numPages?: number;
} = {}) {
  const state: { options?: FakePdfOptions; destroyed: number; workerSrc?: string } = { destroyed: 0 };
  const module = {
    version: 'test-version',
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument(parameters: FakePdfOptions) {
      state.options = parameters;
      return {
        promise: Promise.resolve({
          numPages: options.numPages ?? pages.length,
          getPage: async (pageNumber: number) => ({
            getTextContent: options.getTextContent
              ? () => options.getTextContent!(pageNumber)
              : async () => ({ items: (pages[pageNumber - 1] ?? []).map((str) => ({ str, hasEOL: true })) }),
          }),
        }),
        destroy: async () => { state.destroyed += 1; },
      };
    },
  } as unknown as PdfJsModule;
  Object.defineProperty(module.GlobalWorkerOptions, 'workerSrc', {
    get: () => state.workerSrc,
    set: (value: string) => { state.workerSrc = value; },
    configurable: true,
  });
  return { module, state };
}

function pdfFile(prefix = '%PDF-1.7\n'): File {
  return new File([prefix], 'resume.pdf', { type: 'application/pdf' });
}

test('extracts text in the browser and passes the disabled-eval option for compatible PDF.js versions', async () => {
  const { module, state } = fakePdfJs([['Nombre: Ana'], ['Experiencia', 'Diseño']]);
  const result = await extractResumePdfText(pdfFile('comment\n%PDF-1.7\n'), async () => module);

  assert.deepEqual(result, { text: 'Nombre: Ana\nExperiencia\nDiseño', pageCount: 2, truncated: false });
  assert.equal(state.options?.isEvalSupported, false);
  assert.ok(state.options?.data instanceof Uint8Array);
  assert.equal(state.workerSrc, '/pdf-assets/test-version/pdf.worker.min.mjs');
  assert.equal(state.destroyed, 1);
});

test('rejects oversized or non-PDF files before loading PDF.js', async () => {
  let loadCount = 0;
  const loadPdfJs = async () => { loadCount += 1; return fakePdfJs([]).module; };
  const oversized = new File([new Uint8Array(resumePdfLimits.maxBytes + 1)], 'large.pdf');

  await assert.rejects(extractResumePdfText(oversized, loadPdfJs), (error: unknown) => error instanceof ResumePdfExtractionError && error.code === 'too-large');
  await assert.rejects(extractResumePdfText(pdfFile('not a PDF'), loadPdfJs), (error: unknown) => error instanceof ResumePdfExtractionError && error.code === 'invalid-pdf');
  assert.equal(loadCount, 0);
});

test('truncates PDFs after the page limit and rejects text beyond the character limit', async () => {
  let readPages = 0;
  const longDocument = fakePdfJs(Array.from({ length: resumePdfLimits.maxPages + 1 }, (_, index) => [`page ${index + 1}`]), {
    numPages: resumePdfLimits.maxPages + 1,
    getTextContent: async (pageNumber) => { readPages += 1; return { items: [{ str: `page ${pageNumber}`, hasEOL: true }] }; },
  });
  const result = await extractResumePdfText(pdfFile(), async () => longDocument.module);
  assert.equal(result.pageCount, resumePdfLimits.maxPages + 1);
  assert.equal(result.truncated, true);
  assert.equal(readPages, resumePdfLimits.maxPages);
  assert.equal(longDocument.state.destroyed, 1);

  const tooMuchText = fakePdfJs([[`a${'b'.repeat(resumePdfLimits.maxCharacters)}`]]);
  await assert.rejects(extractResumePdfText(pdfFile(), async () => tooMuchText.module), (error: unknown) => error instanceof ResumePdfExtractionError && error.code === 'too-long');
  assert.equal(tooMuchText.state.destroyed, 1);
});

test('reports a PDF with no extractable text as scanned', async () => {
  const scanned = fakePdfJs([[' ', '\n']]);
  await assert.rejects(extractResumePdfText(pdfFile(), async () => scanned.module), (error: unknown) => error instanceof ResumePdfExtractionError && error.code === 'scanned');
  assert.equal(scanned.state.destroyed, 1);
});

test('destroys the PDF.js worker when extraction times out', async () => {
  const hanging = fakePdfJs([[]], { getTextContent: () => new Promise(() => undefined) });
  await assert.rejects(extractResumePdfText(pdfFile(), async () => hanging.module, 5), (error: unknown) => error instanceof ResumePdfExtractionError && error.code === 'timeout');
  assert.ok(hanging.state.destroyed >= 1);
});
