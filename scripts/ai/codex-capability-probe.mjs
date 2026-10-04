// Read-only Codex capability probe for v0.9.0 T00.
// Uses version/help plus account/read and account/rateLimits/read over the official local app-server.
// It never starts login/logout, creates a thread, starts inference, requests config/instruction contents,
// or writes configuration. Identity and raw protocol payloads are normalized in memory and discarded.
import { spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { delimiter, extname, join } from 'node:path';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

export const PROBE_SCHEMA_VERSION = 1;
export const TIMEOUT_MS = 15_000;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const SHUTDOWN_GRACE_MS = 500;
export const HARD_SHUTDOWN_MS = 500;

const PLAN_TYPES = new Set([
  'free', 'go', 'plus', 'pro', 'prolite', 'promax', 'team', 'self_serve_business_prolite',
  'self_serve_business_usage_based', 'business', 'ent26', 'enterprise_cbp_automation',
  'enterprise_cbp_usage_based', 'enterprise', 'edu', 'edu_plus', 'edu_pro', 'unknown',
]);
const AUTH_MODES = new Set(['apikey', 'chatgpt', 'chatgptAuthTokens', 'agentIdentity', 'personalAccessToken', 'bedrockApiKey']);
const ACCOUNT_TYPES = new Set(['chatgpt', 'apiKey', 'amazonBedrock']);
const RATE_LIMIT_REACHED_TYPES = new Set([
  'rate_limit_reached', 'workspace_owner_credits_depleted', 'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached',
]);
export const AUTH_OVERRIDE_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'];
const CHILD_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'CODEX_HOME',
  'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec',
];

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailableAccount = () => ({
  available: false,
  accountPresent: false,
  requiresOpenaiAuth: null,
  accountType: null,
  authMode: null,
  planType: null,
  identityPresent: false,
});
const unavailableRateLimits = () => ({ available: false, ordinaryUsageAllowed: null, buckets: [] });

function enumOrUnknown(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : value == null ? null : 'other';
}

export function normalizeAccount(result) {
  if (!isRecord(result)) return unavailableAccount();
  const account = result.account;
  if (account !== null && !isRecord(account)) return unavailableAccount();
  if (account && ((account.type !== undefined && typeof account.type !== 'string')
    || (account.authMode !== undefined && typeof account.authMode !== 'string')
    || (account.planType !== undefined && typeof account.planType !== 'string')
    || (account.email !== undefined && account.email !== null && typeof account.email !== 'string'))) {
    return unavailableAccount();
  }
  const authMode = account?.authMode ?? result.authMode;
  return {
    available: true,
    accountPresent: account !== null,
    requiresOpenaiAuth: typeof result.requiresOpenaiAuth === 'boolean' ? result.requiresOpenaiAuth : null,
    accountType: enumOrUnknown(account?.type, ACCOUNT_TYPES),
    authMode: enumOrUnknown(authMode, AUTH_MODES),
    planType: enumOrUnknown(account?.planType ?? result.planType, PLAN_TYPES),
    identityPresent: typeof account?.email === 'string' && account.email.length > 0,
  };
}

