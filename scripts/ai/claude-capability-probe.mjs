// Read-only Claude Code capability probe for v0.9.0 T00 (node scripts/ai/claude-capability-probe.mjs).
// Runs only `--version`, `--help`, `auth status --help` and `auth status --json`: no prompt, no inference, no login,
// no settings change. Auth status output is parsed in memory; only enum values and booleans are printed, never email,
// organization, identifiers or directories. Capabilities come from what the installed binary prints, not from guesses.
import { execFile } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

export const PROBE_SCHEMA_VERSION = 1;
const TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 1024 * 1024;

// Documented `authMethod` values (CLI reference, `claude auth status`). Anything else is reported as `unknown`.
const AUTH_METHODS = new Set(['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party']);
// `authMethod` values that bill a Claude subscription rather than API usage or a cloud provider.
const SUBSCRIPTION_METHODS = new Set(['claude.ai', 'oauth_token']);
const SUBSCRIPTION_TIERS = new Set(['free', 'pro', 'max', 'team', 'enterprise']);

// Flags the adapter relies on, looked up literally in `claude --help`.
const HELP_FLAGS = {
  print: '--print',
  outputFormat: '--output-format',
  jsonSchema: '--json-schema',
  inputFormat: '--input-format',
  safeMode: '--safe-mode',
  restricted: '--restricted',
  bare: '--bare',
  tools: '--tools',
  allowedTools: '--allowedTools',
  disallowedTools: '--disallowedTools',
  strictMcpConfig: '--strict-mcp-config',
  mcpConfig: '--mcp-config',
  settingSources: '--setting-sources',
  settings: '--settings',
  noSessionPersistence: '--no-session-persistence',
  permissionMode: '--permission-mode',
  permissionPrompts: '--permission-prompts',
  disableSlashCommands: '--disable-slash-commands',
  systemPrompt: '--system-prompt',
  model: '--model',
  maxBudgetUsd: '--max-budget-usd',
};

// Variables that change which account or billing route a run uses. Only their presence is reported.
export const AUTH_OVERRIDE_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CONFIG_DIR',
];

// Environment passed to the binary: what it needs to locate the official login, nothing that redirects auth.
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR',
  'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec',
];

export function sanitizedEnv(source = process.env) {
  const env = {};
  const allowed = new Set(ENV_ALLOWLIST.map(name => name.toUpperCase()));
  for (const [name, value] of Object.entries(source)) if (value !== undefined && allowed.has(name.toUpperCase())) env[name] = value;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.DISABLE_AUTOUPDATER = '1';
  env.NO_COLOR = '1';
  return env;
}

export function presentOverrides(source = process.env, platform = process.platform) {
  return Object.fromEntries(AUTH_OVERRIDE_ENV.map((name) => {
    const key = platform === 'win32' ? Object.keys(source).find(key => key.toUpperCase() === name) : name;
    return [name, Boolean(key && source[key])];
  }));
}

// Resolve an executable from PATH without a shell. On Windows only `.exe` is accepted: `.cmd`/`.bat` need a shell.
export function resolveBinary(name, env = process.env, platform = process.platform) {
  const candidates = platform === 'win32' ? [`${name}.exe`] : [name];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const file of candidates) {
      const full = join(dir, file);
      try {
        if (!statSync(full).isFile()) continue;
        if (platform !== 'win32') accessSync(full, constants.X_OK);
        else if (extname(full).toLowerCase() !== '.exe') continue;
        return full;
      } catch { /* not here */ }
    }
  }
  return null;
}

export function parseVersion(text) {
  const match = /^(\d+\.\d+\.\d+)\s+\(Claude Code\)\s*$/m.exec(text ?? '');
  return match ? match[1] : null;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// An option counts only where it is defined (start of an option line, possibly after a short form or alias),
// not where another option's description mentions it.
const definition = (flag) => new RegExp(`^[ \\t]{1,4}(?:-\\w, )?(?:--[\\w-]+, )?${escape(flag)}(?=[\\s,=<\\[]|$)`, 'm');
const OPTION_LINE = /^[ \t]{1,4}-/m;

export function helpHasFlag(help, flag) {
  return definition(flag).test(help ?? '');
}

// The option's definition plus its wrapped description, with whitespace collapsed.
export function optionText(help, flag) {
  const match = definition(flag).exec(help ?? '');
  if (!match) return '';
  const rest = help.slice(match.index + match[0].length);
  const next = rest.search(OPTION_LINE);
  return (match[0] + (next < 0 ? rest : rest.slice(0, next))).replace(/\s+/g, ' ').trim();
}

export function parseHelpFlags(help) {
  return Object.fromEntries(Object.entries(HELP_FLAGS).map(([key, flag]) => [key, helpHasFlag(help, flag)]));
}

export function parseChoices(help, flag) {
  const match = /\(choices: ([^)]*?)(?:, default: [^)]*)?\)/.exec(optionText(help, flag));
  return match ? [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
}

