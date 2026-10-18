import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractKnownSkills, factCoversRequirement } from '../src/matching.js';

const evidence = (text: string) => ({ id: 'fact', text, tags: [], approval: 'USER_APPROVED' as const });

test('continuous integration, delivery and deployment do not substitute for one another', () => {
  const integration = extractKnownSkills('continuous integration')[0]!;
  const delivery = extractKnownSkills('continuous delivery')[0]!;
  const deployment = extractKnownSkills('continuous deployment')[0]!;

  assert.equal(factCoversRequirement(evidence('Set up continuous integration.'), integration), true);
  assert.equal(factCoversRequirement(evidence('Set up integración continua.'), integration), true);
  assert.equal(factCoversRequirement(evidence('Set up continuous integration.'), delivery), false);
  assert.equal(factCoversRequirement(evidence('Set up entrega continua.'), integration), false);
  assert.equal(factCoversRequirement(evidence('Set up continuous delivery.'), deployment), false);
  assert.equal(factCoversRequirement(evidence('Set up CI/CD.'), integration), false);
});
