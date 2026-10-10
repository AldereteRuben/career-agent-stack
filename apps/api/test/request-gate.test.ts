// The admission gate that deleting all data closes (ADR 020): requests already admitted finish before anything is
// deleted, and none is admitted meanwhile. Deterministic: each request is paused on a latch the test controls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createRequestGate, releaseOnResponse } from '../src/request-gate.js';

function latch() { let open!: () => void; const promise = new Promise<void>((resolve) => { open = resolve; }); return { promise, open }; }

function harness(timeoutMs = 5_000) {
  const app = Fastify(); const gate = createRequestGate(); const log: string[] = [];
  const entered = latch(); const release = latch();
  app.addHook('onRequest', async (request, reply) => { if (!gate.enter(request)) return reply.code(503).send({ error: 'DELETION_IN_PROGRESS' }); });
  releaseOnResponse(app, gate);
  // A mutation that has passed authentication and pauses before it writes.
  app.post('/write', async () => { entered.open(); await release.promise; log.push('written'); return { ok: true }; });
  app.post('/fail', async () => { entered.open(); await release.promise; throw new Error('fictional failure'); });
  // The same steps as the real route; `hold` pauses a deletion after it owns the gate.
  let hold: Promise<void> = Promise.resolve();
  app.post('/delete', async (request, reply) => {
    const outcome = await gate.close(timeoutMs, request);
    if (outcome === 'busy') return reply.code(409).send({ error: 'DELETION_IN_PROGRESS' });
    if (outcome === 'timeout') { gate.open(request); return reply.code(503).send({ error: 'DELETION_BUSY' }); }
    try { await hold; log.push('deleted'); return { deleted: true }; } finally { gate.open(request); }
  });
  return { app, gate, log, entered: () => entered.promise, release: () => release.open(), holdDeletion: (until: Promise<void>) => { hold = until; } };
}

test('deleting waits for a mutation already admitted, and admits nothing new meanwhile', async () => {
  const { app, gate, log, entered, release } = harness();
  try {
    const write = app.inject({ method: 'POST', url: '/write' });
    await entered();
    const deletion = app.inject({ method: 'POST', url: '/delete' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(log, [], 'Nothing is deleted while an admitted mutation runs');
    assert.equal(gate.closed, true);
    assert.equal((await app.inject({ method: 'POST', url: '/write' })).statusCode, 503, 'A new request is refused while deleting');
    release();
    assert.equal((await write).statusCode, 200);
    assert.equal((await deletion).statusCode, 200);
    assert.deepEqual(log, ['written', 'deleted'], 'The mutation finished before the deletion, so it cannot write afterwards');
    assert.equal(gate.closed, false, 'The gate opens again afterwards');
    assert.equal(gate.active, 0);
  } finally { await app.close(); }
});

test('a failing mutation is released too', async () => {
  const { app, gate, log, entered, release } = harness();
  try {
    const failing = app.inject({ method: 'POST', url: '/fail' });
    await entered();
    const deletion = app.inject({ method: 'POST', url: '/delete' });
    release();
    assert.equal((await failing).statusCode, 500);
    assert.equal((await deletion).statusCode, 200);
    assert.deepEqual(log, ['deleted']);
    assert.equal(gate.active, 0);
  } finally { await app.close(); }
});

test('if admitted requests do not finish in time, nothing is deleted and the gate opens again', async () => {
  const { app, gate, log, entered, release } = harness(50);
  try {
    const write = app.inject({ method: 'POST', url: '/write' });
    await entered();
    const deletion = await app.inject({ method: 'POST', url: '/delete' });
    assert.equal(deletion.statusCode, 503);
    assert.equal(deletion.json().error, 'DELETION_BUSY');
    assert.deepEqual(log, []);
    assert.equal(gate.closed, false);
    release();
    assert.equal((await write).statusCode, 200);
  } finally { await app.close(); }
});

test('two deletions admitted together never run at once: the second is refused', async () => {
  const { app, gate, log, holdDeletion } = harness();
  const paused = latch(); holdDeletion(paused.promise);
  try {
    // Both are admitted while the gate is still open, as when two tabs send them at the same moment.
    const first = app.inject({ method: 'POST', url: '/delete' });
    const second = app.inject({ method: 'POST', url: '/delete' });
    const refused = await Promise.race([first, second]);
    assert.equal(refused.statusCode, 409, 'One of them is refused at once');
    assert.equal(refused.json().error, 'DELETION_IN_PROGRESS');
    assert.equal(gate.closed, true, 'The refused one cannot open the gate it does not own');
    paused.open();
    const results = (await Promise.all([first, second])).map((response) => response.statusCode).sort();
    assert.deepEqual(results, [200, 409]);
    assert.deepEqual(log, ['deleted'], 'The deletion ran exactly once');
    assert.equal(gate.closed, false);
  } finally { await app.close(); }
});
