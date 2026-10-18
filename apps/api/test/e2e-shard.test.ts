import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseShard, selectShard } from '../e2e/shard.js';

const names = (items: Array<{ name: string }>) => items.map((item) => item.name);
const scenarios = ['sign-in', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => ({ name }));

test('an empty shard value runs every scenario', () => {
  assert.equal(parseShard(undefined), null);
  assert.equal(parseShard(''), null);
  assert.deepEqual(names(selectShard(scenarios, null, ['sign-in'])), names(scenarios));
});

test('shards cover every scenario exactly once and always include the sign-in scenario', () => {
  const slices = [1, 2, 3].map((index) => names(selectShard(scenarios, parseShard(`${index}/3`), ['sign-in'])));
  for (const slice of slices) assert.equal(slice[0], 'sign-in');
  assert.deepEqual(slices.flatMap((slice) => slice.slice(1)).sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(slices[0], ['sign-in', 'a', 'd', 'g']);
});

test('an invalid shard fails loudly instead of running nothing', () => {
  for (const value of ['0/4', '5/4', '1/0', '2', 'a/b', '1/4/2']) assert.throws(() => parseShard(value), /E2E_SHARD/);
});
