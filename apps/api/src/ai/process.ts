import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { finished } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export type AiProcessErrorCode = 'AI_EXECUTABLE_UNAVAILABLE' | 'AI_PROCESS_FAILED' | 'AI_CANCELLED' | 'AI_TIMEOUT' | 'AI_OUTPUT_TOO_LARGE' | 'AI_INVALID_OUTPUT';

/** Provider stderr can contain private data. Only these codes may leave the runner. */
export class AiProcessError extends Error {
  constructor(readonly code: AiProcessErrorCode) { super(code); this.name = 'AiProcessError'; }
}

const environmentKeys = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'PATHEXT',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
]);

/** Preserve the user's actual official auth location; never copy credentials into our own storage. */
export function aiProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && environmentKeys.has(key.toUpperCase())) result[key] = value;
  }
  result.NO_COLOR = '1';
  return result;
}

export type AiProcessOptions = {
  executable: string;
  args: readonly string[];
  cwd: string;
  input?: string;
  /** Internal duplex protocol. Its completion closes stdin; private messages never enter argv. */
  interact?: (channel: AiProcessChannel) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Wait between SIGTERM and SIGKILL, and the longest wait for output pipes once the process has exited. */
  killGraceMs?: number;
  maxOutputBytes?: number;
  /** Called for complete stdout lines only. Throw to reject the provider protocol. */
  onLine?: (line: string) => void;
  /** Internal dependency for isolated tests; never accept this object over HTTP. */
  environment?: NodeJS.ProcessEnv;
};

export type AiProcessChannel = { write: (message: string) => Promise<void>; signal: AbortSignal };

export type AiProcessResult = { stdout: string; exitCode: 0 };

