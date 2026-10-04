import { createHmac } from 'node:crypto';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeAiUsage, type AiUsageObservation, type AiUsageSnapshot } from '@career/domain';
import { runAiProcess, type AiProcessOptions } from './process.js';
import { isAiRecord, withAiRpcProcess, type AiRpcClient } from './rpc.js';

/** This is an inspected protocol candidate, not a declaration that inference passed G0. */
export const CODEX_PROTOCOL_VERSION = '0.160.0';
export type CodexAccountObservation = {
  status: 'NOT_INSTALLED' | 'SIGNED_OUT' | 'SIGNED_IN' | 'UNSUPPORTED' | 'UNAVAILABLE';
  version: string | null;
  billing: 'CHATGPT_PLAN' | 'SEPARATE_API' | 'UNKNOWN';
  accountFingerprint: string | null;
  maskedIdentity: string | null;
  plan: string | null;
  usage: AiUsageSnapshot;
};
const knownPlans = new Set(['free', 'go', 'plus', 'pro', 'prolite', 'promax', 'team', 'self_serve_business_prolite', 'self_serve_business_usage_based', 'business', 'ent26', 'enterprise_cbp_automation', 'enterprise_cbp_usage_based', 'enterprise', 'edu', 'edu_plus', 'edu_pro', 'unknown']);
const emptyUsage = (now: number) => normalizeAiUsage({ provider: 'codex', source: 'NONE', observedAt: null, windows: [], costUsd: null }, now);
const emptyObservation = (status: CodexAccountObservation['status'], now: number, version: string | null = null): CodexAccountObservation => ({ status, version, billing: 'UNKNOWN', accountFingerprint: null, maskedIdentity: null, plan: null, usage: emptyUsage(now) });

/** Only the official account response is inspected; credentials and auth files are never read. */
export function normalizeCodexAccount(raw: unknown, identitySalt: string, now: number): CodexAccountObservation {
  if (identitySalt.length < 32 || !isAiRecord(raw) || !Object.hasOwn(raw, 'account')) return emptyObservation('UNAVAILABLE', now);
  if (raw.account === null) return emptyObservation('SIGNED_OUT', now);
  if (!isAiRecord(raw.account)) return emptyObservation('UNAVAILABLE', now);
  if (raw.account.type === 'apiKey' || raw.account.type === 'amazonBedrock') return { ...emptyObservation('UNSUPPORTED', now), billing: 'SEPARATE_API' };
  if (raw.requiresOpenaiAuth !== true || raw.account.type !== 'chatgpt') return emptyObservation('UNSUPPORTED', now);
  const email = raw.account.email;
  // Without an observable identity we cannot detect a changed account and must not authorize a connection.
  if (typeof email !== 'string' || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return emptyObservation('UNAVAILABLE', now);
  const [local = '', domain = ''] = email.split('@');
  return {
    ...emptyObservation('SIGNED_IN', now), billing: 'CHATGPT_PLAN',
    accountFingerprint: createHmac('sha256', identitySalt).update(`codex:chatgpt:${email.toLowerCase()}`).digest('hex'),
    maskedIdentity: `${local.slice(0, 1)}***@${domain}`,
    plan: typeof raw.account.planType === 'string' && knownPlans.has(raw.account.planType) ? raw.account.planType : 'unknown',
  };
}

export function normalizeCodexUsage(raw: unknown, now: number): AiUsageSnapshot {
  if (!isAiRecord(raw)) return emptyUsage(now);
  const windows: AiUsageObservation['windows'] = [];
  // Prefer the named Codex bucket; never combine unrelated model quotas or imply they share one allowance.
  const buckets = isAiRecord(raw.rateLimitsByLimitId) ? raw.rateLimitsByLimitId : null;
  const bucket = buckets ? buckets.codex : raw.rateLimits;
  if (!isAiRecord(bucket)) return emptyUsage(now);
  for (const id of ['primary', 'secondary'] as const) {
    const value = bucket[id];
    if (!isAiRecord(value)) continue;
    const used = typeof value.usedPercent === 'number' && Number.isFinite(value.usedPercent) ? value.usedPercent : null;
    const seconds = typeof value.resetsAt === 'number' && Number.isSafeInteger(value.resetsAt) && value.resetsAt > 0 && value.resetsAt < 253402300800 ? value.resetsAt : null;
    windows.push({ windowId: id, usedPercent: used, resetsAt: seconds === null ? null : new Date(seconds * 1000).toISOString(), limitReached: raw.ordinaryUsageAllowed === false || bucket.spendControlReached === true || bucket.rateLimitReachedType != null ? true : used === null ? null : used >= 100 });
  }
  return normalizeAiUsage({ provider: 'codex', source: 'PROVIDER_REPORTED', observedAt: new Date(now).toISOString(), windows, costUsd: null }, now);
}

/** A fixed binary name from absolute PATH entries; never accept a browser-provided path or shell shim. */
export async function findCodexExecutable(environment: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const pathKey = process.platform === 'win32' ? Object.keys(environment).find(key => key.toLowerCase() === 'path') : 'PATH';
  const value = pathKey ? environment[pathKey] ?? '' : '';
  for (const directory of value.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    try { if (!(await stat(candidate)).isFile()) continue; await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return candidate; }
    catch { /* try the next trusted search entry */ }
  }
  return null;
}

export async function initializeCodexRpc(rpc: AiRpcClient): Promise<void> {
  await rpc.request('initialize', { clientInfo: { name: 'career_stack', title: 'Career Stack', version: '0.9.0' }, capabilities: { experimentalApi: true } });
  await rpc.notify('initialized');
}

type InspectDependencies = {
  resolveBinary: () => Promise<string | null>;
  run: typeof runAiProcess;
  rpc: typeof withAiRpcProcess;
  now: () => number;
};
/** Account inspection is explicit and inference-free. It does not authorize Career Stack or start login. */
export async function inspectCodexAccount(identitySalt: string, signal?: AbortSignal, dependencies: Partial<InspectDependencies> = {}, readUsage = false): Promise<CodexAccountObservation> {
  const now = dependencies.now ?? Date.now;
  const executable = await (dependencies.resolveBinary ?? findCodexExecutable)();
  if (!executable) return emptyObservation('NOT_INSTALLED', now());
  const directory = await mkdtemp(path.join(tmpdir(), 'career-codex-account-'));
  let version: string | null = null;
  try {
    const common: Omit<AiProcessOptions, 'args'> = { executable, cwd: directory, timeoutMs: 15_000, maxOutputBytes: 1024 * 1024, ...(signal ? { signal } : {}) };
    const observed = await (dependencies.run ?? runAiProcess)({ ...common, args: ['--version'] });
    version = /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(observed.stdout)?.[1] ?? null;
    if (version !== CODEX_PROTOCOL_VERSION) return emptyObservation('UNSUPPORTED', now(), version);
    return await (dependencies.rpc ?? withAiRpcProcess)({ ...common, args: ['--no-daemon', 'app-server', '--stdio'] }, async rpc => {
      await initializeCodexRpc(rpc);
      const observation = normalizeCodexAccount(await rpc.request('account/read', { refreshToken: false }), identitySalt, now());
      let usage = observation.usage;
      if (observation.status === 'SIGNED_IN' && readUsage) {
        try { usage = normalizeCodexUsage(await rpc.request('account/rateLimits/read'), now()); } catch { /* quota unavailable is not a lost connection */ }
      }
      return { ...observation, version, usage };
    });
  } catch { return emptyObservation('UNAVAILABLE', now(), version); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
