import { AI_LIMITS, aiHashSchema, aiSourceSnapshotSchema, validateAiOutput, type AiErrorCode, type AiOutput, type AiSourceSnapshot } from '@career/domain';
import { buildAiPrompt } from './prompts.js';

export type OllamaModel = { name: string; size?: number; modifiedAt?: string };
export type OllamaResult = {
  output: AiOutput;
  inputContentHash: string; model: string; cliVersion: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  account: { accountFingerprint: string };
};

export function isOllamaCloudModel(value: string): boolean {
  return /(?:^|[:_-])cloud$/iu.test(value);
}

export class OllamaExecutionError extends Error {
  constructor(readonly code: AiErrorCode, readonly dispatched: 'NO' | 'UNKNOWN' | 'YES', readonly usage?: { inputTokens: number | null; outputTokens: number | null }) {
    super(code); this.name = 'OllamaExecutionError';
  }
}

export function validateOllamaBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('OLLAMA_URL_INVALID'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.port !== '11434' || (url.pathname !== '/' && url.pathname !== '')
    || url.username || url.password || url.search || url.hash) throw new Error('OLLAMA_URL_INVALID');
  return url.origin;
}

function validModelName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
    && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9._-]+)?$/u.test(value)
    && !isOllamaCloudModel(value);
}

async function boundedText(response: Response, maxBytes = 1_048_576): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(output);
}

async function requestJson(baseUrl: string, path: 'api/tags', fetcher: typeof fetch, signal?: AbortSignal): Promise<unknown> {
  const url = `${validateOllamaBaseUrl(baseUrl)}/${path}`;
  const timeout = AbortSignal.timeout(5_000);
  try {
    const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('OLLAMA_UNAVAILABLE');
    return JSON.parse(await boundedText(response));
  } catch { throw new Error('OLLAMA_UNAVAILABLE'); }
}

export async function listOllamaModels(baseUrl: string, dependencies: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<OllamaModel[]> {
  const response = await requestJson(baseUrl, 'api/tags', dependencies.fetch ?? fetch, dependencies.signal);
  if (!response || typeof response !== 'object' || !Array.isArray((response as { models?: unknown }).models)) throw new Error('OLLAMA_UNAVAILABLE');
  const models: OllamaModel[] = [];
  for (const item of (response as { models: unknown[] }).models) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (!validModelName(row.name)) continue;
    models.push({ name: row.name,
      ...(typeof row.size === 'number' && Number.isSafeInteger(row.size) && row.size >= 0 ? { size: row.size } : {}),
      ...(typeof row.modified_at === 'string' ? { modifiedAt: row.modified_at } : {}),
    });
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function executeOllama(
  input: AiSourceSnapshot, expectedAccountFingerprint: string, baseUrl: string, model: string,
  signal?: AbortSignal, dependencies: { fetch?: typeof fetch } = {},
): Promise<OllamaResult> {
  if (signal?.aborted) throw new OllamaExecutionError('CANCELLED', 'NO');
  if (!aiHashSchema.safeParse(expectedAccountFingerprint).success || !validModelName(model)) throw new OllamaExecutionError('NOT_CONNECTED', 'NO');
  let origin: string;
  try { origin = validateOllamaBaseUrl(baseUrl); } catch { throw new OllamaExecutionError('NOT_CONNECTED', 'NO'); }
  const parsed = aiSourceSnapshotSchema.safeParse(input);
  if (!parsed.success || !['JOB_ANALYSIS', 'SEARCH_DRAFT'].includes(parsed.data.operation)) throw new OllamaExecutionError('UNSUPPORTED_VERSION', 'NO');
  const source = parsed.data;
  let prompt;
  try { prompt = buildAiPrompt(source, { workspaceId: source.workspaceId, operation: source.operation, locale: source.locale }); }
  catch (error) { throw new OllamaExecutionError(error instanceof Error && error.message === 'AI_INPUT_TOO_LARGE' ? 'INPUT_TOO_LARGE' : 'INVALID_OUTPUT', 'NO'); }
  const fetcher = dependencies.fetch ?? fetch;
  const timeout = AbortSignal.timeout(AI_LIMITS.timeoutMs);
  let dispatched: 'UNKNOWN' | 'YES' = 'UNKNOWN';
  let usage: { inputTokens: number | null; outputTokens: number | null } | undefined;
  try {
    const response = await fetcher(`${origin}/api/chat`, {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ model, stream: false, format: prompt.outputSchema, messages: [
        { role: 'system', content: prompt.messages[0].content }, { role: 'user', content: prompt.messages[1].content },
      ], options: { temperature: 0.1 } }),
    });
    dispatched = 'YES';
    if (!response.ok) throw new OllamaExecutionError('PROVIDER_ERROR', 'YES');
    let result: unknown;
    try { result = JSON.parse(await boundedText(response)); } catch { throw new OllamaExecutionError('INVALID_OUTPUT', 'YES'); }
    if (!result || typeof result !== 'object') throw new OllamaExecutionError('INVALID_OUTPUT', 'YES');
    const record = result as Record<string, unknown>;
    const message = record.message && typeof record.message === 'object' ? record.message as Record<string, unknown> : null;
    usage = { inputTokens: count(record.prompt_eval_count), outputTokens: count(record.eval_count) };
    if (record.done !== true || record.model !== model || !message || typeof message.content !== 'string') throw new OllamaExecutionError('INVALID_OUTPUT', 'YES', usage);
    let output: unknown;
    try { output = JSON.parse(message.content); } catch { throw new OllamaExecutionError('INVALID_OUTPUT', 'YES', usage); }
    const validated = validateAiOutput(output, source, { workspaceId: source.workspaceId, operation: source.operation, locale: source.locale });
    if (!validated.ok) throw new OllamaExecutionError('INVALID_OUTPUT', 'YES', usage);
    if (signal?.aborted) throw new OllamaExecutionError('CANCELLED', 'YES', usage);
    return { output: validated.output, inputContentHash: prompt.inputContentHash, model, cliVersion: 'ollama-api', usage, account: { accountFingerprint: expectedAccountFingerprint } };
  } catch (error) {
    if (error instanceof OllamaExecutionError) throw error;
    throw new OllamaExecutionError(signal?.aborted ? 'CANCELLED' : timeout.aborted ? 'TIMEOUT' : 'PROVIDER_ERROR', dispatched, usage);
  }
}
