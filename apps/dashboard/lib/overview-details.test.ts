import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overviewDetailsOpen } from './overview-details';

test('dense overview details stay collapsed; pending review is surfaced by the primary action', () => {
  assert.equal(overviewDetailsOpen(), false);
});
