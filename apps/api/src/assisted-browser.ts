import { chromium, type Browser, type Page } from 'playwright';
import { leverApplicationUrl, type AssistedPlan } from '@career/domain';

export type AssistedBrowserResult = { filled: string[]; manual: string[]; reason?: string };
type Session = { browser: Browser; page: Page; mode: 'LOADING' | 'FILLING' | 'REVIEW' | 'MANUAL'; url: string; onLost: () => Promise<void> };

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
      const session: Session = { browser, page, mode: 'LOADING', url: plan.url, onLost };
      this.sessions.set(id, session);
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
        // No network traffic at all while filling or reviewing. Human handoff explicitly lifts this barrier.
        if (session.mode === 'FILLING' || session.mode === 'REVIEW') return route.abort();
        if (url.protocol !== 'https:' || url.username || url.password || (!sameOrigin && !captcha)) return route.abort();
        if (session.mode === 'LOADING' && (request.method() !== 'GET' || (request.isNavigationRequest() && (request.frame() === page.mainFrame()) && url.href !== plan.url))) return route.abort();
        return route.fallback();
      });
      page.setDefaultTimeout(5000);
      await page.goto(plan.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      if (page.url() !== plan.url) throw new Error('ASSIST_PAGE_CHANGED');
      session.mode = 'FILLING';
      const form = page.locator('form#application-form');
      const filled: string[] = []; const manual: string[] = ['resume', 'custom-questions', 'legal-consents', 'captcha', 'submit'];
      if (await form.count() !== 1 || !await form.isVisible()) {
        session.mode = 'REVIEW';
        return { filled, manual, reason: 'ASSIST_FORM_NOT_RECOGNIZED' };
      }
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
  async close(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.browser.close();
  }
  async closeAll() { await Promise.all([...this.sessions.keys()].map((id) => this.close(id))); }
}
