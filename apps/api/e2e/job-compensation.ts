import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Scenario } from './scenarios.js';

type Compensation = { min: number | null; max: number | null; currency: string | null; period: string | null; text: string | null; provider: string } | null;
type ListedJob = { id: string; compensation?: Compensation };

// Synthetic board payloads shaped like the documented Lever and Ashby fields. The projections in GET /jobs read
// sourcePayload->'salaryRange' and sourcePayload->'compensation' on their own, so they are checked here against the database.
export const jobCompensationScenario: Scenario = {
  name: 'job-compensation-from-stored-source-payload',
  async run({ api, db, marker }) {
    const workspace = (await db.query<{ id: string }>('select id from workspaces limit 1')).rows[0]!.id;
    const seed = async (title: string, provider: 'lever' | 'ashby', payload: Record<string, unknown>) => {
      const id = randomUUID();
      await db.query("insert into jobs(id,workspace_id,company,title,canonical_url,availability,discovered_at) values($1,$2,$3,$4,$5,'OPEN',now())", [id, workspace, `Pay ${marker}`, title, `https://example.test/${marker}/pay/${id}`]);
      await db.query('insert into job_occurrences(workspace_id,job_id,provider,region,tenant,external_job_id,job_url,source_payload) values($1,$2,$3,$4,$5,$6,$7,$8)', [workspace, id, provider, 'global', `pay-${marker}`.slice(0, 60), id, `https://example.test/${marker}/pay/${id}`, JSON.stringify(payload)]);
      return id;
    };
    const lever = await seed(`Lever range ${marker}`, 'lever', { salaryRange: { currency: 'usd', interval: 'per-year-salary', min: 90000, max: 120000 }, salaryDescriptionPlain: 'Legal text that is not pay.' });
    const leverTextOnly = await seed(`Lever text ${marker}`, 'lever', { salaryDescriptionPlain: 'The range depends on location and experience.' });
    const ashby = await seed(`Ashby salary ${marker}`, 'ashby', { compensation: { compensationTierSummary: '€110K – €185K • Offers Equity', summaryComponents: [
      { compensationType: 'EquityPercentage', interval: 'NONE', currencyCode: null, minValue: null, maxValue: null },
      { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'EUR', minValue: 110000, maxValue: 185000 },
    ] } });
    const ashbyMultiplier = await seed(`Ashby multiplier ${marker}`, 'ashby', { compensation: { summaryComponents: [{ compensationType: 'Salary', interval: '6 MONTH', currencyCode: 'USD', minValue: 30000, maxValue: 40000 }] } });
    const none = await seed(`No pay ${marker}`, 'lever', {});

    const listed = await api.get<ListedJob[] | { items: ListedJob[] }>(`/jobs?q=${encodeURIComponent(marker)}&scope=active&pageSize=100`);
    const items = Array.isArray(listed) ? listed : listed.items;
    const byId = new Map(items.map((job) => [job.id, job.compensation ?? null]));
    const expected: Array<[string, Compensation]> = [
      [lever, { min: 90000, max: 120000, currency: 'USD', period: 'YEAR', text: null, provider: 'lever' }],
      [leverTextOnly, null],
      [ashby, { min: 110000, max: 185000, currency: 'EUR', period: 'YEAR', text: null, provider: 'ashby' }],
      [ashbyMultiplier, { min: 30000, max: 40000, currency: 'USD', period: null, text: null, provider: 'ashby' }],
      [none, null],
    ];
    for (const [id, compensation] of expected) {
      assert.ok(byId.has(id), `The list returns job ${id}`);
      assert.deepEqual(byId.get(id), compensation, `GET /jobs compensation for ${id}`);
      const detail = await api.get<{ compensation: Compensation }>(`/jobs/${id}`);
      assert.deepEqual(detail.compensation ?? null, compensation, `GET /jobs/:id compensation for ${id}`);
    }
  },
};
