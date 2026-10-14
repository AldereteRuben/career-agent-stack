import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Scenario } from './scenarios.js';

type Fact = { id: string; statement: string; importId: string | null; approvalStatus: string };
type ProfileResponse = { revision: number; locale: string; profile: Record<string, unknown>; facts: Fact[] };

// Resume import, ADR 018 task T1: an import's entries stay grouped by import_id through profile saves and corrections,
// so undoing the import (T10) can reach every one of them. The import route itself is covered by test/fact-import.test.ts.
export const factImportScenarios: Scenario[] = [{
  name: 'imported-entries-keep-their-import-through-saves-and-corrections',
  async run({ api, db, marker }) {
    const importId = randomUUID();
    // Later scenarios count entries waiting for review, so everything this scenario adds is archived at the end.
    const archiveOwnEntries = async () => {
      for (const fact of (await api.get<ProfileResponse>('/profile')).facts.filter((item) => item.statement.endsWith(marker) && item.approvalStatus !== 'REJECTED')) await api.post(`/profile/facts/${fact.id}/reject`);
    };
    try {
      const created = await api.post<{ facts: Fact[] }>('/profile/facts/import', { importId, facts: [
        { kind: 'achievement', statement: `Imported achievement ${marker}` },
        { kind: 'skill', statement: `Imported skill ${marker}` },
      ] });
      assert.equal(created.facts.length, 2);
      const inImport = async () => (await db.query<{ statement: string }>('select statement from profile_facts f where import_id = $1 and profile_version_id = (select id from profile_versions where workspace_id = f.workspace_id order by revision desc limit 1) order by statement', [importId])).rows.map((row) => row.statement);

      // A profile save creates a new revision and copies every fact with its import_id.
      const before = await api.get<ProfileResponse>('/profile');
      await api.put('/profile', { expectedRevision: before.revision, locale: before.locale, profile: before.profile });
      assert.deepEqual(await inImport(), [`Imported achievement ${marker}`, `Imported skill ${marker}`]);

      // Correcting an imported entry keeps it in its import.
      const current = await api.get<ProfileResponse>('/profile');
      const target = current.facts.find((fact) => fact.statement === `Imported skill ${marker}`)!;
      await api.put(`/profile/facts/${target.id}`, { expectedRevision: current.revision, fact: { kind: 'skill', statement: `Corrected skill ${marker}` } });
      assert.deepEqual(await inImport(), [`Corrected skill ${marker}`, `Imported achievement ${marker}`]);

      // Facts entered by hand never join an import.
      const manual = await api.post<{ id: string }>('/profile/facts', { kind: 'skill', statement: `Manual skill ${marker}` });
      assert.equal((await db.query<{ import_id: string | null }>('select import_id from profile_facts where id = $1', [manual.id])).rows[0]!.import_id, null);
    } finally {
      await archiveOwnEntries();
    }
  },
}];
