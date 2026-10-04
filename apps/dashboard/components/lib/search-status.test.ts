import assert from 'node:assert/strict';
import test from 'node:test';
import type { Search } from '../search-types';
import { emptyKind, nextCheckLabel, searchHealth, summarize } from './search-status';

const finished = '2026-10-04T08:00:00.000Z';
function search(overrides: Partial<Search> = {}, run?: Partial<NonNullable<Search['latestRun']>> | null): Search {
  return {
    id: overrides.id ?? 'a', role: 'QA', company: null, location: null, workMode: 'any', frequencyHours: 24, enabled: true, autoPrepare: false, language: 'en', revision: 1,
    matcherVersion: 2, providerIds: ['remotive'], includeRelated: false, lastRunAt: null, nextRunAt: '2026-10-05T08:00:00.000Z', lastRunStatus: null, lastResultCount: 0, lastNewCount: 0, lastError: null,
    latestRun: run === null ? null : { id: 'r', status: 'SUCCEEDED', finishedAt: finished, error: null, sources: [{ provider: 'remotive', status: 'FRESH', coverage: 'COMPLETE', fetchedAt: finished, error: null }], ...run },
    ...overrides,
  };
}

test('only queued and running searches read as active work', () => {
  assert.equal(searchHealth(search({}, { status: 'QUEUED', finishedAt: null })).state, 'queued');
  assert.equal(searchHealth(search({}, { status: 'RUNNING', finishedAt: null })).state, 'running');
  assert.equal(searchHealth(search({}, { status: 'PARTIAL', finishedAt: null })).state, 'running');
  assert.equal(searchHealth(search({}, { status: 'FAILED', sources: [{ provider: 'remotive', status: 'FAILED', coverage: null, fetchedAt: null, error: 'x' }] })).state, 'failed');
  assert.equal(searchHealth(search({}, { status: 'PARTIAL', sources: [{ provider: 'remotive', status: 'CACHED', coverage: 'BOUNDED', fetchedAt: finished, error: null }] })).state, 'limited');
  assert.equal(searchHealth(search({ enabled: false })).state, 'paused');
  assert.equal(searchHealth(search({}, null)).state, 'pending');
  assert.equal(searchHealth(search()).state, 'ready');
});

test('one failed portal in a finished run is partial, not a total failure', () => {
  const health = searchHealth(search({}, { status: 'PARTIAL', sources: [
    { provider: 'remotive', status: 'FRESH', coverage: 'COMPLETE', fetchedAt: finished, error: null },
    { provider: 'himalayas', status: 'FAILED', coverage: null, fetchedAt: null, error: 'timeout' },
  ] }));
  assert.equal(health.state, 'limited');
  assert.deepEqual(health.failedProviders, ['himalayas']);
});

test('a finished failure is never described as still searching (U01)', () => {
  const failed = search({}, { status: 'FAILED', error: 'down', sources: [] });
  assert.equal(summarize([failed]).active.length, 0);
  assert.equal(emptyKind({ view: 'new', error: false, scope: [failed], matchesTotal: 0 }), 'failed');
});

test('first empty search is "no matches", not "you reviewed everything" (U04)', () => {
  assert.equal(emptyKind({ view: 'new', error: false, scope: [search()], matchesTotal: 0 }), 'noMatches');
  assert.equal(emptyKind({ view: 'new', error: false, scope: [search()], matchesTotal: 3 }), 'caughtUp');
  assert.equal(emptyKind({ view: 'new', error: false, scope: [search({}, null)], matchesTotal: 0 }), 'pending');
  assert.equal(emptyKind({ view: 'new', error: false, scope: [search({ enabled: false })], matchesTotal: 0 }), 'paused');
  assert.equal(emptyKind({ view: 'new', error: false, scope: [search({}, { status: 'RUNNING', finishedAt: null })], matchesTotal: 0 }), 'searching');
  assert.equal(emptyKind({ view: 'new', error: true, scope: [search()], matchesTotal: 0 }), 'loadError');
  assert.equal(emptyKind({ view: 'saved', error: false, scope: [search()], matchesTotal: 0 }), 'noSaved');
  assert.equal(emptyKind({ view: 'new', error: false, scope: [search()], matchesTotal: null }), 'unknown');
});

test('aggregate: one failed search among working ones does not make the whole inbox failed', () => {
  const scope = [search({ id: 'a' }, { status: 'FAILED', sources: [] }), search({ id: 'b' })];
  assert.equal(emptyKind({ view: 'new', error: false, scope, matchesTotal: 0 }), 'noMatches');
  assert.equal(summarize(scope).failed.length, 1);
});

test('next check uses the earliest enabled search and plain relative words', () => {
  const summary = summarize([search({ id: 'a', nextRunAt: '2026-10-06T08:00:00.000Z' }), search({ id: 'b', nextRunAt: '2026-10-05T08:00:00.000Z' }), search({ id: 'c', enabled: false, nextRunAt: '2026-10-04T09:00:00.000Z' })]);
  assert.equal(summary.nextRunAt, '2026-10-05T08:00:00.000Z');
  const now = new Date(2026, 9, 4, 10, 0);
  assert.match(nextCheckLabel(new Date(2026, 9, 5, 9, 30).toISOString(), 'es', now), /^mañana a las 09:30$/);
  assert.match(nextCheckLabel(new Date(2026, 9, 4, 18, 0).toISOString(), 'en', now), /^today at 18:00$/);
  assert.equal(nextCheckLabel(new Date(2026, 9, 4, 9, 0).toISOString(), 'en', now), 'shortly');
  assert.equal(summarize([search({ enabled: false })]).allPaused, true);
});
