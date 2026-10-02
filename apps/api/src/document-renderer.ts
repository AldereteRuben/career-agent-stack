import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { resumeLabels, resumeSectionName } from '@career/domain';

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export async function renderResume(input: { path: string; fullName: string; role: string; locale?: 'es' | 'en'; facts: Array<{ kind: string; statement: string; tags: string[] }> }) {
  if (!input.facts.length || input.facts.length > 50) throw new Error('DOCUMENT_FACT_LIMIT');
  if (input.facts.reduce((size, fact) => size + fact.statement.length, 0) > 40_000) throw new Error('DOCUMENT_SIZE_LIMIT');
  const grouped = new Map<string, typeof input.facts>();
  for (const fact of input.facts) grouped.set(fact.kind, [...(grouped.get(fact.kind) ?? []), fact]);
  const locale = input.locale === 'es' ? 'es' : 'en';
  const labels = resumeLabels(locale);
  const sections = [...grouped].map(([kind, facts]) => `<section><h2>${escapeHtml(resumeSectionName(kind, locale))}</h2><ul>${facts.map((fact) => `<li>${escapeHtml(fact.statement)}</li>`).join('')}</ul></section>`).join('');
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
    @page{size:A4;margin:17mm 18mm 18mm}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#1d2635;font-size:10pt;line-height:1.48;margin:0}header{border-bottom:2px solid #3766db;padding-bottom:12px;margin-bottom:16px}h1{font-size:23pt;line-height:1.1;margin:0 0 5px;letter-spacing:-.4px}header p{color:#536176;font-size:11pt;margin:0}h2{font-size:10pt;letter-spacing:1px;text-transform:uppercase;color:#315cbe;border-bottom:1px solid #d8dfeb;padding-bottom:4px;margin:16px 0 7px}ul{margin:0;padding-left:17px}li{padding:0 0 5px;break-inside:avoid}section{break-inside:avoid}footer{position:fixed;bottom:-11mm;left:0;right:0;text-align:center;font-size:8pt;color:#8a94a5}
    </style></head><body><header><h1>${escapeHtml(input.fullName || labels.defaultName)}</h1><p>${escapeHtml(input.role || labels.defaultRole)}</p></header>${sections}<footer>${escapeHtml(labels.footer)}</footer></body></html>`;
  const absolutePath = resolve(input.path);
  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: false, javaScriptEnabled: false });
    const page = await context.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html, { waitUntil: 'load', timeout: 10_000 });
    const extractedText = await page.locator('body').innerText();
    for (const fact of input.facts) if (!extractedText.includes(fact.statement)) throw new Error('DOCUMENT_TEXT_CHECK_FAILED');
    await page.pdf({ path: absolutePath, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false, margin: { top: '17mm', right: '18mm', bottom: '18mm', left: '18mm' } });
  } finally { await browser.close(); }
  const bytes = await readFile(absolutePath);
  if (bytes.byteLength < 1_000 || bytes.byteLength > 20_000_000 || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('PDF_OUTPUT_INVALID');
  return { absolutePath, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
}
