import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { renderApplicationDocumentText, resumeLabels, resumeSectionName, type ApplicationDocumentSentence } from '@career/domain';

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export type ResumePaperSize = 'A4' | 'LETTER';

type PdfOptions = Omit<NonNullable<Parameters<Page['pdf']>[0]>, 'path'>;

// One headless Chromium serves every render: launching it costs 130-600 ms, a fresh context in a running browser about
// 45 ms. Preparing an application renders inside a transaction that holds workspace locks, so this is also how long
// other writes to that workspace wait. Each render still gets its own context with JavaScript off and every request
// aborted, so documents share nothing. The browser closes after a quiet minute and when the API shuts down.
const IDLE_CLOSE_MS = 60_000;
let sharedBrowser: Promise<Browser> | null = null;
let activeRenders = 0;
let idleTimer: NodeJS.Timeout | null = null;

function rendererBrowser(): Promise<Browser> {
  if (sharedBrowser) return sharedBrowser;
  const launching: Promise<Browser> = chromium.launch({ headless: true }).then((browser) => {
    browser.on('disconnected', () => { if (sharedBrowser === launching) sharedBrowser = null; });
    return browser;
  });
  launching.catch(() => { if (sharedBrowser === launching) sharedBrowser = null; });
  sharedBrowser = launching;
  return launching;
}

/** Closes the shared PDF browser; the next render launches a new one. Called on API shutdown and by tests. */
export async function closePdfRenderer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const current = sharedBrowser; sharedBrowser = null;
  const browser = await current?.catch(() => null);
  await browser?.close().catch(() => {});
}

async function newRenderContext() {
  const pending = rendererBrowser();
  const browser = await pending;
  try { return await browser.newContext({ acceptDownloads: false, javaScriptEnabled: false }); }
  catch (error) {
    // The browser died between renders before its `disconnected` event arrived: start a new one once. Forget only
    // the browser that failed, so a parallel render that already replaced it keeps using the new one.
    if (browser.isConnected()) throw error;
    if (sharedBrowser === pending) { sharedBrowser = null; void browser.close().catch(() => {}); }
    return (await rendererBrowser()).newContext({ acceptDownloads: false, javaScriptEnabled: false });
  }
}