function normalizeWindow(window) {
  if (!isRecord(window) || !Number.isInteger(window.usedPercent)) return null;
  return {
    available: true,
    usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
    windowDurationMins: Number.isSafeInteger(window.windowDurationMins) && window.windowDurationMins > 0 ? window.windowDurationMins : null,
    resetsAt: Number.isSafeInteger(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null,
  };
}

export function normalizeRateLimits(result) {
  if (!isRecord(result)) return unavailableRateLimits();
  let sourceBuckets;
  if (result.rateLimitsByLimitId !== undefined && result.rateLimitsByLimitId !== null) {
    if (!isRecord(result.rateLimitsByLimitId)) return unavailableRateLimits();
    sourceBuckets = result.rateLimitsByLimitId;
  } else if (result.rateLimits !== undefined) {
    if (!isRecord(result.rateLimits)) return unavailableRateLimits();
    sourceBuckets = { codex: result.rateLimits };
  } else {
    return unavailableRateLimits();
  }

  const buckets = [];
  for (const [id, bucket] of Object.entries(sourceBuckets)) {
    if (!isRecord(bucket)) continue;
    const primary = normalizeWindow(bucket.primary);
    const secondary = normalizeWindow(bucket.secondary);
    const reachedType = enumOrUnknown(bucket.rateLimitReachedType, RATE_LIMIT_REACHED_TYPES);
    if (!primary && !secondary && (reachedType === null || reachedType === 'other')
      && typeof bucket.spendControlReached !== 'boolean') continue;
    buckets.push({
      id: id === 'codex' ? id : 'other',
      reached: reachedType === 'other' || reachedType === null ? null : true,
      primary,
      secondary,
      spendControlReached: typeof bucket.spendControlReached === 'boolean' ? bucket.spendControlReached : null,
    });
  }
  if (buckets.length === 0) return unavailableRateLimits();
  return {
    available: true,
    ordinaryUsageAllowed: typeof result.ordinaryUsageAllowed === 'boolean' ? result.ordinaryUsageAllowed : null,
    buckets,
  };
}

function envEntry(source, name, platform) {
  if (platform !== 'win32') return Object.hasOwn(source, name) ? [name, source[name]] : null;
  const found = Object.keys(source).find((key) => key.toLowerCase() === name.toLowerCase());
  return found === undefined ? null : [found, source[found]];
}

export function safeCodexEnv(source = process.env, platform = process.platform) {
  const env = {};
  for (const allowedName of CHILD_ENV_ALLOWLIST) {
    const entry = envEntry(source, allowedName, platform);
    if (entry && entry[1] !== undefined) env[entry[0]] = entry[1];
  }
  return env;
}

export function presentOverrides(source = process.env, platform = process.platform) {
  return Object.fromEntries(AUTH_OVERRIDE_ENV.map((name) => {
    const entry = envEntry(source, name, platform);
    return [name, Boolean(entry?.[1])];
  }));
}

// Resolve without a shell. Windows accepts only executable images, not .cmd/.bat shims.
export function resolveBinary(name, source = process.env, platform = process.platform, io = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const pathEntry = envEntry(source, 'PATH', platform);
  const pathValue = pathEntry?.[1] ?? '';
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  const stat = io.statSync ?? statSync;
  const access = io.accessSync ?? accessSync;
  const candidates = platform === 'win32' ? [`${name}.exe`] : [name];
  for (const dir of String(pathValue).split(pathDelimiter)) {
    if (!dir || !pathApi.isAbsolute(dir)) continue;
    for (const file of candidates) {
      const full = pathApi.join(dir, file);
      try {
        if (!stat(full).isFile()) continue;
        if (platform !== 'win32') access(full, constants.X_OK);
        else if (extname(full).toLowerCase() !== '.exe') continue;
        return full;
      } catch { /* not executable here */ }
    }
  }
  return null;
}

function signalChild(child, signal) {
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  } catch { /* process may have exited while shutting down */ }
}

function childAlreadyClosed(child, closed) {
  return closed || child.exitCode !== null || child.signalCode !== null;
}

async function terminateChild(child, closed, graceMs, hardMs) {
  if (childAlreadyClosed(child, closed.value)) return;
  signalChild(child, 'SIGTERM');
  const closedAfterGrace = await waitForClose(child, closed, graceMs);
  if (closedAfterGrace) return;
  signalChild(child, 'SIGKILL');
  const closedAfterKill = await waitForClose(child, closed, hardMs);
  if (!closedAfterKill) {
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try { stream?.destroy(); } catch { /* stream may already be closed */ }
    }
    try { child.unref?.(); } catch { /* child may already be detached */ }
  }
}

function waitForClose(child, closed, timeoutMs) {
  if (childAlreadyClosed(child, closed.value)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (didClose) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('close', onClose);
      resolve(didClose);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('close', onClose);
    if (childAlreadyClosed(child, closed.value)) finish(true);
  });
}

