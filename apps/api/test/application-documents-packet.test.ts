import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { test } from 'node:test';
import { ApplicationPacketError, APPLICATION_PACKET_LIMIT, buildApplicationMaterialsZip, packetFileName, tryAcquireApplicationPacketDownload } from '../src/application-packet-routes.js';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

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
    await writeFile(join(root, 'resume.pdf'), first);
    await writeFile(join(root, 'letter.pdf'), second);
    const archive = await buildApplicationMaterialsZip(root, [
      { fileName: 'Example-Engineer-Resume-en.pdf', storagePath: 'resume.pdf', sha256: hash(first) },
      { fileName: 'Example-Engineer-Cover-Letter-en.pdf', storagePath: 'letter.pdf', sha256: hash(second) },
    ]);
    const entries = unzipSync(new Uint8Array(archive));
    assert.deepEqual(Object.keys(entries).sort(), ['Example-Engineer-Cover-Letter-en.pdf', 'Example-Engineer-Resume-en.pdf']);
    assert.deepEqual(Buffer.from(entries['Example-Engineer-Resume-en.pdf']!), first);
    assert.deepEqual(Buffer.from(entries['Example-Engineer-Cover-Letter-en.pdf']!), second);
    const subset = await buildApplicationMaterialsZip(root, [
      { fileName: 'Example-Engineer-Cover-Letter-en.pdf', storagePath: 'letter.pdf', sha256: hash(second) },
    ]);
    assert.deepEqual(Object.keys(unzipSync(new Uint8Array(subset))), ['Example-Engineer-Cover-Letter-en.pdf'], 'files the user did not select are omitted');
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
    const valid = { fileName: 'Resume.pdf', storagePath: 'approved.pdf', sha256: hash(content) };
    await assert.rejects(buildApplicationMaterialsZip(root, [{ ...valid, storagePath: 'missing.pdf' }]), (error: unknown) => error instanceof ApplicationPacketError && error.code === 'MATERIAL_NOT_AVAILABLE');
    await assert.rejects(buildApplicationMaterialsZip(root, [{ ...valid, sha256: '0'.repeat(64) }]), (error: unknown) => error instanceof ApplicationPacketError && error.code === 'MATERIAL_NOT_AVAILABLE');
    await assert.rejects(buildApplicationMaterialsZip(root, [{ ...valid, storagePath: '../outside.pdf' }]), (error: unknown) => error instanceof ApplicationPacketError && error.code === 'MATERIAL_NOT_AVAILABLE');
    await assert.rejects(buildApplicationMaterialsZip(root, [{ ...valid, storagePath: 'linked.pdf' }]), (error: unknown) => error instanceof ApplicationPacketError && error.code === 'MATERIAL_NOT_AVAILABLE');
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
    await assert.rejects(buildApplicationMaterialsZip(root, [{ fileName: 'Large.pdf', storagePath: 'large.pdf', sha256: '0'.repeat(64) }]), (error: unknown) => error instanceof ApplicationPacketError && error.statusCode === 413 && error.code === 'MATERIAL_PACKET_TOO_LARGE');
  } finally { await rm(root, { recursive: true, force: true }); }
});
