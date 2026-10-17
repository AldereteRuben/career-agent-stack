/**
 * Admission gate for workspace requests (ADR 020). Deleting all data closes it: new requests are refused, and the
 * deletion waits until every request already admitted has finished, so none can write after the rows are deleted.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

export type RequestGate = ReturnType<typeof createRequestGate>;

export type GateClose = 'drained' | 'timeout' | 'busy';

export function createRequestGate() {
  let owner: FastifyRequest | null = null;
  const admitted = new Set<FastifyRequest>();
  let waiters: Array<() => void> = [];
  const settle = () => { if (!admitted.size) for (const done of waiters.splice(0)) done(); };
  return {
    /** Admits a request; false when the gate is closed and the request must be refused. */
    enter(request: FastifyRequest) {
      if (owner) return false;
      admitted.add(request);
      return true;
    },
    /** Marks an admitted request as finished. Safe to call more than once, or for a request never admitted. */
    leave(request: FastifyRequest) {
      if (admitted.delete(request)) settle();
    },
    /**
     * Closes the gate for `request`, which becomes its only owner, and waits for the other admitted requests to
     * finish: 'drained' once none is left, 'timeout' after `timeoutMs` (still closed until the owner opens it).
     * 'busy' when another request already owns it: that one is running, so this one must not proceed.
     */
    async close(timeoutMs: number, request: FastifyRequest): Promise<GateClose> {
      if (owner) return 'busy';
      owner = request;
      admitted.delete(request);
      if (!admitted.size) return 'drained';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = new Promise<GateClose>((resolve) => { waiters.push(() => resolve('drained')); });
      const expired = new Promise<GateClose>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
      try { return await Promise.race([drained, expired]); } finally { clearTimeout(timer); waiters = []; }
    },
    /** Opens the gate again; only its owner can. */
    open(request: FastifyRequest) { if (owner === request) owner = null; },
    get closed() { return owner !== null; },
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
