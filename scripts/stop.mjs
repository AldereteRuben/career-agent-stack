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
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { ok, printRecovery, processIdentity, projectRoot, runDir, say, warn } from './lib/local-env.mjs';
import { windowsStopTree } from './lib/windows-process.mjs';

const stopDatabase = process.argv.includes('--database');
const forget = process.argv.includes('--forget');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const isStopFile = (record) => typeof record.stopFile === 'string'
  && dirname(resolve(record.stopFile)) === resolve(runDir)
  && /^api-stop-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.signal$/i.test(basename(record.stopFile));

/** Returns null when the running process is exactly the recorded one, otherwise the reason it is not. */
async function mismatch(record) {
  // Windows cannot read another process's working directory, so there the exact start time and the absolute entry path stand in for it.
  const needsCwd = process.platform !== 'win32';
  if (record.version !== 2 || !record.lstart || (needsCwd && !record.cwd) || !record.entry || !Number.isInteger(record.pgid)) return 'record from an older launcher without a verifiable identity';
  if (record.projectRoot !== projectRoot) return 'record belongs to another checkout';
  const current = await processIdentity(record.pid);
  if (!current) return 'identity of the running process cannot be read';
  if (current.lstart !== record.lstart) return 'PID now belongs to a process started at another time';
  if (needsCwd && current.cwd !== record.cwd) return 'working directory differs';
  if (current.pgid !== record.pgid) return 'process group differs';
  const titles = Array.isArray(record.titles) ? record.titles : [];
  if (!current.args.includes(record.entry) && !titles.some((title) => current.args.startsWith(title))) return 'command line differs';
  return null;
}

async function signal(record, name) {
  // Re-verify immediately before every signal, so a PID reused in between is never hit.
  if (await mismatch(record)) return false;
  if (process.platform === 'win32') return windowsStopTree(record.pid); // no signals or process groups: end the process tree
  const group = record.pgid === record.pid;
  try { process.kill(group ? -record.pgid : record.pid, name); } catch { return false; }
  return true;
}

async function stopProcess(record) {
  if (!Number.isInteger(record.pid) || !alive(record.pid)) return { outcome: 'gone' };
  const reason = await mismatch(record);
  if (reason) return { outcome: 'refused', reason };
  if (process.platform === 'win32' && record.name === 'api' && record.stopFile) {
    if (!isStopFile(record)) return { outcome: 'refused', reason: 'invalid cooperative stop-file path' };
    if (await mismatch(record)) return { outcome: 'refused', reason: 'process identity changed before stop request' };
    try { await writeFile(record.stopFile, 'stop', { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') return { outcome: 'failed', reason: 'could not create cooperative stop file' };
    }
    for (let attempt = 0; attempt < 60 && alive(record.pid); attempt += 1) await delay(250);
    if (!alive(record.pid)) return { outcome: 'stopped' };
    warn('La API no respondió a la parada ordenada en 15 s; se usará taskkill como último recurso.', 'The API did not stop gracefully within 15 s; using taskkill as a last resort.');
    if (await mismatch(record)) return { outcome: 'refused', reason: 'process identity changed before forced stop' };
    if (!windowsStopTree(record.pid) && alive(record.pid)) return { outcome: 'failed', reason: 'taskkill could not stop the API process tree' };
    return { outcome: 'forced' };
  }
  await signal(record, 'SIGTERM');
  for (let attempt = 0; attempt < 40 && alive(record.pid); attempt += 1) await delay(250);
  if (alive(record.pid) && process.platform === 'win32') return { outcome: 'failed' }; // the first step was already forceful (taskkill /F), so there is nothing stronger to try
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
    let recordText;
    try { recordText = await readFile(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const record = JSON.parse(recordText);
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
      const inspect = process.platform === 'win32' ? `Get-CimInstance Win32_Process -Filter 'ProcessId=${record.pid}' | Select-Object ProcessId,CreationDate,CommandLine` : `ps -o pid,lstart,args -p ${record.pid}`;
      say(`    Compruébalo con: ${inspect}   y detenlo tú si corresponde; luego: pnpm run stop --forget`, `Check it with: ${inspect}   and stop it yourself if appropriate; then: pnpm run stop --forget`, process.stderr);
      continue;
    }
    if (outcome === 'failed') {
      warn(`${record.name}: el PID ${record.pid} sigue en marcha; no se pudo detener.`, `${record.name}: PID ${record.pid} is still running; it could not be stopped.`);
      process.exitCode = 1;
      continue;
    }
    if (outcome === 'forced') warn('API detenida a la fuerza; revisa su registro si había trabajo en curso.', 'API was force-stopped; check its log if work was in progress.');
    const stoppedText = outcome === 'forced' ? 'detenida a la fuerza' : outcome === 'stopped' ? 'detenido' : 'ya no estaba en marcha';
    const stoppedTextEn = outcome === 'forced' ? 'force-stopped' : outcome === 'stopped' ? 'stopped' : 'was not running';
    ok(`${record.name}: ${stoppedText}`, `${record.name}: ${stoppedTextEn}`);
    if (isStopFile(record)) await unlink(record.stopFile).catch(() => {});
    await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
  if (refused) process.exitCode = 1;
}

try { await main(); }
catch (error) { printRecovery(error); process.exitCode = 1; }
