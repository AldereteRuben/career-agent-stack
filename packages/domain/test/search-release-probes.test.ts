import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateSearchMatch, type SearchCriteria, type SearchJob } from '../src/search-matching.js';

// Prospective release probes: expectations fixed on 2026-10-04 after the matcher
// implementation was frozen, before the first execution of this file. Do not
// relabel failures to improve metrics. Synthetic checks, not a user study.
const families = [
  ['quality', 'QA Engineer', 'Ingeniero de pruebas'],
  ['development', 'Software Engineer', 'Ingeniera de software'],
  ['design', 'Product Designer', 'Diseñadora de producto'],
  ['support', 'Customer Support', 'Agente de atención al cliente'],
  ['marketing', 'Digital Marketing Specialist', 'Especialista en marketing digital'],
  ['administration', 'Administrative Assistant', 'Asistente administrativa'],
] as const;
const probes = families.flatMap(([family, role, alias]) => {
  const criteria: SearchCriteria = { role, company: 'Faro Labs', location: 'JP', workMode: 'remote', matcherVersion: 2, includeRelated: false };
  const job: SearchJob = { title: role, company: 'Faro Labs', location: 'Japan', countries: ['JP'], workMode: 'remote' };
  const make = (name: string, relevant: boolean, changes: Partial<SearchJob> = {}, requested: Partial<SearchCriteria> = {}) => ({ family, name, relevant, job: { ...job, ...changes }, criteria: { ...criteria, ...requested } });
  return [
    make('Spanish alias with explicit Japanese eligibility', true, { title: `${alias} — plataforma educativa` }),
    make('English title with specialization suffix', true, { title: `${role} — education platform` }),
    make('Unknown geography remains reviewable', true, { countries: undefined, location: null }),
    make('Similar company spelling is not the requested employer', false, { company: 'Faros Labs' }),
    make('Explicit country restriction excludes Japan', false, { countries: ['NZ'], location: 'New Zealand only' }),
    make('Explicit hybrid mode excludes remote-only search', false, { workMode: 'hybrid' }),
    make('Unrelated occupation is not a match', false, { title: 'Veterinary Surgeon' }),
    make('Junior query excludes explicitly senior listing', false, { title: `Senior ${role}` }, { role: `Junior ${role}` }),
  ];
});

test('48 frozen prospective release probes across six role families', () => {
  assert.equal(probes.length, 48);
  const predictions = probes.map((probe) => evaluateSearchMatch(probe.job, probe.criteria).matched);
  const failures = probes.filter((probe, index) => predictions[index] !== probe.relevant);
  const positives = probes.filter((probe) => probe.relevant).length;
  const tp = probes.filter((probe, index) => probe.relevant && predictions[index]).length;
  const fp = probes.filter((probe, index) => !probe.relevant && predictions[index]).length;
  console.info(`Prospective synthetic probes n=48: precision=${(tp / (tp + fp || 1)).toFixed(3)}, recall=${(tp / positives).toFixed(3)}, failures=${failures.map((probe) => `${probe.family}: ${probe.name}`).join('; ') || 'none'}`);
  assert.deepEqual(failures.map((probe) => `${probe.family}: ${probe.name}`), []);
});
