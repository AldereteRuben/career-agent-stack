// Backup encryption (ADR 019) with fictional data only. Runs on Linux, macOS and Windows.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { keyFileContent, keyFingerprint, readKeyFile } from '../lib/backup-core.mjs';
import { AGE_HEADER, ageIdentity, decryptFile, encryptFile, isAgeFile, parseIcacls, privateTempDir, restrictToCurrentUser } from '../lib/backup-crypto.mjs';

const key = 'fictional-installation-key-0123456789abcdef0123456789';
const otherKey = 'another-fictional-key-0123456789abcdef0123456789abcdef';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function workspace(run) {
  const dir = await mkdtemp(join(tmpdir(), 'career-crypto-test-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('a backup round-trips through age across many 64 KiB chunks', () => workspace(async (dir) => {
  const data = randomBytes(3 * 65_536 + 1_234);
  await writeFile(join(dir, 'backup.tar'), data);
  await encryptFile(join(dir, 'backup.tar'), join(dir, 'backup.tar.age'), key);
  const encrypted = await readFile(join(dir, 'backup.tar.age'));
  assert.equal(encrypted.subarray(0, AGE_HEADER.length).toString('latin1'), AGE_HEADER);
  assert.equal(encrypted.includes(data.subarray(0, 64)), false, 'No plaintext in the encrypted file');
  await decryptFile(join(dir, 'backup.tar.age'), join(dir, 'restored.tar'), key);
  assert.equal(sha(await readFile(join(dir, 'restored.tar'))), sha(data));
}));

test('a wrong key, a truncated file or an altered byte is refused and leaves no plaintext', () => workspace(async (dir) => {
  await writeFile(join(dir, 'backup.tar'), randomBytes(200_000));
  await encryptFile(join(dir, 'backup.tar'), join(dir, 'good.age'), key);
  const encrypted = await readFile(join(dir, 'good.age'));
  await writeFile(join(dir, 'truncated.age'), encrypted);
  await truncate(join(dir, 'truncated.age'), encrypted.length - 100);
  const altered = Buffer.from(encrypted); altered[Math.floor(altered.length / 2)] ^= 0x01;
  await writeFile(join(dir, 'altered.age'), altered);
  for (const [file, decryptWith] of [['good.age', otherKey], ['truncated.age', key], ['altered.age', key]]) {
    await assert.rejects(decryptFile(join(dir, file), join(dir, `${file}.out`), decryptWith), `${file} with ${decryptWith === key ? 'the right' : 'a wrong'} key`);
    assert.equal((await readdir(dir)).includes(`${file}.out`), false, `${file}: partial plaintext removed`);
  }
}));

test('an existing destination is never overwritten', () => workspace(async (dir) => {
  await writeFile(join(dir, 'backup.tar'), 'fictional');
  await writeFile(join(dir, 'taken.age'), 'keep me');
  await assert.rejects(encryptFile(join(dir, 'backup.tar'), join(dir, 'taken.age'), key));
  assert.equal(await readFile(join(dir, 'taken.age'), 'utf8'), 'keep me');
}));

test('age files are told apart from plain tar backups', () => workspace(async (dir) => {
  await writeFile(join(dir, 'plain.tar'), Buffer.alloc(1024));
  await writeFile(join(dir, 'short'), 'age');
  await writeFile(join(dir, 'source'), 'fictional');
  await encryptFile(join(dir, 'source'), join(dir, 'source.age'), key);
  assert.equal(await isAgeFile(join(dir, 'source.age')), true);
  assert.equal(await isAgeFile(join(dir, 'plain.tar')), false);
  assert.equal(await isAgeFile(join(dir, 'short')), false);
}));

test('the age identity is derived from the key: stable, valid and independent of the other derived keys', () => {
  const identity = ageIdentity(key);
  assert.match(identity, /^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/);
  assert.equal(ageIdentity(key), identity);
  assert.notEqual(ageIdentity(otherKey), identity);
  assert.equal(identity.toLowerCase().includes(keyFingerprint(key)), false);
});

test('key file version 2 carries the age identity; versions 1 and 2 are read, others are refused', () => workspace(async (dir) => {
  const v2 = JSON.parse(keyFileContent(key, ageIdentity(key)));
  assert.equal(v2.formatVersion, 2);
  assert.equal(v2.ageIdentity, ageIdentity(key));
  await writeFile(join(dir, 'v2.json'), JSON.stringify(v2));
  await writeFile(join(dir, 'v1.json'), JSON.stringify({ ...v2, formatVersion: 1, ageIdentity: undefined }));
  await writeFile(join(dir, 'v3.json'), JSON.stringify({ ...v2, formatVersion: 3 }));
  assert.equal((await readKeyFile(join(dir, 'v2.json'))).key, key);
  assert.equal((await readKeyFile(join(dir, 'v1.json'))).key, key, 'Key files written before encryption still restore');
  await assert.rejects(readKeyFile(join(dir, 'v3.json')));
}));

