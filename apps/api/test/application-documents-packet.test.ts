import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { test } from 'node:test';
import { ApplicationPacketError, APPLICATION_PACKET_LIMIT, buildApplicationMaterialsZip, packetFileName, tryAcquireApplicationPacketDownload } from '../src/application-packet-routes.js';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function collect(stream: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('application packet downloads have a process-wide concurrency limit and release idempotently', () => {
  const release = tryAcquireApplicationPacketDownload();
  assert.equal(typeof release, 'function');
  assert.equal(tryAcquireApplicationPacketDownload(), null, 'a concurrent download is rejected before allocating packet buffers');
  release!();
  release!();
  const nextRelease = tryAcquireApplicationPacketDownload();
  assert.equal(typeof nextRelease, 'function', 'the slot is available after release');
  nextRelease!();
});

test('application packet contains only the selected verified files and uses safe ZIP paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-application-packet-'));
  try {
    const first = Buffer.from('%PDF-1.7 fictional resume');
    const second = Buffer.from('%PDF-1.7 fictional cover letter');
    const firstText = Buffer.from('Fictional resume text', 'utf8');
    const secondText = Buffer.from('Fictional cover letter text', 'utf8');
    await writeFile(join(root, 'resume.pdf'), first);
    await writeFile(join(root, 'letter.pdf'), second);
    await writeFile(join(root, 'resume.txt'), firstText);
    await writeFile(join(root, 'letter.txt'), secondText);
    const archive = await collect(await buildApplicationMaterialsZip(root, [
      { id: 'revision:00000000-0000-4000-8000-000000000001', kind: 'RESUME', language: 'en', revision: 2, fileName: 'Example-Engineer-Resume-en.pdf', pdfStoragePath: 'resume.pdf', pdfSha256: hash(first), textStoragePath: 'resume.txt', textSha256: hash(firstText) },
      { id: 'revision:00000000-0000-4000-8000-000000000002', kind: 'COVER_LETTER', language: 'en', revision: 1, fileName: 'Example-Engineer-Cover-Letter-en.pdf', pdfStoragePath: 'letter.pdf', pdfSha256: hash(second), textStoragePath: 'letter.txt', textSha256: hash(secondText) },
    ]));
    const entries = unzipSync(new Uint8Array(archive));
    assert.deepEqual(Object.keys(entries).sort(), ['Example-Engineer-Cover-Letter-en.pdf', 'Example-Engineer-Cover-Letter-en.txt', 'Example-Engineer-Resume-en.pdf', 'Example-Engineer-Resume-en.txt', 'manifest.json']);
    assert.deepEqual(Buffer.from(entries['Example-Engineer-Resume-en.pdf']!), first);
    assert.deepEqual(Buffer.from(entries['Example-Engineer-Cover-Letter-en.pdf']!), second);
    assert.deepEqual(Buffer.from(entries['Example-Engineer-Resume-en.txt']!), firstText);
    assert.deepEqual(Buffer.from(entries['Example-Engineer-Cover-Letter-en.txt']!), secondText);
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']!).toString('utf8')) as { documents: Array<{ files: Array<{ name: string; sha256: string }> }> };
    assert.deepEqual(manifest.documents[0]!.files.map((file) => file.sha256), [hash(first), hash(firstText)]);
    const subset = await collect(await buildApplicationMaterialsZip(root, [
      { id: 'revision:00000000-0000-4000-8000-000000000002', kind: 'COVER_LETTER', language: 'en', revision: 1, fileName: 'Example-Engineer-Cover-Letter-en.pdf', pdfStoragePath: 'letter.pdf', pdfSha256: hash(second), textStoragePath: 'letter.txt', textSha256: hash(secondText) },
    ]));
    assert.deepEqual(Object.keys(unzipSync(new Uint8Array(subset))).sort(), ['Example-Engineer-Cover-Letter-en.pdf', 'Example-Engineer-Cover-Letter-en.txt', 'manifest.json'], 'files the user did not select are omitted');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('generated filenames remove traversal, control and reserved device-name characters', () => {
  const fileName = packetFileName('../CON. ', 'QA/Engineer\\\u0000', 'RESUME', 'en', 2);
  assert.equal(fileName.includes('/'), false);
  assert.equal(fileName.includes('\\'), false);
  assert.equal(/\p{Cc}/u.test(fileName), false);
  assert.equal(fileName, '_CON-QA-Engineer-Resume-2-en.pdf');
});

test('a missing, changed, escaping or duplicated file rejects the whole packet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-application-packet-invalid-'));
  try {
    const content = Buffer.from('%PDF-1.7 approved');
    await writeFile(join(root, 'approved.pdf'), content);
    await symlink(join(root, 'outside.pdf'), join(root, 'linked.pdf'));
    const text = Buffer.from('approved resume text');
    await writeFile(join(root, 'approved.txt'), text);
    const valid = { id: 'revision:00000000-0000-4000-8000-000000000001', kind: 'RESUME' as const, language: 'en', revision: 1, fileName: 'Resume.pdf', pdfStoragePath: 'approved.pdf', pdfSha256: hash(content), textStoragePath: 'approved.txt', textSha256: hash(text) };
    await assert.rejects(buildApplicationMaterialsZip(root, [{ ...valid, pdfStoragePath: 'missing.pdf' }]), (error: unknown) => error instanceof ApplicationPacketError && error.code === 'MATERIAL_NOT_AVAILABLE');
    await assert.rejects(buildApplicationMaterialsZip(root, [{ ...valid, pdfSha256: '0'.repeat(64) }]), (error: unknown) => error instanceof ApplicationPacketError && error.code === 'MATERIAL_NOT_AVAILABLE');
    await assert.rejects(buildApplicationMaterialsZip(root, [{ ...valid, pdfStoragePath: '../outside.pdf' }]), (error: unknown) => error instanceof ApplicationPacketError && error.code === 'MATERIAL_NOT_AVAILABLE');
    await assert.rejects(buildApplicationMaterialsZip(root, [{ ...valid, pdfStoragePath: 'linked.pdf' }]), (error: unknown) => error instanceof ApplicationPacketError && error.code === 'MATERIAL_NOT_AVAILABLE');
    await assert.rejects(buildApplicationMaterialsZip(root, [valid, { ...valid }]), (error: unknown) => error instanceof ApplicationPacketError && error.code === 'MATERIAL_PACKET_FILENAME_CONFLICT');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('files exceeding the packet limit are rejected before their contents are read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-application-packet-limit-'));
  try {
    const path = join(root, 'large.pdf');
    await writeFile(path, Buffer.alloc(1));
    const { truncate } = await import('node:fs/promises');
    await truncate(path, APPLICATION_PACKET_LIMIT + 1);
    await assert.rejects(buildApplicationMaterialsZip(root, [{ id: 'revision:00000000-0000-4000-8000-000000000001', kind: 'RESUME', language: 'en', revision: 1, fileName: 'Large.pdf', pdfStoragePath: 'large.pdf', pdfSha256: '0'.repeat(64), textStoragePath: 'unused.txt', textSha256: '0'.repeat(64) }]), (error: unknown) => error instanceof ApplicationPacketError && error.statusCode === 413 && error.code === 'MATERIAL_PACKET_TOO_LARGE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a 20-document ZIP contains 41 entries: PDF and text per revision plus one manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-application-packet-twenty-'));
  try {
    const files = [];
    for (let index = 0; index < 20; index += 1) {
      const pdf = Buffer.from(`%PDF-1.7 fixture ${index}`);
      const text = Buffer.from(`synthetic text ${index}`, 'utf8');
      const pdfStoragePath = `${index}.pdf`;
      const textStoragePath = `${index}.txt`;
      await writeFile(join(root, pdfStoragePath), pdf);
      await writeFile(join(root, textStoragePath), text);
      files.push({
        id: `revision:00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
        fileName: `Fictional-Company-Role-${index}-en.pdf`, kind: 'RESUME' as const, language: 'en', revision: 1,
        pdfStoragePath, pdfSha256: hash(pdf), textStoragePath, textSha256: hash(text),
      });
    }
    const archive = await collect(await buildApplicationMaterialsZip(root, files));
    assert.equal(Object.keys(unzipSync(new Uint8Array(archive))).length, 41);
  } finally { await rm(root, { recursive: true, force: true }); }
});
