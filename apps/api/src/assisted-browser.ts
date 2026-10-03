import { chromium, type Browser, type Page } from 'playwright';
import { createHash } from 'node:crypto';
import { leverApplicationUrl, type AssistedPlan } from '@career/domain';

export type AssistedBrowserResult = { filled: string[]; manual: string[]; reason?: string };
export type AssistedSubmitInspection = { supported: true } | { supported: false; reason: string };
export type AssistedSubmitResult = { outcome: 'CONFIRMED' | 'UNKNOWN'; reason: string; receipt?: string };
type Session = { browser: Browser; page: Page; mode: 'LOADING' | 'FILLING' | 'REVIEW' | 'SUBMITTING' | 'MANUAL'; url: string; submitUrl?: string; submissionResponseStatus: number | undefined; submissionResponseUrl: string | undefined; writes: number; fields: AssistedPlan['fields']; onLost: () => Promise<void> };

/** One visible, ephemeral browser per workspace. Never stores cookies, traces, PDFs or screenshots. */
export class AssistedBrowser {
  private sessions = new Map<string, Session>();
  private starting = false;
  constructor(private readonly launch = () => chromium.launch({ headless: false })) {}
  has(id: string) { return this.sessions.has(id); }
  busy() { return this.starting || this.sessions.size > 0; }

