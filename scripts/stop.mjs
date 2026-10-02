// Stops only the processes that scripts/launch.mjs started and recorded in data/run/.
// Services started some other way (your own terminal, an IDE, launchd) are left alone.
//   pnpm run stop               stop the web app and API started by the launcher
//   pnpm run stop --database    also stop PostgreSQL if the launcher started it (data is kept)
//   pnpm run stop --forget      remove records that cannot be verified, without signalling anything
//
// A process is signalled only if it still matches the identity recorded at launch: same PID, process group,
// exact start time, working directory, and entry point (or Next's "next-server" title). Anything else,
// including records written by older launcher versions, is left running (fail closed).
import { spawnSync } from 'node:child_process';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { ok, printRecovery, processIdentity, projectRoot, runDir, say, warn } from './lib/local-env.mjs';

const stopDatabase = process.argv.includes('--database');
const forget = process.argv.includes('--forget');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** Returns null when the running process is exactly the recorded one, otherwise the reason it is not. */
async function mismatch(record) {
  if (record.version !== 2 || !record.lstart || !record.cwd || !record.entry || !Number.isInteger(record.pgid)) return 'record from an older launcher without a verifiable identity';
  if (record.projectRoot !== projectRoot) return 'record belongs to another checkout';
  const current = await processIdentity(record.pid);
  if (!current) return 'identity of the running process cannot be read';
  if (current.lstart !== record.lstart) return 'PID now belongs to a process started at another time';
  if (current.cwd !== record.cwd) return 'working directory differs';
  if (current.pgid !== record.pgid) return 'process group differs';
  const titles = Array.isArray(record.titles) ? record.titles : [];
  if (!current.args.includes(record.entry) && !titles.some((title) => current.args.startsWith(title))) return 'command line differs';
  return null;
}

async function signal(record, name) {
  // Re-verify immediately before every signal, so a PID reused in between is never hit.
  if (await mismatch(record)) return false;
  const group = record.pgid === record.pid;
  try { process.kill(group ? -record.pgid : record.pid, name); } catch { return false; }
  return true;
}

async function stopProcess(record) {
  if (!Number.isInteger(record.pid) || !alive(record.pid)) return { outcome: 'gone' };
  const reason = await mismatch(record);
  if (reason) return { outcome: 'refused', reason };
  await signal(record, 'SIGTERM');
  for (let attempt = 0; attempt < 40 && alive(record.pid); attempt += 1) await delay(250);
  if (alive(record.pid)) {
    warn(`${record.name} no se detuvo con SIGTERM; se fuerza el cierre.`, `${record.name} did not stop on SIGTERM; forcing it.`);
    await signal(record, 'SIGKILL');
  }
  return { outcome: 'stopped' };
}

async function main() {
  let files = [];
  try { files = (await readdir(runDir)).filter((file) => file.endsWith('.json')); } catch { /* nothing recorded */ }
  if (!files.length) {
    say('No hay servicios iniciados por el lanzador.', 'No services started by the launcher.');
    return;
  }
  let refused = 0;
  for (const file of files) {
    const path = resolve(runDir, file);
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (record.name === 'postgres') {
      if (!stopDatabase) { say('PostgreSQL sigue en marcha (usa --database para detenerlo; los datos se conservan).', 'PostgreSQL keeps running (use --database to stop it; data is kept).'); continue; }
      const result = record.method === 'homebrew-pg_ctl'
        ? spawnSync(record.pgCtl, ['-D', record.dataDir, '-m', 'fast', 'stop'], { stdio: 'inherit' })
        : spawnSync('docker', ['compose', 'stop', 'postgres'], { cwd: projectRoot, stdio: 'inherit' });
      if (result.status === 0) { ok('PostgreSQL detenido; los datos se conservan.', 'PostgreSQL stopped; data is kept.'); await unlink(path); }
      else warn('No se pudo detener PostgreSQL.', 'PostgreSQL could not be stopped.');
      continue;
    }
    const { outcome, reason } = await stopProcess(record);
    if (outcome === 'refused') {
      if (forget) {
        await unlink(path);
        warn(`${record.name}: registro eliminado sin detener nada (PID ${record.pid}).`, `${record.name}: record removed without stopping anything (PID ${record.pid}).`);
        continue;
      }
      refused += 1;
      warn(`${record.name}: no se detiene el PID ${record.pid} porque no se puede confirmar que sea el que inició el lanzador.`, `${record.name}: PID ${record.pid} is not stopped because it cannot be confirmed as the one the launcher started (${reason}).`);
      say(`    Compruébalo con: ps -o pid,lstart,args -p ${record.pid}   y detenlo tú si corresponde; luego: pnpm run stop --forget`, `Check it with: ps -o pid,lstart,args -p ${record.pid}   and stop it yourself if appropriate; then: pnpm run stop --forget`, process.stderr);
      continue;
    }
    ok(`${record.name}: ${outcome === 'stopped' ? 'detenido' : 'ya no estaba en marcha'}`, `${record.name}: ${outcome === 'stopped' ? 'stopped' : 'was not running'}`);
    await unlink(path);
  }
  if (refused) process.exitCode = 1;
}

try { await main(); }
catch (error) { printRecovery(error); process.exitCode = 1; }
