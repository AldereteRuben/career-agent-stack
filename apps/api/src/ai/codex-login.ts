import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCodexExecutable, initializeCodexRpc, CODEX_PROTOCOL_VERSION } from './codex-account.js';
import { runAiProcess } from './process.js';
import { isAiRecord, withAiRpcProcess, type AiRpcClient } from './rpc.js';

export type CodexLoginState = 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
export type CodexLoginView = { id: string; state: CodexLoginState; expiresAt: string; url?: string };
type Attempt = { workspaceId: string; view: CodexLoginView; controller: AbortController; stop: (() => Promise<void>) | null; done: Promise<void> };
export class CodexLoginError extends Error {
  constructor(readonly code: 'LOGIN_BUSY' | 'LOGIN_UNAVAILABLE' | 'LOGIN_NOT_FOUND') { super(code); this.name = 'CodexLoginError'; }
}

export function permittedCodexLoginUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port || url.hash) return null;
    return url.href;
  } catch { return null; }
}
const view = (attempt: Attempt): CodexLoginView => {
  const result = { ...attempt.view };
  if (result.state !== 'WAITING') delete result.url;
  return result;
};
type Dependencies = { resolveBinary: typeof findCodexExecutable; run: typeof runAiProcess; rpc: typeof withAiRpcProcess; now: () => number };

/** Login remains in memory, is workspace-scoped and never logs the authorization URL or calls account/logout. */
export function createCodexLoginManager(dependencies: Partial<Dependencies> = {}) {
  const attempts = new Map<string, Attempt>();
  const now = dependencies.now ?? Date.now;
  const prune = () => {
    for (const [id, attempt] of attempts) if (attempt.view.state !== 'WAITING' && now() - Date.parse(attempt.view.expiresAt) > 300_000) attempts.delete(id);
  };
  const get = (workspaceId: string, id: string) => {
    const attempt = attempts.get(id);
    if (!attempt || attempt.workspaceId !== workspaceId) throw new CodexLoginError('LOGIN_NOT_FOUND');
    if (attempt.view.state === 'WAITING' && Date.parse(attempt.view.expiresAt) <= now()) { attempt.view.state = 'EXPIRED'; attempt.controller.abort(); }
    return attempt;
  };
  return {
    async start(workspaceId: string): Promise<CodexLoginView> {
      prune();
      for (const pending of attempts.values()) {
        if (pending.view.state === 'WAITING') {
          if (pending.workspaceId === workspaceId) return view(pending);
          throw new CodexLoginError('LOGIN_BUSY');
        }
      }
      if (attempts.size >= 20) throw new CodexLoginError('LOGIN_BUSY');
      // Reserve synchronously before any await, including binary discovery, so concurrent starts cannot race.
      const id = randomUUID();
      const attempt: Attempt = { workspaceId, view: { id, state: 'WAITING', expiresAt: new Date(now() + 300_000).toISOString() }, controller: new AbortController(), stop: null, done: Promise.resolve() };
      attempts.set(id, attempt);
      let accept!: (value: CodexLoginView) => void; let reject!: (error: CodexLoginError) => void;
      const started = new Promise<CodexLoginView>((resolve, fail) => { accept = resolve; reject = fail; });
      attempt.done = (async () => {
        const executable = await (dependencies.resolveBinary ?? findCodexExecutable)();
        if (!executable) throw new CodexLoginError('LOGIN_UNAVAILABLE');
        const directory = await mkdtemp(join(tmpdir(), 'career-codex-login-'));
        try {
          const common = { executable, cwd: directory, signal: attempt.controller.signal, maxOutputBytes: 1024 * 1024 };
          const version = await (dependencies.run ?? runAiProcess)({ ...common, args: ['--version'], timeoutMs: 15_000 });
          if (version.stdout.trim() !== `codex-cli ${CODEX_PROTOCOL_VERSION}`) throw new CodexLoginError('LOGIN_UNAVAILABLE');
          await (dependencies.rpc ?? withAiRpcProcess)({ ...common, args: ['--no-daemon', 'app-server', '--stdio'], timeoutMs: 300_000 }, async (rpc: AiRpcClient) => {
            await initializeCodexRpc(rpc);
            let loginId: string | null = null;
            const early: Record<string, unknown>[] = [];
            let finish!: (success: boolean) => void;
            const finished = new Promise<boolean>(resolve => { finish = resolve; });
            const receive = (params: Record<string, unknown>) => {
              if (!loginId) { if (early.length >= 4) throw new CodexLoginError('LOGIN_UNAVAILABLE'); early.push(params); return; }
              if (params.loginId === loginId) finish(params.success === true);
            };
            const unsubscribe = rpc.onNotification((method, params) => { if (method === 'account/login/completed') receive(params); });
            const abort = () => finish(false);
            rpc.signal.addEventListener('abort', abort, { once: true });
            try {
              const response = await rpc.request('account/login/start', { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'codex' });
              if (!isAiRecord(response) || response.type !== 'chatgpt' || typeof response.loginId !== 'string' || !/^[A-Za-z0-9-]{1,200}$/.test(response.loginId)) throw new CodexLoginError('LOGIN_UNAVAILABLE');
              const url = permittedCodexLoginUrl(response.authUrl);
              if (!url) throw new CodexLoginError('LOGIN_UNAVAILABLE');
              loginId = response.loginId;
              attempt.stop = async () => { await rpc.request('account/login/cancel', { loginId }); finish(false); };
              if (attempt.view.state !== 'WAITING' || attempt.controller.signal.aborted) { await attempt.stop(); return; }
              attempt.view.url = url;
              accept(view(attempt));
              early.forEach(receive);
              const success = await finished;
              if (attempt.view.state === 'WAITING') attempt.view.state = Date.parse(attempt.view.expiresAt) <= now() ? 'EXPIRED' : success ? 'COMPLETED' : 'FAILED';
            } finally { unsubscribe(); rpc.signal.removeEventListener('abort', abort); attempt.stop = null; }
          });
        } finally { await rm(directory, { recursive: true, force: true }); }
      })().catch(() => {
        if (attempt.view.state === 'WAITING') attempt.view.state = now() >= Date.parse(attempt.view.expiresAt) ? 'EXPIRED' : 'FAILED';
        reject(new CodexLoginError('LOGIN_UNAVAILABLE'));
      }).finally(() => { delete attempt.view.url; });
      return started;
    },
    read(workspaceId: string, id: string): CodexLoginView { return view(get(workspaceId, id)); },
    async cancel(workspaceId: string, id: string): Promise<CodexLoginView> {
      const attempt = get(workspaceId, id);
      if (attempt.view.state === 'WAITING') {
        attempt.view.state = 'CANCELLED';
        try { await attempt.stop?.(); } catch { /* termination still fences the callback */ }
        attempt.controller.abort(); await attempt.done;
      }
      return view(attempt);
    },
    async close(): Promise<void> {
      for (const attempt of attempts.values()) { if (attempt.view.state === 'WAITING') attempt.view.state = 'CANCELLED'; attempt.controller.abort(); }
      await Promise.all([...attempts.values()].map(attempt => attempt.done)); attempts.clear();
    },
  };
}