function spawnCollected(file, args, {
  cwd,
  env,
  spawnImpl = spawn,
  timeoutMs = TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  shutdownGraceMs = SHUTDOWN_GRACE_MS,
  hardShutdownMs = HARD_SHUTDOWN_MS,
} = {}) {
  return new Promise((resolve) => {
    let child;
    let done = false;
    let closed = false;
    let bytes = 0;
    const stdout = [];
    let failure = null;
    let timeoutTimer;
    let escalationTimer;
    let hardTimer;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timeoutTimer);
      clearTimeout(escalationTimer);
      clearTimeout(hardTimer);
      if (child) {
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
        child.unref?.();
      }
      resolve(result);
    };
    const end = (code, signal) => {
      closed = true;
      if (failure) finish({ ok: false, failure, stdout: '' });
      else finish({ ok: code === 0 && signal == null, failure: code === 0 && signal == null ? null : 'exit', stdout: Buffer.concat(stdout).toString('utf8') });
    };
    const stop = (reason) => {
      if (done || failure !== null) return;
      failure = reason;
      if (!child) return finish({ ok: false, failure, stdout: '' });
      signalChild(child, 'SIGTERM');
      escalationTimer = setTimeout(() => signalChild(child, 'SIGKILL'), shutdownGraceMs);
      hardTimer = setTimeout(() => {
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          try { stream?.destroy(); } catch { /* stream may already be closed */ }
        }
        try { child.unref?.(); } catch { /* child may already be detached */ }
        finish({ ok: false, failure, stdout: '' });
      }, hardShutdownMs + shutdownGraceMs);
      if (childAlreadyClosed(child, closed)) end(child.exitCode, child.signalCode);
    };
    try {
      child = spawnImpl(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch {
      finish({ ok: false, failure: 'spawn', stdout: '' });
      return;
    }
    child.once('error', () => stop('spawn'));
    child.once('close', end);
    child.stdout?.on('data', (chunk) => {
      if (done || failure) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.byteLength;
      if (bytes > maxOutputBytes) return stop('output_limit');
      stdout.push(data);
    });
    child.stderr?.on('data', (chunk) => {
      if (done || failure) return;
      bytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk));
      if (bytes > maxOutputBytes) stop('output_limit');
    });
    timeoutTimer = setTimeout(() => stop('timeout'), timeoutMs);
    if (childAlreadyClosed(child, closed)) end(child.exitCode, child.signalCode);
  });
}

function rpcClient(child, {
  timeoutMs = TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let bytes = 0;
  let nextId = 0;
  let accountUpdate = null;
  let failure = null;
  const pending = new Map();
  const rejectPending = (reason) => {
    failure ??= reason;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    pending.clear();
  };
  const onOutput = (chunk) => {
    if (failure !== null) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.byteLength;
    if (bytes > maxOutputBytes) {
      rejectPending('output_limit');
      signalChild(child, 'SIGTERM');
      return;
    }
    buffer += decoder.write(data);
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!isRecord(message)) continue;
      if (message.method === 'account/updated') {
        const params = isRecord(message.params) ? message.params : {};
        accountUpdate = {
          authMode: enumOrUnknown(params.authMode, AUTH_MODES),
          planType: enumOrUnknown(params.planType, PLAN_TYPES),
        };
        continue;
      }
      if (!Number.isInteger(message.id) || !pending.has(message.id)) continue;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error('request_failed'));
      else waiter.resolve(message.result);
    }
  };
  child.stdout?.on('data', onOutput);
  child.stderr?.on('data', (chunk) => {
    if (failure !== null) return;
    bytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk));
    if (bytes > maxOutputBytes) {
      rejectPending('output_limit');
      signalChild(child, 'SIGTERM');
    }
  });
  child.stdin?.on('error', () => rejectPending('stdin_error'));
  child.once('error', () => rejectPending('spawn_error'));
  child.once('close', () => rejectPending('process_closed'));

  const write = (message) => new Promise((resolve, reject) => {
    if (failure) return reject(new Error(failure));
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          rejectPending('stdin_error');
          reject(new Error('stdin_error'));
        } else resolve();
      });
    } catch {
      rejectPending('stdin_error');
      reject(new Error('stdin_error'));
    }
  });
  return {
    async request(method, params = {}) {
      const id = ++nextId;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          rejectPending('timeout');
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
      });
      try {
        const writing = write({ method, id, params });
        const [, value] = await Promise.all([writing, response]);
        return value;
      } catch (error) {
        const waiter = pending.get(id);
        if (waiter) clearTimeout(waiter.timer);
        pending.delete(id);
        throw error;
      }
    },
    async notify(method, params = {}) { await write({ method, params }); },
    latestAccountUpdate() { return accountUpdate; },
    failed() { return failure !== null; },
  };
}