  async start(id: string, plan: AssistedPlan, onLost: () => Promise<void>): Promise<AssistedBrowserResult> {
    if (this.busy()) throw new Error('ASSIST_BROWSER_BUSY');
    if (leverApplicationUrl(plan.url) !== plan.url) throw new Error('ASSIST_UNSUPPORTED_URL');
    this.starting = true;
    let browser: Browser | undefined;
    try {
      browser = await this.launch();
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
      await context.routeWebSocket('**/*', (socket) => socket.close());
      const page = await context.newPage();
      const session: Session = { browser, page, mode: 'LOADING', url: plan.url, submissionResponseStatus: undefined, submissionResponseUrl: undefined, writes: 0, fields: plan.fields, onLost };
      this.sessions.set(id, session);
      page.on('response', (response) => {
        if (session.mode === 'SUBMITTING' && response.request().method() === 'POST' && response.url() === session.submitUrl) {
          session.submissionResponseStatus = response.status(); session.submissionResponseUrl = response.url();
        }
      });
      browser.once('disconnected', () => {
        if (this.sessions.delete(id)) void onLost().catch(() => undefined);
      });
      page.once('close', () => { if (this.sessions.has(id)) void browser?.close().catch(() => undefined); });
      context.on('page', (other) => { if (other !== page) void other.close().catch(() => undefined); });
      page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => undefined); });
      await context.route('**/*', async (route) => {
        const request = route.request(); const url = new URL(request.url());
        const sameOrigin = url.origin === new URL(plan.url).origin;
        const captcha = url.protocol === 'https:' && !url.port && (url.hostname === 'hcaptcha.com' || url.hostname.endsWith('.hcaptcha.com'));
        // No network traffic while filling or reviewing. Submission opens only a single same-origin write.
        if (session.mode === 'FILLING' || session.mode === 'REVIEW') return route.abort();
        if (url.protocol !== 'https:' || url.username || url.password || (!sameOrigin && !captcha)) return route.abort();
        if (session.mode === 'SUBMITTING') {
          if (!sameOrigin) return route.abort();
          if (request.method() === 'GET' && session.writes === 1 && request.isNavigationRequest() && request.frame() === page.mainFrame()) return route.fallback();
          if (request.method() === 'POST' && request.url() === session.submitUrl && session.writes === 0) { session.writes++; return route.fallback(); }
          return route.abort();
        }
        if (session.mode === 'LOADING' && (request.method() !== 'GET' || (request.isNavigationRequest() && (request.frame() === page.mainFrame()) && url.href !== plan.url))) return route.abort();
        return route.fallback();
      });
      page.setDefaultTimeout(5000);
      await page.goto(plan.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      if (page.url() !== plan.url) throw new Error('ASSIST_PAGE_CHANGED');
      session.mode = 'FILLING';
      const form = page.locator('form#application-form');
      const filled: string[] = []; const manual: string[] = ['custom-questions', 'legal-consents', 'captcha'];
      if (await form.count() !== 1 || !await form.isVisible()) {
        session.mode = 'REVIEW';
        return { filled, manual, reason: 'ASSIST_FORM_NOT_RECOGNIZED' };
      }
      if (await page.locator('iframe[src*="captcha" i], [class*="captcha" i], [id*="captcha" i], [name*="captcha" i], [name*="g-recaptcha-response"], [name*="h-captcha-response"]').count()) {
        session.mode = 'REVIEW'; return { filled, manual, reason: 'ASSIST_CAPTCHA_REQUIRED' };
      }
      const bodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
      if (/\b(sign in|log in|two.factor|multi.factor|one.time code|verification code)\b/.test(bodyText)) {
        session.mode = 'REVIEW'; return { filled, manual, reason: 'ASSIST_AUTH_REQUIRED' };
      }
      const controls = await form.locator('input,textarea,select').evaluateAll((nodes) => nodes.map((node) => {
        const el = node as HTMLInputElement;
        const required = el.required || el.getAttribute('aria-required') === 'true';
        const label = [...(el.labels ?? [])].map((item) => item.innerText).join(' ').toLowerCase();
        return { type: el.type, checked: el.checked, required, name: el.name, legal: /legal|consent|agree|attest|certif|authorization|privacy|terms|truthful|accurate/.test(`${el.name} ${label}`) };
      }));
      if (controls.some((item) => item.type === 'checkbox' && item.legal && !item.checked)) { session.mode = 'REVIEW'; return { filled, manual, reason: 'ASSIST_LEGAL_REVIEW_REQUIRED' }; }
      if (controls.some((item) => item.required && !['name', 'email', 'phone', 'org', 'resume'].includes(item.name))) { session.mode = 'REVIEW'; return { filled, manual, reason: 'ASSIST_REQUIRED_FIELD_UNSUPPORTED' }; }
      // Validate every destination before touching any field. Unknown or modified forms stay manual.
      const destinations: Array<{ key: keyof AssistedPlan['fields']; value: string }> = [];
      for (const [key, value] of Object.entries(plan.fields) as Array<[keyof AssistedPlan['fields'], string]>) {
        if (!value) continue;
        const input = form.locator(`input[name="${key}"]`);
        if (await input.count() !== 1 || !await input.isVisible() || !await input.isEditable() || !['text', 'email', 'tel'].includes(await input.getAttribute('type') ?? 'text') || await input.inputValue()) {
          if (key === 'name' || key === 'email') {
            session.mode = 'REVIEW';
            return { filled, manual: [...manual, ...Object.keys(plan.fields)], reason: 'ASSIST_FORM_NOT_RECOGNIZED' };
          }
          manual.push(key); continue;
        }
        destinations.push({ key, value });
      }
      for (const { key, value } of destinations) {
        if (page.url() !== plan.url) throw new Error('ASSIST_PAGE_CHANGED');
        await form.locator(`input[name="${key}"]`).fill(value);
        filled.push(key);
      }
      session.mode = 'REVIEW';
      await page.bringToFront();
      return { filled, manual };
    } catch (error) {
      this.sessions.delete(id);
      await browser?.close().catch(() => undefined);
      throw error;
    } finally { this.starting = false; }
  }

  async handoff(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.page.isClosed()) throw new Error('ASSIST_BROWSER_LOST');
    if (session.page.url() !== session.url) throw new Error('ASSIST_PAGE_CHANGED');
    // No click, key press, upload, consent acceptance or submission is performed here.
    session.mode = 'MANUAL';
    await session.page.bringToFront();
  }
  private async inspectSubmission(session: Session): Promise<AssistedSubmitInspection> {
    const { page } = session;
    const unsupported = (reason: string): AssistedSubmitInspection => ({ supported: false, reason });
    if (page.isClosed() || page.url() !== session.url || new URL(page.url()).origin !== new URL(session.url).origin) return unsupported('ASSIST_PAGE_CHANGED');
    if (await page.locator('iframe[src*="captcha" i], [class*="captcha" i], [id*="captcha" i], [name*="captcha" i], [name*="g-recaptcha-response"], [name*="h-captcha-response"]').count()) return unsupported('ASSIST_CAPTCHA_REQUIRED');
    const visibleText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    if (/\b(sign in|log in|two.factor|multi.factor|one.time code|verification code)\b/.test(visibleText)) return unsupported('ASSIST_AUTH_REQUIRED');
    const form = page.locator('form#application-form');
    if (await form.count() !== 1 || !await form.isVisible()) return unsupported('ASSIST_FORM_NOT_RECOGNIZED');
    const receiptBefore = page.locator('[data-qa="application-confirmation"], .application-confirmation, .application-success, [data-qa="application-success"]');
    for (let i = 0; i < await receiptBefore.count(); i++) if (await receiptBefore.nth(i).isVisible()) return unsupported('ASSIST_RECEIPT_PREEXISTS');
    const action = new URL(await form.getAttribute('action') || page.url(), page.url());
    if ((await form.getAttribute('method') || 'get').toLowerCase() !== 'post' || action.origin !== new URL(session.url).origin || action.protocol !== 'https:' || action.username || action.password) return unsupported('ASSIST_SUBMIT_UNSUPPORTED');
    action.hash = '';
    session.submitUrl = action.href;
    const controls = await form.locator('input,textarea,select,button').evaluateAll((nodes) => nodes.map((node) => {
      const el = node as HTMLInputElement;
      const label = [...(el.labels ?? [])].map((item) => item.innerText).join(' ').toLowerCase();
      return { tag: el.tagName.toLowerCase(), name: el.name, type: (el.type || '').toLowerCase(), value: el.value, required: el.required || el.getAttribute('aria-required') === 'true', checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked : true, legal: /legal|consent|agree|attest|certif|authorization|privacy|terms|truthful|accurate/.test(`${el.name} ${label}`), disabled: el.disabled };
    }));
    if (controls.some((item) => item.tag === 'input' && item.type === 'checkbox' && item.legal && !item.checked)) return unsupported('ASSIST_LEGAL_REVIEW_REQUIRED');
    if (controls.some((item) => item.required && !['name', 'email', 'phone', 'org', 'resume'].includes(item.name))) return unsupported('ASSIST_REQUIRED_FIELD_UNSUPPORTED');
    if (controls.some((item) => item.required && item.name === 'resume' && item.type !== 'file')) return unsupported('ASSIST_FORM_NOT_RECOGNIZED');
    if (controls.some((item) => item.required && item.name !== 'resume' && item.type === 'checkbox')) return unsupported('ASSIST_LEGAL_REVIEW_REQUIRED');
    const allowedData = new Set(['name', 'email', 'phone', 'org', 'resume']);
    if (controls.some((item) => item.tag !== 'button' && !allowedData.has(item.name) && ((item.type === 'checkbox' || item.type === 'radio') ? item.checked : item.value !== ''))) return unsupported('ASSIST_OPTIONAL_FIELD_REVIEW_REQUIRED');
    for (const key of ['name', 'email', 'phone', 'org'] as const) {
      const field = form.locator(`input[name="${key}"]`);
      if ((key === 'phone' || key === 'org') && !session.fields[key] && await field.count() === 0) continue;
      if (await field.count() !== 1 || !await field.isVisible() || !await field.isEditable() || await field.inputValue() !== session.fields[key]) return unsupported('ASSIST_FORM_NOT_RECOGNIZED');
    }
    const resume = form.locator('input[type="file"][name="resume"]');
    if (await resume.count() !== 1 || await resume.isDisabled()) return unsupported('ASSIST_UPLOAD_UNSUPPORTED');
    const buttons = form.locator('button[type="submit"]');
    if (await buttons.count() !== 1 || !await buttons.isVisible() || !await buttons.isEnabled()) return unsupported('ASSIST_SUBMIT_UNSUPPORTED');
    return { supported: true };
  }
  async inspectSubmit(id: string): Promise<AssistedSubmitInspection> {
    const session = this.sessions.get(id);
    if (!session || session.mode !== 'REVIEW') return { supported: false, reason: 'ASSIST_BROWSER_LOST' };
    return this.inspectSubmission(session);
  }
  async submit(id: string, input: { bytes: Buffer; sha256: string; name: string; fields: { name: string; email: string; phone: string; org: string } }): Promise<AssistedSubmitResult> {
    const session = this.sessions.get(id);
    if (!session || session.mode !== 'REVIEW') throw new Error('ASSIST_BROWSER_LOST');
    if (createHash('sha256').update(input.bytes).digest('hex') !== input.sha256) throw new Error('ASSIST_DOCUMENT_STALE');
    const check = await this.inspectSubmission(session);
    if (!check.supported) throw new Error(check.reason);
    const form = session.page.locator('form#application-form');
    for (const key of ['name', 'email', 'phone', 'org'] as const) {
      if ((key === 'phone' || key === 'org') && !input.fields[key] && await form.locator(`input[name="${key}"]`).count() === 0) continue;
      if (await form.locator(`input[name="${key}"]`).inputValue() !== input.fields[key]) throw new Error('ASSIST_INPUTS_CHANGED');
    }
    session.writes = 0;
    await form.locator('input[type="file"][name="resume"]').setInputFiles({ name: input.name, mimeType: 'application/pdf', buffer: input.bytes });
    const uploaded = await form.locator('input[type="file"][name="resume"]').evaluate((element) => {
      const file = (element as HTMLInputElement).files?.[0];
      return file ? { name: file.name, size: file.size, type: file.type } : null;
    });
    if (!uploaded || uploaded.name !== input.name || uploaded.size !== input.bytes.length || uploaded.type !== 'application/pdf') throw new Error('ASSIST_UPLOAD_UNSUPPORTED');
    const afterUpload = await this.inspectSubmission(session);
    if (!afterUpload.supported) throw new Error(afterUpload.reason);
    session.mode = 'SUBMITTING';
    await session.page.bringToFront();
    try {
      const receiptBefore = session.page.locator('[data-qa="application-confirmation"], .application-confirmation, .application-success, [data-qa="application-success"]');
      for (let i = 0; i < await receiptBefore.count(); i++) if (await receiptBefore.nth(i).isVisible()) throw new Error('ASSIST_RECEIPT_PREEXISTS');
      session.submissionResponseStatus = undefined; session.submissionResponseUrl = undefined;
      const submitResponse = session.page.waitForResponse((response) => response.request().method() === 'POST' && response.url() === session.submitUrl, { timeout: 4000 });
      await Promise.all([form.locator('button[type="submit"]').click(), submitResponse]);
      const receipt = session.page.locator('[data-qa="application-confirmation"], .application-confirmation, .application-success, [data-qa="application-success"]');
      await receipt.first().waitFor({ state: 'visible', timeout: 4000 });
      if (new URL(session.page.url()).origin !== new URL(session.url).origin || session.writes !== 1 || session.submissionResponseUrl !== session.submitUrl || session.submissionResponseStatus === undefined || session.submissionResponseStatus < 200 || session.submissionResponseStatus >= 300) {
        this.sessions.delete(id); await session.browser.close().catch(() => undefined);
        return { outcome: 'UNKNOWN', reason: 'ASSIST_RECEIPT_UNVERIFIED' };
      }
      const text = (await receipt.first().innerText()).slice(0, 300);
      if (!/application (was )?(submitted|received)|thank you for applying|we received your application|your application has been received/i.test(text)) {
        this.sessions.delete(id); await session.browser.close().catch(() => undefined);
        return { outcome: 'UNKNOWN', reason: 'ASSIST_RECEIPT_UNVERIFIED' };
      }
      this.sessions.delete(id); await session.browser.close().catch(() => undefined);
      return { outcome: 'CONFIRMED', reason: 'ASSIST_VISIBLE_RECEIPT', receipt: text };
    } catch {
      // A click may have reached the employer even when its receipt could not be read. Never retry it.
      this.sessions.delete(id); await session.browser.close().catch(() => undefined);
      return { outcome: 'UNKNOWN', reason: 'ASSIST_SUBMISSION_UNCERTAIN' };
    }
  }
  async close(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.browser.close();
  }
  async closeAll() { await Promise.all([...this.sessions.keys()].map((id) => this.close(id))); }
}
