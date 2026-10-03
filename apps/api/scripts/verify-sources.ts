/**
 * Opt-in live validation of the public job-board adapters against real, unauthenticated provider feeds.
 *
 *   pnpm --filter @career/api exec tsx scripts/verify-sources.ts --live [--out <summary.json>] [provider:region:tenant ...]
 *
 * Read-only: one GET per target through the production adapter, run one at a time with a pause in between. Only
 * aggregate counts and date ranges are printed or written; raw feeds and posting text are never stored.
 */
import { writeFileSync } from 'node:fs';
import { readBoardWithReport, sourceUrl, type BoardForSource } from '../src/sources.js';

const defaultTargets = ['greenhouse:global:gitlab', 'lever:global:leverdemo', 'lever:eu:lever', 'ashby:global:ashby'];
const pauseMs = 1_000;

type Summary = {
  target: string; endpoint: string | null; outcome: 'OK' | 'ERROR'; error?: string; elapsedMs: number;
  bytes?: number; received?: number; valid?: number; unlisted?: number; skipped?: number; skipReasons?: Record<string, number>;
  withDescription?: number; withLocation?: number; withApplyUrl?: number; withPostedAt?: number; withUpdatedAt?: number;
  postedAtRange?: [string, string] | null; updatedAtRange?: [string, string] | null; descriptionChars?: { min: number; median: number; max: number } | null;
  markupLeaks?: number; offHostJobUrls?: number;
};

function parseTarget(value: string): BoardForSource {
  const [provider, region, tenant, ...rest] = value.split(':');
  if (!provider || !region || !tenant || rest.length) throw new Error(`Target must be provider:region:tenant, got "${value}"`);
  return { provider: provider as BoardForSource['provider'], region, tenant };
}
const range = (values: Array<string | null>): [string, string] | null => { const sorted = values.filter((v): v is string => !!v).sort(); return sorted.length ? [sorted[0]!, sorted.at(-1)!] : null; };
const hostedOn = (provider: string) => provider === 'greenhouse' ? /(^|\.)greenhouse\.io$/ : provider === 'lever' ? /(^|\.)lever\.co$/ : /(^|\.)ashbyhq\.com$/;

async function verify(target: string): Promise<Summary> {
  const started = Date.now();
  let board: BoardForSource;
  try { board = parseTarget(target); } catch (error) { return { target, endpoint: null, outcome: 'ERROR', error: (error as Error).message, elapsedMs: 0 }; }
  try {
    const report = await readBoardWithReport(board);
    const lengths = report.jobs.map((job) => job.description?.length ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
    return {
      target, endpoint: report.url, outcome: 'OK', elapsedMs: Date.now() - started, bytes: report.bytes, received: report.received, valid: report.jobs.length, unlisted: report.unlisted, skipped: report.skipped, skipReasons: report.skipReasons,
      withDescription: lengths.length, withLocation: report.jobs.filter((job) => job.location).length, withApplyUrl: report.jobs.filter((job) => job.applyUrl).length,
      withPostedAt: report.jobs.filter((job) => job.postedAt).length, withUpdatedAt: report.jobs.filter((job) => job.updatedAt).length,
      postedAtRange: range(report.jobs.map((job) => job.postedAt)), updatedAtRange: range(report.jobs.map((job) => job.updatedAt)),
      descriptionChars: lengths.length ? { min: lengths[0]!, median: lengths[Math.floor(lengths.length / 2)]!, max: lengths.at(-1)! } : null,
      // Plain-text fields should never carry tags or undecoded entities.
      markupLeaks: report.jobs.filter((job) => /<\/?[a-z][^>]*>|&(?:[a-z]{2,8}|#\d{1,7}|#x[0-9a-f]{1,6});/i.test(`${job.title}\n${job.description ?? ''}`)).length,
      offHostJobUrls: report.jobs.filter((job) => !hostedOn(board.provider).test(new URL(job.jobUrl).hostname)).length,
    };
  } catch (error) {
    let endpoint: string | null = null;
    try { endpoint = sourceUrl(board).toString(); } catch { /* rejected before any request */ }
    return { target, endpoint, outcome: 'ERROR', error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - started };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--live')) {
    console.error('Live source validation makes real network requests to public job-board APIs. Re-run with --live to opt in.');
    process.exit(2);
  }
  let out: string | undefined; const targets: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--live') continue;
    if (args[index] === '--out') { out = args[++index]; if (!out) { console.error('--out needs a file path'); process.exit(2); } continue; }
    targets.push(args[index]!);
  }
  const list = targets.length ? targets : defaultTargets;
  const results: Summary[] = [];
  for (const [index, target] of list.entries()) {
    if (index) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    const summary = await verify(target); results.push(summary);
    console.log(JSON.stringify(summary));
  }
  const record = { recordedAt: new Date().toISOString(), adapter: 'apps/api/src/sources.ts', node: process.version, results };
  if (out) writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  process.exit(results.some((result) => result.outcome !== 'OK' || (result.markupLeaks ?? 0) > 0) ? 1 : 0);
}

await main();
