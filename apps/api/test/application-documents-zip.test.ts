import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@career/db';
import { applicationDocumentHashes, latestApplicationDocumentOffer } from '@career/domain';
import { unzipSync } from 'fflate';
import { registerApplicationPacketRoutes } from '../src/application-packet-routes.js';

const root = new URL('../../../', import.meta.url);
const { Client, Pool } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_APPLICATION_DOCUMENTS_TEST_ADMIN_URL;
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

test('application ZIP route validates scoped, current approved revisions and streams a private manifest', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname));
  assert.equal(maintenance.pathname, '/postgres');
  const databaseName = `career_document_zip_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() });
  const logLines: string[] = [];
  const stderrLines: string[] = [];
  const originalStderrWrite = process.stderr.write;
  const originalFetch = globalThis.fetch;
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    stderrLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    return Reflect.apply(originalStderrWrite, process.stderr, [chunk, ...args]);
  }) as typeof process.stderr.write;
  const app = Fastify({ logger: { level: 'trace', stream: { write: (line: string) => { logLines.push(line); } } } });
  const filesRoot = await mkdtemp(join(tmpdir(), 'career-document-zip-'));
  let client: InstanceType<typeof Client> | undefined;
  let pool: InstanceType<typeof Pool> | undefined;
  let closePool: (() => Promise<void>) | undefined;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    maintenance.pathname = `/${databaseName}`;
    client = new Client({ connectionString: maintenance.toString() });
    await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((entry) => /^\d{4}_.*\.sql$/u.test(entry)).sort()) {
      const source = await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8');
      for (const statement of source.split('--> statement-breakpoint').filter((part) => part.trim())) await client.query(statement);
    }
    pool = new Pool({ connectionString: maintenance.toString(), max: 4 });
    closePool = trackPgPoolCleanup(pool);
    const database = drizzle(pool, { schema });
    const workspaceId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const jobId = randomUUID();
    const snapshotId = randomUUID();
    const profileVersionId = randomUUID();
    const factId = randomUUID();
    const applicationId = randomUUID();
    const otherApplicationId = randomUUID();
    const documentId = randomUUID();
    const otherDocumentId = randomUUID();
    const firstRevisionId = randomUUID();
    const pendingRevisionId = randomUUID();
    const otherRevisionId = randomUUID();
    await client.query('INSERT INTO workspaces(id) VALUES($1),($2)', [workspaceId, foreignWorkspaceId]);
    await client.query("INSERT INTO jobs(id,workspace_id,company,title,availability) VALUES($1,$2,'Sentinel Company Ñ','Synthetic Role','OPEN')", [jobId, workspaceId]);
    await client.query("INSERT INTO applications(id,workspace_id,job_id,company,role,location,application_cycle) VALUES($1,$2,$3,'Sentinel Company Ñ','Synthetic Role','Remote',1),($4,$2,$3,'Another Synthetic Company','Another Role','Remote',2)", [applicationId, workspaceId, jobId, otherApplicationId]);
    const fetchedAt = new Date();
    await client.query("INSERT INTO job_snapshots(id,workspace_id,job_id,title,description_text,snapshot_hash,fetched_at) VALUES($1,$2,$3,'Synthetic Role','Synthetic offer text','synthetic-offer-hash',$4)", [snapshotId, workspaceId, jobId, fetchedAt]);
    await client.query("INSERT INTO profile_versions(id,workspace_id,revision,profile) VALUES($1,$2,1,$3)", [profileVersionId, workspaceId, { identity: { fullName: 'Synthetic Candidate Private', email: 'private@example.test', phone: '+34 600 123 456' }, notes: 'SENTINEL_PRIVATE_NOTE_76A2', unrelatedContact: 'alternate@example.test' }]);
    await client.query("INSERT INTO profile_facts(id,workspace_id,profile_version_id,kind,statement,approval_status) VALUES($1,$2,$3,'experience','SENTINEL_CITED_FACT_76A2','USER_APPROVED')", [factId, workspaceId, profileVersionId]);
    await client.query("INSERT INTO application_documents(id,workspace_id,application_id,kind,language) VALUES($1,$2,$3,'RESUME','en'),($4,$2,$5,'RESUME','en')", [documentId, workspaceId, applicationId, otherDocumentId, otherApplicationId]);

    const offer = latestApplicationDocumentOffer({ workspaceId, company: 'Sentinel Company Ñ', role: 'Synthetic Role', location: 'Remote', snapshots: [{ id: snapshotId, title: 'Synthetic Role', descriptionText: 'Synthetic offer text', fetchedAt: fetchedAt.toISOString() }] });
    const claim = { sentenceId: 'synthetic-claim', text: 'SENTINEL_CITED_FACT_76A2', kind: 'CANDIDATE_CLAIM' as const, origin: 'BUILDER' as const, sourceFactIds: [factId], language: 'en' as const };
    const factSnapshots = [{ id: factId, workspaceId, approval: 'USER_APPROVED' as const, text: 'SENTINEL_CITED_FACT_76A2', tags: [] }];
    const hashes = await applicationDocumentHashes({ workspaceId, claims: [claim], facts: factSnapshots, offer });
    assert.equal(hashes.ok, true);
    const pdf = Buffer.from('%PDF-1.7\nSENTINEL_PRIVATE_DOCUMENT_76A2\nSENTINEL_CITED_FACT_76A2\n');
    const text = Buffer.from('SENTINEL_PRIVATE_TEXT_76A2\nSENTINEL_CITED_FACT_76A2\n', 'utf8');
    const row = (id: string, document: string, revision: number, approved: boolean, stem: string, claims = [claim]) => ({
      id, workspaceId, documentId: document, revision, parentRevision: null, claims, contentHash: digest(`content-${id}`),
      offerSnapshotId: snapshotId, offerHash: hashes.ok ? hashes.offerHash : '', factsHash: hashes.ok ? hashes.factsHash : '', paperSize: 'A4',
      textStoragePath: `${stem}.txt`, textSha256: digest(text), pdfStoragePath: `${stem}.pdf`, pdfSha256: digest(pdf), confirmedUnsupportedIds: [],
      approvedAt: approved ? new Date() : null, approvedBy: approved ? 'USER' : null,
    });
    await database.insert(schema.applicationDocumentRevisions).values([
      row(firstRevisionId, documentId, 1, true, 'first'),
      row(pendingRevisionId, documentId, 2, false, 'pending'),
      row(otherRevisionId, otherDocumentId, 1, true, 'other'),
    ]);
    for (const stem of ['first', 'pending', 'other']) {
      await writeFile(join(filesRoot, `${stem}.pdf`), pdf, { mode: 0o600 });
      await writeFile(join(filesRoot, `${stem}.txt`), text, { mode: 0o600 });
    }
    const workspace = (request: { headers: Record<string, unknown> }) => request.headers['x-fixture-workspace'] === foreignWorkspaceId ? foreignWorkspaceId : workspaceId;
    registerApplicationPacketRoutes(app, workspace, { database, filesRoot });
    let outboundRequests = 0;
    globalThis.fetch = (async () => { outboundRequests += 1; throw new Error('unexpected outbound request'); }) as typeof fetch;
    const headers = { 'x-fixture-workspace': workspaceId };
    const url = `/api/v1/applications/${applicationId}/materials`;
    const listing = await app.inject({ url, headers });
    assert.equal(listing.statusCode, 200, listing.body);
    const available = listing.json().files.find((item: { id: string }) => item.id === `revision:${firstRevisionId}`);
    assert.equal(available.selectable, true);
    assert.equal(available.newerPendingRevision, true);
    const before = Number((await client.query('SELECT count(*)::int AS count FROM application_document_revisions WHERE workspace_id=$1', [workspaceId])).rows[0]!.count);
    const response = await app.inject({ method: 'POST', url: `/api/v1/applications/${applicationId}/materials.zip`, headers, payload: { fileIds: [`revision:${firstRevisionId}`] } });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.headers['content-type']!, /application\/zip/u);
    const archive = Buffer.from(response.rawPayload);
    const entries = unzipSync(new Uint8Array(archive));
    assert.equal(Object.keys(entries).length, 3);
    const pdfName = Object.keys(entries).find((name) => name.endsWith('.pdf'))!;
    const textName = Object.keys(entries).find((name) => name.endsWith('.txt'))!;
    assert.deepEqual(Buffer.from(entries[pdfName]!), pdf);
    assert.deepEqual(Buffer.from(entries[textName]!), text);
    const localHeader = archive.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const centralHeader = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.equal(archive.readUInt16LE(localHeader + 6) & 0x0800, 0x0800);
    assert.equal(archive.readUInt16LE(centralHeader + 8) & 0x0800, 0x0800);
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']!).toString('utf8')) as { documents: Array<{ files: Array<{ sha256: string }> }> };
    assert.deepEqual(manifest.documents[0]!.files.map((file) => file.sha256), [digest(pdf), digest(text)]);
    for (const privateText of ['SENTINEL_PRIVATE_DOCUMENT_76A2', 'SENTINEL_PRIVATE_TEXT_76A2', 'SENTINEL_CITED_FACT_76A2']) {
      assert.equal(archive.includes(Buffer.from(privateText)), true, 'selected document content appears only in the archive entries');
      assert.equal(JSON.stringify(manifest).includes(privateText), false, 'manifest does not contain profile or document text');
    }
    for (const privateText of ['Synthetic Candidate Private', 'private@example.test', '+34 600 123 456', 'SENTINEL_PRIVATE_NOTE_76A2', 'alternate@example.test']) assert.equal(archive.includes(Buffer.from(privateText)), false, 'profile identity, notes and unrelated contact data are excluded from archive entries');
    assert.equal(Number((await client.query('SELECT count(*)::int AS count FROM application_document_revisions WHERE workspace_id=$1', [workspaceId])).rows[0]!.count), before, 'selection and ZIP generation persist no DB rows');
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/applications/${applicationId}/materials.zip`, headers, payload: { fileIds: [`revision:${pendingRevisionId}`] } })).statusCode, 409, 'unapproved revisions are refused');
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/applications/${applicationId}/materials.zip`, headers, payload: { fileIds: [`revision:${otherRevisionId}`] } })).statusCode, 409, 'revisions belonging to another application are refused');
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/applications/${applicationId}/materials.zip`, headers: { 'x-fixture-workspace': foreignWorkspaceId }, payload: { fileIds: [`revision:${firstRevisionId}`] } })).statusCode, 404, 'cross-workspace application ids are hidden');
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/applications/${applicationId}/materials.zip`, headers, payload: { fileIds: Array.from({ length: 21 }, () => `revision:${randomUUID()}`) } })).statusCode, 400, '21 requested revisions are refused before selection');
    await database.update(schema.applicationDocumentRevisions).set({ approvedAt: new Date(), approvedBy: 'USER' }).where(eq(schema.applicationDocumentRevisions.id, pendingRevisionId));
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/applications/${applicationId}/materials.zip`, headers, payload: { fileIds: [`revision:${firstRevisionId}`] } })).statusCode, 409, 'a superseded approval is refused');
    await database.update(schema.applicationDocumentRevisions).set({ factsHash: '0'.repeat(64) }).where(eq(schema.applicationDocumentRevisions.id, pendingRevisionId));
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/applications/${applicationId}/materials.zip`, headers, payload: { fileIds: [`revision:${pendingRevisionId}`] } })).statusCode, 409, 'a stale approved revision is refused');
    const oversizedPath = join(filesRoot, 'oversized.pdf');
    await writeFile(oversizedPath, Buffer.alloc(1));
    await truncate(oversizedPath, 30_000_001);
    await database.update(schema.applicationDocumentRevisions).set({ factsHash: hashes.ok ? hashes.factsHash : '', pdfStoragePath: 'oversized.pdf' }).where(eq(schema.applicationDocumentRevisions.id, pendingRevisionId));
    const oversized = await app.inject({ method: 'POST', url: `/api/v1/applications/${applicationId}/materials.zip`, headers, payload: { fileIds: [`revision:${pendingRevisionId}`] } });
    assert.equal(oversized.statusCode, 413);
    assert.deepEqual(oversized.json(), { error: 'MATERIAL_PACKET_TOO_LARGE' }, 'oversized selection returns an error and no partial ZIP');
    globalThis.fetch = originalFetch;
    assert.equal(outboundRequests, 0, 'building and downloading a packet never contacts an external service');
    for (const line of [...logLines, ...stderrLines]) {
      assert.equal(line.includes('Sentinel-Company-Ñ-Synthetic-Role-Resume-1-en.pdf'), false, 'generated filename data is redacted from logs');
      assert.equal(line.includes('SENTINEL_PRIVATE_DOCUMENT_76A2'), false, 'PDF content is redacted from logs');
      assert.equal(line.includes('SENTINEL_PRIVATE_TEXT_76A2'), false, 'text content is redacted from logs');
      assert.equal(line.includes('SENTINEL_CITED_FACT_76A2'), false, 'cited fact text is redacted from logs');
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalStderrWrite;
    await app.close();
    await closePool?.();
    await client?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
    await rm(filesRoot, { recursive: true, force: true });
  }
});
