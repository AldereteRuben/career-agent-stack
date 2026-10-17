// Process inspection for native Windows, where the Unix tools the launcher uses elsewhere (ps, lsof, ss) do not exist.
// Windows has no process groups and no readable working directory for another process, so the identity of a process
// here is its PID, its exact creation time (millisecond resolution, which stops a reused PID from matching) and its
// command line. Every PID that reaches PowerShell is an integer checked first, never text from another source.
import { spawnSync } from 'node:child_process';

const powershell = (script) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });

const validPid = (pid) => Number.isInteger(pid) && pid > 1;

/** Turns the JSON that Get-CimInstance printed into an identity, or null when any part is missing. */
export function parseProcessJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (Array.isArray(data)) data = data[0];
  const pid = Number(data?.ProcessId);
  const startedAt = Number(data?.Created);
  const args = typeof data?.CommandLine === 'string' ? data.CommandLine : '';
  if (!validPid(pid) || !Number.isFinite(startedAt) || !args) return null;
  return { pid, ppid: Number(data.ParentProcessId) || 0, startedAt, args };
}

const query = (pid) => `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ProcessId,ParentProcessId,CommandLine,@{n='Created';e={[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress`;

/** Identity of a running process, or null when it cannot be read (callers then fail closed). */
export function windowsProcessIdentity(pid) {
  if (!validPid(pid)) return null;
  const result = powershell(query(pid));
  const found = result.status === 0 ? parseProcessJson(result.stdout) : null;
  if (!found || found.pid !== pid) return null;
  return { pid, pgid: pid, lstart: new Date(found.startedAt).toISOString(), startedAt: found.startedAt, args: found.args, cwd: null, ppid: found.ppid };
}

/** PID listening on a TCP port, or null when unknown. */
export function windowsListeningPid(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const result = powershell(`Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`);
  const pid = Number(result.stdout?.trim());
  return result.status === 0 && validPid(pid) ? pid : null;
}

/** Command line of a process's parent, or an empty string when unknown. */
export function windowsParentArgs(pid) {
  const identity = windowsProcessIdentity(pid);
  if (!identity?.ppid || !validPid(identity.ppid)) return '';
  return windowsProcessIdentity(identity.ppid)?.args ?? '';
}

/** Ends a process and everything it started. Windows console programs without a window cannot be asked to close, so this is forced. */
export function windowsStopTree(pid) {
  if (!validPid(pid)) return false;
  return spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).status === 0;
}
