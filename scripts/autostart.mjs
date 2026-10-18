#!/usr/bin/env node
// Opt in to starting the existing local launcher at login. This never opens a browser.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const label = 'com.careeragentstack.launcher';
export const serviceName = 'career-agent-stack.service';

const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const systemdQuote = (value) => `"${String(value).replaceAll('%', '%%').replaceAll('$', '$$').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}"`;
const say = (es, en) => {
  const spanish = /^es/i.test(process.env.CAREER_LANG || process.env.LC_ALL || process.env.LANG || '');
  process.stdout.write(`${spanish ? es : en}\n${spanish ? en : es}\n`);
};

export function launchAgent({ node = process.execPath, root = projectRoot, path = process.env.PATH || '', home = homedir() } = {}) {
  const log = join(root, 'data', 'logs', 'autostart.log');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${xml(label)}</string>\n  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(join(root, 'scripts', 'launch.mjs'))}</string><string>--no-open</string></array>\n  <key>WorkingDirectory</key><string>${xml(root)}</string>\n  <key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(path)}</string></dict>\n  <key>RunAtLoad</key><true/>\n  <key>StandardOutPath</key><string>${xml(log)}</string>\n  <key>StandardErrorPath</key><string>${xml(log)}</string>\n</dict></plist>\n`;
}

export function systemdUnit({ node = process.execPath, root = projectRoot, path = process.env.PATH || '', home = homedir() } = {}) {
  return `[Unit]\nDescription=Career Stack local launcher\nAfter=default.target\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nWorkingDirectory=${systemdQuote(root)}\nEnvironment=${systemdQuote(`HOME=${home}`)}\nEnvironment=${systemdQuote(`PATH=${path}`)}\nExecStart=${systemdQuote(node)} ${systemdQuote(join(root, 'scripts', 'launch.mjs'))} --no-open\nExecStop=${systemdQuote(node)} ${systemdQuote(join(root, 'scripts', 'stop.mjs'))}\n\n[Install]\nWantedBy=default.target\n`;
}

function atomicPrivateWrite(file, contents) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally { rmSync(temporary, { force: true }); }
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: 'ignore', ...options });
}

function configFor(platform = process.platform, home = homedir(), root = projectRoot) {
  if (platform === 'darwin') return { file: join(home, 'Library', 'LaunchAgents', `${label}.plist`), log: join(root, 'data', 'logs', 'autostart.log'), kind: 'launchd' };
  if (platform === 'linux') return { file: join(home, '.config', 'systemd', 'user', serviceName), log: null, unit: serviceName, kind: 'systemd' };
  return null;
}

export function isEnabled({ platform = process.platform, home = homedir(), exec = run, uid = process.getuid?.() } = {}) {
  const config = configFor(platform, home);
  if (!config || !existsSync(config.file)) return false;
  if (config.kind === 'launchd') {
    if (!Number.isInteger(uid)) return null;
    const domain = `gui/${uid}`;
    if (exec('launchctl', ['print', domain]).status !== 0) return null;
    return exec('launchctl', ['print', `${domain}/${label}`]).status === 0;
  }
  if (exec('systemctl', ['--user', 'show-environment']).status !== 0) return null;
  return exec('systemctl', ['--user', 'is-enabled', config.unit]).status === 0;
}

export function renderStatus(options = {}) {
  const platform = options.platform ?? process.platform;
  if (!configFor(platform, options.home ?? homedir(), options.root ?? projectRoot)) return { supported: false, enabled: false };
  return { supported: true, enabled: isEnabled(options) };
}

export function statusMessage(status) {
  if (!status.supported) return ['Inicio automático: no disponible en este sistema.', 'Autostart: unavailable on this system.'];
  if (status.enabled === null) return ['Inicio automático: no se pudo comprobar.', 'Autostart: could not be checked.'];
  return status.enabled
    ? ['Inicio automático: activado.', 'Autostart: enabled.']
    : ['Inicio automático: desactivado.', 'Autostart: disabled.'];
}

function writeUnit(config, options) {
  atomicPrivateWrite(config.file, config.kind === 'launchd' ? launchAgent(options) : systemdUnit(options));
}

function cleanupAfterDisable(config, root, stopServices = () => spawnSync(process.execPath, [join(root, 'scripts', 'stop.mjs')], { cwd: root, stdio: 'inherit', env: process.env })) {
  const stop = stopServices();
  if (stop.status !== 0) throw new Error('The launcher could not confirm that its services stopped; the autostart file was kept for inspection.');
  rmSync(config.file, { force: true });
  if (config.log) rmSync(config.log, { force: true });
  say('Inicio automático desactivado; los servicios iniciados por Career Stack se han detenido.', 'Autostart disabled; services started by Career Stack have been stopped.');
}

function unloadLaunchAgent(exec, config, uid) {
  const domain = `gui/${uid}`;
  if (exec('launchctl', ['print', domain]).status !== 0) throw new Error('launchd user session could not be inspected; the login agent configuration was kept.');
  const unloaded = exec('launchctl', ['bootout', domain, config.file]);
  if (unloaded.status === 0) return;
  const stillLoaded = exec('launchctl', ['print', `${domain}/${label}`]);
  const domainAfter = exec('launchctl', ['print', domain]);
  if (domainAfter.status !== 0 || stillLoaded.status === 0) throw new Error('launchd could not confirm that the login agent was unloaded; its configuration was kept.');
}

export function enable({ platform = process.platform, home = homedir(), exec = run, node = process.execPath, root = projectRoot, path = process.env.PATH || '', nodeMajor = Number(process.versions.node.split('.')[0]), uid = process.getuid?.() } = {}) {
  const config = configFor(platform, home, root);
  if (!config) throw new Error('Automatic startup is currently supported on macOS and Linux. Windows support depends on the Windows launcher (#19).');
  if (nodeMajor !== 24) throw new Error('Enable autostart with Node.js 24, the version required by the launcher.');
  if (!existsSync(join(root, '.env'))) throw new Error('Career Stack is not configured in this checkout. Run its setup before enabling autostart.');
  if (config.kind === 'launchd') {
    if (!Number.isInteger(uid)) throw new Error('Could not determine the current macOS user session.');
    unloadLaunchAgent(exec, config, uid);
    if (config.log) mkdirSync(dirname(config.log), { recursive: true, mode: 0o700 });
    writeUnit(config, { node, root, path, home });
    if (exec('launchctl', ['bootstrap', `gui/${uid}`, config.file]).status !== 0) throw new Error('launchctl could not confirm the login agent loaded; its plist was kept for inspection.');
  } else {
    if (exec('systemctl', ['--user', 'show-environment']).status !== 0) throw new Error('The systemd user manager is unavailable; no autostart changes were made.');
    writeUnit(config, { node, root, path, home });
    if (exec('systemctl', ['--user', 'daemon-reload']).status !== 0) throw new Error('systemd could not reload user services; the unit file was kept for inspection.');
    if (exec('systemctl', ['--user', 'enable', '--now', config.unit]).status !== 0) {
      const rolledBack = exec('systemctl', ['--user', 'disable', '--now', config.unit]);
      if (rolledBack.status === 0 && exec('systemctl', ['--user', 'daemon-reload']).status === 0) rmSync(config.file, { force: true });
      throw new Error(rolledBack.status === 0 ? 'systemd could not enable the Career Stack login service.' : 'systemd could not confirm rollback; the service configuration was kept for inspection.');
    }
  }
  say('Inicio automático activado; no se abrirá el navegador al iniciar sesión.', 'Autostart enabled; the browser will not open at login.');
}

export function disable({ platform = process.platform, home = homedir(), root = projectRoot, exec = run, stopServices, uid = process.getuid?.() } = {}) {
  const config = configFor(platform, home, root);
  if (!config) throw new Error('Automatic startup is currently supported on macOS and Linux. Windows support depends on the Windows launcher (#19).');
  if (!existsSync(config.file)) {
    say('El inicio automático ya estaba desactivado.', 'Autostart was already disabled.');
    return;
  }
  if (config.kind === 'launchd') {
    if (!Number.isInteger(uid)) throw new Error('Could not determine the current macOS user session; the login agent configuration was kept.');
    unloadLaunchAgent(exec, config, uid);
  } else {
    if (exec('systemctl', ['--user', 'disable', '--now', config.unit]).status !== 0) throw new Error('systemd could not disable the service; its configuration was kept.');
    if (exec('systemctl', ['--user', 'daemon-reload']).status !== 0) throw new Error('systemd could not reload user services; its configuration was kept.');
  }
  cleanupAfterDisable(config, root, stopServices);
}

export function main(argv = process.argv.slice(2)) {
  const [action, ...extra] = argv[0] === '--' ? argv.slice(1) : argv;
  if (extra.length || !['--enable', '--disable', '--status'].includes(action)) {
    say('Uso: pnpm run autostart -- --enable|--disable|--status', 'Usage: pnpm run autostart -- --enable|--disable|--status');
    process.exitCode = extra.length || action ? 2 : 0;
    return;
  }
  try {
    if (action === '--enable') enable();
    else if (action === '--disable') disable();
    else {
      const status = renderStatus();
      say(...statusMessage(status));
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
