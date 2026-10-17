import type { PDFDocumentLoadingTask, PDFPageProxy } from 'pdfjs-dist';

export const resumePdfLimits = {
  maxBytes: 5 * 1024 * 1024,
  maxPages: 10,
  maxCharacters: 50_000,
  minExtractedCharacters: 20,
  timeoutMs: 30_000,
  signatureSearchBytes: 1024,
} as const;

export type ResumePdfErrorCode = 'too-large' | 'invalid-pdf' | 'password-protected' | 'pdfjs-unavailable' | 'too-long' | 'timeout' | 'cancelled' | 'scanned';

export class ResumePdfExtractionError extends Error {
  constructor(readonly code: ResumePdfErrorCode) {
    super(code);
    this.name = 'ResumePdfExtractionError';
  }
}

type PdfJsModule = typeof import('pdfjs-dist');
type PdfJsLoader = () => Promise<PdfJsModule>;

function hasPdfSignature(header: Uint8Array): boolean {
  const signature = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  return header.some((_, offset) => signature.every((byte, index) => header[offset + index] === byte));
}

function appendPageText(text: string, items: readonly unknown[]): string {
  let output = text;
  for (const item of items) {
    if (item && typeof item === 'object' && 'str' in item && typeof item.str === 'string') {
      const addition = item.str + ('hasEOL' in item && item.hasEOL ? '\n' : ' ');
      if (output.length + addition.length > resumePdfLimits.maxCharacters) throw new ResumePdfExtractionError('too-long');
      output += addition;
    }
  }
  return output;
}

function pdfError(error: unknown): ResumePdfExtractionError {
  return new ResumePdfExtractionError(
    error && typeof error === 'object' && 'name' in error && error.name === 'PasswordException'
      ? 'password-protected'
      : 'invalid-pdf',
  );
}

async function appendStreamText(text: string, page: PDFPageProxy, signal?: AbortSignal): Promise<string> {
  const reader = page.streamTextContent().getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  let output = text;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output = appendPageText(output, value.items);
    }
    return output;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function extractResumePdfText(
  file: File,
  loadPdfJs: PdfJsLoader = () => import('pdfjs-dist'),
  timeoutMs: number = resumePdfLimits.timeoutMs,
  signal?: AbortSignal,
): Promise<{ text: string; pageCount: number; truncated: boolean }> {
  if (signal?.aborted) throw new ResumePdfExtractionError('cancelled');
  if (file.size > resumePdfLimits.maxBytes) throw new ResumePdfExtractionError('too-large');

  const header = new Uint8Array(await file.slice(0, resumePdfLimits.signatureSearchBytes).arrayBuffer());
  if (signal?.aborted) throw new ResumePdfExtractionError('cancelled');
  if (!hasPdfSignature(header)) throw new ResumePdfExtractionError('invalid-pdf');

  let loadingTask: PDFDocumentLoadingTask | undefined;
  let timedOut = false;
  let cancelled = false;
  const streamAbort = new AbortController();
  let destroyPromise: Promise<void> | undefined;
  const destroy = () => {
    destroyPromise ??= loadingTask?.destroy().catch(() => undefined) ?? Promise.resolve();
    return destroyPromise;
  };
  let rejectTimeout!: (error: ResumePdfExtractionError) => void;
  let rejectCancellation!: (error: ResumePdfExtractionError) => void;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  const onAbort = () => {
    cancelled = true;
    streamAbort.abort();
    void destroy();
    rejectCancellation(new ResumePdfExtractionError('cancelled'));
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    streamAbort.abort();
    void destroy();
    rejectTimeout(new ResumePdfExtractionError('timeout'));
  }, timeoutMs);

  const extraction = (async () => {
    let library: PdfJsModule;
    try {
      library = await loadPdfJs();
    } catch {
      if (timedOut) throw new ResumePdfExtractionError('timeout');
      if (cancelled) throw new ResumePdfExtractionError('cancelled');
      throw new ResumePdfExtractionError('pdfjs-unavailable');
    }
    if (timedOut) throw new ResumePdfExtractionError('timeout');
    if (cancelled) throw new ResumePdfExtractionError('cancelled');
    library.GlobalWorkerOptions.workerSrc = `/pdf-assets/${library.version}/pdf.worker.min.mjs`;
    const data = new Uint8Array(await file.arrayBuffer());
    if (timedOut) throw new ResumePdfExtractionError('timeout');
    if (cancelled) throw new ResumePdfExtractionError('cancelled');
    // Keep the explicit hardening option for PDF.js versions that support it.
    // PDF.js 6 removed the vulnerable eval path entirely; this version ignores the legacy option.
    const options = { data, isEvalSupported: false } as Parameters<typeof library.getDocument>[0] & {
      isEvalSupported: false;
    };
    options.standardFontDataUrl = `/pdf-assets/${library.version}/standard_fonts/`;
    loadingTask = library.getDocument(options);

    let document: Awaited<PDFDocumentLoadingTask['promise']>;
    try {
      document = await loadingTask.promise;
    } catch (error) {
      if (timedOut) throw new ResumePdfExtractionError('timeout');
      if (cancelled) throw new ResumePdfExtractionError('cancelled');
      throw pdfError(error);
    }
    if (timedOut) throw new ResumePdfExtractionError('timeout');
    if (cancelled) throw new ResumePdfExtractionError('cancelled');
    const pagesToRead = Math.min(document.numPages, resumePdfLimits.maxPages);

    let text = '';
    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
      try {
        const page = await document.getPage(pageNumber);
        if (timedOut) throw new ResumePdfExtractionError('timeout');
        if (cancelled) throw new ResumePdfExtractionError('cancelled');
        text = await appendStreamText(text, page, streamAbort.signal);
        if (timedOut) throw new ResumePdfExtractionError('timeout');
        if (cancelled) throw new ResumePdfExtractionError('cancelled');
      } catch (error) {
        if (error instanceof ResumePdfExtractionError) throw error;
        if (timedOut) throw new ResumePdfExtractionError('timeout');
        if (cancelled) throw new ResumePdfExtractionError('cancelled');
        throw pdfError(error);
      }
    }

    const meaningfulCharacters = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    const truncated = pagesToRead < document.numPages;
    if (meaningfulCharacters < resumePdfLimits.minExtractedCharacters && !truncated) throw new ResumePdfExtractionError('scanned');
    return { text: text.trim(), pageCount: document.numPages, truncated };
  })();

  try {
    return await Promise.race([extraction, timeout, cancellation]);
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
    if (timedOut || cancelled) void destroy();
    else await destroy();
  }
}
