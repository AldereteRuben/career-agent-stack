import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { disable, enable, isEnabled, launchAgent, renderStatus, statusMessage, systemdUnit } from '../autostart.mjs';

function temporary() { return mkdtempSync(join(tmpdir(), 'career-autostart-')); }

test('LaunchAgent reuses the local launcher without opening a browser and escapes XML values', () => {
  const plist = launchAgent({ node: '/Users/Ruben/bin/node&24', root: '/Users/Ruben/Career <Stack>', path: '/usr/bin:/bin', home: '/Users/Ruben' });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<string>--no-open<\/string>/);
  assert.match(plist, /node&amp;24/);
  assert.match(plist, /Career &lt;Stack&gt;/);
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>/);
});

test('systemd user unit runs the same launcher as a one-shot without a shell or browser', () => {
  const unit = systemdUnit({ node: '/home/ruben/node 24/bin/node', root: '/home/ruben/Career Stack', path: '/home/ruben/.local/bin:/usr/bin', home: '/home/ruben' });
  assert.match(unit, /Type=oneshot/);
  assert.match(unit, /RemainAfterExit=yes/);
  assert.match(unit, /WorkingDirectory=\/home\/ruben\/Career Stack\n/);
  assert.doesNotMatch(unit, /WorkingDirectory="/);
  assert.match(unit, /ExecStart="\/home\/ruben\/node 24\/bin\/node" "\/home\/ruben\/Career Stack\/scripts\/launch\.mjs" --no-open/);
  assert.match(unit, /ExecStop=.*scripts\/stop\.mjs/);
  assert.doesNotMatch(unit, /\/bin\/sh/);
});

test('generated macOS plist passes plutil on macOS', { skip: process.platform !== 'darwin' }, () => {
  const home = temporary(); const file = join(home, 'agent.plist');
  try {
    writeFileSync(file, launchAgent());
    const result = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('generated Linux unit passes systemd-analyze when available', { skip: process.platform !== 'linux' }, () => {
  const home = temporary(); const file = join(home, 'career-agent-stack.service');
  try {
    writeFileSync(file, systemdUnit());
    const result = spawnSync('systemd-analyze', ['verify', file], { encoding: 'utf8' });
    if (result.error?.code === 'ENOENT') return;
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('status reports user-manager state and treats unsupported Windows as unavailable', () => {
  const home = temporary();
  try {
    const unit = join(home, '.config', 'systemd', 'user', 'career-agent-stack.service');
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
    assert.deepEqual(renderStatus({ platform: 'linux', home }), { supported: true, enabled: false });
    writeFileSync(unit, '[Service]\n');
    assert.equal(isEnabled({ platform: 'linux', home, exec: (_command, args) => ({ status: args.includes('is-enabled') ? 0 : 0 }) }), true);
    assert.equal(isEnabled({ platform: 'linux', home, exec: (_command, args) => ({ status: args.includes('show-environment') ? 0 : 1 }) }), false);
    assert.equal(isEnabled({ platform: 'linux', home, exec: () => ({ status: 1 }) }), null);
    assert.deepEqual(statusMessage({ supported: true, enabled: null }), ['Inicio automático: no se pudo comprobar.', 'Autostart: could not be checked.']);
    assert.deepEqual(renderStatus({ platform: 'win32', home }), { supported: false, enabled: false });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('macOS status is unknown when launchd cannot inspect the user session', () => {
  const home = temporary(); const file = join(home, 'Library', 'LaunchAgents', 'com.careeragentstack.launcher.plist');
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true }); writeFileSync(file, 'plist');
  try {
    assert.deepEqual(renderStatus({ platform: 'darwin', home, uid: 501, exec: () => ({ status: 1 }) }), { supported: true, enabled: null });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('enable writes a private Linux user unit and calls only user-scoped systemctl commands', () => {
  const home = temporary(); const root = join(home, 'checkout'); const calls = [];
  mkdirSync(root); writeFileSync(join(root, '.env'), 'PRIVATE=do-not-copy\n');
  try {
    enable({ platform: 'linux', home, root, node: '/usr/bin/node', nodeMajor: 24, path: '/usr/bin', exec: (command, args) => { calls.push([command, args]); return { status: 0 }; } });
    const unit = join(home, '.config', 'systemd', 'user', 'career-agent-stack.service');
    const contents = readFileSync(unit, 'utf8');
    assert.match(contents, /--no-open/);
    assert.doesNotMatch(contents, /PRIVATE=do-not-copy/);
    assert.equal(statSync(unit).mode & 0o777, 0o600);
    assert.deepEqual(calls.map(([command, args]) => [command, args.join(' ')]), [
      ['systemctl', '--user show-environment'], ['systemctl', '--user daemon-reload'], ['systemctl', '--user enable --now career-agent-stack.service'],
    ]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('disable unloads autostart, stops launcher-owned services, and removes its files', () => {
  const home = temporary(); const root = join(home, 'checkout'); const calls = []; let stopped = 0;
  const unitDir = join(home, '.config', 'systemd', 'user'); const unit = join(unitDir, 'career-agent-stack.service');
  mkdirSync(unitDir, { recursive: true }); writeFileSync(unit, 'unit');
  try {
    disable({ platform: 'linux', home, root, exec: (command, args) => { calls.push([command, args]); return { status: 0 }; }, stopServices: () => { stopped++; return { status: 0 }; } });
    assert.equal(stopped, 1);
    assert.equal(existsSync(unit), false);
    assert.deepEqual(calls.map(([command, args]) => [command, args.join(' ')]), [
      ['systemctl', '--user disable --now career-agent-stack.service'], ['systemctl', '--user daemon-reload'],
    ]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('disable keeps configuration when owned services cannot be confirmed stopped', () => {
  const home = temporary(); const root = join(home, 'checkout');
  const unitDir = join(home, '.config', 'systemd', 'user'); const unit = join(unitDir, 'career-agent-stack.service');
  mkdirSync(unitDir, { recursive: true }); writeFileSync(unit, 'unit');
  try {
    assert.throws(() => disable({ platform: 'linux', home, root, exec: () => ({ status: 0 }), stopServices: () => ({ status: 1 }) }), /configuration was kept|was kept for inspection/);
    assert.equal(existsSync(unit), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('enable leaves no file when the Linux user manager is unavailable', () => {
  const home = temporary(); const root = join(home, 'checkout');
  mkdirSync(root); writeFileSync(join(root, '.env'), 'PRIVATE=do-not-copy\n');
  try {
    assert.throws(() => enable({ platform: 'linux', home, root, nodeMajor: 24, exec: () => ({ status: 1 }) }), /user manager is unavailable/);
    assert.equal(existsSync(join(home, '.config', 'systemd', 'user', 'career-agent-stack.service')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('macOS enable keeps its plist if launchd cannot confirm that it loaded', () => {
  const home = temporary(); const root = join(home, 'checkout'); const calls = [];
  mkdirSync(root); writeFileSync(join(root, '.env'), 'PRIVATE=do-not-copy\n');
  try {
    assert.throws(() => enable({ platform: 'darwin', home, root, node: '/usr/bin/node', nodeMajor: 24, path: '/usr/bin', uid: 501, exec: (command, args) => {
      calls.push([command, args]);
      return { status: args[0] === 'bootstrap' ? 1 : 0 };
    } }), /could not confirm the login agent loaded/);
    assert.equal(existsSync(join(home, 'Library', 'LaunchAgents', 'com.careeragentstack.launcher.plist')), true);
    assert.ok(calls.some(([command, args]) => command === 'launchctl' && args[0] === 'bootstrap'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('macOS enable makes no changes when launchd cannot inspect the user session', () => {
  const home = temporary(); const root = join(home, 'checkout');
  mkdirSync(root); writeFileSync(join(root, '.env'), 'PRIVATE=do-not-copy\n');
  try {
    assert.throws(() => enable({ platform: 'darwin', home, root, nodeMajor: 24, uid: 501, exec: () => ({ status: 1 }) }), /user session could not be inspected/);
    assert.equal(existsSync(join(home, 'Library', 'LaunchAgents', 'com.careeragentstack.launcher.plist')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('macOS disable unloads the user agent, stops owned services and removes its log', () => {
  const home = temporary(); const root = join(home, 'checkout'); let stopped = 0; const calls = [];
  const plist = join(home, 'Library', 'LaunchAgents', 'com.careeragentstack.launcher.plist');
  const log = join(root, 'data', 'logs', 'autostart.log');
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true }); mkdirSync(join(root, 'data', 'logs'), { recursive: true });
  writeFileSync(plist, 'plist'); writeFileSync(log, 'output');
  try {
    disable({ platform: 'darwin', home, root, uid: 501, exec: (command, args) => { calls.push([command, args]); return { status: 0 }; }, stopServices: () => { stopped++; return { status: 0 }; } });
    assert.equal(stopped, 1);
    assert.equal(existsSync(plist), false);
    assert.equal(existsSync(log), false);
    assert.ok(calls.some(([command, args]) => command === 'launchctl' && args[0] === 'bootout'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('macOS disable preserves configuration when the launchd domain cannot be inspected', () => {
  const home = temporary(); const root = join(home, 'checkout'); let stopped = 0;
  const plist = join(home, 'Library', 'LaunchAgents', 'com.careeragentstack.launcher.plist');
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true }); writeFileSync(plist, 'plist');
  try {
    assert.throws(() => disable({ platform: 'darwin', home, root, uid: 501, exec: () => ({ status: 1 }), stopServices: () => { stopped++; return { status: 0 }; } }), /user session could not be inspected/);
    assert.equal(stopped, 0);
    assert.equal(existsSync(plist), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
