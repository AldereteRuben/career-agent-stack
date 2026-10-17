import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractResumePdfText, ResumePdfExtractionError, resumePdfLimits } from './resume-pdf-text';

type PdfJsModule = typeof import('pdfjs-dist');
type FakePdfOptions = { data?: Uint8Array; isEvalSupported?: boolean; standardFontDataUrl?: string };

function fakePdfJs(pages: readonly (readonly string[])[], options: {
  streamItems?: (pageNumber: number) => unknown[];
  readStream?: (pageNumber: number) => Promise<ReadableStreamReadResult<{ items: unknown[] }>>;
  onStreamCancel?: () => void;
  numPages?: number;
  loadError?: unknown;
} = {}) {
  const state: { options?: FakePdfOptions; destroyed: number; workerSrc?: string } = { destroyed: 0 };
  const module = {
    version: 'test-version',
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument(parameters: FakePdfOptions) {
      state.options = parameters;
      return {
        promise: options.loadError ? Promise.reject(options.loadError) : Promise.resolve({
          numPages: options.numPages ?? pages.length,
          getPage: async (pageNumber: number) => ({
            streamTextContent: () => {
              let emitted = false;
              return new ReadableStream<{ items: unknown[] }>({
                async pull(controller) {
                  if (options.readStream) {
                    const result = await options.readStream(pageNumber);
                    if (result.done) controller.close();
                    else controller.enqueue(result.value);
                    return;
                  }
                  if (!emitted) {
                    emitted = true;
                    const items = options.streamItems?.(pageNumber)
                      ?? (pages[pageNumber - 1] ?? []).map((str) => ({ str, hasEOL: true }));
                    controller.enqueue({ items });
                  } else controller.close();
                },
                cancel() { options.onStreamCancel?.(); },
              });
            },
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
  assert.equal(state.options?.standardFontDataUrl, '/pdf-assets/test-version/standard_fonts/');
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
    streamItems: (pageNumber) => { readPages += 1; return [{ str: `page ${pageNumber}`, hasEOL: true }]; },
  });
  const result = await extractResumePdfText(pdfFile(), async () => longDocument.module);
  assert.equal(result.pageCount, resumePdfLimits.maxPages + 1);
  assert.equal(result.truncated, true);
  assert.equal(readPages, resumePdfLimits.maxPages);
  assert.equal(longDocument.state.destroyed, 1);

  let cancelled = 0;
  const tooMuchText = fakePdfJs([[`a${'b'.repeat(resumePdfLimits.maxCharacters)}`]], {
    onStreamCancel: () => { cancelled += 1; },
  });
  await assert.rejects(extractResumePdfText(pdfFile(), async () => tooMuchText.module), (error: unknown) => error instanceof ResumePdfExtractionError && error.code === 'too-long');
  assert.equal(tooMuchText.state.destroyed, 1);
  assert.ok(cancelled >= 1);
});

test('reports a PDF with no extractable text as scanned', async () => {
  const scanned = fakePdfJs([[' ', '\n']]);
  await assert.rejects(extractResumePdfText(pdfFile(), async () => scanned.module), (error: unknown) => error instanceof ResumePdfExtractionError && error.code === 'scanned');
  assert.equal(scanned.state.destroyed, 1);

  const footerOnly = fakePdfJs([['Página 1']]);
  await assert.rejects(extractResumePdfText(pdfFile(), async () => footerOnly.module), (error: unknown) => error instanceof ResumePdfExtractionError && error.code === 'scanned');

  const initiallyBlankButTruncated = fakePdfJs(Array.from({ length: resumePdfLimits.maxPages + 1 }, () => []), {
    numPages: resumePdfLimits.maxPages + 1,
  });
  assert.deepEqual(await extractResumePdfText(pdfFile(), async () => initiallyBlankButTruncated.module), {
    text: '', pageCount: resumePdfLimits.maxPages + 1, truncated: true,
  });
});

test('maps password-protected and malformed PDF.js errors to stable helper codes', async () => {
  const passwordProtected = fakePdfJs([], { loadError: Object.assign(new Error('password needed'), { name: 'PasswordException' }) });
  await assert.rejects(extractResumePdfText(pdfFile(), async () => passwordProtected.module), (error: unknown) => error instanceof ResumePdfExtractionError && error.code === 'password-protected');

  const malformed = fakePdfJs([], { loadError: new Error('internal parser details') });
  await assert.rejects(extractResumePdfText(pdfFile(), async () => malformed.module), (error: unknown) => error instanceof ResumePdfExtractionError && error.code === 'invalid-pdf');
});

test('aborting extraction cancels the text stream and destroys the PDF.js worker', async () => {
  let cancelled = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const controller = new AbortController();
  const hanging = fakePdfJs([[]], {
    readStream: () => {
      markStarted();
      return new Promise(() => undefined);
    },
    onStreamCancel: () => { cancelled += 1; },
  });
  const extraction = extractResumePdfText(pdfFile(), async () => hanging.module, 30_000, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(extraction, (error: unknown) => error instanceof ResumePdfExtractionError && error.code === 'cancelled');
  assert.ok(cancelled >= 1);
  assert.ok(hanging.state.destroyed >= 1);
});

test('destroys the PDF.js worker when extraction times out', async () => {
  let cancelled = 0;
  const hanging = fakePdfJs([[]], {
    readStream: () => new Promise(() => undefined),
    onStreamCancel: () => { cancelled += 1; },
  });
  await assert.rejects(extractResumePdfText(pdfFile(), async () => hanging.module, 5), (error: unknown) => error instanceof ResumePdfExtractionError && error.code === 'timeout');
  assert.ok(hanging.state.destroyed >= 1);
  assert.ok(cancelled >= 1);
});