// Reduce `claude auth status --json` to non-secret fields. Email, organization and paths are dropped here.
export function normalizeAuthStatus(stdout, exitCode) {
  let raw;
  try { raw = JSON.parse(stdout); } catch { return { parsed: false, exitCode }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.loggedIn !== 'boolean' || typeof raw.authMethod !== 'string') return { parsed: false, exitCode };
  const method = AUTH_METHODS.has(raw.authMethod) ? raw.authMethod : 'unknown';
  const tier = typeof raw.subscriptionType === 'string' && SUBSCRIPTION_TIERS.has(raw.subscriptionType) ? raw.subscriptionType : null;
  return {
    parsed: true,
    exitCode,
    loggedIn: raw.loggedIn === true && exitCode === 0,
    method,
    firstPartyProvider: raw.apiProvider === 'firstParty',
    subscriptionBilling: SUBSCRIPTION_METHODS.has(method),
    separateApiBilling: method === 'api_key' || method === 'api_key_helper',
    cloudProvider: method === 'third_party',
    subscriptionTier: tier,
    identityPresent: typeof raw.email === 'string' && raw.email.length > 0,
    organizationPresent: typeof raw.orgId === 'string' && raw.orgId.length > 0,
  };
}

/** Internal diagnostic transport. Raw stdout is normalized by probe(), never exposed by a product route. */
export function runClaudeProbeCommand(file, args, { cwd, env, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolveRun) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) {
      resolveRun({ exitCode: null, timedOut: false, stdout: '' });
      return;
    }
    let child;
    let settled = false;
    let deadline;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolveRun(result);
    };
    try {
      child = execFile(file, args, { cwd, env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, windowsHide: true, shell: false }, (error, stdout) => {
        const exitCode = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        finish({ exitCode, timedOut: Boolean(error?.killed) && error?.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: error ? '' : String(stdout ?? '') });
      });
      // A descendant can keep inherited pipes open after the parent exits. Bound the diagnostic itself too.
      deadline = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
        finish({ exitCode: null, timedOut: true, stdout: '' });
      }, timeoutMs + 1000);
    } catch {
      finish({ exitCode: null, timedOut: false, stdout: '' });
    }
  });
}

export async function probe({ binary, source = process.env } = {}) {
  const env = sanitizedEnv(source);
  const file = binary ?? resolveBinary('claude', source);
  const result = { schemaVersion: PROBE_SCHEMA_VERSION, inference: false, binary: { found: Boolean(file), version: null }, parentEnvOverrides: presentOverrides(source) };
  if (!file) return result;

  // Empty working directory: no project settings, .mcp.json or CLAUDE.md can be discovered from the caller's folder.
  const cwd = mkdtempSync(join(tmpdir(), 'claude-probe-'));
  try {
    const opts = { cwd, env };
    const version = await runClaudeProbeCommand(file, ['--version'], opts);
    result.binary.version = parseVersion(version.stdout);
    const help = await runClaudeProbeCommand(file, ['--help'], opts);
    result.helpReadable = help.exitCode === 0;
    result.flags = parseHelpFlags(help.stdout);
    // Bare mode is unusable with a subscription login when the binary's own help says it never reads OAuth.
    result.bareExcludesOAuth = result.flags.bare ? /OAuth and keychain are never read/.test(optionText(help.stdout, '--bare')) : null;
    result.choices = {
      outputFormat: parseChoices(help.stdout, '--output-format'),
      permissionMode: parseChoices(help.stdout, '--permission-mode'),
      permissionPrompts: parseChoices(help.stdout, '--permission-prompts'),
    };
    const authHelp = await runClaudeProbeCommand(file, ['auth', 'status', '--help'], opts);
    result.authStatusJsonFlag = authHelp.exitCode === 0 && helpHasFlag(authHelp.stdout, '--json');
    const status = result.authStatusJsonFlag ? await runClaudeProbeCommand(file, ['auth', 'status', '--json'], opts) : null;
    result.auth = status ? { ...normalizeAuthStatus(status.stdout, status.exitCode), timedOut: status.timedOut } : { parsed: false };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  const f = result.flags;
  // Derived only from flags present in this binary's help; a real isolated run must still confirm the behaviour.
  result.derived = {
    structuredOutputFlags: f.print && f.outputFormat && f.jsonSchema && result.choices.outputFormat.includes('json'),
    customizationIsolationFlags: f.safeMode && f.strictMcpConfig && f.tools && f.disallowedTools && f.settings,
    noTranscriptFlag: f.noSessionPersistence,
    unattendedDenyFlag: f.permissionPrompts && result.choices.permissionPrompts.includes('none'),
  };
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await probe();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.binary.found ? 0 : 2;
}