/**
 * POSIX: the child is started detached, so it leads its own process group and the negative PID reaches only that
 * group. Windows: taskkill /T follows the parent-PID tree of a process that is still running; descendants that
 * outlive their parent are not reachable this way (a Job Object would be needed) and are not claimed to be cleaned.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals, environment: NodeJS.ProcessEnv): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const root = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.windir ?? environment.WINDIR;
    if (!root || !isAbsolute(root)) { child.kill(signal); return; }
    // taskkill is an OS utility at a fixed path, never a shell command assembled from user data.
    try {
      const killer = spawn(join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore', env: environment,
      });
      killer.on('error', () => { child.kill(signal); });
      killer.unref();
    } catch { child.kill(signal); }
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
  }
}

/** Executes one trusted local program. No shell, inherited API keys, raw stderr or unbounded output. */
export function runAiProcess(options: AiProcessOptions): Promise<AiProcessResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const killGraceMs = options.killGraceMs ?? 5_000;
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  if (!isAbsolute(options.executable) || !isAbsolute(options.cwd)
      || (options.input !== undefined && options.interact !== undefined)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
      || !Number.isSafeInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > 5_000
      || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1_048_576) {
    return Promise.reject(new AiProcessError('AI_PROCESS_FAILED'));
  }
  if (options.signal?.aborted) return Promise.reject(new AiProcessError('AI_CANCELLED'));
  const environment = aiProcessEnvironment(options.environment ?? process.env);

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.executable, [...options.args], {
        cwd: options.cwd, shell: false, detached: process.platform !== 'win32',
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: environment,
      });
    } catch {
      // Invalid arguments or a Windows batch file throw synchronously; the raw error may echo arguments.
      reject(new AiProcessError('AI_PROCESS_FAILED'));
      return;
    }
    let failure: AiProcessError | null = null;
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let pipesClosed = false;
    let stdinDone: 'pending' | 'ok' | 'failed' = 'pending';
    let bytes = 0;
    let stdout = '';
    let pendingLine = '';
    const protocolController = new AbortController();
    const decoder = new StringDecoder('utf8');
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, action: () => void) => {
      const timer = setTimeout(() => { timers.delete(timer); action(); }, ms);
      timers.add(timer);
      return timer;
    };
    const clearTimers = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); };
    // Never signal by PID after the child was reaped: the PID (and group ID) may then belong to another program.
    const running = () => !exited && child.exitCode === null && child.signalCode === null;
    const signal = (name: NodeJS.Signals) => { if (running()) signalGroup(child, name, environment); };

    const settle = (error: AiProcessError | null) => {
      if (settled) return;
      settled = true;
      protocolController.abort();
      clearTimers();
      options.signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve({ stdout, exitCode: 0 });
    };
    /** Last resort when pipes stay open: something outside our reach holds them. Stop reading and fail. */
    const abandon = () => {
      failure ??= new AiProcessError('AI_PROCESS_FAILED');
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      settle(failure);
    };
    const stop = (code: AiProcessErrorCode) => {
      if (settled || failure) return;
      failure = new AiProcessError(code);
      protocolController.abort();
      if (running()) {
        signal('SIGTERM');
        later(killGraceMs, () => { signal('SIGKILL'); later(killGraceMs, abandon); });
      } else {
        later(killGraceMs, abandon);
      }
    };
    const cancel = () => stop('AI_CANCELLED');
    const lines = (text: string, final = false) => {
      pendingLine += text;
      let newline: number;
      while (!failure && (newline = pendingLine.indexOf('\n')) >= 0) {
        const line = pendingLine.slice(0, newline).replace(/\r$/, '');
        pendingLine = pendingLine.slice(newline + 1);
        try { options.onLine?.(line); } catch { stop('AI_INVALID_OUTPUT'); }
      }
      if (final && !failure && pendingLine) {
        try { options.onLine?.(pendingLine); } catch { stop('AI_INVALID_OUTPUT'); }
        pendingLine = '';
      }
    };
    const acceptChunk = (chunk: Buffer): boolean => {
      if (settled || failure) return false;
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) { stop('AI_OUTPUT_TOO_LARGE'); return false; }
      return true;
    };
    /** Result only after the process exited, its output pipes closed and the input was fully handed over. */
    const finish = () => {
      if (settled || !exited || !pipesClosed || stdinDone === 'pending') return;
      if (!failure) {
        const tail = decoder.end();
        stdout += tail;
        lines(tail, true);
      }
      if (failure) settle(failure);
      else if (stdinDone === 'failed' || exitCode !== 0) settle(new AiProcessError('AI_PROCESS_FAILED'));
      else settle(null);
    };

    options.signal?.addEventListener('abort', cancel, { once: true });
    later(timeoutMs, () => stop('AI_TIMEOUT'));
    child.stdout.on('data', (chunk: Buffer) => {
      if (!acceptChunk(chunk)) return;
      const text = decoder.write(chunk);
      stdout += text;
      lines(text);
    });
    child.stderr.on('data', (chunk: Buffer) => { acceptChunk(chunk); });
    child.stdin.on('error', () => { /* reported through finished() below */ });
    finished(child.stdin, { readable: false }, (error) => {
      stdinDone = error ? 'failed' : 'ok';
      // A provider that stops reading its instructions has not received the task it reports on.
      if (error && running()) stop('AI_PROCESS_FAILED');
      finish();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      // After a successful spawn, 'error' only reports a failed kill(); exit and close still decide the outcome.
      if (child.pid !== undefined || settled) return;
      settle(new AiProcessError(error.code === 'ENOENT' || error.code === 'EACCES' ? 'AI_EXECUTABLE_UNAVAILABLE' : 'AI_PROCESS_FAILED'));
    });
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      // POSIX: sweep the group synchronously while it is still ours. While any member lives the group ID cannot be
      // reused; once it is empty this is the only post-exit signal and it is sent in the same tick as the reap.
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already empty */ }
      }
      // Pipes held open by a process outside the group must not keep the task pending.
      if (!failure) later(killGraceMs, () => { if (!pipesClosed) abandon(); });
      finish();
    });
    child.on('close', () => { pipesClosed = true; finish(); });
    if (options.signal?.aborted) cancel();
    if (options.interact) {
      const write = (message: string): Promise<void> => new Promise((resolveWrite, rejectWrite) => {
        if (failure || settled || protocolController.signal.aborted) { rejectWrite(new AiProcessError('AI_PROCESS_FAILED')); return; }
        try {
          child.stdin.write(message, (error) => {
            if (error) { stop('AI_PROCESS_FAILED'); rejectWrite(new AiProcessError('AI_PROCESS_FAILED')); }
            else resolveWrite();
          });
        } catch { stop('AI_PROCESS_FAILED'); rejectWrite(new AiProcessError('AI_PROCESS_FAILED')); }
      });
      void Promise.resolve().then(() => options.interact!({ write, signal: protocolController.signal })).then(
        () => { if (!child.stdin.destroyed) child.stdin.end(); },
        () => { stop('AI_INVALID_OUTPUT'); if (!child.stdin.destroyed) child.stdin.end(); },
      );
    } else child.stdin.end(options.input ?? '');
  });
}
