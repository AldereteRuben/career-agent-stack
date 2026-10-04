import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AI_LIMITS, aiHashSchema, aiSourceSnapshotSchema, validateAiOutput,
  type AiErrorCode, type AiOutput, type AiSourceSnapshot,
} from '@career/domain';
import { CODEX_PROTOCOL_VERSION, findCodexExecutable, inspectCodexAccount, type CodexAccountObservation } from './codex-account.js';
import { AiProcessError, aiProcessEnvironment, runAiProcess } from './process.js';
import { AiPromptError, buildAiPrompt } from './prompts.js';

/** Bundled official 0.160.0 model catalogue: priority 1. No model or billing fallback. */
export const CODEX_DEFAULT_MODEL = 'gpt-6.1-sol' as const;
export const CODEX_MODELS = [CODEX_DEFAULT_MODEL] as const;
export type CodexModel = (typeof CODEX_MODELS)[number];

export class CodexExecutionError extends Error {
  constructor(readonly code: AiErrorCode, readonly dispatched: 'NO' | 'UNKNOWN' | 'YES', readonly invalidateConnection = false,
    readonly usage: CodexTokenUsage | null = null) {
    super(code); this.name = 'CodexExecutionError';
  }
}
export type CodexTokenUsage = { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null };
export type CodexExecutionResult = {
  output: AiOutput; inputContentHash: string; model: CodexModel; cliVersion: string;
  usage: CodexTokenUsage; account: CodexAccountObservation;
};
/** Dependencies are internal test seams, never populated from HTTP input. */
export type CodexDependencies = {
  run: typeof runAiProcess;
  inspect: typeof inspectCodexAccount;
  resolveBinary: typeof findCodexExecutable;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
};

const disabledFeatures = [
  'apps', 'hooks', 'plugins', 'memories', 'multi_agent', 'multi_agent_v2', 'shell_tool', 'unified_exec',
  'code_mode_host', 'code_mode', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation',
  'view_image', 'skill_search', 'skill_mcp_dependency_install', 'shell_snapshot', 'tool_suggest', 'goals',
  'sleep_tool', 'workspace_dependencies', 'in_app_browser', 'in_app_chat', 'in_app_local_automation',
  'daemon_auto_start', 'remote_plugin', 'unbounded_connection_retries', 'system_proxy_fallback',
] as const;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const emptyUsage = (): CodexTokenUsage => ({ inputTokens: null, cachedInputTokens: null, outputTokens: null });
const token = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
// Emitted by pinned 0.160.0 because this adapter intentionally disables its code-mode execution host.
const isolationNotice = 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';

