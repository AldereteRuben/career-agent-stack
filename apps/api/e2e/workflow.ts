// Browser E2E entry point (pnpm run test:e2e).
//
// Runs entirely against a disposable stack (see isolation.ts): a throwaway database, a private API and a
// private dashboard dev server on free ports. It never writes live workspace data (read-only fingerprints verify isolation), never uses
// the live sign-in token and never builds into the shared `.next`. If isolation cannot be proven the run
// stops before the browser opens. Everything it created is dropped at the end (E2E_KEEP=1 keeps it).
//
//   E2E_ONLY=name,name   run a subset of scenarios
//   E2E_HEADED=1         show the browser
//   E2E_KEEP=1           keep the disposable database, temp directories and logs for debugging
import { chmod, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createIsolatedStack, IsolationError, liveRowCounts, projectRoot, type IsolatedStack } from './isolation.js';
import { scenarios, type ScenarioContext } from './scenarios.js';
import { apiClient } from './ui.js';

let activeStack: IsolatedStack | undefined;

type Result = { name: string; ok: boolean; ms: number; error?: string; notes: string[] };

async function runScenarios(stack: IsolatedStack, artifacts: string): Promise<Result[]> {
  const only = (process.env.E2E_ONLY ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  const selected = only.length ? scenarios.filter((scenario) => only.includes(scenario.name) || scenario.name === 'sign-in-and-language-switch') : scenarios;
  const browser = await chromium.launch({ headless: process.env.E2E_HEADED !== '1' });
  const results: Result[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'es-ES', baseURL: stack.uiUrl });
    // Pace browser and fixture requests together below the unchanged production limit.
    let nextRequest = 0;
    const pace = async () => {
      const start = Math.max(Date.now(), nextRequest);
      nextRequest = start + 600;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, start - Date.now())));
    };
    await context.route('**/api/v1/**', async (route) => { await pace(); await route.continue(); });
    const page = await context.newPage();
    let allowed: RegExp[] = [];
    let browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !allowed.some((pattern) => pattern.test(message.text()))) browserErrors.push(message.text()); });

    for (const scenario of selected) {
      const notes: string[] = [];
      allowed = []; browserErrors = [];
      const ctx: ScenarioContext = {
        page, context, api: apiClient(context, stack.uiUrl, pace), uiUrl: stack.uiUrl, marker: stack.marker, token: stack.readToken, artifacts,
        allowConsole: (pattern) => { allowed.push(pattern); }, note: (message) => { notes.push(message); },
      };
      const started = Date.now();
      try {
        await scenario.run(ctx);
        if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`);
        results.push({ name: scenario.name, ok: true, ms: Date.now() - started, notes });
        console.log(`✓ ${scenario.name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ name: scenario.name, ok: false, ms: Date.now() - started, error: message, notes });
        console.log(`✗ ${scenario.name}\n    ${message.split('\n').join('\n    ')}`);
        await page.screenshot({ path: join(artifacts, `failed-${scenario.name}.png`), fullPage: true }).catch(() => undefined);
        // Without a session nothing else can run.
        if (scenario.name === 'sign-in-and-language-switch') break;
      }
      for (const note of notes) console.log(`    note: ${note}`);
    }
    await context.close();
  } finally {
    await browser.close();
  }
  return results;
}

async function main() {
  console.log('Career Agent Stack E2E · isolated disposable stack');
  const liveBefore = await liveRowCounts().catch(() => null);
  let stack: IsolatedStack | undefined;
  let failed: boolean;
  try {
    stack = await createIsolatedStack();
    activeStack = stack;
    const artifacts = resolve(projectRoot, 'output/playwright', stack.runId);
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    await chmod(artifacts, 0o700);
    const results = await runScenarios(stack, artifacts);
    failed = results.some((result) => !result.ok);
    if (failed) console.log(`\n${await stack.tailLogs()}`);
    await stack.assertLiveUntouched();
    console.log(`\n${results.filter((result) => result.ok).length}/${results.length} scenarios passed · artifacts: ${artifacts}`);
  } catch (error) {
    failed = true;
    if (error instanceof IsolationError) console.error(`\n✗ Isolation not proven, nothing was run against it: ${error.message}`);
    else console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await stack?.teardown();
  }
  const liveAfter = await liveRowCounts().catch(() => null);
  if (liveBefore && liveAfter) {
    const changed = Object.keys(liveBefore).filter((table) => liveBefore[table] !== liveAfter[table]);
    // Informational only: the user may legitimately use the live app while tests run.
    if (changed.length) console.log(`note: live row counts changed during the run (${changed.join(', ')}); the run itself writes only to its disposable database.`);
  }
  process.exitCode = failed ? 1 : 0;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.error(`\nInterrupted (${signal}); removing the disposable stack…`);
    void (activeStack?.teardown() ?? Promise.resolve()).finally(() => process.exit(130));
  });
}

await main();