/** Prints offline HTML to `path` after checking that every expected text made it onto the page, then validates the file. */
async function printPdf(input: { path: string; html: string; expectedTexts: string[]; textCheckError: string; pdf: PdfOptions }) {
  const absolutePath = resolve(input.path);
  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
  activeRenders++;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  try {
    const context = await newRenderContext();
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent(input.html, { waitUntil: 'load', timeout: 10_000 });
      const extractedText = await page.locator('body').innerText();
      for (const text of input.expectedTexts) if (!extractedText.includes(text)) throw new Error(input.textCheckError);
      await page.pdf({ ...input.pdf, path: absolutePath });
    } finally { await context.close().catch(() => {}); }
  } finally {
    activeRenders--;
    if (!activeRenders && sharedBrowser) { idleTimer = setTimeout(() => { void closePdfRenderer(); }, IDLE_CLOSE_MS); idleTimer.unref(); }
  }
  const bytes = await readFile(absolutePath);
  if (bytes.byteLength < 1_000 || bytes.byteLength > 20_000_000 || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('PDF_OUTPUT_INVALID');
  return { absolutePath, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
}

export function parseResumePaperSize(value: unknown): ResumePaperSize | null {
  if (value === undefined || value === 'A4') return 'A4';
  return value === 'LETTER' ? 'LETTER' : null;
}

export async function renderResume(input: { path: string; fullName: string; email?: string; phone?: string; city?: string; links?: Array<{ label: string; url: string }>; role: string; locale?: 'es' | 'en'; paperSize?: ResumePaperSize; facts: Array<{ kind: string; statement: string; tags: string[] }> }) {
  if (!input.facts.length || input.facts.length > 50) throw new Error('DOCUMENT_FACT_LIMIT');
  if (input.facts.reduce((size, fact) => size + fact.statement.length, 0) > 40_000) throw new Error('DOCUMENT_SIZE_LIMIT');
  const grouped = new Map<string, typeof input.facts>();
  for (const fact of input.facts) grouped.set(fact.kind, [...(grouped.get(fact.kind) ?? []), fact]);
  const locale = input.locale === 'es' ? 'es' : 'en';
  const paperSize = input.paperSize === 'LETTER' ? 'LETTER' : 'A4';
  const pageSize = paperSize === 'LETTER' ? 'Letter' : 'A4';
  const pageMargins = paperSize === 'LETTER'
    ? { top: '17.78mm', right: '19.05mm', bottom: '19.05mm', left: '19.05mm' }
    : { top: '19mm', right: '20mm', bottom: '21mm', left: '20mm' };
  const labels = resumeLabels(locale);
  const sectionOrder = ['summary', 'experience', 'current_employment', 'achievement', 'project', 'skill_evidence', 'skill', 'education', 'certification', 'language'];
  const sections = [...grouped].sort(([a], [b]) => {
    const rank = (kind: string) => sectionOrder.includes(kind) ? sectionOrder.indexOf(kind) : sectionOrder.length;
    return rank(a) - rank(b);
  }).map(([kind, facts]) => `<section><h2>${escapeHtml(resumeSectionName(kind, locale))}</h2><ul>${facts.map((fact) => `<li>${escapeHtml(fact.statement)}</li>`).join('')}</ul></section>`).join('');
  const contactItems: Array<{ text: string } | { link: { label: string; url: string } }> = [input.email, input.phone, input.city].filter((value): value is string => Boolean(value?.trim())).map((text) => ({ text }));
  for (const link of input.links ?? []) contactItems.push({ link });
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
    @page { size: ${pageSize}; margin: ${pageMargins.top} ${pageMargins.right} ${pageMargins.bottom} ${pageMargins.left}; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #263344; font-family: Arial, Helvetica, sans-serif; font-size: 10.5pt; line-height: 1.58; }
    header { border-top: 4px solid #244d64; padding-top: 20px; padding-bottom: 22px; margin-bottom: 25px; border-bottom: 1px solid #ccd6dd; break-inside: avoid; }
    h1 { color: #172b3b; font-family: Georgia, 'Times New Roman', serif; font-weight: 400; font-size: 34pt; line-height: 1.1; letter-spacing: -0.8px; margin: 0; overflow-wrap: anywhere; }
    .role { color: #244d64; font-size: 12pt; line-height: 1.4; margin: 12px 0 0; overflow-wrap: anywhere; }
    .contact { color: #485867; font-size: 9.5pt; margin: 10px 0 0; overflow-wrap: anywhere; }
    section { margin: 0 0 23px; }
    h2 { color: #244d64; font-size: 9pt; font-weight: 700; line-height: 1.3; letter-spacing: 1.4px; text-transform: uppercase; padding-bottom: 8px; margin: 0 0 12px; border-bottom: 1px solid #dce3e8; break-after: avoid; }
    ul { margin: 0; padding-left: 16px; }
    li { padding-left: 5px; margin-bottom: 9px; white-space: pre-wrap; overflow-wrap: anywhere; orphans: 3; widows: 3; break-inside: avoid; }
    li:last-child { margin-bottom: 0; }
    li::marker { color: #527489; font-size: 8pt; }
    </style></head><body><header><h1>${escapeHtml(input.fullName || labels.defaultName)}</h1><p class="role">${escapeHtml(input.role || labels.defaultRole)}</p>${contactItems.length ? `<p class="contact">${contactItems.map((item) => 'text' in item ? escapeHtml(item.text) : `<a href="${escapeHtml(item.link.url)}">${escapeHtml(item.link.label)}</a>`).join(' · ')}</p>` : ''}</header><main>${sections}</main></body></html>`;
  const footer = `<div style="width:100%;margin:0 ${pageMargins.right};padding-top:7px;border-top:1px solid #dce3e8;font-family:Arial,Helvetica,sans-serif;font-size:7px;color:#526171;display:flex;justify-content:flex-end;gap:12px"><span style="white-space:nowrap"><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
  return printPdf({ path: input.path, html, expectedTexts: input.facts.map((fact) => fact.statement), textCheckError: 'DOCUMENT_TEXT_CHECK_FAILED', pdf: { format: pageSize, printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footer, tagged: true, margin: pageMargins } });
}

/** Renders a saved, offer-specific resume revision without deriving or adding claims. */
export async function renderApplicationResume(input: {
  path: string; fullName: string; email?: string; phone?: string; city?: string; role: string;
  locale: 'es' | 'en'; paperSize?: ResumePaperSize; sentences: ApplicationDocumentSentence[];
}) {
  if (!input.sentences.length || input.sentences.length > 50) throw new Error('APPLICATION_DOCUMENT_SENTENCE_LIMIT');
  const expectedText = renderApplicationDocumentText(input.sentences);
  if (expectedText.length > 40_000) throw new Error('APPLICATION_DOCUMENT_SIZE_LIMIT');
  const locale = input.locale;
  const paperSize = input.paperSize === 'LETTER' ? 'LETTER' : 'A4';
  const pageSize = paperSize === 'LETTER' ? 'Letter' : 'A4';
  const pageMargins = paperSize === 'LETTER'
    ? { top: '17.78mm', right: '19.05mm', bottom: '19.05mm', left: '19.05mm' }
    : { top: '19mm', right: '20mm', bottom: '21mm', left: '20mm' };
  const labels = resumeLabels(locale);
  const contactItems = [input.email, input.phone, input.city].filter((value): value is string => Boolean(value?.trim()));
  const claims = input.sentences.map((sentence) => `<p>${escapeHtml(sentence.text)}</p>`).join('');
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
    @page { size: ${pageSize}; margin: ${pageMargins.top} ${pageMargins.right} ${pageMargins.bottom} ${pageMargins.left}; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #263344; font-family: Arial, Helvetica, sans-serif; font-size: 10.5pt; line-height: 1.58; }
    header { border-top: 4px solid #244d64; padding-top: 20px; padding-bottom: 22px; margin-bottom: 25px; border-bottom: 1px solid #ccd6dd; break-inside: avoid; }
    h1 { color: #172b3b; font-family: Georgia, 'Times New Roman', serif; font-weight: 400; font-size: 34pt; line-height: 1.1; letter-spacing: -0.8px; margin: 0; overflow-wrap: anywhere; }
    .role { color: #244d64; font-size: 12pt; line-height: 1.4; margin: 12px 0 0; overflow-wrap: anywhere; }
    .contact { color: #485867; font-size: 9.5pt; margin: 10px 0 0; overflow-wrap: anywhere; }
    h2 { color: #244d64; font-size: 9pt; font-weight: 700; line-height: 1.3; letter-spacing: 1.4px; text-transform: uppercase; padding-bottom: 8px; margin: 0 0 12px; border-bottom: 1px solid #dce3e8; break-after: avoid; }
    p { margin: 0 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; orphans: 3; widows: 3; }
    </style></head><body><header><h1>${escapeHtml(input.fullName || labels.defaultName)}</h1><p class="role">${escapeHtml(input.role || labels.defaultRole)}</p>${contactItems.length ? `<p class="contact">${contactItems.map(escapeHtml).join(' · ')}</p>` : ''}</header><main><h2>${escapeHtml(labels.defaultName)}</h2>${claims}</main></body></html>`;
  const footer = `<div style="width:100%;margin:0 ${pageMargins.right};padding-top:7px;border-top:1px solid #dce3e8;font-family:Arial,Helvetica,sans-serif;font-size:7px;color:#526171;display:flex;justify-content:flex-end;gap:12px"><span style="white-space:nowrap"><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
  return printPdf({ path: input.path, html, expectedTexts: input.sentences.map((sentence) => sentence.text), textCheckError: 'APPLICATION_DOCUMENT_TEXT_CHECK_FAILED', pdf: { format: pageSize, printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footer, tagged: true, margin: pageMargins } });
}

/** Renders an offer-specific cover letter offline; the checked PDF contains the same sentence text as its companion file. */
export async function renderApplicationCoverLetter(input: { path: string; locale: 'es' | 'en'; paperSize?: ResumePaperSize; sentences: ApplicationDocumentSentence[] }) {
  if (!input.sentences.length || input.sentences.length > 50) throw new Error('APPLICATION_DOCUMENT_SENTENCE_LIMIT');
  const expectedText = renderApplicationDocumentText(input.sentences);
  if (expectedText.length > 40_000) throw new Error('APPLICATION_DOCUMENT_SIZE_LIMIT');
  const locale = input.locale;
  const paperSize = input.paperSize === 'LETTER' ? 'LETTER' : 'A4';
  const pageSize = paperSize === 'LETTER' ? 'Letter' : 'A4';
  const margin = paperSize === 'LETTER' ? '19.05mm' : '20mm';
  const paragraphs = input.sentences.map((sentence) => `<p>${escapeHtml(sentence.text)}</p>`).join('');
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
    @page { size: ${pageSize}; margin: 22mm ${margin}; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #263344; font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.65; }
    main { white-space: normal; }
    p { margin: 0 0 1em; white-space: pre-wrap; overflow-wrap: anywhere; orphans: 3; widows: 3; }
    </style></head><body><main>${paragraphs}</main></body></html>`;
  return printPdf({ path: input.path, html, expectedTexts: input.sentences.map((sentence) => sentence.text), textCheckError: 'APPLICATION_DOCUMENT_TEXT_CHECK_FAILED', pdf: { format: pageSize, printBackground: true, preferCSSPageSize: true, tagged: true, margin: { top: '22mm', right: margin, bottom: '22mm', left: margin } } });
}
