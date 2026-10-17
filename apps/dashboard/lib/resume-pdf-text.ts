import type { PDFDocumentLoadingTask } from 'pdfjs-dist';

export const resumePdfLimits = {
  maxBytes: 5 * 1024 * 1024,
  maxPages: 10,
  maxCharacters: 50_000,
  timeoutMs: 30_000,
  signatureSearchBytes: 1024,
} as const;

export type ResumePdfErrorCode = 'too-large' | 'invalid-pdf' | 'too-long' | 'timeout' | 'scanned';

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
      output += item.str + ('hasEOL' in item && item.hasEOL ? '\n' : ' ');
      if (output.length > resumePdfLimits.maxCharacters) throw new ResumePdfExtractionError('too-long');
    }
  }
  return output;
}

export async function extractResumePdfText(
  file: File,
  loadPdfJs: PdfJsLoader = () => import('pdfjs-dist'),
  timeoutMs: number = resumePdfLimits.timeoutMs,
): Promise<{ text: string; pageCount: number; truncated: boolean }> {
  if (file.size > resumePdfLimits.maxBytes) throw new ResumePdfExtractionError('too-large');

  const header = new Uint8Array(await file.slice(0, resumePdfLimits.signatureSearchBytes).arrayBuffer());
  if (!hasPdfSignature(header)) throw new ResumePdfExtractionError('invalid-pdf');

  let loadingTask: PDFDocumentLoadingTask | undefined;
  let timedOut = false;
  let rejectTimeout!: (error: ResumePdfExtractionError) => void;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    void loadingTask?.destroy().catch(() => undefined);
    rejectTimeout(new ResumePdfExtractionError('timeout'));
  }, timeoutMs);

  const extraction = (async () => {
    const library = await loadPdfJs();
    if (timedOut) throw new ResumePdfExtractionError('timeout');
    library.GlobalWorkerOptions.workerSrc = `/pdf-assets/${library.version}/pdf.worker.min.mjs`;
    const data = new Uint8Array(await file.arrayBuffer());
    if (timedOut) throw new ResumePdfExtractionError('timeout');
    // Keep the explicit hardening option for PDF.js versions that support it.
    // PDF.js 6 removed the vulnerable eval path entirely; this version ignores the legacy option.
    const options = { data, isEvalSupported: false } as Parameters<typeof library.getDocument>[0] & {
      isEvalSupported: false;
    };
    loadingTask = library.getDocument(options);

    const document = await loadingTask.promise;
    if (timedOut) throw new ResumePdfExtractionError('timeout');
    const pagesToRead = Math.min(document.numPages, resumePdfLimits.maxPages);

    let text = '';
    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      if (timedOut) throw new ResumePdfExtractionError('timeout');
      const content = await page.getTextContent();
      if (timedOut) throw new ResumePdfExtractionError('timeout');
      text = appendPageText(text, content.items);
    }

    if (!text.trim()) throw new ResumePdfExtractionError('scanned');
    return { text: text.trim(), pageCount: document.numPages, truncated: pagesToRead < document.numPages };
  })();

  try {
    return await Promise.race([extraction, timeout]);
  } finally {
    clearTimeout(timeoutId);
    if (timedOut) void loadingTask?.destroy().catch(() => undefined);
    else await loadingTask?.destroy().catch(() => undefined);
  }
}