test('icacls output is parsed into the principals that have access', () => {
  const path = 'C:\\Users\\Ana\\AppData\\Local\\Temp\\career-restore-abc';
  assert.deepEqual(parseIcacls(`${path} DESKTOP-1\\Ana:(OI)(CI)(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`, path), ['DESKTOP-1\\Ana']);
  assert.deepEqual(parseIcacls(`${path} DESKTOP-1\\Ana:(OI)(CI)(F)\n          BUILTIN\\Administrators:(OI)(CI)(F)\n\nSuccessfully processed 1 files; Failed processing 0 files\n`, path), ['DESKTOP-1\\Ana', 'BUILTIN\\Administrators']);
  assert.deepEqual(parseIcacls('Some other path NOBODY:(F)\n', path), []);
});

test('a Windows folder is accepted only when its ACL lists the current user alone', () => {
  const calls = [];
  const fake = (listing) => (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'whoami') return '"DESKTOP-1\\ana","S-1-5-21-1-2-3-1001"\r\n';
    return args.length === 1 ? listing : 'processed';
  };
  const path = 'C:\\Temp\\career-restore-abc';
  restrictToCurrentUser(path, fake(`${path} DESKTOP-1\\Ana:(OI)(CI)(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`));
  assert.ok(calls.some((call) => call === `icacls ${path} /inheritance:r /grant:r *S-1-5-21-1-2-3-1001:(OI)(CI)F`), 'Inheritance removed and access granted by SID');
  assert.throws(() => restrictToCurrentUser(path, fake(`${path} DESKTOP-1\\ana:(OI)(CI)(F)\r\n         Everyone:(R)\r\n`)), /could not be restricted/);
  assert.throws(() => restrictToCurrentUser(path, fake('')), /could not be restricted/);
});

test('explicit entries for other principals, which /inheritance:r keeps, are removed one by one', () => {
  const path = 'C:\\Temp\\career-restore-abc';
  const removed = [];
  const run = (command, args) => {
    if (command === 'whoami') return '"DESKTOP-1\\ana","S-1-5-21-1-2-3-1001"\r\n';
    if (args[1] === '/remove:g') { removed.push(args[2]); return 'processed'; }
    if (args.length > 1) return 'processed';
    const entries = ['NT AUTHORITY\\SYSTEM:(OI)(CI)(F)', 'BUILTIN\\Administrators:(OI)(CI)(F)', 'DESKTOP-1\\ana:(OI)(CI)(F)'].filter((entry) => !removed.some((name) => entry.startsWith(`${name}:`)));
    return `${path} ${entries.join('\r\n    ')}\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`;
  };
  restrictToCurrentUser(path, run);
  assert.deepEqual(removed, ['NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators']);
});

test('the temporary folder for decrypted backups is private on this system', async () => {
  const folder = await privateTempDir('career-crypto-private-');
  try {
    if (process.platform === 'win32') {
      const principals = parseIcacls(execFileSync('icacls', [folder], { encoding: 'utf8' }), folder);
      const user = execFileSync('whoami', { encoding: 'utf8' }).trim();
      assert.deepEqual(principals.map((name) => name.toLowerCase()), [user.toLowerCase()], 'Only the current user has access');
    } else {
      assert.equal((await stat(folder)).mode & 0o777, 0o700);
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

// The official age tool must decrypt a backup with the identity from the key file (ADR 019). CI installs age and sets
// CAREER_AGE_CLI_TEST=1 so this cannot be skipped there; elsewhere it runs only when age is installed.
const ageInstalled = (() => { try { execFileSync('age', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('the official age tool decrypts a backup with the key file identity', { skip: !ageInstalled && process.env.CAREER_AGE_CLI_TEST !== '1' && 'age is not installed' }, () => workspace(async (dir) => {
  assert.ok(ageInstalled, 'CAREER_AGE_CLI_TEST=1 requires the age command');
  const data = randomBytes(150_000);
  await writeFile(join(dir, 'backup.tar'), data);
  await encryptFile(join(dir, 'backup.tar'), join(dir, 'backup.tar.age'), key);
  await writeFile(join(dir, 'identity.txt'), `${JSON.parse(keyFileContent(key, ageIdentity(key))).ageIdentity}\n`, { mode: 0o600 });
  execFileSync('age', ['--decrypt', '--identity', join(dir, 'identity.txt'), '--output', join(dir, 'cli.tar'), join(dir, 'backup.tar.age')]);
  assert.equal(sha(await readFile(join(dir, 'cli.tar'))), sha(data));
}));
