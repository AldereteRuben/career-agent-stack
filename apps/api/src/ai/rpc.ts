import { AiProcessError, runAiProcess, type AiProcessChannel, type AiProcessOptions } from './process.js';

export class AiRpcError extends Error {
  constructor(readonly code: 'RPC_FAILED' | 'RPC_CLOSED' | 'RPC_TIMEOUT' | 'RPC_INVALID') { super(code); this.name = 'AiRpcError'; }
}
type RecordValue = Record<string, unknown>;
export const isAiRecord = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
export type AiRpcClient = {
  request: (method: string, params?: RecordValue) => Promise<unknown>;
  notify: (method: string, params?: RecordValue) => Promise<void>;
  onNotification: (listener: (method: string, params: RecordValue) => void) => () => void;
  signal: AbortSignal;
};
type Pending = { resolve: (value: unknown) => void; reject: (error: AiRpcError) => void; timer: ReturnType<typeof setTimeout> };

/** Private local stdio transport; server-initiated tools and authentication-token requests are never serviced. */
export async function withAiRpcProcess<T>(
  options: Omit<AiProcessOptions, 'input' | 'interact' | 'onLine'>,
  action: (client: AiRpcClient) => Promise<T>,
  requestTimeoutMs = 10_000,
): Promise<T> {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 300_000) throw new AiRpcError('RPC_INVALID');
  let channel: AiProcessChannel | undefined;
  let nextId = 0;
  let result: T | undefined;
  let completed = false;
  let actionError: unknown;
  const pending = new Map<number, Pending>();
  const listeners = new Set<(method: string, params: RecordValue) => void>();
  let closed = false;
  const close = () => {
    closed = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new AiRpcError('RPC_CLOSED')); }
    pending.clear(); listeners.clear();
  };
  const write = async (message: RecordValue) => {
    if (!channel || closed || channel.signal.aborted) throw new AiRpcError('RPC_CLOSED');
    await channel.write(`${JSON.stringify(message)}\n`);
  };
  try {
    await runAiProcess({
      ...options,
      onLine(line) {
        if (!line.trim()) return;
        const message: unknown = JSON.parse(line);
        if (!isAiRecord(message)) throw new AiRpcError('RPC_INVALID');
        // A request from the CLI could ask for filesystem, tools or replacement credentials. Fail closed.
        if (typeof message.method === 'string' && message.id !== undefined) throw new AiRpcError('RPC_INVALID');
        if (typeof message.method === 'string') {
          if (message.params !== undefined && !isAiRecord(message.params)) throw new AiRpcError('RPC_INVALID');
          for (const listener of listeners) listener(message.method, (message.params ?? {}) as RecordValue);
          return;
        }
        if (!Number.isSafeInteger(message.id)) throw new AiRpcError('RPC_INVALID');
        const waiter = pending.get(message.id as number);
        if (!waiter) throw new AiRpcError('RPC_INVALID');
        pending.delete(message.id as number); clearTimeout(waiter.timer);
        if (message.error !== undefined) waiter.reject(new AiRpcError('RPC_FAILED'));
        else if (Object.hasOwn(message, 'result')) waiter.resolve(message.result);
        else waiter.reject(new AiRpcError('RPC_INVALID'));
      },
      async interact(openChannel) {
        channel = openChannel;
        channel.signal.addEventListener('abort', close, { once: true });
        const client: AiRpcClient = {
          signal: channel.signal,
          async request(method, params = {}) {
            if (closed || pending.size >= 16 || nextId >= 128) throw new AiRpcError('RPC_CLOSED');
            const id = ++nextId;
            const response = new Promise<unknown>((resolve, reject) => {
              const timer = setTimeout(() => { pending.delete(id); reject(new AiRpcError('RPC_TIMEOUT')); }, requestTimeoutMs);
              pending.set(id, { resolve, reject, timer });
            });
            try { const [, value] = await Promise.all([write({ id, method, params }), response]); return value; }
            finally { const waiter = pending.get(id); if (waiter) { clearTimeout(waiter.timer); pending.delete(id); } }
          },
          notify: (method, params = {}) => write({ method, params }),
          onNotification(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        };
        try { result = await action(client); completed = true; }
        catch (error) { actionError = error; throw error; }
        finally { channel.signal.removeEventListener('abort', close); close(); }
      },
    });
  } catch (error) {
    if (actionError instanceof AiRpcError) throw actionError;
    if (error instanceof AiProcessError) throw error;
    throw new AiRpcError('RPC_FAILED');
  } finally { close(); }
  if (!completed) throw new AiRpcError('RPC_CLOSED');
  return result as T;
}
