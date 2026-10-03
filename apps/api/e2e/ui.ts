// Locator helpers that tolerate copy changes: every UI string is matched in Spanish or English and,
// where possible, by role, href or form structure instead of exact text or CSS classes.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { APIRequestContext, BrowserContext, Locator, Page } from 'playwright';

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive match of any of the given phrases (substring). */
export const any = (...phrases: string[]) => new RegExp(phrases.map(escape).join('|'), 'i');

export const locales = ['es', 'en'] as const;
export type Locale = (typeof locales)[number];

export const routes = ['/', '/jobs', '/applications', '/profile', '/documents', '/boards', '/settings'] as const;

export async function currentLocale(page: Page): Promise<string> {
  return ((await page.locator('html').getAttribute('lang')) ?? '').slice(0, 2).toLowerCase();
}

export async function setLocale(page: Page, locale: Locale) {
  for (let attempt = 0; attempt < 3 && (await currentLocale(page)) !== locale; attempt += 1) {
    await page.getByRole('button', { name: locale === 'en' ? /^English$/ : /^Español$/ }).first().click();
    await page.waitForFunction((wanted) => document.documentElement.lang.startsWith(wanted), locale, { timeout: 5_000 }).catch(() => undefined);
  }
  assert.equal(await currentLocale(page), locale, `Could not switch the interface to ${locale}`);
}

export function mainNavigation(page: Page): Locator {
  return page.getByRole('navigation', { name: any('Navegación principal', 'Main navigation') });
}

/** Navigates through the main navigation by href, so renamed labels do not break the test. */
export async function goTo(page: Page, href: string) {
  if (new URL(page.url()).pathname === href || (page.viewportSize()?.width ?? 1440) <= 850) {
    await page.goto(new URL(href, page.url()).toString());
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    return;
  }
  const link = mainNavigation(page).locator(`a[href="${href}"]`).first();
  if (await link.isVisible().catch(() => false)) await link.click();
  else await page.goto(new URL(href, page.url()).toString());
  await page.waitForURL((url) => url.pathname === href);
  await page.getByRole('heading', { level: 1 }).first().waitFor();
}

export async function signIn(page: Page, uiUrl: string, token: string) {
  await page.goto(`${uiUrl}/login`, { waitUntil: 'domcontentloaded' });
  const field = page.getByLabel(/^(Código de acceso|Sign-in code)$/i).first();
  await field.fill(token);
  const submit = page.getByRole('button', { name: any('Entrar', 'Sign in', 'Iniciar sesión', 'Continue', 'Continuar', 'Open my workspace') }).first();
  if (await submit.isVisible().catch(() => false)) await submit.click();
  else await field.press('Enter');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
  await page.getByRole('heading', { level: 1 }).first().waitFor();
}

/** Visible feedback after a failed action: an alert region or a recognisable error sentence. */
export function errorFeedback(page: Page): Locator {
  return page.getByRole('alert').or(page.getByText(any('No se pudo', 'no se ha podido', 'Inténtalo', 'Could not', 'could not', 'Try again', 'went wrong', 'Algo salió mal'))).first();
}

export async function hasHorizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

export async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, message: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!accept(last) && Date.now() < deadline) {
    await delay(250);
    last = await read();
  }
  assert.ok(accept(last), `${message} (last value: ${JSON.stringify(last)?.slice(0, 400)})`);
  return last;
}

/** JSON client for the isolated API through the isolated dashboard origin, sharing the browser session cookie. */
export function apiClient(context: BrowserContext, uiUrl: string, pace: () => Promise<void> = async () => {}) {
  const request: APIRequestContext = context.request;
  const call = async <T>(method: string, path: string, data?: unknown): Promise<T> => {
    await pace();
    // Fixture GETs may reuse a connection closed by the dev proxy. Playwright retries only ECONNRESET, not HTTP errors.
    // Writes are never retried: repeating a successful mutation after a lost response could duplicate side effects.
    const response = await request.fetch(`${uiUrl}/api/v1${path}`, { method, maxRetries: method === 'GET' ? 1 : 0, headers: { Origin: uiUrl, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { data: JSON.stringify(data) }) });
    const body = await response.text();
    assert.ok(response.ok(), `${method} ${path} → ${response.status()} ${body.slice(0, 300)}`);
    return (body ? JSON.parse(body) : null) as T;
  };
  return {
    get: <T>(path: string) => call<T>('GET', path),
    post: <T>(path: string, data?: unknown) => call<T>('POST', path, data ?? {}),
    put: <T>(path: string, data: unknown) => call<T>('PUT', path, data),
    patch: <T>(path: string, data: unknown) => call<T>('PATCH', path, data),
    bytes: async (path: string) => {
      await pace();
      const response = await request.get(new URL(path, uiUrl).toString());
      assert.ok(response.ok(), `GET ${path} → ${response.status()}`);
      return response.body();
    },
  };
}
export type ApiClient = ReturnType<typeof apiClient>;
