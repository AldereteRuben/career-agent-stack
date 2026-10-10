/**
 * Admission gate for workspace requests (ADR 020). Deleting all data closes it: new requests are refused, and the
 * deletion waits until every request already admitted has finished, so none can write after the rows are deleted.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

export type RequestGate = ReturnType<typeof createRequestGate>;

export function createRequestGate() {
  let closed = false;
  const admitted = new Set<FastifyRequest>();
  let waiters: Array<() => void> = [];
  const settle = () => { if (!admitted.size) for (const done of waiters.splice(0)) done(); };
  return {
    /** Admits a request; false when the gate is closed and the request must be refused. */
    enter(request: FastifyRequest) {
      if (closed) return false;
      admitted.add(request);
      return true;
    },
    /** Marks an admitted request as finished. Safe to call more than once, or for a request never admitted. */
    leave(request: FastifyRequest) {
      if (admitted.delete(request)) settle();
    },
    /**
     * Stops admitting requests and waits for the admitted ones to finish. Resolves true once none is left, or false
     * after `timeoutMs` (the gate then stays closed until `open`). `except` is the closing request itself.
     */
    async close(timeoutMs: number, except?: FastifyRequest) {
      closed = true;
      if (except) admitted.delete(except);
      if (!admitted.size) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = new Promise<boolean>((resolve) => { waiters.push(() => resolve(true)); });
      const expired = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
      try { return await Promise.race([drained, expired]); } finally { clearTimeout(timer); waiters = []; }
    },
    open() { closed = false; },
    get closed() { return closed; },
    get active() { return admitted.size; },
  };
}

/**
 * Releases admitted requests once their handler has produced a response. onSend runs when the handler finishes,
 * whether it succeeded, failed or the client already left; onResponse is a second, idempotent release.
 */
export function releaseOnResponse(app: FastifyInstance, gate: RequestGate) {
  app.addHook('onSend', async (request, _reply, payload) => { gate.leave(request); return payload; });
  app.addHook('onResponse', async (request) => { gate.leave(request); });
}