export async function readNativeAccount(binary, {
  env = safeCodexEnv(),
  cwd,
  spawnImpl = spawn,
  timeoutMs = TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  shutdownGraceMs = SHUTDOWN_GRACE_MS,
  hardShutdownMs = HARD_SHUTDOWN_MS,
} = {}) {
  let child;
  let closed = { value: false };
  let result = { readCompleted: false, account: unavailableAccount(), rateLimits: unavailableRateLimits() };
  try {
    child = spawnImpl(binary, ['app-server', '--stdio'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
  } catch {
    return result;
  }
  child.once('close', () => { closed.value = true; });
  const rpc = rpcClient(child, { timeoutMs, maxOutputBytes });
  try {
    if (childAlreadyClosed(child, closed.value)) throw new Error('app_server_exited');
    await rpc.request('initialize', {
      clientInfo: { name: 'career_stack_capability_probe', title: 'Career Stack capability probe', version: '0.9.0' },
    });
    await rpc.notify('initialized');
    const account = await rpc.request('account/read', { refreshToken: false });
    let rateLimits = null;
    try { rateLimits = await rpc.request('account/rateLimits/read'); } catch {
      if (rpc.failed()) throw new Error('app_server_unavailable');
      /* Rate-limit read may be unsupported; availability remains explicit. */
    }
    if (rpc.failed()) throw new Error('app_server_unavailable');
    const update = rpc.latestAccountUpdate();
    result = {
      readCompleted: true,
      account: normalizeAccount({
        ...account,
        authMode: update?.authMode ?? account?.authMode,
        planType: account?.account?.planType ?? update?.planType,
      }),
      rateLimits: normalizeRateLimits(rateLimits),
    };
  } catch {
    // Never surface provider messages, response bodies, stdout, or stderr.
  } finally {
    try { child.stdin.end(); } catch { /* EPIPE during shutdown is harmless */ }
    await terminateChild(child, closed, shutdownGraceMs, hardShutdownMs);
    // Closing our pipes also handles a reaped parent whose descendants kept them open.
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
    child.unref?.();
  }
  return result;
}

function hasOption(help, option) {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[ \\t]{1,8}${escaped}(?=[ \\t,=<[]|$)`, 'm').test(help ?? '');
}

export async function probe({
  binary,
  source = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  timeoutMs = TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  shutdownGraceMs = SHUTDOWN_GRACE_MS,
  hardShutdownMs = HARD_SHUTDOWN_MS,
  tempRoot = tmpdir(),
  fileIO = {},
} = {}) {
  const env = safeCodexEnv(source, platform);
  const file = binary ?? resolveBinary('codex', source, platform, fileIO);
  const result = {
    schemaVersion: PROBE_SCHEMA_VERSION,
    inference: false,
    binary: { found: Boolean(file), version: null },
    parentEnvAuthOverrides: presentOverrides(source, platform),
    help: {
      appServerReadable: false,
      execReadable: false,
      appServerStdio: false,
      execIgnoreUserConfig: false,
      execIgnoreRules: false,
      execEphemeral: false,
      execOutputSchema: false,
    },
    appServerAccountRead: { readCompleted: false, account: unavailableAccount(), rateLimits: unavailableRateLimits() },
    isolation: { appServerProven: false, execCandidateFlagsPresent: false, inferenceRequiredToProve: true },
  };
  if (!file) return result;

  let cwd;
  try { cwd = mkdtempSync(join(tempRoot, 'codex-probe-')); } catch { return result; }
  try {
    const run = (args) => spawnCollected(file, args, {
      cwd, env, spawnImpl, timeoutMs, maxOutputBytes, shutdownGraceMs, hardShutdownMs,
    });
    const version = await run(['--version']);
    result.binary.version = version.ok ? /^codex-cli (\d+\.\d+\.\d+)\s*$/m.exec(version.stdout)?.[1] ?? null : null;
    const appHelp = await run(['app-server', '--help']);
    const execHelp = await run(['exec', '--help']);
    result.help = {
      appServerReadable: appHelp.ok,
      execReadable: execHelp.ok,
      appServerStdio: hasOption(appHelp.stdout, '--stdio'),
      execIgnoreUserConfig: hasOption(execHelp.stdout, '--ignore-user-config'),
      execIgnoreRules: hasOption(execHelp.stdout, '--ignore-rules'),
      execEphemeral: hasOption(execHelp.stdout, '--ephemeral'),
      execOutputSchema: hasOption(execHelp.stdout, '--output-schema'),
    };
    if (version.ok && result.binary.version && result.help.appServerStdio) {
      result.appServerAccountRead = await readNativeAccount(file, {
        env, cwd, spawnImpl, timeoutMs, maxOutputBytes, shutdownGraceMs, hardShutdownMs,
      });
    }
    result.isolation.execCandidateFlagsPresent = result.help.execIgnoreUserConfig
      && result.help.execIgnoreRules && result.help.execEphemeral;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await probe();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.binary.found ? 0 : 2;
}
