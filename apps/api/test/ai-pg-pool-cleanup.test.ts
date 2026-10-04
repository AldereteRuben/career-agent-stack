import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';

class FixturePool extends EventEmitter {
  endCalls = 0;
  constructor(private readonly ending: () => Promise<void> = () => Promise.resolve()) { super(); }
  end() { this.endCalls++; return this.ending(); }
}

test('pool cleanup waits for physical client removal even when end resolves early', async () => {
  const pool = new FixturePool(); const close = trackPgPoolCleanup(pool);
  const first = {}; const second = {};
  pool.emit('connect', first); pool.emit('connect', second);
  let finished = false; const closing = close(); void closing.then(() => { finished = true; });
  assert.equal(close(), closing, 'concurrent cleanup shares one shutdown');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(pool.endCalls, 1); assert.equal(finished, false, 'the database must not be dropped yet');
  pool.emit('remove', first); await Promise.resolve();
  assert.equal(finished, false, 'all connections must finish closing');
  pool.emit('remove', second); await closing;
  assert.equal(finished, true); assert.equal(pool.listenerCount('connect'), 0); assert.equal(pool.listenerCount('remove'), 0);
});

test('pool cleanup handles removal before end resolves and a pool that never connected', async () => {
  const client = {};
  const pool = new FixturePool(async () => { pool.emit('remove', client); });
  const close = trackPgPoolCleanup(pool); pool.emit('connect', client);
  await close(); assert.equal(pool.listenerCount('remove'), 0);
  const empty = new FixturePool(); await trackPgPoolCleanup(empty)(); assert.equal(empty.endCalls, 1);
});

test('pool cleanup propagates shutdown errors instead of hiding them', async () => {
  const failure = new Error('synthetic close failure');
  const pool = new FixturePool(async () => { throw failure; });
  await assert.rejects(trackPgPoolCleanup(pool)(), failure);
  assert.equal(pool.listenerCount('connect'), 0); assert.equal(pool.listenerCount('remove'), 0);
});
