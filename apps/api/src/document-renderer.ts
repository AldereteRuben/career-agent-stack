import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { resumeLabels, resumeSectionName } from '@career/domain';

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export async function renderResume(input: { path: string; fullName: string; email?: string; role: string; locale?: 'es' | 'en'; facts: Array<{ kind: string; statement: string; tags: string[] }> }) {
  if (!input.facts.length || input.facts.length > 50) throw new Error('DOCUMENT_FACT_LIMIT');
  if (input.facts.reduce((size, fact) => size + fact.statement.length, 0) > 40_000) throw new Error('DOCUMENT_SIZE_LIMIT');
  const grouped = new Map<string, typeof input.facts>();
  for (const fact of input.facts) grouped.set(fact.kind, [...(grouped.get(fact.kind) ?? []), fact]);
  const locale = input.locale === 'es' ? 'es' : 'en';
  const labels = resumeLabels(locale);
  const sectionOrder = ['experience', 'current_employment', 'achievement', 'project', 'skill_evidence', 'skill', 'education', 'certification', 'language'];
  const sections = [...grouped].sort(([a], [b]) => {
    const rank = (kind: string) => sectionOrder.includes(kind) ? sectionOrder.indexOf(kind) : sectionOrder.length;
    return rank(a) - rank(b);
  }).map(([kind, facts]) => `<section><h2>${escapeHtml(resumeSectionName(kind, locale))}</h2><ul>${facts.map((fact) => `<li>${escapeHtml(fact.statement)}</li>`).join('')}</ul></section>`).join('');
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
    @page { size: A4; margin: 19mm 20mm 21mm; }
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
    </style></head><body><header><h1>${escapeHtml(input.fullName || labels.defaultName)}</h1><p class="role">${escapeHtml(input.role || labels.defaultRole)}</p>${input.email ? `<p class="contact">${escapeHtml(input.email)}</p>` : ''}</header><main>${sections}</main></body></html>`;
  const footer = `<div style="width:100%;margin:0 20mm;padding-top:7px;border-top:1px solid #dce3e8;font-family:Arial,Helvetica,sans-serif;font-size:7px;color:#526171;display:flex;justify-content:flex-end;gap:12px"><span style="white-space:nowrap"><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
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
    await page.pdf({ path: absolutePath, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footer, tagged: true, margin: { top: '19mm', right: '20mm', bottom: '21mm', left: '20mm' } });
  } finally { await browser.close(); }
  const bytes = await readFile(absolutePath);
  if (bytes.byteLength < 1_000 || bytes.byteLength > 20_000_000 || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('PDF_OUTPUT_INVALID');
  return { absolutePath, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
}
