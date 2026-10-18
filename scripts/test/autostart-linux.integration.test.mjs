import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { disable, enable, isEnabled, serviceName } from '../autostart.mjs';

const optedIn = process.env.CAREER_AUTOSTART_LINUX_INTEGRATION === '1' && process.platform === 'linux';

test('real systemd user manager enables, starts and removes a disposable launcher unit', { skip: !optedIn }, () => {
  const home = homedir();
  const unitFile = join(home, '.config', 'systemd', 'user', serviceName);
  assert.equal(existsSync(unitFile), false, 'the disposable runner must not have an existing Career Stack user unit');

  const root = mkdtempSync(join(tmpdir(), 'career-autostart-systemd-'));
  const scripts = join(root, 'scripts');
  mkdirSync(scripts);
  writeFileSync(join(root, '.env'), 'FIXTURE_ONLY=1\n');
  writeFileSync(join(scripts, 'launch.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('started.marker', 'ok');\n");
  writeFileSync(join(scripts, 'stop.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('stopped.marker', 'ok');\n");

  const manager = (command, args) => spawnSync(command, args, { encoding: 'utf8' });
  const options = {
    platform: 'linux', home, root, node: process.execPath, path: process.env.PATH || '',
    nodeMajor: Number(process.versions.node.split('.')[0]), exec: manager,
  };
  const stopFixture = () => spawnSync(process.execPath, [join(scripts, 'stop.mjs')], { cwd: root, encoding: 'utf8' });

  try {
    assert.equal(manager('systemctl', ['--user', 'show-environment']).status, 0, 'systemd user manager must be available');
    enable(options);
    assert.equal(isEnabled(options), true);
    assert.equal(manager('systemctl', ['--user', 'is-active', serviceName]).status, 0);
    assert.equal(existsSync(join(root, 'started.marker')), true, 'systemd must execute the fixture launcher');

    disable({ ...options, stopServices: stopFixture });
    assert.equal(existsSync(unitFile), false, 'disable must remove the unit file');
    assert.equal(isEnabled(options), false);
    assert.notEqual(manager('systemctl', ['--user', 'is-active', serviceName]).status, 0, 'the unit must be inactive after disable');
    assert.equal(existsSync(join(root, 'stopped.marker')), true, 'disable must call the fixture stop command');
  } finally {
    manager('systemctl', ['--user', 'disable', '--now', serviceName]);
    rmSync(unitFile, { force: true });
    manager('systemctl', ['--user', 'daemon-reload']);
    rmSync(root, { recursive: true, force: true });
  }
});
