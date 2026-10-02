import { access, constants } from 'node:fs/promises';
import process from 'node:process';

const checks = [];
checks.push([Number(process.versions.node.split('.')[0]) === 24, `Node ${process.versions.node} (requires 24.x)`]);
try {
  await access('.env', constants.R_OK);
  checks.push([true, '.env exists']);
} catch {
  checks.push([false, '.env missing; run pnpm run bootstrap']);
}
try {
  const env = await (await import('node:fs/promises')).readFile('.env', 'utf8');
  const rawUrl = env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
  const url = new URL(rawUrl ?? '');
  checks.push([['postgresql:', 'postgres:'].includes(url.protocol), 'DATABASE_URL is configured']);
  checks.push([/APP_ENCRYPTION_KEY=.{32,}/.test(env) && /APP_SESSION_SECRET=.{32,}/.test(env), 'local secrets are configured']);
} catch {
  checks.push([false, 'DATABASE_URL or local secrets are invalid']);
}
let failed = false;
for (const [ok, message] of checks) {
  console.log(`${ok ? '✓' : '!' } ${message}`);
  failed ||= !ok;
}
console.log(`AI_PROVIDER=${process.env.AI_PROVIDER ?? 'none'}; application writes are unavailable in v0.1.`);
if (failed) process.exitCode = 1;
