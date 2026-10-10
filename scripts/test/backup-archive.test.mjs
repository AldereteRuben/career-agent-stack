// Unit tests for the backup archive format and its guards. No database needed.
//   node --test scripts/test/backup-archive.test.mjs
import assert from 'node:assert/strict';
import { readdir, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ARCHIVE_ROOT, ArchiveError, assertSafeRelativePath, buildHeader, extractArchive, safeJoin, writeArchive } from '../lib/backup-archive.mjs';
import { allowedArchiveName, keyFingerprint, manifestMac, validateManifest, verifyManifestMac } from '../lib/backup-core.mjs';

let work;
before(async () => { work = await mkdtemp(join(tmpdir(), 'career-archive-test-')); });
after(async () => { await rm(work, { recursive: true, force: true }); });

const fresh = async (name) => { const dir = join(work, name); await mkdir(dir); return dir; };
const block = (size) => Buffer.alloc(Math.ceil(size / 512) * 512);
/** Raw tar bytes from [name, content, options] tuples, bypassing the writer's own name checks. */
function rawTar(items, { end = true } = {}) {
  const parts = [];
  for (const [name, content, options] of items) {
    const data = Buffer.from(content);
    parts.push(buildHeader(name, data.length, options));
    const padded = block(data.length);
    data.copy(padded);
    parts.push(padded);
  }
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
async function expectRejected(bytes, code, allowName) {
  const file = join(work, `hostile-${Math.random().toString(16).slice(2)}.tar`);
  await writeFile(file, bytes);
  const dest = await fresh(`dest-${Math.random().toString(16).slice(2)}`);
  await assert.rejects(extractArchive(file, dest, { allowName }), (error) => error instanceof ArchiveError && error.code === code);
  return dest;
}

describe('path guards', () => {
  for (const name of ['../evil', 'a/../../evil', '/etc/passwd', 'C:/x', 'a\\b', '', 'a//b', './a', 'a/.', '.hidden', 'a/b\0c', 'ä/b', `${'a'.repeat(300)}`]) {
    test(`rejects ${JSON.stringify(name).slice(0, 40)}`, () => assert.throws(() => assertSafeRelativePath(name), ArchiveError));
  }
  test('accepts the document layout', () => assert.deepEqual(assertSafeRelativePath('files/4b4f-1/doc_1.pdf'), ['files', '4b4f-1', 'doc_1.pdf']));
  test('safeJoin stays inside the root', () => {
    assert.equal(safeJoin('/tmp/root', 'a/b.pdf'), resolve('/tmp/root/a/b.pdf'));
    assert.throws(() => safeJoin('/tmp/root', '../b.pdf'), ArchiveError);
  });
});

describe('writer and reader', () => {
  test('round trip keeps bytes, hashes and private permissions', async () => {
    const source = join(work, 'source.pdf');
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(700_000, 7)]);
    await writeFile(source, pdf);
    const archive = join(work, 'ok.tar');
    const longName = `files/${'a'.repeat(36)}/${'b'.repeat(36)}.pdf`;
    const written = await writeArchive(archive, [{ name: 'manifest.json', buffer: Buffer.from('{}') }, { name: longName, path: source }]);
    if (process.platform !== 'win32') assert.equal((await stat(archive)).mode & 0o777, 0o600); // no POSIX modes on Windows (#98)
    const dest = await fresh('roundtrip');
    const entries = await extractArchive(archive, dest);
    assert.deepEqual([...entries.keys()], ['manifest.json', longName]);
    assert.equal(entries.get(longName).sha256, written[1].sha256);
    assert.deepEqual(await readFile(entries.get(longName).path), pdf);
    if (process.platform !== 'win32') assert.equal((await stat(entries.get(longName).path)).mode & 0o777, 0o600); // no POSIX modes on Windows (#98)
  });

  test('writer refuses a file whose content differs from the expected hash', async () => {
    const source = join(work, 'changed.pdf');
    await writeFile(source, 'changed');
    await assert.rejects(writeArchive(join(work, 'changed.tar'), [{ name: 'x.pdf', path: source, sha256: '0'.repeat(64) }]), (error) => error.code === 'SOURCE_HASH_MISMATCH');
  });

  test('writer never overwrites an existing archive', async () => {
    const archive = join(work, 'exists.tar');
    await writeFile(archive, 'keep');
    await assert.rejects(writeArchive(archive, [{ name: 'a', buffer: Buffer.from('x') }]), { code: 'EEXIST' });
    assert.equal(await readFile(archive, 'utf8'), 'keep');
  });

  test('rejects path traversal and writes nothing outside the destination', async () => {
    const dest = await expectRejected(rawTar([[`${ARCHIVE_ROOT}/../escape.txt`, 'x']]), 'UNSAFE_PATH');
    await assert.rejects(stat(join(dest, '..', 'escape.txt')));
    await expectRejected(rawTar([['/etc/evil', 'x']]), 'UNSAFE_PATH');
    await expectRejected(rawTar([['other-root/file', 'x']]), 'UNSAFE_PATH');
  });
  test('rejects symlinks, hard links, directories and pax headers', async () => {
    await expectRejected(rawTar([[`${ARCHIVE_ROOT}/link`, '', { type: '2', linkname: '/etc/passwd' }]]), 'UNSUPPORTED_ENTRY');
    await expectRejected(rawTar([[`${ARCHIVE_ROOT}/hard`, '', { type: '1', linkname: `${ARCHIVE_ROOT}/a` }]]), 'UNSUPPORTED_ENTRY');
    await expectRejected(rawTar([[`${ARCHIVE_ROOT}/dir`, '', { type: '5' }]]), 'UNSUPPORTED_ENTRY');
    await expectRejected(rawTar([[`${ARCHIVE_ROOT}/pax`, 'path=../../x\n', { type: 'x' }]]), 'UNSUPPORTED_ENTRY');
  });
  test('rejects duplicates, including case-only duplicates', async () => {
    await expectRejected(rawTar([[`${ARCHIVE_ROOT}/a.pdf`, '1'], [`${ARCHIVE_ROOT}/A.pdf`, '2']]), 'DUPLICATE_ENTRY');
  });
  test('rejects names the caller does not allow', async () => {
    await expectRejected(rawTar([[`${ARCHIVE_ROOT}/notes.txt`, 'x']]), 'UNEXPECTED_ENTRY', allowedArchiveName);
  });
  test('rejects truncated archives, missing end marker and trailing data', async () => {
    const good = rawTar([[`${ARCHIVE_ROOT}/a`, 'x'.repeat(2000)]]);
    await expectRejected(good.subarray(0, 1536), 'TRUNCATED');
    await expectRejected(rawTar([[`${ARCHIVE_ROOT}/a`, 'x']], { end: false }), 'TRUNCATED');
    await expectRejected(Buffer.concat([good, Buffer.from('extra'.padEnd(512, '!'))]), 'TRAILING_DATA');
  });
  test('rejects a header with a wrong checksum', async () => {
    const bytes = rawTar([[`${ARCHIVE_ROOT}/a`, 'x']]);
    bytes[0] ^= 1;
    await expectRejected(bytes, 'BAD_HEADER');
  });
  test('rejects an oversized size field that points past the end', async () => {
    const header = buildHeader(`${ARCHIVE_ROOT}/a`, 10 * 1024 * 1024);
    await expectRejected(Buffer.concat([header, Buffer.alloc(1536)]), 'TRUNCATED');
  });
  test('nothing escapes even when extraction fails midway', async () => {
    const dest = await expectRejected(rawTar([[`${ARCHIVE_ROOT}/ok`, 'fine'], [`${ARCHIVE_ROOT}/../../bad`, 'x']]), 'UNSAFE_PATH');
    assert.deepEqual(await readdir(dest), ['ok']); // only the valid entry, inside the destination
  });
});

