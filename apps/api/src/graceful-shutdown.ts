import { lstat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';

type Closeable = { close(): Promise<unknown> };
type Pool = { end(): Promise<unknown> };
type ShutdownProcess = {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exit(code?: number): unknown;
};

const stopFileName = /^api-stop-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.signal$/i;

/** Accept only a launcher-generated signal directly inside this installation's private data/run folder. */
export function resolveLauncherStopFile(dataRoot: string, configuredPath: string | undefined, platform = process.platform): string | null {
  if (platform !== 'win32' || !configuredPath || !isAbsolute(configuredPath)) return null;
  const path = resolve(configuredPath);
  if (dirname(path) !== resolve(dataRoot, 'run') || !stopFileName.test(basename(path))) return null;
  return path;
}

/** Share one shutdown path between OS signals and the launcher's Windows-only cooperative stop file. */
export function attachGracefulShutdown(
  app: Closeable,
  pool: Pool,
  options: { stopFile: string | null; processRef?: ShutdownProcess; onPollError?: (error: unknown) => void },
) {
  const processRef = options.processRef ?? process;
  let closing = false;
  let pollTimer: NodeJS.Timeout | undefined;

  const shutdown = () => {
    if (closing) return;
    closing = true;
    if (pollTimer) clearTimeout(pollTimer);
    const deadline = setTimeout(() => processRef.exit(1), 15_000);
    deadline.unref();
    void app.close().then(() => pool.end()).then(() => {
      clearTimeout(deadline);
      processRef.exit(0);
    }).catch(() => {
      clearTimeout(deadline);
      processRef.exit(1);
    });
  };

  processRef.once('SIGINT', shutdown);
  processRef.once('SIGTERM', shutdown);

  if (options.stopFile) {
    const poll = async () => {
      if (closing) return;
      try {
        const signal = await lstat(options.stopFile!);
        if (signal.isFile() && !signal.isSymbolicLink()) {
          await unlink(options.stopFile!);
          shutdown();
          return;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') options.onPollError?.(error);
      }
      if (!closing) {
        pollTimer = setTimeout(() => { void poll(); }, 1_000);
        pollTimer.unref();
      }
    };
    pollTimer = setTimeout(() => { void poll(); }, 1_000);
    pollTimer.unref();
  }

  return shutdown;
}