/** No copied credentials, API keys, provider endpoints or inherited debug/proxy configuration. */
function inferenceEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = aiProcessEnvironment(source);
  for (const key of Object.keys(environment)) {
    if (['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase())) delete environment[key];
  }
  return environment;
}

function checkAccount(account: CodexAccountObservation, fingerprint: string, dispatched: 'NO' | 'YES'): void {
  if (account.status === 'UNSUPPORTED' || (account.version !== null && account.version !== CODEX_PROTOCOL_VERSION)) throw new CodexExecutionError('UNSUPPORTED_VERSION', dispatched);
  if (account.status !== 'SIGNED_IN' || account.billing !== 'CHATGPT_PLAN' || !account.accountFingerprint) {
    const authoritative = account.status === 'SIGNED_OUT' || account.status === 'SIGNED_IN' && account.billing === 'SEPARATE_API';
    throw new CodexExecutionError('NOT_CONNECTED', dispatched, authoritative);
  }
  if (account.version !== CODEX_PROTOCOL_VERSION) throw new CodexExecutionError('UNSUPPORTED_VERSION', dispatched);
  if (account.accountFingerprint !== fingerprint) throw new CodexExecutionError('ACCOUNT_CHANGED', dispatched, true);
  if (dispatched === 'NO' && account.usage.availability === 'KNOWN' && account.usage.windows.some(window => window.limitReached === true)) {
    throw new CodexExecutionError('PROVIDER_LIMIT_REACHED', 'NO');
  }
}

/** Closed JSONL protocol. The one fixed pre-turn isolation notice is allowed; other errors/tools never become drafts. */
export function createCodexOutputParser(): { onLine: (line: string) => void; finish: () => { raw: unknown; usage: CodexTokenUsage }; hasStarted: () => boolean } {
  let started = false; let thread = false; let completed = false; let text: string | null = null;
  let isolationNoticeSeen = false;
  let usage = emptyUsage();
  const fail = (): never => { throw new CodexExecutionError('INVALID_OUTPUT', started ? 'YES' : 'UNKNOWN'); };
  return {
    hasStarted: () => started,
    onLine: (line) => {
      if (!line.trim()) return;
      let event: unknown;
      try { event = JSON.parse(line); } catch { return fail(); }
      if (!record(event) || typeof event.type !== 'string' || completed) return fail();
      if (event.type === 'thread.started') {
        if (thread || started || typeof event.thread_id !== 'string' || !event.thread_id) return fail();
        thread = true; return;
      }
      if (event.type === 'turn.started') {
        if (!thread || started) return fail();
        started = true; return;
      }
      if (event.type === 'item.completed') {
        if (thread && !started && !isolationNoticeSeen && record(event.item) && event.item.type === 'error' && event.item.message === isolationNotice) {
          isolationNoticeSeen = true; return;
        }
        if (!started || text !== null || !record(event.item) || event.item.type !== 'agent_message'
          || typeof event.item.text !== 'string' || !event.item.text.trim()
          || (event.item.phase !== undefined && event.item.phase !== 'final_answer')) return fail();
        text = event.item.text; return;
      }
      if (event.type === 'turn.completed') {
        if (!started || text === null) return fail();
        if (event.usage !== undefined) {
          if (!record(event.usage)) return fail();
          usage = { inputTokens: token(event.usage.input_tokens), cachedInputTokens: token(event.usage.cached_input_tokens), outputTokens: token(event.usage.output_tokens) };
        }
        completed = true; return;
      }
      return fail();
    },
    finish: () => {
      if (!completed || text === null) return fail();
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { return fail(); }
      if (!record(raw)) return fail();
      return { raw, usage };
    },
  };
}

/**
 * One explicit, authorized task. Callers own consent, queue leases and current source checks before dispatch and before
 * saving a result. This function never grants consent, adopts a draft, changes a profile or retries a dispatched task.
 * The installed CLI is pinned; native isolation has been demonstrated on macOS only. Other OSes stay unavailable.
 */
export async function executeCodex(
  input: AiSourceSnapshot,
  expectedAccountFingerprint: string,
  identitySalt: string,
  signal?: AbortSignal,
  model: CodexModel = CODEX_DEFAULT_MODEL,
  dependencies: Partial<CodexDependencies> = {},
): Promise<CodexExecutionResult> {
  if (signal?.aborted) throw new CodexExecutionError('CANCELLED', 'NO');
  if ((dependencies.platform ?? process.platform) !== 'darwin' || !CODEX_MODELS.includes(model)) throw new CodexExecutionError('UNSUPPORTED_VERSION', 'NO');
  if (!aiHashSchema.safeParse(expectedAccountFingerprint).success || identitySalt.length < 32) throw new CodexExecutionError('NOT_CONNECTED', 'NO');
  const snapshot = aiSourceSnapshotSchema.safeParse(input);
  if (!snapshot.success) throw new CodexExecutionError('INVALID_OUTPUT', 'NO');
  // Zod returns a new object. Mutation of a caller's object while account inspection awaits cannot alter this task.
  const source = snapshot.data;
  const scope = { workspaceId: source.workspaceId, operation: source.operation, locale: source.locale };
  let prompt;
  try { prompt = buildAiPrompt(source, scope); }
  catch (error) { throw new CodexExecutionError(error instanceof AiPromptError && error.code === 'AI_INPUT_TOO_LARGE' ? 'INPUT_TOO_LARGE' : 'INVALID_OUTPUT', 'NO'); }
  const inspect = dependencies.inspect ?? inspectCodexAccount;
  const environment = inferenceEnvironment(dependencies.environment ?? process.env);
  let executable: string | null;
  try { executable = await (dependencies.resolveBinary ?? findCodexExecutable)(environment); }
  catch { throw new CodexExecutionError('NOT_CONNECTED', 'NO'); }
  if (!executable) throw new CodexExecutionError('NOT_CONNECTED', 'NO');
  const accountDependencies = {
    resolveBinary: async () => executable,
    run: (options: Parameters<typeof runAiProcess>[0]) => runAiProcess({ ...options, environment }),
  };
  let before: CodexAccountObservation;
  try { before = await inspect(identitySalt, signal, accountDependencies); }
  catch { throw new CodexExecutionError(signal?.aborted ? 'CANCELLED' : 'NOT_CONNECTED', 'NO'); }
  if (signal?.aborted) throw new CodexExecutionError('CANCELLED', 'NO');
  checkAccount(before, expectedAccountFingerprint, 'NO');
  if (signal?.aborted) throw new CodexExecutionError('CANCELLED', 'NO');
  let directory: string;
  try { directory = await mkdtemp(path.join(tmpdir(), 'career-codex-task-')); }
  catch { throw new CodexExecutionError('INTERNAL', 'NO'); }
  let invoked = false;
  const parser = createCodexOutputParser();
  let result: CodexExecutionResult | null = null;
  let failure: CodexExecutionError | null = null;
  let observedUsage: CodexTokenUsage | null = null;
  try {
    const instructions = path.join(directory, 'instructions.txt');
    const schema = path.join(directory, 'schema.json');
    await writeFile(instructions, prompt.messages[0].content, { mode: 0o600, flag: 'wx' });
    await writeFile(schema, JSON.stringify(prompt.outputSchema), { mode: 0o600, flag: 'wx' });
    const config: Record<string, string> = {
      model_provider: '"openai"', forced_login_method: '"chatgpt"', model: JSON.stringify(model),
      model_reasoning_effort: '"low"', model_reasoning_summary: '"none"', model_instructions_file: JSON.stringify(instructions),
      project_doc_max_bytes: '0', developer_instructions: '""', web_search: '"disabled"',
      'memories.generate_memories': 'false', 'memories.use_memories': 'false',
      'skills.include_instructions': 'false', 'cloud.skills.enabled': 'false',
      'tools.experimental_request_user_input.enabled': 'false', 'tools.update_plan.enabled': 'false',
      'analytics.enabled': 'false', log_dir: JSON.stringify(directory), sqlite_home: JSON.stringify(directory),
      'history.persistence': '"none"', suppress_unstable_features_warning: 'true',
    };
    const args = ['--no-daemon', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--strict-config',
      '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never', '--output-schema', schema];
    for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${value}`);
    for (const feature of disabledFeatures) args.push('--disable', feature);
    args.push('-');
    // These flags select ChatGPT authentication only. The subprocess receives no API key or endpoint override.
    invoked = true;
    await (dependencies.run ?? runAiProcess)({ executable, args, cwd: directory, input: prompt.messages[1].content,
      environment, ...(signal ? { signal } : {}), onLine: parser.onLine,
      timeoutMs: AI_LIMITS.timeoutMs, killGraceMs: AI_LIMITS.killGraceMs, maxOutputBytes: AI_LIMITS.outputBytes,
    });
    const parsed = parser.finish();
    observedUsage = parsed.usage;
    if (signal?.aborted) throw new CodexExecutionError('CANCELLED', 'YES');
    let after: CodexAccountObservation;
    try { after = await inspect(identitySalt, signal, accountDependencies); }
    catch { throw new CodexExecutionError(signal?.aborted ? 'CANCELLED' : 'NOT_CONNECTED', 'YES'); }
    if (signal?.aborted) throw new CodexExecutionError('CANCELLED', 'YES');
    checkAccount(after, expectedAccountFingerprint, 'YES');
    const validated = validateAiOutput(parsed.raw, source, scope);
    if (!validated.ok) throw new CodexExecutionError('INVALID_OUTPUT', 'YES');
    if (signal?.aborted) throw new CodexExecutionError('CANCELLED', 'YES');
    result = { output: validated.output, inputContentHash: prompt.inputContentHash, model, cliVersion: CODEX_PROTOCOL_VERSION, usage: parsed.usage, account: after };
  } catch (error) {
    const dispatched = !invoked ? 'NO' : parser.hasStarted() ? 'YES' : 'UNKNOWN';
    if (error instanceof CodexExecutionError) failure = error;
    else if (error instanceof AiProcessError) {
      const code: AiErrorCode = error.code === 'AI_CANCELLED' ? 'CANCELLED' : error.code === 'AI_TIMEOUT' ? 'TIMEOUT'
        : error.code === 'AI_INVALID_OUTPUT' || error.code === 'AI_OUTPUT_TOO_LARGE' ? 'INVALID_OUTPUT'
          : error.code === 'AI_EXECUTABLE_UNAVAILABLE' ? 'NOT_CONNECTED' : 'PROVIDER_ERROR';
      failure = new CodexExecutionError(code, dispatched);
    } else failure = new CodexExecutionError('PROVIDER_ERROR', dispatched);
  } finally {
    try { await rm(directory, { recursive: true, force: true }); }
    catch { failure ??= new CodexExecutionError('INTERNAL', invoked ? parser.hasStarted() ? 'YES' : 'UNKNOWN' : 'NO'); }
  }
  if (failure) throw new CodexExecutionError(failure.code, failure.dispatched, failure.invalidateConnection, observedUsage);
  if (!result) throw new CodexExecutionError('INTERNAL', invoked ? 'UNKNOWN' : 'NO');
  return result;
}