describe('manifest authentication', () => {
  const key = 'k'.repeat(44);
  const manifest = () => ({
    format: 'career-agent-stack-backup', formatVersion: 1, tools: { pgDumpMajor: 18, pgDump: '18.4' }, tables: { 'public.workspaces': 1 }, migrations: [],
    encryption: { keyFingerprint: keyFingerprint(key) },
    documents: [{ id: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', storagePath: '22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111.pdf', sha256: 'a'.repeat(64), archivePath: 'files/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111.pdf' }],
    entries: [{ path: 'database.pgdump', size: 1, sha256: 'b'.repeat(64) }, { path: 'files/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111.pdf', size: 1, sha256: 'a'.repeat(64) }],
  });
  test('HMAC verifies only the exact bytes with the right key', () => {
    const bytes = Buffer.from(JSON.stringify(manifest()));
    const mac = manifestMac(key, bytes);
    assert.ok(verifyManifestMac(key, bytes, mac));
    assert.ok(!verifyManifestMac('x'.repeat(44), bytes, mac));
    assert.ok(!verifyManifestMac(key, Buffer.from(JSON.stringify({ ...manifest(), tables: { 'public.workspaces': 2 } })), mac));
    assert.ok(!verifyManifestMac(key, bytes, 'zz'));
  });
  test('fingerprint does not contain the key', () => {
    assert.match(keyFingerprint(key), /^[0-9a-f]{32}$/);
    assert.notEqual(keyFingerprint(key), keyFingerprint(`${key}x`));
  });
  test('valid manifest passes; hostile variants fail', () => {
    assert.ok(validateManifest(manifest()));
    const variants = [
      (m) => { m.documents[0].storagePath = '../../etc/passwd'; },
      (m) => { m.documents[0].archivePath = 'files/other.pdf'; },
      (m) => { m.entries.push({ path: 'files/extra.pdf', size: 1, sha256: 'c'.repeat(64) }); },
      (m) => { m.entries.push({ path: 'manifest.json', size: 1, sha256: 'c'.repeat(64) }); },
      (m) => { m.entries[0].path = 'notes.txt'; },
      (m) => { m.entries = m.entries.slice(1); },
      (m) => { m.formatVersion = 2; },
      (m) => { m.tables = { 'pg_catalog.pg_authid': 1 }; },
      (m) => { m.documents[0].id = 'not-a-uuid'; },
      (m) => { m.entries[0].size = -1; },
    ];
    for (const change of variants) {
      const value = manifest();
      change(value);
      assert.throws(() => validateManifest(value), ArchiveError);
    }
  });
});


describe('publishing on external filesystems', () => {
  test('falls back to exclusive copy when hard links are unsupported', async () => {
    const { publishArchive } = await import('../lib/backup-archive.mjs');
    const dir = await mkdtemp(join(tmpdir(), 'career-publish-test-'));
    try {
      const source = join(dir, 'source'); const destination = join(dir, 'destination');
      await writeFile(source, 'verified backup bytes', { mode: 0o600 });
      const linkFile = async () => { throw Object.assign(new Error('No hard links'), { code: 'ENOTSUP' }); };
      await publishArchive(source, destination, { linkFile });
      assert.equal(await readFile(destination, 'utf8'), 'verified backup bytes');
      await writeFile(source, 'replacement');
      await assert.rejects(publishArchive(source, destination, { linkFile }), { code: 'EEXIST' });
      assert.equal(await readFile(destination, 'utf8'), 'verified backup bytes');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
