import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_LIMIT_PER_MINUTE, WRITE_LIMIT_PER_MINUTE, errorResponse, isConflictCode, rateLimitOptions } from '../src/request-errors.js';

const fastifyError = (statusCode: number, code: string) => Object.assign(new Error('boom'), { statusCode, code });

test('a request the person can correct is answered as 4xx, never as a service failure', () => {
  assert.deepEqual(errorResponse(fastifyError(400, 'FST_ERR_CTP_INVALID_JSON_BODY')), { status: 400, code: 'INVALID_INPUT' });
  assert.deepEqual(errorResponse(fastifyError(413, 'FST_ERR_CTP_BODY_TOO_LARGE')), { status: 413, code: 'INVALID_INPUT' });
  assert.deepEqual(errorResponse(fastifyError(415, 'FST_ERR_CTP_INVALID_MEDIA_TYPE')), { status: 415, code: 'INVALID_INPUT' });
  assert.deepEqual(errorResponse(fastifyError(404, 'FST_ERR_NOT_FOUND')), { status: 404, code: 'NOT_FOUND' });
  // PostgreSQL refusing a path id that is not a UUID.
  assert.deepEqual(errorResponse(Object.assign(new Error('invalid input syntax for type uuid: "x"'), { code: '22P02' })), { status: 400, code: 'INVALID_INPUT' });
});

test('database errors are recognised when the query builder wraps them', () => {
  const driver = (code: string) => Object.assign(new Error('driver error'), { code });
  const wrapped = (code: string) => Object.assign(new Error('Failed query: select …'), { cause: driver(code) });
  assert.deepEqual(errorResponse(wrapped('22P02')), { status: 400, code: 'INVALID_INPUT' });
  assert.deepEqual(errorResponse(wrapped('23505')), { status: 409, code: 'DUPLICATE_RECORD' });
  // A connection failure wrapped the same way is still a service failure.
  assert.deepEqual(errorResponse(Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) })), { status: 500, code: 'INTERNAL_ERROR' });
  // A self-referencing cause chain cannot loop forever.
  const loop: { cause?: unknown } = {}; loop.cause = loop;
  assert.deepEqual(errorResponse(loop), { status: 500, code: 'INTERNAL_ERROR' });
});

test('domain codes, conflicts and the rate limit keep their meaning', () => {
  assert.deepEqual(errorResponse(fastifyError(429, 'FST_ERR_RATE_LIMIT')), { status: 429, code: 'RATE_LIMIT_EXCEEDED' });
  assert.deepEqual(errorResponse(new Error('STALE_APPLICATION_VERSION')), { status: 409, code: 'STALE_APPLICATION_VERSION' });
  assert.deepEqual(errorResponse(new Error('ASSIST_ACTIVE_ATTEMPT')), { status: 409, code: 'ASSIST_ACTIVE_ATTEMPT' });
  assert.deepEqual(errorResponse(Object.assign(new Error('duplicate key'), { code: '23505' })), { status: 409, code: 'DUPLICATE_RECORD' });
  assert.deepEqual(errorResponse(fastifyError(409, 'BACKUP_IN_PROGRESS')), { status: 409, code: 'BACKUP_IN_PROGRESS' });
});

test('service failures never leak their message or an unexpected status', () => {
  assert.deepEqual(errorResponse(new Error('connect ECONNREFUSED 127.0.0.1:5432')), { status: 500, code: 'INTERNAL_ERROR' });
  assert.deepEqual(errorResponse(Object.assign(new Error('timeout exceeded when trying to connect'), { code: 'ETIMEDOUT' })), { status: 500, code: 'INTERNAL_ERROR' });
  assert.deepEqual(errorResponse(fastifyError(503, 'UPSTREAM')), { status: 500, code: 'INTERNAL_ERROR' });
  assert.deepEqual(errorResponse(fastifyError(400, 'lower case or free text')), { status: 400, code: 'INVALID_INPUT' });
  for (const value of [null, undefined, 'text', 42]) assert.deepEqual(errorResponse(value), { status: 500, code: 'INTERNAL_ERROR' });
});

test('only domain conflicts may be answered from inside a transaction', () => {
  assert.equal(isConflictCode('INVALID_STATE_TRANSITION'), true);
  assert.equal(isConflictCode('invalid input syntax for type uuid: "x"'), false);
  assert.equal(isConflictCode(undefined), false);
});

test('reads and writes are limited separately and writes keep the stricter budget', () => {
  const read = { ip: '127.0.0.1', method: 'GET' }; const write = { ip: '127.0.0.1', method: 'POST' };
  assert.notEqual(rateLimitOptions.keyGenerator(read), rateLimitOptions.keyGenerator(write));
  assert.equal(rateLimitOptions.keyGenerator({ ip: '127.0.0.1', method: 'HEAD' }), rateLimitOptions.keyGenerator(read));
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal(rateLimitOptions.keyGenerator({ ip: '127.0.0.1', method }), rateLimitOptions.keyGenerator(write));
  assert.equal(rateLimitOptions.max(read), READ_LIMIT_PER_MINUTE);
  assert.equal(rateLimitOptions.max(write), WRITE_LIMIT_PER_MINUTE);
  assert.equal(WRITE_LIMIT_PER_MINUTE, 120);
  assert.ok(READ_LIMIT_PER_MINUTE > WRITE_LIMIT_PER_MINUTE);
});
